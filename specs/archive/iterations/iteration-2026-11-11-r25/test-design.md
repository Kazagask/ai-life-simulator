# R2.5 测试设计（实施前置蓝本）

**状态**：草案 v1（2026-11-11，实施开始前设计）｜**范围**：R2.5（事件模型 + 三层分离）与 R2.6（NPC 生命周期）的测试用例设计与测试世界模板规划；**只设计，不实现**——本文档不修改任何实现代码、测试代码、模板 yaml 文件，唯一产物是本文件。
**上游依据**：`specs/iteration-2026-11-11-r25/README.md` → `requirements.md` → `design.md`（§2 三层模型、§3 事件模型、§4 NPC、§5 迁移、§7 Q-R25-01..10、§0.3 第二批裁决）、`docs/DECISIONS.md` ADR-0010/0011/0012（**已通过 2026-11-12 G1 评审**，评审修订与第二批裁决已并入正文）、`docs/OPEN_QUESTIONS.md` #34–#46（第一批/第二批裁决已回填）、`AGENTS.md` §4（四类测试口径）与 §1（确定性不变量）。
> ## ⚠️ 2026-11-12 评审后待同步（本文档为 v1 草案，实施前必须对齐）
>
> 用户 2026-11-12 评审修订了设计（`design.md` §0.2 为第一批权威口径、**§0.3 为第二批裁决权威口径**）。本文件内以下 v1 表述**已过时**，T1-09 需按下表逐项改写用例与测试夹具（**本文不宣称已同步**）；第 11–14 项为 2026-11-12 第二批裁决新增：
>
> | # | v1 表述 | 修订后 |
> |---|---|---|
> | 1 | `action_trigger` 改名、TC-ADR11-26 双案（Q-R25-01） | **保留 `action-hook` 不改名**；夹具 `ev-action-probe` 写 `action-hook`；另加一条「action-hook 声明 window ⇒ 延时入队」用例 |
> | 2 | `TimeExpr { kind: absolute\|relative }`、TC-TIME-08 双形态、模板 fixture 里的 `start: { kind: absolute, at: ... }` | 单一 **`TimeSpec`**（`{ value, unit }` / 字符串），默认相对入队时刻；`resolveTimeSpec(spec, now, calendar)`；所有 fixture 时间字段换形 |
> | 3 | 判定序 once→conditions→cooldown→probability、错失原因含 `once_fired`/`probability_failed` | **入队门控前置**（once/概率/pool 条件），出队仅 missWhen→conditions→cooldown→fire；`MissReason` 仅 `window_expired\|miss_when`；新增「门控失败零错失记录」用例 |
> | 4 | TC-ADR11-17「drain 跳过序 4」、pool 概率留在抽取时 | pool 门控决定是否入池；drain 不再掷概率骰；新增「无窗口 pool ⇒ 0 延时、下次 drain 触发」用例 |
> | 5 | 无 combat 入池限制 | 新增「加载期拒绝 `source: pool` + `kind: combat`」与「normal/random → 链立即步触发战斗」用例 |
> | 6 | `MAX_SAFE_INTEGER` 当 +∞ 哨兵（TC-ADR11-05 等） | `end: undefined` + `hasEnd: false`；排序三键的「end 空视为最大」改由 `hasEnd` 分支断言 |
> | 7 | `chooseOptionV2` 不推进轮次、事件 `elapsed: 0` | **结算推进 `turnIndex` +1**；`timeCost` 缺省 0、非 0 推进 `worldTime`；战斗结束算/用物品不算；多事件逐轮呈现 |
> | 8 | 实例含 `snapshot.conditions/probability` | 实例**不复制配置字段**；新增存档/实例静态扫描断言（R-EV-15） |
> | 9 | 「多跳亲属称谓不做」、OQ #40 双案 | R2.6 分层复用 `relationship.js`；新增断代 gap、多跳称谓、确定性、库不可用退化用例（R-NP-08） |
> | 10 | Q-R25-01/02/03、OQ #34/#37/#38/#40/#42 双案标注 | 均已关闭，按 `design.md` §0.2 / `tasks.md` 回填表重写断言，删除双案分支 |
> | 11 | #35 加载期三用例 | **新增**：#35「加载期静态拒绝」三组用例——① 同一 `onActionId` 挂 1 条立即 + N 条声明 `window/delay` 的延时 `action-hook` → 加载合法；② 同一 `onActionId` 挂 2 条均未声明 `window/delay` 的立即 `action-hook` → 加载报错且提示「可为后续 hook 声明 window/delay 转为延时」；③ 同一 `onActionId` 全为延时 `action-hook` → 加载合法；延时 `action-hook`/chain 延时步/schedule/pool 不受约束（关联 TC-ADR11-21..23） |
> | 12 | #36 hold/过期用例 | **新增**：#36「留在队列」用例——窗口内 `conditions`/`cooldown` 不满足一律 hold 留队、每轮 drain 重估且零错失记录；仅 `worldTime > window.end` 才出队并追加 `reason="window_expired"`；无 `window.end` 永不因时间过期、由显式 `missWhen` 兜底；门控失败不构成错失（关联 TC-ADR11-09..13） |
> | 13 | #41 合并投影单一入口用例 | **新增**：#41「合并」用例——`visibility: public\|hidden` 并入 `projectNpc()` 单一判定入口、不存在与动态已知标记并行的第二套 AND 判定；`R-VS-03`/`isPlayerVisible()` 历史可见性口径不变（关联 TC-ADR12-09..13） |
> | 14 | #44/#45 本轮不测字符串字面量与上界 | **标注**：本轮 R2.5 不测 `TimeSpec` 字符串时长/历法日期字面量（#44 方向定 A、实现延期）与 `MAX_WORLD_TIME` 数值上界拒载/年号渲染（#45 保持现状、下期决策）；相关 TC-TIME-* 负向用例顺延下一期 |
>
> **本轮 R2.5 只实现 `TimeAmount`、无世界时间上界校验**：字符串 `TimeSpec` 只留 `CalendarAdapter.parseTimeSpec` seam、不做加载期解析；`worldTime` 维持 number 分钟、不加数值上界拒载；②③ 历法实现顺延下一期（R2.6）首批。
>
> **实施纪律**：先改本文件再写测试代码；RNG 基线因结算轮/门控前置需整体重录（§3.4.5「同 seed 序列变更」）。

**模板格式参照**：`specs/data/templates/jjk-2006/`（现行 schema 形态）+ `design.md` §3.1 字段迁移表的新写法（`window` / **`TimeSpec`** / `cooldown` / `timeCost` / `ChainStep.delay` / `enqueueEvent` / `setNpcLifecycle` / `spawnNpc`）。
**基线**：R2.4b（7912493），typecheck 0 错误，245 tests 绿。本文档所有「新模型期望」均以 ADR-0010/0011/0012（**已通过 2026-11-12 G1 评审**，评审修订与第二批裁决已并入正文）为准；第二批裁决的新增/调整用例见顶部第 11–14 项。

------------------------------------------------------------------------

## 0. 用例 ↔ 需求 / ADR ↔ 待决问题 追溯矩阵

用例编号规则：`TC-ADR10-xx`（三层分离）、`TC-ADR11-xx`（事件模型与队列）、`TC-ADR12-xx`（NPC 生命周期，R2.6 执行）、`TC-TIME-xx`（时间模型）、`TC-UI-xx`（UI 冒烟，实施完成后执行）。

| 用例组 | 需求 | ADR | 待决依赖 | 执行批次 |
|---|---|---|---|---|
| TC-ADR10-01..03 | R-LM-01/03 | ADR-0010 决策 1 | — | R2.5 |
| TC-ADR10-04..06 | R-LM-02/03 | ADR-0010 决策 1/2 | — | R2.5 |
| TC-ADR10-07..09 | R-LM-01（§2 硬约束） | ADR-0010 决策 1/3 | — | R2.5 |
| TC-ADR11-01..03 | R-EV-05 | ADR-0011 决策 2 | — | R2.5 |
| TC-ADR11-04..06 | R-EV-04 | ADR-0011 决策 2 | **OQ #37（Q-R25 相对基准）** | R2.5 |
| TC-ADR11-07..08 | R-EV-08 | ADR-0011 决策 1/3 | — | R2.5 |
| TC-ADR11-09..13 | R-EV-06/07 | ADR-0011 决策 3 | Q-R25-03 / **OQ #36** | R2.5 |
| TC-ADR11-14 | R-EV-07 | ADR-0011 决策 3 | — | R2.5 |
| TC-ADR11-15..17 | R-EV-08 | ADR-0011 决策 1 | **Q-R25-02 / OQ #38** | R2.5 |
| TC-ADR11-18..20 | R-EV-10 | ADR-0011 决策 6 | Q-R25-06（nextTurn 去留） | R2.5 |
| TC-ADR11-21..23 | R-EV-01/02/03 | ADR-0011 决策 1/5 | **OQ #34 / #35** | R2.5 |
| TC-ADR11-24..26 | R-EV-09 | ADR-0011 决策 4 | Q-R25-01 | R2.5 |
| TC-ADR11-27..28 | R-NFR-01（确定性） | ADR-0010/0011 §3.4.5 | — | R2.5 |
| TC-ADR11-29 | 存档兼容 | ADR-0010/0011 §5 | Q-R25-09 | R2.5 |
| TC-ADR11-30..31 | R-EV-01（守卫）/效果引用完整性 | ADR-0010 | — | R2.5 |
| TC-ADR12-01..02 | R-NP-02/03 | ADR-0012 决策 1 | — | **R2.6** |
| TC-ADR12-03..08 | R-NP-02/03 | ADR-0012 决策 2 | Q-R25-10（关系冻结） | **R2.6** |
| TC-ADR12-09..13 | R-NP-01 | ADR-0012 决策 3 | **Q-R25-07 / OQ #41** | **R2.6** |
| TC-TIME-01..04 | R-NP-04 | ADR-0012 决策 4 | Q-R25-08（玩家统一 birthTime） | R2.5（接口）/ R2.6（ageAt） |
| TC-TIME-05..06 | R-NP-04（不锁死单模型） | ADR-0012 决策 4 | **Q-R25-05 / OQ #39** | R2.5 |
| TC-TIME-07 | （前向占位） | ADR-0012 决策 4 | **blocked-by Q-R25-05** | 未来迭代 |
| TC-TIME-08 | R-EV-04 | ADR-0011 决策 2 | — | R2.5 |
| TC-UI-01..06 | 端到端冒烟 | — | — | R2.5 实施完成后 |

**不实现 / 不测试 / 不计入 DoD 的范围**（范围污染禁令）：

- `R-NP-07`（DEFERRED，通用 yaml 关系机制）——无任何用例。
- R2.3 的 `R-TS-01..05`（既有 DEFERRED）——状态不变，无任何用例。
- OPEN_QUESTIONS #21–#25（NPC 生命周期/留存/清理的引擎级细节）——本轮 `R-NP-*` 只承接上层口径，底层细节不写用例。
- 时间穿越（R3/ADR-0005）、六阶段 Lifecycle（ADR-0004 禁令）、真实公历/农历实现（#39/#43 继续延期，下一期 R2.6 首批，本轮只留声明位与负向用例）、字符串 `TimeSpec` 字面量与世界时间数值上界（#44/#45 顺延下一期，见顶部第 14 项）。
- V1 引擎残留符号（`evaluateLife` / 旧 `advanceTurn(` / `lifecycle.ts` / `PhaseTransitionLog`）不得出现在任何用例的前置或期望中（见 §9 扫描清单）。

------------------------------------------------------------------------

## 1. 通用约定

### 1.1 用例分类口径

每条用例标注四类之一（AGENTS.md §4）：

- **正常**：合法输入 + 预期内交互的黄金路径。
- **边界**：合法输入 + 极端/临界条件（同键排序、窗口端点、end 缺省、enqueueSeq 并列、跨 drain 等）。
- **无效输入**：schema 层应拒绝的模板/存档（atTurn、cooldownTurns、非法 preset、旧 schemaVersion 等），期望 = 加载期报错且错误信息可诊断（含字段路径与替代写法提示）。
- **类型检查**：不单列用例，随每批次 DoD 执行 `pnpm typecheck`（0 错误为硬门禁）。

### 1.2 确定性口径（R-NFR-01）

- 所有引擎用例使用注入 seed 的 RNG（`RunnerContext` 注入，禁 `Date`/`Math.random`）。
- 确定性断言双层：① 同 seed 同输入两次运行，逐字段比对（事件序列、转盘结果、`missedEvents`、`eventFires`、快照投影）；② RNG 消耗顺序断言（TC-ADR11-28）。
- **显式声明（ADR-0011 后果）**：R2.5 实施后，同 seed 下的事件触发序列相对 R2.4b **会改变**（drain/pool 的 RNG 调用时机与次数不同）。这不违反确定性不变量，但依赖具体事件序列的旧回放断言须按 §8 清单重录，重录报告须注明「同 seed 序列变更（ADR-0011）」。

### 1.3 夹具构建约定

- **模板级用例**：从 `specs/data/templates/<world-id>/` 目录按现行 `loadJjkTemplate()` 同型加载器（`v2.test.ts` 顶部六文件合并 → `WorldTemplateV2Schema.parse`）加载真实模板目录，经 `createWorldV2` / `createActiveWorldV2`（`v2/test-utils.ts`）建局。三个新模板目录**实施阶段才落盘**（本设计稿见 §6），实施前用例不得引用不存在目录。
- **纯函数级用例**：`scheduler.ts` 的 `cmp` / `evaluateDue` / `evaluateChain` 用手工构造的 `ScheduledEventInstance[]` / `WorldStateV2` 片段直测，不建整局（对齐 T1-03 DoD「三键排序用例」「RNG 消耗顺序写进注释」）。
- **无效输入用例**：内联 YAML 字符串片段（不落 `specs/data/templates/`），直接喂 `WorldTemplateV2Schema.parse` / 加载器，断言抛错与错误信息。
- 世界时间换算基准（近似历法 ①）：1 分钟 = 1，1 小时 = 60，1 天 = 1440，1 年 = 525600。

### 1.4 待决项标注规则

期望结果依赖 OPEN_QUESTIONS #34/#35/#36/#37/#38/#39 或 Q-R25-01..10 的用例，一律**双案并列**写期望（「案A ⇒ 期望X」/「案B ⇒ 期望Y」），并标注编号；实施者不得在裁决前只实现单案期望。裁决回填后，未选中案的期望删除、选中案期望去标注化。

------------------------------------------------------------------------

## 2. ADR-0010：配置 / 实例 / 事实三层分离（TC-ADR10）

前置（无特别说明时）：`test-scheduler-core` 模板（§6.1）+ seed `20251111`，通过 `createActiveWorldV2` 建局后推进若干轮。

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR10-01 | 正常 | R-LM-01 | 同上 | 建局后对 `WorldTemplateV2` 做深拷贝快照；推进 30 轮（含事件触发、入队、过期、错失）；快照深比对 | 模板对象逐字段不变（加载后只读）；模板指纹（sha256）不变 |
| TC-ADR10-02 | 正常 | R-LM-01 | 同上 | 任取一次触发结算，检查该变更的落点 | 每条运行期变更落在实例层（`scheduledEvents[].status`、`chains[].stepIndex` 等）或事实层（`eventFires` / `missedEvents` / `history`）之一；无任何写回模板对象的路径 |
| TC-ADR10-03 | 正常 | R-LM-03 | 同上 | 构造同 eventId 多次触发（`ev-sched-once-victim` 因 enqueueEvent 二次入队判定，见 TC-ADR11-11a）；对 `eventFires` 在 T 时刻与 T+10 轮各做快照深比对 | ① 同 eventId 多次触发产生多条独立日志；② 每条记录自写入起逐字段不变（append-only）；③ `lastFiredIndex[eventId]` 取日志最后一条 |
| TC-ADR10-04 | 边界 | R-LM-03 / ADR-0010 决策 1 | 上述状态 | 人工篡改 `lastFiredIndex`（删除键 / 改成过期值）后触发重建逻辑（存档加载、或防御性校验路径） | 索引从 `eventFires` 日志重建；once/冷却/eventOccurred 判定以日志为准；重建结果与篡改前语义一致 |
| TC-ADR10-05 | 边界 | R-LM-02 | 同上 | 让 NPC 死亡（`setNpcLifecycle`）、链推进、事件入队各发生一次，比对前后 `state.flags` 集合 | flags 集合不变（引擎内部记录不写 flag 命名空间）；生命周期判定输入不含 flag（`evaluateDue` / `evaluateChain` / 判活均读实例字段） |
| TC-ADR10-06 | 正常 | R-LM-02 / ADR-0010 决策 2 | jjk-2006 或 test-scheduler-core | 推进若干轮后检查人生评价输入与残留 | `turnsPlayed` flag 不再写入（全仓库 grep 零命中，见 §9）；评价消费点读 `turnIndex`，评价结果与重构前语义等价（同输入同分） |
| TC-ADR10-07 | 边界 | R-LM-01 / ADR-0010 §2 硬约束 1 | 手工构造 state：`scheduledEvents` 含 1 条到期实例；模板 `events` 含 50 条窗口在未来的 schedule 定义 | 执行 `drainScheduledEvents` | 仅队列中到期实例被判定/触发；未入队定义零接触。辅以静态断言：`turn.ts` 生产路径无 `template.events` 遍历（除入队与 pool 抽取，T1-04 DoD 同款） |
| TC-ADR10-08 | 边界 | ADR-0010 §2 硬约束 3 | 手工构造 state：仅含 `eventFires` 若干条，无任何 scheduledEvents / chains / pendingEvents | 推进 10 轮（只做自由行动） | 无任何事件被触发（事实不得反向驱动调度；触发源仅有玩家行动、效果 DSL、队列到期三种） |
| TC-ADR10-09 | 正常 | ADR-0010 决策 3 | 手工构造同一 `(instance, worldTime, facts)` 输入对 | 调用 `evaluateDue` 两次并深比对 | 两次返回完全一致（纯函数、无隐藏读取）；签名外状态（全局变量/模块缓存）变化不影响结果 |

------------------------------------------------------------------------

## 3. ADR-0011：事件触发收敛 + 延时队列（TC-ADR11）

### 3.1 队列结构与排序（R-EV-05）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-01 | 边界 | R-EV-05 | 纯函数：手工构造 5 条实例——D(start 9d, end 11d, seq 4)、E(start 10d, end 12d, seq 1)、A(start 10d, end 12d, seq 2)、C(start 10d, end 12d, seq 3)、B(start 10d, end undefined, seq 5) | 执行 `cmp` 排序 / `sortScheduled` | 出队序 = D → E → A → C → B：start asc（D 最先）→ 同 start 同 end 按 enqueueSeq asc（E/A/C）→ end undefined 视为 +∞ 排同 start 最后（B） |
| TC-ADR11-02 | 正常 | R-EV-05 | 同 TC-ADR11-01 输入 | 排序两次并比对 | 出队序列逐条目一致（enqueueSeq 全局唯一 ⇒ 全序严格、排序幂等、与插入方式无关） |
| TC-ADR11-03 | 正常 | R-EV-05 | test-scheduler-core + seed | 建局后检查 `enqueueSeqCounter`；触发若干次入队后存档→读回；再入队一条 | 计数器单调递增不回退；存档往返逐字段相等；读回后新入队实例的 seq 接续递增且全局唯一；队列不使用 `Infinity`（JSON 序列化安全，undefined 哨兵口径按 Q-R25-03 附带裁决二选一） |

### 3.2 时间窗口与 TimeExpr（R-EV-04）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-04 | 正常 | R-EV-04 | test-scheduler-core | 建局后检查 `ev-sched-day2` / `ev-sched-windowed` 的实例 | `window.start = 2880`（2d）/ `window = { start: 4320, end: 8640 }`（3d–6d）；origin = `schedule-init`；status = waiting |
| TC-ADR11-05 | 正常 | R-EV-04 | 同上，seed 固定 | 推进到第 7 日触发 `ev-enqueue-repeat`，选「重复召唤」选项（`enqueueEvent ev-sched-once-victim delay relative 1d`，当时 worldTime = W₇） | 新实例 `enqueuedAt = W₇`、`window.start = W₇ + 1440`（换算为分钟标量固化）；此后再推进 30 轮，`window` 逐字段不变（入队即固化，后续时间推进/前拨不影响） |
| TC-ADR11-06 | 边界 | R-EV-04 | 同 TC-ADR11-05 | 同输入重复两次运行 | 两次的 `window.start` 完全一致（换算可复现）。**双案标注【OQ #37】**：案①（推荐，入队时刻基准）⇒ 如上；案②（世界起点基准）⇒ `window.start = 1440`（与世界起点偏移 1d），与 W₇ 无关。案②下 TC-ADR11-05 期望同步改写 |
| TC-TIME-08 | 正常 | R-EV-04 | 纯函数 | `resolveTimeExpr({kind:"relative", after:{value:3,unit:"day"}}, now=7200)` 与 `resolveTimeExpr({kind:"absolute", at:{value:1,unit:"day"}}, now=任意)` | relative → `7200 + 4320 = 11520`；absolute → `1440`（与 now 无关）；换算经 CalendarAdapter（可注入历法） |

### 3.3 drain 与判定顺序（R-EV-06/07，Q-R25-03 / OQ #36）

**判定顺序固定：once → conditions → cooldown → probability（不得重排）**。以下按设计推荐处置（once/probability = drop 记错失；conditions/cooldown = hold 留队）编写；**若 Q-R25-03 / OQ #36 裁决改变处置**（全丢弃 / 全留队至窗口结束），受影响用例为 TC-ADR11-11b/11c/11d 与 TC-ADR11-12，期望按裁决改写，判定顺序用例（TC-ADR11-11 整组）不变。

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-11a | 边界 | R-EV-06 / Q-R25-03 | e2e：test-scheduler-core；`ev-sched-once-victim` 已于第 1 日触发；第 7 日 `ev-enqueue-repeat` 经 `enqueueEvent` 再次入队同 eventId（TC-ADR11-05 的后续） | 推进到第 8 日 drain | 序 1 命中：once 判定失败 ⇒ 实例 `status = "expired"`，`missedEvents` 追加一条 `{definitionId: "ev-sched-once-victim", reason: "once", ...}`；不占轮次槽位、无 history 触发条目 |
| TC-ADR11-11b | 边界 | R-EV-06 | 纯函数：实例 conditions 引用 `flag condGate eq true`，facts 中 condGate = false，window 含 now | `evaluateDue` | 返回 hold（留队）；不消耗 RNG；不写 missedEvents。e2e 对应 TC-ADR11-09/10 |
| TC-ADR11-11c | 边界 | R-EV-06 | 纯函数：实例 cooldown = 2d，`lastFiredIndex[id] = {worldTime: t0}`，now = t0+1d | `evaluateDue` | 返回 hold（冷却未满，留队）；now = t0+2d 时返回 fire（时间维度冷却，非轮次维度） |
| TC-ADR11-11d | 边界 | R-EV-06 / Q-R25-03 | e2e：`ev-sched-prob-zero`（probability: 0，window 5d–30d） | 推进到第 5 日 drain | 序 4 掷骰失败 ⇒ 一次性判定（无重掷）：`status = "expired"`，`missedEvents` 追加 `reason: "probability"`；此后每轮 drain 不再为该实例消耗 RNG |
| TC-ADR11-11-order | 边界 | R-EV-06 | 纯函数：构造同时满足「once 已触发 + 条件满足 + 冷却未满 + probability 1」的实例 | `evaluateDue` | 返回 drop（once 序最先，短路后续判定）——证明判定顺序固定不可重排 |
| TC-ADR11-09 | 正常 | R-EV-06 | e2e：`ev-sched-windowed`（条件 condGate，窗口 3d–6d）；`ev-sched-gate-setter` 第 4 日置位 condGate | 推进第 3–6 日 | 第 3 日 drain：条件不满足 ⇒ hold 留队；第 4 日 gate-setter 触发后，第 5 日 drain：条件满足 ⇒ 触发（入队时不满足、出队时满足） |
| TC-ADR11-10 | 正常 | R-EV-06 | e2e：同上但不执行 gate-setter 的置位选项（选放弃选项，无 condGate 效果） | 推进到第 6 日之后 | 窗口内持续 hold，第 6 日（end）过后 `status = "expired"` + `missedEvents` reason `"expired"`（入队满足、出队不满足的到期自然淘汰路径） |
| TC-ADR11-12 | 边界 | R-EV-07 / Q-R25-03 | e2e：队列中含一条过期实例 + 一条同窗可触发实例（如第 5 日：prob-zero 过期、sched-day2 之后某实例到期） | drain 该日 | 过期实例标记 expired + 记错失后 **continue**（继续判定下一个），不提前终止 drain；可触发实例正常触发 |
| TC-ADR11-13 | 边界 | R-EV-05 | 纯函数：有序队列中首条 start > now，其后 3 条更晚 | `drainScheduledEvents` | 循环立即 break；后续实例 status 不变、零 RNG 消耗（有序队列语义：start > now 即停） |
| TC-ADR11-14 | 正常 | R-EV-07 | e2e：同 seed 构造同窗 3 条可触发实例（TC-ADR11-01 的 E/A/C 三条在 10d 到期，条件全满足） | 推进到第 10–12 日 | 3 条均完成出队判定并触发（或按到期规则处置），无静默丢弃、无合并；呈现次序 = 排序键序（同 start 同 end 按 seq） |

### 3.4 schedule 初始化 / opening handoff（R-EV-08）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-07 | 正常 | R-EV-08 | test-scheduler-core | `createWorldV2` 完成、第 0 轮结算前检查 `state.scheduledEvents` | 模板全部 schedule 事件（本模板 8 条）均已有实例（origin = `schedule-init`，status = waiting，window 按定义固化）；`resolveScheduleV2` 不存在（§9 静态扫描） |
| TC-ADR11-08 | 正常 | R-EV-08 / R-LM-02 | jjk-2006（迁移后）或 test-scheduler-core 带 opening | 执行 opening 抽取 + handoff | schedule 事件真正入队为实例（而非写 `flags["openingScheduled:<id>"]`）；flags 集合无任何 `openingScheduled:*` 键（§9 零命中） |

### 3.5 pool 降格为抽取器（R-EV-08，Q-R25-02 / OQ #38）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-15 | 正常 | R-EV-08 | e2e：test-scheduler-core，pool 抽中任一事件（概率/权重抽取由 seed 决定，用同 seed 重放定位抽中轮） | 抽中当轮检查 `pendingEvents` 与 `scheduledEvents` | 抽中 ⇒ **入队**（新实例 origin = `pool`）而非当轮槽位呈现：`pendingEvents` 无该事件条目；`triggerEventV2` 未被抽取点调用 |
| TC-ADR11-15-def | 边界 | Q-R25-02 / OQ #38 | 同上，抽中 `ev-pool-default0`（无 delay 声明） | 推进至下一次 drain 入口 | **双案标注**：案A（推荐，缺省 `relative 0`）⇒ 入队后 `window.start = 抽中时刻`，由入口 3（入队即到期）内联触发，时序 ≈ 现状立即呈现；案B（delay 必填）⇒ `ev-pool-default0` 在加载期报错（错误信息含 `trigger.delay` 路径），`test-scheduler-core` 需为该事件补 delay 后方可建局。**OQ #38 案③**（继承事件自身窗口）：模板可另设带 `window` 的 pool 事件用例，抽中后按 `R-EV-04/05` 排队——期望与案A 用例结构相同，仅窗口来源不同 |
| TC-ADR11-16 | 正常 | R-EV-08 / Q-R25-02 | e2e：抽中 `ev-pool-delay3`（delay = relative 3d） | 抽中当轮 + 3 日 | 实例 `window.start = 抽中时刻 + 4320`；第 3 日 drain 触发（kind normal 占槽位呈现）；抽中至触发之间该事件不出现在任何 pendingEvents |
| TC-ADR11-17 | 边界 | design §3.7 | 纯函数/e2e：pool 事件自带 probability | 用计数 RNG 断言抽取与 drain 的骰子次数 | pool 事件的 probability/once/conditions 在**抽取时**过滤（现状口径）；drain 对 origin = pool 的实例**跳过判定序 4**（不重复掷概率骰）：抽中消耗 1 次概率骰 + N 次 weight 骰，drain 阶段为该实例消耗 0 次 |
| TC-ADR11-pool-once | 边界 | design §3.7 | e2e：`ev-pool-delay3`（once: true）已抽中入队 | 后续轮次 pool 抽取 | 该定义不再进入候选（once 在抽取时过滤），不会产生第二条实例 |

### 3.6 链与延时队列组合（R-EV-10，Q-R25-06）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-18 | 正常 | R-EV-10 | e2e：经 `ev-pool-chain-starter` 选项 `startChain chain-delay-demo`；链步 `ev-chain-day3` 声明 `delay: relative 3d` | 结算 `ev-chain-ann` 后立即检查；推进 3 日 | 结算时该步不入 `pendingEvents`，立即 `enqueueScheduled`（origin 记 chain 类 kind、`chainId = "chain-delay-demo"`、window = 结算时刻 +4320）；链状态保持 active（`evaluateChain` 靠队列实例判活）；3 日后 drain 触发并按 chainId 回归链优先级；随后 `ev-chain-finale`（nextTurn）正常推进。stepIndex 只按单一推进规则更新，无双写漂移 |
| TC-ADR11-19 | 边界 | R-EV-10 | 纯函数：① 队列存在 `{chainId, status: waiting}` 实例但 `stepIndex` 已指向越界位置；② 队列无该链条目且 `steps[stepIndex]` 不存在 | `evaluateChain(state, lookup, chainId)` | ① 返回 `"active"`（队列对账优先于 stepIndex——修复 M4 漂移的结构性断言）；② 返回 `"completed"`（断链）；③ 链实例缺失或已 completed ⇒ `"completed"`；④ 当前步 fired 未结算（pendingEvents 占槽）⇒ `"active"` |
| TC-ADR11-20 | 边界 | ADR-0011 决策 3 | e2e：drain 触发的事件其选项效果含 `advanceBy`，使另一条已 waiting 实例当场到期 | 该次 drain 结束后、下一 drain 入口前检查 | 到期实例**不在本次 drain** 触发（无递归 drain）；`timeAdvanced` 只置标记，由安全边界（下一轮管线步骤 3 / 效果推进后入口）统一消费；RNG 无重入消耗。断言：本次 drain 结束时该实例仍 waiting，下一入口时触发 |
| TC-ADR11-nextturn | 边界 | Q-R25-06 | e2e：chain-delay-demo 第 3 步 `advanceWhen: nextTurn` | 覆盖于 TC-ADR11-18 | **双案标注**：案A（推荐，保留）⇒ 结算 day3 后下一轮推进触发 finale，无 delay；案B（退役 nextTurn）⇒ 本模板 chains 需改写为 `onSettle + delay`，对应夹具 `v2.test.ts:711/786` 同步重设计（见 §8） |

### 3.7 槽位守卫与立即事件（R-EV-01/02/03，OQ #34 / #35）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-21 | 正常 | R-EV-02 | e2e：test-scheduler-core，执行 `probe` 行动（probability 1 ⇒ `ev-action-probe` 必触发） | 行动结算后检查 `state.scheduledEvents` 与呈现时机 | 立即事件**不产生延时队列条目**（scheduledEvents 无新实例）。**双案标注【OQ #34】**：案①（推荐，下一轮呈现并吃该轮槽位）⇒ 行动轮 = 纯行动无事件呈现；下一轮开局事件呈现，该轮 `pending_event_required` 拦截自由行动，`chooseOptionV2` 不推进 `turnIndex`（事件无独立轮次推进）；案②（现状，当前轮呈现）⇒ 行动与事件同轮呈现，选项不推进时间。两案下 random/combat 即时结算均不占槽位 |
| TC-ADR11-22 | 无效输入 | R-EV-03 | 内联夹具：同一 `onActionId: probe` 挂两条 `action_trigger` 事件的模板 | 加载 | **双案标注【OQ #35】**：案①（推荐，加载期静态拒绝）⇒ `WorldTemplateV2Schema.parse` 抛错，错误信息含重复 actionId；案②（运行期确定性首个胜出）⇒ 加载成功，运行时按 `EVENT_SOURCE_PRIORITY` + 确定性次序仅一条触发。未决前先落不变量部分（见 TC-ADR11-23） |
| TC-ADR11-23 | 正常 | R-EV-01 | test-scheduler-core，同 seed 推进 60 轮（混行动/事件/战斗外情形） | 逐轮检查结算产物 | 任一轮至多包含一个待决事件或一次自由行动，从不同时出现（**口径随 #34 双案**：案① = 二者不同轮并存；案② = 一轮至多一次行动 + 至多一个事件呈现）；`pending_event_required` 在槽位被占时拒绝新自由行动提交 |
| TC-ADR11-30 | 边界 | R-EV-01 | e2e：构造延时段落事件呈现中的状态 | 在事件待决时提交自由行动 | 请求被 `pending_event_required` 拒绝（语义收窄为「槽位被占用则拒绝自由行动」，含延时事件到期的待决） |

### 3.8 退役字段与效果 DSL（R-EV-09，Q-R25-01）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-24 | 无效输入 | R-EV-09 | 内联夹具：`trigger: { source: schedule, atTurn: 3 }` | 加载 | 报错；错误信息含 `atTurn` 字段路径与替代写法提示（`window.start` 绝对/相对时间） |
| TC-ADR11-25 | 无效输入 | R-EV-09 | 内联夹具：`trigger: { source: pool, probability: 0.3, cooldownTurns: 4 }` | 加载 | 报错；错误信息提示改用 `cooldown: TimeExpr`（时间维度） |
| TC-ADR11-26 | 边界 | Q-R25-01 | 内联夹具：`source: action-hook`（旧名） | 加载 | **双案标注**：案A（推荐改名）⇒ 过渡期 superRefine 双接受 + 告警；全部模板迁移完成后旧值拒绝（两阶段：过渡期用例 + 收尾期用例，收尾期在 T1-08 完成后把过渡期用例改为拒载断言）。案B（保留 action-hook）⇒ 旧值恒接受，`test-scheduler-core` 的 `ev-action-probe` 写 `action-hook` |
| TC-ADR11-31 | 无效输入 | 效果引用完整性 | 内联夹具：效果 `{ type: enqueueEvent, eventId: "ev-not-exist" }`；`{ type: setNpcLifecycle, npcId: "npc-not-exist", state: "alive" }` | 加载 | 报错且错误信息含字段路径（引用完整性，同 enemies[].ref 校验口径）；合法的 `enqueueEvent` / `setNpcLifecycle` 通过 strict 校验（EffectSchema 白名单扩两类，M11 缺口闭合） |

### 3.9 确定性与存档（R-NFR-01 / Q-R25-09）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR11-27 | 正常 | R-NFR-01 | test-scheduler-core，seed `20251111` | 同 seed 同输入序列完整运行 30 轮两次，逐字段比对：事件触发序列、转盘结果、`scheduledEvents`（含 status/enqueueSeq）、`eventFires`、`missedEvents`、`history`、最终快照 | 两次运行全部逐字段相等 |
| TC-ADR11-28 | 边界 | design §3.4.5 | 计数 mock RNG | 单独驱动 drain，含：1 条可触发（probability 1）、1 条 hold（条件不满足）、1 条未到期 | RNG 消耗 = 每个到期实例至多 1 次概率骰 + 条件内 RandomCondition 骰；hold 与未到期实例消耗 0 次；同输入两次 drain 消耗次数一致。RNG 消耗顺序作为规范注释写入 `scheduler.ts`（T1-03 DoD） |
| TC-ADR11-29 | 无效输入 | Q-R25-09 | 内联存档夹具：`schemaVersion: 1` 的合法旧结构信封 | 加载存档 | 拒载：加载器记 error 并跳过，错误信息可诊断（含 schemaVersion 期望值 2 与实际值 1）；`schemaVersion: 2` 信封正常读回（`WorldStateV2Schema` 新字段全量往返一致，T1-02 DoD） |

------------------------------------------------------------------------

## 4. ADR-0012：NPC 生命周期与投影解耦（TC-ADR12，R2.6 批次执行）

> 本组用例本次一并设计，**执行与验收在 R2.6 迭代**（`tasks.md` T2-01..T2-08）。前置默认使用 `test-npc-lifecycle` 模板（§6.3）+ seed `20251111`。

### 4.1 生命周期与默认判活（R-NP-02/03）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR12-01 | 正常 | R-NP-02 | test-npc-lifecycle 建局 | 检查四名 NPC 的 `lifecycle` | `npc-ghost-master` / `npc-sealed` = `{state: "inactive", reasonCode: ...}`；`npc-sleeper` = `unspawned`；`npc-normal` 缺省 `{state: "alive"}`（默认判活，模板零书写）；均有 `sinceTurn` / `sinceWorldTime`；无 `lifecycle.ts` 模块、无 Phase 枚举（§9 扫描） |
| TC-ADR12-02 | 正常 | R-NP-03 | 同上 | 对 `reasonCode: "dead"`（ghost-master）与 `reasonCode: "sealed"`（sealed）分别执行：NPC 行动环节、战斗引用、关系写入、条件求值 | 两者引擎行为**完全一致**（行动跳过/战斗整条跳过/关系冻结/条件正常求值逐项相同）；辅以静态扫描断言：引擎生产代码对 `reasonCode` 零分支（T2-02 DoD 同款） |
| TC-ADR12-03 | 正常 | R-NP-02 | 同上，推进多轮（npcActions 有 `tc-npc-train` 等行动） | 检查行动结算的 history | inactive / unspawned NPC 不产生任何 `npc_action` 历史条目；alive 的 `npc-normal` 正常行动（判活过滤发生在效用评分之前） |
| TC-ADR12-04 | 边界 | R-NP-02 / ADR-0012 决策 2 | 同上，触发 `ev-combat-vs-dead`（enemies 引用 `npc-ghost-master`） | 结算该事件 | 该场战斗**整条跳过**：不建战斗会话、不写触发历史、不消耗 once/冷却（沿用 combat 冲突口径）；追加一条事实记录（目标不可参战）；不建场期硬报错（「分支里先死、之后再引用同一 NPC 的战斗」是合法剧情）；`allies` 引用同规则（用 `ev-combat-ally-dead` 重复验证） |
| TC-ADR12-05 | 正常 | R-NP-02 / Q-R25-10 | 同上，触发 `ev-rel-to-dead`（`adjustRelation npc-ghost-master +5`） | 结算后检查关系数值 | **双案标注**：案A（推荐，冻结）⇒ 关系数值不变（跳过写入，不改数值），unspawned 同样冻结；案B ⇒ 照写（死后关系仍可变）。案B 裁决时本用例期望改为「数值按效果写入」 |
| TC-ADR12-06 | 正常 | R-NP-02 | 同上，`ev-cond-npcstate`（conditions 含 `{npcState: {npcId: "npc-ghost-master", state: "inactive"}}`） | drain 判定 | 条件正常求值（模板显式意图不被默认过滤）⇒ 触发；同条件对 `npc-sealed`（reasonCode sealed）同样成立——npcState 只匹配状态不匹配 reasonCode |
| TC-ADR12-07 | 正常 | R-NP-03 | 同上，`ev-revive-sleeper` 选项执行 `setNpcLifecycle npc-sleeper alive` | 结算后推进若干轮并再触发 `ev-combat-with-sleeper`（enemies 引用 sleeper） | sleeper 复活为 alive（sinceTurn/sinceWorldTime 更新）；复活后可参战、可行动、可被 npcState `{state: "alive"}` 命中；「绕过判活」无特权通道（复活只能经效果 DSL） |
| TC-ADR12-08 | 无效输入 | R-NP-03 / T2-06 | 内联夹具：`setNpcLifecycle` 的 `state: "dead"`（枚举外值）、`npcId` 不存在、reasonCode 空串 | 加载 | 均报错且错误信息含字段路径（state 合法值 ∈ alive/inactive/unspawned；reasonCode `min(1)`，值本身模板自由，如 dead/missing/sealed/fell 均合法） |

### 4.2 投影解耦（R-NP-01，Q-R25-07 / OQ #41）

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-ADR12-09 | 正常 | R-NP-01 | test-npc-lifecycle 建局，`npc-ghost-master` 声明 `projection: {alwaysVisible: true, showLifecycle: true}` | 请求玩家端快照投影 | 开局即 inactive(dead) 的重要角色**上屏**；alive 与 dead 的 NPC 投影可见性判定结果相同（可见性判定不读取 lifecycle 字段——可用同一投影函数分别喂 alive/dead 实例断言输出结构一致）；状态标注文案由模板 label 映射 reasonCode，引擎只下发 reasonCode 不下发语义解释 |
| TC-ADR12-10 | 正常 | R-NP-01 / ADR-0012 决策 3 | 同上，推进 2 年 | 检查投影 | `npc-ghost-master` 投影 `age` 冻结于 `sinceWorldTime`（不随世界时间增长）；`npc-normal` 的 `age` 随 worldTime 按 `ageAt(birthTime, now)` 增长；投影 `player.age` / `npcs[].age` 字段形状不变（前端零改动基线） |
| TC-ADR12-11 | 边界 | R-NP-01 / Q-R25-07 / OQ #41 | 同上，`npc-sleeper`（unspawned，infoVisibility unknown，无 alwaysVisible） | 请求投影 | **双案标注**：案A（推荐，保留 visibility 静态闸）⇒ `visibility: hidden`、动态 `infoVisibility: unknown`、`alwaysVisible` 三闸 AND 组合，任一关闭即不下发（sleeper 未登场不上屏；`npc-ghost-master` 因 alwaysVisible 恒上屏）。案B（删 visibility 合并单一判定）/ OQ #41 案① 合并投影入口时，本用例期望改为单一判定函数的等价输出，AND 语义保持 |
| TC-ADR12-12 | 无效输入 | ADR-0012 决策 1 | 内联夹具：条件 `{npcState: {npcId: "npc-x", state: "dead"}}`（"dead" 不是合法 state 值） | 加载 | 报错——`npcState.state` 合法值 ∈ alive/inactive/unspawned，业务语义（dead）只能经 reasonCode + 模板 label 表达，永不进条件 DSL |
| TC-ADR12-13 | 无效输入 | ADR-0012 决策 2 | 内联夹具：combat `enemies: [{ref: "enemy-not-exist"}]`；同局两名 NPC `id` 重复 | 加载 | 引用完整性报错（characterId 在模板中不存在 ⇒ 加载期报错）；重 id 报错（全库 id 唯一） |

------------------------------------------------------------------------

## 5. 时间模型（TC-TIME，Q-R25-05 / OQ #39）

> 现状裁决状态：design §3.5/§4.4 **推荐 R2.5/R2.6 只实现 ① 固定年长近似**，② 真实公历、③ 自定义历仅留 `world.yaml calendar.preset` 声明位（Q-R25-05 待用户确认）。因此 ②③ 用例分两层：(a) 当前实施的负向用例（TC-TIME-05/06，R2.5 执行）；(b) 未来实现的前向用例（TC-TIME-07，blocked-by Q-R25-05，本迭代**不执行不验收**）。

| 编号 | 分类 | 关联 | 前置 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-TIME-01 | 正常 | R-NP-04 / Q-R25-05 | test-time-models（无 calendar 声明，§6.2） | 建局并推进若干轮 | 未声明 calendar ⇒ 缺省采用 ① 固定年长近似历法（1 年 = 525600 分钟），全部现有时间/年龄行为不变 |
| TC-TIME-02 | 正常 | R-NP-04 | 同上（age 20 的 NPC = birthTime `-20×525600`） | 读取 age；经 `advanceBy 1 year` 效果推进世界时间后再读 | 读取点输出 = `ageAt(birthTime, worldTime)` 的纯函数值：推进前 20、推进后 21；同输入可回放；实例上不存储静态 age（§9 扫描 `identity.age` 只在模板配置层） |
| TC-TIME-03 | 边界 | R-NP-04 / Q-R25-08 | 同上（含 age 0 与「age 45 出生于世界开始前」NPC） | 读取投影 | `birthTime` 可为负（世界开始前出生）正确计算；投影 `player.age` / `npcs[].age` 形状不变。**双案标注【Q-R25-08】**：案A（推荐统一）⇒ 玩家也走 birthTime 派生（`playerAgeAtStart + elapsedYears` 退役，两套年龄语义消失）；案B ⇒ 玩家保留现状派生链，NPC 独立 birthTime——用例分别断言对应实现 |
| TC-TIME-04 | 正常 | R-NP-04 | 同上，seed 固定推进 200 轮两次 | 比对逐轮年龄序列 | 两次年龄序列逐字段一致（动态年龄可回放） |
| TC-TIME-05 | 无效输入 | R-NP-04 / Q-R25-05 | 内联夹具：`world.yaml` 追加 `calendar: { preset: gregorian }` | 加载 | **当前实施明确报错**（错误信息含 `calendar.preset` 路径与「本版本仅支持固定近似历法」提示），**不得静默忽略降级为 ①**（静默忽略 = 不锁死单模型验收失败） |
| TC-TIME-06 | 无效输入 | R-NP-04 / Q-R25-05 | 内联夹具：`calendar: { preset: custom, months: [...], leapRule: ... }` | 加载 | 同 TC-TIME-05（声明位被 schema 识别并显式拒绝，而非 unknown-field 之外的语义吞掉） |
| TC-TIME-07 | 前向占位 | — | blocked-by Q-R25-05（若用户裁决实现 ②/③ 才立用例） | — | ②公历：闰年 2/29 存在、月长 28–31、生日未到不加岁、`toMinutes(1 month, from)` 按真实月长换算；③自定义历：自定义月长/置闰规则下窗口换算与 ageAt 确定。本迭代不写断言细节，仅登记占位防实现越界 |
| TC-TIME-08 | 正常 | R-EV-04 | 纯函数（已列于 §3.2） | `resolveTimeExpr` 双形态 | 见 TC-TIME-08（§3.2 表） |

------------------------------------------------------------------------

## 6. 测试世界模板规划（设计稿，实施阶段落盘 `specs/data/templates/`）

三个模板均为**专用测试世界**：不追求叙事完整性，只追求「每个事件 id 可定位到具体用例」。格式严格对齐 jjk-2006 现行 schema + design.md §3.1 迁移表新写法；字段最小必填集以现行 Zod schema 为准，实施时若有 schema 细节出入，以 schema 为权威微调并在加载测试中暴露。

**指纹与 schemaVersion 2 的关系（三模板通用声明）**：

- 三模板均使用 R2.5 新字段（`window` / `TimeExpr` / `cooldown` / `delay` / `enqueueEvent`），在**旧 schema 下加载必失败**、在新 schema（R2.5 后）下加载必成功——即「新模板仅随新 schema 生效」，天然构成 schema 边界的双向断言（TC-ADR11-24/25 的正面镜像）。
- 由三模板产生的存档信封必须为 `schemaVersion: 2`；任何以它们建局后落盘的档，读回须逐字段相等（TC-ADR11-03/29）。
- 模板指纹 sha256 随实施落盘一并生成；修改模板内容即换指纹，旧档拒载（ADR-0007 机制，迭代期接受重开）。

### 6.1 `test-scheduler-core` —— 调度全矩阵

**目的**：覆盖 schedule/pool/chain 触发全矩阵——absolute 与 relative TimeExpr、window.start/end、排序三键、once/条件/冷却/概率四序判定、pool delay 两案、链 delay 步骤、`enqueueEvent` 效果、立即事件槽位。不含战斗与 NPC 生命周期（各自有专用模板），保持 RNG 消耗面最小、断言面最纯。

**用例映射表**：

| 事件 / 结构 id | 覆盖用例 |
|---|---|
| `ev-sched-day2` | TC-ADR11-04、TC-ADR11-07 |
| `ev-sched-windowed` | TC-ADR11-09、TC-ADR11-10、TC-ADR11-12 |
| `ev-sched-gate-setter` | TC-ADR11-09（置位 condGate） |
| `ev-sched-prob-zero` | TC-ADR11-11d、TC-ADR11-12 |
| `ev-sched-once-victim` | TC-ADR11-11a、TC-ADR10-03 |
| `ev-enqueue-repeat` | TC-ADR11-05、TC-ADR11-06、TC-ADR11-31（enqueueEvent 效果） |
| `ev-sort-a` / `ev-sort-b` / `ev-sort-c` | TC-ADR11-01、TC-ADR11-14 |
| `ev-pool-delay3` | TC-ADR11-16、TC-ADR11-pool-once |
| `ev-pool-default0` | TC-ADR11-15、TC-ADR11-15-def（Q-R25-02 双案） |
| `ev-pool-chain-starter` | TC-ADR11-18（startChain 入口） |
| `ev-chain-ann` / `ev-chain-day3` / `ev-chain-finale` + `chain-delay-demo` | TC-ADR11-18、TC-ADR11-19、TC-ADR11-nextturn |
| `ev-action-probe` + 行动 `probe` | TC-ADR11-21、TC-ADR11-23、TC-ADR11-26 |
| 排序纯函数夹具（手工实例） | TC-ADR11-01/02、TC-ADR11-11b/11c/11-order、TC-ADR11-13 |
| 存档夹具 | TC-ADR11-03、TC-ADR11-27、TC-ADR11-28、TC-ADR11-29 |

**world.yaml**：

```yaml
# 调度核心测试世界 · world.yaml
meta:
  id: test-scheduler-core
  name: 调度核心测试世界
  description: R2.5 ADR-0010/0011 引擎测试专用：时间窗队列、排序三键、判定四序、池与链的全矩阵。无叙事目标。
  startYear: 2000
  engineProtocol: v2

time:
  defaultStep: { value: 1, unit: hour }      # 最小步长，便于精确落窗
  lifeStageSteps:
    childhood: { value: 1, unit: day }
    youth: { value: 4, unit: hour }
    adulthood: { value: 6, unit: hour }
    elderhood: { value: 1, unit: day }
  lifeStages:
    - { id: childhood, label: 幼年, maxAge: 12 }
    - { id: youth, label: 青年, maxAge: 29 }
    - { id: adulthood, label: 壮年, maxAge: 59 }
    - { id: elderhood, label: 暮年 }

genders:
  - { id: male, label: 男 }
  - { id: female, label: 女 }

mood:
  min: 0
  max: 100
  defaultValue: 60
  bands:
    - { id: low, label: 消沉, min: 0, max: 40, attributeModifiers: {} }
    - { id: normal, label: 平静, min: 41, max: 70, attributeModifiers: {} }
    - { id: high, label: 高昂, min: 71, max: 100, attributeModifiers: {} }

statusBar:
  - { id: sb-identity, label: 基本, source: identity }
  - { id: sb-mood, label: 心情, source: mood }

attributes:
  order: [intellect, physique, agility, luck]
  defaults: { intellect: 5, physique: 5, agility: 5, luck: 5 }
  labels: { intellect: 智力, physique: 体魄, agility: 敏捷, luck: 运气 }

resources:
  hp: { base: 100, perLevel: 10, perAttribute: { physique: 5 } }
  mp: { base: 50, perLevel: 5, perAttribute: { intellect: 2 } }

regen:
  perTurn: { hp: 2, mp: 1 }
  actions:
    rest: { hp: 20, mp: 10 }

actions:
  - id: wait
    label: 等待
    description: 只消耗时间，不产生其他效果（落窗用）。
    duration: { value: 6, unit: hour }
  - id: probe
    label: 探查
    description: 触发 action_trigger 立即事件的行动钩子宿主。
    duration: { value: 2, unit: hour }
    effects:
      - { type: adjustFlag, id: probeCount, value: 1 }

npcActions:
  - id: tc-npc-train
    summary: "{name} 度过了平静的一天。"
    trigger: { probability: 0.1 }
    utility:
      base: 1
    effects:
      - { type: adjustMood, value: 1 }
```

**characters.yaml**：

```yaml
# 调度核心测试世界 · characters.yaml（最小占位，不含生命周期/投影声明——R2.6 范围）
characters:
  - id: npc-observer
    isEnemy: false
    visibility: public
    identity:
      name: 观测员
      age: 20
      gender: male
      description: 测试占位 NPC。
    mood: { value: 60 }
    attributes: { intellect: 5, physique: 5, agility: 5, luck: 5 }
    public:
      personality: 沉默的观测者。
    private:
      goals: [observe]
      traits: [calm]
    relationship: 0

  - id: npc-second
    isEnemy: false
    visibility: public
    identity:
      name: 副观测员
      age: 20
      gender: female
      description: 测试占位 NPC（用于多 NPC 行动候选过滤基线）。
    mood: { value: 60 }
    attributes: { intellect: 5, physique: 5, agility: 5, luck: 5 }
    public:
      personality: 沉默的观测者二号。
    private:
      goals: [observe]
      traits: [calm]
    relationship: 0
```

**skills.yaml / items.yaml / statuses.yaml**（最小占位，保证六文件合并可加载）：

```yaml
# skills.yaml
skills: []   # 无战斗事件，战斗技能不需要；实施时若 schema 要求非空，补一条 kind: combat 占位

# items.yaml
items:
  - id: item-probe-note
    type: key
    name: 观测笔记
    description: 测试占位物品。
    stackable: false
    usableInBattle: false
    usableOutsideBattle: false

# statuses.yaml
statuses: []  # 无战斗，无补正需求；实施时若 schema 要求非空，补一条 duration.turns 占位
```

**events.yaml**（核心文件；换算基准 1 day = 1440 分钟）：

```yaml
# 调度核心测试世界 · events.yaml
# 每个事件 id 对应 test-design.md §6.1 映射表的 TC 编号。
events:
  # ---- schedule：绝对窗口（无 end） ----
  - id: ev-sched-day2
    title: 排程 · 第二日晨钟
    narrative: 远处的钟楼敲响了第二日的晨钟。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 2, unit: day } }
      once: true
      priority: 10
    kind: normal
    settle:
      normal:
        options:
          - id: opt-sched-day2
            text: 应钟声而起
            effects:
              - { type: setFlag, id: schedDay2Fired, value: true }

  # ---- schedule：窗口 + 条件（hold / 到期过期） ----
  - id: ev-sched-windowed
    title: 排程 · 封印观测窗
    narrative: 只有在封印松动期间，观测窗才会显现内容。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 3, unit: day } }
        end: { kind: absolute, at: { value: 6, unit: day } }
      conditions:
        - { flag: condGate, eq: true }
    kind: normal
    settle:
      normal:
        options:
          - id: opt-sched-windowed
            text: 记录观测结果
            effects:
              - { type: setFlag, id: schedWindowedFired, value: true }

  - id: ev-sched-gate-setter
    title: 排程 · 封印松动
    narrative: 你感到某处封印松动了。正是核实观测窗的机会。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 4, unit: day } }
      once: true
      priority: 9
    kind: normal
    settle:
      normal:
        options:
          - id: opt-sched-gate
            text: 上前查看，置位观测条件
            effects:
              - { type: setFlag, id: condGate, value: true }
          - id: opt-sched-gate-skip
            text: 不去查看（用于 TC-ADR11-10 过期路径）
            effects: []

  # ---- schedule：概率 0（drain 掷骰必败 → drop + missedEvents） ----
  - id: ev-sched-prob-zero
    title: 排程 · 必然错失的流星
    narrative: 预报说今夜有流星，但概率表写死为零。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 5, unit: day } }
        end: { kind: absolute, at: { value: 30, unit: day } }
      probability: 0
    kind: normal
    settle:
      normal:
        options:
          - id: opt-prob-zero
            text: （不应呈现）

  # ---- 排序三键：同 start、不同 end / 同 end 不同 seq ----
  - id: ev-sort-a
    title: 排序观测 · A
    narrative: 同窗条目 A（end 12d，先入队）。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 10, unit: day } }
        end: { kind: absolute, at: { value: 12, unit: day } }
    kind: normal
    settle:
      normal:
        options:
          - id: opt-sort-a
            text: 记录 A
            effects: [{ type: setFlag, id: sortOrder, value: a }]

  - id: ev-sort-c
    title: 排序观测 · C
    narrative: 同窗条目 C（end 12d，文件序在 A 后 → enqueueSeq 更大）。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 10, unit: day } }
        end: { kind: absolute, at: { value: 12, unit: day } }
    kind: normal
    settle:
      normal:
        options:
          - id: opt-sort-c
            text: 记录 C
            effects: [{ type: setFlag, id: sortOrder, value: c }]

  - id: ev-sort-b
    title: 排序观测 · B
    narrative: 同窗条目 B（无 end ≡ +∞，排同窗最后）。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 10, unit: day } }
    kind: normal
    settle:
      normal:
        options:
          - id: opt-sort-b
            text: 记录 B
            effects: [{ type: setFlag, id: sortOrder, value: b }]

  # ---- once 二次判定 + enqueueEvent 效果 ----
  - id: ev-sched-once-victim
    title: 排程 · 一次性祭典
    narrative: 第 1 日的祭典。它只应发生一次。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 1, unit: day } }
      once: true
    kind: normal
    settle:
      normal:
        options:
          - id: opt-once-victim
            text: 参加祭典
            effects:
              - { type: setFlag, id: onceVictimFired, value: true }

  - id: ev-enqueue-repeat
    title: 排程 · 重放祭典令
    narrative: 有人试图让祭典再来一次——但 once 的事实不会同意。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 7, unit: day } }
    kind: normal
    settle:
      normal:
        options:
          - id: opt-enqueue-repeat
            text: 下令重放祭典（1 日后）
            effects:
              - { type: enqueueEvent, eventId: ev-sched-once-victim, delay: { kind: relative, after: { value: 1, unit: day } } }

  # ---- pool：显式 delay / 缺省 delay（Q-R25-02 双案） ----
  - id: ev-pool-delay3
    title: 池 · 迟到的请柬
    narrative: 请柬被抽中了，但它注明：三日后送达。
    trigger:
      source: pool
      probability: 1
      once: true
      priority: 5
      delay: { kind: relative, after: { value: 3, unit: day } }
    kind: normal
    settle:
      normal:
        options:
          - id: opt-pool-delay3
            text: 接下迟到的请柬
            effects:
              - { type: setFlag, id: poolDelay3Fired, value: true }

  - id: ev-pool-default0
    title: 池 · 即达的传单
    narrative: 传单被抽中了。它没有注明延迟。
    trigger:
      source: pool
      probability: 1
      once: true
      priority: 4
      # delay 缺省：Q-R25-02 案A = relative 0（抽中即入队，入口 3 内联触发）；
      # 案B（必填）下本事件加载报错——TC-ADR11-15-def 双案断言
    kind: normal
    settle:
      normal:
        options:
          - id: opt-pool-default0
            text: 读传单
            effects:
              - { type: setFlag, id: poolDefault0Fired, value: true }

  - id: ev-pool-chain-starter
    title: 池 · 链之钥匙
    narrative: 一把开启延时之链的钥匙。
    trigger:
      source: pool
      probability: 1
      once: true
      priority: 3
    kind: normal
    settle:
      normal:
        options:
          - id: opt-pool-chain-starter
            text: 转动钥匙（startChain）
            effects:
              - { type: startChain, chainId: chain-delay-demo }

  # ---- 立即事件（action_trigger，Q-R25-01 改名后；过渡期接受 action-hook） ----
  - id: ev-action-probe
    title: 探查的回响
    narrative: 探查行动立刻有了回响。
    trigger:
      source: action_trigger
      onActionId: probe
      probability: 1
    kind: normal
    settle:
      normal:
        options:
          - id: opt-action-probe
            text: 查看探查结果
            effects:
              - { type: setFlag, id: actionProbeFired, value: true }

  # ---- 链事件（含 delay 链步与 nextTurn 尾步） ----
  - id: ev-chain-ann
    title: 链 · 宣告
    narrative: 链之宣告。结算后 3 日，回响将至。
    trigger:
      source: chain
      priority: 9
    kind: normal
    settle:
      normal:
        options:
          - id: opt-chain-ann
            text: 聆听宣告
            effects:
              - { type: setFlag, id: chainAnnFired, value: true }

  - id: ev-chain-day3
    title: 链 · 第三日回响
    narrative: 三日之期已到，回响如约而至（延时链步）。
    trigger:
      source: chain
      priority: 9
    kind: normal
    settle:
      normal:
        options:
          - id: opt-chain-day3
            text: 回应回响
            effects:
              - { type: setFlag, id: chainDay3Fired, value: true }

  - id: ev-chain-finale
    title: 链 · 尾声
    narrative: 回响平息，链条走到终点（nextTurn 步，Q-R25-06）。
    trigger:
      source: chain
      priority: 9
    kind: normal
    settle:
      normal:
        options:
          - id: opt-chain-finale
            text: 见证尾声
            effects:
              - { type: setFlag, id: chainFinaleFired, value: true }

chains:
  - id: chain-delay-demo
    startEventId: ev-chain-ann
    steps:
      - { eventId: ev-chain-ann, advanceWhen: onSettle }
      - { eventId: ev-chain-day3, advanceWhen: onSettle, delay: { kind: relative, after: { value: 3, unit: day } } }
      - { eventId: ev-chain-finale, advanceWhen: nextTurn }
```

**加载期预期校验结果**：

- R2.5 新 schema 下：`WorldTemplateV2Schema.parse` 通过；引用完整性（`enqueueEvent → ev-sched-once-victim`、`startChain → chain-delay-demo`、`onActionId → probe`）全部解析；全库 id 唯一。
- 旧 schema 下：`window` / `delay` / `enqueueEvent` 为 unknown 字段 ⇒ strict 拒绝（新模板仅随新 schema 生效的负向证明）。
- 注意 `opt-sched-gate-skip` 的空 effects：若现行 `EffectSchema` 不允许空数组，改为 `[{ type: log, text: ... , visibility: public }]`（实施时以 schema 为准）。

### 6.2 `test-time-models` —— 三种时间类型声明

**目的**：以 `world.yaml calendar.preset` 三种声明为核心验证时间模型边界。Q-R25-05 推荐 R2.5 只实现 ①：因此本模板**主 world.yaml 不写 calendar**（缺省 ①，可跑正常用例 + ageAt 计算）；②③ 的声明以**变体片段**形式给出，用于负向加载用例与未来前向用例占位。

**用例映射表**：

| 结构 / 变体 | 覆盖用例 |
|---|---|
| 主 world.yaml（无 calendar） | TC-TIME-01、TC-TIME-02、TC-TIME-03、TC-TIME-04 |
| `ev-age-tick`（advanceBy 1 year） | TC-TIME-02、TC-TIME-04 |
| 变体片段 `calendar: {preset: gregorian}` | TC-TIME-05（负向） |
| 变体片段 `calendar: {preset: custom, ...}` | TC-TIME-06（负向） |
| 前向占位（②③ 语义骨架） | TC-TIME-07（blocked-by Q-R25-05） |

**world.yaml**（主文件，与 §6.1 world.yaml 结构相同处不再重复注释；仅列差异与新增）：

```yaml
# 时间模型测试世界 · world.yaml
meta:
  id: test-time-models
  name: 时间模型测试世界
  description: R2.5/R2.6 时间模型测试专用：缺省近似历法(①)的年龄动态计算；公历(②)/自定义历(③)仅留声明位。
  startYear: 2000
  engineProtocol: v2

time:
  defaultStep: { value: 1, unit: hour }
  lifeStageSteps:
    childhood: { value: 1, unit: day }
    youth: { value: 4, unit: hour }
    adulthood: { value: 6, unit: hour }
    elderhood: { value: 1, unit: day }
  lifeStages:
    - { id: childhood, label: 幼年, maxAge: 12 }
    - { id: youth, label: 青年, maxAge: 29 }
    - { id: adulthood, label: 壮年, maxAge: 59 }
    - { id: elderhood, label: 暮年 }

# 【声明位说明】当前实施（Q-R25-05 推荐 A）不实现 ②③，因此主文件不写 calendar。
# 未来若裁决实现，声明形态为：
#   calendar:
#     preset: gregorian        # ② 真实公历：月长 28-31、闰年、生日未到不加岁
#     startYear: 2000
#   calendar:
#     preset: custom           # ③ 自定义历：自定义月长/置闰
#     months: [{ id: m1, label: 正月, days: 30 }, ...]
#     leapRule: ...
# 现阶段写入任一变体 ⇒ 加载期明确报错（TC-TIME-05/06）。

genders:
  - { id: male, label: 男 }
  - { id: female, label: 女 }

mood:
  min: 0
  max: 100
  defaultValue: 60
  bands:
    - { id: low, label: 消沉, min: 0, max: 40, attributeModifiers: {} }
    - { id: normal, label: 平静, min: 41, max: 70, attributeModifiers: {} }
    - { id: high, label: 高昂, min: 71, max: 100, attributeModifiers: {} }

statusBar:
  - { id: sb-identity, label: 基本, source: identity }
  - { id: sb-mood, label: 心情, source: mood }

attributes:
  order: [intellect, physique]
  defaults: { intellect: 5, physique: 5 }
  labels: { intellect: 智力, physique: 体魄 }

resources:
  hp: { base: 100, perLevel: 10, perAttribute: { physique: 5 } }
  mp: { base: 50, perLevel: 5, perAttribute: { intellect: 2 } }

regen:
  perTurn: { hp: 2, mp: 1 }
  actions:
    rest: { hp: 20, mp: 10 }

actions:
  - id: wait
    label: 等待
    description: 只消耗时间。
    duration: { value: 1, unit: day }

npcActions:
  - id: tm-npc-idle
    summary: "{name} 度过了平静的一天。"
    trigger: { probability: 0.1 }
    utility: { base: 1 }
    effects:
      - { type: adjustMood, value: 1 }
```

**characters.yaml**（age 覆盖三个边界：常规 / 零岁 / 世界开始前出生）：

```yaml
# 时间模型测试世界 · characters.yaml
characters:
  - id: npc-age20
    isEnemy: false
    visibility: public
    identity:
      name: 二十岁者
      age: 20            # ⇒ birthTime = -20 × 525600 = -10512000（近似历法 ①）
      gender: male
      description: 常规年龄基线。
    mood: { value: 60 }
    attributes: { intellect: 5, physique: 5 }
    public: { personality: 平淡。 }
    private: { goals: [observe], traits: [calm] }
    relationship: 0

  - id: npc-age0
    isEnemy: false
    visibility: public
    identity:
      name: 初生者
      age: 0             # ⇒ birthTime = 0，边界：世界起点出生
      gender: female
      description: 年龄零基线。
    mood: { value: 60 }
    attributes: { intellect: 5, physique: 5 }
    public: { personality: 蒙昧。 }
    private: { goals: [observe], traits: [calm] }
    relationship: 0

  - id: npc-age45-past
    isEnemy: false
    visibility: public
    identity:
      name: 先来者
      age: 45            # ⇒ birthTime = -23652000（世界开始前出生，可为负）
      gender: male
      description: 出生于世界起点之前。
    mood: { value: 60 }
    attributes: { intellect: 5, physique: 5 }
    public: { personality: 沉静。 }
    private: { goals: [observe], traits: [calm] }
    relationship: 0
```

**skills.yaml / items.yaml / statuses.yaml**：与 §6.1 相同的最小占位（`skills: []`、`item-probe-note` 同型占位、`statuses: []`）。

**events.yaml**（最小：一个时间推进触发器）：

```yaml
# 时间模型测试世界 · events.yaml
events:
  - id: ev-age-tick
    title: 岁末
    narrative: 一年过去了（推进世界时间 1 年，用于 ageAt 断言）。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 100, unit: day } }
      once: true
    kind: normal
    settle:
      normal:
        options:
          - id: opt-age-tick
            text: 接受岁月
            effects:
              - { type: advanceBy, value: { value: 1, unit: year } }
              - { type: setFlag, id: ageTickDone, value: true }
```

**加载期预期校验结果**：

- 主文件（无 calendar）在 R2.5 新 schema 下通过；NPC 静态 `identity.age` 仍写配置层（实施中 `createWorldV2` 换算为 `birthTime`，实例层无静态 age）。
- 变体片段（gregorian / custom）在当前实施下**必须报错**（TC-TIME-05/06）；若某次提交后变体被静默接受，即为「不锁死单一时间模型」验收失败 + 范围越界（Q-R25-05 未裁决即实现 ②③）。
- 未来裁决实现 ②③ 后：TC-TIME-05/06 转为正向加载用例，TC-TIME-07 展开为断言级用例。

### 6.3 `test-npc-lifecycle` —— NPC 生命周期与投影

**目的**（R2.6 批次执行）：开局已死亡重要角色、unspawned 后续 spawn、复活参战、关系冻结、投影 alwaysVisible、npcState 条件与 reasonCode 不分支。

**用例映射表**：

| 结构 id | 覆盖用例 |
|---|---|
| `npc-ghost-master`（inactive/dead + alwaysVisible） | TC-ADR12-01、TC-ADR12-02、TC-ADR12-04、TC-ADR12-05、TC-ADR12-06、TC-ADR12-09、TC-ADR12-10 |
| `npc-sealed`（inactive/sealed） | TC-ADR12-01、TC-ADR12-02、TC-ADR12-06（reasonCode 不分支镜像） |
| `npc-sleeper`（unspawned） | TC-ADR12-01、TC-ADR12-03、TC-ADR12-07、TC-ADR12-11 |
| `npc-normal`（缺省 alive，零书写） | TC-ADR12-01、TC-ADR12-03（默认判活基线）、TC-ADR12-10 |
| `ev-combat-vs-dead` / `ev-combat-ally-dead` | TC-ADR12-04 |
| `ev-combat-with-sleeper` | TC-ADR12-07（复活后参战） |
| `ev-rel-to-dead` | TC-ADR12-05（Q-R25-10 双案） |
| `ev-cond-npcstate` | TC-ADR12-06 |
| `ev-revive-sleeper` | TC-ADR12-07、TC-ADR12-08（正面） |
| `npcActions: tc-npc-train` | TC-ADR12-03（行动判活过滤） |

**world.yaml**：与 §6.2 主文件同构（meta id/name 换为 `test-npc-lifecycle` / 「生命周期测试世界」），另加一条行动与战斗资源即可：

```yaml
# 生命周期测试世界 · world.yaml（差异部分；其余同 §6.2 主文件）
meta:
  id: test-npc-lifecycle
  name: 生命周期测试世界
  description: R2.6 ADR-0012 测试专用：三态生命周期、默认判活四处消费点、投影解耦。

actions:
  - id: wait
    label: 等待
    description: 只消耗时间。
    duration: { value: 6, unit: hour }
```

**characters.yaml**（本模板核心）：

```yaml
# 生命周期测试世界 · characters.yaml
# lifecycle 声明为 R2.6 新字段（design §4.1/4.3）；缺省 alive，模板零书写判活条件。
characters:
  - id: npc-ghost-master
    isEnemy: false
    visibility: public
    lifecycle: { initialState: inactive, reasonCode: dead }   # 开局已死亡的重要角色
    projection:
      alwaysVisible: true
      showLifecycle: true
    identity:
      name: 亡师
      age: 45
      gender: male
      description: 开局即已故去的宗师，其学说仍影响世界。
    mood: { value: 50 }
    attributes: { intellect: 9, physique: 4 }
    public:
      personality: 温厚，已不在人世。
    private:
      goals: [legacy]
      traits: [calm]
    relationship: 10

  - id: npc-sealed
    isEnemy: false
    visibility: public
    lifecycle: { initialState: inactive, reasonCode: sealed }  # reasonCode 不分支镜像
    identity:
      name: 封印者
      age: 30
      gender: female
      description: 被封印的存在。引擎行为必须与「死者」完全一致。
    mood: { value: 50 }
    attributes: { intellect: 7, physique: 6 }
    public: { personality: 沉默。 }
    private: { goals: [sealed], traits: [calm] }
    relationship: 0

  - id: npc-sleeper
    isEnemy: false
    visibility: public
    lifecycle: { initialState: unspawned }                     # 开局未登场
    identity:
      name: 沉睡者
      age: 22
      gender: male
      description: 尚未进入世界的重要角色。
    mood: { value: 50 }
    attributes: { intellect: 6, physique: 7 }
    public: { personality: 未登场。 }
    private: { goals: [awaken], traits: [diligent] }
    relationship: 0

  - id: npc-normal
    isEnemy: false
    visibility: public
    # 无 lifecycle 声明 ⇒ 默认 alive（默认判活零书写基线）
    identity:
      name: 在场者
      age: 19
      gender: female
      description: 常规存活 NPC。
    mood: { value: 60 }
    attributes: { intellect: 5, physique: 5 }
    public: { personality: 日常。 }
    private: { goals: [observe], traits: [caring] }
    relationship: 0

  - id: enemy-larva
    isEnemy: true
    visibility: public
    identity:
      name: 测试咒灵
      age: 0
      gender: agender
      description: 供复活参战用例的敌人。
    mood: { value: 50 }
    attributes: { intellect: 2, physique: 6, agility: 5 }
    skills: []
    public: { personality: 凶暴。 }
    private: { combatHints: { skillWeights: {} } }
    relationship: -100
```

> 注：`lifecycle` / `projection` 为 R2.6 schema 新字段——本模板在 R2.5 schema 下加载**失败**、在 R2.6 schema 下通过；这本身即是分批边界断言（R2.5 实施阶段本模板允许以夹具形态先存在但标记 `pending R2.6`，或延迟到 R2.6 落盘——二选一在实施时定，不改变用例设计）。

**skills.yaml / items.yaml / statuses.yaml**：同 §6.1 最小占位，另需一条战斗技能与轻伤补正供 `ev-combat-with-sleeper` 使用：

```yaml
# skills.yaml
skills:
  - id: sk-basic-strike
    kind: combat
    name: 基础打击
    description: 测试占位战斗技能。
    cost: { mp: 0 }
    target: enemy
    hitCheck: { preset: opposed, attacker: physique, defender: agility, baseChance: 0.7 }
    damage:
      - { preset: fixed, value: 8 }
    cooldownTurns: 0
    usableInBattle: true

# statuses.yaml
statuses:
  - id: injured-sim
    name: 轻伤
    description: 测试占位补正。
    duration: { turns: 2 }
    stacking: refresh
    simulation:
      attributeModifiers: { physique: -1 }
    visibility: known
```

**events.yaml**：

```yaml
# 生命周期测试世界 · events.yaml
events:
  # 战斗引用已死角色 → 整条跳过 + 记事实（TC-ADR12-04）
  - id: ev-combat-vs-dead
    title: 亡者之战（不应发生）
    narrative: 试图与已故者战斗——引擎应整条跳过。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 2, unit: day } }
      once: true
    kind: combat
    settle:
      combat:
        enemies:
          - { ref: npc-ghost-master, levelScale: 1 }
        canFlee: false
        onVictory:
          effects:
            - { type: setFlag, id: combatVsDeadWon, value: true }

  # 友军位引用已死角色（TC-ADR12-04 allies 同规则）
  - id: ev-combat-ally-dead
    title: 与亡者并肩（不应发生）
    narrative: 试图与已故者并肩作战——引擎应整条跳过。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 3, unit: day } }
      once: true
    kind: combat
    settle:
      combat:
        enemies:
          - { ref: enemy-larva, levelScale: 1 }
        allies:
          - { ref: npc-ghost-master, levelScale: 0.5 }
        canFlee: false
        onVictory:
          effects:
            - { type: setFlag, id: combatAllyDeadWon, value: true }

  # 关系写入冻结（TC-ADR12-05，Q-R25-10 双案）
  - id: ev-rel-to-dead
    title: 迟到的书信
    narrative: 你试图向已故者表达敬意。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 4, unit: day } }
      once: true
    kind: normal
    settle:
      normal:
        options:
          - id: opt-rel-to-dead
            text: 寄出书信
            effects:
              - { type: adjustRelation, npcId: npc-ghost-master, value: 5 }

  # npcState 条件（TC-ADR12-06）：只匹配状态，不匹配 reasonCode
  - id: ev-cond-npcstate
    title: 追思仪式
    narrative: 只要有「不在场」的存在，追思仪式便会开始。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 5, unit: day } }
      once: true
      conditions:
        - { npcState: { npcId: npc-ghost-master, state: inactive } }
        - { npcState: { npcId: npc-sealed, state: inactive } }
    kind: normal
    settle:
      normal:
        options:
          - id: opt-cond-npcstate
            text: 参加追思
            effects:
              - { type: setFlag, id: memorialHeld, value: true }

  # 复活（TC-ADR12-07/08 正面）：setNpcLifecycle 效果
  - id: ev-revive-sleeper
    title: 唤醒沉睡者
    narrative: 你叩响了沉睡者的门。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 6, unit: day } }
      once: true
    kind: normal
    settle:
      normal:
        options:
          - id: opt-revive-sleeper
            text: 唤醒他
            effects:
              - { type: setNpcLifecycle, npcId: npc-sleeper, state: alive }

  # 复活后参战（TC-ADR12-07）
  - id: ev-combat-with-sleeper
    title: 沉睡者的初战
    narrative: 唤醒后的沉睡者将面对测试咒灵。
    trigger:
      source: schedule
      window:
        start: { kind: absolute, at: { value: 8, unit: day } }
      once: true
    kind: combat
    settle:
      combat:
        enemies:
          - { ref: enemy-larva, levelScale: 1 }
        canFlee: false
        onVictory:
          effects:
            - { type: setFlag, id: sleeperCombatWon, value: true }
```

**加载期预期校验结果**：

- R2.6 schema 下通过：`lifecycle.initialState` ∈ alive/inactive/unspawned、`reasonCode` 自由字符串、`projection` 三键、`npcState` 条件、`setNpcLifecycle` 效果全部在白名单。
- R2.5 schema 下加载失败（`lifecycle` / `projection` 为 unknown 字段）——分批边界的天然断言。
- 引用完整性：`enemies[].ref`、`allies[].ref`、`adjustRelation.npcId`、`setNpcLifecycle.npcId`、`npcState.npcId` 全部解析；`enemy-larva.skills` 引用的技能存在。
- 注：`enemy-larva.private.combatHints.skillWeights` 为空对象是占位；若 schema 要求非空，补 `sk-basic-strike: 1`（实施时以 schema 为准）。

### 6.4 模板落盘与执行批次小结

| 模板 | 落盘批次 | 主要执行批次 | 备注 |
|---|---|---|---|
| `test-scheduler-core` | R2.5（T1-08 同期或更早） | R2.5 | 三文件占位随 T1-01 schema 定型微调 |
| `test-time-models` | R2.5 | R2.5（TC-TIME-05/06）；TC-TIME-01..04 的 ageAt 部分在 R2.6（T2-04）补断言 | ②③ 变体永不落盘为正式模板，仅作内联负向夹具与前向占位 |
| `test-npc-lifecycle` | R2.6（或 R2.5 末以夹具预置） | R2.6 | R2.5 schema 下不可加载，天然分批断言 |

------------------------------------------------------------------------

## 7. UI 测试规划（TC-UI，本轮只设计不执行）

**执行时机：R2.5 实施完成后**（由 RPA skill「Web Access」驱动本地 Chrome / CDP 执行）。目标端口 **5173（Vite dev，前端改动看这里）**；3000 为构建产物端口，不用于前端回归。若实施引入了前端展示变更（missedEvents、schemaVersion 拒载提示），必须在 5173 上验证。

| 编号 | 分类 | 关联 | 路径 | 操作 | 期望 |
|---|---|---|---|---|---|
| TC-UI-01 | 正常 | 端到端 | http://localhost:5173 | 新建世界：选择 `test-scheduler-core` 模板 → 填玩家名 → 创建 | 世界创建成功；状态栏、行动列表渲染；无控制台错误；模板指纹出现在存档信封 |
| TC-UI-02 | 正常 | R-EV-05..08 | 同上 | 连续推进轮次（等待/探查混合） | 到点事件按窗口呈现（第 2 日晨钟等）；事件卡与历史时间线一致；槽位守卫生效（事件待决时行动按钮禁用/拒绝提示） |
| TC-UI-03 | 正常 | 装备回归（R2.4 既有） | 同上 | 打开背包/装备方格面板 | 方格 UI（panelSide 分列等 R2.4 行为）无回归 |
| TC-UI-04 | 正常+无效输入 | Q-R25-09 | 同上 | ① 存档 → 刷新 → 读档；② 用旧 schemaVersion 1 存档文件替换后读档 | ① 读档后状态一致（scheduledEvents/eventFires 往返无损）；② 显示明确的拒载提示（含版本信息），不静默丢弃也不崩溃 |
| TC-UI-05 | 正常 | R-EV-07 / missedEvents 投影 | 同上 | 推进至 `ev-sched-prob-zero` 错失后查看时间线 | 错失事件以「错失」形态展示（仅 eventId+标题级信息，无 hidden 语义，OPEN_QUESTIONS #33 口径）；不进入可交互事件列表 |
| TC-UI-06 | 正常 | R-NP-01（R2.6 后执行） | 同上（模板换 `test-npc-lifecycle`） | 打开 NPC 面板 | 开局已死亡的重要角色上屏且带状态标注（模板 label 映射文案）；沉睡者未登场不上屏；年龄展示随世界时间推进（NPC 面板生命周期标注对应 T2-03 DoD 前端项） |

执行注意：测试数据全部来自 §6 模板（不污染 jjk-2006 的玩家叙事）；UI 用例失败时先区分「前端缺陷」与「引擎投影缺陷」（引擎断言已在 §2–§5 覆盖），只把 UI 层问题记入 UI 缺陷清单。

------------------------------------------------------------------------

## 8. 基线重录与测试迁移对照清单（对齐 design.md §3.4.5 / §6）

**RNG 序列变更声明（ADR-0011）**：以下现存测试依赖具体事件触发序列/骰序，R2.5 实施后须重录基线，提交信息注明「同 seed 序列变更（ADR-0011）」：

| 现存测试点（v2.test.ts） | 迁移动作 | 关联用例 |
|---|---|---|
| `:737` combat 并发优先级（`atTurn: 1` 夹具） | 改写为 `window: { start: { kind: absolute, at: { value: 1, unit: day } } }`（或夹具对应分钟量）；断言「优先级次序」语义不变 | TC-ADR11-24 正面镜像 |
| `:768` normal 队列优先级（同型 atTurn 夹具） | 同上 | 同上 |
| `:711` / `:786` 链 nextTurn 步 | Q-R25-06 案A（保留）⇒ 不动；案B ⇒ 改写为 `onSettle + delay` 或重设计 | TC-ADR11-nextturn |
| 夹具中带 `cooldownTurns` 的 pool 事件（多处） | 换形 `cooldown: TimeExpr`；冷却断言从轮次差改时间差 | TC-ADR11-25 正面镜像、TC-ADR11-11c |
| 「怀玉·玉折主线」全链路 / 转盘 weightBy 等依赖骰序断言 | 同 seed 重放重录期望值（jjk-2006 events.yaml 迁移后） | TC-ADR11-27 同型 |
| `v2.test.ts` 模板加载测试（六文件合并） | 迁移后 jjk-2006 重算指纹；加载断言补充 `scheduledEvents` 初始化条目数 | TC-ADR11-07 |

新增测试文件建议（实施者照单创建）：`packages/game-core/src/v2/scheduler.test.ts`（纯函数组：cmp / evaluateDue / evaluateChain / RNG 序）、`v2/three-layer.test.ts`（TC-ADR10 组）、无效输入夹具集（TC-ADR11-24/25/26/29/31、TC-TIME-05/06、TC-ADR12-08/12/13）。

------------------------------------------------------------------------

## 9. 验收期残留与范围污染扫描清单

实施完成后按本清单扫描（QA 验收用，命中即 FAIL）：

```bash
# 1) 三层拆分残留：应零命中（生产代码；测试中的"拒载断言"除外）
grep -rn "openingScheduled\|turnsPlayed" packages apps --include="*.ts"           # ADR-0010 flags 拆分
grep -rn "resolveScheduleV2" packages apps --include="*.ts"                       # 全模板扫描下线
grep -rn "atTurn\|cooldownTurns" packages/shared/src/schema --include="*.ts"      # 退役字段出 schema

# 2) V1 残留符号：命中即 FAIL
grep -rn "evaluateLife\|PhaseTransitionLog" packages apps --include="*.ts"
ls packages/game-core/src/v2/lifecycle.ts 2>/dev/null                             # 不应存在（ADR-0004）

# 3) 模板残留：specs/data/templates 下应零命中
grep -rn "atTurn\|cooldownTurns\|action-hook" specs/data/templates               # Q-R25-01 收尾期后

# 4) hidden 泄漏：projectSnapshotV2 输出 diff 评审（白名单制）
#    missedEvents 只含 eventId+标题级信息；reasonCode 不进投影文本（引擎只给 code）

# 5) 范围污染：tasks/reports 与 tasks.md 不得出现
grep -rn "R-TT-\|R-LC-" tasks/reports specs/iteration-2026-11-11-r25             # DEFERRED 组不得混入 DoD
grep -n "R-NP-07" specs/iteration-2026-11-11-r25/tasks.md                        # 只允许登记行，不允许任务行
```

------------------------------------------------------------------------

## 10. 未决项与风险

| # | 项 | 影响用例 | 风险与处置 |
|---|---|---|---|
| 1 | **OQ #34**（立即事件呈现时点） | TC-ADR11-21/23 | 双案期望已并列；实施者不得在裁决前只实现单案。案① 需「延迟一拍呈现」机制，改动量中等 |
| 2 | **OQ #35**（仅一个的强制方式） | TC-ADR11-22 | 双案；案① 下 test-scheduler-core 需确认无违规模板（本模板仅一条 action_trigger，天然合规） |
| 3 | **Q-R25-03 / OQ #36**（判定失败处置） | TC-ADR11-11b/11c/11d、TC-ADR11-12 | 按 design 推荐混合处置写期望；若裁决全丢弃/全留队，仅改这 4 条的期望，判定顺序用例不变 |
| 4 | **OQ #37**（相对时间基准） | TC-ADR11-05/06 | 双案（入队时刻 vs 世界起点）；案② 改写窗口固化断言 |
| 5 | **Q-R25-02 / OQ #38**（pool delay 来源） | TC-ADR11-15/15-def/16 | 双案 + 案③ 变体；`ev-pool-default0` 在案B 下由「正常事件」转为「无效输入夹具」 |
| 6 | **Q-R25-05 / OQ #39**（时间模型范围） | TC-TIME-05/06/07 | 推荐 A（只实现①）；若用户裁决实现②③，TC-TIME-05/06 转正向、TC-TIME-07 展开——须先回本设计补断言再实施 |
| 7 | **Q-R25-06**（nextTurn 去留） | TC-ADR11-nextturn、v2.test.ts:711/786 | 双案；案B 触发链夹具重设计 |
| 8 | **Q-R25-10**（inactive 关系冻结） | TC-ADR12-05 | 双案；R2.6 执行时按裁决定稿 |
| 9 | **Q-R25-01**（action-hook 改名） | TC-ADR11-26、模板 `ev-action-probe` | 本设计稿按推荐案A 写 `action_trigger`；案B 则模板触发源字段改回 `action-hook` |
| 10 | schema 细节出入 | 三模板 YAML 占位 | `skills: []` / `statuses: []` / 空 effects 等「最小占位」是否合法取决于现行 Zod schema；实施时以 schema 为权威微调，差异记入 T1-08 报告，不改用例结构 |
| 11 | 链 delay 步骤与 pendingEvents 的呈现竞争 | TC-ADR11-18 | delay 步到期触发与玩家正在结算其他事件可能同窗竞争槽位——期望按 `EVENT_SOURCE_PRIORITY`（chain 0 最先）排队、槽位逐个消费；若实施发现规格未覆盖的竞争情形，登记新 OPEN_QUESTION 而非现场拍板 |

—— 完 ——
