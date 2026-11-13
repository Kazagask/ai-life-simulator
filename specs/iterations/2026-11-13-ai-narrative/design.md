# R2.7 设计 · AI 叙事层接入（LLM 接入）

> 本文件只补「本次实施决策 + 文件级计划 + 测试计划」。深护栏见 `packages/game-core/src/v2/narrative.ts` 既有实现（strict Zod / 证据白名单 / 三来源 / diagnostic）。编号不重排。
>
> **〔云端工程适配更正，2026-11-13〕本设计稿的实绩差异以 `docs/DECISIONS.md` ADR-0027〔事后补记〕为准**；下方 §2 与 §5 共三处按代码复核的事实更正（路由文件、事件 flavor 缓存键）已用同款标注显式留痕，起草期原文保留可追溯。

## 1. 现状盘点（阶段 0 差距报告）

| 能力 | 现状（R2.6 末） | R2.7 缺口 |
|---|---|---|
| 叙事护栏 | `narrative.ts` 已有 `NarrativeRequest`（只读、无可写状态）、`NarrativeAdapter = (req)=>unknown` 注入点、`resolveEndingNarrative` / `organizeEvaluationSummary` / `finalizeEvaluationSummary`；`EndingNarrativeOutputSchema`{title,summary,evidenceIds} 与 `EvaluationSummaryOutputSchema`{summary} 均为 **strict**；证据白名单 `allowedEvidenceIds` 防虚构事实；三来源 `template/llm/fallback` + `diagnostic`。 | LLM 路径从未接通——当前 `narrativeSource` 恒 `"template"`（无 adapter 注入）；无 provider、无路由、无回退触发。 |
| 确定性内核 | `packages/game-core` **无任何 LLM SDK / 网络调用**（AGENTS §1）。 | 真 LLM 必须落在 `apps/server`；game-core 只能保留「构造请求 + 校验候选」的纯函数。 |
| Provider | 无 `LLMProvider` 抽象；无 Mock / WorkBuddy 云端 SDK / OpenAI 兼容实现。 | 需 `LLMProvider` 接口 + 三层实现 + 服务端凭证路由。 |
| 凭证 | 无 env 注入；ADR-0025 已接 WorkBuddy 登录 + 人生档案（前端 `2991eb2`/`dee5570`），登录会话可作云端 SDK 凭证来源。 | 需三层路由：登录态→云端 SDK、env→OpenAI 兼容、无→Mock；客户端零凭证（§5）。 |
| 事件 flavor | 事件仅有模板 `summary`/`narrative` 文本，无 LLM 增强、无异步路径。 | 需新增事件 flavor 表面 + 异步生成 + 非权威缓存。 |

## 2. 实施决策（与 ADR-0027 对齐）

- **WS-P**：把「构造请求」与「校验候选」从 `narrative.ts` 抽成**导出的纯函数**（`buildEndingNarrativeRequest` / `buildEvaluationSummaryRequest` / `validateNarrativeOutput(schema, candidate, allowedEvidenceIds)`），供 `apps/server` 复用；LLM 调用只发生在 `apps/server` 的 `LLMProvider.complete`，返回候选后交给 game-core 校验。既满足 §1（game-core 不碰 LLM/网络），又保持校验单一事实来源。
- **凭证路由**：服务端持有 provider 选择逻辑——登录会话存在 ⇒ 云端 SDK（免密钥）；`LIFE_SIM_LLM_*` 齐备 ⇒ OpenAI 兼容；否则 Mock。`NarrativeAdapter` 注入点保留给纯本地/测试（同步 Mock），但生产主路径为服务端编排。
- **确定性边界**：LLM 文本明确排除在 replay 契约外；归档时把当时生成的原文作为快照存入档案（展示用），重放断言只比对状态/事件/结局/评分。
- **WS-S 事件 flavor**：异步生成，结果存**非权威服务端缓存**（起草期键 `worldId + eventInstanceId + worldTime` ⇒ **〔云端工程适配更正，2026-11-13〕** 实绩为确定性复合键 `worldId|turnIndex|worldTime|eventId|occurrenceIndex`，见 `apps/server/src/narrative/flavorCache.ts:25-33`），**不写入 `WorldStateV2`、不进 replay**；投影优先取缓存，缺失/超时取模板文案。缓存仅展示用途，状态序列化字节不受影响。
  - 更正依据：`eventInstanceId` 在代码中不存在（现有 `instanceId` 是状态层延时队列实例 `evi-<seq>`、不进玩家投影；`triggeredEvents[].id` 是事件定义 id），已由 `docs/DECISIONS.md` ADR-0027〔事后补记〕决策结果第 7 条固化。

## 3. 数据模型

### 3.1 LLMProvider（`apps/server/src/llm/provider.ts`，新）
```ts
export interface LLMProvider {
  readonly id: "mock" | "workbuddy-cloud" | "openai-compatible";
  /** 返回未校验候选；失败抛错（由编排层转 fallback） */
  complete(request: NarrativeRequest, schema: ZodTypeAny, opts?: { timeoutMs?: number }): Promise<unknown>;
}
```

### 3.2 事件 flavor 输出契约（`packages/shared/src/schema/event.ts` 或 `narrative.ts` 新增）
```ts
export const EventFlavorOutputSchema = z
  .object({ flavor: z.string().min(1) })
  .strict(); // 只允许文本；拒绝任何 state/字段写入
```

### 3.3 NarrativeRequest 扩展（`packages/game-core/src/v2/narrative.ts`）
- 新增 `buildEventFlavorRequest(eventId, context): NarrativeRequest` 变体（事件 id + 上下文事实，仍只读）；`validateNarrativeOutput` 抽为导出纯函数复用既有 strict 校验 + 证据白名单逻辑。

## 4. 接口形状

### 4.1 `apps/server/src/llm/`
- `provider.ts`：`LLMProvider` 接口 + `createLLMProvider(config, auth?): LLMProvider`（按路由决策 2 选实现）。
- `mock.ts`：返回模板化/确定性文本（dev/test 默认）。
- `workbuddyCloud.ts`：凭登录会话调 WorkBuddy 云服务 SDK 免密钥 LLM（部署/登录态默认；纯本地 dev 不可达 ⇒ 回退 Mock/OpenAI 兼容）。
- `openaiCompatible.ts`：按 `LIFE_SIM_LLM_*` 调 OpenAI 兼容端点（DeepSeek / 国产 / 本地）。

### 4.2 服务端编排（`apps/server/src/narrative/` 或现有 world 路由）
- `generateNarrative(request, schema, provider)`：调 `provider.complete` → `validateNarrativeOutput` → 成功返回 `{source:"llm", ...}`；失败/超时/虚构证据返回 `{source:"fallback", diagnostic}`。
- 结局/总结在对应路由（archive / ending / summary）同步调用；事件 flavor 在事件结算后 `fire-and-forget` 异步生成并写缓存。

### 4.3 game-core（仅抽纯函数，不引 LLM）
- 导出 `buildEndingNarrativeRequest` / `buildEvaluationSummaryRequest` / `buildEventFlavorRequest` / `validateNarrativeOutput`。
- 既有 `resolveEndingNarrative(request, adapter?)` / `finalizeEvaluationSummary(record, adapter?)` 保留（同步 adapter 路径），生产改用服务端编排。

## 5. 文件级计划

| 文件 | 改动 | 归属 |
|---|---|---|
| `apps/server/src/llm/provider.ts` | 新增 `LLMProvider` 接口 + 路由工厂 | WS-P |
| `apps/server/src/llm/{mock,workbuddyCloud,openaiCompatible}.ts` | 三层实现 | WS-P |
| `apps/server/src/narrative/generate.ts` | `generateNarrative` 编排（complete+validate+fallback） | WS-P/WS-S |
| `packages/game-core/src/v2/narrative.ts` | 抽出 `build*Request` / `validateNarrativeOutput` 为导出纯函数；新增 `buildEventFlavorRequest` | WS-P/WS-S |
| `packages/shared/src/schema/{event,narrative}.ts` | 新增 `EventFlavorOutputSchema`（strict） | WS-S |
| **〔云端工程适配更正，2026-11-13〕** `apps/server/src/index.ts`（起草期误作 `apps/server/src/v2.ts`，该文件不存在；全仓唯一路由文件，`GET /api/worlds/:id` 见 `:334-347`、监听见 `:704-705`） | 结局/总结路由接 `generateNarrative`；事件结算后异步生成 flavor | WS-S |
| `apps/server` 事件 flavor 缓存 | 非权威 `Map` 缓存（**〔云端工程适配更正，2026-11-13〕** 实绩键 `worldId\|turnIndex\|worldTime\|eventId\|occurrenceIndex`，起草期误作 `worldId+eventInstanceId+worldTime`；见 `flavorCache.ts:25-33` / ADR-0027 决策结果第 7 条），不进 `WorldStateV2` | WS-S |
| `apps/web` | 投影消费 `eventFlavor`（若存在），缺省模板文案；结局/总结 `narrativeSource` 透传 | WS-S |

> **指纹影响**：shared 增 `EventFlavorOutputSchema` 为纯新增、不改既有 schema ⇒ `schemaVersion` **不升**（旧档兼容）。`WorldStateV2` 零改动（缓存不进状态）。game-core 只抽纯函数、不新增 LLM 依赖。

## 6. 测试计划（AGENTS.md §4）

| 类 | WS-P 用例 | WS-S 用例 |
|---|---|---|
| 正常 | Mock 返回合法候选 → `source:"llm"`；OpenAI 兼容（测试用 Mock 替代真实端点）返回被校验通过 | 结局/总结 provider 可用时 `narrativeSource:"llm"`；事件 flavor 缓存被填充 |
| 边界 | 无 env 无登录态 ⇒ Mock 默认、叙事恒模板；`API_KEY` 缺失自动 Mock 不报错 | 同 seed 重放断言不比对叙事文本；存档快照含叙事原文 |
| 无效 | 非法 schema 候选 → 回退 + diagnostic；虚构 `evidenceIds` → 回退；超时 → 回退 | 事件 flavor 超时 → 模板文案、回合不阻塞；`WorldStateV2` 两次序列化字节一致 |
| 类型 | `pnpm typecheck` 0 错 | 同左 |

## 7. 风险与开放项（G6：写入 OPEN_QUESTIONS 不伪造）

- WorkBuddy 云服务 SDK 免密钥 LLM 的真实接入方式（凭 ADR-0025 登录令牌调平台端点）在 T-P2 实施时确认；纯本地 dev 不可达属预期，回退 Mock/OpenAI 兼容。
- 事件 flavor 缓存键的回放语义：缓存是非权威展示数据，明确不进 replay 契约（已在 R-LLM-03 / R-NAR-03 裁定）。
- 自由文本行动（#26）、多 Agent 运行时（#3）、流式输出：本轮 DEFERRED，不实现、不测试、不派任务。

## 8. R2.8 凭证路由落地（ADR-0028，2026-11-13）

> 与 ADR-0028 决策 1/2 对齐；纯服务端新增，不进 `packages/shared` 契约、不持久化、不改 `WorldStateV2`（非 T-2，见 ADR-0028 契约影响判定）。

### 8.1 新增服务端 API（运营接口，非 shared schema）
- `POST /api/llm-credentials`：接收 `{ apiKey: string; model: string; baseUrl?: string }`；Zod 基础校验（非空、URL 合法、字段齐全）；通过则 mint 不透明 `sessionId`（randomUUID）写入内存并 `201 { sessionId }`；失败 `400 { error:"invalid_credentials" }`。

### 8.2 内存凭证（`apps/server/src/llm/userCredentials.ts`，新）
- `Map<sessionId, { apiKey; model; baseUrl? }>`；`mint(input)` / `lookup(id)` / `clear(id)` / `clearAll()`。
- Zod 校验 `~.trim().min(1)`（防纯空白通过 `min(1)`）；`baseUrl` 可选、须合法 URL；`DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"`。
- **不落盘、不进日志、不进玩家端投影、不写仓库**（沿用 §5 底线 + `boundary.test.ts` 类密钥扫描护栏）。

### 8.3 请求级 provider 优先级（`apps/server/src/llm/provider.ts`）
- `resolveProviderForRequest(userCreds, fallback: LLMProvider): LLMProvider`：有 userCreds ⇒ `new OpenAICompatibleProvider({ baseUrl: (userCreds.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/,""), model: userCreds.model.trim(), apiKey: userCreds.apiKey.trim() })`；否则 ⇒ `fallback`（platform-keyless 或 mock）。
- Fastify `preHandler` 钩子读取 `x-life-sim-llm-session` header ⇒ `userCredentials.lookup(sid)` ⇒ 注入 `request.llmProvider`（模块增强 `FastifyRequest.llmProvider` 非空，钩子恒设）。
- 所有叙事调用点（create/get world、6 处 turn/result 路由、scheduleFlavors、archive 路由）传递 `request.llmProvider` ⇒ 实现 `user-key ＞ platform-keyless ＞ mock` 确定性优先级。

### 8.4 前端（FE-01 / FE-02，`apps/web`）
- FE-01：登录页 `<details className="card llm-config">` 可折叠 `apiKey`(password) / `model` / `baseUrl` 输入 + 保存/清除；`api.ts` 中央 `request()` 自动附 `x-life-sim-llm-session` header；凭证存内存、默认不持久化 localStorage（风险自担提示）。
- FE-02：移除 `people` tab 与 `PeopleTab`，NPC 记录归并「世界」视图 `WorldTab` 分 tab（`overview` / `npc`，复用 `NpcCard`）；纯前端布局重组，不新增投影字段（免 ADR、非 T-2）。

### 8.5 待平台确认（卡点）
- 服务端 platform-keyless 真实免密钥链路（cloud.llm server identity 注入）未证实 ⇒ `R-LLM-09` DEFERRED（#49 / ADR-0028 决策 2 ⚠️）；当前 server 侧 platform-keyless 仍是 env 注入 session 降级形态，未注入即 `LLMUnavailableError` ⇒ 回退 mock，绝不假装成功。
