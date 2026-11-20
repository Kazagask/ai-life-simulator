import type {
  NpcLifecycleState,
  RelationEdge,
  RelationScope,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { setExtensionStateSliceValidators, type ExtensionStateSliceValidator } from "@life-sim/shared";
import type { ZodTypeAny } from "zod";
import type { ConditionEvalFn } from "./condition-evaluator.js";

/**
 * 扩展层接缝（`docs/EXTENSIONS.md` §2）。**契约在本文件，实现各在各的包**。
 *
 * 边界一句话：core 拥有关系的**事实**（边、图算法、可见性收敛、投影装配），
 * 扩展只拥有对这张图的**解释**（称谓、系谱、宗族）。
 * 判据：把扩展全部卸载，内核照样跑完整一局，只是少了几列展示字段。
 *
 * 本文件**不 import 任何扩展**（单向依赖），扩展 import 这里。
 */

/** 扩展能往关系行上加的字段值：只允许可 JSON 序列化的标量/字符串数组。 */
export type RelationFieldValue = string | number | boolean | string[];
export type RelationFields = Record<string, RelationFieldValue>;

/** 宿主装进来的一份扩展实现。`id` 与模板 `extensions:` 的键对齐。 */
export interface ExtensionRuntime {
  readonly id: string;
  /**
   * 扩展自身版本（`package.json#version` 的镜像，由扩展包自己填）。
   * 供 `world.yaml#requires.extensions` 核对；缺省视为 "*"（老扩展零回归）。
   */
  readonly version?: string;
  /**
   * 本扩展依赖的主包版本区间（`satisfiesVersion()` 的格式）。
   * 缺省视为 "*"。主包升级若破坏接口，扩展包应在这里收紧，加载期即暴露不兼容。
   */
  readonly requiresCore?: string;
  readonly relationDerivation?: RelationDerivation;
  readonly snapshotDerivation?: SnapshotDerivation;
  /**
   * 本扩展自己实现的效果类型（`{ schema, type, apply }` **成对**）。
   *
   * `applyEffectsV2` 的 switch 只认内核那 27 种；其余 type 一律按「已注册扩展的效果」分发
   * （见 `applyExtensionEffect`）。没命中 ⇒ **抛 `unknown_effect`**，不静默吞
   * （`docs/EXTENSIONS.md` §2 保证 6）。`schema` 由扩展在 `apply` 里自行 parse —— 内核不看字段。
   */
  readonly effects?: readonly ExtensionEffectHandler[];
  /**
   * 本扩展贡献的条件 op（`{ op, args }` 开放形的求值函数）。
   *
   * **只有模板声明了本扩展**（`extensions:` 里有这个 id）时才会并进条件注册表 ——
   * 未声明 ⇒ 模板里写同名 op 仍然得到 `unknown_reference` 诊断，不是静默放过（保证 4）。
   */
  readonly conditions?: Readonly<Record<string, ConditionEvalFn>>;
  /**
   * `state.extensions[<id>]` 的存档校验（读档期应用）。切片**缺省时不校验**
   * （模板声明了扩展但存档早于该扩展引入 —— 必须能直载），校验失败 ⇒ 读档拒载，
   * 归入既有封闭码 `world_state_invalid`（见 `packages/shared/src/v2-state.ts`
   * 的 `setExtensionStateSliceValidators`）。
   */
  readonly stateSchema?: ZodTypeAny;
  /**
   * 建世界期初始化本扩展的状态切片（`createWorldV2` 尾部调用一次，仅对模板**已声明**的扩展）。
   *
   * 与 `stateSchema` 的分工：这里造初值，那里校存档。两者都 optional ——
   * 不写就不产生切片，`state.extensions` 保持缺省（零回归）。
   */
  readonly onWorldCreated?: (
    state: WorldStateV2,
    config: unknown,
    template: WorldTemplateV2,
  ) => void;
  /**
   * 扩展向投影**贡献**关系边（`extensions/family/doc/FAMILY-GRAPH.md` §7.1）。
   *
   * 为什么需要：指针模式（只写 `fatherId` / `motherId`）下 `state.relations` 里没有亲属边，
   * NPC 卡的关系行会整块消失。让扩展在投影期把指针合成的边**加回来**，行装配与称谓装饰
   * （`relationDerivation`）照旧走原来的路 —— 行级逻辑不进扩展。
   *
   * 边界：
   * · 返回的边**只活在这一次投影里**，绝不写回 `state.relations`（不许在渲染路径制造事实）；
   * · 合并与去重由内核执行（见 `projection.ts` 的 `mergeContributedRelationEdges`）：
   *   按 `(from,to,kind)` 去重，**声明边优先**（作者写的关系压过推出来的）；
   * · 只看 `known` / `inferred`：合成边同样要过可见性门槛；
   * · 未声明本扩展 / 未注册 / 没实现本钩子 ⇒ 一次都不调用（零回归）。
   */
  readonly contributeRelationEdges?: (ctx: RelationEdgeSourceContext) => readonly RelationEdge[];
  /**
   * 本扩展贡献给 `ui.yaml` 的能力 id（如 `pedigree` / `clan`）。
   *
   * 只用于**加载期校验**：服务端把宿主闭合集与本表合并，未知的 `place:` 键拒载。
   * 前端不读它 —— 视图仍由 `ExtensionView.slot` 声明落位，这里只让模板作者写的
   * `place: pedigree: ...` 不因"主包不知道这个 id"而被误判为拼写错误。
   */
  readonly uiCapabilities?: readonly string[];
}

/**
 * 扩展效果的上下文。
 *
 * 刻意**不含** `lookup` / `rng`：扩展效果只写自己的切片，不查模板表、不掷骰
 * （掷骰会扰动主轮 RNG，破坏确定性）。
 */
export interface ExtensionEffectContext {
  /** 当前执行行动的 NPC（`__self__` 的解析基准；玩家直接驱动的效果没有这个值）。 */
  readonly selfNpcId?: string;
  /** 玩家节点 id（`selfIdOf(state)`）。扩展不得写死 `"player"` 字面量。 */
  readonly selfId: string;
  /** 本扩展在模板 `extensions.<id>` 里的配置值（`true` = 默认配置）。 */
  readonly config: unknown;
  /** 玩家可见日志收集器（与内核 `log` 效果同一个数组）。 */
  readonly logs?: string[];
}

/** 一条扩展效果：type 是分发键，schema 是自校验，apply 是唯一写点。 */
export interface ExtensionEffectHandler {
  readonly type: string;
  /** 该效果的 zod schema。**内核不替扩展 parse**（字段解释权归扩展）。 */
  readonly schema: ZodTypeAny;
  apply(state: WorldStateV2, raw: unknown, ctx: ExtensionEffectContext): void;
}

/** 给**一条事实行**加字段（逐行调用）。 */
export interface RelationRowContext {
  /** 这张卡是谁的（npc id / player id） */
  readonly viewerId: string;
  /** 这一行自己那条边 —— 不是整张图的最短路 */
  readonly edge: RelationEdge;
  /** 边是否从 viewer 出发 */
  readonly outgoing: boolean;
  /** 全部对当前 self 可见的边（与内核同一份口径：`relationVisibleTo`） */
  readonly visibleEdges: readonly RelationEdge[];
  /** 模板给本扩展的配置，扩展自己校验 */
  readonly config: unknown;
  /**
   * 内核为**这一张卡**新建的空 Map，`decorate` 与 `extendRows` 共用同一个。
   * 多跳路径枚举的记忆化放这里 —— **不要放模块级缓存**（会跨卡串味）。
   */
  readonly memo: Map<string, unknown>;
}

/** 给**一张卡**补推导行（每卡调用一次，不是每行）。 */
export interface RelationCardContext {
  readonly viewerId: string;
  readonly visibleEdges: readonly RelationEdge[];
  /** 已有事实行覆盖到的对手（粗粒度；需要按读法判重时用 `factTerms`）。 */
  readonly factCounterpartIds: ReadonlySet<string>;
  /**
   * 事实行已经说过的**称谓**（2026-11-20）：`withId → Set<kinshipTerm>`。
   *
   * 只按「有没有事实边」判重会把不同读法一起吞掉 —— 娶了外婆之后
   * 「她是妻子」与「她是外婆」是两件事，前者不该让后者消失。
   * 扩展用它在**同一段亲缘的另一种读法**上补行，完全重复的则跳过。
   */
  readonly factTerms?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * 事实行已经说过的 **kind**：`withId → Set<kind>`（2026-11-20）。
   *
   * 用来判断「这个人已经是我的血亲事实了吗」：已经是父亲/母亲/子女的，绕路推出来的
   * 「表兄弟」只是同一段血缘的变体（噪声）；而只有婚姻事实的人（娶了外婆），
   * 多跳血缘读法才是**新信息**，该单独成行。
   */
  readonly factKinds?: ReadonlyMap<string, ReadonlySet<string>>;
  /** 内核判定不可上屏的节点 */
  readonly hiddenNodeIds: ReadonlySet<string>;
  readonly config: unknown;
  /** 与本次每行 `decorate` 共用一个 */
  readonly memo: Map<string, unknown>;
}

export interface RelationDerivation {
  /** 返回要并进这一行的额外字段；`null` = 不加。 */
  decorate?(ctx: RelationRowContext): RelationFields | null;
  /** 返回要追加的推导行（没有直接边、但推得出来的关系）。 */
  extendRows?(ctx: RelationCardContext): RelationRowDraft[];
}

/** 推导行草稿。**只有这几个字段扩展能定**，其余由内核填。 */
export interface RelationRowDraft {
  readonly withId: string;
  /** 缺省 `"relative"` */
  readonly kind?: string;
  /**
   * 知情人范围（ADR-007 D3）：缺省 `"public"`。
   *
   * 多跳推导行必须**合成**构成边的范围（任一段 private ⇒ 整条 private），
   * 不许在这里写死 `public` —— 否则一段私情会被推导成"大家都知道"。
   */
  readonly scope?: RelationScope;
  readonly fields?: RelationFields;
}

// ---------- 快照段派生（每次投影一次，`docs/EXTENSIONS.md` §7） ----------

/**
 * 演员目录里的一项（投影期现算，扩展只读）。
 *
 * `genderLabel` / `lifeStageLabel` / `lifeState` / `reasonCode` 是**可选**的展示派生：
 * 内核已经把「按模板解析成中文」「已故年龄冻结」这类口径算完了，扩展不该自己再算一遍
 * （两处口径必然漂移）。扩展只负责「谁跟谁有关系、隔几代」。
 */
export interface SnapshotActor {
  readonly id: string;
  readonly name: string;
  /** 有没有卡：`false` = 隐藏/未登场/敌人——关系是真的，但点不出档案。 */
  readonly visible: boolean;
  readonly alive: boolean;
  /** 投影口径的当前年龄（已故者冻结在 `sinceWorldTime`）。 */
  readonly age: number;
  /**
   * 模板里的原始 gender id（如 `male` / `female`）；**由扩展解释，内核不判断语义**。
   *
   * 内核只做透传（`npc.gender` / `player.gender`），不把它翻译成 male/female
   * —— 那是世界观语义，归扩展（`docs/EXTENSIONS.md` §7 宿主零知识）。
   * 与 `genderLabel` 的分工：那个是给玩家看的文案，这个只给扩展做结构判断。
   */
  readonly genderId?: string;
  readonly genderLabel?: string;
  readonly lifeStageLabel?: string;
  readonly lifeState?: NpcLifecycleState;
  readonly reasonCode?: string;
  /**
   * 父/母指针（`extensions/family/doc/FAMILY-GRAPH.md` §3.1），原样透传实例上的值。
   * 缺省 = 不详（旧档 / 模板没写）。**内核不解释指针**：家族扩展据此选「指针模式」，
   * 没有指针时回落关系边推导 —— 选源与解释都在扩展里。
   */
  readonly fatherId?: string;
  readonly motherId?: string;
  /**
   * 出生时刻（世界分钟，可为负）。缺省 = 实例没有该字段（旧档），
   * 要「当前年龄」请读上面的 `age`（内核已按同口径反推）——别自己再算一遍。
   */
  readonly birthTime?: number;
}

/**
 * 扩展向投影贡献关系边的上下文（`contributeRelationEdges`，`extensions/family/doc/FAMILY-GRAPH.md` §7.1）。
 *
 * 刻意**不给** `visibleEdges`：贡献是纯追加，合并在内核做（一个集合、两个消费者）。
 * 给了边集，扩展就有了「自己合并一遍」的入口，双真相会从那里长回来。
 */
export interface RelationEdgeSourceContext {
  /** 玩家节点 id（`selfIdOf(state)`）。 */
  readonly selfId: string;
  /** 演员目录（已含 `fatherId` / `motherId` / `genderId` / `birthTime`）—— 指针合成的原料。 */
  readonly actors: ReadonlyMap<string, SnapshotActor>;
  /** 内核判定不可上屏的节点（贡献边不许越过它：与 `SnapshotDerivationContext` 同口径）。 */
  readonly hiddenNodeIds: ReadonlySet<string>;
  /** 模板 `extensions.<id>` 的值（`true` = 默认配置），扩展自己校验。 */
  readonly config: unknown;
  /**
   * 本扩展自己的 state 切片（`state.extensions[<id>]`，**可能缺省**；只读，不许写回）。
   *
   * 婚配 / 收养（`extensions/family/doc/FAMILY-GRAPH.md` §3.2）就在这段里 —— 没有它，指针模式只能合成
   * 父/母边，卡片上永远看不到配偶行（族谱却画得出，两处自相矛盾）。
   */
  readonly extensionState?: unknown;
}

/**
 * 给**整张快照**加段（每次投影调用一次，不是每张卡）。
 *
 * 与 `RelationDerivation` 的分工：那边给「一张卡上的一行」加解释，这边给「整个快照」
 * 加一段独立视图（族谱、宗族这类与卡片无一一对应关系的结构）。
 */
export interface SnapshotDerivationContext {
  /** 玩家节点 id —— 用 `selfIdOf(state)` 来的值，**不许**字面量 `"player"`。 */
  readonly selfId: string;
  /** 全部对当前 self 可见的边（与内核投影同一份口径，不是另一份过滤）。 */
  readonly visibleEdges: readonly RelationEdge[];
  /** 内核判定不可上屏的节点。扩展**不许**越过它（越界的段由内核在装配处拒绝）。 */
  readonly hiddenNodeIds: ReadonlySet<string>;
  readonly actors: ReadonlyMap<string, SnapshotActor>;
  readonly worldTime: number;
  readonly turnIndex: number;
  /** 模板 `extensions.<id>` 的值（`true` = 默认配置），扩展自己校验。 */
  readonly config: unknown;
  /**
   * 本扩展自己的 state 切片：`state.extensions[<id>]`，**可能缺省**
   * （模板声明了扩展但存档早于该扩展引入，或这段数据压根没有）。
   *
   * 只读引用，扩展**不许写回**（投影期改 state 等于在渲染路径上制造事实）。
   * 缺省时返回「空视图」而不是抛错：一个可选展示段坏掉不该锁死整张快照。
   */
  readonly extensionState?: unknown;
  /**
   * 世界时间（分钟）→ 历法显示文本，走**内核时间适配器**（与 `snapshot.formattedTime`
   * 同一口径）。扩展不要自己按固定年长折算 —— 两处口径必然漂移。
   */
  readonly formatWorldTime?: (worldTime: number) => string;
  /** 生命周期 = 一次快照；跨快照缓存会串味（照 `RelationRowContext.memo` 的先例）。 */
  readonly memo: Map<string, unknown>;
}

export interface SnapshotDerivation {
  /**
   * 返回本扩展的快照片段：`{ [扩展 id]: 段 }`。
   *
   * 段键**必须等于扩展 id** —— 段会落进 `snapshot.extensions`，那里按扩展 id 分槽；
   * 写别人的槽就抛错（`assertOwnSegmentKeys`），不静默覆盖。内核不解析段内容。
   */
  derive(ctx: SnapshotDerivationContext): Record<string, unknown>;
}

/**
 * 段键必须等于扩展 id：`snapshot.extensions` 是按扩展 id 分槽的不透明命名空间
 * （`docs/EXTENSIONS.md` §7），扩展只能写自己那一格。
 *
 * 这条约束替代了旧的「不得覆盖内核快照键」：段不再落在快照顶层，天然碰不到内核字段。
 */
export function assertOwnSegmentKeys(
  extensionId: string,
  segment: Record<string, unknown>,
): void {
  for (const key of Object.keys(segment)) {
    if (key === extensionId) continue;
    throw new Error(
      `extension "${extensionId}" 返回了段键 "${key}"：snapshot.extensions 按扩展 id 分槽，扩展只能写自己那一格（docs/EXTENSIONS.md §7）`,
    );
  }
}

/**
 * 内核字段：扩展**只能加列，不能改列**。
 *
 * 名单即 `docs/EXTENSIONS.md` §2 保证 1 的名单：`withId` / `kind` / `scope` /
 * `direction` / `counterpartVisible` / `counterpartState` / `withName` / `value`。
 * `withName` / `counterpartVisible` 在名单里不是巧合 —— 命名与上屏判定归内核，
 * 否则隐藏角色可以被扩展「说出来」（保证 2）。
 */
const RESERVED_ROW_FIELDS: ReadonlySet<string> = new Set([
  "withId",
  "kind",
  "scope",
  "direction",
  "counterpartVisible",
  "counterpartState",
  "withName",
  "value",
]);

/** 注册表（启动期装，运行期只读）。同 id 重复注册按后者覆盖（幂等装配）。 */
const RUNTIMES = new Map<string, ExtensionRuntime>();

/**
 * 把各扩展的 `stateSchema` 镜像到 `shared` 的读档校验钩子里。
 *
 * 为什么要有这一步：存档的唯一校验入口是 `WorldStateV2Schema`（`shared`），而注册表在 core。
 * `shared` 不能反向依赖 core，所以由这里在**装配期**把校验器推过去；`stateSchema` 缺省
 * 的扩展不注册（它的切片就是「不许校验、原样保留」的遗留数据）。
 */
function syncStateSliceValidators(): void {
  const validators: Record<string, ExtensionStateSliceValidator> = {};
  for (const [id, runtime] of RUNTIMES) {
    const schema = runtime.stateSchema;
    if (schema === undefined) continue;
    validators[id] = (slice) => {
      const parsed = schema.safeParse(slice);
      if (parsed.success) return { ok: true };
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        message: issue?.message ?? "扩展状态切片校验失败",
        ...(issue !== undefined ? { path: issue.path.map((p) => p as string | number) } : {}),
      };
    };
  }
  setExtensionStateSliceValidators(validators);
}

/**
 * 启动期注册（`apps/server` bootstrap 调一次）。
 * 运行期不再改 —— 这是「放弃热加载」的落点，也让投影保持确定。
 */
export function registerExtensionRuntime(runtime: ExtensionRuntime): void {
  RUNTIMES.set(runtime.id, runtime);
  syncStateSliceValidators();
}

/** 仅供测试：清空注册表，回到「零扩展」状态（连同读档校验钩子一起清）。 */
export function resetExtensionRuntimes(): void {
  RUNTIMES.clear();
  syncStateSliceValidators();
}

/** 模板加载期用：已注册的扩展 id（错误信息里列给作者看；与 `hasExtensionRuntime` 同源）。 */
export function installedExtensionIds(): string[] {
  return [...RUNTIMES.keys()].sort();
}

/** 模板加载期用：某个 id 有没有装包（`unknown_extension` 拒载的判据）。 */
export function hasExtensionRuntime(id: string): boolean {
  return RUNTIMES.has(id);
}

/** 模板加载期用：取某个已注册扩展的运行时（版本核对用）；没装返回 undefined。 */
export function getExtensionRuntime(id: string): ExtensionRuntime | undefined {
  return RUNTIMES.get(id);
}

/** 模板加载期用：所有已注册扩展声明的 UI 能力 id（供 `ui.yaml` 的 `place:` 键校验）。 */
export function registeredUiCapabilities(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const runtime of RUNTIMES.values()) {
    for (const capability of runtime.uiCapabilities ?? []) ids.add(capability);
  }
  return ids;
}

/** 模板 `extensions:` 的一条已解析声明。 */
export interface ResolvedExtension {
  readonly id: string;
  readonly runtime: ExtensionRuntime;
  /** `true` = 模板写的是 `true`（用扩展默认配置）；否则是模板给的对象/标量。 */
  readonly config: unknown;
}

/**
 * 按模板 `extensions:` 取 runtime。**未声明即不跑**（保证 4）：
 * 没有 `extensions` 段 ⇒ 返回空数组，`projectSnapshotV2` 一次都不调用任何扩展。
 *
 * 声明了但没注册的 id 在这里**跳过**：那是模板加载期该拒载的事（`unknown_extension`），
 * 投影期只负责不崩 —— 拒载是加载器的职责，不是投影的副作用。
 */
export function resolveExtensionRuntimes(template: WorldTemplateV2): ResolvedExtension[] {
  const declared = template.extensions;
  if (declared === undefined) return [];
  const out: ResolvedExtension[] = [];
  for (const [id, config] of Object.entries(declared)) {
    const runtime = RUNTIMES.get(id);
    if (runtime === undefined) continue;
    out.push({ id, runtime, config });
  }
  return out;
}

/**
 * 保证 1 的执行点：扩展返回的字段若与内核字段同名 ⇒ **抛错**，不静默忽略。
 * 静默忽略会让「扩展以为改生效了、其实被吞掉」变成线上谜案。
 */
export function assertNoReservedRowFields(extensionId: string, fields: RelationFields): void {
  for (const key of Object.keys(fields)) {
    if (!RESERVED_ROW_FIELDS.has(key)) continue;
    throw new Error(
      `extension "${extensionId}" 试图写内核字段 "${key}"：扩展只能加列，不能改列（docs/EXTENSIONS.md §2 保证 1）`,
    );
  }
}

// ---------- 效果 / 条件分发（内核只做查表，不解释字段） ----------

/**
 * 找一条扩展效果：只在模板**已声明**的扩展里找（保证 4：未声明即不跑）。
 *
 * 命中第一个即返回，多条同名 handler 不叠加 —— 同名 type 的冲突应在装配期解决，
 * 运行期做「都跑一遍」会让效果写两次，是最难查的一类 bug。
 */
export function resolveExtensionEffect(
  type: string,
  template: WorldTemplateV2,
): { readonly handler: ExtensionEffectHandler; readonly config: unknown } | undefined {
  for (const ext of resolveExtensionRuntimes(template)) {
    const handler = ext.runtime.effects?.find((h) => h.type === type);
    if (handler !== undefined) return { handler, config: ext.config };
  }
  return undefined;
}

/**
 * 把模板**已声明**扩展贡献的条件 op 并成一张表，供 `createConditionRegistry` 使用。
 *
 * 未声明 ⇒ 不并；模板里写同名 op 仍会命中 `unknown_reference` 诊断（R11 的老口径：
 * 未注册的 op 绝不静默放过）。同名 op 后注册者覆盖前者（与 `ConditionRegistry.register` 一致）。
 */
export function collectExtensionConditions(
  template: WorldTemplateV2,
): Record<string, ConditionEvalFn> {
  const out: Record<string, ConditionEvalFn> = {};
  for (const ext of resolveExtensionRuntimes(template)) {
    for (const [op, fn] of Object.entries(ext.runtime.conditions ?? {})) {
      out[op] = fn;
    }
  }
  return out;
}
