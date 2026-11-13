# R2.8 收口报告 · 登录页用户 key + 平台免密路由 + 前端收敛（ADR-0028）

> 对应 ADR：`docs/DECISIONS.md` ADR-0028（G2 评审通过 · 2026-11-13）。
> 需求来源：`tasks/R28-REQUIREMENTS.md`（5 条：R-LLM-07/08 + FE-01/02 ACTIVE，R-LLM-09 DEFERRED）。
> 验证口径：**冒烟级**（与 R2.7 同，用户裁决仅冒烟验证）。

## 1. 交付物（commits）

| commit | 内容 | 归属 |
|---|---|---|
| `8698a74` | ADR-0028 + R28 需求草案（Phase 1 文档，G2 批准进入实施） | docs |
| `f107ceb` | server R-LLM-07/08：`POST /api/llm-credentials`、内存凭证 `userCredentials.ts`、`resolveProviderForRequest`、Fastify `preHandler` 注入 `request.llmProvider`、所有叙事调用点传 `request.llmProvider` | server |
| `38b6ee8` | docs 同步：AGENTS §5 第 102 行加例外、OPEN_QUESTIONS #49 改「部分落地 + 平台卡点保留」、PROJECT 增 R2.8 状态 | docs |
| `5bbbcb3` | web FE-01（登录页可折叠 key 配置）+ FE-02（NPC 记录归并世界视图分 tab） | web |

## 2. 改动面（契约影响）

- **未改** `packages/shared` / `WorldStateV2` / 投影契约 / `schemaVersion`：旧档可直载、零 `*.yaml` 改动 ⇒ 模板指纹不变。
- FE-02 纯前端布局重组，未向 `V2Snapshot` / archive 新增投影字段（免 ADR、非 T-2）。
- 新增服务端运营接口 `POST /api/llm-credentials`（非 shared schema，由 ADR-0028 覆盖为新增运营接口，非 T-2）。

## 3. 验证（冒烟级）

| 项 | 结果 |
|---|---|
| `pnpm typecheck`（root `tsc --noEmit`） | 0 错（EXIT 0） |
| 服务端路由单元核对（临时脚本 8 项） | 全过：三层路由、Zod 校验、session 注入、provider 优先级 |
| 服务端 curl 冒烟 | 合法凭证→201；缺/空 apiKey→400；非法 baseUrl→400；header 透传→200 |
| `apps/web` vite build | 34 模块、built in ~1.3s，EXIT 0 |
| 密钥扫描护栏（沿用 `boundary.test.ts` 类） | 仓库无 key 字面量；`userCredentials.ts` 不落盘/不进日志 |

## 4. 未验证（诚实登记，与 R2.7 同口径）

- 全量 `pnpm test`（shared 67 / game-core 478）未重跑；6 种子 playthrough 未跑。
- UI e2e（前端 FE-01/FE-02 实际交互、真实 header 透传链路）未跑。
- 真实外部 LLM 联网调用未跑（无凭据；且属 #49 待决）。
- 并发多用户内存凭证互不串号、进程重启清空等边界未在集成层实测（代码层面保证，待云端 CT-03 类参数化脚本或后续回归覆盖）。

## 5. 残留风险 / 开放项

- **#49 平台卡点**：`R-LLM-09` DEFERRED —— 服务端真实免密钥 LLM 链路（cloud.llm server identity 注入）待平台确认；当前 server 侧 platform-keyless 仍为 `WorkBuddyCloudProvider` env 注入 session 降级形态，未注入即回退 mock，绝不假装成功。
- user-key 路径已绕开 #49 卡点；未注入 user-key 且无平台 session 时叙事恒 mock（与 #49 候选 C 一致）。
- 凭证安全风险用户自担：服务端仅做基础校验，不校验 key 是否足额/本人；key 不落盘、不进日志、不进玩家端投影（AGENTS §5 第 101 行保留）。

## 6. 流程口径

- ADR-0028 经 G2 评审通过（用户于 R2.7 收口后给出三条一次性裁决，主理人应用默认后推进），未沿用 R2.7「免前置 ADR + 事后补记」例外。
- 本轮为 R2.7 同一产品面的后续小轮，未宣告按标准流程关闭；是否补做正式 G1 评审 / 关闭迭代待用户裁决。
- 待办：① 推送 SSH（`origin/main` 当前领先 5 commit）；② #49 待用户裁决 A/B/C；③ 全量回归 / UI e2e 仍由 CT-01/CT-02/CT-03 等补齐。
