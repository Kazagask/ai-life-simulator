# 建议实施顺序

## Milestone 0：工程可运行
- pnpm workspace
- TypeScript strict
- Vitest
- web/server/core 最小启动
- CI 命令可本地运行

## Milestone 1：模拟内核 P0
- shared schemas/types
- world state
- time pacing
- player action
- NPC autonomous action
- event pool
- event chain
- visibility projection
- history/evaluation

## Milestone 2：API 与存档
- in-memory repository
- create world / get world / advance turn / history
- PostgreSQL + Drizzle adapter

## Milestone 3：竖屏 Web Demo
- 人生页
- 人物页
- 世界页
- 记录页
- 行动输入和推进控制

## Milestone 4：AI 叙事接入
- provider adapter
- structured output schemas
- candidate validation
- narrative fallback
