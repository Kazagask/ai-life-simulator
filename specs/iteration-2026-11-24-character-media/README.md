# iteration-2026-11-24-character-media

角色媒体与技能演出（V1）。

一句话：**让人物真的长得像那个人** —— 头像、半身立绘、多皮肤与自动切换、技能 CutIn，
且**不把角色媒体做成底层引擎改造**。

基于 `feat/local-first` 现状施工，不重构人物实例体系，不新建演出引擎，
优先复用 `AssetDescriptor` / `MediaVM` / `ActorFieldGroups` / `Condition` / `Effect` / `BattleFxLayer`。

## 四条需求（用户 2026-11-24）

1. 实装人物**头像**与**立绘**。
2. **多皮肤** + **自动皮肤切换**（2006 高专 → 2017 教师 → 2018 新宿）。
3. **技能 CutIn 演出**（复用现有 FX，不新造一套）。
4. 自定义角色的**生图只预留协议与接入点**，不实现模型调用、生成入口与皮肤管理。

## 裁决表

| # | 争议点 | 裁决 | 落地 |
|---|---|---|---|
| M1 | `assets/manifest.yaml` 参与语义指纹 ⇒ 加立绘会把旧档判成漂移 | **排除**，但必须处理「算法变化本身」造成的旧档不匹配 | 三类指纹分工 + 旧算法兼容读取（`design.md §3`） |
| M2 | 离线媒体：SW 把所有 `/api/*` 当 network-only | **独立媒体 Cache Storage**，与 App Shell 生命周期解耦；SWR；默认 128 MB；简单淘汰 | `design.md §6` |
| M3 | CutIn 与 Cast FX 的先后没有机制保证 | **演出完成回调门控**（结束 / 跳过 / 取消 / 超时），不用固定 `holdMs` | `design.md §7` |
| S1 | `skinId` / `customSkin` 归谁 | **身体实例**，**不参与** `ACTOR_FIELD_GROUPS` 搬运 | 羂索夺舍后显示夏油的身体形象（`design.md §5`） |
| S2 | `setSkin` | 接受 **T-2 协议变更**，补齐引用校验 | `design.md §4.4` |
| S3 | `characterMedia` 进 `ui.yaml` | 同步所有 strict schema，否则模板一写就 `ui_invalid` | `tasks.md` T-02 |
| S4 | 条件皮肤的上下文 | **V1 只支持全局条件子集**：世界时间 / 全局 flag / 全局事件事实；人物自身状态、属性、关系暂缓 | `design.md §5.3`；**禁止**临时替换 `state.player` / `selfId` |
| S5 | 敌人、召唤物 | 区分**战斗实例 id** 与**模板人物 id**（`Combatant.characterId`） | `design.md §8` |
| S6 | 多段、群体演出 | 按**技能释放事件**去重（`cast.seq` + `skillId`） | `design.md §7.2` |
| S7 | 图片规格 | WebP 优先；头像 256²、半身长边 1024、全身/演出长边 1536；**资产规范，不进 Schema** | `design.md §9` |
| S8 | 占位符 | 复用现有**文字头像**（首字），**不新造剪影**；缺失立绘保持原布局 | `design.md §4.5` |
| S9 | 指纹兼容的判据 | 安全依据是「**存档值与当前模板用同一旧算法算出的值相等**」，不是「legacy 与 v2 相等」；新增可选 `fingerprintVersion`，旧档双哈希、升级后只校验 v2；**不承诺全量无损** | `design.md §3.3` + ADR-70 |
| S10 | CutIn 素材优先级 | `skillCutIns[skillId] → cutIn → bust → full → 纯文字`（**专属优先于通用**） | `design.md §7.4` |
| S11 | 回滚口径 | optional 字段只保证「新代码读旧档」，**不保证** strict 旧 Schema 读新档 ⇒ 向后兼容但**不可逆** | `design.md §11` |
| S12 | 媒体缓存细节 | FIFO 淘汰、`event.waitUntil`、尊重 HTTP 缓存头、404 失效、并发写入保护、用 `assetFingerprint` 做 URL 版本参数 | `design.md §6.3` |
| S13 | CutIn 门控形态 | 抽成轻量 `useCastPlayback` Hook，`release` 幂等；卸载时**取消**而不是放行后续 FX | `design.md §7.1` |
| S14 | 条件与时间回溯 | 只保证**时间条件**重算；flag / event 的恢复遵循现有时间系统语义 | `requirements.md R5` |
| S15 | `setSkin` 作用域 | 不限剧情/战斗场景，但只能改**已存在的可写人物实例**；校验归属；不改数值与身份；**不支持战斗临时单位** | `requirements.md R6` |
| S16 | 解析器输入 | 统一 `ActorMediaRef { actorId, characterId?, skinId?, customSkin? }`，只是解析层入参，不新增实例体系；演出用**释放时的媒体快照** | `design.md §4` |

## 交付切分（外部评审裁决 2026-11-24）

**复杂度分界线是「静态媒体」与「时序演出」，不是「头像」与「立绘」** —— 头像和立绘共用同一条
`manifest → 皮肤 → 解析器 → 组件` 的链路，拆开做只是把同一条链路付两次调试成本。

### V1.0 · 静态媒体（本轮施工）

| 波 | 内容 | 独立验收 |
|---|---|---|
| **P0** | ADR + Schema + 指纹兼容 | 旧存档正常加载；已有 874 例不回退 |
| **P1** | Asset Resolver、媒体缓存、头像/立绘组件、占位符 | 头像立绘正常显示；断网仍显示 |
| **P2** | Skin Resolver、全局条件、`setSkin`、Self 适配、`customSkin` 预留 | 2006→2017 自动切换；原作人物开局皮肤完整 |

### V1.1 · 技能演出（V1.0 验收通过后再开）

| 波 | 内容 | 独立验收 |
|---|---|---|
| **P3** | `useCastPlayback`、CutIn 组件、专属素材、播放去重与边界 | 演出按顺序播完，可跳过，不阻塞结算 |
| **P4** | 模板实装 CutIn + 全链路回归 | V1.1 验收清单全绿 |

## 不做（V1 明确排除）

- 文生图模型调用、生成入口、皮肤管理页、生成历史。
- Live2D / 视频演出 / 表情差分（`kind: diff` 枚举保留但不用）/ 皮肤继承。
- 任意 NPC 条件上下文（Actor Context 是下一轮的事）。
- 法轮等常驻装饰图层（另立迭代）。
- 为咒术回战的角色或技能在引擎里写分支 —— `test/unit/engine-generic.test.ts` 会拦。

## 验收

见 `requirements.md §5` 的 18 条清单与 `tasks.md` 每条的「验收命令」。
