# CLOUD_TASKS · 云端项目任务清单（R2.7 收口 / 云端可跑性）

> 唯一产出文件：`tasks/CLOUD_TASKS.md`。由「人生模拟器研发团」需求策划师许清源于 Phase 1 生成。
> **只登记规划，不代表任何任务已完成**；不修改任何 `specs/**` / `docs/**` / `packages/**` / `apps/**` 源码，不执行 git add / commit。

## 0. 文档头

| 项 | 内容 |
|---|---|
| 用途 | 供 **WorkBuddy 云端项目内置任务管理系统导入**，并供 **Agent 消费**。主理人无法访问该云端项目内部（SPA 需登录、无对应 connector），且**不知道其内置任务管理系统的导入格式**，因此产物必须落在仓库内、随 git 同步，并同时给出**机器可读（YAML）**与**人可读（Markdown 表格）**两种形态。YAML 只采用最小通用字段集，不发明产品系统不存在的字段。 |
| 生成日期 | 2026-11-13 |
| 生成者 | 需求策划师 许清源（Phase 1 需求侧产出） |
| 工程 | `ai-life-simulator`；WorkBuddy 云端项目 `p_b65216f5322d464eb95088a64eaf38fa`；分支 `main`，HEAD `2a296d6`，162 commits |
| 代码通道 | `git@github.com:Kazagask/ai-life-simulator.git`（用户已建；HTTPS 匿名可读、当前空仓库；SSH publickey 认证待主理人解决，推送由主理人处理）。本机 `git remote -v` 当前为空。 |
| 线上应用 | 已绑定「咒术转盘人生」`wbapp_6BjykHXBJu8kLx2VWyxeie`（云服务 ACTIVE），分享链接 `https://cursed-wheel-life.app.workbuddy.host/?sharecode=AWEIS4D6KT`。线上发布与云端开发测试是两件事，本清单不含发布动作。 |
| 状态口径（需求） | `ACTIVE` / `DEFERRED` / `RETIRED`。本轮 9 条 ACTIVE 需求（`R-LLM-01..06`、`R-NAR-01..03`）**全部已实现、仅冒烟级验证、待全量回归**；DEFERRED 只登记不实现；RETIRED 只登记不实现。**编号不重排、原文不删。** |
| 状态口径（任务） | `todo` / `in_progress` / `done` / `blocked`。本清单 10 条任务一律为 `todo` 或 `blocked`，**无 `done`、无 `in_progress`**。`blocked` 表示「待用户裁决」或「须先 ADR」，解锁前不得派实现动作、不计入 DoD。 |
| 优先级 | `P0` 全量回归与云端取证（首要动作）；`P1` 云端 e2e 可跑性 / spec 事实一致性 / 待用户裁决；`P2` BACKLOG 收口与协议变更门禁。 |
| 规划声明 | **本清单是规划产物，不代表已完成。** R2.7 上轮按用户裁决仅冒烟级验证；本轮 Phase 4 全量回归由 QA 启动后进程在 6m37s 异常退出（框架管道断开），**未出结论**，`tasks/reports/R27-FULL-REGRESSION.md` 不存在 ⇒ 全量回归仍未出结论。**绝不把未跑项写成已验证。** |

### 越界提醒（只登记，不处置）

- DEFERRED 三项（`OPEN_QUESTIONS #26`、`#3`、事件 flavor 流式输出）**不派任务、不计入任何 DoD、不纳入实现或验收**，编号与原文一律保留（见 §4）。
- 历史 `R-TT-01..07`（DEFERRED，时间穿越）、`R-LC-01..06`（RETIRED）编号与原文保留，不在本清单范围。
- `CT-05` / `CT-09` / `CT-10` 为 `blocked`：分别待用户裁决 / 待裁定 / 须先 ADR，不得自行实现、不得伪造共识。
- 动 `packages/shared` / `packages/game-core` / `apps/**` 的**契约面（T-2）**必须先写 ADR 并经 G1/G2 评审。`ADR-0027` 的「免前置 ADR + 事后补记」是 2026-11-13 **一次性裁决，不延续**；G1/G2 已恢复。
- 用户 WIP：`specs/iterations/README.md`（M）、`specs/iterations/2026-11-13-ai-narrative/{README,design,requirements}.md`（未跟踪）由架构师并行处理，本清单不触碰（`CT-04` 只登记）。
- 用户已定规则不重新讨论：不引入六阶段 Lifecycle 状态机；ADR-0004 属本轮、ADR-0005 留给时间穿越；装备词条动态补正；HP 与死亡结局解耦；条件化 AI 只读公有字段。
- 已知云端坑（登记，不派实现）：`apps/web/dist` 需先 `pnpm build` 否则 503；`data/worlds` 57/61 旧档按指纹策略拒载属预期行为，测试须新建世界；开局 12 个待决事件使 `POST /turns` 返回 409 `pending_event_required`。

---

## 1. 机器可读区（YAML）

```yaml
project: "WorkBuddy 云端项目 p_b65216f5322d464eb95088a64eaf38fa / ai-life-simulator / R2.7 收口与云端可跑性"
repository: "git@github.com:Kazagask/ai-life-simulator.git"
generated: "2026-11-13"
tasks:
  - id: "CT-01"
    title: "R2.7 全量回归补齐并产出 R27-FULL-REGRESSION.md"
    status: "todo"
    priority: "P0"
    depends_on: []
    owner_role: "QA 验收"
    source: "tasks/reports/R27-COMPLETION.md §5 明确未执行清单; docs/CLOUD_DEV.md §3 L0/L1/L2/L2b/L3/L4; PROJECT.md §2 当前迭代表; docs/BACKLOG.md E-01"
    acceptance:
      - "`pnpm typecheck` 退出码 0 且输出 0 错（L0）"
      - "`pnpm --filter @life-sim/shared test` 全绿（L1 shared 全量）与 `pnpm test` 全绿（L2 game-core 全量）；若触发 BACKLOG E-01 并行收集挂死，改带 `--no-file-parallelism` 的等价 vitest 调用并在报告注明"
      - "`pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism src/v2/playthrough.test.ts` 6 种子 × 2 开局自动通关（L2b），day / 章节数 / 五维评价与 R27-COMPLETION.md 冒烟基线一致"
      - "`pnpm --filter @life-sim/server exec tsx smoke/narrative.smoke.ts` 输出 6 PASS + SMOKE OK（L3）；`pnpm --filter @life-sim/web build` 通过（L4）"
      - "`tasks/reports/R27-FULL-REGRESSION.md` 存在，逐条记录上述命令、退出码、实际输出与结论；未跑项不得写成 PASS"
    files:
      - "tasks/reports/R27-FULL-REGRESSION.md"
      - "tasks/reports/R27-COMPLETION.md"
    notes: "R2.7 上轮按当时用户裁决仅冒烟级验证（typecheck 0 错、game-core 定向 12 例、shared 定向 5 例、服务端 6 项冒烟、web build、加载期 200），明确未跑 pnpm test 全量 / shared 全量 / playthrough 6 种子 / UI e2e / 全流程测试 / 真实外部 LLM 联网调用。本轮 Phase 4 验收进程在 6m37s 后异常退出、未出结论，R27-FULL-REGRESSION.md 当前不存在，全量回归仍待重跑。真实外部 LLM 联网调用不在本任务范围（OPEN_QUESTIONS #49 未决）。"

  - id: "CT-02"
    title: "云端起步复跑 cloud.smoke.mjs 并留取证"
    status: "todo"
    priority: "P0"
    depends_on: []
    owner_role: "内核后端工程师"
    source: "docs/CLOUD_DEV.md §1 / §3 L5 / §4 / §6 已知坑 2、3; apps/server/smoke/cloud.smoke.mjs; PROJECT.md §8"
    acceptance:
      - "云端按 CLOUD_DEV.md §1 完成 `pnpm install` + `pnpm build` + `pnpm start`，`GET /` 返回 200 且 index.html 含 assets/ 引用，不是 503 web_dist_missing"
      - "`LIFE_SIM_BASE_URL=<云端基址> node apps/server/smoke/cloud.smoke.mjs` 输出 6 PASS + 1 SKIP + `SMOKE OK`，退出码 0"
      - "判据 ⑤ `GET /api/worlds/:id` 响应含 `eventFlavors` 键，确认服务跑的是 R2.7（含）之后的代码"
      - "取证写入 `tasks/reports/` 新建报告，含 BASE、逐项 PASS/SKIP 明细与环境（Node / pnpm 版本、PORT、LIFE_SIM_DATA_DIR）"
    files:
      - "apps/server/smoke/cloud.smoke.mjs"
      - "docs/CLOUD_DEV.md"
    notes: "本机已实跑 6 PASS + 1 SKIP、SMOKE OK，但那是本机证据；本任务要求的是云端环境复跑取证，属未完成。脚本每次新建世界、不写文件、不改状态、不调用 LLM；旧档按指纹策略拒载属预期行为；UI 段缺 Chrome / puppeteer-core 记 SKIP 不算失败。"

  - id: "CT-03"
    title: "参数化 data/_aishot/*.mjs 本机硬编码使 UI e2e 可在云端跑"
    status: "todo"
    priority: "P1"
    depends_on:
      - "CT-01"
      - "CT-02"
    owner_role: "内核后端工程师"
    source: "docs/CLOUD_DEV.md §3 L6 / §6 已知坑 4; docs/BACKLOG.md B-10; PROJECT.md §8; 11 个脚本清单经工作区核实"
    acceptance:
      - "11 个脚本（check-pass / check-refresh / check-stun / check-title / d3-reasoncode-blank / fresh-multi / npc-life-check / npc-panel-check / npc-status-check / shot / t3-npc-attrs）内不再出现字面量 `http://127.0.0.1:3000` 与 `C:/Program Files/Google/Chrome/Application/chrome.exe`；基址统一取 `LIFE_SIM_BASE_URL`，浏览器统一取 `CHROME_PATH`"
      - "`d3-reasoncode-blank.mjs` 与 `t3-npc-attrs.mjs` 内嵌的旧 worldId、旧资源 hash 改为运行时新建世界与现场读取，不复用旧档"
      - "`grep -rn '127.0.0.1:3000' data/_aishot/` 与 `grep -rn 'chrome.exe' data/_aishot/` 均无输出"
      - "云端以 `LIFE_SIM_BASE_URL=<云端基址> CHROME_PATH=<chromium 路径>` 至少跑通 1 个脚本，页面无 pageerror，取证写入报告"
    files:
      - "data/_aishot/*.mjs"
      - "docs/CLOUD_DEV.md"
    notes: "只做可移植性参数化，不改产品实现、不改模板 yaml。data/ 全目录被 gitignore（B-10），如需长期入库须另立迁移到 tests/e2e/ 的任务，本轮不扩范围。11 个脚本清单已逐一核实。"

  - id: "CT-04"
    title: "spec 事实一致性复核（架构师并行处理，本清单只登记）"
    status: "todo"
    priority: "P1"
    depends_on:
      - "CT-01"
    owner_role: "架构师"
    source: "主理人 Phase 1 派单（spec 适配由架构师并行处理）; PROJECT.md §3 迭代输入表; tasks/reports/R27-COMPLETION.md §9 工作树状态 / §10 次日复核建议"
    acceptance:
      - "`specs/iterations/README.md` 与 `specs/iterations/2026-11-13-ai-narrative/{README,design,requirements}.md` 中「G1 待评审 / 零代码改动 / 未接入 LLM」等实施前表述与 R2.7 实绩对齐"
      - "`design.md` 两处笔误（`apps/server/src/v2.ts` 实为 `src/index.ts`；`eventInstanceId` 实为确定性复合键）按 R27-COMPLETION.md §9 更正或明确登记"
      - "核对结论须与 CT-01 的 R27-FULL-REGRESSION.md 验证口径一致，不得把未跑项写成已验证"
      - "本清单只登记任务与依赖，不派需求策划师的实现动作；specs/** 的实际修改由架构师在并行工作流完成并遵守 AGENTS.md §0.1 与 G1/G2"
    files:
      - "specs/iterations/README.md"
      - "specs/iterations/2026-11-13-ai-narrative/README.md"
      - "specs/iterations/2026-11-13-ai-narrative/design.md"
      - "specs/iterations/2026-11-13-ai-narrative/requirements.md"
    notes: "用户 WIP：specs/iterations/README.md 为 M 状态，R2.7 三件套为未跟踪文件，tasks.md 已入库。与 CT-01 并行开展，口径依赖 CT-01 结论但不构成硬阻塞；需求策划师不触碰这些文件。"

  - id: "CT-05"
    title: "OPEN_QUESTIONS #49 登录用户到服务端免密钥 LLM 真实注入链路待用户裁决"
    status: "blocked"
    priority: "P1"
    depends_on: []
    owner_role: "用户"
    source: "docs/OPEN_QUESTIONS.md #49; tasks/reports/R27-COMPLETION.md §8.2; PROJECT.md §2 待裁决; ADR-0025 / ADR-0027 决策 2、6"
    acceptance:
      - "`docs/OPEN_QUESTIONS.md` #49 由用户在 A（服务端配置长期凭据）/ B（平台可校验短期会话令牌下发链路）/ C（保持现状）中选定并注明裁决时间与依据；未裁决即默认落 C"
      - "裁决前不得新增或修改 `apps/server/src/llm/workbuddyCloud.ts` 的凭据注入实现，不得在仓库写入任何 key / session"
      - "若选 A 或 B，须先定契约并产出 T-2 ADR、经 G2 评审通过后方可升级为实现任务；ADR-0027 事后补记不覆盖此项"
      - "裁决落文前状态保持 blocked，不计入任何 DoD"
    files:
      - "docs/OPEN_QUESTIONS.md"
      - "docs/DECISIONS.md"
    notes: "不决策后果即 C：登录用户仍只走 Mock / OpenAI 兼容路由，云端免密钥 LLM 在生产不可用。当前落地的是可运行降级形态（env 注入 LIFE_SIM_WORKBUDDY_SESSION + LIFE_SIM_WORKBUDDY_CLOUD_URL，SSE 聚合），未注入 session 即抛 LLMUnavailableError 回退模板，绝不假装成功。真实外部 LLM 联网调用本轮明确排除。"

  - id: "CT-06"
    title: "B-23 关系投影判据反例做成 table-driven"
    status: "todo"
    priority: "P2"
    depends_on:
      - "CT-01"
    owner_role: "QA 验收"
    source: "docs/BACKLOG.md B-23; tasks/reports/RELATION-PROJECTION-FIX-ACCEPTANCE.md §八 观察 2（O2）; ADR-0022 补记 D-1 决策 1"
    acceptance:
      - "`packages/game-core/src/v2/relation-projection.test.ts` 新增一个 table-driven 用例，enemy / inactive / player 各绑一条断言，每条注释点明各自区分的错法：enemy 防「不在投影后 NPC 集合内」、inactive 防「按 lifecycle.state 为 alive 的白名单过滤」、player 防「白名单式节点枚举丢掉玩家」"
      - "变异验证：把判据改回「不在上屏 NPC 集合内」后 enemy 两例真红且至少一条新 table-driven 断言真红；改回「按 lifecycle.state 白名单」后 inactive 断言真红"
      - "`pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism src/v2/relation-projection.test.ts` 全绿且 `pnpm typecheck` 0 错；30 种子无 hidden 关系泄漏的既有结论不变"
    files:
      - "packages/game-core/src/v2/relation-projection.test.ts"
    notes: "纯测试补强，不改投影实现、不动契约面，按 AGENTS.md §0.3 判据免 ADR。BACKLOG 原文标注「本轮不做，下一轮测试补强时一并处理」。现状：三条反例散落在 relation-projection.test.ts 与 v2.test.ts，QA 变异验证 M1 实测只有 enemy 端点两例真红。"

  - id: "CT-07"
    title: "T1-09 补齐 curl 级错失 / 断链不误判负向 e2e"
    status: "todo"
    priority: "P2"
    depends_on:
      - "CT-01"
      - "CT-02"
    owner_role: "QA 验收"
    source: "tasks/reports/R25-COMPLETION.md §7.1（T1-09 部分满足）; PROJECT.md §2 下一步; docs/CLOUD_DEV.md §6 已知坑 1"
    acceptance:
      - "以 curl 端到端举证 `miss_when` 与 `window_expired` 两类错失落日志：响应或服务端日志含 `reason=miss_when` / `reason=window_expired` 的错失事实"
      - "以 curl 端到端举证断链不误判的负向用例：链未断仍可连续推进，不因队列 / 结算竞争误判断链"
      - "新增专用测试模板或夹具构造 `missWhen` 与带 `window.end` 的事件；若改 `specs/data/templates/**/*.yaml`，交付说明须声明模板指纹变化致旧档全部拒载"
      - "证据写入 `tasks/reports/`（命令、HTTP 状态码、响应体关键字段），不得只引用单测结果"
    files:
      - "tasks/reports/"
      - "specs/data/templates/"
    notes: "R25 §7.1 原文：到点触发与链连续推进已有 HTTP e2e 举证；错失落日志与断链不误判负向用例仅由 scheduler.test.ts / r25-acceptance.test.ts 覆盖，未做 curl 级端到端，理由是 jjk-2006 模板未声明 missWhen 与带 window.end 的事件、上一轮未擅自扩展范围。开局 12 个待决转盘事件会使 POST /turns 返回 409 pending_event_required，须先 POST /events/choose 选完。"

  - id: "CT-08"
    title: "B-13 once 池事件待决期前提变假的可诊断事实"
    status: "todo"
    priority: "P2"
    depends_on:
      - "CT-01"
    owner_role: "内核后端工程师"
    source: "docs/BACKLOG.md B-13; events.yaml:1545/1909/2410/2650/2815/3154/3456; turn.ts 丢弃分支; PROJECT.md §2 下一步"
    acceptance:
      - "先产出 ADR 并经 G2 评审通过：明确「扩 MissReason」或「丢弃时退还 once」的取舍、对协议 / 存档 / 30 种子基线的影响；BACKLOG B-13 原文注明两种做法都要动协议，属 T-2"
      - "按 ADR 补一条可诊断事实：once 为 true 的池事件在待决期前提变假被丢弃时可被端到端观测，且 once 不再永久烧掉"
      - "`pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` 与 `pnpm typecheck` 均通过；30 种子回归 0 例章节软锁"
      - "若动 `specs/data/templates/**/*.yaml`，交付说明须声明模板指纹变化致旧档全部拒载"
    files:
      - "docs/DECISIONS.md"
      - "packages/game-core/src/v2/turn.ts"
      - "packages/shared/src/schema/"
    notes: "主理人归类为「P2 便宜收口项」，但 BACKLOG B-13 原文明确两种做法均为协议变更（T-2），故实施门禁仍是「须先 ADR」；本清单按主理人归类列 P2，同时如实登记该 ADR 前置，不得绕过 G1/G2。现状：7 个章节门全是 once+pool，30 种子 0 例、正常玩法不可达。"

  - id: "CT-09"
    title: "战斗结束结算轮是否跑完整尾管线（runTurnTail）待裁定"
    status: "blocked"
    priority: "P2"
    depends_on: []
    owner_role: "主理人"
    source: "tasks/reports/R25-COMPLETION.md §6.9; PROJECT.md §2 下一步; docs/OPEN_QUESTIONS.md #34（已关闭，轮语义口径来源）"
    acceptance:
      - "产出明确裁决：`battleActionV2` 战斗结束结算轮是否在 `turnIndex += 1` 之外跑 `runTurnTail()` 完整 NPC / pool 尾管线；裁决写入 `docs/DECISIONS.md` 或 `docs/OPEN_QUESTIONS.md` 并注明依据与时间"
      - "裁决须同步 `specs/data/TEMPLATE_PROTOCOL_V2.md` §9.6 / §22 的轮语义口径，避免实现与协议漂移"
      - "裁决前不得修改 `battleActionV2` 与 `runTurnTail` 的调用关系；状态保持 blocked、不计入 DoD"
      - "若裁决为「跑完整尾管线」，须补对应回归用例并说明对同 seed 序列 / RNG 基线的影响"
    files:
      - "docs/DECISIONS.md"
      - "docs/OPEN_QUESTIONS.md"
      - "specs/data/TEMPLATE_PROTOCOL_V2.md"
    notes: "R25 §6.9 如实登记：按 brief 只做 turnIndex += 1 加时间推进 drain，未跑完整尾管线，与「轮语义单一」在战斗结束时存在口径差异，留给 QA / 后续迭代裁定。本清单只登记待裁项，不自行拍板、不伪造共识。"

  - id: "CT-10"
    title: "协议变更类 B-19 / B-20 / B-21 / B-22 立项前须先 ADR"
    status: "blocked"
    priority: "P2"
    depends_on: []
    owner_role: "主理人"
    source: "docs/BACKLOG.md B-19 / B-20 / B-21 / B-22; AGENTS.md §0.3 T-2 判据; tasks/reports/R27-COMPLETION.md §0 流程口径（G1/G2 已恢复）"
    acceptance:
      - "B-19（玩家关系双真相）/ B-20（playerTemplate.relations 缺失）/ B-21（infoVisibility flag 只写不读）/ B-22（characters[].visibility hidden 未参与上屏过滤）逐条标注「须先 ADR」，BACKLOG 判定维持「延后 / 未裁决」"
      - "任一编号升级为实现任务前须产出对应 ADR 并经 G1/G2 评审通过；ADR-0027「免前置 ADR + 事后补记」为 2026-11-13 一次性裁决，不得援引为先例"
      - "未产出 ADR 前 `git status` 不得出现 `packages/shared/src/schema/**` / 投影契约 / 存档结构的对应改动"
      - "B-21 明确禁止拿 infoVisibility flag 当投影红线判据；B-22 撤下屏属展示口径变更，不得顺带修"
    files:
      - "docs/BACKLOG.md"
      - "docs/DECISIONS.md"
      - "docs/OPEN_QUESTIONS.md"
    notes: "纯登记门禁，不派实现。四条均属 T-2 契约面；若将来实施，一次只做一个 T-*（AGENTS.md G3），并在 BACKLOG 条目末尾追加去向标注。B-24（存档上云）与 S-01/S-02/S-05 不在本清单范围，不重复立案。"
```

---

## 2. 人可读区（任务表格，按优先级与依赖排序）

| ID | 标题 | 状态 | 优先级 | 依赖 | 验收要点 |
|---|---|---|---|---|---|
| CT-01 | R2.7 全量回归补齐并产出 `R27-FULL-REGRESSION.md` | todo | P0 | — | `pnpm typecheck` 0 错；`pnpm --filter @life-sim/shared test` 与 `pnpm test` 全绿；6 种子 × 2 开局 `playthrough.test.ts` 通关；服务端 6 PASS + `SMOKE OK`；web build 通过；报告逐条记录命令与输出、未跑项不得写 PASS。当前报告**不存在**。 |
| CT-02 | 云端起步复跑 `cloud.smoke.mjs` 并留取证 | todo | P0 | — | `pnpm build` 后 `GET /` 返回 200（非 503 `web_dist_missing`）；`LIFE_SIM_BASE_URL=<云端基址> node apps/server/smoke/cloud.smoke.mjs` 输出 6 PASS + 1 SKIP + `SMOKE OK`、退出码 0；`GET /api/worlds/:id` 含 `eventFlavors` 键；取证落入 `tasks/reports/`。本机已跑 ≠ 云端已跑。 |
| CT-03 | 参数化 `data/_aishot/*.mjs` 本机硬编码使 UI e2e 可在云端跑 | todo | P1 | CT-01, CT-02 | 11 个脚本不再含字面量 `http://127.0.0.1:3000` 与 `C:/Program Files/.../chrome.exe`，统一取 `LIFE_SIM_BASE_URL` / `CHROME_PATH`；`d3-reasoncode-blank.mjs`、`t3-npc-attrs.mjs` 的内嵌旧 worldId / hash 改运行时读取；两条 grep 无输出；云端至少跑通 1 个脚本且无 pageerror。 |
| CT-04 | spec 事实一致性复核（架构师并行，只登记） | todo | P1 | CT-01 | 三件套与 `specs/iterations/README.md` 的实施前表述对齐 R2.7 实绩；`design.md` 两处笔误（`src/v2.ts`、`eventInstanceId`）更正或登记；结论口径与 CT-01 报告一致；本清单不派需求侧实现动作、不碰用户 WIP。 |
| CT-05 | `OPEN_QUESTIONS #49` 免密钥 LLM 真实链路待用户裁决 | **blocked** | P1 | — | 用户在 A / B / C 中选定并落文（未裁决即默认 C）；裁决前不得改 `workbuddyCloud.ts` 凭据注入、不得写入 key / session；选 A/B 须先定契约 + T-2 ADR + G2 评审；不计入 DoD。 |
| CT-06 | B-23 关系投影判据反例做成 table-driven | todo | P2 | CT-01 | `relation-projection.test.ts` 新增 enemy / inactive / player 各一条断言并注明各自区分的错法；变异验证（改回「不在上屏集合内」/「lifecycle 白名单」）对应断言真红；定向 vitest 全绿、typecheck 0 错、30 种子无泄漏结论不变。 |
| CT-07 | T1-09 补齐 curl 级错失 / 断链不误判负向 e2e | todo | P2 | CT-01, CT-02 | curl 端到端举证 `reason=miss_when` / `reason=window_expired` 落日志与断链不误判负向用例；专用测试模板构造 `missWhen` 与 `window.end`（改 yaml 须声明旧档全拒载）；证据写入 `tasks/reports/`，不得只引用单测。 |
| CT-08 | B-13 `once` 池事件待决期前提变假的可诊断事实 | todo | P2 | CT-01 | 先产出 ADR + G2 评审（BACKLOG 原文：两种做法均动协议，T-2）；按 ADR 使丢弃可端到端观测且 once 不再永久烧掉；game-core 全量 + typecheck 通过、30 种子 0 例章节软锁；改 yaml 声明旧档拒载代价。 |
| CT-09 | 战斗结束结算轮是否跑完整尾管线待裁定 | **blocked** | P2 | — | 裁决 `battleActionV2` 是否跑 `runTurnTail()` 完整 NPC / pool 尾管线并落文（依据 + 时间）；同步 `TEMPLATE_PROTOCOL_V2.md §9.6 / §22` 口径；裁决前不得改调用关系、不计入 DoD。 |
| CT-10 | 协议变更类 B-19 / B-20 / B-21 / B-22 立项前须先 ADR | **blocked** | P2 | — | 四条逐条标注「须先 ADR」、BACKLOG 判定维持延后；升级实现前须 ADR + G1/G2 评审，不得援引 ADR-0027 一次性裁决；未产出 ADR 前 `git status` 无契约面改动；B-21 不得拿 flag 当投影红线、B-22 不得顺带修。 |

> 任务条数：**10**（P0 2 条 / P1 3 条 / P2 5 条）；`todo` 7 条 / `blocked` 3 条 / `done` 0 条 / `in_progress` 0 条。
> 每条的 `source` 均在 YAML 区逐条给出；本表只做验收要点摘要，完整可判定断言以 YAML `acceptance` 为准。

---

## 3. ACTIVE 需求状态表（R2.7：9 条）

**口径声明**：R2.7 的 9 条 ACTIVE 需求与 8 个 `T-*` 任务**全部已实现**（落地清单见 `tasks/reports/R27-COMPLETION.md §1 / §2`），并按当时用户裁决**仅执行冒烟级验证**。冒烟是「整体功能可用性」证据，**不等于逐条需求验收**；下表「已冒烟验证」列标注该需求被哪条冒烟 / 定向用例触及，未被独立触及者标「仅整体冒烟」。**9 条全部「待全量回归 = 是」**，统一对应 `CT-01`；在 `tasks/reports/R27-FULL-REGRESSION.md` 产出前一律不得标记 `done`。

| R-ID | EARS 类（摘要） | 已实现 | 已冒烟验证 | 待全量回归 | 追溯（ADR-0027 / R27-COMPLETION.md / T-*） |
|---|---|---|---|---|---|
| `R-LLM-01` | Ubiquitous：`The system shall` 定义供应商无关 `LLMProvider` 接口 | 是 | 仅整体冒烟 + 定向 `narrative-llm.test.ts` 12 例 + `pnpm typecheck` 0 错（无独立冒烟项） | **是 → CT-01** | ADR-0027 决策 1；`R27-COMPLETION.md §2.1 / §3.2 / §5`；`T-P1` |
| `R-LLM-02` | Event-driven：`When` 需要生成叙事 → 三层凭证路由 | 是 | 冒烟 ①（三层路由 / `API_KEY` 缺失自动 Mock 不抛）；QA 附加裁定「仓库密钥零字面量」 | **是 → CT-01** | ADR-0027 决策 2/6、ADR-0025；`R27-COMPLETION.md §2.1 / §5`；`T-P2`（云端链路见 `#49` / `CT-05`） |
| `R-LLM-03` | Ubiquitous：LLM 仅填展示字段，排除在回放契约外 | 是 | 冒烟 ④（注入前后 `dimensions`/`evidenceIds`/`overall` 逐字段相等）+ ⑥（缓存不进状态、两次序列化字节一致） | **是 → CT-01** | ADR-0027 决策 3；`R27-COMPLETION.md §2.1 / §5 / §6`；`T-P1` |
| `R-LLM-04` | Unwanted：非法 schema / 虚构证据 / 超时 → 回退且可诊断 | 是 | 冒烟 ②（三类反例回退且 `diagnostic` 区分原因） | **是 → CT-01** | ADR-0027 决策 4；`R27-COMPLETION.md §2.1 / §5`；`T-P3` |
| `R-LLM-05` | Event-driven：事件 flavor 后台生成、不阻塞回合 | 是 | 冒烟 ⑥（flavorCache 确定性键 + 缓存不进状态）+ 定向 12 例 | **是 → CT-01** | ADR-0027 决策 5；`R27-COMPLETION.md §2.1 / §5 / §6`；`T-P4` |
| `R-LLM-06` | Event-driven + Unwanted：仅 `LIFE_SIM_LLM_*` env 注入，缺失即回退 Mock | 是 | 冒烟 ①；QA 附加裁定「仓库密钥零字面量、零回归」；`ef28d26` 清扫描误报 | **是 → CT-01** | ADR-0027 决策 2/6、`OPEN_QUESTIONS #5`；`R27-COMPLETION.md §2.1 / §5`；`T-P2` |
| `R-NAR-01` | Event-driven：provider 可用且结局结算 → `narrativeSource` 取 llm | 是 | 冒烟 ③（合法候选 ⇒ llm；mock ⇒ template 且不调 `complete`）+ ⑤（hidden 结局原样返回） | **是 → CT-01** | ADR-0027、`R-EN-06`；`R27-COMPLETION.md §2.1 / §5`；`T-P3` / `T-S1` |
| `R-NAR-02` | Event-driven：人生总结仅替换 `summary` / `summarySource` | 是 | 冒烟 ④（注入 LLM 前后维度 / 证据 / overall 逐字段相等） | **是 → CT-01** | ADR-0027、`R-EV-05`；`R27-COMPLETION.md §2.1 / §5`；`T-S2` |
| `R-NAR-03` | Event-driven：事件 flavor 异步接入 + 非权威缓存 + 投影优先取缓存 | 是 | 冒烟 ⑥ + 定向 `shared/event-flavor.test.ts` 5 例；`GET /api/worlds/:id` 含 `eventFlavors`（云端判据见 `CT-02`） | **是 → CT-01** | ADR-0027 决策 5；`R27-COMPLETION.md §2.1 / §5 / §6`；`T-P4` / `T-S3` / `T-S4`（已收窄为冒烟级） |

### 追溯缺口（登记，不代为补写）

| 缺口 | 影响 | 最小补充建议 |
|---|---|---|
| `tasks/reports/R27-FULL-REGRESSION.md` 不存在 | 9 条 ACTIVE 需求与 8 个 `T-*` 的**全量回归证据链断裂**，无法宣告 R2.7 按标准流程关闭 | 由 `CT-01` 产出，逐条记录命令 / 退出码 / 输出；未跑项明确标注，不得写成 PASS |
| `T-S4` 本轮收窄为冒烟级（编号与原文保留） | `pnpm test` / shared 全量 / `playthrough.test.ts` 6 种子 / UI e2e 未跑 | 由 `CT-01`（全量回归）与 `CT-03`（云端 UI e2e 可跑）分别补齐证据，不改 `T-S4` 章节原文 |
| `narrativeSource` / `summarySource` 端到端展示断言缺失 | 冒烟级未覆盖前端展示断言 | `R27-COMPLETION.md §8.3` 已登记为下轮补强；本清单不新增需求编号，随 `CT-01` 全量回归一并观察 |
| `design.md` 两处笔误未在规格侧更正 | 规格与代码事实不一致 | 由 `CT-04`（架构师）处理；本清单不碰 `specs/**` |
| Phase 4 QA 进程异常退出（6m37s） | 全量回归「未出结论」而非「失败」 | 报告中须区分「未出结论」与「测试失败」，不得把异常退出写成回归红项 |

---

## 4. DEFERRED 登记表（只登记，不派任务、不计入 DoD）

| 编号 | 原文（保留，不改写） | 来源 | 状态 | 处置 |
|---|---|---|---|---|
| `#26` | 「自由文本行动是否纳入 AI 解析及其规格归属（未决）：… 当前自由输入只写进历史摘要 … 需确定是否补编号需求、候选行动白名单与校验责任归属（关联 #3、#5）」 | `docs/OPEN_QUESTIONS.md #26`；`R27-COMPLETION.md §8.1` | **DEFERRED** | 只登记；编号与原文保留；**不派 `T-*`、不实现、不纳入验收、不计入 DoD** |
| `#3` | 「是否需要真正的多 Agent 运行时；P0 不要求。」 | `docs/OPEN_QUESTIONS.md #3`；`R27-COMPLETION.md §8.1` | **DEFERRED** | 同上；`requirements.md` 追溯矩阵已标注「多 Agent（#3，DEFERRED）」 |
| 事件 flavor 流式输出 | `R27-COMPLETION.md §8.1` 表格两列原文：「自由文本行动解析（`OPEN_QUESTIONS #26`）/ 多 Agent 运行时（#3）/ 事件 flavor 流式输出」；「明确 DEFERRED / 后续增强，只登记不实现」 | `tasks/reports/R27-COMPLETION.md §8.1 本轮明确不做` | **DEFERRED** | **无独立编号**，不新造编号；只登记，不派任务、不计入 DoD |

> 历史编号同样保留：`R-TT-01..07`（时间穿越，DEFERRED，ADR-0005 留 seam）、`R-LC-01..06`（RETIRED）。二者不在本清单范围，**编号不重排、原文不删、不派任务**。
> 用户已定规则（装备词条动态补正、HP 与死亡结局解耦、条件化 AI 只读公有字段、ADR-0004 属本轮 / ADR-0005 留给时间穿越、不引入六阶段 Lifecycle 状态机）**不重新讨论**。

### 待决项（已决 / 待决 对账）

| 编号 | 问题 | 已决 / 待决 | 依据文件 |
|---|---|---|---|
| `#49` | 登录用户 → 服务端免密钥 LLM 真实注入链路（A / B / C） | **待用户拍板**（不决策即 C） | `docs/OPEN_QUESTIONS.md #49`；`R27-COMPLETION.md §8.2`；`CT-05` |
| R25 §6.9 | 战斗结束结算轮是否跑完整 `runTurnTail()` 尾管线 | **待裁定** | `tasks/reports/R25-COMPLETION.md §6.9`；`CT-09` |
| B-13 | `once` 池事件静默丢弃却烧 once 的可诊断事实（两种做法均动协议） | **待 ADR + 用户/主理人立项** | `docs/BACKLOG.md B-13`；`CT-08` |
| B-19 / B-20 / B-21 / B-22 | 协议变更类（关系双真相 / 玩家 relations / infoVisibility flag / hidden 上屏过滤） | **待 ADR（G1/G2）**，BACKLOG 判定「延后」 | `docs/BACKLOG.md`；`CT-10` |
| ADR-0027 流程口径 | 免前置 ADR + 事后补记是否延续 | **已决：不延续**，G1/G2 已恢复 | `R27-COMPLETION.md §0 / §2.2`；`AGENTS.md §0.3` |
| R2.7 验证范围 | 仅冒烟级，明确不进行全流程测试 | **已决（当时一次性裁决）** | `R27-COMPLETION.md §1 用户裁决原文要点 / §5` |

---

## 5. 依赖图（文字）

```
CT-01 (P0 R2.7 全量回归 + R27-FULL-REGRESSION.md)
  ├─→ CT-03 (P1 参数化 data/_aishot/*.mjs，使云端 UI e2e 可跑)
  ├─→ CT-04 (P1 spec 事实一致性；口径依赖，与 CT-01 并行开展)
  ├─→ CT-06 (P2 B-23 table-driven 反例)
  ├─→ CT-07 (P2 T1-09 curl 级负向 e2e)
  └─→ CT-08 (P2 B-13 可诊断事实，须先 ADR)

CT-02 (P0 云端起步 + cloud.smoke.mjs 复跑取证)
  ├─→ CT-03 (与 CT-01 并列前置)
  └─→ CT-07 (提供云端可访问服务作为环境前提)

CT-05 (P1 #49 待用户裁决)          ┐
CT-09 (P2 战斗结束尾管线待裁定)     ├─ blocked，无前置依赖；分别待用户裁决 / 待裁定 / 先 ADR 解锁
CT-10 (P2 协议变更类须先 ADR)      ┘
```

- 主链（主理人示例口径）：**P0 全量回归（CT-01）→ P1 云端 e2e 参数化（CT-03）**；`CT-02` 与 `CT-01` 并列，共同为 `CT-03` 前置。
- `CT-01` 是多数 P2 收口项的证据基线：B-23 / T1-09 / B-13 的回归断言都以其全量结论为前提。
- 三条 `blocked` 不与 P0/P1 形成执行依赖；解锁条件分别是「用户裁决落文」「裁定落文」「ADR + G2 评审通过」，解锁前不得进入实现或验收。
- 全部任务最终状态仍为 `todo` / `blocked`；**本清单不出任何测试结论、不宣告 R2.7 关闭**（是否补做正式 G1 评审 / 关闭迭代另待主理人裁决）。
