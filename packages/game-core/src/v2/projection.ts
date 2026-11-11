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
import { createTimeAdapter } from "./time.js";
import type { TemplateLookup } from "./lookup.js";
import { pendingEventView } from "./turn.js";

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
        };
      }),
    },
    npcs: state.npcs.map((npc) => ({
      id: npc.id,
      name: npc.name,
      age: npc.age,
      genderLabel: lookup.genderLabel(npc.gender),
      personality: npc.personality,
      relationship: npc.relationship,
      knownGoals: [...npc.knownGoals],
    })),
    pendingEvent: ended ? null : pendingEventView(state, lookup),
    battle,
    lastWheel: state.lastWheel,
    activeChains: state.chains
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, status: c.status })),
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
    },
    status,
    ending: state.termination ? buildEndingView(state.termination, endings, state) : null,
  };
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
      canFlee: battle.settle.canFlee ?? false,
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
