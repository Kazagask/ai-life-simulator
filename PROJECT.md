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
| 当前迭代 | **R2.6「关系图谱 + 时间适配器落地」已启动**（`specs/iteration-2026-11-12-r26/`）：ADR-0013（日历 ②③ + 字面量）/ ADR-0014（关系图 + `relationship.js` 依赖）已通过；实施中（WS-A `T-A1..A5` 时间适配器、WS-B `T-B1..B6` 关系图谱，按 G3 单任务推进）。上一轮 **R2.5 事件模型 `T1-01..T1-09` 已落地自验**（待 QA 验收）；**R2.4「装备归属修复 + DNF 式个人面板」已收尾**。 |
| 范围 | 用户裁决：先把「配置 / 实例 / 事实」三层梳理清楚再编码。事件侧收敛为立即/延时两类 + 时间窗队列 + 入队门控，退役 x 轮后触发，`pool` 只产出延时事件且 combat 不入池，断链判定须查时间队列；NPC 侧投影与生命周期解耦、`spawn-alive-dead` 默认判活、出生时间动态年龄、关系类型化与亲属/师承推导（含断代与多跳称谓）。→ **ADR-0010/0011/0012（状态：已通过 2026-11-12 G1 评审）**；需求 **27 ACTIVE（LM 5 / EV 15 / NP 7）+ 1 DEFERRED** |
| 进度 | **G1/G2 已过；R2.5 事件模型 9 个任务全部落地并自验完成（待 `life-sim-qa` 验收）**：`T1-01`..`T1-03` 分别落模板契约 / 状态层 / 调度器（`bd5ef2f`、`bd84f61`、`dfa15a6`），`T1-04`..`T1-07` 引擎接线（`23706e1`），`T1-08` 夹具迁移与验收用例（`f1fd1ee`），`T1-09` 协议 §9.6/§22 与完成报告。**自验**：`pnpm typecheck` 0 错误；game-core 275/275、shared 50/50；`pnpm build` 通过；服务 `/api/templates` 200；HTTP e2e 在 `worldTime=1440` 到点触发 `ev-sp-briefing`。详见 `tasks/reports/R25-COMPLETION.md` 与 r25 `tasks.md` §1.1 |
| 已有产出 | R2.5 实现：单一 `TimeSpec` + `window/delay/cooldown/timeCost/missWhen`、退役字段诊断与 #35 加载期强制、`ScheduledEventInstance` 三层分离、`scheduler.ts` 确定性出队与封闭 `MissReason`、pool 门控入队与 combat 不入池、链延时步与 `alignChainStep`、结算轮 + `timeCost`、事件轮共享尾管线、`schemaVersion=2` 拒载旧档、协议 §22 调度章节 + 完成报告；**规格侧**保留三层混杂清单 M1–M11、ADR-0010/0011/0012（已通过）与 R2.6 的 NPC 设计 |
| 下一步 | 等待 QA 验收 R2.5；按裁决把 **#39/#43/#44/#45**（真实公历/自定义纪元与年号/字符串 `TimeSpec`/世界时间上界）与 **R2.6 NPC 系统（`T2-*`）**放到下一期首批。遗留：`test-design.md` 仍有与已关闭裁决冲突的旧用例待规格轮对齐；`T1-09` 的 curl 级错失/断链负向 e2e 未做（见报告 §7.1）；战斗结束结算轮是否跑完整尾管线待裁定（报告 §6.9） |
| 待决问题 | `docs/OPEN_QUESTIONS.md`（未决项不得自行伪造共识）；第一批 #34/#37/#38/#40/#42 **已关闭**，第二批 **#35/#36/#41/#46 已关闭**、**#39/#43/#44/#45 顺延下一期（R2.6）首批** |

> 状态会变。每轮迭代收尾时**只更新本表**，不要在别处另建第二份状态。

## 3. 迭代输入（消费顺序固定）

| # | 文件 | 作用 |
|---|---|---|
| 0 | `AGENTS.md` | 工程规范与硬约束，任何任务先读 |
| 1 | `specs/iteration-*/README.md` | 本轮范围、冲突对齐、硬约束、交给 Coding Agent 的读法 |
| 2 | `specs/iteration-*/requirements.md` | EARS 需求 + 验收标准 + 追溯矩阵 |
| 3 | `specs/iteration-*/design.md` | 现状盘点、数据模型、接口建议、需 ADR 清单 |
| 4 | `specs/iteration-*/tasks.md` | 分阶段任务、依赖、产出、完成定义 |
| 5 | `tasks/reports/*.md` | 差距报告与验收证据 |

## 4. 硬约束（不可协商，摘自 `AGENTS.md`）

- `packages/game-core` 是确定性内核：不依赖 React / Fastify / DB / LLM SDK；对外输入一律 Zod 校验。
- 相同初始状态 + 相同输入 + 相同 seed ⇒ 相同结果（含阶段序列、结局、评价、装备效果、AI 决策）。
- AI 只做受约束叙事与候选生成，**不得写入权威状态、不得决定评分**；LLM 输出须结构校验，失败回退模板。
- 隐藏信息 `hidden` 不得进入玩家端 API 投影。
- 世界观专属规则只能进模板，不得硬编码进通用引擎。
- 时间、随机数、ID 必须可注入；禁止 `any` 逃逸、禁止吞异常。
- **改核心数据模型 / 技术栈 / 目录结构 / 游戏规则前，先写 ADR**（`docs/DECISIONS.md`）。
- 一次只做一个明确任务，小步提交、可运行、可测试；不要擅自扩展范围。

## 5. 专家团与迭代发起方式

- 专家中心 → 我的专家 → **「人生模拟器研发团」**（Team 型，团长 + 需求策划 / 架构 / 内核后端 / 前端 / 测试验收）→ 召唤。
- 发起一轮迭代的推荐说法（把「目标 / 输入 / 输出 / 约束」四件事说清）：

  ```
  目标：推进 R2 阶段 0 的差距复核。
  输入：specs/iteration-2026-11-11/ 四件套、AGENTS.md、当前工作区代码。
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
- 新增一轮迭代时，在 `specs/iteration-<日期>/` 下沿用 `README → requirements → design → tasks` 四件套，
  编号不重排，延期需求保留编号与原文。
