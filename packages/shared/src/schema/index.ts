/**
 * 世界模板协议 V2 Schema 汇总导出。
 * 本目录是协议的单一事实来源：YAML 模板必须通过 WorldTemplateV2Schema 校验；
 * 运行时类型用 z.infer 派生（实现阶段以本目录替换 index.ts 的 V1 类型）。
 */

export * from "./common.js";
export * from "./character.js";
export * from "./skill.js";
export * from "./item.js";
export * from "./status-effect.js";
export * from "./npc-action.js";
export * from "./event.js";
export * from "./world.js";
export * from "./ending.js";
export * from "./event-instance.js";
export * from "./opening.js";
