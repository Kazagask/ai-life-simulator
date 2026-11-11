# R2.5 设计文档：配置/实例/事实三层分离 · 事件触发收敛 · NPC 生命周期与关系

状态：草案（待用户与主控评审）
范围：**只出规格，不改实现代码**。实施拆分为 R2.5（事件实例化与延时队列）与 R2.6（NPC 生命周期与关系），见 §8。
上游依据：用户原始诉求（2026-11-11）、`AGENTS.md` §1/§2/§3/§5、`docs/ARCHITECTURE.md`、ADR-0001~0009、`packages/shared/src/schema/`、`packages/game-core/src/v2/`。
基线：R2.4b（7912493），typecheck 0 错误，245 tests 绿。

---

## §0 结论摘要

1. **判定：本次变更属于「核心数据模型」类**（`WorldStateV2` 新增调度/事实结构、`V2Npc` 增生命周期与出生时间、`EventTriggerSchema` 字段语义修订），按 AGENTS.md §0 必须先出 ADR。本设计配套 **ADR-0010（三层分离）、ADR-0011（事件触发收敛 + 时间窗口队列）、ADR-0012（NPC 生命周期与投影解耦）**，均已落 `docs/DECISIONS.md`。
2. **三层模型是本轮的裁判标准**：配置层（模板 YAML，只读）→ 实例层（本局对象，有 id/status/可序列化）→ 事实层（只追加记录，只可查询）。现存十一处混杂（§1 M1-M11）中，最危险的是「模板事件被当调度器扫描」与「flags 被当系统表用」——前者让调度无实例可回溯（堵死 R3 穿越回拨），后者让模板条件能读引擎内部记录。
3. **事件触发收敛为立即/延时两类**：`action_trigger` + `chain` 立即结算不入队；`schedule` 世界初始化即入时间窗口队列；`pool` 降格为抽取器（抽中后只能入队）。`atTurn`（x 轮后）与 `cooldownTurns`（轮次冷却）退役为时间窗表达。`resolveScheduleV2` 的每轮全模板扫描被 `drainScheduledEvents()` 的「有序队列 + 出队判定」取代。
4. **NPC 引入引擎无关的生命周期**：`alive | inactive(reasonCode) | unspawned`，引擎只判 `alive`，`reasonCode` 是模板自由语义（dead/missing/sealed…），**引擎不得对 reasonCode 分支**。投影与生命周期解耦：判活决定「行动/参战/关系变更」四处的默认过滤，`projectNpc()` 决定「是否上屏」，死亡角色可依模板配置继续上屏。
5. **确定性告警**：新 drain 判定链的 RNG 消耗顺序与旧 `resolveScheduleV2`/`resolvePoolV2` 不同，**同 seed 下事件结果序列会改变**（§3.4.5 显式声明）；这不破坏「同 seed 同输入同结果」的可复现性（新代码仍是确定性的），但旧回放断言与旧存档不可复用，随 schemaVersion 升级一并处理（§5）。
6. **命名裁决（推荐，待用户确认 = Q-R25-01）**：`action-hook` → **`action_trigger`**（对齐用户词汇）。理由：本次 strict schema 变更本就要求全模板迁移（指纹窗口），改名边际成本最低（jjk-2006 仅 1 处 + 协议 §8/§12 + v2.test.ts 少量夹具）；不改名则用户词汇与协议词汇永久分叉，后续沟通持续折价。

### §0.1 不变量检查表

| 不变量 | 现状 | 本改动影响 | 保护措施 |
|---|---|---|---|
| 同 seed 同输入同结果 | 成立（注入 RNG，`deriveTurnSeed`） | drain/pool 的 RNG 调用序列改变 → 同 seed 事件序列与旧版不同 | 新旧行为不一致**只在 schemaVersion 升级边界发生一次**；R2.5 测试重录基线；RNG 消耗顺序在 §3.4.5 固化为规范 |
| hidden 不进入玩家端 API | 成立（`projectSnapshotV2` + R-VS-01） | 新增 `missedEvents`/关系记录均为事实层，默认不投影 | 投影白名单制：事实层字段进入 `V2Snapshot` 须逐字段评审；错失事件只发 `eventId`+标题（无 hidden 语义，OPEN_QUESTIONS #33） |
| 世界观规则只进模板 | 成立（声明式 DSL） | 亲属/师承**推导逻辑**进引擎（图查询），**关系语义**（谁是父子）进模板/实例 | 推导是纯结构算法（上溯/拼接），不含世界观语义；reasonCode 命名与含义完全由模板定 |
| 时间/随机/ID 可注入 | 成立（RunnerContext） | `enqueueSeq` 计数器进状态（不用 Date/随机）；`window.start` 一律 `worldTime` 换算 | `enqueueSeqCounter` 为纯状态递增；TimeExpr→分钟换算经 CalendarAdapter（可注入历法） |
| R3 穿越 seam 未被封死 | seam 已预留（实例-定义分离/TimeAdapter/visibility） | **强化**：调度从「模板扫描」变为「实例队列」，时间回拨只需对实例重算到期 | 队列实例保留 `origin` 与入队参数快照；排序键只用 `worldTime` 不用 `Date`；不写死时间单调假设（drain 以 `>=`/`<=` 比较而非增量） |
| 不新增 Lifecycle 状态机 | ADR-0004 已禁 | NPC `lifecycle.state` 是**角色级三态**，非阶段编排；不新建 `lifecycle.ts` 模块 | NPC 生命周期字段并入 `shared/src/schema/character.ts` 同域；boundary.test.ts 的静态禁令继续生效 |

---

## §1 现状盘点：配置/实例/事实三层混杂清单

「配置 = 模板（只读）；实例 = 本局对象（有 id、有状态、可序列化）；事实 = 只追加记录」。逐条列出混杂点（位置 → 混了什么 → 后果）。**以当前代码为准**（R2.4b，7912493），已逐文件核对。

| # | 位置 | 混了什么 | 后果 |
|---|---|---|---|
| M1 | `packages/game-core/src/v2/turn.ts:374-383`（`resolveScheduleV2`） | **配置被当调度器**：每轮遍历 `template.events`，命中 `atTurn === turnIndex` 或 `worldTime >= atWorldTime` 就触发。没有实例层——「某个 schedule 事件已入队/已过期/已错失」在状态里不可见 | ① 无窗口结束语义（过期、错失无法表达）；② 无相对时间（「3 天后」只能靠效果 `advanceBy` 间接造）；③ O(n) 全模板扫描且与队列语义无关；④ R3 时间回拨时「已触发」只能靠 `firedEvents` 猜，实例级回溯不存在 |
| M2 | `packages/shared/src/v2.ts:184-185`（`firedEvents: Record<eventId, turnIndex>`）+ `turn.ts:407-411`（`onCooldown`） | **事实记录粒度不足且绑定轮次**：事实只存「最近触发轮次」，冷却判定 `turnIndex - fired < cooldownTurns` 把轮次当时间单位 | 时间窗冷却无法表达（一轮 = 多长？取决于步长）；`once`/冷却事实与调度耦合在同一无结构字典里 |
| M3 | `flags` 多用途（`turn.ts:529`、`npc.ts:54/92`、`opening.ts:150-160/253`、`engine.ts:295-303`） | **引擎内部记录/实例状态伪装成模板语义 flag**：`npcAction:<npcId>:<actionId>`（NPC 行动冷却=系统事实）、`infoVisibility:<npcId>`（NPC 投影状态=实例层）、`relationSource:<npcId>`（关系来源=事实）、`openingScheduled:<eventId>`（调度标记=实例层缺失的补丁）、`turnsPlayed`（= `turnIndex` 的冗余副本）。**最强证据**：`infoVisibility:*` 与 `relationSource:*` 全仓库生产代码**零读取点**——只在 `opening.ts:150-160` 写入（唯一检索命中处），game-core/shared/web 无任何消费，仅 opening.test.ts 断言写入值。这是「事实塞进配置命名空间且无人消费」的直接实证 | ① 模板条件 DSL（`FlagConditionSchema`）**可以读到引擎内部记录**——层级墙被穿透；② 键名字符串拼接无 schema 保护；③ `openingScheduled` 只写标记不建实例，开局排程事件实际仍靠 M1 的模板扫描触发（`opening.ts:249-254` 注释自证）；④ 写而不读的记录证明该数据从未参与任何决策——属于占位垃圾状态，迁移时应直接重构消费点（R2.6 的 projectNpc/关系模型）而非保留语义 |
| M4 | `packages/shared/src/v2.ts:140-146`（`ChainStateV2.stepIndex`）+ 两处写入口（`engine.ts:370-375` `advanceChain` 效果直接 `+1`；`turn.ts:302-305` `advanceChainOnSettle` 按 `findIndex` 派生） | **派生状态存成事实，且双写入口**：`stepIndex` 本可由「链定义 + 已结算步骤」推导，却被独立存储；`advanceChain` 效果盲目 `+1`，与结算推进可能漂移 | 同一状态两处写、语义不一致的风险（效果推一步 + 事件结算再推一步 = 跳步）；链「当前进行到哪」无法与延时队列对账 |
| M5 | `packages/shared/src/schema/event-instance.ts` + `opening.ts:227-259` | **实例协议存在但未接线**：`EventInstanceSchema`（instanceId/definitionId/origin/scheduledTime/status/visibility）只有 opening 抽取在用；`handoff()` 对 schedule 事件只写 `flags["openingScheduled:<eventId>"] = true`，不产生任何运行时队列条目 | M1 的扫描器根本不消费实例——实例层有名无实；`scheduledTime` 与 `atWorldTime` 两套时间表达并存 |
| M6 | `packages/shared/src/v2.ts:130-136`（`pendingEvents`/`PendingEvent {eventId, chainId}`） | **待决队列被当调度队列用**：无实例 id、无时间、无 status；`advanceTurnV2:505` 的 `pending_event_required` 守卫依赖它表达「槽位占用」 | 「待玩家决策」与「等待触发」两种性质不同的东西挤在一个 FIFO 里；链的延时步骤（「3 天后触发」）无落点 |
| M7 | `packages/shared/src/schema/character.ts:16`（`identity.age: int`）+ `turn.ts:565` + `npc.ts` 无年龄处理 | **NPC 年龄是静态快照**：`createWorldV2` 从模板复制一次后永不更新；玩家年龄走 `playerAgeAtStart + elapsedYears`（另一套派生逻辑） | NPC 不衰老；「开局已死亡的重要角色」无出生时间可推年龄；两种年龄语义并存 |
| M8 | `character.ts:56`（`relationship: -100..100`）+ `opening.ts:155-161`（`relationSource` 塞 flags） | **单值混合三种语义**：好感度、亲属、师承挤在一个数上；关系的「来源说明」是字符串 flag | 无法表达「五条是我的师父且好感 -10」；亲属/师承只能手写双向对称数据，无法推导，错误无校验 |
| M9 | `character.ts:29/31`（`isEnemy` + `visibility: public\|hidden`）+ `npc.ts:36`（`if (npc.isEnemy) continue`） | **语义重叠的两个开关**：`isEnemy` 同时承担「战斗敌人」与「不参与 NPC 自主行动」两职；`visibility` 又是第二层显示开关；且 NPC **没有「不参与任何事」的状态**（死亡的 NPC 照样被效用评分选去行动） | 死亡/失联 NPC 继续行动与说话；敌人模板角色无法以非战斗身份行动；前端隐藏逻辑与引擎跳过逻辑互相纠缠 |
| M10 | `turn.ts:165-200`（`EVENT_SOURCE_PRIORITY` + `enqueuePendingEvent`） | **优先级是排序事实却散落在插入算法里**：pool 事件抽中立即 `triggerEventV2`（`turn.ts:344/351`），与用户「pool 只能触发延时事件」的诉求冲突 | 池事件无延迟语义；同轮多事件呈现顺序逻辑内嵌在插入函数中，不可配置不可测试 |
| M11 | `packages/shared/src/schema/common.ts:155-176`（`EffectSchema`） | **效果 DSL 缺口**：白名单中没有任何 NPC 生命周期效果、没有 spawn 效果、也没有「入队延时事件」效果。而 R-NP-03 要求「模板把失联事件映射为 dead」、R-EV-08 要求「pool 抽中后延时入队」——需求已有，写入通道不存在 | 生命周期（4.1）与 pool/链延时（3.7/3.9）落地时必须扩白名单：`setNpcLifecycle` / `enqueueEvent`（见 §6），否则模板只能靠硬编码或绕过效果层写状态，违反 AGENTS.md §2「副作用放 adapter/白名单」 |

---

## §2 三层模型定义

**裁判标准**：任何新字段/新记录，先问它属于哪一层、谁能写、何时被读。三层一旦划定，M1-M10 的每一处改造落点自动确定。

| 层 | 职责 | 载体（具体类型/文件） | 可变性 | 谁能写 | 校验点 | 是否进存档 |
|---|---|---|---|---|---|---|
| **配置层** | 世界观规则与内容的唯一来源（事件定义、链定义、NPC 初始定义、行动、历法声明、投影配置） | `specs/data/templates/<world>/ *.yaml` → Zod strict（`packages/shared/src/schema/`：`event.ts`/`character.ts`/`world.ts`…）→ `WorldTemplateV2` | **只读**。加载后不可变（模板指纹 sha256 绑定存档，ADR-0007） | 模板作者（加载期 Zod 校验 + 引用完整性校验） | 加载期：Zod strict（未知字段即错）+ superRefine 交叉校验 + 指纹 | 否（以指纹形式间接进存档信封） |
| **实例层** | 本局「活的」对象：有 id、有 status、可序列化、可取消 | 事件实例 `ScheduledEventInstance`（新，§3.3）、待决事件 `pendingEvents`、链实例 `ChainStateV2`、NPC `V2Npc`（+lifecycle/birthTime/parents）、战斗 `BattleState`、装备 `EquipmentInstance`、补正 `StatusInstance` | 可变，但**写入口收口**（如链推进唯一入口、调度唯一入口 `scheduler.ts`） | 引擎效果 DSL（`applyEffectsV2`）、调度器、玩家命令 | 写入时：引擎白名单效果 + 运行时断言（如环检测）；存档加载时 `WorldStateV2Schema.safeParse` | **是** |
| **事实层** | 只追加（append-only）的历史记录：可查询、不可改写、**不得作为触发源** | `history: HistoryEntryV2[]`（既有）、`eventFires: Array<{eventId, turnIndex, worldTime}>`（新，append-only 日志）+ `lastFiredIndex: Record<eventId, {turnIndex, worldTime}>`（**派生索引/缓存，可从日志重建，不是事实**，承接 once/冷却/结局 eventOccurred 的按 id 查询）、`missedEvents: MissedEventRecord[]`（新，错失的延时事件）、关系变更记录 `relationLog`（新，R2.6） | 事实只追加。条目一经写入不改不删；派生索引可随时重建 | 引擎在结算边界写入（触发、过期、错失、关系变更） | 无需复杂校验（只追加天然一致）；加载时照常 safeParse，索引与日志不一致以日志为准重建 | **是** |

**配置/实例/事实的读写规则（编码时的硬约束）**：

1. 配置层只在两个时刻被读：**入队/实例化时**（把定义变成实例，固化判定参数）与**条件求值时**（读定义的结构，如 `lookup.event(id)`）。调度循环（drain）**不得遍历 `template.events`**——只遍历 `state.scheduledEvents`。
2. 实例层是唯一可被调度驱动的东西。实例过期/取消只改自己的 `status`，不删（保留审计痕迹，供事实层查询）。
3. 事实层的合法消费方式**只有三种**：条件求值的只读输入（`once`/冷却/`FlagCondition`）、投影展示、结局证据（`evidenceIds`）。**事实不得反向驱动调度**：任何「因为有 X 记录所以触发/入队事件」的逻辑非法——触发只能来自：玩家行动、效果 DSL（`startChain`/`enqueueEvent`）、延时队列到期。
4. 调度判定器必须是**纯函数**：`evaluateDue(instance, worldTime, facts) → decision`，输入全显式，无隐藏读取。这是确定性可测的关键。

**flags 的归属与拆分（M3 的处理）**：

| 现有 flags 键 | 判定 | 去向 | 兼容策略 |
|---|---|---|---|
| 模板语义 flag（`spAware`、`nightLine`、`canonDeviation`、`doomed`…，由 `setFlag/adjustFlag/clearFlag` 写、`FlagCondition` 读） | **合法的模板语义层** | 保留在 `state.flags`，定位明确化：`flags = 模板可读写的语义黑板` | 不动 |
| `npcAction:<npcId>:<actionId>` | 系统事实（NPC 行动冷却） | R2.6：迁入 NPC 实例 `actionLastFired: Record<actionId, worldTime>` | 旧键停止写入，加载时清理；冷却改时间维度见 Q-R25-04 |
| `infoVisibility:<npcId>` | 实例层（NPC 投影状态） | R2.6：迁入 NPC 实例字段 `infoVisibility: known\|inferred\|unknown` | opening 写入点同步迁移 |
| `relationSource:<npcId>` | 事实层（关系来源） | R2.6：迁入关系边 `source` 字段 + `relationLog` | 随关系模型迁移 |
| `openingScheduled:<eventId>` | 实例层缺失的补丁 | R2.5：被延时队列实例取代，**删除** | handoff 改为真正入队；旧键不再写入 |
| `turnsPlayed` | 冗余事实（≡ `turnIndex`） | **删除** | 消费点（`life-evaluation.ts:77`）改读 `turnIndex` |

---

## §3 事件模型

### 3.1 触发分类与字段迁移

用户总则落地：触发分**立即**与**延时**两类；`pool` 不是触发类型而是**抽取器**。

| 分类 | source 取值 | 行为 | 是否入延时队列 |
|---|---|---|---|
| 立即触发 | `action_trigger`（由现 `action-hook` 改名，见 Q-R25-01） | 玩家行动命中 `onActionId` → 本轮内立即 `triggerEventV2`（normal 占槽位 / random 即时转盘 / combat 建战斗） | 否 |
| 立即触发 | `chain` | 链的下一步（`onSettle` 或显式 `delay` 的步骤例外——见 3.9），由结算/推进点立即触发 | 否（除非该步声明 delay） |
| 延时触发 | `schedule` | 世界初始化（opening handoff）与效果 `enqueueEvent` 时按时间窗入队；到期 drain 判定后触发 | **是** |
| 抽取器 | `pool` | 管线末尾按 probability/weight 抽取；**抽中后一律入延时队列**，不得立即呈现（3.7） | 是（抽中即入队） |

**字段迁移表**（`EventTriggerSchema`，strict schema 下旧字段加载期即拒绝，模板随指纹一并升级）：

| 旧字段 | 新字段 | 语义 | 兼容期处理 |
|---|---|---|---|
| `source: "action-hook"` | `source: "action_trigger"` | 仅改名 | superRefine 过渡期同时接受两值并告警，模板全部迁移后删除旧值（Q-R25-01） |
| `atTurn: int` | **退役** | x 轮后触发无法换算成世界时间（轮次时长由行动/人生阶段决定，不可预知） | 替代表达：`window.start`（绝对/相对时间）；现存模板无 `atTurn` 使用（已核对 jjk-2006），退役零迁移成本 |
| `atWorldTime: TimeAmount` | `window.start: TimeExpr` | 世界起点偏移 → 统一进时间窗 | `atWorldTime: T` ≡ `window: { start: { kind: "absolute", at: T } }` |
| `cooldownTurns: int` | `cooldown: TimeExpr`（时间维度） | `worldTime - lastFiredIndex[id].worldTime < cooldown` 判定 | 需 `firedEvents` 两层拆分（3.6：`eventFires[]` 日志 + `lastFiredIndex` 派生索引）；数值兼容见 §5 |
| `probability` / `weight` / `once` / `priority` / `conditions` / `onActionId` | 保留 | 语义不变；`probability` 在 drain 判定时掷骰（3.4），`priority` 保留给 pool 抽取排序与同批立即事件排序 | 不动 |
| （新增）`window.end?: TimeExpr` | 时间窗结束；到期未触发 = 过期/错失 | 无 | |
| （新增）`delay?: TimeExpr`（pool 用） | 抽中后入队的延迟 | 缺省语义见 Q-R25-02 | |

**TimeExpr 定义**（`common.ts` 新增，与 `TimeAmount` 同文件域）：

```text
TimeExpr =
  | { kind: "absolute", at: TimeAmount }    // 相对世界起点（worldTime = 0）的偏移，兼容现 atWorldTime
  | { kind: "relative", after: TimeAmount } // 相对入队时刻（enqueue 时的 worldTime）的偏移
resolveTimeExpr(expr, now): number          // → 世界分钟；换算经 CalendarAdapter（3.5）
```

### 3.2 轮次槽位唯一

- **定义**：一个轮次槽位 = 「一个待决事件被呈现并结算」**或**「一次玩家自由行动」，二者不共存于同一轮。`pending_event_required` 守卫（`advanceTurnV2:505`）继续作为「槽位被占用时拒绝提交新行动」的机制保留。**注意：现状实现并不满足这个定义**——行动与立即事件同处一轮（见方案 ②），该定义是用户裁决 `#34` 后的目标态。
- **立即事件何时吃槽位（OPEN_QUESTIONS `#34`，双方案对照，设计不预设结论）**——用户原话「立即触发的不入队，下一轮触发」字面对应方案 ①；现状实现对应方案 ②：

| 维度 | 方案 ①：下一轮触发（**推荐，与用户原话一致**） | 方案 ②：当前轮触发（现状行为） |
|---|---|---|
| 语义 | 玩家行动轮 = **纯行动**；行动触发的立即事件在**下一轮开局**呈现并吃掉该轮槽位；下一轮玩家只能面对事件不能自由行动 | 行动与事件同轮：行动效果结算后事件立即呈现，本轮结束时玩家面对它 |
| `turnIndex` | 事件呈现轮 = 新的一轮（`turnIndex` 已在行动轮 +1；事件在下一轮呈现时**不再另起一轮**，事件没有自己的轮次推进） | 同 ①（事件不另起轮次） |
| `worldTime` | 事件呈现轮开局是否推进时间 = **待裁决子项**：若事件有 duration 则按行动轮规则推进；现状 `chooseOptionV2` 不推进、事件无 duration（`elapsed: 0 minute`）——方案 ① 下维持「选项不耗时间」语义不变（零改动），是否给事件挂 duration 留 `#34` 一并裁决 | 事件结算发生在行动轮内，时间已在步骤 1 推进，选项不推进（现状） |
| 槽位守卫 | 事件呈现轮 = 该轮槽位被事件占用，`pending_event_required` 照常拦截自由行动；定义自洽（行动轮无事件、事件轮无行动） | **违反「一轮一槽位」定义**：动作 + 事件共处一轮，定义需弱化为「一轮至多一次玩家行动 + 至多一个事件呈现」 |
| 改动量 | 管线需要「延迟一拍呈现」机制（立即事件入队后 `window.start`/呈现指针指向下一轮，或等效的 deferred 标记），改动中等 | 零改动（即现状 `enqueuePendingEvent`） |
| `chooseOptionV2` 是否推进 `turnIndex` | **不推进**（事件结算不是行动轮，现状即如此，两方案一致） | 不推进（现状） |

  **标注：方案选择待用户裁决 `#34`，本设计不预设**。若裁决 ①，`enqueuePendingEvent` 增加呈现时机标记、管线在下一轮开局先消费 deferred 事件再轮询其他触发源（优先级次序不变）；若裁决 ②，本文「一轮一槽位」定义弱化为「一轮 = 至多一次玩家行动 + 至多一个事件呈现」。同一行动触发多个立即事件时按 `EVENT_SOURCE_PRIORITY`（chain 0 → schedule 1 → action_trigger 2 → pool 3）排队、槽位逐个消费，`enqueuePendingEvent` 排序结构不变。
- **随机事件与战斗的槽位记账（用户 2026-11-11 补充裁决，已定）**：随机事件也是事件，**占其触发轮的槽位**——服务端在轮次结算内用 RNG 抽取并随轮次结果（`wheelResult`）返回，前端在通用事件区以转盘揭示（R-EV-11）；**combat 同理为该轮槽位内容**（战斗会话占据槽位直至结束）。二者与行动的关系：行动是触发源，事件/战斗是该轮槽位的承载物——即「一轮 = 至多一次玩家行动 + 至多一个事件/战斗承载」这一弱化定义的实例。
- **槽位呈现契约（前端，已实现）**：通用事件区 = 槽位的可视化容器；占位者优先级 **转盘（本轮已结算的随机事件）→ 战斗 → 待决事件 → 自由行动（空槽）**，一个轮次只呈现一个；转盘确认「继续」后槽位让位于下一个占位者。同轮其它已结算事件的叙述进「本轮还发生」底栏（排除待决事件与转盘事件，避免重复）。
- **新模型下的 `pending_event_required`**：语义收窄为「槽位被待决事件占用时，拒绝提交新的自由行动」。延时事件到期触发同样产生待决事件，同受此守卫约束。**不变式**：`advanceTurnV2` 结束时 `pendingEvents` 至多按优先级有序、队首必可呈现。

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
  window: { start: number; end?: number }   // 世界分钟；end 缺省 = 无限期
  enqueuedAt: number            // 入队时世界分钟
  enqueueSeq: number            // 取自 enqueueSeqCounter++，全局唯一
  status: "waiting" | "fired" | "expired" | "cancelled"
  snapshot?: {                  // 入队时固化的判定参数（可选；缺省引用定义现值）
    conditions?: Condition[]    // 例如开局排程希望冻结开局时刻的条件值
    probability?: number
  }
}
```

- `status` 生命周期：`waiting → fired`（触发）/ `waiting → expired`（窗口结束仍未触发）/ 任意 → `cancelled`（效果 `cancelChain`/未来效果取消）。`fired/expired/cancelled` 条目**保留在数组中**（审计 + R3 回溯），drain 时跳过非 `waiting` 条目。
- 排序键（**严格固定**）：`window.start asc → window.end asc（undefined 视为 +∞）→ enqueueSeq asc`。

```text
// 比较函数伪代码
cmp(a, b):
  if a.window.start != b.window.start: return a.window.start - b.window.start
  ae = a.window.end ?? MAX_SAFE_INTEGER; be = b.window.end ?? MAX_SAFE_INTEGER
  if ae != be: return ae - be
  return a.enqueueSeq - b.enqueueSeq
```

**稳定性证明**：`enqueueSeq` 全局唯一 ⇒ cmp 不可能返回 0 ⇒ 全序严格；同 start 同 end 的条目由 seq 定序，与插入方式（二分插入 / 整体重排）无关 ⇒ 排序结果与历史无关，纯函数 `sortScheduled(events)` 幂等。序列化安全：不用 `Infinity`（JSON 不支持），用 `MAX_SAFE_INTEGER` 哨兵或保留 `undefined` 在比较处兜底，二者取一见 Q-R25-03 附带裁决。

### 3.4 出队/触发判定算法

**何时 drain**（三个入口，全部复用同一 `drainScheduledEvents(state, lookup, rng, result)`）：

1. `advanceTurnV2` 时间推进后（替换现步骤 3 的 `resolveScheduleV2`，位置不变——保持 chain 先于 schedule 的优先级次序）；
2. 任何效果推进世界时间后（现 `timeAdvanced` 标记的消费点：`chooseOptionV2`/`useItemV2`/`battleActionV2`/事件结算内——替换其中所有 `resolveScheduleV2` 调用）；
3. 入队后队首已到期时（例如 `delay=0` 的相对入队；实现上入口 2 的 drain 天然覆盖大多数场景，入口 3 仅在 `enqueueScheduled` 内 `window.start <= state.worldTime` 时内联触发一次）。

**判定算法**：

```text
drainScheduledEvents(state, lookup, rng, result):
  for inst of state.scheduledEvents where status == "waiting":   // 数组已按排序键序
    if inst.window.start > state.worldTime: break                // 有序队列，后面只会更晚 → 停止
    if inst.window.end != undefined && state.worldTime > inst.window.end:
      inst.status = "expired"
      facts.missedEvents.append(record(inst))                    // 事实层：错失记录
      continue                                                   // 过期：出队语义，继续看下一个
    decision = evaluateDue(inst, state, lookup, rng)             // 顺序见下
    if decision == "fire": inst.status = "fired"; triggerEventV2(...)
    else if decision == "drop": inst.status = "expired"; facts.missedEvents.append(record(inst))
    else: /* hold: 留队 */ pass
```

**`evaluateDue` 判定顺序（固定，不得重排）**：

| 序 | 检查 | 失败处置 | 理由 |
|---|---|---|---|
| 1 | `once`：`lastFiredIndex[definitionId]` 存在（读派生索引，见 3.6） | **drop**（记错失） | once 事件已触发过，等待没有意义 |
| 2 | `conditions`（用入队快照或定义现值） | **hold**（留队，窗口内每轮重估） | 时间未到条件不满足是常态（如等待某信息公开）；到期/窗口结束仍不满足则走序 5 的过期路径自然淘汰 |
| 3 | 冷却：`worldTime - lastFiredIndex[id].worldTime < cooldown` | **hold**（留队） | 冷却结束仍可能触发 |
| 4 | `probability` 掷骰 | **drop**（记错失） | 一次性判定。留队会导致每轮重掷（RNG 语义混乱、概率失真为「窗口内至少一次命中」） |
| 5 | （窗口已在循环头判定过） | — | — |

判定通过 → `status = "fired"` → `triggerEventV2(state, def, lookup, rng, 0, result, inst.chainId)`（按 kind 路由：normal 占槽位 / random 转盘 / combat 建战斗）。**失败是丢弃还是留队**的裁决汇总：once/概率 = 丢弃；条件/冷却 = 留队。此混合策略为推荐值，记待决问题 Q-R25-03（备选：全部丢弃 / 全部留队至窗口结束）。

**与 RNG 消耗顺序的关系（确定性声明）**：

- drain 按排序键序逐个判定，**每个到期实例至多消耗**：1 次 `probability` 骰 + 条件 DSL 内 `RandomCondition` 的骰（`checkCondition` 语义不变）。hold（留队）不消耗 RNG；下轮重估时从序 2 重新开始。
- `pool` 抽取仍在管线末尾（步骤 9），其 RNG 消耗（probability 逐事件掷骰 + weight 抽取）顺序不变；变化在于抽中后是**入队**而非立即 `triggerEventV2`（随机事件 kind 若为 random，其转盘骰从「本轮末」移到「到期 drain 时」）。
- **显式声明：与 R2.4b 相比，同 seed 同输入的事件触发序列与转盘结果会改变**（骰子的调用时机与次数不同）。这不违反确定性不变量（新行为完全可复现），但：① 现有依赖具体事件序列的测试需重录基线；② 旧存档不可续玩（§5 一起处理）。
- 断链保护：drain 内触发的 random/combat 事件若再推进时间（`advanceBy`），**不得在本 drain 循环内递归 drain**——新到期实例等下一个 drain 入口（管线步骤 3 次序在后续轮次保证）。实现为：`triggerEventV2` 内的 `timeAdvanced` 只置标记，由路由层在安全边界统一消费（与现状 `resolveScheduleV2` 的调用点纪律一致，仅把「重扫模板」换成「重 drain 队列」）。

### 3.5 时间写法与历法

- **两种语法**（3.1 的 `TimeExpr`）：`absolute`（世界起点偏移，兼容现 `atWorldTime`）与 `relative`（入队时刻 + N 天/小时…，`enqueueScheduled` 时经 `resolveTimeExpr(expr, state.worldTime)` 一次性换算为分钟固化进 `window`）。**入队即换算**保证后续时间回拨/前拨不影响已固化窗口的判定语义（窗口是实例事实，不是每轮重算的表达式）。
- **月/年的固定分钟近似问题**：现 `UNIT_MINUTES.month=43200 (30d)`、`year=525600 (365d)` 是近似值（`time.ts:18-25`）。对「3 天后」这类短延时无影响；对「1 年后」的剧情节点有 ±1 天漂移。**是否引入真实历法**与 NPC 出生时间（4.4）共用同一套裁定：
  - 候选 ①：**维持固定分钟近似**（零迁移成本，现有行为逐字段不变）；
  - 候选 ②：**真实公历** CalendarAdapter（月长 28-31、闰年；`relative` 换算需 `from` 上下文：`toMinutes(amount, fromMinute)`）；
  - 候选 ③：**自定义历/农历**（`world.yaml` 声明 `calendar: { preset: "custom", ... }`）。
  - **推荐**：三者统一进 `CalendarAdapter` 接口（ADR-0002 seam 已预留），接口增加 `toMinutes(amount, fromMinute)` 与 `ageAt(birthTime, now)`（4.4）；**R2.5 只实现候选 ①**，②③ 留作模板声明切换的后续项。是否需要 ②③ 属用户裁决项（**Q-R25-05**）。

### 3.6 退役 `atTurn` 与 `cooldownTurns`

| 退役项 | 替代表达 | 需改的模板点 | 需改的代码点（只列不改） |
|---|---|---|---|
| `trigger.atTurn`（x 轮后） | `window.start: { kind: "absolute"\|"relative", ... }`。轮次时长不可预知 ⇒ 语义上不可换算，必须用时间窗 | 现存模板零使用（已核对 jjk-2006 events.yaml 无 `atTurn`） | `event.ts` schema 删字段；`turn.ts:379` due 判定删除 |
| `trigger.cooldownTurns`（轮次冷却） | `trigger.cooldown: TimeExpr`：`worldTime - lastFiredIndex[id].worldTime < cooldownMinutes` | jjk-2006 中带 `cooldownTurns` 的 pool 事件（加载期 strict 会拒绝旧字段，随指纹升级一并改写） | `event.ts` schema；`turn.ts:407-411` `onCooldown` 改读 `lastFiredIndex`；`firedEvents` 两层拆分（3.6） |
| `duration.turns`（补正轮次寿命）/ NPC 行动 `cooldownTurns` | **本轮不动**（R2.6 随 NPC 冷却迁移评估；ADR-0001 已确认战斗不消耗世界时间的特例） | — | — |

**`firedEvents` 拆为两层（修正 R2.4b 的按 id 覆盖写——覆盖违反 R-LM-03「事实只追加、逐字段不变」与本文件 §2 的层定义）**：

- **事实层 `eventFires: Array<{ eventId: string; turnIndex: number; worldTime: number }>`**：append-only，每次触发追加一条，同 eventId 可多条（多次触发是多次事实），**写入后逐字段不变**（R-LM-03 验收）。
- **派生索引 `lastFiredIndex: Record<eventId, { turnIndex: number; worldTime: number }>`**：**显式标注为派生缓存，不是事实**——完全可从 `eventFires` 重建（对每个 eventId 取最后一条）；语义上等价于现 `firedEvents`（「最近一次触发」）。消费点（`once` 判定、冷却判定、结局 `eventOccurred` 的 `v2/ending.ts:134` 按 eventId O(1) 查询）一律读索引；**索引与日志不一致时以日志为准重建**（加载存档时、或防御性校验发现漂移时）。事件按 eventId 随机查询的需求由索引承接（见下「事实层结构约束」），append-only 语义由日志承接，两者职责不混。

旧存档兼容：现 `firedEvents` 数字值视为 `{ turnIndex: v, worldTime: 0 }` 导入 `lastFiredIndex`（仅拒载策略下的兜底说明，见 §5；`eventFires` 无旧档数据可迁移，旧档缺失该日志是已知损失）。

**事实层结构约束（防止实现走偏）**：事实层 ≠ 只能是裸数组。按 eventId 的随机查询必须有索引承接：终止条件 `eventOccurred`（`v2/ending.ts:134`，`ids.every((id) => state.firedEvents[id] !== undefined)`）要求按 eventId O(1) 查询「全部已登记」——该需求由 `lastFiredIndex` 承接（3.6 两层拆分），**不得把 `eventFires` 实现成数组后让终止判定退化为 O(n) 扫描，也不得另建第二份按 id 的"事实"副本**（索引不是事实，是可重建缓存，唯一事实来源是 `eventFires` 日志）。设计口径：**事实层 = 「只追加的记录 + 其派生索引」**；无按 id 随机查询需求的事实（history、missedEvents、relationLog）不建索引（投影/结局证据均顺序遍历）。

**测试迁移清单（退役项的现存测试使用，只列不改）**：

| 退役/待决项 | 测试使用点 | 迁移动作 |
|---|---|---|
| `atTurn`（退役） | `packages/game-core/src/v2.test.ts:737`（combat 并发优先级：`{ source: "schedule", atTurn: 1 }` 注入首轮时间触发战斗）、`:768`（normal 队列优先级同型） | 改写为 `window: { start: { kind: "absolute", at: { value: 1, unit: "day" } } }`（或夹具对应分钟量）——**两个测试断言的「优先级次序」语义不变**，仅触发表达换形；这两个测试同时是 RNG 序列基线重录点（§3.4.5） |
| `advanceWhen: "nextTurn"`（去留待 Q-R25-06） | `v2.test.ts:711`、`:786`（链 nextTurn 步触发链战斗/链 normal） | 若 Q-R25-06 裁决保留（推荐）：测试不动；若退役：两测试改写为 `onSettle` + `delay` 或重设计 |
| `cooldownTurns`（改 `cooldown: TimeExpr`） | 夹具中带 `cooldownTurns` 的 pool 事件（v2.test.ts 内多处构建） | 字段换形 + 冷却判定从轮次差改时间差，相关断言重算 |

### 3.7 `pool` 语义收敛

- **现状**：`resolvePoolV2`（`turn.ts:329-352`）抽中即 `triggerEventV2` 立即呈现。
- **新语义**：抽中 → `enqueueScheduled(state, { definitionId, origin: { kind: "pool" }, window: { start: resolveTimeExpr(trigger.delay ?? 默认, state.worldTime) } })`。池事件从此**只能**经 drain 触发 = 用户「pool 只能触发延时事件」。
- **delay 从哪来**：`trigger.delay?: TimeExpr`（模板显式声明，如 `{ kind: "relative", after: { value: 3, unit: "day" } }`）。缺省值两个候选：`{ relative, 0 minute }`（抽中即在下一次 drain 立即触发 ≈ 现状行为，管线步骤 9 入队后由入口 3 内联触发，时序与 R2.4b 等价）或**必填**（强制模板作者思考延迟）。**推荐缺省 0**（平滑兼容 jjk-2006 现有 5 个 pool 事件的行为），记 Q-R25-02。
- 抽取时机与 RNG：仍在管线步骤 9、每轮一次；probability 逐事件掷骰 + weight 加权抽一，顺序不变。**注意**：pool 事件自带的 `conditions`/`once`/冷却在**抽取时**过滤（现状不变），`probability` 在**入队后 drain 时**掷骰会重复过滤——为避免语义重复，推荐 pool 事件的概率判定留在抽取时（现状），drain 阶段对 pool 来源实例跳过序 4（其 `snapshot.probability` 不再掷）。此细节随实施在测试中固化。

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
- `advanceWhen: nextTurn` 与「x 轮后触发」的关系：`nextTurn` 语义是「下一轮推进时触发」——它**不**是「x 轮后」（后者已退役）。推荐**保留 `nextTurn`**（jjk-2006 现无使用但协议保留表达力；「下一轮」是槽位语义不是时间量），延时步骤用 `ChainStep.delay?: TimeExpr` 表达（3.9）。是否一并退役记 Q-R25-06。
- **`stepIndex` 改派生还是保留缓存**：**推荐保留缓存 + 单一写入口**。理由：派生需要回放「哪些事件已结算且属于本链」（事实层只有 eventId→firedAt，无法区分链实例归属），引入派生映射表的成本高于一个被严格收口的整数。措施：① 删除 `engine.ts:370-375` `advanceChain` 效果的盲目 `+1`（改为按 `findIndex` 对齐，与 `advanceChainOnSettle` 同规则）；② `evaluateChain` 作为断链兜底校验；③ `startedTurn`/`stepIndex` 继续进存档。

### 3.9 事件链与延时队列的组合

链的一步可以是「3 天后触发」，写法：

```yaml
chains:
  - id: chain-culling-game
    startEventId: ev-culling-announce
    steps:
      - { eventId: ev-culling-announce, advanceWhen: onSettle }          # 结算后立即触发下一步
      - { eventId: ev-culling-day3, advanceWhen: onSettle, delay: { kind: "relative", after: { value: 3, unit: "day" } } }
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

- **引擎只判 `alive`**：所有消费点做 `npc.lifecycle.state === "alive"` 过滤。**引擎不得对 `reasonCode` 分支**——「死了才能 X」「失联者 Y」的业务语义由模板条件表达；为此新增条件 DSL：`{ npcState: { npcId: string, state: "inactive" | "unspawned" | "alive" } }`（只匹配状态本身，永远不暴露 reasonCode 匹配）。
- **与业务语义解耦**：`dead`/`missing`/`sealed` 只是字符串，引擎行为完全一致（不行动、不参战、关系冻结）。模板可自造 reasonCode（Zod 校验为 `string.min(1)`，不设枚举）。
- **spawn 由谁触发**：① 模板初始化——`characters.yaml` 角色缺省 `alive`；模板可声明 `initialState: "unspawned"|"inactive"`（含 reasonCode）表达「开局未登场/开局已死亡的重要角色」；② 事件效果——`EffectSchema` 新增 `{ type: "setNpcLifecycle", npcId, state, reasonCode? }`（与 `setFlag` 同级的白名单效果，经既有 `applyEffectsV2`）；③ NPC 行动效果——同样通过效果 DSL，无特权通道。
- **不引入 `lifecycle.ts` 模块/阶段枚举**（ADR-0004 边界继续有效）：这是角色级三态字段，不是流程编排；boundary 静态检查不放松。

### 4.2 默认判活（模板零书写）

四处消费点**引擎自动过滤**，模板不写任何 `alive` 条件：

| 消费点 | 过滤规则 | 位置（现） |
|---|---|---|
| ① NPC 自主行动 | `lifecycle.state !== "alive"` 直接 continue（替代并加强现 `isEnemy` 跳过的一半职责） | `npc.ts:35-37` |
| ② 战斗参战 | `createBattle` 解析 `enemies`/**`allies`** 的角色 ref 时，目标 NPC `inactive/unspawned` → **跳过该场战斗整条触发并记一条事实**（沿用现 combat 冲突口径：`triggerEventV2:219`「已有进行中战斗时整条跳过、不写 firedEvents/不消耗 once/冷却」——扩为「目标不可参战时同样整条跳过」）。**不在建场期硬报错**：「分支里先死、之后再引用同一 NPC 的战斗」是合法剧情（事件条件层可另行用 `npcState` 把关）。只有 `characterId` 在模板里**根本不存在**才在加载期报错（引用完整性，同性别/技能/补正校验口径） | `battle.ts` 建场 |
| ③ 关系变更 | `adjustRelation`/关系效果对 `inactive` NPC **冻结**（跳过写入，不改数值）；对 `unspawned` 同样冻结 | `engine.ts:321-326` |
| ④ NPC 相关条件 | `requireKnowledge`、新增 `npcState` 条件正常求值（条件是模板显式意图，不默认过滤）；但**NPC 行动候选过滤**（①）已先行挡住 inactive NPC 的行动 | `npc.ts:41` |

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
- **`visibility: public|hidden` 是否保留**：推荐**保留**并明确其为「模板作者对角色定义的第二道静态闸」：`hidden` = 角色定义整体不进投影（未登场敌人、剧透角色），与动态 `infoVisibility`/`projection.alwaysVisible` 做 AND 组合（任一闸关闭即不下发）。是否简化合并记 Q-R25-07。

### 4.4 年龄动态计算与三种时间模型

- **数据模型**：`V2Npc` 删除静态 `age`（`V2CombatantBase.age` 一并处理），新增 `birthTime: number`（世界分钟，**可为负** = 世界开始前出生）。模板 `characters.yaml` 仍写 `identity.age`（配置层人类可读），`createWorldV2` 换算：`birthTime = 0 - age * yearMinutes`（近似历法）或经 CalendarAdapter 反推。
- **删除 `age` 的影响面（必须完整接线，否则前端/战斗全挂）**：
  - `V2CombatantBase.age` 是 `BattleEnemy`（`packages/shared/src/v2.ts:40-52` 经 V2Npc/V2Player 继承链）共用的基类字段——`V2Player`/`V2Npc` 删静态 age 时，**战斗镜像不跟随**：`createBattle` 建场时把当时计算好的 `age` **快照**进 `BattleEnemy`/战斗内单位（战斗不消耗世界时间，ADR-0001 已确认，战斗内不能也不需要实时 `ageAt`；快照值在战斗生命周期内恒定）。
  - **投影层仍下发计算后的 `age`（视图字段，不是实例字段）**：`projection.ts:100`（玩家快照 `player.age`）与 `:141`（NPC 快照 `npcs[].age`）的形状**对前端保持不变**，内部实现改为 `ageAt(birthTime, state.worldTime)` 现算；前端 `apps/web/src/main.tsx:531/1225/1597` 的 `age` 消费点**零改动**。原则：删的是**实例层的存储**，不动**视图层的输出形状**——避免一次内部重构波及前端。
  - `formattedTime`/人生阶段等其余时间输出不受影响（本就经 CalendarAdapter）。
- **算法**：`ageAt(npc, now) = calendar.ageAt(npc.birthTime, now)`；近似历法下 `= floor((now - birthTime) / 525600)`。投影、条件（如新增 `{ npcAge: { npcId, gte } }`，是否需要记 Q）、人生阶段判定统一走该函数；玩家亦统一（`playerAgeAtStart + elapsedYears` 退役，`V2Player` 同样挂 `birthTime`）——统一与否记 **Q-R25-08**（推荐统一，消除 M7 的双语义）。
- **三种时间模型**（与 3.5 共用 CalendarAdapter 裁定；「以后没说的话默认都要支持」= 统一接口 + 模板声明切换）：

| 候选 | 说明 | 接口位 | 成本 |
|---|---|---|---|
| ① 固定年长近似 | 1 年 = 525600 分钟，生日即整年节点 | `ageAt = floor((now-birth)/525600)` | 零（现状语义） |
| ② 真实公历 | 月长 28-31、闰年；「生日未到不加岁」 | `world.yaml: calendar: { preset: "gregorian", startYear }`；`ageAt` 按历法日期差 | CalendarAdapter 完整实现 + `toMinutes(amount, from)` |
| ③ 自定义历/农历 | 世界自定义月长/置闰/农历 | `calendar: { preset: "custom", months[], leapRule... }` | 最大；农历可考虑 lunar-javascript（见 4.5 调研②） |

  **推荐**：R2.5/R2.6 只实现 ①，接口按 ②③ 形状设计（`CalendarAdapter` 增 `toMinutes(amount, fromMinute)` / `ageAt(birth, now)` / 模板 `calendar.preset` 声明位）。**该默认选择属用户确认项（Q-R25-05）**——用户原话「三种时间模型以后没说的话默认都要支持」的最保守解读即「接口统一、模板可切换」，不是本轮全实现。

### 4.5 关系模型

- **分离**：`affinity: number`（-100..100，现 `relationship` 改名，数值好感）与 `relations`（类型化边）分离。**亲属与师承不手写双向**，由单向事实推导：

```text
// 实例层：NPC 实例上的单向事实边（写入即校验）
V2Npc.parents: string[]          // 双亲 npcId 列表（≤2 不强制，模板自由）
V2Npc.masterId?: string          // 师父
// 事实层：关系变更记录（只追加）
relationLog: Array<{ npcId, kind: "parent"|"master"|"affinity", targetNpcId?, delta?, source?, atTurn, worldTime }>
```

- **推导算法**（自研纯函数，game-core `v2/relations.ts`，计划 ~150 行，无外部依赖）：
  - `child`：全 NPC 对 `parents[]` 反查；`apprentice`：对 `masterId` 反查 —— O(N·E)；
  - `sibling`：共享任一 parent 的 NPC 对 —— 按 parent 建倒排索引 O(N + E)；
  - 同门（共享 master）：同上倒排；
  - 辈分/谱系上溯（祖师、师伯）：`parents` 图与 `master` 链分别 BFS/DFS，O(V+E)；**环检测**：写入 `parents`/`masterId` 时校验目标不是自己的后代/徒弟链上节点（DFS 上溯检查），加载期对模板初始声明同样校验，运行时写入违反即抛可诊断错误（事实层只追加，一旦合法写入即无环）；
  - 多跳称谓（叔叔/师伯/师祖的中文称谓计算）：V1 范围只做「直接边 + 一跳派生」，多跳称谓延后（模板可先用 `custom` 关系 + label 表达）。
  - `custom` 关系：`relations: Array<{ type: "custom", customType: string, label?: string, targetNpcId, source? }>`，语义完全模板自定义（用户后续的通用 yaml 模板机制的落点，本轮只留类型位）。
- **开源调研**（用户点名复用成熟方案，结论先行：**默认不引入依赖**，理由见被否决备选）：
  1. **relationship.js（中国亲戚称谓计算库）**：面向「现实称谓查询」（三姑六婆文本推理），数据结构与引擎的确定性图模型不同构，称谓文本也不是模拟所需（模拟需要结构边供条件/评分消费）。借鉴其「辈分路径 + 关系链合成」思路即可，不值得为此引入依赖及其维护风险。
  2. **lunar-javascript**：农历/历法计算成熟库（若未来选时间模型 ③）。本轮不引（历法 ① 零需求）；未来启用 ③ 时再单独 ADR，届时它是首选候选而非自研。
  3. family-chart / Gramps 等族谱库：可视化或数据格式导向，与运行时图查询不匹配。
  - 复杂度与规模匹配：单局 NPC 量级 10¹~10²，图查询毫秒级，自研成本远低于依赖治理成本。

### 4.6 NPC 行动与事件的边界

- NPC 行动结算**只能**：写事实（history `npc_action`）、写实例状态（自身字段、背包、关系 affinity）、经效果 DSL 改世界（现状 `applyEffectsV2` 白名单）；需要排程时**只能 `enqueueScheduled`**（新增效果 `{ type: "enqueueEvent", eventId, delay?: TimeExpr }`，事件与 NPC 行动共用），**不得直接触发模板事件**——现 `startedChains` 收集 + 路由层触发的模式保留（它是「效果收集 → 路由触发」，不是 NPC 直接触发）。
- 落点：`npc.ts` 不新增扫描逻辑；NPC 行动的 `cooldownTurns` 改时间维度随 R2.6（Q-R25-04）。

---

## §5 兼容与迁移

**`WorldStateV2` 变更清单**：

| 字段 | 变更 | 层 |
|---|---|---|
| `scheduledEvents: ScheduledEventInstance[]` | 新增 | 实例 |
| `enqueueSeqCounter: number` | 新增 | 实例 |
| `missedEvents: MissedEventRecord[]` | 新增（{instanceId, definitionId, reason: "expired"\|"once"\|"probability", atTurn, worldTime}） | 事实 |
| `eventFires: Array<{eventId, turnIndex, worldTime}>` | 新增（append-only 触发日志，替代旧 `firedEvents` 的"事实"角色） | 事实 |
| `lastFiredIndex: Record<eventId, {turnIndex, worldTime}>` | 新增（派生索引/缓存，承接 once/冷却/eventOccurred 的按 id 查询；可从 eventFires 重建） | 实例（缓存） |
| `relationLog` | 新增（R2.6） | 事实 |
| `pendingEvents` | 形状不变（即时待决专用，不再兼调度） | 实例 |
| `chains: ChainStateV2` | `advanceChain` 写入口收口；形状不变 | 实例 |
| `flags` | 删除 `openingScheduled:*`、`turnsPlayed`；其余迁出随 R2.6 | 拆分见 §2 |
| `V2Npc` | +`lifecycle` +`birthTime` +`parents` +`masterId` +`infoVisibility`，-静态 `age`（R2.6） | 实例 |

**schemaVersion 升级**：信封 `schemaVersion: 1 → 2`（ADR-0007 机制）。

**旧存档：拒载 vs 迁移——推荐拒载**。理由：① 本轮是数据模型换代（队列/事实结构不可由旧字段机械推导）；② 模板指纹本就因 events.yaml/characters.yaml 变更而拒旧档，迁移旧档也无模板可用；③ 迭代期用户已接受重开（ADR-0008/0009 先例）。加载器对 `schemaVersion !== 2` 记 error 跳过（沿 ADR-0007 行为）。`firedEvents` 数字兜底规则（3.6）仅在内部测试夹具使用，不构成迁移承诺。

**模板指纹影响**：`EventTriggerSchema`（window/delay/cooldown 改造）、`ChainStepSchema`（delay）、`characters.yaml`（projection/lifecycle 初始声明，R2.6）均为 breaking strict 变更 → 指纹必变 → 旧档拒载，与上述策略一致。jjk-2006 模板随实施同步迁移（1 个 schedule、5 个 pool、1 个 action_trigger、约 20 个 chain，全部 `onSettle`，无 `atTurn`——迁移量小）。

---

## §6 影响面清单

| 文件 | 改动类型 | 轮次 |
|---|---|---|
| `packages/shared/src/schema/common.ts` | 新增 `TimeExprSchema`；不动 `TimeAmount` | R2.5 |
| `packages/shared/src/schema/common.ts` | `EffectSchema` 白名单**新增两类效果**（M11 缺口，R-NP-03 / R-EV-08 的写入通道）：① `{ type: "setNpcLifecycle", npcId, state: "alive"\|"inactive"\|"unspawned", reasonCode? }`（R2.5 落 schema、R2.6 落消费）；② `{ type: "enqueueEvent", eventId, delay?: TimeExpr }`（R2.5，事件与 NPC 行动共用的延时入队通道）。均走 `applyEffectsV2` 白名单分发，引擎不新增特权写入路径 | R2.5（schema+enqueueEvent 消费）/R2.6（setNpcLifecycle 消费） |
| 新增效果模板写法示例（进 events.yaml / npcActions） | `events.yaml`（失联事件映射，R-NP-03）：`effects: [{ type: "setNpcLifecycle", npcId: "npc-toji", state: "inactive", reasonCode: "missing" }]`；NPC 行动排程延时事件：`npcActions[].effects: [{ type: "enqueueEvent", eventId: "ev-shadow-deal", delay: { kind: "relative", after: { value: 2, unit: "day" } } }]` | R2.5/R2.6 |
| `packages/shared/src/schema/event.ts` | `EventTriggerSchema`：window/delay/cooldown；`action-hook→action_trigger`；退役 `atTurn/cooldownTurns`；`ChainStepSchema.delay` | R2.5 |
| `packages/shared/src/schema/event-instance.ts` | `EventInstanceOrigin.kind` 扩展（opening/schedule-init/effect/pool）；与 `ScheduledEventInstance` 合并或引用（实施时二选一，避免两套实例类型并存——推荐直接扩展本文件为统一实例 schema） | R2.5 |
| `packages/shared/src/v2.ts` | `WorldStateV2` 新字段（§5）；`eventFires`/`lastFiredIndex` 类型；`PendingEvent` 注释收窄 | R2.5 |
| `packages/shared/src/v2-state.ts` | 存档 Schema 同步 + schemaVersion 2 | R2.5 |
| `packages/game-core/src/v2/scheduler.ts`（新） | `enqueueScheduled` / `drainScheduledEvents` / `evaluateDue` / `cmp` / `evaluateChain`——调度唯一入口 | R2.5 |
| `packages/game-core/src/v2/turn.ts` | 删 `resolveScheduleV2` 全模板扫描；管线步骤 3 改 drain；`enqueuePendingEvent` 保留（槽位呈现队列）；pool 改入队；`onCooldown` 改时间维度 | R2.5 |
| `packages/game-core/src/v2/engine.ts` | `EffectSchema` 消费：+`enqueueEvent`；`advanceChain` 写入口收口；+`setNpcLifecycle`（R2.6） | R2.5/R2.6 |
| `packages/game-core/src/v2/opening.ts` | `handoff` schedule 改真正入队；删 `openingScheduled` flags | R2.5 |
| `packages/game-core/src/v2/npc.ts` | 判活过滤；冷却迁移（R2.6） | R2.6 |
| `packages/game-core/src/v2/projection.ts` | `projectNpc()`（R2.6）；npcs 投影增 lifecycle 标注 | R2.6 |
| `packages/game-core/src/v2/time.ts` | `CalendarAdapter` 增 `toMinutes(amount, from)`/`ageAt`；模板 `calendar.preset` 声明位 | R2.5（接口）/R2.6（实现①） |
| `packages/game-core/src/v2/relations.ts`（新） | 亲属/师承推导 + 环检测 | R2.6 |
| `packages/shared/src/schema/character.ts` | +lifecycle/birthTime/parents/masterId/projection 配置（R2.6） | R2.6 |
| `specs/data/templates/jjk-2006/events.yaml` / `characters.yaml` | 触发字段迁移 + 投影声明 | R2.5/R2.6 |
| `apps/server`、`apps/web` | 存档信封 version 2；快照字段展示 | R2.5/R2.6 |
| 相关测试（v2.test.ts、ending-*.test.ts 等） | RNG 序列变化重录基线；`atTurn` 退役迁移（v2.test.ts:737/768）、`nextTurn` 去留所依（v2.test.ts:711/786，随 Q-R25-06）、`cooldownTurns` 换形；新增 scheduler/relations 单测 | R2.5/R2.6 |

---

## §7 待决问题（不自行拍板）

| 编号 | 问题 | 可选方案 | 推荐 | 影响面 |
|---|---|---|---|---|
| Q-R25-01 | `action-hook` 是否改名为 `action_trigger`（**用户原话用词 vs 现协议词**，§0 结论 6 已给推荐） | A 改名对齐用户词汇〔推荐〕：正逢本次模板迁移窗口（strict schema 变更本就要求全模板重写 + 指纹升级），边际成本 = jjk-2006 1 处 + 协议 §8/§12 文档 + v2.test.ts 夹具少量换形；B 保留 `action-hook` 并在设计/协议注明「= 用户所称 action_trigger」：省一次改名，但两套词汇永久并存，后续沟通持续折价 | A | event.ts、common.ts（无）、jjk-2006 1 处、TEMPLATE_PROTOCOL_V2.md §8/§12、v2.test.ts 夹具 |
| Q-R25-02 | pool 抽中后的 `delay` 缺省值 | A 缺省 `relative 0`（≈现状立即呈现）／B 必填 | A（平滑兼容 5 个现存 pool 事件） | scheduler、event.ts |
| Q-R25-03 | drain 判定失败的处置 | A 混合（once/概率丢弃记错失，条件/冷却留队）〔推荐〕／B 全丢弃／C 全留队至窗口结束 | A | scheduler、missedEvents 语义 |
| Q-R25-04 | `cooldownTurns` 退役范围 | A 仅事件触发冷却改时间维度，NPC 行动/技能冷却 R2.6 再议〔推荐〕／B 本轮全改 | A | event.ts、npc.ts |
| Q-R25-05 | 时间模型默认与实现范围 | A 本轮只实现①近似历法，接口预留②③，模板声明位就绪〔推荐〕／B 本轮实现②公历／C ③农历（引 lunar-javascript） | A（待用户确认「三种都要支持」的交付边界） | time.ts、world.yaml |
| Q-R25-06 | `advanceWhen: nextTurn` 是否随 `atTurn` 一并退役 | A 保留（「下一轮」是槽位语义非时间量）〔推荐〕／B 退役（链步骤全走 onSettle+delay） | A | ChainStepSchema |
| Q-R25-07 | 角色 `visibility: public\|hidden` 静态开关去留；「绕过判活」是否提供模板一等开关 | A 保留 visibility 做 AND 闸 + 不提供绕过（复活即 alive）〔推荐〕／B 删 visibility 合并进 projection／C 提供参与开关 | A | character.ts、projection.ts |
| Q-R25-08 | 玩家是否与 NPC 统一 birthTime 派生年龄（退役 `playerAgeAtStart + elapsedYears`） | A 统一〔推荐〕／B 玩家保留现状 | A | v2.ts、turn.ts:565、engine.ts:361 |
| Q-R25-09 | 旧存档策略 | A schemaVersion 2 + 拒载〔推荐〕／B 自动迁移 | A | v2-state.ts、server/store |
| Q-R25-10 | inactive NPC 的 affinity/关系是否冻结 | A 冻结写入口（③ 默认判活的一部分）〔推荐〕／B 照写（死后关系仍可变） | A | engine.ts、relations |

---

## §8 分阶段实施建议

**R2.5：事件的实例化与延时队列**（本轮交付范围）

| 顺序 | 动作 | 产出 | 前置依赖 |
|---|---|---|---|
| 1 | ADR-0010/0011/0012 评审通过（已落盘待批） | `docs/DECISIONS.md` | 用户/主控裁决 §7 中 Q-R25-01/02/03/05 |
| 2 | shared schema：`TimeExpr`、`EventTriggerSchema` 迁移表、`ScheduledEventInstance`（扩展 event-instance.ts）、`WorldStateV2` 新字段 + v2-state.ts | schema 层 | 1 |
| 3 | `v2/scheduler.ts`：cmp/排序/enqueue/drain/evaluateDue/evaluateChain 纯函数 + 单测（到期/过期/once/条件 hold/概率 drop/RNG 序断言） | 调度器 | 2 |
| 4 | turn.ts 接线：删 `resolveScheduleV2` 扫描、步骤 3 改 drain、pool 改入队、opening.handoff 真入队、删冗余 flags | 管线 | 3 |
| 5 | jjk-2006 events.yaml 迁移 + 测试基线重录 + 全量回归 | 模板与测试 | 4 |
| 6 | server 存档 schemaVersion 2 | 持久化 | 2 |

**R2.6：NPC 生命周期与关系**（下一轮）

| 顺序 | 动作 | 前置依赖 |
|---|---|---|
| 1 | `character.ts` + `V2Npc`：lifecycle/birthTime/parents/masterId/infoVisibility + `setNpcLifecycle` 效果 + `npcState` 条件 | R2.5 全部；Q-R25-07/08/10 裁决 |
| 2 | 默认判活四处接线（npc.ts/battle.ts/engine.ts） | 1 |
| 3 | `projectNpc()` + projection 配置 + jjk-2006 characters.yaml（含「开局已死亡的重要角色」样例） | 1 |
| 4 | `time.ts` CalendarAdapter 接口落地 + ageAt（近似历法实现①） | Q-R25-05 裁决 |
| 5 | `relations.ts` 推导 + 环检测 + relationLog + relationSource flags 迁移 | 1 |
| 6 | NPC 行动冷却迁移时间维度（Q-R25-04 B 案若选） | 1 |

**不做什么（本轮明确边界）**：真实历法/农历实现、多跳亲属称谓计算、通用关系 yaml 模板机制（用户自述后续自做）、NPC 物品逻辑、时间穿越（R3/ADR-0005）、六阶段 Lifecycle（ADR-0004 禁令）。
