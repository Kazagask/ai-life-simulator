# 世界模板协议 V2 规格（YAML）

本规格定义"AI 人生模拟器"世界模板协议 V2。模板以 YAML 创作，Zod Schema（`packages/shared/src/schema/`）为协议的可执行定义与单一事实来源。引擎不允许硬编码具体世界观，世界观专属内容只进模板不进引擎。

配套决策见 `docs/DECISIONS.md` ADR-0001（协议）、ADR-0002（时间/属性）、**ADR-0004（终止模型）**；待定项见 `docs/OPEN_QUESTIONS.md`。

> **V2.1 修订（2026-11-11，R2.2 / T1-03）**：新增开局（§16）、结局与终止（§17）、人生评价（§18）、装备动态补正（§19）、战斗 AI 分层（§20）五个分域章节，并扩充 §8 物品、§13 校验与 §14 测试。**不含时间穿越、不含任何阶段状态机**：前者属 R3（ADR-0005，本轮不落盘），后者是 ADR-0004 明确否决的替代方案。新章节按追加方式编号（§16–§20），不重排既有编号，以保留报告与规格中的交叉引用。

## 1. 目标与范围

- 覆盖：世界元信息与历法、角色（含自定义性别与心情）、状态栏、补正（原"异常状态"，buff/debuff 统称）、技能（战斗/通用）、物品栏、通用事件协议（普通/随机转盘/战斗）、事件链、世界事件池、交互式战斗。
- 不覆盖：AI 叙事接口（沿用 CORE_ENGINE 的 Mock/Adapter 约定）、云存档、**时间穿越（R3，本轮不写配置）**、**六阶段 Lifecycle 状态机（ADR-0004 已否决）**。
- V2.1 起覆盖：开局 Opening、结局 Ending 与模拟终止、人生评价 Evaluation、归档只读标记、装备与动态补正、战斗 AI 分层决策（§16–§20）；装备不再是「物品 type 预留」。
- 所有随机必须走注入 seed 的 RNG，同 seed 同指令完全可复现；hidden 信息不得进入玩家可见投影。

## 2. 术语与状态分层

系统内"状态"一词分四层，协议中严格区分：

- 世界 flag：世界层面的事实（如 `curseSighting`），存于 `WorldState.flags`。
- 角色属性：角色常量面板（HP/MP 与世界自定义属性），缓慢变化。
- 心情：角色连续计量条 + 档位映射。心情不是补正；补正可以修改心情。
- 补正：附着在角色上的临时修改器，带生命周期，见第 6 节。

补正不替代前三者，只修改它们。

## 3. 模板目录结构与加载约定

```text
specs/data/templates/<world-id>/
  world.yaml        # 元信息、历法、genders、mood 档位、statusBar、属性、判定默认值
  characters.yaml   # 玩家初始、NPC、敌人角色
  skills.yaml
  items.yaml        # 物品；V2.1 起含 type: equipment 与 dynamicModifier
  statuses.yaml     # 补正
  events.yaml       # 事件池 + 事件链
  # —— 以下 5 个为 V2.1 新增分域（可选，按文件存在性加载）——
  opening.yaml      # 开局模板、事件池、completionConditions、handoff
  endings.yaml      # 终止条件、结局模板、DeathRoute
  evaluation.yaml   # 评价维度、权重、证据规则
  equipment.yaml    # 槽位、类别、品质、初始装备
  combat-ai.yaml    # 战斗风格与条件化策略
```

加载约定：

- 每世界一目录；前六个文件除 events 依赖其余相互独立，events 最后合并。**V2.1 的 5 个分域为可选**：未提供时该能力按模板缺省关闭，加载器按文件存在性加载，不要求所有世界一次性补齐（T8-01 负责补三世界观模板）。
- 加载顺序：`world -> characters -> skills -> items -> statuses -> equipment -> opening -> endings -> evaluation -> combat-ai -> events`；全部文件经 Zod 校验后聚合成 `WorldTemplateV2`。新增分域的引用完整性在 events 合并前校验，确保引用断裂在加载期暴露。
- 全库 id 唯一：同一目录内任意两个实体不得重 id；建议前缀约定 `ev-`（事件）、`chain-`（链）、`opt-`（选项）、`sk-`（技能）、`item-`（物品）、`npc-`/`enemy-`（角色）。
- 跨文件引用完整性（实现阶段在加载器中校验）：技能的 `applyStatus[].status`、补正的 `cureConditions[].item`、事件的 `nextEventId`/`chainId`、战斗的 `enemies[].ref`、选项的 `requiresSkill` 必须指向已定义实体。
- Schema 拒绝未知字段（strict mode），模板拼写错误在加载期暴露而非运行期。

## 4. world.yaml：世界与状态栏

### 4.1 元信息与历法

```yaml
meta:
  id: jjk-2006
  name: 咒术回战·平行世界
  description: 2006 年的东京咒术高专……
  startYear: 2006
  engineProtocol: v2
time:
  defaultStep: { value: 1, unit: day }      # 沿用 V1 TimeAmount 语义
  lifeStageSteps:
    youth: { value: 1, unit: week }
    adulthood: { value: 1, unit: month }
  # 人生阶段阈值（模板可配置；缺省回退引擎固定阈值 13/20/60）
  lifeStages:
    - { id: childhood, label: 幼年, maxAge: 12 }
    - { id: youth, label: 青年, maxAge: 29 }
    - { id: adulthood, label: 壮年, maxAge: 59 }
    - { id: elderhood, label: 暮年 }
```

- `engineProtocol` 必须为 `v2`，加载器按此拒绝旧模板。
- `lifeStages` 按 `maxAge` 升序，最后一档可省略 `maxAge` 表示无上界；引擎时间适配器据此解析人生阶段与历法显示（ADR-0002）。

### 4.2 性别枚举（自定义，非二元）

```yaml
genders:
  - { id: male, label: 男 }
  - { id: female, label: 女 }
  - { id: femboy, label: 男娘 }
  - { id: agender, label: 无性别 }
  - { id: custom-1, label: 武装直升机 }
```

- 角色的 `identity.gender` 只能取此处 `id`；Schema 校验引用完整性。
- 世界可定义任意档位，引擎不解释语义，只透传 label 展示。

### 4.3 心情（角色计量条，非补正）

```yaml
mood:
  min: 0
  max: 100
  defaultValue: 60
  bands:                        # 档位映射，区间不得重叠，按 min 升序
    - { id: low, label: 消沉, min: 0, max: 40, attributeModifiers: { intellect: -1 } }
    - { id: normal, label: 平静, min: 41, max: 70, attributeModifiers: {} }
    - { id: high, label: 高昂, min: 71, max: 100, attributeModifiers: { physique: 1 } }
```

- 心情变化来源：效果 DSL 的 `adjustMood`、补正的 `simulation.moodDeltaPerTurn`、事件结算。
- 档位修正并入属性结算管线，与补正修正同一套累加规则。

### 4.4 属性与资源

```yaml
attributes:
  order: [cursedEnergy, intellect, physique, agility]   # 世界自定义属性
  defaults: { cursedEnergy: 5, intellect: 6, physique: 5, agility: 5 }
  caps: { cursedEnergy: 999 }                            # 可选上限，缺省 999
  labels: { cursedEnergy: 咒力, intellect: 智力, physique: 体术, agility: 敏捷 }  # 显示名（可选，缺省回退属性 id）
resources:
  hp: { base: 100, perLevel: 10, perAttribute: { physique: 5 } }   # 上限 = base + perLevel*growthLevel + Σ perAttribute[attr]*基础属性值
  mp: { base: 50, perLevel: 5, perAttribute: { cursedEnergy: 2 } } # perAttribute 键必须是 attributes.order 中声明的属性（加载期校验）
regen:                                    # B3：回复节奏跟模拟轮次
  perTurn: { hp: 2, mp: 1 }               # 每模拟轮次自然回复
  actions:
    rest: { hp: 20, mp: 10 }              # 名为 rest 的行动提供额外回复
```

- HP/MP 为角色单一共享池：战斗与模拟读写同一池子，战斗结果持久化（见 10.3）。
- 等级成长来源由世界决定（熟练度、年龄、事件效果均可），V0.1 不内置"等级"概念，`perLevel` 中的 level 指角色 `growthLevel`（效果 DSL `adjustGrowth` 推进）。
- `perAttribute` 属性贡献使用**基础属性值**（不含补正/心情档位修正）：上限随临时状态波动会破坏回血 clamp 语义。敌人的资源池按其自身属性计算后整体乘 `levelScale`。
- 属性模型维持纯自定义（ADR-0002 附带确认）：引擎不引入 HP/ATK/DEF/SPD/HIT/EVA/CRIT/CRIT_DMG/RES 等通用基础属性语义，也不内置伤害/命中/暴击默认公式；世界观对公式的差异化诉求以扩展 preset 参数满足，不开放自由表达式 DSL。
- **显示名只来自模板**：属性名取 `attributes.labels`，资源名与心情名取 `statusBar`（§4.5）。引擎日志、投影与前端一律经此取名，不得在 `game-core` 硬编码世界观用词（R-NFR-05/06）；未声明时回退属性 id / 资源键，不得猜测。

### 4.5 状态栏（模板化）

```yaml
statusBar:
  - { id: sb-identity, label: 基本, source: identity }          # 姓名/年龄/性别固定区
  - { id: sb-mood, label: 心情, source: mood }
  - { id: sb-hp, label: 生命, source: resource, key: hp }
  - { id: sb-mp, label: 咒力, source: resource, key: mp }
  - { id: sb-attrs, label: 属性, source: attribute, keys: [cursedEnergy, intellect, physique, agility] }
  - { id: sb-status, label: 补正, source: status }              # 当前补正列表
  - id: sb-secret
    label: 咒力质感
    source: custom
    visibleWhen: [{ status: cursed-quality, present: true }]    # 区块级可见性条件
```

- `source` 枚举：`identity | attribute | resource | mood | status | custom`。
- 每个区块可带 `visibleWhen` 条件（第 12 节），投影阶段过滤。
- **显示名的唯一来源**：投影在 `snapshot.labels` 下发 `resources`（`statusBar` 中 `source: resource` 的 label）、`attributes`（`attributes.labels`，按 `order` 排序）与 `mood`（`source: mood` 的 label）；引擎生成的战斗日志同样经此取名。区块缺失时回退资源键/属性 id。
- 加载期校验：`source: resource` 必须声明 `key` 且只能为 `hp|mp`；`source: attribute` 必须声明 `keys`，且每个键都在 `attributes.order` 中（避免「写了错 key 但界面静默空掉」）。

### 4.6 判定参数的声明位置

- 判定参数不做「全局缺省」：每个技能在自己的 `hitCheck` / `damage` / `heal` 中就声明（见 7.1、10.4），逃跑判定写在事件 `settle.combat.fleeCheck`，缺省值即引擎内置默认（命中 `0.6`、clamp `0.05..0.95`）。
- 历史模板里的 `world.checks`（`opposedDefault` / `fixedDefault` / `scaledDefault`）从未被引擎读取，属死配置，已从 Schema 与协议移除（2026-11-11）。模板再写该字段会在加载期按未知字段拒绝，而不是静默忽略。

## 5. characters.yaml：角色

```yaml
- id: npc-gojo
  isEnemy: false
  identity:
    name: 五条悟
    age: 28
    gender: male
    description: 公开资料……
  visibility: public            # public | hidden（hidden 角色不进投影）
  mood: { value: 70 }
  attributes: { cursedEnergy: 99, intellect: 9, physique: 9, agility: 9 }
  public:                       # 玩家可见资料
    personality: 轻浮不定，实力深不可测
    knownGoals: [培养能改变咒术界的学生]
  private:                      # 仅引擎与条件系统可见，永不进投影
    secrets: [知晓世界线偏差]
    knowledge: [咒术界格局]
  relationship: 0               # 与玩家初始关系（-100..100）
```

- 敌人角色：`isEnemy: true`，供战斗事件 `enemies[].ref` 引用；同样走角色协议，私有块可放战斗行为参数。
- 心情与属性为初始值，运行时由引擎维护；模板只给初值。
- `skills` 为角色初始持有的技能（战斗技能供战斗中使用，通用技能影响选项可见性）；NPC 与敌人同样适用。敌人 AI 的 `private.combatHints.skillWeights` 的 key 必须是该角色已持有的技能（Schema 顶层校验）。
- 玩家角色不在此文件（由创建输入生成），但世界可定义玩家初始模板 `playerTemplate`（初始属性/技能/物品/心情）。

## 6. statuses.yaml：补正（单定义双面）

### 6.1 定义

```yaml
- id: poison
  name: 中毒
  description: 每回合损失生命。
  duration: { turns: 3 }             # 唯一生命周期：跟世界轮次；until-cured 表示只能被解除
  stacking: refresh                  # refresh | stack | unique（重复施加时）
  simulation:                        # 模拟面（可选；缺省 = 战斗结束清除该补正）
    attributeModifiers: { physique: -2 }
    actionEfficiency: { train: -0.3 } # 行动效率修正（按 actionId）
    moodDeltaPerTurn: -1              # 每轮心情漂移
    eventConditionTag: wounded        # 供条件系统 status 查询的标签
  combat:                            # 战斗面（可选；缺省 = 不带入战斗）
    control: [cannot_use_skills]     # 控制语义白名单，OR 合并
    damageDealt: -0.2                # 数值修正（累加）
    damageTaken: 0.1
    onRoundEnd:                      # DOT/回合结算（按战斗回合）
      - { damage: { preset: fixed, value: 3 } }
    battleRounds: 2                  # 可选：战斗内 N 回合后失效；缺省整场有效
  cureConditions:                    # 可选：解除途径
    - { item: item-antidote }
    - { restTurns: 2 }               # 休息 N 轮自动解除
  visibility: known                  # known（玩家可见）| hidden（仅引擎可见，如敌方增益）
```

- `simulation` 与 `combat` 至少定义其一（Schema 校验）。
- 单一定义双面意味着状态栏与记录中同一状态只有一个名字。

### 6.2 转换规则（引擎固定，模板不可覆盖）

- 进入战斗：定义了 `combat` 面的补正激活战斗效果；未定义则战斗中休眠（无效果但不消失）。
- 战斗结束：定义了 `simulation` 面的补正存续并继续按世界轮次计时；只有 `combat` 面的补正自动清除。
- 战斗中：`duration.turns` 不递减（战斗不消耗世界时间）；`onRoundEnd` 按战斗回合结算；`battleRounds` 用尽后该补正在战斗内失效。
- 施加途径仅三条声明式途径：技能命中、事件结算、物品使用。战斗外的技能/事件只能施加含 `simulation` 面的补正；战斗内可施加任意面。
- 条件系统可查询补正（`{ status: poison, present: true }` 或按层数 `stacksGte`），但效果不允许直接"写"任意补正——补正的增删只来自上述三条途径。

### 6.3 战斗面三要素（独立结算）

1. 控制语义（白名单，引擎固定含义）：
   - `cannot_act`：跳过整个回合，隐含以下全部。
   - `cannot_use_skills` / `cannot_use_items` / `cannot_attack` / `cannot_flee`：单项禁用。
   - `forced_target_self`：行动目标强制为自身（嘲讽类预留）。
   - 合并规则：多补正 OR（任一为真即生效）；`cannot_act` 优先级最高。
2. 数值修正：`damageDealt` / `damageTaken` / `hitChance` 等，多补正间累加。
3. DOT/回合结算：`onRoundEnd` 列表，按战斗回合执行。

白名单之外的战斗语义（反射/吸血/复活等）V0.1 不做，见 OPEN_QUESTIONS。

## 7. skills.yaml：技能

### 7.1 战斗技能

```yaml
- id: sk-cursed-strike
  kind: combat
  name: 咒力斩击
  description: ……
  cost: { mp: 10 }                        # 消耗共享 MP 池
  target: enemy                           # enemy | self | ally | all_enemies
  hitCheck: { preset: opposed, attacker: accuracy, defender: evasion }   # 省略 = 必中
  damage:
    - { preset: scaled, base: 10, scaleBy: cursedEnergy, multiplier: 1.5 }
    - { preset: stack-scaled, base: 10, perStack: 15, status: absorbed-curses }  # 按施放者补正层数缩放
  heal:
    - { preset: fixed, value: 5 }
  applyStatus:
    - { status: stun, chance: 0.3 }              # 缺省施加给技能目标
    - { status: absorbed-curses, stacks: 1, onSelf: true }   # onSelf: 施加给施放者自身
  consumeStatus: { status: absorbed-curses }     # 施放结算后移除施放者自身该补正（献祭类技能）
  cooldownTurns: 1                        # 战斗回合冷却；用大值（如 99）近似"每场一次"
  usableInBattle: true
```

- `hitCheck` 可省略（必中）；`damage` 为公式列表，依次结算。
- `scaleBy` 引用角色属性 id（含补正修正后的有效值）；`stack-scaled` 的 `status` 引用补正 id，读取施放者当前层数（`base + stacks * perStack`）。
- 结算次序（实现阶段遵循）：消耗 → 命中判定 → 伤害/治疗 → 施加补正 → 最后 `consumeStatus`（献祭发生在输出结算之后，漩涡先按层数出伤再失去咒灵）。
- `target: all_enemies` 时伤害/补正作用于对方全体（命中判定逐个结算）。
- `hitCheck.attacker` / `hitCheck.defender`（`fleeCheck` 同）都是属性 id 引用，必须在 `attributes.order` 中声明：加载期校验并拒绝，避免写错属性名后被静默当作 0 参与判定。

### 7.2 通用技能

```yaml
- id: sk-investigation
  kind: general
  name: 调查
  description: ……
  unlocksOptions: [opt-investigate]       # 解锁事件选项/行动选项
  efficiency: { key: train, bonus: 0.2 }  # 行动效率修正
  proficiency: { maxLevel: 5, growthPerUse: 1 }   # 熟练度：使用成长，事件效果亦可成长
```

- 通用技能在投影中展示为"已掌握技能"；其 `unlocksOptions` 参与选项可见性判定。

## 8. items.yaml：物品

```yaml
- id: item-antidote
  type: consumable            # consumable | material | key | equipment（预留）
  name: 解毒剂
  description: ……
  stackable: true
  usableInBattle: true        # 战斗中可用（受补正 control 的 cannot_use_items 约束）
  usableOutsideBattle: true
  use:                        # 使用效果（效果 DSL，见第 12 节）
    - { cureStatus: poison }
- id: item-curse-tool
  type: key
  name: 咒具·残刃
  stackable: false
  usableInBattle: false
  usableOutsideBattle: false
```

- 库存为角色级映射 `{ itemId: count }`；获取途径由事件/战斗奖励的 `grantItem` 效果提供。
- `equipment` 类型 **V2.1 起正式启用**（用户 2026-11-11 决策 ③：词条统一动态补正）。定义/实例分离：`ItemSchema` 的 equipment 分支描述**定义**（`slot` / `category` / `quality` / `dynamicModifier`），`EquipmentInstance` 只存 `itemId / ownerId / slot / stacks? / durability?`，**不存补正结果**。完整字段、preset 白名单与求值链见 §19。

```yaml
- id: item-cursed-ring
  type: equipment
  name: 咒缚之戒
  slot: accessory
  category: ring
  quality: rare
  dynamicModifier:
    preset: stack-scaled           # 只允许 §10 既有 preset 白名单
    params: { attribute: cursedEnergy, base: 2, perStack: 1 }
    conditions:                    # 声明式条件，见 §12
      - { status: absorbed-curses, present: true }
```

## 9. events.yaml：事件三段式、链与池

### 9.1 三段式结构

```yaml
- id: ev-curse-sighting
  title: 市区咒灵目击
  narrative: 新宿方向的结界出现波动……
  trigger:                          # 一、触发
    source: pool                    # pool | chain | schedule | action-hook
    conditions: [...]               # 第 12 节条件 DSL
    probability: 0.3                # 与 weight 二选一
    weight: 5
    cooldownTurns: 4
    once: false
    priority: 10
  kind: random                      # 二、类型：normal | random | combat
  settle:                           # 三、结算（按 kind 分派）
    random:
      wheel:
        segments:
          - { weight: 5, label: 发现咒灵巢穴, effects: [...], nextEventId: ev-curse-investigate }
          - { weight: 2, label: 虚惊一场, effects: [...] }
```

### 9.2 普通事件（normal）与选项出现条件

```yaml
  kind: normal
  settle:
    normal:
      options:
        - id: opt-investigate
          text: 前往调查
          visibleWhen:                       # 选项出现条件（玩家不可见的选项不出现在投影）
            - { requiresSkill: sk-investigation }
            - { attribute: physique, gte: 5 }
          effects: [...]
          nextEventId: ev-curse-investigate  # 可选：选项后进入下一事件（形成交互序列）
        - id: opt-ignore
          text: 无视
          effects: [{ adjustMood: -2 }]
```

- 选项是普通事件的"行动"；`visibleWhen` 全部满足才进投影。
- 选项链（`nextEventId`）允许一个事件接入另一个事件；事件链仍由 chain 定义管理宏观推进（见 9.3）。

### 9.3 事件链

```yaml
chains:
  - id: chain-exchange
    startEventId: ev-exchange-notice
    steps:                    # 线性链主干（分支用事件的 nextEventId 表达）
      - { eventId: ev-exchange-notice, advanceWhen: nextTurn }
      - { eventId: ev-exchange-open, advanceWhen: nextTurn }
    pauseWhenHidden: true     # 关键 NPC 不在可见集合时暂停推进
```

- 链状态机沿用 V1：`pending -> active -> completed | paused | cancelled`。
- `advanceWhen: nextTurn` 表示上一事件结算后的下一轮推进；战斗/转盘类步骤在对应 settle 完成后推进。

### 9.4 世界事件池

- 模板内全部 `source: pool` 的事件构成事件池；引擎每轮按"条件 -> 冷却/once -> 概率或权重 -> 优先级"结算（沿用 CORE_ENGINE 规则，条件在逐个结算时求值以支持同轮因果）。
- `source: schedule` 为定时事件（`atTurn` 按轮次、`atWorldTime` 按相对世界起始的 `TimeAmount` 偏移触发）；`action-hook` 为行动钩子事件（`onActionId` 在玩家执行对应行动时触发）。

### 9.5 NPC 自主行动（npcActions）

NPC 自主行动是**触发式 + 效用评分 + 兜底随机**，而非每轮全量轮询（ADR A6）：

```yaml
npcActions:
  - id: npc-train
    summary: "{name} 独自打熬咒力。"        # {name} 替换为 NPC 名
    trigger:
      probability: 0.25                      # 兜底随机触发概率
      cooldownTurns: 2                       # 同一 NPC 两次执行的最小间隔
      conditions: []                         # 条件 DSL（世界 flag/关系/时间等）
      requireKnowledge: [jujutsu]            # 信息差：NPC knowledge 必须包含
    utility:                                 # 效用评分
      base: 1                                #   得分 = base + 目标命中 + 性格命中 + 随机
      goalMatch: [become-stronger]           #   命中 NPC private.goals 标签加分
      traitAffinity: [diligent]              #   命中 NPC private.traits 标签加分
    effects:                                 # 复用效果 DSL；adjustRelation npcId 可用 __self__ 表示执行者
      - { type: adjustRelation, npcId: __self__, value: 1 }
```

- NPC 运行时私有字段 `private.goals` / `private.traits` / `private.knowledge` / `private.secrets` 不进投影，仅参与效用评分与信息差约束。
- 每个 NPC 每轮至多自主行动一次；行动结果写入 history（`npc_action` 类型，`summary` 为玩家可见摘要）。

## 10. 战斗协议

### 10.1 战斗事件与状态机

```yaml
  kind: combat
  settle:
    combat:
      enemies: [{ ref: enemy-grade2-curse, levelScale: 1 }]
      canFlee: true
      fleeCheck: { preset: opposed, attacker: agility, defender: agility, baseChance: 0.5 }
      onVictory: { effects: [...], nextEventId: ... }
      onDefeat: { effects: [...], nextEventId: ... }
      onFlee: { effects: [...] }        # 可选
```

- 状态机：`pending -> active(player_turn | enemy_turn) -> victory | defeat | fled`。
- 玩家回合可选：技能 / 道具 / 普攻 / 逃跑；全部受补正 control 过滤（见 10.2）。
- 敌人为角色模板引用，`levelScale` 缩放其属性与 HP/MP 上限。

### 10.2 回合流程

- 回合开始：汇总参战方全部补正的 control 语义（OR 合并）。
- `cannot_act` 或过滤后无可用行动 → 跳过回合。
- 否则玩家（或敌人 AI）选择行动 → 命中判定 -> 伤害结算 -> 施加补正 -> 回合结束结算（双方 `onRoundEnd`、`battleRounds` 递减）。
- 敌人 AI：V0.1 采用模板可配置的简单权重策略（可用技能列表 + 权重），复杂策略见 OPEN_QUESTIONS。

### 10.3 资源持久化（B3）

- 战斗直接读写共享 HP/MP 池，战斗结束结果持久化。
- 战斗不消耗世界时间；`duration.turns` 类补正在战斗中不递减。
- 战斗中 HP 最低打到 1（不死）；善后（施加轻伤补正、事件分支）由胜负结算效果承担。
- 模拟域 HP 归零的含义为模板可定义项，默认"重伤 + 强制休息"，死亡规则见 OPEN_QUESTIONS。

### 10.4 判定与伤害 preset（V0.1 白名单）

```text
opposed : { attacker, defender, baseChance }   命中率 = baseChance + (攻击值 - 防御值) * 0.05，截断 0.05..0.95
fixed   : { value }                            固定值
scaled  : { base, scaleBy, multiplier }        base + 属性值 * multiplier
stack-scaled : { base, perStack, status }      base + 施放者指定补正层数 * perStack
```

- 公式结果即最终值，**不做随机浮动**（`fixed: 10` 恒为 10）。随机只发生在命中判定、转盘与补正施加概率上，且全部取自战斗专用 RNG（由轮次 seed 派生），保证复现。
- 治疗（技能 `heal`、补正 `onRoundEnd.heal`、物品 `adjustResource`）一律截断到目标 HP 上限；伤害下限 0。
- 自由表达式 DSL 列入 OPEN_QUESTIONS（安全考量，V0.1 不做）。

## 11. 随机与转盘

- 随机事件（kind: random）的 `wheel.segments` 为加权扇区；服务端按权重随机选中一个扇区并直接结算其 effects。
- **属性加权**：扇区可选 `weightBy`（属性 id → 每点系数），最终权重 = `max(0, weight + Σ(玩家有效属性值 × 系数))`。属性取含补正/心情档位修正后的有效值；系数可为负（如"凶"随幸运收敛）。支持多属性叠加（如 `weightBy: { luck: 0.4, cursedEnergy: 0.1 }`）。
- 前端仅播放转盘动画揭示服务端已确定的结果（纯展示），转盘扇区展示 `label` 与权重。
- 转盘、概率、判定共用注入 seed 的 RNG；同 seed 同指令结果一致（属性加权发生在随机抽样之前，确定性不受影响）。
- 事件池的 `trigger.weight` 目前为静态值；属性加权（如幸运影响遭遇稀有事件）如需要再扩展，见 OPEN_QUESTIONS。

## 12. 条件与效果 DSL（通用）

条件（全部可组合，数组内 AND 语义）：

```text
{ flag: <id>, eq|ne|gte|lte|gt|lt: <value> }        世界 flag 比较
{ attribute: <id>, gte: <n> }                        角色有效属性（含补正/心情档位修正）
{ status: <id>, present: true } / { status, stacksGte: <n> }
{ inventory: <itemId>, gte: <n> }
{ mood: { gte: 40 } }
{ relation: <npcId>, gte: <n> }
{ requiresSkill: <skillId> }
{ random: <0..1> }                                   判定时掷一次
{ time: { gte|gt|lte|lt: <TimeAmount> } }            世界时间比较（相对世界起始的偏移）
```

效果（声明式，引擎白名单实现）：

```text
setFlag / clearFlag            写世界 flag
adjustAttribute / adjustResource（hp/mp）/ adjustMood / adjustRelation
grantItem / removeItem
applyStatus / cureStatus       施加/解除补正（仅这三条途径可施加）
unlockSkill / adjustProficiency / adjustGrowth
startChain / advanceChain / cancelChain
log(visibility)                写历史记录并标注可见性
```

## 13. 校验规则清单

Schema 层（加载即校验）：

- strict mode 拒绝未知字段；枚举字段（unit、kind、source、visibility、stacking、control、preset）只接受白名单值。
- 补正必须定义 `simulation` 或 `combat` 至少其一；`mood.bands` 区间不重叠且覆盖 min..max。
- `probability` 与 `weight` 二选一；`duration.turns` 为正或 `until-cured`。

引用完整性层（加载器校验）：

- genders / attributes / resources / skills / items / statuses / events / chains / characters 的 id 全库唯一。
- 技能 `applyStatus[].status`、物品 `use[].cureStatus`、条件 `status`/`inventory`/`requiresSkill`、战斗 `enemies[].ref`、事件 `nextEventId`/`chainId`/`startEventId` 均须指向已定义实体。
- 属性槽位引用：技能 `hitCheck.attacker/defender`、战斗 `fleeCheck.attacker/defender`、`attributes.labels` 的键、`statusBar` 的 `key`（resource）与 `keys`（attribute），均须指向 `attributes.order` 已声明的属性或已定义资源。
- 事件链 `startEventId` 的 `trigger.source` 必须为 `chain`。

### V2.1 新增校验（加载即拒绝，错误信息须含字段路径）

- **开局（§16）**：`OpeningTemplateSchema` strict；`openingId` 全库唯一；`steps[].kind` 与 `eventPools[]` 抽取字段只取白名单；`completionConditions` 非空；`handoff` 的 `pendingEvents` / `schedule` 引用完整性；**不得出现 `phase` / `stage` 字段**。
- **结局 / 终止（§17）**：`EndingConditionSchema` 的 `type` 只取七类白名单（含 `battleDefeat`）；`combinator` 为 `AND|OR`；`terminationMode` 为 `immediate|afterSettle`；**拒绝任何以 `hp <= 0` / `hp == 0` /「HP 归零」为条件的结局声明**（R-EN-07 / P9）；`DeathRoute.deathMode` 只取 `event|direct`，`event` 路径的 `deathEventId` 必须指向已定义事件；`EndingTemplateSchema` 不含评分字段；`TerminationRecord` 由引擎固化，**模板不得声明或写入**。
- **评价（§18）**：`EvaluationConfigSchema` strict；维度 id 唯一、权重为有限正数、`ranges` 不重叠；模板可增删改名调权但不得声明硬编码 `overall` 总分；**结局类型不得作为评分维度或权重来源**。
- **装备（§19）**：`dynamicModifier.preset` 只取既有 preset 白名单（含 `stack-scaled`）；`params` 按 preset 形状 strict 校验；**拒绝 `modifierMode` / `static|dynamic` 二选一字段、拒绝自由表达式（任何字符串公式）、拒绝 `attributeModifiers.perStack`**（S3 #18 延期，须报可诊断错误而非静默忽略）；`slot` 必须在 `equipment.yaml` 的 `slots[]` 中。
- **战斗 AI（§20）**：`PublicConditionContext` 字段白名单校验——条件引用只能是玩家投影可见字段、`visibility: "public"` 的日志/效果、该阵营已公开战斗状态；**加载期拒绝** `hidden` / `unknown` / `secrets` / `combatHints`（敌方私有）/ `knownGoals`（NPC 私有目标）/ 任何指向完整 `WorldStateV2` 的引用，错误信息须给出具体字段路径且不留部分初始化状态（R-CA-06）；`actionId` 必须是引擎已注册行动。
- **跨分域**：`openingId / endingId / dimensionId / styleId / slot` 纳入全库 id 唯一校验；所有新分域均 strict mode 拒绝未知字段。

## 14. 必须覆盖的测试

- JJK 示例模板六个 YAML 通过 `WorldTemplateV2Schema` 校验。
- 非法样例被拒绝：双面均缺失的补正；未知 control 语义；未知字段；引用断裂（技能指向不存在的补正、事件指向不存在的链）；mood 区间重叠；probability 与 weight 并存。
- 加载器引用完整性测试与 Schema 测试同套件（实现阶段补引擎测试：进战斗带入/带出转换、control OR 合并、HP 持久化、转盘 seed 复现）。
- 显示名与判定引用：`snapshot.labels` 与模板 `statusBar`/`attributes.labels` 一致且缺失时回退 id；`hitCheck`/`fleeCheck` 指向未声明属性被拒、模板写 `world.checks` 被按未知字段拒绝；`cannot_attack` 与 `forced_target_self` 在玩家侧与 AI 侧各有一条用例；战斗内物品含非白名单效果时拒绝且不扣库存；`fixed` 公式不再有浮动（`fixed: 10` 恒为 10）；技能治疗与物品治疗一样 clamp 到 HP 上限。

### V2.1 新增测试（按需求编号）

- **开局**：同 seed 抽取可复现、互斥组至多命中一个、必选必出现、`countRange` 落在区间（R-OP-04）；两个不同开局模板均加载通过（R-OP-01）；缺字段报错含路径。
- **结局 / 终止**：七类条件与 AND/OR、`immediate` / `afterSettle` 各有测试且无半更新状态（R-EN-02/03）；三结局同时满足时 `priority` 决胜稳定、无专属命中走 `fallback`、隐藏结局未解锁不进候选（R-EN-04/05）；**`deathMode: event` / `direct` 两条路径各有测试，且都不改写 HP**（R-EN-08 / P9）；任意结算后 `state.player.hp >= 1`（R-EN-07）；`markTerminated()` 幂等与归档只读（P2/P3）。
- **评价**：同结局不同过程得分不同、同过程不同结局得分可相近（R-EV-01/02）；每条 `evidenceIds[]` 可在本局历史解析（P6）；篡改分数的 LLM 输出被拒（R-EV-05）。
- **装备**：模板声明 `modifierMode` / 自由表达式被拒（R-EQ-02/06）；同一装备在两份不同状态下补正值不同、穿脱前后基础属性逐字段不变（R-EQ-03/04 / P8）；`perStack` 报可诊断错误；槽位冲突被拒；同 seed 回放补正序列一致。
- **战斗 AI**：五步可单测、候选集不含被禁止行动（R-CA-01）；三种风格至少一次决策不同（R-CA-02）；低血治疗条件命中/不命中（R-CA-03）；**引用隐藏字段的模板在加载期被拒**、非法 actionId 回退、同 seed 决策一致且上下文不含隐藏字段（R-CA-04/05/06 / P7）。
- **静态边界**：无 `lifecycle.ts` / `Phase` / `PhaseTransitionLog` / `transition(state, to: Phase)` / `assertPhase`；`ending.ts` 不读取 HP 判死；`decide()` 不接收完整 `WorldStateV2`；`game-core` 无世界观专名常量（R-TM-03 / R-EN-07 / R-CA-06 / R-NFR-06）。
- **LLM 失败注入**：全链路不可用时仍可到达归档只读，叙事与总结回退模板文本并记录 `summarySource: fallback`（R-EN-06 / R-NFR-03）。

## 15. 与 V1 的关系与迁移（已完成，2026-11-11）

- **当前状态**：引擎与运行时模板已全部切到协议 V2。`apps/server` 启动时经 `loadTemplates()` 加载 `specs/data/templates/<world-id>/` 六文件 YAML → `WorldTemplateV2Schema` 校验 → V2 引擎消费；`/health` 返回 `protocol: "v2"`。
- **V1 已下线**：删除 `game-core/src/{time,events,evaluation,world,turn}.ts`、`data/jjk.ts`、`core.test.ts`、`time.test.ts` 与 `shared/src/legacy.ts`（含空的 `data/` 目录）；移除 `shared` 的 `./legacy` 子路径导出、`tsconfig.json` 与 `vitest.config.ts` 的 legacy alias、`game-core/src/index.ts` 的 V1 导出块。
- **例外保留**：`game-core/src/rng.ts` 是 V2 共用的确定性 RNG（`v2/{battle,engine,npc,turn}.ts` 直接 `import "../rng.js"`），不属于 V1 遗留，继续保留并导出。
- **验收**：`pnpm typecheck` 0 错误；game-core 46/46、shared 23/23；web build 通过；server `/health` 与 `/api/templates` 正常。JJK YAML 与旧 `jjk.ts` 的逐行为等价对照按项目决定未单独补齐，以 V2 全量测试与运行时验证为准。
- **沿革说明**：本文件中「沿用 V1 TimeAmount 语义」「链状态机沿用 V1」以及各章「实现阶段」措辞，均为协议设计时的来源标注或实现要求，不表示 V1 代码仍存在。

------------------------------------------------------------------------

## 16. opening.yaml：开局（V2.1 新增）

**Schema 落点**：`packages/shared/src/schema/opening.ts` → `OpeningTemplateSchema` / `OpeningRunSchema`；`EventInstanceSchema`（实例级 `origin` 元数据）落在 `schema/event-instance.ts`。全部 strict。

| 字段 | 类型 | 说明 |
|---|---|---|
| `openingId` / `name` / `description` | `string` | `openingId` 全库唯一，按 id 选择开局 |
| `entryConditions` | `Condition[]` | §12 条件 DSL，选择该开局的门槛 |
| `steps[]` | `{ id, kind: required\|optional\|branch, ref? }` | 必经/可选/分支步骤；模板可增删 |
| `characterSetup` / `worldSetup` / `npcSetup` | `object` | 初始角色、世界、NPC；关系须带 `source`，**未声明关系不得默认为相识** |
| `eventPools[]` | `{ id, countRange, exclusiveGroup?, sequence?, seed?, events[] }`；`events[]` 每项含 `id / tags[] / weight / conditions[] / required / effects[] / nextEvents[]` | 抽取字段白名单；不提供自定义表达式 |
| `objectives` / `choices` | `object` | 初始目标与关键节点玩家选择 |
| `completionConditions` | `Condition[]` | 满足才允许 `handoff()` |
| `handoff` | `{ pendingEvents: eventId[], schedule: object[] }` | 未完成即时事件与未来事件的去向 |

```yaml
- openingId: op-2006-tokyo
  name: 2006 · 东京高专
  steps:
    - { id: step-character, kind: required }
    - { id: step-first-choice, kind: branch, ref: ev-first-day }
  eventPools:
    - id: pool-opening-random
      countRange: [1, 3]
      events:
        - { id: ev-meet-senpai, tags: [campus], weight: 3, required: true }
        - { id: ev-curse-omen,  tags: [night],  weight: 1, exclusiveGroup: omen }
  completionConditions:
    - { flag: openingDone, eq: true }
  handoff:
    pendingEvents: [ev-first-day]
    schedule: []
```

**硬约束**

- 开局事件复用统一事件系统：连续事件进现有 chains，未来/条件事件进现有 schedule；**不新增事件栈调度器、不新增 `source` 枚举**（附录 A A4/A5）。实例级 `origin: { kind: "opening", id: openingId }` 只是元数据，不参与事件类型判定。
- `completionConditions` 满足后 `handoff()` 置 `openingCompleted = true`（ADR-0004 / R-TM-02）；**不得**产出 `phase` / `LifecycleState` / 阶段日志。
- 同 seed + 同模板抽取结果一致；`exclusiveGroup` 至多命中一个、`required` 必出现、数量落在 `countRange`；固定主事件与随机遭遇走同一抽取管线。
- `EventInstance` 保持 `instanceId / definitionId` 可区分（R3 穿越 seam），本轮只写 `origin`，**不引入 `EventRecord`**。

## 17. endings.yaml：终止条件、结局与死亡路径（V2.1 新增）

**Schema 落点**：`packages/shared/src/schema/ending.ts` → `EndingConditionSchema` / `EndingTemplateSchema` / `EndingRecordSchema` / `DeathRouteSchema` / **`TerminationRecordSchema`**（并入同文件，**不新增 `lifecycle.ts` 或 `termination.ts`**）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `terminationConditions[]` | `{ type, params, combinator: AND\|OR, terminationMode: immediate\|afterSettle }` | `type` 七类白名单：`timeReached / characterState / objective / worldState / eventOccurred / playerRequested / battleDefeat` |
| `endings[]` | `EndingTemplate` | `endingId / name / description / triggerConditions / priority / endingType / narrativeConfig / visibility / exclusiveGroup / fallback`；`visibility` 取 `public\|hidden`，`hidden` 结局未解锁不进候选集（R-EN-05 / R-NFR-04） |
| `deathRoute` | `DeathRoute` | `{ deathMode: event\|direct, deathEventId?, conditions[] }`；引擎不硬编码死亡判定 |
| `fallback` | `endingId` | 无专属命中时的兜底结局 |

```yaml
terminationConditions:
  - { type: objective, params: { objectiveId: main }, combinator: AND, terminationMode: afterSettle }
  - { type: battleDefeat, params: { minSeverity: fatal }, combinator: OR, terminationMode: immediate }
deathRoute:
  deathMode: event
  deathEventId: ev-death-funeral       # 复用既有事件定义，不新增 source 枚举
  conditions:
    - { flag: fatalWound, eq: true }
endings:
  - endingId: end-hero
    priority: 10
    triggerConditions: [{ flag: mainObjectiveDone, eq: true }]
    narrativeConfig: { source: template }
    visibility: public
fallback: end-ordinary
```

**硬约束**

- 终止只在明确模拟边界检查（事件结算后 / 时间推进后 / 玩家主动结束），命中后**先结算完当前事件**再写 `termination`，不留半更新状态（R-TM-01 / R-EN-02）。
- **HP 不得作为终止或死亡判据**（R-EN-07 / P9）；协议在加载期拒绝 `hp <= 0` 类条件；重伤/昏迷由模板以补正或事件效果表达，不引入「HP 归零」语义。
- 战败（`over = "defeat"`）且死亡条件满足 ⇒ `deathMode: event` 生成模板死亡事件走既有 chains 结算后触发结局，或 `direct` 直接触发结局；两条路径都统一走 `markTerminated()`、都不改写 HP、不新增事件类型枚举；条件不满足则继续模拟（R-EN-08）。
- `TerminationRecord`（`reason / worldTime / turnIndex / endingId? / source`）由引擎 `v2/ending.ts` 固化且幂等；模板只声明条件与结局，**不得写终止记录、不得包含评分字段**。
- 不产出 `Phase` / `PhaseTransitionLog` / `LifecycleState` / `lifecycle.ts`（ADR-0004 否决六阶段状态机）。

## 18. evaluation.yaml：人生评价（V2.1 新增）

**Schema 落点**：`packages/shared/src/schema/evaluation.ts` → `EvaluationConfigSchema` / `EvaluationRecordSchema`。

六通用维度（可由模板增删改名、调权）：`relationships / achievements / choices / growth / influence / regrets`；每条含 `id / label / weight / ranges / explainRules`。`EvaluationRecord` 每维度输出 `{ id, score, level, explanation, evidenceIds[] }` + `summary` + `summarySource`。

```yaml
dimensions:
  - { id: relationships, label: 羁绊, weight: 1.0, ranges: [0, 100], explainRules: [relation-events] }
  - { id: achievements,  label: 成就, weight: 1.2, ranges: [0, 100], explainRules: [objective-events] }
worldSpecificDimensions:
  - { id: cursedEnergyMastery, label: 咒力掌控, weight: 0.8, ranges: [0, 100], explainRules: [skill-events] }
```

**硬约束**

- 基于过程记录（事件历史 / 选择 / 关系变化 / 目标）确定性评分；**结局类型仅作背景，不得直接映射总分**（R-EV-01/02）。
- 每维度 `evidenceIds[]` 必须能在本局历史解析（P6）；LLM 只组织语言，不得决定分数、改写维度或证据；结构校验失败/超时回退模板文本并记 `summarySource: fallback`（R-EV-05 / R-NFR-03）。
- 本模块是评价的**唯一事实来源**：`v2/projection.ts` 的 `evaluateSummaryV2` 现算评价由 T4-04 取代；`specs/engine/CORE_ENGINE.md §8` 已标注由本规格取代，避免仓库内出现两份互相冲突的评价事实来源。
- 归档只读后评价不得回写结局或 `state.player`（R-EV-06 / R-AR-02 / P3）。

## 19. equipment.yaml + items.yaml 扩展：装备与动态补正（V2.1 新增）

**Schema 落点**：`packages/shared/src/schema/equipment.ts` + `schema/item.ts` 的 equipment 分支 → `EquipmentDefinitionSchema` / `EquipmentInstanceSchema` / `DynamicModifierSpecSchema`。

| 分域 | 字段 | 说明 |
|---|---|---|
| `equipment.yaml` | `slots[]: { id, label, allowedCategories[], maxCount }`、`initialEquipment[]` | 槽位与初始装备 |
| `items.yaml`（`type: equipment`） | `slot / category / quality / dynamicModifier` | 装备**定义** |
| `EquipmentInstance`（运行时） | `itemId / ownerId / slot / stacks? / durability?` | **不存补正结果** |

```yaml
# equipment.yaml
slots:
  - { id: weapon,   label: 武器, allowedCategories: [blade, cursed-tool], maxCount: 1 }
  - { id: accessory, label: 饰品, allowedCategories: [ring, charm],        maxCount: 2 }
```

**动态补正（用户决策 ③）**

- 每次结算由 `evaluateDynamicModifier(spec, ctx)` 按当前状态 / 补正层数 / 条件 / 心情档位求值；`preset` 只取 §10 既有白名单（含 `stack-scaled` 的 `base + stacks * perStack`），`params` 按 preset 形状 strict 校验；**不接受自由表达式 DSL**（ADR-0001 / ADR-0002）。
- 求值结果并入 `effectiveAttributes()` 的**运行时累加链**（基础值 → 状态补正 × 层数 → 装备动态补正 → 心情档位 → caps），**不写回 `state.player.attributes`、不写入 `EquipmentInstance`**；固定值只是「无条件、无层数」的退化 preset，走同一管线。
- **不提供 `modifierMode: static|dynamic` 二选一**；模板声明该字段或自由表达式 ⇒ 加载期拒绝并给出字段路径（R-EQ-02/06）。
- `attributeModifiers.perStack`（S3 #18 通用属性补正模型）本轮明确报可诊断错误，不得静默忽略。
- 穿脱/替换经 Zod 校验槽位冲突；同 seed 回放补正序列逐次相等（R-EQ-05 / R-NFR-01 / P8）。

## 20. combat-ai.yaml：战斗风格与条件化策略（V2.1 新增）

**Schema 落点**：`packages/shared/src/schema/combat-ai.ts` → `CombatStyleProfileSchema` / `ConditionalStrategySchema` / `PublicConditionContextSchema`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `styleId` | `string` | 风格标识，**仅为模板数据，引擎不得按风格名分支** |
| `candidateFilters[]` | `ActionFilter[]` | 行动过滤参数 |
| `scoreWeights` | `Record<actionId, number>` | 评分权重 |
| `conditions[]` | `ConditionalStrategy[]` | 条件化策略，只引用 `PublicConditionContext` 字段 |

```yaml
- styleId: cautious
  scoreWeights: { sk-heal: 2.0, sk-guard: 1.4, sk-attack: 0.8 }
  conditions:
    - when: { publicPlayerHpRatio: { lte: 0.3 } }   # 公有字段：玩家投影可见的 HP 比例
      prefer: [sk-heal]
```

**硬约束**

- 五步决策：① 规则约束（控制语义 / 资源 / CD 过滤，只用已注册 `actionId`）→ ② 候选集 → ③ 评分（`scoreWeights` + 条件化策略 + 可选注入 RNG 扰动）→ ④ 最高分选择（平局按模板决胜，默认稳定排序）→ ⑤ 交回 `v2/battle.ts` 既有结算路径；**AI 不自行写状态**（R-CA-01/05）。
- 风格只解析为权重/过滤参数，**引擎内不得出现风格名常量或分支**（R-CA-02）。
- 条件求值的**唯一输入**是 `PublicConditionContext` = 玩家端投影可见字段 + `visibility === "public"` 的日志/效果 + 该阵营已公开战斗状态。禁止 `hidden` / `unknown` / `secrets`、`combatHints`（敌方私有）、`knownGoals`（NPC 私有目标）、完整 `WorldStateV2` 与服务端内部状态。
- ⚠️ **现有 `v2/battle.ts:151` 的 `def.private.combatHints?.skillWeights` 属于既有简单权重 AI 的敌方私有提示，不得被包装成条件化策略的求值输入**；否则隐藏信息会泄漏进决策（R-CA-06 / P7）。
- 模板引用非公有字段在**加载期**由 Zod/协议校验拒绝并给出字段路径，且无部分初始化状态；运行时不得静默降级（R-CA-06）。
- 不依赖 LLM；同 seed + 同状态 + 同模板决策一致；非法 `actionId` 被拒并回退合法候选（R-CA-04/05 / P1）。

### V2.1 边界声明

- 本轮**不交付**：时间穿越章节、`WorldLineRecord`、`jumpTo()`、隐秘未来事件、ADR-0005、Steins;Gate 穿越剧本，以及六阶段 Lifecycle 状态机 / `lifecycle.ts` / `PhaseTransitionLog`。
- §16–§20 是**协议层约定**：Zod Schema 草案由 T1-03 定义、实现由阶段 3–6 落地；5 个新分域文件可选，未提供的世界不受影响。
- 世界时间仍经 `TimeAdapter`（ADR-0002）；§16–§20 **不得写死「时间单调 / 未来事件不可撤销」假设**。`EventInstance` 的 `instanceId / definitionId` 分离、时间适配器不写死单调假设、投影按 `visibility` 过滤——三个 R3 接口预留点保持不变。
