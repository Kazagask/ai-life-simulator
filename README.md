# AI 人生模拟器

AI 驱动的 RPG 人生模拟。四层分工：模板给故事骨架 → core 定通用 RPG 规则 → AI 补血肉 → 前端可定制。

## 当前状态（2026-11-16）

**没有生效中的规格。** 「推倒重来」之前的全部 spec / ADR / BACKLOG / 待决项 / 验收报告
已整体归档到 [`archive/2026-11-16-pre-rewrite/`](archive/2026-11-16-pre-rewrite/)，
**不构成任何现行约束**，只作排查历史用。新规格正在重写，写到哪算哪。

## 跑起来

需要 Node.js 22+、pnpm 9+。

```bash
pnpm install
pnpm dev            # server 0.0.0.0:3000（serve 构建产物）+ vite 5173
```

```bash
pnpm typecheck      # 全仓类型检查
pnpm test           # 五包最小测试集（shared / game-core / agent-runtime / rpg-ui / server）
pnpm test:playthrough   # 6 种子整局回归（demo-agentic 跑到结局）
pnpm build          # typecheck + web 构建
```

## 目录

| 路径 | 作用 |
|---|---|
| `packages/game-core` | 确定性模拟内核（不依赖 React / Fastify / DB / LLM SDK） |
| `packages/shared` | 契约层（zod schema、投影契约、引擎 API 类型） |
| `packages/agent-runtime` | LLM 编排（provider、工具循环、上下文组装） |
| `packages/rpg-ui` | 可复用 React 组件库（只吃 ViewModel） |
| `apps/server` | Fastify API / 持久化 / 应用编排 |
| `apps/web` | 默认前端（竖屏 PWA） |
| **`specs/data/templates/`** | **运行时资产**：服务端按此路径加载世界模板，不得迁出或改名 |
| `archive/` | 历史（当前无任何约束力） |

## 本地数据

`data/worlds/`（可用 `LIFE_SIM_DATA_DIR` 挂载）；模板指纹不匹配的旧档会被拒载。
