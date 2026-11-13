# R2.7 完成报告 · AI 叙事层接入（LLM 接入）

> **生成时间**：2026-11-13 无人值守任务收尾，供次日复核。
> **报告口径**：只陈述实际实现、实际跑过的命令、已登记的决策。未做 / 未验证 / 未解决的项目逐条列明，**不补写成已完成**。
> **裁定来源**：`life-sim-qa` 冒烟级验收通过（S1–S9 全 PASS，零 P0/P1）；本报告为实施方汇总，不重新出测试结论。
> **提交序列**：`ad53d01`（R2.7 起草时 HEAD）→ `42ffa17`..`ba889ba`（10 个功能 / 规格 commit）→ `0f42bd0`（ADR 事后补记）→ 收尾文档 commit（仅 `PROJECT.md` + 本报告，无代码改动）。

## 0. 一句话结论

R2.7 的 **9 条 ACTIVE 需求 / 8 个 `T-*` 任务全部实现**；按用户裁决**仅执行冒烟级验证**（全绿）；**ADR-0027 在全部功能与冒烟验证完成之后事后补记**。`BACKLOG §0` 标注的产品核心缺口「AI 叙事层未实现、引擎零 LLM 调用」已闭合为：**服务端 LLM Provider 全链路可运行，且无配置时零回归**。

🔴 **流程口径（仅适用本次任务，不延续）**：本次「免除前置 ADR 流程 + 事后补记 ADR」是用户对该次无人值守任务的一次性裁决。**后续任何任务一律恢复 `AGENTS.md §0.3` 的 G1 / G2 正常门禁**——动契约面（T-2）必须先写 ADR 并经评审通过后再实施，不得援引本轮为先例。

### 本次用户裁决原文要点

| 项 | 裁决 |
|---|---|
| 范围 | 完成本次任务中全部待完善需求项，补齐所有未完成功能 |
| 验证 | **仅冒烟级**，确认核心功能可用；**明确不进行全流程测试** |
| ADR | **免除前置流程**；全部功能与冒烟验证完成之后，再**事后补记**，涵盖变更范围与决策结果 |
| 交互 | **无需等待确认**，次日本人复核 |
| 时效 | 免流程与事后补记**仅适用本次任务，不延续到后续任务** |

---

## 1. 提交清单（11 个功能 / ADR commit + 1 个收尾文档 commit）

| # | 提交 | 内容 |
|---|---|---|
| 1 | `42ffa17` | `T-P1 R-LLM-01/R-LLM-03` 叙事纯函数抽取 + `LLMProvider` 契约 + `EventFlavorOutputSchema` |
| 2 | `e189d03` | `T-P2 R-LLM-02/R-LLM-06` 三层 Provider 与凭证路由 |
| 3 | `6242981` | `T-P3 R-LLM-04/R-NAR-01` 叙事编排与同步/异步桥 |
| 4 | `3b567dd` | `T-P4 R-LLM-05/R-NAR-03` 事件 flavor 异步非权威缓存 + 冒烟脚本 |
| 5 | `c4f59e1` | `T-S3` 前端消费 `eventFlavors` + `T-S1/T-S2` 玩家可见 AI 叙事标记 |
| 6 | `80379c4` | `T-S1 R-NAR-01` 结局叙事接真实 LLM + 响应层装饰 |
| 7 | `00a5649` | `T-S2 R-NAR-02` 人生总结接真实 LLM |
| 8 | `0501e98` | `T-S3 R-NAR-03` 事件 flavor 服务端接入 + 投影下发 |
| 9 | `ef28d26` | 冒烟脚本路由占位值改为具名常量，消除密钥字面量扫描误报 |
| 10 | `ba889ba` | `T-S3` 补齐 GET / 409 刷新路径的 `eventFlavors` 合并（实施期发现的缺口） |
| 11 | `0f42bd0` | **ADR-0027 事后补记**（仅 `docs/DECISIONS.md`，在 1–10 与冒烟验证全部完成之后） |
| 12 | 收尾文档 commit | `PROJECT.md` §2 状态表 / 「下一步」/ §3 输入表 + 本报告 `tasks/reports/R27-COMPLETION.md`（仅文档，无代码改动） |

**量化**：`git diff --stat ad53d01..ba889ba`（功能 + 规格）= **18 files / +1767 / -53**；再加 ADR 补记后 `ad53d01..0f42bd0` = **19 files / +1893 / -54**。

---

## 2. 需求与任务完成对照

### 2.1 九条 ACTIVE 需求

| 需求 | 主题 | 落地位置 | 状态 |
|---|---|---|---|
| `R-LLM-01` | `LLMProvider` 统一接口 | `apps/server/src/llm/provider.ts`；`complete(): Promise<unknown>` 返回未校验候选 | ✅ |
| `R-LLM-02` | 三层凭证路由 | `createLLMProvider()`；客户端零凭证 | ✅（云端链路见 §8 #49） |
| `R-LLM-03` | 确定性边界 | LLM 只填展示字段；不进 `WorldStateV2` / replay / 存档信封 | ✅ |
| `R-LLM-04` | 回退与可诊断 | `generateNarrative()`；`invalid_schema` / `fabricated_evidence` / `[超时]` / `[不可用]` 四类 `diagnostic` | ✅ |
| `R-LLM-05` | 异步不阻塞回合 | `scheduleEventFlavors()` fire-and-forget，在 `worldStore.save()` 之后 | ✅ |
| `R-LLM-06` | 配置与密钥管理 | 仅 `LIFE_SIM_LLM_*` env；缺任一即整组不可用、启动不报错；`ef28d26` 清掉扫描误报 | ✅ |
| `R-NAR-01` | 结局叙事接真实 LLM | `resolveEndingNarrative` + `decorateEndingView` + `archive` 路由 adapter 注入 | ✅ |
| `R-NAR-02` | 人生总结接真实 LLM | `finalizeEvaluationSummary`；`dimensions`/`evidenceIds`/`overall` 逐字段不变 | ✅ |
| `R-NAR-03` | 事件 flavor 异步接入 | `flavorCache.ts` + `index.ts` 响应级 `eventFlavors` + 前端 `resolveEventNarrative` | ✅ |

### 2.2 八个 `T-*` 任务

`T-P1` / `T-P2` / `T-P3` / `T-P4` / `T-S1` / `T-S2` / `T-S3` **全部 ✅ 已完成**。
`T-S4` **⚠️ 按用户裁决收窄为冒烟级**：任务编号与 `tasks.md` 中 T-S4 章节原文保留不改，仅调整本轮验证范围；`pnpm test` / 全量 vitest / `playthrough.test.ts` 6 种子 / UI e2e **本轮禁止执行**。

> 状态表见 `specs/iterations/2026-11-13-ai-narrative/tasks.md`「完成总览」。

---

## 3. 变更范围（实绩）

### 3.1 契约面判定

| 项 | 结论 |
|---|---|
| 变更类别 | **T-2 协议/契约变更**（动 `packages/shared` + `packages/game-core` + `apps/**`）。用户免除的是**前置 ADR 流程**，**不是**降级为 T-1 |
| `schemaVersion` | **保持 2，不升**（`apps/server/src/store.ts:34`） |
| `WorldStateV2` | **零改动**（`packages/shared/src/v2-state.ts` 未改） |
| 模板指纹 | **不变** —— 本轮未改任何 `*.yaml`，`computeFingerprint()` 只 hash `specs/data/templates/**/*.yaml` |
| 旧档 | **不拒载，可直载**（版本 / 指纹 / `safeParse` 四道关全过） |
| 运行时依赖 | **无新增** —— `package.json` / `pnpm-lock.yaml` 均未改，用 Node 22 全局 `fetch` 与 `AbortSignal.timeout` |
| 投影契约 | `EndingView` / `V2Snapshot` / `projectSnapshotV2` / `buildEndingView` **零改动**；玩家可见 llm 来源由服务端**出口响应层装饰**实现 |

### 3.2 18 个改动文件

| 包 | 文件 | 角色 |
|---|---|---|
| `apps/server` | `src/llm/{provider,mock,openaiCompatible,workbuddyCloud,errors}.ts` | Provider 接口、三层实现、路由工厂、类型化错误（错误体绝不含 key/token/session） |
| `apps/server` | `src/narrative/generate.ts` | `generateNarrative` / `adapterFromOutcome` / `decorateEndingView` |
| `apps/server` | `src/narrative/flavorCache.ts` | 非权威 `Map` + 确定性复合键 + fire-and-forget 调度 |
| `apps/server` | `src/index.ts` | **唯一路由文件**（设计稿误写的 `src/v2.ts` 并不存在）：`isMaskedEnding`、快照装饰、归档 adapter 注入、flavor 调度与响应合并 |
| `apps/server` | `smoke/narrative.smoke.ts` | 6 项冒烟（`node:assert` + `tsx`，不引 vitest） |
| `packages/game-core` | `src/v2/narrative.ts` | 导出 `build*Request` / `validateNarrativeOutput` / `NarrativeInput` 等纯函数；**既有同步签名零改动、不引 LLM / 网络 / zod** |
| `packages/game-core` | `src/v2/narrative-llm.test.ts` | 定向 12 例 |
| `packages/shared` | `src/schema/event.ts` | 新增 `EventFlavorOutputSchema = z.object({flavor}).strict()`（落在 `event.ts`，导出链零改动） |
| `packages/shared` | `src/event-flavor.test.ts` | 定向 5 例 |
| `apps/web` | `src/api.ts` / `src/main.tsx` / `src/style.css` | 可选字段消费、`resolveEventNarrative` / `mergeEventFlavors` / `withMergedFlavors`、`AiNarrativeTag`、GET / 409 刷新合并 |
| `docs` / `specs` | `OPEN_QUESTIONS.md`、`tasks.md` | #49 登记、任务状态回填 |

---

## 4. 关键设计决策（落地口径）

1. **LLM 全在服务端，game-core 保持确定性**：`LLMProvider` 定义在 `apps/server`；校验单一事实来源 `validateNarrativeOutput()` 留在 game-core 并通过 `NarrativeOutputSchemaLike` 避免 import zod。game-core 无 `fetch` / SDK / Promise。
2. **同步 / 异步桥**：服务端 `await generateNarrative()` 预取 → `adapterFromOutcome()` 包装成 game-core 既有**同步** `NarrativeAdapter`（`template` ⇒ 不注入；`llm` ⇒ 返回已校验候选；`fallback` ⇒ 抛错借用既有 catch 分支）。**LLM 注入绝不发生在 turn 管线 / `advanceTurnV2` 内**，只在归档 / 读取 / 响应出口按需生成。
3. **三层路由**（`createLLMProvider`）：`cloudSession + cloudUrl` ⇒ `workbuddy-cloud`；三项 `LIFE_SIM_LLM_*` 齐备 ⇒ `openai-compatible`；否则 ⇒ `mock`。
4. **Mock 语义消歧**：默认路由**短路 `template`**，`generateNarrative` 见 `provider.id === "mock"` 直接返回，**根本不调 `complete()`**（零回归 / 零延迟 / 零外部依赖）。`MockProvider.complete` 保留供显式注入，合法候选 ⇒ `source: "llm"`。由此 `R-LLM-02`「无配置恒模板」与 T-P3 DoD「合法候选 ⇒ llm」不再冲突。
5. **🔴 隐藏结局红线（ADR 草案遗漏，实施期补上的硬约束）**：`masked` 结局一律跳过 LLM adapter 注入**与**响应层装饰。双层实现 —— `isMaskedEnding()` 按 `endingId` 回查 `narrativeConfig.masked`（三处同步跳过）+ `decorateEndingView()` 判 `ending.visibility === "hidden"` 原样返回。防止 LLM 的 title/summary 覆盖掩码、绕过 ADR-0006 泄漏 hidden 原文。
6. **缓存键修正**：设计稿的 `eventInstanceId` **在代码中不存在**（现有 `instanceId` 是状态层延时队列实例，`triggeredEvents[].id` 是定义 id）。实绩改用确定性复合键 `worldId|turnIndex|worldTime|eventId|occurrenceIndex`，**严禁 `Math.random()` / `Date.now()` / `randomUUID()` 参与键**；缓存为进程级独立 `Map`，不挂 state、不落盘、不进 replay，保留 R3 时间穿越 seam。
7. **`diagnostic` 落点**：`EndingRecordSchema` / `EvaluationRecordSchema` 为 strict 且无该字段 ⇒ 只存在于 `NarrativeOutcome` 与服务端可诊断日志（`request.log.warn({diagnostic}, "narrative_fallback")`，不含凭据），**不写进 shared 契约或 state**。
8. **前端零回归**：新增字段全部可选；`resolveEventNarrative()` 空值回退 `event.narrative`（字段缺失 = 与改前逐字相同）；`AiNarrativeTag` 仅在 `narrativeSource === "llm"` / `summarySource === "llm"` 显示。
9. **刷新延迟弥合**（`ba889ba`）：flavor 是 fire-and-forget，首次结算响应可能早于后台生成 ⇒ `GET /api/worlds/:id` 与 409 冲突刷新路径合并「该世界历史缓存 ∪ 本轮缓存」，前端 `withMergedFlavors` 守护 turnIndex 一致与 no-op。

---

## 5. 冒烟验证结果

> **按用户裁决：只跑冒烟级，确认核心功能可用。未执行全流程测试。**

| 命令 / 项 | 实际结果 |
|---|---|
| `pnpm typecheck` | **0 错**（全仓 `tsc --noEmit -p tsconfig.json`，覆盖 `packages/**/*.ts` + `apps/**/*.ts(x)`） |
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism src/v2/narrative-llm.test.ts` | **12 passed** |
| `pnpm --filter @life-sim/shared exec vitest run src/event-flavor.test.ts` | **5 passed** |
| `pnpm --filter @life-sim/server exec tsx smoke/narrative.smoke.ts` | **6 PASS + `SMOKE OK`** |
| `pnpm --filter @life-sim/web build` | **Vite build 通过** |
| 服务端加载期 | `/health`、`/api/templates` 均 **200**（QA 用 `PORT=3107` + 临时 `LIFE_SIM_DATA_DIR` 验证后杀进程） |

服务端冒烟 6 项：

```text
PASS  ① createLLMProvider 三层路由 / API_KEY 缺失自动 Mock 不抛
PASS  ② generateNarrative 三类反例(非法 schema / 虚构证据 / 超时)回退且 diagnostic 可区分
PASS  ③ 合法候选 ⇒ llm；mock ⇒ template 且不调用 complete
PASS  ④ finalizeEvaluationSummary 注入 LLM 前后 dimensions/evidenceIds/overall 逐字段相等
PASS  ⑤ decorateEndingView 对 hidden 结局原样返回；public 才装饰
PASS  ⑥ flavorCache 键确定性 + 缓存不进状态
SMOKE OK
```

QA 附加裁定：**隐藏信息零泄漏**（含 masked 隐藏结局护栏）、**仓库密钥零字面量**、**零回归**（无 env 无登录态 ⇒ 叙事恒 `template`、不调 `complete`，与改前逐字相同）。

### 🔴 明确**未**执行（有意的验收边界，不是缺陷或遗漏）

`pnpm test` / 全量 vitest 套件 / `playthrough.test.ts` 6 种子结构性回归 / UI e2e / 任何全流程测试 / 真实外部 LLM 端点的联网调用。
ADR-0027 草案「验证要点」第 6 条所列 `playthrough.test.ts` 6 种子断言**本轮未跑**。**不得把未跑项写成已验证。**

> 环境备注：本机默认 3000 端口被占用（`EADDRINUSE`），非代码缺陷；自验与 QA 分别改用 `PORT=3399` / `PORT=3107`。

---

## 6. 保留的不变量

| 不变量 | 保护措施 |
|---|---|
| 同 seed + 同输入 + 同 seed ⇒ 同结果 | LLM 文本排除在回放契约外；不写状态 / 评分 / 事件 / 结局判定；`finalizeEvaluationSummary` 前后维度逐字段相等（冒烟 ④） |
| `hidden` 不进入玩家端 API | 不动投影字段集；新增🔴 masked 隐藏结局双层护栏（冒烟 ⑤） |
| game-core 无 LLM / 网络依赖 | 接口与实现全在 `apps/server`；game-core 只抽纯函数 |
| 客户端零 LLM 凭证、零直连 | 路由全服务端；密钥仅 env；`apps/web` 新增字段全可选 |
| `WorldStateV2` 零改动 / `schemaVersion=2` | flavor 缓存为进程级非权威 `Map`；两次 `JSON.stringify(state)` 逐字节一致（冒烟 ⑥） |
| LLM 失败不阻塞玩法 | `Promise.race` 超时竞速 + 四类 `diagnostic` + 一律回退模板 |
| 时间 / 随机 / ID 可注入，R3 seam | 缓存键确定性，未为键给 `WorldStateV2` 新增实例 id 字段，键含 `worldTime` 但不写死时间单调假设 |

---

## 7. ADR-0027 事后补记（时序合规）

**时序**：Phase 3 全部功能完成（10 个代码 / 规格 commit，HEAD `ba889ba`）→ Phase 4 冒烟验证由 QA 裁定通过 → **之后**才提交 `0f42bd0` 修改 `docs/DECISIONS.md`。`docs/DECISIONS.md` 在此之前全程未被改动。

`0f42bd0` 只改 `docs/DECISIONS.md` 的 ADR-0027 一节：状态行由「草案（G1 待评审）」改为「**已实施（事后补记，2026-11-13）**」，不变量检查表新增 1 行、「明确不做」表新增 1 行，并新增四节：

- 〔事后补记〕**变更范围（实绩）** —— 契约面事实 + 18 文件归属表
- 〔事后补记〕**决策结果（落地口径）** —— 9 条，逐条固化草案决策 1–6 与实现的差异、6 条主理人裁决
- 〔事后补记〕**验证结果（冒烟级）** —— 含「明确未执行」清单
- 〔事后补记〕**附录：遗留与风险**

ADR-0001..0026 历史正文**一字未动**；草案原文（背景 / 现状核实 / 决策 1–6 / 被否决的备选 / 影响面 / 验证要点 / 明确不做）**一律保留不改**，便于逐条核对。

---

## 8. 明确不做 / 遗留 / 风险

### 8.1 本轮明确不做（边界，非缺口）

| 不做 | 理由 |
|---|---|
| 客户端直连 LLM / 用户自带 key 走浏览器 | 违反 `AGENTS.md §5`（key 暴露 / XSS / 绑定外部账号） |
| LLM 写权威状态 / 决定评分 | 违反 `AGENTS.md §1/§5` 与既有 strict 契约 |
| LLM SDK 进 game-core | 违反确定性内核边界 |
| 升 `schemaVersion` / 改 `WorldStateV2` / 改模板 yaml | 旧档兼容 + 缓存非权威；本轮零 yaml 改动 |
| 自由文本行动解析（`OPEN_QUESTIONS #26`）/ 多 Agent 运行时（#3）/ 事件 flavor 流式输出 | 明确 DEFERRED / 后续增强，只登记不实现 |
| **宣称 WorkBuddy 云端 SDK 免密钥 LLM 已接通** | 见 §8.2，不假装成功 |

### 8.2 🔴 待用户裁决：`OPEN_QUESTIONS #49`

**「登录用户 → 服务端免密钥 LLM」的真实注入链路仍未解决**。ADR-0027 草案写「登录会话 → 云端 SDK」，但 ADR-0025 已定**服务端零凭据**，登录会话只存在于浏览器 `apps/web` 的 SDK 单例（会话以 localStorage 为唯一真源、client 刻意不暴露 `sessionToken`），且该 SDK 的 `chat.completions.create()` **仅支持 streaming SSE**；`apps/server` 没有该依赖、拿不到浏览器登录态。

本轮落地的是**可运行降级形态**：env 注入 `LIFE_SIM_WORKBUDDY_SESSION` + `LIFE_SIM_WORKBUDDY_CLOUD_URL` → 全局 `fetch` 调 `${cloudUrl}/.cloud/llm/chat/completions`（`stream:true`）→ 聚合 SSE `choices[0].delta.content` → `JSON.parse` → Zod。**未注入 session 即抛 `LLMUnavailableError` 回退模板，绝不假装成功**。

候选：**A** 服务端配置长期凭据（等价 OpenAI 兼容 env 路由）/ **B** 平台提供服务端可校验的短期会话令牌下发链路（须定令牌形态、下发通道、过期与撤销）/ **C** 保持现状（登录用户仍只走 Mock / OpenAI 兼容，云端免密钥 LLM 生产不可用）。**不决策后果即 C**。选 A/B 须先定契约并走 T-2 + ADR 补记，本轮 ADR-0027 **不覆盖此项**。

### 8.3 其他已知边界（均不阻断）

| 项 | 状态 |
|---|---|
| `summarySource` 玩家随时可见性 | 本轮仅从 `archive.evaluation.summarySource` 读取；若要跑动中随时可见，须给 `V2Snapshot.evaluation` 加可选字段（动投影契约 = T-2 + ADR） |
| `narrativeSource` / `summarySource` 端到端展示断言 | QA 建议下轮补强（本轮仅冒烟级） |
| `diagnostic` 未持久化 | strict schema 无该字段；若要可追溯须另立 T-2 + ADR |
| 缓存 TTL / 容量 | 进程级 `Map`，`worldStore.delete` 时按 `worldId` 清桶；不落盘、不进 replay |
| WorkBuddy SDK 仅 streaming 与 `complete(): Promise<unknown>` 的签名落差 | 已由 SSE 聚合消化；将来接真实 SDK 仍须保持此适配 |

---

## 9. 工作树状态（**刻意保留，未清理**）

以下为用户 / 规格侧既有 WIP，本轮**未改动、未提交、未清理**：

```text
 M specs/iterations/README.md
?? specs/iterations/2026-11-13-ai-narrative/README.md
?? specs/iterations/2026-11-13-ai-narrative/design.md
?? specs/iterations/2026-11-13-ai-narrative/requirements.md
```

`specs/iterations/README.md` 当前标注「R2.7 AI 叙事层接入（G1 待评审、零代码改动）」—— 该描述在**实施前**成立；实施后 G1 前置门禁按用户裁决本次免除，**未走正式 G1 评审**，因此本轮**不宣告迭代已按标准流程关闭**，仅宣告「功能完成 + 冒烟验证通过 + ADR 事后补记」。是否补做正式评审、何时关闭迭代，留待次日复核裁决。

`tasks.md` 已提交（属 R2.7 规格四件套中唯一入库的一份）。**`design.md` 中两处笔误未在规格侧更正**，已在 ADR-0027 实绩中记明：`apps/server/src/v2.ts` 实际不存在（唯一路由文件为 `src/index.ts`）；`eventInstanceId` 实际不存在（改用确定性复合键）。

---

## 10. 次日复核建议（按优先级）

1. **先看 `docs/DECISIONS.md` ADR-0027** 的四个〔事后补记〕小节 —— 变更范围 / 决策结果 / 验证结果 / 遗留风险已逐条对齐。
2. **裁决 `OPEN_QUESTIONS #49`**（A / B / C），否则默认落 C。
3. **确认流程口径**：本轮免前置 ADR + 事后补记为一次性；下一轮恢复 G1/G2。
4. **决定是否补做正式 G1 评审 / 关闭 R2.7 迭代**、是否更正 `design.md` 两处笔误、是否把 `summarySource` 加进投影契约。
5. 若需要**全流程回归证据**，另起一轮执行（本轮按裁决明确未跑 `pnpm test` / 6 种子 playthrough / UI e2e）。
6. 若要联调真实 LLM：配置 `LIFE_SIM_LLM_BASE_URL` / `LIFE_SIM_LLM_MODEL` / `LIFE_SIM_LLM_API_KEY` 三项后重启服务即可走 `openai-compatible`；不配置则恒为模板，与改前零差异。

---

> **本报告边界**：新增 `tasks/reports/R27-COMPLETION.md`；同步更新 `PROJECT.md` §2 状态表与 `.workbuddy/memory/`。未改任何实现代码、未改 spec 正文、未改 `docs/DECISIONS.md`（ADR 已于 `0f42bd0` 单独提交）、未改用户 WIP 文件。
