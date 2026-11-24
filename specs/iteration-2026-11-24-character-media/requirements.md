# requirements · 角色媒体与技能演出 V1

> 上游：`README.md`（需求与裁决）。本文只写**要什么**与**怎么判过**，不写怎么做（见 `design.md`）。

## 1. 背景

模板里已经有 6 张五条悟的立绘（`specs/data/templates/jjk-2006/3.0.0/assets/characters/`），
但**没有 `assets/manifest.yaml`**，所以它们从来没被下发过；投影侧的 `state.media` 只有 LLM
叙事块会写，人物本身的形象在界面上不存在。

同时，`sk-hollow-purple` 之类的技能在战斗里只有 `cast / trace / hit` 三段几何特效，
没有「这是谁在放什么」的那一下停顿。

## 2. 目标

| # | 目标 | 判据 |
|---|---|---|
| G1 | 人物有头像与立绘 | 人物面板、叙事气泡、战斗面板能看到对应形象 |
| G2 | 形象随时间/剧情变化 | 2006 高专 → 2017 教师 → 2018 新宿自动切换；显式切换可存读档 |
| G3 | 技能有 CutIn 演出 | 释放技能时先播「人物 + 技能名」，再播现有 FX，可跳过 |
| G4 | 素材缺失不阻塞游戏 | 任何资源 404 / 未登记 / 离线缺失 ⇒ 走占位符，游戏继续 |
| G5 | 加素材不毁存档 | 只改媒体配置时，旧存档照常载入 |

## 3. 功能需求

### R1 · 资源登记

- 模板可以用 `assets/manifest.yaml` 登记静态资源（沿用 `AssetDescriptorSchema`：`assetId / path / kind / tags / characterRef / visibility`）。
- 已登记资源可通过现有端点 `/api/templates/:id/:version/assets/:assetId` 取到。
- **未登记**的 `assetId` 必须降级为占位符，不得抛错、不得中断回合。

### R2 · 人物媒体配置

- `ui.yaml` 新增顶层 `characterMedia`：`characterId → { defaultSkin, skins, skinRules? }`。
- 一个皮肤可以声明 `avatar / bust / full / cutIn / skillCutIns`，除 `name` 外全部可选。
- **没有** `characterMedia` 的人物保持现有展示行为（不显示图，退文字头像）。

### R3 · 槽位与回退

| 请求槽位 | 回退链（**只在同一皮肤内**） |
|---|---|
| `avatar` | avatar → bust → full → 占位符 |
| `bust` | bust → full → avatar → 占位符 |
| `full` | full → bust → avatar → 占位符 |
| `cutIn` | skillCutIns[skillId] → cutIn → bust → full → 纯文字 |

不跨皮肤混用（避免 2017 的五条用 2006 的头像）。

### R4 · 皮肤集合与解析优先级

优先级（高 → 低）：

1. 实例 `skinId`（显式，持久化）
2. `skinRules` 中**首个满足条件**的皮肤
3. `defaultSkin`
4. `customSkin`（V1 仅预留，不产生）
5. 占位符

- 扮演原作人物（`who.kind = reuse`）时，**完整保留**该角色的模板皮肤集合。
- 自建角色没有皮肤集合 ⇒ 直接占位符。

### R5 · 自动切换（条件子集）

`skinRules[].when` 复用现有 `Condition` 协议，但 **V1 加载期只放行三类**：

| 条件 | V1 |
|---|---|
| 世界时间（`time`） | ✅ |
| 全局 flag（`flag`） | ✅ |
| 全局事件事实（`eventOccurred` 等） | ✅ |
| 人物自身状态（`status`） | ❌ 加载期拒载 |
| 人物自身属性（`attribute`） | ❌ |
| 人物关系（`relation`） | ❌ |

被拒的写法在 `inspect check` 与加载期都要报错，**不许静默忽略**。
人物状态驱动的换装（受伤、变身）在 V1 用 `setSkin` 显式切。

### R6 · 显式切换

- 新增 Effect `{ type: setSkin, who?, skinId }`；`who` 缺省 self，`skinId: null` = 清除覆盖、回到自动。
- 只能指向**同一角色**已声明的皮肤；指向未声明的皮肤 ⇒ 加载期 `checkEffectRefs` 报错。
- 切换结果**进存档**（`skinId?` 落 `state.player` / `state.npcs[i]`），存读档后一致。

### R7 · 皮肤归属身体

- `skinId` / `customSkin` **不参与** `transplantActor` 的任何字段组。
- 夺舍（`inheritActor`）后，形象跟着**身体**走；表现上的变化（如缝合线）由剧情 `setSkin` 决定。

### R8 · 战斗单位

- 敌人与召唤物**没有** NPC 实例，媒体只能按 `Combatant.characterId` 查模板 `characterMedia`。
- 找不到就占位符。**不得**为了取图而给战斗单位造 NPC 实例。

### R9 · CutIn 演出

- 在 `ui.presentation.skills[skillId]` 上新增 `cutIn?: { durationMs?, title? }`；存在即启用。
- 播放顺序：**CutIn → Cast FX → Trace FX → Impact FX → 结算表现**。
- 触发依据是**技能释放事件**（`cast.seq`），不是 UI 点击。
- 同一段释放只播一次；AoE / 多段命中不重复播。
- 可跳过；跳过 / 超时 / 组件卸载都必须**放行**后续 FX。
- **不阻塞内核结算**：引擎照常返回快照，演出只是表现队列。

### R10 · 离线

- 模板媒体用独立缓存，与 App Shell 解耦；`stale-while-revalidate`。
- 断网时已缓存的媒体正常显示，未缓存的走占位符。

### R11 · 指纹与存档

- 只改 `ui.yaml` / `assets/manifest.yaml` **不得**导致存档拒载。
- 真正的机制漂移（事件 / 技能 / 数值 / 角色定义变化）**仍按现有策略拒载**。

### R12 · 通用性

- 引擎与共享包**零作品专名**：不得出现「五条」「虚式·茈」等；不得按 `templateId` 分支。
- 皮肤、CutIn 的配置全部由模板提供。

## 4. 非功能需求

| # | 要求 |
|---|---|
| N1 | 资源**不进存档 JSON**，只存 `assetId` 引用；不持久化 blob URL |
| N2 | 媒体缓存默认上限 **128 MB**，超出按最久未用淘汰；失败不影响游戏 |
| N3 | 首屏不因媒体阻塞：图片懒加载，缺失即占位符 |
| N4 | 旧存档（无 `skinId` 字段）零迁移可用 |
| N5 | `ui.yaml` 仍**不进**语义指纹 |

## 5. 验收清单

| # | 用例 | 判据 |
|---|---|---|
| 1 | 旧模板、旧存档 | 无需迁移即可运行 |
| 2 | 五条 2006 → 2017 | 头像 / 立绘自动更新 |
| 3 | 时间回溯 | 回到 2006 后自动皮肤回到 `student` |
| 4 | 显式切换 | `setSkin` 后存读档一致 |
| 5 | 清除覆盖 | `skinId: null` 后恢复条件切换 |
| 6 | 原作开局 | 扮演五条时皮肤集合完整（student/teacher/shinjuku） |
| 7 | 自建角色 | 无媒体 ⇒ 文字头像，不报错 |
| 8 | 敌人 / 召唤物 | 按 `characterId` 解析到模板媒体 |
| 9 | 同技能不同人 | 演出素材取自各自皮肤 |
| 10 | AoE | 只播一次 CutIn |
| 11 | 多段攻击 | 只播一次 CutIn |
| 12 | 跳过演出 | 跳过立刻放行 FX，结算不受影响 |
| 13 | 读档 | 不重播历史演出（沿用 `fx.seq` 游标） |
| 14 | 资源缺失 | 404 / 未登记 ⇒ 占位符，游戏继续 |
| 15 | 离线 | 已缓存媒体断网可显示 |
| 16 | 只改媒体配置 | 旧存档不因指纹拒载 |
| 17 | 夺舍 | 羂索夺舍夏油后显示夏油形象，而非上一具身体 |
| 18 | 机制漂移 | 改事件/技能定义仍判 `template_content_drift` |

## 6. 依赖与假设

- `ui.yaml` 已被排除在语义指纹外（现网事实）。
- 当前仓库**没有** `assets/manifest.yaml` ⇒ 本轮第一次引入，兼容窗口详见 `design.md §3.4`。
- 素材由人工准备（不做生成）；缺失可用占位符顶着。
