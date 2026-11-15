# 重构设计（REFACTOR-DESIGN）

> **v2：按 F1–F4 + 5 分叉裁决修订**（2026-11-15 实施前最后一道设计收口；取代本文件 v1 中与之冲突的措辞）
>
> **本文件性质**：2026-11-15 21:46 用户裁决「推倒重来 / 开放设计 / 之前的 ADR 都可以不管了，只当作代码排查记录即可 / 直接按重构需求设计」后的**唯一实施依据**。
>
> - **不是** ADR、**不是**四件套（`README` / `requirements` / `design` / `tasks`）、**不做** G1/G2 常规评审、**不给** ADR 清单。本轮不写任何 ADR 正文；验收跑通后 ADR 重新计数，本文件与 `docs/DECISIONS.md`、`AGENTS.md`、`PROJECT.md`、`specs/core/GAME_RULES.md` 等旧记录一并归档。
> - `ADR-0001..0034` 及所有旧规格**仅作代码排查记录**：下文引用 `文件:行号` 是为了定位现有实现，**不构成约束**，也不产生「修订 / 推翻 / 历史归档」结论。
> - `AGENTS.md` / `PROJECT.md` / `GAME_RULES.md` 的旧措辞本轮**不改**，且**不作为实施阻碍**；不为迁就它们做妥协设计。旧措辞与新架构的张力在用户验收判定可行后统一处理。
> - 本轮只改本文件；不改代码、不改 `*.yaml`、不改其它 `docs/**`、不跑测试。
>
> **v2 变更摘要（覆盖关系，仅针对本文件 v1，不涉及旧 ADR）**：
>
> | 裁决 | 作废的 v1 措辞 | v2 落点 |
> |---|---|---|
> | **F1** | T-10「`events.yaml` 骨架化」隐含在旧模板上改 | 新建最小骨架模板 `demo-agentic`；`jjk-2006` 的 11 个 yaml 一律不动 → §10 T-10、§8.3 |
> | **F2** | T-01「game-core 现有测试全绿」/ T-08「全量测试绿」/ T-12「`pnpm test` 全绿 + 6 种子基线重录」 | 新建最小测试集为唯一验收基线，旧测试可排除 / 退休、不修、不保留双轨引擎 → §0.10、§10 T-01/T-08/T-12 |
> | **F3** | §2.2 的 `WorldStateV2.contentLayer` 落点、§8.3 的 `contentLayer` 字段、§11.2② 推荐 A | **B′**：`LlmTrace` 为叙事正文唯一持久落点，state 只持 `traceRef` / `contentRef` + 锚点 → §2.1/2.2、§8.2/8.3、§11.2② |
> | **F4** | §6.3「A 玩家端 / B LLM 上下文」双出口、§2.3 `buildLlmFacts()`、§6.1「`buildLlmContext()` 放 agent-runtime」 | 引擎统一持有的**透视窗口**（`world` / `player` / `npc:<id>`，1+1+N）+ 统一观察者知识台账 → §2.3、§4.1、§5、§6（整节重写）、§9.1、§11.1 |
> | **5 分叉** | §11.2「必须用户拍板」+ ①A / ②A / ③A / ④A / ⑤A 推荐 | §11.2 改为「已裁决」，②改判 **B′**；不再列待拍板项 |
> | **T-\*** | 13 个 `T-*` 无优先级 | 整表重发，逐条标 **P0 / P1**，T-05 / T-08 / T-09 拆 a/b → §10 |
> | **补充口径**（team-lead 只读核对） | v2 初稿「白名单 11→12」、未覆盖 `narrative` 下游债 / `tsconfig.json` include 陷阱 / `llmTriggers` 落点 | 白名单 **11→13** + 独立 loader/Zod schema + 三个「绝不」；`opening.yaml` 省略；`narrative ?? title` 三处连带改 + `tsconfig.json` exclude + `test` 扩四包；Condition DSL 复用 / `fallbackDag.edges` 明确给出 → §0.2、§3.2/3.4/3.5、§7、§10、§11.1/11.2 |
>
> **核对基线**（只读实查）：HEAD `2e4d2ec`；`pnpm-workspace.yaml` = `apps/*` + `packages/*`；`apps/server/src/store.ts:50` = `SCHEMA_VERSION = 3`；`packages/shared/src/v2.ts:335` 为 `slot: SlotScene | null`、`:322` 为 `delayQueue`、运行时无 `state.chains`；`packages/game-core/src/v2/turn.ts:683` 为 `nextTurn`、`:279` `revalidateSlot`、`:381` `settleSlotEvent`；`apps/web/src/main.tsx` 3370 行、零 `export`。模板层 `events.yaml` 有 204 条 `nextEventId`（配置层数据），与运行时状态层无链状态是两回事，勿混。

---

## 0. 设计输入（已定，原文口径，不自行补充共识）

1. **四层分工**：① 模板给故事骨架（事件模板 / 生成规则 / 世界观 / 属性 / 人物）+ 静态资源（立绘 / 差分）；② core 定最底层 RPG 通用规则（世界 / 事件 / 人物 / 行动 / 评价）；③ AI 补血肉；④ 前端可定制（低优，默认前端 + 对应 core 通用能力的 React 组件）。
2. **agentic 工具调用**（像 AINT，不用酒馆式正则 / 纯文本抽取）。**取消 workbuddy-cloud 通道**；OpenAI 兼容（用户自带 key / `LIFE_SIM_LLM_*` env）为唯一主通道；Mock 保留为零回归默认。
3. **LLM 非每轮参与**：core 主管线（单槽 `slot` + 唯一队列 `delayQueue`）**保留且仍是驱动方**；开局由 LLM 发布「任务 DAG」；轮次结算时满足条件才触发（随机 / 任务完成 / DAG 节点到期等）。**条件集合由模板或规则声明，不写死枚举**。
4. **交互方向优先 `core → llm` 回调**：core 决定何时叫、注入当前事实 + 隐秘 + 相关提示词；LLM 回程一律走 **core 提供的规范引擎 API**（`llm → core`）落账；**禁止旁路写权威状态**。
5. **事实控制全部经 core 规范 API**，暂不设字段级红线；**引擎不做自由文本语义判断**。硬不变量 = **「无 API 调用即无事实变更」**。叙事 / 记忆 / 选项 / 资源引用可在**内容层直写**（**F3**：内容层 = append-only trace / callLog，不是 `WorldStateV2` 字段）。
6. **引擎兜底按分支①**：「事实 / 逻辑错误 → 返回给 LLM 重生成」；「引擎静默处理 + 打日志」**仅作重试超限 / 不可用兜底**。重试上限、单轮 / 全局超时、token 预算见 §5.3（本设计给出具体数值与理由）。
7. **hidden 可进服务端 LLM 上下文**，玩家端投影必须继续过滤；**v1「与 `isPlayerVisible` 平行的第二出口判据」由 F4 统一透视窗口取代**：引擎 API 统一持有 `world` / `player` / `npc:<id>` 三类窗口，玩家与 NPC 共用一套观察者知识台账，按 `known` / `inferred` 投影，防止 LLM 把隐秘复述进叙事后泄露（§6.3）。
8. **回放**：尽量可回放（输入快照 / 工具调用序列），可降级为「通过调用当时的日志」重建调用链。**F3**：LLM 叙事正文只进 append-only `LlmTrace` / `callLog`，**不进 `WorldStateV2`**；存档只留 `traceRef` / `contentRef` + 锚点。现行 `schemaVersion=3`，改状态模型会再拒载一次旧档，**本次不必兼容旧档**。
9. **「core 能救就救」= 救机制与不变量**：`time.ts` / `rng.ts` / `relations.ts` / `projection.ts` / `scheduler.ts` / `battle.ts` 可复用；**不救文件原样**；`life-evaluation.ts` / `turn.ts`（1267 行）/ `narrative.ts` 允许重写。
10. **默认交付形态（主理人定，本设计不更换）**：**原地重写**——现有包内重做，不新建并行系统（不 fork 第二套引擎 / 第二套状态机 / 第二套调度器）。「能跑」= `pnpm dev` 起服务，自带 key 的真实 LLM 跑通一个完整回合、默认前端能看到 AI 叙事与立绘；`typecheck` / **新建最小测试集** / `build` 通过（**F2**：旧 shared 67 / game-core 478 例不再作为阻断项）。**F1**：验收用**新建最小骨架模板**，不改 `jjk-2006`。旧 `*.yaml` 与旧记录归档留到用户验收后，本轮不删。

### 0.1 v2 收口裁决（用户已拍板，作为并列已定输入；与 1–10 冲突处以本节为准）

- **F1｜新建模板验证**：跑通验收用**新建的最小骨架模板**（本设计定 id = `demo-agentic`），**不要改 `jjk-2006`**（其 11 个 yaml 一律不动）。
- **F2｜新建最小测试集**：验收基线是**新建的最小测试集**；旧 shared 67 / game-core 478 例**不再作为阻断项**，允许从 vitest include 排除或移入 legacy 目录，**不花人力修**；**不得为迁就旧测试保留双轨引擎**。
- **F3｜锚点落账、叙事留日志**：DAG 锚点 / 任务完成 / 权威事实 / 媒体 `assetId` 进存档；**LLM 叙事正文只进 append-only `LlmTrace` / `callLog`，不进 `WorldStateV2`**，存档只留 `traceRef` / `contentRef`。分叉点②改判 **B′ = 以 trace 日志为内容仓库、state 只持引用**。
- **F4｜引擎 API 处理可见窗口**（用户原文：「世界维度的全量给，玩家和各 npc 视角的，只给已知和推测（之前没有做 npc 视角的隐秘，制作了玩家的隐秘系统这次一起设计）」）：取消 v1「A 玩家端 / B LLM 上下文」二元出口，改为**引擎 API 统一持有的透视窗口（Perspective Window）**，`1 + 1 + N` 个；玩家与 NPC 共用**统一观察者知识台账**与 `buildFacts`。落地解释逐条见 §6.3。
- **5 分叉全部收口**（§11.2 改为「已裁决」，不再生成新的待拍板项）：① **A** 两个新包都加；② **B′** trace 日志内容仓库；③ **A** manifest 进语义指纹 / `assetFingerprint` 进信封不参与拒载 / 3 张 IP 图标 demo 占位；④ **A** 模板内置 fallback DAG；⑤ **A** 验收要档 2 可用 + 档 1 在 Mock 路径逐字段断言。

### 0.2 补充工程口径（team-lead 只读核对，已裁决，作为硬判据）

> 以下 4 条与 §0.1 并列为已定输入，写入 §3 / §7 / §10 / §11 对应章节；均为**会卡死「能跑」的工程事实**，不是待拍板项。

1. **白名单 11 → 13（不是 11 → 12）**：新最小模板需要 `rules.yaml` 与 `assets/manifest.yaml` **两个**新声明式文件，两者都必须 ① 加入 `apps/server/src/templates.ts` 的 `DECLARATIVE_FILES`；② 用**独立专用 loader + 独立 Zod schema** 解析；③ **绝不并入 `TEMPLATE_MERGE_FILES`**（现为前 8 个），也**绝不作为新顶层键塞进 `world.yaml`** —— `WorldTemplateV2Schema` 是 `.strict()`，塞进去加载期 fail-fast；而未加白名单的新文件在 `templates.ts:422` 是 **`warn + 忽略`**，服务照常起但触发 / DAG / manifest / 知识授权**全部静默失效，比 fail-fast 更危险**。→ T-06 / T-10 硬判据。
2. **`opening.yaml` 在新最小模板中省略**：缺文件时 `templates.ts:331` 返回 `[]`、`store.ts:356` 回退 `createDefaultOpeningTemplate()`，省掉 13 个必填字段与 `completionConditions.min(1)`。→ T-10。
3. **`narrative` 改可选的下游债与 typecheck 陷阱**：`EventOption.text` / `WheelSegment.label` 仍 `min(1)` 必填（Mock 文案靠它们）；`narrative` 回退值定为 **`?? title`**（不是 `""`）；`packages/shared/src/v2.ts` 的 event view `narrative: string`、`triggeredEvents[].narrative: string`、`packages/game-core/src/v2/narrative.ts` 的 `readonly narrative: string` **三处都要跟着改**，否则 `pnpm typecheck` 报错。根 `tsc --noEmit -p tsconfig.json` 覆盖 `packages/**/*.ts`，**包含 43 个旧测试文件**，F2 只排除 vitest 不够，必须在 `tsconfig.json` 加 `exclude`（建议旧测试移入 `packages/*/legacy-tests/` 并排除该目录），否则验收基线 R-01 必红；根 `package.json` 的 `test` 现仅 `--filter @life-sim/game-core`，T-12 扩到 shared / game-core / agent-runtime / rpg-ui 四包。→ T-00 / T-12 完成判据。
4. **两个小分叉同步收口**（§11.2 记为已裁决，不再列待拍板）：`rules.yaml` 的 `when` **P0 复用现行声明式 Condition DSL**（`packages/shared/src/schema/common.ts:181-192`），外面套一层开放 `ConditionRegistry` 作前向 seam，**不另立独立语法**；`fallbackDag` 的 `edges` 形状由架构侧明确给出（含无环校验方式），否则 T-02 / T-10 无法落盘。→ §3.2 / §3.4 / §3.5 / §11.2 ⑥⑦。

---

## 1. 新分层与包边界

### 1.1 裁决：原地重写 + 两个职责包（目录结构开放）

| 包 / 应用 | 重构后职责 | 依赖方向 | 处置 |
|---|---|---|---|
| `packages/shared` | **全部契约的单一真源**：世界 / 事件 / 人物 / 行动 / 评价的 schema；**新增** 工具面 schema、任务 DAG schema、trace schema、**透视窗口 / 知识台账 schema（`perspective.ts`）**、内容引用 schema、资源 manifest schema、**`rules.yaml` 独立 schema**、view model 类型、封闭诊断码枚举 | 被所有包依赖；不依赖任何包 | 保留 + 扩字段 |
| `packages/game-core` | **确定性内核**：RPG 通用规则 + **规范引擎 API（`RpgEngineAPI`）** + **透视窗口（`buildFacts`）/ 知识台账** + 触发点 / 条件求值 / DAG 校验 / 投影 / 回放重放 | → `shared`；**不依赖** React / Fastify / DB / LLM SDK / 网络 | 原地重写主管线，保留 6 个可救模块 |
| `packages/agent-runtime` **（新增）** | 有状态、非确定性编排层：`LlmGateway`、agentic 多轮循环、工具注册表、能力画像、**把 core 给的 `PerspectiveFactView` 排进 messages（不自行决定可见性）**、重试 / 预算 / 诊断、trace、`OpenAI 兼容 provider` + `Mock` | → `shared`；调用 `game-core` 的**公开 API**（不 import 其内部模块）；不写权威状态 | 新增，见 §1.2 理由 |
| `packages/rpg-ui` **（新增）** | **可导出 React 组件库** + `ViewModel` adapter，对应 core 通用能力 | → `shared`（只吃 view model，不吃 `V2Snapshot`）；不依赖 `game-core` 运行时 | 新增，见 §1.2 理由 |
| `apps/server` | **仅** HTTP 边界 + 持久化 + 应用编排接线 + **模板 loader（白名单 / 独立解析）**；把 `src/llm/`、`src/narrative/` 迁往 `agent-runtime` | → 上述 3 包 | `index.ts`（807 行单文件）瘦身；`templates.ts` / `store.ts` 原地改 |
| `apps/web` | **默认前端**：会话 / 路由 / API 客户端；UI 由 `rpg-ui` 组件拼装 | → `rpg-ui` / `shared` | 保留 app 模式，`main.tsx` 大幅瘦身 |

**「原地重写」如何兑现**：`game-core` / `shared` / `server` / `web` 四个既有目录全部保留并在其内部重做；**不**新建 `v3/`、`engine-next/`、`world2/` 之类的并行引擎目录，**不**保留旧主管线与新主管线双轨。新增的两个包是**职责分离**（把现有 `apps/server/src/llm/` + `narrative/` 与 `apps/web` 里 40 个内嵌组件抽出来），不是另起一套系统。**「是否拆包」已由分叉点 ① 裁决 A：两个新包都加**（§11.2），不再作为待拍板项；本表及其余章节按 A 落地。

### 1.2 新增两个包的理由

- **`agent-runtime` 必须独立**：agentic 循环是多轮、有网络、有超时、有 token 预算、可重试的**非确定性编排**；`game-core` 是确定性内核，两者混在一处会直接破坏「同 seed + 同输入 ⇒ 同结果」。且 `apps/server/src/index.ts` 现为 807 行单文件（`GET/POST` 全路由 + 装饰 + 归档 + flavor 调度），再塞循环会失控。放在 `apps/server/src/agent/` 也能跑，但独立包可被 QA 单独注入 Mock 测循环终止条件、且 `game-core` 只暴露稳定 API 面。
- **`rpg-ui` 必须独立**：用户要求「前端可定制 + React 组件对应 core 通用能力」。现状 `apps/web/src/main.tsx` 3370 行、`grep -c "^export"` = 0、无 `components/`、vite 为 app 模式、`tsconfig noEmit` ⇒ **不是可复用库**。可导出组件库只能以独立包形态存在（vite lib 模式或 `tsc emit declaration`）。
- **不新增第三包**：不建 `ai-core`（`docs/ARCHITECTURE.md §2` 里那个 V0.1 草案包），其功能已被 `agent-runtime` 覆盖；不建 `view-model` 包，view model 类型放 `shared` 即可（避免多一层依赖）。
- **F4 归属约束**：可见性判定**只能**在 `game-core` 窗口层；`agent-runtime` 不得自建第二套 hidden 判据。这进一步加强了「拆出独立编排包」的必要性——边界靠 `EngineApiHandle` 卡死，而不是靠纪律。

### 1.3 依赖图（单向，无环）

```
apps/web ──→ rpg-ui ──→ shared
    │                      ▲
    └──────────────────────┤
apps/server ──→ agent-runtime ──→ shared
    │                │              ▲
    │                └──(公开 API)──┤
    └────────→ game-core ──────────┘
```
`agent-runtime` **只能**经 `game-core` 的公开 `RpgEngineAPI` 落账；`game-core` **永不** import `agent-runtime`（回调通过注入的 `LlmGateway` 接口反转，见 §4.1）。`buildFacts(perspective)` 由 `game-core` 实现并拥有，`agent-runtime` 只消费其输出。

---

## 2. core 规范 API 的形状（LLM 控制事实的唯一入口）

> 以下为**接口形状草案（TypeScript 签名级），不是实现代码**。落地文件：`packages/shared/src/contract/engine-api.ts` + `perspective.ts`（类型 + Zod）+ `packages/game-core/src/api/engine-api.ts` / `api/perspective.ts`（实现）。

### 2.1 硬不变量与结构保证

**硬不变量：「无 API 调用即无事实变更」。** 保证方式不是靠纪律，而是靠结构：

1. `WorldStateV2` 的权威字段在 `game-core` 内收敛为唯一写入口 `RpgEngineAPI.dispatch()`；`turn.ts` / `engine.ts` 现有散落的 `state.flags[...] =`、`state.slot =`、`recordFire` 等写点全部改走该入口（现状排查：`engine.ts:326` `applyEffectsV2` 是 24 种 effect 的唯一执行体，`turn.ts` 有 6 处 `state.slot =` 赋值）。
2. `agent-runtime` **不持有 `WorldStateV2` 引用**：它只拿到 `EngineApiHandle`（不透明句柄 + `dispatch` / `snapshot` / `buildFacts` 三个方法），由 `apps/server` 在请求期注入。LLM 的 tool_calls 被翻译成 `ApiCall[]` 交给 `dispatch`，`agent-runtime` 无法直接赋值任何状态字段，也**无法自行决定某事实对谁可见**（`buildFacts` 由 core 产出）。
3. 内容层直写同样必须经 API（`content.*` 工具），只是**不进权威字段**——保证「所有写入都有 receipt、都可进 trace、都可回放」。**F3 补充**：内容层直写**也不进 `WorldStateV2`**；叙事正文只落 `LlmTrace`，`WorldStateV2` 只留 `traceRef` / `contentRef` 引用与锚点。

### 2.2 工具面分类（两类，映射到 LLM tools）

| 类别 | 工具（`tool.name`） | 落点 | 校验强度 | 说明 |
|---|---|---|---|---|
| **内容直写** `content.*` | `content.writeNarrative` / `content.writeMemory` / `content.writeOption` / `content.referenceAsset` / `content.writeFlavor` | **append-only `LlmTrace` / `callLog`**（`data/worlds/<worldId>.trace.jsonl`）；**`WorldStateV2` 只留 `traceRef` / `contentRef` + 媒体 `assetId` 锚点**（F3） | 结构校验 + **按 `targetPerspective` 窗口校验 `refs[]` + 可见性标记**（§6.3） | 叙事 / 记忆 / 选项文本 / 资源引用。不产生数值、时间、关系、战斗、评价变化 |
| **事实 API** `fact.*` | `fact.setAttribute` / `fact.adjustResource` / `fact.advanceTime` / `fact.setRelation` / `fact.addRelationEdge` / `fact.setFlag` / `fact.signalEvaluation` / `fact.spawnNpc` / `fact.setNpcLifecycle` / `fact.grantItem` / `fact.removeItem` / `fact.equip` / `fact.enqueueEvent` / `fact.markTaskDone` / `fact.advanceDag` / `fact.submitCombatAction` / **`fact.setKnowledge`**（F4 新增，可批量） | `WorldStateV2` 权威字段（含 `observationLedger`） | 结构 + **前置条件 / 引用完整性 / 数值边界 / 幂等 / 状态冲突** 全校验（§5.2） | 属性 / 时间 / 关系 / 战斗 / 评价 / 观察者知识等权威变更走**结构化提案**，core 校验后落账 |

- **不设字段级红线**（用户裁决）：上表是**能力清单**，不是「哪些字段禁止 AI 碰」的禁令；任何权威变更只要走 `fact.*` 且通过校验即合法。
- **工具清单本身是数据**：`ToolDescriptor[]` 由模板 / 规则声明 + 能力画像裁剪后生成（§6.2），引擎不 switch on 工具名枚举——`dispatch` 只做「查注册表 → 校验 → 执行」，`switch` 落在注册表数据里。
- `fact.signalEvaluation` 只提交**过程信号**；最终分数仍由 core 的评价规则函数计算（避免 AI 直接定分，同时不写死成禁令）。
- `fact.setKnowledge` 提交 `{ observerId, factRef, level, source }`，是**玩家与 NPC 共用**的唯一知识变更入口；LLM 可提交但必须过 §5.2 校验（引用完整性 / 状态冲突 / 可见性），引擎不对自由文本做语义判断。

### 2.3 形状草案

```ts
// packages/shared/src/contract/engine-api.ts —— 形状草案，非实现
export interface FactCall { callId: string; tool: string; args: unknown; idempotencyKey?: string }
export interface ContentCall { callId: string; tool: string; args: unknown; refs?: string[] }
export type ApiCall = FactCall | ContentCall;

export type DiagnosticCode =
  | "unknown_tool" | "invalid_arguments" | "unknown_reference"
  | "precondition_failed" | "numeric_out_of_range" | "state_conflict"
  | "visibility_violation" | "idempotency_conflict" | "budget_exceeded"
  | "timeout" | "provider_unavailable" | "retry_exhausted" | "duplicate_invocation";

export interface CallReceipt {
  callId: string;
  outcome: "accepted" | "rejected" | "deferred";
  code?: DiagnosticCode;            // 封闭枚举，无自由文本 code
  detail?: string;                  // 可诊断，不含 key / 完整隐秘原文
  changes?: Array<{ path: string; before?: unknown; after?: unknown }>; // 变更摘要，供回灌与 trace
  factsHint?: Record<string, unknown>; // 被拒时回灌给 LLM 的「当前正确事实片段」
}

export interface DispatchResult { receipts: CallReceipt[]; state: WorldStateV2 }

/** game-core 唯一权威写入口；agent-runtime 只能持有 EngineApiHandle */
export interface EngineApiHandle {
  dispatch(calls: ApiCall[], ctx: DispatchContext): DispatchResult;
  snapshot(): V2Snapshot;                                      // ≡ player 窗口（永远按知识台账投影）
  buildFacts(perspective: Perspective): PerspectiveFactView;  // 由 game-core 实现并拥有（F4）
}
export interface DispatchContext {
  invocationId: string; turnIndex: number; worldTime: number;
  perspective: Perspective;            // 本次 invocation 的观察窗口
  targetPerspective: Perspective;      // content.* 的验收窗口
  rng: Rng; calendar: CalendarAdapter; lookup: TemplateLookup; trace: TraceSink;
}
```

- **v1 作废项**：`buildLlmFacts(): LlmFactView`（不分窗口）、`snapshot()` 注释中的「出口 A」提法、以及 §6.1「`buildLlmContext()` 放 `agent-runtime`」的写法，**全部作废**。可见性是 core 的能力，不是编排层的能力。
- `snapshot()` 与 `buildFacts("player")` **同源同判据**；归档 / 人生总结 / 玩家端 API 一律等于 player 窗口，不再另立判据。
- `dispatch` 是**同步纯函数**（给定 `state` + `calls` + `ctx` ⇒ 确定 `DispatchResult`），不发起网络、不读 `Date`、不消耗主轮 RNG 之外的随机源。
- 每次 `dispatch` 前后各写一条 trace（§5.4）。「无 API 调用即无事实变更」可断言为：`dispatch([], ctx).state` 与原 `state` **逐字段相等**（T-01 / T-12 完成判据）。

### 2.4 现状排查（仅定位，不作约束）

- `packages/game-core/src/v2/engine.ts:297-326`：`EffectContextV2` + `applyEffectsV2(ctx, effects)` 已是「单一 effect 执行体」，是 `dispatch` 最好的复用基座（保留其 24 种 effect 分支，改为从 `FactCall` 转换而来）。
- `packages/game-core/src/v2/turn.ts:673-735`：`nextTurn` 三条分支（槽有 / 扫队列 / 自由行动）+ `scanDelayQueue` 全序，是保留的主驱动。
- `packages/shared/src/schema/common.ts:196-293`：`EffectSchema` 24 种封闭白名单可作为 `FactCall.args` 的 Zod 校验基座（**不再要求封闭**：新增工具只需在注册表加一项 + 一个 Zod schema）；`:181-192` 为现行声明式 Condition DSL，P0 复用（§3.4）。
- `packages/game-core/src/v2/runner-context.ts:9-26`：`RunnerContext`（rng / now / idFactory）作为 `DispatchContext` 的注入来源。
- `packages/game-core/src/v2/projection.ts:40-68`：`isPlayerVisible` + `hiddenNodeIds` 是**旧玩家单观察者**判据。F4 后**仅保留为 player 窗口的兼容别名**，不再是全局判据；`hiddenNodeIds` 布尔二分由 `observationLedger` 取代（§6.3）。

---

## 3. 任务 DAG：数据形状、生命周期、触发机制

### 3.1 定位：DAG 不是第三个调度结构

**核心裁决**：DAG 是**「何时回调 LLM + 回调带什么上下文」的声明源**，不是队列、不是槽、不是调度器。它与 `slot` / `delayQueue` 的共存规则只有三条：

1. DAG 节点**要变成游戏事件**时，经 `fact.enqueueEvent` 写入 `delayQueue`（**唯一队列**），再由既有 `nextTurn` 的 `scanDelayQueue → queueTake` 上桌占 `slot`。
2. DAG 节点**状态迁移**（ready / 完成 / 过期）本身是权威事实，经 `fact.markTaskDone` / `fact.advanceDag` 落账并进存档（**F3 的「锚点」**）。
3. DAG **不写 `slot`、不新增队列、不新增调度器**。`slot` 的写入来源仍收敛在既有引擎内部路径（`turn.ts:344-351/642-643/726/829` 那几处），建议按重构顺手收敛为单一 `assignSlot()`。

### 3.2 数据形状（草案）

```ts
// packages/shared/src/contract/task-dag.ts —— 形状草案
export interface TaskDag {
  dagId: string;
  version: number;                 // 每次修订 +1，进存档
  issuedBy: "llm" | "template";    // 开局 LLM 发布 / 模板内置 fallback（分叉④裁决 A）
  nodes: TaskNode[];
  edges: Array<{ from: string; to: string; kind: string }>; // kind 开放，不写死枚举；形状见 §3.5
}
export interface TaskNode {
  id: string;
  kind: string;                    // 开放标签（模板 / LLM 自定义），引擎不 switch
  title: string;
  status: "draft" | "active" | "ready" | "in_progress" | "completed" | "expired" | "cancelled";
  guards: Condition[];             // 前置/触发条件（声明式 AST，见 3.4）
  completion: Condition[];         // 完成条件
  due?: TimeSpec;                  // 可选到期（复用既有 TimeSpec / CalendarAdapter）
  templateRefs: string[];          // 关联模板骨架 id（事件 / 人物 / 资源）
  visibility: "public" | "hidden"; // 该节点是否对所有观察者公开
  contextHints?: string[];         // 回调时注入哪些提示词 / 事实域
}
export interface Condition {
  op: string;                      // 开放操作符，注册在 ConditionRegistry（数据）
  args: Record<string, unknown>;
}
```

- `kind` / `op` 都是**开放字符串 + 注册表数据**，不是引擎里的枚举 switch——直接兑现「条件集合由模板或规则声明，不写死枚举」。
- **补充裁决（P0 复用现行 DSL）**：`Condition` 的 P0 实现**直接复用现行声明式 Condition DSL**（`packages/shared/src/schema/common.ts:181-192` 的 `ConditionSchema` 与求值器），即 `{ op, args }` 的现行形态；`ConditionRegistry` 只作为注册新 `op` 的**前向 seam**，**不另立一套独立语法 / 解析器**。`rules.yaml` 的 `when`、DAG 的 `guards` / `completion` 三处共用同一 `ConditionSchema`（§3.4、§11.2⑥）。
- DAG 存于 `WorldStateV2.taskDag`（新增权威字段，F3 锚点之一）。
- **F4 改写**：`visibility:"hidden"` 的节点**只在 `world` 窗口全量可见**；是否进 `player` / `npc:<id>` 窗口由 `observationLedger` 的知识条目决定（§6.3），**不再用「进出口 B / 不进 V2Snapshot」这种二元出口措辞**，也**不再用全局布尔 `hiddenNodeIds` 做二分**。`snapshot()` / `buildFacts("player")` 只投影该观察者已持有的节点。

### 3.3 生命周期

```
开局（createWorld 后、首次 nextTurn 前）
  → core 发出 invocation(reason="dag.publish", perspective="world", targetPerspective="world")，
    LLM 用 fact.advanceDag 提交 TaskDag
  → dispatch 结构校验（validateDag：无环 / 节点 id 唯一 / 端点完整 / guards 可解析 / templateRefs 存在，见 §3.5）
  → 通过则落账；失败按 §5.3 重试；仍失败 / 无 key ⇒ 用模板内置 fallback DAG（分叉④ 已裁决 A）
  → dagIssued = true（进存档，避免每局重复发布）

模板加载期（独立于开局，服务启动时）
  → 同一 validateDag() 预跑 rules.yaml 的 fallbackDag（fail-fast，见 §3.5 第 6 条）

每轮结算 tail（唯一固定 hook 位，见 3.4）
  → ConditionEvaluator 求值所有 active 节点的 guards / completion / due
  → 命中的节点：
      (a) 需要 LLM 补肉 ⇒ 产出 invocation(reason=<节点声明的开放标签>, perspective/targetPerspective 由规则声明)
      (b) 需要上桌事件     ⇒ fact.enqueueEvent → delayQueue
      (c) 直接完成         ⇒ fact.markTaskDone
  → 引擎按 rules.yaml 的 knowledgeGrants[] / inferenceRules[] 给在场观察者授 known / inferred
      （走 fact.setKnowledge → dispatch，F4）
  → 全部经 dispatch 落账，回灌 receipt 给 LLM（若本次有回调）
```

### 3.4 触发机制：谁求值、条件怎么声明、与主管线怎么接

- **声明位置**：`specs/data/templates/<id>/<version>/` 内的 **`rules.yaml`（独立文件、独立 Zod schema，见 §7.1）**，内容形如「随机触发 / 任务完成 / DAG 节点到期 / 属性阈值 / 事件结算后」等**数据条目**；每条含 `when: Condition[]`、`invoke: { reason, perspective, targetPerspective, contextHints, toolProfile }`。**引擎不枚举 trigger 类型**。
- **v1「或并入 `world.yaml` 的 `llmTriggers: []` 段」作废（补充口径 1 的连带收敛）**：`WorldTemplateV2Schema` 是 `.strict()`，新增顶层键会加载期 fail-fast；用户 F1 原文「`world.yaml`（世界观 / 属性 / 人物 / `llmTriggers`）」的意图是「模板要声明触发」，**落点统一收敛到 `rules.yaml`**（仍在新最小模板内声明），`world.yaml` 只承载世界观 / 属性 / 人物等既有 schema 字段。此为架构侧对落点的收敛裁决，不改变用户意图（详见交付回报）。
- **`when` 的 Condition DSL（补充裁决）**：**P0 复用现行声明式 Condition DSL**（`packages/shared/src/schema/common.ts:181-192`），**不另立独立语法**；`ConditionRegistry` 仅作前向 seam（注册新 `op` 的扩展点），P0 不启用自定义语法解析器。这样 T-02 可直接复用现行求值逻辑，`rules.yaml` 的 `when` 与 DAG 的 `guards` / `completion` 三处同构。
- **F4 数据条目**：`rules.yaml` 另含 `knowledgeGrants[]` / `inferenceRules[]` 两类**数据条目**——前者声明「某事件结算时给哪些在场观察者授 `known`」，后者声明「满足何种事实组合时授 `inferred`」。引擎在结算时按条目自动调 `fact.setKnowledge`，**不对自由文本做语义判断**；条目是数据，引擎不 switch on 具体规则 id。
- **求值者**：`game-core` 的 `ConditionEvaluator`（纯函数），在**轮次结算 tail** 的固定 hook 位调用，输入 `state + lookup + rng 派生流`，输出 `TriggeredRule[]`。LLM 不参与求值。
- **随机触发**走独立派生流（`deriveTurnSeed(seed + 37, ...)` 的既有先例，见 `turn.ts` 扫描流），**不扰动主轮 RNG**，保证确定性。
- **与主管线的接线**：hook 位在 `nextTurn` 之前的结算 tail（现状 `turn.ts:939-940` 附近），产出的 `invocation` 交给 `LlmGateway` 异步执行；**回合推进本身不等待 LLM**——core 先把本轮确定性结果落账并返回，回调以「待办」形态挂起（`pendingInvocation`），由服务端编排在响应前 / 下一次请求时补齐（§4.3 时序）。
- **触发稀疏性**：`rules.yaml` 默认给 2–3 条低频繁触发（如「章节推进」「任务完成」），明确不写「每轮触发」；这是「LLM 非每轮参与」的落地保证。

### 3.5 `fallbackDag` 落盘形状与无环校验（补充裁决，必须明确给出）

**落盘位置**：`specs/data/templates/demo-agentic/1.0.0/rules.yaml` 的顶层 `fallbackDag:` 键。**不进 `WorldTemplateV2Schema`**——`rules.yaml` 是独立文件、独立 Zod schema（§7.1），因此不受 `.strict()` 约束。

**形状**（与 §3.2 `TaskDag` 同构，`issuedBy: "template"`）：

```yaml
# specs/data/templates/demo-agentic/1.0.0/rules.yaml（片段）
llmTriggers:
  - when: [{ op: "nodeCompleted", args: { nodeId: "n1.awaken" } }]
    invoke:
      reason: "chapter.advance"
      perspective: "player"
      targetPerspective: "player"
      contextHints: ["chapter.tone"]
      toolProfile: "narrative"
toolProfile:
  narrative: ["content.writeNarrative", "content.referenceAsset", "fact.enqueueEvent"]
knowledgeGrants:
  - when: [{ op: "eventResolved", args: { eventId: "evt:trial" } }]
    grant: { observers: ["player"], factRefs: ["fact:trial-result"], level: "known", source: "witness" }
inferenceRules:
  - when: [{ op: "flagSet", args: { flag: "suspicion" } }]
    grant: { observers: ["npc:rival"], factRefs: ["fact:hidden-motive"], level: "inferred", source: "inferred" }
fallbackDag:
  dagId: "demo-agentic.fallback.v1"
  version: 1
  issuedBy: "template"
  nodes:
    - id: "n1.awaken"
      kind: "opening"
      title: "苏醒"
      status: "ready"
      guards: []
      completion: [{ op: "always", args: {} }]
      templateRefs: ["evt:awaken"]
      visibility: "public"
    - id: "n2.trial"
      kind: "trial"
      title: "初次试炼"
      status: "draft"
      guards: [{ op: "nodeCompleted", args: { nodeId: "n1.awaken" } }]
      completion: [{ op: "always", args: {} }]
      templateRefs: ["evt:trial"]
      visibility: "public"
    - id: "n3.hiddenSeed"
      kind: "secret"
      title: "未公开的线索"
      status: "draft"
      guards: [{ op: "nodeCompleted", args: { nodeId: "n2.trial" } }]
      completion: []
      templateRefs: []
      visibility: "hidden"
  edges:
    - { from: "n1.awaken", to: "n2.trial",      kind: "unlocks" }
    - { from: "n2.trial",  to: "n3.hiddenSeed", kind: "unlocks" }
```

**`edges` 形状（明确定义）**：`Array<{ from: NodeId; to: NodeId; kind: string }>`。

- `from` / `to` 必须是 `nodes[].id` 内的**字符串 id**（不用数组下标、不用时间戳、不用外部 ref）。
- `kind` 是**开放字符串标签**（`unlocks` / `requires` / `blocks` / `reveals` 等由模板自定）；**引擎不 switch on `kind`**，只把 `edges` 当有向图用于「无环校验」与节点 `ready` 推导；`kind` 的语义解释留给 `ConditionRegistry` / 模板，符合「条件集合不写死枚举」。
- 与 §3.2 `TaskDag.edges` **同一形状**：LLM 发布的 DAG 与模板 fallback DAG 走**同一个校验器**。

**无环校验方式（`game-core` 的 `validateDag(dag)`，纯函数，`O(V+E)`）**：

| 步 | 检查 | 失败码 | 类别 |
|---|---|---|---|
| 1 | 端点完整性：所有 `edges.from` / `edges.to` ∈ `nodes[].id` 集合 | `unknown_reference`（`factsHint` 给出悬空端点） | RETRYABLE |
| 2 | 节点 id 唯一：`nodes[].id` 无重复 | `state_conflict` | RETRYABLE |
| 3 | 自环：`from === to` 直接拒 | `state_conflict` | RETRYABLE |
| 4 | 重复边：同一 `(from, to, kind)` 三元组多次出现（不静默去重） | `state_conflict` | RETRYABLE |
| 5 | **Kahn 拓扑排序**：邻接表 + 入度表，反复取出入度 0 节点；出队数 `< nodes.length` ⇒ 存在环 | `state_conflict`（`factsHint` 回灌环上剩余节点 id 列表） | RETRYABLE |
| 6 | guards 可解析（`op` 在 `ConditionRegistry` 内）、`templateRefs` 在 lookup 内 | `unknown_reference` | RETRYABLE |

- **两处生效、一份实现**：① **加载期**对模板 `fallbackDag` 预跑 `validateDag()`（fail-fast，服务不起则立刻可见，不会被 `templates.ts:422` 静默吞掉）；② **运行期** `fact.advanceDag` 提交 LLM DAG 时由 `dispatch` 第 2 层跑同一 `validateDag()`。两处共用 `validateDag()`，**不写两份**。
- **为什么必须写死形状**：T-02（`ConditionEvaluator` 需按 `edges` 推导 `ready`）与 T-10（模板落盘）各写一份形状会漂移；明确给出后二者只消费同一 `TaskDagSchema`（`shared`，T-00 产出）。

---

## 4. `core → llm` 回调与 `llm → core` API 的双向协议

### 4.1 `core → llm`：回调（依赖反转）

```ts
// packages/shared/src/contract/llm-invocation.ts —— 形状草案
export interface LlmInvocation {
  invocationId: string;            // 确定性派生：worldId|turnIndex|seq（禁 Date/random）
  reason: string;                  // 开放标签，来自 rules.yaml / DAG 节点
  context: LlmContext;             // §6.1 分层上下文；facts 段由 core 的 buildFacts() 产出
  perspective: Perspective;        // 【F4 新增】决定 LLM 看得到什么窗口
  targetPerspective: Perspective;  // 【F4 新增】决定 content.* 按哪个窗口验收
  tools: ToolDescriptor[];         // 按能力画像裁剪后的工具子集
  budget: LlmBudget;               // §5.3
  replyTo: "dispatch";             // 硬编码：回程只能走 dispatch
}
/** game-core 定义的端口；由 apps/server 注入 agent-runtime 实现，game-core 不 import 它 */
export interface LlmGateway {
  invoke(inv: LlmInvocation): Promise<LlmOutcome>;
}
export type LlmOutcome =
  | { kind: "committed"; traceRef: string; contentWrites: number }
  | { kind: "fallback"; code: DiagnosticCode; traceRef: string }
  | { kind: "deferred"; reason: string };   // 预算/超时，留待下一次请求补
```

- `perspective` / `targetPerspective` 取值：
  - 全知叙事者 / 开局 `dag.publish` ⇒ `perspective="world"`，全量权威事实 + 全部隐秘 + hidden DAG 节点 + 全部观察者知识台账；`targetPerspective` 视内容去向而定（写「世界内部记录」可为 `world`，写面向玩家的叙事应为 `player`）。
  - 玩家侧叙事 ⇒ `perspective="player"`、`targetPerspective="player"`。
  - NPC 对白 / NPC 自主行动 ⇒ `perspective="npc:<id>"`、`targetPerspective="npc:<id>"`（或按规则声明写向 `player`）。
- `TurnPipelineConfig`（现状 `turn.ts:765-768` 仅 2 个字段）扩展为注入位：`{ endingConfig?, evaluationConfig?, gateway?, conditionRegistry?, toolRegistry?, trace?, budget? }`。**不传 `gateway` 时行为与今天逐字段一致**（零回归默认，Mock 路径）。
- core **决定何时叫**（触发求值的结果）、**注入什么**（`context.facts` 由 core 用 `buildFacts(inv.perspective)` 产出，`world` 窗口含全量隐秘、`player`/`npc` 窗口只含 `known`/`inferred`）；agent-runtime 只负责「怎么调模型」与「把 `PerspectiveFactView` 排进 messages」，**不自行决定可见性**。

### 4.2 `llm → core`：回程一律走 dispatch

LLM 通过 OpenAI 兼容 `tool_calls` 返回若干 `ApiCall`。`agent-runtime` **不落账、不改 state**，只做：

```
tool_calls → Zod 结构校验（第 1 层）→ 组装 ApiCall[] → engineApi.dispatch(calls, ctx)
           → 第 2 层按 ctx.targetPerspective 校验 content.* 的 refs[]（F4）
           → CallReceipt[] → 作为 tool_result 回灌 LLM（多轮循环）
```

**禁止旁路**：`agent-runtime` 无 `WorldStateV2` 引用、无 `store.save` 权限、无 `applyEffectsV2` import；由 T-03 加一条源码守卫测试断言这三个禁项（类似现状 `boundary.test.ts` 的做法，但作为新设计，不引用旧约束）。**F4 追加第四条禁项**：`agent-runtime` 不得出现自己的 hidden 过滤 / 可见性判据，只消费 core 的 `PerspectiveFactView`。

### 4.3 agentic 多轮工具循环与终止条件

```
invoke(inv):
  messages = [stablePrefix, turnSegment(inv.context)]        // §6.1；facts 段已是 core 投影后的视图
  for round in 1..budget.maxToolRounds:
      rsp = provider.chat(messages, tools=inv.tools, response_format 不强制,
                          timeout=budget.perCallTimeoutMs)
      if rsp 无 tool_calls 或含 content.submit ⇒ exit("final")
      calls = parseToolCalls(rsp)                            // 结构化解析，非正则
      receipts = engineApi.dispatch(calls, ctx)             // 第 2 层校验（含窗口校验）
      if 有 RETRYABLE receipt:
          retryBudget-- ; 若 > 0 ⇒ messages += [tool_result(receipts, 带 factsHint)] ; continue
          else ⇒ exit("fallback", code="retry_exhausted")
      if 有 FATAL receipt:
          messages += [tool_result(receipts)] ; continue      // 不消耗重试，让 LLM 改
      messages += [tool_result(receipts)]                    // 全 accepted，继续补内容
  exit("fallback", code="budget_exceeded")
```

**终止条件（封闭集合，7 条不变）**：

| # | 条件 | 出口 |
|---|---|---|
| 1 | LLM 返回无 `tool_calls` 的收尾 / 显式 `content.submit` | `committed` |
| 2 | `round > maxToolRounds` | `fallback(budget_exceeded)` |
| 3 | 单次调用 `> perCallTimeoutMs` 或 invocation `> invocationTimeoutMs` | `fallback(timeout)` |
| 4 | 累计 token `> maxTotalTokens` 或单轮输入 `> maxInputTokens` | `fallback(budget_exceeded)` |
| 5 | RETRYABLE 重试次数耗尽 | `fallback(retry_exhausted)` |
| 6 | provider 非 2xx / 网络错误 / 无有效 key | `fallback(provider_unavailable)` |
| 7 | 一回合 `turnLlmBudgetMs` 用尽 | `deferred`（下一次请求续） |

**任一 fallback 都不得阻塞回合推进**：core 已先落账确定性结果并给玩家返回模板文案 / 已有内容层文本；trace 记一条结构化记录（§5.4）。这正是用户「引擎静默处理 + 打日志仅作兜底」的落地。

**时序关键点**：core 主管线**不 await LLM**。回合响应先返回确定性快照；若本轮有 invocation，标记为 `deferred` 并在 `V2Snapshot` 给一个 `llmPending?: boolean`，服务端在同一请求内尽力 `await` 补齐（真实 LLM 可用时），补不上就留待下一次请求 / 轮询。这样「自带 key 的真实 LLM 跑通一个完整回合」可接受（一次 `pnpm dev` 往返内补齐），而「无 key / 超时」时零回归。

---

## 5. 两层校验、重试回路、封闭诊断码、日志契约

### 5.1 第 1 层（结构层，`agent-runtime` + `shared`）

- `tool_calls` 参数按工具注册表的 Zod schema **strict** 校验（拒额外字段）。
- 未知工具 / 未在本次能力画像内挂载的工具 ⇒ `unknown_tool`（FATAL）。
- `content.*` 的 `refs[]` 仅做**结构性**校验：必须是合法的事实引用 id、格式正确、且在本 invocation 声明的引用集内 ⇒ 否则 `unknown_reference`（RETRYABLE）。**F4：是否「越窗」不由第 1 层判定**——第 1 层看不到 `observationLedger`，也不得自行判断可见性；窗口校验下沉到第 2 层。
- 输出是**结构化 tool_calls**，不做正则 / 纯文本抽取（兑现「像 AINT，不用酒馆式」）。

### 5.2 第 2 层（规则层 + 窗口层，`game-core` 的 `dispatch`）

| 校验 | 内容 | 失败码 | 类别 |
|---|---|---|---|
| 前置条件 | 引用的 NPC / item / event / task 存在且状态允许（如给已退场 NPC 加关系） | `precondition_failed` | RETRYABLE |
| 引用完整性 | `templateRefs` / `assetId` / `eventId` / `factRef` / **DAG `edges.from/to`** 在 lookup / manifest / 知识台账 / 节点集内 | `unknown_reference` | RETRYABLE |
| 数值边界 | 属性 / 资源 / 时间增量在模板声明区间内，时间不倒流（**但见 §8.4 R3 seam**） | `numeric_out_of_range` | RETRYABLE |
| 状态冲突 | 与当前 state 不一致（重复完成同一节点、对已终止世界写状态、对同一 `factRef` 重复授互斥 `level`、**DAG 有环 / 自环 / 重复边 / id 重复**） | `state_conflict` | RETRYABLE |
| 幂等 | 同 `idempotencyKey` 重复提交 | `idempotency_conflict` | FATAL |
| **可见性（F4 改写）** | `content.*` 的 `refs[]` 引用了 **`ctx.targetPerspective` 窗口之外**的 fact（该观察者在 `observationLedger` 中未持有，或仅 `inferred` 却被断言为真） | `visibility_violation` | RETRYABLE |
| 结构 | 参数 Zod 失败 / 未知工具 | `invalid_arguments` / `unknown_tool` | FATAL |

- **F4 归属**：本表**全部**在 `game-core` 实现；`visibility_violation` 由 core 窗口层按 `buildFacts(ctx.targetPerspective)` 产出的允许引用集判定，带 `factsHint`（当前窗口内可引用的正确事实片段）回灌重生成（分支①）。`agent-runtime` 只搬运 receipt，**不做任何语义或可见性判断**。
- **DAG 校验**：`fact.advanceDag` 走 §3.5 的 `validateDag()`（同一函数，加载期预跑 fallbackDag 亦同）。
- 「引擎不做自由文本语义判断」不变：`visibility_violation` 判的是**结构化 `refs[]` 与窗口内 fact 集合的集合关系**，不是文本里有没有出现某个词。

### 5.3 错误分流、重试回路与**具体数值 + 理由**

| 分流 | 处理 | 是否消耗重试 |
|---|---|---|
| **RETRYABLE（事实 / 逻辑错误 / 窗口越界 / DAG 有环）** | **分支①**：把 `CallReceipt`（含 `code` + `factsHint` 当前正确事实片段）作为 `tool_result` **返回给 LLM 重生成**，不静默吞掉 | 是 |
| **FATAL（schema / 越权 / 幂等）** | 原样回灌让 LLM 改，不重生成整轮 | 否 |
| **兜底（重试超限 / 超时 / 不可用 / 预算耗尽）** | **静默处理 + 打日志**：丢弃本次会话未 commit 的产出、回退模板文案、写 trace、回合继续 | — |

| 参数 | 数值 | 理由 |
|---|---|---|
| `maxToolRounds` | **6** | 一次 invocation 典型路径 = 读上下文 → 1–2 个 `fact.*` → 2–3 个 `content.*` → `submit`，约 3 轮；6 留一倍余量。超过 6 轮基本是模型原地打转，边际收益≈0 而成本线性上涨 |
| RETRYABLE 重试上限 | **2**（共 3 次尝试） | 第一次被拒后带 `factsHint` 改正的成功率最高；第三次仍错说明上下文缺信息而非随机抖动，再试无益，转兜底 |
| `perCallTimeoutMs` | **20 000** | OpenAI 兼容单轮带 tool 定义典型 3–8s；20s 覆盖慢模型 / 长上下文，又不让玩家干等（现状 provider 默认 8000ms 偏紧） |
| `invocationTimeoutMs` | **90 000** | 6 轮 × 20s 理论上限 120s；取 90s 作硬闸，正常路径不会跑满 |
| `turnLlmBudgetMs` | **120 000** | 一回合最多 1 次稀疏回调，留 30s 给投影 / 落盘 / 响应；超出转 `deferred` |
| `maxInputTokens` | **8 000** | 稳定前缀 ~1.5k + 事实（按窗口投影后）~1.5k + 隐秘（仅 world 窗口）~0.5k + 裁剪后工具 schema ~2k + 滚动窗口 ~2k + 余量 0.5k |
| `maxOutputTokens` | **2 000** / 单次调用 | 一次 tool_calls + 一段叙事足够；防模型输出长篇自由文本 |
| `maxTotalTokens` | **24 000** / invocation | 多轮累计上限；典型一次 ≈ 8k in + 3k out ≈ 11k，留一倍余量 |
| 滚动窗口 `recentTurns` | **最近 6 轮** | 覆盖短期因果，又不超过输入预算 |

**成本 sanity check**：稀疏触发（每 10–20 回合 1 次）下，一局约 30–50 回合计 2–5 次 invocation ≈ 30k–60k tokens/局，用户自带 key 自担，可接受。

### 5.4 日志与 trace 契约

- **`LlmTrace` 是叙事正文的唯一持久落点（F3）**：append-only `data/worlds/<worldId>.trace.jsonl`，与存档同 `LIFE_SIM_DATA_DIR`。每条：
  `{ invocationId, turnIndex, worldTime, reason, perspective, targetPerspective, contextHash, toolProfile, callsHash, receipts[], diagnostics[], inputTokens, outputTokens, latencyMs, outcome, fallbackCode?, templateRef, contentBlocks? }`
- **`contentBlocks`（F3×F4 咬合，见 §6.3 / §8.2）**：每条内容直写除正文外，必须带 `{ blockId, targetPerspective, refs[], visibility, maskText? }` 元数据。这使「投影期确定性掩码」在**不把正文写进 state** 的前提下仍可实现——读回端点按请求者窗口过滤 / 掩码后再下发。
- **绝不记**：`apiKey` / `session` / `token` / 完整隐秘原文 / 完整 prompt；隐秘只记结构化引用 id 与 hash。
- 两级：① 服务端可诊断日志（含 code + detail，供排障）；② 存档 trace（供回放与取证）。两者都**不进玩家端投影**。
- `DiagnosticCode` 是**封闭枚举**（§2.3 已列 13 个），无自由文本 code；新增诊断须改 `shared` 契约（单写者，§10）。

---

## 6. 上下文工程与统一透视窗口（Perspective Window）

> **本节为 v2 整节重写**：v1「hidden 双出口隔离（A 玩家端 / B LLM 上下文）」被 F4 取代。出口不是两个，而是引擎 API 统一持有的 **1 + 1 + N** 个透视窗口；玩家与 NPC 共用一套知识台账与 `buildFacts`。

### 6.1 `LlmContext` 分层组装（前缀稳定）

```
[1] stablePrefix   —— 世界观骨架摘要 + 能力画像 + 工具 schema + 输出契约
                       ★ 字节稳定：不含 turnIndex / worldTime / 随机 / 队列长度
                       ★ 命中 provider prefix cache；同一模板跨回合、跨局复用
[2] facts          —— 由 core 的 buildFacts(inv.perspective) 产出的 PerspectiveFactView
                       （world 窗口：全量权威事实 + 全部隐秘 + hidden DAG 节点 + 全部台账；
                        player / npc:<id> 窗口：仅该观察者 known / inferred 事实，
                        inferred 条目带显式标记，不得断言为真）
[3] secrets        —— 仅 world 窗口 invocation 才有的隐秘段：
                       显式包裹 <DO_NOT_REVEAL> 标记 + 结构化引用 id（不给原文）
[4] recentTurns    —— 最近 6 轮滚动窗口（叙事摘要 + 已发生事实，不含未来队列）
[5] invocationReason / contextHints —— 本次触发原因（开放标签）
```

- **F4 归属裁决（作废 v1 写法）**：`buildLlmContext()` 放在 `agent-runtime` 的写法**作废**；`agent-runtime` 只做「把 core 给的 `PerspectiveFactView` 排进 messages」，**不自行决定可见性**、`[2]`/`[3]` 段不得由编排层裁剪或补齐。`inv.context.facts` 在 core 构造 `LlmInvocation` 时即已按 `inv.perspective` 投影完毕。
- 现状 system prompt 是固定一句「只能输出严格 JSON…」（`openaiCompatible.ts:63`）、user 消息是 `JSON.stringify(request)` 整体（`openaiCompatible.ts:65`）⇒ 任何字段变化都破坏前缀；重构后把易变部分全部后置到 `[2]-[5]`。
- `[1]` 的顺序、序列化方式固定（键排序 + 无时间戳），保证跨调用逐字节一致。

### 6.2 能力画像（按需挂载）

- `CapabilityProfile` 由**当前 DAG 节点 `kind` / 玩家阶段 / `rules.yaml` 的 `toolProfile` 声明**三者决定，输出「本次可用工具子集」。
- 例：开局 `dag.publish` 只挂 `fact.advanceDag`（+ `fact.setKnowledge` 若需初始化台账）；叙事节点挂 `content.*` + `fact.enqueueEvent`；战斗节点挂 `fact.submitCombatAction`；结算节点挂 `fact.signalEvaluation`。
- 收益：降 token（工具 schema 不全集下发）、降误用（LLM 不会在叙事节点调数值工具）、天然对齐「按需挂载」。
- 画像表是**数据**（`rules.yaml` / 模板），引擎不 switch on `kind`。

### 6.3 统一透视窗口与观察者知识台账（取代 v1 双出口）

**6.3.1 窗口定义（1 + 1 + N）**

| 窗口 | 内容 | 消费者 | 依据 |
|---|---|---|---|
| **`world`** | 世界维度**全量**：权威事实 + 全部隐秘 + hidden DAG 节点 + **全部观察者知识台账** | 引擎内部求值；**全知叙事者 / 开局 DAG 发布**这类 LLM invocation | 兑现用户「世界维度的全量给」与「hidden 可进服务端 LLM 上下文」 |
| **`player`** | 只含该玩家 `known` / `inferred` 事实（`inferred` 带显式标记，不得断言为真） | **玩家端 API 投影、归档、人生总结一律等于此窗口** | 兑现「玩家视角只给已知和推测」 |
| **`npc:<id>`** | 每个 NPC 一份，同样只含 `known` / `inferred` | NPC 对白 / NPC 自主行动的 LLM invocation、前端 NPC 视图 | 兑现「之前只做了玩家隐秘系统，这次 NPC 视角一起设计」 |

- 三个/多类窗口由 `game-core` 的 **同一套 `buildFacts(perspective)` + 同一份知识台账**实现，**不做两套代码**。
- `snapshot(): V2Snapshot` ≡ `buildFacts("player")` 的投影结果；归档 / 人生总结不再另立判据。
- `isPlayerVisible`（`projection.ts:40-68`）**若保留只作为 player 窗口的兼容别名**，不再是全局判据；`isMaskedEnding` / `decorateEndingView` / `projectArchiveForPlayer` 三处统一改为「按 player 窗口投影」。

**6.3.2 统一观察者知识台账**

```ts
// packages/shared/src/contract/perspective.ts —— 形状草案
export type ObserverId  = "player" | `npc:${string}`;
export type Perspective = "world" | "player" | `npc:${string}`;

export interface KnowledgeEntry {
  factRef: string;                                   // 结构化事实引用 id
  level: "known" | "inferred";                      // inferred 不得断言为真
  source: "witness" | "told" | "inferred" | "llm" | "rule";
  sinceTurn: number;
  confidence?: number;
}
export type ObservationLedger = Record<ObserverId, KnowledgeEntry[]>;

export interface PerspectiveFactView {
  perspective: Perspective;
  facts: Array<{
    factRef: string;
    value: unknown;
    level?: "known" | "inferred";                   // world 窗口无 level 约束
  }>;
  dagNodes?: Array<{ nodeId: string; status: string }>;  // 按窗口过滤后的节点
  ledger?: ObservationLedger;                     // 仅 world 窗口含全部观察者台账
}
```

- 落点：`WorldStateV2.observationLedger`（§8.3 破坏面字段清单之一）。
- **未被某观察者持有的 fact 即为该观察者的 hidden**；**不再用布尔 `hiddenNodeIds` 做全局二分**（v1 的全局 hidden 标记作废）。
- NPC 视角隐秘系统与玩家**共用同一套台账与 `buildFacts`**，只是 `ObserverId` 不同。

**6.3.3 知识变更只能走 dispatch**

- 新增 `fact.setKnowledge({ observerId, factRef, level, source })`（**可批量**），与其余 `fact.*` 同等校验（§5.2）。
- 引擎按 `rules.yaml` 的 **`knowledgeGrants[]` / `inferenceRules[]` 数据条目**在事件结算时自动给在场观察者授 `known`、按推断规则授 `inferred`；**引擎不对自由文本做语义判断**，只看结构化条件。
- LLM 也可经 `fact.setKnowledge` 提交，但需过校验（引用完整性 / 状态冲突 / 不能给别的观察者凭空授 `known` 越权）；失败按 RETRYABLE 回灌。

**6.3.4 `EngineApiHandle` 与 `LlmInvocation` 的相应形状**

- `EngineApiHandle`：`dispatch(calls, ctx)` / `snapshot(): V2Snapshot`（≡ player 窗口）/ `buildFacts(perspective: Perspective): PerspectiveFactView`（**由 `game-core` 实现并拥有**）。见 §2.3。
- `LlmInvocation` 增 `perspective: Perspective`（决定 LLM 看得到什么）与 `targetPerspective: Perspective`（决定它写出来的 `content.*` 按哪个窗口验收）。见 §4.1。

**6.3.5 泄露防线（归属从 agent-runtime 移到 core 窗口层）**

1. `content.*` 落内容层时，**`dispatch` 第 2 层**按 `ctx.targetPerspective` 窗口校验 `refs[]`：引用目标窗口之外的 fact ⇒ **`visibility_violation`（RETRYABLE，带 `factsHint` 回灌重生成，分支①）**。
2. 「**结构化引用 id + 显式标记 + 投影期确定性掩码**」作为实现手段**保留**（v1 §6.3 的 1–4 条），但**归属从 `agent-runtime` 移到 `game-core` 窗口层**：隐秘在 world 窗口以「引用 id + 掩码文案」给（如 `secret:suko-na-plan → "某未公开的计划"`），不给原文；LLM 若要提及只能调 `content.writeNarrative({ text, refs: ["secret:..."] })`。
3. 内容块带 `targetPerspective` / `refs[]` / `visibility` 元数据存入 `LlmTrace`（§5.4）；`GET /api/worlds/:id/narrative?fromTurn=` 读回时经 **core 窗口层按请求者 perspective 掩码**后下发（§8.2）。这是 F3（正文不入 state）与 F4（窗口掩码）的**咬合点**：正文可以不在 state，但掩码判据必须随正文一起留在 trace。
4. 「引擎不做自由文本语义判断」不变：掩码判的是结构化元数据与窗口集合关系，不是文本 NLP / 正则。
5. **F3×F4 接缝（实施必须守住，非硬冲突）**：`world` 窗口 invocation 产出的内容若 `targetPerspective="world"`，该内容块**默认不进 player 投影**；只有 `targetPerspective` 命中请求者窗口才下发。这保证「全量给全知叙事者」不会绕过 player 窗口泄露。

**6.3.6 T-05 断言（由两条改三条）**

1. `world` 窗口**含隐秘**（全量权威事实 + hidden DAG 节点 + 全部台账）。
2. `player` 与 `npc:<id>` 窗口**均不含隐秘原文**（只含各自 `known` / `inferred`）。
3. **故意把隐秘写进面向 `player` 的叙事**被 `visibility_violation` 拦下并掩码（含归档 / 人生档案 / narrative 端点三处读回路径）。

> 彻底杜绝「模型凭记忆背出原文」超出结构化掩码能力，登记为 §11.1 R2 残留风险；不引入语义 NLP / 酒馆式正则。

---

## 7. 静态资源链路

现状排查：`specs/data/templates/jjk-2006/1.0.0/assets/characters/` 有 3 张 PNG（`gojo-satoru-kaigyoku-{bust,full,portrait}.png`，未跟踪）；`templates.ts:47-59` 白名单 11 个 yaml、`:83-102` `FORBIDDEN_ASSET_EXTS` 含 `.svg/.html`、`:462-466` 语义指纹只 hash 白名单 yaml、`scanAssets`（`:270`）产出 `assetCount`/`assetFingerprint` 仅诊断；`GET /api/templates`（`index.ts:345`）只给 `assetCount`；`index.ts:777-786` 的 MIME 表只服务 `web/dist` SPA 托管，**不是**资源端点；schema 零媒体字段、前端零 `<img>`。

**补充实查（team-lead 需求侧只读核对，写进硬判据）**：`templates.ts` 另有 `TEMPLATE_MERGE_FILES`（现为白名单**前 8 个**），只这 8 个被合并进 `WorldTemplateV2Schema`；该 schema 为 **`.strict()`**，任何新顶层键（把 `rules` / `assets` / `llmTriggers` 塞进 `world.yaml`）都会加载期 fail-fast。**未在白名单内的新文件在 `templates.ts:422` 是 `warn + 忽略`** —— 服务照常启动，但触发 / DAG / manifest / 知识授权**全部静默失效，比 fail-fast 更危险**。缺 `opening.yaml` 时 `templates.ts:331` 返回 `[]`、`store.ts:356` 回退 `createDefaultOpeningTemplate()`。

### 7.1 manifest 与 `rules.yaml`：白名单 11 → 13

- **白名单 11 → 13（补充口径，不是 11 → 12）**：新最小模板需要 **`rules.yaml` 与 `assets/manifest.yaml` 两个**新声明式文件，二者都必须加入 `apps/server/src/templates.ts` 的 `DECLARATIVE_FILES`（相对路径条目）。因此白名单从 11 项变为 **13 项**，语义指纹 = **13 个白名单文件**；二进制 PNG **不进**语义指纹。
- **独立解析（硬约束）**：两个新文件各自使用**独立专用 loader + 独立 Zod schema** 解析（`RulesSchema` / `AssetManifestSchema`），产出独立对象供触发求值 / 知识授权 / 选图工具消费。
- **三个「绝不」**：
  1. **绝不并入 `TEMPLATE_MERGE_FILES`**（现为前 8 个）——它们不是 `WorldTemplateV2` 的组成片段；
  2. **绝不作为新顶层键塞进 `world.yaml`**——`WorldTemplateV2Schema` 是 `.strict()`，塞进去加载期 fail-fast；
  3. **绝不留白名单之外**——`templates.ts:422` 的 `warn + 忽略` 会让触发 / DAG / manifest / 知识授权静默失效，比 fail-fast 更危险，故 T-06 / T-10 必须有「两文件都被加载」的**显式断言**。
- 模板目录新增 `assets/manifest.yaml`，字段：
  `{ assets: [{ assetId, path, kind: "portrait|diff|cg|bgm", tags[], characterRef?, visibility, license?, credit? }] }`
- `assetId` 是**稳定标识**；LLM 选图工具只接 `assetId`，**不接路径 / URL**（防路径穿越、防外链）。
- `license` / `credit` 字段为版权登记位；现有 3 张为 IP 素材（五条悟 / 怀玉篇），**已裁决 A：标注为 demo 占位**（分叉③），正式发布前需用户单独确认授权（§11.1 R6）。
- **F1**：本轮 `manifest.yaml` 与 `rules.yaml` 随**新建的 `demo-agentic` 模板**落 `specs/data/templates/demo-agentic/1.0.0/`；`jjk-2006` 的 11 个 yaml **一律不动**。

### 7.2 下发端点

- 新增 `GET /api/templates/:id/:version/assets/:assetId`：`assetId → manifest 查表 → 拼路径`（**不接受客户端路径**），校验扩展名白名单（`.png/.jpg/.jpeg/.webp`，`.svg/.html` 继续禁——即便有端点也不接受可脚本化格式）、`Content-Type` 映射、`Cache-Control`、越界路径拒绝 403。
- `GET /api/templates` 的 `TemplateVersionSummary`（`templates.ts:740-765`）在 `assetCount`/`assetFingerprint` 之外**下发 assetId 列表 + kind + characterRef**（仍不下发二进制）。

### 7.3 模型选图工具与指纹口径（**已裁决 A**）

- `content.referenceAsset({ assetId, slot, alt })`：工具描述里带本次能力画像允许的 `assetId[]`（从 manifest 生成），LLM 只能从中选；`slot` 为开放标签（如 `portrait.main` / `cg.chapterEnd`）。
- `fact` 侧不提供改图工具（资源是内容，不是权威事实）；**F3**：媒体引用的 `assetId` 作为**锚点**进存档，正文 / 二进制不进 `WorldStateV2`。
- **指纹口径（分叉③ 已裁决 A）**：`semanticFingerprint` = **13 个白名单文件**（含 `rules.yaml` 与 `assets/manifest.yaml`）；`assetFingerprint` 记入**存档信封**作为「展示完整性锚」但**不参与拒载**（缺失 / 变化 ⇒ 立绘降级，世界仍可载）。理由：让「模拟可载性」与「展示完整性」解耦，改图不打断玩家存档；又让 trace 能定位「当时展示的是哪版资源」。v1 的备选 B/C 不再保留为待选项。

### 7.4 前端渲染位

- `V2Snapshot` 新增 `media?: Array<{ slot, assetId, url, alt }>`（url 为 `/api/templates/.../assets/:assetId` 相对路径，前端 `BASE=""` 现状可直接用）。
- `rpg-ui` 提供 `<Portrait assetId>` / `<CgStage media>` 组件；默认前端在事件舞台与人物页渲染；`content.referenceAsset` 写入经 **player 窗口投影**后落到 `media`。

---

## 8. 回放与存档

### 8.1 三层回放输入与「可回放」定义

现状排查：`ReplaySpec`（`replay.ts:14-20`）= `{ seed, playerName, worldId, template, commands[] }`，`commands` 由调用方传入，`replay()` 纯函数重建；`WorldStateV2` 无 `rngState` / `inputLog`；`rng.ts:19-24` 无状态重推导。

重构后 `ReplaySpec` 扩为三档输入，**优先级从高到低**：

| 档 | 输入 | 回放语义 | 确定性 |
|---|---|---|---|
| 1 **输入快照 + 工具调用序列** | **`commands[]` + `llmTrace[]`**（`llmTrace` 每次 invocation 的 `ApiCall[]` + receipts + **叙事正文 `contentBlocks`**，F3） | `replay()` **不再调 LLM**，按 trace 重放 `engineApi.dispatch()` | **逐字段可复现**（同 seed + 同输入 + 同 trace ⇒ 同结果） |
| 2 **调用当时的日志**（降级） | `commands[]` + `callLog[]`（含 prompt hash / 响应摘要 / 时序） | 重建「当时发生了什么」的调用链，供取证与人工复核 | 可追溯，**不承诺**逐字段复现 |
| 3 **仅命令序列** | `commands[]` | LLM 相关轮次按模板 fallback 重放 | 权威层可复现，内容层退化为模板 |

- 档 1 是「尽量可回放」的目标；档 2 是用户允许的「降级为通过调用当时的日志达成可回放」。
- **分叉⑤ 已裁决 A**：验收要求「**档 2 可用 + 档 1 在 Mock 路径通过逐字段断言**」；真实 LLM 的档 1 逐字段复现列为尽力目标、不作阻断。
- **F3 关键**：`llmTrace` 现在**含叙事正文**（v1 档 1 只重放 `dispatch`，正文若在 state 则由 state 带；现在正文只在 trace，故档 1 必须带 `llmTrace[]` 才能逐字段复现内容读回结果）。

### 8.2 trace 留存范围与叙事读回端点

- **F3：`LlmTrace`（`data/worlds/<worldId>.trace.jsonl`，append-only）是叙事正文的唯一持久落点**；`WorldStateV2` 不存正文，只留 `traceRef` / `contentRef` + 锚点（DAG 节点状态、任务完成、媒体 `assetId`、权威事实、`observationLedger`）。
- 留存：§5.4 的 `LlmTrace` 全量 append-only + 每次 `dispatch` 的 `CallReceipt[]` + 内容块（带 `targetPerspective` / `refs[]` / `visibility` / `maskText` 元数据）。
- 不留存：`apiKey` / `session` / 完整隐秘原文 / 完整 prompt 正文（只留 hash + 结构化引用）。
- 位置：`data/worlds/<worldId>.trace.jsonl`（与存档同目录，随 `worldStore.delete` 清理）。**不落到 v1 分叉②-C 的「刷新即丢」**。
- **读回端点（F3 必须）**：新增 **`GET /api/worlds/:id/narrative?fromTurn=`**，从 trace 读回内容块，按 `turnIndex >= fromTurn` 过滤，经 **core 窗口层按请求者 perspective 掩码 / 过滤**后返回 `ContentBlockVM[]`。保证**刷新后 AI 叙事不消失**，且刷新路径与首次响应路径共用同一套窗口判据（F4）。默认前端 `<NarrativeStream>` 消费此端点。

### 8.3 存档与 `schemaVersion`

- `SCHEMA_VERSION` `3 → 4`（`store.ts:50`，**保留 v1 判断**）。
- **破坏面字段清单（严格按 F3 裁决改写）**：`WorldStateV2` 新增 **`observationLedger` / `taskDag` / `pendingInvocation?` / `media?` / `traceRef`**；**删掉 v1 的 `contentLayer`**。`ReplaySpec` 扩展；信封新增 **`traceRef?` / `contentRef?`（`contentRef` 为 trace 内叙事段定位锚，不承载正文）/ `assetFingerprint?`（分叉③ A，不参与拒载）**。
- **本次不必兼容旧档**：不做迁移 / 回填 / 版本推断分支；加载期遇 `schemaVersion !== 4` 走既有封闭拒载码 `envelope_schema_version_unsupported`，世界列表仍可见 + 可删（沿用 `store.ts:67-93` 的诊断结构，仅作实现参考）。
- 交付说明里写明「线上已发布 app 的旧档在本次重构中将再次被拒载」（这是第二次；第一次是 `2→3`），用户已裁决不必兼容。
- **F1**：验收用新建 `demo-agentic` 模板，其语义指纹为**全新值**（白名单 13 文件口径下），与旧模板无关；`jjk-2006` 的 11 个 yaml 不动，故不存在「改旧模板触发指纹变化」的问题。

### 8.4 R3 前向兼容 seam（本设计的硬约束）

三个预留点不得封死：① 事件实例标识（`ScheduledEventInstance.instanceId`）；② `TimeAdapter`（`time.ts:50-88`，Date-free、负分钟回溯）；③ 可见性投影（**§6.3 透视窗口 / 知识台账**，v1「双出口」提法作废）。

具体：
- `dispatch` 的 `numeric_out_of_range` **不因「时间单调不减」而把回拨判死**——时间倒流校验只在当前非 R3 模式下启用，且做成可注入的 `TimePolicy`，不写死进 `ConditionRegistry`。
- trace / 缓存键 / 内容层 id **不使用单调时间戳作为唯一排序依据**：用 `turnIndex + invocationSeq + callId`（复合键），避免回拨后键冲突。F3 下 trace 块 id 同样用复合键。
- `observationLedger` 的 `sinceTurn` 用 `turnIndex`（复合键语义），不用墙钟时间；R3 回溯时知识授予可按 `turnIndex` 重算，不封死。
- `scanDelayQueue` 的「`start > now` 即停」优化在 R3 下需降级为 `continue + 重排`；本轮保留该 seam 注记，**不实施** R3。

---

## 9. 前端默认实现与可复用 React 组件包

### 9.1 `packages/rpg-ui`（新增，可导出）

- 形态：vite **lib 模式** + `index.ts` 全量 `export`；`tsconfig` 从 `noEmit` 改为 emit `d.ts`；props **只吃 `ViewModel`，不吃 `V2Snapshot`**。
- 组件集（对应 core 通用能力，开放增删）：

| 组件 | 对应 core 能力 | 主要 props（view model） | 优先级 |
|---|---|---|---|
| `<WorldClock>` | `time.ts` | `formattedTime`, `lifeStageLabel`, `storyChapter?` | P0 最小集 |
| `<CharacterSheet>` | 属性 / 资源 / 装备 | `PlayerVM`, `EquipmentSlotVM[]` | P1 完整集 |
| `<EventStage>` | `slot` / `slotEvent` | `SlotSceneVM`（含 options / wheel / battle 三态） | P0 最小集 |
| `<ActionBar>` | `availableActions` | `ActionVM[]` | P0 最小集 |
| `<EvaluationPanel>` | `life-evaluation.ts` | `EvaluationVM` | P1 完整集 |
| `<RelationGraph>` | `relations.ts` | `NpcVM[]`, `RelationVM[]` | P1 完整集 |
| `<BattleBoard>` | `battle.ts` | `BattleVM`, `commands` | P1 完整集 |
| `<NarrativeStream>` | 内容层（trace 读回） | `ContentBlockVM[]`（经 **player 窗口**过滤 / 掩码） | **P0（验收可见 AI 叙事）** |
| `<Portrait>` / `<CgStage>` | 静态资源 | `MediaVM[]` | **P0（验收可见立绘）** |
| `<TaskDagView>` | DAG 的**player 窗口可见**节点 | `TaskNodeVM[]`（hidden 节点不下发） | **P1** |

- 主题：CSS 变量（替换现状单文件全局暗色 `style.css` 的硬编码），支持定制前端覆盖。
- **P1 明确不做为「能跑」前置**：完整 rpg-ui 组件集、`TaskDagView`、SSE 流式正文 / 分支重写（§10 T-09b、§11.1 R9）。

### 9.2 view model 契约

- `packages/shared/src/contract/view-model.ts` 定义 `ViewModel` 及 `PlayerVM` / `SlotSceneVM` / `EvaluationVM` / `MediaVM` / `ContentBlockVM` 等类型（Zod + `z.infer`）。
- `toViewModel(snapshot: V2Snapshot): ViewModel` 作为**单一 adapter**，放在 `rpg-ui`（或 `shared` 的纯函数模块）。
- **定制前端的两条路**：① 换组件但复用 adapter；② 换 adapter 直接吃 `V2Snapshot`。两条都不要求理解引擎内部状态。

### 9.3 默认前端 `apps/web`

- 保留 vite app 模式；`main.tsx`（3370 行）瘦身为「会话 / 路由 / API 客户端 + 组件拼装」。
- `api.ts` 增 `llmPending` / `media` / **`GET /api/worlds/:id/narrative?fromTurn=`** 消费；保留 GET / 409 刷新合并的既有形态（仅作实现参考）。
- 验收可见：AI 叙事（`<NarrativeStream>`，从 trace 读回）+ 立绘（`<Portrait>`）在默认前端出现，**刷新后叙事不消失**（F3 读回端点）。

---

## 10. 可执行的实施任务拆分（`T-*` 序列，v2 重发，逐条标 P0 / P1）

> **写者纪律（强制，v2 保持）**：`packages/**`（`shared` / `game-core` / `agent-runtime` / `rpg-ui`）**必须单写者、串行**——契约面由一个人一处改，避免并行写冲突与双真源。`apps/**` 可分派不同写者，但都**依赖** `packages/**` 对应 T 完成；`specs/data/**`（新建模板与 manifest）由**独立写者**负责，与 `packages/**` 不交叉。**根 `tsconfig.json` / `package.json` 由内核单写者一并改**（不属 `apps/**`，不可并行）；旧测试移入 `packages/*/legacy-tests/` 属 `packages/**`，同单写者。
> 「由谁做」按工种标注，主理人据此派活：`内核` = game-core/shared 单写者；`运行时` = agent-runtime + server；`前端` = rpg-ui + web；`QA` = 验证；`需求` = 模板数据 / 验收口径；`主理人` = 验收。
> **P0 = 能跑必需；P1 = 用户验收「跑通」后再补**。每个 `T-*` 的完成判据都是**可判定**的（能红、能重复、红了能指认哪一层）。
> **F2 纪律**：不得为迁就旧 shared 67 / game-core 478 例保留双轨引擎；旧测试允许从 vitest include 排除或移入 legacy 目录，**不要求修复**；**F2 补充**：仅排 vitest 不够，根 `tsconfig.json` 必须 `exclude` 旧测试（见 T-00 / T-12）。

| # | P | 任务 | 改动文件（落点） | 由谁做 | 完成判据 | 前置 |
|---|---|---|---|---|---|---|
| **T-00** | **P0** | 契约先行：全部新 schema + 诊断码 + 端口类型 + **`Perspective` / `KnowledgeEntry` / `ObservationLedger` / `traceRef`** + `narrative` 改可选的下游债 + **`tsconfig.json` exclude** | `packages/shared/src/contract/{engine-api,perspective,task-dag,llm-invocation,trace,content-ref,asset-manifest,rules,view-model}.ts`（新/改）；`packages/shared/src/index.ts` 导出；`schema/event.ts`（`narrative` 必填→可选，F1 配套）；`schema/common.ts` EffectSchema 扩注册位；`packages/shared/src/v2.ts`（event view / `triggeredEvents[].narrative`）；`packages/game-core/src/v2/narrative.ts`（`readonly narrative`）；**根 `tsconfig.json`**（`exclude`）；旧测试移入 `packages/*/legacy-tests/` | **内核（单写者）** | `typecheck` 0 错；`DiagnosticCode` 为封闭联合且被 `CallReceipt` 引用；`EngineApiHandle` 含 `buildFacts(perspective)`；`LlmInvocation` 含 `perspective` / `targetPerspective`；`Perspective` / `KnowledgeEntry` / `traceRef` 可被 game-core 与 rpg-ui import；`toViewModel` 类型可 import；**`narrative` 回退值统一 `?? title`（不是 `""`）**，`EventOption.text` / `WheelSegment.label` 保持 `min(1)` 必填（Mock 文案靠它们），`shared/src/v2.ts` 的 event view `narrative: string` 与 `triggeredEvents[].narrative: string`、`game-core/src/v2/narrative.ts` 的 `readonly narrative: string` **三处连带改完**；**根 `tsconfig.json` 加 `exclude`（旧测试移入 `packages/*/legacy-tests/` 并排除该目录），`pnpm typecheck` 0 错且 43 个旧测试文件不被 `tsc --noEmit -p tsconfig.json` 覆盖**（否则验收基线 R-01 必红）；`TaskDagSchema` / `RulesSchema` / `AssetManifestSchema` 三者可 import | — |
| **T-01** | **P0** | 收敛权威写入口 `RpgEngineAPI.dispatch` + **`buildFacts` 窗口实现 + `observationLedger` + `fact.setKnowledge`**；保留 6 个可救模块 | `packages/game-core/src/api/{engine-api,perspective}.ts`（新）；`v2/engine.ts`（`applyEffectsV2` 改为从 `FactCall` 转换，保留 24 分支）；`v2/turn.ts`（6 处 `state.slot =` 收敛为 `assignSlot()`）；`index.ts` 导出；**保留** `time.ts` / `rng.ts` / `relations.ts` / `scheduler.ts` / `battle.ts` 原样，`projection.ts` 的 `isPlayerVisible` 降为 player 窗口兼容别名 | **内核（单写者）** | **硬不变量断言**：`dispatch([], ctx).state` 与原 state 逐字段相等 + 全仓 `WorldStateV2` 权威字段赋值只出现在 `api/engine-api.ts`（源码守卫）；`buildFacts("world")` 含全量隐秘与台账；`fact.setKnowledge` 批量落账可回溯；**不要求旧 game-core 测试全绿（F2）** | T-00 |
| **T-02** | **P0** | 触发点 + `ConditionEvaluator` + DAG 生命周期 + **`validateDag()`** + 知识授予规则 + 保留主管线驱动 | `v2/turn.ts`（结算 tail 加唯一 hook 位，`nextTurn` 三条分支不动）；`v2/condition-evaluator.ts`（新，**复用 `common.ts:181-192` 的 Condition DSL**，`ConditionRegistry` 仅作前向 seam）；`v2/task-dag.ts`（新，`validateDag()`，§3.5 六步）；`v2/knowledge-grants.ts`（新，按 `rules.yaml` 条目调 `fact.setKnowledge`）；`runner-context.ts`（`DispatchContext` 注入 `perspective` / `targetPerspective`）；`TurnPipelineConfig` 扩展注入位 | **内核（单写者）** | `rules.yaml` 写 2 条触发条件 + 1 条 `knowledgeGrants` / `inferenceRules` 即可被求值；**`when` / `guards` / `completion` 复用现行 Condition DSL（`common.ts:181-192`），`ConditionRegistry` 仅作前向 seam、不另立语法（源码守卫）**；「每轮触发」不写死；随机触发走 `+37` 派生流且同 seed 两次结果一致；**`fallbackDag` 按 §3.5 形状落盘且加载期 `validateDag()` 无环校验通过；`fact.advanceDag` 提交 LLM DAG 走同一 `validateDag()`（含环 / 自环 / 重复边 / 悬空端点 ⇒ `state_conflict` 或 `unknown_reference`，RETRYABLE 带 `factsHint`）**；`slot` 仍只有既有来源、`delayQueue` 仍是唯一队列（结构断言）；未传 `gateway` 时与改前逐字段一致 | T-01 |
| **T-03** | **P0** | `agent-runtime` 骨架：provider 单一主通道 + 工具注册表 + 端口反转 | `packages/agent-runtime/`（新包，`package.json` / `index.ts`）；`apps/server/src/llm/` 迁入并**删除 `workbuddyCloud.ts`**；`provider.ts` 只保留 `openai-compatible` + `mock`；`openaiCompatible.ts` 增 `tools` / `tool_calls` 解析（结构化，非正则）；`tool-registry.ts`；`pnpm-workspace.yaml` 无需改（`packages/*` 已覆盖） | **运行时** | 真实 key 的 OpenAI 兼容端点能返回 `tool_calls` 并被解析为 `ApiCall[]`；无 key 时 `mock` 零回归（不发起网络）；`agent-runtime` 源码不含 `WorldStateV2` / `store.save` / `applyEffectsV2` import，**且不含自建可见性 / hidden 判据**（F4，共四条源码守卫）；`typecheck` 0 错 | T-00 |
| **T-04** | **P0** | agentic 多轮循环 + 重试 / 预算 / 诊断 + **`LlmTrace` 作为叙事正文唯一持久落点** | `packages/agent-runtime/src/{loop,budget,diagnostics,trace}.ts`；`apps/server/src/narrative/` 迁入并重写（`generate.ts` / `flavorCache.ts` 由 trace 内容块替代）；`LlmTrace` 每条带 `contentBlocks{ blockId, targetPerspective, refs[], visibility, maskText? }` | **运行时** | §4.3 七个终止条件各有单测（注入 Mock provider）；RETRYABLE 带 `factsHint` 回灌、2 次后转 fallback；超时 / 预算 / 不可用均**不阻塞**且写 trace；13 个诊断码全覆盖；**`WorldStateV2` 中不出现任何叙事正文字段**（源码 + 结构断言，F3）；不传 `gateway` 时零回归 | T-01, T-03 |
| **T-05a** | **P0** | **core 透视窗口与 NPC 知识台账**（内核先） | `packages/game-core/src/api/perspective.ts`（`buildFacts` 三/多类窗口 + `observationLedger` 读写）；`v2/projection.ts` / `archive.ts` / `index.ts` 装饰 / 归档 / 人生档案三处统一按 player 窗口投影 | **内核（单写者）** | **三条独立断言**：① `world` 窗口含隐秘（全量事实 + hidden DAG 节点 + 全部台账）；② `player` 与 `npc:<id>` 窗口均不含隐秘原文；③ 故意把隐秘写进面向 `player` 的叙事被 `visibility_violation` 拦下并掩码（含归档 / 档案三路径）；NPC 与玩家共用同一套台账与 `buildFacts`（结构断言） | T-01, T-02 |
| **T-05b** | **P0** | **agent-runtime 上下文组装**（只把 core 的 `PerspectiveFactView` 排进 messages，不自行决定可见性） | `packages/agent-runtime/src/{context,capability}.ts`（`visibility.ts` v1 独立判据**删除**）；`agent-runtime` 消费 `inv.context.facts` | **运行时** | `[1] stablePrefix` 跨回合逐字节相同（哈希断言）；能力画像按 `rules.yaml` 的 `toolProfile` 裁剪工具集；`[2] facts` / `[3] secrets` 段**直接来自 core 投影结果**、编排层不增删裁剪（源码守卫）；`world` / `player` / `npc` 三种 invocation 注入的 facts 段互不相同 | T-05a, T-04 |
| **T-06** | **P0** | 静态资源链路（**分叉③ A 已裁决**）：**白名单 11→13** + 独立 loader + 端点 + `<Portrait>` | `specs/data/templates/demo-agentic/1.0.0/assets/manifest.yaml`（**独立写者，与 T-10 同模板**）；`apps/server/src/templates.ts`（**白名单 11→13**、`rules.yaml` / `assets/manifest.yaml` 各自独立 loader + 独立 Zod schema、manifest 与 rules 进语义指纹、`scanAssets` 读 manifest）；`apps/server/src/index.ts`（新 `GET .../assets/:assetId`）；`packages/shared/src/contract/asset-manifest.ts`；`V2Snapshot.media?`；`rpg-ui/src/Portrait.tsx` | **运行时 + 内核（`media` 字段）+ 前端（Portrait）+ 需求（manifest 内容）** | **白名单 11→13（不是 11→12）**：`rules.yaml` 与 `assets/manifest.yaml` 两项都进 `DECLARATIVE_FILES`、各自独立 loader + 独立 Zod schema；**断言二者均被加载（非 `templates.ts:422` 的 `warn + 忽略` 静默失效）**；**结构断言二者不在 `TEMPLATE_MERGE_FILES`、且未作为新顶层键塞进 `world.yaml`**（`.strict()` 会 fail-fast）；语义指纹 = **13** 个白名单文件；端点按 `assetId` 查表下发 PNG 且 403 拒绝任意路径 / `.svg`；`GET /api/templates` 下发 assetId 列表；`content.referenceAsset` 只能选清单内 id；`assetFingerprint` 写入信封但**不参与拒载**；3 张 IP 图标标 demo 占位 | T-00 |
| **T-07** | **P0** | 回放与存档 `3 → 4`（F3） | `packages/game-core/src/v2/replay.ts`（`ReplaySpec` 扩 `llmTrace?` / `callLog?`，档 1 trace 重放 `dispatch` 且带叙事正文）；`apps/server/src/store.ts`（`SCHEMA_VERSION=4`、信封 `traceRef?` / `contentRef?` / `assetFingerprint?`、不做旧档迁移）；`packages/shared/src/v2.ts` / `v2-state.ts`（`observationLedger` / `taskDag` / `pendingInvocation?` / `media?` / `traceRef`，**无 `contentLayer`**）；`apps/server/src/index.ts`（新增 `GET /api/worlds/:id/narrative?fromTurn=`） | **内核（单写者）+ 运行时（store / 端点）** | 档 1：同 seed + 同 `commands[]` + 同 `llmTrace[]` 回放**逐字段相等**且**不发起网络**；档 2：callLog 可重建调用链；`schemaVersion!==4` 走封闭拒载码且世界列表可见可删；**narrative 端点刷新后 AI 叙事不消失且按 player 窗口掩码**；state 结构断言无正文字段 | T-01, T-04, T-05a |
| **T-08a** | **P0** | **`life-evaluation.ts` 模板化到「新最小模板能跑评价」** + `narrative.ts` 最小改造为 `ContentSink`（写 trace，不写 state） | `v2/life-evaluation.ts`（去硬编码维度 id / `history.id.includes("-c-")` / `summary.includes("败北")` / jjk 标定，改 `EvaluationConfig` 由模板驱动）；`v2/narrative.ts`（`ContentSink` + 结构校验器，正文落 `LlmTrace`） | **内核（单写者）** | `demo-agentic` 模板用**自定义维度集**能算出评价且不改引擎代码（换维度集用例）；`WorldStateV2` 无叙事正文；`typecheck` 0 错；**不要求旧 game-core 全量测试绿（F2）** | T-02, T-10 |
| **T-09a** | **P0** | `rpg-ui` **最小可导出** + view model + 默认前端改造（能看到 AI 叙事与立绘） | `packages/rpg-ui/`（新包，lib 模式 + `index.ts` 全导出 + `toViewModel`）；最小集组件 `<EventStage>` / `<ActionBar>` / `<WorldClock>` / `<NarrativeStream>` / `<Portrait>`；`apps/web/src/main.tsx` 瘦身 + `api.ts` 增 `media` / `llmPending` / `narrative?fromTurn=` 消费 | **前端** | `import { EventStage, Portrait, NarrativeStream } from "@life-sim/rpg-ui"` 可用；组件 props 零 `V2Snapshot` 引用（源码守卫）；`pnpm --filter @life-sim/web build` 通过；`pnpm dev` 默认前端能渲染 `<NarrativeStream>` 与 `<Portrait>`，刷新后叙事仍在 | T-00, T-06, T-07 |
| **T-10** | **P0** | **新建最小骨架模板 `demo-agentic`（F1）** | `specs/data/templates/demo-agentic/1.0.0/`（全新目录）：`world.yaml`（**仅世界观 / 属性 / 人物等既有 schema 字段；不新增 `llmTriggers` 等顶层键**——触发声明统一收敛到 `rules.yaml`）、`rules.yaml`（2–3 条低频触发 + `toolProfile` + `knowledgeGrants[]` / `inferenceRules[]` + **§3.5 形状的 `fallbackDag`**）、少量事件模板（`narrative` 可选，回退 `?? title`）、`assets/manifest.yaml`（≥1 张立绘，复用 3 张 Gojo PNG 或占位图，标 demo 占位）、**`opening.yaml` 明确省略** | **需求 + 独立写者（`specs/data/**`）+ 内核（schema 侧 T-00 已支持）** | 加载期 fail-fast 通过；**两个新声明式文件（`rules.yaml` / `assets/manifest.yaml`）都在白名单内且被独立 loader 成功加载（非 `warn + 忽略` 静默失效）**；`world.yaml` 无新顶层键、`.strict()` 不 fail-fast；**省略 `opening.yaml`**（`templates.ts:331` 返回 `[]`、`store.ts:356` 回退 `createDefaultOpeningTemplate()`，省掉 13 个必填字段与 `completionConditions.min(1)`）；**`fallbackDag` 按 §3.5 形状且加载期 `validateDag()` 无环校验通过**；无 key / Mock 下用 fallback DAG 仍能完整跑通一局；模板语义指纹为**全新值**、与旧模板无关；**`jjk-2006` 的 11 个 yaml 逐字节未变**（diff 断言） | T-00, T-02 |
| **T-11** | **P0** | 接线 + 端到端「能跑」 | `apps/server/src/index.ts`（注入 `LlmGateway`、回合 `deferred` 补齐、装饰 / 归档统一走 `dispatch`）；`apps/web` 会话态 | **运行时 + 前端** | **`pnpm dev` 起服务，自带 key 的真实 LLM 跑通一个完整回合**（开局发布 DAG → 至少一次触发 → tool_calls → dispatch 落账 → trace 叙事 → 前端看到 AI 叙事与立绘）；无 key 时零回归 | 全部 P0 |
| **T-12** | **P0** | **新建最小测试集 + 验证（F2，唯一验收基线）** | 全仓（新建 `tests/minimal/**` 或各包 `*.minimal.test.ts`；vitest include 可排除旧测试 / 移入 `legacy/`）；**根 `package.json`**（`test` 扩四包） | **QA + 主理人** | 六条全覆盖：① `dispatch([], ctx).state` 逐字段相等 + 源码守卫；② tool_calls 结构化解析 + 循环 7 个终止条件；③ world/player/npc 三窗口 + 故意泄露被拦；④ 新模板下 Mock 零 key 一局可跑；⑤ 档 1 逐字段回放（Mock 路径）；⑥ `typecheck` 0 错 / `web build` 通过 / `pnpm dev` 起服务。**补充硬判据**：根 `tsconfig.json` 的 `exclude` 生效（43 个旧测试文件不进 `tsc --noEmit -p tsconfig.json`）；根 `package.json` 的 `test` 由仅 `--filter @life-sim/game-core` **扩到 shared / game-core / agent-runtime / rpg-ui 四包**。**明确**：旧测试不修、不阻断，不得保留双轨引擎 | T-11 |
| **T-08b** | **P1** | **1267 行主管线全量拆分** + `narrative.ts` 完整重写 | `v2/turn.ts`（按职责拆 `turn/{pipeline,slot,settle,triggers,projection}.ts`，保留 `nextTurn` / `revalidateSlot` / `settleSlotEvent` seam）；`v2/narrative.ts` 完整 `ContentSink` | **内核（单写者）** | 拆分后 `pnpm dev` 一局逐字段一致（Mock 路径）；`typecheck` 0 错；新最小测试集全绿 | T-02, T-07, T-08a |
| **T-09b** | **P1** | 完整 `rpg-ui` 组件集 + `TaskDagView` + SSE / 分支重写 | `packages/rpg-ui/src/**`（`CharacterSheet` / `EvaluationPanel` / `RelationGraph` / `BattleBoard` / `CgStage` / `TaskDagView`）；`apps/web` SSE 流式正文 / 分支重写 | **前端** | 组件全导出、`d.ts` 可 emit；`TaskDagView` 只下发 player 窗口可见节点；SSE 正文经窗口掩码 | T-09a |

**共 16 个 `T-*` 条目**（主编号 `T-00 … T-12` 保留；`T-05` / `T-08` / `T-09` 各拆 a/b）。**14 个 P0 + 2 个 P1**。

**P0 关键路径（派活顺序）**：
```
T-00 → T-01 → ┬→ T-02 ────────────────────────┬→ T-10 → T-08a ─┐
              ├→ T-05a（内核先，插在 T-04 之前）│                  │
              └→ T-03 → T-04 ──────────────────┼→ T-07 ──────────┤
                         └→ T-05b ──────────────┘                  │
              T-06（依赖 T-00，rules/manifest 与 T-10 同模板）──────┤
                                                                    ↓
                          T-09a → T-11 → T-12
```
- `packages/**` 全程由**同一单写者**按 `T-00 / T-01 / T-02 / T-05a / T-07 / T-08a` 顺序串行推进（T-05b 的 `agent-runtime` 部分、`T-03/T-04` 属运行时写者，与内核写者以 `T-00` 契约为界）。**T-00 内含根 `tsconfig.json` / `package.json` 的改动与旧测试迁移，同属单写者，不可并行分派。**
- `apps/**` 可并行；`specs/data/**`（T-06 manifest / T-10 模板）由**独立写者**负责，与 `packages/**` 不交叉。
- `T-08b` / `T-09b` 为 **P1**，用户验收「跑通」后再派，不进 P0 关键路径。

---

## 11. 风险与已裁决的分叉点

### 11.1 风险登记（架构侧已给缓解，不需用户拍板）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **不同 OpenAI 兼容 provider 的 `tool_calls` 能力参差**（部分国产 / 本地端点不支持或格式偏差） | `provider` 层做能力探测 + 结构化解析容错；不支持 `tool_calls` 的端点退化为「单次结构化 JSON + Zod 校验」（**仍是结构化，不是正则抽文本**）；完全不可用 ⇒ `fallback(provider_unavailable)` + 模板文案，回合不中断 |
| R2 | **LLM 凭记忆把隐秘原文背进叙事**（超出结构化掩码能力） | §6.3 已把隐秘改为「结构化引用 id + 掩码文案」并按 `targetPerspective` 窗口校验 `refs[]`（`visibility_violation` 回灌）；残留风险登记，验收时以 T-05a「故意注入」用例验证；**不引入语义 NLP** |
| R3 | **agentic 多轮延迟 / token 成本** | §5.3 全套硬预算 + 稀疏触发 + 稳定前缀命中 cache + 能力画像裁剪工具集；`deferred` 保证回合不被拖死 |
| R4 | **`schemaVersion 3→4` 再次拒载线上已发布 app 旧档** | 用户已裁决「本次不必兼容旧档」；交付说明显式写明（这是第二次拒载，第一次是 2→3） |
| R5 | **「无 API 调用即无事实变更」被旁路**（有人图省事直接写 state） | T-01 源码守卫测试 + `agent-runtime` 不持有 state 引用 + 逐字段相等断言 |
| R6 | **静态资源版权 / 授权**（现有 3 张为 IP 素材） | manifest 加 `license`/`credit`；**分叉③ 已裁决 A**：本轮标注 demo 占位、不对外分发正式资源；正式发布前用户单独确认授权，不绑技术口径 |
| R7 | **任务 DAG 由 LLM 发布 → 可能出环 / 引用不存在的模板 id / 条件不可解析** | §3.5 `validateDag()`（端点完整性 / id 唯一 / 自环 / 重复边 / Kahn 拓扑排序 / guards 可解析）；失败走 RETRYABLE 回灌，超限用**模板内置 fallback DAG**（分叉④ 已裁决 A）；加载期预跑同一校验器 |
| R8 | **`turn.ts` 1267 行拆分引发回归** | 拆分列为 **P1（T-08b）**，不进「能跑」关键路径；保留 `nextTurn` / `revalidateSlot` / `settleSlotEvent` 三处 seam；Mock 零回归路径逐字段对比（**不重录旧 6 种子 playthrough 基线，F2**） |
| R9 | **SSE 流式正文 / 分支重写 / 完整组件集 / `TaskDagView` 未做** | 用户明确前端低优；列为 **P1（T-09b）**，不在「能跑」验收范围 |
| R10 | **F3×F4 接缝：正文不在 state，投影期掩码可能失去判据** | §5.4 规定 trace 内容块必须带 `targetPerspective` / `refs[]` / `visibility` / `maskText`；§8.2 `GET /api/worlds/:id/narrative?fromTurn=` 读回时经 **core 窗口层**按请求者窗口掩码；`world` 窗口产出的内容默认不进 player 投影（§6.3.5-5）。T-05a / T-07 / T-12 均有对应断言 |
| **R11** | **两个新声明式文件未进白名单 → 静默失效**（`templates.ts:422` `warn + 忽略`，服务照常起但触发 / DAG / manifest / 知识授权全失效，**比 fail-fast 更危险**）；或误并 `TEMPLATE_MERGE_FILES` / 误塞 `world.yaml` 顶层键 → `.strict()` 加载期 fail-fast | §7.1 **白名单 11→13**（不是 11→12）+ 独立 loader / 独立 Zod schema + 三个「绝不」；T-06 / T-10 加「两文件都被加载且非 `warn + 忽略`」显式断言；`world.yaml` 不新增顶层键（`llmTriggers` 收敛到 `rules.yaml`）；`opening.yaml` 省略依赖既有 `[]` / `createDefaultOpeningTemplate()` 回退（T-10） |
| **R12** | **`narrative` 改可选的下游类型债 + typecheck 陷阱**：`EventOption.text` / `WheelSegment.label` 仍 `min(1)`；根 `tsc --noEmit -p tsconfig.json` 覆盖 `packages/**/*.ts` 含 **43 个旧测试文件**，F2 只排 vitest 不够 | 回退值统一 **`?? title`**（不是 `""`）；`shared/src/v2.ts` 的 event view `narrative: string` 与 `triggeredEvents[].narrative: string`、`game-core/src/v2/narrative.ts` 的 `readonly narrative: string` **三处连带改**（T-00）；根 `tsconfig.json` 加 `exclude`（旧测试移入 `packages/*/legacy-tests/` 并排除），否则验收基线 R-01 必红；根 `package.json` 的 `test` 由仅 `--filter @life-sim/game-core` **扩到 shared / game-core / agent-runtime / rpg-ui 四包**（T-12） |

### 11.2 已裁决的分叉点（5 项 + 2 项补充收口，**不再拍板**）

> v1 本节为「必须用户拍板，若无回复按推荐执行」。用户已逐条收口 5 项；team-lead 补充只读核对再收口 2 项工程口径（⑥⑦）。**全部记为已裁决，均不是新增待拍板项**；下表「理由」逐条对齐用户原文 / 补充核对，实施按裁决直接执行。

| # | 裁决 | 落地 | 理由（对齐用户原文 / 补充核对） |
|---|---|---|---|
| **①** | **A：两个新包都加**（`agent-runtime` + `rpg-ui`） | §1.1 表格与 §1.3 依赖图按 A 落地；§1.1 末尾「用户可否决 / 按 ①-B / ①-C 落地」措辞作废 | 用户「大刀阔斧 / 开放设计」+ 四层分工要「React 组件对应 core 通用能力」⇒ 需真正可导出库；职责隔离保证 `game-core` 确定性不被污染 |
| **②** | **B′：以 trace 日志为内容仓库、state 只持引用**（**改判，取代 v1 推荐 A**） | §2.2 落点、§8.2 `LlmTrace` 唯一叙事落点、§8.3 破坏面删 `contentLayer`、新增 `GET /api/worlds/:id/narrative?fromTurn=`；**明确不取 ②-C「刷新即丢」** | 用户 F3 原文「LLM 叙事正文只进 append-only trace / callLog，不进 `WorldStateV2`，存档只留 `traceRef` / `contentRef`」；且要求「刷新后 AI 叙事不消失」 |
| **③** | **A：manifest 进语义指纹 / `assetFingerprint` 进信封但不参与拒载 / 3 张 IP 图标 demo 占位**（补充：`rules.yaml` 与 `assets/manifest.yaml` 一并进白名单，共 **13** 个语义指纹文件） | §7.1 / §7.3 / §8.3；备选 B（二进制进指纹）/ C（完全脱钩）不再保留为待选项 | 用户裁决 A；兼顾展示完整性可追溯与存档稳定，版权单独走用户确认 |
| **④** | **A：模板内置 fallback DAG** | §3.3 生命周期、§3.5 形状、T-10 新模板内置 fallback DAG；无 key / Mock / LLM 发布失败时用它跑完整一局 | 用户裁决 A；同时兑现「开局由 LLM 发布任务 DAG」与「Mock 零回归默认」 |
| **⑤** | **A：验收要档 2 可用 + 档 1 在 Mock 路径逐字段断言** | §8.1 末、T-07 / T-12 完成判据；真实 LLM 档 1 逐字段复现为尽力目标、不阻断 | 逐字对齐用户「尽量可回放，可降级为通过调用当时的日志达成可回放」 |
| **⑥** | **补充收口：`rules.yaml` 的 `when` P0 复用现行声明式 Condition DSL**（`packages/shared/src/schema/common.ts:181-192`），外面套一层开放 `ConditionRegistry` 作前向 seam；**不另立独立语法** | §3.2 / §3.4；T-02 完成判据（源码守卫） | 避免 T-02 与 T-10 各写一套条件语法导致漂移，且可直接复用现行求值器；`ConditionRegistry` 保留「条件集合开放」的前向能力 |
| **⑦** | **补充收口：`fallbackDag.edges` 形状由架构侧明确给出**：`Array<{ from: NodeId; to: NodeId; kind: string }>`（`kind` 开放、引擎不 switch）；**无环校验 = 端点完整性 + id 唯一 + 自环 / 重复边 + Kahn 拓扑排序，加载期与 `fact.advanceDag` 两处共用 `validateDag()`** | §3.5（完整 `rules.yaml` 片段 + 6 步校验表）；T-02 / T-10 完成判据 | 形状不明确则 T-02（按 `edges` 推导 `ready`）与 T-10（模板落盘）无法落盘 / 会各写一份漂移 |

> 除以上 **7 条**（现已全部裁决）外，其余设计取舍——工具面分类、DAG 不新增调度结构、**统一透视窗口 / 知识台账**、具体预算数值、16 个 `T-*` 顺序与 P0/P1 划分、单槽 / 单队列保留、白名单 11→13 与独立 loader 口径——均为架构侧裁决，**不需用户拍板**，按本文件执行。**本轮无剩余待拍板项。**

---

## 附：本文件与「不做什么」的边界

- 不写 ADR、不写四件套、不做 G1/G2、不给 ADR 清单、不做旧 ADR 修订 / 推翻 / 归档结论。
- 不改 `AGENTS.md` / `PROJECT.md` / `GAME_RULES.md` / `DECISIONS.md` / `BACKLOG.md` / `OPEN_QUESTIONS.md`；**只改本文件**；不改代码、不改 `*.yaml`、不跑测试。
- **不新建并行引擎 / 第二套状态机 / 第二套调度器**；`slot` + `delayQueue` 保持为唯一呈现位与唯一队列；DAG 不是第三调度结构；**不得为迁就旧测试保留双轨引擎（F2）**。
- **不改 `jjk-2006` 的 11 个 yaml（F1）**；验收只走新建 `demo-agentic` 最小模板。
- **不把 `rules.yaml` / `assets/manifest.yaml` 并入 `TEMPLATE_MERGE_FILES`、也不作为新顶层键塞进 `world.yaml`**（`.strict()` 会 fail-fast）；白名单是 **11→13** 不是 11→12；不新增 `opening.yaml`（走既有回退）。
- **不把 LLM 叙事正文写进 `WorldStateV2`（F3）**；不做旧档兼容 / 迁移 / 回填（第二次拒载，用户已裁决）。
- **不保留 v1「A 玩家端 / B LLM 上下文」双出口（F4）**；不在 `agent-runtime` 自建第二套 hidden 判据；`isPlayerVisible` 仅为 player 窗口兼容别名。
- 不引入六阶段 Lifecycle 状态机 / `Phase` / 阶段日志；不引用已下线的 V1 符号。
- 不把 LLM SDK / 网络调用放进 `packages/game-core`；`agent-runtime` 不持有权威状态引用。
- 不做 R3 时间穿越实施（只保留 seam）；不封死时间单调假设。
- 旧 `*.yaml` 与旧记录**本轮不删**，归档留到用户验收跑通之后。
