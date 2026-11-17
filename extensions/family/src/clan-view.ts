import type { SnapshotDerivationContext } from "@life-sim/game-core";
import type { ClanHeadView, ClanView } from "@life-sim/shared";
import {
  clanStateSchema,
  parseClanConfig,
  type ClanConfig,
  type ClanFact,
  type ClanMember,
} from "./clan.js";

/**
 * 宗族投影（`docs/CLAN-DESIGN.md` §2.4）：`state.extensions.family` 的权威数据 → 展示视图。
 *
 * 边界（§0 / §3）：
 * · **成员只从族表数，绝不从关系图推** —— 嫁出去的女儿、出继的儿子、义子、入赘随妻族，
 *   血缘与归族本来就不同；族谱那边也永远不从族表推。两者冲突时**显示冲突**，不消解。
 * · 这里只读，不写 state：投影期改事实等于在渲染路径上造史。
 * · 切片缺省（模板 `family: true` 没声明 `clans`、或存档早于本段）⇒ 返回空视图，**不抛**。
 *   一个可选展示段坏掉不该让整张快照连带丢掉族谱。
 */

/** 空视图：缺省切片的返回值（同时也是一份合法的「玩家不属于任何族」）。 */
export interface ClanViewBundle {
  readonly selfClanIds: string[];
  readonly clans: ClanView[];
}

const EMPTY: ClanViewBundle = { selfClanIds: [], clans: [] };

const SPOUSE_KINDS: ReadonlySet<string> = new Set(["husband", "wife"]);

/**
 * 这个人在**玩家视角**里数不算数：既要有画像（`actors` 里有他），也要内核判定可上屏。
 *
 * 不数 `hiddenNodeIds` / 未登场 / 敌人 / 模板 `visibility: hidden` 的人：
 * 数进去等于告诉玩家「族里还有 3 个你不认识的」（§2.4 / §2.6 双口径警告）。
 * **判定口径**（`clanSize` 条件）走全图，那是另一处，别混。
 */
function isVisibleActor(ctx: SnapshotDerivationContext, actorId: string): boolean {
  const actor = ctx.actors.get(actorId);
  return actor !== undefined && actor.visible && !ctx.hiddenNodeIds.has(actorId);
}

/** 玩家是不是这条边的配偶方（姻亲判定只用于 `selfRelation`，不用于成员）。 */
function isSpouseEdge(kind: string): boolean {
  return SPOUSE_KINDS.has(kind);
}

/**
 * 姻亲：玩家自己不在族，但**可见的**在族成员里有人与玩家是配偶。
 *
 * 只看可见成员 —— 如果玩家的配偶在族表里但被隐藏，「姻亲」这个标签本身就会泄露
 * 「有这么个人」，所以宁可落回 `outsider`。
 */
function hasAffineLink(
  ctx: SnapshotDerivationContext,
  activeVisibleMemberIds: ReadonlySet<string>,
): boolean {
  for (const edge of ctx.visibleEdges) {
    if (!isSpouseEdge(edge.kind)) continue;
    if (edge.from === ctx.selfId && activeVisibleMemberIds.has(edge.to)) return true;
    if (edge.to === ctx.selfId && activeVisibleMemberIds.has(edge.from)) return true;
  }
  return false;
}

/** 家主投影：家主不可见（或 id 悬空）⇒ 整个 `head` 缺省，不编一个「无名的家主」。 */
function headView(clan: ClanFact, ctx: SnapshotDerivationContext): ClanHeadView | undefined {
  if (clan.headId === null) return undefined;
  const actor = ctx.actors.get(clan.headId);
  if (actor === undefined || !actor.visible) return undefined;
  return {
    id: actor.id,
    name: actor.name,
    hasCard: true,
    isSelf: actor.id === ctx.selfId,
    alive: actor.alive,
  };
}

/**
 * 族学：以**模板声明**为准（候选顺序即展示顺序），`unlocked` 看 state 里的解锁表。
 *
 * 配置解析失败 ⇒ 只丢族学，不影响族的其它字段（配置错误该在建局期就拒载，
 * 不该在投影期把整段 `family` 打成 undefined —— 那会连带弄丢族谱）。
 */
function legaciesView(
  clan: ClanFact,
  config: ClanConfig | undefined,
): Array<{ id: string; name: string; unlocked: boolean }> {
  const declared = config?.clans.find((d) => d.id === clan.id)?.legacies ?? [];
  const unlocked = new Set(clan.legacies);
  const out = declared.map((l) => ({
    id: l.id,
    name: l.name ?? l.id,
    unlocked: unlocked.has(l.id),
  }));
  // state 里有、模板没声明的解锁项（历史遗留 / 配置被删）：照实给出，名字回落到 id。
  for (const id of clan.legacies) {
    if (out.some((l) => l.id === id)) continue;
    out.push({ id, name: id, unlocked: true });
  }
  return out;
}

function safeConfig(raw: unknown): ClanConfig | undefined {
  try {
    return parseClanConfig(raw);
  } catch {
    return undefined;
  }
}

/**
 * 派生一族的视图。
 *
 * 计数口径（§2.4）：
 * · `memberCount` = **数得出来的成员数**：在族 + 可见 + **含已故**（死者仍是族人）；
 * · `livingCount` = 在族 + 可见 + 在世；
 * · 出族者（`leftAt` 有值）两者都不算 —— 人已经不在这族了，史里留着即可。
 */
function toClanView(
  clan: ClanFact,
  members: readonly ClanMember[],
  ctx: SnapshotDerivationContext,
  config: ClanConfig | undefined,
): ClanView {
  let memberCount = 0;
  let livingCount = 0;
  const activeVisibleMemberIds = new Set<string>();

  for (const member of members) {
    if (member.clanId !== clan.id) continue;
    if (member.leftAt !== undefined) continue;
    if (!isVisibleActor(ctx, member.actorId)) continue;
    activeVisibleMemberIds.add(member.actorId);
    memberCount += 1;
    if (ctx.actors.get(member.actorId)?.alive === true) livingCount += 1;
  }

  const selfMember = activeVisibleMemberIds.has(ctx.selfId);
  const selfRelation: ClanView["selfRelation"] =
    clan.headId === ctx.selfId
      ? "head"
      : selfMember
        ? "member"
        : hasAffineLink(ctx, activeVisibleMemberIds)
          ? "affine"
          : "outsider";

  const legacies = legaciesView(clan, config);
  const head = headView(clan, ctx);

  return {
    // id 只作 key / 跳转键；显示名是 name（可被改姓）。
    id: clan.id,
    name: clan.name,
    ...(clan.seat !== undefined ? { seat: clan.seat } : {}),
    status: clan.status,
    prestige: clan.prestige,
    ...(head !== undefined ? { head } : {}),
    livingCount,
    memberCount,
    selfRelation,
    ...(legacies.length > 0 ? { legacies } : {}),
    // 史直接透传 `text`（**不实时调 LLM 复述**：史是事实，不是叙事），按存储顺序（正序）。
    history: clan.history.map((entry) => ({
      at: entry.at,
      // 历法口径与 `snapshot.formattedTime` 同源（内核时间适配器）；没有适配器时只给分钟数。
      formattedAt: ctx.formatWorldTime?.(entry.at) ?? String(entry.at),
      kind: entry.kind,
      text: entry.text,
    })),
  };
}

/**
 * 整个家族段的宗族部分。切片缺省 / 坏形状 ⇒ 空视图（**不抛**，见文件头）。
 */
export function deriveClanView(ctx: SnapshotDerivationContext): ClanViewBundle {
  const parsed = clanStateSchema.safeParse(ctx.extensionState);
  if (!parsed.success) return EMPTY;
  const { clans, members } = parsed.data;
  if (clans.length === 0) return EMPTY;

  const config = safeConfig(ctx.config);

  // 玩家在族的身份：一人同时只能有一个（`joinClan` 的约束），这里仍按数组表达，
  // 免得投影成为「单族」这条规则的第二个真源。
  const selfClanIds = members
    .filter((m) => m.actorId === ctx.selfId && m.leftAt === undefined && m.clanId !== "")
    .map((m) => m.clanId)
    .filter((id, i, all) => all.indexOf(id) === i);

  return {
    selfClanIds,
    clans: clans.map((clan) => toClanView(clan, members, ctx, config)),
  };
}
