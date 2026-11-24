// ---------- 协议 V2 引擎（主入口） ----------
export * from "./v2/lookup.js";
export * from "./v2/time.js";
export * from "./v2/engine.js";
// 资源公式（ADR-012：仪器与后台工具需要 initPlayerResources / maxHp 之外的口径）
export * from "./v2/resources.js";
export * from "./v2/battle.js";
export * from "./v2/battle-evaluation.js";
export * from "./v2/talent.js";
export * from "./v2/any-match.js";
export * from "./v2/equipment.js";
// ADR-015：技能封印（技能还在、但现在用不了）+ 原因文案，投影与前端共用一份
export * from "./v2/seal.js";
export * from "./v2/npc.js";
export * from "./v2/turn.js";
export * from "./v2/scheduler.js";
export * from "./v2/ending.js";
export * from "./v2/projection.js";
export * from "./v2/runner-context.js";
export * from "./v2/replay.js";
export * from "./v2/opening.js";
// ADR-001：前实例化开局会话内核（createOpeningSession / resolveStep / commitOpening）
export * from "./v2/opening-dag.js";
export * from "./v2/allocation.js";
// ADR-004：开局 DAG 的跨文件校验（加点目标 / 预算来源 / 节点引用）
export * from "./v2/opening-validate.js";
export * from "./v2/narrative.js";
export * from "./v2/narrative-text.js";
export * from "./v2/life-evaluation.js";
export * from "./v2/archive.js";
export * from "./v2/history.js";
export * from "./v2/equipment-turn.js";
// R2.6 关系图谱（ADR-0014）：R-REL-01 的查询 API 对外可见（建图/最短路径/投影）
export * from "./v2/relations.js";
// 表现层（ADR-002）：样式解析 / 效果摘要 / 固定效果文案 / 回合增量，均为只读投影
export * from "./v2/presentation/style.js";
export * from "./v2/presentation/media.js";
export * from "./v2/presentation/fx.js";
export * from "./v2/presentation/effects.js";
export * from "./v2/presentation/ledger.js";
export * from "./v2/presentation/fixed-effects.js";
export * from "./v2/presentation/gains.js";
// 扩展层接缝（docs/EXTENSIONS.md §2）：注册表 + 派生契约，扩展从这里 import
export * from "./v2/extensions.js";
// 演员表访问层（A 期 seam）：扩展需要 `selfIdOf` / `actorOf` 时从这里取，
// 不许自己写 `state.selfId ?? "player"` 这类第二份兜底。
export * from "./v2/actors.js";

// ---------- 确定性随机源（V2 引擎共用，非 V1 遗留） ----------
export * from "./rng.js";

// ---------- 阶段 B：引擎 API / 透视窗口 / 条件求值 / DAG / 知识授予（T-01/T-02/T-05a） ----------
export * from "./api/engine-api.js";
export * from "./api/perspective.js";
export * from "./v2/condition-evaluator.js";
export * from "./v2/knowledge-grants.js";

// ---------- 测试夹具（extensions/* 的用例也从这里拿，避免两份「最小模板」各自漂移） ----------
export * from "./v2/test-utils.js";
