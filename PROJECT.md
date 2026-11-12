# AI 人生模拟器 · WorkBuddy 项目面板

> 本文件是 WorkBuddy 工作空间的**迭代入口与状态快照**，不是产品规格，也不是代码。
> 权威内容始终在 `AGENTS.md`、`specs/`、`docs/` 与代码里。
> 建立于 2026-11-11：本文件与 `.workbuddy/` 均为**新增的协作元文件**，未改动任何既有规格、架构、数据模型或游戏规则。

## 1. 工作空间

- 项目根：`D:\code\ai-life-simulator`（pnpm workspace / TypeScript / Node 22+）
- 在 WorkBuddy 新建任务时：输入框下方「选择工作空间」→「打开本地文件夹」→ 选中此目录。
  之后该项目的所有任务都会归到同一个 Space，侧边栏可回看整个项目的迭代历史。
- 架构边界、技术栈、代码规范：`AGENTS.md` §1–2、`docs/ARCHITECTURE.md`。

## 2. 当前迭代状态（快照：2026-11-12）

| 项 | 状态 |
|---|---|
| 当前迭代 | **R2.6「关系图谱 + 时间适配器落地」已交付并通过 QA 验收（有条件通过 → 阻断项已闭环）**（`specs/iteration-2026-11-12-r26/`）：ADR-0013（日历 ②③ + 字面量，含**修订 R1**：年龄口径改为日历年边界跳岁）/ ADR-0014（关系图 + `relationship.js` 依赖）已落地；WS-A `T-A1..A5`、WS-B `T-B1..B6` 全部实现（`f95f5ce`/`24f9b39`/`eb2946d`/`8ee3998`/`ec4eef6`/`c938f2a`/`ccf57b6`/`cc58699`）。同期执行 **ADR-0015**（jjk-2006 内容收敛，`0358cc9`）。**QA 报告 `tasks/reports/R26-ACCEPTANCE.md`**：基线 `fc6694f` 上 game-core 332/332、shared 50/50、UI 43 维全通；两条阻断已处置（D-01 工作区另属其他会话的 WIP，不碰；D-02 `ageAt` 经用户裁决**改规格**，见 ADR-0013 修订 R1 与 `OPEN_QUESTIONS #47`）。 |
| QA 验收 | **裁定：有条件通过 → 阻断项已闭环**。D-01（工作区被另一进程改写为「第二版」58 事件 / 6 链，不属 R2.6）判定为外部 WIP，R2.6 只对 `fc6694f` 收口；D-02（`ageAt` 未实现）按用户裁决改规格，代码零改动。补强项 D-03/D-04（`custom` 无 `months`、关系端点未知角色两条负向用例）已落为 `packages/game-core/src/v2/template-validation.test.ts`（9 例）；D-07 `relations.ts` 已从包入口导出；D-09（转盘 `timeCost` 全 0 ⇒ 开局时间不推进）确认为**预期行为**并已在 `tasks.md` 记明。**上轮「WS-A 全部实现并自验」对 `ageAt` 一条属过述，已在本行更正。** |
| 第二版验收 | **jjk-2006「第二版」玩法重构（ADR-0016）已验收通过**（HEAD `a9ac32f`，报告 `tasks/reports/JJK-V2-ACCEPTANCE.md`）。轨迹：首轮「退回」→ 复验「退回（单点）」→ 终判「通过」。修掉的阻断项：**D-01** 章节重复触发（`ce6fbcc`，五章触发器补 `once` + `chapterFires` 护栏，已做变异验证）、**D-02** 五维评价不可见（`5612ebc` 引擎补 `label`+投影 / `3db902c` 前端）、**D-04** 日常池插入开局、**D-10** 评价块把主交互区推出首屏（`a9ac32f`，用户裁决只在结局/归档展示）。**遗留未修（不阻断）**：D-03 单轮多转盘 `wheelResult` 单槽覆盖、D-05 浮标/滚动手感、D-06 满年局评分饱和、D-07 章节进度不可见、D-08 战斗道具按钮与 `bound_items` 不一致、D-09 刷新后转盘结果丢失；**D-11**（死亡判据过宽）`Won't fix`（用户裁决，ADR-0016 更正 C1）。 |
| 遗留缺陷清理 | **已验收通过（HEAD `6e77aca`，报告 `tasks/reports/JJK-V2-FIXES-ACCEPTANCE.md`）**。用户裁决「yaml 模板问题不处理、内核/前后端 bug 就修」，据此清 10 条：D-03 转盘结果覆盖、D-05 继续按钮被底栏压、D-06 满年局评分全 100、D-07 章节不可见、D-08 道具按钮、D-09 刷新丢转盘结果，以及修复中连带发现的 **D-12** `canFlee` 未合并补正、**D-13** 眩晕无提示、**D-14** `BattleCommand` 缺 `pass`、**D-15** 服务端手写第二份 schema、**D-16** 刷新后转盘标题回落、**D-17** 属性键未校验。**核心成果不是 10 个补丁，而是三条原则**：① 投影不得让玩家看到引擎会拒绝的操作（`canUseItems`/`canFlee`/`canAct` 共用 `controlOf` 单一判定，ADR-0017 决策 1）；② 评分改有界饱和，长局恢复区分度（决策 2）；③ 战斗命令 schema 收敛单一真源 + 源码守卫（决策 3）。**验证**：typecheck 0 错、game-core 367/367、shared 62/62、build 通过；10 条缺陷 + D-16(3/3) + D-17(4/4) 全 PASS、9 项回归 PASS。**遗留（不阻断）**：`labels` 投影断言分两阶段、web 6 处 `resources` 死兜底、`moodLabel()` 回退不一致、e2e 脚本待迁入可入库位置。 |
| 范围 | 用户裁决：先把「配置 / 实例 / 事实」三层梳理清楚再编码。事件侧收敛为立即/延时两类 + 时间窗队列 + 入队门控，退役 x 轮后触发，`pool` 只产出延时事件且 combat 不入池，断链判定须查时间队列；NPC 侧投影与生命周期解耦、`spawn-alive-dead` 默认判活、出生时间动态年龄、关系类型化与亲属/师承推导（含断代与多跳称谓）。→ **ADR-0010/0011/0012（状态：已通过 2026-11-12 G1 评审）**；需求 **27 ACTIVE（LM 5 / EV 15 / NP 7）+ 1 DEFERRED** |
| 进度 | **G1/G2 已过；R2.5 事件模型 9 个任务全部落地并自验完成（待 `life-sim-qa` 验收）**：`T1-01`..`T1-03` 分别落模板契约 / 状态层 / 调度器（`bd5ef2f`、`bd84f61`、`dfa15a6`），`T1-04`..`T1-07` 引擎接线（`23706e1`），`T1-08` 夹具迁移与验收用例（`f1fd1ee`），`T1-09` 协议 §9.6/§22 与完成报告。**自验**：`pnpm typecheck` 0 错误；game-core 275/275、shared 50/50；`pnpm build` 通过；服务 `/api/templates` 200；HTTP e2e 在 `worldTime=1440` 到点触发 `ev-sp-briefing`。详见 `tasks/reports/R25-COMPLETION.md` 与 r25 `tasks.md` §1.1 |
| 已有产出 | R2.5 实现：单一 `TimeSpec` + `window/delay/cooldown/timeCost/missWhen`、退役字段诊断与 #35 加载期强制、`ScheduledEventInstance` 三层分离、`scheduler.ts` 确定性出队与封闭 `MissReason`、pool 门控入队与 combat 不入池、链延时步与 `alignChainStep`、结算轮 + `timeCost`、事件轮共享尾管线、`schemaVersion=2` 拒载旧档、协议 §22 调度章节 + 完成报告；**规格侧**保留三层混杂清单 M1–M11、ADR-0010/0011/0012（已通过）与 R2.6 的 NPC 设计 |
| 下一步 | 等待 QA 验收 R2.5；按裁决把 **#39/#43/#44/#45**（真实公历/自定义纪元与年号/字符串 `TimeSpec`/世界时间上界）与 **R2.6 NPC 系统（`T2-*`）**放到下一期首批。遗留：`test-design.md` 仍有与已关闭裁决冲突的旧用例待规格轮对齐；`T1-09` 的 curl 级错失/断链负向 e2e 未做（见报告 §7.1）；战斗结束结算轮是否跑完整尾管线待裁定（报告 §6.9） |
| 待决问题 | `docs/OPEN_QUESTIONS.md`（未决项不得自行伪造共识）；第一批 #34/#37/#38/#40/#42 **已关闭**，第二批 **#35/#36/#41/#46 已关闭**、**#39/#43/#44/#45 顺延下一期（R2.6）首批** |
| 按原作重做 | **已通过（`6124840`，ADR-0017b / ADR-0018）**。T-2 引擎增量仅 1 个加法效果 `setIdentity { gender?, age? }`（改年龄同步重置 `playerAgeAtStart`），不改任何既有路径；T-1 模板整体重做：8 章 / 283 事件 / 12 结局、时间线按原作公历 2006→2019（终止 day4755）、术式改为「补正 + 技能」、领域展开实装、`deathRoute` 取消（D-11 因此自然关闭）。**破坏性**：模板指纹变化 ⇒ 旧存档全部拒载。验证：typecheck 0 错、shared 62/62、game-core 370/370、6 种子 × 2 开局通关至 day4755。 |
| NPC 生命周期补强 | **已验收通过（HEAD `467270b`，报告 `tasks/reports/ADR0021-ACCEPTANCE.md`）**，ADR-0021。四项：① **战斗参战判活**（`resolveCombatRefs` 单一入口；敌人耗尽整条跳过不建空场——空 enemies 会让 `checkBattleEnd` 立刻判胜白送 `onVictory`；友军耗尽照常打）；② **reasonCode 展示**（前端只显示模板给的具体原因，无 code 回退「已离场」，全页不再出现「已故/失联」）；③ **NPC 属性投影**（`npcs[].attributes` 只透 `attributes.order` 内键的 base 原值，不下发 effective——否则成 hidden 侧信道）；④ **birthTime 年龄派生**（含修 `CalendarAdapter` 负分钟：原钳位使 `toMinutes(-15y)` 静默返回 0；顺带打开 R3 回拨 seam）。验证：typecheck 0 错、game-core **415/415**、shared 62/62、build 通过；QA 自建 37 条探针独立复验全绿，0 条 P0/P1。 |
| NPC 刷新机制 | **已实现（`fecc6dd`，ADR-0022）**，补 ADR-0010 决策 4 / R-LM-04 的欠账（与 ADR-0020 生命周期是同一次遗漏）。三层：配置 `npcSpawnRules[{id, characterRef, age?}]` → 实例 `state.spawnRules`（pending/spawned，进存档）→ 事实 `state.spawnLog`（append-only）。建世界期规则角色为 `unspawned` 且**不上屏**；效果 `spawnNpc{ruleId}` 幂等出生，`age:0` 即新生儿（`birthTime` 第二写入点）。**刻意不做 `spawnAt` 自动出生**：R-LM-04 要求 spawn 不得由已有事实（含时间到达）自动触发。验证：typecheck 0 错、game-core **422/422**、shared 62/62；模板未声明规则 ⇒ 行为零变化。 |
| 剧本重构 + 机制落地 | **已验收通过（HEAD `b1321ec`，报告 `tasks/reports/JJK-SCRIPT-ACCEPTANCE.md`，ADR-0024）**。三段：① **机制接线**（`0ca88d0`）：虎杖/伏黑身体争夺用 `setNpcLifecycle` + `reasonCode` 当 cause、决战宿傩拆成 `enemy-sukuna-megumi`/`-incarnate` 两个 NPC、`rule-yuta-arrival` 让 spawn 真正生效；② **P0 因果 9 项 + 密度**（`b7a53ee`/`8c99cf3`）：事件 91→109、战斗 12→18，七海按原作谢幕；③ **两条 P1**（`0759497` 理子生死落 lifecycle、`bbb440b` 待决事件呈现前前提复核、`b1321ec` 已故者年龄冻结）。QA 复验：30 种子诈尸扫描 18→**0** 命中；旧 `optionId` 提交必失败；零选项死锁不可构造；跨版本前缀逐字节相同。验证：typecheck 0 错、game-core **462/462**、shared 62/62、build 通过。 |
| 阶段策略 | **2026-11-12 用户裁决：demo 期以内核开发为主，模板会频繁变更。** **仅改 `specs/data/templates/**/*.yaml` 的模板变更免 ADR**；只有动到协议面（schema 字段/枚举、effect 类型、`source`/`kind` 语义、投影契约、存档结构）才走 ADR。免 ADR 仍须加载期校验 + 读模板的测试 + 一条冒烟，并声明指纹变化致旧档拒载。判据见 `AGENTS.md` §0.3。 |
| 待办池 | **`docs/BACKLOG.md`** —— 小问题 / 优化点 / 已裁决不修 / 环境坑 / 证据缺口。**默认不做**，用户裁决「先完成主要模块建设，细节不扣死」；开新一轮时从这里挑条目升级为 `T-*`，勿在验收报告里重复立案。 |

> 状态会变。每轮迭代收尾时**只更新本表**，不要在别处另建第二份状态。

## 3. 迭代输入（消费顺序固定 · 2026-11-12 收起）

> **默认只读 §3 的 0–2 行。** 查全部 spec 前必须先通知用户确认（见 `AGENTS.md` §0.1、`specs/README.md` §0）。

| # | 文件 | 作用 | 何时读 |
|---|---|---|---|
| 0 | `AGENTS.md` | 工程规范与硬约束 | 任何任务先读 |
| 1 | `specs/core/GAME_RULES.md` | **一页纸核心决策速查**（时间/事件/终止/评价/NPC/投影/模板边界） | 默认必读，够用即止 |
| 2 | `specs/core/` 其余 | `CORE_ENGINE` / `TEMPLATE_PROTOCOL_V2` / `MOBILE_UX` / `JJK_DEMO`，按 `specs/README.md` §2 的对照表按需取 | 命中对应领域时 |
| 3 | `specs/iterations/<当前迭代>/` | 活跃迭代四件套 `README / requirements / design / tasks` | **仅当前迭代**（当前为空） |
| 4 | `docs/DECISIONS.md` | ADR 正文 | 重大改动时 |
| 5 | `specs/archive/**` | 已关闭迭代与历史设计稿，**不构成现行约束** | 仅在用户点名或排查「当初为什么」时，且需先声明 |
| 6 | `docs/BACKLOG.md` / `docs/OPEN_QUESTIONS.md` | 小问题池 / 产品待决项 | 规划下一轮、或遇到未定规则 |
| 7 | `tasks/reports/*.md` | 验收证据与结论 | 复核历史结论时 |

## 4. 硬约束（不可协商，摘自 `AGENTS.md`）

- `packages/game-core` 是确定性内核：不依赖 React / Fastify / DB / LLM SDK；对外输入一律 Zod 校验。
- 相同初始状态 + 相同输入 + 相同 seed ⇒ 相同结果（含阶段序列、结局、评价、装备效果、AI 决策）。
- AI 只做受约束叙事与候选生成，**不得写入权威状态、不得决定评分**；LLM 输出须结构校验，失败回退模板。
- 隐藏信息 `hidden` 不得进入玩家端 API 投影。
- 世界观专属规则只能进模板，不得硬编码进通用引擎。
- 时间、随机数、ID 必须可注入；禁止 `any` 逃逸、禁止吞异常。
- **改核心数据模型 / 技术栈 / 目录结构 / 游戏规则 / 协议面前，先写 ADR**（`docs/DECISIONS.md`）。**例外：仅改 `specs/data/templates/**/*.yaml` 的模板变更免 ADR**（见 `AGENTS.md` §0.3）。
- 一次只做一个明确任务，小步提交、可运行、可测试；不要擅自扩展范围。

## 5. 专家团与迭代发起方式

- 专家中心 → 我的专家 → **「人生模拟器研发团」**（Team 型，团长 + 需求策划 / 架构 / 内核后端 / 前端 / 测试验收）→ 召唤。
- 发起一轮迭代的推荐说法（把「目标 / 输入 / 输出 / 约束」四件事说清）：

  ```
  目标：推进 R2 阶段 0 的差距复核。
  输入：`specs/core/GAME_RULES.md` + 当前迭代四件套 `specs/iterations/<id>/`、AGENTS.md、当前工作区代码。
  输出：更新 tasks/reports/R2-GAP-ANALYSIS.md，逐条标注 45 条 ACTIVE 需求状态。
  约束：不改任何实现代码；DEFERRED/RETIRED 只登记不分析；不确定项写 docs/OPEN_QUESTIONS.md。
  ```

- 不召唤专家团时，也可直接用项目技能 `/life-sim-iteration` 按同一套 SOP 走。
- 汇报统一按 `AGENTS.md` §4：改动摘要 / 关键设计决策 / 执行过的命令及结果 / 未完成项与风险 / 是否修改了 Spec。

## 6. 本地运行与外网测试

- 启动：`pnpm dev`（服务 `0.0.0.0:3000`，前端 `apps/web`，API `apps/server`）。
- 外网联调：`C:\Users\kazag\WorkBuddy\2026-11-11-04-05-38\tunnel\start-tunnel.bat`，
  启动后窗口里会打印 `https://*.trycloudflare.com` 临时公网地址（**每次重启会变**）。
  该链接公开无鉴权，测完及时关闭；需要固定地址时再单独处理端口映射或命名隧道。
- 前端 API 基址为相对路径（`'BASE = ""'`），因此反向代理 / 隧道下无需改代码。

## 7. 目录约定

- `specs/` — 规格与设计；`tasks/` — 实施计划与报告；`docs/` — 产品、架构、ADR、待决问题。
- `.workbuddy/` — WorkBuddy 协作元文件（项目记忆 + 项目技能），**不参与构建**，不属于产品架构。
- 新增一轮迭代时，在 `specs/iterations/<YYYY-MM-DD>-<短标签>/` 下沿用 `README → requirements → design → tasks` 四件套，
  编号不重排，延期需求保留编号与原文。
