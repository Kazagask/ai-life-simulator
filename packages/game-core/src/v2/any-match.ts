import type {
  AnyMatch,
  AnyMatchPredicate,
  BattleResult,
  WorldStateV2,
  WorldTemplateV2,
} from "@life-sim/shared";
import { selfIdOf } from "./actors.js";

/**
 * `anyMatch`（ADR-075 §6）：集合 + 字段谓词。
 *
 * 为什么不是"再写一个条件类"：它要能同时读战果、玩家状态、背包、NPC 与关系边，
 * 每加一个集合就多一个条件类型会迅速把 DSL 变成 switch 迷宫。这里只有一张
 * **加载期已校验过的字段白名单** + 一个统一的谓词求值器。
 *
 * 单位集合**没有 `hp`**：逐单位精确血量既不该进条件，也会把 R-EN-07 从后门放回来。
 */

type Item = Record<string, unknown>;

export interface AnyMatchInput {
  state: WorldStateV2;
  /** 战评 hook 里传刚生成的那份；事件 / 死亡路由缺省读 `state.lastBattleResult`。 */
  battle?: BattleResult;
  /** 状态 kind 需要模板；缺省时 `kind` 字段读不到（谓词为假）。 */
  template?: WorldTemplateV2;
}

function unitItem(unit: {
  instanceId?: string;
  characterId?: string;
  ref?: string;
  name: string;
  tier?: "minion" | "hero";
  alive?: boolean;
  defeated?: boolean;
  damageByPlayer?: number;
  damageToPlayer?: number;
  killer?: boolean;
  summonedByPlayer?: boolean;
}, playerKillerId: string | undefined): Item {
  return {
    ref: unit.ref ?? unit.characterId,
    name: unit.name,
    tier: unit.tier ?? "minion",
    alive: unit.alive ?? !(unit.defeated ?? false),
    damageByPlayer: unit.damageByPlayer ?? 0,
    damageToPlayer: unit.damageToPlayer ?? 0,
    defeated: unit.defeated ?? !(unit.alive ?? true),
    killer: unit.killer ?? (unit.instanceId !== undefined && unit.instanceId === playerKillerId),
    summonedByPlayer: unit.summonedByPlayer ?? false,
  };
}

function itemsOf(over: AnyMatch["over"], input: AnyMatchInput): Item[] {
  const { state } = input;
  if (over.startsWith("battle.")) {
    const live = state.battle;
    if (live !== null) {
      const killerId = live.player.lastHitBy;
      const self = selfIdOf(state);
      const list =
        over === "battle.enemies" ? live.enemies : over === "battle.allies" ? live.allies : (live.neutrals ?? []);
      return list.map((unit) => ({
        ...unitItem(unit, killerId),
        summonedByPlayer: unit.summonedBy === self,
      }));
    }
    const result = input.battle ?? state.lastBattleResult;
    if (result === undefined) return [];
    // 战果只落了敌方；友军 / 中立在 lastBattleResult 里没有名单 ⇒ 空集合（不猜）。
    if (over !== "battle.enemies") return [];
    return result.enemies.map((unit) => unitItem(unit, undefined));
  }

  if (over === "player.statuses") {
    return state.player.statuses.map((inst) => ({
      statusId: inst.statusId,
      kind: input.template?.statuses.find((s) => s.id === inst.statusId)?.kind,
      stacks: inst.stacks,
      progress: inst.progress ?? 0,
    }));
  }
  if (over === "player.inventory") {
    return Object.entries(state.player.inventory).map(([itemId, count]) => ({ itemId, count }));
  }
  if (over === "npcs") {
    return state.npcs.map((npc) => ({
      id: npc.id,
      name: npc.name,
      lifecycle: npc.lifecycle.state,
      isEnemy: npc.isEnemy,
      visibility: npc.visibility,
    }));
  }
  return state.relations.map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    value: edge.value ?? 0,
    scope: edge.scope ?? "private",
    frozen: edge.frozen ?? false,
  }));
}

function predicateMet(item: Item, pred: AnyMatchPredicate): boolean {
  const value = item[pred.field];
  if (pred.eq !== undefined && value !== pred.eq) return false;
  if (pred.ne !== undefined && value === pred.ne) return false;
  if (pred.gt !== undefined && !(typeof value === "number" && value > pred.gt)) return false;
  if (pred.gte !== undefined && !(typeof value === "number" && value >= pred.gte)) return false;
  if (pred.lt !== undefined && !(typeof value === "number" && value < pred.lt)) return false;
  if (pred.lte !== undefined && !(typeof value === "number" && value <= pred.lte)) return false;
  if (pred.in !== undefined && !pred.in.some((candidate) => candidate === value)) return false;
  return true;
}

/** 集合里任意一项满足 `where` 的全部谓词即 true；空集合 / 缺上下文 ⇒ false。 */
export function anyMatchMet(match: AnyMatch, input: AnyMatchInput): boolean {
  return itemsOf(match.over, input).some((item) => match.where.every((pred) => predicateMet(item, pred)));
}
