import type { V2Snapshot, WorldStateV2 } from "@life-sim/shared";

/**
 * GM 的**只读**工具（AGENTIC-GM 重构 · 设计 §3）。
 *
 * 一条查询一个工具，**不做上帝函数**：每个入参都对应一个独立语义，不存在"把整个世界给我"的口子。
 *
 * 视角：这些工具**不接受 perspective 参数**。视角在 invocation 时固定，
 * 数据来源是 `projectSnapshotV2` 已经裁好的 `V2Snapshot`（player 窗口）——
 * 也就是说"看不到的东西"在数据源上就不存在，不是靠过滤。
 *
 * 返回值一律是**给模型看的 JSON**，不带任何只对引擎有意义的字段（不泄露隐藏节点/敌人意图）。
 */
export const READ_TOOL_NAMES = [
  "world.now",
  "world.history",
  "world.present",
  "world.self",
  "world.clues",
] as const;

export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

export function isReadTool(name: string): name is ReadToolName {
  return (READ_TOOL_NAMES as readonly string[]).includes(name);
}

/** 历史默认条上限：防止一次查询把上下文撑爆。 */
const HISTORY_HARD_CAP = 50;

export interface ReadToolDeps {
  /** 已按 invocation 视角裁好的快照（player 窗口）。 */
  snapshot: V2Snapshot;
  /** 权威状态：只用于 history / world 窗口的全量读取。 */
  state: WorldStateV2;
  /**
   * 本次 invocation 的视角（由模板 `invoke.perspective` 声明，**不是工具参数**）。
   *
   * - `player` ⇒ 只读投影后的快照（看不到 hidden）；
   * - `world`  ⇒ 直读权威状态（GM 全知：含 NPC 隐秘与 hidden 章节节点）。
   *
   * 关键：模型**无法**通过传参改视角 —— 它连这个字段都看不见。
   */
  perspective: "world" | "player" | `npc:${string}`;
}

const isOmniscient = (perspective: ReadToolDeps["perspective"]): boolean =>
  perspective === "world";

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * 执行一次只读查询。未知工具名返回 `{ error }` 而不是抛——模型读错了不该炸整轮。
 */
export function runReadTool(name: string, rawArgs: unknown, deps: ReadToolDeps): unknown {
  const args = asRecord(rawArgs) ?? {};
  const { snapshot, state } = deps;

  switch (name) {
    case "world.now": {
      const slot = snapshot.slotEvent;
      return {
        turnIndex: snapshot.turnIndex,
        worldTime: snapshot.worldTime,
        time: snapshot.formattedTime,
        chapter: snapshot.storyChapter ?? null,
        slot:
          slot === null
            ? null
            : {
                eventId: slot.eventId,
                title: slot.title,
                kind: slot.kind,
                from: slot.from,
                // 玩家此刻能点的选项（与事件面板一致，不含隐藏选项）
                options: (slot.options ?? []).map((option) => ({ id: option.id, text: option.text })),
              },
        status: snapshot.status,
        lifeStage: snapshot.lifeStageLabel,
      };
    }

    case "world.history": {
      const all = state.history ?? [];
      const rawLimit = args.limit;
      const limit =
        typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), HISTORY_HARD_CAP)
          : HISTORY_HARD_CAP;
      // 取最近 limit 条（数组是 append 序，尾部最新）。
      const entries = all.slice(Math.max(0, all.length - limit)).map((entry) => ({
        turnIndex: entry.turnIndex,
        time: entry.formattedTime,
        type: entry.type,
        summary: entry.summary,
      }));
      return {
        entries,
        returned: entries.length,
        total: all.length,
        truncated: entries.length < all.length,
      };
    }

    case "world.present": {
      if (isOmniscient(deps.perspective)) {
        // GM 全知窗口：含未登场的、离场的、以及隐秘 refs（只给 id，不给展开内容）。
        return {
          npcs: state.npcs.map((npc) => ({
            id: npc.id,
            name: npc.name,
            lifecycle: npc.lifecycle.state,
            secrets: [...npc.secrets],
            goals: npc.goals !== undefined ? [...npc.goals] : [],
          })),
        };
      }
      return {
        npcs: snapshot.npcs.map((npc) => ({
          id: npc.id,
          name: npc.name,
          alive: npc.lifecycle?.state === "alive",
          relationship: npc.relationship,
          knownGoals: npc.knownGoals,
          statuses: npc.statuses.map((status) => status.name),
        })),
      };
    }

    case "world.self": {
      const player = snapshot.player;
      return {
        name: player.name,
        age: player.age,
        hp: player.hp,
        maxHp: player.maxHp,
        mp: player.mp,
        maxMp: player.maxMp,
        mood: player.mood,
        attributes: player.attributes,
        statuses: player.statuses.map((status) => status.name),
        skills: player.skills.map((skill) => skill.name),
        inventory: player.inventory.map((item) => ({ name: item.name, count: item.count })),
        equipment: (player.equipment ?? []).map((item) => ({ name: item.name, slot: item.slotLabel })),
      };
    }

    case "world.clues": {
      // 只出 public 节点：hidden 节点在投影阶段就不该出现，这里再挡一次。
      const nodes = (state.taskDag?.nodes ?? [])
        // player 窗口只出 public；world 窗口（GM 全知）出全部，含 hidden。
        .filter((node) => isOmniscient(deps.perspective) || node.visibility === "public")
        .map((node) => ({
          id: node.id,
          title: node.title,
          status: node.status,
          ...(isOmniscient(deps.perspective) ? { visibility: node.visibility } : {}),
        }));
      return { nodes };
    }

    default:
      return { error: `未知的只读工具：${name}` };
  }
}
