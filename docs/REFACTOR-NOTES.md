# 重构笔记（2026-11-17）

> 这份文件**不是规格**，是新规格落地前唯一有效的"我们定过什么"的记录。
> 旧 `specs/` + `docs/` 已整体归档到 `archive/2026-11-16-pre-rewrite/`，**不构成任何约束**。
> 写入原则：只记用户裁决与已落地的代码事实；推断与候选一律标注。

---

## 1. 产品定位

- 一句话定义：**AI 驱动的 RPG 人生模拟**。
- 四层分工：
  1. **模板**给故事骨架（事件模板 / 生成规则 / 世界观 / 属性 / 人物），**要支持静态资源**（立绘、差分等）；
  2. **core** 定最底层通用 RPG 规则（世界 / 事件 / 人物 / 行动 / 评价）；
  3. **AI** 补血肉；
  4. **前端**可定制（低优先级，可先用默认实现，但组件要对应 core 的通用能力）。
- **交互权重：点击为主，打字输入为辅。** 玩家主要靠点选枚举选项推进；自由文本是兜底，折叠成「自由行动…」入口，不作主表面。
- **三项契约变更全部否决**：`statePolicy`（字段级因果表）、`lore`（关键词检索层）、`style`（模板级文风契约）都不做。外部参考项目只作**体验标尺**，不作架构输入。
- 参照物是「给一些简单剧本与主线时间，AI 自由发挥」的偏 RPG 酒馆游戏；但战斗 / 装备 / 评分 / 关系图这些是我们相对它的真资产，保留。

## 2. 工程流程裁决

| 裁决 | 状态 |
|---|---|
| 旧 spec / ADR / BACKLOG / 待决项 **整体归档作废** | 已落 `902319a`，全在 `archive/2026-11-16-pre-rewrite/` |
| **测试全删**，先把代码写好再谈测试 | 已落 `d422452`：42 个 `*.min.test.ts` + 38 个 `legacy-tests` + 6 个 vitest 配置清零 |
| 测试**单开 `test/` 目录**，npm 不打包测试代码 | 约定已写进 `test/README.md`；打包边界尚未真正生效 |
| 开发期**不管旧数据 / 旧资产 / 旧模板**，直接扔 | 有效 |
| **默认发线上**，验收通过不用再问 | 有效；必须复用 appId `wbapp_6BjykHXBJu8kLx2VWyxeie`，否则云服务 Origin 失配 |
| **新 spec 的前置条件 = 全流程测试通过** | 用户 2026-11-17 明确：现在还不能写 spec |

## 3. 世界 GM / LLM 的 API 面

- 立意：**暴露给世界 GM 的 API 不只给 LLM 用，引擎自身与模板也要能复用。**
- 三类现有 API：读链路（`world.now/history/present/self`，主要是 LLM 用）／生成分支（LLM 与 yaml 预制两种来源）／叙事（LLM 用）。
- 在 `submitBranch` 上扩展的五件事，**全部已落地**（`4b913f3`）：
  1. NPC 生成，id 与实例由引擎管理；
  2. 固定人物**随轮次自动刷出**（`npcSpawnRules[].when`，无 `when` 则永不自动）；
  3. **事件加载即生成 NPC**（模板源与 LLM 源同形，事件占槽时生效）；
  4. 关系（含可见性：确信 / 推断 / 猜测 / 隐藏）+ 隐秘 + 生命周期变更；
  5. 上述语义**两侧同一套**，LLM 只能从模板能力上限里收窄。
- **`fact.*` 四个写工具已下线**（`d2c311f`）：`setKnowledge` / `advanceDag` / `upsertDagBranch` / `enqueueEvent`。写世界只留 `story.submitBranch` 一条通道；知识只由模板 `knowledgeGrants` / `inferenceRules` 授予。
- GM 全知：**视角由模板声明 + 参数透传**，不写死在代码里。
- 叙事区不出现选项；LLM 出选项要走 function calling **把带选项的事件注入事件池**，不是生成文本让前端渲染。

## 4. NPC 与关系

- 玩家终局形态：**也是一个 NPC 实例**，用 `self` 指针指向它，在 NPC 列表里隐藏。
  本期只提前做了关系这半（`selfId` + `actorOf`，`35b7906`），**玩家存储未切换**。
- **关系是独立事实**：可以不认识伏黑甚尔，但知道"惠有个父亲"。关系投影与 NPC 卡片解耦（`35b7906`）。
- **关系只展示出边**（"五条悟视乙骨为远亲"，乙骨侧不要这条边）（`866204a`）。
- **`characters[].visibility: hidden` = 纯展示门**：只决定"玩家视角 NPC 列表里有没有他"，
  **不**跳过实例存在、不跳过关系端点、不跳过自主行动（`866204a`）。
- 敌人：**不退役也不实例化**。`isEnemy` 留在字段上；敌人没有实例、不上卡、不跑自主行动。
  代价：关系行只挂在 NPC 卡上，**敌人侧出边仍然没有落点**（用户裁决：不需要）。

## 5. DAG：砍了什么、留了什么

- **砍掉**（`60d5799`）：`rules.yaml` 的 `fallbackDag`、`state.taskDag`、`advanceDagProgress`、
  `nodeCompleted` 条件、`perspective` 的 `dagNodes`/`edges` 视图与 `dag:<id>` ref、`world.clues` 只读工具。
  理由（2026-11-18 用户更正）：当时那版实现**没按用户的需求做**（我理解错了任务语义），
  且当时没时间重写一套真正的任务系统，所以先整体移除。
  **不是**因为"任务 / 进度"这个能力没有价值，也**不是**"必须有现成消费者才允许做"的架构原则。
  将来做任务系统要按用户真实需求重新设计，不要照搬旧 `taskDag`，也不要把这次删除当成反对任务系统的先例。
- **保留**：`story.submitBranch` 的**分支图**（nodes + `goto`）。这才是业务语义上的"一段剧情"。
- **扩展**（`585424c` + `51d863d`）：
  - 入口 `trigger.after`、节点 `goto.after` ⇒ **支持"未来才触发"**；
  - 节点之间**可以穿插**别的事件与自由行动（"设计槽模型就是为了这样做的"）；
  - **yaml 也能用同一套语法**：`events.yaml` 条目写 `branch:`，加载期展开成普通事件；
    首节点**沿用父 id**（外部 `nextEventId` / `eventResolved` 引用零改动），其余 `<id>#<node>`。
    真样例：`specs/data/templates/jjk-shinjuku/1.0.0/events.yaml` 的 `evt:north-counter`。
  - **YAML 专用扩展（2026-11-18）：`branch` 的 node 可写 `as: <actorId>`**，同一 `node` 别名写多份、
    每份带不同 `as` ⇒ **同一个节点、不同 self 看到不同剧情**（正文与选项整套不同）。self 恒单值 ⇒
    变体天然互斥；多变体时必须有一份无 `as` 的兜底变体防软锁。
    加载期把变体展开成独立事件 `<id>#<node>@<as>`，as 变体带一等条件 `selfIs`、兜底带一组 `selfIsNot`
    （逐条 AND，否则 chain 来源下兜底会与 as 变体同时成立而串戏）。
    `goto` 到多变体节点、以及**外部 `nextEventId` 指向多变体首节点父 id**（chain 入队不看 conditions）
    都自动展开为多条 self 门控的同一选项 —— 玩家仍只看到一条、不额外占轮次，不是"给某些角色多一个选项"；
    random.wheel / combat outcome 指多变体首节点 ⇒ 加载期拒载（无处挂 visibleWhen）。
    **2026-11-18 追加**：**首节点也允许 `as`**（用户裁决：很可能共用触发器、首节点就不一样，彻底 close 不留遗留）。
    多个首节点变体**共用父 trigger**，兜底沿用父 id（外部引用零改动），as 变体用 `<id>#<node>@<as>`。
    新增对称原语 `selfIsNot`（`shared/schema/common.ts` + `engine.ts#checkCondition`），与 `selfIs` 一样只读
    `selfIdOf(state)`。**只对模板开放**：LLM 的 `submitBranch` node 没有 `as`，其 option 也没有 `visibleWhen`，
    LLM 不感知角色分派（参与时角色早已确定）。

## 6. 我判断错、已被纠正的点（别再犯）

1. `fact.*` 不是"刻意保留但没暴露"，是**早已裁定下线、代码没删干净**。留着只会让模型去调不存在的工具。
2. 敌人**不实例化**（曾按"实例化 + 字段退役"做过一版，已整包回退）。
3. `taskDag` 不是"有用的章节系统"，是**零消费者的自嗨机制**。
4. `visibility: hidden` 是**纯展示门**，不是"跳过 NPC 逻辑"的门。
5. 我上一轮说"仓库还在跑测试"—— 实际测试已全删，`pnpm test` 不存在。

## 7. 待办（2026-11-17 微调后）

**保留**
- `turn.ts` 拆分（现 1518 行）
- rpg-ui 补组件：CharacterSheet / EvaluationPanel / RelationGraph / BattleBoard
  （**`TaskDagView` 已砍** —— DAG 子系统不存在了）
- **B-20**：~~玩家侧关系面板 + `playerTemplate.relations`~~ —— **协议半截已做（2026-11-20，ADR-017）**：
  `playerTemplate.relations` 上线（`from` 恒为 self），投影本来就会发 `direction: "out"`。
  **UI 面板仍未做**，见 `docs/BACKLOG.md` §「仍需产品设计」。
- **新测试从零设计**，两条硬要求：
  1. 单侧的 LLM 层**走 mock**；
  2. **mock 数据必须来自真实跑出来的一条 trace**（录制→回放），不允许手搓假 payload。
- **流式叙事**：见 §8，取决于"叙事能不能从 fc 里增量吐字"的结论。

**已删除（不再跟进）**
- **放弃转盘通道** —— 不做。用户口径：「能放弃就没意义了」（抽到什么就认，不给弃权）。
- `OPEN_QUESTIONS #49`（平台免密钥 LLM 链路）、`#50`（LLM 与 core 的边界）——
  旧待决项随归档一并作废，不再作为待办跟踪。
- `TaskDagView`。

## 8. 流式叙事的可行性结论（2026-11-17 调研）

**事实（代码层，已核实）**
- 服务端**整条链路都在**：`openai-tools.ts` 支持 `stream: true` 且逐行解析 SSE；
  `apps/server/src/narrative/stream.ts` 有内存频道 + SSE 路由（已注册），把 `onDelta` 的碎片转发给浏览器。
- **但 `onDelta` 只吃 `delta.content`**。而叙事是走 function calling 的：正文在
  `tool_calls[].function.arguments` 的 JSON 里，`delta.content` 是空的
  ⇒ **现在流式一条字也吐不出来**，前端接 EventSource 也是空屏。

**结论：做得到，但不是"接个前端"的事**
- 技术上可以：在 provider 里对 `arguments` 做**增量 JSON 字符串提取**（识别 `"text":"…"` 这棵树、
  跨分片处理转义与 `\uXXXX`），把正文碎片喂给 `onDelta`。约 100–150 行。
- 真正的障碍是**契约**：流出去的字在**校验之前**。若该次调用最终被拒
  （参数不合法 / 引用越窗 / 可见性违规），玩家已经看见的字要么"消失"（体验崩），
  要么被当成已提交（等于绕过校验）。这需要**"草稿正文"与"已提交正文"两态**，
  属于叙事层契约变更，正好落在新 spec 要定的边界里。

**建议**：先记在这里，等全流程测试 + 新 spec 定完叙事层边界再做。
另一条更省事的路线（用户自己提过）：**叙事层不走 agentic**，单独一次纯 chat completion
（`delta.content` 天然可流），代价是叙事与 GM 决策分成两次调用、trace 的单源性要重新设计。

---

## 9. `valmont`：极端亲缘关系测试模板（另一会话维护）

**定位**：不是给玩家玩的产品模板，是**亲缘关系推导的压力测试载体**。故意构造现实里罕见、
但规则上必须给出正确称谓的家族结构，把"多读法排序 / 姻亲合成 / 半血亲 / 平行边"的边界压出来。

**位置与规模**（2026-11-17 实查）
- `specs/data/templates/valmont/1.0.0/`，10 个 yaml，**当前未入库（untracked）**
- **12 个角色 / 57 条关系边 / 10 种 kind**：`wife` 10、`husband` 10、`son` 10、`father` 8、
  `daughter` 7、`mother` 7，另有 4 种手足（elder/younger × brother/sister）
- 结构特征：多段婚配 + 半血亲 + 姻亲链 + 近亲婚配产生的**平行边**
- `events.yaml` 201 行、`rules.yaml` 31 行（`fallbackDag` 段已随 DAG 子系统删除）

**它压的是什么**（对应 game-core 的能力，不是模板自己的逻辑）
- 多读法**先收集 → 排序 → 去重**：血亲(0) → 「继」字辈(1) → 其余姻亲(2)，同层按跳数、再字典序
  （反例：3 跳的 `[爸爸,妻子]` 曾在 DFS 里抢走 2 跳 `[妈妈,妈妈]` 的主称谓）
- 姻亲**结构化合成**而非直接采信关系库：`爸爸的妻子 ≠ 妈妈`（库把它硬编码成血亲）
- **半血亲**前缀（同父异母 / 同母异父），由父边+母边推出
- **亲缘系数交叉审计**：`kinshipCoefficient`（Wright 路径法）与链记号两套独立实现互验，
  不变式只有一条 —— 纯血亲读法 ⇒ `r > 0`
- `self` 环防护
- 典型期望值（seed 3 实测）：布兰奇→玛蒂尔达 = **外婆**（而非"妈妈"）；
  戈弗雷→罗莎（零血缘）= **老婆** + 继姐妹；玛蒂尔达→戈弗雷 = 同父异母的姐姐

**去向**
- 模板本身由另一会话维护，**未入库、我不改它**；本笔记只做登记，避免下次有人当它是产品模板
- 它的单测目前散在 `packages/game-core/src/`（`kinship-readings` / `kinship-coefficient` /
  `self-loop-guard` 三个 `.min.test.ts`），**违反 `test/` 约定**；
  后续合并到 `test/` 目录下统一管理
- 曾短暂存在一个同源压力模板 `stress-lineage`，当前盘上已无（被 valmont 取代）

---

## 10. 叙事链路与工具面（2026-11-17 定稿）

**工具面收敛完毕**（`d2c311f` 删 `fact.*`、`28ada5c` 删 `narrative.*`）：

| 一类 | 工具 |
|---|---|
| 只读 | `world.now` / `world.history` / `world.present` / `world.self` |
| 写世界 | **只有 `story.submitBranch`** |

`dispatch("fact.*")` 与 `dispatch("narrative.*")` 现在都是 `unknown_tool`。

**叙事正文只有一个来源**：模型 `content` 里的 `<narrative-content>…</narrative-content>` 块。

- loop 收尾提取所有标签块 → 合成一个 `ContentBlock`（`kind:"narrative"`、`targetPerspective:"player"`、
  `refs: []`）→ `ContentSink` → trace。**标签外内容一律丢弃**，绝不透给玩家。
- 没有标签 ⇒ 诊断 `narrative_tag_missing`（committed / fallback 都记），回退模板文案。
- `ContentSink` 保留为唯一正文落盘点：agent-runtime 的标签路径与服务端的结局/总结/flavor 都走它。

**实时通道**：`POST /api/worlds/:id/narrative/stream`（SSE）。

- **服务端剥标签**：`stream.ts` 有增量标签扫描器，SSE 只下发标签内文字；跨帧半截开/闭标签都缓冲。
  客户端拿到的是干净正文，**不要再自己扫标签**（web 已删掉 `narrativeDraftText`）。
- 等待窗 `PENDING_WAIT_MS = 3000`：覆盖"先开流、再发 turn"的真实顺序。
- ⚠️ **订阅端的坑**：`fetch` 返回响应头要等首帧写出，而首帧要等 invocation 开始。
  所以**不能 `await fetch(stream)` 之后再发 turn**（会互锁到 idle）。
  正确顺序：起请求（不 await）→ 发 turn → 再 await 读取。web 就是这样做的；手写脚本容易踩。

**已知代价**：正文改纯文本后不再有 `refs[]`，`allowedContentRefs` / `visibility_violation`
这套结构校验对**正文**失效（只对结构化内容块仍有效）。GM 全知，理论上可以在正文里写出隐秘。
暂定接受，等新 spec 定叙事层边界时再裁决（候选：标签内带 refs / 事后掩码 / 结构声明）。

## 11. 展示层声明 `ui` 与"进度"的裁决（2026-11-17）

**问题**：世界的两条差异被混在一起。

1. **功能差异**（有没有战斗、有没有转盘、有没有装备）—— 模板能用 `flag` 表达，引擎能读，
   业务上也够用。但**前端读不懂 flag**：`apps/web/src/main.tsx` 的页签是写死的
   `type Tab = "life" | "personal" | "world" | "log" | "records"`，于是没有战斗的世界
   照样摆一个战斗面板，点进去空的。
2. **视图重要性差异** —— 槽 / 队列是**引擎通用**机制，但"某世界格外在意这套调度的呈现"
   是每个世界自己的事。这条不能靠引擎判断。

**裁决（用户 2026-11-17）**：

- **`ui` 单列成 `ui.yaml`**（不塞进 `world.yaml`）—— 用户追加裁决：「ui 直接单列 yaml 吧」。
  白名单 14 → 15，但**不进语义指纹**：纯渲染声明变了不该拒载存档。它有自己的 loader，
  和 `rules.yaml` / `lore.md` 一样不并入 `TEMPLATE_MERGE_FILES`。
- `views` 这一档现在做；**不做 auto 推导**：前端不许从"模板有没有 `equipment.yaml`""某 flag 是不是真"
  "某表是不是空"反推视图该不该出现。理由原话：「协议变更会很麻烦 这块只该影响前端渲染」——
  推导规则会随模板形态不断追加，等于每次改渲染都要改协议。要出现什么，模板写出来。
- **形状未定**（用户同日：「`ui.views` 字段随时可能会变，因为我有考虑前端插槽化——
  比如图谱镶嵌到 npc 栏，还是单独 tab 页」）。已并列写两个候选：
  A 扁平开关 `views: <能力>: bool`；B 落位 `place: <能力>: tab|overlay|slot:<host>|off`。
  B 能直接吃掉插槽化（改一个字符串），A 落完就要改协议。
- `layout` / `style`（声明式布局 / 样式）将来也进 `ui.yaml`，`未决`。
- **不投影时间队列**：「时间队列就不是玩家该感知的 不该投影时间队列」。`delayQueue` 留在
  `WorldStateV2`，不进 `V2Snapshot`（现状本来就没投影，这条是钉住别回退）。
- 进度感**不靠队列**，方向是「扩展 dag 协议和引擎数据模型（这是个什么类型的事件链 该如何呈现给玩家）」，
  现在不做。已在 `specs/SPEC.md` §4.9 写成 `未决`，含 4 条硬约束（不许靠投影队列、
  引擎不编造名字、不能变成第二套 `taskDag`、不改既有语义）。

**`ui.yaml` 的层级归属（2026-11-18 更新）**：层级表已重定为 L0 最简 / L1 深度利用内核本体 /
L2 需要扩展包。`ui.yaml` 是内核自带的声明式文件、不改判定与结算，因此归 **L1**
（不再是旧表的 L4）。旧文里"放在 L4、不重编号"的理由随层级重定一并作废。

**单列顺手解决的那笔怪账**：`ui` 挤在 `world.yaml` 里时，改一个页签 = 改语义指纹 = 该模板旧存档
全部拒载。这种"纯渲染变更触发存档拒载"是错的，单列之后就能按文件粒度把 `ui.yaml` 排除在指纹外。
代价是"老存档 + 新 `ui.yaml`"这种组合必须能打开，兜底靠 §1.5 的降级规则
（被关的能力一旦当轮成为唯一推进路径，必须降级呈现，不许软锁）。

**顺带记账的两处文档债**（已改）：`SPEC.md` 的白名单写 13 个（漏 `lore.md`，实际 14）；
测试用例写 19 例（实际 27）。

## 12. 扩展层 extension（2026-11-17 裁决）

**病根**：加一个世界往往不只加 yaml。某个世界想要一套 core 里没有的机制，今天只能塞进
`packages/game-core`，于是 core 越来越重，而这份重量**所有世界一起背**。中间缺一档。

**裁决（用户原话）**：「先叫 extension 这里装的类别是"多个世界共同，但不是所有世界通用"的逻辑
如玄幻拓展 都市拓展 家族拓展；放弃热加载 改拓展必须重启」。

> 我上一轮提的准入规矩是"两个世界都要才配进 core"——**这条是错的**，它会继续把 core 喂重。
> 正确的线是"**所有**世界都要才进 core"，"多个但不是所有"进扩展。

**三档归属，判据是"有多少世界要"**：一个世界要 → 模板；多个但不是所有 → 扩展；所有 → core。

**先模板、后上提**：不预判复用。先写在模板里，等第二个世界真的要用时再上提。
提前抽象是 core 变重的主要成因，比"重复两遍"贵。

**v1 只开三个口**：`conditions`（缝已有：`ConditionRegistry`）、`effects`（21 种闭合 union +
`engine.ts:323` switch，要改成注册表）、`derivations`（投影期派生，无现成缝）。
**不开 `settle kind`**：`discriminatedUnion` 只有 normal/random/combat，开一口要同时动
事件 schema / 结算分发 / 前端渲染，而"需要第四种"还没被两份世界证明。

**schema 必须成对**：扩展导出 `{ schema, handler }`，加载器启动时把 schema 并进 union，
保住模板 yaml 的加载期 fail-fast。`packages/shared` 不依赖任何扩展，合并发生在 `apps/server`。

**硬约束**：单向依赖（core 不 import 扩展，源码守卫钉住）；扩展之间不做依赖；
扩展不是"待升级 core 的暂存区"；不接管 `advanceTurnV2` 主循环。

**加载模型**：编译期静态依赖，`extensions/<id>/`，打进服务端进程。放弃热加载，改扩展必须重启。
模板 `world.yaml` 写 `requires: [...]`，缺扩展即加载期报错。扩展 id + 版本**进语义指纹**
（改的是规则语义，和模板 yaml 同级）。

**为什么不做热加载**：`game-core` 的核心资产是「同 seed + 同输入 ⇒ 同结果」，`test/unit/replay.ts`
那套录制回放全建在它上面。运行时换规则 ⇒ 同一存档两次跑出不同结果 ⇒ 回放 / e2e / 旧档复现全失效。
且启动期加载时坏扩展 = 服务起不来（一秒发现），运行期替换 = 线上某刻炸掉还连着在跑的局。

**第一个真实样本**：亲缘称谓推导。它现在躺在 `packages/game-core/src/v2/relations.ts`，
工作树里那份 WIP 是 +593 行（`meta.kinship` / `kinshipTerms` / `derived`，2026-11-17 03:00 起搁置）。
玄幻有家族、都市有家族、家族剧就是家族，但不是所有世界都要 —— 它该是 `extensions/family`，
`derivations` 口的第一个用户。

**未决**：扩展能否带前端组件（与 §1.5 插槽化绑定）；能否带自己的测试与 fixture 模板。

## 13. 多人共用工作区的硬规则（2026-11-17，一天踩三次）

**1. 同一文件集，同一时刻只许一个写者。**
派活前先比对两个 worker 的写入路径是否相交，相交就串行。今天三次事故里，
`aca952a` 那次**根因是调度**——我把 `extensions/family/src/pedigree.ts` 同时派给了两个 agent，
两份实现互相覆盖，最后靠其中一个手工合并。git 用法没错，派活错了。

**2. 提交只用 pathspec 形式，不要先 `git add`。**
```bash
git commit -m "..." -- <具体路径> ...   # 隐式只加这些路径，绕开共享 index
```
`git add` 会把内容留在**共享 index** 里，别人紧接着 `git commit` 就会把你的工作按他的名义带走：
- `5bdc72d`：顶着「docs: 族谱与宗族拆成两件事」的 message，实际提交了 26 个文件、2292 行的扩展层搬迁；
- `aca952a`：带走了另一个 agent 已 `add` 但未提交的族谱修复。

**3. 不信任务状态，信盘。**
`git log` / `git status` / 实跑测试 三者一致才算数。今天有过「worker 报 79 全绿、另一个报某用例红」
的冲突，实际是两边跑在不同瞬间；也出现过「任务 paused 但工作早已提交」。

**4. 验证要在没有在途改动时跑。**
并发写者还在改 `game-core` 时跑全量 typecheck，红绿都不作数——必须等所有写者收口再一次性验。
