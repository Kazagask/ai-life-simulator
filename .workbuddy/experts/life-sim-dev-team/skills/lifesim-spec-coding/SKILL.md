---
name: lifesim-spec-coding
description: Spec Coding method for the AI Life Simulator repository. Use when the team starts an iteration, checks whether implementation is allowed, drafts a requirements/design/tasks package, implements a T-numbered task, or verifies a definition of done.
---

# 人生模拟器 · Spec Coding 方法

本技能是「人生模拟器研发团」随身携带的迭代方法卡。**权威来源仍是仓库里的 `AGENTS.md` / `specs/` / `docs/`**；本卡只规定执行顺序与门禁，避免团队凭记忆跳步。

## 适用工作空间

`D:\code\ai-life-simulator`（pnpm workspace / TypeScript strict / Node 22+）。
若当前工作空间不是该目录，先提示用户切换或确认路径，不要在别的仓库套用这些硬约束。

## 固定阅读顺序

1. `PROJECT.md` — 迭代面板与状态快照
2. `AGENTS.md` — 工程规范（§0 工作方式 / §1 架构边界 / §4 交付 / §5 禁止事项）
3. `specs/iteration-*/README.md` — 范围、冲突对齐、交给 Agent 的读法
4. `specs/iteration-*/requirements.md` → `design.md` → `tasks.md`
5. `docs/DECISIONS.md`（ADR）、`docs/OPEN_QUESTIONS.md`（待决项）
6. `tasks/reports/*.md`（已有差距报告 / 验收证据）

面板与规格冲突时以 `specs/` 为准，并提醒更新 `PROJECT.md`。

## 六道门禁

| 门禁 | 规则 |
|---|---|
| G1 | 阶段 0 差距报告完成并经用户确认前，不得修改实现代码 |
| G2 | 核心数据模型 / 技术栈 / 目录结构 / 游戏规则变更，先写 ADR |
| G3 | 一次只执行一个 `T<阶段>-<序号>` 任务，不擅自扩展范围 |
| G4 | 同一时刻只允许一个 Agent 写 `packages/` |
| G5 | `DEFERRED` / `RETIRED` 只登记，不实现、不测试、不派任务、不计入 DoD；编号与原文保留 |
| G6 | 不确定产品规则写 `docs/OPEN_QUESTIONS.md`，禁止自行伪造共识 |

## 四段流程

- **A 审查（只读）**：对照 ACTIVE 需求与当前实际代码，逐条标注五态（已实现/部分实现/缺失/耦合/需重构），更新 `tasks/reports/*.md`，停下来等用户确认。
- **B 规格与设计**：`README → requirements（EARS + 验收 + 追溯）→ design（现状/模型/接口/需 ADR）→ tasks（阶段/依赖/完成定义）`。只新增文件，不改代码、不重排编号。
- **C 实施**：取一个任务，先给实施计划再改文件；补正常/边界/无效输入测试与类型检查；提交信息注明任务 ID 与需求编号。
- **D 验收**：由 QA 独立重跑命令，按完成定义逐条 PASS/FAIL；按 `AGENTS.md` §4 汇报五项；更新 `PROJECT.md` 状态表。

## 项目硬约束速查

- `packages/game-core` 不依赖 React / Fastify / DB / LLM SDK；对外输入一律 Zod 校验。
- 同初始状态 + 同输入 + 同 seed ⇒ 相同结果；时间、随机数、ID 可注入。
- AI 只做叙事与候选生成，不得写入权威状态或决定评分；LLM 输出须结构校验并回退模板。
- `hidden` 不得进入玩家端 API 投影；世界观规则只能进模板。
- 不引入六阶段 Lifecycle 状态机，不产出 `lifecycle.ts` / `Phase` / 阶段日志；不写死「时间单调」假设。
- V1 引擎与类型已下线（仅保留 V2 共用 `rng.ts`），禁止引用 `evaluateLife` / `advanceTurn` 等已删除符号。
- 逻辑轮次 ≠ 世界时间；事件链可暂停、取消、分支；禁止单个巨型 `advanceTurn`。

## 当前轮次事实（2026-11-11，可能过期，以 specs 为准）

- R2.2：45 条 ACTIVE / 7 条 DEFERRED（时间穿越，转 R3）/ 6 条 RETIRED（Lifecycle 状态机）。
- 用户已定：ADR-0004 属本轮、ADR-0005 留给穿越；装备词条动态补正；HP 与死亡结局解耦；条件化 AI 只读公有字段。
- 阶段 0/1 完成前不得进入实现。

## 汇报格式（`AGENTS.md` §4）

1. 改动摘要 2. 关键设计决策 3. 执行过的命令及结果 4. 未完成项与风险 5. 是否修改了 Spec（列出文件）

## 任务简报四要素

发给成员的任务必须写清：目标 / 输入材料 / 输出格式 / 约束。
仓库内模板：`.workbuddy/skills/life-sim-iteration/templates/iteration-brief.md`。
