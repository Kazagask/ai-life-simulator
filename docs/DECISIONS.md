# 已知决策与未决项

## 当前作为工程基线采用
- 竖屏移动端、单手操作、叙事优先、卡片交互、Bottom Sheet、底部 Tab。
- TypeScript / Node.js 生态。
- 模块化单体，核心模拟引擎与 UI、API、LLM 解耦。
- 确定性规则引擎 + 受约束 AI 叙事/生成。
- 世界模板参数化，世界时间与逻辑轮次解耦。
- P0 优先验证轮次、时间、NPC、事件、信息差和人生评价闭环。

## 本 Starter 暂定技术默认值
React + Vite + PWA、Fastify、PostgreSQL、Drizzle、Zod、Vitest、pnpm workspace。
此前讨论过 Vue/React、Prisma/Drizzle 等备选，但没有形成足够明确的最终确认。若要改动，先提交 ADR，不要静默换栈。

## 明确不做
- 不要求 AI 每轮介入。
- 不让 AI 直接写入权威游戏状态。
- 不要求 P0 上微服务、Redis 或复杂多 Agent。
- 不强制原作剧情按固定顺序发生。
