import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  BattleCommand,
  BattleEnemy,
  StatusInstance,
  UiConfig,
  WorldTemplateV2,
} from "@life-sim/shared";
import { BattleCommandSchema } from "@life-sim/shared";
import {
  applyStatusToPlayer,
  createBattleRng,
  createLookup,
  createRng,
  deriveTurnSeed,
  evaluateBattle,
  finishBattle,
  effectiveAttributesOfActor,
  maxHp,
  maxMp,
  performBattleAction,
  projectSnapshotV2,
} from "@life-sim/game-core";
import { chooseCommand, createSimSetup, type SimDuelSpec, type SimSetup } from "./sim.js";
import type { TemplateRegistry } from "../templates.js";

/**
 * 后台「战斗演练」：和木桩共用 `createSimSetup`，但一回合一回合地走。
 *
 * 这里不放任何战斗规则：挑招由人点、伤害由 `performBattleAction` 算、展示走
 * `projectSnapshotV2` → `BattleView`。战斗中临时加属性/状态/装备/技能只改现场，
 * 不落盘、不回写世界列表——它就是个带真实内核的试验台。
 */

type SpecParser = (value: unknown) => SimDuelSpec | null;

/**
 * 这一次行动的根随机流。
 *
 * 不能复用 `session.setup.rng`：`createBattleRng` 在**当前游标**派生，而 fork 不推进父流，
 * 于是每一回合都从同一处派生 ⇒ 每回合的命中/暴击骰完全相同（要么永远暴击，要么永远不）。
 * 与生产入口 `battleActionV2` 用同一条公式（seed+13、turnIndex×100+round），
 * 演练场才会和真实战斗给出同一个分布。
 */
function actionRootRng(setup: SimSetup) {
  const { state } = setup;
  return createRng(deriveTurnSeed(state.seed + 13, state.turnIndex * 100 + (state.battle?.round ?? 0)));
}

interface LiveSession {
  id: string;
  setup: SimSetup;
  spec: SimDuelSpec;
  version: string;
  maxRounds: number;
  /** `ui.yaml`（展示域）：不给的话轨迹只剩默认红箭头，苍/赫/茈的个人色与黑闪全都消失。 */
  ui?: UiConfig;
}

const sessions = new Map<string, LiveSession>();
const MAX_SESSIONS = 32;

function viewOf(session: LiveSession) {
  const { state, template, lookup } = session.setup;
  const snapshot = projectSnapshotV2(
    state,
    template,
    lookup,
    undefined,
    undefined,
    session.ui,
  );
  return {
    /** 每个响应都带 token：前端每次 setLive 后仍能用同一个会话继续发命令。 */
    token: session.id,
    battle: snapshot.battle,
    template: { id: template.meta.id, version: session.version },
    resourceLabels: {
      hp: (template.statusBar?.find((s) => s.key === "hp")?.label ?? "生命"),
      // 兜底用协议字段名（`MP`），不替某个世界写成「咒力」：管理端也会开别的模板。
      mp: (template.statusBar?.find((s) => s.key === "mp")?.label ?? "MP"),
    },
  };
}

function targetUnit(session: LiveSession, raw: unknown): BattleEnemy | undefined {
  const battle = session.setup.state.battle;
  if (!battle) return undefined;
  const id = typeof raw === "string" ? raw : undefined;
  return (
    [...battle.enemies, ...battle.allies, ...battle.neutrals].find((u) => u.instanceId === id) ??
    battle.enemies[0]
  );
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/**
 * 后台补丁用的状态实例（ADR-018）：只有 `battle` 档能在战斗里临时挂上，
 * 且不写时长 = 撑到战斗结束。世界状态不在这里补 —— 那是世界的事，
 * 用后台硬塞会让「面板与存档不一致」这种最难查的 bug 出现。
 */
function battleStatusInstance(session: LiveSession, statusId: string): StatusInstance | null {
  const def = session.setup.lookup.status(statusId);
  if (!def || def.kind !== "battle") return null;
  const state = session.setup.state;
  return {
    statusId,
    stacks: 1,
    appliedTurn: state.turnIndex,
    appliedAt: state.worldTime,
  };
}

function applyPatch(session: LiveSession, raw: unknown): { applied: string[]; error?: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const applied: string[] = [];
  const { state, template, lookup } = session.setup;
  const battle = state.battle;
  if (!battle) return { applied, error: "battle_not_active" };

  const attributes = numberRecord(body.attributes);
  const addStatuses = stringList(body.addStatuses);
  const removeStatuses = new Set(stringList(body.removeStatuses));
  const addSkills = stringList(body.addSkills);
  const addEquipment = stringList(body.addEquipment);
  const target = body.target === "enemy" ? "enemy" : "player";

  if (target === "player") {
    if (attributes) {
      Object.assign(state.player.attributes, attributes);
      // ADR-074：上限读有效属性（派生/换算之后的值），不能拿基础值夹。
      const eff = effectiveAttributesOfActor(state, lookup, state.player);
      const hpCap = maxHp(state.player, template, eff);
      const mpCap = maxMp(state.player, template, eff);
      state.player.hp = Math.min(state.player.hp, hpCap);
      state.player.mp = Math.min(state.player.mp, mpCap);
      battle.player.hp = Math.min(battle.player.hp, hpCap);
      battle.player.mp = Math.min(battle.player.mp, mpCap);
      applied.push(`属性 ${Object.keys(attributes).join("/")}`);
    }
    for (const id of addSkills) {
      if (!state.player.skills.includes(id)) {
        state.player.skills.push(id);
        applied.push(`技能 ${id}`);
      }
    }
    for (const id of addEquipment) {
      if (!state.player.equipment?.some((e) => e.itemId === id)) {
        state.player.equipment = [
          ...(state.player.equipment ?? []),
          {
            instanceId: `live-eq-${randomUUID().slice(0, 8)}`,
            itemId: id,
            ownerId: state.player.id,
            slot: lookup.item(id)?.slot ?? "weapon",
          },
        ];
        applied.push(`装备 ${id}`);
      }
    }
    for (const id of addStatuses) {
      // 同一个状态重复加会产生两条同 id 实例：投影里 React key 撞车，数值上也说不清是叠层还是重复。
      if (
        state.player.statuses.some((s) => s.statusId === id) ||
        battle.player.statuses.some((s) => s.statusId === id)
      ) {
        continue;
      }
      const before = state.player.statuses.length;
      applyStatusToPlayer(state, id, 1, lookup);
      if (state.player.statuses.length > before) {
        battle.player.statuses.push(state.player.statuses[state.player.statuses.length - 1]!);
        applied.push(`状态 ${id}`);
      } else {
        const inst = battleStatusInstance(session, id);
        if (inst) {
          battle.player.statuses.push(inst);
          applied.push(`战斗状态 ${id}`);
        }
      }
    }
    if (removeStatuses.size > 0) {
      state.player.statuses = state.player.statuses.filter((s) => !removeStatuses.has(s.statusId));
      battle.player.statuses = battle.player.statuses.filter((s) => !removeStatuses.has(s.statusId));
      applied.push(`移除状态 ${[...removeStatuses].join("/")}`);
    }
    if (typeof body.hp === "number" && Number.isFinite(body.hp)) {
      battle.player.hp = Math.max(1, Math.round(body.hp));
      applied.push(`HP ${battle.player.hp}`);
    }
    if (typeof body.mp === "number" && Number.isFinite(body.mp)) {
      battle.player.mp = Math.max(0, Math.round(body.mp));
      applied.push(`MP ${battle.player.mp}`);
    }
  } else {
    const unit = targetUnit(session, body.enemyInstanceId);
    if (!unit) return { applied, error: "enemy_not_found" };
    if (attributes) {
      Object.assign(unit.attributes, attributes);
      applied.push(`${unit.name} 属性 ${Object.keys(attributes).join("/")}`);
    }
    for (const id of addSkills) {
      if (!unit.skills.includes(id)) {
        unit.skills.push(id);
        applied.push(`${unit.name} 技能 ${id}`);
      }
    }
    for (const id of addStatuses) {
      if (unit.statuses.some((s) => s.statusId === id)) continue;
      const inst = battleStatusInstance(session, id);
      if (inst) {
        unit.statuses.push(inst);
        applied.push(`${unit.name} 状态 ${id}`);
      }
    }
    if (removeStatuses.size > 0) {
      unit.statuses = unit.statuses.filter((s) => !removeStatuses.has(s.statusId));
      applied.push(`${unit.name} 移除状态 ${[...removeStatuses].join("/")}`);
    }
    if (typeof body.hp === "number" && Number.isFinite(body.hp)) {
      unit.hp = Math.max(0, Math.round(body.hp));
      applied.push(`${unit.name} HP ${unit.hp}`);
    }
  }
  return { applied };
}

/**
 * 战斗已结束：**当场算好战评**并留在 `battle.evaluation`（ADR-077）。
 *
 * 与生产入口同一口径：结束不再当场收场，前端先看到最后一击 + 战评，点「继续」才推进。
 * 只算一次 —— 重算会把战评钩子（天赋 / 旗标）在同一次战斗里跑两遍。
 */
function evaluateIfOver(session: LiveSession): void {
  const { state, lookup } = session.setup;
  const battle = state.battle;
  if (!battle || battle.over === null || battle.evaluation !== undefined) return;
  battle.evaluation = evaluateBattle(state, battle, lookup, actionRootRng(session.setup));
}

/**
 * 「继续」：收场，然后用同一个 spec / seed **重开一场**。
 *
 * 演练场是仪器不是存档：收场之后没有「下一轮世界」可走，重开一场才是它的常态。
 */
function leaveBattle(session: LiveSession): void {
  const { state, template, lookup } = session.setup;
  const battle = state.battle;
  if (!battle || battle.over === null) return;
  const evaluated =
    battle.evaluation ?? evaluateBattle(state, battle, lookup, actionRootRng(session.setup));
  finishBattle(state, lookup, evaluated);
  state.battle = null;
  session.setup = createSimSetup(template, session.spec, state.seed);
}

/** 挂到只在 `LIFE_SIM_ADMIN=1` 下注册的 Fastify 实例上。 */
export function registerLiveBattleRoutes(
  app: FastifyInstance,
  registry: TemplateRegistry,
  parseSpec: SpecParser,
): void {
  app.post("/api/admin/battle/start", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const templateId = typeof body.templateId === "string" ? body.templateId : undefined;
    const version = typeof body.version === "string" ? body.version : undefined;
    const spec = parseSpec(body.spec);
    if (templateId === undefined || version === undefined || spec === null) {
      return reply.code(400).send({ error: "bad_request", detail: "需要 templateId、version 与 spec" });
    }
    const entry = registry.resolve({ id: templateId, version });
    if (!entry) return reply.code(404).send({ error: "template_not_ready" });
    const seed = typeof body.seed === "number" && Number.isFinite(body.seed) ? body.seed : 1;
    try {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      const setup = createSimSetup(entry.template, spec, seed);
      const session: LiveSession = { id: randomUUID(), setup, spec, version, maxRounds: 100, ui: entry.ui };
      sessions.set(session.id, session);
      return { ...viewOf(session), token: session.id, spec };
    } catch (error) {
      return reply.code(400).send({ error: "sim_setup_failed", detail: String(error) });
    }
  });

  app.get("/api/admin/battle/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = sessions.get(token);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    return viewOf(session);
  });

  app.post("/api/admin/battle/:token/command", async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = sessions.get(token);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    const battle = session.setup.state.battle;
    if (!battle) return reply.code(409).send({ error: "battle_not_active" });
    const parsed = BattleCommandSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_command", detail: parsed.error.message });
    const command: BattleCommand = parsed.data;
    // ADR-077：结束态只接受「继续」
    if (command.type === "leave") {
      if (battle.over === null) return reply.code(409).send({ error: "battle_not_active" });
      leaveBattle(session);
      return viewOf(session);
    }
    if (battle.over !== null) return reply.code(409).send({ error: "battle_over" });
    if (battle.round > session.maxRounds) return reply.code(409).send({ error: "round_limit_reached" });
    performBattleAction(session.setup.state, command, session.setup.lookup, createBattleRng(actionRootRng(session.setup)));
    evaluateIfOver(session);
    return viewOf(session);
  });

  /** 让仪器替玩家挑一招；挑招逻辑与木桩同一函数，不另写一套。 */
  app.post("/api/admin/battle/:token/auto", async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = sessions.get(token);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    const battle = session.setup.state.battle;
    if (!battle || battle.over) return reply.code(409).send({ error: "battle_not_active" });
    const command = chooseCommand(session.setup.state, session.setup.lookup, session.setup.maxHpValue, "damage");
    performBattleAction(session.setup.state, command, session.setup.lookup, createBattleRng(actionRootRng(session.setup)));
    evaluateIfOver(session);
    return { ...viewOf(session), command };
  });

  app.post("/api/admin/battle/:token/patch", async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = sessions.get(token);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    const result = applyPatch(session, request.body);
    if (result.error) return reply.code(409).send({ error: result.error });
    return { ...viewOf(session), applied: result.applied };
  });

  app.delete("/api/admin/battle/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    sessions.delete(token);
    return { ok: true };
  });
}

/** 仅给测试用：清空内存里的演练会话。 */
export function resetLiveBattleSessions(): void {
  sessions.clear();
}
