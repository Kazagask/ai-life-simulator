# 设计：表现层（叙事追加 / 本轮收获 / 样式体系）

> 事实均以当前工作区代码为准（行号为 2026-11-18 快照）。凡标「现状」的都是已核实行为，
> 凡标「拟」的都是本轮要落地的设计。

## 1. 现状与差距

| 能力 | 现状（证据） | 差距 |
|---|---|---|
| 叙事累积 | `GET /narrative?fromTurn=0` 已返回全量 trace；但**模板/mock 回合不写 trace**（`narrative/generate.ts:42` 直接 `source:"template"` 返回，只有结束时才写 ending/evaluation） | 没有 LLM 就没有叙事；实测开局+1 回合 `blocks=0` |
| 叙事呈现 | SSE 草稿上屏，收尾后用正式块替换并**关掉打字机**（`NarrativeStage.tsx:59-68,95`） | 无 LLM 时整段瞬现，与有 LLM 时观感割裂 |
| 回合结算卡 | 仅转盘回合出现「命运落定」，只有标题 + 标签（`main.tsx:1882-1891`） | 不含任何效果；其他回合什么都没有 |
| 详情 | `SkillVM` 只有 name/description/kind（`view-model.ts:76-83`）；`StatusVM` 只有 id/name/stacks（`:85-92`） | 装备/消耗品/技能/补正的效果没下发 |
| 样式 | `quality` 是自由字符串 + 模板白名单（`equipment.ts:150`），前端只用文字标签 | 没有颜色/动画体系；补正/技能连 quality 都没有 |
| 补正交互 | 个人页签里是只读 chip（`main.tsx` statuses 渲染） | 点击无反应，看不到效果 |
| 固定效果 | `ControlSemanticsSchema`（`status-effect.ts:16`）已建模，但从未出现在任何展示面 | 没有「下划线」这类可读呈现 |

## 2. 协议新增（一次说清）

新增 `packages/shared/src/schema/style.ts`：

```ts
export const StylePresetIdSchema = z.enum([
  "rainbow", "gold", "silver", "bronze", "crimson", "azure", "jade",
]);
export const StyleAnimationSchema = z.enum(["none", "rainbow-flow", "pulse", "glow"]);
/** 颜色只收 3/6/8 位十六进制或引擎 token；禁止任意 CSS。 */
export const ColorTokenSchema = z.union([
  z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/),
  z.enum(["text", "muted", "accent", "accent-2", "gold", "danger", "success"]),
]);
export const StyleSpecSchema = z.object({
  preset: StylePresetIdSchema.optional(),
  color: ColorTokenSchema.optional(),
  background: ColorTokenSchema.optional(),
  bold: z.boolean().optional(),
  animation: StyleAnimationSchema.optional(),
}).strict();
```

`ui.yaml` 追加两段（展示域，**不进语义指纹**）：

```yaml
styles:                       # 模板自定义 / 别名
  rainbow: { preset: rainbow }
  six-eyes: { preset: rainbow, bold: true }
qualityStyles:                # 品质 → 样式 id（先查 styles，再查 preset）
  mythic: six-eyes
```

实体侧追加（全部可选，缺省零回归）：
- `StatusEffectSchema`（`status-effect.ts:56`）：`quality?: string`、`style?: string`
- `CombatSkillSchema` / `GeneralSkillSchema`（`skill.ts`）：`quality?: string`、`style?: string`
- `ItemSchema`（`item.ts`）：`style?: string`

`packages/shared/src/contract/view-model.ts` 追加：

```ts
export const EffectSummaryVMSchema = z.object({
  text: z.string(),                                        // 「咒力 +4」「无法行动」
  kind: z.enum(["attr","combat","control","apply","remove","cost","formula","note"]),
  tone: z.enum(["buff","debuff","neutral"]).optional(),
}).strict();

export const ResolvedStyleSchema = z.object({              // 引擎解析后的最终样式
  preset: StylePresetIdSchema.optional(),
  color: z.string().optional(),                           // 已解析成 #rrggbb / var(--x)
  background: z.string().optional(),
  bold: z.boolean().optional(),
  animation: StyleAnimationSchema.optional(),
}).strict();

// StatusVM / SkillVM / InventoryItemVM / EquipmentVM 追加：
//   description?, quality?, style?: ResolvedStyle, effects?: EffectSummaryVM[]

export const TurnGainVMSchema = z.object({
  category: z.enum(["attribute","status","skill","item","equipment"]),
  action: z.enum(["gain","lose","up","down","equip","unequip"]),
  id: z.string(),
  name: z.string(),
  amount: z.number().optional(),      // 属性净变化 / 数量变化
  stacks: z.number().optional(),      // 补正层数
  quality: z.string().optional(),
  style: ResolvedStyleSchema.optional(),
}).strict();
```

`ContentBlockVM` 追加 `turnIndex?: number`（读侧从 trace 行带出，前端据此只给**最新回合**播打字机）。

## 3. 叙事

### 3.1 每回合一条（R-NAR-01）

现状的 narrative 写入只服务 ending / evaluation。新链路放在**服务端写操作收尾**（`turn` /
`choose` / `wheels/confirm` / `battle` / `items/use` 共用 helper）：

```
afterTx(world, entry, tx):
  if readNarrativeBlocks(worldId, world, fromTurn = tx.turnIndex).length > 0: return  // LLM 已写过
  text = composeTemplateNarrative(world, tx)   // 只用本回合 history + 本轮 slot/wheel
  if text === "": return
  recordNarrative(world, entry, { reason: "turn.template", blocks: [{ blockId, kind: "narrative", text, refs }] })
```

`composeTemplateNarrative` 的取材（按优先级拼**一条**，最多三段）：

1. 事件回合：`slot.narrative`（事件正文）+ 所选选项文本；
2. 转盘回合：`⚄ {wheel.title}：{wheel.label}`；
3. 其余：本回合 `history` 里 `type ∈ {player_action, event, battle, npc_action}` 的 `summary`，
   按写入顺序拼接（NPC 行动放最后一段）。

**幂等**：只按 `turnIndex` 判重（同一回合已有块就不写），不依赖调用次数。

### 3.2 呈现与流式（R-NAR-02）

- 客户端保留全量 `blocks`（已如此），**追加**而非替换。
- `NarrativeStream` 追加 `animateFromTurn?: number`：`block.turnIndex >= animateFromTurn` 的块才播打字机；
  其余静态。默认 = `view.turnIndex`，即只有最新回合动。
- 有 SSE 草稿：沿用「草稿逐字 → 正式块不重打」（现有 `instantTurn` 逻辑改为按回合判定）。
- 无 SSE：最新回合块按打字机速度播放（同一组件同一节奏），**不显示**「AI 书写中…」。
- 历史过长的性能：本轮先不截断（DEFERRED R-NAR-D1），但在 design §9 记录风险。

## 4. 本轮收获（R-GAIN）

### 4.1 基线 + 差分（引擎纯函数）

新增 `packages/game-core/src/v2/presentation/gains.ts`：

```ts
export interface GainBaseline {
  attributes: Record<string, number>;
  statuses: Array<{ id: string; stacks: number }>;
  skills: string[];
  inventory: Record<string, number>;
  equipment: Array<{ instanceId: string; itemId: string }>;
}
export function captureGainBaseline(state: WorldStateV2): GainBaseline;
export function diffGains(before: GainBaseline, after: WorldStateV2, lookup: TemplateLookup): TurnGain[];
```

- **不做整状态 clone**：只抓玩家可见的五类字段，成本与状态规模无关（NPC 再多也不影响）。
- 属性：净值 ≠ 0 才出条目，`action: up|down`，`amount` 为净值。
- 补正：按 `(id)` 比较层数，新增 / 移除 / 层数变化各一条（变化合并成一条，带最终层数）。
- 技能：集合差（`gain`）。
- 物品：数量差（`gain` / `lose`，带 `amount`）。
- 装备：按 `instanceId` 差（`equip` / `unequip`）。
- 顺序固定：属性 → 补正 → 技能 → 物品 → 装备（同类按 id 排序，保证可复现）。

### 4.2 传输与呈现

- 五个写操作响应统一追加 `gains: TurnGainVM[]`（空数组表示无收获）。
- 前端 `LastResult` 增加 `gains`；渲染位置就是现在「命运落定」那张卡：
  标题改「本轮收获」，按类别分组，属性用 `+/-` 与色彩区分（红涨绿跌沿用**游戏语义**：
  增益绿、减益红——注意与股市约定无关，这里是属性好坏）。
- 无 `gains` 且无转盘 → 保留「世界平静地流转着」。
- **不持久化**：刷新后卡片消失（D-6 已定）；如果需要历史，走叙事区（R-NAR-01）。

### 4.3 交互（R-GAIN-03）

条目点击 → 打开对应详情（技能 / 物品 / 装备 / 补正同一套组件）。属性条目不可点。

## 5. 详情与固定效果

### 5.1 补正详情（R-DETAIL-04 / 05）

新增 `packages/rpg-ui/src/ModifierSheet.tsx`（毛玻璃浮层）：

- 结构：头部（名称 + 品质样式 + 层数）/ 持续时间 / 仿真面 / 战斗面 / 控制 / 说明。
- 打开方式：`onOpenModifier(statusId)` 由宿主传入，宿主维护 `openModifier` 状态；
  Esc / 遮罩 / 关闭按钮关闭；同一时刻只开一个。
- 毛玻璃：`backdrop-filter: blur(18px) saturate(1.2)` + 半透明深底；
  `@supports not (backdrop-filter: blur(1px))` 回退到 92% 不透明底（避免糊字）。

### 5.2 装备 / 消耗品 / 技能详情（R-DETAIL-01..03）

- 引擎侧新增 `buildEffectSummaries(def, kind, lookup): EffectSummary[]`（纯函数，展示用）：
  - 补正：`attributeModifiers` → `咒力 +4`；`combat.control` → `无法行动`（`kind:"control"`）；
    `damageDealt/damageTaken/hitChance` → `伤害 +10%`；`onRoundEnd` → `每回合受到 2 点伤害`。
  - 技能：`消耗 {mp}`、`目标 X`、`伤害 1.2×咒力`、`施加 重伤`、`冷却 N 回合`。
  - 物品：`恢复 30 生命`、`施加 …`、`移除 …`。
  - 装备：静态补正 + 动态补正规则描述（`随咒力成长：3 + 0.2×咒力`），**不算值**。
- 现有详情组件（`AssetDetail` / `SkillList` / `CharacterSheet`）接入同一 `EffectList` 组件。

### 5.3 固定效果下划线（R-FX-01）

`EffectSummary.kind === "control"` 的条目渲染为 `<u className="ls-fixed-effect">`，
`title`/`aria-label` 给语义说明（`cannot_act` → 「无法行动：本回合不能执行任何动作」）。
文案表放引擎（`presentation/fixed-effects.ts`），前端不重复维护。

## 6. 样式体系

### 6.1 解析顺序（唯一实现）

```
resolveStyle(entity.style, entity.quality, ui.styles, ui.qualityStyles) :
  1. entity.style 命中 ui.styles → 用其 spec
     命中预设 id → 直接用预设
     未命中 → 加载期已拒载（不会到这里）
  2. 否则按 entity.quality 查 qualityStyles → 再解析一次
  3. 否则 undefined（渲染回退默认样式）
```

- 位置：`packages/game-core/src/v2/presentation/style.ts`，**投影期**执行（`projection.ts` 调用），
  这样服务端 / rpg-ui / 自定义前端拿到的是同一份 `ResolvedStyle`。
- 颜色 token 解析成 `var(--ls-gold)` 之类的 CSS 变量字符串（前端不再判断语义）。

### 6.2 预设样式表（引擎）

| id | 视觉 |
|---|---|
| `rainbow` | 流动彩虹渐变文字（`background-clip:text` + `rainbow-flow` 动画） |
| `gold` / `silver` / `bronze` | 金属色 |
| `crimson` / `azure` / `jade` | 语义色（危险 / 冷静 / 生命） |

CSS 落在 `packages/rpg-ui/src/styles.css`（`.ls-style--rainbow` …），
`prefers-reduced-motion` 下动画自动停（R-STYLE-05）。

### 6.3 安全与校验（R-STYLE-04）

- `StyleSpecSchema` 只接受枚举 / 颜色 token；**任何**自由字符串（含 `;{}url(`）在 schema 层就失败。
- 加载期额外校验：`qualityStyles` 的键必须是模板已声明的 `quality` 值（装备走 `qualities` 白名单，
  补正/技能用于映射的 quality 不做白名单，允许模板自由定义——但映射目标必须存在）。
- 未知 `style` id ⇒ `template_invalid` 拒载，错误带实体 id 与字段路径。

## 7. 待用户裁决

| 编号 | 问题 | 建议 |
|---|---|---|
| D-1 | 叙事段保留范围：全量 vs 最近 N 回合 | 先全量（trace 已在盘上），前端做「折叠更早」留到下一轮 |
| D-2 | 收获卡是否包含关系 / 旗标变化 | 本轮不含（关系是双相值，语义待定） |
| D-3 | 「本轮收获」是否持久化（刷新可见） | 不持久化（一次性呈现），历史交给叙事区 |
| D-4 | 样式是否也用于技能/物品之外的文本（叙事内联） | 本轮不做（DEFERRED R-STYLE-D1） |
| D-5 | 属性增减的配色语义 | 增益绿 / 减益红（游戏语义，不用股市红涨绿跌） |

## 8. 需 ADR 清单（G2）

`docs/adr/60-表现层与仪器.md` 需裁决 6 条：

1. 表现层新增字段全部**只读投影**，不进 `WorldStateV2`、不进语义指纹、不参与判定。
2. 样式词汇受控（枚举 + 颜色 token），禁止任意 CSS；解析在引擎投影期。
3. 效果摘要由引擎从定义派生，动态补正只描述规则不算值。
4. 回合增量以「基线 + 差分」产生，**不落库**。
5. 叙事段按回合追加，模板兜底写入同一 trace 通道；`ContentBlockVM` 增加 `turnIndex`。
6. `schemaVersion` 保持 5（本轮无 state 结构变更）。

## 9. 正确性与测试策略

| 层 | 用例 |
|---|---|
| 样式 schema | 合法 spec 通过；`color:"red;}"`、未知 preset、未知 style id 全部拒载 |
| 样式解析 | 自身 style > quality 映射 > 默认；`rainbow` 落到 `preset:"rainbow"` |
| 效果摘要 | 补正 → 属性/控制/战斗三类文本；技能 → 消耗/伤害/冷却；动态补正不含数值 |
| 差分 | 属性净变化合并；补正层数变化；技能/物品/装备增删；空变化 → `[]` |
| 叙事 | 模板回合写 1 条；同回合再调不重复写；有 LLM 块时跳过；hidden 引用不落 trace |
| 前端 | 走查：无 LLM 三回合 → 叙事累积且最新回合逐字；收获卡四类条目；补正浮层开合；彩虹样式在个人页/收获卡一致 |
| 回归 | 旧档（schemaVersion 5）直载；`pnpm test` 全绿；web build 通过 |

## 10. 影响面

- `packages/shared`：新增 style.ts、view-model 追加字段（`strict()` 需同步放宽新增键）。
- `packages/game-core`：新增 `presentation/` 三个纯函数 + 投影接入；不动 turn 管线语义。
- `apps/server`：写操作响应加 `gains`；叙事兜底写入；模板加载期校验。
- `packages/rpg-ui`：新组件（收获卡 / 效果列表 / 补正浮层 / 样式渲染），现有组件接线。
- `apps/web`：叙事追加 + 假流式 + 收获卡接线 + 浮层状态。
- `specs/data/templates/jjk-2006/2.0.0`：给 `tech-six-eyes` 等高品质补正加 `quality`/`style`，
  `ui.yaml` 加 `styles` / `qualityStyles`。
