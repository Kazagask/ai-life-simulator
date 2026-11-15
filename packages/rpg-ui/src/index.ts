/**
 * Wave 1A 占位：RPG UI 组件在后续波次实现。
 * P0 用「exports 直连源码」即可被 apps/web import，不引入 vite lib 模式 / d.ts emit / 额外构建步骤
 * （这是可升级的实现选型：需要独立发布时再补构建链）。
 */
export const RPG_UI_VERSION = "0.1.0" as const;

export type {
  ViewModel,
  PlayerVM,
  SlotSceneVM,
  EvaluationVM,
  MediaVM,
  ContentBlockVM,
  NpcVM,
} from "@life-sim/shared";
