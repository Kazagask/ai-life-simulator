import type {
  ActionVM,
  BattleVM,
  ContentBlockVM,
  EvaluationVM,
  MediaVM,
  NpcVM,
  PlayerVM,
  V2Snapshot,
  ViewModel,
  WheelResultView,
  WheelVM,
} from "@life-sim/shared";
import { isVisualSlot } from "./slots.js";

/**
 * 快照 → 视图模型的**纯适配器**（本包唯一允许接触引擎快照的模块）。
 *
 * 为什么只有这里能 import `V2Snapshot`：`@life-sim/rpg-ui` 的组件必须只吃 `ViewModel`，
 * 自定义前端才能在不引入引擎类型的前提下复用组件；引擎字段改名时，需要改的只有本文件。
 * `src/components.min.test.ts` 里有一条源码守卫（source guard）会扫描本目录，
 * 除本文件外不得出现 `V2Snapshot`。
 *
 * 纯函数：不读时间、不读全局、不 mutate 入参。
 */

/** 适配器入参：快照是必填，叙事正文与媒体可以由调用方另行拼装（例如从 trace 读回的正文）。 */
export interface ToViewModelInput {
  snapshot: V2Snapshot;
  /** 从 `GET /api/worlds/:id/narrative` 等来源拿到的内容块；缺省为空。 */
  content?: ContentBlockVM[];
  /** 显式覆盖媒体列表；缺省用 `snapshot.media`。 */
  media?: MediaVM[];
}

/**
 * 转盘结果 → 展示模型（只搬展示需要的字段：命中标签 + 全扇区权重）。
 * `title` 不在这里：它来自事件槽（`slot.title`），由宿主与 wheel 配对传入。
 */
export function toWheelVM(wheel: WheelResultView): WheelVM {
  return {
    eventId: wheel.eventId,
    label: wheel.label,
    segments: wheel.segments.map((s) => ({ label: s.label, weight: s.weight })),
  };
}

/** 战斗镜像 → 展示模型（`id` 取引擎实例 id，只作 React key / 目标标识）。 */
export function toBattleVM(battle: NonNullable<V2Snapshot["battle"]>): BattleVM {
  const statuses = (list: Array<{ id: string; name: string; stacks: number }>) =>
    list.map((s) => ({ id: s.id, name: s.name, stacks: s.stacks }));
  return {
    round: battle.round,
    over: battle.over,
    player: {
      hp: battle.player.hp,
      maxHp: battle.player.maxHp,
      mp: battle.player.mp,
      maxMp: battle.player.maxMp,
      // 控制判定的结论与「为什么」都由投影层下发，展示层不自己查补正表（D-08 / D-12 / D-13）。
      statuses: statuses(battle.player.statuses),
      skills: battle.player.skills.map((s) => ({
        id: s.id,
        name: s.name,
        costMp: s.costMp,
        cooldownLeft: s.cooldownLeft,
      })),
      items: battle.player.items.map((i) => ({ itemId: i.itemId, name: i.name, count: i.count })),
      canAct: battle.player.canAct,
      canUseItems: battle.player.canUseItems,
      canFlee: battle.player.canFlee,
    },
    enemies: battle.enemies.map((e) => ({
      id: e.instanceId,
      name: e.name,
      hp: e.hp,
      maxHp: e.maxHp,
      alive: e.alive,
      statuses: statuses(e.statuses),
    })),
    allies: battle.allies.map((a) => ({
      id: a.instanceId,
      name: a.name,
      hp: a.hp,
      maxHp: a.maxHp,
      alive: a.alive,
      statuses: statuses(a.statuses),
    })),
    log: [...battle.log],
  };
}

/**
 * 资源告警阈值：剩余比例 ≤ 25% 视为危险。
 *
 * 阈值判定属于**投影口径**（和引擎面板同一处算，展示层不该各写一遍），
 * 所以只在适配器里算一次，`StatusBars` 只认 `tone` 上色。
 */
export const DANGER_RATIO = 0.25;

function toneOf(value: number, max: number): "normal" | "danger" {
  return value / Math.max(1, max) <= DANGER_RATIO ? "danger" : "normal";
}

/**
 * 资源条派生：值取玩家当前 hp/mp，**标签取模板 `labels.resources`**（缺省才回退 "HP"/"MP"）。
 * `max` 归一为 ≥1，避免除零；不派生心情条（模板的心情是 0-100 的软量，不属于资源）。
 */
function deriveStatusBar(snapshot: V2Snapshot): ViewModel["statusBar"] {
  const labels = snapshot.labels.resources;
  const p = snapshot.player;
  const hpMax = Math.max(1, p.maxHp);
  const mpMax = Math.max(1, p.maxMp);
  return [
    { key: "hp", label: labels.hp ?? "HP", value: p.hp, max: hpMax, tone: toneOf(p.hp, hpMax) },
    { key: "mp", label: labels.mp ?? "MP", value: p.mp, max: mpMax, tone: toneOf(p.mp, mpMax) },
  ];
}

/** 可执行动作：只搬运展示字段，丢掉时长等规则字段（展示层不需要）。 */
function toActions(snapshot: V2Snapshot): ActionVM[] {
  return snapshot.availableActions.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
  }));
}

/**
 * 内联 CG 解析：返回**唯一一条允许在叙事流里内联上屏**的 asset 块。
 *
 * 判据三件套，缺一不可，且**只在这里实现一次**（叙事流与宿主抑制横幅都调它，
 * 两套判据曾经不一致，先后出过两次「横幅没了、流里也跳过」的黑场）：
 *  ① `kind === "asset"` 且 `assetId` 非空；
 *  ② 能在本轮 media 里找到该资源，且 `url` 非空（空 url 的条目渲染不出图）；
 *  ③ 该资源的槽位是**画面槽**（`cg*` / `scene*`）—— 立绘归立绘排、道具图标归别处，
 *     只有画面槽允许内联，否则「第一个能解析的 asset 块」可能是立绘，把真正的 CG 块挤掉。
 *     判定见 `./slots.ts` `isVisualSlot`（`scene` 不能漏：引擎内联块就用这个槽）。
 *     横幅口径更窄（只认 `cg*`，见 `CgStage`）：`scene*` 只由块指名后内联。
 *
 * `url` 为空的内联块一律不渲染：宁可少一张图，也不留一条破图色带。
 */
export function firstInlineCgBlock(
  view: Pick<ViewModel, "content" | "media">,
): ContentBlockVM | undefined {
  return view.content.find((block) => {
    if (block.kind !== "asset" || block.assetId === undefined || block.assetId === "") return false;
    const hit = view.media.find((item) => item.assetId === block.assetId);
    return hit !== undefined && hit.url !== "" && isVisualSlot(hit.slot);
  });
}

// ---------- NPC 卡投影 ----------

/**
 * 关系种类词表（内核词汇 → 中文）。放在适配器而不是组件里：这是**数据**不是排版，
 * 换语言/换主题只该改一处，自定义前端不该各自维护一份。
 */
const RELATION_KIND_LABEL: Record<string, string> = {
  father: "父亲",
  mother: "母亲",
  son: "儿子",
  daughter: "女儿",
  husband: "丈夫",
  wife: "妻子",
  "elder-brother": "兄长",
  "younger-brother": "弟弟",
  "elder-sister": "姐姐",
  "younger-sister": "妹妹",
  relative: "亲戚",
  mentor: "师父",
  disciple: "弟子",
  friend: "朋友",
  rival: "对手",
  enemy: "敌手",
  colleague: "同僚",
};

const RELATION_VISIBILITY_LABEL: Record<string, string> = {
  known: "确知",
  inferred: "推断",
};

/**
 * 关系行行首的称谓标签。
 *
 * **事实行**按 `kind` 翻译：一级边的 `kind` 本身就是准的（`father` → 父亲），不需要替换。
 *
 * **派生行**（多跳亲缘，投影里 `derived: true`）的 `kind` 恒为占位的 `"relative"` ——
 * 照 kind 翻会把爷爷、外婆统统显示成「亲戚」。所以派生行以扩展推出来的 `kinshipTerm`
 * 作主标签（「爷爷」），只有连称谓都推不出来时才回落到 kind 词（「亲戚」）。
 * 组件侧不会再重复画一遍同名词（见 `RelationList`）。
 */
function relationKindLabel(rel: {
  readonly kind: string;
  readonly derived?: boolean;
  readonly kinshipTerm?: string;
}): string {
  if (rel.derived === true && rel.kinshipTerm !== undefined && rel.kinshipTerm !== "") {
    return rel.kinshipTerm;
  }
  return RELATION_KIND_LABEL[rel.kind] ?? rel.kind;
}

/**
 * 生命周期三态（ADR-0012 / ADR-0020）只是 `reasonCode` 缺失时的**兜底**文案。
 * `inactive` 的兜底必须中性写「已离场」：「已故」「失联」都是在替模板猜具体死因，
 * 而模板可能表达的是叛逃、被封印、转学离开……真正的原因由 `reasonCode` 原样下发。
 */
const NPC_LIFECYCLE_LABEL: Record<string, string> = {
  alive: "在世",
  inactive: "已离场",
  unspawned: "尚未登场",
};

/**
 * 生命周期文案（ADR-0021 / T3）：`reasonCode` 存在且 trim 后非空时**只显示原因**，
 * 否则回退状态词。顶部芯片与「生命周期」区块共用这一份，保证两处永远一致。
 *
 * 必须 trim 判空：模板 schema 对 `reasonCode` 只约束 `min(1)`，`" "`（单个空格）是合法值，
 * 用真值判断会渲染出一个近乎空白的胶囊且不回退（QA D-3）。
 */
function lifecycleText(state: string, reasonCode?: string): string {
  const code = reasonCode?.trim();
  if (code !== undefined && code !== "") return code;
  return NPC_LIFECYCLE_LABEL[state] ?? state;
}

/**
 * NPC 卡投影。
 *
 * 三处口径都在这里定死，不让前端各抄一份：
 *  - 属性顺序 = 模板 `attributes.order`（`labels.attributes` 的键序），标签回填；
 *  - 关系**只给 out 边**（「这个人怎么看别人」），双向渲染等于把同一句话写两遍，
 *    而且「A 视 B 为远亲 ≠ B 视 A 为远亲」的不对称语义会打架（2026-11-16 用户裁决）；
 *  - `withName` 在这里解析成显示名（玩家 → 「你」），组件不再需要名字表。
 */
function toNpcVM(snapshot: V2Snapshot, npc: V2Snapshot["npcs"][number]): NpcVM {
  const attrLabels = snapshot.labels.attributes;
  const nameOf = (id: string): string => {
    if (id === "player") return "你";
    const hit = snapshot.npcs.find((n) => n.id === id);
    return hit?.name ?? id;
  };
  return {
    id: npc.id,
    name: npc.name,
    age: npc.age,
    genderLabel: npc.genderLabel,
    lifeStageLabel: npc.lifeStageLabel,
    relationship: npc.relationship,
    personality: npc.personality,
    knownGoals: [...npc.knownGoals],
    statuses: npc.statuses.map((s) => ({ id: s.id, name: s.name, stacks: s.stacks })),
    attributes: Object.entries(npc.attributes)
      // 顺序即模板 attributes.order：投影已按 order 构造，这里不重排、不过滤（0 是有效值）。
      .map(([key, value]) => ({ key, label: attrLabels[key] ?? key, value: Number(value) })),
    alive: npc.lifecycle.state === "alive",
    lifeState: npc.lifecycle.state,
    lifeText: lifecycleText(npc.lifecycle.state, npc.lifecycle.reasonCode),
    relations: npc.relations
      .filter((rel) => rel.direction === "out")
      .map((rel) => {
        return {
        withId: rel.withId,
        withName: rel.withName ?? nameOf(rel.withId),
        kind: rel.kind,
        kindLabel: relationKindLabel(rel),
        visibility: rel.visibility,
        visibilityLabel: RELATION_VISIBILITY_LABEL[rel.visibility] ?? rel.visibility,
        ...(rel.value !== undefined ? { value: rel.value } : {}),
        ...(rel.kinshipTerm !== undefined ? { kinshipTerm: rel.kinshipTerm } : {}),
        ...(rel.kinshipTerms !== undefined ? { kinshipTerms: [...rel.kinshipTerms] } : {}),
        ...(rel.counterpartVisible !== undefined ? { counterpartVisible: rel.counterpartVisible } : {}),
        };
      }),
  };
}

/**
 * 玩家卡投影：属性条的顺序与「哪些属性不算属性」都是**投影口径**，在这里一次算清，
 * 不然每个自定义前端都要各自抄一遍 `labels.attributes` 的排序和 `proficiency*` 过滤。
 */
function toPlayerVM(snapshot: V2Snapshot): PlayerVM {
  const p = snapshot.player;
  const labels = snapshot.labels;
  const order = Object.keys(labels.attributes);
  const rank = (key: string): number => {
    const idx = order.indexOf(key);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  return {
    id: p.id,
    name: p.name,
    age: p.age,
    genderLabel: p.genderLabel,
    hp: p.hp,
    maxHp: p.maxHp,
    mp: p.mp,
    maxMp: p.maxMp,
    mood: p.mood,
    moodBandLabel: p.moodBandLabel,
    // 标签缺省回填放在这里：`labels.resources.hp ?? "hp"` 是旧前端的兜底，展示层不该各抄一份。
    labels: {
      hp: labels.resources.hp ?? "hp",
      mp: labels.resources.mp ?? "mp",
      mood: labels.mood,
    },
    attributes: Object.entries(p.attributes)
      // 熟练度（`proficiency*`）是派生键，不算面板上的属性条（与既有视觉一致）。
      .filter(([key]) => !key.startsWith("proficiency"))
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([key, value]) => ({ key, label: labels.attributes[key] ?? key, value: Number(value) })),
    statuses: p.statuses.map((s) => ({
      id: s.id,
      name: s.name,
      stacks: s.stacks,
      ...(s.description !== undefined ? { description: s.description } : {}),
      ...(s.quality !== undefined ? { quality: s.quality } : {}),
      ...(s.style !== undefined ? { style: s.style } : {}),
      ...(s.effects !== undefined ? { effects: s.effects } : {}),
      ...(s.durationLabel !== undefined ? { durationLabel: s.durationLabel } : {}),
    })),
    // 模板没给阶段文案时投影会回退成 id（「adulthood」）；这里把这种情况抹成空串，
    // 展示层据此不渲染 —— 内部 id 不该出现在界面上（RPA ui-2-personal.png）。
    lifeStage: snapshot.lifeStage,
    lifeStageLabel: snapshot.lifeStageLabel === snapshot.lifeStage ? "" : snapshot.lifeStageLabel,
    equipment: (p.equipment ?? []).map((e) => ({
      instanceId: e.instanceId,
      itemId: e.itemId,
      slot: e.slot,
      ...(e.slotLabel !== undefined ? { slotLabel: e.slotLabel } : {}),
      ...(e.stacks !== undefined ? { stacks: e.stacks } : {}),
      ...(e.durability !== undefined ? { durability: e.durability } : {}),
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.description !== undefined ? { description: e.description } : {}),
      ...(e.category !== undefined ? { category: e.category } : {}),
      ...(e.quality !== undefined ? { quality: e.quality } : {}),
      ...(e.style !== undefined ? { style: e.style } : {}),
      ...(e.effects !== undefined ? { effects: e.effects } : {}),
    })),
    inventory: p.inventory.map((i) => ({
      itemId: i.itemId,
      name: i.name,
      description: i.description,
      count: i.count,
      usableOutsideBattle: i.usableOutsideBattle,
      usableInBattle: i.usableInBattle,
      type: i.type,
      ...(i.slot !== undefined ? { slot: i.slot } : {}),
      ...(i.slotLabel !== undefined ? { slotLabel: i.slotLabel } : {}),
      ...(i.category !== undefined ? { category: i.category } : {}),
      ...(i.quality !== undefined ? { quality: i.quality } : {}),
      ...(i.style !== undefined ? { style: i.style } : {}),
      ...(i.effects !== undefined ? { effects: i.effects } : {}),
    })),
    skills: p.skills.map((sk) => ({
      id: sk.id,
      name: sk.name,
      description: sk.description,
      kind: sk.kind,
      ...(sk.quality !== undefined ? { quality: sk.quality } : {}),
      ...(sk.style !== undefined ? { style: sk.style } : {}),
      ...(sk.effects !== undefined ? { effects: sk.effects } : {}),
    })),
  };
}

/** 评价投影：`ended` 是「盖棺」判据（跑动中分项整块不渲染），由适配器算好交给展示层。 */
function toEvaluationVM(snapshot: V2Snapshot): EvaluationVM {
  const ev = snapshot.evaluation;
  const ended = snapshot.status === "terminated" || snapshot.status === "archived";
  return {
    summary: ev.summary,
    ...(ev.dimensions !== undefined
      ? {
          dimensions: ev.dimensions.map((d) => ({
            id: d.id,
            ...(d.label !== undefined ? { label: d.label } : {}),
            level: d.level,
            score: d.score,
            ...(d.explanation !== undefined ? { explanation: d.explanation } : {}),
          })),
        }
      : {}),
    ...(ev.overall !== undefined ? { overall: ev.overall } : {}),
    ...(ev.canonDeviation !== undefined ? { canonDeviation: ev.canonDeviation } : {}),
    ended,
  };
}

export function toViewModel({ snapshot, content, media }: ToViewModelInput): ViewModel {
  const slot = snapshot.slotEvent;
  return {
    player: toPlayerVM(snapshot),
    npcs: snapshot.npcs.map((n) => toNpcVM(snapshot, n)),
    slot:
      slot === null
        ? null
        : {
            eventId: slot.eventId,
            title: slot.title,
            narrative: slot.narrative,
            // 待决事件的选项：id 是引擎分配的真 optionId，前端只负责原样回传。
            ...(slot.options !== undefined
              ? { options: slot.options.map((o) => ({ id: o.id, text: o.text })) }
              : {}),
          },
    evaluation: toEvaluationVM(snapshot),
    media: media ?? snapshot.media ?? [],
    content: content ?? [],
    availableActions: toActions(snapshot),
    formattedTime: snapshot.formattedTime,
    lifeStage: snapshot.lifeStage,
    lifeStageLabel: snapshot.lifeStageLabel,
    ...(snapshot.storyChapter !== undefined ? { storyChapter: snapshot.storyChapter } : {}),
    statusBar: deriveStatusBar(snapshot),
    ...(snapshot.equipmentSlots !== undefined
      ? {
          equipmentSlots: snapshot.equipmentSlots.map((sl) => ({
            id: sl.id,
            label: sl.label,
            maxCount: sl.maxCount,
            allowedCategories: [...sl.allowedCategories],
            panelSide: sl.panelSide,
          })),
        }
      : {}),
    battle: snapshot.battle === null ? null : toBattleVM(snapshot.battle),
    ending:
      snapshot.ending === undefined || snapshot.ending === null
        ? null
        : { title: snapshot.ending.title, summary: snapshot.ending.summary },
    ...(snapshot.llmPending !== undefined ? { llmPending: snapshot.llmPending } : {}),
    turnIndex: snapshot.turnIndex,
    // 扩展命名空间：宿主只做**原样搬运**（`docs/EXTENSIONS.md` §7.1）——不解析、不映射、
    // 不校验；数据怎么解释是扩展自带 UI 的事（它只该看自己那一格）。
    ...(snapshot.extensions !== undefined ? { extensions: snapshot.extensions } : {}),
  };
}
