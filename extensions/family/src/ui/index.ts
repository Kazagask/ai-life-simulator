/**
 * `@life-sim/ext-family/ui`：家族扩展自带的前端（`docs/EXTENSIONS.md` §7）。
 *
 * 组件、自己的视图模型（zod）、自己的样式都在这里；宿主只提供槽与渲染时机。
 * **不要**从这个入口导出引擎侧实现 —— 前端只能拿到 `ViewModel`（扩展切片是 `unknown`）。
 */
import "./styles.css";

export { familyUi, pedigreeView, clanView, WORLD_SUBVIEW_SLOT } from "./views.js";
export { familyUiData, toPedigreeVM, toClanVM, type FamilyUiData } from "./adapter.js";
export { PedigreePanel, type PedigreePanelProps } from "./PedigreePanel.js";
export { ClanPanel, type ClanPanelProps } from "./ClanPanel.js";
export type {
  PedigreeVM,
  PedigreeNodeVM,
  PedigreeEdgeVM,
  ClanVM,
  ClanHeadVM,
  ClanHistoryVM,
  ClanLegacyVM,
} from "./view-model.js";
