import { isKinshipKind } from "@life-sim/game-core";
import type {
  ExtensionRuntime,
  RelationCardContext,
  RelationDerivation,
  RelationFields,
  RelationRowContext,
  RelationRowDraft,
  SnapshotDerivation,
} from "@life-sim/game-core";
import type { RelationEdge } from "@life-sim/shared";
import {
  clanConditions,
  clanEffectHandlers,
  clanStateSchema,
  initClanState,
} from "./clan.js";
import { deriveClanView } from "./clan-view.js";
import { parseFamilyConfig } from "./config.js";
import { reachableKinshipNodeIds } from "./graph.js";
import { derivePedigree } from "./pedigree.js";
import { kinshipReadings, kinshipTerm, SELF_TITLE, STEP_TERMS, type KinshipReading } from "./terms.js";

/**
 * 家族扩展（extension id = `family`）：把关系**事实图**解释成称谓与族谱。
 *
 * 它是 `docs/EXTENSIONS.md` 的 `derivations` 口的第一个用户。边界：
 * · 只加列（`kinshipTerm` / `kinshipTerms`）、推导行、以及快照上的 `family` 段；
 * · 不改事实、不改可见性、不给别人起名字；
 * · 全部产物由模板 `extensions.family` 声明后才出现 —— 不声明时本文件一行都不跑。
 */

/** memo 键前缀：同一张卡的 memo 里，不同扩展与不同用途必须分得开。 */
const READINGS_KEY = "family:readings:";

/**
 * 同一对端点的全部读法（一条简单路径 = 一个称谓），只看**可见合成**。
 *
 * 可见性不是另立一档「推断」：一段亲缘由哪几条边构成，它就继承那几条边的属性。
 * 任一条边 unknown / hidden ⇒ 整条读法丢弃（合成后不可见）。
 *
 * 每张卡对同一个目标只算一次：同一对端点会被「事实行」与「推导行」各查一次，
 * 不缓存则每条路径枚举跑两遍（十二人家族下足以把请求拖死）。
 */
function visibleReadings(
  ctx: {
    readonly memo: Map<string, unknown>;
    readonly visibleEdges: readonly RelationEdge[];
    readonly viewerId: string;
  },
  target: string,
  maxHops: number,
): KinshipReading[] {
  const key = `${READINGS_KEY}${target}`;
  const hit = ctx.memo.get(key);
  if (hit !== undefined) return hit as KinshipReading[];
  const v = kinshipReadings(ctx.visibleEdges, ctx.viewerId, target, { maxHops }).filter(
    (r) => r.visibility === "known" || r.visibility === "inferred",
  );
  ctx.memo.set(key, v);
  return v;
}

/**
 * `showAllRoles` 打开时，把主要读法之外的其他身份带出。
 *
 * 血亲读法全部保留（「女儿 / 孙女」这类同一血脉的多个身份）；
 * 姻亲读法只留「继」字辈与配偶直系（`STEP_TERMS`）——「婆婆」「小姑子」这类
 * 随口称呼是社交称谓，不是身份，列出来只会把卡片刷满。
 * 姻亲已被 `kinshipReadings` 过滤过（不可命名的路径直接丢弃），
 * 所以这里不会再有「老公的老婆」那种噪音。
 *
 * 展示顺序：**「继」字辈优先**，其余按跳数。血亲优先只用于选主称谓；
 * 一旦作为「附加身份」并排展示，「继母」比「小姑」更值得占那一格。
 * 复制一份再排序——缓存里的数组不能被就地改动，否则主称谓会跟着变。
 */
function pickExtras(readings: readonly KinshipReading[], primary: string, showAllRoles: boolean): string[] {
  if (!showAllRoles) return [];
  return [...readings]
    .filter((r) => !r.affinal || STEP_TERMS.has(r.term))
    .sort(
      (a, b) =>
        Number(!STEP_TERMS.has(a.term)) - Number(!STEP_TERMS.has(b.term)) ||
        a.hops - b.hops ||
        (a.term < b.term ? -1 : a.term > b.term ? 1 : 0),
    )
    .map((r) => r.term)
    .filter((t) => t !== primary && t !== SELF_TITLE)
    .slice(0, 3);
}

/**
 * 逐行加称谓。
 *
 * 称谓必须按**这一行自己的边**推导，而不是拿 (viewerId, withId) 去整张图上求最短路径
 * —— 旧实现是后者，导致同一对端点上的多行共用同一个结果：玛蒂尔达的「兄长」「弟弟」
 * 「儿子」三行同时显示「老公」，因为 1 跳候选里 `妻子` 的码点序最小。
 * 行是**事实**，称谓就该描述这条事实。反向边仍不反推称谓。
 */
function decorate(ctx: RelationRowContext): RelationFields | null {
  if (!ctx.outgoing || !isKinshipKind(ctx.edge.kind)) return null;
  const cfg = parseFamilyConfig(ctx.config);
  const withId = ctx.edge.to;
  const term = kinshipTerm([ctx.edge], ctx.viewerId, withId, { maxHops: 1 });
  if (term === null) return null;
  const extra = pickExtras(visibleReadings(ctx, withId, cfg.maxHops), term.term, cfg.showAllRoles);
  return {
    kinshipTerm: term.term,
    ...(extra.length > 0 ? { kinshipTerms: extra } : {}),
  };
}

/**
 * 每卡一次：补「没有直接边、但血缘上确实够得着」的推导行。
 *
 * 多跳亲缘**不是额外的推断关系**，而是同一张事实图上换一条路径得出的另一个称谓 ——
 * 属性继承构成边，不另立可信度。
 */
function extendRows(ctx: RelationCardContext): RelationRowDraft[] {
  const cfg = parseFamilyConfig(ctx.config);
  const rows: RelationRowDraft[] = [];
  for (const otherId of reachableKinshipNodeIds(ctx.visibleEdges, ctx.viewerId, cfg.maxHops)) {
    if (ctx.factCounterpartIds.has(otherId)) continue;
    // ADR-0022 D-1 同口径：推得出来 ≠ 可以显示，未登场/隐藏端点照旧剔除。
    if (ctx.hiddenNodeIds.has(otherId)) continue;
    const readings = visibleReadings(ctx, otherId, cfg.maxHops);
    if (readings.length === 0) continue;
    const primary = readings[0]!;
    // 多跳链（如 丈夫的妻子的儿子）会绕回本体，这类行必须丢弃，
    // 否则人物卡上会出现「某某 视 X 为自己」。
    if (primary.term === SELF_TITLE) continue;
    const extra = pickExtras(readings, primary.term, cfg.showAllRoles);
    rows.push({
      withId: otherId,
      kind: "relative",
      // 可见性继承构成边（已知+已知=已知），不是「推断」。
      visibility: primary.visibility === "inferred" ? "inferred" : "known",
      fields: {
        kinshipTerm: primary.term,
        ...(extra.length > 0 ? { kinshipTerms: extra } : {}),
      },
    });
  }
  return rows;
}

const relationDerivation: RelationDerivation = { decorate, extendRows };

/**
 * 每次快照一次：产出 `snapshot.family`（`docs/CLAN-DESIGN.md`）。
 *
 * 两段**互不依赖**（§0/§3）：
 * · `pedigree` 只吃关系图（关系边 + 演员目录），删掉宗族切片照样完整；
 * · `selfClanIds` / `clans` 只吃 `state.extensions.family`（权威族表），从不从关系图推成员。
 *
 * 没声明宗族 ⇒ 前两者是空数组，`pedigree` 照出；展示层按 `clans.length > 0` 决定是否出页签。
 */
const snapshotDerivation: SnapshotDerivation = {
  derive(ctx) {
    const clan = deriveClanView(ctx);
    return {
      family: {
        selfClanIds: clan.selfClanIds,
        clans: clan.clans,
        pedigree: derivePedigree(ctx),
      },
    };
  },
};

/**
 * 宿主注册的那一份实现。`id` 与模板 `extensions.family` 的键对齐。
 *
 * 四个口（`docs/EXTENSIONS.md` §2）：
 * · `relationDerivation` / `snapshotDerivation` —— 称谓与族谱（**只读事实图**）；
 * · `effects` / `conditions` / `stateSchema` / `onWorldCreated` —— 宗族（**权威 state 切片**）。
 * 两者互不依赖（`docs/CLAN-DESIGN.md` §0/§3）：删掉宗族切片，族谱照样完整。
 */
export const familyExtension: ExtensionRuntime = {
  id: "family",
  relationDerivation,
  snapshotDerivation,
  effects: clanEffectHandlers,
  conditions: clanConditions,
  stateSchema: clanStateSchema,
  onWorldCreated: initClanState,
};

export { derivePedigree } from "./pedigree.js";
export { deriveClanView, type ClanViewBundle } from "./clan-view.js";
export {
  CLAN_HISTORY_KINDS,
  CLAN_MEMBER_VIAS,
  CLAN_STATUSES,
  ClanFactSchema,
  ClanHistoryEntrySchema,
  ClanMemberSchema,
  AdjustClanPrestigeEffectSchema,
  ClanHistoryEffectSchema,
  JoinClanEffectSchema,
  LeaveClanEffectSchema,
  SetClanHeadEffectSchema,
  UnlockLegacyEffectSchema,
  clanConditions,
  clanEffectHandlers,
  clanStateSchema,
  initClanState,
  parseClanConfig,
  readClanState,
  type ClanConfig,
  type ClanDeclaration,
  type ClanFact,
  type ClanHistoryEntry,
  type ClanHistoryKind,
  type ClanMember,
  type ClanMemberVia,
  type ClanState,
  type ClanStatus,
} from "./clan.js";
export { parseFamilyConfig, type FamilyConfig } from "./config.js";
export { reachableKinshipNodeIds, isKinshipReachable } from "./graph.js";
export {
  KINSHIP_TOKEN,
  COARSE_KINSHIP_TITLE,
  SELF_TITLE,
  STEP_TERMS,
  kinshipReadings,
  kinshipTerm,
  type KinshipReading,
  type KinshipTerm,
} from "./terms.js";
export { inbreedingCoefficient, kinshipCoefficient, pedigreeOf } from "./coefficient.js";
