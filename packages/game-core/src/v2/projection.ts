import type {
  AttributeValue,
  BattleEnemy,
  BattleEnemyView,
  BattleView,
  EndingTemplate,
  EndingView,
  EvaluationRecord,
  RelationEdge,
  ResourceView,
  Skill,
  StatusEffect,
  StatusInstance,
  TerminationRecord,
  V2Npc,
  StatusView,
  UiConfig,
  V2Snapshot,
  WorldRunStatus,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import {
  DEFAULT_RESOURCE_DANGER_RATIO,
  DEFAULT_RESOURCE_DISPLAY,
  relationScopeOf,
  relationVisibleTo,
} from "@life-sim/shared";
import { moodBand, maxHp, maxMp } from "./engine.js";
import { resourceMax, resourceValue } from "./resources.js";
import { resolveAttributeViews } from "./presentation/attributes.js";
import { birthTimeFromAge, createTimeAdapter } from "./time.js";
import type { TemplateLookup } from "./lookup.js";
import { slotEventView } from "./turn.js";
import { controlOf, effectiveCostOf, legalTargetsForPlayer, playerSkills, summonLimitOfTier } from "./battle.js";
import { battleSealOf, skillSealOf } from "./seal.js";
import { projectVisibleRelations } from "./relations.js";
import {
  resolveEntityStyle,
  resolveEntityTags,
  resolveStyle,
  tagIdsOf,
} from "./presentation/style.js";
import {
  equipmentEffectSummaries,
  itemEffectSummaries,
  skillEffectSummaries,
  statusEffectSummaries,
  remainingLabel as statusDurationRemaining,
} from "./presentation/effects.js";
import { statusTotalsOf } from "./presentation/ledger.js";
import {
  assertNoReservedRowFields,
  assertOwnSegmentKeys,
  resolveExtensionRuntimes,
  type RelationEdgeSourceContext,
  type ResolvedExtension,
  type SnapshotActor,
  type SnapshotDerivationContext,
} from "./extensions.js";
import { actorName, buildActorDirectory, selfIdOf } from "./actors.js";

/** 关系行（`V2Snapshot.npcs[].relations[]` 的元素）。 */
type RelationRow = V2Snapshot["npcs"][number]["relations"][number];
/**
 * 装配期可变形态：内核字段 + 扩展加进来的列。
 * 扩展的列名是动态的，只能以索引访问；出口处收敛回 `RelationRow`。
 */
type MutableRelationRow = RelationRow & Record<string, unknown>;

/**
 * V2 投影：hidden 信息不外泄；
 * 状态仅 visibility=known 可见；敌人 combatHints 与 secrets 永不出现。
 */
/** 召唤类技能：技能参数 + 召唤物面板，一起给；非召唤技能返回 undefined。 */
function summonOf(def: Skill | undefined, lookup: TemplateLookup, ui: UiConfig | undefined) {
  if (def === undefined || def.kind !== "combat") return undefined;
  const summon = def.summon;
  if (summon === undefined) return undefined;
  const character = lookup.character(summon.ref);
  const tier = summon.tier ?? "minion";
  return {
    /** 技能参数：一次几只、这批多强（与下面的面板同属一个 `summon`，不能只给一半）。 */
    count: summon.count ?? 1,
    ...(summon.levelScale !== undefined ? { levelScale: summon.levelScale } : {}),
    /**
     * `unit` 只描述**召唤物本身**（它是谁、带什么技能与状态）。
     * 参数与面板同层但分开命名，避免「强度是单位的属性」这种误读。
     */
    unit: {
      ref: summon.ref,
      name: character?.identity.name ?? summon.ref,
      tier,
      ...(character?.identity.description !== undefined
        ? { description: character.identity.description }
        : {}),
      /**
       * 召唤物的技能逐个带上**效果摘要**（ADR-002 D3：摘要由定义派生，唯一出口
       * `skillEffectSummaries`）。只给名字的话，玩家在浮窗里看不到它到底会干什么；
       * 而自己拼一份描述就会长出第二套口径。
       */
      skills: (character?.skills ?? []).map((id) => {
        const skill = lookup.skill(id);
        const style = resolveStyle(skill?.style, skill?.quality, ui, undefined, tagIdsOf(skill));
        const effects = skill === undefined ? [] : skillEffectSummaries(skill, lookup, ui);
        return {
          id,
          name: skill?.name ?? id,
          ...(skill?.description !== undefined && skill.description !== ""
            ? { description: skill.description }
            : {}),
          ...(style !== undefined ? { style } : {}),
          ...(effects.length > 0 ? { effects } : {}),
        };
      }),
      /**
       * 召唤物身上**常驻的状态**（`characters[].statuses`，如魔虚罗的法轮）。
       *
       * 这些是被动，不是技能：只列技能会让玩家以为它每回合回 25 点血是「白给的」。
       * 走 `toStatusView` 的同一套投影 —— 名字 / 样式 / 效果摘要 / 时长口径与
       * 个人页、战斗面板逐字一致，前端拿到的就是可点的状态条目。
       */
      statuses: (character?.statuses ?? [])
        .map((statusId) => lookup.status(statusId))
        // hidden 状态连**存在**都不该被看见（展示层红线）。
        .filter((def): def is StatusEffect => def !== undefined && def.visibility === "known")
        .map((def) => statusViewOfDefinition(def, lookup, ui)),
    },
  };
}

export function projectSnapshotV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  /** 评价唯一事实来源（v2/life-evaluation.ts）；未提供时用中性占位文案 */
  evaluation?: EvaluationRecord | null,
  /** 结局模板集（endings.yaml）；未提供时只投影终止事实、结局文案用中性兜底 */
  endings?: readonly EndingTemplate[],
  /**
   * 展示域配置（ui.yaml，ADR-002 D2）：只用于解析样式。
   * 缺省 ⇒ 不解析样式（等价「模板没写样式」），自定义前端不传也不会坏。
   */
  ui?: UiConfig,
  /**
   * 观察者视角（ADR-010 D4）。缺省 = self。
   *
   * 只影响**关系可见性**（`relationVisibleTo`）与快照上的 `viewerId`；
   * `self` 段仍是「你控制的那个人」。观察 ≠ 接管。
   */
  viewerIdArg?: string,
): V2Snapshot {
  const player = state.player;
  const genderLabel = lookup.genderLabel(player.gender);
  const adapter = createTimeAdapter(template);
  const lifeStage = adapter.resolveLifeStage(player.age);
  const status: WorldRunStatus =
    state.archived === true ? "archived" : state.termination !== null ? "terminated" : "running";
  const ended = status !== "running";

  // R2.6 / ADR-0014 + ADR-007 D2：只投影**对这个 self 可见**的边（`relationVisibleTo`）。
  //
  // ADR-0022 补记 D-1：判据是「确知未对玩家可见」，不是「不在上屏列表」——
  // inactive 必须保留边与称谓（决策 1 反例 2：逝去的祖父依旧是祖父）。
  // player 无 NPC 实例，永不进 hiddenNodeIds（硬保留）。
  // 反例记录（勿改成「投影后 NPC 集合的补集」）：用「不在上屏集合内」会把公开边误杀、并让列表口径静默决定关系可见性；
  // 因此 hiddenNodeIds 只由下面几条**显式**规则构成，绝不含「投影后的 npc.id 集合」。
  //
  // 三条显式规则（2026-11-16 补齐第三条）：
  //   · unspawned —— 有定义、没露过面；
  //   · 敌人 —— 永不实例化；
  //   · 模板 `characters[].visibility: hidden` —— 有实例，但玩家的人物列表里**没有他**。
  //     用户裁决口径：「visibility 的语义就是 player 视角 npc 列表是否有他」。
  //     它只影响「列表 / 有没有卡」，不参与关系上屏判定（B-2 已解耦）。
  //
  // ⚠ 与 `npc.ts` 的关系：hidden 角色**照样跑自主行动**（世界不会因为玩家看不见就停摆）。
  // 目前 `runNpcActionsV2.summaries` 没有被任何投影消费（`postSettleJudgements` 只取
  // `startedChains`），所以不存在「摘要里冒出隐藏人物」的泄露；一旦将来把 summaries 上屏，
  // 必须在那一层按 `visibility` 过滤，而不是在这里改行动条件。
  const hiddenNodeIds = new Set<string>([
    ...state.npcs.filter((n) => n.lifecycle.state === "unspawned").map((n) => n.id),
    ...template.characters.filter((c) => c.isEnemy).map((c) => c.id),
    ...state.npcs.filter((n) => n.visibility === "hidden").map((n) => n.id),
  ]);
  /**
   * 上面三条规则各自的**理由**（2026-11-19）：关系行要知道"没有卡"是因为
   * 还没登场 / 不上面板 / 根本不是人，而不是笼统一句「无档案」。
   *
   * 优先级与集合构造顺序一致：unspawned > enemy > hidden —— 还没出场的人，
   * 更该说「尚未登场」而不是「有这个人但你看不见」。
   */
  const hiddenReason = new Map<string, "unspawned" | "hidden" | "enemy">();
  for (const c of template.characters) if (c.isEnemy) hiddenReason.set(c.id, "enemy");
  for (const n of state.npcs) {
    if (n.visibility === "hidden") hiddenReason.set(n.id, "hidden");
  }
  for (const n of state.npcs) {
    if (n.lifecycle.state === "unspawned") hiddenReason.set(n.id, "unspawned");
  }
  /**
   * 模板声明了哪些扩展（`docs/EXTENSIONS.md` §3）。**未声明即不跑** ——
   * 这里返回空数组时，下面一次都不会调用扩展，投影与「零扩展」逐字段一致。
   *
   * 注册表只在启动期写（`apps/server` bootstrap），运行期只读 ⇒ 投影保持确定。
   */
  const extensionRuntimes = resolveExtensionRuntimes(template);
  const selfId = selfIdOf(state);
  /**
   * 观察者三级：调用方显式传的 > `state.viewerId`（模板用 `observeActor` 写的）> self。
   * 写了但人不在（离场 / 被删）⇒ 回落到 self，不让一次观察把整张快照看空。
   */
  const requestedViewer = viewerIdArg ?? state.viewerId;
  const viewerId =
    requestedViewer !== undefined &&
    (requestedViewer === selfId || state.npcs.some((n) => n.id === requestedViewer))
      ? requestedViewer
      : selfId;
  /**
   * 演员目录（含玩家）：关系边贡献与快照段派生**共用这一份**，年龄 / 阶段不会两处各算一遍。
   */
  const actors = buildSnapshotActors(state, hiddenNodeIds, adapter, lookup);
  /**
   * **唯一的关系边集合**：声明边 + 扩展贡献的合成边
   * （`extensions/family/doc/FAMILY-GRAPH.md` §7.1：指针模式下把指针合成的边加回来）。
   *
   * 声明边先按**边自己的知情人范围**（`scope`，ADR-007 D2）收敛，与「有没有 NPC 卡」无关。
   *
   * 为什么解耦（2026-11-16 用户裁决 B-2）：关系是**独立事实** ——
   * 你可能完全不认识某个人（没有他的 NPC 卡），但你知道「某人有个父亲」。
   * 旧实现要求两端都在可见子图里，于是指向敌人/未登场者的边被整条带走，
   * 这类关系永远显示不出来。解耦后关系能否上屏只由**边自己**说了算：
   * `scope: public` 就是"谁都能知道这条关系"，引擎不再二次猜测。
   *
   * 想让某条关系只有当事人知道：写 `scope: private`（缺省）；
   * 想让「一部分人知道」：`scope: limited` + `knownBy`。
   * 端点有没有卡由 `counterpartVisible` 表达，名字由 `withName` 直接给全 ——
   * 前端因此不需要在"没有卡"的情况下反查人名。
   *
   * ⚠ 已知限制（本期接受）：敌人不实例化，所以**从敌人侧出边**没有落点 ——
   * 关系行只挂在 NPC 卡上，而卡片只来自 `state.npcs`。要让「敌人 → 某人」也上屏，
   * 得等 A 期真的把关系行提升为独立于卡片的一等投影项。
   *
   * 这个集合有两个消费者：① NPC 卡的行装配（`buildRelationRows`）；
   * ② `relationDerivation` / 快照段派生的 `visibleEdges`。
   * **不许**任何一方另拿一份 —— 两份就会长出双真相
   * （「卡片上写了这行、称谓却算不出来」正是这样来的）。
   */
  const observableRelations = mergeContributedRelationEdges(
    projectVisibleRelations(state.relations, viewerId),
    extensionRuntimes,
    { selfId: viewerId, actors, hiddenNodeIds },
    state.extensions,
  );
  /** 关系行里的人名解析：实例 → 模板（敌人没有实例但有名字）→ 玩家。 */
  const actorDirectory = buildActorDirectory(state, template);

  /** 类别 id → 显示名（模板 `equipment.categories`）；缺省回退 id。 */
  const categoryLabelOf = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    return template.equipment?.categories?.find((c) => c.id === id)?.label ?? id;
  };


  /**
   * 玩家状态 = **战斗镜像优先 + 世界层补齐**（2026-11-21）。
   *
   * 以前这里只读 `player.statuses`（世界层），于是战斗中挂上的 `black-flash` 这类
   * 战斗态在个人页一个字都看不到 —— 而战斗面板看得见，两处自相矛盾。
   * 与 `battleView` 同一份合并口径：镜像里的实例更「新鲜」（层数/剩余回合都在上面），
   * 世界层只补镜像缺的那些（旧档 / 手工构造）。
   *
   * 排序与战斗面板一致：战斗态 → 修正 → 天赋。
   */
  const playerStatusViews = ((): StatusView[] => {
    const activeBattle =
      state.battle !== null && state.battle !== undefined && !state.battle.over ? state.battle : undefined;
    const merged = activeBattle
      ? activeBattle.player.statuses
          .map((inst) => toStatusView(inst, lookup, ui, state.worldTime, true))
          .filter((s): s is StatusView => s !== null)
      : [];
    for (const inst of player.statuses) {
      if (merged.some((s) => s.id === inst.statusId)) continue;
      const view = toStatusView(inst, lookup, ui, state.worldTime);
      if (view !== null) merged.push(view);
    }
    return merged.sort((a, b) => statusKindRank(a.kind) - statusKindRank(b.kind));
  })();

  const statuses = playerStatusViews;

  const skills = player.skills.map((id) => {
    const def = lookup.skill(id);
    // 技能不参与正负零（用户 2026-11-18 裁决）：只有品级 / 自身 style。
    const style = resolveStyle(def?.style, def?.quality, ui, undefined, tagIdsOf(def));
    const effects = def === undefined ? [] : skillEffectSummaries(def, lookup, ui);
    /**
     * ADR-015：技能页里**照常列出**用不了的技能，只挂一个封印说明原因。
     * 这里只放「持久」判据（现在只有英雄召唤永久失去）；「这一回合够不够钱」属于战斗面板。
     */
    const seal = skillSealOf(state, id, lookup);
    const summon = summonOf(def, lookup, ui);
    return {
      id,
      name: def?.name ?? id,
      description: def?.description ?? "",
      kind: def?.kind ?? "general",
      ...(summon !== undefined ? { summon } : {}),
      ...(def?.quality !== undefined ? { quality: def.quality } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(effects.length > 0 ? { effects } : {}),
      ...(seal !== undefined ? { seal } : {}),
    };
  });

  const inventory = Object.entries(player.inventory)
    .filter(([, count]) => count > 0)
    .map(([itemId, count]) => {
      const def = lookup.item(itemId);
      return {
        itemId,
        name: def?.name ?? itemId,
        description: def?.description ?? "",
        count,
        usableOutsideBattle: def?.usableOutsideBattle ?? false,
        usableInBattle: def?.usableInBattle ?? false,
        // 展示字段（T5-02 / R-EQ-09）：不含任何状态结果——状态只进 effectiveAttributes（P8）
        type: def?.type ?? "key",
        slot: def?.slot,
        slotLabel: template.equipment?.slots?.find((s) => s.id === def?.slot)?.label,
        category: def?.category,
        ...(categoryLabelOf(def?.category) !== undefined
          ? { categoryLabel: categoryLabelOf(def?.category) }
          : {}),
        quality: def?.quality,
        ...(() => {
          if (def === undefined) return {};
          const style = resolveEntityStyle(def, ui);
          const tags = resolveEntityTags(def, ui);
          const effects =
            def.type === "equipment"
              ? equipmentEffectSummaries(def, lookup)
              : itemEffectSummaries(def, lookup, ui);
          return {
            ...(style !== undefined ? { style } : {}),
            ...(tags.length > 0 ? { tags } : {}),
            ...(effects.length > 0 ? { effects } : {}),
          };
        })(),
      };
    });

  const battle = state.battle ? battleView(state, lookup, template, ui) : null;
  // 战斗进行中时 HP/MP 以战斗镜像为准（战斗消耗实时反映到状态栏；结束后 finishBattle 已回写，两者一致）
  const shownHp = battle && !battle.over ? battle.player.hp : player.hp;
  const shownMp = battle && !battle.over ? battle.player.mp : player.mp;

  const snapshot: V2Snapshot = {
    worldId: state.id,
    templateId: state.templateId,
    /**
     * 观察者只在**不是自己**时下发（缺省即「你在看你自己」）。
     * 前端用它在顶栏标「你在看谁」；关系行已经按同一个 viewerId 收敛过。
     */
    ...(viewerId !== selfId ? { viewerId, viewerName: actorName(actorDirectory, viewerId) } : {}),
    worldName: template.meta.name,
    turnIndex: state.turnIndex,
    worldTime: state.worldTime,
    formattedTime: adapter.format(state.worldTime),
    lifeStage,
    lifeStageLabel: adapter.lifeStageLabel(lifeStage),
    startYear: template.meta.startYear,
    /**
     * LLM 是否还有一次 invocation 在路上（异步 fire-and-forget，回合本身不 await）。
     *
     * 玩家侧语义：这是**软提示**，不是锁。口径是「点击为主」——`llmPending` 为真时前端只应
     * 显示「AI 还在写」，**不得禁用点击**。玩家点得更快是合法输入，晚到的叙事会挂在它
     * **自己那一轮**的 `traceRef` 下补上（`readNarrativeBlocks` 按 `trace.turnIndex` 过滤），
     * 不会被错记成新一轮，也不会把事件弄丢（事件进 `delayQueue` 后不设窗口终点 ⇒ 不过期）。
     *
     * 只在为真时下发：字段缺省 = 没有在飞的调用，前端不必判 undefined 的三态。
     */
    ...(state.pendingInvocation !== undefined ? { llmPending: true } : {}),
    /**
     * D-07：章节进度对玩家可见。读 `flags.chapter`（模板 opening.yaml 起 1、setFlag 推进），
     * **仅当它是 number 时**下发；否则字段缺省（不输出 0/null，前端不渲染章节指示）。
     * 引擎不提供章节中文名（模板无章节名表），前端只用数字。
     */
    ...(typeof state.flags.chapter === "number" ? { storyChapter: state.flags.chapter } : {}),
    labels: {
      // 全部已声明资源的显示名（hp/mp 与自定义资源同口径；statusBar 的 label 优先）。
      resources: Object.fromEntries(
        Object.keys(template.resources).map((key) => [key, lookup.resourceLabel(key)]),
      ),
      attributes: lookup.attributeLabels(),
      mood: lookup.moodLabel(),
    },
    player: {
      id: player.id,
      name: player.name,
      age: player.age,
      gender: player.gender,
      genderLabel,
      hp: shownHp,
      maxHp: maxHp(player, template),
      mp: shownMp,
      maxMp: maxMp(player, template),
      mood: player.mood,
      moodBandLabel: moodBand(player.mood, template).label,
      attributes: { ...player.attributes },
      // ADR-003：属性面板视图（排序 / hidden 过滤 / 样式 / 档位 / 进度）在投影期一次算好。
      attributeViews: resolveAttributeViews(player.attributes, template, ui, player.attributeTiers),
      // ADR-003 D10：资源条顺序与显隐由 statusBar 决定；自定义资源同形。
      resources: resourceViews(state, lookup, ui),
      statuses,
      // ADR-018 D8：状态合计（含装备/心情残差），面板与详情共用一份，前端不再自己求和。
      statusTotals: statusTotalsOf(state, lookup, player),
      /**
       * 关系（2026-11-20）：**当前观察者**的出边与入边，与 NPC 卡同一份
       * `buildRelationRows`、同一份 `observableRelations`。
       *
       * 主语是 `viewerId` 而不是 `player.id`：`observeActor` 把镜头交给别人之后，
       * 「我的人际关系」这一屏本来就该换成他的 —— 否则那个效果在界面上等于没发生
       * （用户 2026-11-20：「借父亲的眼睛 我在前端没发现有任何用」）。
       * 谁的关系由 `relationsOwner` 标出来，展示层据此写「以 XX 的目光」。
       *
       * 两个方向都下发，由消费方决定画不画：NPC 卡滤出边，关系图也只画出边。
       */
      relations: buildRelationRows(
        viewerId,
        observableRelations,
        hiddenNodeIds,
        hiddenReason,
        extensionRuntimes,
        actorDirectory,
      ),
      ...(viewerId !== selfId
        ? { relationsOwner: { id: viewerId, name: actorName(actorDirectory, viewerId) } }
        : {}),
      skills,
      inventory,
      // 装备实例：只下发展示字段；状态结果不入投影（R-EQ-04 / P8）
      equipment: (player.equipment ?? []).map((inst) => {
        const def = lookup.item(inst.itemId);
        return {
          instanceId: inst.instanceId,
          itemId: inst.itemId,
          slot: inst.slot,
          ...(inst.stacks !== undefined ? { stacks: inst.stacks } : {}),
          ...(inst.durability !== undefined ? { durability: inst.durability } : {}),
          name: def?.name ?? inst.itemId,
          slotLabel: template.equipment?.slots?.find((s) => s.id === inst.slot)?.label ?? inst.slot,
          description: def?.description ?? "",
          category: def?.category,
          ...(categoryLabelOf(def?.category) !== undefined
            ? { categoryLabel: categoryLabelOf(def?.category) }
            : {}),
          quality: def?.quality,
          ...(() => {
            if (def === undefined) return {};
            const style = resolveEntityStyle(def, ui);
            const tags = resolveEntityTags(def, ui);
            const effects = equipmentEffectSummaries(def, lookup);
            return {
              ...(style !== undefined ? { style } : {}),
              ...(tags.length > 0 ? { tags } : {}),
              ...(effects.length > 0 ? { effects } : {}),
            };
          })(),
        };
      }),
    },
    // 槽位定义（R-EQ-11 / R-EQ-15）：个数、格数与摆位全部来自模板，前端不猜
    equipmentSlots: (template.equipment?.slots ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      maxCount: s.maxCount,
      allowedCategories: [...s.allowedCategories],
      // 判定用 id 与展示用 label 同序下发：前端不做 id→词的查表（词表在模板里）。
      allowedCategoryLabels: s.allowedCategories.map((id) => categoryLabelOf(id) ?? id),
      panelSide: s.panelSide ?? "bottom",
    })),
    // ADR-0022：unspawned（尚未出生/登场）的角色不上屏——实例存在是为了让模板能用
    // `npcState` 条件判断「还没出生」，但它不该出现在人物列表里。
    // 与关系边/称谓子图同源（ADR-0022 补记 D-1）：三处共用 `hiddenNodeIds`。
    npcs: state.npcs
      .filter((npc) => !hiddenNodeIds.has(npc.id))
      .map((npc) => {
      // ADR-0019：NPC 面板需要「状态 / 生命周期」两块。口径与玩家一致——
      // 状态只透 visibility=known（hidden/unknown 不外泄），阶段由年龄按模板阶段表推导。
      //
      // ADR-0021 决策 4.1：年龄**投影期现算**（`ageAt(birthTime, worldTime)`，年差口径=
      // 跨年界即 +1），不回写 `state.npcs[].age`（那是起始年龄快照）。旧档缺 birthTime
      // ⇒ 按同一反推口径兜底，保证「加载即与原来一致，此后随世界时间增长」。
      //
      // P1-2 任务 C（ADR-0024 补遗）：**已故/被占据/未登场者的年龄冻结在 `sinceWorldTime`**。
      // 否则人物面板会出现「天内理子 · 已故 · 阵亡 · 26 岁」并且年年长岁——死人不会变老。
      // 用 lifecycle 作为单一判据（不新引入字段）：alive 走 worldTime，其余走 sinceWorldTime。
      // `lifeStage` / `lifeStageLabel` 都由同一份展示派生 ⇒ 阶段也自动冻结，不另设基准。
      // 复活（回 alive）后自动恢复按 worldTime 增长，与状态机语义一致。
      const shown = npcPresentation(npc, state.worldTime, adapter);
      return {
        id: npc.id,
        name: npc.name,
        age: shown.age,
        genderLabel: lookup.genderLabel(npc.gender),
        personality: npc.personality,
        relationship: npc.relationship,
        knownGoals: [...npc.knownGoals],
        attributes: projectNpcAttributes(npc.attributes, template),
        attributeViews: resolveAttributeViews(npc.attributes, template, ui, npc.attributeTiers),
        // 与玩家卡同一份投影（ADR-002 D3）：NPC 面板上的「六眼」也要是同一身彩虹。
        statuses: npc.statuses
          .map((inst) => toStatusView(inst, lookup, ui, state.worldTime))
          .filter((s): s is StatusView => s !== null),
        lifeStage: shown.stage,
        lifeStageLabel: shown.lifeStageLabel,
        // ADR-0020：生命周期与上屏解耦——inactive 照常上屏，只是带状态标注。
        // 旧档加载时 schema 已补默认 alive，故这里不必兜底。
        lifecycle: {
          state: npc.lifecycle.state,
          ...(npc.lifecycle.reasonCode !== undefined ? { reasonCode: npc.lifecycle.reasonCode } : {}),
          sinceTurn: npc.lifecycle.sinceTurn,
          sinceWorldTime: npc.lifecycle.sinceWorldTime,
        },
        // 行来源与扩展推导用的边集是同一份 `observableRelations`（B-2 解耦后 =
        // 全部对 self 可见的边，不再按节点可见性剔除）——不得再引入第二份过滤口径，
        // 否则「卡片上写了这条关系、称谓却算不出来」这类自相矛盾会重新出现。
        relations: buildRelationRows(
          npc.id,
          observableRelations,
          hiddenNodeIds,
          hiddenReason,
          extensionRuntimes,
          actorDirectory,
        ),
        };
      }),
    // ADR-0034 §5：投影只给"当前在演什么"（`slotEvent`），不投影队列内容与长度。
    // **唯一真源**：过渡字段 `pendingEvent` / `activeChains` 已在前端切换（`c693814`）后删除，
    // 现存消费方一律读本字段；顺带消除 ADR §12-5 记的"投影重复求值"（旧实现为
    // `pendingEvent` 再调一次 `slotEventView`，同一场景算两遍）。
    /**
     * 待完成的加点（ADR-019）：只下发**请求**，属性等玩家提交后再变。
     * 目标里的 `label` / `style` 由适配器按玩家属性视图补齐（那里已解析过一遍）。
     */
    ...(state.pendingAllocation !== undefined
      ? {
          pendingAllocation: {
            id: state.pendingAllocation.id,
            budget: state.pendingAllocation.budget,
            ...(state.pendingAllocation.reason !== undefined
              ? { reason: state.pendingAllocation.reason }
              : {}),
            // 展示名与样式在投影期一次算好（与开局 `describeNode` 同一口径）。
            targets: state.pendingAllocation.targets.map((t) => ({
              attribute: t.attribute,
              label: t.label ?? lookup.attributeLabel(t.attribute),
              ...(t.min !== undefined ? { min: t.min } : {}),
              ...(t.max !== undefined ? { max: t.max } : {}),
              ...(t.style !== undefined ? { style: resolveStyle(t.style, undefined, ui) } : {}),
            })),
            sinceTurn: state.pendingAllocation.sinceTurn,
            sinceWorldTime: state.pendingAllocation.sinceWorldTime,
          },
        }
      : {}),
    slotEvent: ended ? null : slotEventView(state, lookup),
    battle,
    lastWheel: state.lastWheel,
    // D-03：当轮全部转盘结果（旧档无该字段 ⇒ 空数组，前端据此不渲染转盘区）
    lastWheels: state.lastWheels ?? [],
    availableActions: ended
      ? []
      : (template.actions ?? []).map((a) => ({
          id: a.id,
          label: a.label,
          description: a.description ?? "",
          duration: a.duration,
        })),
    evaluation: {
      summary: evaluation?.summary ?? "本局评价尚未生成。",
      canonDeviation: typeof state.flags.canonDeviation === "number" ? state.flags.canonDeviation : 0,
      // 五维分项（ADR-0016）：评价只读过程信号，不含结局类型 ⇒ 提前展示不泄露结局
      ...(evaluation
        ? {
            summarySource: evaluation.summarySource,
            dimensions: evaluation.dimensions.map((d) => ({
              id: d.id,
              ...(d.label !== undefined ? { label: d.label } : {}),
              score: d.score,
              level: d.level,
              explanation: d.explanation,
            })),
            ...(evaluation.overall !== undefined ? { overall: evaluation.overall } : {}),
          }
        : {}),
    },
    status,
    ending: state.termination ? buildEndingView(state.termination, endings, state) : null,
  };

  /**
   * 快照段派生（`docs/EXTENSIONS.md` §7）：装配完内核段之后、返回之前，逐个调用
   * **模板声明过且已注册**的 `snapshotDerivation`，把结果放进 `snapshot.extensions[id]`。
   *
   * 未声明 ⇒ `extensionRuntimes` 为空数组 ⇒ 这里一次都不调用，`snapshot.extensions`
   * 保持 `undefined`（零回归门槛）。段键不是扩展 id ⇒ `assertOwnSegmentKeys` 抛错。
   */
  applySnapshotDerivations(snapshot, extensionRuntimes, state.extensions, {
    // 与行装配**同一份**边集（含扩展贡献的合成边）——不许另算一份。
    selfId,
    visibleEdges: observableRelations,
    hiddenNodeIds,
    actors,
    worldTime: state.worldTime,
    turnIndex: state.turnIndex,
    // 历法口径与 `snapshot.formattedTime` 同源：扩展要展示历史时刻时不得自算。
    formatWorldTime: (minutes: number) => adapter.format(minutes),
  });
  return snapshot;
}

/**
 * NPC 的投影期展示派生（当前年龄 / 人生阶段 / 阶段文案）。
 *
 * **只在这里算一次**：NPC 列表与「快照段派生」的演员目录必须同源 —— 两处各算一遍，
 * 迟早会出现「卡片写 26 岁、族谱写 27 岁」。
 *
 * ADR-0021 决策 4.1：年龄投影期现算（`ageAt(birthTime, worldTime)`），不回写
 * `state.npcs[].age`；旧档缺 `birthTime` 按同一反推口径兜底。
 * P1-2 / ADR-0024 补遗：**已故/被占据/未登场者的年龄冻结在 `sinceWorldTime`**（死人不会变老）。
 */
function npcPresentation(
  npc: V2Npc,
  worldTime: number,
  adapter: ReturnType<typeof createTimeAdapter>,
): { age: number; stage: string; lifeStageLabel: string } {
  const ageBasis = npc.lifecycle.state === "alive" ? worldTime : npc.lifecycle.sinceWorldTime;
  const age = adapter.ageAt(npc.birthTime ?? birthTimeFromAge(npc.age, adapter), ageBasis);
  const stage = adapter.resolveLifeStage(age);
  return { age, stage, lifeStageLabel: adapter.lifeStageLabel(stage) };
}

/**
 * 快照段派生用的演员目录（含玩家）。
 *
 * 与关系行的 `actorDirectory` 不是一回事：那边要「名字」，这里还要**展示派生**
 * （年龄 / 阶段 / 生死态 / 有没有卡）。名字仍以实例与玩家为准，不另立真源。
 */
function buildSnapshotActors(
  state: WorldStateV2,
  hiddenNodeIds: ReadonlySet<string>,
  adapter: ReturnType<typeof createTimeAdapter>,
  lookup: TemplateLookup,
): Map<string, SnapshotActor> {
  const selfId = selfIdOf(state);
  const actors = new Map<string, SnapshotActor>();
  for (const npc of state.npcs) {
    const shown = npcPresentation(npc, state.worldTime, adapter);
    actors.set(npc.id, {
      id: npc.id,
      name: npc.name,
      visible: !hiddenNodeIds.has(npc.id),
      alive: npc.lifecycle.state === "alive",
      age: shown.age,
      // 原始 gender id 只透传，由扩展解释（内核不判断 male/female 语义）。
      genderId: npc.gender,
      genderLabel: lookup.genderLabel(npc.gender),
      lifeStageLabel: shown.lifeStageLabel,
      lifeState: npc.lifecycle.state,
      ...(npc.lifecycle.reasonCode !== undefined ? { reasonCode: npc.lifecycle.reasonCode } : {}),
      // 指针与出生时刻原样透传（FAMILY-GRAPH §3.1）：只搬运实例已有字段，不新增计算。
      ...(npc.fatherId !== undefined ? { fatherId: npc.fatherId } : {}),
      ...(npc.motherId !== undefined ? { motherId: npc.motherId } : {}),
      ...(npc.birthTime !== undefined ? { birthTime: npc.birthTime } : {}),
    });
  }
  const player = state.player;
  // 权威 self 实体（ADR-001）：被扮演的角色不另建 npc 实例，这里把它作为演员写进目录。
  // 玩家没有 lifecycle：恒在世、恒可见（见 hiddenNodeIds 的硬保留说明）。
  actors.set(selfId, {
    id: selfId,
    name: player.name,
    visible: true,
    alive: true,
    age: player.age,
    genderId: player.gender,
    genderLabel: lookup.genderLabel(player.gender),
    lifeStageLabel: adapter.lifeStageLabel(adapter.resolveLifeStage(player.age)),
    lifeState: "alive",
    // 玩家指针同样原样透传（`extensions/family/doc/FAMILY-GRAPH.md` §3.1：玩家不是特例）。
    ...(player.fatherId !== undefined ? { fatherId: player.fatherId } : {}),
    ...(player.motherId !== undefined ? { motherId: player.motherId } : {}),
  });
  return actors;
}

/**
 * 把扩展贡献的关系边并入声明边（`extensions/family/doc/FAMILY-GRAPH.md` §7.1）。
 *
 * 规则（**冲突时声明边赢**）：
 * · 键 = `(from, to, kind)`。声明边先占位，合成边撞键就让位 ——
 *   作者写的关系优先级更高，推出来的只是补充；
 * · 只接受 `known` / `inferred`：合成边同样要过内核的可见性门槛，否则扩展能绕过
 *   `projectVisibleRelations` 把 hidden 关系说上屏（那是红线）；
 * · 自环直接丢（`RelationEdgeSchema` 对声明边禁止自环，合成边照办）；
 * · **没有扩展贡献 ⇒ 原样返回声明边**：没有指针的存量语料与零扩展模板逐字段不变。
 *
 * 扩展抛错不 fail-fast（与 `snapshotDerivation` 同口径）：派生展示坏掉不该把整局锁死。
 */
function mergeContributedRelationEdges(
  declared: readonly RelationEdge[],
  extensions: readonly ResolvedExtension[],
  base: Pick<RelationEdgeSourceContext, "selfId" | "actors" | "hiddenNodeIds">,
  extensionSlices: Readonly<Record<string, unknown>> | undefined,
): readonly RelationEdge[] {
  /** 已占位的 `(from,to,kind)`：先放进全部声明边，合成边只能补空位。 */
  const seen = new Set<string>();
  for (const edge of declared) seen.add(relationEdgeKey(edge));

  let merged: RelationEdge[] | null = null;
  for (const ext of extensions) {
    const contribute = ext.runtime.contributeRelationEdges;
    if (contribute === undefined) continue;

    let contributed: readonly RelationEdge[];
    try {
      contributed = contribute({
        selfId: base.selfId,
        actors: base.actors,
        hiddenNodeIds: base.hiddenNodeIds,
        config: ext.config,
        // 每个扩展只看得见**自己的**切片（同 `SnapshotDerivationContext.extensionState`）。
        extensionState: extensionSlices?.[ext.id],
      });
    } catch (err) {
      console.warn(
        `[extensions] "${ext.id}".contributeRelationEdges 抛错，本次投影跳过其贡献：`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    for (const edge of contributed) {
      // 扩展贡献的边同样按观察者判定（ADR-007 D3）：扩展不许"替玩家知道"。
      if (!relationVisibleTo(edge, base.selfId)) continue;
      if (edge.from === edge.to) continue;
      const key = relationEdgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      (merged ??= [...declared]).push(edge);
    }
  }
  return merged ?? declared;
}

/** 关系边去重键：`(from, to, kind)`（与 `relations.addEdge` 同口径）。 */
function relationEdgeKey(edge: RelationEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
}

/**
 * 把扩展返回的段并入 `snapshot.extensions`（按扩展 id 分槽，`docs/EXTENSIONS.md` §7）。
 *
 * **失败策略：跳过并留诊断，不 fail-fast。** 理由：派生段不是事实 —— 一个可选展示
 * 扩展抛错时，世界状态本身仍然可玩；让整张投影崩掉等于「装了个展示插件
 * 就把整局锁死」，违反「卸载全部扩展内核照跑」的边界。契约违规（段键不是自己的 id）
 * 仍然**抛错**：那是代码 bug，必须响。
 */
function applySnapshotDerivations(
  snapshot: V2Snapshot,
  extensions: readonly ResolvedExtension[],
  extensionSlices: Readonly<Record<string, unknown>> | undefined,
  base: Omit<SnapshotDerivationContext, "config" | "memo" | "extensionState">,
): void {
  if (extensions.length === 0) return;
  const target = snapshot as unknown as Record<string, unknown>;
  const namespace: Record<string, unknown> = {
    ...(target.extensions as Record<string, unknown> | undefined),
  };
  for (const ext of extensions) {
    const derive = ext.runtime.snapshotDerivation?.derive;
    if (derive === undefined) continue;
    let segment: Record<string, unknown>;
    try {
      segment = derive({
        ...base,
        config: ext.config,
        // 每个扩展只看得见**自己的**切片（别的扩展的 state 不是它的数据源）。
        extensionState: extensionSlices?.[ext.id],
        memo: new Map<string, unknown>(),
      });
    } catch (err) {
      console.warn(
        `[extensions] "${ext.id}".snapshotDerivation 抛错，本次投影跳过该段：`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    assertOwnSegmentKeys(ext.id, segment);
    // 段键 = 扩展 id ⇒ 只落在自己那一格，不可能改写别人的段或内核字段。
    for (const [key, value] of Object.entries(segment)) namespace[key] = value;
  }
  if (Object.keys(namespace).length > 0) target.extensions = namespace;
}

/**
 * 「这个人为什么没有卡」（2026-11-19）。返回 `undefined` = 有卡。
 *
 * 只回答 KV 里那条规则命中了谁 —— 判定本身仍在 `hiddenNodeIds`（唯一真源），
 * 本函数不新增任何上屏规则，只把已有的三条规则翻译成一句能给玩家看的话。
 */
function counterpartStateOf(
  hiddenNodeIds: ReadonlySet<string>,
  hiddenReason: ReadonlyMap<string, "unspawned" | "hidden" | "enemy">,
  id: string,
): "unspawned" | "hidden" | "enemy" | undefined {
  if (!hiddenNodeIds.has(id)) return undefined;
  return hiddenReason.get(id) ?? "unspawned";
}

/**
 * 一张卡的关系行：**内核填事实，扩展加解释**（`docs/EXTENSIONS.md` §2）。
 *
 * 内核负责且只负责：
 * · 事实行（`known` / `inferred` 边）与它们的 `withName` / `counterpartVisible` / `direction`；
 * · 每卡一个 `memo`，逐行 `decorate`、每卡一次 `extendRows`（顺序 = 模板声明顺序）；
 * · 这套契约里内核能守的三条：字段同名冲突抛错、推导行的可行性与命名由内核说了算、
 *   未声明不跑（由调用方传进来的 `extensions` 为空表达）。
 *
 * 扩展**拿不到**命名与上屏判定：`withName` / `counterpartVisible` 一律从 actor 目录与
 * `hiddenNodeIds` 现算 —— 否则隐藏角色可以被扩展「说出来」。
 */
function buildRelationRows(
  viewerId: string,
  visibleEdges: readonly RelationEdge[],
  hiddenNodeIds: ReadonlySet<string>,
  hiddenReason: ReadonlyMap<string, "unspawned" | "hidden" | "enemy">,
  extensions: readonly ResolvedExtension[],
  directory: ReturnType<typeof buildActorDirectory>,
): RelationRow[] {
  /**
   * 每张卡一个 memo，`decorate` 与 `extendRows` 共用。
   * 多跳路径枚举的记忆化放这里 —— 同一对端点会被事实行与推导行各查一次，
   * 不缓存则每条路径枚举跑两遍（十二人家族下足以把请求拖死）。
   */
  const memo = new Map<string, unknown>();

  const factEdges = visibleEdges.filter((e) => e.from === viewerId || e.to === viewerId);
  const factCounterpartIds = new Set<string>();
  const rows: RelationRow[] = [];

  for (const edge of factEdges) {
    const outgoing = edge.from === viewerId;
    const withId = outgoing ? edge.to : edge.from;
    factCounterpartIds.add(withId);
    const noCardReason = counterpartStateOf(hiddenNodeIds, hiddenReason, withId);
    const row: MutableRelationRow = {
      withId,
      kind: edge.kind,
      scope: relationScopeOf(edge),
      direction: outgoing ? "out" : "in",
      /**
       * 对方有没有 NPC 卡。`false` = 这条边指向一个未登场 / 不展示的角色
       * （比如敌人、或尚未露面的亲属）—— 关系是真的，但点不出卡片。
       * 前端据此显示「名字 + 未登场」，而不是假装有卡或干脆不显示这条边。
       */
      counterpartVisible: !hiddenNodeIds.has(withId),
      /** 没卡的理由：关系行据此写「尚未登场 / 未现身 / 不在名册」，不再一句「无档案」 */
      ...(noCardReason !== undefined ? { counterpartState: noCardReason } : {}),
      /** 对方名字（隐藏/未登场/敌人都有；前端不再需要在无卡时反查） */
      withName: actorName(directory, withId),
      ...(edge.value !== undefined ? { value: edge.value } : {}),
    };
    for (const ext of extensions) {
      const decorate = ext.runtime.relationDerivation?.decorate;
      if (decorate === undefined) continue;
      const fields = decorate({ viewerId, edge, outgoing, visibleEdges, config: ext.config, memo });
      if (fields === null) continue;
      assertNoReservedRowFields(ext.id, fields);
      Object.assign(row, fields);
    }
    rows.push(row);
  }

  /**
   * 推导行：没有直接边、但扩展推得出来的关系（如多跳亲缘）。
   *
   * 这些行**不是新事实**，是同一张事实图上换一条路径得出的另一个解释 ——
   * 所以可见性由扩展按构成边合成（`visibility` 已在草稿里给出），
   * 但「能不能上屏」仍由内核判定（见下方两条 continue）。
   */
  /**
   * 判重按**读法**而不是「有没有边」（2026-11-20）。
   *
   * `covered` 以前是「这个人已经有事实行 ⇒ 推导行一律不要」。那条规则在
   * 「娶了自己的外婆」这种局面下会吃掉真实信息：事实行只说「妻子」，
   * 而多跳推出来的「外婆」被当成重复整条丢弃 —— 玩家看到的是「外婆边消失了」。
   *
   * 现在两个键各管一段：`withId::kind` 挡同类型的重复，`withId::称谓` 挡同读法的重复，
   * 读法不同的推导行照常出现（同一段亲缘的另一种叫法本来就该并排站着）。
   */
  const coveredKeys = new Set<string>();
  const coveredTerms = new Set<string>();
  for (const row of rows) {
    coveredKeys.add(`${row.withId}::${row.kind}`);
    if (typeof row.kinshipTerm === "string" && row.kinshipTerm !== "") {
      coveredTerms.add(`${row.withId}::${row.kinshipTerm}`);
    }
  }
  /** 扩展要的「事实行说过哪些称谓 / 类型」，按人聚合。 */
  const factTerms = new Map<string, Set<string>>();
  const factKinds = new Map<string, Set<string>>();
  for (const row of rows) {
    const kinds = factKinds.get(row.withId) ?? new Set<string>();
    kinds.add(row.kind);
    factKinds.set(row.withId, kinds);
    if (typeof row.kinshipTerm !== "string" || row.kinshipTerm === "") continue;
    const set = factTerms.get(row.withId) ?? new Set<string>();
    set.add(row.kinshipTerm);
    factTerms.set(row.withId, set);
  }

  for (const ext of extensions) {
    const extendRows = ext.runtime.relationDerivation?.extendRows;
    if (extendRows === undefined) continue;
    const drafts = extendRows({
      viewerId,
      visibleEdges,
      factCounterpartIds,
      factTerms,
      factKinds,
      hiddenNodeIds,
      config: ext.config,
      memo,
    });
    for (const draft of drafts) {
      // 保证 3：推得出来 ≠ 可以显示。隐藏节点一律丢弃；重复按 kind / 称谓逐条判。
      if (hiddenNodeIds.has(draft.withId)) continue;
      if (coveredKeys.has(`${draft.withId}::${draft.kind ?? "relative"}`)) continue;
      if (
        typeof draft.fields?.kinshipTerm === "string" &&
        draft.fields.kinshipTerm !== "" &&
        coveredTerms.has(`${draft.withId}::${draft.fields.kinshipTerm}`)
      ) {
        continue;
      }
      const fields = draft.fields ?? {};
      assertNoReservedRowFields(ext.id, fields);
      /**
       * `kind` 缺省 `"relative"`：这里借用的只是**显示层的 kind 名**（模板同样可以用
       * `relative` 声明「据称的远亲」，配 `gap: true`），不是在伪造一条状态边。
       *
       * 这些行只在投影里现造，**从不写进 `state.relations`**：`derived: true` / `kind`
       * 都随 `V2Snapshot` 一次性下发，引擎的条件与效果永远看不到它们。因此
       * 「他是我亲戚」不会污染「他是我的父亲」这类事实判定 —— 不需要在求值侧另加判断。
       */
      const draftNoCardReason = counterpartStateOf(hiddenNodeIds, hiddenReason, draft.withId);
      const row: MutableRelationRow = {
        withId: draft.withId,
        kind: draft.kind ?? "relative",
        scope: draft.scope ?? "public",
        direction: "out",
        counterpartVisible: !hiddenNodeIds.has(draft.withId),
        ...(draftNoCardReason !== undefined ? { counterpartState: draftNoCardReason } : {}),
        withName: actorName(directory, draft.withId),
        derived: true,
      };
      Object.assign(row, fields);
      rows.push(row);
      // 同一个「人 + 类型」只留一行：后一个扩展不许把同一段话再说一遍。
      coveredKeys.add(`${row.withId}::${row.kind}`);
      if (typeof row.kinshipTerm === "string" && row.kinshipTerm !== "") {
        coveredTerms.add(`${row.withId}::${row.kinshipTerm}`);
      }
    }
  }

  return rows;
}

/**
 * 资源条视图（ADR-003 D10）。
 *
 * 顺序与可见性 = `statusBar` 的 `source: resource` 段（模板声明什么就显示什么）；
 * 一个 resource 段都没写时回退 hp/mp（旧模板的默认 HUD）。
 * 战斗进行中取战斗镜像（消耗实时可见），结束后镜像已回写，与权威态一致。
 */
function resourceViews(
  state: WorldStateV2,
  lookup: TemplateLookup,
  ui: UiConfig | undefined,
): ResourceView[] {
  const template = lookup.template;
  const inBattle = state.battle !== null && !state.battle.over;
  const valueOf = (key: string): number => {
    if (!inBattle) return resourceValue(state.player, key);
    const mirror = state.battle!.player;
    if (key === "hp") return mirror.hp;
    if (key === "mp") return mirror.mp;
    return mirror.resources[key] ?? 0;
  };
  const viewOf = (key: string, label: string): ResourceView | undefined => {
    const def = template.resources[key];
    if (def === undefined) return undefined;
    const display = ui?.resources?.[key]?.display ?? DEFAULT_RESOURCE_DISPLAY;
    const fallbackDanger = key === "hp" || key === "mp" ? DEFAULT_RESOURCE_DANGER_RATIO : 0;
    const dangerAt = ui?.resources?.[key]?.dangerAt ?? fallbackDanger;
    return {
      key,
      label,
      value: valueOf(key),
      max: resourceMax(state.player, template, key),
      display,
      dangerAt,
    };
  };

  const out: ResourceView[] = [];
  const seen = new Set<string>();
  for (const section of template.statusBar) {
    if (section.source !== "resource" || section.key === undefined) continue;
    if (seen.has(section.key)) continue;
    const view = viewOf(section.key, section.label);
    if (view === undefined) continue;
    seen.add(section.key);
    out.push(view);
  }
  if (out.length === 0) {
    for (const key of ["hp", "mp"] as const) {
      const view = viewOf(key, lookup.resourceLabel(key));
      if (view !== undefined) out.push(view);
    }
  }
  /**
   * ADR-012 D9 补：**专属池**也要上屏，否则「咒灵数量」这条经济完全不可见
   * （它不在 `template.resources` 里，上面那两圈都扫不到）。
   * 上限取玩家身上那一份（`resourceMax`），标签取声明它的角色所写的 `label`。
   */
  for (const key of Object.keys(state.player.resourceMax ?? {})) {
    if (seen.has(key) || template.resources[key] !== undefined) continue;
    const value = inBattle ? (state.battle!.player.resources[key] ?? 0) : resourceValue(state.player, key);
    out.push({
      key,
      label: exclusiveLabel(template, key),
      value,
      max: state.player.resourceMax![key],
      display: ui?.resources?.[key]?.display ?? DEFAULT_RESOURCE_DISPLAY,
      dangerAt: ui?.resources?.[key]?.dangerAt ?? 0,
    });
  }
  return out;
}

/** 专属池的显示名：取第一个声明它的角色所写的 `label`，没写就用键名（不编造）。 */
function exclusiveLabel(template: { characters: readonly { resources?: Record<string, { label?: string }> }[] }, key: string): string {
  for (const c of template.characters) {
    const label = c.resources?.[key]?.label;
    if (label !== undefined) return label;
  }
  return key;
}

/**
 * NPC 属性下发（ADR-0021 决策 3 / ADR-003）：
 * - 键集 = `template.attributes.order`（顺序无关地相等），order 外的键**一律不透**
 *   ——否则玩家侧的 `proficiency*` 之类内部/派生键会变成新的 API 面；
 * - 值 = 实例层的模板 base 原值（`turn.ts` 建实例时从 `characters[].attributes` 拷入）；
 *   order 内但 NPC 未声明的键给 0，与玩家面板取值口径一致；
 * - order 为空 ⇒ `{}`（不是缺省 undefined，前端直接遍历）。
 * 这里**不做** effective 派生：状态过滤后算出的数与战斗实算必不一致，
 * 不过滤则成 hidden 侧信道（ADR-0019 红线），二者不可兼得。
 */
function projectNpcAttributes(
  attributes: Record<string, AttributeValue>,
  template: WorldTemplateV2,
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const key of template.attributes.order) out[key] = attributes[key] ?? 0;
  return out;
}

/**
 * 结局投影：只读取模板的公有叙事字段。
 * 隐藏结局（模板声明 narrativeConfig.masked，ADR-0006）即便命中也不外泄 name / description
 * （R-EN-05 / R-NFR-04）：title/summary 按掩码配置下发（缺省回退默认掩码文案），
 * 仅保留 endingId 与派生的 visibility 供前端提示，evidenceIds 置空。
 */
function buildEndingView(
  termination: TerminationRecord,
  endings: readonly EndingTemplate[] | undefined,
  state: WorldStateV2,
): EndingView {
  const base = {
    source: termination.source,
    reason: termination.reason,
    worldTime: termination.worldTime,
    turnIndex: termination.turnIndex,
  };
  const tpl = endings?.find((e) => e.endingId === termination.endingId);
  if (!tpl) {
    return {
      endingId: termination.endingId ?? "unresolved",
      title: "旅程收束",
      summary: "本局到此结束。",
      endingType: "neutral",
      visibility: "public",
      narrativeSource: "template",
      evidenceIds: state.history.map((h) => h.id),
      ...base,
    };
  }
  const masked = tpl.narrativeConfig.masked;
  if (masked) {
    return {
      endingId: tpl.endingId,
      title: masked.title ?? "未公开的结局",
      summary: masked.summary ?? "有一个不会出现在公开名录里的结局被达成了。",
      endingType: tpl.endingType,
      visibility: "hidden",
      narrativeSource: "template",
      evidenceIds: [],
      ...base,
    };
  }
  return {
    endingId: tpl.endingId,
    title: tpl.narrativeConfig.title ?? tpl.name,
    summary: tpl.narrativeConfig.summary ?? tpl.description,
    endingType: tpl.endingType,
    visibility: "public",
    narrativeSource: "template",
    evidenceIds: state.history.map((h) => h.id),
    ...base,
  };
}

/**
 * 状态投影（ADR-002 D3）：玩家卡、战斗面板共用同一份。
 * `hidden` 状态不进投影（既有红线：hidden 侧信道）。
 */
function statusViewOf(
  def: StatusEffect,
  stacks: number,
  lookup: TemplateLookup,
  ui: UiConfig | undefined,
  /** 只有**实例**能给时长；定义视图不传，于是输出里就没有 `durationLabel`。 */
  durationLabel?: string,
): StatusView {
  const style = resolveEntityStyle(def, ui);
  const tags = resolveEntityTags(def, ui);
  const effects = statusEffectSummaries(def, lookup, ui);
  return {
    id: def.id,
    name: def.name,
    stacks,
    /**
     * 正负是**一等字段**（2026-11-20）：战斗面板与技能描述的配色都由它决定，
     * 不再下发 `battleStyle` —— 后端不再为「战斗中长什么样」做一份解析。
     */
    polarity: def.polarity,
    kind: def.kind,
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...(def.quality !== undefined ? { quality: def.quality } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(effects.length > 0 ? { effects } : {}),
    ...(durationLabel !== undefined ? { durationLabel } : {}),
  };
}

/**
 * 状态的**定义视图**（2026-11-20）：挂载在角色 / 召唤物身上的被动用它。
 *
 * 定义没有时长（ADR-009 D1），也不存在 `appliedAt / appliedTurn` 这些实例字段 ——
 * 以前为了复用实例投影，代码里会伪造一个「本轮刚挂上」的实例再显示「直到被移除」，
 * 那是**假事实**。定义视图从定义出发，天然没有时长。
 */
function statusViewOfDefinition(def: StatusEffect, lookup: TemplateLookup, ui: UiConfig | undefined): StatusView {
  return statusViewOf(def, 1, lookup, ui);
}

/**
 * 状态展示排序：战斗态（这一场会掉）→ 修正（战后还挂着）→ 天赋（身份）。
 * 投影里两处（个人页 / 战斗面板）共用，避免两套顺序各排各的。
 */
function statusKindRank(kind: StatusView["kind"]): number {
  return kind === "battle" ? 0 : kind === "modifier" ? 1 : 2;
}

function toStatusView(
  inst: StatusInstance,
  lookup: TemplateLookup,
  ui: UiConfig | undefined,
  /** 当前世界时间（分钟）：状态「还剩多久」由实例的绝对到期点算出（ADR-009）。 */
  worldTime: number,
  /**
   * 这条状态是在**战斗面板**上展示的吗（ADR-015 D2）。
   *
   * 战斗中 `worldTime` 不动，所以按世界时间算出来的「还剩 2 天」在一场战斗里既不会变、
   * 也不会因为打完而变少 —— 沿用同一个口径会让玩家以为「打一场消耗两天」。
   * 战斗面板改说「整场战斗有效（战后还剩 X）」，把两件事分开说清。
   */
  inBattle = false,
): StatusView | null {
  const def = lookup.status(inst.statusId);
  if (def === undefined || def.visibility !== "known") return null;
  /**
   * 天赋**不下发时长**（ADR-018 D1）：它没有时钟，面板与详情都不该出现「持续」。
   * 这不是展示层过滤 —— 下发了就总会有人把它渲染出来，然后「六眼 直到被移除」
   * 就成了玩家要猜的一句话。
   */
  const label =
    def.kind === "talent"
      ? undefined
      : // 战斗态省略时长 = 撑到战斗结束；写「直到被移除」会让玩家以为它出了战斗还在。
        def.kind === "battle" && inst.roundsLeft === undefined
        ? "整场战斗"
        : statusDurationRemaining(inst, worldTime, { inBattle });
  return statusViewOf(def, inst.stacks, lookup, ui, label);
}

function battleView(
  state: WorldStateV2,
  lookup: TemplateLookup,
  template: WorldTemplateV2,
  ui: UiConfig | undefined,
): BattleView {
  const battle = state.battle!;
  /**
   * 战斗面板的状态列表：**三类全上**（2026-11-20 用户裁决）。
   *
   * 以前只留带 `combat` 字段的，理由是「纯模拟面状态在战斗里没有行为语义」。
   * ADR-018 之后这条前提没了：`attributeModifiers` 提到定义层，一件只有属性状态的
   * 「重伤」会实打实压低战斗里的敏捷与体术 —— 再从面板上过滤掉，就是"数字变了但没有原因"。
   *
   * 排序按紧迫度：战斗状态（这一场会掉）→ 修正（战后还挂着）→ 天赋（身份）。
   * 这条排序同时是展示层的分组依据，所以放在投影里做一次，前端不再各排各的。
   */
  const kindRank = statusKindRank;
  const statusViews = (instances: StatusInstance[]) =>
    instances
      .map((inst) => toStatusView(inst, lookup, ui, state.worldTime, true))
      .filter((s): s is StatusView => s !== null);

  /**
   * 镜像优先、世界补齐：正常战斗里镜像就是全量副本，这里「补齐」是给
   * 手工构造 / 旧档（镜像为空但世界有状态）兜底 —— 少了它，面板会突然一条都没有。
   */
  const battleStatuses = statusViews(battle.player.statuses);
  const allStatuses = [...battleStatuses];
  for (const s of statusViews(state.player.statuses)) {
    if (!allStatuses.some((x) => x.id === s.id)) allStatuses.push(s);
  }
  allStatuses.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));

  /**
   * 战斗单位 → 展示模型（敌 / 友 / 中立共用）。
   * `tier` 决定前端版式（ADR-012 D2）：小框还是整行，由模板声明，不由前端猜名字。
   */
  /** 召唤者名字：玩家不在参战数组里，要单独认；NPC 按战斗实例 id 找。 */
  const summonerNameOf = (unit: BattleEnemy): string | undefined => {
    if (unit.summonedBy === undefined) return undefined;
    if (unit.summonedBy === selfIdOf(state)) return state.player.name;
    const owner = [...battle.enemies, ...battle.allies, ...(battle.neutrals ?? [])].find(
      (u) => u.instanceId === unit.summonedBy,
    );
    return owner?.name ?? state.npcs.find((n) => n.id === unit.summonedBy)?.name;
  };
  const combatantView = (unit: BattleEnemy): BattleEnemyView => ({
    instanceId: unit.instanceId,
    name: unit.name,
    // 已退场名册是混合列表：阵营必须跟着走，否则敌方献祭的单位会画成友军蓝框。
    ...(unit.side !== undefined ? { side: unit.side } : {}),
    hp: Math.max(0, unit.hp),
    maxHp: unit.maxHp,
    alive: unit.alive,
    statuses: statusViews(unit.statuses),
    // ADR-012 D9：专属资源池（只有声明过的角色才有条目）。
    resources: Object.entries(unit.resources ?? {}).map(([key, value]) => ({
      key,
      label: lookup.resourceLabel(key),
      value,
      max: unit.resourceMax?.[key] ?? value,
      display: "bar" as const,
      dangerAt: 0,
    })),
    ...(unit.tier !== undefined ? { tier: unit.tier } : {}),
    ...(unit.summonedBy !== undefined ? { summonedBy: unit.summonedBy } : {}),
    ...(unit.summonRef !== undefined ? { summonRef: unit.summonRef } : {}),
    ...(unit.deathReason !== undefined ? { deathReason: unit.deathReason } : {}),
    ...(summonerNameOf(unit) !== undefined ? { summonerName: summonerNameOf(unit) } : {}),
  });

  return {
    eventId: battle.eventId,
    round: battle.round,
    over: battle.over,
    player: {
      /**
       * 玩家在战斗里的单位 id（= `state.player.id`）。
       *
       * 「选自己」需要一个**真实**的目标 id：`null` 只表示「还没选」，
       * 两者混用会让「点了自己」和「没点」在契约上分不开（用户 2026-11-20）。
       */
      id: selfIdOf(state),
      hp: battle.player.hp,
      maxHp: maxHp(state.player, template),
      mp: battle.player.mp,
      maxMp: maxMp(state.player, template),
      // ADR-003 D10：战斗内资源条（hp/mp + 自定义资源），值取战斗镜像。
      resources: resourceViews(state, lookup, ui),
      statuses: allStatuses,
      skills: playerSkills(state, lookup)
        .map((id) => lookup.skill(id))
        .filter((s) => s?.kind === "combat")
        /**
         * ADR-015（用户 2026-11-20 裁决，取代 ADR-013 D3 的「从面板上拿掉」）：
         * 用不了的技能**仍然列出来**，挂 `seal` 说明原因。
         *
         * 「藏起来」比「灰着」更糟：玩家无法区分「我没学过」和「我学过但用不了」，
         * 只能怀疑是自己点错了。判据一律问 `battleSealOf`（内部就是 `canUseSkill`，
         * 与引擎拒绝同源），这里不自己数消耗、不自己数上限。
         */
        .map((s) => {
          const combat = s as Extract<NonNullable<typeof s>, { kind: "combat" }>;
          /**
           * ADR-012 D8：价格走**修正后**的值（六眼 -90%）。
           * 面板写 18 而实际扣 2，玩家会以为技能坏了；反之写 2 扣 18 更糟。
           */
          const cost = effectiveCostOf(state, battle, selfIdOf(state), combat.id, lookup);
          const resolved = Object.keys(cost).length > 0 ? cost : combat.cost;
          const seal = battleSealOf(state, battle, selfIdOf(state), combat.id, lookup);
          /**
           * 合法目标（2026-11-20）：只对**需要点选**的目标类型下发（`enemy` / `ally`）。
           * 判据与引擎同一份（`legalTargetsForPlayer` → `legalTargetIdsOf`），
           * UI 只做 `includes`，不重算规则 —— 否则新增谓词时前端要跟着抄一遍协议。
           */
          const legalTargets =
            combat.target === "enemy" || combat.target === "ally"
              ? legalTargetsForPlayer(battle, state, combat)
              : undefined;
          return {
            id: combat.id,
            name: combat.name,
            description: combat.description ?? "",
            costs: Object.entries(resolved)
              .filter(([, amount]) => amount > 0)
              .map(([resource, amount]) => ({
                resource,
                label: lookup.resourceLabel(resource),
                amount,
              })),
            cooldownLeft: battle.player.skillCooldowns[combat.id] ?? 0,
            target: combat.target,
            ...(legalTargets !== undefined ? { legalTargets } : {}),
            ...(combat.legalTarget?.disableReason !== undefined
              ? { legalTargetNote: combat.legalTarget.disableReason }
              : {}),
            ...(seal !== undefined ? { seal } : {}),
          };
        }),
      items: Object.entries(state.player.inventory)
        .filter(([itemId, count]) => count > 0 && lookup.item(itemId)?.usableInBattle)
        .map(([itemId, count]) => ({ itemId, name: lookup.item(itemId)?.name ?? itemId, count })),
      /**
       * D-12：逃跑可用性 = settle 声明**与**未被 cannot_flee 状态压制（与引擎判定同源）。
       * 引擎侧顺序是 `!settle.canFlee ⇒ flee_not_allowed`、`controlOf(...cannot_flee) ⇒ cannot_flee`，
       * 两者都通过才真能逃 ⇒ 投影取 AND，判定函数复用 battle.ts 的 controlOf。
       */
      canFlee: (battle.settle.canFlee ?? false) && !controlOf(battle.player.statuses, "cannot_flee", lookup),
      /**
       * D-08：与引擎同一判定（battle.ts 的 controlOf），输入取**战斗镜像**的状态列表
       * —— 这正是 performBattleAction 检查 `pc.statuses` 的来源，二者不会漂移。
       */
      canUseItems: !controlOf(battle.player.statuses, "cannot_use_items", lookup),
      /**
       * D-13：与引擎同一分支同源 —— performBattleAction 的第一步就是
       * `controlOf(pc.statuses, "cannot_act")`，为真时**不抛错**、只记日志并跳过玩家动作，
       * 回合照常推进（眩晕的应有语义，引擎不改）。输入同样取战斗镜像状态列表。
       */
      canAct: !controlOf(battle.player.statuses, "cannot_act", lookup),
    },
    enemies: battle.enemies.map(combatantView),
    allies: battle.allies.map(combatantView),
    /** ADR-012 D5：第三方。旧前端可忽略（契约给了 `default([])`）。 */
    // 旧现场（测试夹具 / 旧档直读）可能没有这个字段：按空数组处理，不在这里崩。
    neutrals: (battle.neutrals ?? []).map(combatantView),
    /**
     * 已退场名册只列**英雄档**（2026-11-20 用户裁决）。
     *
     * 杂兵是兵力：夏油一场献祭三只，名册就多三张 108/108 的卡片，
     * 把「谁真的没了」这唯一有用的信息淹掉。杂兵的去向战报里已经有一行
     * 「XX 被献祭了」，不需要在面板上再立碑。
     *
     * 英雄档保留：玉犬 / 魔虚罗这类是本局不可再召的损失，玩家需要知道**为什么**没了
     * （被献祭 / 召唤者倒下 / 生命耗尽）。
     */
    fallen: (battle.fallen ?? []).filter((u) => u.tier === "hero").map(combatantView),
    log: battle.log.slice(-30),
  };
}
