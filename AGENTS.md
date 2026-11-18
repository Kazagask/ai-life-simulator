# Agent 须知（临时版）

**当前生效的规格是 `specs/SPEC.md`**（2026-11-17）。它只写"已实现且可验证"的东西，
未实现的标 `未决`——**不要把它没写的东西当成已承诺**。

本文件是操作须知，不是规格。

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
pnpm build             # typecheck + web 构建
pnpm dev               # server + vite dev
```

**测试在 `test/`（引擎级）与 `extensions/*/test/`（扩展自有）**，根 `pnpm test` = `vitest run`
同时收集两处（`vitest.config.ts` 的 include）。旧的 `test:playthrough` / `test:accept` 已移除，
CI 只剩 typecheck / 测试 / web build / 冒烟。覆盖清单与运行方式见 `specs/SPEC.md` §5。

将来加测试时：**单开仓库根的 `test/` 目录**，不要放回 `packages/*/src` 或 `apps/*/src`；
并显式声明打包边界，确保测试代码不进 npm 包（细节见 `test/README.md`）。

## 已知环境坑（本机）

- 沙箱内 `tsc` 会栈溢出、vitest worker 会 `ERR_IPC_CHANNEL_CLOSED`；跑测试/类型检查需关闭沙箱。
  `tsc` 亦可 `node --stack-size=8000 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`。
- 3000 端口 serve 的是 `apps/web/dist` 构建产物；改前端要看 5173 或先 build。
