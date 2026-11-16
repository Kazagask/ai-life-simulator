// ---------- 协议 V2 引擎（主入口） ----------
export * from "./v2/lookup.js";
export * from "./v2/time.js";
export * from "./v2/engine.js";
export * from "./v2/battle.js";
export * from "./v2/npc.js";
export * from "./v2/turn.js";
export * from "./v2/scheduler.js";
export * from "./v2/ending.js";
export * from "./v2/projection.js";
export * from "./v2/runner-context.js";
export * from "./v2/replay.js";
export * from "./v2/opening.js";
export * from "./v2/narrative.js";
export * from "./v2/life-evaluation.js";
export * from "./v2/archive.js";
export * from "./v2/history.js";
export * from "./v2/equipment-turn.js";
// R2.6 关系图谱（ADR-0014）：R-REL-01 的查询 API 对外可见（建图/最短路径/称谓/投影）
export * from "./v2/relations.js";

// ---------- 确定性随机源（V2 引擎共用，非 V1 遗留） ----------
export * from "./rng.js";

// ---------- 阶段 B：引擎 API / 透视窗口 / 条件求值 / DAG / 知识授予（T-01/T-02/T-05a） ----------
export * from "./api/engine-api.js";
export * from "./api/perspective.js";
export * from "./v2/condition-evaluator.js";
export * from "./v2/knowledge-grants.js";
