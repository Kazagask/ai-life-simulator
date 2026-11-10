---
name: life-sim-iteration
description: Run a Spec Coding iteration for the AI Life Simulator repo. Use when the user asks to start/continue an iteration, review a gap report, write requirements/design/tasks, implement a T*-numbered task, or verify acceptance in this workspace. Enforces AGENTS.md hard constraints and the requirements → design → tasks → implementation → verification sequence.
---

# AI 人生模拟器 · 迭代 SOP

本技能把仓库既有的 Spec Coding 流程固化成可重复执行的步骤。**它不是新规范**：`AGENTS.md`、`specs/`、`docs/` 始终是权威来源，本技能只负责"按什么顺序读、什么时候可以动手、怎么交付"。

## 何时使用

- 用户说"开始下一轮迭代 / 继续 R2 / 做 T2-03 / 复核差距报告 / 写 ADR / 验收这个功能"。
- 需要判断某个任务当前是否允许进入编码实现。
- 需要在本工作空间新建一轮 `specs/iteration-<日期>/` 四件套。

## 第 0 步：永远先读

每次任务开始，**按顺序**读取，不要跳读：

1. `PROJECT.md` — 当前轮次、状态快照、硬约束速查
2. `AGENTS.md` — 工程规范（尤其 §0 工作方式、§1 架构边界、§4 交付与测试、§5 禁止事项）
3. 本轮 `specs/iteration-*/README.md` — 范围、冲突对齐、交给 Agent 的读法
4. `specs/iteration-*/requirements.md` → `design.md` → `tasks.md`
5. `docs/DECISIONS.md`（ADR）、`docs/OPEN_QUESTIONS.md`（待决项）
6. `tasks/reports/*.md`（已有差距报告 / 验收证据）

> 若 `PROJECT.md` 的状态表与 `specs/` 冲突，**以 `specs/` 为准**，并提示用户更新面板。

## 门禁（不可跳过）

| 门禁 | 条件 |
|---|---|
| G1 审查对齐 | 阶段 0（差距报告）完成并经用户确认前，**不得修改实现代码** |
| G2 ADR 先行 | 涉及核心数据模型 / 技术栈 / 目录结构 / 游戏规则变更，必须先写 ADR 并落到 `docs/DECISIONS.md` |
| G3 单任务 | 一次只执行一个 `T<阶段>-<序号>` 任务，按 `tasks.md` 的依赖顺序；不擅自扩展范围 |
| G4 单写者 | 同一时刻只允许一个 Agent 写 `packages/`；并行任务先确认对方已停或已提交 |
| G5 状态过滤 | `DEFERRED` / `RETIRED` 需求只登记，**不实现、不测试、不派任务、不计入 DoD**；编号与原文保留 |
| G6 待决项 | 不确定的产品规则写入 `docs/OPEN_QUESTIONS.md`，**禁止自行伪造共识** |

## 标准流程

### Phase A — 审查（只读）
1. 对照 `requirements.md` 的 ACTIVE 需求与**当前工作区实际代码**（不是旧 spec）逐条标注：已实现 / 部分实现 / 缺失 / 耦合 / 需重构。
2. 输出或更新 `tasks/reports/R2-GAP-ANALYSIS.md`（下一轮用对应编号）。
3. 把「缺失」项的最小改造建议、需 ADR 的点、接口预留点现状写清楚。
4. **停下来向用户汇报**，等确认后再进入下一阶段。

### Phase B — 规格与设计
1. 新迭代沿用四件套：`README.md`（范围与冲突）→ `requirements.md`（EARS + 验收标准 + 追溯矩阵）→ `design.md`（现状 / 数据模型 / 接口 / 正确性属性 / 需 ADR 清单）→ `tasks.md`（阶段 / 依赖 / 产出 / 完成定义）。
2. 需求编号 `R-<组>-<序号>`，任务编号 `T<阶段>-<序号>`，**编号不重排**；延期整组标 `DEFERRED` 并保留原文。
3. 规格包本身**只新增文件**，不修改代码；协议与 ADR 的修订放到实施阶段按任务执行。

### Phase C — 实施（一次一个任务）
1. 从 `tasks.md` 取第一个未完成且依赖已满足的任务，确认其「完成定义」。
2. 改动前先给简短实施计划；改动严格限定在该任务产出文件内。
3. 每个功能至少覆盖：正常路径、边界条件、无效输入（适用时）、类型检查。
4. 提交信息注明任务 ID 与需求编号；保持可运行、可测试。

### Phase D — 验收与汇报
1. 执行 `pnpm typecheck`、相关 `pnpm test`（按 `tasks.md` 完成定义），记录实际命令与结果。
2. 自验通过后按 `AGENTS.md` §4 汇报五项：改动摘要 / 关键设计决策 / 执行过的命令及结果 / 未完成项与风险 / 是否修改了 Spec（列出文件）。
3. 更新 `PROJECT.md` 的状态快照；把新产生的未决项写入 `docs/OPEN_QUESTIONS.md`。

## 确定性内核专项检查

涉及 `packages/game-core` 时，额外核对：

- 纯函数优先，副作用放 adapter/service 层；时间、随机数、ID 生成可注入，测试中不得依赖真实时间或不可控随机数。
- 同初始状态 + 同输入 + 同 seed ⇒ 相同结果；不得让 LLM 成为唯一状态裁判。
- 逻辑轮次 ≠ 世界时间；事件触发由规则 / 条件 / 权重 / 概率 / 冷却 / 优先级控制；事件链可暂停、取消、分支。
- 信息分层 `known / inferred / unknown / hidden`；`hidden` 不得进入玩家端 API 投影。
- 不新增 `lifecycle.ts` / `Phase` / 阶段日志；不写死「时间单调」假设（R3 时间穿越 seam 要保留）。
- 禁止把所有逻辑塞进单个 `advanceTurn` 巨型函数；禁止把世界观专属规则硬编码进通用引擎。

## 与专家团协作

- 综合任务（跨需求 / 设计 / 实现 / 验收）优先召唤 **「人生模拟器研发团」**，由团长按 SOP 拆分、派发、汇总。
- 单点任务可直调对应角色或直接执行本技能，不必启动整团（专家团会消耗更多积分）。
- 无论是否用专家团，**门禁 G1–G6 同样生效**；专家产出也必须先审查对齐再落地。
- 发起任务时写清四件事：目标 / 输入材料 / 输出格式 / 约束，模板见 `templates/iteration-brief.md`。

## 禁止事项

- ❌ 不读 `AGENTS.md` 和本轮四件套就改代码
- ❌ 阶段 0/1 未完成就进入实现
- ❌ 静默换技术栈、改目录结构、改核心数据模型或游戏规则
- ❌ 用 `any` 逃逸、吞异常、吞掉测试失败
- ❌ 把 `DEFERRED` / `RETIRED` 需求偷偷实现或写进验收范围
- ❌ 替用户决定产品规则，或把猜测写成"已达成共识"
