# AI 人生模拟器 · Engineering Starter

一个面向竖屏移动端的、参数化世界观人生模拟器工程起点。

> 本仓库是给 WorkBuddy / CodeBuddy / 其他 Coding Agent 使用的统一基线。
> 当前版本重点是产品规格、架构边界、验收标准和可执行的开发任务，不代表所有 P0 功能已经实现。

## 核心产品循环

人物状态 → 世界动态 → 玩家行动 → 规则结算 → 事件反馈 → 人生变化 → 人生评价

世界不会因为玩家停止操作而停止：NPC 有自己的目标、行动、关系、信息和秘密。

## 技术基线（Starter 默认值）

- Monorepo：pnpm workspace
- 语言：TypeScript
- Web：React + Vite + PWA（竖屏优先）
- API：Node.js + Fastify
- 数据校验：Zod
- 数据库：PostgreSQL + Drizzle ORM（当前阶段可先使用内存仓储）
- 测试：Vitest
- AI：通过 provider adapter 接入；AI 不直接写入核心状态

这些是本 Starter 的默认工程基线。若 Agent 认为必须调整，必须先提交 ADR 说明原因、影响和迁移成本，不得静默换栈。

## 快速开始

需要 Node.js 22+、pnpm 9+。

```bash
pnpm install
pnpm dev
```

开发命令：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 手机试玩测试包

P0 Demo 已实现"创建世界 → 推进轮次 → NPC 自主行动 → 事件池/事件链 → 信息可见性 → 人生评价"闭环。

```bash
pnpm install        # 本机沙箱环境如遇 workspace 链接失败，加 --config.node-linker=hoisted
pnpm build          # 类型检查 + 构建 web 产物到 apps/web/dist
pnpm start          # 启动服务（默认 0.0.0.0:3000，同时托管 web 构建产物）
```

启动后手机与电脑连同一 Wi-Fi，访问 `http://<电脑局域网IP>:3000` 即可（可通过"添加到主屏幕"以独立应用方式运行）。注意存档在内存中，服务重启即清空。

## 先读这些文件

1. `AGENTS.md`：所有 Coding Agent 必须遵循的工程规则。
2. `docs/PRODUCT.md`：产品范围与玩法原则。
3. `docs/ARCHITECTURE.md`：系统边界和技术架构。
4. `specs/core/CORE_ENGINE.md`：核心模拟引擎规格。
5. `specs/core/JJK_DEMO.md`：Demo 世界模板规格。
6. `tasks/AGENT_TRIAL.md`：给 WorkBuddy / CodeBuddy 的同题测试任务。

## 当前阶段目标

先完成一个可运行、可测试的 P0 垂直切片：
- 创建一个世界和玩家角色
- 推进一轮，支持动态时间步长
- NPC 在玩家不操作时仍能自主行动
- 从模板事件池触发普通事件
- 支持动态事件链的最小版本
- 保留事件日志和人生记录
- 生成基础人生评价
- AI 只负责受约束的叙事增强，不拥有状态写权限

## 重要原则

**规则引擎决定发生什么和结果；AI 负责有限的生成、解释与叙事。**
所有 AI 输出必须经过 Zod schema 校验和规则层校验后，才能转化为游戏动作。
