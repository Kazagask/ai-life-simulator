import type { RelationEdge, WorldTemplateV2 } from "@life-sim/shared";

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
  readonly relationDerivation?: RelationDerivation;
}

/** 给**一条事实行**加字段（逐行调用）。 */
export interface RelationRowContext {
  /** 这张卡是谁的（npc id / player id） */
  readonly viewerId: string;
  /** 这一行自己那条边 —— 不是整张图的最短路 */
  readonly edge: RelationEdge;
  /** 边是否从 viewer 出发 */
  readonly outgoing: boolean;
  /** 全部 known/inferred 边（与内核同一份口径） */
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
  /** 已有事实行覆盖到的对手，补行要跳过 */
  readonly factCounterpartIds: ReadonlySet<string>;
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
  /** 缺省 `"known"` */
  readonly visibility?: "known" | "inferred";
  readonly fields?: RelationFields;
}

/**
 * 内核字段：扩展**只能加列，不能改列**。
 *
 * 名单即 `docs/EXTENSIONS.md` §2 保证 1 的名单：`withId` / `kind` / `visibility` /
 * `direction` / `counterpartVisible` / `withName` / `value`。
 * `withName` / `counterpartVisible` 在名单里不是巧合 —— 命名与上屏判定归内核，
 * 否则隐藏角色可以被扩展「说出来」（保证 2）。
 */
const RESERVED_ROW_FIELDS: ReadonlySet<string> = new Set([
  "withId",
  "kind",
  "visibility",
  "direction",
  "counterpartVisible",
  "withName",
  "value",
]);

/** 注册表（启动期装，运行期只读）。同 id 重复注册按后者覆盖（幂等装配）。 */
const RUNTIMES = new Map<string, ExtensionRuntime>();

/**
 * 启动期注册（`apps/server` bootstrap 调一次）。
 * 运行期不再改 —— 这是「放弃热加载」的落点，也让投影保持确定。
 */
export function registerExtensionRuntime(runtime: ExtensionRuntime): void {
  RUNTIMES.set(runtime.id, runtime);
}

/** 仅供测试：清空注册表，回到「零扩展」状态。 */
export function resetExtensionRuntimes(): void {
  RUNTIMES.clear();
}

/** 模板加载期用：某个 id 有没有装包（`unknown_extension` 拒载的判据）。 */
export function hasExtensionRuntime(id: string): boolean {
  return RUNTIMES.has(id);
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
