/**
 * 「线」的推导：支线树 / 角色线 / 身份线 / 搜索。
 *
 * 只读、纯函数，输入是 `buildOrchestration()` 的产物 —— 网页与 CLI 共用同一份推导，
 * 不各自维护一套「谁和谁有关」的判断。
 *
 * 为什么需要这一层：模板里角色关系绝大部分是**隐式**的（jjk-2006 的 100 个事件
 * 一个 `actors` / `mentions` / `npcs` 都没写），全靠效果、战斗引用、条件、正文提到人。
 * 单看 `events.yaml` 想知道「夏油这条线有哪些戏」得全文检索再人工过滤。
 */
import type {
  AdminCharacter,
  AdminOrchestration,
  AdminSpawnRule,
} from "./admin-data.js";
import { flagsReadInConditions } from "./admin-data.js";

type Rec = Record<string, unknown>;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asObject = (value: unknown): Rec | undefined =>
  value !== null && typeof value === "object" ? (value as Rec) : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/* ------------------------------------------------------------------ *
 * 基础索引
 * ------------------------------------------------------------------ */

function eventsById(orch: AdminOrchestration): Map<string, Rec> {
  const map = new Map<string, Rec>();
  for (const raw of orch.events) {
    const event = asObject(raw);
    const id = str(event?.id);
    if (event && id) map.set(id, event);
  }
  return map;
}

/** 从条件里读 `era` / `chapter` 这类数值锚，用来给线排序。 */
function numberAnchor(conditions: unknown, flag: string): number | undefined {
  for (const raw of asArray(conditions)) {
    const cond = asObject(raw);
    if (cond && cond.flag === flag && typeof cond.eq === "number") return cond.eq;
  }
  return undefined;
}

function triggerOf(event: Rec): Rec {
  return asObject(event.trigger) ?? {};
}

/** 事件声明 / 隐式涉及的旗标写入（支线节点用来提示「这一步改了哪些开关」）。 */
export function flagWritesOfEvent(event: Rec): Array<{ flag: string; how: string }> {
  const out: Array<{ flag: string; how: string }> = [];
  const collect = (effects: unknown, where: string): void => {
    for (const raw of asArray(effects)) {
      const effect = asObject(raw);
      if (!effect) continue;
      const id = str(effect.id);
      if (!id) continue;
      if (effect.type === "setFlag") out.push({ flag: id, how: `${where} set = ${JSON.stringify(effect.value)}` });
      else if (effect.type === "adjustFlag") out.push({ flag: id, how: `${where} adjust ${String(effect.value)}` });
      else if (effect.type === "clearFlag") out.push({ flag: id, how: `${where} clear` });
    }
  };
  for (const option of optionsOf(event)) collect(option.effects, `选项 ${str(option.id) ?? "?"}`);
  for (const segment of wheelSegmentsOf(event)) collect(segment.effects, `转盘 ${str(segment.label) ?? "?"}`);
  for (const outcome of combatOutcomesOf(event)) collect(outcome.value.effects, outcome.key);
  return out;
}

function optionsOf(event: Rec): Rec[] {
  const settle = asObject(event.settle);
  return asArray(asObject(settle?.normal)?.options).map((o) => asObject(o)).filter((o): o is Rec => !!o);
}

function wheelSegmentsOf(event: Rec): Rec[] {
  const settle = asObject(event.settle);
  const wheel = asObject(asObject(settle?.random)?.wheel);
  return asArray(wheel?.segments).map((s) => asObject(s)).filter((s): s is Rec => !!s);
}

function combatOutcomesOf(event: Rec): Array<{ key: string; value: Rec }> {
  const settle = asObject(event.settle);
  const combat = asObject(settle?.combat);
  const out: Array<{ key: string; value: Rec }> = [];
  for (const key of ["onVictory", "onDefeat", "onFlee"]) {
    const value = asObject(combat?.[key]);
    if (value) out.push({ key, value });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 支线树
 * ------------------------------------------------------------------ */

export interface LineVia {
  kind: "root" | "option" | "wheel" | "combat" | "enqueue";
  /** 人话标签：选项文本 / 转盘档位 / 战斗结果 / 入队来源。 */
  label: string;
  optionId?: string;
  outcome?: string;
}

export interface LineNode {
  id: string;
  title: string;
  kind: string;
  source: string;
  era?: number;
  chapter?: number;
  conditions: unknown[];
  via?: LineVia;
  viaConditions?: unknown[];
  depth: number;
  children: LineNode[];
  flags: Array<{ flag: string; how: string }>;
  /** 被本节点写入的旗标所解锁的结局 id。 */
  endings: string[];
  /** 终止 / 环 / 断链 / 超深 / 同一事件已展开过。 */
  note?: "terminal" | "cycle" | "missing" | "depth-limit" | "repeat";
}

export interface LineTree {
  root: LineNode;
  nodeCount: number;
  truncated: boolean;
  missing: string[];
  /** 命中但超出节点上限没展开的事件。 */
  notExpanded: string[];
}

interface OutEdge {
  to: string;
  via: LineVia;
  conditions: unknown[];
}

/** 一条事件往前的所有出口：选项 / 转盘 / 战斗结果 / enqueueEvent。 */
export function outgoingEdges(event: Rec): OutEdge[] {
  const out: OutEdge[] = [];
  const enqueue = (effects: unknown, via: LineVia, conditions: unknown[]): void => {
    for (const raw of asArray(effects)) {
      const effect = asObject(raw);
      if (effect?.type === "enqueueEvent") {
        const to = str(effect.eventId);
        if (to) out.push({ to, via: { ...via, kind: "enqueue", label: `${via.label} → 入队` }, conditions });
      }
    }
  };

  for (const option of optionsOf(event)) {
    const conditions = asArray(option.visibleWhen);
    const via: LineVia = {
      kind: "option",
      label: str(option.text) ?? str(option.id) ?? "选项",
      ...(str(option.id) ? { optionId: String(option.id) } : {}),
    };
    const to = str(option.nextEventId);
    if (to) out.push({ to, via, conditions });
    enqueue(option.effects, via, conditions);
  }
  for (const segment of wheelSegmentsOf(event)) {
    const via: LineVia = { kind: "wheel", label: str(segment.label) ?? "转盘档位" };
    const to = str(segment.nextEventId);
    if (to) out.push({ to, via, conditions: [] });
    enqueue(segment.effects, via, []);
  }
  for (const { key, value } of combatOutcomesOf(event)) {
    const via: LineVia = { kind: "combat", label: key, outcome: key };
    const to = str(value.nextEventId);
    if (to) out.push({ to, via, conditions: [] });
    enqueue(value.effects, via, []);
  }
  return out;
}

/** 旗标 → 读取它的结局 id（支线节点据此提示「这一步可能锁定了哪个结局」）。 */
function endingReaders(orch: AdminOrchestration): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (flag: string, id: string): void => {
    const list = map.get(flag) ?? [];
    if (!list.includes(id)) list.push(id);
    map.set(flag, list);
  };
  for (const raw of orch.endings) {
    const ending = asObject(raw);
    if (!ending) continue;
    const id = str(ending.endingId) ?? str(ending.id);
    if (!id) continue;
    const flags = [
      ...flagsReadInConditions(ending.triggerConditions),
      ...flagsReadInConditions(ending.unlockConditions),
    ];
    for (const flag of flags) add(flag, id);
  }
  // 死亡路由（ADR-075 §5）：档枪那条线靠 `hvEarlyDeath` 走到早夭，现已不在 triggerConditions 里。
  for (const raw of orch.deathRoutes ?? []) {
    const route = asObject(raw);
    const then = route ? asObject(route.then) : undefined;
    const id = str(then?.endingId);
    if (!route || !id || then?.kind !== "ending") continue;
    for (const flag of flagsReadInConditions(route.when)) add(flag, id);
  }
  return map;
}

export function buildLine(
  orch: AdminOrchestration,
  startEventId: string,
  options: { maxDepth?: number; maxNodes?: number } = {},
): LineTree | undefined {
  const events = eventsById(orch);
  const start = events.get(startEventId);
  if (!start) return undefined;
  const maxDepth = options.maxDepth ?? 12;
  const maxNodes = options.maxNodes ?? 120;
  const endingsOfFlag = endingReaders(orch);
  const missing: string[] = [];
  const notExpanded: string[] = [];
  /** 已经完整展开过的事件 id（后续同一目标只标「同上」）。 */
  const expanded = new Set<string>();
  let nodeCount = 0;
  let truncated = false;

  const makeNode = (id: string, via: LineVia | undefined, viaConditions: unknown[], depth: number): LineNode => {
    const event = events.get(id);
    if (!event) {
      missing.push(id);
      return {
        id,
        title: "（事件不存在）",
        kind: "?",
        source: "?",
        conditions: [],
        ...(via ? { via } : {}),
        ...(viaConditions.length > 0 ? { viaConditions } : {}),
        depth,
        children: [],
        flags: [],
        endings: [],
        note: "missing",
      };
    }
    const trigger = triggerOf(event);
    // 同一事件里多个选项可能写同一个旗标，节点摘要只保留一次（顺序按首次出现）。
    const flagMap = new Map<string, { flag: string; how: string }>();
    for (const write of flagWritesOfEvent(event)) if (!flagMap.has(write.flag)) flagMap.set(write.flag, write);
    const flags = [...flagMap.values()];
    const endings = [...new Set(flags.flatMap((f) => endingsOfFlag.get(f.flag) ?? []))];
    const era = numberAnchor(trigger.conditions, "era");
    const chapter = numberAnchor(trigger.conditions, "chapter");
    return {
      id,
      title: str(event.title) ?? id,
      kind: str(event.kind) ?? "?",
      source: str(trigger.source) ?? "?",
      ...(era !== undefined ? { era } : {}),
      ...(chapter !== undefined ? { chapter } : {}),
      conditions: asArray(trigger.conditions),
      ...(via ? { via } : {}),
      ...(viaConditions.length > 0 ? { viaConditions } : {}),
      depth,
      children: [],
      flags,
      endings,
    };
  };

  const walk = (node: LineNode, path: Set<string>): void => {
    if (node.depth >= maxDepth) {
      const has = outgoingEdges(events.get(node.id) as Rec).length > 0;
      if (has) {
        node.note = "depth-limit";
        truncated = true;
      }
      return;
    }
    // 同一事件被多个选项指向很常见（三条分支汇到同一场戏）。
    // 子树只展开一次，其余标「同上」，否则一次点击就把输出撑成三份。
    if (expanded.has(node.id)) {
      node.note = "repeat";
      return;
    }
    let edges = outgoingEdges(events.get(node.id) as Rec);
    expanded.add(node.id);
    if (edges.length === 0) {
      node.note = node.note ?? "terminal";
      return;
    }
    // 同一目标的多条入口（比如两个选项都导向同一事件）保留，但同一 via 去重。
    const seen = new Set<string>();
    edges = edges.filter((edge) => {
      const key = `${edge.to}|${edge.via.kind}|${edge.via.optionId ?? edge.via.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const edge of edges) {
      if (nodeCount >= maxNodes) {
        truncated = true;
        if (!notExpanded.includes(edge.to)) notExpanded.push(edge.to);
        continue;
      }
      nodeCount += 1;
      const child = makeNode(edge.to, edge.via, edge.conditions, node.depth + 1);
      node.children.push(child);
      if (path.has(child.id)) {
        child.note = "cycle";
        continue;
      }
      if (child.note === "missing") continue;
      walk(child, new Set([...path, child.id]));
    }
  };

  const root = makeNode(startEventId, undefined, [], 0);
  nodeCount = 1;
  walk(root, new Set([startEventId]));
  return { root, nodeCount, truncated, missing, notExpanded };
}

/* ------------------------------------------------------------------ *
 * 角色线 / 身份线
 * ------------------------------------------------------------------ */

export type NpcRole =
  | "在场"
  | "提及"
  | "登场"
  | "触发条件"
  | "选项条件"
  | "关系"
  | "生命周期"
  | "可见性"
  | "秘闻"
  | "战斗"
  | "正文提及"
  | "选项提及";

export interface NpcScene {
  eventId: string;
  title: string;
  era?: number;
  chapter?: number;
  roles: NpcRole[];
  details: string[];
}

export interface NpcLifecycleStep {
  eventId: string;
  state: string;
  reason?: string;
}

export interface NpcSpawnStep {
  eventId: string;
  ruleId: string;
  age?: number;
}

export interface NpcLine {
  character: AdminCharacter;
  /** 登场（spawnNpc 规则命中）。 */
  spawns: NpcSpawnStep[];
  /** 生命周期迁移（存活 / 死亡 / 离场…）。 */
  lifecycle: NpcLifecycleStep[];
  scenes: NpcScene[];
  /** 出现过的 era（按数值升序）。 */
  eras: number[];
}

/** 角色名 / id 都能定位；名字用包含匹配（"夏油" 能命中 "夏油杰"）。 */
export function findCharacter(orch: AdminOrchestration, query: string): AdminCharacter | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exact = orch.characters.find((c) => c.id.toLowerCase() === q || c.name.toLowerCase() === q);
  if (exact) return exact;
  return orch.characters.find((c) => c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
}

function conditionsTouchNpc(conditions: unknown, npcId: string): string[] {
  const hits: string[] = [];
  for (const raw of asArray(conditions)) {
    const cond = asObject(raw);
    if (!cond) continue;
    if (cond.relation === npcId) hits.push(`relation ${npcId}`);
    const npcState = asObject(cond.npcState);
    if (npcState?.npcId === npcId) hits.push(`npcState ${npcId} = ${String(npcState.state)}`);
  }
  return hits;
}

interface NpcEffectHit {
  role: NpcRole;
  detail: string;
  lifecycleState?: string;
  spawnRuleId?: string;
}

function effectsTouchNpc(effects: unknown, npcId: string, spawnRules: AdminSpawnRule[]): NpcEffectHit[] {
  const hits: NpcEffectHit[] = [];
  for (const raw of asArray(effects)) {
    const effect = asObject(raw);
    if (!effect) continue;
    const type = str(effect.type) ?? "";
    const npc = str(effect.npcId) ?? str(effect.fromId) ?? str(effect.toId);
    if (npc === npcId) {
      if (type === "setNpcLifecycle") {
        hits.push({ role: "生命周期", detail: `lifecycle → ${String(effect.state)}`, lifecycleState: String(effect.state) });
      } else if (type === "setNpcVisibility") {
        hits.push({ role: "可见性", detail: `visibility → ${String(effect.visibility)}` });
      } else if (type === "addSecret") {
        hits.push({ role: "秘闻", detail: `秘闻：${String(effect.text ?? "")}` });
      } else if (type === "adjustRelation" || type === "addRelationEdge") {
        const value = effect.value === undefined ? "" : ` ${String(effect.value)}`;
        hits.push({
          role: "关系",
          detail: `${String(effect.fromId ?? npcId)} → ${String(effect.toId ?? "player")}${value}`,
        });
      } else if (type === "freezeRelationsOnDeath") {
        hits.push({ role: "关系", detail: "死亡时冻结关系边" });
      } else {
        hits.push({ role: "关系", detail: type });
      }
    }
    if (type === "spawnNpc") {
      const ruleId = str(effect.ruleId);
      const rule = spawnRules.find((r) => r.id === ruleId);
      if (rule?.characterRef === npcId) {
        hits.push({ role: "登场", detail: `登场（规则 ${rule.id}${rule.age !== undefined ? ` · ${rule.age} 岁` : ""}）`, spawnRuleId: rule.id });
      }
    }
  }
  return hits;
}

export function buildNpcLine(orch: AdminOrchestration, npcId: string): NpcLine | undefined {
  const character = orch.characters.find((c) => c.id === npcId);
  if (!character) return undefined;
  const events = eventsById(orch);
  const order = new Map<string, number>();
  (orch.events as unknown[]).forEach((raw, i) => {
    const id = str(asObject(raw)?.id);
    if (id) order.set(id, i);
  });
  const scenes: NpcScene[] = [];
  const lifecycle: NpcLifecycleStep[] = [];
  const spawns: NpcSpawnStep[] = [];

  // 转折旗标：被多个事件读取的旗标才是「分支开关」，只写不读的不值一提。
  const readerCount = new Map(orch.flags.map((f) => [f.id, f.readers.length] as const));
  const turningCache = new Map<string, Array<{ flag: string; readers: number }>>();
  const turningFlags = (eventId: string, event: Rec): Array<{ flag: string; readers: number }> => {
    const cached = turningCache.get(eventId);
    if (cached) return cached;
    const picked = flagWritesOfEvent(event)
      .filter((w) => w.flag !== "era" && w.flag !== "chapter" && (readerCount.get(w.flag) ?? 0) >= 2)
      .map((w) => ({ flag: w.flag, readers: readerCount.get(w.flag) ?? 0 }));
    const unique = [...new Map(picked.map((p) => [p.flag, p])).values()]
      .sort((a, b) => b.readers - a.readers)
      .slice(0, 3);
    turningCache.set(eventId, unique);
    return unique;
  };

  const push = (
    eventId: string,
    event: Rec,
    role: NpcRole,
    detail: string,
  ): void => {
    let scene = scenes.find((s) => s.eventId === eventId);
    if (!scene) {
      const trigger = triggerOf(event);
      const era = numberAnchor(trigger.conditions, "era");
      const chapter = numberAnchor(trigger.conditions, "chapter");
      scene = {
        eventId,
        title: str(event.title) ?? eventId,
        ...(era !== undefined ? { era } : {}),
        ...(chapter !== undefined ? { chapter } : {}),
        roles: [],
        details: [],
      };
      scenes.push(scene);
    }
    if (!scene.roles.includes(role)) scene.roles.push(role);
    if (detail && !scene.details.includes(detail)) scene.details.push(detail);
    for (const turn of turningFlags(eventId, event)) {
      const text = `⚑ ${turn.flag}（读 ${turn.readers}）`;
      if (!scene.details.includes(text)) scene.details.push(text);
    }
  };

  for (const [eventId, event] of events) {
    // 1) 显式阵容（模板可声明；jjk-2006 全隐式，所以后面还要靠效果推断）。
    for (const raw of asArray(event.actors)) if (raw === npcId) push(eventId, event, "在场", "actors");
    for (const raw of asArray(event.mentions)) if (raw === npcId) push(eventId, event, "提及", "mentions");
    for (const raw of asArray(event.npcs)) if (raw === npcId) push(eventId, event, "登场", "npcs");

    // 2) 条件
    const trigger = triggerOf(event);
    for (const hit of conditionsTouchNpc(trigger.conditions, npcId)) push(eventId, event, "触发条件", hit);
    for (const hit of conditionsTouchNpc(trigger.missWhen, npcId)) push(eventId, event, "触发条件", `missWhen: ${hit}`);

    // 3) 效果（选项 / 转盘 / 战斗结果）
    const applyHits = (hits: NpcEffectHit[], where: string): void => {
      for (const hit of hits) {
        push(eventId, event, hit.role, `${where}: ${hit.detail}`);
        if (hit.lifecycleState !== undefined) {
          lifecycle.push({ eventId, state: hit.lifecycleState, reason: where });
        }
        if (hit.spawnRuleId !== undefined) {
          const rule = orch.spawnRules.find((r) => r.id === hit.spawnRuleId);
          spawns.push({ eventId, ruleId: hit.spawnRuleId, ...(rule?.age !== undefined ? { age: rule.age } : {}) });
        }
      }
    };
    for (const option of optionsOf(event)) {
      for (const hit of conditionsTouchNpc(option.visibleWhen, npcId)) {
        push(eventId, event, "选项条件", `${String(option.id)}: ${hit}`);
      }
      applyHits(effectsTouchNpc(option.effects, npcId, orch.spawnRules), String(option.id));
    }
    for (const segment of wheelSegmentsOf(event)) {
      applyHits(effectsTouchNpc(segment.effects, npcId, orch.spawnRules), `转盘 ${String(segment.label)}`);
    }
    for (const { key, value } of combatOutcomesOf(event)) {
      applyHits(effectsTouchNpc(value.effects, npcId, orch.spawnRules), key);
    }

    // 4) 战斗里的敌我引用
    const combat = asObject(asObject(event.settle)?.combat);
    for (const key of ["enemies", "allies"]) {
      for (const raw of asArray(combat?.[key])) {
        const ref = asObject(raw);
        if (str(ref?.ref) === npcId) push(eventId, event, "战斗", key === "enemies" ? "敌人" : "友军");
      }
    }

    // 5) 正文 / 选项文本提到名字（最弱的证据，单独标注，免得当成"这条线有他"）
    const name = character.name;
    if (str(event.narrative)?.includes(name)) push(eventId, event, "正文提及", "narrative");
    for (const option of optionsOf(event)) {
      if (str(option.text)?.includes(name)) push(eventId, event, "选项提及", String(option.id));
    }
  }

  // 模板文件顺序就是作者的叙事顺序，比 era/chapter 更可靠（链内事件大多不写锚）。
  scenes.sort((a, b) => (order.get(a.eventId) ?? 0) - (order.get(b.eventId) ?? 0));
  const eras = [...new Set(scenes.map((s) => s.era).filter((e): e is number => typeof e === "number"))].sort((a, b) => a - b);
  return { character, spawns, lifecycle, scenes, eras };
}

/** 身份线：角色卡 + 登场 / 生命周期 + 参与场景（就是 NpcLine，语义别名）。 */
export const buildIdentityLine = buildNpcLine;

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

export interface SearchHit {
  eventId: string;
  title: string;
  era?: number;
  chapter?: number;
  /** 命中字段：标题 / 叙事 / 选项 / 事件 id / 角色名。 */
  where: string[];
  snippet?: string;
}

export function searchOrchestration(
  orch: AdminOrchestration,
  query: string,
  options: { limit?: number } = {},
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = options.limit ?? 40;
  const hits: SearchHit[] = [];
  for (const raw of orch.events) {
    const event = asObject(raw);
    const id = str(event?.id);
    if (!event || !id) continue;
    const where: string[] = [];
    let snippet: string | undefined;
    if (id.toLowerCase().includes(q)) where.push("id");
    const title = str(event.title) ?? "";
    if (title.toLowerCase().includes(q)) where.push("标题");
    const narrative = str(event.narrative) ?? "";
    if (narrative.toLowerCase().includes(q)) {
      where.push("叙事");
      const at = narrative.toLowerCase().indexOf(q);
      snippet = narrative.slice(Math.max(0, at - 18), at + q.length + 24);
    }
    for (const option of optionsOf(event)) {
      if (str(option.text)?.toLowerCase().includes(q)) {
        where.push("选项");
        snippet = snippet ?? str(option.text);
      }
    }
    for (const character of orch.characters) {
      if (character.name.toLowerCase().includes(q) && (title.includes(character.name) || narrative.includes(character.name))) {
        if (!where.includes("角色")) where.push(`角色:${character.name}`);
      }
    }
    if (where.length === 0) continue;
    const trigger = triggerOf(event);
    const era = numberAnchor(trigger.conditions, "era");
    const chapter = numberAnchor(trigger.conditions, "chapter");
    hits.push({
      eventId: id,
      title,
      ...(era !== undefined ? { era } : {}),
      ...(chapter !== undefined ? { chapter } : {}),
      where,
      ...(snippet ? { snippet } : {}),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
