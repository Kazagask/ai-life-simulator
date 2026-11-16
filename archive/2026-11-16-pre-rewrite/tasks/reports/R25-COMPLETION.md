# R2.5 完成报告（事件模型 / T1-01..T1-09）

> 范围：R2.5 事件模型 **T1-01..T1-09**。R2.6 / `T2-*` NPC 系统**不在本轮范围、未实施**。
> 报告口径：只陈述实际实现与实际跑过的命令；未做到/部分做到逐条列在 §6、§7。
> 验收裁定权在 `life-sim-qa`；本报告为实施方自验。

## 0. 提交清单

| # | 提交 | 说明 |
|---|---|---|
| 0 | `1c87f04` | `docs(R2.5): 回填用户裁决 #35/#36/#41/#46 与延期项、新增 test-design 规格 (G1/G2 通过)` — 承接已有规格回填（含未跟踪的 `test-design.md`） |
| 1 | `bd5ef2f` | `feat(R2.5-T1-01): 模板契约收敛 TimeSpec/window/cooldown/missWhen + 退役字段诊断 + #35 加载期强制` |
| 2 | `bd84f61` | `feat(R2.5-T1-02): 实例层/事实层落状态 + schemaVersion 2 拒载旧档` |
| 3 | `dfa15a6` | `feat(R2.5-T1-03): 新建确定性调度器 scheduler.ts + 15 项单测（同 seed 序列变更）` |
| 4 | `23706e1` | `feat(R2.5-T1-04..07): 引擎接线 删全模板扫描/pool 门控入队/链收口/结算轮+timeCost/开局真入队（同 seed 序列变更）` |
| 5 | `f1fd1ee` | `test(R2.5-T1-08): 夹具迁退役字段/重录结算轮基线 + 11 项验收用例，触发事实收口 recordFire（同 seed 序列变更）` |
| 6 | 见 §8 | `docs(R2.5-T1-09): 协议调度章节 + 完成报告 + 状态更新` |

**中间提交非全绿说明**：`schemaVersion 1→2` 是破坏性变更，Group A/B/C/D 期间测试与类型检查处于中间态（例如 T1-01 引入退役字段诊断后，旧夹具尚未迁移）。按主理人许可，最终状态全绿；**最终状态**的验证输出见 §1。

## 1. 命令与实际结果

| 命令 | 实际输出 | 结论 |
|---|---|---|
| `pnpm typecheck` | `tsc --noEmit -p tsconfig.json`，**0 错误** | 通过 |
| `pnpm --filter @life-sim/game-core test` | `Test Files 19 passed (19)` / `Tests 275 passed (275)` | 通过 |
| `pnpm --filter @life-sim/shared test` | `Test Files 3 passed (3)` / `Tests 50 passed (50)` | 通过 |
| `pnpm --filter @life-sim/web build` | `vite v6.4.6`，`✓ 29 modules transformed`，`built in 1.50s`（`index-*.js 260.84 kB`） | 通过 |
| `pnpm build`（= typecheck + web build） | 同上两段，`built in 1.35s` | 通过 |
| `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/templates` | `200` | 服务冒烟通过 |
| 服务启动日志 | `worlds_loaded: loaded 0, skipped 8`，8 条均为 `schema_version_mismatch: 1` / `save_skipped` | 旧档拒载生效 |

**合计**：19 + 3 = 22 个测试文件，275 + 50 = **325 条测试全绿**。

### 1.1 HTTP 端到端证据（jjk-2006，seed=1）

`POST /api/worlds` → 交替调用 `GET /api/worlds/:id`、`POST .../turns`、`POST .../events/choose`、`POST .../battle`，实跑 15 步：

```text
create: 201  turnIndex=0  worldTime=0
step01 CHOOSE opt-investigate -> turnIndex=1  worldTime=0    triggered=['ev-curse-investigate','ev-curse-find']
step04 TURN   rest           -> turnIndex=3  worldTime=480   triggered=['ev-curse-sighting','ev-shrine-lottery']
step10 TURN   rest           -> turnIndex=6  worldTime=960   triggered=['ev-rumor']
step11 CHOOSE opt-listen     -> turnIndex=7  worldTime=960   triggered=[]
step12 TURN   rest           -> turnIndex=8  worldTime=1440  triggered=['ev-sp-briefing']   ← 到点触发（window.start = 1 day）
step13 CHOOSE opt-join-guard -> turnIndex=9  worldTime=1440  triggered=['ev-sp-riko-meet','ev-exchange']
step14 CHOOSE opt-befriend-riko -> turnIndex=10 worldTime=2880 triggered=['ev-sp-vigil']
step15 CHOOSE opt-relax      -> turnIndex=11 worldTime=4320  triggered=['ev-sp-ambush']
```

- **到点触发**：`ev-sp-briefing`（`source: schedule`, `window.start: {value:1, unit:day}`）恰在 `worldTime=1440` 的轮次出队，验证「初始化即入队 + 到期 drain」。
- **结算轮**：每次 `CHOOSE` 都 `turnIndex +1`；`timeCost` 缺省 0 ⇒ `worldTime` 不因结算增加（step01/11/13）。
- **链未断**：step13–15 跨 3 个结算轮连续推进主线链，未因队列/结算竞争误判断链。
- **存档落盘**：该局 `data/worlds/4ddebd7a-*.json` 为 `schemaVersion: 2`，`scheduledEvents: 5`（`origin` 含 `schedule-init` / `pool`）、`eventFires: 12`、`lastFiredIndex: 10`、`missedEvents: 0`；实例键集合为 `{instanceId, definitionId, origin, window, hasEnd, enqueuedAt, enqueueSeq, status}`，**六个配置域字段零副本**。指纹 `sha256:f92a7b6a…` 由模板 YAML 运行时计算，无手工常量需重算。

## 2. 逐任务 DoD 举证

| 任务 | 完成定义 | 证据 | 判定 |
|---|---|---|---|
| **T1-01** 模板契约 | `TimeSpec` / `window` / `cooldown` / `timeCost` / `delay` / `missWhen` / `missLabel` / `ChainStep.delay`；退役字段诊断；`schedule` 必 `window.start`；pool 必 probability\|weight 且互斥；pool+combat 拒载；#35 三组用例 | `packages/shared/src/schema/{common,event,event-instance,world}.ts`；`shared/r25-schema.test.ts` 13 项（含 `①1 立即+N 延时合法 / ②2 立即拒载带提示 / ③全延时合法`、三个退役字段诊断、pool+combat、TimeSpec 整数、strict 新字段、实例零快照、enqueueEvent 引用完整性） | **满足** |
| **T1-02** 状态层 | 新字段 + strict Zod + 双断言；`schemaVersion=2`；旧档拒载；append-only；实例无六字段副本 | `shared/v2.ts`、`shared/v2-state.ts`、`apps/server/src/store.ts`、`game-core/v2/turn.ts#createWorldV2`；`persistence.test.ts` 13 项（含 `schemaVersion=2` 往返与 `schema_version_mismatch: 1`）；服务日志 8 条旧档拒载 | **满足** |
| **T1-03** 调度器 | `resolveTimeSpec` / `sortScheduled` / `enqueueScheduled` / `enqueueCandidate` / `evaluateDue` / `drainScheduledEvents` / `recordFire` / `evaluateChain`；三键排序、条件终判、确定性、missWhen、#36 hold、门控零错失、pool+combat | 新增 `v2/scheduler.ts`（361 行）+ `v2/scheduler.test.ts` **16 项**（含 T1-04 init 入队专项）；RNG 消耗顺序写在模块头注释 | **满足** |
| **T1-04** 删全模板扫描 | 删 `resolveScheduleV2`；初始化即入队；opening handoff 真入队；删冗余 flags | `turn.ts` 已无 `resolveScheduleV2` 调用（仅注释提及）；`createWorldV2` 为全部 `source: schedule` 入队；`opening.ts#handoff` 用 `enqueueScheduled`；`grep -rn "openingScheduled\|turnsPlayed" packages apps --include="*.ts"` → **CLEAN** | **满足** |
| **T1-05** pool 门控 | 抽中只入队、不立即触发、不进 `pendingEvents`；六策略不重复扣减；combat 不入池 | `resolvePoolV2` 改为 `enqueueCandidate(preGated:true)`；`scheduler.test.ts` 门控用例 + `r25-schema.test.ts` pool+combat 加载期用例；`scheduler.ts` 抽取期防御 | **满足** |
| **T1-06** 链与断链 | `evaluateChain` 以队列 waiting 实例为 active 充分条件；`advanceChain` 收口单一规则；`nextTurn` 去留 | `scheduler.ts#evaluateChain/alignChainStep`；`engine.ts#advanceChain` 改调 `alignChainStep`；`scheduler.test.ts` 2 项 + `r25-acceptance.test.ts` 「无 nextTurn 步不盲目 +1」；Q-R25-06 保留 `nextTurn`（见 §6.5） | **满足** |
| **T1-07** 槽位与结算轮 | `turnIndex += 1`、timeCost、战斗结束算、用物品不算、事件轮跑完整管线、`pending_event_required` 收窄、#35 | `turn.ts#chooseOptionV2/battleActionV2/useItemV2/advanceTurnV2/runTurnTail`；`r25-acceptance.test.ts` 5 项槽位用例（含战斗结束/用物品/无效输入/拒绝时逐字段不变）；`v2.test.ts` 3 处旧断言按新行为重录 | **满足（详见 §6.9 战斗结束范围）** |
| **T1-08** 模板与夹具迁移 | jjk 事件字段迁移；测试夹具迁退役字段；重录基线；指纹 | `events.yaml`（4 条 `cooldownTurns`→`cooldown`、1 条 `atWorldTime`→`window.start`、`turnsPlayed` 条件→`time`）；`opening.yaml` 注释；`guard.test.ts` / `v2.test.ts` / `time.test.ts` 夹具；`action-hook` 保留；模板 YAML 中事件触发旧字段零残留；指纹运行时计算 | **满足** |
| **T1-09** 协议与验收 | 协议与实现一致；报告含命令输出与端到端证据 | `TEMPLATE_PROTOCOL_V2.md` §9.1/§9.3/§9.4/§9.6、§12、§13、§14、§21.2、新增 §22；本报告 + §1.1 HTTP e2e + 存档落盘核验 | **部分满足**（见 §7.1） |

## 3. 改动文件清单（相对 `5637b03`）

**shared（7）**：`schema/common.ts`（TimeSpec / `enqueueEvent` / `TimeAmount.value` 整数）、`schema/event.ts`（新字段 + 退役字段 declared-but-deprecated 诊断 + schedule 必 window）、`schema/event-instance.ts`（origin 扩展 + `ScheduledEventInstanceSchema`）、`schema/world.ts`（pool+combat、#35、enqueueEvent 引用校验）、`v2.ts`、`v2-state.ts`、`r25-schema.test.ts`（新增 13 项）。

**game-core（15）**：新增 `v2/scheduler.ts`、`v2/scheduler.test.ts`（16 项）、`v2/r25-acceptance.test.ts`（11 项）；改 `v2/turn.ts`、`v2/engine.ts`、`v2/opening.ts`、`v2/ending.ts`、`v2/time.ts`、`v2/replay.ts`、`v2/test-utils.ts`、`src/index.ts`、`v2/guard.test.ts`、`v2/opening.test.ts`、`v2/persistence.test.ts`、`v2/time.test.ts`、`v2.test.ts`。

**server（1）**：`apps/server/src/store.ts`（`SCHEMA_VERSION = 2`、`handoff(..., lookup)`）。

**模板 / 规格（3 + 状态文档）**：`specs/data/templates/jjk-2006/{events.yaml,opening.yaml}`、`specs/data/TEMPLATE_PROTOCOL_V2.md`、`tasks/reports/R25-COMPLETION.md`、`specs/iteration-2026-11-11-r25/tasks.md`、`PROJECT.md`。

## 4. 确定性 / 边界自检

- **同 seed 同输入同结果**：`r25-acceptance.test.ts`「同 seed 同输入逐字段一致」（含 `scheduledEvents` / `eventFires` / `lastFiredIndex` / `enqueueSeqCounter`）+ `scheduler.test.ts`「同输入两次出队序列一致」+ `replay.test.ts` 9 项自洽断言，全部通过。
- **时间 / 随机 / ID 可注入**：`game-core` 内无 `Date.now()` / `Math.random()`；`createWorldV2` 的 seed 可注入（`RunnerContext.rng`）；`instanceId = evi-<enqueueSeqCounter>` 由状态内计数器派生，不依赖外部 id 工厂。RNG 消耗顺序固化在 `scheduler.ts` 头注释。
- **hidden 未进入玩家端 API**：未新增任何 snapshot 字段；`r25-acceptance.test.ts` 断言投影不含 `scheduledEvents` / `enqueueSeqCounter` / `missedEvents` / `eventFires` / `lastFiredIndex` / `firedEvents` / `chains` / `flags` / `termination`，且 `npcs` / `activeChains` 白名单投影不含私有字段。
- **未引入 Lifecycle 状态机 / 阶段日志**：`boundary.test.ts` 5 项静态边界检查通过；无 `lifecycle.ts` / `Phase` / `PhaseTransitionLog`；保留 R3 时间穿越 seam（窗口入队即固化绝对分钟）。
- **game-core 不含 React / Fastify / DB / LLM SDK**：未新增任何此类 import。
- **退役字段残留扫描**：
  - `grep -rn "atTurn\|atWorldTime\|cooldownTurns" specs/data/templates --include="*.yaml"` → 仅 `skills.yaml`（技能冷却）与 `world.yaml:110`（NPC 行动冷却），**均为裁决明令不改的独立语义**；事件触发侧零残留。
  - `grep -rn "openingScheduled\|turnsPlayed" packages apps --include="*.ts"` → **CLEAN**。
  - `action-hook` 仍是触发源唯一词（jjk `events.yaml:152` + 协议 §9.6 / §22.7）。
- **触发事实单一写入口**：`recordFire()`（`scheduler.ts`）覆盖 `firedEvents` + `lastFiredIndex` + `eventFires` 三处；`ending.ts#applyDeathRoute` 的散写已改为 `recordFire`；`chooseOptionV2` 不再重复写（见 §6.8）。

## 5. 模板迁移的具体裁决落点（须报备）

- **唯一的 `flag: turnsPlayed` 模板条件**：`jjk-2006/events.yaml` 的 `ev-finger`（`conditions: [{ flag: turnsPlayed, gte: 5 }]`）。按裁决 10 迁移为等价表达 `{ time: { gte: { value: 20, unit: hour } } }`（每轮默认 4h × 5 ≈ 20h），注释已在模板内写明来源。全仓 `grep turnsPlayed specs/data/templates --include="*.yaml"` → **CLEAN**。
- **`cooldownTurns: N` → `cooldown: { value: N, unit: day }`**：按主理人给定映射执行（4/6/5/3 四处）。注意这是**语义重置而非严格等价换算**（默认 4h/轮时原 `N` 轮 ≈ `4N` 小时）；本轮按裁决统一到「天」量级，未做逐条时长反推。
- **`timeCost`**：jjk 模板**未新增**任何 `timeCost`。主线事件的时间流逝已由选项效果 `advanceBy: {value:1, unit:day}` 表达（四处），再叠 `timeCost` 会双计；其余事件叙事不消耗时间 ⇒ 全部省略（缺省 0，符合 R-EV-14）。`r25-acceptance.test.ts` 用独立最小模板覆盖 `timeCost=0` 与非 0 两条路径。
- **指纹**：`apps/server/src/templates.ts#computeFingerprint` 在 `loadTemplates()` 时对模板目录全部 `.yaml` 运行时 sha256，**无存库常量**；模板改动后自动重算，落盘信封已见新指纹 `sha256:f92a7b6a…`。
- **RNG 基线**：`replay.test.ts` 的断言是「同输入两次回放自洽」而非硬编码事件序列，故无需重录；`v2.test.ts` 三处旧断言因「结算轮跑完整管线」改为新行为断言（§6.10）。所有改动 RNG 消耗次序的提交信息均标注「同 seed 序列变更」。

## 6. 决策与偏差（相对主理人 brief / 规格）

| # | 偏差 | 理由 |
|---|---|---|
| 6.1 | `instanceId` 由 `state.enqueueSeqCounter` 派生，而非 design §3.3 的 `RunnerContext.idFactory("evi")` | id 必须进存档且不能依赖调用方注入的上下文；计数器单调且可重建，确定性更强。已在 `scheduler.ts` 注释记录。 |
| 6.2 | **过渡期三索引并存**：保留 `firedEvents: Record<string, number>`，同时写 `eventFires[]` / `lastFiredIndex`，统一由 `recordFire()` 写入 | 主理人显式许可的兼容决策：`ending.ts#eventOccurred` 与 ~27 处既有消费/测试仍读 `firedEvents`。已在代码注释标注「R2.6 收敛」，未新增散写。 |
| 6.3 | `setNpcLifecycle` / `spawnNpc` 效果**未加**（连 schema-only 也没加） | 属 R2.6；brief 允许「preferably skip and report the deviation」。协议 §12 已注明模板不得使用。 |
| 6.4 | `opening.handoff()` 增加**可选**第三参 `lookup?: TemplateLookup`；并新增 `enqueueScheduledInput.absoluteStart?: number` | `OpeningScheduledEventSchema.at` 语义是「相对世界起始」，与 `TimeSpec`「默认相对入队时刻」(#37) 不同；交接可能发生在 `advanceTo` 之后，直接按相对量会被二次平移（实测 `opening.test.ts` 首轮触发失败）。改为按绝对分钟固化；`lookup` 用于在没有 `at` 时回退到定义的 `window.start`。旧 2 参调用仍编译可用。 |
| 6.5 | `advanceWhen: nextTurn` **保留** | `design.md §3.8 / §7 Q-R25-06` 推荐 A「保留（下一轮是槽位语义而非时间量）」，未检索到用户的关闭裁决；按 brief「否则 keep」执行。协议 §9.3 / §22.7 已标明。 |
| 6.6 | `engine.ts` 与 `scheduler.ts` 存在**单向运行期互引**（scheduler 读 `checkAllConditions`、engine 写 `enqueueCandidate`） | 为避免把 `enqueueEvent` 效果退化成「收集请求再由调用方代执行」，选择直接在效果执行器消费。双方只在函数体内互相调用、无顶层求值，ESM 函数声明提升可保证初始化安全；19 个测试文件与 tsx 启动均验证无循环初始化问题。 |
| 6.7 | `drainDue()` 采用**多轮 pass**（上限 8）而非「仅内联 drain 一次」 | `onFire` 内 `advanceBy` / `enqueueEvent` 产生的新到期实例需在同一安全边界消费；不在 drain 循环内递归（符合 §3.4.5 断链保护），每轮结束后才开下一 pass，且无到期 waiting 实例时立即收敛。 |
| 6.8 | `chooseOptionV2` **删除**了 `state.firedEvents[event.id] = state.turnIndex` | 事件的触发事实已在 `triggerEventV2` 内经 `recordFire()` 记录；结算不是「再次触发」，重复写会追加虚假 `eventFires` 事实。`ending.ts#applyDeathRoute` 的同类散写已改为 `recordFire()`。 |
| 6.9 | **战斗结束结算轮只做 `turnIndex += 1` + 时间推进 drain，未跑 `runTurnTail()` 完整 NPC/pool 尾管线** | brief 对 `battleActionV2` 的指令只有「turnIndex += 1（结算轮），战果留在槽位」，并明确「Extract the shared pipeline into a single function used by both `advanceTurnV2` and `chooseOptionV2`」。为避免往同一个已由战果占据的槽位再塞 pool 事件，按 brief 执行；这与「轮语义单一」在战斗结束时存在口径差异，**如实登记，留给 QA / 后续迭代裁定**。 |
| 6.10 | 三处旧断言按新行为重录（未削弱/删除） | `v2.test.ts`「识破伏击」的 `pendingEvent===null` → 改断言「主线链无残留待决且 `status=completed`」；「选择选项生效并清空待决」→ 改断言「`turnIndex+1` 且尾管线为下一槽位补入池事件」；「后到高优先级插队」→ 期望数组新增结算轮补入的 `ev-normal`。均为 #34「事件轮跑完整管线」的必然结果，已在测试注释标明。 |
| 6.11 | 夹具预置 `firedEvents` 时同步 `consumeScheduleInstance()` | `once` 按用户裁决是**入队门控**，出队判定不再重查 once；「模拟开场事件已发生」的夹具必须同时把对应 waiting 实例标 `cancelled`，否则会被新队列模型重触发。属夹具语义对齐，非引擎行为放宽。 |
| 6.12 | 协议章节落点 | 按 team-lead 更正：触发文档全部落在 §9（新增 **§9.6 触发契约**）与新增 **§22 调度章节**；§8 items.yaml 未改；§12 补 `missWhen` 谓词与 `enqueueEvent` 效果；§13 补 R2.5 校验；§14 补调度/错失/槽位用例；§21.2 改 `schemaVersion: 2` + 新状态字段。因 §9.5 已是「NPC 自主行动」，触发契约另起 §9.6 而非覆盖 §9.5。 |
| 6.13 | `test-design.md` 未改写 | 该文件仍含与已关闭裁决冲突的旧用例（如 TC-ADR11-11a 期望 `reason: "once"`、TC-ADR11-21 的 #34 双案标注、6.1 节的 `TimeExpr` 字样）。本轮范围是对齐实现与协议，**未擅自重写用例规格**；已在 §7.2 登记为待 QA/规格轮处理项。 |

## 7. 未完成项与风险

### 7.1 T1-09 部分满足项
- tasks.md T1-09 DoD 要求的「curl 端到端证据：**到点触发 / 错失 / 断链不误判**」中，**到点触发与链连续推进**已用 HTTP e2e 举证（§1.1）；**错失（`miss_when` / `window_expired`）落日志**与**断链不误判的负向用例**仅由 `scheduler.test.ts` / `r25-acceptance.test.ts` 单元与集成用例覆盖，**未做 curl 级端到端**。理由：jjk-2006 模板未声明 `missWhen` 与带 `window.end` 的事件，走 HTTP 需要先新增专用测试模板（超出本轮「不擅自扩展范围」约束）。建议 QA 在验收时以单测结果裁定，或列入 R2.6 补 e2e 模板。

### 7.2 规格与验收侧遗留
- `specs/iteration-2026-11-11-r25/test-design.md` 存在与已关闭用户裁决冲突的旧用例（见 §6.13），**未改写**；建议规格轮或 QA 统一。
- `design.md §7 Q-R25-04 / 06 / 08 / 10` 仍为「待决/推荐」状态；本轮按 brief 与主理人裁决执行（06 保留 `nextTurn`、04 仅事件触发冷却改时间维度），**未自行关闭这些OPEN_QUESTION**。
- 用户裁决 #39 / #43 / #44 / #45（真实公历 / 自定义纪元与年号 / 字符串 `TimeSpec` / 世界时间数值上界）与 #41 / #46 的 NPC 侧实施**全部顺延 R2.6**，本轮零实现；`CalendarAdapter` 仅预留 `parseTimeSpec` / `toMinutes` 接口形状，加载期不做字符串解析、无数值上界拒载。
- `eventFires` 与 `firedEvents` 双索引收敛、`hidden` 信息投影重构、`setNpcLifecycle` / `spawnNpc` / `npcState` 条件、`birthTime` / 关系图均属 R2.6。

### 7.3 已知行为风险
- `once` 只在入队门控求值（用户裁决）：若同一事件在队列实例 waiting 期间经其它路径（链/钩子/效果）被触发，该实例仍会在到期时触发一次。jjk-2006 现网模板未构造此情形；夹具用 `consumeScheduleInstance()` 对齐。若后续模板出现，需要规格层明确「是否出队终判重查 once」——**未现场拍板**。
- pool 事件无 `delay` 时 `window.start = now`，在**同一次结算轮的尾管线**即被 drain 触发并进入下一槽位；在概率为 1 且无冷却的模板里会连续占槽（已在 `v2.test.ts` 重录断言中体现）。真实模板带 probability/cooldown，不会无限占槽。
- 破坏性 `schemaVersion` 变更使所有旧存档不可续玩；服务日志已确认 8 条旧档被跳过且不阻断启动。

## 8. 是否修改了 Spec

**是**。本轮修改的规格/文档文件：
- `specs/data/TEMPLATE_PROTOCOL_V2.md`（§9.1 / §9.3 / §9.4 / 新增 §9.6 / §12 / §13 / §14 / §21.2 / 新增 §22）
- `tasks/reports/R25-COMPLETION.md`（新增，本文件）
- `specs/iteration-2026-11-11-r25/tasks.md`（实施状态小节，见下）
- `PROJECT.md`（状态快照，见下）
- `specs/data/templates/jjk-2006/events.yaml` / `opening.yaml`（模板数据与注释）
- `specs/iteration-2026-11-11-r25/{README,design,requirements,tasks}.md` 与 `docs/{DECISIONS,OPEN_QUESTIONS}.md`、`specs/iteration-2026-11-11-r25/test-design.md`（`1c87f04` 承接的用户裁决回填，**非本轮新写**）

> 未提交、保持 untracked 的用户参考物：`specs/data/templates/jjk-2006/咒术转盘☆第二版.wheel.json`（139 KB，meme-auto-wheel-config）。加载器只读 `*.yaml`，对模板集无影响；按 team-lead 指示**不纳入 commit、不作为模板数据**。

## 9. 收尾状态

- 最终工作树：`pnpm typecheck` 0 错误；game-core 275/275、shared 50/50、`pnpm build` 通过；服务 `/api/templates` 200；HTTP e2e 到点触发与链推进正常。
- 未宣布验收通过：本报告只记录自验结果，验收由 `life-sim-qa` 裁定。
