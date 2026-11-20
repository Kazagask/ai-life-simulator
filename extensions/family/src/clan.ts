import { z } from "zod";
import type { WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import {
  UNKNOWN_ACTOR,
  actorOf,
  selfIdOf,
  type ConditionEvalContext,
  type ConditionEvalFn,
  type ExtensionEffectContext,
  type ExtensionEffectHandler,
} from "@life-sim/game-core";

/**
 * 宗族（`extensions/family/doc/CLAN-DESIGN.md` 第二部分）：**新实体**，不是族谱的派生。
 *
 * 与族谱的分工（§0）：族谱是关系图的发散视图（零 state）；宗族有自己的生命周期
 * （族名 / 声望 / 家主 / 兴衰 / 族学 / append-only 大事记 / 权威成员表），只被显式
 * effect 改。**两者互不依赖**：删掉这里的整段数据，族谱照样画得出来；反过来也一样。
 *
 * 边界（`docs/EXTENSIONS.md` §1）：本文件只写 `state.extensions.family`，不碰关系事实、
 * 不碰可见性、不碰投影。内核不认识「宗族」，只把它当一段不透明的 JSON。
 *
 * 防的不是「两个真相」，而是**没有记录的漂移**（§2.2）：
 * · 入族 / 出族只能经 `joinClan` / `leaveClan`，**必须带 reason**，并**自动追加一条 history**；
 * · 禁止任何「父亲的族就是我的族」式的隐式继承；
 * · 出族**不删成员条目**，写 `leftAt` + `leftReason` 留史。
 */

// ---------- 数据模型（§2.1，全部进存档） ----------

/** 兴衰三态（§2.3「借 CK 的兴衰」：只要这三态，不做封臣层级）。 */
export const CLAN_STATUSES = ["active", "extinct", "exiled"] as const;
export type ClanStatus = (typeof CLAN_STATUSES)[number];

/** 大事记种类（封闭枚举：新种类必须改协议，不能自由书写）。 */
export const CLAN_HISTORY_KINDS = [
  "founded",
  "head_changed",
  "prestige",
  "member_joined",
  "member_left",
  "extinct",
  "legacy",
  "custom",
] as const;
export type ClanHistoryKind = (typeof CLAN_HISTORY_KINDS)[number];

/** 入族途径（§2.1）。**在族但无亲缘路径**的人必须靠 `adoption` / `override` 解释（§3）。 */
export const CLAN_MEMBER_VIAS = ["birth", "marriage", "adoption", "override"] as const;
export type ClanMemberVia = (typeof CLAN_MEMBER_VIAS)[number];

export const ClanHistoryEntrySchema = z
  .object({
    /** 世界时间（分钟）。 */
    at: z.number().int(),
    turn: z.number().int().nonnegative(),
    kind: z.enum(CLAN_HISTORY_KINDS),
    /** 人话（模板文案或引擎拼接）。**只追加，不改史**。 */
    text: z.string().min(1),
    /** 涉及的人（actor id）/ 事件 id。 */
    refs: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ClanFactSchema = z
  .object({
    /** 稳定 key（模板声明里必须存在）。 */
    id: z.string().min(1),
    /** 族名 / 氏号：从模板初始化，之后可由 `clanHistory` 之外的写点改（改姓在 v1 不做）。 */
    name: z.string().min(1),
    /** 郡望 / 祖宅。 */
    seat: z.string().min(1).optional(),
    /** 累计声望（可增可减，钳在模板配置域内 —— `adjustClanPrestige` 是唯一写点）。 */
    prestige: z.number(),
    /** 可支配声名（CK 味；v1 只保留字段，不消费）。 */
    renown: z.number().optional(),
    /** 家主；`null` = 空缺 / 族老摄政。 */
    headId: z.string().min(1).nullable(),
    status: z.enum(CLAN_STATUSES),
    /** 立族的世界时间（分钟）。 */
    foundedAt: z.number().int(),
    /** 已解锁族学 / 家训（候选由模板声明，运行时解锁）。 */
    legacies: z.array(z.string().min(1)),
    /** append-only 大事记。 */
    history: z.array(ClanHistoryEntrySchema),
  })
  .strict();

export const ClanMemberSchema = z
  .object({
    /** 玩家或 NPC，一视同仁。 */
    actorId: z.string().min(1),
    clanId: z.string().min(1),
    /** 入族的世界时间。 */
    since: z.number().int(),
    /** "家主" / "族老" / "嫡长" …（模板自定义词，引擎不解释）。 */
    role: z.string().min(1).optional(),
    via: z.enum(CLAN_MEMBER_VIAS),
    /** 出族时间；缺省 = 在族。**出族不删条目**。 */
    leftAt: z.number().int().optional(),
    /** "出继" / "嫁出" / "除籍" / "身故"（模板自由文本，引擎不解释）。 */
    leftReason: z.string().min(1).optional(),
  })
  .strict();

/**
 * 婚配（`extensions/family/doc/FAMILY-GRAPH.md` §3.2）：`a` / `b` **无向**，按 `(min,max)` 归一去重；
 * `until` 表达和离 / 丧偶（历史留在表里，不删条目）；**多妻顺序 = 数组顺序**。
 *
 * 放在扩展切片而**不留在 core 的边里**：这些语义只有家族关心，core 今天没有消费者。
 */
export const KinSpouseFactSchema = z
  .object({
    a: z.string().min(1),
    b: z.string().min(1),
    since: z.number().int().optional(),
    until: z.number().int().optional(),
  })
  .strict();

/** 收养（`extensions/family/doc/FAMILY-GRAPH.md` §3.2 第三层推导）：`parent` 是养父母，`child` 是被收养者。 */
export const KinAdoptionFactSchema = z
  .object({
    child: z.string().min(1),
    parent: z.string().min(1),
    since: z.number().int().optional(),
    until: z.number().int().optional(),
  })
  .strict();

/**
 * `state.extensions.family` 的权威形状（整段严格）。
 *
 * `members` 是**权威表**，不是从关系图推的派生（§2.2）：嫁出去的女儿、出继的儿子、
 * 义子、入赘随妻族 —— 血缘与归族本来就不同。所以这里既允许「在族但无亲缘」，
 * 也允许「有亲缘但不在族」。
 *
 * `spouses` / `adoptions`（`extensions/family/doc/FAMILY-GRAPH.md` §3.2）**可选且不补缺省值**：
 * · 旧档 / 旧模板里没有这两个键 ⇒ 必须直载（`optional()` 而非 `default([])`，
 *   否则读档 round-trip 会凭空多出两个空数组，等于改了存档形状）；
 * · 一旦存在，**任何 clan effect 都必须原样保留** —— 本文件的写点全部走
 *   `ensureClanState`（整段解析，已含保留字段）→ 只改自己那部分 → `writeClanState`，
 *   **不要**另造 `{ clans, members }` 形状的裸对象重建切片（那会当场抹掉婚配表，
 *   亲属图随之塌掉；回归用例见 `extensions/family/test/clan-state-slice.test.ts`）。
 */
export const clanStateSchema = z
  .object({
    clans: z.array(ClanFactSchema),
    members: z.array(ClanMemberSchema),
    spouses: z.array(KinSpouseFactSchema).optional(),
    adoptions: z.array(KinAdoptionFactSchema).optional(),
  })
  .strict();

export type ClanHistoryEntry = z.infer<typeof ClanHistoryEntrySchema>;
export type ClanFact = z.infer<typeof ClanFactSchema>;
export type ClanMember = z.infer<typeof ClanMemberSchema>;
export type KinSpouseFact = z.infer<typeof KinSpouseFactSchema>;
export type KinAdoptionFact = z.infer<typeof KinAdoptionFactSchema>;
export type ClanState = z.infer<typeof clanStateSchema>;

/** 空切片（读侧兜底用；**不写回** state，避免把「没数据」写成「有数据」）。 */
const EMPTY_CLAN_STATE: ClanState = { clans: [], members: [] };

// ---------- 配置（`extensions.family` 的宗族段，§2.5） ----------

/** 一条模板族声明。**宗族只能由模板声明** —— 本文件不提供 `foundClan`（§2.5）。 */
export interface ClanDeclaration {
  readonly id: string;
  readonly name: string;
  readonly seat?: string;
  /**
   * 血缘根（谁是这一族的血脉起点）。B1 **只校验不消费**：族谱派生在 B2，
   * 且族谱按契约**永远不从族表推**（§3），这些字段只给「宗族视角」用。
   */
  readonly lineageRoots?: readonly string[];
  /** 世系类型（B1 只校验不消费，同 `lineageRoots`）。 */
  readonly descent?: "patrilineal" | "matrilineal" | "bilateral";
  /** 配偶是否入族（B1 只校验不消费）。 */
  readonly spouseJoins?: boolean;
  /** 声望初值（缺省 0，建世界时按 `prestige` 域夹紧）。 */
  readonly prestige?: number;
  /** 族学候选；`unlockLegacy` 只能解锁这里声明过的 id。 */
  readonly legacies?: readonly { readonly id: string; readonly name?: string }[];
}

export interface ClanConfig {
  readonly clans: readonly ClanDeclaration[];
  /** 声望域与单次调整上限（§4 风险 8：没有钳域就会一步登天）。 */
  readonly prestige: { readonly min: number; readonly max: number; readonly maxStep: number };
  /**
   * 模板声明的婚配表（`extensions.family.spouses`，`extensions/family/doc/FAMILY-GRAPH.md` §3.2）：
   * 建世界时**原样播种**进 `state.extensions.family.spouses` —— 指针模式下这是配偶行的唯一来源
   * （父/母来自 `fatherId`/`motherId`，婚姻没有指针形态）。已按无向对归一去重。
   */
  readonly spouses: readonly KinSpouseFact[];
  /** 模板声明的收养表（`extensions.family.adoptions`），口径同 `spouses`。 */
  readonly adoptions: readonly KinAdoptionFact[];
}

const DEFAULT_PRESTIGE = { min: 0, max: 100, maxStep: 20 } as const;

const LegacyDeclarationSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1).optional() })
  .strict();

const ClanDeclarationSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    seat: z.string().min(1).optional(),
    lineageRoots: z.array(z.string().min(1)).optional(),
    descent: z.enum(["patrilineal", "matrilineal", "bilateral"]).optional(),
    spouseJoins: z.boolean().optional(),
    prestige: z.number().optional(),
    /** 族学候选：允许简写为字符串 id（没有展示名时文本回落到 id）。 */
    legacies: z.array(z.union([z.string().min(1), LegacyDeclarationSchema])).optional(),
  })
  .strict();

/**
 * `extensions.family` 的**全部**配置键。
 *
 * ⚠ **配置里认下的每个键，都必须在 `initClanState` 里有对应落点**。这张 schema 是
 * `passthrough`：写进来而没人消费的键会被**静默忽略** —— `spouses` 就这样在 3c 之前
 * 被吞掉过（模板写了婚配、state 里一条都没有，配偶行整批消失，且全程无报错）。
 * 加字段时要么在 `initClanState` 里写进切片，要么在这里显式拒绝。
 */
const ClanConfigSchema = z
  .object({
    clans: z.array(ClanDeclarationSchema).optional(),
    /** 婚配 / 收养（指针模式的输入）：与宗族同段但**互不依赖**，见 ClanConfig 的注释。 */
    spouses: z.array(KinSpouseFactSchema).optional(),
    adoptions: z.array(KinAdoptionFactSchema).optional(),
    prestige: z
      .object({
        min: z.number().optional(),
        max: z.number().optional(),
        maxStep: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

/**
 * 婚配归一去重：`a` / `b` 无向（按 id 字典序取小端在前），同一对只留第一次出现
 * （**数组顺序 = 多妻先后**，去重不能打乱它），自环直接丢弃。
 */
function normalizeSpouses(list: readonly KinSpouseFact[]): KinSpouseFact[] {
  const seen = new Set<string>();
  const out: KinSpouseFact[] = [];
  for (const s of list) {
    if (s.a === s.b) continue;
    const [a, b] = s.a < s.b ? [s.a, s.b] : [s.b, s.a];
    const key = `${a}\u0000${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s, a, b });
  }
  return out;
}

/** 收养去重：`(parent, child)` 唯一，自养自丢弃；顺序保留。 */
function normalizeAdoptions(list: readonly KinAdoptionFact[]): KinAdoptionFact[] {
  const seen = new Set<string>();
  const out: KinAdoptionFact[] = [];
  for (const a of list) {
    if (a.parent === a.child) continue;
    const key = `${a.parent}\u0000${a.child}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function intClamp(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 解析宗族配置。**与族谱配置同源不同段**：族谱读 `showAllRoles` / `pedigree.*`，
 * 这里读 `clans` / `prestige`，两段互不依赖（与两者数据互不依赖同一纪律）。
 *
 * 口径：
 * · 取值宽松（`true` / 缺字段 / 类型不对 ⇒ 用缺省，不抛）—— 与 `parseFamilyConfig` 一致；
 * · **族声明本身**结构错误（缺 id/name、id 重复）⇒ 抛错：静默丢掉一个族会让它的
 *   声望与历史凭空少一半，比建局失败更难查。
 */
export function parseClanConfig(raw: unknown): ClanConfig {
  const prestige = {
    min: intClamp(readPath(raw, ["prestige", "min"]), DEFAULT_PRESTIGE.min, -1_000_000, 1_000_000),
    max: intClamp(readPath(raw, ["prestige", "max"]), DEFAULT_PRESTIGE.max, -1_000_000, 1_000_000),
    maxStep: intClamp(readPath(raw, ["prestige", "maxStep"]), DEFAULT_PRESTIGE.maxStep, 1, 1_000_000),
  };
  // min > max 的配置是写错了，不是「反向区间」：就地交换，别让每次调整都夹成 min。
  const bounds =
    prestige.min <= prestige.max
      ? prestige
      : { ...prestige, min: prestige.max, max: prestige.min };

  // 非对象 = 没声明宗族（`true` = 用默认配置；缺字段 / 类型不对 → 与 parseFamilyConfig 同口径）
  if (raw === undefined || raw === null || raw === true) {
    return { clans: [], prestige: bounds, spouses: [], adoptions: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { clans: [], prestige: bounds, spouses: [], adoptions: [] };
  }

  const parsed = ClanConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`clan_config_invalid: ${describeZodError(parsed.error)}`);
  }
  const declarations = (parsed.data.clans ?? []).map((d) => ({
    ...d,
    legacies: d.legacies?.map((l) => (typeof l === "string" ? { id: l } : l)),
  }));
  const seen = new Set<string>();
  for (const d of declarations) {
    if (seen.has(d.id)) throw new Error(`clan_config_invalid: 宗族 id 重复声明 "${d.id}"`);
    seen.add(d.id);
  }
  return {
    clans: declarations,
    prestige: bounds,
    spouses: normalizeSpouses(parsed.data.spouses ?? []),
    adoptions: normalizeAdoptions(parsed.data.adoptions ?? []),
  };
}

/** 按路径取值（配置是 `unknown`，不许直接下标）。非对象一律 undefined。 */
function readPath(raw: unknown, path: readonly string[]): unknown {
  let cur: unknown = raw;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function describeZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return "未知配置错误";
  return `${first.path.join(".") || "<root>"}: ${first.message}`;
}

// ---------- state 读写 ----------

/**
 * 读切片（**不抛**）：条件求值走这里 —— 坏数据已在读档期被 `stateSchema` 拦掉，
 * 这里再抛会让一局直接崩在求值上。缺省 / 坏形状一律当「没有宗族」。
 */
export function readClanState(state: WorldStateV2): ClanState {
  const parsed = clanStateSchema.safeParse(state.extensions?.family);
  return parsed.success ? parsed.data : EMPTY_CLAN_STATE;
}

/** 写前读（**抛**）：effect 是权威写点，坏切片上继续写会把历史写丢。 */
function ensureClanState(state: WorldStateV2): ClanState {
  const raw = state.extensions?.family;
  if (raw === undefined) return { clans: [], members: [] };
  const parsed = clanStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`clan_state_invalid: ${describeZodError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * 只替换 `family` 切片，**保留其它扩展的切片**（`state.extensions` 是共享命名空间）。
 *
 * `next` 必须是 `ensureClanState` 的返回值（或其副本）：整段解析已把 `spouses` /
 * `adoptions` 带上，写回时原样保留。**禁止**用 `{ clans, members }` 裸对象调用本函数
 * —— 那等于重建切片，婚配表会被静默抹掉（`extensions/family/doc/FAMILY-GRAPH.md` §7.1 第 2 条）。
 */
function writeClanState(state: WorldStateV2, next: ClanState): void {
  state.extensions = { ...(state.extensions ?? {}), family: next };
}

function findClan(clanState: ClanState, clanId: string): ClanFact {
  const clan = clanState.clans.find((c) => c.id === clanId);
  if (clan === undefined) {
    // 引用未声明的族属配置错误：抛可诊断错误，不静默跳过（与 addSecret 对未知 NPC 同口径）
    throw new Error(`未知宗族：${clanId}（宗族只能由模板 extensions.family.clans 声明）`);
  }
  return clan;
}

function historyEntry(
  state: WorldStateV2,
  kind: ClanHistoryKind,
  text: string,
  refs?: readonly string[],
): ClanHistoryEntry {
  return {
    at: state.worldTime,
    turn: state.turnIndex,
    kind,
    text,
    ...(refs !== undefined && refs.length > 0 ? { refs: [...refs] } : {}),
  };
}

/**
 * `__self__` 的解析：与 `engine.ts` 的 `addSecret` **同一约定** ——
 * 指当前执行行动的 NPC；玩家直接驱动的效果没有这个值，模板须显式写玩家节点 id。
 */
function resolveActorId(rawActorId: string, ctx: ExtensionEffectContext, effect: string): string {
  if (rawActorId !== "__self__") return rawActorId;
  if (ctx.selfNpcId === undefined) {
    throw new Error(`${effect} 的 actorId 无法解析："__self__" 需要当前执行行动的 NPC`);
  }
  return ctx.selfNpcId;
}

/** 人名（大事记要说人话，绝不把裸 id 写进史）。 */
function actorLabel(state: WorldStateV2, actorId: string): string {
  return actorOf(state, actorId)?.name ?? UNKNOWN_ACTOR;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------- 效果（§2.5，schema + handler 成对） ----------

export const JoinClanEffectSchema = z
  .object({
    type: z.literal("joinClan"),
    actorId: z.string().min(1),
    clanId: z.string().min(1),
    via: z.enum(CLAN_MEMBER_VIAS),
    /** **必填**：没有理由的入族就是无记录漂移（同时作为大事记文本）。 */
    reason: z.string().min(1),
    role: z.string().min(1).optional(),
  })
  .strict();

export const LeaveClanEffectSchema = z
  .object({
    type: z.literal("leaveClan"),
    actorId: z.string().min(1),
    /** **必填**："出继" / "嫁出" / "除籍" / "身故"（同时作为大事记文本）。 */
    reason: z.string().min(1),
  })
  .strict();

export const SetClanHeadEffectSchema = z
  .object({
    type: z.literal("setClanHead"),
    clanId: z.string().min(1),
    /** `null` = 家主之位空悬（族老摄政）。 */
    actorId: z.string().min(1).nullable(),
  })
  .strict();

export const AdjustClanPrestigeEffectSchema = z
  .object({
    type: z.literal("adjustClanPrestige"),
    clanId: z.string().min(1),
    /** 增量（不是目标值）；先按 `prestige.maxStep` 夹，再按 `[min,max]` 夹。 */
    value: z.number(),
  })
  .strict();

/**
 * 运行时成婚（2026-11-20）：把一对配偶写进**权威切片** `state.extensions.family.spouses`。
 *
 * 为什么需要它：`spouses` 过去只有建局期 `initClanState` 播种那一次写点 ——
 * 运行时「结婚」只能落一条关系边，族谱的配偶行不动（用户 2026-11-20：
 * 「不能只认快照，要实时更新」）。这条效果补上写点，投影下一帧就能看到新配偶。
 *
 * 无向、幂等（同一对写两次不重复）；`since` 缺省取当前世界时间。
 */
export const AddSpouseEffectSchema = z
  .object({
    type: z.literal("addSpouse"),
    a: z.string().min(1),
    b: z.string().min(1),
    since: z.number().int().optional(),
  })
  .strict();

export const UnlockLegacyEffectSchema = z
  .object({
    type: z.literal("unlockLegacy"),
    clanId: z.string().min(1),
    legacyId: z.string().min(1),
  })
  .strict();

export const ClanHistoryEffectSchema = z
  .object({
    type: z.literal("clanHistory"),
    clanId: z.string().min(1),
    kind: z.enum(CLAN_HISTORY_KINDS),
    text: z.string().min(1),
    refs: z.array(z.string().min(1)).optional(),
  })
  .strict();

function applyAddSpouse(state: WorldStateV2, raw: unknown): void {
  const effect = AddSpouseEffectSchema.parse(raw);
  if (effect.a === effect.b) throw new Error("addSpouse: a 与 b 不能是同一人");
  /**
   * 端点必须是**已声明 / 已在场**的演员：写错一个 id 会让族谱长出一对查不到的夫妻，
   * 而且不会报错。加载期没有扩展配置的校验口，所以在这里 fail-fast。
   */
  const selfId = state.selfId ?? state.player.id;
  const known = new Set<string>([selfId, ...state.npcs.map((n) => n.id)]);
  if (!known.has(effect.a) || !known.has(effect.b)) {
    throw new Error(`addSpouse: 未知演员 ${!known.has(effect.a) ? effect.a : effect.b}`);
  }
  const clanState = ensureClanState(state);
  const spouses = clanState.spouses ?? [];
  const exists = spouses.some(
    (s) => (s.a === effect.a && s.b === effect.b) || (s.a === effect.b && s.b === effect.a),
  );
  if (exists) return;
  clanState.spouses = [...spouses, { a: effect.a, b: effect.b, since: effect.since ?? state.worldTime }];
  writeClanState(state, clanState);
}

function applyJoinClan(state: WorldStateV2, raw: unknown, ctx: ExtensionEffectContext): void {
  const effect = JoinClanEffectSchema.parse(raw);
  const clanState = ensureClanState(state);
  const clan = findClan(clanState, effect.clanId);
  const actorId = resolveActorId(effect.actorId, ctx, "joinClan");

  const active = clanState.members.find((m) => m.actorId === actorId && m.leftAt === undefined);
  // 已在同一族 ⇒ 幂等（模板重复触发不堆成员、不刷史）。
  if (active?.clanId === effect.clanId) return;
  /**
   * 一人同时只能有**一个**在族身份：`leaveClan` 的签名里没有 clanId（§2.5），
   * 若允许同时挂两族，出族就不知道该出哪一族。要换族必须先 `leaveClan`，
   * 那一步会留下 `member_left` 史 —— 这正是「不许无记录漂移」要的形状。
   */
  if (active !== undefined) {
    throw new Error(
      `joinClan: ${actorId} 已属宗族 ${active.clanId}，换族须先 leaveClan（一人同时只能有一个在族身份）`,
    );
  }

  const prior = clanState.members.find((m) => m.actorId === actorId && m.clanId === effect.clanId);
  if (prior !== undefined) {
    // 复族：复用同一条目（保留原始 since 之外的字段），清掉出族痕迹。
    prior.since = state.worldTime;
    prior.via = effect.via;
    delete prior.leftAt;
    delete prior.leftReason;
    if (effect.role !== undefined) prior.role = effect.role;
    else delete prior.role;
  } else {
    clanState.members.push({
      actorId,
      clanId: effect.clanId,
      since: state.worldTime,
      via: effect.via,
      ...(effect.role !== undefined ? { role: effect.role } : {}),
    });
  }
  clan.history.push(historyEntry(state, "member_joined", effect.reason, [actorId]));
  writeClanState(state, clanState);
}

function applyLeaveClan(state: WorldStateV2, raw: unknown, ctx: ExtensionEffectContext): void {
  const effect = LeaveClanEffectSchema.parse(raw);
  const clanState = ensureClanState(state);
  const actorId = resolveActorId(effect.actorId, ctx, "leaveClan");

  const active = clanState.members.find((m) => m.actorId === actorId && m.leftAt === undefined);
  if (active === undefined) {
    // 不在族却出族 = 配置错误（与 addSecret 指向未知 NPC 同口径），不静默补一条空记录。
    throw new Error(`leaveClan: ${actorId} 当前不属于任何宗族`);
  }
  const clan = findClan(clanState, active.clanId);
  active.leftAt = state.worldTime;
  active.leftReason = effect.reason;
  clan.history.push(historyEntry(state, "member_left", effect.reason, [actorId]));
  /**
   * 家主出族后必须落空位：让 `headId` 悬在一个非成员身上，`isClanHead` 会对一个
   * 「不在族的人」为真 —— 这是数据损坏，不是历史。**空位本身也写史**，不算漂移。
   */
  if (clan.headId === actorId) {
    clan.headId = null;
    clan.history.push(
      historyEntry(state, "head_changed", `家主出族（${effect.reason}），家主之位空悬`, [actorId]),
    );
  }
  writeClanState(state, clanState);
}

function applySetClanHead(state: WorldStateV2, raw: unknown, ctx: ExtensionEffectContext): void {
  const effect = SetClanHeadEffectSchema.parse(raw);
  const clanState = ensureClanState(state);
  const clan = findClan(clanState, effect.clanId);
  const actorId = effect.actorId === null ? null : resolveActorId(effect.actorId, ctx, "setClanHead");

  if (actorId !== null) {
    const member = clanState.members.find(
      (m) => m.actorId === actorId && m.clanId === clan.id && m.leftAt === undefined,
    );
    // 家主必须在族：外姓可以当家主，但「不在族」不行（§2.3 借「家主可外姓」）。
    if (member === undefined) {
      throw new Error(`setClanHead: ${actorId} 不是宗族 ${clan.id} 的在族成员，不能当家主`);
    }
  }
  if (clan.headId === actorId) return; // 幂等：不重复写史

  clan.headId = actorId;
  clan.history.push(
    historyEntry(
      state,
      "head_changed",
      actorId === null ? "家主之位空悬" : `${actorLabel(state, actorId)}继任${clan.name}家主`,
      actorId === null ? undefined : [actorId],
    ),
  );
  writeClanState(state, clanState);
}

function applyAdjustClanPrestige(
  state: WorldStateV2,
  raw: unknown,
  ctx: ExtensionEffectContext,
): void {
  const effect = AdjustClanPrestigeEffectSchema.parse(raw);
  const clanState = ensureClanState(state);
  const clan = findClan(clanState, effect.clanId);
  const bounds = parseClanConfig(ctx.config).prestige;

  const step = clamp(effect.value, -bounds.maxStep, bounds.maxStep);
  const before = clan.prestige;
  const after = clamp(before + step, bounds.min, bounds.max);
  // 夹完没变化 ⇒ 不写史（否则「声望 +0」会把大事记刷满）。
  if (after === before) return;

  clan.prestige = after;
  const delta = after - before;
  clan.history.push(
    historyEntry(
      state,
      "prestige",
      `声望 ${delta > 0 ? "+" : ""}${delta}（${before} → ${after}）`,
    ),
  );
  writeClanState(state, clanState);
}

function applyUnlockLegacy(state: WorldStateV2, raw: unknown, ctx: ExtensionEffectContext): void {
  const effect = UnlockLegacyEffectSchema.parse(raw);
  const clanState = ensureClanState(state);
  const clan = findClan(clanState, effect.clanId);
  const declaration = parseClanConfig(ctx.config).clans.find((d) => d.id === clan.id);
  const candidate = declaration?.legacies?.find((l) => l.id === effect.legacyId);
  if (candidate === undefined) {
    // 族学只能解锁模板声明过的候选：AI 现编「家训」会撞设定（§4 风险 7 同一理由）。
    throw new Error(
      `unlockLegacy: 宗族 ${clan.id} 未声明族学候选 "${effect.legacyId}"（须写进模板 extensions.family.clans[].legacies）`,
    );
  }
  if (clan.legacies.includes(effect.legacyId)) return; // 幂等

  clan.legacies.push(effect.legacyId);
  clan.history.push(
    historyEntry(state, "legacy", `族学「${candidate.name ?? candidate.id}」已解锁`),
  );
  writeClanState(state, clanState);
}

function applyClanHistory(state: WorldStateV2, raw: unknown): void {
  const effect = ClanHistoryEffectSchema.parse(raw);
  const clanState = ensureClanState(state);
  const clan = findClan(clanState, effect.clanId);
  clan.history.push(historyEntry(state, effect.kind, effect.text, effect.refs));
  writeClanState(state, clanState);
}

/** 宿主装进 `ExtensionRuntime.effects` 的六条（`foundClan` 刻意不做，§2.5）。 */
export const clanEffectHandlers: readonly ExtensionEffectHandler[] = [
  { type: "joinClan", schema: JoinClanEffectSchema, apply: applyJoinClan },
  { type: "leaveClan", schema: LeaveClanEffectSchema, apply: applyLeaveClan },
  { type: "setClanHead", schema: SetClanHeadEffectSchema, apply: applySetClanHead },
  {
    type: "adjustClanPrestige",
    schema: AdjustClanPrestigeEffectSchema,
    apply: applyAdjustClanPrestige,
  },
  { type: "addSpouse", schema: AddSpouseEffectSchema, apply: applyAddSpouse },
  { type: "unlockLegacy", schema: UnlockLegacyEffectSchema, apply: applyUnlockLegacy },
  { type: "clanHistory", schema: ClanHistoryEffectSchema, apply: applyClanHistory },
];

// ---------- 条件（§2.5，注册进 ConditionRegistry） ----------

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 缺省演员 = 玩家（`selfIdOf`）；**不写死 "player" 字面量**。 */
function actorArg(args: Record<string, unknown>, ctx: ConditionEvalContext): string {
  return strArg(args, "actorId") ?? selfIdOf(ctx.state);
}

function withinRange(value: number, args: Record<string, unknown>): boolean {
  const gte = typeof args.gte === "number" ? args.gte : undefined;
  const lte = typeof args.lte === "number" ? args.lte : undefined;
  if (gte !== undefined && value < gte) return false;
  if (lte !== undefined && value > lte) return false;
  return true;
}

/**
 * 五个判定 op。
 *
 * **双口径警告（§2.6）**：`clanSize` 用**全图**（权威成员表），不按玩家可见性收敛 ——
 * 藏起来的族人照样是家族实力。这是**判定口径**，不是展示口径；投影侧的可见计数在 B2。
 */
export const clanConditions: Readonly<Record<string, ConditionEvalFn>> = {
  /** 某人在族（`actorId` 缺省 = 玩家）。 */
  inClan: (args, ctx) => {
    const clanId = strArg(args, "clanId");
    if (clanId === undefined) return false;
    const s = readClanState(ctx.state);
    if (!s.clans.some((c) => c.id === clanId)) return false;
    const actorId = actorArg(args, ctx);
    return s.members.some(
      (m) => m.clanId === clanId && m.actorId === actorId && m.leftAt === undefined,
    );
  },
  /** 某人是家主（`actorId` 缺省 = 玩家）。 */
  isClanHead: (args, ctx) => {
    const clanId = strArg(args, "clanId");
    if (clanId === undefined) return false;
    const clan = readClanState(ctx.state).clans.find((c) => c.id === clanId);
    return clan !== undefined && clan.headId === actorArg(args, ctx);
  },
  /** 声望区间（`gte` / `lte` 都可省；族不存在 ⇒ false）。 */
  clanPrestige: (args, ctx) => {
    const clanId = strArg(args, "clanId");
    if (clanId === undefined) return false;
    const clan = readClanState(ctx.state).clans.find((c) => c.id === clanId);
    return clan !== undefined && withinRange(clan.prestige, args);
  },
  /** 在族人数区间（**全图口径**，见上）。 */
  clanSize: (args, ctx) => {
    const clanId = strArg(args, "clanId");
    if (clanId === undefined) return false;
    const s = readClanState(ctx.state);
    if (!s.clans.some((c) => c.id === clanId)) return false;
    const size = s.members.filter((m) => m.clanId === clanId && m.leftAt === undefined).length;
    return withinRange(size, args);
  },
  /** 兴衰三态。 */
  clanStatus: (args, ctx) => {
    const clanId = strArg(args, "clanId");
    const is = strArg(args, "is");
    if (clanId === undefined || is === undefined) return false;
    const clan = readClanState(ctx.state).clans.find((c) => c.id === clanId);
    return clan !== undefined && clan.status === is;
  },
};

// ---------- 建世界期初始化 ----------

/**
 * 把模板声明实例化成 `state.extensions.family`（`onWorldCreated`）。
 *
 * · 只造 `clans`，`members` 恒为空 —— **每个成员都必须有 `joinClan` 记录**（§2.2）。
 *   所以族声明里**没有** `headId`：家主只能由 `joinClan` + `setClanHead` 显式立，
 *   否则会出现「家主不在族成员表」的自我矛盾。
 * · 每个族写一条 `founded` 史（append-only 的起点）。
 * · 同时播种模板声明的 `spouses` / `adoptions`（`extensions/family/doc/FAMILY-GRAPH.md` §3.2）：
 *   指针模式没有婚姻边，`world.yaml` 里这一份是配偶行的**唯一来源**。段名与读侧
 *   （`kin-source.readSpouses`）一致，建局即有，无需事件补写。
 * · 没声明族、也没有婚配/收养 ⇒ 不造空段（`state.extensions` 保持缺省，零回归）。
 * · 已有切片 ⇒ 不覆盖（幂等：建世界只调一次，防重复装配把历史抹掉）。
 *   这里是**唯一**会造新切片的写点：切片还不存在，故不存在「抹掉 `spouses` / `adoptions`」
 *   的问题；已存在时上面这条早退把它挡在门外。
 * · 婚配 / 收养的端点必须是已声明角色或玩家自身：加载期没有扩展配置的校验口，
 *   这里 fail-fast（静默丢掉一对配偶会让族谱少一代，比建局失败更难查）。
 */
export function initClanState(
  state: WorldStateV2,
  config: unknown,
  template: WorldTemplateV2,
): void {
  const cfg = parseClanConfig(config);
  const hasClans = cfg.clans.length > 0;
  const hasKinSeed = cfg.spouses.length > 0 || cfg.adoptions.length > 0;
  if (!hasClans && !hasKinSeed) return;
  if (state.extensions?.family !== undefined) return;

  const known = new Set<string>([selfIdOf(state), ...template.characters.map((c) => c.id)]);
  const spouses = cfg.spouses.filter((s) => known.has(s.a) && known.has(s.b));
  const adoptions = cfg.adoptions.filter((a) => known.has(a.parent) && known.has(a.child));
  if (spouses.length !== cfg.spouses.length) {
    const bad = cfg.spouses.find((s) => !known.has(s.a) || !known.has(s.b));
    throw new Error(
      `family_kin_seed_invalid: 婚配端点未声明（${bad?.a} × ${bad?.b}）；` +
        `spouses 只能指向 characters[].id 或玩家自身`,
    );
  }
  if (adoptions.length !== cfg.adoptions.length) {
    const bad = cfg.adoptions.find((a) => !known.has(a.parent) || !known.has(a.child));
    throw new Error(
      `family_kin_seed_invalid: 收养端点未声明（${bad?.parent} → ${bad?.child}）；` +
        `adoptions 只能指向 characters[].id 或玩家自身`,
    );
  }

  const clans: ClanFact[] = cfg.clans.map((d) => ({
    id: d.id,
    name: d.name,
    ...(d.seat !== undefined ? { seat: d.seat } : {}),
    prestige: clamp(d.prestige ?? 0, cfg.prestige.min, cfg.prestige.max),
    headId: null,
    status: "active",
    foundedAt: state.worldTime,
    legacies: [],
    history: [historyEntry(state, "founded", `${d.name}立族`)],
  }));
  writeClanState(state, {
    clans,
    members: [],
    ...(spouses.length > 0 ? { spouses } : {}),
    ...(adoptions.length > 0 ? { adoptions } : {}),
  });
}
