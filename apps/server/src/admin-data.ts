import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createTimeAdapter } from "@life-sim/game-core";
import type { LlmTrace, OpeningBranchDag } from "@life-sim/shared";
import type { ReadyTemplateEntry } from "./templates.js";
import { dataDir, traceFile, worldStore, type UnloadableWorld, type WorldRecord } from "./store.js";

/**
 * 后台工具的数据层（2026-11-19）。
 *
 * 这里**不含任何 HTTP 依赖**：`admin.ts` 把它包成 Fastify 路由给浏览器看，
 * `cli/inspect.ts` 把它打印成文本给 agent 看。两边共用同一份推导，
 * 避免「网页说没问题、命令行说有断链」这种双口径。
 *
 * 全部只读：不写存档、不写模板、不写 trace。
 */

/* ------------------------------------------------------------------ *
 * 数据结构
 * ------------------------------------------------------------------ */

export interface AdminFlagWrite {
  flag: string;
  /** 写入点所属事件；开局写入没有事件 id，用 `opening:<node>`。 */
  eventId: string;
  optionId?: string;
  how: string;
  /** 写入来源。缺省 = 事件；`opening` = 前实例化开局的 set。 */
  source?: "opening";
}

export interface AdminFlagRead {
  flag: string;
  where: "trigger" | "missWhen" | "visibleWhen" | "ending" | "unlock" | "termination";
  /** 读取点所属事件；结局 / 终止条件读旗标时没有单一事件，留空。 */
  eventId?: string;
  optionId?: string;
  /** 无事件归属时的出处：结局 id 或终止条件类型。 */
  ref?: string;
}

export interface AdminEdge {
  from: string;
  to: string;
  type: "option" | "wheel" | "victory" | "defeat" | "flee" | "enqueue";
  label: string;
}

export interface AdminRelationDecl {
  to: string;
  kind: string;
  value?: number;
  visibility?: string;
}

export interface AdminCharacter {
  id: string;
  name: string;
  isEnemy: boolean;
  gender?: string;
  age?: number;
  description?: string;
  visibility?: string;
  relationship?: number;
  relations: AdminRelationDecl[];
}

export interface AdminSpawnRule {
  id: string;
  characterRef: string;
  age?: number;
}

export interface AdminOrchestration {
  template: { id: string; version: string; name: string; description: string; startYear: number };
  generatedAt: string;
  labels: Record<string, string>;
  attributes: string[];
  resources: Record<string, string>;
  characters: AdminCharacter[];
  /** `spawnNpc` 效果只带 ruleId，要反查角色得靠这张表（身份线的「登场」节点）。 */
  spawnRules: AdminSpawnRule[];
  items: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string }>;
  statuses: Array<{ id: string; name: string }>;
  events: unknown[];
  edges: AdminEdge[];
  flags: Array<{ id: string; writers: AdminFlagWrite[]; readers: AdminFlagRead[] }>;
  /**
   * 开局参数被**多处写**的清单（B-04）。空数组 = 干净。
   * 只列「同一条路径上真的会互相覆盖」的，分叉互斥的写者不算（见 `openingParamOverwrites`）。
   */
  openingParams: Array<{ param: string; writers: Array<{ node: string; option: string }> }>;
  endings: unknown[];
  termination: unknown[];
  chains: unknown[];
  stats: {
    eventCount: number;
    edgeCount: number;
    flagCount: number;
    danglingEdges: AdminEdge[];
    orphanChainEvents: string[];
    /** 开局写入的旗标数（与事件写入分开统计，避免体检误报「无人写入」）。 */
    openingFlagWrites: number;
    /** 开局直接排队的事件（`source: chain` 但无需入边，不算孤立）。 */
    openingSeedEvents: string[];
  };
}

/* ------------------------------------------------------------------ *
 * 模板 → 编排图
 * ------------------------------------------------------------------ */

/** 从效果里收集 flag 写入（只认闭集里的三种写法，其余形态不猜）。 */
function flagWritesOf(effects: unknown): Array<{ flag: string; how: string }> {
  if (!Array.isArray(effects)) return [];
  const out: Array<{ flag: string; how: string }> = [];
  for (const raw of effects) {
    if (raw === null || typeof raw !== "object") continue;
    const effect = raw as Record<string, unknown>;
    const id = effect.id;
    if (typeof id !== "string" || id === "") continue;
    if (effect.type === "setFlag") out.push({ flag: id, how: `setFlag = ${JSON.stringify(effect.value)}` });
    else if (effect.type === "adjustFlag") out.push({ flag: id, how: `adjustFlag ${String(effect.value)}` });
    else if (effect.type === "clearFlag") out.push({ flag: id, how: "clearFlag" });
  }
  return out;
}

/** 条件里引用的 flag。条件数组是 AND 语义，只看平层 key。 */
export function flagsReadInConditions(conditions: unknown): string[] {
  if (!Array.isArray(conditions)) return [];
  const out: string[] = [];
  for (const cond of conditions) {
    if (cond === null || typeof cond !== "object") continue;
    const flag = (cond as Record<string, unknown>).flag;
    if (typeof flag === "string" && flag !== "") out.push(flag);
  }
  return [...new Set(out)];
}

function nextEventIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>).nextEventId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** 效果里的 `enqueueEvent` 也是编排的一部分（占槽之外的另一条入队路径）。 */
function enqueuedEventIds(effects: unknown): string[] {
  if (!Array.isArray(effects)) return [];
  const out: string[] = [];
  for (const raw of effects) {
    if (raw === null || typeof raw !== "object") continue;
    const effect = raw as Record<string, unknown>;
    if (effect.type === "enqueueEvent" && typeof effect.eventId === "string") out.push(effect.eventId);
  }
  return out;
}

/**
 * 开局 DAG 的旗标写入。
 *
 * `opening.yaml` 的 `set` 用 **参数名** 当 key（`f01: { id: w01, value: 男 }`），
 * 真正落到的 flag 是 value.id。所以必须先按 `kind: flag` 过滤参数，否则会把
 * `who` / `years` 这类非 flag 参数也算成旗标。
 */
function openingFlagWrites(entry: ReadyTemplateEntry): AdminFlagWrite[] {
  const dag = entry.openingDag;
  if (!dag) return [];
  const flagParams = new Set(dag.params.filter((p) => p.kind === "flag").map((p) => p.id));
  const out: AdminFlagWrite[] = [];
  for (const node of dag.nodes) {
    for (const option of node.options ?? []) {
      for (const [key, value] of Object.entries(option.set ?? {})) {
        if (!flagParams.has(key)) continue;
        if (value === null || typeof value !== "object") continue;
        const id = (value as Record<string, unknown>).id;
        if (typeof id !== "string" || id === "") continue;
        out.push({
          flag: id,
          eventId: `opening:${node.node}`,
          optionId: option.id,
          how: `opening set = ${JSON.stringify((value as Record<string, unknown>).value)}`,
          source: "opening",
        });
      }
    }
  }
  return out;
}

/**
 * 开局 DAG 里「从某个选项出发还能走到哪些节点」（B-04 用）。
 *
 * 后继规则与引擎逐字相同（`opening-dag.ts#nextNodeId`）：`option.goto ?? node.goto ?? 数组下一个`。
 * 自己实现一遍是为了**不把体检绑到运行中的会话上** —— 这一步只读模板。
 */
function reachableFromOption(
  dag: OpeningBranchDag,
  startIndex: number,
  optionIndex: number,
): Set<string> {
  const nextOf = (index: number, optIndex?: number): string | undefined => {
    const node = dag.nodes[index];
    const fallback = index + 1 < dag.nodes.length ? dag.nodes[index + 1].node : undefined;
    if (optIndex === undefined) return node.goto ?? fallback;
    return node.options?.[optIndex]?.goto ?? node.goto ?? fallback;
  };
  const seen = new Set<string>();
  const stack: Array<string | undefined> = [nextOf(startIndex, optionIndex)];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const index = dag.nodes.findIndex((n) => n.node === id);
    if (index < 0) continue;
    const node = dag.nodes[index];
    const count = node.options?.length ?? 0;
    if (count === 0) {
      stack.push(nextOf(index));
      continue;
    }
    for (let i = 0; i < count; i += 1) stack.push(nextOf(index, i));
  }
  return seen;
}

/**
 * 开局参数被多处写（B-04，作者陷阱）。
 *
 * `resolveParamMap` 是 `Object.assign` —— 同一个 param id 被两处设置时**后写覆盖先写**，
 * 而且没有任何提示。2026-11-18 的真实事故：`n13-entrance` 的 `begin` 也写 `weapon`，
 * 把第六格选的天逆鉾静默换成急救包（症状是「开局送的咒具没进背包」）。
 *
 * **不能**按「同 id 出现两次」直接报 —— DAG 是分叉的：`n-self` 的「自建」与 `n-canon` 的
 * 「借名」都写 `who`，玩家只能走其中一边。判据是**可达**：从 a 的选项出发能走到 b 所在节点
 * （或反过来），两者才可能同时发生。同一个节点的两个选项天生互斥，直接跳过。
 */
export function openingParamOverwrites(
  dag: OpeningBranchDag | undefined,
): Array<{ param: string; writers: Array<{ node: string; option: string }> }> {
  if (!dag) return [];
  type Write = { node: string; nodeIndex: number; option: string; reach: Set<string> };
  const byParam = new Map<string, Write[]>();
  dag.nodes.forEach((node, nodeIndex) => {
    (node.options ?? []).forEach((option, optionIndex) => {
      for (const param of Object.keys(option.set ?? {})) {
        const list = byParam.get(param) ?? [];
        list.push({
          node: node.node,
          nodeIndex,
          option: option.id,
          reach: reachableFromOption(dag, nodeIndex, optionIndex),
        });
        byParam.set(param, list);
      }
    });
  });

  const out: Array<{ param: string; writers: Array<{ node: string; option: string }> }> = [];
  for (const [param, writes] of byParam) {
    const conflicting = new Set<Write>();
    for (let i = 0; i < writes.length; i += 1) {
      for (let j = i + 1; j < writes.length; j += 1) {
        const a = writes[i]!;
        const b = writes[j]!;
        // 同一个节点：roll/choose 一次只落一个选项，两个选项不可能同时生效。
        if (a.nodeIndex === b.nodeIndex) continue;
        if (!a.reach.has(b.node) && !b.reach.has(a.node)) continue;
        conflicting.add(a);
        conflicting.add(b);
      }
    }
    if (conflicting.size === 0) continue;
    out.push({
      param,
      writers: [...conflicting].map((w) => ({ node: w.node, option: w.option })),
    });
  }
  return out.sort((a, b) => a.param.localeCompare(b.param));
}

/**
 * 开局排队的链式事件。
 *
 * legacy `opening.yaml` 用 `handoff.schedule[].eventId` / `handoff.pendingEvents[]`
 * 把 `source: chain` 的事件直接塞进队列——它们没有入边是**正常**的，
 * 不排除就会把每个开局事件都误报成「孤立链事件」。
 */
function openingSeedEventIds(entry: ReadyTemplateEntry): string[] {
  const out = new Set<string>();
  for (const opening of entry.openings ?? []) {
    for (const id of opening.handoff?.pendingEvents ?? []) out.add(id);
    for (const item of opening.handoff?.schedule ?? []) {
      if (typeof item.eventId === "string" && item.eventId !== "") out.add(item.eventId);
    }
  }
  return [...out];
}

/**
 * legacy `opening.yaml` 的旗标写入：`characterSetup/worldSetup/objectives/choices`
 * 都是 `{ effects, flags }` 形态，`flags` 直接落键值，`effects` 里还能再 setFlag。
 * 不收集这些，体检会把「只由开局写的旗标」误报成死旗标。
 */
function legacyOpeningFlagWrites(entry: ReadyTemplateEntry): AdminFlagWrite[] {
  const out: AdminFlagWrite[] = [];
  for (const opening of entry.openings ?? []) {
    const sections: Array<[string, unknown]> = [
      ["characterSetup", opening.characterSetup],
      ["worldSetup", opening.worldSetup],
      ["objectives", opening.objectives],
      ["choices", opening.choices],
    ];
    for (const [section, raw] of sections) {
      if (raw === null || typeof raw !== "object") continue;
      const setup = raw as Record<string, unknown>;
      const eventId = `opening:${opening.openingId}.${section}`;
      const flags = setup.flags;
      if (flags !== null && typeof flags === "object") {
        for (const [flag, value] of Object.entries(flags as Record<string, unknown>)) {
          out.push({ flag, eventId, how: `opening flags = ${JSON.stringify(value)}`, source: "opening" });
        }
      }
      for (const w of flagWritesOf(setup.effects)) {
        out.push({ flag: w.flag, eventId, how: `opening ${w.how}`, source: "opening" });
      }
    }
  }
  return out;
}

export function buildOrchestration(entry: ReadyTemplateEntry): AdminOrchestration {
  const tpl = entry.template;
  const edges: AdminEdge[] = [];
  const flags = new Map<string, { writers: AdminFlagWrite[]; readers: AdminFlagRead[] }>();

  const ensureFlag = (id: string) => {
    let row = flags.get(id);
    if (!row) {
      row = { writers: [], readers: [] };
      flags.set(id, row);
    }
    return row;
  };

  for (const event of tpl.events) {
    const trigger = event.trigger as Record<string, unknown>;
    for (const flag of flagsReadInConditions(trigger.conditions)) {
      ensureFlag(flag).readers.push({ flag, where: "trigger", eventId: event.id });
    }
    for (const flag of flagsReadInConditions(trigger.missWhen)) {
      ensureFlag(flag).readers.push({ flag, where: "missWhen", eventId: event.id });
    }

    // 事件自身的写入（选项 / 转盘分段 / 战斗结果）
    const writes = (list: Array<{ optionId?: string; effects: unknown }>) => {
      for (const item of list) {
        for (const w of flagWritesOf(item.effects)) {
          ensureFlag(w.flag).writers.push({
            flag: w.flag,
            eventId: event.id,
            ...(item.optionId !== undefined ? { optionId: item.optionId } : {}),
            how: w.how,
          });
        }
        for (const target of enqueuedEventIds(item.effects)) {
          edges.push({
            from: event.id,
            to: target,
            type: "enqueue",
            label: "enqueueEvent",
          });
        }
      }
    };

    if (event.kind === "normal") {
      writes(event.settle.normal.options.map((o) => ({ optionId: o.id, effects: o.effects })));
      for (const option of event.settle.normal.options) {
        for (const flag of flagsReadInConditions(option.visibleWhen)) {
          ensureFlag(flag).readers.push({ flag, where: "visibleWhen", eventId: event.id, optionId: option.id });
        }
        if (option.nextEventId) {
          edges.push({ from: event.id, to: option.nextEventId, type: "option", label: option.text });
        }
      }
    } else if (event.kind === "random") {
      writes(event.settle.random.wheel.segments.map((s) => ({ effects: s.effects })));
      for (const segment of event.settle.random.wheel.segments) {
        if (segment.nextEventId) {
          edges.push({ from: event.id, to: segment.nextEventId, type: "wheel", label: segment.label });
        }
      }
    } else {
      const outcomes: Array<[AdminEdge["type"], string, unknown]> = [
        ["victory", "胜利", event.settle.combat.onVictory],
        ["defeat", "战败", event.settle.combat.onDefeat],
        ["flee", "逃跑", event.settle.combat.onFlee],
      ];
      for (const [type, label, outcome] of outcomes) {
        if (outcome === undefined) continue;
        const effects = (outcome as Record<string, unknown>).effects;
        writes([{ effects }]);
        const next = nextEventIdOf(outcome);
        if (next) edges.push({ from: event.id, to: next, type, label });
      }
    }
  }

  const openingWrites = [...openingFlagWrites(entry), ...legacyOpeningFlagWrites(entry)];
  for (const write of openingWrites) {
    const row = ensureFlag(write.flag);
    // 同一 node+option 可能被多个分支共用，去重避免「一个开局节点算十次写入」。
    const dup = row.writers.some(
      (w) => w.source === "opening" && w.eventId === write.eventId && w.optionId === write.optionId,
    );
    if (!dup) row.writers.push(write);
  }

  const endings = (entry.endingConfig?.endings ?? []) as Array<Record<string, unknown>>;
  for (const ending of endings) {
    const ref = String(ending.endingId ?? ending.id ?? "?");
    for (const flag of flagsReadInConditions(ending.triggerConditions)) {
      ensureFlag(flag).readers.push({ flag, where: "ending", ref });
    }
    for (const flag of flagsReadInConditions(ending.unlockConditions)) {
      ensureFlag(flag).readers.push({ flag, where: "unlock", ref });
    }
  }
  const termination = (entry.endingConfig?.terminationConditions ?? []) as Array<Record<string, unknown>>;
  for (const cond of termination) {
    const params = (cond.params ?? {}) as Record<string, unknown>;
    const ref = typeof cond.type === "string" ? cond.type : "termination";
    for (const flag of flagsReadInConditions(params.conditions)) {
      ensureFlag(flag).readers.push({ flag, where: "termination", ref });
    }
  }

  const eventIds = new Set(tpl.events.map((e) => e.id));
  const danglingEdges = edges.filter((e) => !eventIds.has(e.to));
  /**
   * 世界时间表（`world.scheduledFacts`）也是一条入队路径：`{ type: enqueueEvent }`
   * 写在事实的 effects 里、由世界时钟到点触发。以前的编排图只扫事件内部的 effects，
   * 于是「只在时间表里排队」的事件一律被判成孤立链 —— 2026-11-20 用瓦勒蒙的测试链踩到。
   */
  const scheduledTargets = new Set(
    (tpl.scheduledFacts ?? []).flatMap((fact) => enqueuedEventIds(fact.effects)),
  );
  const targeted = new Set([...edges.map((e) => e.to), ...scheduledTargets]);
  const seeded = new Set(openingSeedEventIds(entry));
  const orphanChainEvents = tpl.events
    .filter((e) => e.trigger.source === "chain" && !targeted.has(e.id) && !seeded.has(e.id))
    .map((e) => e.id);

  const attributeLabels = (tpl.attributes.labels ?? {}) as Record<string, string>;
  return {
    template: {
      id: entry.ref.id,
      version: entry.ref.version,
      name: tpl.meta.name,
      description: tpl.meta.description,
      startYear: tpl.meta.startYear,
    },
    generatedAt: new Date().toISOString(),
    labels: attributeLabels,
    attributes: tpl.attributes.order,
    // 资源显示名从模板取（`lookup.resourceLabel`：statusBar 段 > resources[].label > 键名）。
    // 不再写死「生命 / 咒力」——那是一个世界的叫法，另一份模板的 mp 可能叫「能量」。
    resources: Object.fromEntries(
      Object.keys(tpl.resources).map((key) => [key, entry.lookup.resourceLabel(key)]),
    ),
    characters: tpl.characters.map((c) => ({
      id: c.id,
      name: c.identity.name,
      isEnemy: c.isEnemy === true,
      ...(c.identity.gender !== undefined ? { gender: c.identity.gender } : {}),
      ...(c.identity.age !== undefined ? { age: c.identity.age } : {}),
      ...(c.identity.description !== undefined ? { description: c.identity.description } : {}),
      ...(c.visibility !== undefined ? { visibility: c.visibility } : {}),
      ...(c.relationship !== undefined ? { relationship: c.relationship } : {}),
      relations: (c.relations ?? []).map((r) => ({
        to: r.to,
        kind: r.kind,
        ...(r.value !== undefined ? { value: r.value } : {}),
        ...(r.visibility !== undefined ? { visibility: r.visibility } : {}),
      })),
    })),
    spawnRules: (tpl.npcSpawnRules ?? []).map((rule) => ({
      id: rule.id,
      characterRef: rule.characterRef,
      ...(rule.age !== undefined ? { age: rule.age } : {}),
    })),
    items: tpl.items.map((i) => ({ id: i.id, name: i.name })),
    skills: tpl.skills.map((s) => ({ id: s.id, name: s.name })),
    statuses: tpl.statuses.map((s) => ({ id: s.id, name: s.name })),
    events: tpl.events,
    edges,
    flags: [...flags.entries()]
      .map(([id, row]) => ({ id, writers: row.writers, readers: row.readers }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    openingParams: openingParamOverwrites(entry.openingDag),
    endings,
    termination,
    chains: (tpl.chains ?? []) as unknown[],
    stats: {
      eventCount: tpl.events.length,
      edgeCount: edges.length,
      flagCount: flags.size,
      danglingEdges,
      orphanChainEvents,
      openingFlagWrites: new Set(openingWrites.map((w) => w.flag)).size,
      openingSeedEvents: [...seeded],
    },
  };
}

/* ------------------------------------------------------------------ *
 * 体检（agent 最需要的那部分）
 * ------------------------------------------------------------------ */

export interface AdminIssue {
  level: "error" | "warn" | "info";
  /** 稳定规则名，便于 agent 按规则聚合 / 忽略。 */
  rule:
    | "dangling-edge"
    | "orphan-chain-event"
    | "sink-event"
    | "flag-never-written"
    | "flag-never-read"
    | "ending-unreachable"
    | "unknown-condition-ref"
    /** B-04：开局同一个 param id 被同一条路径上的两处写，后写静默覆盖先写。 */
    | "opening-param-overwrite";
  subject?: string;
  message: string;
}

interface RefTables {
  attributes: Set<string>;
  statuses: Set<string>;
  items: Set<string>;
  skills: Set<string>;
  npcs: Set<string>;
  flags: Set<string>;
}

/** 条件里引用的 id 是否在本模板里存在。只查 id 型引用，不做语义判断。 */
function checkConditionRefs(conditions: unknown, where: string, table: RefTables, out: AdminIssue[]): void {
  if (!Array.isArray(conditions)) return;
  for (const raw of conditions) {
    if (raw === null || typeof raw !== "object") continue;
    const cond = raw as Record<string, unknown>;
    const push = (kind: string, id: string, exists: boolean) => {
      if (!exists) {
        out.push({
          level: "warn",
          rule: "unknown-condition-ref",
          subject: id,
          message: `${where} 引用了不存在的${kind}「${id}」`,
        });
      }
    };
    if (typeof cond.attribute === "string") push("属性", cond.attribute, table.attributes.has(cond.attribute));
    if (typeof cond.status === "string") push("状态", cond.status, table.statuses.has(cond.status));
    if (typeof cond.inventory === "string") push("物品", cond.inventory, table.items.has(cond.inventory));
    if (typeof cond.requiresSkill === "string") push("技能", cond.requiresSkill, table.skills.has(cond.requiresSkill));
    if (typeof cond.relation === "string") push("角色", cond.relation, table.npcs.has(cond.relation));
    if (typeof cond.selfIs === "string" && cond.selfIs !== "player") {
      push("角色", cond.selfIs, table.npcs.has(cond.selfIs));
    }
    if (typeof cond.selfIsNot === "string" && cond.selfIsNot !== "player") {
      push("角色", cond.selfIsNot, table.npcs.has(cond.selfIsNot));
    }
    const npcState = cond.npcState as Record<string, unknown> | undefined;
    if (npcState && typeof npcState.npcId === "string") {
      push("角色", npcState.npcId, table.npcs.has(npcState.npcId));
    }
  }
}

/**
 * 结局 / 终止条件会读的旗标集合（`sink-event` 的「通向结局」判据）。
 *
 * 只读 `endings[].triggerConditions` 与 `terminationConditions[].params.conditions`：
 * `unlockConditions` 是解锁条件，不是「这一局走完了」。
 */
export function terminationFlagsOf(orch: AdminOrchestration): Set<string> {
  const out = new Set<string>();
  for (const raw of orch.endings) {
    for (const flag of flagsReadInConditions((raw as Record<string, unknown>).triggerConditions)) out.add(flag);
  }
  for (const raw of orch.termination) {
    const cond = raw as Record<string, unknown>;
    const params = (cond.params ?? {}) as Record<string, unknown>;
    for (const flag of flagsReadInConditions(params.conditions)) out.add(flag);
  }
  return out;
}

/** 事件所有结算分支的 effects：选项 / 转盘分段 / 战斗结果 / 未展开的 branch 节点。 */
function settlementEffectLists(event: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  const settle = (event.settle ?? {}) as Record<string, unknown>;
  const normal = settle.normal as Record<string, unknown> | undefined;
  for (const option of (normal?.options as Array<Record<string, unknown>>) ?? []) out.push(option.effects);
  const random = settle.random as Record<string, unknown> | undefined;
  const wheel = random?.wheel as Record<string, unknown> | undefined;
  for (const segment of (wheel?.segments as Array<Record<string, unknown>>) ?? []) out.push(segment.effects);
  const combat = settle.combat as Record<string, unknown> | undefined;
  for (const key of ["onVictory", "onDefeat", "onFlee"]) {
    const outcome = combat?.[key] as Record<string, unknown> | undefined;
    if (outcome !== undefined) out.push(outcome.effects);
  }
  // 加载期已把 `events[].branch` 展开成普通事件；这里兜底未展开的原始结构。
  for (const node of (event.branch as Array<Record<string, unknown>>) ?? []) {
    for (const option of (node.options as Array<Record<string, unknown>>) ?? []) out.push(option.effects);
  }
  return out;
}

/** 这一幕结束后玩家还能不能继续走（`sink-event` 的「出边」）。 */
function hasOutgoingEdge(event: Record<string, unknown>): boolean {
  const settle = (event.settle ?? {}) as Record<string, unknown>;

  const normal = settle.normal as Record<string, unknown> | undefined;
  for (const option of (normal?.options as Array<Record<string, unknown>>) ?? []) {
    if (nextEventIdOf(option)) return true;
  }
  const random = settle.random as Record<string, unknown> | undefined;
  const wheel = random?.wheel as Record<string, unknown> | undefined;
  for (const segment of (wheel?.segments as Array<Record<string, unknown>>) ?? []) {
    if (nextEventIdOf(segment)) return true;
  }
  const combat = settle.combat as Record<string, unknown> | undefined;
  for (const key of ["onVictory", "onDefeat", "onFlee"]) {
    if (nextEventIdOf(combat?.[key])) return true;
  }
  for (const node of (event.branch as Array<Record<string, unknown>>) ?? []) {
    for (const option of (node.options as Array<Record<string, unknown>>) ?? []) {
      if (nextEventIdOf(option) || option.goto !== undefined) return true;
    }
  }
  // enqueueEvent 把后续事件排进队列，同样不是死胡同。
  for (const effects of settlementEffectLists(event)) {
    if (!Array.isArray(effects)) continue;
    for (const raw of effects) {
      if (raw !== null && typeof raw === "object" && (raw as Record<string, unknown>).type === "enqueueEvent") {
        return true;
      }
    }
  }
  return false;
}

/**
 * 事件是否写过任何一个结局 / 终止条件读取的旗标。
 *
 * `setFlag` 是常见的「达成某结局」，但 `adjustFlag` 也可能是在累加阈值
 * （`truthBits` / `savedCivilians` 这类 `gte` 判据）——两种都算「通向结局」，
 * 否则「攒够三条真相」这种设计会被误报成断头路。
 */
function writesTerminationFlag(event: Record<string, unknown>, terminationFlags: ReadonlySet<string>): boolean {
  if (terminationFlags.size === 0) return false;
  for (const effects of settlementEffectLists(event)) {
    if (!Array.isArray(effects)) continue;
    for (const raw of effects) {
      if (raw === null || typeof raw !== "object") continue;
      const effect = raw as Record<string, unknown>;
      if (typeof effect.id !== "string" || !terminationFlags.has(effect.id)) continue;
      if (effect.type === "setFlag" || effect.type === "adjustFlag") return true;
    }
  }
  return false;
}

/**
 * 链上事件没有出口。
 *
 * 「链上」= `trigger.source: chain`，或被别的任何边（nextEventId / goto / 转盘 / 战斗结果 /
 * enqueueEvent）指向。`source: pool` 的日常事件天然不在链上，不算。
 * `chains[].steps` 里非末位的步骤由调度器推进，也算有出口。
 */
function findSinkEvents(orch: AdminOrchestration, terminationFlags: ReadonlySet<string>): string[] {
  const targeted = new Set(orch.edges.map((edge) => edge.to));
  /**
   * 「交接给时间表」的旗标（2026-11-20）：本事件写的旗标被某个**非链事件**的 trigger 读走。
   *
   * `ev-bs-06` 就是这样：它写完 `ready3` / `chapter` 就结束，下一幕 `ev-ch3-gate` 是
   * `source: schedule` 的定时门 —— 链条没有断，只是从「下一幕」换成了「等世界时钟」。
   * 以前这种交接一律报 sink-event，是误报；模板作者只好硬塞一个假的 nextEventId，
   * 反而把定时门变成立刻触发。
   */
  const gateEventIds = new Set<string>();
  for (const raw of orch.events) {
    const event = raw as Record<string, unknown>;
    const trigger = (event.trigger ?? {}) as Record<string, unknown>;
    if (trigger.source !== "chain") gateEventIds.add(String(event.id ?? ""));
  }
  const handoffFlags = new Set<string>();
  for (const row of orch.flags) {
    const readByGate = row.readers.some(
      (r) => r.where === "trigger" && r.eventId !== undefined && gateEventIds.has(r.eventId),
    );
    if (readByGate && row.writers.length > 0) handoffFlags.add(row.id);
  }
  const writtenBy = new Map<string, Set<string>>();
  for (const row of orch.flags) {
    if (!handoffFlags.has(row.id)) continue;
    for (const writer of row.writers) {
      if (writer.source === "opening") continue;
      const set = writtenBy.get(writer.eventId) ?? new Set<string>();
      set.add(row.id);
      writtenBy.set(writer.eventId, set);
    }
  }
  const chainAdvanced = new Set<string>();
  for (const raw of orch.chains) {
    const steps = ((raw as Record<string, unknown>).steps as Array<Record<string, unknown>>) ?? [];
    for (let i = 0; i + 1 < steps.length; i += 1) {
      const id = steps[i]?.eventId;
      if (typeof id === "string") chainAdvanced.add(id);
    }
  }

  const out: string[] = [];
  for (const raw of orch.events) {
    const event = raw as Record<string, unknown>;
    const id = String(event.id ?? "?");
    const trigger = (event.trigger ?? {}) as Record<string, unknown>;
    if (trigger.source !== "chain" && !targeted.has(id)) continue;
    if (hasOutgoingEdge(event) || chainAdvanced.has(id)) continue;
    if (writesTerminationFlag(event, terminationFlags)) continue;
    // 交接给时间表（写了定时门的门闩旗标）不算死胡同。
    if ((writtenBy.get(id)?.size ?? 0) > 0) continue;
    out.push(id);
  }
  return out;
}

/**
 * 静态体检：把「模板写错了但这辈子都不会报错」的形态找出来。
 *
 * 只看能确定的（引用不存在 / 无人写入 / 断链），不做「这条线好不好玩」这类判断。
 * 结局依赖死旗标算 error：那不是缺内容，是结局永远打不开。
 */
export function diagnoseOrchestration(orch: AdminOrchestration): AdminIssue[] {
  const issues: AdminIssue[] = [];
  const eventIds = new Set(orch.events.map((e) => (e as { id: string }).id));
  const writersOf = new Map(orch.flags.map((f) => [f.id, f.writers.length]));
  const readersOf = new Map(orch.flags.map((f) => [f.id, f.readers.length]));

  const table: RefTables = {
    attributes: new Set(orch.attributes),
    statuses: new Set(orch.statuses.map((s) => s.id)),
    items: new Set(orch.items.map((i) => i.id)),
    skills: new Set(orch.skills.map((s) => s.id)),
    npcs: new Set(orch.characters.map((c) => c.id)),
    flags: new Set(orch.flags.map((f) => f.id)),
  };

  // 1) 断链：连到不存在的事件
  for (const edge of orch.stats.danglingEdges) {
    issues.push({
      level: "error",
      rule: "dangling-edge",
      subject: edge.from,
      message: `${edge.from} → ${edge.to}（${edge.type}: ${edge.label}）指向不存在的事件`,
    });
  }

  // 2) 链事件永远不会被排队：source=chain 却没有任何边指向它
  const chainStarts = new Set<string>();
  for (const chain of orch.chains as Array<Record<string, unknown>>) {
    if (typeof chain.startEventId === "string") chainStarts.add(chain.startEventId);
  }
  for (const id of orch.stats.orphanChainEvents) {
    if (chainStarts.has(id)) continue;
    issues.push({
      level: "error",
      rule: "orphan-chain-event",
      subject: id,
      message: `${id} 的 trigger.source 是 chain，但没有任何 nextEventId / enqueueEvent / 链首指向它`,
    });
  }

  // 3) 链上事件没有出口：既没有下一幕，也没有写任何结局 / 终止条件读的旗标
  const terminationFlags = terminationFlagsOf(orch);
  for (const id of findSinkEvents(orch, terminationFlags)) {
    issues.push({
      level: "warn",
      rule: "sink-event",
      subject: id,
      message: `链上事件无出口：${id}（既没有 nextEventId，也没有写任何结局旗标）`,
    });
  }

  // 4) 旗标只读不写（含开局写入：开局写的不算死旗标）
  for (const flag of orch.flags) {
    if (flag.writers.length > 0) continue;
    const wheres = [...new Set(flag.readers.map((r) => r.where))];
    const fatal = wheres.includes("ending") || wheres.includes("unlock") || wheres.includes("termination");
    issues.push({
      level: fatal ? "error" : "warn",
      rule: "flag-never-written",
      subject: flag.id,
      message: `被 ${flag.readers.length} 处读取（${wheres.join(" / ")}）但全模板无人写入`,
    });
  }

  // 5) 旗标只写不读：多半是写了没人用，不算错
  for (const flag of orch.flags) {
    if (flag.readers.length > 0) continue;
    if (flag.writers.length === 0) continue;
    issues.push({
      level: "info",
      rule: "flag-never-read",
      subject: flag.id,
      message: `${flag.writers.length} 处写入但没有任何条件 / 结局读取`,
    });
  }

  // 6) 结局不可达：触发或解锁条件里只要有死旗标，这个结局就永远不成立
  for (const raw of orch.endings) {
    const ending = raw as Record<string, unknown>;
    const id = String(ending.endingId ?? ending.id ?? "?");
    for (const [key, label] of [
      ["triggerConditions", "触发"],
      ["unlockConditions", "解锁"],
    ] as const) {
      const dead = flagsReadInConditions(ending[key]).filter((f) => (writersOf.get(f) ?? 0) === 0);
      if (dead.length > 0) {
        issues.push({
          level: "error",
          rule: "ending-unreachable",
          subject: id,
          message: `结局「${id}」的${label}条件依赖无人写入的旗标：${dead.join(", ")}`,
        });
      }
    }
  }

  // 7) 条件引用完整性（属性 / 状态 / 物品 / 技能 / 角色）
  for (const raw of orch.events) {
    const event = raw as Record<string, unknown>;
    const eventId = String(event.id ?? "?");
    const trigger = (event.trigger ?? {}) as Record<string, unknown>;
    checkConditionRefs(trigger.conditions, `${eventId}.trigger`, table, issues);
    checkConditionRefs(trigger.missWhen, `${eventId}.missWhen`, table, issues);
    const settle = (event.settle ?? {}) as Record<string, unknown>;
    const normal = settle.normal as Record<string, unknown> | undefined;
    for (const option of (normal?.options as Array<Record<string, unknown>>) ?? []) {
      checkConditionRefs(option.visibleWhen, `${eventId}.${String(option.id ?? "option")}.visibleWhen`, table, issues);
    }
  }
  for (const raw of orch.endings) {
    const ending = raw as Record<string, unknown>;
    const id = String(ending.endingId ?? ending.id ?? "?");
    checkConditionRefs(ending.triggerConditions, `ending:${id}.trigger`, table, issues);
    checkConditionRefs(ending.unlockConditions, `ending:${id}.unlock`, table, issues);
  }

  // 8) 开局参数被同一条路径上的两处写（B-04）：`Object.assign` 后写覆盖先写，全程静默
  for (const row of orch.openingParams) {
    issues.push({
      level: "warn",
      rule: "opening-param-overwrite",
      subject: row.param,
      message:
        `开局参数 ${row.param} 被 ${row.writers.length} 处写入（` +
        `${row.writers.map((w) => `${w.node}/${w.option}`).join("、")}），后写覆盖先写`,
    });
  }

  // 只写不读是 info，放在最后，不被错误淹没
  const order = { error: 0, warn: 1, info: 2 } as const;
  return issues.sort((a, b) => order[a.level] - order[b.level] || (a.subject ?? "").localeCompare(b.subject ?? ""));
}

/* ------------------------------------------------------------------ *
 * trace 读取
 * ------------------------------------------------------------------ */

export interface TraceFileSummary {
  entries: LlmTrace[];
  skippedLines: number;
  bytes: number;
  stats: {
    committed: number;
    fallback: number;
    deferred: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    maxLatencyMs: number;
    tools: Array<{ tool: string; count: number }>;
    diagnostics: Array<{ code: string; count: number }>;
    fallbackCodes: Array<{ code: string; count: number }>;
  };
}

/** 损坏行跳过而不是整份失败：append-only 文件可能被进程崩溃截断在最后一行。 */
export function readTraceFile(worldId: string): TraceFileSummary {
  const file = traceFile(worldId);
  const raw = readFileSync(file, "utf-8");
  const entries: LlmTrace[] = [];
  let skippedLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      entries.push(JSON.parse(trimmed) as LlmTrace);
    } catch {
      skippedLines += 1;
    }
  }

  const tools = new Map<string, number>();
  const diagnostics = new Map<string, number>();
  const fallbackCodes = new Map<string, number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let committed = 0;
  let fallback = 0;
  let deferred = 0;
  const latencies: number[] = [];

  for (const entry of entries) {
    if (entry.outcome === "committed") committed += 1;
    else if (entry.outcome === "fallback") fallback += 1;
    else deferred += 1;
    inputTokens += entry.inputTokens ?? 0;
    outputTokens += entry.outputTokens ?? 0;
    latencies.push(entry.latencyMs ?? 0);
    for (const call of entry.calls ?? []) tools.set(call.tool, (tools.get(call.tool) ?? 0) + 1);
    for (const code of entry.diagnostics ?? []) diagnostics.set(code, (diagnostics.get(code) ?? 0) + 1);
    if (entry.fallbackCode) fallbackCodes.set(entry.fallbackCode, (fallbackCodes.get(entry.fallbackCode) ?? 0) + 1);
  }

  latencies.sort((a, b) => a - b);
  const p95 =
    latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]!;
  const avg = latencies.length === 0 ? 0 : latencies.reduce((s, v) => s + v, 0) / latencies.length;

  return {
    entries,
    skippedLines,
    bytes: statSync(file).size,
    stats: {
      committed,
      fallback,
      deferred,
      inputTokens,
      outputTokens,
      avgLatencyMs: Math.round(avg),
      p95LatencyMs: p95,
      maxLatencyMs: latencies.length === 0 ? 0 : latencies[latencies.length - 1]!,
      tools: [...tools.entries()].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
      diagnostics: [...diagnostics.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      fallbackCodes: [...fallbackCodes.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 世界列表（磁盘扫描，含不可载档）
 * ------------------------------------------------------------------ */

export interface AdminWorldRow {
  id: string;
  playerName?: string;
  templateId?: string;
  templateVersion?: string;
  templateName?: string;
  turnIndex?: number;
  worldTime?: number;
  formattedTime?: string;
  status?: "running" | "terminated" | "archived";
  loadable: boolean;
  unloadableReason?: string;
  /** 可诊断的具体原因（哪个字段 / 哪个模板版本），比 reason 枚举有用。 */
  unloadableDetail?: string;
  savedAt?: string;
  trace: { exists: boolean; entries: number; bytes: number };
}

/**
 * 世界列表。
 *
 * `input` 用于 CLI：它自己调 `loadPersistedWorlds()` 拿结果，**不调 `hydrate()`**——
 * `hydrate()` 在规范化时会回写存档，而只读工具不能写盘。不传则读服务端已载入的内存表。
 */
export function listWorlds(input?: {
  loaded: readonly WorldRecord[];
  unloadable: readonly UnloadableWorld[];
}): AdminWorldRow[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  const source = input?.loaded ?? worldStore.all();
  const skipped = input?.unloadable ?? worldStore.unloadableAll();
  const loaded = new Map(source.map((r) => [r.state.id, r]));
  const rows = new Map<string, AdminWorldRow>();

  for (const name of readdirSync(dir)) {
    if (name.endsWith(".trace.jsonl")) {
      const id = name.slice(0, -".trace.jsonl".length);
      const file = path.join(dir, name);
      const size = statSync(file).size;
      const lineCount = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "").length;
      const existing = rows.get(id) ?? { id, loadable: false, trace: { exists: true, entries: 0, bytes: 0 } };
      existing.trace = { exists: true, entries: lineCount, bytes: size };
      rows.set(id, existing);
    } else if (name.endsWith(".json")) {
      const id = name.slice(0, -".json".length);
      const existing = rows.get(id) ?? { id, loadable: false, trace: { exists: false, entries: 0, bytes: 0 } };
      existing.savedAt = statSync(path.join(dir, name)).mtime.toISOString();
      rows.set(id, existing);
    }
  }

  for (const row of rows.values()) {
    const record = loaded.get(row.id);
    if (record) {
      const state = record.state;
      row.loadable = true;
      row.playerName = state.player.name;
      row.templateId = record.entry.ref.id;
      row.templateVersion = record.entry.ref.version;
      row.templateName = record.entry.template.meta.name;
      row.turnIndex = state.turnIndex;
      row.worldTime = state.worldTime;
      row.status = state.archived === true ? "archived" : state.termination !== null ? "terminated" : "running";
      // 时间格式化只在可载档做得出来（需要模板历法）。
      try {
        row.formattedTime = createTimeAdapter(record.entry.template).format(state.worldTime);
      } catch {
        row.formattedTime = undefined;
      }
    }
  }

  for (const unloadable of skipped) {
    const row = rows.get(unloadable.id);
    if (row) {
      row.unloadableReason = unloadable.reason;
      row.unloadableDetail = unloadable.detail;
      row.templateId = unloadable.templateId;
      row.templateVersion = unloadable.templateVersion;
    }
  }

  return [...rows.values()].sort((a, b) => ((a.savedAt ?? "") < (b.savedAt ?? "") ? 1 : -1));
}
