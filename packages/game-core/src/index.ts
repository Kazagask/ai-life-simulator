// ---------- 协议 V2 引擎（主入口） ----------
export * from "./v2/lookup.js";
export * from "./v2/time.js";
export * from "./v2/engine.js";
export * from "./v2/battle.js";
export * from "./v2/npc.js";
export * from "./v2/turn.js";
export * from "./v2/ending.js";
export * from "./v2/projection.js";
export * from "./v2/runner-context.js";
export * from "./v2/replay.js";

// ---------- 确定性随机源（V2 引擎共用，非 V1 遗留） ----------
export * from "./rng.js";
