# R2.7 迭代 · AI 叙事层接入（LLM 接入）

> 本文件是 R2.7 本轮的**范围、冲突对齐与读法**说明，不是产品规格，也不是代码。
> 权威内容始终在 `AGENTS.md`、`specs/`（含本迭代四件套）、`docs/DECISIONS.md` 与代码里。

> **〔云端工程适配状态，2026-11-13〕** 本 README 的 §0 缘起、§2 读序、§3 门禁状态含**实施前**口径；现按实绩对齐（起草期原文尽量保留、更正处显式标注）。§1 范围与 DEFERRED 项原文不动。
> - **功能已完成**：9 条 ACTIVE 需求（`R-LLM-01..06` / `R-NAR-01..03`）+ 8 个 `T-*` 全部实现，10 个功能 / 规格 commit（`42ffa17`..`ba889ba`）；契约面 `schemaVersion=2` / `WorldStateV2` 零改动 / 零 `*.yaml` 改动。
> - **验证仅冒烟级**：typecheck 0 错、定向 12+5 例、服务端 6 项、web build、加载期 200；全量 vitest / 6 种子 playthrough / UI e2e / 全流程 / 真实外部 LLM 联网**未跑**。
> - **ADR-0027 事后补记**（`0f42bd0`）：在全部功能与冒烟验证完成后补记，非前置门禁产物。
> - 🔴 **G1 前置门禁本次免除、未走正式评审**，故**未宣告按标准流程关闭**；是否补做正式评审 / 何时关闭迭代待用户裁决。该「免前置 ADR + 事后补记」**仅适用本次任务、不延续**，后续任务一律恢复 `AGENTS.md §0.3` 的 G1 / G2 正常门禁。
> - **追溯**：`tasks/reports/R27-COMPLETION.md`、`docs/DECISIONS.md` ADR-0027〔事后补记〕。

## 0. 本轮缘起（用户指令）

2026-11-13 讨论结论（bug fix 在飞期间）：下一阶段 = **AI 叙事层（LLM 接入）**。这是 `BACKLOG.md` §0 主线缺口序列排第一的**产品核心模块**，当前引擎完全是模板文案、零 LLM 调用。

provider / 部署决策（用户拍板，已记入 `.workbuddy/memory/2026-11-13.md`）：

- **参考适配器双轨**：OpenAI 兼容（覆盖 DeepSeek / 多数国产模型 / 本地端点）+ **WorkBuddy 云服务 SDK（凭登录会话免密钥）**；**Mock 默认启用**（零 key 也能跑、demo/测试零外部依赖）。
- **凭证全服务端、客户端零凭证**：运营 env 注入（`LIFE_SIM_LLM_*`）或用户经 WorkBuddy 登录后的云端 SDK；**客户端绝不直连 LLM**（AGENTS §5）。用户「自带 key」概念消解——登录用户经云端 SDK 免密钥调 LLM。
- **延迟面含事件 flavor 异步**：不止暂停点（结局叙事 + 人生总结），事件展示文案也 LLM 化，脱离回合管线后台生成、超时回退模板。
- 落地形态：需 **ADR-0027**（provider 接口 / 确定性边界 / 异步回退 / 凭证路由），属 **T-2**（动 server/engine 契约 + shared schema），**非** T-1 免 ADR。

## 1. 范围

| 包含 | 说明 |
|---|---|
| WS-P LLM Provider 接入 | `LLMProvider` 统一接口 + 三层实现（Mock / WorkBuddy 云服务 SDK / OpenAI 兼容）；服务端凭证路由（登录态→云端 SDK、env→OpenAI 兼容、无→Mock）；确定性边界；Zod 校验失败/超时/错误一律回退模板；异步生成机制。 |
| WS-S 叙事表面接入 | 结局叙事（R-EN-06，经 `resolveEndingNarrative`）、人生总结（R-EV-05，经 `finalizeEvaluationSummary`）、事件 flavor（新增异步表面）三个表面接真实 LLM provider。 |

| 明确**不含**（DEFERRED / RETIRED，只登记不实现） | 依据 |
|---|---|
| 自由文本行动解析（自然语言→结构化候选行动） | OPEN_QUESTIONS #26 未决；本轮不进，留待专项 |
| 多 Agent 运行时 | OPEN_QUESTIONS #3；P0 不要求 |
| 事件 flavor 流式输出 | 本轮只做异步生成 + 超时回退，流式是后续增强 |
| 客户端直连 LLM | AGENTS §5 严禁（外部账号依赖 / key 暴露） |

## 2. 阅读顺序（固定）

1. `AGENTS.md`（§0 工作方式 / §1 架构边界 / §5 禁止事项）—— 硬约束。
2. 本 `README.md`（范围与读法）。
3. `requirements.md`（EARS + 验收 + 追溯）。
4. `design.md`（现状盘点 / 实施决策 / 数据模型 / 文件计划 / 测试计划）。
5. `tasks.md`（阶段 / 依赖 / 完成定义）。
6. `docs/DECISIONS.md` **ADR-0027**（〔云端工程适配更正，2026-11-13〕已实施 · 事后补记；起草期作「本轮 G2 门禁产物，草案待审」，该口径已过时）。

## 3. 门禁状态（Spec Coding 六道）

| 门禁 | 状态 | 说明 |
|---|---|---|
| G1 差距报告 | **〔更正〕本次免除前置评审** | 起草期原文「待用户确认…确认前不写实现代码」；实绩按用户一次性裁决**免除 G1 前置门禁**、未走正式评审即进入实施，差距报告（本 README + `design.md` §1）未经正式评审。 |
| G2 核心模型/依赖 ADR | **〔更正〕已实施 · 事后补记** | 起草期原文「已写入草案…待 G1 评审通过转已通过」；实绩 ADR-0027 在全部功能 + 冒烟验证完成后事后补记（`0f42bd0`），状态「已实施（事后补记，2026-11-13）」，非前置门禁产物。 |
| G3 单任务 | 将遵守 | 实施时一次只做一个 `T-*`；WS-P / WS-S 可先后或并行窗口。 |
| G4 单 Agent 写 packages/ | 将遵守 | 实施期同一时刻仅一个 Agent 改 `packages/`。 |
| G5 DEFERRED 只登记 | 遵守 | 上表「不含」项不实现、不测试、不派任务。 |
| G6 不确定写 OPEN_QUESTIONS | 遵守 | 实施中任何产品规则歧义写入 `docs/OPEN_QUESTIONS.md`，不伪造共识（如事件 flavor 缓存键的回放语义）。 |

> **〔云端工程适配更正，2026-11-13〕** G1 / G2 两行按实绩对齐；G3–G6 为过程纪律声明，原文保留。🔴 本次「免前置 ADR + 事后补记」**仅适用本次任务、不延续**，后续任务一律恢复 `AGENTS.md §0.3` 的 G1 / G2 正常门禁。本轮**未宣告按标准流程关闭**，是否补做正式评审 / 何时关闭迭代待用户裁决。

## 4. 复用说明（避免重排编号 / 重复设计）

`packages/game-core/src/v2/narrative.ts` 已建好 LLM 接入的**脚手架与护栏**（只读 `NarrativeRequest`、`NarrativeAdapter` 注入点、`EndingNarrativeOutputSchema`/`EvaluationSummaryOutputSchema` 的 strict Zod 校验、证据白名单 `allowedEvidenceIds` 防虚构事实、`template/llm/fallback` 三来源 + `diagnostic` 可诊断）。**本迭代不重述这些护栏，只补「服务端 Provider 编排 + 异步事件 flavor + 凭证路由」**，并显式引用既有符号。

## 5. 交付判定（完成定义总览）

- WS-P：`pnpm --filter @life-sim/server start` 加载期不报错；无 `LIFE_SIM_LLM_*` 且无登录态时叙事恒走模板（零回归）；注入伪造 LLM 响应（非法 schema / 引用未发生证据）→ 断言回退 `fallback` + `diagnostic` 非空；Mock 默认生效。
- WS-S：结局叙事 / 人生总结在 provider 可用时 `narrativeSource === "llm"`、否则 `template`/`fallback`；事件 flavor 在 provider 可用时被异步填充、超时/失败回退模板且不阻塞回合；全量 `pnpm typecheck` 0 错；game-core / shared 测试全绿。

> **〔云端工程适配说明，2026-11-13〕** 上述为交付判定口径（原文保留）。本轮实绩按用户裁决**仅冒烟级验证**：typecheck 0 错 / 定向 12+5 例 / 服务端 6 项 / `apps/web` build / 加载期 200 通过；全量 `pnpm test` / 6 种子 playthrough / UI e2e / 全流程 / 真实外部 LLM 联网**未执行**，见 `tasks/reports/R27-COMPLETION.md` 与 `docs/DECISIONS.md` ADR-0027〔事后补记〕验证结果。

## 6. 云端工程适配（〔2026-11-13〕）

- 本迭代四件套随 GitHub 仓库 `git@github.com:Kazagask/ai-life-simulator.git` 同步至 WorkBuddy 云端项目，clone 后即可被 Agent 直接消费。
- 云端开发 / 测试入口：`docs/CLOUD_DEV.md`（runbook）与 `apps/server/smoke/cloud.smoke.mjs`（可移植冒烟，输出 `SMOKE OK`）。
- 全量回归（`pnpm test` / 6 种子 playthrough / UI e2e / 全流程 / 真实外部 LLM 联网）本轮**未执行**，仍待在云端跑完并单独出结论；不得据本迭代包写成已验证。
