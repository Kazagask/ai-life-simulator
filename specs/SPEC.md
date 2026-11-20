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

### 1.2 世界模板的接入层级（2026-11-18 重定）

> 用户裁决：**只用三层**。L0 最简；L1 深度利用内核本体；L2 = 本体不够用、需要扩展包，
> 且**任意扩展都算 L2**（不再按"资源 / 声明式 / 展示 / 扩展"细分六档）。
>
> 旧表的 L1 资源、L2 深度 yaml、L3 复用宏、L4 展示声明全部收进 **L1**（都是内核本体能力）；
> 旧 L5 扩展层即 **L2**。旧编号在本文件其余章节若被引用，一律按本表映射理解。

| 层 | 定义 | 当前状态 |
|---|---|---|
| **L0 最简模板** | 只写必要的 yaml 即可跑完一局（§1.3 的 6 个必需文件） | **已实现** |
| **L1 深度利用内核本体** | 用内核自带的全部声明式文件：`assets/manifest.yaml`（资源）、`rules.yaml` / `lore.md` / `prompt.style`（叙事注入）、`opening` / `endings` / `evaluation`（流程分域）、更复杂的事件/触发/效果、`ui.yaml`（展示落位）。**不写扩展代码** | **已实现**（`ui.yaml` 形状 B 已落地）；`layout` / `style`、模板 include / macro / anchor、事件/叙事**引用媒体的契约**仍 `未决`；复杂触发原语 / 结算形状仍受 §3 闭合 schema 限制 |
| **L2 需要扩展包** | 内核本体不够用：模板 + 代码打包成套逻辑（多个世界共同、但不是所有世界通用）。**任意扩展都归这一层**，当前实例是 `family` | **已实现**（扩展层契约见 §1.6，实例见 `extensions/family/spec/SPEC.md`）；扩展版本约束已落地（§1.6） |

**L1 / L2 的判据**：能不能只靠 `specs/data/templates/<id>/<version>/` 下的声明式文件表达？
能 ⇒ L1；需要写 TypeScript 并注册 runtime ⇒ L2。`ui.yaml` 只声明"能力摆哪"，不改变判定与结算，
所以它属于 L1，不是 L2。

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

### 1.5 展示层声明：`ui.yaml`（已落地，形状 B）

> 用户 2026-11-17 裁决：**`ui` 单列成 `ui.yaml`**，不塞进 `world.yaml`；只做「能力怎么摆」，
> 不做 auto 推导，只影响前端渲染。**2026-11-18 施工完成**：形状选定 B（落位），
> 服务端 loader + 前端落位分发 + 三个模板基线声明全部落地。

**位置**：`<template>/<version>/ui.yaml`，白名单第 15 个文件。独立 loader（`UiConfigSchema`，
`.strict()`），**不并入** `TEMPLATE_MERGE_FILES`，schema 失败加载期拒载。
**指纹**：进白名单、不进语义指纹 —— 改页签不让旧存档拒载（有定向测试锁定）。
**下发**：只在响应出口经 `decorateSnapshot()` 挂到快照的 `ui` 字段；`WorldStateV2` 与内核
全程不读它。

**形状 B —— 落位**（形状 A 扁平开关已废弃，不再接受）：

```yaml
place:
  life: tab                  # 顶层页签
  personal: tab
  world: tab
  log: tab
  records: tab
  npcList: tab               # 「世界」页的 NPC 子页，同时是宿主
  character: slot:personal   # 嵌进个人页
  equipment: slot:personal
  inventory: slot:personal
  skills: slot:personal
  relations: slot:npcList
  wheel: overlay             # 事件区按需浮层
  battle: overlay
  event: overlay
  pedigree: slot:world.subview   # 扩展能力 id，必须有扩展声明
  clan: slot:world.subview
```

落位四值：`tab`（页签）/ `overlay`（按需浮层）/ `slot:<hostId>`（嵌进宿主）/ `off`（关常驻入口）。
**能力 id 闭合**：宿主内建集在 `packages/shared/src/schema/ui.ts` 的
`BUILTIN_UI_CAPABILITIES`；扩展能力由 `ExtensionRuntime.uiCapabilities` 声明，
加载期合并校验，写错键名即拒载（`ui.yaml: 未知能力 id ...`）。

**四条语义**（已实现）：

1. **缺省等于现状**：不写文件 / 只写几项 ⇒ 其余按 `DEFAULT_UI_PLACEMENTS` 保持内建布局。
2. **嵌不进去降级 `tab`**：前端 `resolvePlacement()` 只认已知宿主槽；未知槽退化为页签，
   不留黑洞。事件区能力（`wheel` / `battle` / `event`）无页签形态，写成 `tab` 一律按 `overlay` 处理。
3. **只关常驻入口，不关推进路径**：`off` 的能力若成为当轮唯一推进路径（引擎
   `pending_event_required`），前端 `MinimalSlotForm` 给出恰好够提交的最小形态，不许软锁。
4. **不是规则**：引擎不读 `ui.yaml`，改它不改变一局的结果。

**预留**：`layout`（声明式布局）与 `style`（声明式样式覆盖）仍未落地，标 `未决`。

### 1.6 扩展层：extension（已落地，即 L2）

> 用户 2026-11-17 裁决：名字叫 **extension**，不叫 plugin / mod。装的是
> 「**多个世界共同、但不是所有世界通用**」的逻辑——玄幻拓展、都市拓展、家族拓展。
> **2026-11-18 施工完成**：版本声明（`requires`）、family 自有 doc/spec/test 归位、
> 主包能力占用台账 `docs/EXTENSION-CAPABILITIES.md` 全部落地。

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
| `effects` | **27 种**闭合 `z.union` + `engine.ts` 的 switch；白名单外交给扩展分发，未命中抛 `unknown_effect`（**不静默 no-op**） | 新增效果类型 |
| `derivations` | `relationDerivation` / `snapshotDerivation` / `contributeRelationEdges` | 投影期派生（称谓、系谱、指针合成边）；合成边只活在投影里 |

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
- 模板在 `world.yaml` 顶层声明 `extensions: { family: true | <config> }`（键 = 扩展 id，出现即启用）。
  缺扩展 ⇒ **该版本不可载**，封闭码 `unknown_extension`，`/api/templates` 与建局 409 都带 `reasonCode`。
  **按版本拒载、不拖垮进程**：一个模板少了扩展包，只让它自己不可载，其它模板照玩——
  崩溃式 fail-fast 会让别人的存档一起陪葬。若全部模板都不可载，仍会命中原有的 `no_templates_found`。
  **版本声明已落地**（2026-11-18）：`world.yaml` 顶层可写
  `requires: { core: "^0.1.0", extensions: { family: "^0.1.0" } }`。加载期三向核对：
  世界要求的主包版本 vs `ENGINE_VERSION`、世界要求的扩展版本 vs runtime.version、
  扩展的 `requiresCore` vs 当前主包。区间格式见 `satisfiesVersion()`（精确 / `^` / `>=` / `*`）。
  不符 ⇒ 封闭码 `core_version_mismatch` / `extension_version_mismatch`，**只废这一个版本**。
  不写 `requires` 的老模板零回归。
- **扩展自有归位**：`extensions/family/{doc,spec,test}`（设计、实现规范、测试）；
  主包侧 `docs/EXTENSION-CAPABILITIES.md` 记录扩展用了主包哪些能力，供升级核对。
  `uiCapabilities` 声明扩展给 `ui.yaml` 的能力 id（`pedigree` / `clan`）。
- **扩展配置进语义指纹**：`extensions` 的 id/config 在 `world.yaml` 里天然被覆盖，**runtime.version
  也显式并入指纹**（`extension:<id>` → version）。改开关或改扩展版本 ⇒ 该模板旧档拒载。
- 「加扩展」= 加目录 + 模板声明 + 重启；「改扩展」= 升 `version` + 重启 + 相关旧存档拒载。

**为什么不做热加载**：`game-core` 的核心资产是「同 seed + 同输入 ⇒ 同结果」，整套回放测试
（`test/unit/replay.test.ts`）建在它上面。规则能在运行时被替换 ⇒ 同一存档两次跑出不同结果 ⇒
回放、e2e、旧档复现一起失效。另外启动期加载时，坏扩展开机那一刻就在 `/api/templates` 上暴露；
运行期替换则是"线上某刻炸掉"，还连着正在跑的局。

**第一个真实样本**：`extensions/family`（已落地）。实现、契约、测试分别在
`extensions/family/{src,spec,test}`，设计理由在 `extensions/family/doc/`。
它是 `derivations` 口的第一个用户；主包侧的能力占用台账见 `docs/EXTENSION-CAPABILITIES.md`。

**已落地**：扩展自带前端组件（`ExtensionUiRuntime.views` + 宿主槽，见 §4.6 与
`docs/EXTENSIONS.md` §7）、扩展自带测试（`extensions/family/test/`，由根
`vitest.config.ts` 收集）。**未决**：扩展能否带自己的 fixture 模板；
`effects` 从闭合联合改注册表时 `shared` 与加载器的 schema 合并分工。

---

### 1.7 表现层：样式 / 效果摘要 / 回合增量 / 叙事分段（已落地，ADR-002）

> 2026-11-18 施工完成。一份协议解决四件事：**实体长什么样**（样式）、**它有什么效果**
> （效果摘要）、**这一回合发生了什么**（回合增量）、**这一回合怎么讲**（叙事分段）。
> 全部是只读投影：不进 `WorldStateV2`、不参与判定、不进语义指纹。

**样式词汇受控**。模板只能写 `preset`（稀有度 8 档 `rainbow`(动虹) / `rainbow-static`(静虹) /
`gold` / `orange` / `pink` / `purple` / `blue` / `white`，正负 3 档 `green` / `red` / `gray`）、
`color`/`background`（`#rgb`/`#rrggbb`/`#rrggbbaa` 或引擎 token）、`bold`、
`animation`（`none/rainbow-flow/pulse/glow`）；**不接受任意 CSS**。
解析顺序（`game-core/v2/presentation/style.ts`，投影期唯一实现）：
实体 `style` > **命中样式的第一个 tag** > `ui.qualityStyles[quality]` > `ui.polarityStyles[polarity]`。
未知样式 id / 未知标签 id 在**加载期拒载**（`style_ref_invalid` / `style_ref_invalid`），不静默回退。

**标签（D2b / D2c）**：`rainbow` 是引擎的视觉变量名，**不出现在界面上**；玩家看到的是标签名。
状态 / 物品用 `tags: [...]` 引用，顺序即优先级（品级写在前面 ⇒ 名字与品级同色）。技能不参与标签。

品级 / 增益 / 异常是**引擎预置**的，模板不用声明：

| id | 名称 | 视觉 | | id | 名称 | 视觉 |
|---|---|---|---|---|---|---|
| `mythic-unique` | 唯一·神话 | 动态彩 | | `excellent` | 五品·卓越 | 紫 |
| `mythic` | 一品·神话 | 静态彩 | | `rare` | 六品·稀有 | 青 |
| `legend` | 二品·传说 | 金 | | `fine` | 七品·精良 | 蓝 |
| `epic` | 三品·史诗 | 橙 | | `common` | 八品·寻常 | 白 |
| `treasure` | 四品·珍宝 | 粉 | | `poor` | 九品·粗劣 | 灰 |
| `abnormal` | 异常 | 红 | | `buff` | 增益 | 绿 |

**品级 ↔ 标签联动**：实体的 `quality` 可以直接写上面的**品级阶梯 id**，
投影期会自动生成一条对应标签（名字 + 配色），不必再写一遍 `tags`：

```yaml
- id: eq-ten-spear
  quality: mythic          # ⇒ 自动得到「一品·神话」标签与静态彩
```

`tags` 仍可用且优先级更高（「品级 + 增益」这类多标签）。模板自定义的品质词
（如 `cursed`）继续走 `equipment.qualities` 白名单；校验口径是「阶梯 id **或** 白名单里的词」。

模板想换叫法 / 配色就覆盖同名 id，其余继续继承预置：

```yaml
# ui.yaml（可选）——不写就用上面的预置
tags:
  mythic-unique: { name: 神话, style: { preset: rainbow, animation: rainbow-flow } }
```

`tags[].style` 同时作用于**标签芯片**与**实体名**：`六眼` 挂 `[mythic, buff]` ⇒ 名字动虹、
标签「神话」动虹、「增益」绿，四端（个人页 / NPC / 战斗 / 浮层）一致。

**效果摘要**（`presentation/effects.ts`）：从定义派生 `{ text, kind, tone, ref? }`。
`kind: "control"` 是固定效果（「战斗中无法行动」），前端加**下划线**；数值条目带 `+/-` 与
增益绿 / 减益红 / 中性灰。动态状态只描述规则（`3 + 0.2×咒力`），**不算值**。
底层效果**只写能力限制，不写回合数**——「几回合」是状态的 `duration` / `combat.battleRounds`。

**回合增量**（`presentation/gains.ts`）：`captureGainBaseline` + `diffGains` 差分玩家可见
五类（属性 / 状态 / 技能 / 物品 / 装备）。五个写操作响应统一带 `gains`，**不落库**，
刷新即消失；历史由叙事区承担。

**叙事分段**（`narrative/turn.ts`）：每回合最多一条叙事块写进同一 trace；转盘只在
**确认后**才把 `⚄ …` 写进正文（`state.slot.eventId === wheelResult.eventId` ⇒ 尚未结算）。
判据是 **provider 是否为 mock**（不是「trace 里有没有块」——invocation 落盘时机与事务收尾
不保证先后）；真实 LLM 是作者，模板只填空缺。`ContentBlockVM` 带 `turnIndex`，
前端据此只给最新回合播打字机。

**契约**：`schema/style.ts`、`schema/effects.ts`、`view-model.ts` 的 `EffectSummaryVM` /
`TurnGainVM` / `StatusVM.effects` 等；`rpg-ui` 的 `StyledName` / `EffectList` /
`DetailSheet` / `TurnGainsCard` 是默认实现，自定义前端可复用同一份数据自己画。

---

### 1.8 属性类型与自定义资源（已落地，ADR-003）

> 2026-11-19 施工完成。属性不再只有「整数」一种；资源不再只有 HP/MP。
> 两者都仍是**纯声明**：模板写 yaml，引擎求值，投影解析，前端只消费视图。

**属性值**统一为 `number | string`（`WorldStateV2.player.attributes` / NPC / 战斗单位同形），
**类型由模板 `attributes.defs[id].kind` 决定**；没有 def 的属性一律 `number`（旧模板零迁移）。

| kind | 存档值 | 展示 | 典型 |
|---|---|---|---|
| `number`（缺省） | number | 数字 | 咒力 / 智力 |
| `enum` | 选项 id（string） | 选项 label + 样式 | 生得术式「无下限术式」、等级「特级」 |
| `ladder` | number | 当前档 label + 本档进度条 | 武艺「熟手 20/50」 |
| `composite` | **不存储** | 由 sources 派生的称号 + 样式 | 名誉：恶名 + 善名 → 恶贯满盈 / 亦正亦邪 |

```yaml
attributes:
  order: [cursedEnergy, ..., grade, innateTechnique, infamy, virtue, fame]
  defaults: { grade: grade-4, innateTechnique: none, infamy: 0, virtue: 0 }
  caps: { infamy: 2, virtue: 2 }
  labels: { grade: 等级, innateTechnique: 生得术式, infamy: 恶名, virtue: 善名, fame: 名誉 }
  defs:
    grade:
      kind: enum
      values:
        - { id: grade-4, label: 四级, style: gray }
        - { id: special, label: 特级, style: gold }
    infamy:
      kind: ladder
      hidden: true                 # 参与规则、不进属性面板
      tiers:                       # cumulative：at 是累计阈值，升档不归零
        - { id: none, label: "—", at: 0 }
        - { id: plus2, label: "＋＋", at: 2 }
    fame:
      kind: composite
      sources: [infamy, virtue]    # 只接受数值属性
      cases:                       # 声明顺序 = 优先序，首个全匹配生效
        - when: { infamy: { gte: 2 }, virtue: { gte: 2 } }
          label: 乱世枭雄
          style: rainbow
      fallback: { label: 默默无闻, style: gray }
```

- **ladder** 两种模式：`mode: cumulative`（缺省，累计阈值）与 `mode: reset`
  （`at` 是本档升到下一档所需；升档扣减，档位落 `player.attributeTiers`）。
- **composite** 只读：不可被效果写入、不可被条件引用；`hidden` 的轴只作为它的输入。
- **效果**：`adjustAttribute`（仅数值属性）与 `setAttribute`（数值 / 枚举选项 id）。
- **条件**：`{ attribute, eq/ne }` 接受字符串；`gte/lte/gt/lt` 只对数值属性；
  `{ attribute, tier }` 只对 ladder（当前档 id）。两个求值入口共用
  `game-core/v2/attribute-rules.ts`，不各写一份 switch。
- **加载期 fail-fast**：defs 结构、enum 选项、ladder 档位单调、composite 来源/兜底、
  数值面（`caps` / `perAttribute` / `attributeModifiers` / 公式 `scaleBy` / 命中判定 /
  转盘权重 / 装备动态状态）只引用数值属性、样式引用合法。

**人生页人物卡展示哪些属性**（`ui.yaml`，展示声明、不进指纹）：

```yaml
playerCard:
  attributes: [grade, innateTechnique, fame, cursedEnergy, intellect, physique]
```

顺序即展示顺序：`number` / `enum` / `composite` **两列一格**（纯文字，**不做胶囊**，避免与状态芯片
同形），`ladder` 独占一行（标签 + 档位 + 本档进度条 + `value/max`）。
键必须是 `attributes.order` 里声明过的属性（加载期拒载）；缺省 = 全部可见属性。
适配器把它算成 `PlayerVM.cardAttributes`，个人页仍用 `player.attributes`（全部）。

**投影**：`V2Snapshot.player.attributeViews` / `npcs[].attributeViews` 是**已解析**的属性视图
（顺序 = `order`、hidden 已剔除、enum/ladder/composite 的 label 与样式都已算好）。
原始 `attributes` 记录保留（含 hidden）。前端只消费视图，不查模板。

**自定义资源**（`world.yaml` 的 `resources`，hp/mp 之后追加任意 id）：

```yaml
resources:
  hp: { base: 100, perLevel: 0 }
  mp: { base: 50, perLevel: 0 }
  beans: { label: 决意, base: 5, cap: 5, initial: 5 }   # 上限 5、开局满

# ui.yaml（纯渲染，不进指纹）
resources:
  beans: { display: pips, dangerAt: 0 }
```

- 上限 = `base + perLevel × growthLevel + Σ perAttribute × 基础属性值`，受 `cap` 限制
  （未写 perAttribute 的属性按 0 计）；`initial` 缺省 = 上限。
- 自定义资源存 `player.resources`（不含 hp/mp），战斗镜像同形，结束回写。
- **技能消耗**：`cost` 在 `mp` 之外可写任意已声明资源（如 `beans: 3`）；引擎逐项检查、
  逐项扣除，不足拒绝（`not_enough_resource:<id>`）；战斗视图下发 `costs`。
- **资源条**：只显示模板 `statusBar` 中 `source: resource` 的段（顺序即展示顺序）；
  `display: bar | pips` 决定条形 / 刻度；`dangerAt` 是告警阈值比例（0 = 永不告警）。
- **效果**：`adjustResource { resource, value }` 可写任意已声明资源（事件 / 选项 / 物品 / NPC 行动 / 战斗内用物品）。
- **回复渠道**：`regen` 是 effect 之外**唯一**的被动回复通道——`regen.perTurn[key]` 与
  `regen.actions.<actionType>[key]` 对**所有已声明资源**生效（含自定义，缺键 = 0，负值不写入）；
  技能 `heal` 只作用于 hp，不参与自定义资源；战斗结束按镜像回写。
- **战斗内每回合回复**（ADR-003 D12）：`world.yaml regen.combat`（玩家）与 `characters[].combatRegen`
  （敌人 / 友军），任意已声明资源、缺键 = 0、非负，`roundEnd` 末尾结算并写战报。
- **回复量可加权**：四处 regen 的值都可写 `{ base, perAttribute }`，按**基础属性**求值后四舍五入
  （如 `beans: { base: 0, perAttribute: { body: 0.4 } }`）；系数只接受数值属性。

**兼容**：属性值 union、`resources` 追加、`player.resources` 默认 `{}` 都是向后兼容的放宽，
旧档可直载，**schemaVersion 保持 5**；模板语义变化由指纹承担。

### 1.9 开局加点（已落地，ADR-004）

> 2026-11-19 施工完成。开局 DAG 的 `allocate` 节点从「预留形状」变成可用链路：
> 模板声明点数从哪来、能加到哪些属性，玩家在提交前自行分配，commit 时按增量落进玩家属性。

```yaml
params:
  - { id: talentRoll, kind: number }          # 开局期标量，commit 不落世界字段
  - id: talentPoints
    kind: points
    budgetFrom: talentRoll                    # 预算来源；也可直接写 budget: 5
    targets:                                  # 白名单：只能列数值类属性
      - { attribute: cursedEnergy, min: 0, max: 3, style: purple }
      - { attribute: intellect, min: 0, max: 2 }

nodes:
  - { node: n12b-talent, mode: roll, options: [...] }     # roll 的 set 写 talentRoll
  - { node: n12c-allocate, mode: allocate, param: talentPoints }
```

- **预算**：`budgetFrom` 指向一个 `kind: number` 参数（由前面的 roll/choose 落定）；
  未声明则用字面 `budget`。没落定 ⇒ `opening_allocate_budget_unavailable`，**不回退 0**。
- **白名单**：`targets[].attribute` 必须是已声明的 `number` / `ladder` 属性；
  `enum` / `composite` 在**加载期**拒载（`opening_invalid: ...`），文本属性没有「加一点」的语义。
- **校验**（运行期四条，任一不满足 400）：键 ⊆ targets、非负整数、落在 `[min,max]`、
  合计**不超过**预算（允许放弃余额；未分完提交由前端二次确认）。错误码 `opening_allocation_*`，带属性名。
- **目标上限可选**：`targets[].max` 不写即不设上限，可把整份预算加到同一项。
- **落点**：commit 时 `attribute += value`（增量，不覆盖基础值），复用角色路径同样成立。
- **可见性**：`describeNode` 下发 `budget` + `targets[{attribute,label,min,max,style}]`
  （label 取模板覆盖 > `attributes.labels` > id；样式已解析）；每个非 0 项同时进「开局所得」。
- **组件**：`packages/rpg-ui` 的 `PointsAllocator` 是唯一实现，开局使用；
  **游戏内加点（升级/训练/奇遇）复用同一组件**，数据契约不变。

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
- **角色分派（YAML 专用 · 2026-11-18）**：**node** 可写 `as: <actorId>`；同一 `node` 别名写多份、
  各自带不同 `as` ⇒ 同一节点按当前 self 呈现不同正文与选项（天然互斥，self 恒单值）。
  多变体时必须有一份无 `as` 的兜底变体（首节点同样适用）。加载期展开成 `<id>#<node>@<as>` 独立事件，
  变体事件带一等条件 `selfIs`，兜底变体带一组 `selfIsNot`（排除所有 as，逐条 AND）。
  `goto` 到多变体节点、或**外部 `nextEventId` 指向多变体首节点父 id** 时，都自动展开为按 self 门控的
  多条**同一选项**（玩家仍只看到一条、不额外占轮次）；random/combat 的 nextEventId 指多变体首节点 ⇒ 拒载。
  **首节点可写 `as`**：多个首节点变体共用父 trigger（"共用触发器、首节点不一样"），只叠 self 门控；
  兜底变体沿用父 id（外部 `nextEventId` / `eventResolved` 零改动），as 变体用 `<id>#<node>@<as>`。
  一等条件 `selfIs` / `selfIsNot` 都读 `selfIdOf(state)`（缺省 `"player"`）。
  这是**模板侧独有**，LLM 的 `submitBranch` 不开放 `as`（其参与时角色已定，无需分派）。

LLM 侧有一条同形的 DSL（`story.submitBranch`），见 §4.4；它**不含** `as` 角色分派字段。

### 2.6 RNG 与回放确定性（2026-11-20）

内核不含 `Math.random` / `Date.now`。随机源 `Rng` 仍是裸函数 `() => number`；
`createRng(seed)` 返回 `RngStream`，额外带 `fork(label)`。fork 从「父流 seed + 当前游标 + label」
派生**独立子流，且不推进父流游标**——同位置、同 label 重复 fork 得到同一序列。
**fork label 是协议的一部分**：改名、改拼接顺序、用数组下标代替稳定 id，都等于换随机序列。

| 流 | 负责 |
|---|---|
| 模拟主线 | 事件调度 / 开局转盘 / 结算判定（`deriveTurnSeed` / `deriveOpeningSeed`）；**战斗拆分未改动它** |
| `battle.resolve` | 命中、闪避、状态/援军概率、逃跑 |
| `battle.ai` | AI 选技能 |
| `battle.target` | AI 选目标；再按 `ai.target:{round}:{instanceId}:{skillId}` 派生单次抽数。**不从 `battle.ai` 再分叉**，否则 AI 多抽一次就会挪动目标序列 |

三条战斗流的根都在本回合新建、游标固定为 0；传裸 `Rng` 的旧调用点退化为三条流共用同一游标
（legacy 兼容）。生产入口 `battleActionV2`、`simulateDuel` 与后台演练均显式 `createBattleRng`。
`combat-ai.yaml` 的 `styles[].targetPolicy: lowest | random`（缺省 `lowest`）决定目标策略，
`random` 从合法存活目标中等概率挑选。

**回放成立的四个前提**：同一 `seed` + 同一输入序列 + 同一 `schemaVersion` + 同一模板语义指纹
（语义指纹 = 14 个声明文件 + 模板声明的扩展 id/version；`ui.yaml` 只影响渲染，不进指纹）。
扩展代码改了规则语义就必须升 `ExtensionRuntime.version`，否则旧档会在同一指纹下算出不同结果。
LLM 正文只进 trace、不进权威状态，不参与回放一致性。

**加新机制的规矩**：新随机决策只申请新的命名子流，label 必须带稳定上下文 id，不许往已有流里插抽数；
确实要改老机制的序列时，按档切换（如 `rngMode: legacy | scoped`），不要原地改。

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
- **后继不重算条件**（容易踩）：`nextEventId` 指向的下一幕由 `applySuccessor`（`turn.ts:390`）
  直接写 `slot`，**不求值** `trigger.conditions` / `missWhen`——这两个只在队列扫描与候选筛选时生效。
  要让"某一幕只在条件成立时出现"，把条件写在**该事件选项的 `visibleWhen`** 上，或让上一幕不指向它。
  写成 `trigger.conditions` 是空转，不会报错，也不会有任何效果。

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
- ~~`ui.yaml` 的形状~~ **已落地形状 B**（2026-11-18，见 §1.5）；`layout` / `style` 仍未决。
- ~~插槽化的宿主/槽位模型~~ **已落地**：`HOST_UI_SLOTS` + `ExtensionView.slot`，未知槽降级
  `tab`（见 §1.5 / `docs/EXTENSIONS.md` §7）；仍缺"宿主how声明自己有哪些槽"的数据层声明。
- ~~扩展能否带前端组件 / 测试~~ **已落地**（`extensions/family/{src,test}`，见 §1.6）。
- **扩展带 fixture 模板**；`effects` 从闭合联合改成注册表时，`packages/shared` 与加载器怎么分担 schema 合并的活。

### 4.8 叙事注入：`lore.md` / `prompt.style` / `invoke.instruction`（已实现）

模型写出"人话"靠三样东西，分工明确、互不越界：

| 注入物 | 声明位置 | 作用域 | 谁选 |
|---|---|---|---|
| **设定条目** | `<template>/lore.md` | 按内容命中，逐次不同 | **引擎**（`selectInvocationLore`） |
| **文风** | `rules.yaml` 顶层 `prompt.style` | 整份模板恒定 | 模板作者 |
| **本幕要求** | `rules.yaml` → `llmTriggers[].invoke.instruction`（≤300 字） | 单条触发 | 模板作者 |
| **体裁 / 篇幅** | `rules.yaml` → `llmTriggers[].invoke.mode` / `invoke.length` | 单条触发 | 模板作者 |
| **历史窗口** | `rules.yaml` → `llmTriggers[].invoke.historyTurns`（缺省 = `budget.recentTurns` = 6） | 单条触发 | 模板作者 |

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

**输出契约**（`agent-runtime/src/context.ts`，11 条硬规则，全部来自真实模型翻车；`mode` 影响第 7、8 条）：

- `mode: narration`（缺省）：**只写这一回合的一小段**、**必须紧接 `recentTurns` 最后一条往下写**。
- `mode: recap`（章节小结 / 长休 / 回忆）：换成**收束一段已经发生的经历**、**不要写成事件清单**。
  两条逐拍约束必须被替换掉，否则模型一边被要求回顾整章、一边被告知只能写一拍，只能写缩水的流水账。
- `length`：契约里的「80–220 字，1–3 段」是**默认值**；模板可用 `minChars/maxChars/minParagraphs/maxParagraphs`
  覆盖，同时把后处理截断上限抬到 `maxChars`（缺省 420）。

- 只写简体中文散文；不带 markdown / 标题 / 列表符 / 引用块。
- **不得复述状态数字**（"你的生命值还有 42"不是叙事）。
- **必须紧接 `recentTurns` 最后一条往下写**，不许跳回更早的桥段。
- **不替玩家说话或做决定**（不写"你说……""你决定……"）。
- **第二人称"你"**指主角；契约里给了正误对照例。
- 不得违反 `[设定]`（`lore`）；篇幅见上面的 `length`（缺省 80–220 字，1–3 段）。

**出口还要过两道**（`agent-runtime/src/loop.ts`）：

- `sanitizeNarrative`：ASCII 成对双引号 → 「」，剥行首 markdown 符，剥内联 `**` / 反引号。
- `normalizeNarrative`：分段落、按首现去重（真实翻车：553 字 10 段只有 6 段不重复）、
  按段落边界截断（缺省 420 字；`invoke.length.maxChars` 更大时以它为准）。

**`recentTurns` 的来源**（2026-11-19 修正）：由 core 在构造 invocation 时填**玩家可见的历史摘要**
（`state.history` 过滤 `isPlayerVisible`，取末尾 `historyTurns` 条，字段 `turnIndex / time / kind / summary`）。
此前这里硬编码 `[]`，编排层又没有别的注入点，模型实际上只在 facts 与工具里看得到世界——
逐拍旁白还能硬撑，章节回顾必然写成空话。可见性判定仍只走 `isPlayerVisible`（R-VS-01）。

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
test/                      根测试（引擎级）：unit/ api/ fixtures/ helpers/
extensions/family/test/    扩展自有测试（13+ 例）
```

- 根测试只放 `test/`，不放回 `packages/*/src` 或 `apps/*/src`；**扩展测试放自己包内**
  （`extensions/<id>/test/`）。两者都由根 `vitest.config.ts` 收集：
  `include: ["test/**/*.test.ts", "extensions/**/test/**/*.test.ts"]`。npm 不打包测试代码。
- 根 `pnpm test` = `vitest run`（串行，`fileParallelism: false`）。

### 5.2 两条原则

1. **LLM 层永远走 mock，且 mock 数据来自真实 trace**（录制 → 回放），不手搓 payload。
   回放 provider 把 `contentBlocks[].text` 包回 `<narrative-content>`、把 `calls[].args` 序列化成
   tool_calls；并断言"回放产出的 trace 与录制时的 `calls` / `contentBlocks` 一致"。
2. **每条测试都要能红**：写完对每条做一次变异验证（故意改坏对应实现，确认测试失败，再恢复）。
   只报绿不报变异 = 没验。

### 5.3 覆盖清单（不写死例数，以 `pnpm test` 实跑为准）

> 2026-11-18 起不再在文档里钉数字：旧的「27 例 P0」早于扩展测试与主包后续新增，
> 数字会持续过期。口径改成能力清单 + 实跑命令。下表按**能力**分行，一个能力可能对应多例。

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
| 17 | `ui.yaml`：形状 B schema、`place:` 四值、未知能力 id 拒载、改 ui.yaml 不改语义指纹、三模板加载 |
| 18 | 前端落位：缺省等于现状、未知槽降级 tab、事件区能力无页签、`off` 的最小推进形态 |
| 19 | 版本声明：`satisfiesVersion` 四格式、主包版本与 package.json 同步、`requires` 不符只废一个版本 |
| 20 | family 自有：族谱 / 宗族 / 称谓 / 状态切片 / UI 槽（见 `extensions/family/test/`） |

### 5.4 未做（明确不承诺）

- **UI 测试**：本轮不做（体系留着，`test/` 下可加 `ui/`）。
- 真实外部 LLM 的联网用例：不在自动化里跑（要跑就手工、用玩家自己的 key）。
- 未覆盖：`submitBranch` 的节点级 `npcs` alias 解析、跨轮写护栏、`once` 的调度器全路径、
  真实 jjk 模板的结局线（用专用最小模板替代）。

---

## 附：怎么验证这份文档没有骗人

```bash
pnpm typecheck     # 类型 0 错
pnpm test          # vitest run：根 test/ + extensions/family/test/
pnpm build         # 前端可构建
PORT=3000 pnpm --filter @life-sim/server start   # 三个模板 loadable
```

任何一条跑不过，说明本文件对应的描述已经过期——改代码或改这份文件，不要两者都留着。
