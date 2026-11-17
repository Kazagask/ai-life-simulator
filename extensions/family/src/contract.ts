import type { NpcLifecycleState } from "@life-sim/shared";

/**
 * 家族扩展的**快照契约**（`docs/EXTENSIONS.md` §7）。
 *
 * 这些类型曾经住在 `packages/shared/src/v2.ts`，那等于让宿主认识「家族」这个玩法。
 * 现在它们归扩展自己：宿主只搬运 `snapshot.extensions.family`（`unknown`），
 * 谁解释这段数据由 `extensions/family/src/ui/adapter.ts` 的 zod 校验负责。
 *
 * 三个视图段互不依赖：`pedigree` 只吃关系图；`clans` / `selfClanIds` 只吃
 * `state.extensions.family`（权威族表）。删掉宗族切片，族谱照样完整；反过来也一样。
 */

/**
 * 族谱节点（`docs/CLAN-DESIGN.md` §1.5）。
 *
 * ⚠ `id` **只作 React key / 跳转键**，不是显示名 —— 玩家看到的永远是 `name`。
 * （`docs/CLAN-DESIGN.md` §1.5 投影纪律：裸 id 不上屏。）
 */
export interface PedigreeNodeView {
  /** 关系图节点 id（React key / 打开 NPC 卡的键）。**不得当人名显示。** */
  id: string;
  /** 显示名（来自 actor 目录；未知者用占位名，绝不是裸 id）。 */
  name: string;
  isSelf: boolean;
  /**
   * `false` = 没有 NPC 卡（隐藏 / 未登场 / 敌人）：可显示，但点不出档案。
   *
   * ⚠ **当前恒为 `true`**：族谱按 §1.5 的投影纪律把隐藏端点**连边带点**整条丢掉，
   * 走到视图里的节点必然可见。字段保留是为了固定视图契约（将来若出现「可见但没卡」
   * 的节点，UI 不必改），不是「暂时没人实现」。
   */
  hasCard: boolean;
  genderLabel: string;
  age: number;
  lifeStageLabel: string;
  /** 世代号：0 = 始祖，**只按血缘**（婚姻不参与，见 §1.2）。 */
  generation: number;
  /**
   * 这一代的依据：`blood` = 由父母边最长路算出；`marriage` = 图里没有父母、继承配偶世代
   * （外来配偶，否则全挤 g0）；`root` = 无父母也无配偶的孤立根。
   */
  generationBasis?: "blood" | "marriage" | "root";
  lifecycle: { state: NpcLifecycleState; reasonCode?: string };
}

/** 族谱边：`from` / `to` 是关系图节点 id（仅作 key / 跳转键）。 */
export interface PedigreeEdgeView {
  from: string;
  to: string;
  kind: "parent" | "spouse" | "sibling";
  /** `kind === "parent"` 时：这条边说的是父还是母（`son` / `daughter` 方向无法区分男女时缺省）。 */
  parentRole?: "father" | "mother";
  /** 姻亲边（配偶，以及由配偶关系派生出来的继亲边）。 */
  affinal?: boolean;
  /** 继亲：父/母的配偶但不是自己的父/母（`docs/CLAN-DESIGN.md` §1.2 第 3 条的反面）。 */
  step?: boolean;
  /** true = 不是模板声明的边，而是由推导得出（仍不是"可信度更低"）。 */
  derived?: boolean;
  // 回边**不下发**（`docs/EXTENSIONS.md` §7.4）：检测仍然做（世代计算必须跳过回边，
  // 否则死循环），但造成亲缘环的那条 parent 边**整条不产出**，不在 `edges` 里标 flag。
  // 现实里人不可能是自己的祖先，这类边只会来自数据错误或极端设定。
}

/** 族谱视图（`docs/CLAN-DESIGN.md` §1.5）：全部从关系图现算，**不进 state**。 */
export interface PedigreeView {
  /** 最上一代（`generation` 最小）的节点 id，按 id 升序。 */
  rootIds: string[];
  nodes: PedigreeNodeView[];
  edges: PedigreeEdgeView[];
  generationRange: { min: number; max: number };
  /**
   * 可见节点的父/母被判 hidden ⇒ UI 画 "?"，不编一个根。
   *
   * 只在**该节点真的上屏**时置真（被世代窗口 / 规模上限截掉的人不算 —— 那种情况由
   * `truncated` 说明）。因此 `incomplete` 为假不代表血缘链完整，只代表「上屏的人里
   * 没有谁的父/母是已知但被隐藏的」。
   */
  incomplete?: boolean;
  /** 因 `maxGenerations` / `maxNodes` 截断过。 */
  truncated?: boolean;
  /** 有边但说不清代数的远亲（`gap: true`），不进树。 */
  looseEnds?: Array<{ id: string; name: string; gap: true }>;
}

/**
 * 宗族的家主（`docs/CLAN-DESIGN.md` §2.4）。
 *
 * `hasCard` 与族谱节点同一口径：隐藏/未登场的人**不出现在投影里**，所以这里只在
 * 家主本人可见时才有值（否则 `head` 整个缺省，不编一个「无名的家主」）。
 */
export interface ClanHeadView {
  /** 演员 id —— 仅作 key / 跳转键，不许当显示名。 */
  id: string;
  name: string;
  hasCard: boolean;
  isSelf: boolean;
  /** 已故的家主仍然在任（族里没换人），UI 照常显示但可以加「已故」标记。 */
  alive: boolean;
}

/**
 * 宗族视图（`docs/CLAN-DESIGN.md` §2.4）：读 `state.extensions.family` 的**权威数据**，
 * 不从关系图推成员（那是族谱的事，§3）。
 */
export interface ClanView {
  /**
   * 稳定 key（模板声明的宗族 id）。**只作 React key / 跳转键，不许当显示名**：
   * 显示名是 `name`（可被改姓/易主），id 是数据锚，两者不是一个东西。
   */
  id: string;
  name: string;
  /** 郡望 / 祖宅。 */
  seat?: string;
  status: "active" | "extinct" | "exiled";
  prestige: number;
  /** 家主；空缺（族老摄政）或家主不可见 ⇒ 缺省。 */
  head?: ClanHeadView;
  /** **玩家视角数得出来的**在世人数（不含已故、不含离族、不含隐藏成员）。 */
  livingCount: number;
  /**
   * **玩家视角数得出来的**成员数：含已故（死者仍是族人，只是不再在世），
   * 不含离族者与隐藏成员。与 `livingCount` 的差 = 族里死了多少人。
   */
  memberCount: number;
  /** 玩家与本族的关系：家主 / 在族 / 姻亲 / 外人。`outsider` 是合法态。 */
  selfRelation: "head" | "member" | "affine" | "outsider";
  /** 行辈（"第三代 · 二房"）。走族谱派生，不是族表；v1 暂不产出。 */
  selfStanding?: string;
  /** 族学 / 家训（候选由模板声明，`unlocked` = 运行时已解锁）。 */
  legacies?: Array<{ id: string; name: string; unlocked: boolean }>;
  /** append-only 大事记，投影原样透传 `text`（不实时调 LLM 复述史）。按时间正序。 */
  history: Array<{ at: number; formattedAt: string; kind: string; text: string }>;
}

/**
 * 家族扩展的快照段 = `snapshot.extensions.family`（宿主原样搬运，不解释）。
 *
 * `clans` / `selfClanIds` 恒为数组（空数组合法：没声明族，或玩家不属于任何族），
 * 展示层据此决定是否出「宗族」页签 —— 不靠 `undefined` 表达「没有」。
 */
export interface FamilyView {
  /** 玩家当前在族的宗族 id（一人同时只能有一个在族身份；空数组 = 不属于任何族）。 */
  selfClanIds: string[];
  clans: ClanView[];
  pedigree?: PedigreeView;
}
