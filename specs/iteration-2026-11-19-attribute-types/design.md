# 设计：属性类型与自定义资源（2026-11-19）

> 对应需求：`requirements.md` R-ATTR-01..09 / R-RES-01..06。
> 协议裁决：`docs/adr/40-属性资源与状态.md`。

## 1. 数据模型

### 1.1 属性定义（模板）

`packages/shared/src/schema/world.ts` 的 `attributes` 从

```ts
{ order, defaults, caps?, labels? }
```

扩为：

```ts
{
  order: string[];                       // 不变（展示顺序；含 hidden）
  defaults: Record<string, number | string>;  // 值类型按 defs 校验
  caps?: Record<string, number>;         // 只允许 number / ladder
  labels?: Record<string, string>;       // 不变（所有 kind 的显示名）
  defs?: Record<string, AttributeDef>;   // 新增；缺省 = 全部 number
}
```

`AttributeDef`（判别在 `kind`）：

```ts
type AttributeDef =
  | { kind: "number"; hidden?: boolean }
  | { kind: "enum"; hidden?: boolean; values: Array<{ id; label; style? }> }
  | {
      kind: "ladder";
      hidden?: boolean;
      /** cumulative（缺省）：at 是累计阈值；reset：at 是本档升到下一档所需 */
      mode?: "cumulative" | "reset";
      tiers: Array<{ id; label; at: number; style? }>;
    }
  | {
      kind: "composite";
      hidden?: boolean;
      sources: string[];
      cases: Array<{
        when: Record<string, { eq?: number | string; gte?: number; lte?: number }>;
        label: string;
        style?: string;
      }>;
      fallback: { label: string; style?: string };
    };
```

放在新文件 `packages/shared/src/schema/attribute.ts`，由 `world.ts` import；
避免 `world.ts` 继续膨胀（已 800 行）。

### 1.2 属性值（状态）

```ts
export type AttributeValue = number | string;
```

落点：

| 文件 | 字段 | 变化 |
|---|---|---|
| `packages/shared/src/v2.ts` | `V2CombatantBase.attributes` | `Record<string, AttributeValue>` |
| `packages/shared/src/v2.ts` | `V2CombatantBase.attributeTiers?` | `Record<string, string>`（reset 阶梯的当前档；可选） |
| `packages/shared/src/v2.ts` | `BattleEnemy.attributes` | 同上 |
| `packages/shared/src/v2.ts` | `V2Snapshot.player.attributes` / `npcs[].attributes` | 同上（原始记录） |
| `packages/shared/src/schema/character.ts` | `CharacterSchema.attributes` | `z.record(string, number \| string)` |
| `packages/shared/src/schema/world.ts` | `PlayerTemplateSchema.attributes` | 同上 |
| `packages/shared/src/v2-state.ts` | `CombatantBaseSchema.attributes` / `BattleEnemySchema.attributes` | 同上 |

`@life-sim/shared` 新增 `numericAttr(value): number`（非 number 一律 0）与
`isNumericAttribute(kind)`。

### 1.3 属性视图（投影）

新增到 `packages/shared/src/v2.ts`（与 `StatusView` 同级，供 `V2Snapshot` 用）：

```ts
export interface AttributeSourceView {
  id: string;
  label: string;
  display: string;
  style?: ResolvedStyle;
}

export interface AttributeView {
  id: string;
  label: string;
  kind: "number" | "enum" | "ladder" | "composite";
  /** number/ladder 为数值；enum 为选项 id；composite 无 */
  value?: number | string;
  /** 已解析的展示文本（number 为数值字符串） */
  display: string;
  style?: ResolvedStyle;
  /** ladder：本档内进度（无下一档且无 cap 时不出现） */
  progress?: { value: number; max: number };
  /** ladder：当前档 */
  tier?: { id: string; label: string; style?: ResolvedStyle };
  /** composite：来源轴 */
  sources?: AttributeSourceView[];
}
```

`V2Snapshot.player` 追加 `attributeViews: AttributeView[]`；
`V2Snapshot.npcs[]` 追加 `attributeViews: AttributeView[]`。
原始 `attributes` 保留（LLM 读工具、调试、旧前端）。

### 1.4 资源定义与状态

`ResourceDefSchema`：

```ts
{ base, perLevel?, perAttribute?, cap?, initial?, label? }
```

`resources = z.object({ hp: R, mp: R }).catchall(R)`（`R` 自身仍 `.strict()`，防拼写错误）。

**显示形态与告警阈值放 `ui.yaml`**（纯渲染，不进指纹）：

```ts
UiConfigSchema.resources?: Record<string, { display?: "bar" | "pips"; dangerAt?: number }>
```

缺省 `display: bar`、`dangerAt: 0.25`（hp/mp 维持现状；自定义资源缺省 `dangerAt: 0`）。

状态：

- `V2Player.resources: Record<string, number>`（自定义资源，**不含 hp/mp**；默认 `{}`）
- `BattleState.player.resources: Record<string, number>`（默认 `{}`）
- `BattleEnemy.resources?: Record<string, number>`
- 旧档：schema `.default({})`，接口必填（与 `spawnRules` 同一策略）。

### 1.5 技能消耗

`CombatSkillSchema.cost`：

```ts
z.object({ mp: z.number().nonnegative() }).catchall(z.number().nonnegative())
```

### 1.6 效果 / 条件

`EffectSchema` 新增：

```ts
{ type: "setAttribute", attribute: string, value: number | string }
```

`adjustResource.resource`：`z.string().min(1)`（原 `enum(["hp","mp"])`）。

`AttributeConditionSchema`：

```ts
{ attribute: string, eq?: number|string, ne?: number|string,
  gte/lte/gt/lt?: number, tier?: string }
```

### 1.7 回复配置

`regen.perTurn` / `regen.actions.<id>` 用 `{ hp, mp } + catchall(number)`，
键集校验 ⊆ `resources`。

## 2. 加载期校验（`world.ts` superRefine + `validateStyleRefs`）

新增（全部 fail-fast、路径精确到字段）：

1. `defs` 键 ⊆ `order`；`kind` 合法；enum/ladder/composite 各自结构校验。
2. enum：`values` 非空、id 唯一；`defaults[id]`（若有）必须是选项 id。
3. ladder：`tiers` 非空、`at` 严格递增、首档 `at === 0`、id 唯一。
4. composite：`sources` 非空且指向 number/ladder；`cases[].when` 键 ⊆ sources；
   `fallback` 必填；sources 不得包含 composite 自身或别的 composite。
5. `caps` 键必须是 number/ladder。
6. `defaults` 值类型与 kind 一致；`playerTemplate.attributes` / `characters[].attributes`
   同上（enum 的字面量必须是选项 id）。
7. 数值面引用校验（ADR-003 D7）：
   `perAttribute` / `mood.attributeModifiers` / `statuses[].simulation.attributeModifiers` /
   `hitCheck` / `scaleBy` / `fleeCheck` / `weightBy` / `dynamicModifier`。
8. 效果引用校验：
   `adjustAttribute` 目标存在且为数值属性；`setAttribute` 目标存在；
   `adjustResource.resource` ∈ resources。
9. `statusBar`：`source: resource` 的 key ∈ resources；`source: attribute` 的 keys 为数值属性
   （该段目前不被 UI 消费，但语义上不能填文本属性）。
10. 技能 `cost` 的键 ⊆ resources。
11. `regen` 的键 ⊆ resources。
12. `ui.resources` 的键 ⊆ resources；`display` 枚举合法；`dangerAt` ∈ [0,1]。
13. 样式：enum option / ladder tier / composite case+fallback 的 `style` 经
    `validateStyleRefs` 校验（未知 id 拒载）。

**校验位置的现实约束**：`world.ts` 的 `superRefine` 已很长，新增逻辑抽到
`packages/shared/src/schema/attribute-validate.ts`（纯函数，接收 `WorldTemplateV2` + `ctx.addIssue` 风格回调），
`world.ts` 只调用。避免继续堆在一个函数里。

## 3. 运行时求值

### 3.1 数值面收口

- `computeMax` / `effectiveAttributes`：遍历时忽略非 number（`numericAttr`）。
- `adjustAttribute`：`current = numericAttr(...)`；`clampAttr` 不变。
- `buildUnits`（战斗敌我）：数值 × levelScale，文本原样复制。
- `playerEffectiveAttributes` 返回值仍是 `Record<string, number>`（文本不参与公式）。
- 条件求值改为共享函数 `evaluateAttributeCondition(cond, { raw, effective, template })`：
  - `eq/ne` 字符串 → 与 raw 值比较；
  - 数值 ops → 与 effective 值比较（非数值 → false）；
  - `tier` → 用 raw 数值 + ladder 定义求当前档 id。
  两处调用：`engine.ts#checkCondition`、`condition-evaluator.ts#FLAT_EVALUATORS`。

### 3.2 效果

- `setAttribute`：
  - number/ladder：与 `adjustAttribute` 一样按 `caps` 夹取；reset 阶梯按「从首档起逐档
    扣减」重算当前档（绝对赋值必须可复现，不读旧档位）；
  - enum：值必须是已声明选项 id，否则抛 `unknown_attribute_value`（加载期已拦字面量，
    运行期只可能是模板把动态值接进来，必须可诊断）。
- `adjustAttribute`（reset 阶梯）：加值后循环
  `while (next tier 存在 && value >= tier.at) { value -= tier.at; tier += 1 }`，
  同步写 `attributeTiers[id]`；cumulative / number 保持原逻辑。
- `adjustResource`：
  - `hp` / `mp` 走原字段（hp 下限 1）；
  - 其他 id 走 `state.player.resources`，按 `maxResource` 夹取，缺键视为 0。

### 3.3 资源

新增 `packages/game-core/src/v2/resources.ts`：

```ts
resourceDef(template, key)
resourceMax(player, template, key): number
resourceValue(player, key): number
adjustResourceValue(player, template, key, delta): void
initCustomResources(player, template): void
```

`hp/mp` 走既有 `maxHp/maxMp`；自定义走通用公式。
`resources` 的初始化在建世界期（`turn.ts`）一次完成：`initial ?? max`。

### 3.4 战斗

- `Combatant` 增加 `resources: Record<string, number>`；
- `playerCombatant` 取 `battle.player.resources`，`writeBack` 写回；
- `buildUnits` 为每个自定义资源算 `max` 并填 `initial`；
- 技能消耗：

```ts
for (const [key, amount] of Object.entries(skill.cost)) {
  if (amount <= 0) continue;
  if (resourceValue(caster, key) < amount) {
    throw new Error(key === "mp" ? "not_enough_mp" : `not_enough_resource:${key}`);
  }
}
// 全部检查通过后再扣，避免部分扣除
```

- AI 可用技能过滤同样检查全部 cost（`battle.ts` 的 `usable`）。
- `finishBattle`：`state.player.resources = clampEach(battle.player.resources)`。

### 3.5 开局

`opening-dag.ts#commitOpening` 的 `mode: "set"` 分支：
`typeof value === "string"` 时写 enum（按模板 def 校验）；`mode: "add"` 只接受 number。
`collectOpeningGains`：文本属性产出 `TurnGain { action: "set", id, name, value, style }`。

## 4. 投影与视图模型

### 4.1 属性

新增 `packages/game-core/src/v2/presentation/attributes.ts`：

```ts
resolveAttributeViews(raw: Record<string, AttributeValue>, template): AttributeView[]
resolveAttributeView(id, raw, template): AttributeView | undefined
```

投影：

- `snapshot.player.attributeViews = resolveAttributeViews(player.attributes, template)`；
- `snapshot.npcs[].attributeViews` 同；
- hidden 属性跳过；
- `labels.attributes` 不变。

### 4.2 资源

`V2Snapshot.player.resources: ResourceView[]`：

```ts
{ key, label, value, max, display: "bar"|"pips", dangerAt: number }
```

顺序 = `statusBar` 的 `source: resource` 段；每段的 key 从 `state.player`（或战斗镜像）取值。
`display` / `dangerAt` 取 `ui.resources[key]`（缺省 bar / 0.25；自定义资源缺省 dangerAt 0）。
`labels.resources` 改为全部 resources 的 label 映射（hp/mp 仍有）。

### 4.3 战斗

`BattleView.player`：

- `resources: ResourceView[]`（含 hp/mp，与状态栏同口径）；
- `skills[].costs: Array<{ resource, label, amount }>`；
- `costMp` 保留（旧前端兼容）= `costs` 中 mp 的 amount。

### 4.4 视图模型（`packages/shared/src/contract/view-model.ts`）

`PlayerAttributeVMSchema` 扩为与 `AttributeView` 同构（字段逐一搬运）：

```ts
{ key, label, kind, value?, display, style?, progress?, tierLabel?, tierStyle?, sources? }
```

`StatusBarVMSchema` 增 `display: "bar" | "pips"`。

`BattleSkillVMSchema` 增 `costs: Array<{ resource, label, amount }>`。

> 字段名沿用 VM 的 `key`（不是 `id`），减少宿主改动；`sources` 用 `{ key, label, display }`。

### 4.5 收获

`TurnGainSchema` 增 `value?: string`（文本属性的展示值）。
`gains.ts`：

- number/ladder（cumulative）：仍按数值差分（`up/down`），ladder 不额外产生档位条目；
- ladder（reset）：档位不变 ⇒ 数值差分；升档 ⇒ `action: "set"` + `value` = 新档 label
  （不展示被扣掉的数值，避免「修为 -90」的误读）；
- enum：`prev !== next` ⇒ `action: "set"`，`value` = 新选项 id，`style` = 选项样式，
  `name` = 属性 label；
- composite：派生称号变化 ⇒ `action: "set"`，`value` = 新称号，`style` = 命中样式；
- hidden 属性不产生条目（它只作为 composite 的输入）。

## 5. 前端

### 5.1 `packages/rpg-ui/src/adapter.ts`

- `toPlayerVM`：`attributes` 直接来自 `snapshot.player.attributeViews`（已排序、已过滤），
  不再 `Object.entries(...).filter(proficiency)`。
- `toNpcVM`：同。
- `deriveStatusBar`：改为搬运 `snapshot.player.resources`（含 display），
  `tone` 仍由适配器算：`dangerAt > 0 && value/max <= dangerAt` ⇒ `danger`。
- `toBattleVM`：`player.resources`、`skills[].costs` 搬运。

### 5.2 组件

- 新增 `packages/rpg-ui/src/AttributeList.tsx`：
  - `AttributeValue`：number 原样、enum/composite 用 `<StyledName>`、ladder 用 `<LadderBar>`；
  - `AttributeGrid`：个人页网格（数字/文本/复合）；
  - `LadderList`：进度条区；
  - `NpcDetails` 与 `StatsPanel` 共用，避免两套口径。
- `StatusBars.tsx`：`display === "pips"` 渲染刻度（最多 12 格，超出用 `value/max` 文案兜底）。
- `BattleBoard.tsx`：资源区按 `b.resources` 渲染（含 pips）；技能按钮按 `costs` 展示与禁用；
  资源不足的文案 `能量豆 3`（红色）。
- `styles.css`：`.ls-pips` / `.ls-pips__pip` / `.ls-attr__ladder` 等。

### 5.3 个人页 / NPC 详情

- `StatsPanel`：属性网格 + 「成长」进度条区（ladder 存在时才渲染）。
- `NpcDetails`：属性网格 + 进度条（紧凑版）。
- `CharacterSheet` 不恢复属性区（2026-11-18 用户已裁决移除）。

## 6. 模板改造

### 6.1 `jjk-2006 2.0.0`

`world.yaml`：

```yaml
attributes:
  order: [cursedEnergy, intellect, physique, agility, luck, reputation,
          grade, innateTechnique, infamy, virtue, fame]
  defaults: { ..., grade: grade-4, innateTechnique: none, infamy: 0, virtue: 0 }
  caps: { ..., infamy: 2, virtue: 2 }
  labels: { ..., grade: 等级, innateTechnique: 生得术式, infamy: 恶名, virtue: 善名, fame: 名誉 }
  defs:
    grade: { kind: enum, values: [四级 gray / 二级 blue / 一级 purple / 特级 gold] }
    innateTechnique: { kind: enum, values: [十种影法术 / 赤血操术 / 刍灵咒法 / 雷电 / 咒言 / 无下限术式 rainbow / 无术式 gray] }
    infamy: { kind: ladder, hidden: true, tiers: [— 0 / ＋ 1 / ＋＋ 2] }
    virtue: { kind: ladder, hidden: true, tiers: [同上] }
    fame: { kind: composite, sources: [infamy, virtue], cases: [...7 条...], fallback: 默默无闻 gray }
```

- `opening.yaml`：n03 四个档位各加 `gradeAttr: { id: grade, value: grade-X, mode: set }`；
  n04 六个术式各加 `techAttr2: { id: innateTechnique, value: ..., mode: set }`
  （沿用现有 param 声明，新增两个 `kind: attribute` 的 param）。
- `characters.yaml`：五条悟 `attributes` 加 `grade: special, innateTechnique: limitless`；
  夏油杰加 `grade: special, innateTechnique: cursed-spirits`；伏黑惠加 `innateTechnique: ten-shadows`。
- `events.yaml`：2..3 个道德分歧选项加 `adjustAttribute { infamy/virtue }`
  （夏油屠村、涩谷救人等），让名誉在实机可变化。

### 6.2 `valmont 1.0.0`

- `world.yaml`：
  ```yaml
  attributes:
    order: [body, mind, will, prowess]
    defs:
      prowess:
        kind: ladder
        tiers:
          - { id: novice, label: 生手, at: 0 }
          - { id: trained, label: 熟手, at: 30 }
          - { id: adept, label: 好手, at: 80 }
          - { id: master, label: 名手, at: 150 }
  resources:
    hp: {...}
    mp: {...}
    beans: { label: 决意, base: 5, cap: 5, initial: 5 }
  statusBar:
    - { id: vitals, label: 生命, source: resource, key: hp }
    - { id: resolve, label: 决意, source: resource, key: beans }
  ```
- `ui.yaml`（新增文件，或追加到现有）：
  ```yaml
  resources:
    beans: { display: pips, dangerAt: 0 }
  ```
  > 注意：`ui.yaml` 在白名单里但**不进指纹**；如果这个模板原本没有 `ui.yaml`，新增文件
  > 不改变模板指纹（见 SPEC §1.3）。
- `characters.yaml`：新增敌人 `npc-duelist`（`isEnemy: true`），带 hp/属性/技能。
- `skills.yaml`：从空改为两条玩家技能 + 一条敌人技能：
  - `sk-duel-strike`（mp 0，无消耗）
  - `sk-duel-finisher`（mp 0，`beans: 3`，高伤害）
  - `sk-duelist-cut`（敌人用）
- `events.yaml`：在 `evt:close` 之前插入 `evt:duel`（`kind: combat`，chain 触发），
  `onVictory.effects: [{ adjustAttribute, attribute: prowess, value: 40 }]`，
  胜/败分别接回主线（`nextEventId`）。
- 战斗事件需 `enemies: [{ ref: npc-duelist }]`。

> 模板不接 LLM（`llmTriggers` 为空），加战斗不改变这一点。

## 7. 兼容与迁移

| 风险 | 处置 |
|---|---|
| 旧存档 `attributes` 缺 union | 放宽 schema；旧值均为 number ⇒ 行为不变 |
| 旧存档无 `player.resources` | `.default({})` ⇒ 补空对象，不拒载 |
| 旧存档 `BattleState.player` 无 `resources` | `.default({})` |
| 旧模板无 `defs` | 全部按 number ⇒ 逐字段不变 |
| 旧模板 `cost` 只有 mp | catchall 允许额外键，`mp` 仍必填 |
| 旧模板 `regen` 只有 hp/mp | 用 catchall，hp/mp 仍必填 |
| 数值公式读到字符串 | `numericAttr` 兜 0；加载期已拒绝 |
| `statusBar` 只写 hp（valmont） | MP 不再常驻显示 ⇒ 与模板意图一致，记录为行为变化 |
| 生成角色（LLM `submitBranch`） | 仍只写数值属性（`branch-submit.ts` 不改） |

`schemaVersion` 保持 5。模板指纹会因 yaml 改动而变化 ⇒ 旧档拒载由既有机制承担。

## 8. 测试计划（`test/`）

新增 `test/unit/attribute-types.test.ts`：

1. enum：默认值 / 字面量校验 / 未知选项拒载 / 投影 label+style。
2. ladder：档位派生、进度 15/100、升档不归零、最后一档无进度条。
3. composite：七种名誉组合逐条断言；fallback；未知 source 拒载；效果写入 composite 拒载。
4. hidden：视图不含、raw 含、composite.sources 带 display。
5. 条件：enum eq/ne、ladder tier、数值 ops、文本属性用 gte 拒载。
6. 效果：`setAttribute` 文本 / 数值；`adjustAttribute` 文本拒载。
7. gains：enum 变更出 `set` 条目（带 style）；hidden 不出条目；composite 称号变化出条目。
8. 数值面拒载：`scaleBy` 指向 enum、`perAttribute` 指向 enum、`attributeModifiers` 指向 enum。

新增 `test/unit/custom-resources.test.ts`：

1. 资源上限公式 + cap + initial。
2. statusBar 顺序 / 未声明不显示 / pips 元数据。
3. `adjustResource` 自定义资源（模拟域 + 战斗物品）。
4. 技能 `cost.beans`：不足拒绝、足够扣除、AI 过滤。
5. 战斗镜像初始化与 finish 回写。
6. regen 自定义键。

新增 `test/api/opening-attribute.test.ts`（或并入现有 opening 用例）：

1. opening `attribute` 参数 `mode:set` 写 enum。
2. 预览 / commit gains 含文本属性。

模板回归：

- `test/unit/jjk2006-dag.test.ts` 补：n03/n04 写 grade/innateTechnique。
- `test/unit/combat.test.ts` 或新文件补 valmont 决斗：进入战斗、豆消耗、胜利后 prowess 40。

## 9. 待裁决（2026-11-19 用户已裁决）

- **D-1 名誉的派生方式**：✅ 恶名 / 善名两条隐藏数值轴，名誉由规则表按优先序派生。
- **D-2 自定义资源的范围**：✅ 玩家 / 敌人全对称（技能消耗 + 战斗镜像 + 物品/效果 + 状态栏刻度）。
- **D-3 资源条的显隐**：✅ 只显示 `statusBar` 里声明的资源。
- **D-4 阶梯的数值语义**：✅ **两种都要** ⇒ `mode: cumulative`（缺省，累计不归零）与
  `mode: reset`（本档经验池，升档扣减）并存；reset 档位落 `attributeTiers`。
