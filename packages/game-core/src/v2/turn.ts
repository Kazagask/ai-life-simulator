import type {
  AttributeValue,
  BattleCommand,
  CallLogEntry,
  ChooseOptionCommand,
  CombatSkill,
  Effect,
  EndingConfig,
  EquipmentInstance,
  EvaluationConfig,
  EventV2,
  HistoryEntryV2,
  HistoryVisibility,
  LlmBudget,
  LlmGateway,
  LlmTrace,
  LoreEntry,
  LoreRule,
  Perspective,
  RelationEdge,
  Rules,
  SlotEventView,
  TimeAmount,
  UseItemCommand,
  V2Snapshot,
  V2TurnResult,
  WheelResultView,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { PLAYER_ID, relationScopeOf } from "@life-sim/shared";
import {
  assignSlot,
  assignPendingInvocation,
  assignKnowledgeGrants,
  assignTriggerFireLedger,
  type ToolRegistry,
} from "../api/engine-api.js";
import {
  createConditionRegistry,
  evaluateTriggersEdge,
  type ConditionRegistry,
} from "./condition-evaluator.js";
import { computeKnowledgeGrants } from "./knowledge-grants.js";
import { collectExtensionConditions, resolveExtensionRuntimes } from "./extensions.js";
import { createRng, deriveTurnSeed, pickWeighted, type Rng } from "../rng.js";
import type { RunnerContext } from "./runner-context.js";
import { evaluateLifeV2 } from "./life-evaluation.js";
import { amountToMinutes, birthTimeFromAge, createTimeAdapter, minutesToAmount, UNIT_MINUTES } from "./time.js";
import {
  applyEffectsV2,
  checkAllConditions,
  checkCondition,
  computeMax,
  maxHp,
  maxMp,
  playerEffectiveAttributes,
  pruneExpiredStatuses,
  type ConditionContext,
  type EffectContextV2,
} from "./engine.js";
import { createBattle, createBattleRng, finishBattle, performBattleAction, resolveCombatRefs } from "./battle.js";
import { adjustResourceValue, initPlayerResources, resolveRegenAmount } from "./resources.js";
import { PLAYER_NODE_ID, addEdge, normalizeRelationEndpoint } from "./relations.js";
import { nextInstanceId } from "./equipment.js";
import { runNpcActionsV2 } from "./npc.js";
import type { TemplateLookup } from "./lookup.js";
import { projectSnapshotV2 } from "./projection.js";
import { playerVisibleHistory, pushHistory } from "./history.js";
import {
  checkEventPremise,
  enqueueCandidate,
  enqueueScheduled,
  hasFired,
  onCooldown,
  recordFire,
  scanDelayQueue,
  sortScheduled,
  specToMinutes,
  ZERO_SPEC,
} from "./scheduler.js";
import {
  applyDeathRoute,
  assertActive,
  createDefaultEndingConfig,
  terminateWithEnding,
  type TerminationSignal,
} from "./ending.js";

/**
 * 扫描 / 呈现前求值的**独立派生流**盐（ADR-0034 §3-5，沿用 ADR-0024 的 `seed + 37` 先例）。
 * 队列扫描会每轮对同一实例重复求值；若条件里写了 `random`，用主轮流会变成"每轮多扣一次骰"，
 * 污染主轮序列。独立盐 ⇒ 确定性不变、扫描成本不记到主轮账上。
 */
const SCAN_RNG_SALT = 37;

/** `nextTurn` 判定链的最大自旋次数（只防实现 bug 变成死循环；正常路径 1–3 圈）。 */
const MAX_NEXT_TURN_SPINS = 32;

// ---------- 创建世界 ----------

/**
 * self 选择（R-SELF-01 / ADR-001）：决定玩家"是谁"。
 *
 * - 省略 / `kind: "default"`：沿用 playerTemplate，self id = `"player"`（旧行为逐字段不变）。
 * - `kind: "reuse"`：扮演模板已声明的某个角色（如 `npc-gojo`）。**基本属性整组取自该角色**，
 *   self id = 该角色 id，该角色不再单独进 `state.npcs`（同一实体，不能有两份真相），
 *   关系边照常按角色声明生成。`input.playerName` 被忽略——名字就是角色名。
 * - `kind: "new"`：新建固定实例化的人物（不进 spawnRules），基本属性由调用方给。
 *
 * 附加属性（技能 / 道具 / 关系 / flag / 属性 add）由后续开局参数层叠加，这里只定基线。
 */
export type SelfSelectionV2 =
  | { kind?: "default" }
  | { kind: "reuse"; characterId: string }
  | { kind: "new"; id: string; name: string; gender: string; age: number; attributes: Record<string, AttributeValue>; skills?: string[] };

export function createWorldV2(
  input: { templateId: string; playerName?: string; seed?: number; self?: SelfSelectionV2 },
  template: WorldTemplateV2,
  worldId: string,
  ctx?: RunnerContext,
): WorldStateV2 {
  // 保持公开签名兼容：不传 ctx 时沿用原有默认；传入时用注入 rng 派生确定性 seed。
  const seed = input.seed ?? (ctx ? Math.floor(ctx.rng() * 0xffffffff) : Math.floor(Math.random() * 0xffffffff));
  const pt = template.playerTemplate;
  /** 物品表：给 NPC 实例化装备时取槽位（ADR-010 D3）。 */
  const itemById = new Map(template.items.map((it) => [it.id, it]));
  /**
   * self 的唯一 id（R-SELF-01）：`player.id`、关系边端点、`state.selfId` 全用它。
   * 默认 "player"（旧档逐字段不变）；reuse 指向模板角色 id；new 用调用方给的 id。
   */
  const selection = input.self;
  let selfId = PLAYER_NODE_ID;
  let baselineName: string | undefined;
  let baselineGender: string | undefined;
  let baselineAge: number | undefined;
  let baselineAttributes: Record<string, AttributeValue> | undefined;
  let baselineSkills: string[] | undefined;
  /** 复用角色自带的状态（如某角色天生自带的特质）：不带上就不是「扮演这个人」。 */
  let baselineStatuses: string[] | undefined;
  let reusedCharacterId: string | undefined;
  if (selection?.kind === "reuse") {
    const c = template.characters.find((x) => x.id === selection.characterId);
    if (!c) throw new Error(`self_reuse_character_not_found: ${selection.characterId}`);
    if (c.isEnemy) throw new Error(`self_reuse_enemy_not_allowed: ${selection.characterId}`);
    selfId = c.id;
    reusedCharacterId = c.id;
    baselineName = c.identity.name;
    baselineGender = c.identity.gender;
    baselineAge = c.identity.age;
    baselineAttributes = { ...template.attributes.defaults, ...c.attributes };
    baselineSkills = [...(c.skills ?? [])];
    baselineStatuses = [...(c.statuses ?? [])];
  } else if (selection?.kind === "new") {
    selfId = selection.id;
    baselineName = selection.name;
    baselineGender = selection.gender;
    baselineAge = selection.age;
    baselineAttributes = { ...template.attributes.defaults, ...selection.attributes };
    baselineSkills = [...(selection.skills ?? [])];
  }
  const playerAge = baselineAge ?? pt?.identity.age ?? 16;
  const mood = pt?.mood ?? template.mood.defaultValue;
  // 初始装备（协议 §19 equipment.initialEquipment；槽位/类型/类别已由 Schema 加载期校验）。
  // 这是**独立的穿戴授予**，不从背包扣除（ADR-0008）：模板若同时在 playerTemplate.items
  // 写了同一 itemId，玩家得到「1 件穿戴 + 1 件备用」。卸下时按职业常规回流到背包。
  const initialEquipment: EquipmentInstance[] = [];
  for (const init of template.equipment?.initialEquipment ?? []) {
    const def = template.items.find((i) => i.id === init.itemId);
    if (!def || def.type !== "equipment" || !def.slot) continue;
    initialEquipment.push({
      instanceId: nextInstanceId(initialEquipment, init.itemId),
      itemId: init.itemId,
      ownerId: selfId,
      slot: def.slot,
    });
  }
  const player = {
    // 玩家节点 id 的唯一来源（R-SELF-01）：关系图端点、演员表、战斗镜像都用它。
    id: selfId,
    // reuse / new 用基线身份；default 沿用 playerName（可空 ⇒ "无名氏"）。
    name: baselineName ?? input.playerName ?? "无名氏",
    gender: baselineGender ?? pt?.identity.gender ?? template.genders[0]?.id ?? "",
    age: playerAge,
    // 玩家属性 = 世界 defaults 与基线的合并（后者覆盖前者）：
    // 模板作者只需写差异项，新增自定义属性不会因遗漏而取 0。
    attributes: baselineAttributes ?? { ...template.attributes.defaults, ...(pt?.attributes ?? {}) },
    hp: 0,
    mp: 0,
    mood,
    statuses: (baselineStatuses ?? []).map((id) => ({ statusId: id, stacks: 1, appliedTurn: 0, appliedAt: 0 })),
    skillCooldowns: {},
    inventory: {} as Record<string, number>,
    /** 自定义资源（ADR-003 D8）：建世界期由 `initPlayerResources` 按模板初始化。 */
    resources: {} as Record<string, number>,
    skills: [...(baselineSkills ?? pt?.skills ?? [])],
    growthLevel: 0,
    equipment: initialEquipment,
    // 玩家也有父/母指针（`extensions/family/doc/FAMILY-GRAPH.md` §3.1「玩家不是特例」）：
    // 缺省不写字段，保持旧模板的存档形状不变。
    ...(pt?.fatherId !== undefined ? { fatherId: pt.fatherId } : {}),
    ...(pt?.motherId !== undefined ? { motherId: pt.motherId } : {}),
  };
  // 历法适配器在建世界期就要用（广播 birthTime 反推 + 下方 schedule 窗口换算），故提前构造。
  // 纯函数、无副作用，位置变化不改变任何行为。
  const initCalendar = createTimeAdapter(template);
  // ADR-0022：配置层刷新规则 → 实例层队列。规则指向的角色在出生前不进世界（unspawned），
  // 由事件效果 spawnNpc 建出。实例只记引用，不复制配置域定义。
  const spawnRuleInstances = (template.npcSpawnRules ?? [])
    // 被 self 复用的角色不走刷新队列（它已是玩家实体，不能被 spawnNpc 再生成一份）。
    .filter((rule) => rule.characterRef !== reusedCharacterId)
    .map((rule) => ({
    ruleId: rule.id,
    characterRef: rule.characterRef,
    status: "pending" as const,
    spawnedTurn: 0,
    spawnedWorldTime: 0,
  }));
  const spawnRuleByCharacter = new Map(spawnRuleInstances.map((r) => [r.characterRef, r.ruleId]));
  /**
   * 指向 self 的声明边若带强度 ⇒ **折叠进 `npc.relationship` 标量**（ADR-017 D1）。
   *
   * 只在「复用某个角色当自己」（`as: npc-gojo`）时才会出现：模板写的
   * `{ to: npc-gojo, kind: disciple, value: 80 }`（夜蛾视五条为弟子）在「你就是五条」这一局
   * 里就是「夜蛾视**你**为弟子，强度 80」。以前这条 value 留在边上，而卡片 chip 读的是
   * `npc-yaga.relationship`（8）—— 同一件事两个数。
   *
   * 覆盖顺序 = 声明顺序（后者胜），与 `resolveParamMap` 同口径。
   */
  const foldedToSelf = new Map<string, number>();
  for (const c of template.characters) {
    for (const r of c.relations ?? []) {
      if (r.value !== undefined && normalizeRelationEndpoint(r.to, selfId) === selfId) {
        foldedToSelf.set(c.id, r.value);
      }
    }
  }
  const state: WorldStateV2 = {
    id: worldId,
    templateId: template.meta.id,
    seed,
    turnIndex: 0,
    worldTime: 0,
    playerAgeAtStart: playerAge,
    player,
    /** 玩家在演员表 / 关系图里的节点 id（A 期 seam；缺省回落同值，见 `selfIdOf`）。 */
    selfId,
    // 敌人不实例化：它只是战斗事件的 `enemies[].ref` 目标，不进实例表、不跑自主行动、
    // 不上 NPC 卡。跨敌我的关系边因此不能靠实例解析，改由关系投影单独处理。
    npcs: template.characters
      // R-SELF-01：被扮演的角色**不另建 NPC 实例**——它与玩家是同一个实体，
      // 再建一份就会出现"两个同一个人"（属性各写各的、投影打架）。关系边不受影响。
      .filter((c) => !c.isEnemy && c.id !== reusedCharacterId)
      .map((c) => ({
        id: c.id,
        name: c.identity.name,
        gender: c.identity.gender,
        // ADR-0021 决策 4.1：age 降级为「起始年龄快照」，仅供 birthTime 反推兜底与旧档兼容
        age: c.identity.age,
        // 出生分钟由起始年龄按整年回溯（negative 分钟，ADR-0021 决策 4.3 已支持）；
        // 此后「当前年龄」由投影按 ageAt(birthTime, worldTime) 现算，不再回写 age。
        birthTime: birthTimeFromAge(c.identity.age, initCalendar),
        attributes: { ...c.attributes },
        hp: 1,
        mp: 1,
        mood: c.mood.value,
        statuses: (c.statuses ?? []).map((id) => ({ statusId: id, stacks: 1, appliedTurn: 0, appliedAt: 0 })),
        skillCooldowns: {},
        inventory: {},
        skills: [...(c.skills ?? [])],
        // ADR-010 D3：模板声明的装备转成实例（ownerId = 角色自身，槽位取物品声明）。
        ...(c.equipment?.length
          ? {
              equipment: c.equipment.map((itemId, idx) => ({
                instanceId: `${c.id}#eq${idx + 1}`,
                itemId,
                ownerId: c.id,
                slot: itemById.get(itemId)?.slot ?? "weapon",
              })),
            }
          : {}),
        relationship: c.relationship,
        personality: c.public.personality ?? "",
        knownGoals: [...(c.public.knownGoals ?? [])],
        goals: [...(c.private.goals ?? [])],
        traits: [...(c.private.traits ?? [])],
        knowledge: [...(c.private.knowledge ?? [])],
        secrets: [...(c.private.secrets ?? [])],
        lastActedAtTurn: 0,
        isEnemy: false,
        // 展示门：决定"玩家的人物列表里有没有他"。只影响上屏，不影响实例存在与参与规则。
        visibility: c.visibility,
        // ADR-0022：由刷新规则管辖的角色，世界创建时处于 unspawned（尚未出生/登场）
        ...(spawnRuleByCharacter.has(c.id) ? { spawnRuleId: spawnRuleByCharacter.get(c.id) } : {}),
        // `extensions/family/doc/FAMILY-GRAPH.md` §3.1：父/母指针原样复制（缺省不写字段，保持旧模板存档形状不变）。
        // **本轮不参与推导**：亲缘仍由 family 扩展从关系边算，这里只把值传下去。
        ...(c.fatherId !== undefined ? { fatherId: c.fatherId } : {}),
        ...(c.motherId !== undefined ? { motherId: c.motherId } : {}),
        // ADR-0012 决策 1 / ADR-0020：缺省在世；模板可在 characters[].lifecycle 声明初始态
        lifecycle: {
          state: spawnRuleByCharacter.has(c.id) ? "unspawned" : (c.lifecycle?.state ?? "alive"),
          ...(c.lifecycle?.reasonCode ? { reasonCode: c.lifecycle.reasonCode } : {}),
          sinceTurn: 0,
          sinceWorldTime: 0,
        },
      })),
    // ADR-0022：规则实例队列 + 空的出生事实（append-only，只由 spawnNpc 追加）
    spawnRules: spawnRuleInstances,
    spawnLog: [],
    // ADR-007 D1：时间表的执行记录（世界创建时为空，之后由 turn tail 追加）。
    facts: [],
    // R2.6 / ADR-0014：初始关系边由 characters[].relations 声明（from=该角色）。
    // 知情人范围由 `scope` 声明（ADR-007 D3；旧模板的 `visibility` 折算成 scope）。
    // npc.relationship 标量保留为独立兼容字段，不自动生成关系边。
    //
    // A 期：模板侧写的是 `to: player`（`PLAYER_ID`），落库时统一换成 `selfId` ——
    // 关系图的端点从此只有一个真源，将来 `selfId` 指向实例时图数据不需要迁移。
    relations: [
      ...template.characters.flatMap((c) =>
        (c.relations ?? []).map((r) => {
          const to = normalizeRelationEndpoint(r.to, selfId);
          return {
            from: c.id,
            to,
            kind: r.kind,
            source: "template" as const,
            scope: r.scope ?? relationScopeOf(r),
            ...(r.knownBy !== undefined ? { knownBy: [...r.knownBy] } : {}),
            /**
             * ADR-017 D1：**指向 self 的边不带强度**。
             *
             * 「某人视你为 X」的强度只有一个家 —— `npc.relationship` 标量。
             * 边再带一份 `value` 就必然分叉（事件改一个、另一个原地不动）。
             * 模板本来的写法就是 `{ to: player, kind: disciple }` 不写 value
             * （见 `characters.yaml` 头部注释）；这里把「写错了也照单全收」这条路堵掉，
             * 加载期另有一条 error 拦在 `schema/world.ts`。
             */
            ...(r.value !== undefined && to !== selfId ? { value: r.value } : {}),
            ...(r.gap !== undefined ? { gap: r.gap } : {}),
          };
        }),
      ),
      /**
       * ADR-017 D2：玩家自己这边的关系边（`playerTemplate.relations`，from 恒为 self）。
       *
       * 没有这一组时，关系图上只有「他们视你如何」，没有「你视他们为何」——
       * 而后者恰恰是玩家侧关系面板（B-20）要显示的那一半。
       */
      ...(pt?.relations ?? []).map((r) => ({
        from: selfId,
        to: normalizeRelationEndpoint(r.to, selfId),
        kind: r.kind,
        source: "template" as const,
        scope: r.scope ?? relationScopeOf(r),
        ...(r.knownBy !== undefined ? { knownBy: [...r.knownBy] } : {}),
        ...(r.gap !== undefined ? { gap: r.gap } : {}),
      })),
    ]
      /**
       * 复用模板角色当自己（`as: npc-gojo`）时，该角色声明的 `to: player` 会被替换成
       * 自己的 id ⇒ 自环。schema 明确禁止自环（「关系边不允许自环」），写进去就是一份
       * **载不回来的存档**（GET 直接 `world_state_invalid`）。这里丢掉这条边：
       * 「某角色把玩家当弟子」在玩家就是这个角色时本来也没有语义。
       */
      .filter((edge) => edge.from !== edge.to)
      /**
       * **同一条边只能有一条**（2026-11-19 修）：模板通常写两笔 ——
       * 「夜蛾视五条为弟子（value 80）」＋「夜蛾视**你**为弟子（无 value）」。
       * 玩家扮演五条时，后者的 `to: player` 归一成 `npc-gojo`，于是同一个
       * `(from,to,kind)` 上出现两条边：一条带强度、一条不带。投影取第一条，
       * 但存档里躺着两条互相矛盾的同一事实。
       *
       * 归一用 `addEdge`（图里唯一去重口径，按 `(from,to,kind)` 合并）：
       * 后来的边只覆盖它自己写了的字段，`value` 不会因为「玩家那一笔没写」而丢。
       */
      .reduce<RelationEdge[]>((acc, edge) => addEdge(acc, edge), []),
    flags: {},
    firedEvents: {},
    // R2.5 实例层 / 事实层：全部由 createWorldV2 显式初始化，存档 strict 校验逐字段要求存在。
    delayQueue: [],
    enqueueSeqCounter: 0,
    missedEvents: [],
    eventFires: [],
    lastFiredIndex: {},
    slot: null,
    battle: null,
    lastWheel: null,
    // D-03：当轮转盘结果列表（每轮起点清空）；单槽 lastWheel 保留兼容
    lastWheels: [],
    history: [],
    openingCompleted: false,
    termination: null,
    archived: false,
    // F3 / F4 新契约状态：建世界期给最小空值，后续由引擎 API（Wave 1B）填充。
    observationLedger: { player: [] },
  };
  state.player.hp = maxHp(state.player, template);
  state.player.mp = maxMp(state.player, template);
  // ADR-003 D8：自定义资源按模板 initial（缺省 = 上限）初始化；hp/mp 不进 resources 映射。
  initPlayerResources(state.player, template);
  /**
   * ADR-012 D9：以某角色开局时，把他的**专属池**一起带过来（夏油开局就有「咒灵数量 3/5」）。
   * 只认 `reuse` —— `new` 是空白人物，没有「他本来就有」的东西。
   */
  if (selection?.kind === "reuse") {
    const reused = template.characters.find((c) => c.id === selection.characterId);
    if (reused?.resources !== undefined && Object.keys(reused.resources).length > 0) {
      state.player.resources = state.player.resources ?? {};
      const maxes: Record<string, number> = {};
      for (const [key, pool] of Object.entries(reused.resources)) {
        maxes[key] = Math.max(0, Math.round(pool.max));
        state.player.resources[key] = Math.max(0, Math.min(maxes[key], Math.round(pool.value)));
      }
      state.player.resourceMax = maxes;
    }
  }
  // NPC 模拟域占位资源 = 完整公式上限（模拟域暂无资源结算，仅保证正数）
  for (const npc of state.npcs) {
    npc.hp = computeMax(template.resources.hp, 0, npc.attributes, 1);
    npc.mp = computeMax(template.resources.mp, 0, npc.attributes, 0);
  }
  // ADR-017 D1：声明边折叠过来的「他视你多重」写进标量（唯一真源）。
  for (const [npcId, value] of foldedToSelf) {
    const npc = state.npcs.find((n) => n.id === npcId);
    if (npc !== undefined) npc.relationship = value;
  }
  for (const item of pt?.items ?? []) {
    state.player.inventory[item.itemId] = (state.player.inventory[item.itemId] ?? 0) + item.count;
  }
  // R-EV-08：全部 source: schedule 事件在**世界初始化**（now=0）即入队，
  // 不再每轮扫描 template.events。window 在入队时一次性换算成绝对分钟固化。
  // R2.6（ADR-0013）：TimeSpec 换算经历法适配器（字符串字面量 / year-month 量）。
  for (const event of template.events) {
    if (event.trigger.source !== "schedule") continue;
    enqueueScheduled({
      state,
      definitionId: event.id,
      origin: { kind: "schedule-init", id: event.id },
      start: event.trigger.window?.start ?? { value: 0, unit: "minute" },
      ...(event.trigger.window?.end !== undefined ? { end: event.trigger.window.end } : {}),
      calendar: initCalendar,
    });
  }
  /**
   * 扩展的状态切片初始化（`docs/EXTENSIONS.md` §2）。只对模板**已声明**的扩展调用，
   * 且放在 state 全部字段就位之后 —— 扩展看到的是可直接落盘的完整状态。
   * 不声明 `extensions:` ⇒ 一次都不调，`state.extensions` 保持缺省（零回归）。
   */
  for (const ext of resolveExtensionRuntimes(template)) {
    ext.runtime.onWorldCreated?.(state, ext.config, template);
  }
  return state;
}

/** 历史条目 id：附加本局历史长度后缀，保证事件结算轮下仍严格唯一（R-EV-14）。 */
function historyId(state: WorldStateV2, base: string): string {
  return `${base}-${state.history.length}`;
}

// ---------- 呈现槽与事件结算（ADR-0034 §2） ----------

/**
 * 一次轮次结算的累加器（引擎内部类型）。
 *
 * **不是**存档 / 投影 / 玩家端 API 的一部分（ADR-0021 决策 1.4 / ADR-0034 §5）：
 * 它只在一次轮次内被填充，随后被裁成 `V2TurnResult`。导出仅为让测试断言诊断位。
 */
export interface TriggerResult {
  triggered: Array<{ id: string; title: string; narrative: string }>;
  wheelResult: WheelResultView | null;
  /** 本条触发被跳过的原因（当前唯一取值见 `SKIP_ALL_ENEMIES_INACTIVE`，非持久化） */
  skipped?: string;
  /**
   * 本轮因**前提失效**被清出槽的事件 id（ADR-0024 决策 4 的可诊断性补偿，非持久化）。
   * 与 `skipped` 分开是刻意的：`skipped` 是单槽，两者写同一个字段会互相覆盖。
   */
  droppedPending?: string[];
}

/** combat 事件的全部敌人过滤后为空 ⇒ 整条触发跳过（取值被测试断言，只写这一处）。 */
export const SKIP_ALL_ENEMIES_INACTIVE = "all_enemies_inactive";

/** 扫描 / 呈现前求值用的独立派生流（ADR-0034 §3-5）：与主轮 RNG 完全分开。 */
function scanStream(state: WorldStateV2): Rng {
  return createRng(deriveTurnSeed(state.seed + SCAN_RNG_SALT, state.turnIndex));
}

/**
 * **呈现前前提复核**（ADR-0034 §3-4：求值固定在真正上桌那一刻）。
 *
 * 与 ADR-0024 的 `revalidatePendingV2` 同一口径，只是作用对象从 `pendingEvents` 换成 `slot`：
 * 前提不成立 ⇒ **静默清槽**（不推 `turnIndex`、不写 history、不记错失、不动 `eventFires`）。
 * 记错失在这里结构上不可能：`MissedEventRecord` 需要 `instanceId`，而槽里只有 `eventId`。
 *
 * RNG 用独立派生流（`scanStream`）：复核会随每次呈现重复求值，不得记账到主轮流。
 */
export function revalidateSlot(state: WorldStateV2, lookup: TemplateLookup): { dropped: string[] } {
  if (state.slot === null) return { dropped: [] };
  const scene = state.slot;
  const def = lookup.event(scene.eventId);
  // 定义缺失：加载期完整性错误 ⇒ 不越权删除语义（与 ADR-0024 一致），但槽不能拿去呈现。
  if (!def) return { dropped: [] };
  const ctx: ConditionContext = { state, lookup, rng: scanStream(state) };
  const premise = checkEventPremise(def, ctx);
  if (premise.ok) return { dropped: [] };

  // ADR-0034 §8-⑪：「失效必须留痕」在槽路径上要尽量写进**持久化**的 missedEvents；
  // 但 `MissedEventRecord` 需要 `instanceId`，只有 `queueTake` 出来的槽有 ⇒
  //   • 有实例 id：写 missedEvents（reason 复用既有枚举：missWhen ⇒ miss_when；条件失效同样按
  //     永久失效处理，因为槽已把事件摘除）；
  //   • 无实例 id（successor/hook/opening/death）：**不造 id**，退化为非持久化 `droppedPending`。
  if (scene.instanceId !== undefined) {
    state.missedEvents.push({
      eventId: def.id,
      instanceId: scene.instanceId,
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      reason: "miss_when",
      ...(premise.ok === false && premise.missWhen && premise.label !== undefined ? { label: premise.label } : {}),
    });
  }
  const dropped = [def.id];
  assignSlot(state, null);
  return { dropped };
}

function recordDroppedPending(result: TriggerResult, dropped: string[]): void {
  if (dropped.length === 0) return;
  result.droppedPending = [...(result.droppedPending ?? []), ...dropped];
}

/** 被清出槽的事件里是否有 `command.optionId` 所属的那一个（决定抛哪个错误码，ADR-0024 决策 8）。 */
function droppedEventOwnsOption(dropped: readonly string[], optionId: string, lookup: TemplateLookup): boolean {
  for (const eventId of dropped) {
    const def = lookup.event(eventId);
    if (def?.kind !== "normal") continue;
    if (def.settle.normal.options.some((o) => o.id === optionId)) return true;
  }
  return false;
}

/** 事件的「后继」是否有时间账：声明了 `delay` / `window.start` ⇒ 入队；否则直接占槽。 */
function enqueueSuccessor(state: WorldStateV2, lookup: TemplateLookup, nextEventId: string): boolean {
  const next = lookup.event(nextEventId);
  if (!next) return false; // 悬空 nextEventId：加载期校验会拦，这里保守当"无后继"
  const startSpec = next.trigger.window?.start ?? next.trigger.delay;
  if (startSpec === undefined) return false;
  enqueueScheduled({
    state,
    definitionId: next.id,
    origin: { kind: "effect", id: next.id },
    start: startSpec,
    ...(next.trigger.window?.end !== undefined ? { end: next.trigger.window.end } : {}),
    calendar: createTimeAdapter(lookup.template),
  });
  return true;
}

/** 结算后的「占槽判定」（ADR-0034 §2 步 4）：**唯一**能写 `slot` 的后继路径。 */
function applySuccessor(state: WorldStateV2, lookup: TemplateLookup, settledId: string, nextEventId?: string): void {
  if (nextEventId === undefined) {
    assignSlot(state, null);
    return;
  }
  if (enqueueSuccessor(state, lookup, nextEventId)) {
    assignSlot(state, null); // 有延迟 ⇒ 进队列，不占槽（ADR §10-4）
    return;
  }
  assignSlot(state, { eventId: nextEventId, from: "successor", fromEventId: settledId });
}

/** 链条起点（`startChain` 效果 / NPC 自主行动）⇒ 只入队，绝不直接写 `slot`（ADR-0034 §4 R3）。 */
function enqueueChainStarts(
  state: WorldStateV2,
  lookup: TemplateLookup,
  chainIds: string[] | undefined,
): void {
  if (!chainIds || chainIds.length === 0) return;
  for (const chainId of chainIds) {
    const def = lookup.chain(chainId);
    if (!def) continue;
    enqueueScheduled({
      state,
      definitionId: def.startEventId,
      origin: { kind: "effect", id: chainId },
      start: ZERO_SPEC,
      calendar: createTimeAdapter(lookup.template),
    });
  }
}

/**
 * 结算一个**已在槽中**的事件（ADR-0034 §2 步 3）。
 *
 * 顺序固定：应用效果 → `turnIndex += 1` → `recordFire` → 写历史 → 占槽判定。
 * `turnIndex` 后移到内容落地之后，是 S2「槽内事件未结算前轮次不前进」的落点；
 * `recordFire` 必须在 `turnIndex += 1` **之后**，否则事实日志会记到上一轮。
 */
function settleSlotEvent(input: {
  state: WorldStateV2;
  template: WorldTemplateV2;
  lookup: TemplateLookup;
  result: TriggerResult;
  def: EventV2;
  applyEffects: () => void;
  choiceText?: string;
  optionId?: string;
  nextEventId?: string;
}): void {
  const { state, template, lookup, result, def } = input;
  input.applyEffects();
  state.turnIndex += 1;
  recordFire(state, def.id);
  result.triggered.push({ id: def.id, title: def.title, narrative: def.narrative ?? def.title });
  pushHistory(state, template, {
    id: historyId(state, `t${state.turnIndex}-e-${def.id}`),
    type: "event",
    summary: `${def.title}：${def.narrative ?? def.title}`,
    visibility: "public",
  });
  if (input.choiceText !== undefined) {
    pushHistory(state, template, {
      id: historyId(state, `t${state.turnIndex}-c-${def.id}-${input.optionId ?? ""}`),
      type: "event",
      summary: `${def.title}：你选择了「${input.choiceText}」`,
      visibility: "public",
    });
  }
  applySuccessor(state, lookup, def.id, input.nextEventId);
}

function pickIndex(weights: number[], rng: { (): number }): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * **呈现**槽内的 `random`（转盘）事件：只掷骰、只记录呈现结果，**不结算**。
 *
 * 为什么不呈现即结算：ADR-0034 §2 步 2 把「转盘确认」列为**输入**，步 3 才是结算。
 * 若呈现即结算，一次调用会连续结算「上一事件 + 转盘」两个事件 ⇒ 直接违反 S1（一轮只结算一个）
 * 与 G1-3（净 `turnIndex` 增量 = 1）。
 *
 * 掷骰用**扫描派生流**（`scanStream`）而不是主轮流：呈现可能被重复调用（刷新/重取快照），
 * 用主轮流会把"看一次"变成"多扣一次骰"。同一 `(seed, turnIndex, state)` 必然得到同一格。
 * 结果写进 `lastWheel(s)`（本轮呈现记录，本来就是呈现态的载体），确认时按同一 label 找回。
 */
function presentRandomSlot(
  state: WorldStateV2,
  lookup: TemplateLookup,
  result: TriggerResult,
  def: EventV2,
): void {
  if (def.kind !== "random") return;
  const existing = (state.lastWheels ?? []).find((w) => w.eventId === def.id);
  if (existing !== undefined) {
    result.wheelResult = existing; // 重复呈现：复用已掷出的那一格（幂等）
    state.lastWheel = existing;
    return;
  }
  const wheel = def.settle.random.wheel;
  const eff = playerEffectiveAttributes(state, lookup);
  const weights = wheel.segments.map((seg) => {
    let w = seg.weight;
    for (const [attr, coef] of Object.entries(seg.weightBy ?? {})) w += (eff[attr] ?? 0) * coef;
    return Math.max(0, w);
  });
  const idx = pickIndex(weights, scanStream(state));
  const seg = wheel.segments[idx];
  const view: WheelResultView = {
    eventId: def.id,
    title: def.title,
    label: seg.label,
    segments: wheel.segments.map((s) => ({ label: s.label, weight: Math.max(0, s.weight) })),
  };
  result.wheelResult = view;
  state.lastWheel = view;
  (state.lastWheels ??= []).push(view);
}

/** 槽内 `random` 的**确认结算**（`advanceTurnV2` 在 random 槽上即"转盘确认"输入）。 */
function settleRandomSlot(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  result: TriggerResult,
  def: EventV2,
): void {
  if (def.kind !== "random") return;
  const wheel = def.settle.random.wheel;
  // 呈现在**上一个**轮次（`presentRandomSlot` 写 `lastWheel(s)`）；确认这一轮必须**按呈现的那一格**结算：
  // 先查本轮呈现集，再退回单槽 `lastWheel`（单槽在 `presentRandomSlot` 写入且不被轮次起点清空）。
  const shown =
    (state.lastWheels ?? []).find((w) => w.eventId === def.id) ??
    (state.lastWheel !== null && state.lastWheel.eventId === def.id ? state.lastWheel : undefined);
  // **不得静默兜底**（团队裁决）：找不回"呈现的那一格"说明呈现/确认链路断了，
  // 悄悄取 `segments[0]` 会让玩家看到的与结算的永久错位，且测试看不出来。
  if (shown === undefined) {
    throw new Error(`wheel_confirm_without_presentation: ${def.id}（槽来源 ${state.slot?.from ?? "?"}）没有已呈现的扇区`);
  }
  const seg = wheel.segments.find((s) => s.label === shown.label);
  if (seg === undefined) {
    throw new Error(`wheel_segment_missing: ${def.id} 呈现的「${shown.label}」在模板 segments 里找不到`);
  }
  // 回填：确认这一轮的响应仍要能展示"这一格是什么"
  result.wheelResult = shown;
  if (!(state.lastWheels ?? []).some((w) => w.eventId === def.id)) {
    (state.lastWheels ??= []).push(shown);
  }
  settleSlotEvent({
    state,
    template,
    lookup,
    result,
    def,
    applyEffects: () => {
      const segCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
      applyEffectsV2(segCtx, seg.effects);
      enqueueChainStarts(state, lookup, segCtx.startedChains);
    },
    ...(seg.nextEventId !== undefined ? { nextEventId: seg.nextEventId } : {}),
  });
}

/** pool 抽取阈值（ADR-0034 §3-6 / §10）：只决定"摇不摇"，不决定"占不占槽"。 */
function poolDrawConfig(template: WorldTemplateV2): { skipWhenSlotOccupied: boolean; maxQueueLength: number } {
  const cfg = template.eventFlow?.poolDraw;
  return {
    skipWhenSlotOccupied: cfg?.skipWhenSlotOccupied ?? true,
    maxQueueLength: cfg?.maxQueueLength ?? 3,
  };
}

/**
 * 池阈值的**计数口径**（ADR-0034 §13.5 A2'）：只数「**当前可上桌**」的 `waiting` 实例。
 *
 * 为什么不能直接数 `waiting` 长度（seed 5 主线停摆的根因）：
 * §3-3 要求「条件不满足必须留队」，§3-6 又按「队列长度 ≥ N 不摇」封顶 ⇒ 一条**入队时合法、
 * 之后永久不成立**的实例（例：`era == 1` 的日常在 `era` 升到 3 之后）会永久占据名额，
 * 队列恒满 ⇒ 池永久停摆 ⇒ `source: pool` 的章节门永远摇不出来 ⇒ 主线卡死到 `timeReached`。
 * 两条规则各自正确，组合致命：没有人负责回答「队列里的东西会不会永远出不去」。
 *
 * 口径 = 「可上桌」两条同时成立（ADR §13.5 写死的判据）：
 * 1. `window.start <= worldTime`（**未到期的不计** —— 它还没到上场时间，不该挡今天的抽取）；
 * 2. `checkEventPremise(def, ctx).ok`（`missWhen` / `conditions` 不成立的不计）。
 * 另加两条不计入：定义缺失（清理归加载期完整性校验）、已过期（`worldTime > window.end`，
 * 扫描会把它摘掉并记 `window_expired`）。**冷却中的实例仍计入**：冷却会自然解除，属"活内容"
 * ——注意这与 `evaluateDue` 的 `hold` 口径**故意不同**（出队终判连冷却一起 hold，计数不 hold）。
 *
 * RNG 纪律（§3-5 / 主理人硬要求，**改错会以最难查的方式出错**）：
 * - 一轮计数只创建**一条**派生流（`scanStream`，`seed + 37`），沿遍历顺序**同一个 `rng`**
 *   顺序传给每次 `checkEventPremise`。**绝不可**每个实例各建一条 —— 那会让两个含 `random`
 *   条件的实例拿到同一个骰值（相关性 bug），而且"同 seed 两次跑一致"还能照绿。
 * - 遍历顺序固定为 `sortScheduled` 的全序（`start → hasEnd → end → enqueueSeq`），
 *   与 `scanDelayQueue` 同一条顺序 ⇒ 骰值消费顺序只由世界状态决定，不随数组顺序漂移。
 * 纯读：只计数，不改 `status`、不写 `missedEvents`、不推 `turnIndex`、不动 `slot`。
 */
function countPresentableQueue(state: WorldStateV2, lookup: TemplateLookup): number {
  const rng = scanStream(state); // 一轮一条流
  let presentable = 0;
  for (const inst of sortScheduled(state.delayQueue)) {
    if (inst.status !== "waiting") continue;
    if (inst.window.start > state.worldTime) continue; // 未来实例不挡路
    const def = lookup.event(inst.definitionId);
    if (!def) continue;
    if (inst.hasEnd && inst.window.end !== undefined && state.worldTime > inst.window.end) continue;
    if (!checkEventPremise(def, { state, lookup, rng }).ok) continue; // 同一个 rng，顺序消费
    presentable += 1;
  }
  return presentable;
}

/**
 * pool = 抽取器（R-EV-08/13）。**只写 `delayQueue`、没有写 `slot` 的权限**（ADR-0034 §10）：
 * 与「取队列实例 → 写 slot」是两个不同函数，结构上保证"摇出事件"这个判断不占槽。
 * 阈值 = `slot !== null`（可按配置关掉）或「**当前可上桌**的实例数 ≥ N」⇒ 本轮不摇
 * （计数口径见 `countPresentableQueue`，ADR §13.5 A2'）。
 */
function resolvePoolV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
): void {
  const draw = poolDrawConfig(template);
  if (draw.skipWhenSlotOccupied && state.slot !== null) return;
  if (countPresentableQueue(state, lookup) >= draw.maxQueueLength) return;

  const ctx: ConditionContext = { state, lookup, rng };
  const calendar = createTimeAdapter(template);
  const pool = template.events
    .filter((e) => e.trigger.source === "pool")
    .filter((e) => e.kind !== "combat") // 加载期已拒，抽取期防御
    .filter((e) => !(e.trigger.once && hasFired(state, e.id)))
    .filter((e) => !onCooldown(state, e.id, e.trigger.cooldown, calendar))
    .filter((e) => checkAllConditions(e.trigger.conditions, ctx))
    .sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));

  const weighted: EventV2[] = [];
  const enqueue = (event: EventV2): void => {
    enqueueCandidate({
      state,
      definition: event,
      origin: { kind: "pool", id: event.id },
      lookup,
      rng,
      calendar,
      preGated: true, // 六策略已在上面消费，门控不得重复扣减 once / probability / conditions
    });
  };
  for (const event of pool) {
    const t = event.trigger;
    if (t.probability !== undefined) {
      if (rng() < t.probability) enqueue(event);
    } else if (t.weight !== undefined) {
      weighted.push(event);
    }
  }
  const chosen = pickWeighted(weighted, (e) => e.trigger.weight ?? 1, rng);
  if (chosen) enqueue(chosen);
}

/**
 * action-hook（行动触发）：声明了 `window` / `delay` ⇒ 入队；否则**写 `hook` 槽**。
 * 槽已被占（例如同轮第一个钩子已占）⇒ 改造入队，绝不覆盖（`slot` 是标量，覆盖即丢事件）。
 */
function resolveHooksV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  actionId: string,
): void {
  const ctx: ConditionContext = { state, lookup, rng };
  const calendar = createTimeAdapter(template);
  for (const event of template.events) {
    const t = event.trigger;
    if (t.source !== "action-hook" || t.onActionId !== actionId) continue;
    if (t.once && hasFired(state, event.id)) continue;
    if (onCooldown(state, event.id, t.cooldown, calendar)) continue;
    if (!checkAllConditions(t.conditions, ctx)) continue;
    if (t.probability !== undefined && rng() >= t.probability) continue;
    if (t.window !== undefined || t.delay !== undefined) {
      enqueueCandidate({
        state,
        definition: event,
        origin: { kind: "effect", id: actionId },
        lookup,
        rng,
        calendar,
        preGated: true,
      });
    } else if (state.slot === null) {
      assignSlot(state, { eventId: event.id, from: "hook" });
    } else {
      // 槽已被同轮其它钩子占用 ⇒ 入队等下一轮（不覆盖、不丢弃）
      enqueueScheduled({
        state,
        definitionId: event.id,
        origin: { kind: "effect", id: actionId },
        start: ZERO_SPEC,
        calendar,
      });
    }
  }
}

/**
 * 结算后的「其他判定」（ADR-0034 §2 步 5，顺序固定：NPC 自主行动 → pool 摇一个）。
 * `missWhen` 的处置在队列扫描里（`scanDelayQueue`），不在这里。
 */
/**
 * 生成分支的「必然」档：条件满足才入队（AGENTIC-GM 重构）。
 *
 * 硬要求：**在 `enqueueCandidate` 之前判条件**，不许"先入队再靠 hold 等条件"——
 * `countPresentableQueue` 会把**条件已满足**的 waiting 实例计入可上桌数，
 * 多条同时满足会顶满 `maxQueueLength` ⇒ 池抽取静默停摆（症状是"随机事件变少了"，
 * 没人会想到是这几条分支干的）。另外每条定义按 `definitionId` 去重：
 * 一个 `waiting` 至多一个，避免同一分支重复入场。
 *
 * 只处理 `story.submitBranch` 生成的、`source === "schedule"` 的事件（模板事件不在此列，
 * 它们在**世界初始化**时一次性入队，见 `createWorldV2`）。
 */
function enqueueGeneratedCertain(
  state: WorldStateV2,
  lookup: TemplateLookup,
  rng: Rng,
): void {
  const generated = state.generatedEvents;
  if (generated === undefined || generated.length === 0) return;
  for (const def of generated) {
    if (def.trigger.source !== "schedule") continue;
    const waiting = state.delayQueue.some(
      (inst) => inst.definitionId === def.id && inst.status === "waiting",
    );
    if (waiting) continue;
    // 已结算过的生成事件不重放（生成分支是一次性内容，不靠 cooldown 收敛）。
    if (state.firedEvents[def.id] !== undefined) continue;
    if (!checkEventPremise(def, { state, lookup, rng }).ok) continue;
    const startSpec = def.trigger.window?.start ?? def.trigger.delay;
    enqueueScheduled({
      state,
      definitionId: def.id,
      origin: { kind: "generated", id: def.id },
      // 事件自己声明的延迟/窗口 ⇒ 相对**入队时刻**换算；未声明仍为 now（零回归）。
      ...(startSpec !== undefined
        ? {
            start: startSpec,
            ...(def.trigger.window?.end !== undefined ? { end: def.trigger.window.end } : {}),
          }
        : { absoluteStart: state.worldTime }),
      calendar: createTimeAdapter(lookup.template),
    });
  }
}

/**
 * 世界时间表求值（ADR-007 D1）：每轮 tail 扫一遍 `scheduledFacts`，
 * 条件成立且没执行过 ⇒ 执行效果并记一条 `state.facts`。
 *
 * 为什么放在 tail：此刻本轮的结算（战斗 / 选项 / 自由行动）都已落地，
 * 世界时间也已经推进到新值 —— 「到点发生」的判断与玩家这一轮做了什么无关。
 *
 * 三条硬约束：
 * · **一事实一次**：`state.facts` 里有这个 id 就跳过（append-only，不看轮次差值）。
 * · **不吃主轮 RNG**：条件与效果各用独立派生流（`scanStream`），给同一 seed 加一条
 *   时间表不会改变既有对局的随机序列。
 * · **顺序即声明顺序**：同一回合到期的多条事实按 `scheduledFacts` 的书写顺序执行，
 *   所以「先让人登场、再建立关系」这种依赖靠排列表达，不靠隐式排序。
 */
function runScheduledFacts(state: WorldStateV2, lookup: TemplateLookup): void {
  const defs = lookup.template.scheduledFacts;
  if (defs === undefined || defs.length === 0) return;
  const fired = new Set(state.facts.map((f) => f.factId));
  for (const fact of defs) {
    if (fired.has(fact.id)) continue;
    if (!checkAllConditions(fact.when, { state, lookup, rng: scanStream(state) })) continue;
    applyEffectsV2({ state, lookup, rng: scanStream(state) }, fact.effects);
    state.facts.push({ factId: fact.id, turnIndex: state.turnIndex, worldTime: state.worldTime });
    fired.add(fact.id);
    /**
     * 上了「世事」栏（2026-11-19）：事实不经过玩家，所以它拿不到「本轮收获」——
     * 但玩家该知道世界动了。`tidings` 是作者写的**玩家可见**那句话（`note` 仍是作者注），
     * 写进编年史就是「远方传来的事」，不需要为此写一个只为了上屏的事件。
     */
    if (fact.tidings !== undefined) {
      pushHistory(state, lookup.template, {
        id: `fact-${fact.id}-t${state.turnIndex}`,
        type: "world",
        summary: fact.tidings,
        visibility: "public",
      });
    }
  }
}

function postSettleJudgements(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
): void {
  const npcResult = runNpcActionsV2(state, lookup, rng);
  enqueueChainStarts(state, lookup, npcResult.startedChains);
  enqueueGeneratedCertain(state, lookup, rng);
  resolvePoolV2(state, template, lookup, rng);
  // ADR-007 D1：世界自己的时间表（NPC 登场也在其中，见 world.yaml scheduledFacts）。
  runScheduledFacts(state, lookup);
}

/**
 * 事件级 `npcs`（S1）：事件**占槽呈现时**把这些人拉上场（`alive` 幂等）。
 *
 * 覆盖的占槽来源：`successor` / `hook` / `queueTake` 以及任何已存在的槽 —— 统一在
 * `nextTurn` 的「复核通过、按 kind 呈现之前」这一个汇合点执行（槽被 revalidate 丢弃时
 * 不执行，避免给一场不会上演的戏拉人）。写入走 `applyEffectsV2`，不另立 spawn 实现：
 * - 命中刷新规则 id ⇒ `spawnNpc`（幂等、写 spawnLog、规则转 spawned）；
 * - 命中角色 id ⇒ `setNpcLifecycle alive`（已登场则跳过，不刷 sinceTurn）；
 * - 未知引用 ⇒ 静默跳过（加载期 / 提交期已校验；呈现路径不能因配置错误炸掉整轮）。
 */
function materializeEventNpcs(
  state: WorldStateV2,
  lookup: TemplateLookup,
  def: EventV2,
): void {
  const refs = def.npcs;
  if (refs === undefined || refs.length === 0) return;
  const effects: Effect[] = [];
  for (const ref of refs) {
    const rule = state.spawnRules.find((r) => r.ruleId === ref);
    if (rule !== undefined) {
      if (rule.status === "pending") effects.push({ type: "spawnNpc", ruleId: ref });
      continue;
    }
    const npc = state.npcs.find((n) => n.id === ref);
    if (npc !== undefined) {
      if (npc.lifecycle.state !== "alive") {
        effects.push({ type: "setNpcLifecycle", npcId: ref, state: "alive" });
      }
      continue;
    }
    // 未知引用：加载期 / 提交期已拦，这里静默跳过（不臆造 NPC）。
  }
  if (effects.length === 0) return;
  applyEffectsV2({ state, lookup, rng: scanStream(state) }, effects);
}

/**
 * **`nextTurn` 判定链**（ADR-0034 §2，全模型唯一的推进入口）。
 *
 * ```
 * 槽有 ⇒ 只处理它；random **只呈现不结算**（等 `/turns` 的转盘确认）；combat 建战斗后等战斗命令；normal 等选择
 * 槽空 ⇒ 扫队列，取出即写 slot（from: "queueTake"）再处理
 * 都没有 ⇒ 返回（空槽 = 可自由行动）
 * ```
 *
 * 自旋上限 `MAX_NEXT_TURN_SPINS` 只防实现 bug；正常路径 1–3 圈。
 */
function nextTurn(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  rng: Rng,
  result: TriggerResult,
): void {
  for (let spin = 0; spin < MAX_NEXT_TURN_SPINS; spin += 1) {
    if (state.slot !== null) {
      const def = lookup.event(state.slot.eventId);
      if (!def) {
        assignSlot(state, null); // 加载期完整性错误：清槽，不臆造错失
        continue;
      }
      // 呈现前前提复核（§3-4）：失效即静默清槽，然后继续判定（可能还有排队事件）
      const { dropped } = revalidateSlot(state, lookup);
      if (dropped.length > 0) {
        recordDroppedPending(result, dropped);
        continue;
      }
      // S1：事件级 `npcs` 在呈现前把人拉上场（`alive` 幂等；所有占槽来源在此汇合）。
      materializeEventNpcs(state, lookup, def);
      if (def.kind === "random") {
        presentRandomSlot(state, lookup, result, def);
        return; // 停在呈现，等「转盘确认」（ADR-0034 §2 步 2）
      }
      if (def.kind === "combat") {
        if (state.battle === null || state.battle.over) {
          if (resolveCombatRefs(def.settle.combat, state, lookup).enemiesExhausted) {
            // ADR-0021 决策 1.2：敌人全部确知非在世 ⇒ 战斗不成立，整条跳过（不记火、不写历史）
            result.skipped = SKIP_ALL_ENEMIES_INACTIVE;
            assignSlot(state, null);
            continue;
          }
          state.battle = createBattle(def.id, def.settle.combat, state, lookup);
          state.battle.log.push(def.narrative ?? def.title);
        }
        return; // 战斗命令由 battleActionV2 接
      }
      return; // normal：等玩家选择
    }

    const scanned = scanDelayQueue(state, lookup, scanStream(state), createTimeAdapter(template));
    if (scanned.kind === "taken") {
      // ADR-0034 §8-⑪：**只有**队列取出这条路带实例 id（其余四个来源没有队列实例，不得造 id）
      assignSlot(state, {
        eventId: scanned.definition.id,
        from: "queueTake",
        instanceId: scanned.instance.instanceId,
      });
      continue;
    }
    return; // 空槽
  }
}

/**
 * 冷启动的「第一幕」呈现：把已到期且前提成立的排队事件写进 `slot` 并呈现。
 *
 * **不推进 `turnIndex`、不消耗行动、不加世界时间**（与 `nextTurn` 槽空分支同一条路径）。
 * 存在理由：`commitOpening` 之后是冷启动（`slot === null`），若只靠玩家下一次行动才
 * `nextTurn`，「开局文本 → 第一幕事件」就会断开——玩家得先点一次「修炼」才看得见序章。
 * 只呈现，不结算：`normal` 停下等选择、`random` 停下等转盘确认、`combat` 建战斗会话。
 */
export function presentQueuedEventV2(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
): TriggerResult {
  const result: TriggerResult = { triggered: [], wheelResult: null };
  if (state.slot !== null || state.termination !== null) return result;
  nextTurn(state, template, lookup, scanStream(state), result);
  return result;
}

/** 投影 + 评价：评价是唯一事实来源（T4-04），每次投影按当前状态重算。 */
function projectWithConfig(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline: TurnPipelineConfig | undefined,
): V2Snapshot {
  const evaluation = evaluateLifeV2(state, pipeline?.evaluationConfig);
  return projectSnapshotV2(state, template, lookup, evaluation, pipeline?.endingConfig?.endings);
}

/** 任何返回给玩家的 `snapshot` 之前复核一次槽前提（ADR-0034 §3-4），保证响应里没有幽灵场景。 */
function revalidateThenProject(
  state: WorldStateV2,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline: TurnPipelineConfig | undefined,
  result: TriggerResult,
  /** ADR-0037 D11：本次调用是否真的推进了回合（`useItemV2` 传 false）。 */
  atTurnBoundary: boolean,
): V2Snapshot {
  recordDroppedPending(result, revalidateSlot(state, lookup).dropped);
  // 本轮真正结算过的事件 id：`eventResolved` 条件的唯一判据（不查历史 eventFires）。
  const resolvedEventIds = new Set(result.triggered.map((t) => t.id));
  // 结算 tail 唯一 hook 位：无 rules / 无 gateway 时为空操作（零回归）。
  runSettlementHooks(state, pipeline, resolvedEventIds, atTurnBoundary, lookup);
  return projectWithConfig(state, template, lookup, pipeline);
}

/**
 * 可选管线配置（阶段 4 遗留接线）：不传时行为与接线前逐字段一致——
 * 无 endings.yaml ⇒ 零终止条件 ⇒ 永不终止；评价用引擎默认配置。
 * 由调用方（apps/server）注入模板分域配置，内核不自行读文件。
 */
export interface TurnPipelineConfig {
  endingConfig?: EndingConfig;
  evaluationConfig?: EvaluationConfig;
  // ---- 阶段 B / LLM 稀疏参与注入位（不传 gateway ⇒ 行为与改前逐字段一致，零回归）----
  /** LLM 网关：core → llm 回调；invoke 异步只在网关 / agent-runtime，内核不 await。 */
  gateway?: LlmGateway;
  /** 触发 / 授权规则（内联 fixture 注入；缺省则本轮不发 invocation）。 */
  rules?: Rules;
  /** `lore.md` 的解析结果（含 keys/always/p）；由 server 注入，内核只做可见文本匹配。 */
  lore?: readonly LoreRule[];
  conditionRegistry?: ConditionRegistry;
  toolRegistry?: ToolRegistry;
  trace?: LlmTrace[];
  callLog?: CallLogEntry[];
  budget?: LlmBudget;
  perspective?: Perspective;
  targetPerspective?: Perspective;
  /**
   * true ⇒ 结算 tail 只落 `pendingInvocation`，把「执行 invocation」交给编排层
   * （编排层据此把它纳入同一回合的事务边界，见 ADR-0035 D2）。
   *
   * 缺省 false = 保持既有 fire-and-forget 语义（仅供不持事务的调用方 / 测试使用）。
   * 生产路径必须由 `apps/server` 设 true —— 否则结构写入会晚到，`story.submitBranch`
   * 的跨回合守卫（IO-1）会把它们全部拒掉，等于 LLM 完全写不了世界。
   */
  deferInvocation?: boolean;
}

/**
 * 结算 tail 的**唯一** hook 位，分两段，顺序固定：
 *
 * ① **知识授予**（F4 / T-02）：按 `rules.yaml` 的 `knowledgeGrants[]` / `inferenceRules[]`
 *    给在场观察者授 `known` / `inferred`。这段**不依赖 gateway** —— 授权是模板数据
 *    驱动的确定性事实，与「这轮有没有 LLM 可调」无关；不接网关的模板
 *    同样应当按规则授知识。写入经 `assignKnowledgeGrants`（权威写入集中在 engine-api）。
 *
 * ② **LLM 触发**（阶段 B / T-05a）：产出 `LlmInvocation` 交 `LlmGateway`，**不 await LLM**
 *    （core → llm 回调，回程一律走 dispatch 引擎 API）。`rules.llmTriggers[].when` 一条都不
 *    命中 ⇒ `invocations` 为空 ⇒ **本轮零网关调用**（LLM 稀疏参与的落点，不是每轮跑）。
 *
 *    ADR-0036 起求值改为**边沿语义**（`fireMode` 缺省 edge：上一轮假、本轮真才发），
 *    跨轮历史落 `state.triggerFireLedger`；同轮多条命中只执行声明序第一条（D3）。
 *
 * 硬不变量：不传 `gateway` 且不传 `rules` ⇒ 完全 no-op，state / 返回结果逐字段不变（零回归）。
 */
/**
 * 引擎侧设定筛选（agent-runtime 不做匹配，这条边界与 F4 一致）。
 *
 * 语料 = 当前槽事件 title+narrative + 最近 8 条非 hidden 的 history.summary
 *      + 本次 contextHints 字符串值。
 * 常驻条目全进；关键词条目只要任一 key 出现在语料里就进。
 * 排序 p 降序 → id 升序；最多 6 条 / 总字符 6000（按排序截断）。
 */
export function selectInvocationLore(
  state: WorldStateV2,
  lookup: TemplateLookup,
  contextHints: readonly string[] | undefined,
  entries: readonly LoreRule[],
): LoreEntry[] {
  if (entries.length === 0) return [];
  const slot = slotEventView(state, lookup);
  const corpus = [
    slot?.title ?? "",
    slot?.narrative ?? "",
    ...state.history
      .slice(-8)
      .filter((entry) => entry.visibility !== "hidden")
      .map((entry) => entry.summary),
    ...(contextHints ?? []),
  ]
    .filter((text) => text.length > 0)
    .join("\n")
    .toLowerCase();

  const picked = entries.filter(
    (entry) =>
      entry.always || entry.keys.some((key) => corpus.includes(key.toLowerCase())),
  );
  picked.sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const out: LoreEntry[] = [];
  let chars = 0;
  for (const entry of picked) {
    if (out.length >= 6) break;
    if (chars + entry.text.length > 6_000) break;
    out.push({
      id: entry.id,
      title: entry.title,
      text: entry.text,
      always: entry.always,
    });
    chars += entry.text.length;
  }
  return out;
}

function runSettlementHooks(
  state: WorldStateV2,
  pipeline: TurnPipelineConfig | undefined,
  resolvedEventIds: ReadonlySet<string>,
  /** 只有真正推进了回合的入口才唤起 agent（轮内小动作不调 LLM）。 */
  atTurnBoundary: boolean,
  lookup: TemplateLookup,
): void {
  if (pipeline?.rules === undefined) return;
  const registry = pipeline.conditionRegistry ?? createConditionRegistry();
  /**
   * 扩展条件（`docs/EXTENSIONS.md` §2）：只并**模板已声明**的扩展贡献的 op。
   * 未声明 ⇒ 不并，`evaluateAll` 对同名 op 仍产出 `unknown_reference` 诊断（不静默放过）。
   * 注册是幂等的（同 op 后注册者覆盖），每轮重并的成本可以忽略。
   */
  for (const [op, fn] of Object.entries(collectExtensionConditions(lookup.template))) {
    registry.register(op, fn);
  }
  // 结算 tail 顺序：**知识授予 → 触发器求值**。
  assignKnowledgeGrants(
    state,
    computeKnowledgeGrants(state, pipeline.rules, registry, state.turnIndex, lookup.template),
  );
  /**
   * **轮内动作不唤起 agent**（2026-11-16 用户实测）：
   * `useItemV2` / `equipV2` / `unequipV2` 这类不占槽、不推进回合的操作，
   * 传进来的 `atTurnBoundary === false`。若触发器求值照跑 ⇒ "喝瓶药"会真的去调一次
   * LLM 并等它几十秒。
   *
   * 口径：LLM 参与是**回合级**的稀疏事件，轮内小动作用引擎规则结算即可。
   */
  if (!atTurnBoundary) return;
  if (!pipeline.gateway) return;
  /**
   * ADR-0036：改用**边沿语义**求值（`fireMode` 缺省 edge）。
   *
   * 旧实现用 `evaluateTriggers`（纯当轮真值）+ `for (inv) assignPendingInvocation`：
   * ① 持久条件（如 `flagSet`）一旦为真就**每轮**调用 LLM，与「稀疏参与」相反；
   * ② 同轮多条命中时后写覆盖前写，前几条静默消失。
   *
   * 现在：ledger 落账所有求值结果（含假值），执行权按 D3 只给**声明序第一条**。
   */
  const { invocations, fireLedger } = evaluateTriggersEdge(
    state,
    pipeline.rules,
    registry,
    {
      seed: state.seed,
      turnIndex: state.turnIndex,
      resolvedEventIds,
      template: lookup.template,
      ...(pipeline.budget !== undefined ? { budget: pipeline.budget } : {}),
      ...(pipeline.perspective !== undefined ? { perspective: pipeline.perspective } : {}),
      ...(pipeline.targetPerspective !== undefined
        ? { targetPerspective: pipeline.targetPerspective }
        : {}),
    },
    state.triggerFireLedger,
  );
  // 全部求值为真的 key 都必须落账（含被 D3 挤掉的），否则它们下一轮会被当成"刚刚变真"。
  assignTriggerFireLedger(state, fireLedger);
  if (invocations.length === 0) return;

  /**
   * D3：每轮最多执行一条 —— 取声明序第一条，其余本轮不执行。
   *
   * **不静默**：被挤掉的每条都写一条 `pipeline.callLog`（`outcome: "deferred"` +
   * `code: "budget_exceeded"`）。为什么不丢弃而是记账：ADR-0035 §3 的「错误错过」正是
   * 静默丢失，这里是同一类风险；callLog 是该管线既有的诊断/取证通道（不伪造 LlmTrace：
   * 被挤掉的调用没有 contextHash / templateRef，编一个只会污染 trace 的取证价值）。
   */
  const [chosen, ...displaced] = invocations;
  const enriched = {
    ...chosen,
    ...(pipeline.rules.prompt?.style !== undefined
      ? { promptStyle: pipeline.rules.prompt.style }
      : {}),
    ...(pipeline.lore !== undefined
      ? { lore: selectInvocationLore(state, lookup, chosen.context.contextHints, pipeline.lore) }
      : {}),
  };
  for (const inv of displaced) {
    pipeline.callLog?.push({
      callId: inv.invocationId,
      tool: "llm.invoke",
      argsHash: `suppressed:${inv.invocationId}`,
      outcome: "deferred",
      code: "budget_exceeded",
    });
  }
  // 落账到 pendingInvocation（写入动作在 api/engine-api.ts，源码守卫据此断言）。
  assignPendingInvocation(state, enriched);
  /**
   * `deferInvocation`：交给编排层在**本回合事务内**执行（ADR-0035 D2）。
   *
   * 为什么不能在这里 fire-and-forget：`story.submitBranch` 是
   * 基于「创作这一轮」的状态算出来的**结构写入**。异步 = 落账时世界已经不是那个世界，
   * 于是要么让已死 npc 诈尸，要么（加 missWhen 后）变成静默的"错误错过"。
   * 二者在触发时刻的状态上完全一样，任何基于触发时刻的判据都分不开 —— 只能靠事务边界。
   */
  if (pipeline.deferInvocation === true) return;
  // fire-and-forget：invoke 返回 Promise，内核不 await；回程由 agent-runtime 经 dispatch 提交。
  void pipeline.gateway.invoke(enriched).catch(() => undefined);
}

/**
 * 终止判定边界：命中条件时在**同一状态快照**上决胜结局并写入 termination。
 * 只原地写 termination 一个字段（turn 管线全链路以可变 state 传递）。
 */
function applyEndingBoundary(
  state: WorldStateV2,
  lookup: TemplateLookup,
  rng: Rng,
  pipeline: TurnPipelineConfig | undefined,
  signal: TerminationSignal,
): void {
  const cfg = pipeline?.endingConfig;
  if (!cfg || cfg.terminationConditions.length === 0) return;
  if (state.termination !== null) return;
  const ctx: ConditionContext = { state, lookup, rng };
  const outcome = terminateWithEnding(
    state,
    cfg.terminationConditions,
    signal,
    cfg.endings,
    ctx,
    cfg.fallback !== undefined ? { fallbackId: cfg.fallback } : {},
  );
  if (outcome.decision !== null && outcome.state.termination !== null) {
    state.termination = outcome.state.termination;
  }
}

/**
 * 战败死亡路径接线（§9.3）。只在战败边界调用；applyDeathRoute 返回克隆状态，
 * 这里只回写可能变化的四个字段，保持管线的可变 state 语义。
 */
function applyDeathRouteInPlace(
  state: WorldStateV2,
  lookup: TemplateLookup,
  rng: Rng,
  pipeline: TurnPipelineConfig | undefined,
  battleDefeat: boolean,
): void {
  const cfg = pipeline?.endingConfig;
  const route = cfg?.deathRoute;
  if (!cfg || !route || !battleDefeat) return;
  if (state.termination !== null) return;
  const ctx: ConditionContext = { state, lookup, rng };
  const res = applyDeathRoute(
    state,
    route,
    { battleDefeat },
    cfg.endings,
    ctx,
    cfg.fallback !== undefined ? { fallbackId: cfg.fallback } : {},
  );
  if (res.outcome.kind === "none") return;
  // 克隆路径产生的所有事实/索引必须一起回写（recordFire 三处写入口保持一致）
  state.firedEvents = res.state.firedEvents;
  state.lastFiredIndex = res.state.lastFiredIndex;
  state.eventFires = res.state.eventFires;
  state.missedEvents = res.state.missedEvents;
  state.history = res.state.history;
  assignSlot(state, res.state.slot);
  state.termination = res.state.termination;
}

export function advanceTurnV2(
  state: WorldStateV2,
  /** endLife=true 表示玩家主动结束这一生（边界信号 playerRequested） */
  command: { action: { type: string; description?: string }; mode?: "single" | "fast"; endLife?: boolean },
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  ctx?: RunnerContext,
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
  // ADR-0024 决策 2.5 的**排空通道**必须排在门禁之前：槽内事件前提已假 ⇒ 先静默清槽，
  // 否则 `pending_event_required` 会把玩家永久挡在自由行动之外（前端看到 `slotEvent === null`
  // 却提交不了任何行动 = 硬死锁）。
  const droppedAtEntry = revalidateSlot(state, lookup).dropped;
  // 槽被占 ⇒ 必须先处理槽内事件（ADR-0034 §5：`pending_event_required` 语义重述，不新增错误码）。
  // 例外：槽内是 `random` ⇒ 本次调用即**「转盘确认」**（ADR-0034 §2 步 2 明确把"转盘确认"列为输入，
  // 而服务端没有也不该新增专用路由）。此时不消耗行动、不推时间，只把已呈现的那一格结算掉。
  const confirmingWheel =
    state.slot !== null && lookup.event(state.slot.eventId)?.kind === "random";
  if (state.slot !== null && !confirmingWheel) throw new Error("pending_event_required");
  if (state.battle !== null && !state.battle.over) throw new Error("battle_in_progress");
  // 清理上一场已结束的战斗（战斗是槽的内部过程，会话不该跨轮残留）
  state.battle = null;

  const rng = ctx?.rng ?? createRng(deriveTurnSeed(state.seed, state.turnIndex + 1));
  const adapter = createTimeAdapter(template);
  const action = lookup.action(command.action.type);
  const lifeStage = adapter.resolveLifeStage(state.player.age);

  // ---- 0. 转盘确认：槽内是 random ⇒ 结算它，然后照常走"其他判定 → nextTurn" ----
  if (confirmingWheel) {
    const wheelEvent = lookup.event(state.slot!.eventId)!;
    const wheelResult: TriggerResult = {
      triggered: [],
      wheelResult: null,
      ...(droppedAtEntry.length > 0 ? { droppedPending: [...droppedAtEntry] } : {}),
    };
    settleRandomSlot(state, template, lookup, rng, wheelResult, wheelEvent);
    postSettleJudgements(state, template, lookup, rng);
    nextTurn(state, template, lookup, rng, wheelResult);
    applyEndingBoundary(state, lookup, rng, pipeline, {
      atBoundary: true,
      boundary: "afterEventSettle",
    });
    const wheelSnapshot = revalidateThenProject(state, template, lookup, pipeline, wheelResult, true);
    return {
      state,
      snapshot: wheelSnapshot,
      elapsed: { value: 0, unit: "minute" },
      triggeredEvents: wheelResult.triggered,
      wheelResult: wheelResult.wheelResult,
      playerVisibleHistory: [],
    };
  }
  // 本轮呈现集在**轮次起点**清空（D-03）：被拒的指令不会清掉上一轮的可见结果。
  // ⚠ 必须放在「转盘确认」分支**之后**：确认本身就是一轮，它要读的是**上一轮呈现、
  // 本轮确认**的那一格；提前清空会让确认拿不到自己演的是哪一段（确定性取 segments[0]）。
  state.lastWheels = [];

  // ---- 1. 时间账（自由行动的时间在行动本身，不在轮次） ----
  let elapsed: TimeAmount;
  if (action?.advanceTo) {
    const delta = Math.max(0, amountToMinutes(action.advanceTo) - state.worldTime);
    state.worldTime += delta;
    elapsed = minutesToAmount(delta);
  } else {
    elapsed = adapter.resolveStep(lifeStage, action?.duration);
    state.worldTime += amountToMinutes(elapsed);
  }
  state.player.age = state.playerAgeAtStart + adapter.elapsedYears(state.worldTime);

  const result: TriggerResult = {
    triggered: [],
    wheelResult: null,
    ...(droppedAtEntry.length > 0 ? { droppedPending: [...droppedAtEntry] } : {}),
  };

  // ---- 2. 行动效果（`startChain` 只入队，绝不直接占槽） ----
  const actionCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
  applyEffectsV2(actionCtx, action?.effects);
  enqueueChainStarts(state, lookup, actionCtx.startedChains);

  // ---- 3. 结算：轮次推进在内容落地之后（ADR-0034 §2 步 3 / §4 S2） ----
  state.turnIndex += 1;
  pushHistory(state, template, {
    id: `t${state.turnIndex}-p`,
    type: "player_action",
    summary: action ? `${action.label}：${command.action.description || action.description || ""}` : command.action.description || "自由行动",
    visibility: "public",
  });

  // ---- 4. 占槽判定：行动钩子可产生 `hook` 槽（唯一能写 slot 的自由行动路径） ----
  resolveHooksV2(state, template, lookup, rng, command.action.type);

  // ---- 5. 模拟域结算（只在自由行动轮执行） ----
  /**
   * 回复按**全部已声明资源**遍历（ADR-003 D8）：hp/mp 与自定义资源同一条路径，
   * 缺省键 = 0。这样「每回合回 1 个能量豆」不需要改引擎。
   */
  const bonus = template.regen.actions?.[command.action.type];
  for (const key of Object.keys(template.resources)) {
    // ADR-003 D12：回复量可以是常数，也可以是「基础值 + 属性加权」。
    const regen =
      resolveRegenAmount(template.regen.perTurn[key], state.player.attributes) +
      resolveRegenAmount(bonus?.[key], state.player.attributes);
    if (regen > 0) adjustResourceValue(state.player, template, key, regen);
  }
  tickSimulationStatuses(state, lookup, command.action.type === "rest", amountToMinutes(elapsed));
  state.player.mood = Math.max(template.mood.min, Math.min(template.mood.max, state.player.mood));

  // ---- 6. 其他判定：NPC 自主行动 → pool（pool 只入队；槽已被占时天然跳过） ----
  postSettleJudgements(state, template, lookup, rng);

  // ---- 7. nextTurn：槽有则呈现、槽空则扫队列 ----
  nextTurn(state, template, lookup, rng, result);

  // ---- 8. 终止边界 ----
  const requested = command.endLife === true;
  applyEndingBoundary(state, lookup, rng, pipeline, {
    atBoundary: true,
    boundary: requested ? "playerRequested" : "afterTimeAdvance",
    playerRequested: requested,
  });

  const snapshot = revalidateThenProject(state, template, lookup, pipeline, result, true);
  return {
    state,
    snapshot,
    elapsed,
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    // 先过滤再截断（R-VS-02 / design §2.3）：hidden 条目不占 20 条窗口
    playerVisibleHistory: playerVisibleHistory(state, 20),
  };
}

/**
 * 模拟域每**行动轮**结算（ADR-009 D3）。
 *
 * 这里做的两件事都确实是「每做一个决定结算一次」，与时间流逝无关：
 * `moodDeltaPerTurn`（心情的自然漂移）与 `restDays`（休息**行为**的累计）。
 *
 * 到期**不在这里数**：`expiresAt` 是绝对时刻，由 `pruneExpiredStatuses` 在时间变化处剪掉。
 * 旧实现把「还剩几轮」存在实例上每轮 -1，于是状态只在自由行动里缩水，事件 `advanceTo`
 * 跨了几年它都原地不动——那个数字当时数的其实是「玩家点了几次」，不是时间。
 */
function tickSimulationStatuses(
  state: WorldStateV2,
  lookup: TemplateLookup,
  isRest: boolean,
  /** 本轮行动消耗的世界时间（分钟）：`restDays` 按它累计，而不是按「休息了几次」 */
  elapsedMinutes: number,
): void {
  // 先剪掉「行动这段时间里已经到期」的：否则一条刚过期的状态还会多扣一次心情。
  pruneExpiredStatuses(state);
  const remaining: typeof state.player.statuses = [];
  for (const inst of state.player.statuses) {
    const def = lookup.status(inst.statusId);
    if (!def) continue;
    const sim = def.simulation;
    if (sim?.moodDeltaPerTurn) {
      state.player.mood += sim.moodDeltaPerTurn * inst.stacks;
    }
    const restCure = def.cureConditions?.find((c) => "restDays" in c);
    if (restCure && "restDays" in restCure) {
      inst.restProgress = (inst.restProgress ?? 0) + (isRest ? elapsedMinutes : 0);
      if (inst.restProgress >= restCure.restDays * UNIT_MINUTES.day) continue; // 痊愈
    }
    remaining.push(inst);
  }
  state.player.statuses = remaining;
}

// ---------- 玩家选项 ----------

export function chooseOptionV2(
  state: WorldStateV2,
  command: ChooseOptionCommand,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
  // ADR-0024 决策 2.3 #2（权威门）：即便状态被外部改坏 / 旧档残留，也绝不允许结算前提已假的事件。
  const droppedAtEntry = revalidateSlot(state, lookup).dropped;
  if (droppedEventOwnsOption(droppedAtEntry, command.optionId, lookup)) {
    // 决策 8：与 option_not_available 分开 —— 客户端据此提示「状态已过期，请重取快照」。
    throw new Error("event_premise_invalidated");
  }
  if (state.battle !== null && !state.battle.over) throw new Error("battle_in_progress");
  const scene = state.slot;
  if (scene === null) throw new Error("no_pending_event");
  const event = lookup.event(scene.eventId);
  if (!event || event.kind !== "normal") throw new Error("event_not_normal");

  const rng = createRng(deriveTurnSeed(state.seed + 7, state.turnIndex));
  const ctx: ConditionContext = { state, lookup, rng };
  const option = event.settle.normal.options.find(
    (o) => o.id === command.optionId && checkAllConditions(o.visibleWhen, ctx),
  );
  if (!option) throw new Error("option_not_available");

  // 「本轮呈现集」在轮次起点清空（D-03）：守卫全部通过后才清
  state.lastWheels = [];

  // 事件级时间账（`timeCost`，缺省 0）：结算轮可以推进 turnIndex 而世界时间不动
  const settleAdapter = createTimeAdapter(template);
  const costMinutes = event.trigger.timeCost === undefined ? 0 : specToMinutes(event.trigger.timeCost, settleAdapter);
  if (costMinutes > 0) {
    state.worldTime += costMinutes;
    state.player.age = state.playerAgeAtStart + settleAdapter.elapsedYears(state.worldTime);
  }

  const result: TriggerResult = {
    triggered: [],
    wheelResult: null,
    ...(droppedAtEntry.length > 0 ? { droppedPending: [...droppedAtEntry] } : {}),
  };

  settleSlotEvent({
    state,
    template,
    lookup,
    result,
    def: event,
    applyEffects: () => {
      const optionCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
      applyEffectsV2(optionCtx, option.effects);
      // B-36 接线：选项结算的 `log` 旁白此前被收集后丢弃（29 处模板文本从未展示给玩家）。
      // 与 `useItemV2` 同口径：拼进本次结算的历史摘要。
      if (optionCtx.logs !== undefined && optionCtx.logs.length > 0) {
        pushHistory(state, template, {
          id: historyId(state, `t${state.turnIndex}-l-${event.id}`),
          type: "event",
          summary: optionCtx.logs.join("；"),
          visibility: "public",
        });
      }
      enqueueChainStarts(state, lookup, optionCtx.startedChains);
    },
    choiceText: option.text,
    optionId: option.id,
    ...(option.nextEventId !== undefined ? { nextEventId: option.nextEventId } : {}),
  });

  postSettleJudgements(state, template, lookup, rng);
  nextTurn(state, template, lookup, rng, result);

  /**
   * 终止边界（2026-11-19 补齐）：选项是**唯一靠 `effects` 写结局旗标的结算入口**。
   * 这里漏一次 `applyEndingBoundary`，玩家就会看到「结局条件已经成立，却还要再多点一轮才结束」
   * ——因为下一次 `advanceTurnV2` 才在时间推进边界判终止。
   * 与战斗 / 自由行动 / 转盘确认同口径：判据仍是落盘旗标，不读 HP 数值（R-EN-07 / P9）。
   */
  applyEndingBoundary(state, lookup, rng, pipeline, {
    atBoundary: true,
    boundary: "afterEventSettle",
  });

  const snapshot = revalidateThenProject(state, template, lookup, pipeline, result, true);
  return {
    state,
    snapshot,
    elapsed: minutesToAmount(costMinutes),
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: [],
  };
}

// ---------- 战斗行动 ----------

/**
 * 战斗命令（ADR-0034 §8-⑦）：**整场战斗是 `slot` 的内部过程，不额外推进轮次**。
 * 战斗结束即该事件"结算完成"，此后才做占槽判定与其他判定。
 */
export function battleActionV2(
  state: WorldStateV2,
  command: BattleCommand,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
  const droppedAtEntry = revalidateSlot(state, lookup).dropped;
  const battle = state.battle;
  if (!battle || battle.over) throw new Error("battle_not_active");
  const rng = createRng(deriveTurnSeed(state.seed + 13, state.turnIndex * 100 + battle.round));

  // 战斗判定与战斗 AI 各走独立子流；模拟主线 rng 本身不再被战斗消费。
  performBattleAction(state, command, lookup, createBattleRng(rng));

  const result: TriggerResult = {
    triggered: [],
    wheelResult: null,
    ...(droppedAtEntry.length > 0 ? { droppedPending: [...droppedAtEntry] } : {}),
  };

  if (battle.over) {
    const event = lookup.event(battle.eventId);
    const outcome = battle.over;
    const outcomeLabel = outcome === "victory" ? "胜利" : outcome === "defeat" ? "败北" : "撤离";
    state.lastWheels = [];
    if (event && event.kind === "combat") {
      const settle = event.settle.combat;
      const outcomeDef =
        outcome === "victory" ? settle.onVictory : outcome === "defeat" ? settle.onDefeat : settle.onFlee;
      // 先回写战斗镜像（状态转换/资源），再结算结果效果，避免镜像覆写结果状态
      finishBattle(state, lookup);
      // 战斗结束立即清会话：它是槽的内部过程，清得比任何触发都早 ⇒ 不会误伤后继 combat 事件
      state.battle = null;
      settleSlotEvent({
        state,
        template,
        lookup,
        result,
        def: event,
        applyEffects: () => {
          const outcomeCtx: EffectContextV2 = { state, lookup, rng, logs: [] };
          applyEffectsV2(outcomeCtx, outcomeDef?.effects);
          enqueueChainStarts(state, lookup, outcomeCtx.startedChains);
        },
        ...(outcomeDef?.nextEventId !== undefined ? { nextEventId: outcomeDef.nextEventId } : {}),
      });
    } else {
      // 定义缺失兜底：战斗会话照样结束，槽清空并推进一轮（否则玩家永久卡在战斗门禁上）
      finishBattle(state, lookup);
      state.battle = null;
      assignSlot(state, null);
      state.turnIndex += 1;
    }
    // 战斗结果作为可展示事件返回，前端在结果区呈现胜负
    result.triggered.push({
      id: `battle-${battle.eventId}`,
      title: `战斗${outcomeLabel}`,
      narrative:
        outcome === "victory"
          ? "你击溃了敌人，尘埃落定。"
          : outcome === "defeat"
            ? "你身负重伤，勉强脱离了危险。"
            : "你趁隙脱离了战斗。",
    });

    postSettleJudgements(state, template, lookup, rng);
    nextTurn(state, template, lookup, rng, result);

    // 战败边界：先走死亡路径（具体），再走终止条件（一般）。
    // 判死只看 battleDefeat 信号，不读取 HP 数值（R-EN-07 / P9）。
    applyDeathRouteInPlace(state, lookup, rng, pipeline, outcome === "defeat");
    applyEndingBoundary(state, lookup, rng, pipeline, {
      atBoundary: true,
      boundary: "afterBattleSettle",
      battleDefeat: outcome === "defeat",
    });
  }

  const snapshot = revalidateThenProject(state, template, lookup, pipeline, result, true);
  return {
    state,
    snapshot,
    elapsed: { value: 0, unit: "minute" },
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: [],
  };
}

// ---------- 战斗外用物品 ----------

export function useItemV2(
  state: WorldStateV2,
  command: UseItemCommand,
  template: WorldTemplateV2,
  lookup: TemplateLookup,
  pipeline?: TurnPipelineConfig,
): V2TurnResult {
  assertActive(state);
  // ADR-0034 §5：用物品**不受槽占用限制**（用户原话「不占槽、独立于轮次结算」）。
  // 战斗进行中仍然拒绝：物品的 `usableOutsideBattle` 语义没有变。
  if (state.battle !== null && !state.battle.over) throw new Error("battle_in_progress");
  const item = lookup.item(command.itemId);
  if (!item) throw new Error("item_not_found");
  if (!item.usableOutsideBattle) throw new Error("item_not_usable");
  if ((state.player.inventory[item.id] ?? 0) <= 0) throw new Error("item_not_owned");

  const rng = createRng(deriveTurnSeed(state.seed + 29, state.turnIndex));
  // 用物品是**轮外操作**（不推进 turnIndex、不占槽），故不清空 lastWheels：
  // 它属于「本轮已发生的转盘」，本轮尚未结束（D-03「当轮」语义）。
  state.player.inventory[item.id] -= 1;
  if (state.player.inventory[item.id] <= 0) delete state.player.inventory[item.id];
  const logs: string[] = [];
  const result: TriggerResult = { triggered: [], wheelResult: null };
  const itemCtx: EffectContextV2 = { state, lookup, rng, logs };
  applyEffectsV2(itemCtx, item.use);
  // ADR-0034 §2 R1：轮外入口**不跑 nextTurn**（不扫队列、不呈现新事件）。
  // `enqueueEvent` 产生的实例留在 `delayQueue`，等下一次「推进轮次的入口」才可能被取出。
  enqueueChainStarts(state, lookup, itemCtx.startedChains);
  pushHistory(state, template, {
    id: `t${state.turnIndex}-i-${item.id}`,
    type: "player_action",
    summary: `使用了「${item.name}」${logs.length > 0 ? `：${logs.join("；")}` : ""}`,
    visibility: "public",
  });

  // 物品效果结算完成 → 终止边界（部分物品会推进时间）
  applyEndingBoundary(state, lookup, rng, pipeline, {
    atBoundary: true,
    boundary: "afterEventSettle",
  });

  // ADR-0037 D11：用物品是**轮外操作**（不推进 turnIndex）⇒ 不推进 DAG。
  const snapshot = revalidateThenProject(state, template, lookup, pipeline, result, false);
  return {
    state,
    snapshot,
    elapsed: { value: 0, unit: "minute" },
    triggeredEvents: result.triggered,
    wheelResult: result.wheelResult,
    playerVisibleHistory: [],
  };
}

// ---------- 呈现槽视图（选项按 visibleWhen 过滤） ----------

/**
 * 槽的呈现视图（ADR-0034 §5 / §8-⑩）：**效果未应用、`turnIndex` 不变**。
 *
 * `kind` 是前端的**行为开关**：`normal` 呈现选项、`random` 呈现已掷出的那一格并等待"确认"、
 * `combat` 走战斗面板。空槽返回 `null`。
 */
export function slotEventView(state: WorldStateV2, lookup: TemplateLookup): SlotEventView | null {
  const scene = state.slot;
  if (scene === null) return null;
  const event = lookup.event(scene.eventId);
  if (!event) return null;
  // ADR-0024 决策 2.3 #6（只读防御）：前提已假 ⇒ 不呈现（正常流程已在呈现前复核过）。
  const premiseRng = scanStream(state);
  if (!checkEventPremise(event, { state, lookup, rng: premiseRng }).ok) return null;

  if (event.kind === "normal") {
    const rng = createRng(deriveTurnSeed(state.seed + 7, state.turnIndex));
    const ctx: ConditionContext = { state, lookup, rng };
    return {
      eventId: event.id,
      from: scene.from,
      kind: "normal",
      title: event.title,
      narrative: event.narrative,
      options: event.settle.normal.options
        .filter((o) => checkAllConditions(o.visibleWhen, ctx))
        .map((o) => ({ id: o.id, text: o.text })),
    };
  }
  if (event.kind === "random") {
    // 呈现时已掷出（`presentRandomSlot` 写入 `lastWheels`）；这里只读出来给前端演。
    const shown = (state.lastWheels ?? []).find((w) => w.eventId === event.id);
    return {
      eventId: event.id,
      from: scene.from,
      kind: "random",
      title: event.title,
      narrative: event.narrative,
      ...(shown !== undefined ? { wheel: shown } : {}),
    };
  }
  return { eventId: event.id, from: scene.from, kind: "combat", title: event.title, narrative: event.narrative };
}
