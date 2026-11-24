# 73 · 战斗模块细化：原生暴击 + 战斗 Hook

> **状态：已定稿并落地（2026-11-23）。** 四项裁决见 §0；协议见 §3/§4；模板改动见 §7。
> 上游：ADR-008（命中/闪避）、ADR-012（战斗与召唤）、ADR-018（状态三类）。
> 参考：用户给的 GPT 设计（7 阶段 + 挂载表 + 示例）。保留与这套工程对得上的部分，
> 对不上的地方在 §2 / §4 逐条说明。

---

## 0. 用户裁决（2026-11-23）

| # | 问题 | 裁决 |
|---|---|---|
| D1 | 天逆眸 = 天逆鉾？ | **是**。矛的「命中时解除术式」用 `afterHit → cureStatus` 表达 |
| D2 | 暴击数值 | **6% / 1.5x**；黑闪 = **属性（资质）+ 天赋**，不能主动打出；倍率取 **2.5 次方**（1.5^2.5 ≈ 2.76） |
| D3 | 六眼 / 无下限是否钩子化 | **留在聚合层**。闪避、命中、必中本身就是一等公民，无需 hook |
| D4 | 分期 | 接受 P1（暴击 + 执行器 + 事件）/ P2（迁黑闪 + 天逆鉾）/ P3（UI 消费） |

---

## 1. 现状盘点（读代码得出，不是猜的）

`performBattleAction`（`packages/game-core/src/v2/battle.ts`）→ `executeSkill`。真实顺序：

```
控制检查（cannot_act / cannot_use_skills / cannot_attack）
→ 费用检查 missingCost(effectiveCost(...))
→ 冷却
→ 目标合法性
→ 扣费 → 冷却 → 献祭
→ 每个目标：命中骰 → 闪避门 → 伤害 → 治疗 → 逐个挂状态
→ 自身/阵营状态
→ 消耗状态、回复资源、召唤、召回
→ writeBack → markDeaths
→ 敌方 AI（aiTurn）→ 回合末（roundEnd）→ 胜负（checkBattleEnd）
```

四条工程事实，直接决定方案能怎么长：

| 事实 | 影响 |
|---|---|
| **伤害是确定性的**：`rollFormula` 只做 preset 求和，一次骰都不掷 | 「原生暴击」是从零加的一层，不是改公式 |
| 现有被动是**聚合式**：`multiplierOf / evadeOf / costMultiplierOf` 只覆盖 `damageDealt / damageTaken / hitChance / evade / costMultiplier` | 只覆盖「改数字」。要「改流程」（取消、追击、锁血）才需要钩子 |
| 战斗已有 3 条随机流（`resolve / ai / target`） | 新随机**必须新开流**，否则既有命中/闪避序列整体挪位 |
| 唯一能绕过闪避的是 `hit: guaranteed` / `gear.guaranteedHit` | 「无下限」现在就是靠这个被穿透的；钩子化之后这条判断不能分裂成两处 |

**你表里 8 个挂载点，在工程里是 3 个**：天赋 / 通用补正 / 战斗补正 / 状态，全都是
`statuses` 的同一个结构（只是 `kind` 不同、时长不同），`hooks` 挂在 `CombatFacetSchema`
上一次就全覆盖；另外两处是**世界规则**（`world.combat.hooks`）与**技能**（`skills[].hooks`）。
装备的词条暂时只参与聚合层（`EquipmentCombat`），不收集钩子 —— 咒具的能力写成它授予的技能。

---

## 2. 设计原则

1. **数字走聚合，流程走钩子。** 不把 `damageDealt / costMultiplier / evade` 改写成 hook ——
   那要重写 30+ 条模板与全部数值验收，收益为零。钩子只补聚合表达不了的东西：
   取消、二次判定、锁血、吸血、驱散。
2. **钩子是闭集声明，不是脚本。** 效果词表在 `battle-hooks.ts` 定义，引擎逐条实现；
   模板写不出的效果就是不存在（与 EffectSchema 同一条纪律）。
3. **随机必须分叉。** 新增两条流：`crit`（暴击）与 `hook`（钩子内部掷骰）。
   `resolve` 的消费序列**一个字节都不变** —— 「天逆鉾一刺 32」「甚尔打不到五条」这类
   数值验收继续成立。
4. **一个收集器、一个排序。** 世界规则 → 状态（含天赋/补正）→ 技能，全部展开到一张表，
   按 `priority` 降序、同优先级按「来源层级 + 声明顺序」稳定排序；`id` 相同的只留第一条。
5. **次数与条件分离。** `when` 管条件、`limit` 管次数；次数落 `battle.hookFires`
   （和 `reinforcementFires` 同构），存档重载不重放。
6. **攻防双方都是来源。** 防御方的「替身 / 不屈」必须在挨打那一刻执行，
   所以每条钩子带 `owner`（见 §4.6）。

---

## 3. 原生暴击（独立于 Hook）

### 3.1 协议

`CombatFacetSchema`（status-effect.ts）与 `CombatSkillSchema`、世界根各加一个可选块，
**同一形状**（`CritSpecSchema`）：

```yaml
combat:
  crit: { chance: 0.08, multiplier: 1.5 }   # chance 累加，multiplier 同形累加
```

技能上可以单独声明（例如「必暴」的技能）：`crit: { chance: 1 }`。

> 2026-11-23 补：jjk 的「6% 底」已迁到派生属性 `critRate`（ADR-074）——世界这一层只留倍率。
> 下面这段是协议允许的另一种写法（世界默认值），不是 jjk 的现状。

世界默认值放 `world.yaml`，**不写死在引擎里**：

```yaml
combat:
  crit: { chance: 0.06, multiplier: 1.5 }
```

### 3.2 结算口径

- 位置：**命中与闪避都通过之后、伤害计算之前**。掷 `crit` 流。
- 合成：`chance = clamp(Σ chance, 0, 1)`；`multiplier = max(1, 1 + Σ(multiplier - 1))`
  （两个 1.5x 叠成 2.0x，不是 2.25x —— 与现有乘区「同形累加」一致）。
- 只作用于 `damage`，**不作用于 heal、不作用于状态概率、不作用于领域回合末伤害**。
- 必中也能暴击（必中只解决「打不打得中」）。
- 暴击也必须对 NPC 生效（同一 `executeSkill`，天然对称）。
- 战报：`… 命中X，造成 42 点伤害（暴击）。`
- 结构化事件：`battle.events` push `{ kind: "damage", critical: true, ... }`；
  `battle.log` 保持纯文本不破坏现有渲染。

### 3.3 木桩同步

`apps/server/src/admin/sim.ts` 的期望伤害折暴击：`× (1 + chance × (multiplier − 1))`。
黑闪不在仪器里重算 —— 那是模板钩子，不是引擎规则。

---

## 4. Hook 协议

### 4.1 六个阶段（工程锚点）

| phase | 插入位置 | 能否取消 | 典型 |
|---|---|---|---|
| `beforeAction` | 控制检查之后、费用检查之前 | 能（整次行动丢弃，回合照常消耗） | 眩晕、行动取消 |
| `beforeHit` | 命中骰之前 | 能（落空，连骰都不掷） | 替身、幻术 |
| `afterHit` | 命中通过、伤害之前 | 能（改为 0 伤） | **黑闪**、暴击后的二次判定 |
| `beforeDamage` | 伤害数值算出、`hp -=` 之前 | — | 护盾、减伤 |
| `afterDamage` | `hp -=` 之后、`markDeaths` 之前 | — | 锁血（不屈）、吸血、反伤 |
| `afterAction` | `executeSkill` 末尾 | — | 余韵、追加状态 |

**§4.1 与讨论稿的差异：`beforeCost` 被删掉。** 费用判定是 `canUseSkill`（投影 / AI /
按钮灰不灰）与 `performBattleAction` 共用的**纯函数**，而钩子带状态与随机。
让费用受钩子影响，就会出现「面板说付不起、实际付得起」的两套真相；
要表达「免费施法」，用状态上的 `costMultiplier: { mp: -1 }` 就够了（聚合层）。

### 4.2 声明形状

```yaml
hooks:
  - id: black-flash              # 唯一；同 id 只生效一次（挂两处不双倍）
    phase: afterHit
    priority: 100                # 降序；同优先级按来源层级（世界→状态→技能）
    when:                        # AND；复用 TaskCondition + 四个战斗扩展键
      - { crit: true }
      - { chance: { attribute: blackFlash, perPoint: 0.004 } }
    limit: { per: battle, times: 3 }   # action | round | battle
    effects:
      - { type: critExponent, value: 2.5 }
      - { type: applyStatus, status: black-flash, target: self, rounds: 2 }
      - { type: log, text: "打击与咒力在百万分之一秒里重合——黑闪。" }
```

### 4.3 效果闭集（v1）

| type | 作用 | 备注 |
|---|---|---|
| `scaleDamage` | 本次伤害 ×value | 与 `addDamage` 按 priority 顺序叠 |
| `addDamage` | 本次伤害 ±value | 负数即减伤（护盾走这个） |
| `critExponent` | 暴击倍率取 value 次方 | 黑闪 2.5：1.5 → 2.76；仅暴击时有效 |
| `cancel` | 取消当前阶段 | `beforeAction` ⇒ 不行动；`beforeHit` ⇒ 落空 |
| `applyStatus` | 挂战斗状态 | 复用战斗域判定（只能 `kind: battle`） |
| `cureStatus` | 解状态 | 选择器 `status / kind / polarity / max`；**清不掉天赋** |
| `heal` | 回血（写公式） | 夹 HP 上限 |
| `setHpFloor` | HP 不低于 value | 只抬不压 |
| `log` | 写一行战报 | 仅文本 |

> 不在 v1：改变技能目标、复制技能、改变阵营、永久改属性。
> **`queueAction`（追击）也暂不做**：它需要 `pendingActions` 队列 + 深度上限，
> 而眼下没有任何模板用法；没有用例支撑的机制只会成为下一个「没人知道它怎么跑」的角落。
> 将来要做，按 ADR 增补一条，不要偷偷塞进效果表。

### 4.4 条件（`when`）

复用 `TaskCondition`，另加四个**只在本场战斗有意义**的键：

- `{ crit: true }` —— 本次攻击是否暴击（攻防双方的钩子读同一个值）；
- `{ hit: true }` —— 本次是否命中；
- `{ hpPct: { lte: 0.5 } }` —— 读**钩子拥有者**的血量比例（「我的血低于三成」）；
- `{ chance: 0.25 }` / `{ chance: { base, attribute, perPoint, min, max } }` —— 掷 `hook` 流。

不给 `{ targetIs: ... }` 这类身份条件：需要区分的场合用 `tags` / `kind`，别把角色 id 写进规则。

### 4.5 限制与状态

`battle.hookFires: Record<string, number>`（键 = `hookId`，`per: battle`）；
`battle.hookRoundFires`（`per: round`，回合末清空）；`per: action` 只活在本次动作的上下文里。
三者都进存档（前两个），重载后「每场一次的不屈」不会复活。

### 4.6 拥有者（`owner`）

一次结算会把**施放者**与**当前目标**的钩子并成一张表，每条带 `owner`：

- 条件 `hpPct`、效果默认收件人（`target: self`）都读 `owner`；
- `target: "target"` 指「对面那个人」：施放者视角是受击者，防御者视角是攻击者；
- `id` 相同只留第一条 —— 同一条天赋挂在两个人身上不结算两次。

这样「不屈」写在自己的天赋上、「黑闪」写在攻击者的天赋上，都不需要额外的「谁在防守」参数。

### 4.7 演出分离

`battle.events?: BattleEvent[]`（`damage / heal / cancel / hook`）与 `battle.log` 并行：
`log` 是人读的句子，`events` 是机器读的事实，**不从字符串反解**。
投影额外下发 `BattleView.crits`（本场暴击次数），战斗面板标题显示「暴击 ×N」。

---

## 5. 三个咒术效果怎么落

| 效果 | 现状 | 落地 | 理由 |
|---|---|---|---|
| **六眼** | `costMultiplier: {mp:-0.9}` + `hitChance` + `damageDealt` | **留在聚合层** | 三个都是纯数字；钩子化只是多一层间接 |
| **无下限** | 战斗状态 `evade: 1`，被 `hit: guaranteed` 穿透 | **留在聚合层** | 闪避是独立一道门，改成 `beforeHit cancel` 会让「必中穿透」分裂成两处判断 |
| **天逆鉾** | `hit: guaranteed` + 32 伤害 | **`sk-ten-spear` 的 `afterHit` 钩子**：`cureStatus { kind: battle, polarity: positive }` | 「解除」是流程；只清战斗态，天赋在结构上不可驱散 |
| **黑闪** | 曾是会心窗口技能 `sk-black-flash` | **天赋 `t-black-flash` + 属性 `blackFlash`** | 用户裁决：不能主动打出；只能是「暴击之后的第二道资质骰」 |

---

## 6. 模板改动（jjk-2006/3.0.0）

- `world.yaml`：新增属性 `blackFlash`（黑闪资质，默认 0，上限 100）；
  新增 `combat.crit: { chance: 0.06, multiplier: 1.5 }`。
- `statuses.yaml`：新增天赋 `t-black-flash`（`afterHit` 钩子：`crit` → 资质骰 → `critExponent 2.5`
  + 两回合 `black-flash` 余韵 + 一行战报）。`black-flash` 战斗态保留（余韵 +50%）。
- `skills.yaml`：删除 `sk-black-flash`；`sk-ten-spear` 加 `ten-spear-dispel` 钩子。
- `opening.yaml`：黑闪选项改为「挂 `t-black-flash` + 资质 45」（约 18% 触发），不再给技能。
- `characters.yaml`：五条 `blackFlash: 55` + `t-black-flash`。
- 指纹随模板变化 ⇒ 旧档 `template_content_drift`（预期）。

---

## 7. 分期与验收（全部完成）

| 期 | 内容 | 验收 |
|---|---|---|
| P1 | `crit` 协议 + `crit` 随机流 + 战报 + 事件 + 木桩折暴击 | `battle-crit.test.ts` 4 例（必暴/不暴/必中可暴/累加口役）；既有 756 例全绿 |
| P2 | 钩子执行器（6 阶段 + 三来源 + 攻防 owner + limit + 事件） | `battle-hooks.test.ts` 4 例（不屈/替身/吸血/解除） |
| P3 | 黑闪迁天赋 + 天逆鉾解除 + 面板暴击标签 | `black-flash-window.test.ts` 4 例（倍率/资质骰/余韵/下一击） |

新增随机流不改变 `resolve` 序列：`rng-streams.test.ts` 与全部数值验收照旧通过。

## 8. 不做 / 风险

- **不做**通用脚本、不做「钩子改目标/改阵营」、不做跨战斗持久钩子、不做 `queueAction`。
- 风险 1：钩子顺序若依赖「收集顺序」，模板作者会写出顺序敏感的东西 → `priority` 强制显式。
- 风险 2：`afterDamage` 里改 HP 与 `markDeaths` 的时机耦合 → 只允许 `setHpFloor` / `heal`，
  不允许「复活已死单位」。注意：**玩家 hp 下限 1 仍然等于败北**（默认 defeat 判据是 `hp <= 1`），
  所以「不屈」给玩家写 `setHpFloor: 1` 是没有意义的，要写一个能继续打的值（如 30）。
- 风险 3：暴击让现有 DPR 整体上浮 2–5% → 数值验收写区间 + 记录，不写死单点。
