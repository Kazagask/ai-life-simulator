# 项目长期记忆 · AI 人生模拟器

## 项目定位
- 竖屏移动端人生模拟器，pnpm workspace + TypeScript strict，Node 22+。
- 三块边界：`packages/game-core`（确定性模拟内核）、`apps/server`（Fastify API / 编排 / 持久化）、`apps/web`（React + Vite 展示层）。
- 权威规范在仓库 `AGENTS.md`；迭代入口面板是 `PROJECT.md`（2026-11-11 建立）。本文件只记跨会话需要复用事实，不复制规范全文。

## 工作方式（用户偏好，2026-11-11）
- 主要用 WorkBuddy 项目化迭代，减少本地 CodeBuddy 开发。
- 工作空间 = `D:\code\ai-life-simulator`；迭代用 Spec Coding：`requirements → design → tasks`，先审查对齐再实施。
- 已配置 Team 型专家包「人生模拟器研发团」（`life-sim-dev-team`），注册在 `~/.workbuddy/plugins/marketplaces/my-experts/`。
- 项目技能：`/life-sim-iteration`（`.workbuddy/skills/life-sim-iteration/`）。

## 硬约束速查（详见 AGENTS.md）
- 同初始状态 + 同输入 + 同 seed ⇒ 相同结果；game-core 不得依赖 React / Fastify / DB / LLM SDK。
- AI 只做叙事与候选生成，不得写入权威状态或决定评分；LLM 输出须结构校验并回退模板。
- `hidden` 信息不得进入玩家端 API 投影；世界观规则只能进模板。
- 改核心数据模型 / 技术栈 / 目录结构 / 游戏规则前先写 ADR（`docs/DECISIONS.md`）。
- 不确定产品规则写 `docs/OPEN_QUESTIONS.md`，禁止自行伪造共识；一次只做一个任务，小步提交。

## 迭代状态（2026-11-11）
- 当前轮次 R2.2「终止模型 + 结局评价 + 遗留能力补齐」：45 ACTIVE / 7 DEFERRED（时间穿越→R3）/ 6 RETIRED（Lifecycle 状态机）。
- 用户已定：不引入六阶段 Lifecycle 状态机；ADR-0004 属本轮、ADR-0005 留给穿越；装备词条动态补正；HP 与死亡结局解耦；条件化 AI 只读公有字段。
- V1 引擎与类型已下线，只保留 V2 共用 `rng.ts`；禁止再引用 `evaluateLife` / `advanceTurn` 等 V1 符号。
- 阶段 0/1 完成前不得进入编码实现；`tasks.md` 约定同一时刻只允许一个 Agent 写 `packages/`。

## 运行与联调
- `pnpm dev` → `0.0.0.0:3000`，标题「AI 人生模拟器」；前端 API `BASE = ""` 为相对路径。
- 外网测试用 Cloudflare Quick Tunnel：`C:\Users\kazag\WorkBuddy\2026-11-11-04-05-38\tunnel\start-tunnel.bat`（`--protocol http2`，本机 QUIC/UDP 不通）。每次重启换随机域名。
- 家里光猫超管被锁、自有 frp 服务端 9002 不通，暂不具备固定公网地址。
