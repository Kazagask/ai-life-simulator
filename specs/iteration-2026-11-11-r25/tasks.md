# R2.5 任务分解

> **状态：施工中，`T1-01` 起**（按 G3 单任务推进）。G1 规格评审 **2026-11-12 已通过**（用户「其余默认通过」）、G2 已过；**2026-11-12 第二批裁决已回填**（`#35`/`#36`/`#41`/`#46` 关闭，`#39`/`#43`/`#44`/`#45` 顺延下一期 R2.6 首批），本轮进入实施，范围为 **R2.5 事件模型（`T1-01`..`T1-09`）**，R2.6/NPC（`T2-*`）为下一期。详见 §0 裁决回填表。
>
> **`#34` / `#37` / `#38` / `#40` / `#42`（第一批）与 `#35` / `#36` / `#41` / `#46`（第二批）已裁决关闭**；`#39` / `#43` / `#44` / `#45` **继续延期、下一期（R2.6）首批解决**。`action-hook` 保留旧名、`TimeSpec` 取代 `TimeExpr`、结算推进轮次 + `timeCost`、pool 门控、combat 不入池、错失原因收缩、谱系库分层复用均已写进 `design.md` / `requirements.md`；ADR-0010/0011/0012 状态已改「已通过（2026-11-12 G1 评审）」。
>
> **例外：T0-10（槽位事件区 UI）已按用户 2026-11-11 指示提前实施并提交**——纯前端呈现改动，不动引擎/数据模型，覆盖 `R-EV-11` 呈现部分；其「记账部分」仍归 `T1-07`。

## 0. 裁决回填表（已回填，2026-11-12 第一批 + 第二批裁决）

> 第一批（G1 评审）已关闭 `#34`/`#37`/`#38`/`#40`/`#42`；**第二批 8 项全部回填完毕**：`#35`/`#36`/`#41`/`#46` 关闭，`#39`/`#43`/`#44`/`#45` 延期（保留开放、下一期 R2.6 首批），均写清回填落点。ADR-0010/0011/0012 状态「已通过（2026-11-12 G1 评审）」。

| 待决 | 影响任务 | 裁决 | 回填后要改的地方 / 落点 |
|---|---|---|---|
| `#34` 立即事件呈现时点（下一轮 vs 当前轮） | `T1-07` | **已裁决 2026-11-12**：事件结算推进轮次（占槽）+ `timeCost` 缺省 0 + 战斗结束算/用物品不算 + 事件轮跑完整管线 + 多事件逐轮呈现 | `chooseOptionV2` 加 `turnIndex += 1` 与 timeCost；`pending_event_required` 反转；前端零改动 |
| `#35` 协议层「仅一个」强制方式 | `T1-01`、`T1-07` | **已裁决 2026-11-12（第二批）：关闭，采用候选①「加载期静态拒绝」（`superRefine`）** + 延时豁免——只按 `onActionId` 分组统计「未声明 `window`/`delay` 的立即 `action-hook`」，同组 ≥2 条才报错；声明 `window`/`delay` 的 `action-hook`、chain 延时步、schedule、pool 不受约束；错误信息提示「可为后续 hook 声明 window/delay 转为延时」 | `T1-01` DoD 增三组加载期用例；`T1-07` 槽位守卫；R-EV-03 / ADR-0011 决策 5 / `design.md` §3.2、§0.3/#1 / `OPEN_QUESTIONS.md` #35 / DECISIONS.md 第二类回填 |
| `#36` 窗口到期未触发处置 | `T1-03` | **已裁决 2026-11-12（第二批）：关闭，采用候选②「留在队列」**——窗口内 `conditions`/`cooldown` 不满足一律 hold 留队、每轮 drain 重估、不记错失；仅 `worldTime > window.end` 才出队并追加 `reason="window_expired"`；无 `window.end` 永不因时间过期，由显式 `missWhen` 兜底（R-EV-12/#42）；门控失败不构成错失 | `T1-03` DoD 补 hold 口径 / `evaluateDue` 的 hold、expire 分支与 `missedEvents` 写入时机；R-EV-07 / ADR-0011 决策 3 / `design.md` §3.4 判定表、§0.3/#2 / `OPEN_QUESTIONS.md` #36 |
| `#37` 相对时间基准 | `T1-01`、`T1-03` | **已裁决 2026-11-12**：`TimeSpec` 单一形态、默认相对入队时刻、兼容时间格式（字面量语法见 #44，第二批定为「方向定 A、实现延期」） | `TimeExpr` 二分支删除；`resolveTimeSpec`；**字符串加载期解析顺延下一期**（见 #44） |
| `#38` pool 无窗口 + 门控 | `T1-01`、`T1-05` | **已裁决 2026-11-12**：六策略门控决定是否入池；无窗口默认相对 0 分钟；combat 不入池 | `enqueueCandidate` 门控；`world.ts` superRefine 拒绝 pool+combat；`MissReason` 收缩 |
| `#39` 三种时间模型枚举 | `T2-04` | **已裁决 2026-11-12（第二批）：继续延期，下一期（R2.6）首批解决；不写成已关闭**——本轮 R2.5 不实现 ②真实公历/③自定义历+年号，`CalendarAdapter` 接口形状保持预留；保留原有候选与推荐描述 | `design.md` §3.5 / §4.4 / §7（Q-R25-05 标注「下期首办」）、§0.3/#3；`requirements.md` R-NP-04 / `OPEN_QUESTIONS.md` #39 / ADR-0012 决策 4 / DECISIONS.md 第二类回填 |
| `#40` 谱系库选型 | `T2-05` | **已裁决 2026-11-12**：分层复用 `relationship.js`（MIT/离线/确定性）+ 自研图内核 | 新增依赖前走 ADR；`relations.ts` 拆图内核与称谓适配层 |
| `#41` visibility 与投影原则合并 | `T2-03` | **已裁决 2026-11-12（第二批）：关闭，采用候选①「合并」**——`visibility` 并入 `projectNpc()` 单一判定入口，不再与动态已知标记各设一套判定；`R-VS-03`/`isPlayerVisible()` 口径不变；ADR-0012 决策 3 与 Q-R25-07 的 A 案按此改写（合并 ≠ 简单 AND 两套并存） | `T2-03` DoD / `design.md` §4.3、§7（Q-R25-07）、§0.3/#4 / `requirements.md` R-NP-01 / ADR-0012 决策 3 / `OPEN_QUESTIONS.md` #41 / DECISIONS.md 第二类回填 |
| `#42` 错失求值时点 | `T1-02`、`T1-03` | **按推荐 ① 通过**（到期出队时判定，用户默认通过） | `missedEvents` 记录 `turnIndex/worldTime` = 判定时刻；`evaluateDue` 序 1 = missWhen |
| `#43` 历法 ②③ 实现排期 | `T2-04` | **已裁决 2026-11-12（第二批）：继续延期，下一期（R2.6）首批解决；不写成已关闭**（接口形状本轮定死、保持预留；与 #39 同案） | `design.md` §3.5 / §7（Q-R25-05「下期首办」）、§0.3/#3 / `T2-04` / `OPEN_QUESTIONS.md` #43 / DECISIONS.md 第二类回填 |
| `#44` TimeSpec 字符串语法 | `T1-01` | **已裁决 2026-11-12（第二批）：方向定 A、实现延期；不写成已关闭**——「符合事件+字面量」按「**复合时长 + 字面量**」解读（候选 A：`3d`/`2h30m` + 历法日期字符串字面量，注明是对原文的解读）；实现与 #39/#43 一并排下一期；本轮 `TimeSpec` 只实现 `TimeAmount {value, unit}`，字符串语法只留 `CalendarAdapter.parseTimeSpec` seam、**不做加载期解析** | `T1-01` 内容/DoD / `design.md` §3.1、§3.5、§0.3/#5 / `test-design.md` 第 13 项 / `OPEN_QUESTIONS.md` #44 / DECISIONS.md 第二类回填 |
| `#45` 世界时间上界 | `T1-02` | **已裁决 2026-11-12（第二批）：保持现状、下期决策；不写成已关闭**——本轮不加 `MAX_WORLD_TIME = 2^52` 上界拒载、不加 `{epochIndex, minuteInEpoch}` 双字段/BigInt，`worldTime` 维持现状（number 分钟）；`R-LM-05` 验收收缩为「整数分钟 + `hasEnd` 无数值哨兵」；上界校验与年号/纪元渲染随 #39/#43 下一期一并验收 | `T1-02` DoD 删「上界」 / `requirements.md` R-LM-05 验收段 / `design.md` §3.5、§6、§0.3/#6 / `test-design.md` 第 14 项 / `OPEN_QUESTIONS.md` #45 / DECISIONS.md 第二类回填 |
| `#46` 运行时生成配置层定义 | `T1-02` | **已裁决 2026-11-12（第二批）：关闭，用户明确「不做」**——运行时按 seed 生成配置层模板定义的能力不实现；R-LM-04 常规路径（规则写 yaml → 世界初始化实例化 `SpawnRuleInstance` → 效果 `spawnNpc(ruleId)` 建 NPC 实例）保留，归 R2.6 | ADR-0010 决策 4 / `design.md` §2、§0.3/#7 / `requirements.md` R-LM-04 / `OPEN_QUESTIONS.md` #46 / DECISIONS.md 第二类回填 |

## 0.1 已提前实施（用户指示，例外放行）

| 任务 | 内容 | 覆盖需求 | 状态 |
|---|---|---|---|
| `T0-10` | **槽位事件区 + 圆形转盘**：LifeTab 重构为统一「事件区」容器（槽位可视化），占位者优先级 转盘 > 战斗 > 待决事件 > 自由行动；`WheelReveal` 圆形转盘（SVG 扇区按权重等比、朱金配色、指针固定 12 点、2.6s 缓动落定、prefers-reduced-motion 直出结果）；「本轮还发生」底栏去重（排除待决事件与转盘事件） | R-EV-11（呈现部分） | ✅ 已提交（本迭代） |

## 1. R2.5 · 事件模型（先做）

| 任务 | 内容 | 覆盖需求 | 依赖 | 完成定义（DoD） |
|---|---|---|---|---|
| `T1-01` | **模板契约收敛**：**`action-hook` 保留旧名**（不改名，Q-R25-01 关闭）；删 `atTurn`（加载期报错并提示替代写法）；`cooldownTurns`→`cooldown: TimeSpec`；新增单一 `TimeSpec`（**本轮只实现 `TimeAmount {value, unit}`**；字符串格式只留 `CalendarAdapter.parseTimeSpec` seam、不做加载期解析，#44）与 `window{start,end?}`、`timeCost`、`delay`、`missWhen/missLabel`、`ChainStep.delay`；`superRefine` 拒绝 `source: pool` + `kind: combat`，并**按 #35 拒绝同 `onActionId` ≥2 条「未声明 `window/delay` 的立即 `action-hook`」（延时事件豁免、错误提示可声明 window/delay 转为延时）**；`EventInstanceSchema` 统一为运行时实例 | R-EV-02/03/04/09/13/14、R-LM-05 | 无 | 含 `atTurn` / `cooldownTurns` / pool+combat 的模板加载报错且给出替代写法；新字段 strict 校验；`action-hook` 声明 `window` 可产生延时实例；**#35 三组加载期用例：① 同一 `onActionId` 挂 1 条立即 + N 条声明 `window/delay` 的延时 `action-hook` → 加载合法；② 同一 `onActionId` 挂 2 条均未声明 `window/delay` 的立即 `action-hook` → 加载报错且提示「可为后续 hook 声明 window/delay 转为延时」；③ 同一 `onActionId` 全为延时 `action-hook` → 加载合法**（chain 延时步/schedule/pool 不受约束）；字符串格式本轮不做加载期解析；`pnpm typecheck` 0 |
| `T1-02` | **实例层 + 事实层落状态**：`WorldStateV2` 增 `scheduledEvents[]`（含 `hasEnd`、**无 snapshot**、不复制配置字段）/ `enqueueSeqCounter` / `missedEvents[]`（reason 仅 `window_expired|miss_when`，含 label）/ `eventFires[]` / `lastFiredIndex`；`worldTime` int、`TimeAmount` int（R-LM-05 收缩口径：整数分钟 + `hasEnd` 无数值哨兵；**本轮无数值上界校验**，#45）；`WorldStateV2Schema` 同步；`schemaVersion` 1→2；旧档拒载 | R-LM-01/03/05、R-EV-15 | `T1-01` | 落盘→读回逐字段相等；旧 `schemaVersion=1` 被拒且错误可诊断；`eventFires`/`missedEvents` append-only（测试断言）；实例/存档中六字段零副本（静态扫描）；**本轮不验收 `MAX_WORLD_TIME` 上界拒载/年号渲染（#45 顺延下一期）** |
| `T1-03` | **调度器**：新建 `v2/scheduler.ts` — `enqueueCandidate()`（入队门控：once/probability + pool 的 conditions/weight/priority，门控失败不产生实例/不记错失）、`enqueueScheduled()`（TimeSpec 换算固化窗口、分配 `enqueueSeq`）、`drainScheduledEvents()`（循环取队首、`start > now` 即停）、`evaluateDue()` 纯函数（missWhen→conditions 终判→cooldown→fire，固定顺序）；三个 drain 入口接线 | R-EV-05/06/07/12/15 | `T1-02` | 三键排序用例（start / `hasEnd` / 入队序）；出队时条件终判用例；同输入两次运行出队序列一致；RNG 消耗顺序写进注释；错失用例——missWhen 命中即出队且 `missedEvents` 落 `reason="miss_when"`（含 label）、无 `window.end` 不再僵尸留队；门控失败零错失记录；**#36 hold 口径用例——窗口内 `conditions`/`cooldown` 不满足一律 hold 留队、每轮 drain 重估且 `missedEvents` 零新增；仅 `worldTime > window.end` 才出队并追加 `reason="window_expired"`；无 `window.end` 永不因时间过期（由 `missWhen` 兜底）；门控失败不构成错失** |
| `T1-04` | **删除全模板扫描**：删 `resolveScheduleV2`；`createWorldV2` 初始化即入队全部 `schedule` 事件；`opening.handoff()` 真正入队并删除 `flags["openingScheduled:*"]`；`turnsPlayed` flag 删除（≡ `turnIndex`） | R-EV-08、R-LM-02 | `T1-03` | 创建世界后 `scheduledEvents` 含全部 schedule 事件；`turn.ts` 无 `template.events` 遍历（除入队与 pool 抽取）；`openingScheduled:*` 与 `turnsPlayed` 全仓库零命中 |
| `T1-05` | **pool 门控与战斗解耦**：抽中前按六策略过滤（现状 `turn.ts:329-352` 已有），门控通过→`enqueueCandidate`（`delay` 缺省相对 0 分钟）；保留最后触发的管线位次；加载期/抽取期拒绝 `kind: combat` 入池；combat 改由 normal/random 事件的链立即步触发 | R-EV-08/13 | `T1-03` | pool 抽中不产生 `pendingEvents` 条目；抽中实例可被 drain 取出；pool 的 once/概率不重复扣减；无窗口实例 `window.start = now` 且下次 drain 触发；pool+combat 模板加载报错 |
| `T1-06` | **链与断链**：`evaluateChain()` 纯函数（active 的充分条件含「队列仍有该链未触发实例」）；`ChainStateV2.stepIndex` 改为派生或标注缓存；`advanceChain` 效果（`engine.ts:370-375` 盲目 `+1`）收口到单一推进规则；`advanceWhen` 去留按 `Q-R25-06` | R-EV-10 | `T1-03` | 链步为延时事件时不断链；队列空且无后续步才判完成；同一链不会出现 `stepIndex` 双写漂移（用例覆盖 `advanceChain` 与 settle 同时发生） |
| `T1-07` | **槽位守卫与结算轮（#34 裁决）**：`chooseOptionV2`/转盘确认后 `turnIndex += 1` + `worldTime += timeCost`（缺省 0）；战斗结束算结算轮、用物品不算；事件轮跑完整管线；同窗多事件逐轮呈现；按 `#35` 实现「仅能有一个」强制；`pending_event_required` 语义反转 | R-EV-01/02/03/11/14 | `T1-01`、`#35`（已裁决） | 槽位不变量用例（任一轮至多一个事件或一次行动）；结算后 `turnIndex` +1 且拒绝自由行动；timeCost 0 时 `worldTime` 不变、非 0 时按分钟推进；战斗结束/用物品分别断言；随机事件占其触发轮槽位；combat 为该轮槽位内容 |
| `T1-08` | **模板与夹具迁移**：`jjk-2006/events.yaml`（1 schedule、5 pool 无需写 delay、1 `action-hook` **保留旧名**、~20 chain）补 `timeCost` 缺省；`opens`/测试夹具中的 `atTurn`（`v2.test.ts:737/768`）改 `TimeSpec`、`advanceWhen`（`:711/:786`）；指纹重算 | R-EV-09 | `T1-01`…`T1-07` | 模板加载通过；旧回放断言按新 RNG 序列重录并注明「序列变更」；无模板残留旧字段；`action-hook` 全仓库仍为唯一触发源词 |
| `T1-09` | **协议与验收**：`TEMPLATE_PROTOCOL_V2.md` §8（触发）/§12（条件）/新增调度章节；`tasks/reports/R25-COMPLETION.md` | 全部 EV | `T1-08` | 协议与实现逐字段一致；报告含命令输出与端到端证据（curl：到点触发 / 错失 / 断链不误判） |

**R2.5 完成判据**：27 条 ACTIVE 中 `R-LM-01..05` + `R-EV-01..15` 全部满足验收（NPC 组 7 条归 R2.6）；**其中 `R-LM-05` 按 #45 收缩后口径验收（整数分钟 + `hasEnd` 无数值哨兵，本轮不验收数值上界/年号渲染，顺延下一期）**；`pnpm typecheck` 0；game-core 测试全绿；web 构建通过。

## 2. R2.6 · NPC 系统（后做）

| 任务 | 内容 | 覆盖需求 | 依赖 | 完成定义（DoD） |
|---|---|---|---|---|
| `T2-01` | **NPC schema 扩展**：`V2Npc.lifecycle {state, reasonCode?, sinceTurn, sinceWorldTime}`；`birthTime` 取代静态 `age`（`V2CombatantBase.age` 的处理按设计 §4.4）；`parents[]`/`masterId`/`affinity`（`relationship` 改名）；`projection` 模板配置；`infoVisibility`/`relationSource` 从 `flags` 迁入实例 | R-NP-02/04/05、R-LM-02 | `T1-02` | 旧字段不再写 `flags`（`opening.ts:150-160` 迁移）；schema strict 校验；存档往返一致 |
| `T2-02` | **默认判活四处**：NPC 行动循环、战斗建场 ref（`enemies`/`allies`）、关系/好感写入冻结、行动候选过滤；`unspawned` 不参与任何一处 | R-NP-02/03 | `T2-01` | 四处各有「inactive 被跳过」用例；模板零书写 `alive` 条件；`reasonCode` 在引擎中零分支（静态扫描断言） |
| `T2-03` | **投影解耦（#41 已合并）**：`projectNpc()` 只读 public 字段 + `infoVisibility` + 模板 `projection`；`inactive` 照常上屏（`age` 冻结、状态标注由模板 label 映射）；**`visibility: public\|hidden` 按 #41 合并入 `projectNpc()` 单一判定入口（Q-R25-07 的 A 案「保留静态闸 + AND 组合」作废），不再与动态已知标记各设一套判定；`R-VS-03`/`isPlayerVisible()` 历史可见性口径不变** | R-NP-01 | `T2-01`、`#41`（已裁决） | 「开局即 dead 的重要角色」上屏用例；alive/dead 投影可见性判定结果一致（不读生命周期）；**合并单一入口用例（不存在两套并行判定）**；前端 `NpcCard` 零改动或仅加状态标注 |
| `T2-04` | **动态年龄 + 历法接口**：`CalendarAdapter` 增 `toMinutes` / `ageAt` / `parseTimeSpec` / `format`；**本轮只实现 ①近似标量，`TimeSpec` 只实现 `TimeAmount`（字符串语法只留 `parseTimeSpec` seam、不做加载期解析，#44）；本轮无世界时间数值上界校验（#45）**；`birthTime`（可为负）；**#39/#43/#44 下期首办**：②真实公历/③自定义历+年号、`calendar.preset`+`era` 年号渲染、字符串字面量、上界校验随下一期 R2.6 首批一并实现/验收，`CalendarAdapter` 接口形状保持预留；玩家侧按 `Q-R25-08` 决定是否同步 | R-NP-04、R-LM-05 | `T2-01`、`#43`（已裁决：延期，下一期首办） | 世界时间推进后 NPC 年龄增长且可回放；投影 `age` 形状不变（`projection.ts:100/141`）；战斗镜像保留建场快照；**洪荒尺度年号渲染/世界时间上界校验顺延下一期 R2.6，本轮不验收** |
| `T2-05` | **关系推导（分层复用）**：`v2/relations.ts` 自研图内核 — `parents[]`/`masterId` 推导 child/sibling/apprentice/同门、倒排索引 O(N+E)、上溯辈分、环检测、`ancestorGaps` 断代标记（gap + 粗称谓，不猜代数）；**多跳中文称谓经 `relationship.js`（MIT/离线/确定性）适配层**（引入前走 ADR），师承称谓走模板 `titleRules`；`relationLog` 只追加 | R-NP-06/08 | `T2-01`、ADR | 双亲/师父推导、环检测拒绝非法写入、断代不编造代数、多跳称谓正确、同输入同输出（确定性）；库不可用时退化为结构边 + 标签 |
| `T2-06` | **效果与条件 DSL**：新增 `setNpcLifecycle`、`enqueueEvent`、条件 `{ npcState: { npcId, state } }`；白名单校验；模板示例 | R-NP-03、R-EV-08 | `T1-01`、`T2-01` | 「失联事件 → inactive(missing)」端到端；非法 state 加载期拒绝 |
| `T2-07` | **模板迁移**：`jjk-2006/characters.yaml`（age→birthTime、parents/masterId、visibility→projection）；协议 §7/§12/§19/§20 | R-NP-01..06 | `T2-01`…`T2-06` | 模板加载通过；`npcSetup.relations` 的 `source` 迁到关系边 |
| `T2-08` | **验收**：`tasks/reports/R26-COMPLETION.md` | 全部 NP | `T2-07` | 6 条 `R-NP` 逐条举证；typecheck 0；测试全绿 |

## 3. 执行纪律

- **G3 单任务**：一次只做一个 `T`，按表内顺序；前置未完成不得开工。
- **G4 单写者**：`T1-*` 与 `T2-*` 不并行写 `packages/`；`T2-06` 触及 `common.ts` 时须在 `T1` 全部提交后再派。
- **G5**：`R-NP-07`（通用 yaml 关系机制）不在任务表内，只留 `custom` 类型位。
- **确定性**：`T1-03` / `T1-05` / `T2-02` 都会改变 RNG 消耗顺序，提交信息必须写明「同 seed 序列变更」，并同步重录回放断言。
