# 核心规格（2026-11-17）

> **这份文件只写"已经实现且能被验证"的东西。**
> 未实现的**不承诺**；不可避免要提到时，标 **`未决`**。
> 旧 `specs/` 与 `docs/` 已整体归档到 `archive/2026-11-16-pre-rewrite/`，不构成约束。
> 逐条裁决记录见 `docs/REFACTOR-NOTES.md`。

---

## 1. 产品说明

**AI 驱动的 RPG 人生模拟。** 玩家在模板给出的世界骨架里行动，规则由确定性内核裁决，
AI 负责把规则结果写成有画面的叙事、并在关键节点补出新的剧情分支。

### 1.1 四层分工

| 层 | 负责 | 边界 |
|---|---|---|
| **模板** | 故事骨架：世界观 / 属性 / 人物 / 事件 / 生成规则 / 结局 / 评价维度 | 只有声明式 yaml，不含可执行代码 |
| **core**（`packages/game-core`） | 最底层通用 RPG 规则：世界推进、事件调度、战斗、关系、评价、投影 | 不依赖 React / Fastify / DB / LLM SDK，无网络 |
| **AI**（`packages/agent-runtime` + `apps/server`） | 叙事与分支候选 | 只能通过引擎工具面写入，不直接改状态，不做评分裁判 |
| **前端**（`packages/rpg-ui` + `apps/web`） | 展示与交互 | 只吃投影（`V2Snapshot` / `ViewModel`），不承载规则 |

### 1.2 世界模板的接入层级

> 用户 2026-11-17 口径：**L0 已实现；L1–L4 待决定；L5 不适用。**
> 下面每层写清"现在能到哪一步"（事实）与"没定的部分"（`未决`）。

| 层 | 内容 | 当前状态 |
|---|---|---|
| **L0 最小实现** | 只写必要的 yaml 模板即可跑完一局 | **已实现**。见 1.3 的必需/可选文件表 |
| **L1 资源文件** | 立绘 / 差分 / 音频等静态资源随模板分发 | **部分**：`assets/manifest.yaml` 已能声明资源，服务端有 `GET /api/templates/:id/:version/assets/:assetId` 下发，`/api/templates` 会带 `assetCount`；**事件/叙事引用媒体的契约 `未决`** |
| **L2 深度 yaml（仍在框架内）** | 更复杂的声明式剧情结构（更多触发原语、更多结算形态） | `未决`。现只支持本文件 §3 描述的事件/触发/效果形状 |
| **L3 声明式拓展** | 复用/宏/片段包含，用来减少重复模板语句 | `未决`。模板目前没有 include / macro / anchor 语义（YAML 自身 anchor 可用，但引擎不理解） |
| **L4 自定义前端** | 自定义组件、或把 `rpg-ui` 当库引用完全自写客户端 | **部分**：`packages/rpg-ui` 已是可导出的 React 组件库（只吃 `ViewModel`），但**没有对外 API 稳定性承诺**，`未决` |
| **L5** | — | **不适用** |

### 1.3 L0 模板文件集（已实现）

服务端只认这 13 个文件（白名单，写在 `apps/server/src/templates.ts`），其余文件**不进加载、不进语义指纹**：

| 必需 | 可选 |
|---|---|
| `world.yaml`、`characters.yaml`、`skills.yaml`、`items.yaml`、`statuses.yaml`、`events.yaml` | `equipment.yaml`、`combat-ai.yaml`、`opening.yaml`、`endings.yaml`、`evaluation.yaml`、`rules.yaml`、`assets/manifest.yaml` |

- 目录即身份：`specs/data/templates/<id>/<version>/`，**版本号变化 = 另一个模板**。
- 模板增删改**只走文件系统**：`mkdir` = 加版本，改文件 = 下次请求时热加载，`rm -rf` = 删除。
- 加载期 **fail-fast**：任一 yaml 不合 schema、引用不存在的 id、DAG 之外的完整性错误 ⇒ **整个服务起不来**（启动期）或该模板标不可载（运行期热加载）。
- 语义指纹 = 13 个白名单 `*.yaml` 排序拼接后的 sha256；指纹变化 ⇒ 旧存档拒载（见 §3.6）。

### 1.4 不做的事（已裁决，不是未决）

- 不做「放弃转盘」：抽到哪一格就认。
- 不做 `taskDag`（任务 DAG 子系统）：已整套删除。
- 不做模板导入端点 / 编辑器：模板只经文件系统。

---

## 2. 核心术语与机制

### 2.1 三层时间

| 概念 | 字段 | 语义 |
|---|---|---|
| **轮次** | `state.turnIndex` | 逻辑回合，整数递增。玩家每做一次"推进"就 +1 |
| **世界时间** | `state.worldTime` | **整数分钟**，从世界起点累加。日期由模板历法渲染 |
| **事件时间窗** | `trigger.window` / `delay` | 相对量，**入队那一刻**换算成绝对分钟（`resolveTimeSpec(spec, now)`） |

轮次与世界时间**解耦**：一次推进可以推进 0 分钟（只占槽）或跨天（行动 duration）。

### 2.2 槽（slot）：唯一呈现位

- `state.slot: SlotScene | null` 是**标量**——结构上不可能"两个事件同时在槽"。
- 槽非空 ⇒ 玩家**必须先处理它**：此时提交自由行动会被拒（`pending_event_required`）。
  **唯一例外**是"确认转盘"（槽内事件 `kind: "random"`）。
- 占槽来源（全部经 `assignSlot()` 单一写入口）：

| 来源 | 何时 |
|---|---|
| `successor` | 上一幕结算后，`nextEventId` 指向的下一幕**没有**声明窗口/延迟 ⇒ 直接占槽 |
| `hook` | 行动触发（`action-hook`）命中 |
| `queueTake` | 空槽时扫时间队列，取出到期事件即占槽 |
| `death` | 死亡结局事件占槽 |

- **有延迟的后继不占槽**：`nextEventId` 的目标若声明了 `window.start` 或 `delay`，进时间队列并清空槽
  ⇒ 中间可以发生别的事（穿插）。这是分支"未来才演下一幕"的实现方式。

### 2.3 时间队列（delayQueue）：唯一队列

- `state.delayQueue: ScheduledEventInstance[]` 是**唯一**队列；没有第二个调度结构。
- 入队门控在入队时一次性求值（`probability` / `weight` / `once` / `priority` / `conditions`），
  出队时只复核**前提**（`missWhen` 与 `trigger.conditions`）。
- 排序键（严格全序）：`window.start` → 是否有 `window.end`（无 = +∞）→ `window.end` → 入队序号。
- 错失（append-only，进 `state.missedEvents`）只有两种原因：`window_expired`、`miss_when`；
  门控失败**不算错失**（不产生实例）。
- `kind: "combat"` **不得**进事件池（不允许被随机抽出来直接开战）。

### 2.4 占槽 / 不占槽操作

| 操作 | 占槽？ | 推进轮次？ | 说明 |
|---|---|---|---|
| 选择事件选项 `POST /events/choose` | 结算当前槽 | 是 | 事件轮跑完整尾管线 |
| 战斗命令 `POST /battle` | 结算当前槽 | 否（战斗内回合） | 战斗结束算一次结算 |
| 确认转盘 `POST /wheels/confirm` | 结算当前槽 | 是 | 不消耗"行动"，只把掷出的那一格结算 |
| 自由行动 `POST /turns` | 空槽时才允许 | 是 | 槽非空 ⇒ `pending_event_required` |
| 用物品 `POST /items/use` | **不占槽** | 否 | 轮外操作，不受槽占用限制 |
| 装备 / 卸下 | **不占槽** | 否 | 同上 |

### 2.5 分支（一段剧情）与延迟

模板里一个事件可以写成 `branch:`（多节点），**加载期展开**成普通事件：

- 首节点沿用父事件 id（外部 `nextEventId` / `eventResolved` 引用零改动），其余节点 `<id>#<node>`；
- `goto` 只能指向**本分支内**的节点；`goto.after` 让下一节点"过一段时间再演"（不占槽，可穿插）；
- 选项可用 `nextEventId` **跳出分支**回到模板主线；
- `goto` 与 `nextEventId` 互斥；同一节点被两个 `goto` 要求不同 `after` ⇒ 拒载。

LLM 侧有一条同形的 DSL（`story.submitBranch`），见 §4.4。

---

## 3. 核心数据模型（按现有实现）

权威状态是 `WorldStateV2`（`packages/shared/src/v2.ts`），存档 `schemaVersion = 4`。

### 3.1 世界 `WorldStateV2`

| 字段 | 层 | 说明 |
|---|---|---|
| `id` / `templateId` / `seed` | 标识 | 同 seed + 同输入 ⇒ 同结果（内核确定性） |
| `turnIndex` / `worldTime` | 时间 | 见 §2.1 |
| `player` | 实体 | 玩家（**不是** NPC 实例，独立字段） |
| `npcs[]` | 实体 | 全部已定义角色的实例（见 §3.4） |
| `relations[]` | 实体 | 关系边（见 §3.5） |
| `slot` / `delayQueue` | 结构 | 见 §2.2 / §2.3 |
| `battle` | 结构 | 进行中的战斗（同一时刻至多一场） |
| `lastWheel` / `lastWheels` | 呈现 | 转盘结果（后者是当轮全部） |
| `flags` | 事实 | 模板可读写的语义黑板 |
| `eventFires` / `missedEvents` / `spawnLog` | 事实 | append-only 事实层 |
| `history` | 事实 | 玩家可见历史（带 `visibility`） |
| `observationLedger` | 事实 | 观察者知识台账（玩家与每个 `npc:<id>` 共用一套） |
| `pendingInvocation` | 运行时 | 进行中的 LLM 调用（回程一律走引擎 API） |
| `traceRef` | 引用 | 叙事正文在 `*.trace.jsonl` 里的引用（正文**不进** state） |
| `generatedEvents` / `generatedCharacters` | 生成 | 运行时由 LLM 提交的分支事件 / 新角色定义（可选） |
| `spawnRules` | 实例 | 刷新规则实例队列 |
| `termination` / `archived` | 终止 | 唯一的终止事实 / 归档只读标记 |

### 3.2 事件 `EventV2`

- `kind`: `normal`（需选择）/ `random`（转盘，需确认）/ `combat`（战斗）。
- `trigger.source`: `schedule` / `pool` / `chain` / `action-hook`。
- `settle` 按 `kind` 分支；`nextEventId` 指定后继。
- `actors` = 这一幕**必须在场**（出队前复核活着，不符判错失）；`mentions` = 只在正文提到（可已故）；
  `npcs` = 这一幕把这些人**拉上场**（幂等）。
- `once` / `cooldown` / `window` / `delay` / `timeCost` / `missWhen` 见 §2。

### 3.3 事实层

- **只追加**：`eventFires`、`missedEvents`、`spawnLog`、`history`、`trace`（jsonl）。
- **可覆写**：`flags`（模板语义黑板）、`observationLedger`（知识台账）。
- 引擎内部记录不得写进 `flags`（命名空间由引擎自己保留：如 `npcAction:<id>:<action>`）。

### 3.4 NPC `V2Npc`

| 字段 | 说明 |
|---|---|
| `id` / `name` / `gender` / `age` / `birthTime` | 身份；年龄由 `birthTime` + 世界时间**现算** |
| `lifecycle.state` | `alive` / `inactive` / `unspawned` 三态；**没有** 布尔 `alive` |
| `visibility` | `public` / `hidden`：**纯展示门**，只决定"玩家视角 NPC 列表里有没有他"；不影响实例存在、关系端点、自主行动 |
| `isEnemy` | 敌人标记。**敌人不实例化**（`turn.ts` 建实例时整类跳过），只作为 `settle.combat.enemies[].ref` 的目标 |
| `skills` / `attributes` / `statuses` | 战斗与判定用 |
| `secrets[]` | 私密事实（只在 `world` 视角可见） |
| `knowledge[]` / `goals[]` / `traits[]` | 私有目标与知识（不进玩家投影） |

### 3.5 关系 `RelationEdge`

```ts
{ from, to, kind, source, visibility, value?, gap?, frozen? }
```

- `kind` = 有向关系（`father` / `mother` / … / `mentor` / `friend` / `colleague` / …）；
  `{from: A, to: B, kind: "father"}` 读作「B 是 A 的父亲」。
- `visibility`: `known` / `inferred` / `unknown` / `hidden` —— **关系能否上屏只由这一位决定**，
  与"对方有没有 NPC 卡"无关（关系是独立事实）。
- 投影只下发 `known` / `inferred`；行内给 `withName`（对方名字）与 `counterpartVisible`（对方有没有卡）。
- `frozen`：一端死亡后冻结，仍参与称谓推导（逝者仍是亲属）。
- 称谓：亲属边多跳推导（复用 `relationship.js`），断代（`gap`）只给粗称谓，不猜代数。

### 3.6 隐秘与知识

- `npc.secrets[]` 是私密事实本体；效果 `addSecret` 追加（按文本去重）。
- **知识只由模板规则授予**：`rules.yaml` 的 `knowledgeGrants`（何时、给谁、哪些 `factRefs`、什么级别）
  与 `inferenceRules`（推断）。LLM 不能写台账。
- `factRef` 命名空间：事实 id（如 `fact:xxx`、`secret:xxx`）；玩家投影按 `visibility` 过滤。

### 3.7 存档与拒载

- 存档是 `WorldStateV2` + 信封（`schemaVersion`、模板 `ref`、`traceRef`、`savedAt`）。
- 拒载条件（封闭码）：`schemaVersion` 不匹配、模板不存在、模板语义指纹变化、解析失败。
- 世界列表区分**可载 / 不可载**，不可载不崩服务、可删除。
- **旧档不兼容**：本次重构把 `schemaVersion` 推到 4 并删除了 `taskDag` 字段，旧档一律拒载。

---

## 4. Agentic

### 4.1 边界（硬约束）

1. LLM **只能通过工具面**影响世界；`dispatch` 之外没有任何写入口。
2. LLM **不写叙事正文进 state**：正文只进 append-only `*.trace.jsonl`，state 只留 `traceRef`。
3. LLM **不做裁判**：评分、结局判定、战斗结算全部由内核完成。
4. 模型输出**必须结构化**（工具调用 + 标签正文），校验失败或不可用 ⇒ 回退模板文案，回合不中断。

### 4.2 工具面（当前全部）

| 类 | 工具 | 作用 |
|---|---|---|
| 只读 | `world.now` | 当前轮次 / 世界时间 / 阶段 |
| 只读 | `world.history` | 玩家可见历史 |
| 只读 | `world.present` | 槽里正在演什么 |
| 只读 | `world.self` | 玩家自身状态 |
| 写世界 | `story.submitBranch` | **一次性提交一整条分支**（唯一写入口） |

已下线的写工具：`fact.setKnowledge` / `fact.advanceDag` / `fact.upsertDagBranch` / `fact.enqueueEvent` /
`narrative.write` / `narrative.flavor`。调用它们会得到 `unknown_tool`。

### 4.3 叙事通道

- 模型把**所有玩家可见正文**包在 `<narrative-content>…</narrative-content>` 里；标签外的内容一律丢弃。
- 收尾时把标签块合成一个 `ContentBlock`（`kind: "narrative"`、`targetPerspective: "player"`、`refs: []`）
  写入 trace。
- 没有标签 ⇒ 诊断 `narrative_tag_missing`（committed / fallback 都记），玩家侧回退模板事件文案。
- 实时通道 `POST /api/worlds/:id/narrative/stream`（SSE）：**服务端剥标签**后按碎片下发；
  `PENDING_WAIT_MS = 3000` 覆盖"先开流、再发 turn"的顺序。
  ⚠️ 订阅端不能 `await fetch(stream)` 之后再发 turn（响应头要等首帧），否则会互锁到 `idle`。

### 4.4 分支 DSL（`story.submitBranch`）

```ts
{ trigger: { mode: "certain" | "random",
            after?: TimeSpec },              // after = 多久之后开演
  npcs?: GeneratedNpc[],                     // 现场造人（引擎分配 id、以 unspawned 落表）
  branch: [{ node, title, text, actors?, mentions?, npcs?,
             options: [{ text, effects?, goto?: string | { node, after? } }] }] }
```

- 节点是本次提交内的**局部别名**；全局 id 由引擎分配（`gen:<invocationId>:<node>`）。
- 选项效果是**扁平形状**（不是内核的 24 种 effect）：`flag` / `mood` / `hp` / `mp` / `spawn` /
  `relation` / `relationEdge` / `secret` / `lifecycle`。
- `spawn` 可引用本次提交的 NPC 别名、模板角色 id、或刷新规则 id。
- 提交内容会被引擎**校验**：`goto` 越界、未知引用、参数不合法 ⇒ 整条拒绝（带回执）。

### 4.5 一次 invocation 的生命周期

```
模板 rules.yaml 的 llmTriggers[].when
   │  （边沿语义：同一条触发只在该条件"由假变真"的那一轮命中；每轮最多执行一条）
   ▼
evaluateTriggers → invocations[]（0..1 条）
   ▼  无 gateway / 无命中 ⇒ 本轮零 LLM 调用
gateway.invoke(invocation)
   │  invocation 带 perspective / targetPerspective / toolProfile / contextHints
   ▼
loop：多轮工具调用（有预算与终止条件）
   │  每一轮：provider → 记录 calls（trace）→ 第 1 层结构校验 → dispatch（第 2 层规则校验）
   ▼
dispatch → 引擎写入 + 回执（accepted / rejected + 封闭诊断码）
   ▼
收尾：提取 <narrative-content> → ContentBlock → trace；置 outcome = committed / fallback
   ▼
服务端把 trace 追加到 <worldId>.trace.jsonl，state 只留 traceRef
```

- **视角**：`world`（全知，GM 用）/ `player` / `npc:<id>`；由模板 `invoke.perspective` 声明。
- **能力画像**（`toolProfile`）：模板声明的工具上限，引擎只能**收窄**不能新增。
- **可回放**：trace 里有 `calls`（模型实际发出的工具调用 + 参数）与 `contentBlocks`（正文），
  足以用录制数据重放一次 invocation（测试就是这么做的，见 §5）。

### 4.6 实体关系（谁依赖谁）

| 从 | 到 | 关系 |
|---|---|---|
| 模板 `rules.yaml` | invocation | 声明何时唤起、给什么视角与工具上限 |
| invocation | 工具调用 | 模型只能在这里发 |
| 工具调用 | 引擎效果 | 经 `dispatch` 校验后落账 |
| 引擎效果 | `WorldStateV2` | 唯一写入路径 |
| `WorldStateV2` | 投影 | 按视角过滤后给前端 / 给模型读工具 |
| trace | 前端叙事 | 正文唯一存放处（state 只留引用） |

### 4.7 `未决`

- 叙事层是否**长期走 agentic 模式**（现在叙事正文与工具调用在同一次 invocation 里）。
- 自由文本行动（玩家输入自然语言 → 结构化行动）。
- 多 Agent / 观察者切换（玩家是"一个 NPC"这件事只做了关系侧的 `selfId` 缝，存储未切）。
- 平台免密钥的 LLM 链路。
- 叙事正文的引用校验（改纯文本后 `refs[]` 失效，模型理论上可在正文里写出隐秘）。

---

## 5. 测试

### 5.1 结构

```
test/
  fixtures/llm/          录制的 trace（一局一份，jsonl）
  fixtures/templates/    测试专用最小模板（不依赖 specs/data 的业务模板）
  helpers/               起服务、建世界、流程驱动、回放 provider
  unit/                  game-core 纯函数
  api/                   起真服务打 HTTP
```

- 测试**只放这里**，不放回 `packages/*/src` 或 `apps/*/src`；npm 不打包测试代码。
- 根 `pnpm test` = `vitest run`（`vitest.config.ts` 只收 `test/**/*.test.ts`）。

### 5.2 两条原则

1. **LLM 层永远走 mock，且 mock 数据来自真实 trace**（录制 → 回放），不手搓 payload。
   回放 provider 把 `contentBlocks[].text` 包回 `<narrative-content>`、把 `calls[].args` 序列化成
   tool_calls；并断言"回放产出的 trace 与录制时的 `calls` / `contentBlocks` 一致"。
2. **每条测试都要能红**：写完对每条做一次变异验证（故意改坏对应实现，确认测试失败，再恢复）。
   只报绿不报变异 = 没验。

### 5.3 P0 覆盖（已实现，19 例）

| # | 覆盖 |
|---|---|
| 1 | 投影：`visibility: hidden` 不进 NPC 列表，但关系边仍上屏且 `withName` 不是裸 id |
| 2 | 关系：只按边自身 visibility 收敛；称谓不因端点未登场而消失 |
| 3 | 调度：`window` / `delay` 相对入队换算；`once` 已触发不再入队 |
| 4 | 分支展开：首节点父 id / `#node` / `goto` / `goto.after` / `nextEventId` 出口 / 撞车拒载 |
| 5 | 战斗：HP clamp 到 1；非 alive 参战者被剔除 |
| 6 | 主循环：建局 → 转盘 → 战斗 → 选择 → 结局；结局 id 属于模板声明集合 |
| 7 | 双开局各到结局且不同 |
| 8 | 叙事：`GET /narrative` 读回；SSE 先订阅后触发拿到 >1 帧、无 `<`、与正式块逐字相等 |
| 9 | 无标签：SSE 0 帧 + `narrative_tag_missing` + 玩家侧无正文 |
| 10 | 工具下线：`story.submitBranch` 正常；`narrative.write` / `fact.enqueueEvent` ⇒ `unknown_tool` |
| 11 | 存档：重启同一数据目录后世界还在、能继续 |
| 12 | 拒载：`schemaVersion` 不匹配 / 指纹漂移 ⇒ 列表标不可载，不崩服务 |

### 5.4 未做（明确不承诺）

- **UI 测试**：本轮不做（体系留着，`test/` 下可加 `ui/`）。
- 真实外部 LLM 的联网用例：不在自动化里跑（要跑就手工、用玩家自己的 key）。
- 未覆盖：`submitBranch` 的节点级 `npcs` alias 解析、跨轮写护栏、`once` 的调度器全路径、
  真实 jjk 模板的结局线（用专用最小模板替代）。

---

## 附：怎么验证这份文档没有骗人

```bash
pnpm typecheck     # 类型 0 错
pnpm test          # 19 例 P0
pnpm build         # 前端可构建
PORT=3000 pnpm --filter @life-sim/server start   # 三个模板 loadable
```

任何一条跑不过，说明本文件对应的描述已经过期——改代码或改这份文件，不要两者都留着。
