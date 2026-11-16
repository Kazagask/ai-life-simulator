# AGENTIC GM 设计（推倒重来）

> **状态**：设计稿 v1（2026-11-16）
> **性质**：推倒重来级重构的唯一实施依据。用户已裁决「之前的 ADR 都可以不管了，只当作代码排查记录」，本文档**不继承**任何旧 ADR / BACKLOG / 四件套约束；旧文档仅作「现状为何长这样」的取证材料。
> **范围**：`packages/shared` → `packages/game-core` → `packages/agent-runtime` → `packages/rpg-ui` → `apps/web` / `apps/server` 全链路。
> **一句话**：agent-runtime 从「被喂快照后一次性输出」升级为**游戏的 GM agent**——它靠**读工具**自己查世界、靠**写工具**提交编排、靠**上下文窗口**决定这一轮导演什么；它永远不能直接动引擎结构（不入队、不占槽、不改 DAG）。

---

## 0. 一页纸摘要

| 维度 | 旧模型（现状） | 新模型（本文档） |
|---|---|---|
| 上下文 | core 每轮 push `facts`/`dagNodes`/`recentTurns`/`contextHints`，再加工具 schema | 只常驻 `stablePrefix`（世界骨架 + 输出契约）；其余**全靠 agent 用读工具自己查** |
| 读世界 | `buildFacts` 一次性灌进 prompt | 一组**按视角裁剪、不接受 perspective 参数**的读工具，一个语义一个工具 |
| 写叙事 | `content.*` 写 trace | 保留 `content.writeNarrative` / `content.submit` |
| 写剧情 | `fact.enqueueEvent` / `fact.advanceDag` / `fact.upsertDagBranch`（LLM 直动队列 / DAG） | **`story.submitBranch` 一次提交一整条分支**；引擎消化成事件、注册、调度；LLM 不感知槽 / 队列 / 池 / DAG |
| 分支单位 | 单个事件 / 增量 DAG 补丁 | **一整条分支（1..N 个事件块）**，单事件是退化形态 |
| 节点 id | LLM 自造 | **引擎分配**，LLM 只用本次提交内的局部引用 |
| 选项 | `content.writeOption` → 前端 `OptionDeck` | **删除**；选项回到事件块的 `settle.options`，由事件区渲染 |
| 跨提交 | 可在已有 DAG 上打补丁 | **一律拒绝**；想续写就提交新分支 |
| 诈尸 | 靠 `missWhen` 兜底 / 事务边界 | **引擎强制**：声明参与角色，呈现前复核，失败即 miss |
| 存档 | `WorldStateV2`（v4） | `WorldStateV2`（**v5**）新增 `generatedEvents`（生成编排与模板事件同形同队列） |

---

## 1. 角色模型

### 1.1 一句话版本

> **GM agent 是这场人生的「说书人 + 编剧」**：它看得见自己视角内的世界（读工具），它写这一轮的叙事（`content.writeNarrative`），它可以把**未来**的剧情写成一条分支交给引擎（`story.submitBranch`）——但**何时、以何顺序、在哪个槽**上演，全由引擎决定，它既看不见也管不着。

### 1.2 职责边界

| 角色 | 职责 | 明确不做 |
|---|---|---|
| **GM agent（agent-runtime）** | 查世界、写本轮叙事、提交未来分支编排 | 不写权威状态、不入队、不占槽、不改 DAG、不决定评分、不决定触发时机 |
| **core（game-core）** | 窗口投影（`buildFacts`）、工具执行（dispatch）、分支编译与注册、调度、呈现槽、诈尸复核 | 不写叙事正文、不做叙事质量判断 |
| **模板（template/*.yaml）** | 声明世界骨架、静态事件、触发规则、知识授权 | 不感知「有 LLM」这件事（无 gateway 时行为不变） |
| **前端（rpg-ui / web）** | 渲染叙事流、事件面板（含选项）、状态栏、媒体 | 不解释剧情、不推断选项与分支的映射 |

### 1.3 分工图（数据流向）

```
                    ┌──────────────────────── 只读 ────────────────────────┐
                    │                                                      │
  ┌──────────┐  读工具 query   ┌──────────────┐                    ┌──────────────┐
  │ GM agent │ ─────────────▶ │ game-core    │ ◀── buildFacts ─── │ WorldStateV2 │
  │ (runtime)│ ◀─── 结果 ───── │ dispatch 层   │                    │  (权威状态)   │
  └──────────┘                └──────┬───────┘                    └──────┬───────┘
       │                             │ 写叙事(进 trace)                   │
       │ content.writeNarrative ─────┘                                   │
       │                                                                 │
       │ story.submitBranch ──▶ 分支编译器 ──▶ generatedEvents(v5) ───────┘
       │                       (EventV2，与模板同形)         │
       │                                                     ▼
       │                              ┌──────────────────────────────────┐
       │                              │ 调度器（唯一队列 delayQueue）       │
       │                              │ enqueueCandidate → scanDelayQueue │
       │                              │        → slot（呈现槽）            │
       │                              └──────────────┬───────────────────┘
       │                                             │ 呈现（含诈尸复核）
       │                                             ▼
       │                                        ┌─────────┐
       └──────── 本轮叙事正文 ◀── trace ◀───────│ 前端渲染 │
                                                └─────────┘
```

### 1.4 三条不可越界的硬线

1. **AI 不写权威状态**：`WorldStateV2` 的任何字段只能由 `game-core/api/engine-api.ts` 的 dispatch handler 写；agent 只能「提议」，采纳与否由引擎决定。
2. **AI 不动引擎结构**：队列、槽、池、DAG、调度权重对 agent **完全不可见**（不进工具面、不进返回值、不进上下文）。
3. **AI 不做评分 / 不做终止**：结局判定、评分维度都由 core 按模板确定性计算。

---

## 2. 上下文契约

### 2.1 现状问题

`packages/agent-runtime/src/context.ts` 的 `buildStablePrefix` 目前拼接：世界骨架 → 能力画像 → 输出契约 → **工具 JSON schema（`# 工具与参数`）**。而 `LlmInvocation.tools` 已经作为 Function-Calling 的 `tools` 下发，工具 schema **是双份**。同时 `LlmContext` 里 `facts` / `recentTurns` / `branchEventIds` 是 core **push** 的——这些是「每轮都塞」，与「agent 自己查」的模型相反。

### 2.2 新契约

```ts
// shared/contract/llm-invocation.ts —— 目标形状（收缩）
export const LlmContextSchema = z.object({
  /** 字节稳定：世界观骨架 + 输出契约 + 本次视角的能力边界（不含工具 schema、不含 facts） */
  stablePrefix: z.string(),
  /** 本次为什么被唤起（自然语言，不是数据）；供模型理解「我在演哪一出」 */
  invocationReason: z.string().min(1),
}).strict();
```

- **删除** `facts` / `secrets` / `recentTurns` / `contextHints` / `branchEventIds` 五个字段。
- **删除** `buildStablePrefix` 里的 `# 工具与参数` 段。
- **删除** `loop.ts` 里 `branchEventIds` 的引导语渲染（`BRANCH_PROMPT_LEAD` 整段移除）。
- 工具面通过 `LlmInvocation.tools` 下发，**工具 schema 不再进 stablePrefix**。

### 2.3 stablePrefix 里到底放什么

| 段落 | 内容 | 为什么常驻 |
|---|---|---|
| `# 世界骨架` | 世界观摘要、题材、人称、语气约束、当前生命阶段 | 每轮必用、字节稳定、可作 prompt cache 前缀 |
| `# 输出契约` | 「你是说书人」「事实变更只能通过工具」「正文 2-4 句、简体中文、第二人称」 | 行为约束，每轮必用 |
| `# 能力边界` | 「你能看见的只有本次视角内的东西」「你不能决定事件何时上演，只能提交编排」 | 防止模型「想当然」越界 |

**明确不放进 stablePrefix 的东西**：工具 schema（走 `tools`）、`facts`（走读工具）、`recentTurns`（走读工具）、当前槽状态（走工具面差异）、任何 `evt:`/`dag:` 引用清单（走读工具）。

### 2.4 字节稳定性

`stablePrefix` 只由「模板静态部分 + 视角」决定，**不随轮次 / 时间 / 随机变化**。同一世界 + 同一视角的两次 invocation，`stablePrefix` 逐字节相同 ⇒ 可命中 prompt cache。`contextHash = sha256(stableStringify(context))` 仍成立，但 `context` 已收缩为两字段，哈希不再被 `facts` 抖动污染。

### 2.5 压缩记忆 compact

> 用户 2026-11-16 追加：「轮次超常的时候 LLM 做一个归纳总结，注入到上下文」。
> **一处修正**（team-lead 已与用户确认）：摘要**不进 `stablePrefix` 的字节**——`stablePrefix` 的定义就是跨轮字节不变（prompt cache 与 `contextHash` 归因都挂在它上面），摘要每 N 轮变一次，塞进去会让前缀缓存全失效、`contextHash` 每轮不同。**摘要作为独立一段常驻注入，紧跟 `stablePrefix` 之后，不并入它的字节。**

#### 2.5.1 存储

```ts
// shared/v2-state.ts（与 generatedEvents 同属 schemaVersion 5）
compact: z.object({
  summary: z.string(),                                // 归纳出来的前情摘要
  coveredThroughTurn: z.number().int().nonnegative(), // 摘要已覆盖到第几轮
  updatedAtTurn: z.number().int().nonnegative(),      // 上一次压缩发生在第几轮
}).strict(),
```

进存档，理由同 `generatedEvents`：**不进档则刷新丢记忆、回放不可复现**。

#### 2.5.2 触发（引擎决定，LLM 不决定）

- 条件：`turnIndex - compact.coveredThroughTurn >= 12` ⇒ 触发一次压缩；无新轮次不压。
- 阈值先写死 **12**，之后可放模板（如 `eventFlow.compactEveryNTurns`）。
- **LLM 不能主动要求压缩**：压缩是引擎按轮次阈值发起的独立 invocation，不挂在 `rules.llmTriggers` 上。

#### 2.5.3 两种调用必须分清

| | GM 调用 | compact 调用 |
|---|---|---|
| 触发者 | 引擎按 `rules.llmTriggers`（边沿语义） | 引擎按轮次阈值（`>=12`） |
| 工具面 | 读工具 + `content.writeNarrative` + `story.submitBranch` + `content.submit` | **只有** `story.commitCompact({ summary })` + `content.submit` |
| 上下文注入 | stablePrefix + `# 前情`（当前摘要）+ 自己查的 | stablePrefix + `# 前情`（旧摘要）+ **上次压缩之后**的轮次原文 |
| 产出 | 叙事 / 分支 / 记忆块 | 摘要文本 → 写进 `state.compact` |

> compact 调用**没有**读工具、没有写叙事、没有提交编排——它只干一件事：把「上次压缩之后」的轮次压成一段文字。给它读工具会诱导它去查世界、变相变成一次 GM 调用。

#### 2.5.4 事务

compact 写入必须与它所在的那一轮**同一事务**（沿用既有纪律：结构写入在同一回合临界区内落账）。否则会出现「摘要基于旧世界、写进新状态」。

#### 2.5.5 注入位置

GM 每次唤起都带 `# 前情`（当前摘要），**在 stablePrefix 之后、读工具查询结果之前**：

```
[system]  stablePrefix（字节稳定）
[system]  # 前情\n{compact.summary}        ← 紧跟 stablePrefix，独立段，不属于其字节
[user]    invocationReason
[tool…]   agent 自己用读工具查到的结果
```

#### 2.5.6 一条硬规则（不可协商）

> **摘要是软记忆，不是事实源。** 它只能让 GM「记得大概发生过什么」；**任何写操作与判活的依据必须来自读工具**。摘要可以写错（模型会编），引擎必须拦（`actors` 在呈现前权威复核，见 §6）。这两条缺一不可：只靠摘要自觉 = 诈尸的另一个入口；只靠引擎拦 = GM 会一直基于错误的记忆写戏。

#### 2.5.7 对已定 §2.2 / §2.3 / §2.4 的同步点（**待 team-lead 确认；本文档未擅自改动已定节**）

本节要求已定节同步三处，否则 `LlmContext` 的 schema 与本节不一致：

1. **§2.2** `LlmContextSchema` 增加一个**可选**字段：
   ```ts
   /** 压缩记忆：`# 前情` 段的内容。独立于 stablePrefix 的字节；每 >=12 轮更新一次。 */
   priorSummary: z.string().optional(),
   ```
2. **§2.3** 「明确不放进 stablePrefix 的东西」补一项：**`# 前情` 摘要**（独立段、紧跟 stablePrefix 之后，不进其字节）。
3. **§2.4** 「`context` 已收缩为两字段」需改为「三字段」，并补一句：`contextHash` 会随 `priorSummary` 更新而变化，但摘要每 ≥12 轮才变一次，**不是每轮变**；`stablePrefix` 字节仍稳定，prompt cache 前缀不受影响。

---

## 3. 读工具面

### 3.1 总则

- **视角在 invocation 时固定**（`player` / `npc:<id>` / `world`），由 `LlmInvocation.perspective` 注入，读工具**不接受任何 perspective / observer 参数**。
- 工具内部用固定视角调用 `buildFacts(perspective)` 或其子投影；**结构上不可能**通过传参看到窗口外的东西。
- **返回值不得泄露存在性信息**：不得出现「你看不见的还有 N 个」「隐藏节点 M 个」之类。看不到就是看不到，不是「看不到 N 个」。
- **一条查询一个工具**，每个入参对应独立语义；**禁止 `world.look` 上帝函数**。

### 3.2 工具清单

#### 3.2.1 `world.now` —— 现在是什么时刻

```jsonc
// 入参：无
// 返回
{
  "worldTime": 120,              // 世界分钟
  "turnIndex": 7,
  "slot": {                      // null = 空槽（自由行动）
    "eventId": "evt:trial",
    "title": "初次试炼",
    "from": "queueTake"
  },
  "lastBranch": {                // 上一幕走了哪个分支；null = 无
    "eventId": "evt:trial",
    "label": "走左边"
  }
}
```

**裁剪规则**：`slot.from` 只透出语义枚举（`successor`/`queueTake`/`opening`/…），不透出 `instanceId`、不透出「队列里还有几个」。

#### 3.2.2 `world.history` —— 最近发生了什么

```jsonc
// 入参
{ "limit": 8 }        // 可选；缺省 = all（引擎上限 50，超限截断为最近 50）
// 返回
{ "entries": [
    { "turnIndex": 6, "worldTime": 100, "eventId": "evt:awaken", "title": "苏醒", "summary": "…" }
  ],
  "returned": 8,      // 本次返回条数
  "total": 137,       // 本视角可见的历史总条数
  "truncated": true   // 是否被上限截断
}
```

**裁剪规则**：只回**本视角可见**的历史条目；`hidden` 事件不进历史；`summary` 是已落账的可见摘要，不是原文重放。

> **`total` / `truncated` 不是可选项**：模型必须知道「还有更早的」，否则会把「只看到 50 条」误当成「世界只发生过 50 件事」，进而编出「世界很空」的叙事。分页游标不提供——单次最多 50 条，超出部分不返回，`truncated:true` 就是唯一提示。

#### 3.2.3 `world.present` —— 场上还有谁

```jsonc
// 入参：无
// 返回
{ "npcs": [
  { "id": "npc:mentor", "name": "老周", "alive": true, "location": "npc:mentor@home",
    "knownFacts": ["fact:gate-location"] }
] }
```

**裁剪规则**：只回**本视角台账里 known/inferred** 的 NPC（`buildFacts().ledger` 的反向索引）；死者只在「你已知他死」时才回 `alive:false`，否则整个 NPC 不出现；**不回死者列表的计数**。

#### 3.2.4 `world.self` —— 我自己

```jsonc
// 入参：无
// 返回
{ "name": "…", "age": 24, "attributes": { "body": 5, "mind": 6, "luck": 3 },
  "resources": { "hp": 80, "mp": 20 }, "mood": 55,
  "statuses": ["bruised"], "inventory": [{ "id": "item:lamp", "count": 1 }] }
```

**裁剪规则**：只回玩家自身（`perspective` 必须是 `player`，npc 视角下回该 NPC 自身）；不含任何 NPC 或世界隐秘。

#### 3.2.5 `world.clues` —— 还有哪些线索 / 分支可用

```jsonc
// 入参：无
// 返回
{ "dagNodes": [ { "nodeId": "n1.awaken", "status": "completed", "title": "苏醒" } ],
  "flags":   [ { "ref": "flag:trialDone", "value": true } ] }
```

**裁剪规则**：`dagNodes` 只回本视角可见节点（player 只见 `visibility === "public"`；npc 只见台账内 `dag:` 条目）；`flags` 只回本视角 known/inferred 的 flag；**不回 hidden 节点、不回不可见 flag、不回其计数**。

### 3.3 「不允许上帝函数」的判据

| 判据 | 含义 |
|---|---|
| 单语义 | 每个工具只覆盖一个语义维度（时间 / 历史 / 人物 / 自身 / 线索），不混合 |
| 无通配参数 | 不存在 `includeAll` / `scope: "world"` / `raw: true` 这类「放大」开关 |
| 封闭返回 | 返回值域由 schema 封闭，新增维度必须**新增工具**而非加字段 |
| 无存在性泄露 | 任何返回都不得暗示「窗口外还有内容」 |
| 视角不可选 | 工具签名里没有 perspective / observer 入参 |

---

## 4. 写工具面

### 4.1 `story.submitBranch` —— 一次提交一整条分支

LLM 侧只表达三件事：**怎么触发、事件是什么、完整编排是什么**。

```jsonc
{
  "trigger": {
    "conditions": [ { "flag": "trialDone" } ],   // 触发条件（Condition DSL 子集，与模板同一词汇表）
    "mode": "random" | "certain"                 // 随机 / 必然
  },
  "branch": [
    {
      "node": "n1",                              // 本批内局部 id（引擎会分配全局 id）
      "title": "夜访",
      "text": "雨停之后，老周敲开了你的门……",       // 事件正文
      "actors": ["npc:mentor"],                  // 参与角色（引擎呈现前复核活性）
      "options": [
        { "text": "让他进来", "effects": [ { "type": "setFlag", "id": "letIn", "value": true } ],
          "goto": "n2" },
        { "text": "装作不在家", "effects": [ { "type": "adjustMood", "value": -3 } ] }  // 无 goto = 到此为止
      ]
    },
    {
      "node": "n2",
      "title": "长谈",
      "text": "……",
      "actors": ["npc:mentor"],
      "options": [ { "text": "送他离开", "effects": [] } ]
    }
  ]
}
```

### 4.2 入参 JSON Schema（工具面，OpenAI `parameters` 级别）

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["trigger", "branch"],
  "properties": {
    "trigger": {
      "type": "object",
      "additionalProperties": false,
      "required": ["conditions", "mode"],
      "properties": {
        "conditions": {
          "type": "array",
          "minItems": 0,
          "items": { "type": "object" }            // Condition DSL（{} = 无条件，必然可触发）
        },
        "mode": { "type": "string", "enum": ["random", "certain"] }
      }
    },
    "branch": {
      "type": "array",
      "minItems": 1,
      "maxItems": 12,                              // 单次提交上限，防超长分支
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["node", "title", "text", "actors", "options"],
        "properties": {
          "node":    { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,32}$" },
          "title":   { "type": "string", "minLength": 1, "maxLength": 40 },
          "text":    { "type": "string", "minLength": 1, "maxLength": 800 },
          "actors":  { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
          "options": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["text", "effects"],
              "properties": {
                "text":    { "type": "string", "minLength": 1, "maxLength": 60 },
                "effects": { "type": "array", "items": { "type": "object" } },
                "goto":    { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,32}$" }
              }
            }
          }
        }
      }
    }
  }
}
```

**工具描述（`description`）只写这三件事**，不写槽 / 队列 / 池 / DAG / 调度权重（这些是引擎内部，见 §5）。

### 4.3 校验分层

| 层 | 位置 | 内容 | 失败处置 |
|---|---|---|---|
| **L1 结构** | agent-runtime 第 1 层（`validateToolCall`） | JSON Schema / Zod：必填、类型、长度、`node` 命名、`maxItems` | `invalid_arguments`（FATAL，不消耗重试） |
| **L2 引用闭合** | game-core `submitBranch` handler | `goto` 必须指向**本批内**的 `node`；`actors` 必须存在于 `state.npcs`；`effects` 必须在 `EffectSchema` 白名单内 | `unknown_reference` / `invalid_arguments`（**RETRYABLE**，回灌） |
| **L3 语义** | 同上 | `actors` 活性 / 在场；分支与当前视角一致性（player 视角不得引用 world-only 事实） | `precondition_failed`（**RETRYABLE**，回灌） |
| **L4 引擎** | 注册入 `generatedEvents` 时 | 与模板事件同一 `EventV2Schema` 校验；id 全局唯一；`settle` 至少 1 个选项 | 整体拒绝（RETRYABLE） |

**注入单位 = 一整条分支**（1..N 个事件块）。单事件是退化形态（`branch.length === 1`）。**不做跨提交补丁**：`goto` 只能指向本批内节点，指向本次提交之外的任何 id ⇒ 拒绝。

**两条提交配额硬约束**：

1. **跨提交完全独立**：同一 invocation 内多次提交的分支**互相独立**；跨提交的 `goto` 一律拒绝（与跨 invocation 同待遇，不因为是「同一轮写的」就放宽）。
2. **每次 invocation 上限 2 条**：第 3 条起 `rejected` + 记 `budget_exceeded`，**不注册**（防单轮刷出过多分支把队列撑满，见 §5.3.1 的队列瘦身理由）。

### 4.4 失败回灌契约

沿用既有分支①：回执 `rejected` + `code` + `factsHint` 作为 `tool` 消息回灌，模型重生成，最多 `budget.retryLimit`（默认 2）次。

- **超限**：作废本次 `story.submitBranch`（**不注册任何分支**），但**保留本轮已写的叙事正文**（`content.writeNarrative` 已进 trace），本次 invocation 仍可 `content.submit` 成功。
- **部分失败**：一条分支提交是**原子**的——任一节点失败则整条不注册，不允许「注册了一半」。

### 4.5 闸门：槽被占时给什么工具面

**闸门在下发（`LlmInvocation.tools`），不在调用时拒绝。**

| 槽状态 | 下发的工具面 | LLM 能做的 |
|---|---|---|
| **空** | `world.*`（读） + `content.writeNarrative` + `story.submitBranch` + `content.submit` | 正常导演：写叙事 + 提交未来分支 |
| **被占（normal / random 待决）** | `world.*`（读） + `content.writeNarrative` + `content.submit`（**无 `story.submitBranch`**） | 只给当前这场补血肉 |
| **被占（combat）** | ——（**不唤起 agent**） | 战斗不走 turn 管线 |

> 为什么闸门在下发而不是调用时拒绝：**结构上让模型没有这个能力**，比「给了工具再拒绝」更干净——后者会诱导模型反复尝试、烧预算。engine 侧仍保留一道廉价 precondition（槽被占时 `story.submitBranch` ⇒ `slot_occupied`）作为纵深防御，但正常流程下**永不应触发**，测试应断言它从未触发。

---

## 5. 引擎侧映射（**不出现在 LLM 工具面**）

> 本节全部是引擎规则。LLM 侧**不感知**槽、队列、候选池、DAG、调度权重；它只知道「怎么触发、事件是什么、完整编排是什么」。

### 5.1 分支编译：一条分支 → 一组 `EventV2`

`submitBranch` 的每个 block 编译成一个 `EventV2`（与模板事件**完全同形**）：

| LLM 字段 | 编译到 `EventV2` |
|---|---|
| `node`（局部 id） | `id = gen:<invocationId>:<node>`（**引擎分配全局 id**） |
| `title` / `text` | `title` / `narrative` |
| `actors` | `generatedActors: Perspective[]`（新字段，见 §6；不编译进 `trigger`） |
| `options[].text` | `settle.normal.options[].text`；`id = opt-gen-<seq>`（**引擎分配**） |
| `options[].effects` | `settle.normal.options[].effects` |
| `options[].goto` | `settle.normal.options[].nextEventId`（映射成全局 id；无 `goto` ⇒ 省略） |
| `trigger.mode = "certain"` | `trigger = { source: "schedule", window: { start: { value: 0, unit: "minute" } }, conditions }` |
| `trigger.mode = "random"` | `trigger = { source: "pool", weight: <引擎默认>, conditions }` |

> `window.start` 是 `TimeSpec`，**不是裸数字**；写成裸 `0` 会被 `TimeSpecSchema` 拒。
> `enqueueScheduled`（`scheduler.ts:113`）以 `state.worldTime` 为基准**一次性换算成绝对分钟**
> ⇒ `start = { value: 0, unit: "minute" }` 就是「**入队即到期**」，**不是**「世界时间 0」。

### 5.2 存放：`WorldStateV2.generatedEvents`

```ts
// shared/v2-state.ts（schemaVersion 5）
generatedEvents: z.array(EventV2Schema),   // 追加式；与模板事件同 schema
```

- **追加式**：一旦注册不再修改（「不能再在已有 DAG 打补丁」同一条纪律）。
- `TemplateLookup.event(id)` 先查 `generatedEvents`，再查模板——**调度器完全无感知**，它拿到的 `EventV2` 与模板事件一模一样。
- 因此：**同一触发词汇表**（`ConditionSchema`）、**同一调度器**（`enqueueCandidate` / `scanDelayQueue`）、**同一队列**（`delayQueue`）、**同一呈现槽**（`slot`）。生成事件不是「第二套系统」，而是「运行时追加的静态事件」。

### 5.3 注册与调度

| `mode` | 注册 / 调度路径 |
|---|---|
| `certain` | 每回合边界，对每条「条件已满足、且尚未入队/未触发」的生成事件调用 `enqueueCandidate({ origin: { kind: "generated", id } , preGated: true })` ⇒ 直接进 `delayQueue`，随即被 `scanDelayQueue` 按序取出占槽 |
| `random` | 作为 pool 候选；每回合 pool 抽取阶段（既有 `enqueueCandidate` 路径，`origin.kind: "pool"`）按权重参与抽取 ⇒ 抽中即入队 ⇒ 后续同上 |

- `EventInstanceOrigin.kind` 需新增 `"generated"`（封闭枚举，属协议变更，随 schemaVersion 5 落地）。
- **两套调度不存在**：生成事件与模板事件在 `delayQueue` 里是同一种东西，排序键 `start → hasEnd → end → enqueueSeq` 一视同仁。
- **重复防止**：`once` 语义 + 入队幂等（同一 `definitionId` 已在 `waiting` 不重复入队）；引擎内部消化，LLM 不感知。

#### 5.3.1 硬要求：`certain` 必须在 `enqueueCandidate` 之前判条件（不可协商）

只有「条件**当前成立**、且该 `definitionId` 尚无 `waiting` 实例」时才调用
`enqueueCandidate({ origin: { kind: "generated", id }, preGated: true })`。
编译出的 `trigger.conditions` 可以在扫描期再判一次（纵深防御），但**不得成为唯一判据**。

**为什么不能「先入队再 hold」**（机制已按 `turn.ts:582-595` 核实）：

- `countPresentableQueue`（A2'）只数「当前可上桌」的 `waiting`；前提不成立的实例**不进分子**（`turn.ts:591` 直接 `continue`）。所以「一条永远不满足条件的分支压住池」**不成立**——它压根不被计入。
- 真正的压制边是**多条条件已满足的 `certain` 同时躺在队列里**：它们全部计入 `presentable`，撞到 `maxQueueLength`（默认 3）就停摇 ⇒ 世界静默地「没有随机事件了」，症状是「随机事件变少」，没人会想到是这几条分支干的。
- 所以：`certain` 实例按 `definitionId` **去重**（一个 `waiting` 至多一个），并**在入队前先判条件**。

**第二条理由：队列要瘦（rng 顺位）**
`countPresentableQueue` 每轮只建**一条** rng 流，`checkEventPremise` 按 `sortScheduled` 全序**顺序消费骰值**。每多一条 `waiting` 实例、且其条件含 `random`，后面的骰值就整体后移一位 ⇒ **加一条分支会改变下游所有随机结果**。这**不是**不确定性（同 state 同 seed 仍可复现），而是结构性的；但必须记一笔，免得以后有人在「为什么加了一条分支之后随机事件全变了」上浪费一天。

### 5.4 槽状态如何决定工具面

`core` 在产出 `LlmInvocation` 前读 `state.slot`：

```
slot === null                     → 工具面 = 空槽版（含 story.submitBranch）
slot.from ∈ {successor,queueTake,opening,death,hook} 且 battle === null → 工具面 = 被占版（无 story.submitBranch）
battle !== null（combat）          → 不唤起 agent（不产出 invocation）
```

这一步在 `game-core/v2/turn.ts` 的 `runSettlementHooks` 里，与既有 `rules.llmTriggers` 求值同处。

---

## 6. 诈尸防线

### 6.1 问题

LLM 生成分支时，场景里那个 NPC 可能：① 已死；② 已离场（不在场）。等分支真的被调度上桌时，玩家会看到「死人说话」。旧模型靠 `missWhen` 兜底或事务边界硬抗，都是「事后补救」。

### 6.2 引擎保证（不靠 LLM 写守卫）

1. **声明**：LLM 在 block 里声明 `actors`，引擎编译为 `EventV2.generatedActors`（**不编译进 `trigger.conditions`**，因为那是 LLM 可控的表面）。
2. **复核**：生成事件出队时（`scanDelayQueue` → `evaluateDue`），引擎在既有 `checkEventPremise` 之后追加一条**隐式前提**：`generatedActors` 中任一角色已死 / 不在场 ⇒ 前提不成立。
3. **处置**：失败即 `drop`（记错失，`reason: "miss_when"`，`label` 由引擎生成，如「某角色已不在场」）。**不 hold**——角色死了不会复活（复活是显式的世界事件，不走这条路径）。
4. **模板事件不套用**：`generatedActors` 只对生成事件存在；模板事件的作者自己声明 `missWhen`。

### 6.3 分层

| 时机 | 检查 | 失败 |
|---|---|---|
| L3 校验（提交时） | `actors` 是否活着 / 在场（**尽力**，提交时可能还在） | `precondition_failed`（RETRYABLE） |
| 出队终判（呈现前） | 同上（**权威**，此时代入的是**当前**状态） | `drop`（miss_when） |

提交时的检查是「早失败、少浪费」，呈现前的是「权威」。两者都执行，不是二选一。

---

## 7. 删除清单

> 每一项的共同理由：**它们给了 LLM 直接动引擎结构的口子，正是被禁止的东西。**

| 符号 / 文件 / 行为 | 位置 | 为什么删 |
|---|---|---|
| `fact.enqueueEvent` | `game-core/api/engine-api.ts` + `agent-runtime/tool-registry.ts` | 让 LLM **直接往 `delayQueue` 塞事件**（`enqueueScheduled` 绕过 `once` 门控），是「closing↔chance 无限交替」事故的根因 |
| `fact.advanceDag` | 同上 | 让 LLM **整份覆盖 `taskDag`**，会静默丢掉它没看见的 guards/edges |
| `fact.upsertDagBranch` | 同上 | **往已有 DAG 上打补丁** = 「在已有完整结构上做增量改写」，正是「链式不可以」禁止的 |
| `content.writeOption` | `game-core/api/engine-api.ts` + `agent-runtime/tool-registry.ts` | 选项不该由 LLM 在叙事流里单独写；选项属于**事件块的 settle**，由事件区渲染 |
| `OptionDeck` 组件 + 叙事流选项渲染 | `rpg-ui/OptionDeck.tsx`、`rpg-ui/NarrativeStream.tsx`、`rpg-ui/index.ts`、`apps/web` | 与上一条同源：选项归事件面板，叙事区不再渲染可点块 |
| ADR-0038 `branchEventIds` | `shared/llm-invocation.ts`、`agent-runtime/context.ts`、`agent-runtime/loop.ts`、`game-core/api/engine-api.ts`、`context.ts` | 白名单机制是「只允许摆模板已有事件」的补丁；新模型下「提交整条分支」取代它，白名单无意义 |
| `LlmContext` 的 `facts` / `secrets` / `recentTurns` / `contextHints` | `shared/contract/llm-invocation.ts` | 这些是「core push」，新模型是「agent 自己查」；留着会让 prompt 双份、且削弱读工具语义 |
| `buildStablePrefix` 的 `# 工具与参数` 段 | `agent-runtime/context.ts` | 工具 schema 已作为 FC `tools` 下发，双份只烧 token |
| `BRANCH_PROMPT_LEAD` 引导语 | `agent-runtime/loop.ts` | 依附于 `branchEventIds`，随之删除 |

**保留**：`content.writeNarrative`（本轮叙事）、`content.submit`（终止信号）、`content.writeFlavor` / `content.referenceAsset`（风味 / 媒体锚点，只写 trace 不改结构）、`content.writeMemory`（**保留**，已核实只 `sink.append`、零结构写入，见 §11-6）。

---

## 8. 确定性 / 存档 / 回放

### 8.1 生成编排落在哪里

`WorldStateV2.generatedEvents: EventV2[]`（追加式）。它进存档，与 `delayQueue` / `slot` / `flags` 同级。**不落 trace**（trace 是叙事正文与调用取证的落点，不是剧情结构）。

### 8.2 `schemaVersion`

**升 5**。破坏面：`WorldStateV2` 新增必填字段 `generatedEvents`；`EventInstanceOrigin.kind` 新增 `"generated"`；`EventV2` 新增可选 `generatedActors`。旧 v4 档拒载（与既有「v3 档拒载」同一条路径）。

### 8.3 从快照能否复现

**能**。给定「同一快照 + 同一 seed + 同一后续指令序列」，`generatedEvents` 已落盘，调度完全确定性（无 `Date` / `Math.random`，`instanceId` 由 `enqueueSeqCounter` 派生），呈现槽由 `scanDelayQueue` 按全序取出。回放 = 重跑 turn 管线，不重跑 LLM。

> **边界（必须同时满足）**：快照复现的前提是 `generatedEvents` **与** `delayQueue` **同时进档**。
> 只落 `generatedEvents` 不落 `delayQueue`，队列里已排的实例就丢了，时序无从复现；
> 只落 `delayQueue` 不落 `generatedEvents`，被引用的 `definitionId` 在 `lookup` 里查不到（定义缺失）。
> **只进一个都不能复现。**

### 8.4 从 seed + 指令能否复现

**不能，且不追求能**。原因：LLM 输出是**非确定性**的（temperature > 0 时同 prompt 不同分支），「指令」是自然语言，不是种子。设计上的确定性边界是：

> **一旦 LLM 的产出被 `story.submitBranch` 接受并落进 `generatedEvents`，往后的一切都是确定性的。**

所以「可复现」的定义是「从**已提交的存档**复现」，不是「从 seed 复现 LLM 的创意」。这也是为什么 `generatedEvents` 必须进存档——它是「LLM 的确定性化投影」。

---

## 9. 实施拆分

> 依赖方向 `shared → game-core → agent-runtime → rpg-ui → apps/*`。同一包内标「串行」的必须按序；跨包标「硬依赖」的前置未完成不能开工。

### 9.1 `packages/shared`（全部串行，其余包硬依赖本组）

| # | 任务 | 产出 |
|---|---|---|
| S1 | 新增 `GeneratedEventV2` 字段 `generatedActors?`；`EventInstanceOrigin.kind` 加 `"generated"` | `schema/event.ts`、`v2.ts` |
| S2 | `WorldStateV2` 加 `generatedEvents: EventV2[]`；`SCHEMA_VERSION` 5 | `v2-state.ts`、`apps/server/store.ts` |
| S3 | `LlmContext` 收缩为 `{ stablePrefix, invocationReason }`；删 5 字段 | `contract/llm-invocation.ts` |
| S4 | 新增 `SubmitBranchArgsSchema`（§4.2 的 Zod 版）与读工具返回 schema | `contract/submit-branch.ts`、`contract/read-tools.ts` |
| S5 | 删 `branchEventIds` 关联字段 | `contract/engine-api.ts`、`contract/llm-invocation.ts` |

### 9.2 `packages/game-core`（S1–S5 完成后）

| # | 任务 | 硬依赖 |
|---|---|---|
| G1 | 删 4 个 `fact.*` handler + `content.writeOption` handler；收敛 `defaultToolRegistry` | S5 |
| G2 | 新增 `story.submitBranch` handler：L2/L3 校验 → 编译 `EventV2[]` → 追加 `generatedEvents` | S1/S2/S4 |
| G3 | `TemplateLookup.event()` 加 `generatedEvents` overlay（生成事件优先） | S2 |
| G4 | 新增 5 个读工具 handler（`world.now/history/present/self/clues`），内部走 `buildFacts` | S4 |
| G5 | `runSettlementHooks`：`certain` 分支注册 + 槽状态 → 工具面选择 | S2、G3 |
| G6 | `evaluateDue`/`checkEventPremise`：生成事件 `generatedActors` 隐式前提 | S1 |
| G7 | 删除 `enqueueEvent` 的 `branchEventIds` 白名单分支 | S5 |

### 9.3 `packages/agent-runtime`（G1/G2/G4 后）

| # | 任务 | 硬依赖 |
|---|---|---|
| A1 | `tool-registry.ts` 重写工具表：5 读 + `content.writeNarrative` + `content.submit`（+ flavor/asset）+ `story.submitBranch`；删旧 5 个 | G1/G2/G4 |
| A2 | `context.ts`：删 `# 工具与参数` 段、删 `facts`/`recentTurns`/`branchEventIds` 注入；`buildLlmContext` 只填 `stablePrefix`+`reason` | S3 |
| A3 | `loop.ts`：删 `BRANCH_PROMPT_LEAD`、删 `branchEventIds` 的 dispatchCtx 注入 | S3/A2 |
| A4 | 更新 mock provider：不再「摆事件」，改为「提交一条最小分支」 | A1 |
| A5 | 全量 `.min.test.ts` 重写（工具面、stablePrefix 字节稳定、读工具裁剪） | A1–A4 |

### 9.4 `packages/rpg-ui`（可并行于 9.2/9.3 的删除项）

| # | 任务 | 硬依赖 |
|---|---|---|
| U1 | 删 `OptionDeck.tsx` + `index.ts` 导出 | 无（可先删） |
| U2 | `NarrativeStream.tsx` 删 `option` 块渲染分支 | U1 |
| U3 | 事件面板改为渲染 `settle.options`（服务端下发） | 后端事件投影就绪 |

### 9.5 `apps/web` / `apps/server`（最后）

| # | 任务 | 硬依赖 |
|---|---|---|
| W1 | `apps/web` 删 `OptionDeck` 引用、接线事件面板 | U1–U3 |
| W2 | `apps/server`：`SCHEMA_VERSION` 5、v4 档拒载路径、`generatedEvents` 随存档落盘 | S2 |
| W3 | 端到端「能跑」联调（§10） | 全部 |

### 9.6 并行 / 串行总览

- **可并行**：9.4（U1/U2）与 9.2/9.3 无强依赖，可先动手。
- **必须串行**：S1 → S2 → S3/S4/S5 是其余一切的前置；G2 依赖 S1+S2+S4；A1 依赖 G1+G2+G4。
- **硬卡点**：`G3`（lookup overlay）不做完，`story.submitBranch` 提交的分支**永远调度不上桌**——这是「能跑」的门槛项。
- **C2（compact）**：依赖 C1（`generatedEvents` + 分支调度）与事务边界就位，**独立排期，不并入 C1**。

### 9.7 C2：压缩记忆 compact（**不并入 C1**）

| # | 任务 | 硬依赖 |
|---|---|---|
| C2-1 | `shared`：`WorldStateV2` 加 `compact`（§2.5.1）；`LlmContext` 加 `priorSummary?`（§2.5.7）；新增 `story.commitCompact` args schema | S2、S3 |
| C2-2 | `game-core`：`story.commitCompact` handler（写 `state.compact`，同一事务）；轮次阈值触发（`turnIndex - coveredThroughTurn >= 12`）产出 compact invocation | G2、事务边界 |
| C2-3 | `agent-runtime`：compact 专用工具面（只有 `story.commitCompact` + `content.submit`）；`context.ts` 注入 `# 前情` 段（stablePrefix 之后、查询结果之前） | A1、A2 |
| C2-4 | `game-core` / `agent-runtime`：断言摘要**不参与任何判活 / 写操作**（§2.5.6 硬规则）——`actors` 复核仍以权威状态为准，加一条回归测试 | C2-2、C2-3 |

> **排期约束（team-lead 明文）**：C2 **不得塞进正在跑的 C1**。C1 = `generatedEvents` + 分支调度；C2 依赖 C1 与事务边界同时就位。

---

## 10. 验收口径

> 用户会亲自跑一遍验收。以下每条都是「可观察的行为」，不是「代码存在」。

### 10.1 最低「能跑」（用户验收线）

1. **开局能玩**：创建世界 → 第一次推进 → 看到叙事正文（不报错、不空白）。
2. **GM 能查世界**：一次 invocation 里，agent 至少调用过 1 个读工具，且返回内容**只有本视角可见**（world 视角能查到的 hidden，player 视角查不到）。
3. **GM 能写叙事**：叙事正文出现在前端，刷新后**不消失**（trace 落盘 + `traceRef` 可定位）。
4. **GM 能提交分支**：一次 invocation 里 `story.submitBranch` 成功，`state.generatedEvents` 增加 ≥1 条，且新事件 `id` 以 `gen:` 开头（引擎分配，不是 LLM 造的）。
5. **分支能上桌**：提交的分支在后继回合被调度进 `slot` 并**渲染出来**（这是 `G3` overlay 的验收点）。
6. **不能越界**：player 视角调用读工具查 hidden 内容，**查不到**（不是「查到但被掩码」）；槽被占时工具面里**没有** `story.submitBranch`。
7. **诈尸被拦**：提交一条 `actors: ["npc:x"]` 的分支，随后让 `npc:x` 死亡，该分支出队时**被 drop**（记 missedEvents），前端不出现「死人说话」。

### 10.2 质量线（非阻塞，但应达标）

8. 同一世界同视角两次 invocation 的 `stablePrefix` **逐字节相同**（prompt cache 可命中）。
9. 一次完整回合的 LLM 输出**不出现**任何 `fact.*` 工具名（旧口子已删）。
10. `story.submitBranch` 失败超限 ⇒ **不注册任何分支**，但本轮叙事正文**仍在**（作废只废编排，不废叙事）。
11. 前端**没有** `OptionDeck`、叙事区**没有**可点选项块；选项全部来自事件面板。

### 10.2.1 已知不做（用户验收时请勿当 bug 报）

- **生成事件不支持 `kind: "combat"`**：`story.submitBranch` 在 v1 只产 `normal` 事件。战斗不走 turn 管线；生成的战斗需要另接一套结算，不在本轮范围。看到「AI 生成的分支里没有战斗」是**预期行为**。

### 10.3 回归线

12. 不传 `gateway` / `rules` ⇒ turn 管线**逐字段不变**（既有零回归不变量）。
13. `pnpm typecheck` 0 error。

---

## 11. 裁决结果（原 8 个待裁点，team-lead 已全部裁定）

> 2026-11-16 全部按下列结论生效，实施按此执行；本表从「待裁」转为「已裁」，作为实现依据。

| # | 裁点 | **裁决** | 理由 / 备注 |
|---|---|---|---|
| 1 | `mode: "random"` 的权重 | **引擎默认**（按 branch 长度反比），LLM 不指定 | 权重是「引擎节奏」，属 LLM 不该感知的调度参数 |
| 2 | 生成事件是否允许 `kind: "combat"` | **v1 不允许**，只产 `normal` | 战斗不走 turn 管线；生成的战斗需另接结算，超本轮。已写入 §10.2.1「已知不做」 |
| 3 | `generatedEvents` 存哪 | **进 `WorldStateV2`，schemaVersion 4→5**；不做模板 overlay | 不进档就没法刷新续玩、没法回放；旧档拒载是既定代价（用户已确认接受） |
| 4 | `world.history` 缺省 all 的硬上限 | **50 条**，且返回体必须带 `returned / total / truncated` | 模型必须知道「还有更早的」，否则误判世界很空（§3.2.2） |
| 5 | 诈尸 drop 的 `reason` | **复用 `miss_when`** + 引擎生成 label，**不新增** `actor_absent` | `MissReason` 是封闭枚举，新增会扩散到前端 / 存档 / 诊断，成本高于收益 |
| 6 | `content.writeMemory` 是否保留 | **保留** | 已核实：只 `sink.append`、对 `WorldStateV2` 零结构写入，不违硬线 |
| 7 | 读工具是否合并 | **不合并** | §3.3「单语义」判据；合并即半个上帝函数，不让步 |
| 8 | 一次 invocation 能否多次 `story.submitBranch` | **能，每次一条，上限 2 条** | 多条 = 多次提交（非一次超长分支）；跨提交 `goto` 一律拒；第 3 条起 `budget_exceeded`（§4.3） |

**追加的两条硬要求（主理人裁定，已并入正文）**：
- `certain` 必须在 `enqueueCandidate` **之前**判条件 + `definitionId` 去重（§5.3.1，不可协商）。
- 快照复现要求 `generatedEvents` 与 `delayQueue` **同时进档**（§8.3）。

---

## 附：与旧文档的关系

- `docs/REFACTOR-DESIGN.md`（v2）→ **历史材料**。它的「agent-runtime = 被喂快照后一次性输出」模型被本文档取代；它的窗口 / trace / 槽 / 调度部分仍是有效现状描述，可作排查参考。
- `docs/DECISIONS.md`（4000+ 行）→ **归档**。本文档不引用、不依赖；用户已裁决验收后重新计数。
- `AGENTS.md` 的四件套门禁 → **本轮不适用**。

---

*本文档是唯一交付物；实现由 team-lead 拆任务后分派。*
