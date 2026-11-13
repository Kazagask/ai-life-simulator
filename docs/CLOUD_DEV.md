# 云端开发测试 Runbook

> **目的**：把本地工程搬到 WorkBuddy 云端（或任意 Linux / 容器环境）后，能独立走完
> `install → build → start → test`，不依赖本机绝对路径、本机 Chrome 与本机旧存档。
> **口径**：只写实际存在的命令与已核实的事实；未验证项明确标注，绝不把未跑写成已验证。
> 建立：2026-11-13。权威约束：`AGENTS.md`、`specs/core/`、`docs/DECISIONS.md`。

## 0. 前置条件

| 项 | 要求 | 核实方式 |
|---|---|---|
| Node.js | 22+（本机 22.22.2） | `node -v` |
| pnpm | 9+（本机 9.15.0） | `pnpm -v` |
| 端口 | 1 个 HTTP 端口，`PORT` 注入，绑定 `0.0.0.0` | `apps/server/src/index.ts:704-705` |
| 磁盘 | 存档目录可写 | `LIFE_SIM_DATA_DIR` |
| Chrome / Chromium | **仅 UI e2e 需要**；API 冒烟不需要 | `CHROME_PATH` |
| 外部网络 | **不需要**（默认 Mock，零 LLM 调用） | 见 §5 |

✅ 代码经 GitHub 远程仓库 `git@github.com:Kazagask/ai-life-simulator.git` 同步（HTTPS 匿名可读）。云端直接 clone 即可，不依赖本机磁盘。
⚠️ **首次推送需要 GitHub 认证**：SSH 公钥未绑定时会报 `Permission denied (publickey)`；改用 HTTPS + PAT，或把本机 `~/.ssh/id_rsa.pub` 加入 GitHub SSH Keys。详见 §1。

## 1. 取回工程并起步

用户已建 GitHub 远程仓库，云端直接 clone（进入含 `pnpm-workspace.yaml` 的那一层）：

```bash
git clone https://github.com/Kazagask/ai-life-simulator.git
cd ai-life-simulator
pnpm install
pnpm build          # 必须：生成 apps/web/dist，否则 / 返回 503 web_dist_missing
pnpm start          # 默认 0.0.0.0:3000
```

**推送认证**：仓库 SSH 地址为 `git@github.com:Kazagask/ai-life-simulator.git`。本机 `~/.ssh/id_rsa.pub`
（`SHA256:DLryRDsmOs+u1FV0Vaa5BgNqLOnl0IkOrz97CYhwz1g`）在 2026-11-13 实测**未被 GitHub 接受**
（`Permission denied (publickey)`）。可用的两条路：
1. 把该公钥加到 GitHub → Settings → SSH and GPG keys（保留纯 SSH）；
2. 用 HTTPS + Personal Access Token。本机 `git config credential.helper = manager` 已存有 github.com 凭据，
   故本轮本地配置采用「`origin` fetch 走 SSH、`pushurl` 走 HTTPS」的混合形式；SSH key 绑定后可执行
   `git remote set-url --delete --push origin https://github.com/Kazagask/ai-life-simulator.git` 切回纯 SSH。

**不要**为了绕开认证使用 `--force` 推送，或把 `origin` 改指向另一个仓库。

`.gitignore` 已排除：`node_modules/`、`dist/`、`/data/`（含 57/61 会被拒载的旧存档）、
`.workbuddy/memory/`、`*.log`、`ck.txt`、`.wbapp_*.genie`、`.workbuddy/applications.yaml`。
仓库内**保留**：全部源码、`specs/`（含运行时模板 yaml）、`docs/`、`tasks/`、`AGENTS.md`、
`PROJECT.md`、`README.md`、`.workbuddy/ENGINEERING.md` 与项目技能。

若 workspace 链接失败，按 `README.md` 提示加 `--config.node-linker=hoisted`。

## 2. 环境变量

```bash
export PORT=3000
export LIFE_SIM_DATA_DIR=/path/to/persistent/worlds   # 可选，默认 <repo>/data/worlds
export LIFE_SIM_BASE_URL=http://127.0.0.1:3000         # 冒烟 / e2e 基址
# 以下四项默认全部不设置 —— 这就是零回归基线
# export LIFE_SIM_LLM_BASE_URL=...
# export LIFE_SIM_LLM_MODEL=...
# export LIFE_SIM_LLM_API_KEY=...
# export LIFE_SIM_WORKBUDDY_SESSION=...
# export LIFE_SIM_WORKBUDDY_CLOUD_URL=...
export CHROME_PATH=/usr/bin/chromium                   # 仅 UI e2e 需要
```

| 变量 | 缺省行为 |
|---|---|
| `LIFE_SIM_LLM_*` 三项 | 缺任一即整组不可用，`createLLMProvider` 落到 `mock` |
| `LIFE_SIM_WORKBUDDY_SESSION` | 未注入 ⇒ `LLMUnavailableError` ⇒ 编排层回退模板，**绝不假装成功** |
| `PORT` | 缺省 3000；改动后所有 e2e 基址必须同步 |
| `LIFE_SIM_DATA_DIR` | 缺省仓库根 `data/worlds/`（按模块位置解析，不依赖 cwd） |

## 3. 验收分层（从轻到重）

| 层 | 命令 | 期望 | 状态 |
|---|---|---|---|
| L0 类型 | `pnpm typecheck` | 0 错 | ✅ 已验证（2026-11-13） |
| L1 共享 schema | `pnpm --filter @life-sim/shared test` | 全绿 | ⚠️ 全量未出结论 |
| L2 内核全量 | `pnpm test` | 全绿 | ⚠️ 全量未出结论 |
| L2b 通关回归 | `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism src/v2/playthrough.test.ts` | 6 种子 × 2 开局自动通关 | ⚠️ 全量未出结论 |
| L3 服务端叙事冒烟 | `pnpm --filter @life-sim/server exec tsx smoke/narrative.smoke.ts` | 6 PASS + `SMOKE OK` | ✅ 已验证（上轮 R2.7） |
| L4 前端构建 | `pnpm --filter @life-sim/web build` | 通过 | ✅ 已验证（2026-11-13） |
| L5 可移植冒烟 | `node apps/server/smoke/cloud.smoke.mjs` | 全 PASS | 🆕 本轮新增，待云端复跑 |
| L6 竖屏 UI e2e | `data/_aishot/*.mjs` | 见 §6 限制 | ⚠️ 本机历史脚本，云端需先参数化 |

🔴 **诚实声明**：R2.7 按当时用户裁决只做冒烟级验证；本轮 Phase 4 全量回归因验收进程异常退出**未出结论**，`tasks/reports/R27-FULL-REGRESSION.md` 不存在。
**不得把 L1 / L2 / L2b / L6 写成已验证。** 云端第一次开发的首要动作就是把这几层跑完并留下证据。

## 4. 可移植冒烟脚本

```bash
# API 冒烟（零外部依赖，Node 22 内置 fetch）
LIFE_SIM_BASE_URL=http://127.0.0.1:3000 node apps/server/smoke/cloud.smoke.mjs

# 非默认端口
LIFE_SIM_BASE_URL=http://127.0.0.1:8080 node apps/server/smoke/cloud.smoke.mjs

# 附加快照 UI 检查（需 puppeteer-core + Chrome/Chromium）
CHROME_PATH=/usr/bin/chromium RUN_UI=1 node apps/server/smoke/cloud.smoke.mjs
```

脚本特性：每次**新建世界**、不复用旧存档、不写任何文件、不调用任何 LLM、不修改状态。
UI 部分是可选项：缺 `puppeteer-core` 或找不到 Chrome 时记 `SKIP`，不算失败。
其中「`GET /api/worlds/:id` 含 `eventFlavors` 键」用于确认服务跑的是 R2.7（含）之后的代码。

## 5. 默认零回归基线

无 `LIFE_SIM_LLM_*` 且无登录态 ⇒ `createLLMProvider` 选 `mock`；`generateNarrative` 见 `provider.id === "mock"` 直接返回 `{source:"template"}`、**根本不调用 `complete()`**。
启动日志只有一行 `llm_provider_ready {"provider":"mock"}`。
判定：推进回合后 `triggeredEvents[].narrative` 是模板原文，页面不出现「AI 叙事」标记。

若云端发现叙事变成 `llm` 或出现网络调用，先查是不是误注入了环境变量，**不要改代码去「修」**。

## 6. 已知坑（逐条实测，不是推测）

1. **开局 409**：开局有 12 个待决命数转盘事件，直接 `POST /turns` 返回 409 `pending_event_required`，这是 `advanceTurnV2` 护栏。须先 `POST /events/choose` 选完，再发 `{"action":{"type":"free","description":""},"mode":"single"}`。
2. **旧存档拒载**：启动日志 `worlds_loaded {"loaded":3,"skipped":57}`，原因为 `template_fingerprint_mismatch` / `schema_version_mismatch: 1`。这是 ADR-0007 既定策略，**不是故障**。测试一律新建世界。
3. **dist 未构建**：`apps/server/src/index.ts:673,691` 从 `apps/web/dist` 取静态文件，缺失返回 503 `web_dist_missing`。解压后第一件事就是 `pnpm build`。
4. **11 个历史 e2e 脚本硬编码**：`http://127.0.0.1:3000` 与 `C:/Program Files/Google/Chrome/Application/chrome.exe` 写死；`d3-reasoncode-blank.mjs` / `t3-npc-attrs.mjs` 还内嵌旧 worldId 与旧资源 hash。云端直接跑必然红，且不代表产品缺陷。
5. **模板指纹**：任一 `specs/data/templates/**/*.yaml` 改动都会改指纹 ⇒ 旧档全拒载。改前必须写进交付说明。
6. **隧道缓存**：本机既有 cloudflared 隧道缓存过旧 CSS hash，老浏览器可能把 SPA fallback 的 HTML 当 CSS 拿到（强刷可解）。云端环境不涉及。
7. **隐藏结局红线**：`narrativeConfig.masked` 的结局一律跳过 LLM adapter 注入与响应层装饰，不得泄漏 hidden 原文（ADR-0027 事后补记新增不变量）。

## 7. 云端不要做的事

- 不要接真实外部 LLM 端点做验证（`OPEN_QUESTIONS #49` 未决；本轮明确排除联网调用）。
- 不要为迁就环境改模板 yaml，也不要在内核加兜底（D-17 教训）；改 yaml 必须声明旧档拒载代价。
- 不要把任何 key / session 写进仓库；密钥仅经环境变量注入。
- 不要改 `WorldStateV2` / `schemaVersion` 去「兼容」旧存档——拒载是既定策略。
- 不要在未写 ADR 的情况下动契约面（T-2）；G1 / G2 已恢复，ADR-0027 的免流程是一次性裁决。

## 8. 与线上发布的关系

线上发布（`workbuddy_sites_deploy`）与云端开发测试是**两件事**：前者把当前源码构建后跑在发布沙箱、对外提供分享链接；后者是你在开发环境里改代码跑测试。
发布是**覆盖式更新**，本地改动不会自动同步；要更新线上须重新显式发布，且需当轮用户授权（「部署 / 发布」），授权不跨轮沿用。
已发布应用「咒术转盘人生」的 `applicationId` = `wbapp_6BjykHXBJu8kLx2VWyxeie`，云服务已 ACTIVE，重复激活不会二次计费。
