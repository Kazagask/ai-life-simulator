# WorkBuddy 工程清单 · AI 人生模拟器

> **性质声明**：本文件是**本项目自定义的工程元信息**，用途是让 WorkBuddy / 其他 Coding Agent 打开本目录时快速建立上下文。
> 它**不是** WorkBuddy 客户端的配置文件格式，客户端不会解析它，也不会据此改变行为。
> 权威约束始终是 `AGENTS.md` 与 `specs/`；冲突时以二者为准。
> 建立：2026-11-13，依据用户指令「创建成 WorkBuddy 的工程，之后会在云端跑开发测试」。
> 2026-11-13 补充：用户已建 WorkBuddy 云端项目 `p_b65216f5322d464eb95088a64eaf38fa` 与 GitHub 远程仓库，本工程经仓库同步，不再依赖本机磁盘。

## 1. 工程身份

| 项 | 值 |
|---|---|
| 工程名 | AI 人生模拟器（云端应用显示名：咒术转盘人生） |
| 根目录 | 检出 / 解压后含 `pnpm-workspace.yaml` 的那一层 |
| 类型 | pnpm workspace monorepo；Node.js HTTP service + React 竖屏 PWA |
| 运行时 | Node.js 22+ / pnpm 9+（本机实测 22.22.2 / 9.15.0） |
| 单端口 | `PORT`（默认 3000），绑定 `0.0.0.0`；Fastify 同时托管 API 与 `apps/web/dist` |
| 云端应用身份 | `wbapp_6BjykHXBJu8kLx2VWyxeie`，云服务 ACTIVE（2026-11-13 `inspect` 核实，billingStatus normal） |
| 已发布分享链接 | https://cursed-wheel-life.app.workbuddy.host/?sharecode=AWEIS4D6KT |
| Git remote | `origin` = `git@github.com:Kazagask/ai-life-simulator.git`（用户 2026-11-13 创建，空仓库、HTTPS 匿名可读）；因本机 SSH 公钥未绑定 GitHub，`pushurl` 暂走 HTTPS + 已存凭据，详见 `docs/CLOUD_DEV.md §1` |
| WorkBuddy 云端项目 | `projectId=p_b65216f5322d464eb95088a64eaf38fa`；代码经上述 GitHub 仓库同步，项目内有内置任务管理系统（清单见 `tasks/CLOUD_TASKS.md`） |
| 当前 HEAD | `2a296d6`（文档收尾）；功能与 ADR 收口于 `0f42bd0` |

## 2. 三块边界（`AGENTS.md §1`）

| 目录 | 职责 | 硬边界 |
|---|---|---|
| `packages/game-core` | 确定性模拟内核 | 不得依赖 React / Fastify / DB / LLM SDK / 网络调用 |
| `packages/shared` | schema 与共享类型 | 契约面改动属 T-2，须先写 ADR |
| `apps/server` | Fastify API、持久化、编排、LLM Provider | LLM 注入只能在归档 / 读取 / 响应出口，绝不进 turn 管线 |
| `apps/web` | 竖屏 PWA 展示 | 不得持有 LLM 凭据、不得直连 LLM、不得承载权威规则 |

## 3. 命令基线（均在仓库根执行）

```bash
pnpm install
pnpm typecheck
pnpm test                                    # = game-core 全量 vitest
pnpm --filter @life-sim/shared test          # shared 全量
pnpm build                                   # typecheck + web build → apps/web/dist
pnpm start                                   # 起 3000，serve dist + API
```

定向用例：

```bash
pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism src/v2/playthrough.test.ts
pnpm --filter @life-sim/server exec tsx smoke/narrative.smoke.ts
node apps/server/smoke/cloud.smoke.mjs       # 可移植冒烟，见 docs/CLOUD_DEV.md
```

## 4. 环境变量（云端必须可注入）

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `3000` | 单端口监听；改后 e2e 基址须同步 |
| `LIFE_SIM_DATA_DIR` | `<repo>/data/worlds` | 存档目录，建议挂持久卷 |
| `LIFE_SIM_LLM_BASE_URL` / `_MODEL` / `_API_KEY` | 无 | OpenAI 兼容路由；三项缺任一即整组不可用 |
| `LIFE_SIM_WORKBUDDY_SESSION` / `_CLOUD_URL` | 无 | 云端降级路由；未注入即 `LLMUnavailableError` 回退模板 |
| `LIFE_SIM_BASE_URL` | `http://127.0.0.1:3000` | 可移植冒烟脚本基址 |
| `CHROME_PATH` | 自动探测 | 竖屏 UI e2e 的 Chrome / Chromium 可执行文件 |

**无 `LIFE_SIM_LLM_*` 且无登录态 ⇒ Mock 短路 `template`、根本不调 `complete()`，叙事与改前逐字相同。**
这是零回归基线；不要为了「让 AI 生效」在云端塞假凭据。

## 5. 本机绑定（搬到云端前必须知道）

- `data/_aishot/*.mjs`（11 个历史 e2e）**硬编码** `http://127.0.0.1:3000` 与 `C:/Program Files/Google/Chrome/Application/chrome.exe`。云端不要直接跑；用 `apps/server/smoke/cloud.smoke.mjs`，或先参数化。
- `specs/data/templates/**/*.yaml` 是**运行时资产**（服务端按路径加载），不是文档，禁止移动 / 改名；任一 yaml 变化都会改模板指纹 ⇒ 旧存档全部拒载。
- `apps/web/dist` 是构建产物且被 gitignore。云端 clone / 解压后**必须先 `pnpm build`**，否则 `/` 返回 503 `web_dist_missing`。
- `data/worlds/*.json` 本机有 61 个历史存档，其中 57 个因 `template_fingerprint_mismatch` / `schema_version_mismatch: 1` 被拒载（`save_skipped`）——这是既定策略，不是故障。**测试一律新建世界，不复用旧存档。**
- 开局有 12 个待决命数转盘事件，直接 `POST /turns` 会返回 409 `pending_event_required`（正常护栏）。
- `PROJECT.md §6` 记的 Cloudflare 隧道脚本是本机绝对路径，云端不可用。
- 已存在一条 cloudflared 隧道指向本机 3000，且隧道侧缓存过旧 CSS hash；云端环境与之无关。

## 6. 迭代与门禁

- Spec Coding：`requirements → design → tasks`；新迭代建在 `specs/iterations/<YYYY-MM-DD>-<短标签>/`，收尾整包移入 `specs/archive/iterations/`。
- **G1 / G2 正常门禁仍生效**：动 `packages/shared` / `packages/game-core` / `apps/**` 契约面（T-2）必须先写 ADR 并经评审；仅改模板 yaml 免 ADR（`AGENTS.md §0.3`）。
- ADR-0027 的「免前置 ADR + 事后补记」是 **2026-11-13 一次性裁决，不延续到后续任何任务**。
- 待决项登记在 `docs/OPEN_QUESTIONS.md`（当前 **#49** 未决：登录用户 → 服务端免密钥 LLM 的真实注入链路）；不得自行伪造共识。
- 小问题 / 优化点记 `docs/BACKLOG.md`，不要新建 spec 文件追踪。
- **CI = 本地命令的镜像**：`.github/workflows/ci.yml` 在 push / PR 到 `main` 时跑
  `pnpm typecheck` → `shared test` → `pnpm test` → playthrough（串行）→ `web build` → 可移植冒烟，
  命令与 §3 完全一致。CI 红即视为门禁未过，不接受「本地过了」放行。

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `docs/PROJECT_MEMORY.md` | 项目记忆快照（跨会话事实、已裁决决定、已知坑），由 `.workbuddy/memory` 提炼入库 |
| `.workbuddy/experts/README.md` | 「人生模拟器研发团」专家包入库说明与换机安装步骤 |
| `.github/workflows/ci.yml` | GitHub Actions 门禁（L0–L5 与本地命令一致） |
| `docs/CLOUD_DEV.md` | 云端开发测试 runbook（环境、命令、验收分层、已知坑） |
| `tasks/CLOUD_TASKS.md` | 云端任务清单（YAML 机器可读 + Markdown 表格），供内置任务管理系统导入 |
| `AGENTS.md` | 工程规范与硬约束（任何任务先读） |
| `PROJECT.md` | WorkBuddy 项目面板 / 迭代状态快照 |
| `tasks/reports/R27-COMPLETION.md` | R2.7 完成报告（含上轮明确未执行的验证清单） |
| `docs/DECISIONS.md` | ADR 正文（ADR-0027 为 LLM 叙事层） |
| `docs/OPEN_QUESTIONS.md` | 产品待决项 |
