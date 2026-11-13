# R2.7 需求 · AI 叙事层接入（LLM 接入）

> EARS 风格（When / The system shall / 验收 / 追溯）。编号：Provider 接入 `R-LLM-*`，叙事表面 `R-NAR-*`。

> **〔本轮状态说明 · 云端工程适配，2026-11-13〕**（本段为状态注记；下方 EARS 正文、需求编号、验收条目、追溯矩阵原文一律不动）
> - **实现**：9 条 ACTIVE 需求（`R-LLM-01..06` / `R-NAR-01..03`）**全部实现**，对应 8 个 `T-*` 任务完成（10 个功能 / 规格 commit `42ffa17`..`ba889ba`）；契约面 `schemaVersion=2`、`WorldStateV2` 零改动、零 `*.yaml` 改动 ⇒ 模板指纹不变、旧档可直载。
> - **验证口径（按用户裁决仅冒烟级）**：`pnpm typecheck` 0 错、定向 `narrative-llm.test.ts` 12 例 + `event-flavor.test.ts` 5 例、服务端冒烟 6 项、`apps/web` build、加载期 200。
> - **明确未跑 / 未出结论**：`pnpm test` / 全量 vitest 套件 / `playthrough.test.ts` 6 种子结构性回归 / UI e2e / 任何全流程测试 / 真实外部 LLM 端点联网调用；全量回归报告 `tasks/reports/R27-FULL-REGRESSION.md` 不存在，仍待在云端补跑，**不得把未跑项写成已验证**。
> - **流程**：ADR-0027 为**事后补记**（`0f42bd0`）；G1 前置门禁本次免除、未走正式评审，故**未宣告按标准流程关闭**；该「免前置 ADR + 事后补记」仅适用本次任务、不延续，后续恢复 `AGENTS.md §0.3` 的 G1 / G2 正常门禁。
> - **追溯**：`tasks/reports/R27-COMPLETION.md`、`docs/DECISIONS.md` ADR-0027〔事后补记〕。

## WS-P LLM Provider 接入

### R-LLM-01 LLMProvider 统一接口
- **The system shall** 定义与任意供应商无关的 `LLMProvider` 接口：`complete(request: NarrativeRequest, schema: ZodSchema, opts?): Promise<unknown>`，返回**未校验**候选，由调用方经 game-core 既有 Zod 校验。
- **验收**：接口在 `apps/server`（非 game-core）定义；game-core 不新增任何 LLM SDK / 网络调用（保持 AGENTS §1）。
- **追溯**：ADR-0027 决策 1、AGENTS §1。

### R-LLM-02 三层凭证路由
- **When** 需要生成叙事，**The system shall** 按优先级选择 provider：① 存在 WorkBuddy 登录会话 ⇒ 云端 SDK（免密钥）；② 配置了 `LIFE_SIM_LLM_*` 环境变量 ⇒ OpenAI 兼容；③ 否则 ⇒ Mock（返回确定性/模板化文本）。
- **验收**：无 env 且无登录态时叙事恒为模板（Mock 默认）；切换路由不依赖前端传 key；客户端代码零 LLM 凭证。
- **追溯**：ADR-0027 决策 2、AGENTS §5、ADR-0025（登录会话来源）。

### R-LLM-03 确定性边界
- **The system shall** 保证 LLM 输出仅填充不参与状态转移 / 评分的展示字段；候选与评分仍由规则确定性生成；叙事文本明确排除在「同 seed 同输入同结果」回放契约之外。
- **验收**：归档记录存当时生成的叙事原文快照；同 seed 重放断言**不**比对叙事文本；注入 LLM 不影响任何维度分数 / 事件触发 / 结局判定。
- **追溯**：ADR-0027 决策 3、AGENTS §5、R-EN-06 / R-EV-05。

### R-LLM-04 回退与可诊断
- **When** LLM 输出未通过 strict Zod 校验、引用未在本局发生的证据（`allowedEvidenceIds` 之外）、超时或抛错，**The system shall** 回退模板叙事并置 `narrativeSource: "fallback"` + 非空 `diagnostic`（不静默忽略、不阻塞玩法管线）。
- **验收**：构造非法 schema / 虚构证据 / 超时三类反例，断言回退且 `diagnostic` 区分原因；玩法回合不因 LLM 失败而中断。
- **追溯**：ADR-0027 决策 4、既有 `narrative.ts` 校验逻辑、AGENTS §2（错误可诊断）。

### R-LLM-05 异步生成（不阻塞回合）
- **When** 为事件 flavor 生成叙事，**The system shall** 在回合管线之外后台生成，超时即回退模板，绝不占用或阻塞当轮结算。
- **验收**：事件结算返回不被 LLM 调用延迟；LLM 超时（注入极短 timeout）后该事件展示仍为模板文案。
- **追溯**：ADR-0027 决策 5、用户延迟面裁决（含事件 flavor 异步）。

### R-LLM-06 配置与密钥管理
- **When** 配置 OpenAI 兼容 provider，**The system shall** 仅经 `LIFE_SIM_LLM_BASE_URL` / `LIFE_SIM_LLM_MODEL` / `LIFE_SIM_LLM_API_KEY` 环境变量注入，**绝不硬编码、绝不提交**密钥；缺失即视为不可用并回退 Mock。
- **验收**：仓库内无明文 key；`API_KEY` 缺省时启动不报错且自动 Mock；密钥扫描（既有 `boundary.test.ts` 世界观专名扫描同类）不含 key 字面量。
- **追溯**：ADR-0027 决策 2/6、OPEN_QUESTIONS #5。

## WS-S 叙事表面接入

### R-NAR-01 结局叙事接入真实 LLM
- **When** provider 可用且结局结算，**The system shall** 经 `resolveEndingNarrative(request, provider)` 产出 `narrativeSource: "llm"` 的标题/总结；不可用/校验失败回退 `template`/`fallback`（沿用既有护栏）。
- **验收**：Mock 关闭、provider 返回合法 `{title,summary,evidenceIds⊆allowed}` 时 `narrativeSource==="llm"`；否则 `template`/`fallback`。
- **追溯**：R-EN-06、ADR-0027、既有 `narrative.ts`。

### R-NAR-02 人生总结接入真实 LLM
- **When** provider 可用且生成人生总结，**The system shall** 经 `finalizeEvaluationSummary(record, provider)` 仅替换 `summary`/`summarySource`；维度、分数、证据、overall 逐字段保持不变。
- **验收**：注入 LLM 前后 `record.dimensions`/`evidenceIds`/`overall` 逐字段相等；`summarySource` 按可用性取 `llm`/`template`/`fallback`。
- **追溯**：R-EV-05、ADR-0027、既有 `narrative.ts`。

### R-NAR-03 事件 flavor 异步接入
- **When** 事件结算且 provider 可用，**The system shall** 异步生成该事件的展示文案（`EventFlavorOutputSchema` strict，仅文本字段），存入**非权威**缓存（不在 `WorldStateV2`、不进 replay），投影时优先取缓存、缺失/超时取模板文案。
- **验收**：事件结算后缓存被填充（或超时回退）；同一 `WorldStateV2` 两次序列化字节一致（缓存不影响状态）；投影在 provider 可用时含 LLM 文案、否则模板文案。
- **追溯**：ADR-0027 决策 5、用户延迟面裁决。

## 追溯矩阵（需求 → ADR / OPEN_QUESTIONS）

| 需求 | ADR | OPEN_QUESTIONS | 备注 |
|---|---|---|---|
| R-LLM-01..06 | ADR-0027 | #5（provider）、#3（多 Agent，DEFERRED） | WS-P |
| R-NAR-01..03 | ADR-0027 | #26（自由文本行动，DEFERRED） | WS-S |

> 注：#26 自由文本行动、#3 多 Agent 为明确 DEFERRED，仅登记不实现。
