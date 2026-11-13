# 待办池（BACKLOG）

> 用途：**收留"已发现但不阻断主线"的小问题与优化点**，避免它们反复出现在验收报告里被重新立案。
> 纪律（2026-11-12 用户裁决）：**先把 demo 主要模块建完，细节不扣死**。本文件里的条目默认不做，除非被主线需要或被用户点名。
> 取用方式：开下一轮迭代时，从这里挑条目升级为 `specs/iterations/<id>/tasks.md` 里的 `T-*`，并在本文件对应条目上标注去向（`→ R2.7 T-03`）。

## 0. 当前主线缺口（优先于本文件任何细节）

| 模块 | 现状 | 说明 |
|---|---|---|
| AI 叙事层（LLM 接入） | **未实现** | `AGENTS.md` §1 与 §5 已划定边界（AI 只产候选/叙事，不写权威状态、不做评分裁判、输出须结构校验并回退模板），但引擎目前全是模板文案，无任何 LLM 调用。这是**产品定位里的核心模块**，不是优化项。 |
| NPC 自主行动 | 部分 | 引擎有 `aiTurn`（战斗）与关系图，但日常 NPC 自主演化仅"间接观察"，无独立驱动。 |
| 剧本重构 | **已完（2026-11-12，`b1321ec`/`c4ca2e8`）** | P0 因果 9 项、密度（事件 91→109 / 战斗 12→18）、虎杖宿傩状态切换、七海谢幕、理子生死落 lifecycle、待决事件前提复核（ADR-0024）。细节缺口见 §3 B-13..B-18。 |
| 关系图前端面板 | **已接（ADR-0019，2026-11-12）** | 人物页改为可展开 `NpcCard`：关系（方向 + 称谓 + 可见性 + 数值）、状态、生命周期三块。D-05 遗留关闭。 |
| 跨模板验证（阶段 8） | DEFERRED | 目前只有 `jjk-2006` 一个模板，无法验证引擎与世界观的解耦程度。 |
| R3 时间穿越 | DEFERRED | ADR-0005 已留 seam，未实现。 |
| NPC 生死状态 | **已实现（ADR-0020/0021/0022）** | 三态 `lifecycle` + `setNpcLifecycle` + `npcState` 条件 + 默认判活（自主行动 / 关系写入 / 战斗参战）；`birthTime` 年龄派生；**刷新队列**（`npcSpawnRules` → `SpawnRuleInstance` → `spawnNpc` 幂等建实例 + `spawnLog` 只追加）；面板显示具体原因。**剩余缺口**：无时间驱动的自动出生（`spawnAt` 按 R-LM-04 刻意不做）；链上战斗整条跳过致链悬空（另立项）；`projectNpc()` 单一入口未抽；玩家侧年龄未统一 birthTime。 |

> 以上属"主要模块建设"，剩余四项建议按此顺序推进：**AI 叙事层 → NPC 自主行动（含生死建模）→ 跨模板验证 → R3**。
> 理由：关系面板只消费已有投影、成本最低且立刻可见；AI 叙事层是产品差异点；后两项依赖前两项的数据形状稳定。

## 1. 有执行顺序约束（必须按序做，勿反序）

| # | 条目 | 约束 | 来源 |
|---|---|---|---|
| B-01 | `labels` 投影契约断言（阶段 1：覆盖 `attributes.order`；阶段 2：覆盖 `player.attributes` 键集）+ 随后删除 `apps/web` 6 处 `resources.hp/mp` 死兜底 | **顺序不可反**：先由内核落断言，前端再删兜底。反序会让投影变化时直接把空白炸给玩家看 | ADR-0017 决策 6 记录项、D-17 |
| B-02 | D-17 破坏性校验升级需补模板协议文档「属性声明」小节 | 改 `specs/` 需用户授权，本轮未动 | ADR-0017 决策 6 |

## 2. 已裁决不修（勿重新立案）

| # | 条目 | 裁决 | 依据 |
|---|---|---|---|
| W-01 | 死亡判据过宽（`end-death` 只判 `injured-sim` 存在，不看来源与轻重；「旧伤复发 + 主动收束」会判战殁并配战死文案） | **已随内容重做自然关闭**：ADR-0018 取消 `deathRoute`，前三章战败只给力竭/重伤（留疗养窗口），死亡只由终章战败表达；`end-death` 不再被通用补正误触发。原裁决 `Won't fix` 记录保留备查 |
| W-02 | 评分饱和区间略保守（QA 路径实测 72.22–85.90 / overall 81.18，略高于内核标定区间） | **不调 `SATURATION_K_RATIO`**，只把文档口径放宽为各维 70–87 / overall 75–82 | ADR-0017 决策 2、验收报告 §七 P2-1 |
| W-03 | 刷新后若同时有进行中战斗与未读转盘，事件区按「转盘 > 战斗」占位，需多点一次「继续」 | **设计取舍，非缺陷** | 验收报告 §七 P2-3 |
| W-04 | 「继续」的已读状态不跨刷新 | 服务器不知道「已读」，重新呈现是对状态的忠实投影 | 前端与主理人一致裁决 |
| W-05 | `seal`（封印）状态有定义但全模板零处施加 | **死配置，不预加字段**（不为不可达状态提前建抽象）；属模板侧资产清理 | ADR-0017 决策 1「已知未覆盖」 |
| W-06 | `cannot_attack` 无任何状态声明 | 不可达，不修 | 同上 |
| W-07 | 抽 `battleControlView()` 统一三个控制位 | 现有 `controlOf` 单入口已够，不提前重构 | ADR-0017 决策 1 |

## 3. 小问题 / 优化（可延后，成本低）

| # | 条目 | 位置 | 备注 |
|---|---|---|---|
| B-03 | `moodLabel()` 回退字面量 `"mood"` 与另两者回退键本身不一致 | 投影层 | 纯一致性，备查 |
| B-04 | 评价条形宽度是 0–100 截断近似 ⇒ **负分条长为 0**（数值与等级仍准确） | `apps/web` | 要精确需投影下发每维 `range`（契约变更，建议与 B-01 同批） |
| B-05 | 结局页五维在 `PlayerCard` 内与 `EndingPanel` 同屏，未在结局卡内部单独呈现 | `apps/web` | 需再定一次版式，否则同屏出现两份 |
| B-06 | `.interact-hint`（固定定位「⚡ 事件待决」浮标）滚动到底时视觉压住内容末行 | `style.css` | `pointer-events: none` 不挡点击，纯视觉 |
| B-07 | 模板 4 个专属维度（bonds/deeds/truth/freedom）同落 `rawScore` 的 `default` 分支 ⇒ 彼此恒等 | `life-evaluation.ts` | 真区分需 `explanationRules → 规则 id` 映射机制（协议变更） |
| B-08 | `storyChapter` 只有数字，无章节中文名 | 投影 | 模板无章节名表，不自造；需要则模板加字段 |
| B-09 | 服务端其它路由 schema（choose / useItem / equip 等）仍手写 | `apps/server` | 服务端独占入参、无第二份真源 ⇒ 无漂移风险，仅一致性问题 |
| B-10 | e2e 脚本躺在 `data/_aishot/`、`data/` 全目录被 gitignore | 工程 | 建议迁到可入库的 `tests/e2e/`（截图仍不入库） |
| B-13 | **`once: true` 的池事件在待决期间前提变假会被静默丢弃，但 `once` 已烧** ⇒ 该事件永久不再触发。7 个章节门全是 `once+pool`，理论上是章节软锁 | `events.yaml:1545/1909/2410/2650/2815/3154/3456`、`turn.ts` 丢弃分支 | P2：30 种子 0 例、正常玩法不可达（章节门待决期间玩家无法行动，唯一轮外入口 `useItem` 只治疗）。**下轮补一条可诊断事实**（扩 `MissReason` 或丢弃时退还 once），二者都要动协议 |
| B-14 | `droppedPending` 只在内部 `TriggerResult`，`V2TurnResult` 上没有 ⇒ 端到端无法断言「这轮丢了什么」，复验只能靠队列差分反推 | `turn.ts` vs `packages/shared/src/v2.ts` | P3。ADR-0024 刻意不进 API；若要暴露需同时定「谁消费」 |
| B-15 | **S1 判据（首丢前缀等价）没有自动化用例** | `packages/game-core/src/v2/` | P3。跨版本比对要 `git archive` 搭旧基线，手工数据不可复算。建议落成用例：断言「首丢前指纹相同 + 首差字段只在 `pendingQueue`」 |
| B-16 | 复活瞬间年龄从冻结值跳到真实值（14→27），语义正确但前端若有动画会突兀 | `projection.ts` | P3，仅在前端做年龄过渡时需要考虑 |
| B-17 | `revalidatePendingV2` 对整个队列共用一个 `+37` rng 流；非队首条目若带 `random` 条件会消耗流 | `turn.ts` | P3，当前模板带 `random` 条件的池事件为 0，零暴露 |
| B-18 | 甚尔之战几乎必胜（`enemy-toji` CE=0 ⇒ HP 86，还带 283 HP 的夏草当友军）⇒ 第一章「胜负」分支虽可达但败北近乎不可能 | `characters.yaml` | 需重做第一章难度曲线（原作是「几乎必败」），属全局平衡，另立项 |

| B-12 | ~~NPC `birthTime` / `ageAt` 派生~~ **已实现（ADR-0021）** | `packages/game-core` | `V2Npc.birthTime`（可选，读侧按 `toMinutes(-age)` 反推）+ 投影期 `ageAt` 现算（年差口径）；同时修了 `CalendarAdapter` 负分钟（原 `Math.max(0,…)` 钳位导致 `toMinutes(-15y)` 静默返回 0）。遗留：玩家侧仍用 `playerAgeAtStart + elapsedYears`，未统一（ADR-0021 明确不做）。 |
| B-11 | `apps/web` 无任何自动化测试（仓库本就没有 web 测试基建） | 工程 | 前端回归全靠可复跑脚本 + 截图，成本偏高 |
| B-19 | **玩家关系双真相**：`npc.relationship` 标量与关系边 `value` 各存一份、互不同步（标量由 `adjustRelation` 标量形态改，边由边形态/`addRelationEdge` 改）。代价不只是展示可能矛盾：模板现有 4 处 `{ relation: npc-x, gte: N }` 条件全是**标量形态**（`endings.yaml:238-239`、`events.yaml:1931/2007/2580`），而一旦有人写成 `{relation, kind}` 形态就会改读边值（`relation-projection.test.ts:110-118` 已固化该语义）⇒ 同一个语义问题两套数值 | `npc.ts` / `relation-effects` / `packages/shared/src/schema/common.ts` | **延后**。统一牵动 `adjustRelation` 双写语义与条件 DSL 取值口径，属协议变更（T-2，需 ADR）。参考：ADR-0014 决策 3 原意是「标量由种子边生成」，实现从未落地 |
| B-20 | **`playerTemplate.relations` 缺失** ⇒ 无法**静态**声明「玩家视 NPC 为 X」（`characters[].relations` 的 `from` 隐含为该角色，只能表达 NPC→玩家）；且 `V2Snapshot.player` 无 `relations` 字段 ⇒ 玩家侧没有关系面板。现状「NPC 视你为 X」只能靠 `characters.yaml` 补 `to: player` 边（T-1），反向要靠 `opening.worldSetup.effects.addRelationEdge {fromId: player}`（运行期，亦 T-1） | `packages/shared/src/schema/world.ts:74-89`（`PlayerTemplateSchema` 为 `.strict()`）、`projection.ts` | **延后**。加字段＝改协议面（T-2，需 ADR）+ 投影契约 + 前端面板，属独立一刀 |
| B-21 | **`flags["infoVisibility:<npcId>"]` 只写不读**：`opening.ts:153-163` 写了一套 `known/inferred/unknown` 信息可见度，全仓唯一消费点是测试断言它被写，投影与条件均未读取 | `v2/opening.ts`、`flags` | **延后 / 需 ADR**。**明确禁止**拿它当投影红线（未登场/隐藏）的判据：它是模板可读写的 flag，把「hidden 不外泄」的裁决权交给模板作者等于自废红线，且会与 `lifecycle` 形成两套真相。启用它＝新机制上线 |
| B-22 | **`characters[].visibility: "hidden"` 未参与上屏过滤**：`turn.ts:126-160`（`filter(c => !c.isEnemy)`）与 `projection.ts`（只滤 `unspawned`）都没有按角色 `visibility` 过滤 ⇒ 声明 `hidden` 的角色（如 `npc-riko`）照常建实例、照常上屏。与 ADR-0020「`visibility` 过滤仍在 `turn.ts` 建实例时按 `isEnemy`/`visibility` 处理」的记载不符 | `v2/turn.ts`、`v2/projection.ts` | **存量偏差，未裁决**。撤下屏属展示口径变更（且影响既有面板验收），不得顺带修；另记一条决策后再动 |
| B-23 | **「判据反例」未做成 table-driven，锁不住判据回退**：三条反例散落在 `relation-projection.test.ts`（enemy 正向断言 / `inactive` 保留 / `player` 硬保留）与 `v2.test.ts`，彼此不成组。QA 变异验证 M1（把判据改成「不在上屏 NPC 集合内」）实测：真红的只有 `enemy-*` 端点那两例（`:61` / `:160`），`inactive` 用例**不红**、`v2.test.ts` 39 例**全绿** ⇒ **只有 enemy 一条真正卡住这类错判据**；若有人把判据改回「不在上屏集合内」，其余断言锁不住 | `packages/game-core/src/v2/relation-projection.test.ts` | **本轮不做，下一轮测试补强时一并处理**。做法：合成一个 table-driven 用例，`enemy / inactive / player` 各绑一条断言，并在每条注释里点明它**各自区分哪种错法**——`enemy` 防「不在投影后 NPC 集合内」；`inactive` 防「按 `lifecycle.state === "alive"` 白名单过滤」；`player` 防「白名单式节点枚举丢掉玩家」。来源：`tasks/reports/RELATION-PROJECTION-FIX-ACCEPTANCE.md` §八 观察 2（O2）、ADR-0022 补记 D-1 决策 1「实测修正」 |
| B-24 | **存档上云 / 跨设备续玩（"输入日志 + 确定性重放"）**：ADR-0025 明确不做，本轮只上云投影副本（云端 `life_records` 只读展示，永不回读进引擎）。要做续玩就必须换存档真相：`worldId` 不再是唯一权威，云端需存 `{ templateId, templateFingerprint, seed, openingId, playerName, startTime, commands[] }`，启动期由 `replay()` 重算出 `WorldStateV2`，并与本地 `data/worlds/<id>.json` 互为备份。**设计要点**：① 命令日志必须是**全部写入口**（turn / choose / battle / useItem / equip / unequip / archive），漏一条即静默分叉；② 模板指纹不匹配的处置必须先定（ADR-0007 现在是拒载）——重放会直接产出"另一条人生线"，比拒载更危险，建议同样拒载并要求客户端只读展示云端摘要；③ `replay.ts` 目前只覆盖 `ReplaySpec` 的极简形态，需先补齐「引擎版本」维度（`schemaVersion` 之外还要引擎指纹）；④ 云端行必须 `owner_id` 隔离且命令日志不可由客户端任意改写（与 ADR-0025 的"可篡改副本"矛盾），所以真正的续玩需要服务端持有签名身份或改成服务端代跑 | `packages/game-core/src/v2/replay.ts`、`apps/server/src/store.ts`、云端表设计 | **延后 / 需 ADR（T-2）**。前置依赖：B-24 的 ④ 与 ADR-0025「服务端不上云」冲突未解，故本轮不启动 |

| B-25 | **`game-core` 的测试直接 `import apps/server/src/store.ts`（跨包耦合）**：`packages/game-core/src/v2/{persistence,ending-pipeline,archive}.test.ts` 三个文件越过包边界引用服务端实现，导致 R2.8 改 `store` 的 `create/loadPersistedWorlds/get` 签名时，**必须同步改这三个测试**（否则 typecheck 与 game-core 全量红）。测试代码不是契约面，本轮按此处理；但这层耦合本身是架构债——`packages/*` 依赖 `apps/*` 方向与 AGENTS §1 的性质相反（虽只在 test 里）。修法：把信封/store 的测试夹具抽成 `apps/server/src/testing/` 或让 game-core 用自带的 `WorldStateV2` 夹具，不 import 服务端。 | `packages/game-core/src/v2/*.test.ts`（跨包 import） | **延后**。来源：R2.8 `d75abf9` 实施时被迫改动 11 个 `*.test.ts`（其中 8 个是模板夹具路径随 `<id>/<version>/` 迁移，3 个是 store 签名）。不阻断，但下次有人动 `store` 导出时会再撞一次 |

| B-26 | **回填 `templateVersion` 时 `savedAt` 无类型兜底**：`apps/server/src/store.ts` 的信封回填路径直接沿用旧信封的 `savedAt`，若手改档把它写成非字符串（如数字/null），回填后会原样写回，直到下次 `persist` 才被覆盖。只影响手改档，正常路径不可达。 | `apps/server/src/store.ts` 回填分支 | **本轮不修**（QA 记 P2-3）。来源：R2.8 `tasks/reports/R28-ACCEPTANCE.md`。修法：回填时校验 `typeof savedAt === "string"`，否则用当前时间 |
| B-27 | **combat 被 `pendingEvents` 挡住（反向对称洞）**：正常事件占槽时战斗仍可开打（`turn.ts:453` 只做「同一时刻至多一场」互斥，不判 `pendingEvents`），而前端占位优先级是 `wheel > battle > event`（`apps/web/src/main.tsx:1308-1315`）⇒ 卡片被战斗遮住，战斗结束后卡片才浮出，与 ADR-0030 修的 L2（battle 遮 normal）同构但方向相反。**为何不一起修**：线上 326 轮存档中该方向零例（2 次链中断全是「normal 在战斗期间抢槽」），扩大改动面会动既有战斗用例。修法：`slotTakenFor()` 加 L1 对 combat 生效（与 normal 对称），并补「战斗不得在卡片占槽时开打」用例 | `packages/game-core/src/v2/turn.ts:441-465`、`apps/web/src/main.tsx` | **延后 / 另案**。来源：ADR-0030 决策 7 边界 |
| B-28 | **`pendingEventPriority` 在单槽下实际失效**：ADR-0026 之后 `pendingEvents` 恒 ≤ 1，`enqueuePendingEvent`（`turn.ts:349-367`）的「按优先级插入」几乎恒是空操作；而真正的准入次序由 drain 的排序键决定（`scheduler.ts:71-82`：`start → hasEnd → end → enqueueSeq`），**从不读 priority**。被守卫延后的事件重新入队时拿到**新的 `enqueueSeq`**，直接落到队尾 ⇒ 理论上「高优先级链事件会被更早入队的日常事件反超」。**为何不修**：把 admission 改成「槽空时按 priority 择优」会重排 drain 的 RNG 消费顺序，动到确定性基线。前置需求：先有「priority 到底该不该影响准入」的裁决 | `turn.ts:327-367`、`scheduler.ts:71-82` | **延后 / 需裁决**。来源：ADR-0030 决策 7 边界、决策 1 的反面观察 |
| B-29 | **`opening.handoff` 直写 `pendingEvents` 绕过准入守卫**：`opening.ts:239-241` 在交接时把未完成即时事件直接 `push` 进 `pendingEvents`，不经 `slotTakenFor()`；若模板 `handoff.pendingEvents` 声明 ≥2 条，开局即出现 `pendingEvents.length > 1`，**直接破坏 ADR-0026 的单槽不变量**。当前 `jjk-2006` 的 `handoff.pendingEvents` 为空数组（`opening.ts:316` 默认值），零暴露。修法：交接改走同一入口（逐条 `triggerEventV2` 或先 `enqueueScheduled(ZERO_SPEC)` 再 drain），或加载期拒绝 `handoff.pendingEvents.length > 1`（`#35` 同款静态拒绝，属 T-2） | `packages/game-core/src/v2/opening.ts:184-245`、`packages/shared/src/schema/**` | **延后 / 需 ADR**（静态拒绝要动 schema）。来源：ADR-0030 决策 7 边界 |
| B-30 | **`scheduledEvents` 无 GC / 归档裁剪**：实例只增不删 —— `status` 变成 `fired`/`expired`/`cancelled` 后仍永久留在 `state.scheduledEvents` 里，326 轮存档已积累大量死实例；守卫延后路径（ADR-0030 决策 4）若不去重更会成倍放大。影响：存档体积、`evaluateChain` 的 `some()` 扫描、序列化耗时。**为何不修**：终态实例是审计证据（`missedEvents` 的 `instanceId` 要能回指，ADR-0024 决策 8），裁剪必须先定「保留多久 / 谁需要回指」 | `packages/game-core/src/v2/scheduler.ts:310-358`、`apps/server/src/store.ts` | **延后**。来源：ADR-0030 决策 4 |
| B-31 | **「放弃转盘」通道缺位**：ADR-0031 裁定「永不自动结算」，唯一逃生口是 `archive`（结束这一生）⇒ 玩家若卡在一枚不想要的转盘上，只能结束这局。可选兜底有三类（① 允许放弃并显式落一条 `missed` 事实；② 放弃即按扇区 `effects` 的「空分支」处理；③ 允许「重掷」消耗资源），**每一种都要定义因果代价与 `MissReason` 扩张**，属 T-2 + 新 ADR。当前模板下风险低（扇区效果全为正/中性），但这是**玩家可感知的唯一硬卡点**，用户若反馈再立案 | `packages/game-core/src/v2/turn.ts`（`settleWheelV2`）、`packages/shared/src/v2.ts`（`MissReason`） | **延后 / 需 ADR**。来源：ADR-0031 决策 4 与「待用户裁决点 2」 |
| B-32 | **ADR-0031 落地时 `playthrough` / `replay` 必须同批改，不可分成两次提交**：切分后 `advanceTurnV2` 会抛 `pending_wheel_required`，而 `playthrough.test.ts`（6 种子 × 2 开局）与 `replay.ts` 的循环只发「推进轮次」指令 ⇒ 只落引擎不落脚本会让 `playthrough` 直接卡死，**中间态不可合并**。改造点：① 主循环在 `pendingEvents` 分支之前先按 `seq` 结算 `pendingWheels`；② `ReplaySpec` 需能表达「结算某一枚」，或在回放内按 `seq` 顺序自动结算并注释声明「回放不含玩家迟疑」；③ 结算后 `day` / 章节基线需重录（结构性断言不变） | `packages/game-core/src/v2/playthrough.test.ts`、`packages/game-core/src/v2/replay.ts`、`packages/game-core/src/v2/replay.test.ts` | **实施约束（不是可选项）**。来源：ADR-0031 决策 9 与「回归影响清单」**（注：ADR-0031 已被打回，本条改造要求随之挂起，待新设计定案后再评估是否仍需）** |
| B-33 | **`pendingEvents ≤ 1` 有两条绕过准入的写入路径**：`opening.ts:241`（开局交接按模板 `handoff.pendingEvents` **批量 push**，模板声明 ≥2 条即开局破单槽）、`ending.ts:379`（死亡结局事件在终止判定里追加，此时队内可能已有待决项）。现状零暴露（`jjk-2006` 的 `handoff.pendingEvents` 为空数组），但这两条路径**不经过任何准入判定**，属 ADR-0032 §3 R1 登记的「运行期约定可被旁路破」。收口二选一：① 运行时改走同一入口（逐条触发或先入待触发队列再 drain）；② 加载期静态拒绝（`handoff.pendingEvents.length > 1` 报错，属 T-2 动 schema）。**ADR-0032 §4 P1 只能挡「玩家侧旁支操作」，挡不住这两条引擎内写入**，故须单独处理 | `packages/game-core/src/v2/opening.ts:239-246`、`packages/game-core/src/v2/ending.ts:379`、`packages/shared/src/schema/world.ts`（若走静态拒绝） | **延后 / 需裁决**。来源：ADR-0032 §3 R1、本轮概念梳理 §2 I6 |

| B-35 | **G2（诈尸）的防线只有模板侧，内核不保证** —— 已知欠账，用户已裁决取舍：2026-11-13 用户明确「b 不做了 交给模板做判活」，即否决"叙事文本结构化引用 + 内核 cast 判活"，诈尸防线回到作者手写 `conditions` / `missWhen`（ADR-0034 §11.1）。**实测现状**：`events.yaml` 109 事件中 **`missWhen` 0 处、`npcState` 条件仅 9 处（覆盖 8%）**，即 91% 的事件对"人是否还在"毫无防线。内核只兑现两件：求值固定在真正上桌那一刻、失效必留 `missedEvents` 痕迹（不静默丢弃）。**不重新提案**：这是用户裁决的取舍，不是待议项；若将来要重新引入内核侧判活，需用户另开口径 | `specs/data/templates/jjk-2006/1.0.0/events.yaml`（模板侧补条件）、`packages/game-core/src/v2/scheduler.ts:249-258`（内核唯一求值点） | **用户已裁决的取舍（不修内核）**。来源：ADR-0034 §11.1、用户 2026-11-13 原话 |
| B-36 | **`type: log` 效果是死接线：29 句公开旁白从未展示给玩家（疑似 bug）** —— `log` 效果本意是「选项结算后的结果旁白」（`schema/common.ts:289`），模板 `events.yaml` 有 **29 处、全部 `visibility: public`、0 处 hidden**（例：「天内理子在同化中消失。」「你带走了星浆体。天元被迫独自进化。」）。但 `engine.ts:573-575` 只做 `ctx.logs?.push(text)` **不写 history**，而 `turn.ts` 的 4 个入口建了 `logs: []` 却**从不读**（`:525` random / `:930` 自由行动 / `:1071` 选项结算 / `:1137` 战斗结果）；**唯一**读它的是 `useItemV2`（`:1213/1220/1230`），而 `items.yaml` **零处** `type: log` ⇒ **这 29 句 100% 从未被玩家看到**。修法三选：①把 `optionCtx.logs` / `actionCtx.logs` / `outcomeCtx.logs` / wheel `segCtx.logs` 拼进各自的 `pushHistory` 摘要（最小改动，与 `useItemV2` 同口径）；②让 `log` 效果直接 `pushHistory`（需要 ctx 带 template，改面大）；③判定"旁白应并入 narrative"则删效果类型（模板侧改动）。**需用户裁决修不修** | `packages/game-core/src/v2/engine.ts:573-575`、`packages/game-core/src/v2/turn.ts:525/930/1071/1137/1213`、`specs/data/templates/jjk-2006/1.0.0/events.yaml`（29 处） | **待用户裁决（疑似 bug）**。来源：ADR-0034 §11.3、用户 2026-11-13 提问「log 是什么？」 |

| B-37 | **A2 覆盖不到的"入队时合法、之后长期不成立"候选**（ADR-0034 §13 已裁定 A2 = 池抽取先判前提、不成立不入队）：A2 只拦「**入队那一刻就不成立**」的候选。若某候选入队时成立、之后因玩家行为/关系值/时间推移长期不成立（例：条件依赖 `{relation: npc-x, gte: N}` 或 `{inventory: ...}`），它会按 §3-3 **永久 hold**、按 §3-6 挤占 `maxQueueLength(3)` ⇒ **可能重演 seed 5 的主线停摆**（四个章节门摇不出来）。**A2 不覆盖这一半**。修法需要给实例加**时间戳 / 休眠字段**（例如 `holdSince` / `staleAfter`，超期转 `expired` 或降级出队），属**协议变更（T-2）**，须另立 ADR；也可先走模板侧规避（不在长期不成立的条件上做池事件） | `packages/shared/src/v2.ts`（`ScheduledEventInstance`）、`packages/game-core/src/v2/scheduler.ts`（`scanDelayQueue` 的 `hold` 分支）、`specs/data/templates/**`（模板侧规避） | **延后 / 需 ADR**。来源：ADR-0034 §13.3 边界、`playthrough` seed 5 复现 |

## 4. 环境 / 工具链坑（不改产品代码也应知道）

| # | 现象 | 原因与对策 |
|---|---|---|
| E-01 | 裸 `pnpm --filter @life-sim/shared test`（或根 `pnpm test`）在本沙箱**挂死十余分钟无输出** | vitest 并行收集问题；**必须带 `--no-file-parallelism`**（shared 约 4s、game-core 约 18s） |
| E-02 | `3000` 端口 serve 的是 `apps/web/dist` 构建产物 | 看最新前端必须先 `pnpm build`，或直接访问 vite dev `5173` |
| E-03 | `data/worlds/` 里旧档启动时被跳过，表现为「列表里能看到、点开 `GET` 404」 | `schema_version_mismatch`（R2.5 信封 1→2）与 `template_fingerprint_mismatch`（模板改动）两道既定闸门，**预期行为**；先看启动日志 `worlds_loaded loaded:N skipped:M` 再判断 |
| E-04 | `data/` 下的存档是本地验收语料 | 已被 gitignore；**对非自己创建的存档发写请求前先 `GET` 确认 `battle === null`**（曾误把他人战斗推进并逃跑） |

## 5. 未验证项（不是已知缺陷，是证据缺口）

| # | 缺口 | 原因 |
|---|---|---|
| U-01 | 真实公历跨月 / 闰年未在 UI 层观测 | 仅单测覆盖；UI 层需 ~186 次点击推进 |
| U-02 | 真机 / iOS Safari 未验 | 全部验收用 headless Chrome 430×932@2x |
| U-03 | 性能未测（长局、大存档） | 无基准 |
| U-04 | 多标签并发写入未测 | JSON 文件存储无并发保护机制 |
| U-05 | 坏档只验了 `json_parse_failed` / `state_schema_invalid` 等 2–3 类 | 其余损坏形态未构造 |
| U-06 | `relationship.js` 未做依赖审计 | MIT / 纯算法 / 离线，风险低 |

## 6. 维护约定

- 新发现的小问题**先记这里**，不要直接开迭代、不要在验收报告里重复立案。
- 每条必须写清：位置、判定（修 / 不修 / 延后）、来源（哪份报告或哪个裁决）。
- 已被用户裁决为 `Won't fix` 的移入 §2，并注明裁决时间与依据，避免下一轮被当成"新发现"。
- 升级为任务时，在本条末尾追加 `→ <迭代号> <任务号>`。

## 7. 从 `specs/` 拆出的未解决细节（2026-11-12 整理时提取）

> 来源：`specs/archive/design-increments/DESIGN_INCREMENT_2026-11-10.md` 附录 A（A1–A13 差异表）、
> `specs/archive/iterations/iteration-2026-11-11/design.md` 与各迭代 `requirements.md` 的待决项表。
> 整理后 `specs/` **不再承载未解决项**，一律在这里追踪。已解决的从下表划掉但不删除（保留判断依据）。

| # | 条目 | 现状 vs 原设想 | 判定 |
|---|---|---|---|
| S-01 | **战斗 AI 分层**（原 A11）：战斗风格配置（激进 / 保守 / 防御反击）+ 分层决策 | 现行敌人 AI 为简单权重策略；未实现风格化 | **延后**。属核心体验增强，等主线模块补齐后再做 |
| S-02 | **属性模型统一**（原 A8）：通用基础属性（HP/ATK/DEF/SPD/HIT/EVA/CRIT…）+ 世界自定义属性，默认公式可覆写 | 现行属性**完全世界自定义**（jjk-2006 为 6 维），无通用战斗属性层 | **延后 / 需 ADR**。属核心数据模型变更，动之前必须走 G2 |
| S-03 | **时间穿越**（原 A3）：未来事件撤销 / 隐秘化、多世界线 | 无此概念；`once` / 冷却 / 链状态机都假设时间单调 | **DEFERRED（R3）**，ADR-0005 已留 seam |
| S-04 | **分支世界的独立存档实体** | 现为单世界单存档 | **DEFERRED**，`iteration-2026-11-11/design.md` §7 已列「不做」 |
| S-05 | **NPC 触发式行动**（原 A6）：7 种触发源 + 效用评分 + 兜底随机 | 仅战斗 `aiTurn` 与关系图；日常无人格驱动 | 见 §0「NPC 自主行动」主线缺口 |
| S-06 | **事件七类分类**（原 A5）：主线 / 随机 / 动态 / NPC / 玩家 / 时间 / 条件 | 现行为 `source` 四类 × `kind` 三类 | **不采用**。ADR-0011 已裁决「只有立即 / 延时两类」，不再加枚举 |
| S-07 | **事件栈调度**（原 A4） | 现行为事件池 + 链状态机 | **不采用**，ADR-0011 保持现状 |
| S-08 | **模块拆成 14 个独立包**（原 A12） | 现为 4 包 monorepo（shared / game-core / server / web） | **不采用**。MVP 不拆包，边界靠 `AGENTS.md` §1 约束 |
| S-09 | R2.5 `test-design.md` v1 的 12 项待同步 | 该文档已随 R2.5 收尾归档；权威口径为 `design.md` §0.2 / §0.3 | **作废**（无需处理） |
| S-10 | 自由文本行动是否纳入 AI 解析、规格归属谁 | 见 `docs/OPEN_QUESTIONS.md` #26 | **未决**，随 AI 叙事层立项时一并裁定 |
| S-11 | 人生评价的具体权重与展示形式 | 已由 `evaluation.yaml` 五维 + 有界饱和公式落地 | **已关闭**（ADR-0017 决策 2） |
| S-12 | 装备系统范围（槽位 / 词条模型 / 与补正的关系） | 已由 ADR-0008（背包与装备栏分离）、ADR-0009（个人面板模板化）、ADR-0017 落地 | **已关闭** |

**取用规则**：S-01 / S-02 / S-05 / S-10 是有实际价值的下一步候选；S-03 / S-04 属 DEFERRED 大项；S-06～S-09 已明确不采用，**不要重新提案**。

## 8. 用户已提出但本轮不设计（2026-11-13）

| # | 条目 | 现状 vs 目标 | 判定 |
|---|---|---|---|
| B-34 | **按规则生成随机事件 / 随机事件链**（用户原话：「按规则生成随机事件/随机事件链，像随机 NPC 那样」，2026-11-13 追加定形：**参数化文本 + AI 润色 + 随机数值**） | 现状：事件全部来自模板静态声明（`events.yaml` 109 条），`source: pool` 只做"从静态池里抽"，无任何生成能力；`npcSpawnRules`（ADR-0022）是仓库里**唯一**"按规则生成实例"的先例。**三要素与既有能力的关系**：①**参数化文本** ≈ 占位符化，但**只用于随机生成、不用于判活**（与 ADR-0034 §11.1 否决 B 不矛盾：否决的是"用占位符做判活"）；②**AI 润色** ≈ ADR-0027 的 LLM flavor（结构校验 + 模板回退，AI 不写权威状态）；③**随机数值** ≈ `deriveTurnSeed` 派生（确定性，禁 `Math.random`） | **本轮不设计、不实施**（ADR-0034 §11.4 仅登记形态）。开工前置：①生成物**运行时产生**（参照 `npcSpawnRules`）⇒ 不进模板指纹但**必须进存档**；②其 `nextEventId` 目标**无法加载期校验** ⇒ 需运行期引用校验 + fail-fast，并为生成事件建运行时定义层（`lookup` 要能查到非模板定义）；③确定性必须 `deriveTurnSeed`；④生成事件不宜进 `once` 静态索引（id 无界增长）；⑤生成事件也进队列 ⇒ 与池阈值（队列 ≥3 不摇）**分开计预算**。**开工前必须先写 ADR（T-2）** |
