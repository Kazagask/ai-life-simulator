import type {
  ActionVM,
  BattleVM,
  ContentBlockVM,
  MediaVM,
  V2Snapshot,
  ViewModel,
} from "@life-sim/shared";

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

/** 战斗镜像 → 展示模型（`id` 取引擎实例 id，只作 React key / 目标标识）。 */
export function toBattleVM(battle: NonNullable<V2Snapshot["battle"]>): BattleVM {
  return {
    round: battle.round,
    over: battle.over,
    player: {
      hp: battle.player.hp,
      maxHp: battle.player.maxHp,
      mp: battle.player.mp,
      maxMp: battle.player.maxMp,
    },
    enemies: battle.enemies.map((e) => ({
      id: e.instanceId,
      name: e.name,
      hp: e.hp,
      maxHp: e.maxHp,
      alive: e.alive,
    })),
    allies: battle.allies.map((a) => ({
      id: a.instanceId,
      name: a.name,
      hp: a.hp,
      maxHp: a.maxHp,
      alive: a.alive,
    })),
    log: [...battle.log],
  };
}

/**
 * 资源条派生：值取玩家当前 hp/mp，**标签取模板 `labels.resources`**（缺省才回退 "HP"/"MP"）。
 * `max` 归一为 ≥1，避免除零；不派生心情条（模板的心情是 0-100 的软量，不属于资源）。
 */
function deriveStatusBar(snapshot: V2Snapshot): ViewModel["statusBar"] {
  const labels = snapshot.labels.resources;
  const p = snapshot.player;
  return [
    { key: "hp", label: labels.hp ?? "HP", value: p.hp, max: Math.max(1, p.maxHp) },
    { key: "mp", label: labels.mp ?? "MP", value: p.mp, max: Math.max(1, p.maxMp) },
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

export function toViewModel({ snapshot, content, media }: ToViewModelInput): ViewModel {
  const slot = snapshot.slotEvent;
  return {
    player: { id: snapshot.player.id, name: snapshot.player.name },
    npcs: snapshot.npcs.map((n) => ({ id: n.id, name: n.name })),
    slot:
      slot === null
        ? null
        : {
            eventId: slot.eventId,
            title: slot.title,
            narrative: slot.narrative,
          },
    evaluation: { summary: snapshot.evaluation.summary },
    media: media ?? snapshot.media ?? [],
    content: content ?? [],
    availableActions: toActions(snapshot),
    formattedTime: snapshot.formattedTime,
    lifeStage: snapshot.lifeStage,
    lifeStageLabel: snapshot.lifeStageLabel,
    ...(snapshot.storyChapter !== undefined ? { storyChapter: snapshot.storyChapter } : {}),
    statusBar: deriveStatusBar(snapshot),
    battle: snapshot.battle === null ? null : toBattleVM(snapshot.battle),
    ending:
      snapshot.ending === undefined || snapshot.ending === null
        ? null
        : { title: snapshot.ending.title, summary: snapshot.ending.summary },
    ...(snapshot.llmPending !== undefined ? { llmPending: snapshot.llmPending } : {}),
    turnIndex: snapshot.turnIndex,
  };
}
