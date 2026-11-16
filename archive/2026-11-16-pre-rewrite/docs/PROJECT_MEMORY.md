# 项目记忆快照（可版本化）

> **这份文件是什么**：把「跨会话必须复用的项目事实」从本地 agent 记忆里搬进仓库，
> 让任何环境（本地 clone、云端、其他 Agent）拿到仓库就有同等上下文。
> **它不是什么**：不是规范。权威约束永远依次是 `AGENTS.md` → `specs/core/` → `docs/DECISIONS.md`；
> 与本文件冲突时以它们为准。本文件也不复制规范全文，只记「已经发生的事实 + 已经裁决的决定」。
>
> 建立：2026-11-13。来源：本地 `.workbuddy/memory/`（该目录被 `.gitignore` 排除，属本机私有记忆）。
> **维护方式**：会话结束若产生了新的跨会话事实，先更新本地记忆，再择要回写本文件的对应小节；
> 本文件与本地记忆不一致时，以**本文件**作为对外可引用的口径。

## 1. 项目定位

- 竖屏移动端人生模拟器（云端显示名「咒术转盘人生」），pnpm workspace + TypeScript strict，Node 22+ / pnpm 9.15.0。
- 三块边界：`packages/game-core`（确定性模拟内核）、`packages/shared`（schema 与共享类型）、
  `apps/server`（Fastify API / 编排 / 持久化 / LLM Provider）、`apps/web`（React + Vite 竖屏 PWA）。
- 权威规范 `AGENTS.md`；迭代入口面板 `PROJECT.md`；云端 runbook `docs/CLOUD_DEV.md`。

## 2. 硬约束速查（详见 `AGENTS.md`）

- 同初始状态 + 同输入 + 同 seed ⇒ 相同结果；`game-core` 不依赖 React / Fastify / DB / LLM SDK / 网络。
- AI 只做叙事与候选生成，**不得写入权威状态、不得决定评分**；LLM 输出必须结构校验并回退模板。
- LLM 注入只允许出现在**归档 / 读取 / 响应出口**，绝不进 turn 管线。
- `hidden` 信息不得进入玩家端 API 投影；`narrativeConfig.masked` 的结局一律跳过 LLM 注入与装饰。
- 改契约面（`packages/shared` schema / effect 类型 / 投影契约 / 存档结构）属 T-2，**必须先写 ADR**；
  仅改 `specs/data/templates/**/*.yaml` 属 T-1，免 ADR 但仍需提交信息写清玩法结构变更与存档代价。
- 改任何 yaml ⇒ 模板指纹变化 ⇒ 旧存档全部拒载（ADR-0007 既定策略，不是故障，必须写进交付说明）。
- 不确定的产品规则写 `docs/OPEN_QUESTIONS.md`，禁止自行伪造共识；小问题记 `docs/BACKLOG.md`。

## 3. 迭代状态（截至 2026-11-13）

已交付验收的主线（时间正序）：

R2.6 关系图谱 + 时间适配器（ADR-0013/0014）→ JJK「第二版」玩法重构（ADR-0016）→
遗留缺陷清理 10 条（ADR-0017 三原则）→ 按原作重做（ADR-0017b/0018）→ NPC 生命周期补强（ADR-0021）→
NPC 刷新（ADR-0022）→ 剧本重构 + 机制落地（ADR-0024）→ 关系缺陷修复（ADR-0022 D-1）→
敌人 NPC 关系投影泄露修复 + 槽模型转正（ADR-0026）→ **R2.7 AI 叙事层接入（ADR-0027）**。

- **R2.7（LLM 叙事层）已实现，功能与 ADR 收口于 `0f42bd0`**，报告 `tasks/reports/R27-COMPLETION.md`。
  - 架构：`LLMProvider` 三层路由（workbuddy-cloud 降级 / OpenAI 兼容 env / Mock），
    `generateNarrative` 回退编排 + 同步异步桥 + 响应层结局装饰 + 人生总结 LLM 来源 + 事件 flavor 异步非权威缓存。
  - 契约面零改动：`schemaVersion` 仍为 2、`WorldStateV2` 零改动、零 yaml 改动 ⇒ 指纹不变、旧档可直载、无新增运行时依赖。
  - 默认 Mock **短路 `template`、根本不调 `complete()`** ⇒ 零回归基线（启动日志只有 `llm_provider_ready {"provider":"mock"}`）。
  - 该轮按用户裁决**只做冒烟级验证**：typecheck 0 错 / 定向 12+5 例 / 服务端 6 项 / web build / 加载期 200。
    **全量 vitest、6 种子 playthrough、UI e2e、真实外部 LLM 联网当时明确未跑**（后续已由 CI 与云端补跑口径见 §5）。
- 槽模型：`#48`（pendingEvents 槽位守卫）已转正为 ADR-0026，撤销 ADR-0011 决策 5 的队列化表述与 R-EV-14 FIFO 解读。
- 云服务（ADR-0025）：前端已接，验收结论「退回，1 项 P1 必修」—— 仍是在飞项。

## 4. 待决与缺口

- **`OPEN_QUESTIONS #49`（未决）**：登录用户 → 服务端免密钥 LLM 的真实注入链路未解决
  （ADR-0025 服务端零凭据、登录态只在浏览器 SDK 且仅 streaming）。当前是 env 注入 session 的降级形态，
  未注入即 `LLMUnavailableError` 回退模板，绝不假装成功；不决策的后果即选项 C（云端免密钥生产不可用）。
- 主线缺口序列（`docs/BACKLOG.md §0`）：~~AI 叙事层~~ 已闭合 → NPC 自主行动（部分）→
  跨模板验证（DEFERRED，当前仅 `jjk-2006`）→ R3 时间穿越（ADR-0005 seam，DEFERRED）。
  R2.7 未覆盖的自由文本行动（#26）/ 多 Agent（#3）/ flavor 流式输出仍 DEFERRED。
- 便宜收口项：B-23 table-driven 反例、T1-09 缺失 curl 级错失/断链负向 e2e、
  战斗结束结算轮是否跑完整尾管线（待裁）、B-13 once+pool 章节软锁诊断。
- 协议变更类（需 ADR，延后）：B-19 玩家关系双真相、B-20 `playerTemplate.relations` 缺失、
  B-22 `characters[].visibility:hidden` 未参与上屏过滤、B-21 `infoVisibility` 只写不读。

## 5. 已裁决的产品决定（仍有效）

- 不引入六阶段 Lifecycle 状态机。
- 装备词条动态补正；HP 与死亡结局解耦。
- 条件化 AI 只读公有字段；事件无隐藏语义（#33）。
- V1 引擎与类型已下线，只保留 V2 共用的 `rng.ts`；**禁止再引用 `evaluateLife` / `advanceTurn` 等 V1 符号**。
- ADR-0027 的「免前置 ADR + 事后补记」是**一次性裁决，不延续到任何后续任务**；G1 / G2 门禁常态生效。

## 6. 运行与验证事实

- `pnpm dev` → server `0.0.0.0:3000` + vite dev `5173`。
  ⚠️ **3000 端口 serve 的是构建产物 `apps/web/dist`**：改前端要在 5173 看，或先 `pnpm --filter @life-sim/web build`。
- 数据目录：仓库根 `data/worlds/`，可用 `LIFE_SIM_DATA_DIR` 挂载；指纹不匹配拒载。
- 默认零回归基线：无 `LIFE_SIM_LLM_*` 且无登录态 ⇒ Mock，叙事逐字等同模板。
- 开局有 12 个待决命数转盘事件，直接 `POST /turns` 返回 409 `pending_event_required` 是**正常护栏**。
- 验收分层（命令与门禁一一对应，CI 见 `.github/workflows/ci.yml`）：

| 层 | 命令 | 判据 |
|---|---|---|
| L0 | `pnpm typecheck` | 0 错 |
| L1 | `pnpm --filter @life-sim/shared test` | 全绿（当前 67 例） |
| L2 | `pnpm test` | 全绿（当前 478 例 / 33 文件） |
| L2b | `… exec vitest run --no-file-parallelism src/v2/playthrough.test.ts` | 6 种子 × 2 开局自动通关 |
| L4 | `pnpm --filter @life-sim/web build` | 产出 `apps/web/dist` |
| L5 | `node apps/server/smoke/cloud.smoke.mjs` | 新建世界、零 LLM、全 PASS |
| L6 | 竖屏 UI e2e | 历史脚本硬编码本机路径，云端不可直接跑 |

> L0–L5 已纳入 GitHub Actions 门禁；`2026-11-13` 本地实测：typecheck 0 错、shared 67、game-core 478、web build 通过、L5 `SMOKE OK`。

## 7. 已知坑（实测，不是推测）

1. **旧存档拒载**：启动日志 `worlds_loaded {"loaded":n,"skipped":m}` 且原因为 `template_fingerprint_mismatch` /
   `schema_version_mismatch: 1` 属既定策略。**测试一律新建世界**，不复用旧档。
2. **dist 未构建**：`/` 返回 503 `web_dist_missing`。clone / 解压后第一件事是 `pnpm build`。
3. **历史 e2e 脚本硬编码** `http://127.0.0.1:3000` 与本机 Chrome 路径，跨环境跑必红，不代表产品缺陷。
4. **模板是运行时资产**：`specs/data/templates/**` 由服务端按路径加载，禁止移动 / 改名 / 当文档处理。
5. **Windows 沙箱 / 小栈环境**：`tsc` 在极小栈下会 `STATUS_STACK_OVERFLOW`（`exit -1073741571`），
   可用 `node --stack-size=8000 ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`；
   受限沙箱内 vitest worker 会 `ERR_IPC_CHANNEL_CLOSED`，属环境限制，换正常环境即可。
6. **不要为迁就环境改模板 yaml，也不要在内核加兜底**；需要兜底说明该改的是 schema，走 T-2 + ADR。

## 8. 协作方式（用户偏好）

- Spec Coding：`requirements → design → tasks`，先审查对齐再实施；新迭代建在 `specs/iterations/<YYYY-MM-DD>-<短标签>/`，
  收尾整包移入 `specs/archive/iterations/`。
- 一次只做一个明确任务，小步提交；提交信息写清「玩法结构变更」与存档代价。
- 团队型专家包 `life-sim-dev-team`（「人生模拟器研发团」）与项目技能 `/life-sim-iteration` 见
  `.workbuddy/experts/README.md` 与 `.workbuddy/skills/`。
