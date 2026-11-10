import type {
  BattleView,
  V2Snapshot,
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
): V2Snapshot {
  const player = state.player;
  const genderLabel = lookup.genderLabel(player.gender);
  const adapter = createTimeAdapter(template);
  const lifeStage = adapter.resolveLifeStage(player.age);

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
    pendingEvent: pendingEventView(state, lookup),
    battle,
    lastWheel: state.lastWheel,
    activeChains: state.chains
      .filter((c) => c.status === "active")
      .map((c) => ({ id: c.id, status: c.status })),
    availableActions: (template.actions ?? []).map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description ?? "",
      duration: a.duration,
    })),
    evaluation: {
      summary: evaluateSummaryV2(state, template),
      canonDeviation: typeof state.flags.canonDeviation === "number" ? state.flags.canonDeviation : 0,
    },
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

function evaluateSummaryV2(state: WorldStateV2, template: WorldTemplateV2): string {
  const attrs = Object.values(state.player.attributes);
  const growth = attrs.length > 0 ? attrs.reduce((a, b) => a + b, 0) / attrs.length : 0;
  const milestones = Object.entries(state.flags).filter(
    ([key, value]) => key.startsWith("milestone:") && value === true,
  ).length;
  const relations = state.npcs.map((n) => n.relationship);
  const relationAvg = relations.length > 0 ? relations.reduce((a, b) => a + b, 0) / relations.length : 0;
  const overall = Math.min(100, growth * 4 + milestones * 10 + (relationAvg + 100) / 10);
  void template;
  return overall >= 70
    ? "你的咒力与心性都在急速成长，命运的轨迹已被你搅动。"
    : overall >= 40
      ? "你在高专的日子平稳推进，机会与危险都还在前方。"
      : "你还只是个初出茅庐的咒术师，前路漫长而未知。";
}
