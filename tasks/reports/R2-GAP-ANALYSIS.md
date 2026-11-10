# R2.1 阶段 0 差距分析报告（R2-GAP-ANALYSIS）

> **快照基准**：本报告基于 **2026-11-11 03:34–03:47 (GMT+8)** 的工作区代码静态快照（精确时段由驱动方在验收时补齐；Agent 侧工具集无 Bash / 系统时钟，无法自行读取）。所有结论与行号以本次会话逐文件读取到的内容为准（详见 §0 读取清单）。
>
> **并发声明**：仓库存在**另一 Agent 的 42 项未提交 WIP（v2 实现正在写入）**。本次复核确见 v2 基础模块（time / npc / battle / projection / turn / engine）已落盘，但 R2 的 Lifecycle / Opening / Ending / Evaluation / Archive / Equipment / Combat-AI 分层尚未开始；且 `DECISIONS.md` 中 ADR-0003「组队战斗」草案已部分落进 `battle.ts` 却仍标「待评审」——规格文档与 WIP 并不同步。**本报告结论可能随该 WIP 的提交而变化。** 本报告未执行任何 git 操作，未提交、未触碰该 WIP。
>
> **执行范围**：`tasks.md` 的 T0-01 / T0-02 / T0-03。只交报告，不改实现代码、不写 ADR（尤其不写 ADR-0004）、不重构、不补 R3 前置项。

------------------------------------------------------------------------

## 0. 读取清单、范围口径与五态定义

### 0.1 已读文件（证据来源）

| 类别 | 文件 |
|---|---|
| 工程规范 | `AGENTS.md` |
| 本轮四件套 | `specs/iteration-2026-11-11/{README,requirements,design,tasks}.md` |
| 两份原文 | `specs/DESIGN_INCREMENT_LIFECYCLE_2026-11-11.md`、`specs/DESIGN_INCREMENT_2026-11-10.md`（含附录 A 决策状态） |
| 协议/引擎/决策 | `specs/data/TEMPLATE_PROTOCOL_V2.md`（15 章）、`specs/engine/CORE_ENGINE.md`、`docs/DECISIONS.md`、`docs/OPEN_QUESTIONS.md` |
| 实际代码·v2 | `packages/game-core/src/v2/{engine,turn,time,lookup,npc,battle,projection}.ts`（7 个源码；另有 `time.test.ts`、`npc.test.ts`） |
| 实际代码·schema | `packages/shared/src/schema/{common,character,skill,item,status-effect,npc-action,event,world,index}.ts`、`packages/shared/src/{v2,index}.ts` |
| 实际代码·legacy | `packages/game-core/src/{evaluation,turn,world,index}.ts` |
| 应用编排 | `apps/server/src/{index,templates,store}.ts` |
| 模板 | `specs/data/templates/jjk-2006/{world,characters,skills,items,statuses,events}.yaml`（仅此一套） |

**路径缩写**（下表与逐条证据使用，均为仓库根相对路径）：

- `v2/` = `packages/game-core/src/v2/`
- `schema/` = `packages/shared/src/schema/`
- `shared/` = `packages/shared/src/`
- `legacy/` = `packages/game-core/src/`
- `server/` = `apps/server/src/`
- `协议` = `specs/data/TEMPLATE_PROTOCOL_V2.md`
- `引擎规格` = `specs/engine/CORE_ENGINE.md`
- `design` = `specs/iteration-2026-11-11/design.md`

### 0.2 范围口径（R2.1，用户 2026-11-11 决定）

- **45 条 ACTIVE 需求**：LC 6 / OP 7 / EN 6 / EV 6 / AR 3 / EQ 6 / CA 5 / NFR 6，逐条标注五态（§2）。
- **7 条 DEFERRED**（`R-TT-01..07`）：单列 §2.F，**只登记「延期（R3）」**，不分析实现、不做设计、不写 ADR。
- **33 个 ACTIVE 任务**（阶段 0–6、8）；`tasks.md` 阶段 7、`T1-02`、`ADR-0004` 全部 DEFERRED。
- 正确性属性本轮覆盖 **P1–P3、P5–P8**；P4 随 A3 延期。
- 装备（A10）与战斗 AI（A11）**仍在本轮范围内**。

### 0.3 五态定义（本报告判定口径）

| 状态 | 含义 |
|---|---|
| **已实现** | 需求的可测语义在当前代码已完整成立，补回归测试即可验收。 |
| **部分实现** | 存在可复用的基础设施，但缺关键环节（模板分域 / 阶段门禁 / 记录 / 接线等），需增量补齐。 |
| **缺失** | 当前代码无任何对应实现，需新建模块 / schema / 模板分域。 |
| **耦合** | 能力已存在，但被放进错误模块或与其它职责绑定，需先解耦再复用。 |
| **需重构** | 现有数据结构或行为与目标规则直接冲突，必须改结构/语义才能兼容。 |

> 对「不得…/应当复用…」这类**约束性需求**，本报告区分「禁令未被违反（基础设施具备）」与「能力已接线（验收用例可跑）」，并在证据中写明；仅在二者皆成立时才判「已实现」。

### 0.4 五态总览（45 条 ACTIVE）

| 组 | 已实现 | 部分实现 | 缺失 | 耦合 | 需重构 | 合计 |
|---|---|---|---|---|---|---|
| LC | 0 | 0 | 6 | 0 | 0 | 6 |
| OP | 0 | 3 | 3 | 0 | 1 | 7 |
| EN | 0 | 0 | 6 | 0 | 0 | 6 |
| EV | 0 | 0 | 5 | 1 | 0 | 6 |
| AR | 0 | 1 | 2 | 0 | 0 | 3 |
| EQ | 0 | 2 | 4 | 0 | 0 | 6 |
| CA | 1 | 2 | 2 | 0 | 0 | 5 |
| NFR | 0 | 3 | 1 | 0 | 2 | 6 |
| **合计** | **1** | **11** | **29** | **1** | **3** | **45** |

------------------------------------------------------------------------

## 1. 全局结构结论（先看这一节）

当前 `game-core` 是**一套完整的 V2 轮次模拟内核 + 一套并存的 V1 legacy 内核**，但**没有任何 Lifecycle 概念**：

- `WorldStateV2`（`shared/v2.ts:148-168`）字段为 `id / templateId / seed / turnIndex / worldTime / playerAgeAtStart / player / npcs / flags / firedEvents / chains / pendingEvents / battle / lastWheel / history` —— **无 `phase`、无 `LifecycleState`、无 `phaseLog`、无 `openingId`、无 `endingRecordId` / `evaluationRecordId`**。
- 全仓 Grep（`packages/`）对 `LifecycleState|phaseLog|openingId|EndingRecord|EvaluationRecord|ARCHIVED|EVALUATING|OPENING|ENDING|CREATED` **零命中**；对 `definitionId|worldLineId|EventInstance|origin` **零命中**。
- `v2/` 目录仅 9 个文件（Glob）：`time / lookup / npc / engine / battle / projection / turn` + 2 个 test；**无 `lifecycle.ts / opening.ts / ending.ts / life-evaluation.ts / archive.ts / equipment.ts / combat-ai.ts`**。
- `schema/` 仅 8 个领域文件（`schema/index.ts:7-14`）；**无 `lifecycle / opening / ending / evaluation / equipment / combat-ai / event-instance`**；`WorldTemplateV2Schema` 为 `.strict()`（`schema/world.ts:176`），新增分域必须显式扩 schema。
- `apps/server/src/index.ts` 的 API 只有 `worlds / turns / events/choose / battle / items/use / history`（L61-195），**无 lifecycle / ending / evaluation / archive 端点**；全文件**无 LLM adapter / provider**（L1-241）。

------------------------------------------------------------------------

## 2. 逐条需求标注（按需求编号组织）

### A. Lifecycle 生命周期骨架（R-LC-01 ~ R-LC-06，6 条）

| 需求 | 状态 | 证据（文件:行号） | 说明 | 最小改造建议（仅建议） |
|---|---|---|---|---|
| **R-LC-01** 六阶段状态机、绑定世界与开局模板 | **缺失** | `shared/v2.ts:148-168`（WorldStateV2 无 phase/模板绑定字段）；`v2/turn.ts:38-116`（`createWorldV2` 仅记 `templateId`）；`schema/world.ts:88-175`（模板无 openings 分域） | 无 `Phase` 类型、无合法迁移表、无 `lifecycle.ts` | 新建 `schema/lifecycle.ts`（`Phase` + `LifecycleState`）与 `v2/lifecycle.ts`（`transition()` / `assertPhase()`）；`LifecycleState` 作为 `WorldStateV2` 并列顶层字段（落点须经 ADR，见 §6.1）；创建时绑定 `openingId` |
| **R-LC-02** 非法迁移拒绝、状态逐字段不变 | **缺失** | `shared/v2.ts:148-168`（无 phase）；全仓 Grep 无 `transition/assertPhase` | 无迁移入口，故无「非法迁移」可拒 | 同上；`transition()` 内做纯函数式校验，失败返回可诊断 `Result` 错误且不改入参 |
| **R-LC-03** Lifecycle 只做阶段编排，不 import 事件/时间/评分 | **缺失** | 模块不存在（Glob `v2/` 无 `lifecycle.ts`） | 现状反向：评价被塞进 `advanceTurn` / `projectSnapshot`（见 §3） | 新建 `v2/lifecycle.ts` 且**只导出阶段查询与迁移函数**；配静态边界检查（对应 T2-03）断言不 import 事件结算 / 历法换算 / 评分实现 |
| **R-LC-04** CREATED/OPENING 拒绝普通轮次推进 | **缺失** | `v2/turn.ts:378-389`（`advanceTurnV2` 入口仅校验 `pending_event_required` / `battle_in_progress`）；`server/index.ts:97-121` | 轮次入口无阶段门禁 | 在 `advanceTurnV2` 入口调 `assertPhase(state, ["RUNNING"])`，非 RUNNING 返回 `PHASE_NOT_RUNNING` 且世界时间/历史不变 |
| **R-LC-05** ENDING 及之后停止接收普通行动、当前事件结算完成后固化 | **缺失** | `v2/turn.ts:378-461`（无 phase 判定、无结算边界收尾）；`v2/battle.ts:504-531`（`finishBattle` 仅为战斗收尾，非生命周期固化） | 无 ENDING 概念 | 门禁 + 在「事件结算后 / 时间推进后 / 玩家主动结束」三个边界调用终止检查（与 R-EN-02 共点） |
| **R-LC-06** 每次阶段切换写含 from/to/原因/世界时间/轮次的日志 | **缺失** | `shared/v2.ts:148-168`（无 `phaseLog`）；`v2/turn.ts:488-499`（`pushHistory` 写 `HistoryEntryV2`，无阶段切换类型） | 无 `PhaseTransitionLog` | `LifecycleState` 增 `phaseLog[]`，`transition()` 内 append；日志条数与迁移次数一一对应 |

### B. Opening 开局（R-OP-01 ~ R-OP-07，7 条）

| 需求 | 状态 | 证据（文件:行号） | 说明 | 最小改造建议（仅建议） |
|---|---|---|---|---|
| **R-OP-01** 多 `OpeningTemplate`、按 `openingId` 选 | **缺失** | `server/index.ts:35-39`（`createWorldSchema` 仅 `templateId/playerName/seed`）；`schema/world.ts:88-175`（模板无 `openings`） | 无开局模板分域、无 `openingId` 入参 | 模板新增 `opening.yaml` 分域与 `OpeningTemplate` schema；`createWorldSchema` 增 `openingId`；`createWorldV2` 按开局模板覆盖起始时间/地点/身份 |
| **R-OP-02** 模板声明开局步骤及顺序、可增删步骤、`OpeningRun` 记录 | **缺失** | `schema/index.ts:7-14`（无 opening schema）；Glob `v2/` 无 `opening.ts` | 无步骤模型、无 `OpeningRun` | 新建 `schema/opening.ts`（`steps[]`，`required/optional/branch`）+ `v2/opening.ts`；`OpeningRun.executedSteps[]` 记录实际执行序列 |
| **R-OP-03** 固定必要步骤 + 事件池随机抽取 + 关键节点玩家选择 | **部分实现** | `v2/turn.ts:292-315`（`resolvePoolV2`：conditions→once/cooldown→probability/weight→priority）；`v2/turn.ts:227-236`（`pickIndex` 加权）；`v2/turn.ts:656-671`（`pendingEventView` 选项 `visibleWhen` 过滤）；`v2/turn.ts:503-546`（`chooseOptionV2`） | 随机抽取与玩家选择基础设施存在于**普通模拟**，但无「开局」语境、无固定必要步骤编排、无 `OpeningRun` | 复用 `resolvePoolV2` / `chooseOptionV2` 的抽取与选项设施，由 `v2/opening.ts` 组织「固定步骤 + 抽取 + 选择」序列；同 seed 复现走现有 `deriveTurnSeed` |
| **R-OP-04** 开局事件池 `tags/weight/conditions/required/countRange/exclusiveGroup/sequence/seed/effects/nextEvents` | **部分实现** | `schema/event.ts:13-43`（`EventTriggerSchema` 有 `conditions/weight/cooldownTurns/once/priority`）；`v2/turn.ts:200-207`（`weightBy` 属性加权）；`schema/common.ts:154-177` + `schema/event.ts:54,74`（`effects` / `nextEventId`） | 已有 `weight / conditions / effects / nextEvents` 的可复用语义；**缺 `tags / required / countRange / exclusiveGroup / sequence / seed` 六项**；现有是「事件触发」而非「开局事件池抽取」 | 在 `OpeningTemplate.eventPools[]` 中定义这 6 个抽取字段，`v2/opening.ts:drawOpeningEvents()` 实现（互斥组至多命中一、`required` 必出、`countRange` 落区间）；`weight/conditions/effects/nextEvents` 直接复用现有 schema 语义，不重复造 |
| **R-OP-05** 初始化世界状态，关系带来源、不默认所有 NPC 认识主角、信息可见性分级 | **需重构** | `schema/character.ts:56`（`relationship` 为**必填**数值 `-100..100`）；`v2/turn.ts:72-96`（`createWorldV2` 每个 NPC 都写 `relationship: c.relationship`，L87）；`shared/v2.ts:59-76`（`V2Npc` **无 `visibility` 字段**）；`schema/character.ts:31`（模板有 `visibility: public\|hidden` 但未映射进运行时）；`v2/projection.ts:91-99`（NPC 投影输出白名单字段、不过滤 visibility） | 与目标规则**直接冲突**：模板强制每个 NPC 都有关系值（默认即「相识」），且角色可见性未透传运行时，信息分层 `known/inferred/unknown/hidden` 不完整 | 改 `CharacterSchema.relationship` 为可选 / 允许 `unknown` 关系态；`V2Npc` 增 `visibility` 与关系来源字段；`createWorldV2` 仅在模板声明时建关系；投影按 `visibility` 过滤（与 §5 seam ③ 同改）。**属数据结构变更，按 `AGENTS.md` §0 先经 ADR 评审** |
| **R-OP-06** 开局事件复用统一事件系统、连续事件进 chains、未来/条件事件进 schedule、不建栈、不加枚举、实例标 `origin` | **部分实现** | `schema/event.ts:15`（`source` 固定 `pool/chain/schedule/action-hook` 4 类）；`v2/turn.ts:130-135`（`EVENT_SOURCE_PRIORITY`）、`147-165`（`pendingEvents` 有序队列，非栈）；`v2/engine.ts:351-363`（`startChain`）、`v2/turn.ts:239-271,337-346,348-368`（链/schedule/nextEventId 路由）；**全仓 Grep `origin\|EventInstance\|definitionId` 零命中** | 「复用统一事件系统、不建栈、不加枚举」**成立**；**缺实例级 `origin` 元数据与 EventInstance 层**（详见 §4 T0-03） | 新增 `schema/event-instance.ts`（`instanceId / definitionId / origin{kind,id}`），在 `triggerEventV2` 产实例；`origin` 只标 `opening + openingId`；**不动 `source` 枚举**、不建栈模块 |
| **R-OP-07** `completionConditions` 满足后 `handoff` 交接并迁移 `RUNNING` | **缺失** | `v2/turn.ts:38-116`（`createWorldV2` 无 phase）；全仓 Grep 无 `handoff` | 无 `handoff()`、无 `completionConditions`、无 `RUNNING` 迁移 | 新建 `v2/opening.ts:handoff()`：未完结即时事件接入现有 `pendingEvents` / chains，未来事件接入 schedule，再调 `transition(state,"RUNNING")`；首轮 `advanceTurnV2` 能消费 |

### C. Ending 结局（R-EN-01 ~ R-EN-06，6 条）

| 需求 | 状态 | 证据（文件:行号） | 说明 | 最小改造建议（仅建议） |
|---|---|---|---|---|
| **R-EN-01** 七类终止条件 + AND/OR 组合 | **缺失** | `schema/common.ts:140-150`（`ConditionSchema` 仅 9 类：flag/attribute/status/inventory/mood/relation/requiresSkill/random/time）；`schema/common.ts:123-138`（已有 `time` 条件可复用）；全仓 Grep 无终止条件实体 | 无 `EndingCondition`、无 `combinator(AND/OR)`、无目标/事件/玩家主动结束条件 | 新建 `schema/ending.ts`：`EndingCondition{ type, params, combinator, terminationMode }`；条件求值复用 `checkAllConditions()`（`v2/engine.ts:205-208`）并加 OR 组合器 |
| **R-EN-02** 只在明确模拟边界检查终止条件 | **缺失** | `v2/turn.ts:378-461`（轮次 10 步无终止检查点）；`v2/battle.ts:398-410`（`checkBattleEnd` 仅战斗胜负，非生命周期终止） | 无边界检查 | `checkTermination()` 只挂在「事件结算后 / 时间推进后 / 玩家主动结束」三处；与 R-LC-05 共用边界 |
| **R-EN-03** 立即终止 / 默认结算后终止、无半更新状态 | **缺失** | `v2/battle.ts:405-409`（战斗 HP 保底 1 不死，属战斗善后，非终止）；`schema/common.ts:169-172`（`advanceTo/advanceBy` 效果，无 `terminationMode`） | 无 `immediate/afterSettle` 模式 | `EndingCondition.terminationMode` 由模板声明；`afterSettle` 为默认，在当前事件效果全部落库后再固化 |
| **R-EN-04** 收集状态/关系/事件/选择 → 筛选 → priority/专属/exclusiveGroup/fallback 决胜 → 固化 `EndingRecord` | **缺失** | 全仓 Grep `EndingRecord` 零命中；`shared/v2.ts:137-146`（`HistoryEntryV2` 仅 type/summary/detail，可作过程素材但无选择记录结构） | 无 `ending.ts`、无 `EndingRecord` | 新建 `v2/ending.ts:resolveEnding()` + `schema/ending.ts:EndingRecord`；决胜默认不依赖随机数（同输入稳定）；`history` / `flags` 作为筛选输入 |
| **R-EN-05** 结局模板字段、隐藏/互斥/兜底结局、模板不含评分字段 | **缺失** | `schema/world.ts:88-175`（无 endings 分域）；`schema/index.ts:7-14` | 无 `EndingTemplate` | 模板新增 `endings.yaml` 分域；`EndingTemplateSchema` 含 `endingId/triggerConditions/priority/endingType/narrativeConfig/visibility/exclusiveGroup/fallback`，**结构内不设评分字段**（静态检查） |
| **R-EN-06** LLM 结局叙事含虚构事实/改状态/校验失败 → 拒绝并回退模板文本 | **缺失** | `server/index.ts:1-241`（全文件无 LLM adapter / provider / narrative）；`shared/v2.ts:226-269`（`V2Snapshot` 无叙事来源字段） | 无叙事 adapter、无 Zod 结构校验、无 `narrativeSource(template/llm/fallback)` | 在 `apps/server` adapter 层加 LLM 输出 Zod schema 与模板文本/变量填充回退；`game-core` 只接收已校验结构化结果（`design` §10） |

### D. Evaluation 人生评价（R-EV-01 ~ R-EV-06，6 条）

| 需求 | 状态 | 证据（文件:行号） | 说明 | 最小改造建议（仅建议） |
|---|---|---|---|---|
| **R-EV-01** 结局与评价两个独立结果、结局类型不决定评分 | **耦合** | `shared/v2.ts:268`（`V2Snapshot.evaluation` 把评价做成投影的一个字段）；`v2/projection.ts:112-115`（每次投影调 `evaluateSummaryV2`）；`legacy/evaluation.ts:39`（`projectSnapshot` 内调 `evaluateLife`）；全仓 Grep `endingType/EndingRecord` 零命中 | **现状不存在「结局类型→人生评分」的直接映射链路**（根本没有结局/endingType 概念，见 §3.1）；但评价**不是独立结果**，而是嵌在轮次/投影里的派生文本，与 R-EV-01「两个独立结果」相悖 | 新建 `v2/life-evaluation.ts` 产出独立 `EvaluationRecord`（本局只读），在 `EVALUATING` 阶段一次性生成；从 `V2Snapshot` 移除按轮实时评价；结局类型仅作背景输入、不进评分函数 |
| **R-EV-02** 六通用维度 + 模板增删改名调权 + 世界观专属维度 | **缺失** | `legacy/evaluation.ts:67-88`（legacy 仅 4 个**硬编码中文**维度：成长/关系/成就/命运偏离）；`v2/projection.ts:186-201`（v2 无维度，仅单一 `overall`） | 无 `EvaluationConfig`、无六维度、维度不可由模板配置 | 新建 `schema/evaluation.ts`：`EvaluationConfig.dimensions[{id,label,weight,ranges,explainRules}]` + `worldSpecificDimensions[]`；六维度为模板缺省而非引擎常量 |
| **R-EV-03** 基于整个过程计算（事件/选择/目标完成/关系变化/成长轨迹/长期影响） | **缺失** | `v2/projection.ts:187-194`（`evaluateSummaryV2` 只读 `state.player.attributes` / `flags` / `npc.relationship`）；`legacy/evaluation.ts:54-65`（`evaluateLife` 同样只读最终面板）；`shared/v2.ts:137-146,167`（`history` 已存在但**评价完全未消费**） | 过程记录 `state.history` 已在，但评价只看最终属性面板 | `evaluateLifeV2()` 输入改为最终状态 + `history` + `flags` + 关系变化 + 目标完成；评分差异可归因到历史事件（P6） |
| **R-EV-04** 各维度得分/等级/解释 + 成就/关系总结 + 贡献/遗憾 + 总结文案 + **评价依据 evidenceIds** | **缺失** | `legacy/evaluation.ts:98`（返回 `{summary,dimensions,canonDeviation}`，无证据 ID）；`shared/v2.ts:268`（投影评价仅 `{summary,canonDeviation}`）；全仓 Grep `evidenceIds` 零命中 | 无 `EvaluationRecord`、无 `EvidenceRef`、无证据可解析性（P6） | `EvaluationRecord.dimensions[].evidenceIds[]` 关联 `HistoryEntryV2.id`（`shared/v2.ts:138`）或选择记录；保证每条 ID 可在本局历史解析 |
| **R-EV-05** 确定性规则评分 + 模板权重/区间 + LLM 只组织语言、篡改分数被结构校验拒绝回退 | **缺失** | `legacy/evaluation.ts:53-99` 与 `v2/projection.ts:186-201` 均为**确定性纯函数**（这半句成立）；`server/index.ts:1-241`（无 LLM adapter / 无 Zod 输出校验 / 无 `summarySource`） | 评分确定性已具备，但「LLM 组织总结 + 结构校验 + 回退」整条链路缺失 | 评分保留纯函数；LLM 只接收 `EvaluationRecord` 组织自然语言，输出经 Zod（分数/维度/证据 ID 只读）校验，失败回退模板文本并标 `summarySource: fallback` |
| **R-EV-06** EVALUATING→ARCHIVED 后只读、评价不改结局/模拟结果 | **缺失** | `shared/v2.ts:148-168`（无 phase）；`server/store.ts:23-25`（`worldStore.save(state)` **无条件写入**，无只读门禁）；全仓 Grep `ARCHIVED` 零命中 | 无 ARCHIVED 阶段、无只读标记 | `assertPhase` 门禁 + `archive.ts` 标记只读；`worldStore.save` 前校验 phase，ARCHIVED 写操作返回只读错误 |

### E. Archive 归档（R-AR-01 ~ R-AR-03，3 条）

| 需求 | 状态 | 证据（文件:行号） | 说明 | 最小改造建议（仅建议） |
|---|---|---|---|---|
| **R-AR-01** 归档五类数据（状态快照/事件历史/结局/评价/阶段日志） | **缺失** | `shared/v2.ts:148-168`（`history/chains/flags` 已有，可作 2 类素材）；全仓 Grep `archive/EndingRecord/EvaluationRecord/phaseLog` 零命中；Glob `v2/` 无 `archive.ts` | 无归档组装；结局/评价/阶段日志三类记录均不存在 | 新建 `v2/archive.ts`：组装既有 `history/chains` + 新建的 `EndingRecord/EvaluationRecord/phaseLog`；事件 ID 可被评价证据引用 |
| **R-AR-02** ARCHIVED 本局记录只读 | **缺失** | `server/store.ts:23-25`（save 无门禁）；`shared/v2.ts:148-168`（无只读标记） | 任何写操作都能落库 | 归档时置只读标记；`worldStore.save` 与所有 `advanceTurnV2/chooseOptionV2/battleActionV2/useItemV2` 入口统一 `assertPhase` |
| **R-AR-03** 沿用现有存档机制、不新增独立存档子系统 | **部分实现** | `server/store.ts:5-26`（内存 Map `create/get/save`，无独立子系统 ✓）；`server/store.ts:5` 注释「**重启即清空**」；`server/index.ts:109,135,159,183`（各写操作后 `worldStore.save`） | 「不新增独立存档子系统」满足；但验收「服务重启后按现有机制恢复，行为与恢复前一致」**不成立**（纯内存无持久化） | 本轮按需求「沿用现有机制」不新增子系统；恢复语义缺口登记为风险（§8），不擅自引入持久化 |

### F. 时间穿越（R-TT-01 ~ R-TT-07，7 条）— ⛔ 只登记状态

> 依据：`requirements.md §0.2 / §F`、`DESIGN_INCREMENT_2026-11-10.md` 附录 A A3「下次迭代（本次不做）」、`ADR-0002`「P4 单独立项」、用户 2026-11-11 决定。**本节不分析实现、不做设计、不写 ADR。**

| 需求 | 状态 |
|---|---|
| R-TT-01 | **延期（R3）** |
| R-TT-02 | **延期（R3）** |
| R-TT-03 | **延期（R3）** |
| R-TT-04 | **延期（R3）** |
| R-TT-05 | **延期（R3）** |
| R-TT-06 | **延期（R3）** |
| R-TT-07 | **延期（R3）** |

对应 `tasks.md` 阶段 7（`T7-01..06`）、`T1-02`、`ADR-0004`、`design.md §8` 草案一并 DEFERRED；编号保留、不重排。本轮与该主题有关的唯一 ACTIVE 工作是 §5 的三个接口预留点现状核查（只报告、不补实现）。

### G. 装备系统（R-EQ-01 ~ R-EQ-06，6 条）

| 需求 | 状态 | 证据（文件:行号） | 说明 | 最小改造建议（仅建议） |
|---|---|---|---|---|
| **R-EQ-01** 模板定义槽位/可装备类别/品质档位/初始装备 | **缺失** | `schema/item.ts:9-23`（`ItemSchema` 仅 7 字段，`type` 枚举含 `equipment`，L12）；`schema/item.ts:5` 注释「equipment 类型 Schema 预留但引擎 V0.1 忽略」；`协议 §8`（L274-295）、`schema/world.ts:88-175`（无 equipment 分域） | `type: equipment` 仅枚举占位，**无 `slots[]/quality/category/effects/modifierMode`** | 模板新增 `equipment.yaml`（`slots[]{id,label,allowedCategories,maxCount}`）；扩 `ItemSchema` 的 `equipment` 分支字段（须保持 `.strict()`）；`server/templates.ts:14-21` 的 `TEMPLATE_FILES` 增该文件 |
| **R-EQ-02** 装备定义与实例分离（所属角色/槽位/耐久/层数） | **缺失** | `shared/v2.ts:53`（`V2Player.inventory: Record<itemId,count>` 仅数量映射）；全仓 Grep `EquipmentInstance` 零命中 | 无实例层、无所属/槽位/耐久 | 新建 `schema/equipment.ts`：`EquipmentDefinition`（模板只读）与 `EquipmentInstance{itemId,ownerId,slot,stacks?,durability?}`（本局）；与 `inventory` 数量映射并存或明确替代关系 |
| **R-EQ-03** 效果走现有声明式效果 DSL / `effectiveAttributes` + preset 白名单，不引入通用基础属性 / 自由表达式 | **部分实现** | `v2/engine.ts:52-76`（`effectiveAttributes` = 基础值 + 补正 `simulation.attributeModifiers` + 心情档位 + caps）；`v2/engine.ts:89-112`（`rollFormula` 仅 fixed/scaled/stack-scaled 三 preset）；`schema/common.ts:55-59,154-177`（`FormulaSchema` 判别联合、效果 DSL 白名单）；`schema/world.ts:124-130`（属性纯自定义 `attributes.order`） | 管线 + 白名单 + 纯自定义属性层**已具备**（ADR-0001/0002 约束未被违反）；**但装备效果→管线的接线缺失**（引擎忽略 equipment，`schema/item.ts:5`） | 装备效果声明复用 `EffectSchema` / `attributeModifiers`，在 `effectiveAttributes()` 读取已装备实例合并补正；**不新增求值器、不引入 HP/ATK/DEF/CRIT 语义** |
| **R-EQ-04** 静态词条 / 动态补正由模板 `modifierMode` 选择、`perStack` 明确报错 | **缺失** | `schema/status-effect.ts:22-29`（`SimulationFacetSchema.attributeModifiers` 仅固定值）；`schema/status-effect.ts:70`（`stacking: refresh\|stack\|unique` 有 stacks 语义可复用）；`docs/OPEN_QUESTIONS.md:22`（#18 `perStack` 属性补正明确不做）；`design §9`（L184） | 无 `modifierMode`、无动态补正路径 | `equipment.yaml` 增 `modifierMode: static\|dynamic`；`static` 走 `attributeModifiers` 固定值，`dynamic` 复用 `stacking/stacks` 缩放；遇 `perStack` 报可诊断错误而非静默忽略 |
| **R-EQ-05** 穿脱/替换参与属性管线、同 seed 可复现、Zod 校验槽位冲突 | **缺失** | `shared/v2.ts:53`（inventory 仅 count）；`v2/turn.ts:616-652`（`useItemV2` 仅消耗品，无 equip/unequip）；`schema/item.ts:20`（`.strict()` 可拒未知字段） | 无装备操作、无槽位冲突校验 | 新增 `equip/unequip/replace` 纯函数 + 槽位冲突 Zod 校验；结果并入 `effectiveAttributes()`；复现沿用 `deriveTurnSeed` |
| **R-EQ-06** 装备不得绕过 preset 判定白名单 / 控制语义白名单 | **部分实现** | `schema/status-effect.ts:13-20`（`ControlSemanticsSchema` 6 项白名单）；`schema/skill.ts:9-16`（`OpposedCheckSchema`）；`schema/common.ts:55-59`（`FormulaSchema` 三 preset）；`schema/item.ts:20`（`.strict()` 拒绝未知字段） | 白名单与 strict 校验**已具备**，现状无任何绕过路径；但装备分域字段未定义，「携带判定类字段被拒且错误指向具体字段」的专用校验路径尚未接线 | 装备效果字段限定为 `EffectSchema` 已注册项；非白名单字段由 `.strict()` 拒绝并在错误信息中带字段路径 |

### H. 战斗 AI 分层决策（R-CA-01 ~ R-CA-05，5 条）

| 需求 | 状态 | 证据（文件:行号） | 说明 | 最小改造建议（仅建议） |
|---|---|---|---|---|
| **R-CA-01** 五步「规则约束→候选集→评分→选择→结算」可单独测试 | **部分实现** | `v2/battle.ts:326-350`（`aiTurn`：L335 `cannot_act` 规则约束 → L339-342 `usable` 候选集 → L347 `pickWeighted` 选择 → L349 `executeSkill` 结算）；`v2/npc.ts:73-86`（`pickBest` 效用评分可复用） | 四步雏形在**单个函数**内，缺独立「评分」步、缺 `Decision{score,reasons[]}`、每步不可单独测试 | 抽出 `v2/combat-ai.ts`，把五步做成可单测的纯函数；结算交回 `battle.ts` 既有路径 |
| **R-CA-02** 风格解析为评分权重/候选集过滤参数、引擎内无风格名分支 | **缺失** | `schema/character.ts:53`（`private.combatHints: z.record(...)` 可放参数）；`v2/battle.ts:151,165,347`（`skillWeights` 简单权重）；全仓 Grep 无 `CombatStyleProfile` | 无风格模型、无 `candidateFilters/scoreWeights/conditions`；「引擎内无风格名字符串」这点现状满足（无风格名常量） | 新建 `schema/combat-ai.ts:CombatStyleProfile{styleId,candidateFilters,scoreWeights,conditions}` + `combat-ai.yaml`；风格名只进模板，引擎只消费权重/过滤参数 |
| **R-CA-03** 条件化 AI（低血优先治疗 / 按玩家属性针对性选技能） | **缺失** | `v2/battle.ts:339-342`（`aiTurn` 仅按 `mp` 与 `skillCooldowns` 过滤，无条件策略）；`docs/OPEN_QUESTIONS.md:17`（#13 待规格化） | 无条件化策略 | `CombatStyleProfile.conditions[]` 由模板声明，决策时按可见战况命中；可见信息边界（#13 待决）确认后再收紧 |
| **R-CA-04** 战斗 AI 不依赖 LLM、同 seed 同状态同模板产生相同选择 | **已实现**（约束层面，针对现有敌人 AI） | `v2/battle.ts:326-350`（`aiTurn` 无 LLM 调用，随机只来自注入 `rng`）；`v2/turn.ts:558`（`deriveTurnSeed(state.seed+13, turnIndex*100+round)`）；`v2/turn.ts:389`（轮次 `createRng(deriveTurnSeed(...))`） | 现有简单权重策略完全确定性、无 LLM 依赖，验收「两次决策逐字段相等 / 注入不可用 LLM 行为不变」成立 | 无改动；**R-CA-01/02/03 新建的分层 AI 必须继承该约束**（注入 RNG、零 LLM），并在 T6-04 补回归 |
| **R-CA-05** 只能从已注册行动/技能/控制白名单选择、非法 actionId 拒绝并回退 | **部分实现** | `v2/battle.ts:164`（`skills` 来自角色模板 `def.skills`）；`v2/battle.ts:339-342`（`lookup.skill(id)` + `kind==="combat"` 过滤）；`v2/battle.ts:429-433`（`performBattleAction` 有 `skill_not_found/skill_not_owned/not_enough_mp/skill_on_cooldown` 校验）；`schema/status-effect.ts:13-20`（控制白名单） | AI 只会从已注册技能里选，现状不会产生未注册 ID；但**无显式「AI 输出非法 actionId → 校验 → 回退合法候选」路径** | `combat-ai.ts` 选择结果经 Zod / 已注册 actionId 集合校验，非法则回退合法候选且状态不变（P7） |

### I. 横切约束（R-NFR-01 ~ R-NFR-06，6 条）

| 需求 | 状态 | 证据（文件:行号） | 说明 | 最小改造建议（仅建议） |
|---|---|---|---|---|
| **R-NFR-01** 同初始状态+同输入+同 seed 全链路可复现 | **部分实现** | `v2/turn.ts:389,515,558,628`（各入口 `createRng(deriveTurnSeed(...))`）；`v2/turn.ts:43,227-236,313`（seed、加权抽取、转盘）；`v2/battle.ts:558`（战斗 RNG 派生）；`v2/engine.ts:111`（`rollFormula` ±1 浮点扰动亦走 rng） | 现有全部随机走注入 seed，**基础复现性成立**；但阶段序列/开局抽取/装备/结局/评价/归档均未实现，无从纳入全链路回放 | 建立 `RunnerContext`（rng/now/idFactory 注入）与同 seed 全链路回放夹具（T2-04）；新增能力一律经该夹具 |
| **R-NFR-02** 模板/输入未过 Zod 则拒加载、错误含字段路径、无部分初始化 | **部分实现** | `server/templates.ts:45`（`WorldTemplateV2Schema.parse(merged)`）、`:11`（校验失败 fail-fast 拒绝启动）、`:29-47`（先合并后 parse，失败不注册）；`schema/world.ts:176`（`.strict()`）；`server/index.ts:73,103,128,153,177`（命令输入 `safeParse` + `parsed.error.flatten()`） | Zod + strict + flatten 基础设施已具备；但验收用例「缺 `openingId` 的模板加载报错含字段路径」**尚不能成立**（模板无 `openingId` 概念） | 新增分域时同步扩 schema 与 `loadTemplate` 合并逻辑；错误信息沿用 `flatten()` 字段路径 |
| **R-NFR-03** LLM 结构校验失败/超时 → 回退模板文本、不阻塞、不写状态 | **缺失** | `server/index.ts:1-241`（全文件无 LLM adapter / 无回退 / 无 `summarySource`）；`shared/v2.ts:226-269`（快照无叙事来源字段） | 无 LLM 参与，故不存在「LLM 阻塞」，但要求的「回退到模板文本」链路完全缺失 | adapter 层 LLM 输出 Zod 校验 + 模板文本/变量填充回退；`ARCHIVED` 必须可达（design §10） |
| **R-NFR-04** `hidden`/`unknown` 不得进入玩家端 API 投影 | **需重构** | `v2/projection.ts:29,125`（仅**补正**按 `def.visibility==="known"` 过滤 ✓）；`schema/character.ts:31`（模板有 `visibility: public\|hidden`）**未映射进** `shared/v2.ts:59-76`（`V2Npc`），`v2/projection.ts:91-99` NPC 投影不过滤；`shared/v2.ts:137-146`（`HistoryEntryV2` **无 visibility 字段**）；`v2/turn.ts:459`（`playerVisibleHistory: state.history.slice(-20)` 无过滤）；`server/index.ts:190-195`（`/api/worlds/:id/history` 返回 `world.history` **全量**）；`schema/common.ts:176` + `v2/engine.ts:339-341`（`log(visibility:hidden)` 仅控制是否拼进 summary，未形成历史可见性） | 隐藏信息**存在泄漏路径**，且无实例级 `visibility` 字段可供统一过滤（与 §5 seam ③ 同源） | 给 `HistoryEntryV2` / NPC 运行时补 `visibility`，`projectSnapshotV2` 与 `/history` 端点统一按该字段过滤；`hidden` 只留服务端内部。属数据结构变更，按 `AGENTS.md` §0 先经 ADR |
| **R-NFR-05** 全部语义由模板/适配器表达、game-core 无世界观专名常量、MVP 不新增 npm 包 | **需重构** | `v2/projection.ts:197-200`（`evaluateSummaryV2` 文本含「**咒力 / 高专 / 咒术师**」JJK 专名，硬编码在 game-core）；`legacy/world.ts:28`（`createWorld` 硬编码 `cursedEnergy/intellect/physique/reputation`）；`packages/game-core/src/data/jjk.ts` 存在；`v2/time.ts:64-104` / `v2/engine.ts` / `v2/battle.ts` 主体已模板化 ✓；monorepo 仍 4 包 ✓ | v2 主体符合，但**两处世界观专名硬编码**违反约束 | 把评价文本移入模板 `narrativeConfig` / 评价配置；V1 `jjk.ts` 按 ADR-0001 下线流程移除；静态扫描纳入 `pnpm test`（T2-03/T8-01） |
| **R-NFR-06** 每能力三类测试 + `pnpm typecheck` / `pnpm test` 通过、测试可追溯到需求编号 | **部分实现（未验证）** | 现有测试文件存在（Glob）：`packages/game-core/src/v2.test.ts`、`v2/time.test.ts`、`v2/npc.test.ts`、`core.test.ts`、`time.test.ts`、`packages/shared/src/schema.test.ts` | 测试框架（Vitest）与现有用例在；但**无 R2 需求编号追溯**，且本轮工具集无 Bash，**无法执行 typecheck/test 验证** | 新增测试文件按需求编号命名/注释（T8-02）；实施阶段跑 `pnpm typecheck` / `pnpm test` 并留输出 |

------------------------------------------------------------------------

## 3. T0-02 专项：开局 / 结局 / 人生评价耦合核查

> 需求：`R-EV-01`、`R-EV-05`、`R-LC-03`；结论须含具体文件与行号。

### 3.1 「结局类型直接映射人生评分」是否存在？——**不存在该映射链路，但存在更根本的职责错位**

- 全仓 Grep（`packages/`）对 `endingType / EndingRecord / ending` 作为结局实体的引用 **零命中**；`WorldStateV2`（`shared/v2.ts:148-168`）与 `V2Snapshot`（`shared/v2.ts:226-269`）**都没有结局字段**。当前系统**没有「结局」概念**，因此不存在「结局类型 → 人生评分」的直接映射代码。
- 但 `S1 §5.1`（`DESIGN_INCREMENT_LIFECYCLE_2026-11-11.md:218-223`）与 `R-EV-01` 真正禁止的耦合，现状以另一种形式存在：
  1. **评价不是独立结果**：`V2Snapshot.evaluation`（`shared/v2.ts:268`）把评价做成**投影的一个字段**，`projectSnapshotV2` 每次调用都现算（`v2/projection.ts:112-115`）；legacy 同样把 `evaluateLife` 塞进 `projectSnapshot`（`legacy/evaluation.ts:39`）。
  2. **评价只看最终属性面板**：`evaluateSummaryV2`（`v2/projection.ts:187-194`）由 `growth`(属性均值) + `milestones`(flag) + `relationAvg` 算单一 `overall`；`evaluateLife`（`legacy/evaluation.ts:54-65`）由属性均值 / 关系均值 / `milestone:` flag / `canonDeviation` 算分。**两者都不读 `state.history`**（`shared/v2.ts:167` 已有过程记录却未消费），直接违反 `R-EV-03`「基于整个过程」。
  3. **风险**：因评价函数位于轮次/投影内部且输出进 `V2Snapshot`，R2 实现 Ending 时若不先解耦，极易把 `endingType` 直接喂成评分输入 —— 这正是 `R-EV-01` 要防的耦合。

### 3.2 `evaluateLife` 现状（legacy V1）

| 项 | 证据 | 结论 |
|---|---|---|
| 位置 | `legacy/evaluation.ts:53-99` | 导出 `evaluateLife(state: WorldState): LifeEvaluation` |
| 输入 | `legacy/evaluation.ts:54-65` | 仅 `state.player.attributes` / `npc.relationships` / `state.flags`（`milestone:` / `canonDeviation`）——**只最终面板，不读 `history`** |
| 维度 | `legacy/evaluation.ts:67-88` | 4 个**硬编码**维度（成长/关系/成就/命运偏离），非六通用维度、非模板配置（`R-EV-02`） |
| 输出 | `legacy/evaluation.ts:90-98` | 单一 `overall` 总分 + 三段硬编码中文 `summary`；**无 `evidenceIds`**（`R-EV-04`）、无分项等级/解释 |
| 调用点 | `legacy/evaluation.ts:39`（`projectSnapshot` 内）、`legacy/turn.ts:102`（`advanceTurn` 内）、`legacy/turn.ts:112`（作为 `TurnResult.evaluation` 返回） | **一轮推进被算两次**（L102 显式 + L103 经 projectSnapshot 隐式） |
| 是否含 endingType | 全函数无 | 无结局类型参与，**不存在「结局→评分」映射** |

### 3.3 `advanceTurn` / `advanceTurnV2` 是否承担 Lifecycle 职责？

| 函数 | 证据 | 结论 |
|---|---|---|
| `advanceTurn`（legacy V1） | `legacy/turn.ts:19-114`；L16 注释「… → 历史 → **评价/投影**」；L101 注释「7. 评价与投影」；**L102 `evaluateLife(nextState)`**、L103 `projectSnapshot(...)`、L112 返回 `evaluation` | **承担了 Evaluation 职责**（每轮算评价并作为轮次结果返回），违反 `R-LC-03`（Lifecycle/轮次不做评分）。但**未承担 Lifecycle 阶段职责**：无 phase、无开始/结束/归档判定、无门禁（L24-26 仅校验 `mode`） |
| `advanceTurnV2`（V2 主入口） | `v2/turn.ts:378-461`；10 步管线（时间推进→行动效果→链→schedule→hook→回复→补正→年龄→NPC→事件池→投影）；L452 `projectSnapshotV2`（内部 `v2/projection.ts:112-115` 调 `evaluateSummaryV2`） | **评价耦合点从 `advanceTurn` 移到 `projectSnapshotV2`**，仍是「每轮投影现算评价」；同样**无 phase、无门禁、无结局、无归档**，即未承担 Lifecycle 阶段职责 |
| `CORE_ENGINE §3` 规格声明 | `引擎规格:51`「`-> calculate life evaluation when required`」 | 规格把「评价」写进轮次流程；legacy 实现成「每轮都算」，V2 实现成「每轮投影都算」。**规格与 R2 新设计均为评价事实来源之一**（见 §6.2） |

**T0-02 结论**：
1. 现状**没有**「结局类型直接映射人生评分」的代码（因无结局概念）；但**评价被错误耦合进轮次推进与玩家投影**，且只基于最终属性面板、单总分、无证据、维度硬编码 —— 这才是 `R-EV-01/02/03/04` 与 `R-LC-03` 的真实差距。
2. `evaluateLife`（legacy）与 `evaluateSummaryV2`（V2）是**两份并存的评价实现**（加 `CORE_ENGINE §8` 规格共三处事实来源），`design §14` 已预见此风险，需在 T1-04 同步。
3. `advanceTurn`（legacy）**承担了 Evaluation 职责**；`advanceTurnV2` 自身不含评价但通过 `projectSnapshotV2` 间接承担。**两者都未承担 Lifecycle 阶段职责**（无 phase / 门禁 / 结局 / 归档）。
4. 最小解耦方向（只建议）：新建 `v2/life-evaluation.ts` 产出独立 `EvaluationRecord`，仅在 `EVALUATING` 阶段一次性计算；从 `advanceTurn` 与 `V2Snapshot` 移除按轮现算；`endingType` 仅作背景输入。

------------------------------------------------------------------------

## 4. T0-03 专项：开局事件复用 Event Engine / `design §7` C1·C2 可行性

> 需求：`R-OP-06`、附录 A A4/A5。核查是否**需要新增栈式调度器或事件枚举**；给出「可行 / 需调整」结论，若需调整先提 ADR 建议而不改代码。

### 4.1 现有事件系统盘点（均来自实际代码，非旧 spec）

| 能力 | 证据 | 现状 |
|---|---|---|
| 统一事件定义 | `schema/event.ts:123-136`（`EventV2Schema` 三段式 `trigger/kind/settle` 判别联合）、`schema/event.ts:13-43`（`EventTriggerSchema`） | **已具备**，开局事件应复用此定义，不另造剧情系统 |
| `source` 枚举 | `schema/event.ts:15` `z.enum(["pool","chain","schedule","action-hook"])` | **固定 4 类**，与附录 A A5「语义复用、不加枚举」一致；`v2/turn.ts:130-135` 的 `EVENT_SOURCE_PRIORITY` 亦为这 4 类 |
| 条件/效果/事件记录 | `v2/engine.ts:157-208`（`checkCondition/checkAllConditions`）、`v2/engine.ts:246-344`（`applyEffectsV2` 全量白名单）、`v2/turn.ts:488-499`（`pushHistory`） | **已具备**，开局事件共用同一结算路径 |
| 连续事件 → chains | `shared/v2.ts:129-135`（`ChainStateV2`）、`v2/engine.ts:351-363`（`startChain` 注册 active）、`v2/turn.ts:239-271`（`advanceChainOnSettle` + `nextEventId`）、`v2/turn.ts:348-368`（`advanceNextTurnChains`）、`schema/event.ts:140-154`（`ChainSchema`） | **已具备**：链状态机 + `nextEventId` + 起点事件按 kind 路由 |
| 未来/定时事件 → schedule | `schema/event.ts:23-25`（`atTurn / atWorldTime`）、`v2/turn.ts:337-346`（`resolveScheduleV2`）、`v2/engine.ts:243` + `v2/turn.ts:217,533,576,635`（`timeAdvanced` 后重结算 schedule） | **已具备**：`atWorldTime`（相对偏移）/ `atTurn`（轮次）两种触发 |
| 并发调度结构 | `v2/turn.ts:147-165`（`pendingEvents` **有序队列**，按优先级插入、同优先级 FIFO）、`v2/turn.ts:130-135`（来源优先级表）；Glob `v2/` 仅 9 文件，**无栈式调度模块** | 现状是「事件池 + chains 状态机 + `nextEventId` + 有序待决队列」，**无栈**（符合 A4） |

### 4.2 C1 映射结论：**可行（含 2 项调整）**

`design §7 C1`（`design:139`）主张「`handoff` 把连续事件接到现有 chains，定时/条件事件接到 schedule，不建栈模块」——与上表一一对应，**无需新增栈式调度器**。

需调整项（**不是**新栈 / 新枚举）：

1. **链状态机缺 `paused` / `cancelled` 两态**：`ChainStateV2.status` 仅 `"active" | "completed"`（`shared/v2.ts:133`），而 `协议 §9.3`（`协议:356`）与 `AGENTS.md §3`（`AGENTS.md:37`）要求 `pending→active→completed|paused|cancelled`；且 `cancelChain` 效果被实现为 `status = "completed"`（`v2/engine.ts:334-337`），**取消与完成语义混同**。R-OP-06/R-OP-07 的 `handoff` 若要「暂停/取消开局事件链」，需补这两态。
2. **schedule 事件无实例级可撤销状态**：`resolveScheduleV2` 用 `firedEvents[event.id]`（`v2/turn.ts:341`）按**定义 ID** 去重、`state.worldTime >= amountToMinutes(t.atWorldTime)`（L342）单调比较；没有实例状态字段。对「开局未来事件接入 schedule」本身够用，但「未来事件撤销」语义缺失（此即 §5 seam ②，属 R3）。

### 4.3 C2 映射结论：**可行**

`design §7 C2`（`design:140`）主张「用 `EventInstance.origin` 元数据标 `opening + openingId`，`source` 枚举不动」：

- `source` 枚举固定 4 类（`schema/event.ts:15`），A5 已决定语义复用、不加枚举 → **确认无需新增事件类型枚举**。
- 现状全仓 Grep `origin / EventInstance / definitionId` **零命中**：事件全是**定义级**，`firedEvents`（`shared/v2.ts:159`）、`pendingEvents`（`shared/v2.ts:121-125`）、`history`（`shared/v2.ts:137-146`）、`triggeredEvents`（`v2/turn.ts:186`）都直接引用 `event.id`（模板定义 ID）。**正因没有实例层，新增 `EventInstance{instanceId, definitionId, origin{kind,id}}` 不会与 `source` 枚举冲突**，只需新增一个实例记录结构并让上述引用点改指 `instanceId`。
- 约束：`origin` 必须与 `instanceId / definitionId` **解耦**（`design §8` seam ①，`design:174`）——`origin` 只是来源标签，不参与实例身份与定义引用。

### 4.4 T0-03 总结论

> **可行（含调整项）**：`design.md §7` 的 **C1 / C2 映射确实无需新增栈式调度器、无需新增事件类型枚举**；现有 Event Engine、chains 状态机、schedule 与 `nextEventId` 足以承载开局事件。

调整项均属「实例层与链状态语义」，而非「新栈 / 新枚举」：

| 调整项 | 涉及 | 是否核心数据模型变更 | 处理建议（**只提建议，不改代码、不写 ADR**） |
|---|---|---|---|
| A. 补 `ChainStateV2.status` 的 `paused/cancelled`，修正 `cancelChain` 语义 | `shared/v2.ts:133`、`v2/engine.ts:334-337` | 是（运行时类型联合 + 行为） | 按 `AGENTS.md §0`（`AGENTS.md:9`）「改核心数据模型先写 ADR」——**建议并入阶段 1 的 ADR 一并评审**；编号冲突见 §6.1 |
| B. 新增 `EventInstance`（`instanceId/definitionId/origin`）并让 `firedEvents/pendingEvents/history/triggeredEvents` 改指 `instanceId` | `shared/v2.ts`、`v2/turn.ts`、`schema/event-instance.ts`（新） | 是（新增实例层 + 引用点改写） | 同上，**建议先经 ADR 评审**；本轮只写 `origin`（`design §5` L95），`status/visibility` 穿越语义留 R3 |
| C. `handoff()` 单一入口把连续事件接 chains / 未来事件接 schedule | `v2/opening.ts`（新） | 否（新增编排模块） | 按 T3-04 / T3-05 实施，无 ADR 需求 |

> ⚠️ 上述 A/B 涉及核心数据模型，**本报告不落 ADR**（尤其不写 ADR-0004），仅建议在阶段 1 ADR 中澄清；且 `ADR-0003` 编号已被占用（§6.1），编号须先确认。

------------------------------------------------------------------------

## 5. `design.md §8` 末三个接口预留点现状核查（R3 前置改造项）

> 依据 `design.md:172-178`：`tasks.md T0-01` 需核查现状是否已具备，缺口记为 **R3 前置改造项**，**本轮不补实现**。本节只做「接口预留点现状」核查，不设计、不实现时间穿越。

### Seam ① `EventInstance` 的 `instanceId / definitionId` 分离，且 `origin` 不与之耦合

| 项 | 现状 | 证据 |
|---|---|---|
| `instanceId / definitionId` 分离 | **不具备** | 全仓 Grep（`packages/`）`definitionId\|EventInstance\|worldLineId\|origin` **零命中**；事件为定义级 `EventV2`（`schema/event.ts:123-136` 仅 `id`） |
| 定义 / 实例可区分 | **不具备** | `firedEvents: Record<string, number>`（`shared/v2.ts:159`，`eventId→turnIndex`）、`PendingEvent{eventId,chainId?}`（`shared/v2.ts:121-125`）、`HistoryEntryV2`（`shared/v2.ts:137-146`）、`triggeredEvents`（`v2/turn.ts:186`）**全部直接用模板定义 ID** |
| 已有的「实例」概念（易混淆，需澄清） | 仅战斗单位 `BattleEnemy.instanceId`（`shared/v2.ts:82`）、补正 `StatusInstance`（`shared/v2.ts:23-34`）、链 `ChainStateV2`（`shared/v2.ts:129-135`） | 均**不是**事件实例层；ADR-0002（`docs/DECISIONS.md:65`）只「预留接口位」，未落地 |
| `origin` 元数据 | **不具备** | 全仓 Grep `origin` 零命中 |

**缺口 → `R3-PRE-01`**：需建立事件「模板定义 `EventDefinition` / 本局实例 `EventInstance` / 已发生记录 `EventRecord`」三层；`instanceId` 为实例身份、`definitionId` 指向模板定义、`origin{kind,id}` 仅为来源标签且不与前两者耦合；`once/冷却` 与历史引用须同时保留 `definitionId` 与 `instanceId` 两个维度。**本轮不补实现**（`design §5` L95-96：`EventRecord` 与 `status/visibility` 穿越语义均 R3）。

### Seam ② 时间换算只经 `TimeAdapter`，不写死「时间单调 / 未来事件不可撤销」

| 项 | 现状 | 证据 |
|---|---|---|
| `TimeAdapter` 已落盘 | **具备（部分）** | `v2/time.ts:48-62`（`CalendarAdapter` / `TimeAdapter` 接口）、`:64-104`（`createTimeAdapter`，ADR-0002）；含 `format/elapsedYears/resolveLifeStage/lifeStageLabel/resolveStep` |
| 接口无时间点解析 / 回拨语义 | **不具备** | `TimeAdapter`（`v2/time.ts:59-62`）**无** `parse/target/可回拨校验` 方法；`docs/DECISIONS.md:65` 承诺的「重新定义 schedule 在可回拨时间下的触发语义」未落地 |
| 「一切时间换算只经 TimeAdapter」 | **不成立** | `amountToMinutes` / `UNIT_MINUTES`（`v2/time.ts:18-30`）是**模块级硬编码公历换算**，被 `v2/engine.ts:13,196-199,312,317-318`、`v2/turn.ts:17,342,397,400,404`、`v2/npc.ts:63` 等**直接 import**；`time` 条件（`v2/engine.ts:194-201`）直接读 `state.worldTime` 分钟数 |
| 写死「时间单调递增」 | **存在（多处，且已固化进测试）** | `v2/engine.ts:312` `state.worldTime = Math.max(state.worldTime, amountToMinutes(...))`（`advanceTo` 效果）；`v2/turn.ts:397` `Math.max(0, amountToMinutes(action.advanceTo) - state.worldTime)`；`v2/turn.ts:394` 注释「不倒退」；`schema/common.ts:169` / `schema/world.ts:161` 注释「不倒退」；**`v2/time.test.ts:94` 测试名「advanceTo 绝对推进到目标时间（不倒退）」** |
| 写死「未来事件永不撤销」 | **存在** | `v2/turn.ts:342` `state.worldTime >= amountToMinutes(t.atWorldTime)` 单调比较 + `firedEvents[event.id]`（`:341`）按定义 ID 去重；schedule 事件**无实例状态字段空间**（`undone/hidden` 等均不存在） |

**缺口 → `R3-PRE-02`**：把 `amountToMinutes` 一类换算收敛进 `TimeAdapter`（或明确其为适配器内部实现、禁止引擎直接 import）；`TimeAdapter` 增目标时间点解析与可回拨校验；移除 `Math.max` 单调假设并同步调整 `v2/time.test.ts:94` 的断言；给 schedule 事件预留可撤销状态字段空间。**本轮不补实现**。

### Seam ③ 投影按 `visibility` 字段过滤，新增隐藏语义只加字段值、不改投影函数结构

| 项 | 现状 | 证据 |
|---|---|---|
| 已有按 `visibility` 字段过滤 | **部分具备** | `v2/projection.ts:29,125`（补正 `def.visibility === "known"`）；`schema/common.ts:176`（`log` 效果 `visibility: public\|hidden`）；`schema/character.ts:31`（角色 `visibility: public\|hidden`）；`schema/status-effect.ts:74`（补正 `visibility: known\|hidden`） |
| 是否「按字段统一过滤」 | **不成立（按领域各自硬编码）** | `v2/projection.ts:91-99` NPC 投影为白名单字段、**无 visibility 过滤**；`shared/v2.ts:59-76` `V2Npc` **无 visibility 字段**（模板的 `CharacterSchema.visibility` 未映射进运行时）；`shared/v2.ts:137-146` `HistoryEntryV2` **无 visibility 字段**；`v2/engine.ts:339-341` `log(visibility:hidden)` 仅控制是否拼进 summary，**未形成历史可见性** |
| 玩家端投影 / API 是否泄漏 | **存在泄漏路径** | `v2/turn.ts:459` `playerVisibleHistory: state.history.slice(-20)` 无过滤；`server/index.ts:190-195` `/api/worlds/:id/history` 返回 `world.history` **全量**（对应 `R-NFR-04` 判「需重构」） |
| 「只加字段值、不改投影函数结构」 | **不成立** | 现状投影函数按各领域分别写死过滤逻辑（补正 / 选项 `visibleWhen` / NPC 白名单 / 历史无过滤），无统一「按 `visibility` 字段过滤」通道；R3 新增「隐秘未来事件」势必要改投影函数结构 |

**缺口 → `R3-PRE-03`**：给 `HistoryEntryV2` / NPC 运行时 / 事件实例补统一 `visibility` 字段；`projectSnapshotV2` 与 `/history` 端点改为按该字段统一过滤；新增隐藏语义只扩字段值、不改过滤函数结构。**本轮不补实现**（与 `R-NFR-04` 同改，属数据结构变更，按 `AGENTS.md §0` 需 ADR）。

### 本节汇总（只登记，不补实现）

| 编号 | 预留点 | 现状判定 | 本轮动作 |
|---|---|---|---|
| `R3-PRE-01` | Seam ① 实例/定义分离 + `origin` 解耦 | **不具备** | 登记为 R3 前置改造项；本轮仅按 `design §5` 写 `origin`（属 ACTIVE 的 T3-04），不补三层存储 |
| `R3-PRE-02` | Seam ② 时间换算只经 TimeAdapter、不假设单调/不可撤销 | **不具备（有多处反例，含测试）** | 登记为 R3 前置改造项；本轮不动时间模块 |
| `R3-PRE-03` | Seam ③ 按 `visibility` 字段统一过滤 | **部分具备、结构不符** | 登记为 R3 前置改造项；本轮不补实现 |

> 三者与 `tasks.md 附录 A` 的「恢复前置条件」（`tasks.md:194`）一致：R3 立项前需补齐三个 seam 缺口。

------------------------------------------------------------------------

## 6. 其他重要发现（spec 与现状冲突，**仅登记，不修改任何文件**）

### 6.1 ⚠️ ADR-0003 编号冲突（阶段 1 前必须澄清）

- `docs/DECISIONS.md:79-109` 已存在 **「ADR-0003 组队战斗（玩家 + AI 友军）」待评审草案**，且该草案**已部分落地代码**：`v2/battle.ts:24`（`Combatant.team: "ally"|"enemy"`）、`:119`（`createBattle` 的 `allies`）、`schema/event.ts:110`（`CombatSettle.allies`）、`shared/v2.ts:113`（`BattleState.allies`）、`schema/world.ts:305-308`（友军引用完整性校验）。
- 但 `design.md §12`（`design:225`）与 `tasks.md T1-01`（`tasks.md:38-40`）把 **ADR-0003 定义为「Lifecycle 六阶段状态机 + `LifecycleState` 落点」**；`ADR-0004` 已被时间穿越占用并延期（`design:226`）。
- **同一编号指向两个不同决策**。本报告不写 ADR、不改 `DECISIONS.md`；建议阶段 1 前由项目负责人确认编号（例如 Lifecycle 改用新编号，或组队战斗草案另立编号），避免 T1-01 落盘冲突。

### 6.2 人生评价存在三份事实来源

`引擎规格 §8`（`引擎规格:112-122`）/ legacy `evaluateLife`（`legacy/evaluation.ts:53-99`）/ V2 `evaluateSummaryV2`（`v2/projection.ts:186-201`）—— `design §14`（`design:253`）已预见「双份事实来源」，现状实为**三处**。T1-04 需同步 `CORE_ENGINE.md §8` 并明确过渡期边界。

### 6.3 时间单调假设已固化进测试

`v2/time.test.ts:94` 用例名「advanceTo 绝对推进到目标时间（**不倒退**）」。R3 接入回拨时该断言需调整，已并入 `R3-PRE-02`。

### 6.4 链状态机规格-实现不一致

`协议 §9.3`（`协议:356`）与 `AGENTS.md §3`（`AGENTS.md:37`）规定 `pending→active→completed|paused|cancelled`；实现仅 `"active"|"completed"`（`shared/v2.ts:133`），且 `cancelChain` 被写成 `completed`（`v2/engine.ts:334-337`）。并入 T0-03 调整项 A。

### 6.5 隐藏信息泄漏路径（R-NFR-04 现状不成立）

`HistoryEntryV2` 无 visibility（`shared/v2.ts:137-146`）→ `playerVisibleHistory` 直接 `slice(-20)`（`v2/turn.ts:459`）→ `/api/worlds/:id/history` 返回 `world.history` 全量（`server/index.ts:190-195`）。详见 §5 seam ③。

### 6.6 NPC 默认「相识」与可见性未透传

`CharacterSchema.relationship` 必填（`schema/character.ts:56`）、`createWorldV2` 每个 NPC 都写 `relationship`（`v2/turn.ts:87`）、`CharacterSchema.visibility`（`schema/character.ts:31`）未进 `V2Npc`（`shared/v2.ts:59-76`）。详见 R-OP-05、R-NFR-04。

### 6.7 模板仅一套世界观

Glob `specs/data/templates/` 仅有 `jjk-2006/` 六文件；`design §13`（`design:245`）/`T8-01` 要求的 JJK / Steins;Gate / 现代人生三世界观模板未齐，`R-NFR-05` 的「模板差异只通过配置表达」尚无跨世界观验证。

### 6.8 存档为纯内存、无恢复

`server/store.ts:5-26` 内存 Map，注释「重启即清空」；`R-AR-03` 验收「服务重启后恢复」不成立（已按「部分实现」登记，不擅自引入持久化）。

------------------------------------------------------------------------

## 7. 「缺失」项最小改造建议索引（仅建议，无实现代码）

> 29 条「缺失」的逐条建议已写在 §2 对应行的最后一列；此处按实施顺序归并，便于 `tasks.md` 阶段 2–6 直接取用（**本报告不派任务、不实现**）。

1. **阶段 1 前置（须先澄清）**：§6.1 的 ADR-0003 编号冲突；`AGENTS.md §0` 要求的 ADR 覆盖 `LifecycleState` 落点、`ChainStateV2.status` 扩展、`EventInstance` 实例层、`visibility` 字段（均属核心数据模型变更）。
2. **Lifecycle 骨架（LC 6 条）**：新建 `schema/lifecycle.ts` + `v2/lifecycle.ts`（`Phase` / 合法迁移表 / `transition` / `assertPhase` / `phaseLog`）；轮次入口加门禁。
3. **Opening（OP-01/02/07）**：新增 `opening.yaml` 分域 + `schema/opening.ts` + `v2/opening.ts`（步骤编排、抽取、`handoff`）；`createWorldSchema` 增 `openingId`。
4. **Ending（EN 6 条）**：新增 `endings.yaml` + `schema/ending.ts` + `v2/ending.ts`（`EndingCondition` / `EndingTemplate` / `EndingRecord` / 边界检查 / 决胜）；adapter 层 LLM 叙事 Zod 校验 + 模板回退。
5. **Evaluation（EV-02/03/04/05/06）**：新建 `schema/evaluation.ts` + `v2/life-evaluation.ts`（`EvaluationConfig` / `EvaluationRecord` / `evidenceIds[]` / `collectEvidence`）；从 `advanceTurn` 与 `V2Snapshot` 解耦按轮现算。
6. **Archive（AR-01/02）**：新建 `v2/archive.ts`；`worldStore.save` 加只读门禁。
7. **Equipment（EQ-01/02/04/05）**：新增 `equipment.yaml` + `schema/equipment.ts` + `v2/equipment.ts`；扩 `ItemSchema` 的 `equipment` 分支与 `server/templates.ts:14-21` 的 `TEMPLATE_FILES`。
8. **Combat AI（CA-02/03）**：新增 `combat-ai.yaml` + `schema/combat-ai.ts`；补条件化策略与风格解析。
9. **NFR-03**：adapter 层 LLM 失败/超时回退与 `summarySource`。
10. **R3 前置（不本轮补）**：`R3-PRE-01/02/03`（§5）。

------------------------------------------------------------------------

## 8. 未完成项与风险

| 项 | 说明 |
|---|---|
| 无法运行验证 | 本轮工具集**无 Bash**，`pnpm typecheck` / `pnpm test` / `git status` 均未执行；所有结论为**静态审查**，行号基于本次读取快照。 |
| WIP 并发 | 另一 Agent 的 42 项未提交 WIP 正在写入 `packages/`；本报告结论可能随其提交而变化。未执行任何 git 操作。 |
| ADR 编号冲突 | §6.1：ADR-0003 已被「组队战斗」占用，阶段 1 的 Lifecycle ADR 编号未定；本报告不写 ADR。 |
| 时间穿越 | 7 条 DEFERRED 只登记状态；三个 seam 缺口登记为 `R3-PRE-01/02/03`，**本轮不补实现、不设计**。 |
| 数据模型变更未评审 | R-OP-05 / R-NFR-04 / seam③ / T0-03 调整项 A·B 均涉及核心数据模型，按 `AGENTS.md §0` 需先写 ADR；本报告仅建议。 |
| 恢复语义 | `R-AR-03` 的「重启后恢复」在纯内存仓储下不成立（§6.8），按需求「沿用现有机制」未擅自引入持久化。 |
| 规格同步 | `CORE_ENGINE §8` / `docs/DECISIONS.md` / `docs/OPEN_QUESTIONS.md` / `TEMPLATE_PROTOCOL_V2.md` 均**未修改**（本轮硬禁止），由阶段 1 的 T1-03 / T1-04 处理。 |

------------------------------------------------------------------------

## 9. 合规声明（本轮未做的事）

- 未修改 `packages/`、`apps/`、`specs/data/TEMPLATE_PROTOCOL_V2.md`、`specs/engine/CORE_ENGINE.md`、`docs/DECISIONS.md`、`docs/OPEN_QUESTIONS.md` 或任何实现代码。
- 未写 ADR（尤其未写 ADR-0004）、未重构、未实现时间穿越、未补 R3 前置项。
- 未执行 `git add / commit / checkout / reset / push`，未提交他人 WIP。
- 除本报告与 `design.md §2`「现状盘点」表外，未新建或修改任何其它文件。
- 报告内所有「建议」均为自然语言的最小改造方向，**不含实现代码**；需 ADR 处只提「先经 ADR 评审」的建议，不落 ADR 文本。
