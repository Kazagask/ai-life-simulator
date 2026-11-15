# 事件流拓扑与模板作者层（讨论沉淀）

> **状态**：2026-11-15 会话的分析与设计笔记，**不是裁决、不是现行约束**。
> 需要拍板的部分已移到 `docs/OPEN_QUESTIONS.md` #50 / #51；落地登记见 `docs/BACKLOG.md` B-26。
> 本轮只做只读核对，**未改任何代码、模板、协议或 spec**。
> 来源：围绕「LLM function call 能否给世界加事件」「模板写法能否简化」「事件流到底是什么形状」的连续讨论。

---

## 1. AI 介入与回放一致性：约束的是输入，不是调用者

`specs/core/GAME_RULES.md` 的不变量是「同初始状态 + 同输入 + 同 seed ⇒ 相同结果」；`packages/game-core/src/v2/replay.ts` 的 `ReplaySpec = { seed, playerName, worldId, template, commands[] }` 是纯函数重建。引擎入口 `advanceTurnV2(state, command, ...)` 不问输入出处，人类点击也只是把 body 变成一条 command。

因此：**LLM 的 tool call 只要被服务端翻译成一条同形命令、记进 `commands[]`，重放时直接喂这条命令而不再调模型，就一致**。非确定性来自「重放时又问了一次 LLM」，不是「曾经问过 LLM」。唯一真实差别是时序——LLM 有超时/重试/乱序，所以正确形态是「轮外异步产提案 → 服务端在一个明确提交点转成一条输入」，不是让 LLM 持写接口。

两层澄清：

- 生产存档按 ADR-0007 存**完整 `WorldStateV2` 快照**，`apps/server/src/store.ts` 里没有命令日志。LLM 注入的事件只要写进 state，读档不会丢；会丢的是 `replay()` 这个开发期属性测试（它只从 `commands[]` 重建）。「破坏回放一致性」常把这两层混在一起。
- 「能重放」是**必要条件，不是充分条件**。极端反例：让 LLM 每轮吐一整份 `WorldStateV2`、记成一条 `replace_state` 命令，回放 100% 一致，但 `game-core` 退化成 JSON 播放器——重现的是录像，不是模拟。把输出记成输入只是用「记录」换「确定性」。

判据换成三问：**产物落在哪一层 / 谁裁决「发生什么」 / 失败时能否诊断与回退**。

## 2. 三层边界（把讨论收敛成一条不变量）

| 层 | 内容 | AI 可写性 |
|---|---|---|
| 配置层 | yaml 模板、事件定义、effect DSL、章节拓扑、结局判据 | 不可写（OQ #46 已裁「不做」运行时生成定义；`GAME_RULES.md` §8 YAML 唯一模板源、加载期 fail-fast） |
| 实例层 | 本局活对象：事件实例、NPC 实例、窗口、参数 | 可**提议**：只引用模板已有 `eventId`，由规则层裁决 |
| 事实层 | append-only 历史 / 错失 / 证据 | 不可写 |

一句话：**LLM 可以提议，不能裁决，也不能进配置层**。`AGENTS.md` §1、`GAME_RULES.md` §9（AI 只产候选行动 / 事件草案 / 叙事文本）、`CORE_ENGINE.md` §7（`source: AI-proposed`、草案须过 schema 与规则校验）本来就是这个意思；ADR-0027 否决的是「LLM 写权威状态 / 决定评分 / 把 LLM SDK 引入 game-core / 进 turn 管线」，没有否决 function call 本身。

`packages/shared/src/schema/event-instance.ts` 明确「实例不复制配置域字段」，判定回 `lookup.event(definitionId)` 读定义现值 ⇒ 项目里是**引用型实例**（指针 + 参数）。ADR-0022 决策 0 的三条越界判据（不参与模板指纹 / 不占配置层主键空间 / 不可被模板按 id 引用）可直接用来判 LLM 提案：「从模板池里选一批 definitionId 排好序」合法；「给实例塞自定义叙述、选项、效果」则绕过加载期引用完整性校验（属性键 ⊆ `attributes.order`、effect preset 白名单），虽叫实例，语义上是定义。

「调用规则层的规则」≠「决定调用哪条规则」。要让 AI 按框架填主线，得先把骨架（章节槽位数、每槽候选池、槽间条件、结局判据）写进模板——这一步本身是配置层改造。

## 3. 副本 / 任务：不是一等公民，是作者层编排

`packages/shared/src/schema/` 里没有 `quest` / `dungeon` / `mission`。现有两套模板全靠 flag + hook + 注释手搓：三国「虎牢关」是 9 个 `ev-war-*` 事件 + 4 个 `action-hook` + 四套 flag + 开头 19 行注释（其中三条是「约束核对」）；咒术「委托」的 `missionsCompleted` 计数散落在 10 处。

**副本和任务没有运行时表示**，只有一个作者层的名字和一条展开规则。产物仍然只有事件 + flag + `conditions` + `nextEventId`——本来就是引擎的一等公民。所以 `WorldStateV2`、存档信封、`ReplayCommand`、Zod schema、`game-core`、投影全不用动，回放与确定性自动成立。

省掉的是运行时，成本全压到编译期展开的正确性上：没有「当前副本」可查询；局部 flag 只是编译期 mangle，运行时仍平铺；单槽不变；**漏一条出口就永久劫持自由行动**（所以胜/败/撤/超时必须全部收敛到 exit 且清干净局部 flag，是硬检查）。那 19 行注释里的约束，正是手写编排时人肉承担的编译期责任。

## 4. 保持 YAML：作者区 + 加载期展开

不需要换 `.life` 自定义语言，也不需要换文件格式。`apps/server/src/templates.ts` 现在是「8 文件逐个 parse → 按 key 合并 → 一次性 `WorldTemplateV2Schema.parse()`」。只加一步：parse 后把 `x-*` 作者键摘出不进 `merged`，合并完交给纯函数 `expand()` 展开成标准字段，再 Zod parse。**Zod 看不到任何新键，strict 严格性完整保留。**

```yaml
# events.yaml —— 文件名、后缀、目录、8 文件分域全不变
x-defaults:
  era1-pool:
    trigger: { source: pool, priority: 10 }
    conditions:
      - { flag: creationDone, eq: true }
      - { flag: era, eq: 1 }

x-dag:
  creation:
    order: [ev-w01, ev-w02, ev-w03, ev-w04, ev-w05]
    edges:
      - { from: ev-war-duel, victory: ev-war-close }
      - { from: ev-war-duel, defeat:  ev-war-close }
    entries:
      - { at: ev-opening-wheel, via: startChain, chain: chain-creation }
    terminal: [ev-war-close]

events:                       # 标准区一个字段没改
  - id: ev-war-timeout
    ...
```

三个必须先处理的坑：

1. **YAML 锚点跨文件失效**——8 个文件分别 parse，锚点作用域是单个文档，所以默认值共享必须走 `x-defaults` + expand。
2. **`x-*` 必须在合并前摘掉**；`templates.ts` 合并逻辑对同名非数组 key 是静默丢弃，作者区重名会无声消失，得改成显式报错。
3. **展开后要有源映射**——`x-dag.creation.order[4]` 变成 `events[42]` 后，Zod 报错得指回前者。`yaml` 包有 AST range，expand 维护映射表即可。

另外，模板指纹目前取**原始 yaml 文本**的 sha256（`apps/server/src/templates.ts`）。作者区一出现，哪怕展开后语义完全等价，旧档照样全部拒载（ADR-0007 既定代价）。若要避免误伤，需把指纹改为对展开后的 canonical IR 取 hash——那是存档契约变更，属 T-2。

## 5. 纯结构化 YAML 优于 string DSL（针对 AI 生成）

`reputation += 2` / `when a and not b` 这类字符串手感更好，但对 AI 生成更差，理由不是「简单 vs 好读」，而是**约束发生在哪一步**：

- 结构化字段能导出成 JSON Schema 交给 function call，生成前就约束住 `type` 枚举、`attribute` ∈ `attributes.order`、`npcId` ∈ 声明表。字符串在 schema 里只能是 `{"type":"string"}`，全部约束退化成 prompt 描述，错误要等服务端 expand 才发现。
- YAML/JSON 配置是模型高分布形态；项目私有记法零样本，会自由发挥成 `++`、中文运算符、混入注释。
- 结构化能按 key 做局部 patch，字符串要整行重写，容易带坏相邻语义。

而且字符串 DSL 想省的那部分本来就不是压缩收益来源：约 41% 是结构骨架、约 10% 是叙事文本、effect 项约 19%；骨架靠 `x-defaults` / `x-dag` / `x-activity` 整块吃掉，不需要写任何语法解析器。若将来给人类加紧凑记法，必须满足：仅 `x-*` 区内允许、展开后 IR 零字符串、严格白名单 grammar 且拒绝即报错不做兜底。AI 通道（`capabilities` / function call）只导出结构化形态。

## 6. 事件流拓扑实测：是 DAG，不是链、不是树、不是带环图

用 `apps/server/node_modules/yaml` 解析两套 `events.yaml`，递归抽取全部 `nextEventId` 建图（2026-11-15 实测）：

| | jjk-2006 | sanguo-2010 |
|---|---|---|
| 事件节点 | 109 | 88 |
| 唯一跳转边 | 93 | 95 |
| 入度 0（入口） | 33 | 22 |
| 出度 0（终止） | 36 | 16 |
| 汇聚点（入度 ≥2） | 14 | 9 |
| 分支点（出度 ≥2） | 15 | 8 |
| 最长路径 | 12 边 | 11 边 |
| **环 / 断链** | **0 / 0** | **0 / 0** |

- 边的唯一来源是 `nextEventId`（含 option 级与 `onVictory/onDefeat/onFlee` 级）。`toId` / `to` 是关系 effect 的 NPC id，不是跳转；`startChain` 是入口。
- 全库 **448 处 `nextEventId` 写法只有 188 条唯一边**，58% 是同一条边被每个 option 各抄一遍。
- 唯一一条指向文件更早位置的边 `ev-war-timeout → ev-war-close` 是旁路入口汇入汇聚点，不回到自己的祖先，不构成环。`ev-war-close` 入度 6、`ev-tangdong-open` 入度 7。
- 「链」这个名不副实：`chains:` 全库只有 1 条（`chain-creation`，13 步纯线性），其余 147 个 `source: chain` 事件根本没有 Chain 状态机，只是 `nextEventId` 手工串起来的**多根 + 带标签边的 DAG**。

精确形状：**多根、带标签边的 DAG**。无环 ⇒ 存在拓扑序 ⇒ 「线性主干 + 例外边」的写法成立：`order` 给节点级默认后继，`edges` 只写带标签的分支/汇聚/旁路，`entries` 显式声明外部入口。硬要求：**不能从文件物理顺序推断拓扑**（timeout 那条即反例），必须由作者写 `order`、编译器验证它是合法拓扑序。

拓扑排序白送一批静态证明：环检测、断链、死端（出度 0 却没标 `terminal`）、真孤岛（入度 0 且无 `entry` 声明）、汇聚点前置条件一致性、可达性、最长路径下界（`playthrough.test.ts` 里绑死模板的「章节 ≥8」可换成骨架级断言）。对 AI 生成还可以更硬：tool schema 约束「新节点只能 `after: [已知节点]`、边只能指向拓扑序更靠后的节点」，让环在类型上不可表达。

## 7. 边界：定义图是 DAG，运行时轨迹不是

三类外部入口（`pool` 28 / `schedule` 15 / `action-hook` 7）能在任意时刻把玩家拉回图上任意节点，所以**运行时是 DAG 上的 walk**，节点会被重访。因此 `once` / 冷却 / 单槽一个都不能少，条件侧也压不掉——`common.ts` 的条件 DSL 只有数组 AND、无 OR/NOT/嵌套，「不好写」的根因是表达力缺口而非啰嗦，且隐式条件（`x-defaults` 继承、`x-activity` 自动带条件）必须配 `explain` 回显，否则变成新的两套真相。

副本里 `drill/consult/feast/rest` 能反复做，循环感来自 `action-hook` 入口，**不来自图上的环**。这给 §3 一个精确形状：副本 = 一块 DAG 子图 + 若干外部入口。

## 8. 落地分级（不是承诺，只是依赖顺序）

| 档 | 内容 | 契约面 |
|---|---|---|
| A · 工具链 | `templates:validate`（错误带文件名+行号、重复 id、断链） / `templates:schema`（Zod → JSON Schema + 白名单） / `templates:dump` / 合并层显式报错 | 零：不动 schema、不动 `WorldStateV2`、不动指纹、旧档不受影响 |
| B · 作者区 | `x-defaults` / `x-dag` / `x-activity` + `expand()` 纯函数 + 源映射 | 动 `apps/server` 加载期 ⇒ **T-2，须先 ADR** |
| C · 指纹 | 指纹从原始文本 hash 改为 canonical IR hash | 存档契约 ⇒ **T-2** |
| D · AI 通道 | 从能力标记导出 function-call tool schema，命令日志可重放 | 动 `ReplayCommand` / 存档 ⇒ **T-2** |

按 `AGENTS.md` §0.3 的判据：`git status` 里只有 `specs/data/templates/` ⇒ T-1 免 ADR；一旦动 `packages/shared` / `packages/game-core` / `apps/**` 的契约面 ⇒ T-2。上面 B/C/D 全部落 T-2。

**优先级建议先 A 后 B**：A 档对「人类 + AI」同时有效，糖主要帮人类；`docs/ENGINE_GAPS.md` 的复盘说明缺的是可发现性而非表达力；现在连「错在哪个文件哪一行」都没解决，先加糖只会让 AI 的错误更难定位。A 档跑起来后才能用真实数据回答「哪类重复最多、该做哪些糖」。

## 9. 仍未拍板（不得当作已定需求）

见 `docs/OPEN_QUESTIONS.md` #50（作者层是否实施、范围与优先级、指纹口径）与 #51（AI function call 产物边界与输入日志是否进生产存档）。本文档只记录分析，不代替裁决。
