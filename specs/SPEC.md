# 核心规格（2026-11-17）

> **这份文件只写"已经实现且能被验证"的东西。**
> 未实现的**不承诺**；不可避免要提到时，标 **`未决`**。
> **已裁决、但还没写代码**的标 **`已裁决·待落地`**（只用于标注"方向定了、实现没做"，
> 不能让读者误以为是现状）。
> 旧 `specs/` 与 `docs/` 已整体归档到 `archive/2026-11-16-pre-rewrite/`，不构成约束。
> 逐条裁决记录见 `docs/REFACTOR-NOTES.md`。

---

## 1. 产品说明

**AI 驱动的 RPG 人生模拟。** 玩家在模板给出的世界骨架里行动，规则由确定性内核裁决，
AI 负责把规则结果写成有画面的叙事、并在关键节点补出新的剧情分支。

### 1.1 五层分工

| 层 | 负责 | 边界 |
|---|---|---|
| **模板** | 故事骨架：世界观 / 属性 / 人物 / 事件 / 生成规则 / 结局 / 评价维度 | 只有声明式 yaml，不含可执行代码 |
| **core**（`packages/game-core`） | 最底层通用 RPG 规则：世界推进、事件调度、战斗、关系、评价、投影 | 不依赖 React / Fastify / DB / LLM SDK，无网络；**不 import 任何扩展** |
| **扩展**（`extensions/*`） | "多个世界共同、但不是所有世界通用"的成套逻辑（玄幻 / 都市 / 家族…） | **只能依赖 core**；不能被 core import；只能往注册表里加东西，不接管 turn 主循环 |
| **AI**（`packages/agent-runtime` + `apps/server`） | 叙事与分支候选 | 只能通过引擎工具面写入，不直接改状态，不做评分裁判 |
| **前端**（`packages/rpg-ui` + `apps/web`） | 展示与交互 | 只吃投影（`V2Snapshot` / `ViewModel`），不承载规则 |

### 1.2 世界模板的接入层级

> 用户 2026-11-17 口径：**L0 已实现；L1 部分；L2 / L3 `未决`；L4 只有 `ui.yaml` 一档已裁决
> （待落地、形状未定），其余 `未决`；L5 扩展层已裁决（待落地），见 §1.6。**
> 下面每层写清"现在能到哪一步"（事实）与"没定的部分"（`未决`）。

| 层 | 内容 | 当前状态 |
|---|---|---|
| **L0 最小实现** | 只写必要的 yaml 模板即可跑完一局 | **已实现**。见 1.3 的必需/可选文件表 |
| **L1 资源文件** | 立绘 / 差分 / 音频等静态资源随模板分发 | **部分**：`assets/manifest.yaml` 已能声明资源，服务端有 `GET /api/templates/:id/:version/assets/:assetId` 下发，`/api/templates` 会带 `assetCount`；**事件/叙事引用媒体的契约 `未决`** |
| **L2 深度 yaml（仍在框架内）** | 更复杂的声明式剧情结构（更多触发原语、更多结算形态） | `未决`。现只支持本文件 §3 描述的事件/触发/效果形状 |
| **L3 声明式拓展** | 复用/宏/片段包含，用来减少重复模板语句 | `未决`。模板目前没有 include / macro / anchor 语义（YAML 自身 anchor 可用，但引擎不理解） |
| **L4 展示层声明 / 自定义前端** | 模板声明"哪些内建视图上屏"→ 声明式布局与样式 → 完全自写客户端，逐级加深 | `ui.yaml`（独立文件的展示层声明）：**`已裁决·待落地`**，见 §1.5，**形状未定**（扁平开关 / 落位，两候选）。
`layout` / `style`：`未决`。自写客户端：**部分**——`packages/rpg-ui` 已是可导出的 React 组件库（只吃 `ViewModel`），但**没有对外 API 稳定性承诺**，`未决` |
| **L5 扩展层（extension）** | 模板 + 代码：把"多个世界共同、但不是所有世界通用"的成套逻辑打包分发 | **`已裁决·待落地`**，见 §1.6 |

### 1.3 L0 模板文件集（已实现）

服务端只认这 15 个文件（白名单，写在 `apps/server/src/templates.ts` 的 `DECLARATIVE_FILES`），其余文件**不进加载**：

| 必需 | 可选 |
|---|---|
| `world.yaml`、`characters.yaml`、`skills.yaml`、`items.yaml`、`statuses.yaml`、`events.yaml` | `equipment.yaml`、`combat-ai.yaml`、`opening.yaml`、`endings.yaml`、`evaluation.yaml`、`rules.yaml`、`lore.md`、`ui.yaml`、`assets/manifest.yaml` |

- 目录即身份：`specs/data/templates/<id>/<version>/`，**版本号变化 = 另一个模板**。
- 模板增删改**只走文件系统**：`mkdir` = 加版本，改文件 = 下次请求时热加载，`rm -rf` = 删除。
- 加载期 **fail-fast**：任一 yaml 不合 schema、引用不存在的 id、DAG 之外的完整性错误 ⇒ **整个服务起不来**（启动期）或该模板标不可载（运行期热加载）。
- 语义指纹 = **14 个**白名单文件（12 个根 yaml + `lore.md` + 嵌套的 `assets/manifest.yaml`）排序拼接后的 sha256；指纹变化 ⇒ 旧存档拒载（见 §3.7）。
  **`ui.yaml` 是唯一进白名单但不进指纹的文件**（纯渲染声明，见 §1.5）。
  模板声明的**扩展 id + 版本**（§1.6）也进指纹——它改的是规则语义，不是渲染。
- `lore.md` 是**唯一非 yaml** 的指纹文件（模板自带的世界观知识库，见 §4.8），它有独立 loader，名字照样进指纹。

### 1.4 不做的事（已裁决，不是未决）

- 不做「放弃转盘」：抽到哪一格就认。
- 不做 `taskDag`（任务 DAG 子系统）：已整套删除。
- 不做模板导入端点 / 编辑器：模板只经文件系统。
- **不做前端 auto 推导**：前端不得从"模板里有没有某个文件"、"某个 flag 是不是真"、"某张表是不是空"
  反推某个能力该不该出现。要出现什么、摆在哪，模板得在 `ui.yaml` 里**写出来**（§1.5）。
  裁决理由：推导规则会随模板形态演化而不断追加，等于每次都要改协议，而且改的是渲染——
  这类变化必须收在数据里，不能收在代码里。
- **不投影时间队列**：`state.delayQueue` 只活在引擎里，不进 `V2Snapshot`，
  将来也不给玩家看"未来会发生什么"（§2.3）。

### 1.5 展示层声明：`ui.yaml`（`已裁决·待落地`，**形状未定**）

> 用户 2026-11-17 裁决：**`ui` 单列成 `ui.yaml`**，不塞进 `world.yaml`；
> 只有"能力怎么摆"这一档现在做，而且**不做 auto 推导**；这个文件**只影响前端渲染**。
> 布局与样式将来也进这个文件。

> ⚠️ **形状未定，随时会变。** 同日补充：「`ui.views` 字段随时可能会变，
> 因为我有考虑前端插槽化——比如图谱镶嵌到 npc 栏，还是单独 tab 页」。
> **定的**是：文件独立、只影响渲染、不做推导。**没定的**是里面写什么形状（两个候选见下）。
> 模板别拿它做长期设计，前端别把开关当契约。

> 也就是说**"某个能力该出现在哪"本身还没定**：同一张关系图谱，可能是一个独立 tab，
> 也可能是 NPC 栏里的一个插槽。

**为什么要有它**：世界的"功能差异"和"展示差异"是两件事。
功能差异（有没有战斗、有没有转盘）模板能用 flag 表达、引擎能读；
但**前端读不懂 flag**——它只会照着写死的页签渲染，于是没战斗的世界也摆着战斗面板，
点进去是空的。展示差异必须有它自己的声明位。

**为什么单列**：`world.yaml` 里已经有 meta / time / statusBar / attributes / resources / regen /
characters / playerTemplate / actions 九块，全在说"这个世界怎么**算**"；`ui.yaml` 说的是
"这个世界怎么**显示**"。两类声明混在一个文件里，改一个页签要和改一条属性规则走同样的流程
（同一份 schema、同一个指纹、同一次拒载），这本身就是错的。

**位置**：模板目录下的独立文件 `<template>/<version>/ui.yaml`，白名单第 15 个文件。
它有自己的 loader（和 `rules.yaml` / `lore.md` 一样**不并入** `TEMPLATE_MERGE_FILES`），
校验失败照旧加载期抛错。

**指纹**：`ui.yaml` **进白名单、不进语义指纹**。
裁决依据：它是纯渲染声明，改一个页签不该让该模板所有旧存档拒载。
兜底：老存档遇到一份已经改过的 `ui.yaml`（比如某个视图被关了）仍要能打开并推进——
这条由下面第 2 条"只关入口不关推进路径"的降级规则保证。

**形状：两个候选，还没选**（键集闭合，键名写错 ⇒ **加载期报错**，不静默忽略）

**候选 A —— 扁平开关**（`views: <能力>: boolean`）：只回答"要不要"。

```yaml
# ui.yaml
views:             # 缺省全开；只写要关的那几个
  wheel: true      # 转盘面板与确认入口       —— WheelPanel
  battle: true     # 战斗面板                —— BattleBoard
  equipment: true  # 装备槽                  —— CharacterPanel / SlotTile
  inventory: true  # 背包分区                —— BagPanel
  skills: true     # 技能分区                —— SkillList
  relations: true  # 关系列表                —— RelationList
  npcList: true    # 世界 → 人物/NPC          —— NpcCard
  log: true        # 历史日志
  evaluation: true # 评价面板                —— EvaluationPanel
```

**候选 B —— 落位**（`place: <能力>: <落位>`）：把"要不要"和"摆哪"合成一个值。

```yaml
# ui.yaml
place:
  world: tab                  # 页
  npcList: tab                # 「世界」页里的 NPC 子页（同时也是宿主）
  personal: tab               # 页
  log: tab
  battle: overlay             # 浮层，不占页签
  wheel: overlay
  evaluation: overlay
  equipment: slot:personal    # 嵌进「个人」页
  inventory: slot:personal
  skills: slot:personal
  relations: slot:npcList     # ← 「图谱嵌到 npc 栏」直接这么写
  # relations: tab            # ← 想让它独立成页，改这一行
  # relations: off            # ← 不想要，改这一行
```

落位只有四个取值：`tab`（顶层页签）/ `overlay`（按需浮层）/ `slot:<hostId>`（嵌进另一个视图）/
`off`（不渲染）。

| | A `views` | B `place` |
|---|---|---|
| 表达"要不要" | ✅ | ✅（`off`） |
| 表达"摆哪" | ❌ | ✅ |
| 插槽化（图谱进 NPC 栏） | 得改协议 | 改一个字符串 |
| 键的粒度 | 混杂（页和页内分区同层） | 不混，落位自己说清 |
| 前端改动 | 过滤页签 | 按落位分发 |

**候选 B 的三条附加规则**（选 A 就没有这些）：

1. **能力 id 是协议，落位是渲染提示**：能力集合（`world` / `battle` / `relations` …）闭合在后端
   schema 里；`slot:<hostId>` 的宿主**认不认这个槽由前端组件决定**，模板不需要另写一份
   "宿主有哪些槽"的声明（一侧声明，不做双向校验）。
2. **嵌不进去就降级成 `tab`**，不报错、不留黑洞。宿主组件没有这个槽、或该能力本来就没法内嵌
   （战斗是全屏的），一律退化成独立页——**宁可多一页，不要一个空槽**。
3. 一个能力只能声明一次（map 天然保证），不出现"既在页签又在插槽"。

**共同的三条语义**（A / B 都成立）：

1. **缺省等于现状**：不写 `ui.yaml`、或只写其中几项 ⇒ 其余保持**当前内建布局**
   （即上面 B 那个例子的样子）。现有模板零改动、零回归。
2. **只关常驻入口，不关推进路径**：`off` 的语义是"本模板不产生需要它的东西"，
   不是"它出来了也不给处理"。任何被关掉的能力，一旦在当轮成为**唯一**推进路径
   （槽里正躺着一个 `kind: "random"` / `kind: "combat"` 的事件），前端**必须降级成最小形态呈现**，
   不许软锁。硬约束：展示声明不能把玩家卡死。
3. **不是规则**：引擎不读 `ui.yaml`。判定、结算、投影内容都不受它影响，改它不改变一局的结果。

**预留**：`layout`（声明式布局）与 `style`（声明式样式 / CSS 变量覆盖）也进这个文件，
`未决`。它们和上面同属"模板只描述**怎么呈现**，不描述**怎么算**"。

### 1.6 扩展层：extension（`已裁决·待落地`）

> 用户 2026-11-17 裁决：名字叫 **extension**，不叫 plugin / mod。装的是
> 「**多个世界共同、但不是所有世界通用**」的逻辑——玄幻拓展、都市拓展、家族拓展。
> **放弃热加载**：改扩展必须重启服务端。

**为什么需要这一层**：加一个世界往往不只加 yaml。某个世界想要一套 core 里没有的机制，
今天就只能塞进 `game-core`；于是 core 越来越重，而这份重量**所有世界一起背**。中间缺一档。

**三档归属**（判据是"有多少世界要"，不是"多复杂"）：

| 归属 | 判据 | 例 |
|---|---|---|
| 进**模板**（`specs/data/templates/**`） | 只有**一个**世界要 | 新宿决战的章节线、某个专属结局 |
| 进**扩展**（`extensions/*`） | **多个**世界要，但**不是所有** | 亲缘称谓推导、玄幻的修真境界、都市的职场声望 |
| 进**core**（`packages/game-core`） | **所有**世界都要 | 改旗标、改资源、给物品、上状态、推进时间 |

**先模板、后上提**：不要预判"这个以后肯定复用"就做成扩展。**先写在模板里，等第二个世界
真的要用时再上提。** 提前抽象是 core 变重的主要成因之一，比"重复两遍"贵得多。

**硬约束**：

1. **依赖单向**：扩展可以 import core，core **不得** import 任何扩展。用源码守卫测试钉住
   （仿 `test/unit/ui-source-guard.test.ts` 的做法）。
2. **扩展之间不做依赖**（v1）。A 要用 B 的能力 ⇒ 那是两者共同的下沉需求，一起下沉到 core；
   不要长出扩展依赖图——那就是把刚拆开的单体重新拼回去。
3. **扩展不是"待升级到 core 的暂存区"**。某能力长期只有两个扩展在用且不成体系，就地留着或下沉，
   不要靠"再包一层共享扩展"糊过去。
4. **不接管主循环**：扩展只能往注册表里加东西，不动 `advanceTurnV2` 的槽、队列、结算顺序。

**v1 只开三个口**：

| 口 | 现有缝 | 说明 |
|---|---|---|
| `conditions` | **已有** `ConditionRegistry`（`condition-evaluator.ts:42`） | 新增条件原语 `op`。⚠️ 事件的 `conditions`/`visibleWhen`/`missWhen` 用的是**闭合**的 `ConditionSchema`，扩展 `op` 目前只能在 `rules.yaml` 触发器里用 |
| `effects` | **27 种**闭合 `z.union` + `engine.ts:323` 的 switch。⚠️ 该 switch **没有 `default`** ⇒ 未知 type 静默 no-op | 新增效果类型 |
| `derivations` | 无（投影里写死） | 投影期派生，如称谓、系谱 |

**明确不开 `settle kind`**（现在只有 `normal` / `random` / `combat`）。它是 `discriminatedUnion`，
开一口要同时动事件 schema、结算分发、前端渲染；而"需要第四种 kind"这件事还没被两份世界证明过。
等有真实第二份需求再说。

**schema 必须成对**：每个扩展导出 `{ schema, handler }` **成对**，加载器启动时把扩展的 schema
并进 `EffectSchema` / 条件 `op` 的 union。这样模板 yaml 仍在**加载期** fail-fast（打错 `type`
立刻报错），不会拖到开局才发现。`packages/shared` **不依赖**任何扩展——合并发生在
`apps/server` 的加载器里。

**加载与版本**：

- 编译期静态依赖：扩展是 workspace 包，目录 `extensions/<id>/`（pnpm workspace 加一条 glob），
  打进服务端进程。**放弃热加载**——改扩展必须重启。
- 模板在 `world.yaml` 声明 `requires: [family, fantasy]`；缺扩展或版本不满足 ⇒ **加载期报错**，
  和引用不存在的角色 id 同一级别。
- **扩展 id + 版本进语义指纹**：它改的是规则语义，和模板 yaml 同级。
- 「加扩展」= 加目录 + 模板声明 + 重启；「改扩展」= 重启 + 相关旧存档拒载。

**为什么不做热加载**：`game-core` 的核心资产是「同 seed + 同输入 ⇒ 同结果」，整套回放测试
（`test/unit/replay.test.ts`）建在它上面。规则能在运行时被替换 ⇒ 同一存档两次跑出不同结果 ⇒
回放、e2e、旧档复现一起失效。而且启动期加载时"坏扩展 = 服务起不来"是一秒就能发现的；
运行期替换是"线上某刻炸掉"，还连着正在跑的局。

**第一个真实样本**：亲缘称谓推导（多跳中文称谓 + `meta.kinship` 开关）。它现在躺在
`packages/game-core/src/v2/relations.ts` 里、约 +593 行——玄幻有家族、都市有家族、家族剧就是家族，
但它不该让所有世界背。**它该是 `extensions/family`，也是 `derivations` 口的第一个用户。**

**未决**：扩展能不能带自己的前端组件（和 §1.5 的插槽化绑在一起）；能不能带自己的测试与
fixture 模板。

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
- 槽是**引擎通用**的：所有模板共用同一套调度，没有"某模板专属的槽"。
  但"这套调度要不要摆给玩家看、以什么形态摆"是另一回事——那由模板的 `ui` 区块声明（§1.5），
  引擎不参与。**通用的是机制，不是视图**。

### 2.3 时间队列（delayQueue）：唯一队列

- `state.delayQueue: ScheduledEventInstance[]` 是**唯一**队列；没有第二个调度结构。
- 入队门控在入队时一次性求值（`probability` / `weight` / `once` / `priority` / `conditions`），
  出队时只复核**前提**（`missWhen` 与 `trigger.conditions`）。
- 排序键（严格全序）：`window.start` → 是否有 `window.end`（无 = +∞）→ `window.end` → 入队序号。
- 错失（append-only，进 `state.missedEvents`）只有两种原因：`window_expired`、`miss_when`；
  门控失败**不算错失**（不产生实例）。
- `kind: "combat"` **不得**进事件池（不允许被随机抽出来直接开战）。
- **队列不投影**：`delayQueue` 只存在于 `WorldStateV2`，不进 `V2Snapshot`——
  玩家看不到"下一件要发生什么"，也看不到"还差几回合"。
  进度感只能来自**已经发生过的事**，或模板自己声明的事件链类型（§4.9）；不能来自队列。
  理由：队列是引擎的调度实现，把它摊给玩家等于把底牌翻开，也等于把"什么时候演什么"
  变成一种玩家可优化的资源——那是另一种游戏。

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
- **事件链的类型与呈现**：见 §4.9。
- **`ui.yaml` 的形状**：扁平开关（`views: <能力>: bool`）还是落位（`place: <能力>: tab|overlay|slot:<host>|off`）。
  取决于插槽化要不要现在定（见 §1.5）。
- **插槽化的宿主/槽位模型**：宿主视图怎么声明自己有哪些槽、能力被塞进不认识的槽怎么办（§1.5 已给降级口径）。
- `layout` / `style`（声明式布局与样式覆盖）。
- **扩展层（§1.6）**：扩展能否带自己的前端组件（与插槽化绑在一起）；能否带测试与 fixture 模板；
  `effects` 从闭合联合改成注册表时，`packages/shared` 与加载器怎么分担 schema 合并的活。

### 4.8 叙事注入：`lore.md` / `prompt.style` / `invoke.instruction`（已实现）

模型写出"人话"靠三样东西，分工明确、互不越界：

| 注入物 | 声明位置 | 作用域 | 谁选 |
|---|---|---|---|
| **设定条目** | `<template>/lore.md` | 按内容命中，逐次不同 | **引擎**（`selectInvocationLore`） |
| **文风** | `rules.yaml` 顶层 `prompt.style` | 整份模板恒定 | 模板作者 |
| **本幕要求** | `rules.yaml` → `llmTriggers[].invoke.instruction`（≤300 字） | 单条触发 | 模板作者 |

**`lore.md` 格式**（非 yaml；`## 标题` 切条目，标题即 id，重名拒载）：

```markdown
## 无下限术式
> keys: 无下限, 术式, 苍, 赫 | p:100
正文……（空正文拒载）
```

- 元信息行紧跟标题、以 `>` 开头，`|` 分段：`keys: a, b` / `always` / `p:N`（0..100）。
- 缺省：没写 `keys` ⇒ `always = true`；写了 `keys` 没写 `always` ⇒ 关键词触发。
- 未知元信息 / `keys` 为空 / `p` 越界 / 重名 / 空正文 ⇒ **拒载**，错误信息带条目标题。

**筛选在引擎侧，agent-runtime 不做匹配**（这条边界和"AI 不碰权威状态"同源）：

- 语料 = 当前槽事件的 `title` + `narrative` + 最近 8 条非 `hidden` 的 `history.summary` + 本次 `contextHints` 字符串值。
- 常驻条目全进；关键词条目只要**任一** key 出现在语料里就进。
- 排序 `p` 降序 → `id` 升序；截断到 **≤6 条 / ≤6000 字**（按排序截断，不跳条）。

**注入位置**（切两段，为了让前缀缓存命得中）：

- **stablePrefix**（同一"世界骨架 + 能力画像 + 输出契约 + 工具表"**字节稳定**）：
  世界骨架 → 能力画像 → 输出契约 → `# 文风约束`（`prompt.style`）→ `# 设定（常驻）` → 工具与参数。
- **reactive 段**：只放**关键词命中**的 `lore`（逐次不同，不能污染前缀）。

**输出契约**（`agent-runtime/src/context.ts`，11 条硬规则，全部来自真实模型翻车）：

- 只写简体中文散文；不带 markdown / 标题 / 列表符 / 引用块。
- **不得复述状态数字**（"你的生命值还有 42"不是叙事）。
- **必须紧接 `recentTurns` 最后一条往下写**，不许跳回更早的桥段。
- **不替玩家说话或做决定**（不写"你说……""你决定……"）。
- **第二人称"你"**指主角；契约里给了正误对照例。
- 不得违反 `[设定]`（`lore`）；80–220 字，1–3 段。

**出口还要过两道**（`agent-runtime/src/loop.ts`）：

- `sanitizeNarrative`：ASCII 成对双引号 → 「」，剥行首 markdown 符，剥内联 `**` / 反引号。
- `normalizeNarrative`：分段落、按首现去重（真实翻车：553 字 10 段只有 6 段不重复）、
  按段落边界截到 420 字。

### 4.9 事件链的类型与呈现（`未决`）

**现在有什么**：`V2Snapshot.world.storyChapter`（数字）取自 `flags.chapter`——模板按约定
在 `opening.yaml#worldSetup.flags` 起 1，事件用 `setFlag` 推进。前端只要有这个数字就显示
"第 N 章"，没有就不显示。

**这个做法的洞**：章节号是**模板私有的 flag 名约定**，不是协议。换一份模板把 key 叫 `arc`、
或者根本不关心章节，前端就无从知道——和 §1.5 说的同一件事：**功能差异能用 flag 表达，
展示差异不能**。而且它只有一个标量：说不出"这是主线还是支线"、"这条链一共几幕"、
"这一条是倒计时还是路线"。

**方向（未决，不是承诺）**：把"链的类型"升成**事件链协议里的第一等字段**，让引擎能回答
"当前这一幕属于哪种链、在这条链的什么位置"，再由模板声明这种链**该以什么形态呈现**。
和 `ui.yaml` 的分工：那边管"某个能力摆不摆、摆在哪"，这里管"这条线是什么、该让玩家看见什么"。

**硬约束（先钉死，免得实现时跑偏）**：

1. 不许靠投影时间队列实现（§2.3）。玩家看见的只能是**已发生**的位置，不是**待发生**的清单。
2. 引擎不编造名字：链的中文名、幕名都来自模板；缺省就不显示，而不是显示 `chain_1`。
3. 不能变成第二套 `taskDag`：`taskDag` 是因为"有结构没消费者"被整套删的
   （前车之鉴，见 `docs/REFACTOR-NOTES.md`）。这次要先有**确定的呈现消费者**，再加字段。
4. 加字段不改既有语义：没声明链的事件照旧跑，`storyChapter` 那套 flag 约定在迁移期继续有效。

**待答**：链的粒度（每条支线一条链 / 只有主线算链）、链的类别闭合集、
位置是"第几幕"还是"百分比"、AI 能不能在 `story.submitBranch` 里声明新链。

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

### 5.3 P0 覆盖（已实现，27 例）

> 口径：`grep -rho "^\s*\(it\|test\)(" test --include=*.test.ts | wc -l`。
> 下表按**能力**分行，一个能力可能对应多例。

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
| 13 | `lore.md`：解析（常驻 / 关键词 / `p`）、`keys` 为空拒载且报标题、引擎筛选与排序（§4.8） |
| 14 | 上下文分层：`prompt.style` 与常驻 lore 进 stable prefix，关键词 lore 进 reactive，两段不混 |
| 15 | 录制 → 回放：回放的 `calls` / `contentBlocks` 与录制逐字段一致，第二轮自然退出 |
| 16 | `rpg-ui` 源码守卫：组件不出现 `V2Snapshot`（`adapter.ts` 除外）、不 import 宿主 api/store、不发请求 |

### 5.4 未做（明确不承诺）

- **UI 测试**：本轮不做（体系留着，`test/` 下可加 `ui/`）。
- 真实外部 LLM 的联网用例：不在自动化里跑（要跑就手工、用玩家自己的 key）。
- 未覆盖：`submitBranch` 的节点级 `npcs` alias 解析、跨轮写护栏、`once` 的调度器全路径、
  真实 jjk 模板的结局线（用专用最小模板替代）。

---

## 附：怎么验证这份文档没有骗人

```bash
pnpm typecheck     # 类型 0 错
pnpm test          # 27 例 P0
pnpm build         # 前端可构建
PORT=3000 pnpm --filter @life-sim/server start   # 三个模板 loadable
```

任何一条跑不过，说明本文件对应的描述已经过期——改代码或改这份文件，不要两者都留着。
