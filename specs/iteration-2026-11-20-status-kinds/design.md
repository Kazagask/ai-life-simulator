# 状态三类 · 设计稿 v0.3

> 状态：**已落地**（2026-11-20）。裁决见 §10；实现与迁移记录见 §12。
> 相关：`docs/adr/40-属性资源与状态.md`、`docs/adr/30-战斗.md`、`docs/adr/60-表现层与仪器.md`。
>
> 版本：v0.1 世界级 `carryOver` 表 → v0.2 定义上 `toModifier` + 属性上提 + `costMultiplier`
> → v0.3 叠层按 kind 分档、NPC 战斗回写、死协议只注释不上屏。

---

## 0. 一句话

`kind` 不是效果强弱的分档，而是**谁拥有这条状态的生命周期**：

| kind | 中文 | 谁授予 | 谁收回 | 时钟 | 可驱散 | 可叠层 | 谁能创建 |
|---|---|---|---|---|---|---|---|
| `talent` | 天赋 | 世界（挂载 / 事件） | 世界（显式收回） | 无 | 否 | **否** | 只有世界 |
| `battle` | 战斗状态 | 战斗（技能 / 回合末 / 召唤配置） | 战斗（回合耗尽 / 驱散 / 收场） | 战斗回合 | **是** | **是** | 只有战斗 |
| `modifier` | 修正 | 世界 | 世界（治愈 / 到期） | 世界时间 | 否 | **是** | 世界 + 战后折算 |

**状态**是三类总称；`modifier` 的中文读作「状态」，不与总称混用。

三条推论，是这套设计真正要拿到的东西：

1. **「不可驱散」变成结构性事实。** 战斗驱散的候选集里没有天赋和状态——六眼不是"免疫清除"，
   是根本不在名单上。`invincible` 那类字段不用加。
2. **`finishBattle` 的 `battleOnly` 启发式整个删掉。** 今天它靠 `duration` 形态代理
   "这是不是战斗里的临时效果"（`rounds`/`untilBattleEnd` 才置位），`exhausted` 这种
   既像战后遗症又像战斗减益的就卡在缝里。三档之后：世界那一份战斗期间**没被动过**
   （战斗只操作镜像），收场丢掉镜像即可；带出去的只有 `toModifier` 显式声明的折算。
3. **一个 `duration` 只服务一种时钟。** 战斗域只剩 `{ rounds?: n }`，世界域只剩
   `{ value, unit }`。`untilCured` / `untilBattleEnd` / 战斗域的 `{value,unit}` 三个令牌退役。

---

## 1. 定义长什么样

```ts
// StatusEffectSchema
kind: z.enum(["talent", "battle", "modifier"]),   // 必填，不给缺省
polarity: PolaritySchema,                          // 已有，必填
stacking: z.enum(["stack", "unique"]),             // talent 禁用，见 §1.4

attributeModifiers: z.record(attrId, number),      // ★ 从 simulation 面提上来
simulation?: { actionEfficiency?, moodDeltaPerTurn?, eventConditionTag? },
combat?: { ... },
cureConditions?: [...],                            // talent 禁用
```

### 1.1 `attributeModifiers` 必须提出来（本轮一并改）

它今天住在 `simulation` 面里，但 `effectiveAttributes()` 是**模拟与战斗共用**的入口：

```
state.player / npc.attributes
  + Σ status.attributeModifiers × stacks      ← engine.ts:90，读的是 simulation 面
  + 装备词条 + 心情档位
  → effectiveAttributes → buildUnit（战斗）/ 自由行动（模拟）
```

也就是说它**现在就在影响战斗**，只是名字写着 simulation。更糟的是 `battle` 档被禁止
声明 simulation 面 ⇒ 一个"战斗中敏捷 -3"的减益，按新规则根本没有地方放属性状态。
两条路只有一条走得通：**上提到定义层**，成为三类共用字段。

顺带两处校验改动：`world.ts:536` 的属性键校验改读顶层；"至少其一"的 refine 改为
`attributeModifiers / simulation / combat` 三者有其一（`battle` 额外要求 `combat`）。
这样天与咒缚可以只写 `attributeModifiers: { cursedEnergy: -8 }`，不用为了过校验硬塞空面。

### 1.2 面与 kind 的约束

| kind | `attributeModifiers` | `simulation` | `combat` |
|---|---|---|---|
| `talent` | 可 | 可 | 可 |
| `modifier` | 可 | 可 | 可 |
| `battle` | 可 | **禁止** | **必填** |

`battle` 禁止 `simulation` 是硬约束：它不在世界里存在，写世界面就是写了个永远读不到的分支；
战后后果由折算出来的 `modifier` 承担，一个东西只有一个身体。

### 1.3 `mpCostMultiplier` → `costMultiplier`

```ts
combat: { costMultiplier: z.record(resourceKey, number).optional() }
```

技能 `cost` 本来就是 `{ mp, ...任意资源 }`（`catchall`），`effectiveCost` 现在却只给 `mp`
打折（battle.ts:559 硬编码 `key === "mp"`）。改成按 key 各算各的：

```
factor(key) = max(0, 1 + Σ costMultiplier[key])
cost[key]   = ceil(base[key] × factor(key))
```

key 必须是模板 `resources` 已声明的（`hp`/`mp` 也算），否则是静默失效的 typo。

### 1.4 叠层：天赋不能叠，另外两档能

| kind | `stacking` 字段 | 实例 `stacks` |
|---|---|---|
| `talent` | **禁止出现**（写了拒载） | 恒 1 |
| `battle` | 必填 `stack` / `unique` | 按 `stacking` |
| `modifier` | 必填 `stack` / `unique` | 按 `stacking` |

- **天赋不写 `stacking`，不是写 `unique`**：连"要不要叠"这个问题都不该存在于天赋上。
  再授予同一个天赋 id = **幂等**（无时钟、无层数，什么都不变）。
  这也让 `talent` 实例的 `stacks` 恒为 1，仍然是 1 而不是缺省，所有读 `.stacks` 的下游不用改。
- `stacksPerLayer` 同理：`talent` 禁写（乘 1 是死配置），`battle` / `modifier` 可写。
- 再施加时三件事各归各：**层数**按 `stacking`、**时长**取 `max`（`roundsLeft` / `expiresAt`）、
  **`roundsHeld` 不回退**（它数的是"已经待了多久"，不是"还剩多久"）。
  所以第 1 回合中了、第 5 回合又中一次，离场时按满 6 回合折算——期间它一直在身上。

---

## 2. 时长：只剩两种写法

| kind | 施加点写什么 | 实例上落什么 |
|---|---|---|
| `talent` | **不许写 `duration`**（拒载） | 两个时钟字段都没有 |
| `battle` | `duration?: { rounds: n }`；省略 = 整场 | `roundsLeft`（省略则不设） |
| `modifier` | `duration: { value, unit }`（**必填**） | `expiresAt` |

退役：`{ untilCured }`、`{ untilBattleEnd }`、战斗域的 `{ value, unit }`。

`untilCured` 退役的理由：**省略即语义**。今天必须显式写它，是因为"省略"被 `rounds` 占着；
三档之后省略不再有歧义，令牌就是噪音。`SimulationDurationSchema` / `CombatDurationSchema`
各自收缩成单一形态，不再需要 union。

`modifier` 的时长**必填**（不是「省略 = 直到被移除」）：模拟域没有自然边界，静默默认付过学费；
「没有时钟」这一类由 `talent` 表达。迁移时 `{ untilCured: true }` 一律换成显式天数。

---

## 3. 施加 / 收回的合法性矩阵

`applyStatus` / `cureStatus` 不新增动词，**由 ref 的 kind 决定归属域**，域再约束合法性：

| 调用点 | `talent` | `battle` | `modifier` |
|---|---|---|---|
| 世界 `applyStatus`（事件 / `scheduledFacts` / 开局参数） | ✅ | ❌ 拒载 | ✅ |
| 世界 `cureStatus`（显式 id） | ✅（= 收回天赋） | ❌ 拒载 | ✅ |
| 世界 `cureStatus`（聚合词：一切异常/增益） | ❌ 跳过 | ❌ 跳过 | ✅ |
| 战斗 `applyStatus`（技能 / `onRoundEnd` / 召唤配置） | ❌ 拒载 | ✅ | ❌ 拒载 |
| 战斗 `cureStatus`（显式 id） | ❌ 拒载 | ✅ | ❌ 拒载 |
| 战斗 `cureStatus`（聚合词） | ❌ 跳过 | ✅ | ❌ 跳过 |
| 战后折算 `toModifier` | ❌ 拒载 | 源 | 目标 |
| 挂载（`characters.yaml` / 开局 `status`） | ✅ | ❌ 拒载 | ✅ |

- **显式 id 写错域 = 加载期报错；聚合词跨域 = 运行期静默跳过。** 前者是作者笔误，
  后者是"清除一切异常"本来就不该有意见。
- `talent` 允许被世界 `cureStatus` 掉，不另造 `revokeTalent`：动词数量不涨，
  "谁在写这条"已经从 ref 的 kind 读出来了。
- `applyStatus.duration` 由**必填**改为**按 kind 必填**（talent 必须不写，modifier 必须写）。
  schema 层只能是 optional，硬约束交给加载期交叉校验（体检 `status-kind-mismatch`，error 级）。
  这是本设计唯一一处"静默默认"的口子，用一条 error 堵住。

---

## 4. 战斗 → 模拟：定义上的 `toModifier`（单向）

```yaml
- id: st-scorch
  name: 咒火
  kind: battle
  polarity: negative
  combat: { ... }
  toModifier:
    id: st-burn-wound        # 必须 kind: modifier 且已声明
    timePerRound: { value: 1, unit: day }   # 每待一回合折算多少世界时间
```

### 4.1 `roundsHeld` 是什么

它是我要新加在 `StatusInstance` 上的一个**计数**：这条战斗态**已经经历了多少个回合末**。

- 回合末那段既有循环里自增（就是 `roundsLeft--` 的同一处），只有带 `toModifier` 的实例才累加；
- 随 `state.battle` 持久化 ⇒ 中途存档重载、战中改数值，都不会少算；
- 为什么不用 `battle.round - appliedRound`：`battle.round` 的语义在回合末会 +1
  （`atRound: 3` 指的是第 3 回合**开始**），拿它做减法要先对齐这个偏移；而且重载/补丁之后
  还得能重建 `appliedRound`。一个单调计数器没有这些解释成本。

### 4.2 折算

```
held     = roundsHeld（最少 1）
duration = timePerRound × held
把 toModifier.id 按 duration 施加给同一演员（stacks 沿用）
```

- **不可逆**。只从 battle 流向 modifier，`modifier` 上没有回指字段，也没有"下场比赛再变回来"。
  一次战斗态就是一张一次性兑换券，用完即弃（镜像本来就整体丢弃）。
- **不需要 `when` / `chance`**。结算即折算，胜负不影响——败北时玩家也活着（hp 保底 1）。
  随机性留在技能本身，不给收场引入新的掷骰点。
- `roundsLeft` 到期的战斗态**不再折算**（它已经不在身上了，没有东西可以兑换）。

### 4.3 回写范围：玩家 + 参战 NPC（本轮做）

今天 `finishBattle` 只写 `state.player`，NPC 打完一场满血复活、状态全丢。本轮补上：

```
对 player / enemies / allies / neutrals 逐个：
  跳过 summonedBy 不为空的        # 召唤物不是世界演员
  跳过 state.npcs 里找不到同 id 的 # enemy-* 这类纯定义永不实例化，属正常
  跳过 lifecycle.state !== "alive" # 死者不复活
  hp = max(1, hp)；mp / resources 夹 0..上限
  statuses = 镜像里 kind !== battle 的 + 折算出来的 modifier
```

**死活不写**：`setNpcLifecycle` 仍是唯一入口。打到 0 血 ≠ 剧本要他死——留活口、抓活的、
打成重伤都是合法剧情，自动写死会让这些表达不出来；两处写同一件事也必然打架。
所以 NPC 战败后是 `hp = 1` 的活人，死不死的决定权仍在事件里（`victory → setNpcLifecycle dead` 照旧）。

死亡单位不参与折算（`hp <= 0` 跳过），"带着伤离场"只对活着的人成立。

---

## 5. 驱散与治愈的词表

| 词 | 战斗域 | 世界域 |
|---|---|---|
| 清除一切异常 | `kind=battle ∧ polarity=negative` | `kind=modifier ∧ polarity=negative` |
| 清除一切增益 | `kind=battle ∧ polarity=positive` | `kind=modifier ∧ polarity=positive` |
| `neutral` | 两个词都不动它 | 同左 |

- 天赋永远不在候选集。
- 世界域的聚合清除只清 `modifier`：天赋的收回必须显式点名——"意外失去了六眼"是剧情事件，
  不该被一句"净化"顺手带走。
- **战斗域不能删 `modifier`（解咒）**：战斗一旦能删世界状态，`finishBattle` 就不再是
  "丢掉镜像"这么简单了。要表达"解咒"就在战斗里施加一条 `battle` 中和态，真正的移除等世界处理。

---

## 6. 合计：一张账本，一个出口

今天状态数值散在 `statusModifier`、`effectiveAttributes`、装备词条、心情档位里各读各的，
"我身上一共加了多少"没有任何地方能看见。

```
ModifierLedger = {
  attributes: Record<attrId, Σ delta×stacks>,     // 读定义层 attributeModifiers
  combat:     { damageDealt, damageTaken, hitChance, ... },  // 累加
  evade:      1 − Π(1 − x),                       // 概率合成
  costMultiplier: Record<resourceKey, Σ>,
  perRound:   { damage?: Σ, heal?: Σ },           // DoT / HoT
  control:    string[],                           // 去重并集
  sources:    Contribution[]                      // channel / value / stacks / 来源
}
Contribution.source = { type: "status"|"equipment"|"mood", id, name, kind? }
```

三条硬规矩：

1. **账本必须就是结算用的那个数**，不是"再算一遍给 UI 看"。`modifierLedgerOf(...)` 是唯一出口，
   `statusModifier` / `mpCostModifierOf` 收进去；否则面板和结算各说各话。
2. **必须含装备与心情**：只算状态的总值会撒谎（"咒力 +3" 但面板 +5）。`type` 供 UI 折叠，数不能少。
3. **不下发引擎不认的通道**（§7 的死协议），零值通道不发（竖屏空间有限）。

投影新增 `modifiers` 段（`PlayerVM` / `BattlePlayerVM` 共用），排序：属性 → 战斗 → 消耗 → 每回合 → 控制。

---

## 7. 表现层：两栏 + 一块

```
┌ 天赋 ──────────────────────────┐   长期、无时长、不可驱散、不叠层
│ 六眼  天与咒缚                  │   点 → 详情（来源、生效域、贡献了哪些数）
└────────────────────────────────┘
┌ 状态 ──────────────────────────┐   modifier ∪ battle
│ 重伤 ×2  还剩 3 天              │   战斗态排在前面，单位是「回合」
│ 咒火 ×1  还剩 2 回合   [战斗]   │   战斗外的面板里没有 battle 行
└────────────────────────────────┘
┌ 状态 ──────────────────────────┐   只在详情页展开，主面板不堆数字
│ 咒力 +3        伤害 +15%        │   点任一行 → 来源列表（分笔，装备/心情可折叠）
│ 咒力消耗 −90%  每回合 3 点伤害  │
└────────────────────────────────┘
```

- `battle` 与 `modifier` **共用「修正」一栏**，差别只体现在时长单位（`还剩 3 天` / `还剩 2 回合` / 无时长）
  与叠层显示（`×2`）。
- 天赋单独一栏的理由不是数值，是**稳定的身份**：它几乎不变化，混在会抖的状态里会让玩家以为六眼快到期。
- 技能描述里的状态引用带 kind 徽标（`天赋` / `战`）；`durationLabel` 仍只属于施加点。
  六眼的 `战斗中咒力消耗 −90%` 只在**详情**里出现，技能按钮继续只显示实付（既有口径不变）。
- 定义视图与实例视图继续分离，`kind` 两边都带。

### 7.1 两个死协议：只注释，不上屏

- `simulation.actionEfficiency`：只有 `presentation/effects.ts:216` 在读 ——
  会向玩家承诺"行动效率 -20%"，而引擎从不结算。
- `simulation.eventConditionTag`：模板里有写入（`curse-poisoned`），全仓无读取点。

处理：**协议字段保留 + 代码注释标"未实现，不得在表现层呈现"，同时删掉 effects.ts 那段渲染。**
以后要用，得先实现结算再上屏——顺序反了就是第二次"面板说着引擎不认的话"。

---

## 8. 协议增删清单（只列，不改）

**增**
- `StatusEffectSchema.kind`
- `StatusEffectSchema.attributeModifiers`（从 `simulation` 上提）
- `StatusEffectSchema.toModifier: { id, timePerRound }`（仅 `battle`）
- `StatusInstance.roundsHeld`
- `CombatFacet.costMultiplier`（替掉 `mpCostMultiplier`）
- VM：`modifiers: ModifierLedgerView`

**删**
- `StatusInstance.battleOnly`
- `simulation.attributeModifiers`（搬走，不保留别名）
- `{ untilCured }`、`{ untilBattleEnd }`、战斗域 `{ value, unit }`
- `SimulationDurationSchema` / `CombatDurationSchema` 的 union 结构
- `combat.mpCostMultiplier`
- `effects.ts` 里 `actionEfficiency` 的渲染（协议保留）

**不变**
- `stacking` 的两档语义、`stacksPerLayer`、`polarity`、`visibility`、`quality`、`tags`、
  `cureConditions`、`finishBattle` 的资源回写与 history。

---

## 9. 影响面与迁移

| 面 | 量 | 动作 |
|---|---|---|
| 模板状态 | 52 条 | 加 `kind`；`attributeModifiers` 上提；`battle` 删 `simulation` 面、`talent` 删 `stacking` |
| 战斗域施加点 | 68 处 `rounds` | 不变 |
| 战斗域施加点 | 16 处 `{value,unit}` | 改 `{rounds}` + 在对应定义上补 `toModifier` |
| 世界域施加点 | 全部 | `talent` 的删 `duration` |
| `finishBattle` | 1 处 | 删 `battleOnly` 分支；加 NPC 回写 + 折算循环 |
| `effectiveCost` | 1 处 | 按 key 各自打折 |
| 体检 | +2 | `status-kind-mismatch`、`to-modifier-invalid`（均 error） |
| 指纹 | 全模板 | 改模板即换指纹，旧档拒载（既定策略） |
| `schemaVersion` | 5 → 6 | `StatusInstanceSchema` 是 `.strict()`，删/加字段必须 bump |

---

## 10. 剩下三条

1. **`modifier` 能叠层**（我按"能"写的：毒/重伤要分层）。若你要"世界状态一律单层"，
   改一行表就行——但那样 `stacking` 只剩 `battle` 用得上，字段可以直接搬到 `battle` 块里。
2. **`roundsHeld` 口径**：按"经历过的回合末次数"算，应用当回合就算 1（最短 1）。
   若要"完整存活回合"（当回合不算），差一个 `-1`。
3. **NPC 打死不自动写死**（仍由 `setNpcLifecycle` 决定，战败方留 `hp = 1`）。若你要
   "打到 0 血即死"，得先说清它和模板里 `victory → dead` 的先后与幂等关系。

都点头我就排 T 任务：schema + 加载期校验 → 折算/回写 → 投影账本 → 模板 52 条 → 体检与回归。
