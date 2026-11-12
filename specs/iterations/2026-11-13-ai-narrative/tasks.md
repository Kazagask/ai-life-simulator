# R2.7 任务 · AI 叙事层接入（LLM 接入）

> G3：一次只做一个 `T-*`，不擅自扩展范围。依赖列表明先后顺序；完成定义（DoD）逐条 PASS 方可标记 completed。
> 关联 ADR：ADR-0027（provider 接口 / 确定性边界 / 异步回退 / 凭证路由）。深设计见 `design.md`。

## WS-P LLM Provider 接入

### T-P1 schema 与接口：LLMProvider + 事件 flavor 契约
- **输入**：`packages/game-core/src/v2/narrative.ts`（抽 `build*Request` / `validateNarrativeOutput` 导出纯函数 + 新增 `buildEventFlavorRequest`）、`packages/shared/src/schema/{event,narrative}.ts`（新增 `EventFlavorOutputSchema` strict）。
- **产出**：纯函数抽取 + `EventFlavorOutputSchema`；`LLMProvider` 接口**类型**声明（设在 `apps/server` 域，但接口形状可先于实现确定）。
- **依赖**：无（ADR-0027 已草案）。
- **DoD**：`z.infer` 类型正确；`validateNarrativeOutput` 对非法 schema / 虚构 evidenceIds 返回 fallback 判定；`pnpm typecheck` 0 错；game-core 不新增 LLM/网络依赖。

### T-P2 LLMProvider 实现（Mock / WorkBuddy 云端 SDK / OpenAI 兼容）
- **输入**：`apps/server/src/llm/{provider,mock,workbuddyCloud,openaiCompatible}.ts`。
- **产出**：三层实现 + `createLLMProvider(config, auth?)` 路由工厂；Mock 默认返回确定性文本；OpenAI 兼容按 `LIFE_SIM_LLM_*` 调端点；云端 SDK 凭登录会话免密钥（不可达回退）。
- **依赖**：T-P1（接口形状）。
- **DoD**：无 env 无登录态 ⇒ Mock 默认生效、叙事恒模板（零回归）；`API_KEY` 缺失不报错；密钥不硬编码/不提交；密钥字面量不进仓库（扫描护栏）。

### T-P3 服务端编排：generateNarrative + 凭证路由 + 回退
- **输入**：`apps/server/src/narrative/generate.ts`。
- **产出**：`generateNarrative(request, schema, provider)` = `provider.complete` → `validateNarrativeOutput` → `{source:"llm"}` 或 `{source:"fallback", diagnostic}`；接结局/总结路由；路由决策：登录态→云端 SDK、env→OpenAI 兼容、无→Mock。
- **依赖**：T-P1/T-P2。
- **DoD**：注入伪造响应（非法 schema / 虚构证据 / 超时）三类反例均回退且 `diagnostic` 区分原因且不阻塞玩法；结局/总结 provider 可用时 `narrativeSource:"llm"`。

### T-P4 异步事件 flavor 缓存
- **输入**：`apps/server`（事件结算后 `fire-and-forget` 生成 + 非权威缓存）、`WorldStateV2`（**不**改）。
- **产出**：缓存键 `worldId+eventInstanceId+worldTime`；超时/失败回退模板；不进状态、不进 replay。
- **依赖**：T-P3。
- **DoD**：事件结算不被 LLM 延迟；超时（注入极短 timeout）后展示仍模板；`WorldStateV2` 两次序列化字节一致；缓存仅展示用途。

## WS-S 叙事表面接入

### T-S1 结局叙事接入真实 LLM
- **输入**：结局/归档路由（接 `generateNarrative`）、`resolveEndingNarrative` 既有护栏。
- **产出**：provider 可用时 `narrativeSource:"llm"`（标题/总结），否则 `template`/`fallback`。
- **依赖**：T-P3。
- **DoD**：Mock 关闭 + 合法候选 ⇒ `llm`；否则 `template`/`fallback`；分数/事件/结局判定不受 LLM 影响。

### T-S2 人生总结接入真实 LLM
- **输入**：总结路由、`finalizeEvaluationSummary`（仅替换 summary/source）。
- **产出**：provider 可用时 `summarySource:"llm"`；维度/分数/证据/overall 逐字段不变。
- **依赖**：T-P3。
- **DoD**：注入 LLM 前后 `dimensions`/`evidenceIds`/`overall` 逐字段相等；`summarySource` 按可用性取值。

### T-S3 事件 flavor 接入 + 投影
- **输入**：事件结算 hook（调用 T-P4 异步生成）、`apps/web` 投影消费 `eventFlavor`。
- **产出**：provider 可用时事件展示含 LLM 文案、否则模板；前端缺省模板文案、不报错。
- **依赖**：T-P4。
- **DoD**：投影在 provider 可用时含 flavor、否则模板；UI 不依赖 flavor 存在。

### T-S4 验收
- **输入**：全量测试 + `pnpm typecheck` + `pnpm --filter @life-sim/server start` 加载期。
- **产出**：R2.7 完成报告；回归 `playthrough.test.ts` 6 种子结构性断言（day/章节/五维）不变。
- **依赖**：T-S1/T-S2/T-S3。
- **DoD**：game-core / shared 测试全绿；typecheck 0 错；服务端加载期 fail-fast；叙事文本排除在 replay 契约外的断言通过。

## 完成总览

| 流 | 任务 | 状态 |
|---|---|---|
| WS-P Provider | T-P1 | ✅ 已完成 |
| WS-P Provider | T-P2 | ✅ 已完成 |
| WS-P Provider | T-P3 | ✅ 已完成 |
| WS-P Provider | T-P4 | ✅ 已完成 |
| WS-S 表面 | T-S1 | ✅ 已完成 |
| WS-S 表面 | T-S2 | ✅ 已完成 |
| WS-S 表面 | T-S3 | ✅ 已完成（服务端接入 + `apps/web` 投影消费） |
| WS-S 表面 | T-S4 | ⚠️ 按用户裁决收窄为冒烟级 |

> **T-S4 收窄说明（本次用户裁决）**：「功能完成后仅执行冒烟级验证，明确不进行全流程测试」。
> 故本轮 T-S4 验收口径收窄为 `pnpm typecheck` 0 错、两个新增定向 vitest 文件、
> `apps/server/smoke/narrative.smoke.ts`、`server start` 加载期检查；
> `pnpm test` / 全量 vitest / playthrough 6 种子 / UI e2e **本轮禁止执行**。
> T-S4 的任务编号与上方 T-S4 章节原文一律保留不改，仅调整本轮验证范围。
>
> 提交颗粒度：每个 `T-*` 一个 commit，信息注明任务 ID 与需求编号（R-LLM-*/R-NAR-*）。
