# 系统架构 V0.1

## 1. 总体架构

采用 TypeScript 全栈、pnpm workspace、模块化单体。先保持轻量，不引入微服务。

```text
apps/
  web/       React + Vite + PWA，竖屏交互
  server/    Fastify API、应用编排、持久化
packages/
  game-core/ 确定性模拟引擎（纯业务逻辑）
  ai-core/   LLM provider adapter、提示词、结构化输出校验
  shared/    共享 schema、DTO、常量
```

## 2. 依赖方向

- `apps/web` -> `packages/shared`
- `apps/server` -> `packages/game-core`, `packages/ai-core`, `packages/shared`
- `packages/game-core` -> `packages/shared`（允许）; 不依赖 Web/API/数据库/LLM SDK
- `packages/ai-core` -> `packages/shared`; 不直接写数据库或修改世界状态

## 3. 技术基线

| 层 | 默认技术 |
|---|---|
| Monorepo | pnpm workspace |
| Language | TypeScript strict |
| Web | React + Vite + PWA |
| UI | Tailwind CSS；组件可选 shadcn/ui |
| Client state | Zustand（仅 UI/会话状态） |
| API | Fastify |
| Validation | Zod |
| Database | PostgreSQL |
| ORM | Drizzle |
| AI integration | Provider adapter；可适配 Vercel AI SDK |
| Tests | Vitest |
| Transport | REST；需要流式叙事时使用 SSE |

不在 P0 引入 Redis/BullMQ。只有确有后台队列、长任务或并发需求时再 ADR 决定。

## 4. 核心模块

### game-core
- `clock`：世界历法、时间步长、年龄阶段 pacing
- `state`：世界、角色、NPC、关系、秘密、事件状态
- `turn`：轮次编排
- `actions`：玩家行动和 NPC 行动结算
- `events`：事件池、条件、权重、冷却、事件链
- `visibility`：信息可见性与信息差
- `evaluation`：人生评价
- `history`：事件日志、人生记录、快照

### ai-core
- `providers`：模型供应商适配
- `prompts`：任务提示词
- `schemas`：AI 输出 Zod schema
- `validators`：候选行动/事件的规则校验
- `narration`：叙事和摘要生成

## 5. 状态与可复现性

- 模拟核心使用显式 `seed` 和可注入随机源。
- 核心计算尽可能使用纯函数。
- 每次推进保存输入、输出、随机种子和事件记录。
- 支持快照 + 事件历史；P0 可先采用简单快照和 append-only event log。
- AI 输出必须先校验结构、再校验权限/前置条件，最后由规则引擎应用。

## 6. 持久化策略

P0 可先用内存仓储跑通测试和 Demo；接入 PostgreSQL 时通过 Repository 接口替换，不让 ORM 进入 game-core。

## 7. API 草案

- `POST /api/worlds`：创建模拟世界
- `GET /api/worlds/:worldId`：读取可见世界状态
- `POST /api/worlds/:worldId/turns`：提交玩家行动并推进一轮
- `GET /api/worlds/:worldId/history`：读取人生记录/事件日志
- `POST /api/worlds/:worldId/advance`：自动推进（支持步数/目标时间）
- `GET /api/templates`：列出世界模板

API 返回玩家可见视图，不得返回 NPC hidden secrets。
