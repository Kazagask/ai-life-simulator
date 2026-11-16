# Agent 须知（临时版，新规格落地后由新规格取代）

本文件是**占位**，不是规格。仓库当前**没有生效中的 spec / ADR**。

## 唯一硬事实

1. **`specs/data/templates/` 是运行时资产**。服务端按这个路径加载世界模板
   （`apps/server/src/templates.ts`，可用 `TEMPLATES_DIR` 覆盖）。不得迁出、改名或重组。
   模板增删改只走文件系统：`mkdir` = 加版本，改文件 = 热加载生效，`rm -rf` = 删除。
2. **历史全部归档**在 `archive/2026-11-16-pre-rewrite/`，包括旧的 `AGENTS.md`、`PROJECT.md`、
   `docs/`（ADR / BACKLOG / 待决项 / 重构设计）、`specs/core`、`specs/iterations`、`tasks/reports`。
   这些内容**不构成现行约束**，与代码冲突时以代码为准，不要据此改代码。
3. 新规格尚未写。在它落地前，改动请只做用户明确要求的那一件，不要自行扩展范围。

## 命令

```bash
pnpm typecheck         # 全仓 tsc
pnpm test              # 五包最小测试集
pnpm test:playthrough  # 6 种子整局回归
pnpm --filter @life-sim/web build
```

## 已知环境坑（本机）

- 沙箱内 `tsc` 会栈溢出、vitest worker 会 `ERR_IPC_CHANNEL_CLOSED`；跑测试/类型检查需关闭沙箱。
  `tsc` 亦可 `node --stack-size=8000 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`。
- 3000 端口 serve 的是 `apps/web/dist` 构建产物；改前端要看 5173 或先 build。
