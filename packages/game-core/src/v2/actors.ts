import type { V2Npc, V2Player, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { PLAYER_NODE_ID } from "./relations.js";

/**
 * 演员表访问层（A 期提前施工 · 2026-11-16 用户裁决）。
 *
 * **要解决的问题**：同一个「人」在引擎里有两个身份来源 —— 玩家在 `state.player`，
 * 其余人（以及将来的观察者）在 `state.npcs`。于是凡是「按 id 找一个人」的地方
 * 都得先特判 `id === "player"`，字面量散落在关系/战斗/调度/投影里，切视角时无处下手。
 *
 * **做法**：引入 `selfIdOf(state)` 作为「玩家这个节点的唯一名字」，再给一个
 * `actorOf(state, id)` 把两类身份统一成 `ActorRef`。调用方不再关心「这是玩家还是 NPC」。
 *
 * **完整切换（ADR-001 / 2026-11-18）**：权威 self 实体就是 `state.player`，`selfId` 是它在
 * 演员表 / 关系图里的名字。扮演模板角色时 `selfId = <characterId>`，该角色**不另建 npc 实例**
 * （杜绝两份真相与同步补丁）；`actorOf` 在 `npcs` 找不到时按 `id === selfId` 回落到玩家，
 * 因此所有上层调用点（关系 / 战斗 / 投影）天然正确，不需要改。
 *
 * 关系图节点 id 与实例 id 是同一个字符串（`nodeId` 字段留给将来需要区分的场景）。
 */
export interface ActorRef {
  /** 演员 id（= 关系图节点 id）。 */
  readonly id: string;
  /** 展示名。任何地方都不得再用裸 id 当人名（隐藏/未登场者也有名字）。 */
  readonly name: string;
  /** 是否玩家自身（本期 = `id === selfIdOf(state)`）。 */
  readonly isSelf: boolean;
  /** 实例条目；玩家当前没有实例 ⇒ 缺省。切存储后这里就会有值。 */
  readonly npc?: V2Npc;
}

/**
 * 玩家节点的 id。
 *
 * 为什么允许缺省回落而不是直接在 schema 里给默认值：`selfId` 是**新增可选字段**，
 * 目的是"旧档直载"；兜底值就是历史字面量 `"player"`，与 `schema/relation.ts`
 * 的 `PLAYER_ID` 同值，所以旧档行为逐字段不变。
 */
export function selfIdOf(state: WorldStateV2): string {
  return state.selfId ?? PLAYER_NODE_ID;
}

/**
 * 按 id 取演员。**先查实例、再查玩家** —— 这个顺序是切存储的兼容点：
 * 玩家进 `npcs` 之后无需改动任何调用点，`isSelf` 靠 id 相等判定仍然成立。
 *
 * 找不到返回 `null`（不猜、不造人）；调用方自行决定"未知 id"该怎么处理。
 */
export function actorOf(state: WorldStateV2, id: string): ActorRef | null {
  const selfId = selfIdOf(state);
  const npc = state.npcs.find((n) => n.id === id);
  if (npc) return { id: npc.id, name: npc.name, isSelf: npc.id === selfId, npc };
  if (id === selfId) return { id, name: state.player.name, isSelf: true };
  return null;
}

/**
 * 一次建好「id → 演员」目录，供投影这种需要反复取名的场景使用
 * （避免在关系行循环里对每个 id 都 `find` 一遍）。
 *
 * 四个来源，优先级从低到高：模板声明 → 运行时角色定义 → 实例 → 玩家。
 * - 模板放最前，是为了让**没有实例的敌人**也有名字：关系边可以指向它
 *   （`characters[].relations[].to` 允许指到任何已声明角色），但 `state.npcs` 里没有它；
 * - `generatedCharacters` 是 `submitBranch` 造的人，正常情况下同时有 `unspawned` 实例，
 *   放在实例前面只是兜底（定义在、实例被裁掉时仍能取到名字）；
 * - 实例覆盖前两者（实例是运行时权威，名字可能被生成内容改过）；
 * - 玩家放最后：被 self 复用的角色虽在模板声明里有一行，但**没有 npc 实例**，
 *   这里用 `state.player.name` 覆盖它——权威名只有一个来源。
 *
 * 引用完整性：加载期 `WorldTemplateV2Schema.superRefine` 已保证 `relations[].to` /
 * `addRelationEdge.toId` 只能指向「已声明角色」或 `PLAYER_ID`，所以本目录**必然命中**。
 * 换句话说，`UNKNOWN_ACTOR` 这条兜底只有在数据绕过校验时才可能出现 —— 它存在只是
 * 为了「宁可显示不明人物，也绝不把裸 id 当人名摆到玩家面前」。
 */
export function buildActorDirectory(
  state: WorldStateV2,
  template?: WorldTemplateV2,
): Map<string, ActorRef> {
  const selfId = selfIdOf(state);
  const directory = new Map<string, ActorRef>();
  for (const c of template?.characters ?? []) {
    directory.set(c.id, { id: c.id, name: c.identity.name, isSelf: c.id === selfId });
  }
  for (const c of state.generatedCharacters ?? []) {
    directory.set(c.id, { id: c.id, name: c.identity.name, isSelf: c.id === selfId });
  }
  for (const n of state.npcs) {
    directory.set(n.id, { id: n.id, name: n.name, isSelf: n.id === selfId, npc: n });
  }
  directory.set(selfId, { id: selfId, name: state.player.name, isSelf: true });
  return directory;
}

/** 目录里查不到人时的占位名。**不得**回落成裸 id（玩家看到的必须是人话）。 */
export const UNKNOWN_ACTOR = "（不明人物）";

/** 目录取名；未知 id 用占位名，绝不把裸 id 当人名下发。 */
export function actorName(directory: ReadonlyMap<string, ActorRef>, id: string): string {
  return directory.get(id)?.name ?? UNKNOWN_ACTOR;
}

/**
 * 「这个人还在场上吗」—— 关系写入判活（ADR-0020），**只拦确知非在世**的：
 * - 玩家恒在世（没有 lifecycle）；
 * - 找不到该 id：无法判定 ⇒ 按可写处理（引用完整性由加载期 `superRefine` 负责，
 *   这里不做猜测，否则会把「指向未实例化角色的边」一并挡掉）；
 * - 找到 NPC：要求 `lifecycle.state === "alive"`。
 *
 * 注意与 `scheduler.isActorPresent` 的差别：那边「未知 id ⇒ 不在场」（宁可少演一幕），
 * 这边「未知 id ⇒ 可写」（不擅自挡掉）。两者口径不同，不要合并。
 */
export function isAliveActor(state: WorldStateV2, id: string): boolean {
  const actor = actorOf(state, id);
  if (!actor) return true;
  return actor.isSelf ? true : actor.npc?.lifecycle.state === "alive";
}

// ══════════════════════════════════════════════════════════════════
// 可写演员（ADR-010 D2）
// ══════════════════════════════════════════════════════════════════

export interface WritableActor {
  /** 可直接改写的人（字段同构，调用方不必分情况）。 */
  actor: V2Player | V2Npc;
  isSelf: boolean;
}

/**
 * 效果的作用对象解析 —— **能力流转的唯一入口**。
 *
 * - `who` 缺省或等于 `selfIdOf(state)` ⇒ `state.player`；
 * - 否则在 `state.npcs` 里找，**要求 `lifecycle.state === "alive"`**；
 * - 找不到 / 已离场 ⇒ `null`（调用方静默跳过：不造人、不改别人、不抛错）。
 *
 * 为什么"已离场"要拦：给一具尸体发物品会让 `inventory` 成为无主数据，
 * 而复活逻辑（ADR-0020）不负责搬回这些东西。宁可这次不给，也不留悬空资产。
 */
export function writableActorOf(state: WorldStateV2, who?: string): WritableActor | null {
  const selfId = selfIdOf(state);
  const id = who ?? selfId;
  if (id === selfId) return { actor: state.player, isSelf: true };
  const npc = state.npcs.find((n) => n.id === id);
  if (npc === undefined) return null;
  if (npc.lifecycle.state !== "alive") return null;
  return { actor: npc, isSelf: false };
}

// ══════════════════════════════════════════════════════════════════
// 演员搬运（ADR-010 D1）
// ══════════════════════════════════════════════════════════════════

/** 可被搬运的两种结构。字段集互为子集（D1），所以按名拷贝总是安全的。 */
export type TransferableActor = V2Player | V2Npc;

/**
 * 字段分组。**这是「切换角色 / 夺舍 / 共生 / 继承」四个场景共用的唯一词汇表**：
 *
 * - `body`：身体侧 —— 六维、血蓝、身上的状态、背包与装备。夺舍时**留原地**。
 * - `mind`：意识侧 —— 会什么、知道什么、长到几级。夺舍时**跟着走**。
 * - `identity`：他是谁。切换角色时跟着走；继承时只搬血缘指针。
 * - `standing`：在场上是什么处境（生死、可见性、对 self 的好感）。
 *
 * **`age` 故意不在此列**：NPC 的 `age` 是起始快照（ADR-0021），玩家的 `age` 是当前年龄，
 * 同名不同义。搬运后一律按 `birthTime + worldTime` 现算，绝不做字段拷贝。
 */
export const ACTOR_FIELD_GROUPS = {
  body: [
    "attributes",
    "attributeTiers",
    "hp",
    "mp",
    "mood",
    "statuses",
    "skillCooldowns",
    "resources",
    "equipment",
    "inventory",
  ],
  mind: ["skills", "growthLevel", "knowledge", "secrets", "goals", "traits", "personality"],
  identity: ["name", "gender", "birthTime", "fatherId", "motherId"],
  standing: ["lifecycle", "visibility", "isEnemy", "relationship", "lastActedAtTurn"],
} as const satisfies Record<string, ReadonlyArray<keyof V2Player | keyof V2Npc>>;

export type ActorFieldGroup = keyof typeof ACTOR_FIELD_GROUPS;

/**
 * 按分组把 `source` 的字段写到 `target` 上（原地改写 target）。
 *
 * **语义是「覆盖」，不是「合并」**：`source` 没有的字段在 `target` 上会被删掉（置 undefined），
 * 否则切回去时会留下上一个人的残影——那正是「两份真相」的来源。
 *
 * `id` 永不被搬运：它是关系图节点、是 self 的名字，由调用方决定。
 */
export function transplantActor(
  source: TransferableActor,
  target: TransferableActor,
  groups: readonly ActorFieldGroup[],
): void {
  const from = source as unknown as Record<string, unknown>;
  const to = target as unknown as Record<string, unknown>;
  for (const group of groups) {
    for (const field of ACTOR_FIELD_GROUPS[group] as readonly string[]) {
      const value = from[field];
      if (value === undefined) delete to[field];
      else to[field] = structuredClone(value);
    }
  }
}
