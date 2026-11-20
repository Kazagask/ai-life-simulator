# 需求：属性类型与自定义资源（2026-11-19）

> 写法沿用 EARS。每条需求有编号、验收标准、追溯（设计 / 任务）。编号一旦发布不重排；
> 本轮不做的整条标 `DEFERRED`，保留原文。
>
> 用户原话（2026-11-19）：
> 「属性现在只支持 int 类型，需要支持 <string,style> 类，如 生得术式 '无下限术式'（彩色样式）、
> 等级 '特级'（金色样式）、阶梯进度类 如 exp 修为（通常是一个甚至多个进度条，联动另一个字段枚举，
> 如 练气初期 修为 15/100）。咒术回战模板可以用名誉来做（恶名+善名 …）。
> 资源支持自定义，很多技能可能需要特殊能量释放（如能量豆机制，攒多少个豆才能放技能）；
> 资源的 UI 展示也应该能定制成刻度样式，如 1/5。可以在瓦勒蒙那个模板里写一个战斗事件测试一下。」

## 0. 术语

| 术语 | 含义 |
|---|---|
| **属性** | 模板 `attributes` 声明、存在 `state.player.attributes` / `npc.attributes` 的键值。 |
| **属性类型（kind）** | `number` / `enum` / `ladder` / `composite`。缺省 `number`。 |
| **文本属性** | `kind: enum`，值是模板声明的选项 id，展示为带样式的 label。 |
| **阶梯属性** | `kind: ladder`，数值 + 累计阈值档位；展示为「档位 + 本档进度」。 |
| **复合属性** | `kind: composite`，由若干数值属性按优先序表派生的称号，**只读、不落 state**。 |
| **隐藏属性** | `defs.hidden: true`：参与规则，但不进属性面板。 |
| **自定义资源** | `resources` 里 `hp` / `mp` 之外的池子（如能量豆），可被效果/技能读写。 |
| **刻度（pips）** | 把资源画成 `max` 个格子、填充 `value` 个，如 `●●●○○ 3/5`。 |

## 1. 属性类型（R-ATTR）

### R-ATTR-01 模板可声明四种属性类型（ACTIVE）

**当**模板在 `attributes.defs` 声明某属性时，**系统应当**按声明的 `kind` 解释其值；
未声明 `defs` 的属性一律按 `number` 处理（与改前逐字段一致）。

验收：

1. 现有模板（jjk / jjk-shinjuku / valmont）的 `world.yaml` 不写 `defs` 时，加载与运行结果不变。
2. `kind` 不属于 `number/enum/ladder/composite` ⇒ 加载期拒载。
3. `defs` 的键必须是 `attributes.order` 的子集；未声明的属性 id 出现在 `defs` 里 ⇒ 拒载。

### R-ATTR-02 文本属性带选项与样式（ACTIVE）

**当**某属性声明为 `kind: enum` 时，**系统应当**把值存为选项 id，并在投影里解析出
选项 label 与 `style`（与 ADR-002 同一套样式闭集）。

验收：

1. 模板可写 `values: [{ id, label, style? }]`；`style` 支持预设 / `ui.styles` 别名；
   未知样式 id ⇒ 加载期拒载。
2. 存档里存的是选项 id（`"limitless"`），不是展示文案（`"无下限术式"`）。
3. 投影 `AttributeView.display` 是选项 label，`style` 是解析后的 `ResolvedStyle`。
4. `defaults[id]` 与角色 `attributes[id]` 的文本值必须是已声明选项 id，否则拒载。
5. 效果 `setAttribute` 可写文本属性；`adjustAttribute` 写文本属性 ⇒ 加载期拒载。

### R-ATTR-03 阶梯属性展示档位与进度（ACTIVE）

**当**某属性声明为 `kind: ladder` 时，**系统应当**按 `mode` 派生当前档位，
并在属性面板展示「档位 label + 本档进度条（值/本档需求）」。

验收：

1. `tiers` 至少一档；`at` 严格递增且首档为 0，否则拒载。
2. `mode: cumulative`（缺省）：数值累计；值 15、首档 `at:0` / 下一档 `at:100`
   ⇒ 展示 `15/100`；升档时**数值不减**。
3. `mode: reset`：数值是本档经验池；升档时扣掉本档所需、档位 +1（可连升），
   当前档位写入 `state.player.attributeTiers`。
4. 两种模式都：达到下一档 ⇒ 档位切换、进度从 0 重新起算。
5. 最后一档且没有 `caps` ⇒ 不下发进度条（只显示档位与总值）。
6. 一个角色可同时拥有多个阶梯属性，每个各一条进度条（面板按 `order` 排列）。

### R-ATTR-04 复合属性按优先序派生称号（ACTIVE）

**当**某属性声明为 `kind: composite` 时，**系统应当**按 `cases` 的声明顺序取首个
全部条件命中的条目作为展示称号；无命中时取 `fallback`。

验收：

1. `sources` 至少一个、且都必须是数值属性（number / ladder），否则拒载。
2. `cases[].when` 的键必须是 `sources` 成员；每个条件至少一个操作（eq/gte/lte）。
3. `fallback` 必填（不允许「无名可显示」）。
4. 复合属性不可被效果写入、不可被条件引用（违反 ⇒ 加载期拒载）。
5. 名誉示例：恶名/善名各 0..2 时，七种组合分别落到
   `恶贯满盈 / 声名狼藉 / 默默无闻 / 亦正亦邪 / 声名远扬 / 名震天下 / 乱世枭雄`。

### R-ATTR-05 隐藏属性参与规则但不上面板（ACTIVE）

**当**属性声明 `hidden: true` 时，**系统应当**保留其存档、效果、条件与公式参与能力，
但从属性面板投影中剔除。

验收：

1. `player.attributeViews` / `npc.attributeViews` 不含 hidden 属性。
2. `player.attributes` 原始记录仍含 hidden 键（权威数据不丢）。
3. 复合属性的 view 带 `sources`（每个源的 label + display），供详情展示「恶名 ++ · 善名 ++」。

### R-ATTR-06 效果与条件支持四种类型（ACTIVE）

**当**模板写效果或条件时，**系统应当**按属性类型接受/拒绝，并在加载期 fail-fast。

验收：

1. 新增 `setAttribute { attribute, value: number|string }`；文本目标必须是选项 id。
2. `adjustAttribute` 目标必须是数值属性；`clamp` 仍按 `caps`。
3. 条件 `{ attribute, eq/ne }` 接受字符串（文本属性）与数字；
   `gte/lte/gt/lt` 只对数值属性合法；`tier` 只对 ladder 合法。
4. 两个条件求值入口（触发条件求值器 / 引擎 `checkCondition`）对同一条件给出同一结果
   （共用一份实现，不接受两份 switch）。

### R-ATTR-07 属性面板展示四种类型（ACTIVE）

**当**玩家打开个人页 / 查看 NPC 详情时，**系统应当**按类型渲染属性：
数字为数值、文本为带样式 label、复合为带样式称号 + 来源、阶梯为进度条。

验收：

1. 数字属性与改前视觉一致（同一 `stat` 网格）。
2. 文本 / 复合属性在网格内展示解析后的 label 与样式（`StyledName`），不显示引擎 id。
3. 阶梯属性单独一块「成长」区，每个属性一条进度条，显示档位（带样式）与 `value/max`。
4. NPC 详情复用同一份渲染逻辑（不出现两套口径）。

### R-ATTR-08 开局与收获消费文本属性（ACTIVE）

**当**开局参数设定了文本属性、或某回合改变了文本 / 复合属性时，**系统应当**
在「已经落定」/「本轮收获」里展示对应条目（带样式），而不是丢弃或显示 `[object Object]`。

验收：

1. 开局 `attribute` 参数 `{ id, value: "limitless", mode: "set" }` 能写入 enum 属性。
2. 开局预览与 commit 的收获列表都含该条，文案为 `生得术式 无下限术式`（选项带样式）。
3. 文本属性变化（值不同）进本轮收获；数值属性仍用 `+/-` 净值。
4. 复合属性称号变化时，收获里出现「名誉 名震天下」（样式取命中条目）。

### R-ATTR-09 存档与回放兼容（ACTIVE）

**当**加载旧存档（`attributes` 全为 number、无 `resources`）时，**系统应当**正常载入，
不因新字段缺失而拒载。

验收：

1. `schemaVersion` 保持 5（不升）。
2. 旧档加载后 `player.attributes` 逐字段不变；`player.resources` 补成 `{}`。
3. 同一 seed + 同一输入 + 同一模板 ⇒ 属性/资源结果逐字段相同（确定性不变）。

## 2. 自定义资源（R-RES）

### R-RES-01 模板可声明自定义资源（ACTIVE）

**当**模板在 `resources` 里追加 `hp` / `mp` 之外的键时，**系统应当**按同一条公式
计算上限，并按 `initial` 初始化当前值。

验收：

1. 资源定义支持 `label / base / perLevel / perAttribute / cap / initial`；
   显示形态（`display`）与告警阈值（`dangerAt`）写在 `ui.yaml.resources`（纯渲染，不进指纹）。
2. 上限 = `base + perLevel × growthLevel + Σ perAttribute × 基础属性值`，再受 `cap` 限制。
3. `initial` 缺省 = 上限；显式写 `0` 则从 0 开始。
4. `perAttribute` 引用非数值属性 ⇒ 加载期拒载。
5. `hp` / `mp` 仍必填，语义不变。

### R-RES-02 资源条按模板声明展示，支持刻度（ACTIVE）

**当**模板在 `statusBar` 声明 `source: resource` 段时，**系统应当**按声明顺序展示资源条；
`display: pips` 的资源画成刻度，`bar` 画成进度条。

验收：

1. 资源条顺序 = `statusBar` 中 resource 段的顺序；未声明的资源不显示。
2. `pips` 展示 `max` 个格子与 `value/max` 文案；`value` 超出 `max` 时按 `max` 填充。
3. 资源条标签取 statusBar 段的 label，缺省回退资源定义的 `label`，再回退 key。
4. `dangerAt` 为 0 的资源不进入告警色（如能量豆不会因为「花光了」变红）。

### R-RES-03 技能可消耗自定义资源（ACTIVE）

**当**战斗技能的 `cost` 含自定义资源键时，**系统应当**在施放前逐项检查、施放后逐项扣除。

验收：

1. `cost: { mp: 0, beans: 3 }` 合法；`beans` 必须是已声明资源 id，否则加载期拒载。
2. 资源不足 ⇒ 引擎拒绝（`not_enough_resource`），不扣任何资源、不进入冷却。
3. 战斗视图的每个技能下发 `costs`（资源 key / label / amount），前端据此置灰与展示。
4. 敌方 AI 选择技能时同样检查自定义资源。

### R-RES-04 效果可读写自定义资源（ACTIVE）

**当**效果 `adjustResource { resource, value }` 指向自定义资源时，**系统应当**在
模拟域与战斗域都按上限/下限夹取后写入。

验收：

1. `resource` 不是已声明 id ⇒ 加载期拒载。
2. 模拟域写 `state.player.resources`；战斗域写战斗镜像，战斗结束回写。
3. 物品在战斗中使用 `adjustResource` 时，自定义资源同样生效（不再只认 hp/mp）。
4. 回复 `regen.perTurn` / `regen.actions.*` 可追加自定义资源键（缺省 0）。

### R-RES-05 战斗携带并回写自定义资源（ACTIVE）

**当**战斗开始/结束时，**系统应当**把自定义资源镜像进战斗、结束后回写世界状态。

验收：

1. 战斗视图 `player.resources` 含自定义资源；数值随技能消耗实时变化。
2. 战斗结束（胜/败/逃）后 `state.player.resources` 等于镜像值（按上下限夹取）。
3. 敌人 / 友军单位同样有 `resources`，不因「只有玩家能攒豆」而出现引擎分支。

### R-RES-06 瓦勒蒙模板的战斗测试事件（ACTIVE）

**当**加载 `valmont 1.0.0` 时，**系统应当**提供一个可复现的战斗事件，覆盖：
自定义资源刻度、技能消耗、胜利后属性（阶梯）成长。

验收：

1. 模板声明一个 `display: pips` 的自定义资源（能量豆，上限 5）。
2. 至少一个战斗技能消耗 ≥3 个能量豆；豆不足时按钮禁用（投影 `costs` 驱动）。
3. 战斗事件可通过既有事件链进入，胜利后 `onVictory.effects` 推进「武艺」阶梯属性。
4. 不引入新的模板文件类型；只改 `world.yaml` / `characters.yaml` / `skills.yaml` / `events.yaml`。

## 3. 明确不做（DEFERRED）

- **DEFERRED** 属性/资源的模板编辑器 UI。
- **DEFERRED** 文本属性的多值列表（一人多术式）；本轮 enum 是单值。
- **DEFERRED** 复合属性参与条件 / 效果（本轮只做展示派生）。
- **DEFERRED** 属性面板的详情浮层（点击查看来源 / 说明）；本轮只展示 label 与来源行。
- **DEFERRED** 资源在非战斗事件里的「消耗式选项」（`cost` 只在战斗技能）。
- **DEFERRED** NPC 属性被效果动态修改（现状 NPC 属性是静态基线，本轮不改）。
