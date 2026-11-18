import { z } from "zod";
import { StyleSpecSchema } from "./style.js";

/**
 * `ui.yaml` —— 模板的展示层声明（形状 B：落位）。
 *
 * 边界（specs/SPEC.md §1.5）：
 * - 引擎不读它：判定、结算、投影内容都不受它影响；
 * - 它进白名单但**不进语义指纹**：改一个页签不该让旧存档拒载；
 * - 缺省等于现状：不写文件、或只写几项 ⇒ 其余能力保持当前内建布局。
 *
 * 能力 id 集合分两层：
 * - `BUILTIN_UI_CAPABILITIES` 是宿主内建能力，闭合在本文件（协议）；
 * - 扩展能力 id 由 `ExtensionRuntime.uiCapabilities` 声明，加载期合并校验。
 *   schema 这里只约束 id 非空字符串，未知 id 由服务端结合注册表判定，
 *   这样扩展新增视图不需要改主包 schema。
 */
export const BUILTIN_UI_CAPABILITIES = [
  "life",
  "world",
  "personal",
  "log",
  "records",
  "character",
  "npcList",
  "wheel",
  "battle",
  "event",
  "equipment",
  "inventory",
  "skills",
  "relations",
  "evaluation",
  "ending",
] as const;

export type BuiltinUiCapability = (typeof BUILTIN_UI_CAPABILITIES)[number];

/** `tab` 顶层页签 / `overlay` 按需浮层 / `off` 不渲染常驻入口 / `slot:<hostId>` 嵌进宿主。 */
export const UiPlacementSchema = z.union([
  z.enum(["tab", "overlay", "off"]),
  z
    .string()
    .regex(/^slot:[A-Za-z][A-Za-z0-9_.-]*$/, '落位必须是 tab / overlay / off 或 slot:<hostId>'),
]);

export type UiPlacement = z.infer<typeof UiPlacementSchema>;

export const UiConfigSchema = z
  .object({
    place: z.record(z.string().min(1), UiPlacementSchema).optional(),
    /**
     * 模板自定义样式（ADR-002 D2）：id → spec。id 同时可被实体的 `style` 引用。
     * 也能覆盖同名预设（如 `rainbow: { preset: rainbow, bold: true }`）。
     */
    styles: z.record(z.string().min(1), StyleSpecSchema).optional(),
    /**
     * 品质 → 样式 id（ADR-002 D3 的展示侧）：实体未自声明 `style` 时按 quality 查这里。
     * 值可以是 `styles` 的键，也可以是引擎预设 id。
     */
    qualityStyles: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();

export type UiConfig = z.infer<typeof UiConfigSchema>;

/**
 * 当前内建布局，作为 `ui.yaml` 缺省项的落位。
 * 这不是"推荐配置"，只是把现有前端分布翻译成 place 语言，保证零回归。
 */
export const DEFAULT_UI_PLACEMENTS: Readonly<Record<string, UiPlacement>> = {
  life: "tab",
  world: "tab",
  personal: "tab",
  log: "tab",
  records: "tab",
  character: "slot:personal",
  npcList: "tab",
  wheel: "overlay",
  battle: "overlay",
  event: "overlay",
  equipment: "slot:personal",
  inventory: "slot:personal",
  skills: "slot:personal",
  relations: "slot:npcList",
  evaluation: "slot:personal",
  ending: "slot:life",
};

/**
 * 解析某项能力的最终落位：声明优先，没声明就回落现状。
 * 前端还要再做一次"宿主认不认这个槽"的降级（认不出 ⇒ 退化为 tab）。
 */
export function uiPlacementOf(ui: UiConfig | undefined, capability: string): UiPlacement {
  return ui?.place?.[capability] ?? DEFAULT_UI_PLACEMENTS[capability] ?? "tab";
}
