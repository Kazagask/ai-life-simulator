# R2.5 任务分解（未开工）

> **状态：全部 `pending`。** G1 未过——本文件只做任务分解，不代表允许编码。
> 开工前置：用户在 `docs/OPEN_QUESTIONS.md` #34 / #35 / #36 / #37 / #39 上给出裁决（对应设计 `Q-R25-01..05`），裁决结果回填到本文件「裁决回填」表后，才从 `T1-01` 开始。

## 0. 裁决回填表（等用户）

| 待决 | 影响任务 | 裁决 | 回填后要改的地方 |
|---|---|---|---|
| `#34` 立即事件呈现时点（下一轮 vs 当前轮） | `T1-01`、`T1-07` | 待定 | `PendingEvent` 是否加 deferred 标记；`advanceTurnV2` 开局是否先消费 deferred 事件 |
| `#35` 协议层「仅一个」强制方式 | `T1-01`、`T1-07` | 待定 | 加载期 superRefine 拒绝，或运行期首个胜出 + 日志 |
| `#36` 窗口到期未触发处置 | `T1-03` | 待定 | `evaluateDue` 的 `hold` / `expire` 分支；`missedEvents` 写入时机 |
| `#37` 相对时间基准 | `T1-03` | 待定 | `TimeExpr.relative` 换算锚点 |
| `#39` 三种时间模型枚举 | `T2-04` | 待定 | `birthTime` 字段形状与 `CalendarAdapter` 接口 |

## 1. R2.5 · 事件模型（先做）

| 任务 | 内容 | 覆盖需求 | 依赖 | 完成定义（DoD） |
|---|---|---|---|---|
| `T1-01` | **模板契约收敛**：`action-hook`→`action_trigger`（过渡期双接受或直接改名，按 `Q-R25-01`）；删 `atTurn`（加载期报错并提示替代写法）；`cooldownTurns`→`cooldown: TimeExpr`；新增 `TimeExpr`（absolute/relative）与 `window{start,end?}`、`ChainStep.delay`；`EventInstanceSchema` 统一为运行时实例 | R-EV-02/04/09 | 无 | 含 `atTurn` / `cooldownTurns` 的模板加载报错且给出替代写法；新字段 strict 校验；`pnpm typecheck` 0 |
| `T1-02` | **实例层 + 事实层落状态**：`WorldStateV2` 增 `scheduledEvents[]` / `enqueueSeqCounter` / `missedEvents[]` / `eventFires[]` / `lastFiredIndex`；`WorldStateV2Schema` 同步；`schemaVersion` 1→2；旧档拒载与错误信息 | R-LM-01/03 | `T1-01` | 落盘→读回逐字段相等；旧 `schemaVersion=1` 被拒且错误可诊断；`eventFires` 写入后不再改写（测试断言） |
| `T1-03` | **调度器**：新建 `v2/scheduler.ts` — `enqueueScheduled()`（换算并固化窗口、分配 `enqueueSeq`）、`drainScheduledEvents()`（循环取队首、`start > now` 即停）、`evaluateDue()` 纯函数（once→conditions→cooldown→probability 固定顺序）；三个 drain 入口接线（轮次推进后、效果推进时间后、入队即到期） | R-EV-05/06/07 | `T1-02` | 三键排序用例（start/end 空/入队序）；出队时判定用例（入队不满足→出队满足）；同输入两次运行出队序列一致；RNG 消耗顺序写进注释 |
| `T1-04` | **删除全模板扫描**：删 `resolveScheduleV2`；`createWorldV2` 初始化即入队全部 `schedule` 事件；`opening.handoff()` 真正入队并删除 `flags["openingScheduled:*"]`；`turnsPlayed` flag 删除（≡ `turnIndex`） | R-EV-08、R-LM-02 | `T1-03` | 创建世界后 `scheduledEvents` 含全部 schedule 事件；`turn.ts` 无 `template.events` 遍历（除入队与 pool 抽取）；`openingScheduled:*` 与 `turnsPlayed` 全仓库零命中 |
| `T1-05` | **pool 降格为抽取器**：抽中→`enqueueEvent`（`delay` 按 `Q-R25-02`）；保留最后触发的管线位次；`probability`/`weight` 语义与 drain 阶段如何分工写清 | R-EV-08 | `T1-03` | pool 抽中不产生 `pendingEvents` 条目；抽中即入队的实例可被 drain 取出；pool 的 once/冷却不重复扣减 |
| `T1-06` | **链与断链**：`evaluateChain()` 纯函数（active 的充分条件含「队列仍有该链未触发实例」）；`ChainStateV2.stepIndex` 改为派生或标注缓存；`advanceChain` 效果（`engine.ts:370-375` 盲目 `+1`）收口到单一推进规则；`advanceWhen` 去留按 `Q-R25-06` | R-EV-10 | `T1-03` | 链步为延时事件时不断链；队列空且无后续步才判完成；同一链不会出现 `stepIndex` 双写漂移（用例覆盖 `advanceChain` 与 settle 同时发生） |
| `T1-07` | **槽位守卫与立即事件**：按 `#34` 裁决实现呈现时机；按 `#35` 实现「仅一个」强制；`pending_event_required` 语义收窄为「槽位被占则拒绝自由行动」 | R-EV-01/02/03 | `T1-01`、`#34`、`#35` | 槽位不变量用例（任一轮至多一个事件或一次行动）；违规模板按裁决口径被拒绝/降级；`random`/`combat` 即时结算不占槽位 |
| `T1-08` | **模板与夹具迁移**：`jjk-2006/events.yaml`（1 schedule、5 pool、1 action-hook、~20 chain）；`opens`/测试夹具中的 `atTurn`（`v2.test.ts:737/768`）与 `advanceWhen`（`:711/:786`）；指纹重算 | R-EV-09 | `T1-01`…`T1-07` | 模板加载通过；旧回放断言按新 RNG 序列重录并注明「序列变更」；无模板残留旧字段 |
| `T1-09` | **协议与验收**：`TEMPLATE_PROTOCOL_V2.md` §8（触发）/§12（条件）/新增调度章节；`tasks/reports/R25-COMPLETION.md` | 全部 EV | `T1-08` | 协议与实现逐字段一致；报告含命令输出与端到端证据（curl：到点触发 / 错失 / 断链不误判） |

**R2.5 完成判据**：19 条中 `R-LM-01..03` + `R-EV-01..10` 全部满足验收；`pnpm typecheck` 0；game-core 测试全绿；web 构建通过。

## 2. R2.6 · NPC 系统（后做）

| 任务 | 内容 | 覆盖需求 | 依赖 | 完成定义（DoD） |
|---|---|---|---|---|
| `T2-01` | **NPC schema 扩展**：`V2Npc.lifecycle {state, reasonCode?, sinceTurn, sinceWorldTime}`；`birthTime` 取代静态 `age`（`V2CombatantBase.age` 的处理按设计 §4.4）；`parents[]`/`masterId`/`affinity`（`relationship` 改名）；`projection` 模板配置；`infoVisibility`/`relationSource` 从 `flags` 迁入实例 | R-NP-02/04/05、R-LM-02 | `T1-02` | 旧字段不再写 `flags`（`opening.ts:150-160` 迁移）；schema strict 校验；存档往返一致 |
| `T2-02` | **默认判活四处**：NPC 行动循环、战斗建场 ref（`enemies`/`allies`）、关系/好感写入冻结、行动候选过滤；`unspawned` 不参与任何一处 | R-NP-02/03 | `T2-01` | 四处各有「inactive 被跳过」用例；模板零书写 `alive` 条件；`reasonCode` 在引擎中零分支（静态扫描断言） |
| `T2-03` | **投影解耦**：`projectNpc()` 只读 public 字段 + `infoVisibility` + 模板 `projection`；`inactive` 照常上屏（`age` 冻结、状态标注由模板 label 映射）；`visibility: public\|hidden` 与动态已知标记的组合按 `Q-R25-07` | R-NP-01 | `T2-01` | 「开局即 dead 的重要角色」上屏用例；alive/dead 投影可见性判定结果一致（不读生命周期）；前端 `NpcCard` 零改动或仅加状态标注 |
| `T2-04` | **动态年龄**：`CalendarAdapter` 增 `toMinutes` / `ageAt`；`birthTime`（可为负）；三种时间模型按 `#39` 裁决落地（默认实现①近似历法，其余留 seam）；玩家侧按 `Q-R25-08` 决定是否同步 | R-NP-04 | `T2-01`、`#39` | 世界时间推进后 NPC 年龄增长且可回放；投影 `age` 形状不变（`projection.ts:100/141`）；战斗镜像保留建场快照 |
| `T2-05` | **关系推导**：`v2/relations.ts` — `parents[]`/`masterId` 推导 child/sibling/apprentice/同门，倒排索引 O(N+E)，上溯辈分，写入时环检测；`relationLog` 只追加 | R-NP-06 | `T2-01` | 双亲/师父推导用例；环检测拒绝非法写入；同输入同输出（确定性） |
| `T2-06` | **效果与条件 DSL**：新增 `setNpcLifecycle`、`enqueueEvent`、条件 `{ npcState: { npcId, state } }`；白名单校验；模板示例 | R-NP-03、R-EV-08 | `T1-01`、`T2-01` | 「失联事件 → inactive(missing)」端到端；非法 state 加载期拒绝 |
| `T2-07` | **模板迁移**：`jjk-2006/characters.yaml`（age→birthTime、parents/masterId、visibility→projection）；协议 §7/§12/§19/§20 | R-NP-01..06 | `T2-01`…`T2-06` | 模板加载通过；`npcSetup.relations` 的 `source` 迁到关系边 |
| `T2-08` | **验收**：`tasks/reports/R26-COMPLETION.md` | 全部 NP | `T2-07` | 6 条 `R-NP` 逐条举证；typecheck 0；测试全绿 |

## 3. 执行纪律

- **G3 单任务**：一次只做一个 `T`，按表内顺序；前置未完成不得开工。
- **G4 单写者**：`T1-*` 与 `T2-*` 不并行写 `packages/`；`T2-06` 触及 `common.ts` 时须在 `T1` 全部提交后再派。
- **G5**：`R-NP-07`（通用 yaml 关系机制）不在任务表内，只留 `custom` 类型位。
- **确定性**：`T1-03` / `T1-05` / `T2-02` 都会改变 RNG 消耗顺序，提交信息必须写明「同 seed 序列变更」，并同步重录回放断言。
