import type { SlotSceneVM } from "@life-sim/shared";

export interface EventStageProps {
  /** 当前呈现槽；`null` = 空槽（可自由行动）。 */
  slot: SlotSceneVM | null;
}

/**
 * 场景舞台：渲染当前在演的那一格（标题 + 正文）。
 *
 * 空槽是**正常状态**而非错误（稀疏 LLM 参与下多数回合没有脚本场景），
 * 所以降级成「自由行动」引导区，而不是空白或占位骨架。
 * 正文缺省用 `?? ""`（服务端约定：不编造叙事、不回填标题）。
 */
export function EventStage({ slot }: EventStageProps) {
  if (slot === null) {
    return (
      <section className="ls-stage ls-stage--empty" data-slot="empty">
        <p className="ls-stage__badge">自由行动</p>
        <p className="ls-stage__hint">此刻没有正在上演的场景，去做点什么吧。</p>
      </section>
    );
  }
  return (
    <section className="ls-stage" data-slot="scene" data-event-id={slot.eventId}>
      <h2 className="ls-stage__title">{slot.title}</h2>
      <p className="ls-stage__narrative">{slot.narrative ?? ""}</p>
    </section>
  );
}
