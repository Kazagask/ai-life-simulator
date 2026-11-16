import type {
  BattleView,
  EndingTemplate,
  EndingView,
  EvaluationRecord,
  TerminationRecord,
  V2Snapshot,
  WorldRunStatus,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { moodBand, maxHp, maxMp } from "./engine.js";
import { birthTimeFromAge, createTimeAdapter } from "./time.js";
import type { TemplateLookup } from "./lookup.js";
import { slotEventView } from "./turn.js";
import { controlOf } from "./battle.js";
import { isKinshipKind, kinshipTerm, projectVisibleRelations } from "./relations.js";
import { actorName, buildActorDirectory } from "./actors.js";

/**
 * V2 投影：hidden 信息不外泄；
 * 补正仅 visibility=known 可见；敌人 combatHints 与 secrets 永不出现。
 */
export function projectSnapshotV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  /** 评价唯一事实来源（v2/life-evaluation.ts）；未提供时用中性占位文案 */
  evaluation?: EvaluationRecord | null,
  /** 结局模板集（endings.yaml）；未提供时只投影终止事实、结局文案用中性兜底 */
  endings?: readonly EndingTemplate[],
): V2Snapshot {
  const player = state.player;
  const genderLabel = lookup.genderLabel(player.gender);
  const adapter = createTimeAdapter(template);
  const lifeStage = adapter.resolveLifeStage(player.age);
  const status: WorldRunStatus =
    state.archived === true ? "archived" : state.termination !== null ? "terminated" : "running";
  const ended = status !== "running";

  // R2.6 / ADR-0014：只投影 known / inferred 边。
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
   * 关系面：**只按边自身的可见性收敛**（known / inferred），与「有没有 NPC 卡」无关。
   *
   * 为什么解耦（2026-11-16 用户裁决 B-2）：关系是**独立事实** ——
   * 你可能完全不认识伏黑甚尔（没有他的 NPC 卡），但你知道"惠有个父亲"。
   * 旧实现要求两端都在可见子图里，于是指向敌人/未登场者的边被整条带走，
   * 这类关系永远显示不出来。解耦后关系能否上屏只由**边自己**说了算：
   * 模板写 `visibility: known` 就是"玩家知道这条关系"，引擎不再二次猜测。
   *
   * 想让某条关系等对方登场后才可见：把它声明成 `unknown`，进场时用效果翻成 known。
   * 端点有没有卡由 `counterpartVisible` 表达，名字由 `withName` 直接给全 ——
   * 前端因此不需要在"没有卡"的情况下反查人名。
   *
   * ⚠ 已知限制（本期接受）：敌人不实例化，所以**从敌人侧出边**没有落点 ——
   * 关系行只挂在 NPC 卡上，而卡片只来自 `state.npcs`。要让「敌人 → 某人」也上屏，
   * 得等 A 期真的把关系行提升为独立于卡片的一等投影项。
   */
  const observableRelations = projectVisibleRelations(state.relations);
  /** 关系行里的人名解析：实例 → 模板（敌人没有实例但有名字）→ 玩家。 */
  const actorDirectory = buildActorDirectory(state, template);

  const statuses = player.statuses
    .map((inst) => {
      const def = lookup.status(inst.statusId);
      return def && def.visibility === "known"
        ? { id: def.id, name: def.name, stacks: inst.stacks }
        : null;
    })
    .filter((s): s is { id: string; name: string; stacks: number } => s !== null);

  const skills = player.skills.map((id) => {
    const def = lookup.skill(id);
    return {
      id,
      name: def?.name ?? id,
      description: def?.description ?? "",
      kind: def?.kind ?? "general",
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
        // 展示字段（T5-02 / R-EQ-09）：不含任何补正结果——补正只进 effectiveAttributes（P8）
        type: def?.type ?? "key",
        slot: def?.slot,
        slotLabel: template.equipment?.slots?.find((s) => s.id === def?.slot)?.label,
        category: def?.category,
        quality: def?.quality,
      };
    });

  const battle = state.battle ? battleView(state, lookup, template) : null;
  // 战斗进行中时 HP/MP 以战斗镜像为准（战斗消耗实时反映到状态栏；结束后 finishBattle 已回写，两者一致）
  const shownHp = battle && !battle.over ? battle.player.hp : player.hp;
  const shownMp = battle && !battle.over ? battle.player.mp : player.mp;

  return {
    worldId: state.id,
    templateId: state.templateId,
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
      resources: { hp: lookup.resourceLabel("hp"), mp: lookup.resourceLabel("mp") },
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
      statuses,
      skills,
      inventory,
      // 装备实例：只下发展示字段；补正结果不入投影（R-EQ-04 / P8）
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
          quality: def?.quality,
        };
      }),
    },
    // 槽位定义（R-EQ-11 / R-EQ-15）：个数、格数与摆位全部来自模板，前端不猜
    equipmentSlots: (template.equipment?.slots ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      maxCount: s.maxCount,
      allowedCategories: [...s.allowedCategories],
      panelSide: s.panelSide ?? "bottom",
    })),
    // ADR-0022：unspawned（尚未出生/登场）的角色不上屏——实例存在是为了让模板能用
    // `npcState` 条件判断「还没出生」，但它不该出现在人物列表里。
    // 与关系边/称谓子图同源（ADR-0022 补记 D-1）：三处共用 `hiddenNodeIds`。
    npcs: state.npcs
      .filter((npc) => !hiddenNodeIds.has(npc.id))
      .map((npc) => {
      // ADR-0019：NPC 面板需要「状态 / 生命周期」两块。口径与玩家一致——
      // 补正只透 visibility=known（hidden/unknown 不外泄），阶段由年龄按模板阶段表推导。
      //
      // ADR-0021 决策 4.1：年龄**投影期现算**（`ageAt(birthTime, worldTime)`，年差口径=
      // 跨年界即 +1），不回写 `state.npcs[].age`（那是起始年龄快照）。旧档缺 birthTime
      // ⇒ 按同一反推口径兜底，保证「加载即与原来一致，此后随世界时间增长」。
      //
      // P1-2 任务 C（ADR-0024 补遗）：**已故/被占据/未登场者的年龄冻结在 `sinceWorldTime`**。
      // 否则人物面板会出现「天内理子 · 已故 · 阵亡 · 26 岁」并且年年长岁——死人不会变老。
      // 用 lifecycle 作为单一判据（不新引入字段）：alive 走 worldTime，其余走 sinceWorldTime。
      // `lifeStage` / `lifeStageLabel` 都由下面这个 npcAge 派生 ⇒ 阶段也自动冻结，不另设基准。
      // 复活（回 alive）后自动恢复按 worldTime 增长，与状态机语义一致。
      const ageBasis = npc.lifecycle.state === "alive" ? state.worldTime : npc.lifecycle.sinceWorldTime;
      const npcAge = adapter.ageAt(
        npc.birthTime ?? birthTimeFromAge(npc.age, adapter),
        ageBasis,
      );
      const npcStage = adapter.resolveLifeStage(npcAge);
      return {
        id: npc.id,
        name: npc.name,
        age: npcAge,
        genderLabel: lookup.genderLabel(npc.gender),
        personality: npc.personality,
        relationship: npc.relationship,
        knownGoals: [...npc.knownGoals],
        attributes: projectNpcAttributes(npc.attributes, template),
        statuses: npc.statuses
          .map((inst) => {
            const def = lookup.status(inst.statusId);
            return def && def.visibility === "known"
              ? { id: def.id, name: def.name, stacks: inst.stacks }
              : null;
          })
          .filter((s): s is { id: string; name: string; stacks: number } => s !== null),
        lifeStage: npcStage,
        lifeStageLabel: adapter.lifeStageLabel(npcStage),
        // ADR-0020：生命周期与上屏解耦——inactive 照常上屏，只是带状态标注。
        // 旧档加载时 schema 已补默认 alive，故这里不必兜底。
        lifecycle: {
          state: npc.lifecycle.state,
          ...(npc.lifecycle.reasonCode !== undefined ? { reasonCode: npc.lifecycle.reasonCode } : {}),
          sinceTurn: npc.lifecycle.sinceTurn,
          sinceWorldTime: npc.lifecycle.sinceWorldTime,
        },
        // 行来源与下方称谓推导的边集是同一份 `observableRelations`（B-2 解耦后 =
        // 全部 known/inferred 边，不再按节点可见性剔除）——不得再引入第二份过滤口径，
        // 否则「卡片上写了这条关系、称谓却算不出来」这类自相矛盾会重新出现。
        relations: observableRelations
          .filter((e) => e.from === npc.id || e.to === npc.id)
          .map((e) => {
            const outgoing = e.from === npc.id;
            const withId = outgoing ? e.to : e.from;
            // 称谓只在「本体称呼对方」的有向亲属边上成立；反向边不强行反推称谓。
            // 入参是**完整**的 known/inferred 边集（2026-11-16 解耦后）：路径可以穿过
            // 未登场/隐藏的中间人 —— 你不需要认识他，也能知道"惠的父亲的兄弟是他叔叔"。
            // 仍不补「远亲」兜底（决策 4）：没边支撑就不该断言关系。
            const term =
              outgoing && isKinshipKind(e.kind)
                ? kinshipTerm(observableRelations, npc.id, withId)
                : null;
            return {
              withId,
              kind: e.kind,
              visibility: e.visibility,
              direction: outgoing ? ("out" as const) : ("in" as const),
              /**
               * 对方有没有 NPC 卡。`false` = 这条边指向一个未登场 / 不展示的角色
               * （比如敌人、或尚未露面的亲属）—— 关系是真的，但点不出卡片。
               * 前端据此显示「名字 + 未登场」，而不是假装有卡或干脆不显示这条边。
               */
              counterpartVisible: !hiddenNodeIds.has(withId),
              /** 对方名字（隐藏/未登场/敌人都有；前端不再需要在无卡时反查） */
              withName: actorName(actorDirectory, withId),
              ...(e.value !== undefined ? { value: e.value } : {}),
              ...(term ? { kinshipTerm: term.term } : {}),
            };
          }),
        };
      }),
    // ADR-0034 §5：投影只给"当前在演什么"（`slotEvent`），不投影队列内容与长度。
    // **唯一真源**：过渡字段 `pendingEvent` / `activeChains` 已在前端切换（`c693814`）后删除，
    // 现存消费方一律读本字段；顺带消除 ADR §12-5 记的"投影重复求值"（旧实现为
    // `pendingEvent` 再调一次 `slotEventView`，同一场景算两遍）。
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
}

/**
 * NPC 属性下发（ADR-0021 决策 3）：
 * - 键集 = `template.attributes.order`（顺序无关地相等），order 外的键**一律不透**
 *   ——否则玩家侧的 `proficiency*` 之类内部/派生键会变成新的 API 面；
 * - 值 = 实例层的模板 base 原值（`turn.ts` 建实例时从 `characters[].attributes` 拷入）；
 *   order 内但 NPC 未声明的键给 0，与玩家面板取值口径一致；
 * - order 为空 ⇒ `{}`（不是缺省 undefined，前端直接遍历）。
 * 这里**不做** effective 派生：补正过滤后算出的数与战斗实算必不一致，
 * 不过滤则成 hidden 侧信道（ADR-0019 红线），二者不可兼得。
 */
function projectNpcAttributes(
  attributes: Record<string, number>,
  template: WorldTemplateV2,
): Record<string, number> {
  const out: Record<string, number> = {};
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

function battleView(state: WorldStateV2, lookup: TemplateLookup, template: WorldTemplateV2): BattleView {
  const battle = state.battle!;
  const statusViews = (instances: Array<{ statusId: string; stacks: number }>) =>
    instances
      .map((inst) => {
        const def = lookup.status(inst.statusId);
        return def && def.visibility === "known"
          ? { id: def.id, name: def.name, stacks: inst.stacks }
          : null;
      })
      .filter((s): s is { id: string; name: string; stacks: number } => s !== null);

  const battleStatuses = statusViews(battle.player.statuses);
  const worldStatuses = statusViews(state.player.statuses);
  const allStatuses = [...battleStatuses];
  for (const s of worldStatuses) {
    if (!allStatuses.some((x) => x.id === s.id)) allStatuses.push(s);
  }

  return {
    eventId: battle.eventId,
    round: battle.round,
    over: battle.over,
    player: {
      hp: battle.player.hp,
      maxHp: maxHp(state.player, template),
      mp: battle.player.mp,
      maxMp: maxMp(state.player, template),
      statuses: allStatuses,
      skills: state.player.skills
        .map((id) => lookup.skill(id))
        .filter((s) => s?.kind === "combat")
        .map((s) => {
          const combat = s as Extract<NonNullable<typeof s>, { kind: "combat" }>;
          return {
            id: combat.id,
            name: combat.name,
            description: combat.description ?? "",
            costMp: combat.cost.mp,
            cooldownLeft: battle.player.skillCooldowns[combat.id] ?? 0,
          };
        }),
      items: Object.entries(state.player.inventory)
        .filter(([itemId, count]) => count > 0 && lookup.item(itemId)?.usableInBattle)
        .map(([itemId, count]) => ({ itemId, name: lookup.item(itemId)?.name ?? itemId, count })),
      /**
       * D-12：逃跑可用性 = settle 声明**与**未被 cannot_flee 补正压制（与引擎判定同源）。
       * 引擎侧顺序是 `!settle.canFlee ⇒ flee_not_allowed`、`controlOf(...cannot_flee) ⇒ cannot_flee`，
       * 两者都通过才真能逃 ⇒ 投影取 AND，判定函数复用 battle.ts 的 controlOf。
       */
      canFlee: (battle.settle.canFlee ?? false) && !controlOf(battle.player.statuses, "cannot_flee", lookup),
      /**
       * D-08：与引擎同一判定（battle.ts 的 controlOf），输入取**战斗镜像**的补正列表
       * —— 这正是 performBattleAction 检查 `pc.statuses` 的来源，二者不会漂移。
       */
      canUseItems: !controlOf(battle.player.statuses, "cannot_use_items", lookup),
      /**
       * D-13：与引擎同一分支同源 —— performBattleAction 的第一步就是
       * `controlOf(pc.statuses, "cannot_act")`，为真时**不抛错**、只记日志并跳过玩家动作，
       * 回合照常推进（眩晕的应有语义，引擎不改）。输入同样取战斗镜像补正列表。
       */
      canAct: !controlOf(battle.player.statuses, "cannot_act", lookup),
    },
    enemies: battle.enemies.map((e) => ({
      instanceId: e.instanceId,
      name: e.name,
      hp: Math.max(0, e.hp),
      maxHp: e.maxHp,
      alive: e.alive,
      statuses: statusViews(e.statuses),
    })),
    allies: battle.allies.map((a) => ({
      instanceId: a.instanceId,
      name: a.name,
      hp: Math.max(0, a.hp),
      maxHp: a.maxHp,
      alive: a.alive,
      statuses: statusViews(a.statuses),
    })),
    log: battle.log.slice(-30),
  };
}
