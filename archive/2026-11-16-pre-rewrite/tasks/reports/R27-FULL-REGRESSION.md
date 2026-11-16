# R27 全量回归报告 · R27-FULL-REGRESSION.md

> 对应云端任务：`CT-01`（R2.7 全量回归补齐）＋ `CT-02`（云端起步复跑 cloud.smoke.mjs）
> 执行环境：WorkBuddy 云端沙箱（Ubuntu 22.04 / Node 22.13.0 / pnpm 9.15.x），仓库基线 `main @ 2850797`（tarball 全量检出，非 git clone）
> 执行日期：2026-11-13 ｜ 本报告只记录实测命令、退出码与输出摘要，未跑项如实标注，未把任何未跑项写成 PASS。

## 0. 结论速览

| 口径 | 命令 | 结果 | 退出码 |
|---|---|---|---|
| L0 typecheck | `pnpm typecheck` | **0 错** | 0 |
| L1 shared 全量 | `pnpm --filter @life-sim/shared test` | **67 passed / 67（5 文件全绿）** | 0 |
| L2 game-core 全量 | `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | **478 passed / 478（33 文件全绿）** | 0 |
| L2b playthrough | `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism src/v2/playthrough.test.ts` | **2 passed**（6 种子 × 2 开局自动通关） | 0 |
| L3 narrative 冒烟 | `pnpm --filter @life-sim/server exec tsx smoke/narrative.smoke.ts` | **6 PASS + SMOKE OK** | 0 |
| L4 web build | `pnpm --filter @life-sim/web build` | 成功（`index-DLvGHcIx.js 357.10 kB / gzip 108.99 kB`，825 ms） | 0 |
| CT-02 云端冒烟 | 起 server 后 `LIFE_SIM_BASE_URL=http://127.0.0.1:3000 node apps/server/smoke/cloud.smoke.mjs` | **6 PASS + 1 SKIP + SMOKE OK** | 0 |

**结论：CT-01 验收条件全数满足；9 条 ACTIVE 需求（R-LLM-01..06、R-NAR-01..03）的全量回归证据链就此补齐。**

## 1. 环境与基线

- 仓库获取：沙箱直连 github.com 不通，走 `codeload.github.com` 下载 `main` 分支 tarball（3.84 MB），HEAD = `2850797`（内容校验与连接器读取的 blob SHA 一致）。
- 依赖安装：`pnpm install --registry=https://registry.npmmirror.com`（仓库 `.npmrc` 已声明该源）。
- 数据隔离：`LIFE_SIM_DATA_DIR=/tmp/life-sim-e2e-data`，未混用任何已有存档；测试新建世界。

## 2. 逐项实测记录

### L0 typecheck
```
> tsc --noEmit -p tsconfig.json
（无输出，0 错）  exit 0
```

### L1 shared 全量
```
Test Files  5 passed (5)
     Tests  67 passed (67)
  Duration  4.20s   exit 0
```
> 注：R26 报告时代为 50 passed/3 文件；R2.7 期间新增 `event-flavor.test.ts` 等文件，总数随之增长。

### L2 game-core 全量（--no-file-parallelism，规避并行 SIGTERM 已知坑）
```
Test Files  33 passed (33)
     Tests  478 passed (478)
  Duration  20.94s   exit 0
```

### L2b playthrough 6 种子 × 2 开局
```
Test Files  1 passed (1)
     Tests  2 passed (2)
   exit 0
```
两用例覆盖 6 种子 × 2 开局（`op-2006-tokyo` / `op-2006-kyoto`）自动通关，day / 章节数 / 五维评价与 R27-COMPLETION.md 冒烟基线一致（用例内断言通过即基线一致）。

### L3 服务端 narrative 冒烟
```
PASS ① createLLMProvider 三层路由 / API_KEY 缺失自动 Mock 不抛
PASS ② generateNarrative 三类反例(非法 schema / 虚构证据 / 超时)回退且 diagnostic 可区分
PASS ③ 合法候选 ⇒ llm；mock ⇒ template 且不调用 complete
PASS ④ finalizeEvaluationSummary 注入 LLM 前后 dimensions/evidenceIds/overall 逐字段相等
PASS ⑤ decorateEndingView 对 hidden 结局原样返回；public 才装饰
PASS ⑥ flavorCache 键确定性 + 缓存不进状态
SMOKE OK   exit 0
```

### L4 web build
```
dist/index.html                   0.96 kB │ gzip:   0.49 kB
dist/assets/index-0eqS5Zz6.css   24.07 kB │ gzip:   5.32 kB
dist/assets/index-DLvGHcIx.js   357.10 kB │ gzip: 108.99 kB
✓ built in 825ms   exit 0
```

### CT-02 云端起步 + cloud.smoke.mjs 复跑
- `pnpm build` 后起 Fastify（PORT=3000），`GET /` → **200**，index.html 含 `assets/` 引用（非 503 `web_dist_missing`）。
- `LIFE_SIM_BASE_URL=http://127.0.0.1:3000 node apps/server/smoke/cloud.smoke.mjs`：
```
PASS ① GET /health — 200 ok=true service=life-sim-server protocol=v2
PASS ② GET /api/templates — 200 jjk-2006 已加载
PASS ③ GET / 静态产物 — 200 资源 2 个（assets/index-DLvGHcIx.js）
PASS ④ POST /api/worlds 新建世界 — 201 worldId=7e33d20c-959d-4a2c-9b2b-f3bb29cc60f5
PASS ⑤ GET /api/worlds/:id 含 eventFlavors — 200 eventFlavors 键存在，当前 0 条
PASS ⑥ 零回归基线 — 无 LIFE_SIM_LLM_* / LIFE_SIM_WORKBUDDY_* ⇒ 预期 provider=mock、叙事恒 template、不调 complete()
SKIP ⑦ 竖屏 UI 检查 — RUN_UI 未开启
SMOKE OK   exit 0
```
- 判据 ⑤ `eventFlavors` 键存在 ⇒ 服务跑的是 R2.7（含）之后代码，满足。
- 环境：Node v22.13.0 / pnpm 9.15.x / PORT=3000 / LIFE_SIM_DATA_DIR=/tmp/life-sim-e2e-data。
- 界定：本次在 WorkBuddy 云端沙箱执行（非主理人本机）。UI 段 ⑦ 未跑（未启 Chrome），按脚本口径记 SKIP，不算失败。

## 3. 本轮沙箱内的一处最小环境修正（如实登记）

`packages/game-core/src/v2/playthrough.test.ts` import `yaml`，但 `packages/game-core/package.json` **未声明该依赖**（本机此前靠 hoisting 偶然可解析）。为使云端/新环境 typecheck 与测试可跑，本地执行了：

```
pnpm add -D yaml@^2.4.0 --filter @life-sim/game-core
```

改动仅限 `packages/game-core/package.json` devDependencies 与 lockfile，不触任何源码/契约面；是否把该修正正式入库由主理人裁决（不落库则云端 typecheck 将报 TS2307）。

## 4. 未跑项（显式声明，不写成 PASS）

| 项 | 原因 |
|---|---|
| UI e2e（`data/_aishot/*.mjs` 11 脚本） | 依赖 CT-03 参数化（去掉 `127.0.0.1:3000` / `chrome.exe` 硬编码），本轮范围外 |
| 真实外部 LLM 联网调用 | OPEN_QUESTIONS #49 未决（CT-05 blocked），R27 口径明确排除 |
| curl 级错失/断链负向 e2e（CT-07）、B-23 table-driven（CT-06）、B-13（CT-08） | P2 任务，依赖本报告基线后另行执行 |
| `GET /` 的公网域名取证 | 本沙箱无公网入口，以 `127.0.0.1:3000` 本地取证替代 |
