/**
 * 媒体槽位命名约定（纯函数，无 React 依赖）。
 *
 * 单独成模块是为了让 `adapter.ts`（投影层）也能复用同一判定 —— 若把 `isCgSlot`
 * 留在 `CgStage.tsx` 里，适配器为了一个正则就得 import 组件，判定也容易再长出第二份。
 */

/**
 * 全屏 CG 槽位：`slot` 以 `cg` 起头（`cg` / `cg.opening` / `cg-battle` …）。
 *
 * 为什么要约定：`MediaVM` 不带 `kind`（资源清单的 kind 不下发到展示层），
 * 展示层只有 `slot` 这一个稳定信号；模板侧把全屏插画槽统一冠以 `cg` 前缀即可自动上屏。
 */
export function isCgSlot(slot: string): boolean {
  return /^cg(?![a-z0-9])/i.test(slot);
}

/** 立绘槽位：`portrait` / `portrait.xxx` / `portrait-xxx`（与 CG 前缀对称）。 */
export function isPortraitSlot(slot: string): boolean {
  return /^portrait(?![a-z0-9])/i.test(slot);
}

/**
 * 可进内联图位的槽位（`scene*` 只内联，横幅仍只认 `cg*`）。
 *
 * 与横幅口径的区别：顶部横幅（`CgStage`）只认 `cg*`，因为横幅是**模板声明**的
 * 展示位；`scene*` 只能由内容块指名后内联，不参与横幅。两者不共用这个判定。
 *
 * 两类算内联图位：
 *  - `cg*` —— 模板声明的全屏插画槽（设计约定）；
 *  - `scene*` —— 引擎内联块实际使用的槽位。`content.referenceAsset` 落库时
 *    `state.media` 直接抄块的 `slot`（`packages/game-core/src/api/engine-api.ts`
 *    的 `content.referenceAsset` 分支），而 provider 下发的内联块就是 `slot: "scene"`
 *    （`agent-runtime/src/providers/mock.ts` 的 `narrativeCalls`），
 *    只认 `cg` 会让真实场景图永远上不了屏。
 *
 * 立绘与道具图标一律排除：它们各有自己的排面（立绘排 / 物品格），
 * 混进 CG 位会把真正的场景图挤掉（review 反例：`[asset(portrait.lucy), asset(cg.opening)]`）。
 */
export function isVisualSlot(slot: string): boolean {
  return isCgSlot(slot) || /^scene(?![a-z0-9])/i.test(slot);
}
