# R2.5 设计文档：配置/实例/事实三层分离 · 事件触发收敛 · NPC 生命周期与关系

状态：**正式（2026-11-12 G1 通过，第二批裁决已回填；R2.5 施工中，`T1-01` 起）**  
范围：**本文件只出规格，不改实现代码**。实施拆分为 R2.5（事件实例化与延时队列，本批施工）与 R2.6（NPC 生命周期与关系，下一期），见 §8、§0.3。  
上游依据：用户原始诉求（2026-11-11）、`AGENTS.md` §1/§2/§3/§5、`docs/ARCHITECTURE.md`、ADR-0001~0009、`packages/shared/src/schema/`、`packages/game-core/src/v2/`。  
基线：R2.4b（7912493），typecheck 0 错误，245 tests 绿。

---

## §0 结论摘要

1. **判定：本次变更属于「核心数据模型」类**（`WorldStateV2` 新增调度/事实结构、`V2Npc` 增生命周期与出生时间、`EventTriggerSchema` 字段语义修订），按 AGENTS.md §0 必须先出 ADR。本设计配套 **ADR-0010（三层分离）、ADR-0011（事件触发收敛 + 时间窗口队列）、ADR-0012（NPC 生命周期与投影解耦）**，均已落 `docs/DECISIONS.md`。
2. **三层模型是本轮的裁判标准**：配置层（模板 YAML，只读）→ 实例层（本局对象，有 id/status/可序列化）→ 事实层（只追加记录，只可查询）。现存十一处混杂（§1 M1-M11）中，最危险的是「模板事件被当调度器扫描」与「flags 被当系统表用」——前者让调度无实例可回溯（堵死 R3 穿越回拨），后者让模板条件能读引擎内部记录。
3. **事件触发收敛为立即/延时两类**：是否延时**由是否声明时间窗决定，不由 source 类型决定**——`action-hook` 与 `chain` 未声明 `window/delay` 时立即结算不入队，声明了则同样入延时队列；`schedule` 世界初始化即入队；`pool` 降格为抽取器（门控通过才入队）。`atTurn`（x 轮后）与 `cooldownTurns`（轮次冷却）退役为时间表达。`resolveScheduleV2` 的每轮全模板扫描被 `drainScheduledEvents()` 的「有序队列 + 出队判定」取代。**【2026-11-12 评审修订，详见 §0.2】**  
   |  |  |  |  
   | --- | --- | --- |
4. **NPC 引入引擎无关的生命周期**：`alive | inactive(reasonCode) | unspawned`，引擎只判 `alive`，`reasonCode` 是模板自由语义（dead/missing/sealed…），**引擎不得对 reasonCode 分支**。投影与生命周期解耦：判活决定「行动/参战/关系变更」四处的默认过滤，`projectNpc()` 决定「是否上屏」，死亡角色可依模板配置继续上屏。
5. **确定性告警**：新 drain 判定链的 RNG 消耗顺序与旧 `resolveScheduleV2`/`resolvePoolV2` 不同，**同 seed 下事件结果序列会改变**（§3.4.5 显式声明）；这不破坏「同 seed 同输入同结果」的可复现性（新代码仍是确定性的），但旧回放断言与旧存档不可复用，随 schemaVersion 升级一并处理（§5）。
6. **命名裁决（2026-11-12 用户已决，Q-R25-01 关闭）**：**保留 `action-hook`，不改名**。理由：用户指出 `action-hook` 既可能是立即触发也可能是延时触发，用 `action_trigger` 命名会把类型与「立即」绑定，属错误抽象。立即/延时的判据是**是否声明时间窗**（§3.1），与 `source` 取值正交；协议 §8 与模板均不改此枚举值。

### §0.1 不变量检查表

| 不变量               | 现状                                       | 本改动影响                                                            | 保护措施                                                                                    |
| ----------------- | ---------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 同 seed 同输入同结果     | 成立（注入 RNG，`deriveTurnSeed`）              | drain/pool 的 RNG 调用序列改变 → 同 seed 事件序列与旧版不同                       | 新旧行为不一致**只在 schemaVersion 升级边界发生一次**；R2.5 测试重录基线；RNG 消耗顺序在 §3.4.5 固化为规范                 |
| hidden 不进入玩家端 API | 成立（`projectSnapshotV2` + R-VS-01）        | 新增 `missedEvents`/关系记录均为事实层，默认不投影                                | 投影白名单制：事实层字段进入 `V2Snapshot` 须逐字段评审；错失事件只发 `eventId`+标题（无 hidden 语义，OPEN_QUESTIONS #33）  |
| 世界观规则只进模板         | 成立（声明式 DSL）                              | 亲属/师承**推导逻辑**进引擎（图查询），**关系语义**（谁是父子）进模板/实例                       | 推导是纯结构算法（上溯/拼接），不含世界观语义；reasonCode 命名与含义完全由模板定                                          |
| 时间/随机/ID 可注入      | 成立（RunnerContext）                        | `enqueueSeq` 计数器进状态（不用 Date/随机）；`window.start` 一律 `worldTime` 换算 | `enqueueSeqCounter` 为纯状态递增；TimeSpec→分钟换算经 CalendarAdapter（可注入历法）                        |
| R3 穿越 seam 未被封死   | seam 已预留（实例-定义分离/TimeAdapter/visibility） | **强化**：调度从「模板扫描」变为「实例队列」，时间回拨只需对实例重算到期                           | 队列实例保留 `origin` 与固化窗口（不复制配置字段）；排序键只用 `worldTime` 不用 `Date`；不写死时间单调假设（drain 以 `>=`/`<=` 比较而非增量） |
| 不新增 Lifecycle 状态机 | ADR-0004 已禁                              | NPC `lifecycle.state` 是**角色级三态**，非阶段编排；不新建 `lifecycle.ts` 模块     | NPC 生命周期字段并入 `shared/src/schema/character.ts` 同域；boundary.test.ts 的静态禁令继续生效             |

### §0.2 评审修订总表（2026-11-12，用户裁决；G1 评审通过）

> 用户 2026-11-12 评审：「其余的暂时没发现问题，你可以默认我通过了，后续有问题再改就行」。以下为**明确点名**的修订项，逐条落点；未点名部分按原设计通过。本表是修订后的权威口径，与后文旧段落冲突时**以本表为准**（旧段落已就地同步关键条目）。

| # | 用户裁决/提问 | 修订后口径 | 落点 |
|---|---|---|---|
| 1 | 事件结算推进轮次 + `timeCost` | **结算即推进 `turnIndex`（占槽）**；新增事件级 `timeCost`（默认 0，TimeSpec 形状）；战斗结束算结算轮；用物品**暂不**算；事件轮跑完整轮次管线；同窗多事件**逐轮各占一槽** | §3.2、R-EV-14、T1-07；#34 裁决 |
| 2 | 配置层只是 yaml？世界初始化能否生成模板 | 配置层**不等于**「只能有 yaml 文件」，但**运行时不生成配置层模板**：刷新规则写在 yaml（配置），世界初始化把规则**实例化**成 `SpawnRuleInstance`（实例层，进存档），事件效果 `spawnNpc` 依规则建 NPC 实例（`unspawned → alive`）+ 事实层只追加。若确需运行时生成新定义，必须确定性（seed 派生、无 Date/随机）、不参与模板指纹、且先写 ADR | §2、R-LM-04、OQ-#46 |
| 3 | `action-hook` 别改名 | 保留旧名；且**既可立即也可延时**，由是否声明 `window/delay` 决定，与 source 类型正交。Q-R25-01 关闭 | §3.1、R-EV-02 |
| 4 | 六字段消费链路核查 | 核查结论：`probability/weight/once/priority/conditions/onActionId` **全部是配置域**（`schema/event.ts:13-43` 定义、`turn.ts:329-383` 只读、从不写入 `WorldStateV2`/`flags`/队列条目/存档；`pendingEvents` 只存 `{eventId, chainId?}`）。但求值依赖运行时状态（`firedEvents`/`turnIndex`、`flags`/npcs/`worldTime`、注入 RNG、运行时 `actionId`）。**实例不得复制这 6 个字段**（删 `snapshot.conditions/probability`）；死配置（`priority`/`conditions` 挂在 chain/schedule 上无人读）由加载期告警或统一门控消除 | §2 硬约束、§3.4、R-EV-15 |
| 5 | 入池按策略门控，miss 原因收缩 | **门控前置**：`once`/`probability`/`weight`/`priority`/`conditions`（pool 抽取时）在候选产生时求值，决定**是否入队**；门控失败**不产生实例、不记错失**。出队只判 `missWhen` → `conditions` 终判（hold）→ `cooldown`（hold）→ fire。`MissReason` 收缩为 `window_expired \| miss_when` 两种 | §3.4/3.4.1/3.7、R-EV-12 修订 |
| 6 | `TimeExpr` 有必要吗 | **收敛为单一 `TimeSpec`**：默认相对**入队时刻**（#37 裁决），兼容时间格式（既有 `TimeAmount {value,unit}` + 字符串时长/历法日期）；删除 `absolute/relative` 二分支；`atWorldTime` 由「初始化入队（now=0）+ 相对量」等价表达；绝对日期在入队时换算成 `at - now` 后固化进 `window` | §3.1、§3.5、OQ-#37 关闭 |
| 7 | 入池没有时间窗口 | pool 事件无 `delay/window` ⇒ **默认相对 0 分钟**：抽中即入队、下一次 drain 到期触发（仍走队列，不算立即触发）；不强制模板填写。OQ-#38 按此关闭 | §3.7 |
| 8 | 战斗事件限制入池 | **加载期拒绝 `source: pool` + `kind: combat`**（superRefine）+ 抽取期防御；要战斗就写 `normal`/`random` 事件，经 `chain` 立即步 / `nextEventId` 触发 `combat`（现代码已支持：`turn.ts:310-325`、`events.yaml:196-202`） | §3.7、R-EV-13 |
| 9 | 分钟标量 + 洪荒几亿年 | 分钟整数在 2^53 内 ≈ 171 亿年，几亿年**不丢整数精度**；真实风险是 ① `MAX_SAFE_INTEGER` 当 +∞ 哨兵与极大时间共域、② 固定 30 天/365 天近似历与年号完全失真、③ 自定义纪元跨度可能逼近 2^53。修订：哨兵改 `undefined` + 显式 `hasEnd`；`worldTime` 加 int + 上界校验；纪元/年号走 `CalendarAdapter` 模板声明（「洪荒 N 年」由 format 渲染，标量仍是分钟）；#39 三模型给出枚举 | §3.5、§4.4、OQ-#39、R-LM-05 |
| 10 | 时间系统为什么只做公历 | **不是「没实现好」，是范围裁定**：R2.5 只需短延时，固定分钟近似零迁移；真实公历/自定义历/年号需扩 `CalendarAdapter`（`toMinutes(amount, from)`/`ageAt`/`format` 注入历法），接口 seam 已留但实现未做（原 Q-R25-05 待决）。本轮把接口定死，实现仍按用户裁决推进 | §3.5、§4.4 |
| 11 | 谱系断代、多跳称谓、真的没有成熟库吗 | **有**：`relationship.js`（npm，MIT，v1.2.9，约 3.7k stars，仍在维护，`dependencies: {}`，纯 JS 数据表算法、Node 离线、确定性），支持 `type:'chain'`、`optimal` 最短关系、`setMode` 方言、多跳中文称谓（外婆的哥哥 → 舅外公）。但它**不存图、不处理师承、不处理断代**。改为**分层复用**：图遍历/环检测/师承/断代自研 `v2/relations.ts`；已知跳数亲属路径转成关系链记号交给 `relationship.js` 出中文称谓；断代用显式 `gap` 边 + 粗称谓（不猜代数、不补节点）；师承称谓用模板 `titleRules`。OQ-#40 按此关闭 | §4.3、R-NP-08、T2-05 |

> **影响提醒**：#1、#5、#8、#11 都会改变 RNG 消耗顺序或新增依赖，实施时按 §3.4.5「同 seed 序列变更」声明重录基线；引入第三方库到 `game-core` 前按 AGENTS.md §0 走 ADR。
>
> **第二批裁决提示**：本表 #9（`worldTime` 显式上界 / 年号渲染）与 #10（历法实现排期）已被 2026-11-12 第二批裁决部分修订，见 **§0.3**；冲突处以 §0.3 为准。

### §0.3 第二批裁决回填（2026-11-12，施工许可）

> 用户 2026-11-12 第二批裁决原文：「35 加载期静态拒绝 但是注意别误伤了延时事件 / 36 留在队列 / 39 43 继续延期 下一期马上解决 / 41 合并 / 44 符合事件+字面量，和39 43 下期排期解决 / 45 先保持现状 时间问题 下一期决策 / 46 不做 / 没问题就施工」。**G1 已过**（用户上一轮「其余默认通过」）、G2 已过，本轮**进入实施**：从 `T1-01` 起按 G3 单任务推进，范围 **R2.5 事件模型（T1-01..T1-09）**，R2.6/NPC（`T2-*`）为下一期。ADR-0010/0011/0012 状态改「**已通过（2026-11-12 G1 评审）**」。本节为第二批裁决的权威口径，**与 §0.2 或后文旧段落冲突时以本节为准**（后文已就地同步关键条目）。

| # | 裁决 | 口径 | 落点 |
|---|---|---|---|
| 1 | **#35 关闭** | 候选①「加载期静态拒绝」（`superRefine`）+ 延时豁免：只统计「未声明 `window`/`delay` 的立即 `action-hook`」并按 `onActionId` 分组，同组 ≥2 条才报错；声明 `window/delay` 的 `action-hook`（延时）、chain 延时步、schedule、pool 全不受约束（延时事件不占同一轮槽位）；错误信息提示「可为后续 hook 声明 window/delay 转为延时」 | §3.2、R-EV-03、T1-01/T1-07、ADR-0011 决策 5；Q-R25-01 已关闭 |
| 2 | **#36 关闭** | 候选②「留在队列」：窗口内 `conditions`/`cooldown` 不满足一律 hold 留队、每轮 drain 重估、不记错失；仅 `worldTime > window.end` 才出队并追加 `reason="window_expired"` 错失事实；无 `window.end` 永不因时间过期，由显式 `missWhen` 兜底（R-EV-12/#42）；门控失败不构成错失 | §3.4 判定表、R-EV-07、T1-03、ADR-0011 决策 3 |
| 3 | **#39 / #43 延期（不写成已关闭）** | 「继续延期，下一期马上解决」：本轮 R2.5 不实现 ②真实公历/③自定义历+年号，`CalendarAdapter` 接口形状保持预留；下一期（R2.6）首批解决；保留原有候选与推荐描述 | §3.5、§4.4、§7（Q-R25-05 标注「下期首办」）、ADR-0012 决策 4/后果 |
| 4 | **#41 关闭** | 候选①「合并」：`visibility: public\|hidden` 并入「NPC 投影原则」单一判定入口 `projectNpc()`，不再与动态已知标记各设一套判定；历史可见性 `R-VS-03`/`isPlayerVisible()` 口径不变；ADR-0012 决策 3 与 Q-R25-07 的 A 案按此改写（合并 ≠ 简单 AND 两套并存） | §4.3、§7（Q-R25-07）、R-NP-01、T2-03、ADR-0012 决策 3 |
| 5 | **#44 方向定 A、实现延期（不写成已关闭）** | 「符合事件+字面量」按「**复合时长 + 字面量**」理解（候选 A：`3d`/`2h30m` 复合时长 + 历法日期字符串字面量）——注明这是对原文的解读；实现与 #39/#43 一并排下一期；本轮 `TimeSpec` 只实现 `TimeAmount {value, unit}`，字符串语法只留 `CalendarAdapter.parseTimeSpec` seam、**不做加载期解析** | §3.1、§3.5、ADR-0011 决策 2、T1-01、test-design 第 13 项 |
| 6 | **#45 保持现状、下期决策（不写成已关闭）** | 本轮**不加** `MAX_WORLD_TIME = 2^52` 上界拒载、不加 `{epochIndex, minuteInEpoch}` 双字段/BigInt；`worldTime` 维持现状（number 分钟）；`R-LM-05` 验收收缩为「整数分钟 + `hasEnd` 无数值哨兵」；上界校验与年号/纪元渲染随 #39/#43 下一期一并验收 | §3.5、§6、R-LM-05、T1-02 DoD（删「上界」）、ADR-0010 决策 5、test-design 第 14 项 |
| 7 | **#46 关闭** | 用户明确「不做」：运行时按 seed 生成**配置层模板定义**的能力不实现；R-LM-04 常规路径（规则写 yaml → 世界初始化实例化 `SpawnRuleInstance` → 效果 `spawnNpc(ruleId)` 建 NPC 实例）保留，归 R2.6 | §2、ADR-0010 决策 4、R-LM-04 |
| 8 | **施工状态** | G1/G2 已过，本轮进入实施，从 `T1-01` 起按 G3 单任务推进；范围 R2.5 事件模型（T1-01..T1-09），R2.6/NPC（`T2-*`）为下一期；ADR-0010/0011/0012 状态「已通过（2026-11-12 G1 评审）」 | 三篇 ADR 状态行、`PROJECT.md` §2、`tasks.md` 顶部、`README.md` 门禁状态 |

> **本轮施工边界**：只实现 `TimeAmount`、无世界时间数值上界校验、无字符串 `TimeSpec` 加载期解析、无 ②③ 历法实现；上述四项均随 #39/#43/#44/#45 顺延下一期（R2.6）首批。

---

## §1 现状盘点：配置/实例/事实三层混杂清单

「配置 = 模板（只读）；实例 = 本局对象（有 id、有状态、可序列化）；事实 = 只追加记录」。逐条列出混杂点（位置 → 混了什么 → 后果）。**以当前代码为准**（R2.4b，7912493），已逐文件核对。

| #   | 位置                                                                                                                                                                           | 混了什么                                                                                                                                                                                                                                                                                                                                                                                                                | 后果                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `packages/game-core/src/v2/turn.ts:374-383`（`resolveScheduleV2`）                                                                                                             | **配置被当调度器**：每轮遍历 `template.events`，命中 `atTurn === turnIndex` 或 `worldTime >= atWorldTime` 就触发。没有实例层——「某个 schedule 事件已入队/已过期/已错失」在状态里不可见                                                                                                                                                                                                                                                                             | ① 无窗口结束语义（过期、错失无法表达）；② 无相对时间（「3 天后」只能靠效果 `advanceBy` 间接造）；③ O(n) 全模板扫描且与队列语义无关；④ R3 时间回拨时「已触发」只能靠 `firedEvents` 猜，实例级回溯不存在                                                                                                             |
| M2  | `packages/shared/src/v2.ts:184-185`（`firedEvents: Record<eventId, turnIndex>`）+ `turn.ts:407-411`（`onCooldown`）                                                              | **事实记录粒度不足且绑定轮次**：事实只存「最近触发轮次」，冷却判定 `turnIndex - fired < cooldownTurns` 把轮次当时间单位                                                                                                                                                                                                                                                                                                                                    | 时间窗冷却无法表达（一轮 = 多长？取决于步长）；`once`/冷却事实与调度耦合在同一无结构字典里                                                                                                                                                                                     |
| M3  | `flags` 多用途（`turn.ts:529`、`npc.ts:54/92`、`opening.ts:150-160/253`、`engine.ts:295-303`）                                                                                       | **引擎内部记录/实例状态伪装成模板语义 flag**：`npcAction:<npcId>:<actionId>`（NPC 行动冷却=系统事实）、`infoVisibility:<npcId>`（NPC 投影状态=实例层）、`relationSource:<npcId>`（关系来源=事实）、`openingScheduled:<eventId>`（调度标记=实例层缺失的补丁）、`turnsPlayed`（= `turnIndex` 的冗余副本）。**最强证据**：`infoVisibility:*` 与 `relationSource:*` 全仓库生产代码**零读取点**——只在 `opening.ts:150-160` 写入（唯一检索命中处），game-core/shared/web 无任何消费，仅 opening.test.ts 断言写入值。这是「事实塞进配置命名空间且无人消费」的直接实证 | ① 模板条件 DSL（`FlagConditionSchema`）**可以读到引擎内部记录**——层级墙被穿透；② 键名字符串拼接无 schema 保护；③ `openingScheduled` 只写标记不建实例，开局排程事件实际仍靠 M1 的模板扫描触发（`opening.ts:249-254` 注释自证）；④ 写而不读的记录证明该数据从未参与任何决策——属于占位垃圾状态，迁移时应直接重构消费点（R2.6 的 projectNpc/关系模型）而非保留语义 |
| M4  | `packages/shared/src/v2.ts:140-146`（`ChainStateV2.stepIndex`）+ 两处写入口（`engine.ts:370-375` `advanceChain` 效果直接 `+1`；`turn.ts:302-305` `advanceChainOnSettle` 按 `findIndex` 派生） | **派生状态存成事实，且双写入口**：`stepIndex` 本可由「链定义 + 已结算步骤」推导，却被独立存储；`advanceChain` 效果盲目 `+1`，与结算推进可能漂移                                                                                                                                                                                                                                                                                                                         | 同一状态两处写、语义不一致的风险（效果推一步 + 事件结算再推一步 = 跳步）；链「当前进行到哪」无法与延时队列对账                                                                                                                                                                             |
| M5  | `packages/shared/src/schema/event-instance.ts` + `opening.ts:227-259`                                                                                                        | **实例协议存在但未接线**：`EventInstanceSchema`（instanceId/definitionId/origin/scheduledTime/status/visibility）只有 opening 抽取在用；`handoff()` 对 schedule 事件只写 `flags["openingScheduled:<eventId>"] = true`，不产生任何运行时队列条目                                                                                                                                                                                                           | M1 的扫描器根本不消费实例——实例层有名无实；`scheduledTime` 与 `atWorldTime` 两套时间表达并存                                                                                                                                                                       |
| M6  | `packages/shared/src/v2.ts:130-136`（`pendingEvents`/`PendingEvent {eventId, chainId}`）                                                                                       | **待决队列被当调度队列用**：无实例 id、无时间、无 status；`advanceTurnV2:505` 的 `pending_event_required` 守卫依赖它表达「槽位占用」                                                                                                                                                                                                                                                                                                                    | 「待玩家决策」与「等待触发」两种性质不同的东西挤在一个 FIFO 里；链的延时步骤（「3 天后触发」）无落点                                                                                                                                                                                 |
| M7  | `packages/shared/src/schema/character.ts:16`（`identity.age: int`）+ `turn.ts:565` + `npc.ts` 无年龄处理                                                                            | **NPC 年龄是静态快照**：`createWorldV2` 从模板复制一次后永不更新；玩家年龄走 `playerAgeAtStart + elapsedYears`（另一套派生逻辑）                                                                                                                                                                                                                                                                                                                       | NPC 不衰老；「开局已死亡的重要角色」无出生时间可推年龄；两种年龄语义并存                                                                                                                                                                                                 |
| M8  | `character.ts:56`（`relationship: -100..100`）+ `opening.ts:155-161`（`relationSource` 塞 flags）                                                                                 | **单值混合三种语义**：好感度、亲属、师承挤在一个数上；关系的「来源说明」是字符串 flag                                                                                                                                                                                                                                                                                                                                                                     | 无法表达「五条是我的师父且好感 -10」；亲属/师承只能手写双向对称数据，无法推导，错误无校验                                                                                                                                                                                        |
| M9  | `character.ts:29/31`（`isEnemy` + `visibility: public\|hidden`）+ `npc.ts:36`（`if (npc.isEnemy) continue`）                                                                     | **语义重叠的两个开关**：`isEnemy` 同时承担「战斗敌人」与「不参与 NPC 自主行动」两职；`visibility` 又是第二层显示开关；且 NPC **没有「不参与任何事」的状态**（死亡的 NPC 照样被效用评分选去行动）                                                                                                                                                                                                                                                                                             | 死亡/失联 NPC 继续行动与说话；敌人模板角色无法以非战斗身份行动；前端隐藏逻辑与引擎跳过逻辑互相纠缠                                                                                                                                                                                   |
| M10 | `turn.ts:165-200`（`EVENT_SOURCE_PRIORITY` + `enqueuePendingEvent`）                                                                                                           | **优先级是排序事实却散落在插入算法里**：pool 事件抽中立即 `triggerEventV2`（`turn.ts:344/351`），与用户「pool 只能触发延时事件」的诉求冲突                                                                                                                                                                                                                                                                                                                       | 池事件无延迟语义；同轮多事件呈现顺序逻辑内嵌在插入函数中，不可配置不可测试                                                                                                                                                                                                  |
| M11 | `packages/shared/src/schema/common.ts:155-176`（`EffectSchema`）                                                                                                               | **效果 DSL 缺口**：白名单中没有任何 NPC 生命周期效果、没有 spawn 效果、也没有「入队延时事件」效果。而 R-NP-03 要求「模板把失联事件映射为 dead」、R-EV-08 要求「pool 抽中后延时入队」——需求已有，写入通道不存在                                                                                                                                                                                                                                                                                    | 生命周期（4.1）与 pool/链延时（3.7/3.9）落地时必须扩白名单：`setNpcLifecycle` / `enqueueEvent`（见 §6），否则模板只能靠硬编码或绕过效果层写状态，违反 AGENTS.md §2「副作用放 adapter/白名单」                                                                                                   |

---

## §2 三层模型定义

**裁判标准**：任何新字段/新记录，先问它属于哪一层、谁能写、何时被读。三层一旦划定，M1-M10 的每一处改造落点自动确定。

| 层       | 职责                                            | 载体（具体类型/文件）                                                                                                                                                                                                                                                                                                 | 可变性                                           | 谁能写                                 | 校验点                                                            | 是否进存档           |
| ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- | --------------- |
| **配置层** | 世界观规则与内容的唯一来源（事件定义、链定义、NPC 初始定义、行动、历法声明、投影配置） | `specs/data/templates/<world>/ *.yaml` → Zod strict（`packages/shared/src/schema/`：`event.ts`/`character.ts`/`world.ts`…）→ `WorldTemplateV2`                                                                                                                                                                 | **只读**。加载后不可变（模板指纹 sha256 绑定存档，ADR-0007）      | 模板作者（加载期 Zod 校验 + 引用完整性校验）          | 加载期：Zod strict（未知字段即错）+ superRefine 交叉校验 + 指纹                  | 否（以指纹形式间接进存档信封） |
| **实例层** | 本局「活的」对象：有 id、有 status、可序列化、可取消               | 事件实例 `ScheduledEventInstance`（新，§3.3）、待决事件 `pendingEvents`、链实例 `ChainStateV2`、NPC `V2Npc`（+lifecycle/birthTime/parents）、战斗 `BattleState`、装备 `EquipmentInstance`、补正 `StatusInstance`                                                                                                                         | 可变，但**写入口收口**（如链推进唯一入口、调度唯一入口 `scheduler.ts`） | 引擎效果 DSL（`applyEffectsV2`）、调度器、玩家命令 | 写入时：引擎白名单效果 + 运行时断言（如环检测）；存档加载时 `WorldStateV2Schema.safeParse` | **是**           |
| **事实层** | 只追加（append-only）的历史记录：可查询、不可改写、**不得作为触发源**    | `history: HistoryEntryV2[]`（既有）、`eventFires: Array<{eventId, turnIndex, worldTime}>`（新，append-only 日志）+ `lastFiredIndex: Record<eventId, {turnIndex, worldTime}>`（**派生索引/缓存，可从日志重建，不是事实**，承接 once/冷却/结局 eventOccurred 的按 id 查询）、`missedEvents: MissedEventRecord[]`（新，错失的延时事件）、关系变更记录 `relationLog`（新，R2.6） | 事实只追加。条目一经写入不改不删；派生索引可随时重建                    | 引擎在结算边界写入（触发、过期、错失、关系变更）            | 无需复杂校验（只追加天然一致）；加载时照常 safeParse，索引与日志不一致以日志为准重建                | **是**           |

**配置/实例/事实的读写规则（编码时的硬约束）**：

1. 配置层只在两个时刻被读：**入队/实例化时**（把定义变成实例，固化判定参数）与**条件求值时**（读定义的结构，如 `lookup.event(id)`）。调度循环（drain）**不得遍历 `template.events`**——只遍历 `state.scheduledEvents`。
2. 实例层是唯一可被调度驱动的东西。实例过期/取消只改自己的 `status`，不删（保留审计痕迹，供事实层查询）。
3. 事实层的合法消费方式**只有三种**：条件求值的只读输入（`once`/冷却/`FlagCondition`）、投影展示、结局证据（`evidenceIds`）。**事实不得反向驱动调度**：任何「因为有 X 记录所以触发/入队事件」的逻辑非法——触发只能来自：玩家行动、效果 DSL（`startChain`/`enqueueEvent`）、延时队列到期。
4. 调度判定器必须是**纯函数**：`evaluateDue(instance, worldTime, facts) → decision`，输入全显式，无隐藏读取。这是确定性可测的关键。

**flags 的归属与拆分（M3 的处理）**：

| 现有 flags 键                                                                                                       | 判定                  | 去向                                                            | 兼容策略                                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| 模板语义 flag（`spAware`、`nightLine`、`canonDeviation`、`doomed`…，由 `setFlag/adjustFlag/clearFlag` 写、`FlagCondition` 读） | **合法的模板语义层**        | 保留在 `state.flags`，定位明确化：`flags = 模板可读写的语义黑板`                  | 不动                                         |
| `npcAction:<npcId>:<actionId>`                                                                                   | 系统事实（NPC 行动冷却）      | R2.6：迁入 NPC 实例 `actionLastFired: Record<actionId, worldTime>` | 旧键停止写入，加载时清理；冷却改时间维度见 Q-R25-04             |
| `infoVisibility:<npcId>`                                                                                         | 实例层（NPC 投影状态）       | R2.6：迁入 NPC 实例字段 `infoVisibility: known\|inferred\|unknown`   | opening 写入点同步迁移                            |
| `relationSource:<npcId>`                                                                                         | 事实层（关系来源）           | R2.6：迁入关系边 `source` 字段 + `relationLog`                        | 随关系模型迁移                                    |
| `openingScheduled:<eventId>`                                                                                     | 实例层缺失的补丁            | R2.5：被延时队列实例取代，**删除**                                         | handoff 改为真正入队；旧键不再写入                      |
| `turnsPlayed`                                                                                                    | 冗余事实（≡ `turnIndex`） | **删除**                                                        | 消费点（`life-evaluation.ts:77`）改读 `turnIndex` |

**配置层是否只能有 yaml？世界初始化能否「生成模板」（2026-11-12 用户评审）**：

- **现状核查**：模板只从 8 个 yaml 加载（`apps/server/src/templates.ts:19-34` `TEMPLATE_FILES` → `parse` + `WorldTemplateV2Schema.parse`），sha256 指纹绑定存档（`templates.ts:96-112`、`store.ts:60-67/108-117`）；`createWorldV2`（`turn.ts:53-151`）只**实例化状态**（player/npcs/装备，`firedEvents`/chains/pendingEvents 空），**没有**任何「运行时生成模板定义」通道；无 `spawn`/`unspawned`/`lifecycle` 实现（仅规格），`npcSetup`（`opening.ts:148-161`）只写关系与可见性，不是刷新规则。仅有的代码构造物是可选 yaml 缺失时的默认模板（`opening.ts:275-292` `createDefaultOpeningTemplate`、`ending.ts:80-82`、`life-evaluation.ts:25-27`）与由模板派生的 `createTimeAdapter`。
- **裁决**：配置层 ≠「只能是磁盘上的 yaml 文件」，但**运行时不生成新的配置层定义**。用户举的「初始化后定义 NPC 刷新规则，后续事件触发 spawn」应落在实例层：
  1. 刷新规则仍写在 yaml（配置域、参与指纹），如 `npcSpawnRules: [{ id, characterRef, condition, spawnAt }]`；
  2. `createWorldV2` 把每条规则**实例化**为 `SpawnRuleInstance { ruleId, status, ... }` 进 `WorldStateV2`（实例层、可序列化）；
  3. 事件效果扩白名单 `spawnNpc(ruleId)`（`common.ts:155-176` EffectSchema 缺口 M11 一并补），依据规则实例创建 NPC 实例，生命周期 `unspawned → alive`，并在事实层只追加 `spawnLog`；
  4. **事实不得反向驱动调度**（§2 硬约束 3）：spawn 只能由玩家行动/效果/队列到期触发，不能因为「有某条事实」自动触发。
- **若确需运行时生成新定义**（例如按 seed 派生一批 NPC 模板）：必须满足 ① 确定性（seed 派生，禁用 `Date`/`Math.random`/LLM）；② 生成结果作为**世界实例数据**进存档，**不参与模板指纹**（否则旧档校验语义崩）；③ 先写 ADR（核心数据模型/配置层边界变更）。**【2026-11-12 第二批裁决 #46：已裁决关闭，用户明确「不做」】** 该更强形式（运行时按 seed 生成**配置层模板定义**）不实现；「规则模板 + 规则实例」常规路径（R-LM-04）保留并归 R2.6。原「推荐不做」升级为已裁决，`OQ-#46` 关闭。

---

## §3 事件模型

### 3.1 触发分类与字段迁移

用户总则落地：触发分**立即**与**延时**两类；`pool` 不是触发类型而是**抽取器**。**【2026-11-12 修订】立即/延时的判据是「是否声明时间窗」，不是 `source` 取值**——`action-hook` 保留旧名且两种形态都允许。

| 分类   | source 取值                                        | 行为                                                                                  | 是否入延时队列         |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------- |
| 立即触发 | `action-hook`（**未**声明 `window/delay`）           | 玩家行动命中 `onActionId` → 本轮内立即 `triggerEventV2`（normal 占槽位 / random 即时转盘 / combat 建战斗） | 否               |
| 立即触发 | `chain`（未声明 `delay` 的步骤）                      | 链的下一步（`onSettle`/`nextTurn`），由结算/推进点立即触发                                           | 否               |
| 延时触发 | `action-hook`（**声明**了 `window/delay`）           | 行动命中后按时间窗入队；到期 drain 判定后触发（例：「做了 X，3 天后 Y 发生」）                                  | **是**           |
| 延时触发 | `chain`（`ChainStep.delay` 步骤）                   | 链步按延时入队，队列有该链条目时不得判断链（R-EV-10）                                                  | **是**           |
| 延时触发 | `schedule`                                       | 世界初始化（opening handoff）与效果 `enqueueEvent` 时按时间窗入队；到期 drain 判定后触发                     | **是**           |
| 抽取器  | `pool`                                           | 管线末尾按 probability/weight/once/priority/conditions **门控 + 抽取**；通过后才入延时队列，不得立即呈现（3.7）   | 是（门控通过才入队）   |

**字段迁移表**（`EventTriggerSchema`，strict schema 下旧字段加载期即拒绝，模板随指纹一并升级）：

| 旧字段                                                                          | 新字段                        | 语义                                                                      | 兼容期处理                                                                        |
| ---------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `source: "action-hook"`                                                      | **保留，不改名**（Q-R25-01 关闭） | 用户裁决：该来源既可能立即也可能延时，改名会把类型与「立即」绑定                                    | 无迁移；`source` 枚举值不变；模板/协议/v2.test.ts 夹具零改动                                  |
| `atTurn: int`                                                                | **退役**                     | x 轮后触发无法换算成世界时间（轮次时长由行动/人生阶段决定，不可预知）                                    | 替代表达：`window.start`（TimeSpec）；现存模板无 `atTurn` 使用（已核对 jjk-2006），退役零迁移成本       |
| `atWorldTime: TimeAmount`                                                    | `window.start: TimeSpec`   | 世界起点偏移 → 统一进时间窗                                                         | `atWorldTime: T` ≡ 世界初始化时入队（now=0）+ `{ after: T }` 相对量，换算结果相同              |
| `cooldownTurns: int`                                                         | `cooldown: TimeSpec`（时间维度） | `worldTime - lastFiredIndex[id].worldTime < cooldownMinutes` 判定            | 需 `firedEvents` 两层拆分（3.6：`eventFires[]` 日志 + `lastFiredIndex` 派生索引）；数值兼容见 §5 |
| `probability` / `weight` / `once` / `priority` / `conditions` / `onActionId` | 保留，但**统一归配置域门控**    | 六字段均为模板只读值（核查见 §0.2 #4），在**候选产生/入队前**求值决定是否入队；drain 不再掷 probability 骰、不再判 once | 门控失败不产生实例、不记错失；`priority` 与 `conditions` 在 chain/schedule 上的死配置由加载期告警收敛 |
| （新增）`window.end?: TimeSpec`                                                | 时间窗结束；到期未触发 = 过期/错失        | 无                                                                       | 无限期用 `undefined`，**不用数值哨兵**（见 §3.5 精度裁决）                                   |
| （新增）`delay?: TimeSpec`（pool / 延时 step 用）                                 | 候选产生后入队的延迟                | **缺省 = 相对 0 分钟**（OQ-#38 关闭）                                            | 抽中即入队、下一次 drain 到期触发，仍走队列                                                  |
| （新增）`timeCost?: TimeSpec`（事件级）                                          | 事件结算轮的 `worldTime` 增量     | **缺省 = 0**（只占槽不耗时，轮次与时间解耦保持）；模板写「这事花了一下午」才推进时间                          | 结算推进 `turnIndex` 恒定，`worldTime += timeCost`（0 时不变）                            |
| （新增）`missWhen` / `missLabel`                                               | 错失机制（§3.4.1）             | `MissReason` 仅 `window_expired \| miss_when`                               | 门控类原因已从枚举移除                                                                   |

**TimeSpec 定义**（`common.ts`，取代原 `TimeExpr` 二分支；#37 裁决基准 = 入队时刻）：

```text
TimeSpec = TimeAmount                        // 现有 { value: number, unit: minute|hour|day|week|month|year }
         | string                            // 兼容时间格式：复合时长 "3d" / "2h30m" / "1y2m"，
                                             // 或模板历法声明下的日期 "2006-12-24" / "洪荒元年"
resolveTimeSpec(spec, now, calendar): number // → 绝对世界分钟（相对量：now + 量；绝对日期：日期 - now 后再固化）
```

- **默认相对入队时刻**，无 `absolute` 分支：世界起点偏移由「初始化入队（now=0）」等价表达；确需「延后到某个绝对日期」时写日期字符串，入队时换算为 `at - now` 的相对量，**仍满足「入队即换算、窗口是实例事实」**（§3.5）。
- 字符串格式由 `CalendarAdapter.parseTimeSpec()` 解析；**【2026-11-12 第二批裁决 #44：方向定 A、实现延期】** 本轮 `TimeSpec` 只实现 `TimeAmount {value, unit}`，字符串语法只留 `CalendarAdapter.parseTimeSpec` seam、**不做加载期解析**（原「加载期 Zod superRefine 校验（非法格式、超出世界时间上界 ⇒ 拒载）」整段作废；#45 亦取消数值上界拒载）；用户原话「符合事件+字面量」按「**复合时长 + 字面量**」解读（候选 A：`3d`/`2h30m` 复合时长 + 历法日期字符串字面量，**注明这是对原文的解读**），实现与 #39/#43 一并排下一期。
- `timeCost`、`cooldown`、`window.start/end`、`delay` 全部复用 `TimeSpec`，不再各造一套时间表达。

### 3.2 轮次槽位唯一【#34 已裁决，2026-11-12】

- **定义**：一个轮次槽位 = 「一个事件被呈现并结算」**或**「一次玩家自由行动」，二者不共存于同一轮。**事件结算推进轮次**是用户的设计前提（2026-11-12 确认），不是待选项；现状 `chooseOptionV2` 不推进 `turnIndex`、`worldTime` 仅效果显式 `advanceBy` 才推进（`turn.ts:623-670`），是「事件零轮次零时间」的旧行为，R2.5 一并纠正。
- **结算轮口径（用户逐项裁决）**：

| 项 | 裁决 |
|---|---|
| 事件结算（`chooseOptionV2` / 转盘确认） | **`turnIndex += 1`**，本轮不再允许自由行动（槽位被事件占用） |
| `worldTime` 增量 | 新增事件级 `timeCost`（TimeSpec，**缺省 0**）：0 = 只占槽不耗时；非 0 时 `worldTime += 换算分钟`。轮次与世界时间继续解耦 |
| 战斗结束 | **算一次结算轮**（战果占槽，推进 `turnIndex`）；战斗回合内 `battleActionV2` 仍不推进（ADR-0001 特例不变） |
| 用物品 / 装备穿脱 | **暂不算**结算轮（保持轮外操作） |
| 事件轮是否跑完整管线 | **跑**：NPC 行动、pool 门控抽取、schedule drain 与普通轮一致（「轮」语义单一，世界不因事件暂停） |
| 同窗多事件 | 一次 drain 仍可出队多条（R-EV-07 出队语义不变），**呈现上每条各占一轮**，逐个结算；T0-10 事件区 UI 零改动 |

- **连带效应**：`pending_event_required`（`turn.ts:505`）从「有待决事件不许推进」反转为「结算本身即推进」，T1-07 收窄为槽位守卫；chain 立即步在下轮呈现（与「下一轮触发」字面一致）；`turnsPlayed` 统计与历史条目 id 计数随之变多（评价分母无语义破坏）；轮种子 `deriveTurnSeed` 调用点增多 ⇒ **同 seed RNG 序列变更**，按 §3.4.5 重录基线。

- **随机事件与战斗的槽位记账（用户 2026-11-11 补充裁决，已定）**：随机事件也是事件，**占其触发轮的槽位**——服务端在轮次结算内用 RNG 抽取并随轮次结果（`wheelResult`）返回，前端在通用事件区以转盘揭示（R-EV-11）；**combat 同理为该轮槽位内容**（战斗会话占据槽位直至结束）。
- **槽位呈现契约（前端，已实现）**：通用事件区 = 槽位的可视化容器；占位者优先级 **转盘（本轮已结算的随机事件）→ 战斗 → 待决事件 → 自由行动（空槽）**，一个轮次只呈现一个；转盘确认「继续」后槽位让位于下一个占位者。同轮其它已结算事件的叙述进「本轮还发生」底栏（排除待决事件与转盘事件，避免重复）。
- **新模型下的 `pending_event_required`**：语义收窄为「槽位被待决事件占用时，拒绝提交新的自由行动」。延时事件到期触发同样产生待决事件，同受此守卫约束。**不变式**：`advanceTurnV2` 结束时 `pendingEvents` 至多按优先级有序、队首必可呈现。
- **槽位唯一前置约束的加载期强制（#35 关闭，2026-11-12 第二批裁决）**：「同一轮至多一个立即触发事件」采用候选①**加载期静态拒绝**（`WorldTemplateV2Schema.superRefine`），并**显式豁免延时事件**——只统计「未声明 `window`/`delay` 的**立即** `action-hook`」并按 `onActionId` 分组，**同组 ≥2 条才报错**；声明了 `window`/`delay` 的 `action-hook`（延时）、`chain` 延时步、`schedule`、`pool` 全部不受此约束（理由：延时事件不占同一轮槽位，不与立即事件争槽）。错误信息须提示「可为后续 hook 声明 window/delay 转为延时」。三组加载期用例见 `tasks.md` T1-01 DoD；验收口径见 R-EV-03。

### 3.3 延时队列数据结构

落点：`WorldStateV2` 新增两个字段：

```text
scheduledEvents: ScheduledEventInstance[]   // 有序数组（保持排序键序）
enqueueSeqCounter: number                   // 单调递增序号，进存档
```

```text
ScheduledEventInstance {
  instanceId: string            // RunnerContext.idFactory("evi") 注入（沿用 EventInstance 惯例）
  definitionId: string          // 指向 events.yaml 定义；实例不复制定义内容（R3 seam 保持）
  origin: EventInstanceOrigin   // kind 扩展枚举："opening" | "schedule-init" | "effect" | "pool"
  chainId?: string              // 归属链的延时步骤
  window: { start: number; end?: number }   // 世界分钟；end 缺省 = 无限期（undefined，不用数值哨兵）
  hasEnd: boolean                           // 显式标记，避免极大世界时间与 +∞ 哨兵共域（§3.5）
  enqueuedAt: number            // 入队时世界分钟
  enqueueSeq: number            // 取自 enqueueSeqCounter++，全局唯一
  status: "waiting" | "fired" | "expired" | "cancelled"
  // 【2026-11-12 修订】无 snapshot：实例不复制 probability/weight/once/priority/conditions/onActionId
  // 等任何配置域字段；判定一律经 lookup.event(definitionId) 读定义现值（§0.2 #4）
}
```

- `status` 生命周期：`waiting → fired`（触发）/ `waiting → expired`（窗口结束仍未触发）/ 任意 → `cancelled`（效果 `cancelChain`/未来效果取消）。`fired/expired/cancelled` 条目**保留在数组中**（审计 + R3 回溯），drain 时跳过非 `waiting` 条目。
- 排序键（**严格固定**）：`window.start asc → window.end asc（undefined 视为 +∞）→ enqueueSeq asc`。

```text
// 比较函数伪代码
cmp(a, b):
  if a.window.start != b.window.start: return a.window.start - b.window.start
  if a.hasEnd != b.hasEnd: return a.hasEnd ? -1 : 1     // 无 end 视为 +∞，排在有 end 之后
  if a.hasEnd && a.window.end != b.window.end: return a.window.end - b.window.end
  return a.enqueueSeq - b.enqueueSeq
```

**稳定性证明**：`enqueueSeq` 全局唯一 ⇒ cmp 不可能返回 0 ⇒ 全序严格；同 start 同 end 的条目由 seq 定序，与插入方式（二分插入 / 整体重排）无关 ⇒ 排序结果与历史无关，纯函数 `sortScheduled(events)` 幂等。**序列化与精度**：不用 `Infinity`（JSON 不支持）、**不用 `MAX_SAFE_INTEGER` 数值哨兵**（洪荒尺度下会与真实世界时间共域，§3.5）；无限期用 `end: undefined` + `hasEnd: false` 显式表达，比较处分支兜底。

### 3.4 出队/触发判定算法

**何时 drain**（三个入口，全部复用同一 `drainScheduledEvents(state, lookup, rng, result)`）：

1. `advanceTurnV2` 时间推进后（替换现步骤 3 的 `resolveScheduleV2`，位置不变——保持 chain 先于 schedule 的优先级次序）；
2. 任何效果推进世界时间后（现 `timeAdvanced` 标记的消费点：`chooseOptionV2`/`useItemV2`/`battleActionV2`/事件结算内——替换其中所有 `resolveScheduleV2` 调用）；
3. 入队后队首已到期时（例如 `delay=0` 的相对入队；实现上入口 2 的 drain 天然覆盖大多数场景，入口 3 仅在 `enqueueScheduled` 内 `window.start <= state.worldTime` 时内联触发一次）。

**两段式判定（2026-11-12 评审修订）**：**入队门控**（候选产生时，配置域策略决定是否产生实例）与**出队判定**（到点是否触发）分离。门控失败**不产生实例、不记错失**——错失事实只记录「曾经入队但未触发」的事件。

```text
// 第一段：入队门控（所有来源统一入口 enqueueCandidate）
enqueueCandidate(state, def, origin, rng):
  if origin == "pool":                         // pool 抽取时：六策略全部在「入池前」求值
    if def.trigger.once && lastFiredIndex[def.id] 存在: return         // 不入队
    if !checkAllConditions(def.trigger.conditions): return              // 不入队
    if def.trigger.probability != undefined && rng() >= probability: return  // 不入队（1 次骰）
    // weight/priority 用于候选集内的确定性排序与加权抽一（pool 每轮一次）
  else:                                       // schedule-init / action-hook 延时 / chain 延时 / effect
    if def.trigger.once && lastFiredIndex[def.id] 存在: return
    if def.trigger.probability != undefined && rng() >= probability: return
    // conditions 不在门控求值，留给出队时刻终判（R-EV-06、schedule 初始化入队不受影响）
  if def.kind == "combat" && origin == "pool": return                   // 加载期已拒，抽取期防御
  inst = enqueueScheduled(state, def, origin, resolveTimeSpec(def.trigger.delay/window, now, calendar))
```

- `weight` / `priority` 只在 pool 抽取阶段消费（排序 + 加权抽一）；`onActionId` 只在 action-hook 命中玩家行动时匹配。**六字段全部经 `lookup.event(definitionId)` 读定义现值，实例不复制**（§0.2 #4）。
- 门控求值依赖运行时状态（`lastFiredIndex`、`flags`/npcs/`worldTime`、注入 RNG、运行时 `actionId`），但**字段本身仍是配置域只读值**——这条边界不变。

```text
// 第二段：出队判定
drainScheduledEvents(state, lookup, rng, result):
  for inst of state.scheduledEvents where status == "waiting":   // 数组已按排序键序
    if inst.window.start > state.worldTime: break                // 有序队列，后面只会更晚 → 停止
    if inst.hasEnd && state.worldTime > inst.window.end:
      inst.status = "expired"
      facts.missedEvents.append(record(inst, "window_expired"))  // 事实层：错失记录（含原因）
      continue
    decision = evaluateDue(inst, state, lookup, rng)             // 顺序见下
    if decision == "fire": inst.status = "fired"; triggerEventV2(...)
    else if decision == "drop":
      inst.status = "expired"
      facts.missedEvents.append(record(inst, decision.reason))   // drop 必须携带错失原因
    else: /* hold: 留队 */ pass
```

**`evaluateDue` 判定顺序（固定，不得重排）**：

| 序 | 检查                                                       | 失败处置                                      | 理由                                               |
| - | -------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| 1 | `missWhen`：模板声明的「触发前提永久失效」谓词（见 3.4.1）                    | **drop**（reason = `miss_when`，可带模板 label） | 前提已永久不成立，留队是僵尸条目                              |
| 2 | `conditions` 终判（读定义现值）                                    | **hold**（留队，窗口内每轮重估）                      | R-EV-06「出队时做触发判断」；时间未到条件不满足是常态，窗口结束仍不满足则走循环头过期路径 |
| 3 | 冷却：`worldTime - lastFiredIndex[id].worldTime < cooldown` | **hold**（留队）                              | 冷却结束仍可能触发                                        |
| 4 | （`once`/`probability` 已在入队门控消费；窗口已在循环头判定）                  | —                                         | 门控失败不产生实例 ⇒ **不构成错失**（用户裁决）                    |

判定通过 → `status = "fired"` → `triggerEventV2(...)`。**失败处置汇总**：missWhen = 丢弃（记错失）；条件/冷却 = 留队；`window.end` 到期 = 丢弃（记错失）。Q-R25-03「全丢/全留」备选随门控前移自然收窄，本表为定稿。

**【2026-11-12 第二批裁决 #36 关闭，采用候选②「留在队列」】**：窗口内 `conditions`/`cooldown` 不满足一律 **hold 留队、每轮 drain 重估、不记错失**（`missedEvents` 零新增）；仅当 `worldTime > window.end` 才出队并追加 `reason="window_expired"` 的错失事实；无 `window.end` 永不因时间过期，由显式 `missWhen` 兜底（R-EV-12/#42）；门控失败不构成错失。本表序 2/3 的「hold」与循环头过期分支即此口径，为定稿。

#### 3.4.1 错失（miss）机制与错失事实【2026-11-12 用户新增】

**概念区分**：本设计的「未触发」分两类，共享同一份事实日志但原因不同——

- **过期（window_expired）**：`window.end` 存在且到点仍未触发（窗口关闭，机会用尽）。
- **错失（miss_when）**：窗口尚未关闭（甚至**无期限**），但**触发前提已永久不成立**——典型如「某角色已死亡，其后置剧情永远不该再发生」。没有 `window.end` 的事件此前只能无限 hold（僵尸条目），错失机制为其提供带记录的终局路径。

**模板契约**（`EventTriggerSchema` 新增字段，R-EV-12）：

```yaml
trigger:
  window: { start: { value: 7, unit: "day" } }   # TimeSpec：默认相对入队时刻；end 缺省 = 无限期
  missWhen:                                    # 可选；触发前提永久失效谓词
    - npcState: { npcId: "gojo", state: "dead" }   # 复用条件 DSL（R2.6 落地 npcState）
    # - flag: { key: "...", equals: "..." } 等，与 conditions 同一 DSL
  missLabel?: "五条悟已死，此事再无发生的可能"      # 可选；错失事实的人类可读标签
```

**设计裁定（missWhen 显式声明与错失原因枚举为写死项；求值时点按 `OQ-#42` 推荐口径 ①，用户 2026-11-12「其余默认通过」）**：

1. **显式声明，不做隐式推断**：引擎**不**从 conditions 里反推「该事件依赖哪个 NPC」再自动判死——条件 DSL 到依赖角色的映射不可靠（一个条件可引用多个角色、可取反、可组合），隐式推断会制造第二套看不见的触发语义，违反 #33「事件无隐藏语义」的既有裁决。模板想表达「XXX 死了就错失」必须写 `missWhen`。
2. **求值时点 = 出队时刻（due drain）**：与 `R-EV-06`「出队时做触发判断」同口径。前提在 `window.start` 之前就已失效的，错失事实记在**首次到期 drain 时**（事实记录的是「系统判定错失」的时刻，不是「角色死亡」的时刻——后者已由 NPC 生命周期/死亡事件另行记录）。不在角色死亡瞬间做全队列扫描（破坏「单一求值点」纪律，且死亡效果可能批量触发导致扫描时机不可控）。
3. **求值用现值**：错失判断的是「现在是否永久不成立」，恒读当前状态与定义现值；实例不含 `snapshot`（§0.2 #4），不存在「快照 vs 现值」二义。
4. **确定性**：missWhen 为纯条件 DSL，无 RNG 消耗；同 seed 回放下命中与否逐字段可复现。
5. **实例状态**：错失实例 `status = "expired"`（状态枚举不扩），原因只记在事实层——实例状态是可重建的排队状态，不是事实；区分两类终局的唯一权威来源是 `missedEvents` 日志的 `reason`。

**错失事实记录**（`facts.missedEvents`，append-only，R-LM-03 约束同样适用）：

```text
MissedEventRecord {
  eventId: string          // 事件定义 id
  instanceId: string       // 队列实例 id（可与 scheduledEvents 对账）
  turnIndex: number        // 判定错失时所在轮次
  worldTime: number        // 判定错失时的世界分钟
  reason: MissReason       // 见下枚举
  label?: string           // 模板 missLabel 透传（仅 reason = miss_when 时有意义）
}

MissReason = "window_expired"     // 循环头：window.end 到点仍未触发
           | "miss_when"          // 序 1：模板声明的前提永久失效（用户需求核心场景）
// 【2026-11-12 评审修订】once_fired / probability_failed 已从枚举移除：
// 二者属于「入队门控」，失败时根本不产生实例，不构成「错失」（用户：相对的 miss 机制也不该有这些原因导致 miss）
```

- 枚举**封闭**（fixed set）：新增原因须改协议，禁止模板自由书写 reason 文本；模板侧唯一自由度是 `missLabel`（人类可读，不参与判定）。门控失败若需可观测性，走**普通日志/调试计数**，不进 `missedEvents` 事实层（避免把「没抽中」误记成「错失」）。
- **门控失败 ≠ 错失**：`missedEvents` 的定义收窄为「已入队的延时事件未触发」，这是事实层语义自洽的关键——一条错失记录必然能在 `scheduledEvents` 找到对应 `instanceId`。
- `missedEvents` 不建按 id 索引（与 history、relationLog 同列——消费点为结局证据与投影统计，顺序遍历即可，见 §3.6「事实层结构约束」）。
- 消费点：结局 `eventOccurred` 类证据之外，R2.5 报告用 curl 断言「错失事件落日志且 reason 正确」（T1-09 DoD）；玩家端是否展示错失提示（如「（此事因……再未发生）」）不在本轮范围，投影字段已备好 `label/reason`。

**与 RNG 消耗顺序的关系（确定性声明）**：

- drain 按排序键序逐个判定；`probability` 骰已移到**入队门控**（每候选 1 次），drain 阶段只可能消耗条件 DSL 内 `RandomCondition` 的骰（`checkCondition` 语义不变）。hold（留队）不消耗 RNG；下轮重估时从序 2 重新开始。
- `pool` 抽取仍在管线末尾（步骤 9），其 RNG 消耗（probability 逐事件掷骰 + weight 抽取）顺序不变；变化在于**门控通过才入队**而非立即 `triggerEventV2`。
- **显式声明：与 R2.4b 相比，同 seed 同输入的事件触发序列与转盘结果会改变**（骰子调用时机/次数、结算推进轮次、事件轮跑完整管线都会增加轮种子调用）。这不违反确定性不变量（新行为完全可复现），但：① 现有依赖具体事件序列的测试需重录基线；② 旧存档不可续玩（§5 一起处理）。
- 断链保护：drain 内触发的 random/combat 事件若再推进时间（`advanceBy`），**不得在本 drain 循环内递归 drain**——新到期实例等下一个 drain 入口（管线步骤 3 次序在后续轮次保证）。实现为：`triggerEventV2` 内的 `timeAdvanced` 只置标记，由路由层在安全边界统一消费（与现状 `resolveScheduleV2` 的调用点纪律一致，仅把「重扫模板」换成「重 drain 队列」）。

### 3.5 时间写法、精度与历法【2026-11-12 评审增补】

- **单一 `TimeSpec`**（3.1）：默认相对**入队时刻**（#37 裁决），本轮支持现有 `TimeAmount {value, unit}`；字符串时间格式（#44：方向定 A、实现延期）**只留 `CalendarAdapter.parseTimeSpec` seam、不做加载期解析**。`enqueueScheduled` 时经 `resolveTimeSpec(spec, state.worldTime, calendar)` **一次性换算为绝对分钟固化进 `window`**——入队即换算保证后续时间回拨/前拨不影响已固化窗口（窗口是实例事实，不是每轮重算的表达式）。`cooldown`/`timeCost`/`delay`/`window.end` 复用同一类型。
- **月/年固定分钟近似**：现 `UNIT_MINUTES.month=43200 (30d)`、`year=525600 (365d)`（`time.ts:18-25`），`format` 固定 30 天月/365 天年（`time.ts:87-94`）。对「3 天后」无影响；对「1 年后」有 ±1 天漂移；对**年号/自定义历/洪荒纪元**完全失真。

**用户提问「按分钟算，几亿年洪荒世界会超出精度吗」——核查结论**：

| 事实 | 数值 |
|---|---|
| `worldTime: number`（`shared/v2.ts:179`、`v2-state.ts:149`，**当前无 int/上界校验**） | 分钟整数约定 |
| JS 安全整数上界 2^53−1 分钟 | ≈ 1.71×10¹⁰ 年（约 171 亿年） |
| 1 亿年 | ≈ 5.26×10¹³ 分钟 → **整数精确，加 1 分钟无误差** |

即「几亿年」本身**不会**超出分钟整数精度；真正的风险有三处，逐条给修订：

1. **`MAX_SAFE_INTEGER` 当 +∞ 哨兵**（原 §3.3 比较函数）：它只存在于规格、运行时代吗无；但洪荒尺度下会与真实 `window.end` 共域 ⇒ **改 `end: undefined` + `hasEnd: boolean`**（§3.3 已就地修订）。
2. **年号/纪元显示**：标量是分钟，显示不该硬编码「YYYY年」。模板 `world.yaml` 声明 `calendar: { preset, era?: { name, epochStartMinute, ... } }`，`CalendarAdapter.format(minute)` 按声明渲染（如「洪荒 3 亿年」/「开元十二年」）。**世界时间标量不变，显示与年号解耦**。
3. **自定义纪元的跨度**：若模板把「1 纪元」声明成极大分钟数，`TimeAmount.value: number`（`common.ts:14`，无 int/上界）可逼近 2^53 ⇒ `worldTime` 与所有时间量加 `z.number().int()`（**仅整数校验**）。**【2026-11-12 第二批裁决 #45：保持现状、下期决策】** 本轮**不加** `MAX_WORLD_TIME = 2^52` 显式数值上界拒载、**不加** `{ epochIndex, minuteInEpoch }` 双字段/BigInt；`worldTime` 维持现状（number 分钟），`R-LM-05` 本轮验收收缩为「整数分钟 + `hasEnd` 无数值哨兵」。上界校验与年号/纪元渲染随 #39/#43 下一期（R2.6）首批一并验收；届时若需要 > 2^52 分钟或亚分钟精度 ⇒ 改双字段或 BigInt，**须先写 ADR**（核心数据模型变更）。

**用户提问「为什么只做公历？是年号/自定义时间没实现好吗」——如实回答**：不是「没实现好」，是**范围裁定**——R2.5 只需短延时，固定分钟近似零迁移成本；真实公历、农历/自定义历、年号需要扩 `CalendarAdapter`（`toMinutes(amount, from)` / `ageAt(birth, now)` / `format` 注入历法），ADR-0002 只留了 seam（`DECISIONS.md:65` 声明 `world.yaml` calendar 位），**代码确实未实现**（`world.ts:101-107` 只有 `defaultStep/lifeStages`，`time.ts:64-105` 无 preset 分支）。本轮把接口形状定死：

- 候选 ① **近似标量**（固定分钟，R2.5 默认实现）；
- 候选 ② **真实公历**（月长 28-31、闰年）；
- 候选 ③ **自定义历/年号/洪荒纪元**（模板声明 `calendar.preset` + 纪元表；`format`/`ageAt` 走适配器）。

三者统一走 `CalendarAdapter`，接口增 `toMinutes(amount, fromMinute)` / `ageAt(birthTime, now)` / `parseTimeSpec(spec)` / `format(minute)`；**R2.5 实现 ①**，接口按三者形状设计、不锁死单一模型。**【2026-11-12 第二批裁决 #39/#43：继续延期，下一期（R2.6）首批解决】** 本轮不实现 ②真实公历/③自定义历+年号，`CalendarAdapter` 接口形状保持预留；`Q-R25-05` 标注「下期首办」（原「实现排期仍属用户裁决」作废）。#44 的字符串 `TimeSpec` 字面量语法同批延期（本轮只实现 `TimeAmount`、不做加载期解析）。

### 3.6 退役 `atTurn` 与 `cooldownTurns`

| 退役项                                              | 替代表达                                                                                      | 需改的模板点                                                             | 需改的代码点（只列不改）                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `trigger.atTurn`（x 轮后）                           | `window.start: TimeSpec`（默认相对入队时刻）。轮次时长不可预知 ⇒ 语义上不可换算，必须用时间窗                  | 现存模板零使用（已核对 jjk-2006 events.yaml 无 `atTurn`）                       | `event.ts` schema 删字段；`turn.ts:379` due 判定删除                                                 |
| `trigger.cooldownTurns`（轮次冷却）                    | `trigger.cooldown: TimeSpec`：`worldTime - lastFiredIndex[id].worldTime < cooldownMinutes` | jjk-2006 中带 `cooldownTurns` 的 pool 事件（加载期 strict 会拒绝旧字段，随指纹升级一并改写） | `event.ts` schema；`turn.ts:407-411` `onCooldown` 改读 `lastFiredIndex`；`firedEvents` 两层拆分（3.6） |
| `duration.turns`（补正轮次寿命）/ NPC 行动 `cooldownTurns` | **本轮不动**（R2.6 随 NPC 冷却迁移评估；ADR-0001 已确认战斗不消耗世界时间的特例）                                      | —                                                                  | —                                                                                            |


**`firedEvents` 拆为两层（修正 R2.4b 的按 id 覆盖写——覆盖违反 R-LM-03「事实只追加、逐字段不变」与本文件 §2 的层定义）**：

- **事实层 `eventFires: Array<{ eventId: string; turnIndex: number; worldTime: number }>`**：append-only，每次触发追加一条，同 eventId 可多条（多次触发是多次事实），**写入后逐字段不变**（R-LM-03 验收）。
- **派生索引 `lastFiredIndex: Record<eventId, { turnIndex: number; worldTime: number }>`**：**显式标注为派生缓存，不是事实**——完全可从 `eventFires` 重建（对每个 eventId 取最后一条）；语义上等价于现 `firedEvents`（「最近一次触发」）。消费点（`once` 判定、冷却判定、结局 `eventOccurred` 的 `v2/ending.ts:134` 按 eventId O(1) 查询）一律读索引；**索引与日志不一致时以日志为准重建**（加载存档时、或防御性校验发现漂移时）。事件按 eventId 随机查询的需求由索引承接（见下「事实层结构约束」），append-only 语义由日志承接，两者职责不混。

旧存档兼容：现 `firedEvents` 数字值视为 `{ turnIndex: v, worldTime: 0 }` 导入 `lastFiredIndex`（仅拒载策略下的兜底说明，见 §5；`eventFires` 无旧档数据可迁移，旧档缺失该日志是已知损失）。

**事实层结构约束（防止实现走偏）**：事实层 ≠ 只能是裸数组。按 eventId 的随机查询必须有索引承接：终止条件 `eventOccurred`（`v2/ending.ts:134`，`ids.every((id) => state.firedEvents[id] !== undefined)`）要求按 eventId O(1) 查询「全部已登记」——该需求由 `lastFiredIndex` 承接（3.6 两层拆分），**不得把 `eventFires` 实现成数组后让终止判定退化为 O(n) 扫描，也不得另建第二份按 id 的"事实"副本**（索引不是事实，是可重建缓存，唯一事实来源是 `eventFires` 日志）。设计口径：**事实层 = 「只追加的记录 + 其派生索引」**；无按 id 随机查询需求的事实（history、missedEvents、relationLog）不建索引（投影/结局证据均顺序遍历）。

**测试迁移清单（退役项的现存测试使用，只列不改）**：

| 退役/待决项                                  | 测试使用点                                                                                                                       | 迁移动作                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atTurn`（退役）                            | `packages/game-core/src/v2.test.ts:737`（combat 并发优先级：`{ source: "schedule", atTurn: 1 }` 注入首轮时间触发战斗）、`:768`（normal 队列优先级同型） | 改写为 `window: { start: { value: 1, unit: "day" } }`（TimeSpec 默认相对入队时刻；初始化入队时 now=0，等价于原绝对偏移）——**两个测试断言的「优先级次序」语义不变**，仅触发表达换形；这两个测试同时是 RNG 序列基线重录点（§3.4.5） |
| `advanceWhen: "nextTurn"`（去留待 Q-R25-06） | `v2.test.ts:711`、`:786`（链 nextTurn 步触发链战斗/链 normal）                                                                         | 若 Q-R25-06 裁决保留（推荐）：测试不动；若退役：两测试改写为 `onSettle` + `delay` 或重设计                                                                                       |
| `cooldownTurns`（改 `cooldown: TimeSpec`） | 夹具中带 `cooldownTurns` 的 pool 事件（v2.test.ts 内多处构建）                                                                            | 字段换形 + 冷却判定从轮次差改时间差，相关断言重算                                                                                                                          |

### 3.7 `pool` 语义收敛【2026-11-12 评审修订】

- **现状核查**：`resolvePoolV2`（`turn.ts:329-352`）已经按顺序执行 `once`（:333）/ 冷却（:334）/ `conditions`（:335）/ `priority` 排序（:336）/ `probability` 逐事件掷骰（:342-345）/ `weight` 加权抽一（:346-350）**六策略过滤**，然后 `triggerEventV2` **立即呈现**。**没有**任何 `kind: combat` 过滤（`turn.ts:329-352` 全函数、`world.ts:178-499` superRefine 均无 source×kind 交叉校验），测试 `v2.test.ts:674-685` 甚至构造过 `source: pool` + `kind: combat`。
- **新语义（用户裁决）**：**门控在抽取时决定是否入池，不是先加进队列等时间到再判定**。抽中且门控通过 → `enqueueCandidate(...)` → 实例进延时队列，只能经 drain 触发（=「pool 只能触发延时事件」）。门控失败（once 已触发 / 概率未中 / 条件不满足）**不产生实例、不记错失**——`missedEvents` 里不会出现 `once_fired` / `probability_failed`（§3.4.1）。
- **无时间窗口怎么办（用户提问，予以裁决）**：`trigger.delay?: TimeSpec` 缺省 = **相对 0 分钟**（OQ-#38 关闭）。抽中即入队、`window.start = now`，由入口 3 内联 drain 在下一次安全边界触发；**仍走队列路径，不算立即触发**，语义上保持「pool 只触发延时事件」。jjk-2006 现有 5 个 pool 事件无需写 delay 即可平滑迁移；模板若想真正延时就显式写 `delay`（如 `{ value: 3, unit: "day" }`）。
- **战斗事件不入池（用户裁决）**：加载期 `WorldTemplateV2Schema.superRefine` **拒绝 `source: "pool"` + `kind: "combat"`**（并给替代写法提示），抽取期保留防御性过滤。想要战斗就写 `normal` 或 `random` 事件入池，再由该事件的 `chain` 立即步 / `nextEventId` **立即触发战斗**——现代码已支持（`turn.ts:310-325` 无 kind 过滤、`events.yaml:196-202` 链内 combat 步骤、`v2.test.ts:696-721` 链起手战斗用例）。理由：战斗会话占槽直至结束，与「抽中→入队→延时触发」的语义叠一层会话状态，且池抽取的权重/概率语义会被战斗结果污染；用事件包一层把「遭遇」与「战斗」解耦。
- **抽取时机与 RNG**：仍在管线步骤 9、每轮一次；probability 逐事件掷骰 + weight 加权抽一，顺序不变。**概率骰只在门控消耗一次**，drain 阶段不再对 pool 来源实例重复掷骰（旧设计的「跳过序 4」条款作废，因序 4 已整体移出出队判定）。

### 3.8 链断裂判定（`evaluateChain` 纯函数）

```text
evaluateChain(state, lookup, chainId) → "active" | "completed" | "stalled"
  链实例 c = state.chains.find(id)；c 缺失或 c.status == "completed" → "completed"
  充分条件之一：时间队列存在 { chainId == c.id, status == "waiting" } 的未触发实例 → "active"（等待延时步骤到期）
  否则：当前步骤已 fired 但未结算（normal 在 pendingEvents 占槽）→ "active"
  否则：def.steps[c.stepIndex] 不存在或事件定义缺失 → "completed"（断链：定义被删/越界）
  否则 → "active"（等待 nextTurn 推进或玩家结算）
```

- 「链为 active 的充分条件之一必须是时间队列里存在该链的未触发实例」——落地为上面的第二个分支：**链的延时步骤入队后，即使 `stepIndex` 尚未推进，链也不得被判为断链**。这是 M4（stepIndex 双写漂移）的结构性修复：断链判定不再只信 `stepIndex`，以队列实例对账。
- `advanceWhen: nextTurn` 与「x 轮后触发」的关系：`nextTurn` 语义是「下一轮推进时触发」——它**不**是「x 轮后」（后者已退役）。推荐**保留 `nextTurn`**（jjk-2006 现无使用但协议保留表达力；「下一轮」是槽位语义不是时间量），延时步骤用 `ChainStep.delay?: TimeSpec` 表达（3.9）。是否一并退役记 Q-R25-06。
- **`stepIndex` 改派生还是保留缓存**：**推荐保留缓存 + 单一写入口**。理由：派生需要回放「哪些事件已结算且属于本链」（事实层只有 eventId→firedAt，无法区分链实例归属），引入派生映射表的成本高于一个被严格收口的整数。措施：① 删除 `engine.ts:370-375` `advanceChain` 效果的盲目 `+1`（改为按 `findIndex` 对齐，与 `advanceChainOnSettle` 同规则）；② `evaluateChain` 作为断链兜底校验；③ `startedTurn`/`stepIndex` 继续进存档。

### 3.9 事件链与延时队列的组合

链的一步可以是「3 天后触发」，写法：

```yaml
chains:
  - id: chain-culling-game
    startEventId: ev-culling-announce
    steps:
      - { eventId: ev-culling-announce, advanceWhen: onSettle }          # 结算后立即触发下一步
      - { eventId: ev-culling-day3, advanceWhen: onSettle, delay: { value: 3, unit: "day" } }
      - { eventId: ev-culling-finale, advanceWhen: nextTurn }            # 下一轮（保留语义，Q-R25-06）
```

执行语义：步骤结算时（`advanceChainOnSettle`），若该步声明 `delay` → **不入 `pendingEvents`、立即 `enqueueScheduled`**（`origin` = `chain` 类kind、`chainId` 记录、窗口从结算时刻起算）→ 链状态保持 active（`evaluateChain` 靠队列实例判定存活）→ 到期 drain 触发时按 `chainId` 回归链优先级。`pauseWhenHidden` 语义不变（hidden 世界线的链在投影层处理，不影响队列）。

---

## §4 NPC 系统

### 4.1 生命周期

```text
V2Npc.lifecycle: {
  state: "alive" | "inactive" | "unspawned"
  reasonCode?: string        // 仅 inactive 时有意义；模板自由语义："dead"|"missing"|"sealed"|"fell"…
  sinceTurn: number          // 进入当前状态的轮次（事实性记录）
  sinceWorldTime: number
}
```

|   |   |   |
| - | - | - |

- **引擎只判 `alive`**：所有消费点做 `npc.lifecycle.state === "alive"` 过滤。**引擎不得对 `reasonCode` 分支**——「死了才能 X」「失联者 Y」的业务语义由模板条件表达；为此新增条件 DSL：`{ npcState: { npcId: string, state: "inactive" | "unspawned" | "alive" } }`（只匹配状态本身，永远不暴露 reasonCode 匹配）。
- **与业务语义解耦**：`dead`/`missing`/`sealed` 只是字符串，引擎行为完全一致（不行动、不参战、关系冻结）。模板可自造 reasonCode（Zod 校验为 `string.min(1)`，不设枚举）。  
  |  |  |  
  | --- | --- |
- **spawn 由谁触发**：① 模板初始化——`characters.yaml` 角色缺省 `alive`；模板可声明 `initialState: "unspawned"|"inactive"`（含 reasonCode）表达「开局未登场/开局已死亡的重要角色」；② 事件效果——`EffectSchema` 新增 `{ type: "setNpcLifecycle", npcId, state, reasonCode? }`（与 `setFlag` 同级的白名单效果，经既有 `applyEffectsV2`）；③ NPC 行动效果——同样通过效果 DSL，无特权通道。
- **不引入 `lifecycle.ts` 模块/阶段枚举**（ADR-0004 边界继续有效）：这是角色级三态字段，不是流程编排；boundary 静态检查不放松。

### 4.2 默认判活（模板零书写）

四处消费点**引擎自动过滤**，模板不写任何 `alive` 条件：

| 消费点        | 过滤规则                                                                                                                                                                                                                                                                                                                                  | 位置（现）               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| ① NPC 自主行动 | `lifecycle.state !== "alive"` 直接 continue（替代并加强现 `isEnemy` 跳过的一半职责）                                                                                                                                                                                                                                                                   | `npc.ts:35-37`      |
| ② 战斗参战     | `createBattle` 解析 `enemies`/**`allies`** 的角色 ref 时，目标 NPC `inactive/unspawned` → **跳过该场战斗整条触发并记一条事实**（沿用现 combat 冲突口径：`triggerEventV2:219`「已有进行中战斗时整条跳过、不写 firedEvents/不消耗 once/冷却」——扩为「目标不可参战时同样整条跳过」）。**不在建场期硬报错**：「分支里先死、之后再引用同一 NPC 的战斗」是合法剧情（事件条件层可另行用 `npcState` 把关）。只有 `characterId` 在模板里**根本不存在**才在加载期报错（引用完整性，同性别/技能/补正校验口径） | `battle.ts` 建场      |
| ③ 关系变更     | `adjustRelation`/关系效果对 `inactive` NPC **冻结**（跳过写入，不改数值）；对 `unspawned` 同样冻结                                                                                                                                                                                                                                                            | `engine.ts:321-326` |
| ④ NPC 相关条件 | `requireKnowledge`、新增 `npcState` 条件正常求值（条件是模板显式意图，不默认过滤）；但**NPC 行动候选过滤**（①）已先行挡住 inactive NPC 的行动                                                                                                                                                                                                                                     | `npc.ts:41`         |

覆盖需求（如「鬼魂参战」「死者托梦」）：模板用 `setNpcLifecycle` 先复活（`state: "alive"`）再触发，或该事件走 `schedule` 不依赖 NPC 行动管线。是否需要「绕过判活」的一等模板开关记 Q-R25-07 附带项。

### 4.3 投影与生命周期解耦

**原则**：判活决定「引擎要不要让 NPC 做事」；投影决定「玩家能不能看到 NPC」。二者无蕴含关系——开局已死亡的重要角色（`initialState: inactive, reasonCode: "dead"`）照样上屏。

```text
projectNpc(npc, state, template) → NpcView | null
  输入：npc 实例（public 字段子集）
      + 玩家已知标记 npc.infoVisibility: "known"|"inferred"|"unknown"（自 flags 迁入实例，§2 M3）
      + 模板投影配置 characters.yaml 每角色可选 projection: {
          alwaysVisible?: boolean        // 无论已知与否恒上屏（如开局已死亡的关键人物）
          revealFields?: string[]        // 上屏时的字段白名单覆盖（缺省按 infoVisibility 档位）
          showLifecycle?: boolean        // 是否展示状态标注（死亡/失联文案由模板 label 映射，引擎只给 reasonCode）
        }
  规则：unknown 且 !alwaysVisible → null（不进投影）
        inactive → 照常上屏，age 冻结于 sinceWorldTime、status 标注由模板 label 提供
        secrets/goals/traits/knowledge/combatHints 一律不进（现状不变，R-VS-01）
```

- **死亡角色仍可上屏**：`reasonCode` 经模板 label 映射为展示文案（如 `dead → "已故"`），引擎不下发语义解释。NPC 产生的事件（历史）照常按 `HistoryEntryV2.visibility` 规则过滤，与生死无关。  
  |  |  |  
  | --- | --- |
- **`visibility: public|hidden` 是否保留（#41 关闭，2026-11-12 第二批裁决）**：**采用候选①「合并」**——`visibility: public|hidden` 并入「NPC 投影原则」的**单一判定入口 `projectNpc()`**，不再与动态已知标记（`infoVisibility`/`projection.alwaysVisible`）各设一套判定；历史条目可见性 `R-VS-03` / `isPlayerVisible()` 口径不变。原「推荐保留为第二道静态闸、与动态已知标记做 AND 组合」及 Q-R25-07 的 A 案**按此改写作废**（合并 ≠ 简单 AND 两套并存）；ADR-0012 决策 3 同步改写。关联 R-NP-01、T2-03。

### 4.4 年龄动态计算与三种时间模型

- **数据模型**：`V2Npc` 删除静态 `age`（`V2CombatantBase.age` 一并处理），新增 `birthTime: number`（世界分钟，**可为负** = 世界开始前出生）。模板 `characters.yaml` 仍写 `identity.age`（配置层人类可读），`createWorldV2` 换算：`birthTime = 0 - age * yearMinutes`（近似历法）或经 CalendarAdapter 反推。
- **删除 `age` 的影响面（必须完整接线，否则前端/战斗全挂）**：
  - `V2CombatantBase.age` 是 `BattleEnemy`（`packages/shared/src/v2.ts:40-52` 经 V2Npc/V2Player 继承链）共用的基类字段——`V2Player`/`V2Npc` 删静态 age 时，**战斗镜像不跟随**：`createBattle` 建场时把当时计算好的 `age` **快照**进 `BattleEnemy`/战斗内单位（战斗不消耗世界时间，ADR-0001 已确认，战斗内不能也不需要实时 `ageAt`；快照值在战斗生命周期内恒定）。
  - **投影层仍下发计算后的 `age`（视图字段，不是实例字段）**：`projection.ts:100`（玩家快照 `player.age`）与 `:141`（NPC 快照 `npcs[].age`）的形状**对前端保持不变**，内部实现改为 `ageAt(birthTime, state.worldTime)` 现算；前端 `apps/web/src/main.tsx:531/1225/1597` 的 `age` 消费点**零改动**。原则：删的是**实例层的存储**，不动**视图层的输出形状**——避免一次内部重构波及前端。
  - `formattedTime`/人生阶段等其余时间输出不受影响（本就经 CalendarAdapter）。
- **算法**：`ageAt(npc, now) = calendar.ageAt(npc.birthTime, now)`；近似历法下 `= floor((now - birthTime) / 525600)`。投影、条件（如新增 `{ npcAge: { npcId, gte } }`，是否需要记 Q）、人生阶段判定统一走该函数；玩家亦统一（`playerAgeAtStart + elapsedYears` 退役，`V2Player` 同样挂 `birthTime`）——统一与否记 **Q-R25-08**（推荐统一，消除 M7 的双语义）。
- **三种时间模型**（与 3.5 共用 CalendarAdapter 裁定；「以后没说的话默认都要支持」= 统一接口 + 模板声明切换）：

| 候选        | 说明                      | 接口位                                                                       | 成本                                               |
| --------- | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| ① 近似标量（固定分钟） | 1 年 = 525600 分钟，生日即整年节点；R2.5 默认 | `ageAt = floor((now-birth)/525600)`                                       | 零（现状语义）                                          |
| ② 真实公历         | 月长 28-31、闰年；「生日未到不加岁」  | `world.yaml: calendar: { preset: "gregorian", startYear }`；`ageAt` 按历法日期差 | CalendarAdapter 完整实现 + `toMinutes(amount, from)` |
| ③ 自定义历/年号/纪元 | 世界自定义月长/置闰/年号/洪荒纪元    | `calendar: { preset: "custom", months[], leapRule, era: { name, epochStartMinute }... }` | 最大；农历可考虑 lunar-javascript；`format` 渲染年号（§3.5）    |

**口径（与 §3.5 合并后统一）**：R2.5/R2.6 只实现 ①，接口按 ②③ 形状设计（`CalendarAdapter` 增 `toMinutes(amount, fromMinute)` / `ageAt(birth, now)` / `parseTimeSpec` / `format(minute)`，模板 `calendar.preset` / `era` 声明位）。**这不是「年号/自定义时间没实现好」**，而是范围裁定：R2.5 只需短延时，ADR-0002 留了 seam 但代码确实未实现（`world.ts:101-107`、`time.ts:64-105` 无 preset 分支）；接口形状本轮定死、保持预留。**【2026-11-12 第二批裁决 #39/#43：继续延期，下一期（R2.6）首批解决】** 本轮不实现 ②真实公历/③自定义历+年号，`Q-R25-05` 标注「下期首办」（原「实现排期仍属用户裁决」作废）；#44 字符串字面量、#45 上界校验与年号渲染一并顺延下一期（见 §0.3）。

### 4.5 关系模型

- **分离**：`affinity: number`（-100..100，现 `relationship` 改名，数值好感）与 `relations`（类型化边）分离。**亲属与师承不手写双向**，由单向事实推导：

```text
// 实例层：NPC 实例上的单向事实边（写入即校验）
V2Npc.parents: string[]          // 双亲 npcId 列表（≤2 不强制，模板自由）
V2Npc.masterId?: string          // 师父
V2Npc.ancestorGaps?: Array<{ id: string; direction: "ancestor"|"descendant"; minHops?: number }>
                                 // 【新增】断代声明：只知道「某祖先」但中间代数缺失，不补节点、不猜代数
// 事实层：关系变更记录（只追加）
relationLog: Array<{ npcId, kind: "parent"|"master"|"affinity", targetNpcId?, delta?, source?, atTurn, worldTime }>
```

- **推导算法（分层，2026-11-12 评审修订）**：
  - **自研图内核**（game-core `v2/relations.ts`，纯函数、确定性、离线）：`child`/`apprentice` 反查、`sibling`/同门倒排索引 O(N+E)、`parents` 图与 `master` 链 BFS/DFS 上溯、**环检测**（写入 `parents`/`masterId` 时校验目标不在自己的后代/徒弟链上，加载期与运行时同样校验，违反抛可诊断错误）；
  - **多跳中文称谓交给成熟库**（见下）：已知跳数的亲属路径转成关系链记号（`f/m/s/d/xb/ob/lb/xs/os/ls` 等）→ `relationship.js` 出称谓（舅外公、甥外孙…）；路径不唯一时取**最短路径 + 确定性次序**（字典序），与库 `optimal` 语义一致；
  - **断代**（用户提问「只知道祖先、中间断代」）：`ancestorGaps` 显式声明缺口，推导结果带 `gap: true` + `hopsKnown: false` + **粗称谓**（如「祖辈（代数不详）」或模板 `label`），**不猜代数、不伪造中间节点**；条件/评分消费的是结构边 + gap 标记，不是编造的辈分数字；
  - **师承称谓**（师祖/师伯/师侄）无现成库覆盖：模板声明 `titleRules`（链长 → 称谓映射），自研按 `master` 链长查表，模板可覆盖；
  - `custom` 关系：`relations: Array<{ type: "custom", customType, label?, targetNpcId, source? }>`，语义完全模板自定义（用户后续通用 yaml 机制的落点，本轮只留类型位）。
- **开源调研（用户追问「真的没有成熟的库吗」——有，2026-11-12 实查核实）**：

  | 库 | 事实 | 覆盖/不覆盖 |
  |---|---|---|
  | **`relationship.js`**（npm，mumuy/relationship；MIT，v1.2.9，`dependencies: {}`，约 3.7k stars，仍在维护；TypeScript 声明由 `@types/relationship.js` 提供） | 纯 JS 数据表算法，Node 离线可用、无网络调用、**同输入同输出（确定性）**；支持 `type:'chain'` 反查关系链、`optimal` 最短关系、`setMode` 方言覆盖、多跳称谓（「妈妈的妈妈的哥哥」→ 舅外公） | ✅ 多跳中文亲属称谓；❌ 不存图、不处理师承、不处理断代 |
  | `lunar-javascript` | 农历/历法计算成熟库 | 时间模型 ③ 启用时首选；本轮不引 |
  | `geneajs` / `banyan` / family-chart / GEDCOM 系 | 可视化或英文 consanguinity 计算 | 与运行时图查询/中文称谓不匹配 |

  **修订结论（原「默认不引入依赖」作废）**：改为**分层复用**——自研图内核（结构边、断代、师承、环检测）+ 引入 `relationship.js` 只承担「已知亲属链 → 中文称谓」的纯函数展示层。选它的理由正是 `OQ-#40` 的两条硬约束：**确定性**（纯查表，无随机/时间读取）与**离线可用**（零运行时依赖、无网络）；引入前按 AGENTS.md §0 走 ADR（新增 `game-core` 第三方依赖），并在 `package.json` 锁版本、把称谓输出限制在投影/展示层（不得回写权威状态）。若用户不愿引入依赖，退路是把该库的数据表**快照进模板配置层**（仍是可复用成熟方案，但需维护数据副本）。`OQ-#40` 按此关闭。


### 4.6 NPC 行动与事件的边界

- NPC 行动结算**只能**：写事实（history `npc_action`）、写实例状态（自身字段、背包、关系 affinity）、经效果 DSL 改世界（现状 `applyEffectsV2` 白名单）；需要排程时**只能经 `enqueueCandidate` 门控 + `enqueueScheduled`**（新增效果 `{ type: "enqueueEvent", eventId, delay?: TimeSpec }`，事件与 NPC 行动共用），**不得直接触发模板事件**——现 `startedChains` 收集 + 路由层触发的模式保留（它是「效果收集 → 路由触发」，不是 NPC 直接触发）。
- 落点：`npc.ts` 不新增扫描逻辑；NPC 行动的 `cooldownTurns` 改时间维度随 R2.6（Q-R25-04）。

---

## §5 兼容与迁移

**`WorldStateV2` 变更清单**：

| 字段                                                        | 变更                                                                                        | 层      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| `scheduledEvents: ScheduledEventInstance[]`               | 新增                                                                                        | 实例     |
| `enqueueSeqCounter: number`                               | 新增                                                                                        | 实例     |
| `missedEvents: MissedEventRecord[]`                       | 新增（{instanceId, definitionId, reason: "expired"|"once"|"probability", atTurn, worldTime}） | 事实     |
| `eventFires: Array<{eventId, turnIndex, worldTime}>`      | 新增（append-only 触发日志，替代旧 `firedEvents` 的"事实"角色）                                            | 事实     |
| `lastFiredIndex: Record<eventId, {turnIndex, worldTime}>` | 新增（派生索引/缓存，承接 once/冷却/eventOccurred 的按 id 查询；可从 eventFires 重建）                            | 实例（缓存） |
| `relationLog`                                             | 新增（R2.6）                                                                                  | 事实     |
| `pendingEvents`                                           | 形状不变（即时待决专用，不再兼调度）                                                                        | 实例     |
| `chains: ChainStateV2`                                    | `advanceChain` 写入口收口；形状不变                                                                 | 实例     |
| `flags`                                                   | 删除 `openingScheduled:*`、`turnsPlayed`；其余迁出随 R2.6                                          | 拆分见 §2 |
| `V2Npc`                                                   | +`lifecycle` +`birthTime` +`parents` +`masterId` +`infoVisibility`，-静态 `age`（R2.6）        | 实例     |

**schemaVersion 升级**：信封 `schemaVersion: 1 → 2`（ADR-0007 机制）。

**旧存档：拒载 vs 迁移——推荐拒载**。理由：① 本轮是数据模型换代（队列/事实结构不可由旧字段机械推导）；② 模板指纹本就因 events.yaml/characters.yaml 变更而拒旧档，迁移旧档也无模板可用；③ 迭代期用户已接受重开（ADR-0008/0009 先例）。加载器对 `schemaVersion !== 2` 记 error 跳过（沿 ADR-0007 行为）。`firedEvents` 数字兜底规则（3.6）仅在内部测试夹具使用，不构成迁移承诺。

**模板指纹影响**：`EventTriggerSchema`（window/delay/cooldown/timeCost/missWhen 改造）、`ChainStepSchema`（delay）、`characters.yaml`（projection/lifecycle 初始声明，R2.6）均为 breaking strict 变更 → 指纹必变 → 旧档拒载，与上述策略一致。jjk-2006 模板随实施同步迁移（1 个 schedule、5 个 pool、1 个 `action-hook` **保留旧名**不做迁移、约 20 个 chain，全部 `onSettle`，无 `atTurn`——迁移量小）。

---

## §6 影响面清单

| 文件                                                              | 改动类型                                                                                                                                                                                                                                                                                                      | 轮次                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/shared/src/schema/common.ts`                          | 新增 `TimeSpecSchema`（**本轮只实现 `TimeAmount {value, unit}`**；字符串格式只留 `parseTimeSpec` seam、不做加载期解析，#44；取代原 `TimeExpr` 二分支）；`TimeAmount` 加 int 校验（**本轮无数值上界校验**，#45，见 §3.5）；`EffectSchema` 加 `spawnNpc(ruleId)`（§2 刷新规则）                                                                                                                                                                 | R2.5                                                  |
| `packages/shared/src/schema/common.ts`                          | `EffectSchema` 白名单**新增三类效果**（M11 缺口，R-NP-03 / R-EV-08 / §2 刷新规则的写入通道）：① `{ type: "setNpcLifecycle", npcId, state: "alive"\|"inactive"\|"unspawned", reasonCode? }`（R2.5 落 schema、R2.6 落消费）；② `{ type: "enqueueEvent", eventId, delay?: TimeSpec }`（R2.5，事件与 NPC 行动共用的延时入队通道）；③ `{ type: "spawnNpc", ruleId }`（R2.6，依 `SpawnRuleInstance` 建 NPC 实例）。均走 `applyEffectsV2` 白名单分发，引擎不新增特权写入路径 | R2.5（schema+enqueueEvent 消费）/R2.6（setNpcLifecycle/spawnNpc 消费） |
| 新增效果模板写法示例（进 events.yaml / npcActions）                          | `events.yaml`（失联事件映射，R-NP-03）：`effects: [{ type: "setNpcLifecycle", npcId: "npc-toji", state: "inactive", reasonCode: "missing" }]`；NPC 行动排程延时事件：`npcActions[].effects: [{ type: "enqueueEvent", eventId: "ev-shadow-deal", delay: { value: 2, unit: "day" } }]`（TimeSpec 默认相对入队时刻）             | R2.5/R2.6                                             |
| `packages/shared/src/schema/event.ts`                           | `EventTriggerSchema`：window/delay/cooldown/timeCost/missWhen/missLabel；**`action-hook` 保留旧名**；退役 `atTurn/cooldownTurns`；`ChainStepSchema.delay`                                                                                                                                                      | R2.5                                                  |
| `packages/shared/src/schema/world.ts`                           | `superRefine` 新增 `source: pool` + `kind: combat` 拒绝；`calendar.preset` / `era` / `npcSpawnRules` 声明位（§3.5/§2）                                                                                                                                                                                                | R2.5/R2.6                                             |
| `packages/shared/src/schema/event-instance.ts`                  | `EventInstanceOrigin.kind` 扩展（opening/schedule-init/effect/pool）；与 `ScheduledEventInstance` 合并或引用（实施时二选一，避免两套实例类型并存——推荐直接扩展本文件为统一实例 schema）                                                                                                                                                               | R2.5                                                  |
| `packages/shared/src/v2.ts`                                     | `WorldStateV2` 新字段（§5）；`eventFires`/`lastFiredIndex` 类型；`PendingEvent` 注释收窄                                                                                                                                                                                                                               | R2.5                                                  |
| `packages/shared/src/v2-state.ts`                               | 存档 Schema 同步 + schemaVersion 2                                                                                                                                                                                                                                                                            | R2.5                                                  |
| `packages/game-core/src/v2/scheduler.ts`（新）                     | `enqueueCandidate`（入队门控，六策略）/ `enqueueScheduled` / `drainScheduledEvents` / `evaluateDue` / `cmp` / `evaluateChain`——调度唯一入口                                                                                                                                                               | R2.5                                                  |
| `packages/game-core/src/v2/turn.ts`                             | 删 `resolveScheduleV2` 全模板扫描；管线步骤 3 改 drain；`enqueuePendingEvent` 保留（槽位呈现队列）；pool 改门控入队 + combat 防御；`onCooldown` 改时间维度；**`chooseOptionV2` 结算推进 `turnIndex` + `timeCost`**（§3.2）、战斗结束推进、用物品不推进                                                                                                  | R2.5                                                  |
| `packages/game-core/src/v2/engine.ts`                           | `EffectSchema` 消费：+`enqueueEvent`；`advanceChain` 写入口收口；+`setNpcLifecycle`（R2.6）                                                                                                                                                                                                                           | R2.5/R2.6                                             |
| `packages/game-core/src/v2/opening.ts`                          | `handoff` schedule 改真正入队；删 `openingScheduled` flags                                                                                                                                                                                                                                                       | R2.5                                                  |
| `packages/game-core/src/v2/npc.ts`                              | 判活过滤；冷却迁移（R2.6）                                                                                                                                                                                                                                                                                           | R2.6                                                  |
| `packages/game-core/src/v2/projection.ts`                       | `projectNpc()`（R2.6）；npcs 投影增 lifecycle 标注                                                                                                                                                                                                                                                                | R2.6                                                  |
| `packages/game-core/src/v2/time.ts`                             | `CalendarAdapter` 增 `toMinutes(amount, from)`/`ageAt`/`parseTimeSpec`/`format`；模板 `calendar.preset`/`era` 声明位；`worldTime` int 校验（**本轮无数值上界校验**，#45，见 §3.5）；②③ 历法实现顺延下一期（#39/#43）                                                                                                                                                                      | R2.5（接口）/R2.6（实现①）                                    |
| `packages/game-core/src/v2/relations.ts`（新）                     | 亲属/师承图推导 + 环检测 + 断代 gap 标记；**多跳中文称谓经 `relationship.js`（MIT/离线/确定性）纯函数适配层**，师承称谓走模板 `titleRules`；引入依赖前走 ADR                                                                                                                                                                                   | R2.6                                                  |
| `package.json`（game-core）                                      | 锁版本引入 `relationship.js` + `@types/relationship.js`（ADR 通过后）                                                                                                                                                                                                                                          | R2.6                                                  |
| `packages/shared/src/schema/character.ts`                       | +lifecycle/birthTime/parents/masterId/projection 配置（R2.6）                                                                                                                                                                                                                                                 | R2.6                                                  |
| `specs/data/templates/jjk-2006/events.yaml` / `characters.yaml` | 触发字段迁移 + 投影声明                                                                                                                                                                                                                                                                                             | R2.5/R2.6                                             |
| `apps/server`、`apps/web`                                        | 存档信封 version 2；快照字段展示                                                                                                                                                                                                                                                                                     | R2.5/R2.6                                             |
| 相关测试（v2.test.ts、ending-*.test.ts 等）                             | RNG 序列变化重录基线；`atTurn` 退役迁移（v2.test.ts:737/768）、`nextTurn` 去留所依（v2.test.ts:711/786，随 Q-R25-06）、`cooldownTurns` 换形；新增 scheduler/relations 单测                                                                                                                                                                | R2.5/R2.6                                             |

---

## §7 待决问题（不自行拍板）

| 编号       | 问题                                                                    | 可选方案                                                                                                                                                                                            | 推荐                    | 影响面                                                                             |
| -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| Q-R25-01 | ~~`action-hook` 是否改名~~ | **【已裁决关闭 2026-11-12】保留 `action-hook` 不改名**；且它既可立即也可延时，立即/延时由是否声明 `window/delay` 决定（§3.1）。`action_trigger` 一词不再进协议 | — | 无改动（模板/协议/夹具零迁移） |
| Q-R25-02 | ~~pool `delay` 缺省值~~ | **【已裁决关闭 2026-11-12】缺省相对 0 分钟**（OQ-#38 同案）：抽中即入队、下一次 drain 到期触发；「入池没有时间窗口」按此处理 | — | scheduler、event.ts |
| Q-R25-03 | ~~drain 判定失败处置~~ | **【已裁决关闭 2026-11-12】门控前置**（once/概率在入队时决定，失败不记错失）；出队仅 missWhen 丢弃、条件/冷却 hold、window 到期丢弃；`MissReason` = `window_expired \| miss_when`。**【第二批 #36 裁决：留在队列】** 窗口内 conditions/cooldown 不满足一律 hold 留队、每轮重估、不记错失；仅 `worldTime > window.end` 才出队记 `window_expired`；无 `window.end` 由 `missWhen` 兜底；门控失败不构成错失 | — | scheduler、missedEvents 语义 |
| Q-R25-04 | `cooldownTurns` 退役范围                                                  | A 仅事件触发冷却改时间维度，NPC 行动/技能冷却 R2.6 再议〔推荐〕／B 本轮全改                                                                                                                                                   | A                     | event.ts、npc.ts                                                                 |
| Q-R25-05 | 时间模型默认与实现范围（含「为何只做公历」「洪荒几亿年精度」） | A 本轮只实现①近似标量、接口预留②③、模板声明位就绪〔推荐〕／B 本轮实现②公历／C ③自定义历+年号（引 lunar-javascript） | A；接口形状已定稿（§3.5，#39 枚举 ①②③）。**【2026-11-12 第二批裁决 #39/#43/#44/#45：继续延期，下期首办】** 本轮只实现 ①、`TimeSpec` 只实现 `TimeAmount`、无数值上界校验与年号渲染；②③ 历法/字符串字面量/上界校验随下一期（R2.6）首批解决 | time.ts、world.yaml |
| Q-R25-06 | `advanceWhen: nextTurn` 是否随 `atTurn` 一并退役                             | A 保留（「下一轮」是槽位语义非时间量）〔推荐〕／B 退役（链步骤全走 onSettle+delay）                                                                                                                                             | A                     | ChainStepSchema                                                                 |
| Q-R25-07 | 角色 `visibility: public\|hidden` 静态开关去留；「绕过判活」是否提供模板一等开关               | **【2026-11-12 第二批裁决 #41：已裁决（合并）】** `visibility` 并入 `projectNpc()` 单一判定入口，**A 案「保留 visibility 做 AND 闸」作废**（合并 ≠ 简单 AND 两套并存）；`R-VS-03`/`isPlayerVisible()` 口径不变；「绕过判活」一等开关维持开放（未在第二批裁决）                                                                                                           | 已裁决（合并）                     | character.ts、projection.ts                                                      |
| Q-R25-08 | 玩家是否与 NPC 统一 birthTime 派生年龄（退役 `playerAgeAtStart + elapsedYears`）     | A 统一〔推荐〕／B 玩家保留现状                                                                                                                                                                               | A                     | v2.ts、turn.ts:565、engine.ts:361                                                 |
| Q-R25-09 | 旧存档策略                                                                 | A schemaVersion 2 + 拒载〔推荐〕／B 自动迁移                                                                                                                                                               | A                     | v2-state.ts、server/store                                                        |
| Q-R25-10 | inactive NPC 的 affinity/关系是否冻结                                        | A 冻结写入口（③ 默认判活的一部分）〔推荐〕／B 照写（死后关系仍可变）                                                                                                                                                           | A                     | engine.ts、relations                                                             |

> **第二批裁决（2026-11-12）对 §7 的影响**：Q-R25-05（#39/#43/#44/#45）标注「**下期首办**」；Q-R25-07（#41）已裁决合并、A 案作废；Q-R25-03（#36）已裁决「留在队列」；Q-R25-01/02 维持第一批关闭状态。#35 的加载期强制、#46 的「不做」分别落在 §3.2 / §2（不在本表 Q-R25 编号内）。本轮 R2.5 从 `T1-01` 起施工，R2.6/NPC 为下一期；三篇 ADR 状态「已通过（2026-11-12 G1 评审）」。

---

## §8 分阶段实施建议

**R2.5：事件的实例化与延时队列**（本轮交付范围）

| 顺序 | 动作                                                                                                                                | 产出                  | 前置依赖                           |
| -- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------ |
| 1  | ADR-0010/0011/0012 **已通过（2026-11-12 G1 评审）**，评审修订与第二批裁决已并入正文                                                                                                    | `docs/DECISIONS.md` | G1/G2 已过（用户「其余默认通过」+ 第二批裁决） |
| 2  | shared schema：`TimeSpec`、`EventTriggerSchema` 迁移表、`ScheduledEventInstance`（扩展 event-instance.ts）、`WorldStateV2` 新字段 + v2-state.ts | schema 层            | 1                              |
| 3  | `v2/scheduler.ts`：cmp/排序/enqueueCandidate（门控）/enqueue/drain/evaluateDue/evaluateChain 纯函数 + 单测（到期/过期/门控不记错失/missWhen/条件 hold/冷却 hold/RNG 序断言） | 调度器                 | 2                              |
| 4  | turn.ts 接线：删 `resolveScheduleV2` 扫描、步骤 3 改 drain、pool 改入队、opening.handoff 真入队、删冗余 flags                                           | 管线                  | 3                              |
| 5  | jjk-2006 events.yaml 迁移 + 测试基线重录 + 全量回归                                                                                           | 模板与测试               | 4                              |
| 6  | server 存档 schemaVersion 2                                                                                                         | 持久化                 | 2                              |

**R2.6：NPC 生命周期与关系**（下一轮）

| 顺序 | 动作                                                                                                                  | 前置依赖                      |
| -- | ------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1  | `character.ts` + `V2Npc`：lifecycle/birthTime/parents/masterId/infoVisibility + `setNpcLifecycle` 效果 + `npcState` 条件 | R2.5 全部；Q-R25-07/08/10 裁决 |
| 2  | 默认判活四处接线（npc.ts/battle.ts/engine.ts）                                                                                | 1                         |
| 3  | `projectNpc()` + projection 配置 + jjk-2006 characters.yaml（含「开局已死亡的重要角色」样例）                                          | 1                         |
| 4  | `time.ts` CalendarAdapter 接口落地 + ageAt（近似历法实现①）                                                                     | Q-R25-05 裁决               |
| 5  | `relations.ts` 推导 + 环检测 + relationLog + relationSource flags 迁移                                                     | 1                         |
| 6  | NPC 行动冷却迁移时间维度（Q-R25-04 B 案若选）                                                                                      | 1                         |

**不做什么（本轮明确边界）**：真实历法/农历/年号的**实现**（接口形状本轮定死、保持预留；数值上界校验与年号渲染顺延下一期，#39/#43/#44/#45）、运行时生成配置层模板（#46 已裁决「不做」）、通用关系 yaml 模板机制（用户自述后续自做）、NPC 物品逻辑、时间穿越（R3/ADR-0005）、六阶段 Lifecycle（ADR-0004 禁令）。**注**：多跳中文亲属称谓已从「不做」移出，R2.6 经 `relationship.js` 适配层交付（§4.5）；本批 R2.5 从 `T1-01` 起施工，R2.6/NPC（`T2-*`）为下一期。
