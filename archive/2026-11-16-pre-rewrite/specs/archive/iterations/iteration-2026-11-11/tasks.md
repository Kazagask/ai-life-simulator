# 迭代 R2 任务清单（Tasks）

**版本：2026-11-11（R2.2 决策修订）｜状态：阶段 0..6 已完成（T2-01..04、T3-01..05、T4-01..06、T5-01..04、T6-01..04 已勾选；阶段 4 遗留 4 项登记于 OPEN_QUESTIONS #28..#31）｜上游：`requirements.md`、`design.md`**

> **R2.1：时间穿越延期。** 阶段 7（`T7-01`～`T7-06`）与 `T1-02`（ADR-0005）整体 `DEFERRED`，编号与原文保留在文末「附录 A」，供 R3 恢复。本轮执行 34 个 ACTIVE 任务，验收 45 条 ACTIVE 需求。
>
> **R2.2（用户 2026-11-11 五项决策）**：① 六阶段 Lifecycle 状态机整组退役（`R-LC-*` → `RETIRED`，阶段 2 改为「终止模型与门禁」，新增 `R-TM-*`）；② 本轮 ADR 顺延为 **ADR-0004**、R3 为 **ADR-0005**（ADR-0003 保留给组队战斗）；③ 装备词条统一动态补正；④ HP 与死亡结局解耦（HP ≥ 1，战败 + 条件 → 死亡事件或直接结局）；⑤ 条件化 AI 只读公有字段。新增 `T0-04` 复核需求集变更；需求仍 45 条 ACTIVE（组成见 `requirements.md` §0.2）。
>
> **V1 legacy 已下线（2026-11-11 04:01）**：阶段 0（T0-01～03）执行时 V1 尚存，报告按当时快照保留原文；此后 V1 引擎与类型全部删除、仅保留 V2 共用的 `rng.ts`。本清单中面向 V1 的验收条件已按现状改写，后续任务不得再引用 `evaluateLife` / `advanceTurn`（V1）等已删除符号。

> 本清单是 Spec Coding 的第三阶段产物。**阶段 0 与阶段 1 完成前不得进入编码实现**（两份源文档与 `AGENTS.md` §0 的共同要求）。

------------------------------------------------------------------------

## 0. 约定

- 任务编号 `T<阶段>-<序号>`；勾选 `[x]` 表示该任务通过「完成定义」。
- 每条任务必须标注：依赖、追溯需求（`R-*`）、产出文件、完成定义。
- 一次只做一个任务；小步提交，提交信息注明任务 ID 与需求编号。
- 汇报格式遵循 `AGENTS.md` §4：改动摘要 / 关键决策 / 执行过的命令及结果 / 未完成项与风险 / 是否修改了 Spec。
- 遇到不确定产品规则：写入 `docs/OPEN_QUESTIONS.md`，**不要自行伪造共识**。
- 文件归属见 `design.md` §4；**同一时刻只允许一个 Agent 写 `packages/`**，另一 Agent 若在运行，先确认它已停或已提交。
- **状态约定（R2.1）**：`R-TT-01..07` 及所有时间穿越任务为 `DEFERRED` —— **不执行、不验收、不计入 DoD**；编号保留供 R3 复用，清单见文末「附录 A」。
- **状态约定（R2.2）**：`R-LC-01..06` 为 `RETIRED` —— 不执行、不验收、不计入 DoD；不得再以 `phase` / `LifecycleState` / 阶段日志作为任务产出。
- 任务计数：共 **41 个编号** = **34 个 ACTIVE**（阶段 0–6、8）+ **7 个 DEFERRED**（T1-02、T7-01..06）。
- **施工顺序调整（用户 2026-11-11 已确认，已执行完毕）**：`T2-02`（`assertActive()` 门禁）从阶段 2 顺延到 `T3-05` 的 `handoff()` 之后最后接入。原因：`createWorldV2` 初始化 `openingCompleted = false`，若先接门禁，阶段 2→3 之间所有未交接世界（含 `apps/server` 运行时）都会被 `NOT_ACTIVE` 拒绝，dev 不可推进。实际按「先建能力、最后接门禁」执行完毕，`main` 全程可跑；`T2-02` 与 `T3-05` 已于 06:51 一并验收。
- **阶段 4 承接项（T2-02 范围内刻意未做）**：`T2-02` 完成定义中「终止条件命中时先结算完当前事件再落 `termination`」属 T4；且门禁当前只接在 `advanceTurnV2`，`chooseOptionV2` / `battleActionV2` / `useItemV2` 等其它行动入口尚未加门禁，已终止/已归档世界仍可能经这些入口写状态，阶段 4 须补齐统一门禁。

## 1. 阶段 0 — 审查（不修改实现代码）

- [x] **T0-01** 依赖：无｜需求：45 条 ACTIVE（审查输入）｜产出：`tasks/reports/R2-GAP-ANALYSIS.md`
  对照 `requirements.md` 45 条 `ACTIVE` 需求与**当时工作区实际代码**，逐组输出「已实现 / 部分实现 / 缺失 / 耦合 / 需重构」五态，并更新 `design.md` §2 现状盘点表；另设一节核查 `design.md` §8 末三个接口预留点（时间穿越 seam）的现状，缺口记为 **R3 前置改造项**。
  完成定义：45 条 ACTIVE 需求全部有状态标注；7 条 `DEFERRED` 仅登记「延期」、不分析实现状态；每个「缺失」项给出最小改造建议；报告不含代码改动。

- [x] **T0-02** 依赖：T0-01｜需求：R-EV-01、R-EV-05、R-TM-03
  专项核查开局/结局/评价是否被错误耦合（尤其「结局类型直接映射人生评分」），以及 `evaluateSummaryV2` 与 `advanceTurnV2` 是否承担了**终止判定**职责（R2.2 后不再核查 Lifecycle 阶段职责）。（本项 03:34–03:47 执行时 V1 尚存，报告结论按当时快照理解；V1 已于 04:01 下线。）
  完成定义：结论写进 T0-01 报告，含具体文件与行号。

- [x] **T0-03** 依赖：T0-01｜需求：R-OP-06、S4 A4/A5
  核查开局事件能否复用现有 Event Engine 与 chains/schedule，确认 `design.md` §7 C1/C2 映射无需新增栈式调度器或枚举。
  完成定义：给出「可行 / 需调整」结论与调整项；若需调整，先提 ADR 而不是直接改代码。

- [x] **T0-04（R2.2 新增）** 依赖：T0-01｜需求：R-TM-01..03、R-EN-07/08、R-CA-06｜产出：`tasks/reports/R2-GAP-ANALYSIS.md` 追加「R2.2 增量复核」一节
  需求集在阶段 0 报告产出后发生变更：6 条 `R-LC-*` 退役、6 条新需求（TM 3 / EN 2 / CA 1）加入。逐条对**当前工作区代码**标注五态并给证据行号；另核查 `design.md` §9.3 的 HP clamp 现状与 §9.2 的公有字段边界是否已有实现。
  完成定义：6 条新增需求均有状态标注与最小改造建议；6 条退役需求登记「RETIRED，不再验收」；报告不含代码改动。

## 2. 阶段 1 — ADR 与协议修订（仍不改实现）

- [x] **T1-01** 依赖：T0-01、T0-04｜需求：R-TM-*、R-EN-07/08｜产出：`docs/DECISIONS.md` ADR-0004
  落盘**终止模型**决策：`openingCompleted / termination / archived` 三字段在 `WorldStateV2` 的落点、`assertActive()` 门禁对轮次管线的影响、`TerminationRecord` / `DeathRoute` 结构；**替代方案须写明「六阶段 Lifecycle 状态机」并给出否决理由**（R2.2 决策 ①）。不得改动 `DECISIONS.md` 已有的 ADR-0003「组队战斗」草案。
  完成定义：ADR 状态为「已接受」，明确对 `WorldStateV2` 与轮次管线的影响面，且编号不与 ADR-0003 冲突。

- **T1-02（⛔ DEFERRED，延期至 R3，编号保留）** 依赖：—｜需求：R-TT-*（DEFERRED）
  原计划落盘 ADR-0005（时间穿越语义，R2.2 顺延后的编号）。按用户 2026-11-11 决定延期，**本轮不执行、不写 ADR**；R3 立项时从「附录 A」恢复。

- [x] **T1-03** 依赖：T1-01｜需求：R-OP-*、R-EN-*、R-EV-*、R-EQ-*、R-CA-*｜产出：`specs/data/TEMPLATE_PROTOCOL_V2.md` 修订
  新增开局 / 结局 / 评价 / 装备 / 战斗 AI 章节（**不含时间穿越**，留待 R3）；扩 §8 `items.yaml`、§13 校验清单、§14 必须覆盖的测试；模板目录新增 `opening.yaml / endings.yaml / evaluation.yaml / equipment.yaml / combat-ai.yaml` 分域约定。
  完成定义：协议新增章节均可映射到 Zod schema 草案；不出现与 ADR-0001/0002 冲突的语义。

- [x] **T1-04** 依赖：T1-01｜需求：R-EV-*、R-NFR-02｜产出：`specs/engine/CORE_ENGINE.md` §8 修订、`docs/OPEN_QUESTIONS.md` 状态更新
  标注人生评价由新规格取代；#9 / #11 / #13 登记为**用户已决**（决策 ③④⑤：动态补正 / HP 与死亡解耦 / 只读公有字段）、#27 ADR 编号冲突登记为**已解决**（ADR-0004 / 0005）；#21 / #22 的 NPC 死亡语义仍待决，不并入本轮。
  完成定义：仓库内不存在两份互相冲突的人生评价事实来源。

## 3. 阶段 2 — 终止模型与门禁（R2.2：不建 Lifecycle 状态机）

- [x] **T2-01** 依赖：T1-01｜需求：R-TM-01、R-TM-03｜产出：`packages/shared/src/schema/ending.ts` 内 `TerminationRecord`、`packages/game-core/src/v2/ending.ts` 的 `markTerminated()` / `assertActive()`
  实现 `openingCompleted`（boolean）、`termination`（`TerminationRecord | null`）、`archived`（boolean）三个并列字段；`markTerminated()` 幂等，重复调用不追加记录；**不创建 `lifecycle.ts`、不引入 `Phase` 枚举或 `PhaseTransitionLog`**。
  完成定义：正常终止 / 重复终止 / 终止后写状态三类测试通过；P2 属性成立。

- [x] **T2-02** 依赖：T2-01｜需求：R-TM-02、R-TM-01｜产出：轮次管线门禁（`v2/turn.ts` 最小改动）
  在 `advanceTurnV2` 入口加 `assertActive()`：开局未完成 ⇒ `NOT_ACTIVE`，已终止/已归档 ⇒ `TERMINATED`；两者均逐字段不改状态。终止条件命中时先结算完当前事件再落 `termination`。
  完成定义：Given 开局未完成 / 已终止，推进请求被拒且世界时间与事件历史不变；现有 v2 回归测试全绿。

- [x] **T2-03** 依赖：T2-01｜需求：R-TM-03、R-NFR-05｜产出：静态边界检查（测试或脚本）
  断言 `game-core/src/v2/` 无 `lifecycle.ts`、无 `Phase` / `PhaseTransitionLog`、无 `transition(state, to: Phase)` 形式导出；`game-core` 无世界观专名常量；回放断言不依赖阶段序列。
  完成定义：检查纳入 `pnpm test`，失败时报错指向具体文件。

- [x] **T2-04** 依赖：T2-01｜需求：R-NFR-01、R-NFR-02｜产出：`RunnerContext` 注入约定与回放测试骨架
  统一 rng / now / idFactory 注入；建立「同 seed 全链路回放逐字段相等」测试夹具（不含阶段序列）。
  完成定义：夹具可供阶段 3–6 复用；P1 属性有基线测试。

## 4. 阶段 3 — Opening 开局

- [x] **T3-01** 依赖：T1-03｜需求：R-OP-01、R-OP-02、R-NFR-02｜产出：`schema/opening.ts`、模板 `opening.yaml` 样例
  定义 `OpeningTemplate` / `OpeningRun` Zod schema 与步骤模型（必经/可选/分支）。
  完成定义：缺字段模板加载报错含字段路径；两个不同开局模板加载均通过。

- [x] **T3-02** 依赖：T3-01｜需求：R-OP-04、R-OP-03｜产出：`v2/opening.ts` 事件池抽取
  实现 tags / weight / conditions / required / countRange / exclusiveGroup / sequence / seed / effects / nextEvents 抽取。
  完成定义：同 seed 可复现、互斥组至多命中一个、必选必出现、数量落在区间（四类测试齐备）。

- [x] **T3-03** 依赖：T3-01｜需求：R-OP-05｜产出：初始化编排（角色/NPC/关系/权限/目标/装备）
  初始化世界状态，关系带来源，未声明关系不默认为相识。
  完成定义：Given 未声明关系的 NPC，`unknown` 且不带关系条目；信息权限按模板分级。

- [x] **T3-04** 依赖：T3-02、T0-03｜需求：R-OP-06｜产出：`schema/event-instance.ts`、`origin` 元数据接线
  开局事件复用统一事件系统；连续事件接 chains，定时/条件事件接 schedule；静态检查无栈模块、无新增 `source` 枚举。
  完成定义：开局产出的事件与普通事件共用同一结算路径；`origin` 为 `opening + openingId`。

- [x] **T3-05** 依赖：T3-01..04、T2-01｜需求：R-OP-07、R-TM-02｜产出：`handoff()` 与 `openingCompleted` 交接
  `completionConditions` 满足后交接给模拟引擎并置 `openingCompleted = true`（不设阶段枚举）。
  完成定义：未完成即时事件与未来事件分别进入正确队列，首轮推进能消费；`openingCompleted === true` 且开局未完成时的推进请求被拒（R-TM-02）。
  **施工顺序调整（用户 2026-11-11 已确认，已执行完毕）**：`handoff()` / `openingCompleted` 置位、事件分流、server 接线均已完成并验收；完成定义中「开局未完成时的推进请求被拒」由 `T2-02` 的 `assertActive()` 门禁承担（2026-11-11 06:51 落地，`guard.test.ts` 5 例 + HTTP 端到端验证），故本条与 `T2-02` 一并勾选；按「先建能力、最后接门禁」执行，阶段 2/3 期间 `main` 全程可跑。

## 5. 阶段 4 — Ending / Evaluation / Archive

- [x] **T4-01** 依赖：T1-03、T2-01｜需求：R-EN-01、R-EN-02、R-EN-03、R-EN-07｜产出：`schema/ending.ts`、`v2/ending.ts` 条件检查
  七类终止条件（含 `battleDefeat`）+ AND/OR + `immediate/afterSettle`；仅在模拟边界检查；**HP 不得作为终止判据**，静态检查 `ending.ts` 不读取 HP 判死。
  完成定义：结算中途临时满足不误触发；立即终止与结算后终止各有测试且无半更新状态；任意战斗/事件结算后 `state.player.hp >= 1`（P9）。

- [x] **T4-02** 依赖：T4-01｜需求：R-EN-04、R-EN-05、R-EN-08｜产出：结局筛选与决胜、`EndingRecord` 固化、`DeathRoute` 两路径
  优先级 / 专属条件 / 互斥组 / fallback / 隐藏结局可见性；战败且死亡条件满足时按 `deathMode: event`（生成死亡事件走既有 chains）或 `direct`（直接触发结局）结束，并统一走 `markTerminated()`；战败但条件不满足时继续模拟。
  完成定义：三结局同满足时结果稳定；无专属命中走兜底；隐藏结局未解锁不进候选集；两条死亡路径各有测试且均不改写 HP。

- [x] **T4-03** 依赖：T4-02｜需求：R-EN-06、R-NFR-03｜产出：结局叙事 adapter + Zod 校验 + 模板回退
  三种叙事实来源；LLM 输出含虚构事实或校验失败时回退。
  完成定义：注入非法输出后最终状态逐字段不变，文案为模板回退版本。

- [x] **T4-04** 依赖：T1-01｜需求：R-EV-01、R-EV-02、R-EV-03、R-NFR-05｜产出：`schema/evaluation.ts`、`v2/life-evaluation.ts`
  六通用维度 + 模板增删改名调权；基于过程记录的确定性评分；结局类型仅作背景。
  完成定义：同结局不同过程得分不同；同过程不同结局得分可相近；`projectSnapshotV2` 内现算评价已移除，新模块为唯一事实来源。

- [x] **T4-05** 依赖：T4-04｜需求：R-EV-04、R-EV-05、R-EV-06｜产出：证据引用与总结编排
  每维度输出 `evidenceIds[]`；LLM 只组织语言；归档后只读。
  完成定义：每条证据 ID 可在本局历史中解析（P6）；篡改分数的 LLM 输出被拒；`ARCHIVED` 写操作被拒。

- [x] **T4-06** 依赖：T4-02、T4-05｜需求：R-AR-01、R-AR-02、R-AR-03｜产出：`v2/archive.ts`
  组装最终快照 / 事件历史 / 结局 / 评价 / `TerminationRecord` 并置 `archived = true`；沿用现有存档机制（不建阶段状态机）。
  完成定义：五类数据齐全且可回顾；无新增独立存档子系统。

## 6. 阶段 5 — 装备系统

- [x] **T5-01** 依赖：T1-03｜需求：R-EQ-01、R-EQ-02、R-NFR-02｜产出：`schema/equipment.ts`、`equipment.yaml` 样例、`items.yaml` `dynamicModifier` 字段
  模板定义槽位/类别/品质/初始装备与**动态补正 spec**（preset 白名单 + params + conditions）；定义与实例分离，实例不存补正结果；**不提供 static/dynamic 二选一**。
  完成定义：两个栏位结构不同的模板均校验通过且无需改引擎；缺字段报错含路径；模板声明 `modifierMode` 或自由表达式时被拒。

- [x] **T5-02** 依赖：T5-01｜需求：R-EQ-03、R-EQ-06｜产出：`v2/equipment.ts` 效果接线
  装备效果走 §12 声明式 DSL / 补正系统，接入 `effectiveAttributes()` 的**运行时求值链**；非白名单字段拒绝；补正结果不得写回 `state.player.attributes` 或 `EquipmentInstance`。
  完成定义：静态检查无自由表达式求值器、无属性写回；注入判定类非白名单字段被拒且状态不变（P8）。

- [x] **T5-03** 依赖：T5-01｜需求：R-EQ-04｜产出：`evaluateDynamicModifier()` 动态补正求值
  每次结算按当前状态 / 层数 / 条件由 preset 白名单求值；固定值作为「无条件」退化 preset 走同一管线；`attributeModifiers.perStack`（S3 #18）明确报错而非静默忽略。
  完成定义：同一装备在两份不同状态下补正值不同且符合 preset 语义；穿脱前后基础属性逐字段不变；`perStack` 报可诊断错误；同 seed 回放补正序列一致。

- [x] **T5-04** 依赖：T5-02｜需求：R-EQ-05、R-NFR-01｜产出：穿脱/替换操作与槽位冲突校验
  完成定义：槽位不匹配/重复占槽被拒且状态不变；同 seed 回放属性结果一致。

## 7. 阶段 6 — 战斗 AI 分层决策

- [x] **T6-01** 依赖：T1-03｜需求：R-CA-01｜产出：`schema/combat-ai.ts`、`v2/combat-ai.ts`
  实现五步决策，每步可单独测试；结算交回 `battle.ts`。
  完成定义：候选集不含被禁止行动；选择等于最高分或模板决胜规则；结算路径不变。

- [x] **T6-02** 依赖：T6-01｜需求：R-CA-02、R-NFR-05｜产出：`CombatStyleProfile` 与风格样例
  风格解析为权重/过滤参数，引擎内无风格名分支。
  完成定义：同状态换三种风格至少一次决策不同；静态扫描无风格名常量。

- [x] **T6-03** 依赖：T6-01｜需求：R-CA-03、R-CA-06｜产出：条件化策略 + `PublicConditionContext` 白名单
  实现低血治疗 / 按公有属性选技能；条件求值唯一输入为 `PublicConditionContext`（投影可见字段 + `visibility: "public"` 日志/效果 + 已公开战斗状态），禁止 `hidden/unknown/secrets/combatHints/NPC 私有目标`；模板引用非公有字段在**加载期**由 Zod / 协议校验拒绝并给出字段路径。
  完成定义：条件满足命中、不满足不命中；注入隐藏字段模板被拒且无部分初始化状态；静态检查 `decide()` 不接收完整 `WorldStateV2`。

- [x] **T6-04** 依赖：T6-01｜需求：R-CA-04、R-CA-05、R-NFR-01｜产出：确定性测试与非法输出回退
  完成定义：无 LLM 依赖、同 seed 决策一致（P1/P7）；非法 actionId 被拒并回退合法候选；决策上下文不含隐藏字段（P7）。

## 8. 阶段 7 — 时间穿越（⛔ 整阶段 DEFERRED，延期至 R3）

> 用户 2026-11-11 决定：A3 时间穿越维持「下次迭代（本次不做）」，与附录 A A3、ADR-0002 P4 立项一致。本阶段 6 个任务（`T7-01`～`T7-06`）、`T1-02`（ADR-0005）与 `requirements.md` §F 的 7 条需求一并延期，**不执行、不验收、不计入全局完成门槛**。任务原文按编号保留在文末「附录 A」，供 R3 直接恢复，编号不重排。
>
> 本轮与该主题有关的唯一 ACTIVE 工作：`T0-01` 核查 `design.md` §8 末三个接口预留点并登记缺口（只报告，不补实现）。

## 9. 阶段 8 — 跨模板剧本与收尾

- [ ] **T8-01** 依赖：阶段 3–6｜需求：R-NFR-05、R-NFR-06｜产出：三世界观模板补齐（JJK / Steins;Gate / 现代人生）
  完成定义：模板差异只通过配置/适配器表达，`game-core` 无世界观专名常量；Steins;Gate 本轮**不写穿越配置**（R3）。

- [ ] **T8-02** 依赖：T8-01｜需求：R-NFR-01、R-NFR-06、`design.md` §11｜产出：P1–P3、P5–P9 正确性属性回归套件（P4 随 A3 延期）
  完成定义：`pnpm typecheck` 0 错误、`pnpm test` 全绿，属性测试可追溯到需求编号。

- [ ] **T8-03** 依赖：T8-02｜需求：R-NFR-03、R-NFR-04｜产出：LLM 失败注入与可见性渗透测试
  完成定义：LLM 全链路不可用时仍能到 `ARCHIVED`；投影中永不出现 hidden/unknown 条目。

- [ ] **T8-04** 依赖：T8-01..03｜需求：全部｜产出：`tasks/reports/R2-COMPLETION.md`
  按需求编号逐条核对验收，列出未完成项与风险；同步 `README.md` / `tasks/IMPLEMENTATION_PLAN.md` 阶段状态。
  完成定义：**R2.2 口径的 45 条 ACTIVE** 需求逐条标注「通过 / 部分 / 延期」及原因；另列 7 条 DEFERRED 为「延期（R3）」、6 条 RETIRED 为「本轮不做」。

------------------------------------------------------------------------

## 10. 全局完成门槛（Definition of Done）

1. `requirements.md` **45 条 ACTIVE** 需求均有测试或明确标注的延期理由；7 条 DEFERRED 已登记为 R3。
2. `design.md` §11 的 **P1–P3、P5–P9 共 8 项**全部有覆盖；P4 随 A3 延期。
3. `pnpm typecheck` 与 `pnpm test` 通过；新增能力均有正常/边界/无效输入三类测试。
4. **ADR-0004** 状态为「已接受」，协议 V2.1 与 `CORE_ENGINE.md` §8 同步；**ADR-0005 本轮不要求**；ADR-0003「组队战斗」草案未被改动。
5. 三世界观剧本可跑通；**Steins;Gate 的时间穿越剧本属 R3**。
6. 无隐藏信息泄漏、无 LLM 直接写状态、无世界观硬编码、无新增 npm 包。
7. **R2.2 决策项**：无 `lifecycle.ts` / `Phase` / 阶段日志；HP 全程 ≥ 1 且未被用作死亡判据；装备补正不写回基础属性；条件化 AI 模板不含隐藏字段引用。

## 11. 阶段 0 启动指令（可直接复制给 Coding Agent）

> **执行状态（2026-11-11 05:10）：已完成。** T0-01/02/03 结论见 `tasks/reports/R2-GAP-ANALYSIS.md` §1–§9（历史快照），T0-04 增量复核见同报告 §10；T1-01（ADR-0004）、T1-03（协议 V2.1）、T1-04（CORE_ENGINE §8 / OPEN_QUESTIONS 同步）均已落盘并提交。V2 WIP 已固化为基线提交 `f8206ca`，工作区干净；下方原文的「另一 Agent 未提交 WIP」描述仅适用于当时快照。**下一阶段为 T2-01（阶段 2 终止模型与门禁）。**


> 阅读 `specs/iteration-2026-11-11/README.md`、`requirements.md`、`design.md`、`tasks.md`，以及 `specs/DESIGN_INCREMENT_LIFECYCLE_2026-11-11.md` 与 `specs/DESIGN_INCREMENT_2026-11-10.md`。对照**当前工作区实际代码**（注意存在未提交的 v2 WIP）执行 `T0-01`～`T0-03`：输出 `tasks/reports/R2-GAP-ANALYSIS.md` 差距报告，逐条标注 **R2.2 口径 45 条 ACTIVE 需求**的实现状态（**7 条 `R-TT-*` 为 DEFERRED、6 条 `R-LC-*` 为 RETIRED，都只登记状态不分析**），另执行 `T0-04` 复核 R2.2 新增需求；核查开局/结局/评价耦合、终止判定归属与事件复用可行性，并核查 `design.md` §8 末三个接口预留点。**本阶段只交报告，不改实现代码，不写 ADR（尤其不写 ADR-0005），不重构。** 完成后按 `AGENTS.md` §4 格式汇报。

> 另：动手前先确认另一个 Agent 是否已停止写入 `packages/`；若仍在运行，等待其提交后再开始，避免并发冲突。

------------------------------------------------------------------------

## 附录 A：R3 延期任务（⛔ 不纳入本轮执行与验收）

> 以下 7 个任务与 `requirements.md` §F 的 `R-TT-01..07`、`design.md` §8 草案一并延期。编号保留、内容不重排，R3 立项时直接恢复为 `- [ ]` 并补 ADR-0005。**恢复前置条件**：ADR-0002 时间适配器实施收敛、阶段 0 差距报告登记的三个 seam 缺口已补齐。

- **T1-02（DEFERRED）** 依赖：T0-01（R3 版）｜需求：R-TT-*｜产出：`docs/DECISIONS.md` ADR-0005
  落盘时间穿越语义（三层事件存储、世界线、隐秘化、RNG 派生、分支存档是否纳入），接续 ADR-0002 预留接口位。
  完成定义：ADR 与 `design.md` §8 一致；`docs/OPEN_QUESTIONS.md` 中相关待决项状态更新。

- **T7-01（DEFERRED）** 依赖：T1-02、T3-04、阶段 2｜需求：R-TT-01｜产出：`schema/event-instance.ts` 扩展、`schema/world-line.ts`
  三层事件存储落地（定义 / 实例 / 记录）。完成定义：穿越前后 `EventDefinition` 集合逐条相等（P4）。

- **T7-02（DEFERRED）** 依赖：T7-01｜需求：R-TT-02、R-TT-03｜产出：`v2/time-travel.ts` `jumpTo()` 前三步
  保留已发生记录及实际发生日期；撤销未来实例执行状态；不删定义。完成定义：回拨后 `EventRecord` 只增不减、时间戳不被改写（P4）。

- **T7-03（DEFERRED）** 依赖：T7-02｜需求：R-TT-04、R-NFR-04｜产出：隐秘化与投影过滤
  完成定义：主角/亲友/重要 NPC 未来事件转 `hidden` 且不进玩家投影（P5），服务端内部可查。

- **T7-04（DEFERRED）** 依赖：T7-02｜需求：R-TT-05｜产出：按新状态重新触发
  完成定义：条件不再满足时旧事件不重放，按新条件分支触发；新实例使用新 ID。

- **T7-05（DEFERRED）** 依赖：T7-01｜需求：R-TT-06｜产出：`WorldLineRecord` 与子 RNG 派生
  完成定义：同初始状态 + 同指令序列（含穿越）+ 同 seed 的完整回放归档逐字段相等（P1）。

- **T7-06（DEFERRED）** 依赖：T7-01..05｜需求：R-TT-07｜产出：Steins;Gate 测试模板与剧本测试
  完成定义：验证未来事件重置、世界线结局与评价差异，且不需修改核心引擎即可表达该世界观规则。
