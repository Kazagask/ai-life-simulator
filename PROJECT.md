# AI 人生模拟器 · WorkBuddy 项目面板

> 本文件是 WorkBuddy 工作空间的**迭代入口与状态快照**，不是产品规格，也不是代码。
> 权威内容始终在 `AGENTS.md`、`specs/`、`docs/` 与代码里。
> 建立于 2026-11-11：本文件与 `.workbuddy/` 均为**新增的协作元文件**，未改动任何既有规格、架构、数据模型或游戏规则。

## 1. 工作空间

- 项目根：`D:\code\ai-life-simulator`（pnpm workspace / TypeScript / Node 22+）
- 在 WorkBuddy 新建任务时：输入框下方「选择工作空间」→「打开本地文件夹」→ 选中此目录。
  之后该项目的所有任务都会归到同一个 Space，侧边栏可回看整个项目的迭代历史。
- 架构边界、技术栈、代码规范：`AGENTS.md` §1–2、`docs/ARCHITECTURE.md`。

## 2. 当前迭代状态（快照：2026-11-11）

| 项 | 状态 |
|---|---|
| 当前迭代 | **R2.5「模型分层：事件触发收敛 + NPC 系统」——规格轮（W3，只出规格不编码）**（`specs/iteration-2026-11-11-r25/`）。上一轮 **R2.4「装备归属修复 + DNF 式个人面板」已收尾**（R-EQ-11..16 验收，见 r24 `tasks.md`） |
| 范围 | 用户裁决：先把「配置 / 实例 / 事实」三层梳理清楚再编码。事件侧收敛为立即/延时两类 + 时间窗队列，退役 x 轮后触发，`pool` 只产出延时事件，断链判定须查时间队列；NPC 侧投影与生命周期解耦、`spawn-alive-dead` 默认判活、出生时间动态年龄、关系类型化与亲属/师承推导。→ **ADR-0010/0011/0012（状态：待评审）**；需求 19 ACTIVE（LM 3 / EV 10 / NP 6）+ 1 DEFERRED |
| 进度 | **G1 未过：零代码改动**。`requirements.md` / `design.md` / `README.md` 已落盘；`tasks.md` 待设计定稿后出。实现拆两批：R2.5 事件、R2.6 NPC |
| 已有产出 | R2.5：三层混杂清单 M1–M11（逐条文件:行）、`scheduledEvents` 时间窗队列与 `drainScheduledEvents` 判定算法、`evaluateChain` 断链对账、NPC 生命周期/投影/`birthTime`/关系推导设计、ADR-0010/0011/0012 草案 |
| 下一步 | 等用户裁决 `docs/OPEN_QUESTIONS.md` #34–#41（设计 `Q-R25-01..10`），其中 #34/#35/#36/#37/#39 为开工前置；裁决后写 `tasks.md` 并从 R2.5 的 schema 收敛开始实施 |
| 待决问题 | `docs/OPEN_QUESTIONS.md`（未决项不得自行伪造共识） |

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
