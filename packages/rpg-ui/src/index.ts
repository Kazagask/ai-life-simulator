/**
 * @life-sim/rpg-ui 公共入口。
 *
 * P0 用「exports 直连源码」被 apps/web import，不引入 vite lib 模式 / d.ts emit / 额外构建步骤
 * （这是可升级的实现选型：需要独立发布时再补构建链）。
 *
 * 组件契约：**只接受 `ViewModel` 及其子类型**（来自 @life-sim/shared 的 contract/view-model），
 * 不接受引擎快照；引擎快照 → ViewModel 的搬运只发生在 `./adapter.ts`（可被自定义前端复用）。
 */
import "./styles.css";

export const RPG_UI_VERSION = "0.2.0" as const;

export { EventStage } from "./EventStage.js";
export type { EventStageProps } from "./EventStage.js";

export { ActionBar } from "./ActionBar.js";
export type { ActionBarProps } from "./ActionBar.js";

export { WorldClock } from "./WorldClock.js";
export type { WorldClockProps } from "./WorldClock.js";

export { NarrativeStream } from "./NarrativeStream.js";
export type { NarrativeStreamProps, BlockRenderer } from "./NarrativeStream.js";

export { OptionDeck } from "./OptionDeck.js";
export type { OptionDeckProps } from "./OptionDeck.js";

export { BattleBoard } from "./BattleBoard.js";
export type { BattleBoardProps } from "./BattleBoard.js";

export { WheelPanel } from "./WheelPanel.js";
export type { WheelPanelProps } from "./WheelPanel.js";

export { CharacterSheet } from "./CharacterSheet.js";
export type { CharacterSheetProps } from "./CharacterSheet.js";

export { EvaluationPanel } from "./EvaluationPanel.js";
export type { EvaluationPanelProps } from "./EvaluationPanel.js";

export { AiNarrativeTag } from "./AiNarrativeTag.js";

export { NpcCard } from "./NpcCard.js";
export type { NpcCardProps } from "./NpcCard.js";

export { RelationList } from "./RelationList.js";
export type { RelationListProps } from "./RelationList.js";

/** 扩展前端槽（`docs/EXTENSIONS.md` §7）：宿主给槽，扩展挂载。 */
export {
  registerExtensionUi,
  resetExtensionUi,
  extensionViewsFor,
} from "./extension-slots.js";
export type { ExtensionView, ExtensionUiRuntime, ExtensionViewHost } from "./extension-slots.js";

export { CharacterPanel, SlotTile } from "./CharacterPanel.js";
export type { CharacterPanelProps, SlotTileProps } from "./CharacterPanel.js";
export { StatsPanel } from "./StatsPanel.js";
export type { StatsPanelProps } from "./StatsPanel.js";
export { BagPanel } from "./BagPanel.js";
export type { BagPanelProps, BagPartition } from "./BagPanel.js";
export { AssetDetail } from "./AssetDetail.js";
export type { AssetDetailProps } from "./AssetDetail.js";
export { SkillList } from "./SkillList.js";
export type { SkillListProps } from "./SkillList.js";
export { EventPanel } from "./EventPanel.js";
export type { EventPanelProps } from "./EventPanel.js";
export { GmWorkingStrip } from "./GmWorkingStrip.js";
export type { GmWorkingStripProps } from "./GmWorkingStrip.js";
export { buildSlotCells, isSlotSelected } from "./personal.js";
export type { PersonalSelection, SlotCell } from "./personal.js";

export {
  MAX_ACT_TEXT,
  MAX_ACT_TYPE,
  FREE_ACTION_TYPE,
  clampActText,
  toActPayload,
  interactionMode,
} from "./act.js";
export type { Act, ActHandler, ActRequest, InteractionMode } from "./act.js";

export { Portrait } from "./Portrait.js";
export type { PortraitProps } from "./Portrait.js";

export { CgStage, isCgSlot } from "./CgStage.js";
export type { CgStageProps } from "./CgStage.js";

export { isPortraitSlot } from "./slots.js";

export { StatusBars } from "./StatusBars.js";
export type { StatusBarsProps } from "./StatusBars.js";

export { toViewModel, toBattleVM, toWheelVM, DANGER_RATIO, firstInlineCgBlock } from "./adapter.js";
export type { ToViewModelInput } from "./adapter.js";

export type {
  ViewModel,
  PlayerVM,
  SlotSceneVM,
  EvaluationVM,
  MediaVM,
  ContentBlockVM,
  NpcVM,
  ActionVM,
  StatusBarVM,
  BattleVM,
  BattlePlayerVM,
  BattleCombatantVM,
  PlayerAttributeVM,
  EvaluationDimensionVM,
  NpcRelationVM,
  EquipmentVM,
  EquipmentSlotVM,
  InventoryItemVM,
  SkillVM,
  EventOptionVM,
  StatusVM,
  WheelVM,
  EndingVM,
} from "@life-sim/shared";
