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
| 当前迭代 | **R2.4「装备归属修复 + DNF 式个人面板」**（`specs/iteration-2026-11-11-r24/`，小步修复轮）。上一轮 **R2.3「可见性收口 + 存档持久化 + 装备穿脱」已收尾**（16/16 ACTIVE 验收，见 `tasks/reports/R23-COMPLETION.md`） |
| 范围 | 用户四项裁决：① 卸下即遗失 ② 装备不应混在物品栏 ③ 方格 UI + 详情区 ④ DNF 式人物面板 + 背包分区 + 摆位模板化 → **ADR-0008（背包/装备栏物理分离）+ ADR-0009（面板摆位 panelSide）**；R-EQ-11..16 共 6 条，已全部验收 |
| 进度 | R2.4：T1-01..T5-03 全部完成；`pnpm typecheck` 0 错误、game-core 245 tests 全绿、web build 257.97 kB；puppeteer 端到端证据见 r24 `tasks.md`。R2.3：18 个任务全部完成并验收 |
| 已有产出 | R2.3：ADR-0006/0007、历史可见性收口（§21）、JSON 持久化（仓库根 `data/worlds/`、`LIFE_SIM_DATA_DIR` 可挂载、四道关加载）、装备穿脱端点与 UI。R2.4：ADR-0008/0009、协议 §8/§12/§19 修订、穿脱移动背包计数、快照 `equipmentSlots[]`（含 panelSide）、DNF 式个人页（角色面板左/中/右 + 属性网格、背包四分区、统一详情区） |
| 下一步 | R2.3 遗留：阶段 8 与 `TS` 组 5 条 DEFERRED（附录 A/B）；时间跨度 DEFERRED（模板内容治理另行立项）。候选方向：战斗 AI 端点、NPC 生命周期（#21–#25）、LLM 叙事接入——均需先立规格 |
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
