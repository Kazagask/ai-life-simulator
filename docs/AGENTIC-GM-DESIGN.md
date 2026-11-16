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
] }
```

**裁剪规则**：只回**本视角可见**的历史条目；`hidden` 事件不进历史；`summary` 是已落账的可见摘要，不是原文重放。

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
| `trigger.mode = "certain"` | `trigger = { source: "schedule", window: { start: 0 }, conditions }` |
| `trigger.mode = "random"` | `trigger = { source: "pool", weight: <引擎默认>, conditions }` |

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

**保留**：`content.writeNarrative`（本轮叙事）、`content.submit`（终止信号）、`content.writeFlavor` / `content.referenceAsset`（风味 / 媒体锚点，只写 trace 不改结构）、`content.writeMemory`（**待裁**，见 §11）。

---

## 8. 确定性 / 存档 / 回放

### 8.1 生成编排落在哪里

`WorldStateV2.generatedEvents: EventV2[]`（追加式）。它进存档，与 `delayQueue` / `slot` / `flags` 同级。**不落 trace**（trace 是叙事正文与调用取证的落点，不是剧情结构）。

### 8.2 `schemaVersion`

**升 5**。破坏面：`WorldStateV2` 新增必填字段 `generatedEvents`；`EventInstanceOrigin.kind` 新增 `"generated"`；`EventV2` 新增可选 `generatedActors`。旧 v4 档拒载（与既有「v3 档拒载」同一条路径）。

### 8.3 从快照能否复现

**能**。给定「同一快照 + 同一 seed + 同一后续指令序列」，`generatedEvents` 已落盘，调度完全确定性（无 `Date` / `Math.random`，`instanceId` 由 `enqueueSeqCounter` 派生），呈现槽由 `scanDelayQueue` 按全序取出。回放 = 重跑 turn 管线，不重跑 LLM。

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

### 10.3 回归线

12. 不传 `gateway` / `rules` ⇒ turn 管线**逐字段不变**（既有零回归不变量）。
13. `pnpm typecheck` 0 error。

---

## 11. 待裁

> 以下点我拿不准，按 team-lead 指示写进文档而不停下来等。默认取「本文件已写的方案」，如需改动请回信点名。

| # | 待裁点 | 我的建议 | 理由 |
|---|---|---|---|
| 1 | `mode: "random"` 的权重由引擎默认给，还是 LLM 可指定 `weight`？ | **引擎默认**（按 branch 长度反比），LLM 不指定 | 权重是「引擎节奏」，属 LLM 不该感知的调度参数 |
| 2 | 生成事件是否允许 `kind: "combat"`？ | **v1 不允许**，`story.submitBranch` 只产 `normal` 事件 | 战斗不走 turn 管线（用户已定），生成的战斗需要另一套结算接线，超出本轮 |
| 3 | `generatedEvents` 进 `WorldStateV2`（schemaVersion 5）还是做模板 overlay？ | **进 `WorldStateV2`，升 5** | 要能刷新续玩、要能回放；overlay 不进档就没法复现 |
| 4 | `world.history` 的 `limit` 缺省 all 的硬上限 | **50 条** | 防超长 prompt；模型要更多可分多次查 |
| 5 | 诈尸 drop 的 `reason` 用 `miss_when` 还是新增 `actor_absent`？ | **`miss_when`**（label 由引擎生成） | `MissReason` 是封闭枚举，新增会扩散到前端 / 存档 / 诊断；label 已能表达原因 |
| 6 | `content.writeMemory` 是否保留？ | **保留** | 它只写 trace 的记忆块，不改结构，不违反任何硬线；删了 NPC 记忆就没了 |
| 7 | 读工具是否合并（如 `world.now` + `world.history` → `world.timeline`）？ | **不合并** | §3.3「单语义」判据；合并会造出半个上帝函数 |
| 8 | `story.submitBranch` 一次 invocation 能否调用多次？ | **能，但每次一条分支** | 多条分支是多次提交，不是一次超长分支；与「注入单位 = 一整条分支」一致 |

---

## 附：与旧文档的关系

- `docs/REFACTOR-DESIGN.md`（v2）→ **历史材料**。它的「agent-runtime = 被喂快照后一次性输出」模型被本文档取代；它的窗口 / trace / 槽 / 调度部分仍是有效现状描述，可作排查参考。
- `docs/DECISIONS.md`（4000+ 行）→ **归档**。本文档不引用、不依赖；用户已裁决验收后重新计数。
- `AGENTS.md` 的四件套门禁 → **本轮不适用**。

---

*本文档是唯一交付物；实现由 team-lead 拆任务后分派。*
