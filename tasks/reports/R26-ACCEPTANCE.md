# R2.6 验收报告 · 关系图谱 + 时间适配器落地

> 验收人：`life-sim-qa`（严过关）｜日期：2026-11-12｜G5：本报告只做测量与结论，**未修改任何产品代码**（主仓唯一新增即本文件；未对工作区做 `checkout`/`stash`/`add`/`commit`/`rm`）。
> 规格：`specs/iteration-2026-11-12-r26/`（README / requirements / design / tasks）＋ ADR-0013（WS-A）/ ADR-0014（WS-B）/ ADR-0015（模板收敛）。
>
> **本报告分两块**：
> **A. R2.6 验收结论（基线 = 干净 HEAD `fc6694f`）—— 唯一判定依据**（§0–§7）
> **B. 工作区偏离说明（仅供参考，未评审、不属 R2.6，不判 FAIL）**（§8）
> **附**：复现指引（§9）

---

# A. R2.6 验收结论（基线 `fc6694f`）

## 0. 结论速览

| # | 认证口径（均在 `fc6694f` 上） | 结果 |
|---|---|---|
| 1 | `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | ✅ **332 passed / 332**（22 文件全绿） |
| 2 | `pnpm --filter @life-sim/shared test` | ✅ **50 passed / 50**（3 文件全绿） |
| 3 | `pnpm typecheck` | ✅ **0 错**（`tsc --noEmit` exit 0） |
| 4 | `pnpm build` | ✅ 成功（`vite build`，29 modules，`index-*.js 260.84 kB`，804 ms） |
| 5 | T-A1..A5 / T-B1..B6 DoD 逐条核对 | ⚠️ **T-A1/A4/A5 + T-B1..B6 共 9 个任务 PASS；T-A2、T-A3 各有 1 条 DoD 失败**（`ageAt` 未实现） |

**A 区裁决：退回（有条件）。**

- R2.6 的**功能与测试基线成立**：五条口径 4 条全 PASS，UI 端到端 44 轮实跑全通，安全边界（hidden 零泄露、V1 符号清零、确定性 IDENTICAL、boundary⑤）全 PASS。
- 但存在 **1 项实质规格偏离**：`CalendarAdapter.ageAt(minute)`（R-CAL-01/03、design §4.1/§5/§6、T-A2/T-A3 四处点名）**在代码中不存在**，「生日未到不加岁」不成立。这是 T-A2、T-A3 的 DoD 条目失败项，**不是文档瑕疵**。
- 另有 **2 项测试缺口**（`custom` 无 `months` 拒载、关系端点校验：实现具备且我手工实测通过，但仓内无用例）+ 5 项 P3 规范/展示偏差。

> 放行条件见 §7。若主理人裁决将 `ageAt` 口径正式改写为「`elapsedYears` 合一」并在 ADR / OPEN_QUESTIONS 登记，则 A 区可转 **可验收**。此项须由主理人裁决，QA 不代决。

---

## 1. 环境与基线

- 仓库：`D:\code\ai-life-simulator`｜Node `v22.22.2`｜pnpm `9.15.0`｜vitest `3.2.7`｜Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`
- 基线检出：`git worktree add D:/code/_r26-head fc6694f`（**detached HEAD，工作区干净**；`node_modules` 以 Windows Junction 复用主仓依赖，未重装）
- 沙箱注意（已验证）：game-core 测试**必须**带 `--no-file-parallelism`，否则并行 SIGTERM。
- 独立数据目录隔离：`LIFE_SIM_DATA_DIR=D:\code\_r26-e2e\data` / `data2`（不与主仓 `data/worlds` 混用）

```
fc6694f docs(R2.6): 面板回填 WS-A/WS-B 全量完成
cc58699 feat(R2.6-T-B6): jjk-2006 声明初始关系边 + 断代亲属，WS-B 收口
ccf57b6 feat(R2.6-T-B5): NPC 投影关系边 + 条件 DSL 关系边形态（R-OP-05 落地）
c938f2a feat(R2.6-T-B4): 效果 DSL 关系边操作 —— adjustRelation 双形态 + addRelationEdge + 冻结
0358cc9 refactor(template)!: ADR-0015 jjk-2006 内容收敛 —— 删主线链，转盘成为开局核心
ec4eef6 feat(R2.6-T-B3): relationship.js 适配 —— 多跳中文称谓（引依赖，ADR-0014 已裁决）
8ee3998 feat(R2.6-T-B2): 关系图内核 relations.ts —— 建图/BFS 最短路径/环检测/断代/冻结
eb2946d feat(R2.6-T-B1): RelationEdge 关系边 schema + 状态层 relations（ADR-0014）
24f9b39 feat(R2.6-T-A5): jjk-2006 接入 gregorian 历法 + advanceTo/advanceBy 经适配器换算
f95f5ce feat(R2.6-WS-A): 时间适配器落地 gregorian/custom 历法 + 字符串 TimeSpec 字面量 (T-A1..A5)
```

**复跑记录（同一基线两次独立执行，结果一致）**

| 口径 | 第 1 次（06:0x） | 第 2 次（06:07） |
|---|---|---|
| game-core | 332 passed / 22 files | **332 passed / 22 files** |
| shared | 50 passed / 3 files | **50 passed / 3 files** |
| typecheck | 0 错 | **0 错**（exit 0） |
| build | 成功（797 ms） | **成功（804 ms）** |

---

## 2. DoD 逐条核验 · WS-A 时间适配器

| 任务 | DoD 条目 | 结果 | 证据 |
|---|---|---|---|
| **T-A1** | `z.infer` 类型正确 | PASS | `world.ts:98-120` `CalendarConfigSchema` + `.superRefine`；typecheck 0 错 |
| | 缺省 `approx`（零迁移） | PASS | `calendar: CalendarConfigSchema.optional()`（`world.ts:140`）；`time.test.ts:184-193`：approx 下 `toMinutes === amountToMinutes`、`parseTimeSpec("3d",0)=4320` |
| | `custom` 无 `months` 加载期报错 | PASS（实现）＋**测试缺口 D-03** | 实测：把 jjk-2006 副本 `preset` 改为 `custom` 后起 server → `ZodError { path: ['time','calendar','months'], message: 'custom 历法必须声明 months' }`，进程 exit 1。**仓内无该用例**（`grep "必须声明 months"` 于 `*.test.ts` 零命中），而 design §6「无效」类明确要求 |
| | `pnpm typecheck` 0 错 | PASS | §0 |
| **T-A2** | 2006 起算闰年/月长正确 | PASS | `time.test.ts:194-202`：`format(0)="2000年1月1日 00:00"`；`format((31+28)*1440)="2000年2月29日 00:00"`（闰年）；平年落 2/28 |
| | **「生日未到不加岁」** | ❌ **FAIL（未实现）** | 全仓 `grep -rn "ageAt"` **零命中**。适配器接口（`time.ts:54`）只有 `elapsedYears`，gregorian 实现（`:291`）按**日历年边界**跳岁 —— `time.test.ts:197` 即断言 `elapsedYears(366*1440)===1`（2001-01-01 跳岁，而非生日）。状态层无生日字段；`player.age = playerAgeAtStart + elapsedYears(...)`（`engine.ts:434/442`、`turn.ts:750/833`） |
| | gregorian 正常/边界用例通过 | PASS | `time.test.ts` 17 例全绿 |
| **T-A3** | 年号渲染（`era.name` + 年内偏移） | PASS | `time.test.ts:227-266`：`"咒术纪元 1年睦月1日 00:00"`、`"咒术纪元 2年睦月1日 00:00"`（一年 = 31+30 = 61 天）；负锚点 `epochStartMinute:-61*1440` 场景 |
| | 自定义月长累加无误 | PASS | 同上 |
| | **`toMinutes`/`ageAt` 按自定义月长** | ⚠️ **部分 FAIL** | `toMinutes` 达标（`time.test.ts:203-212`）；`ageAt` 不存在（同 T-A2） |
| | 异常配置加载期拒载 | PASS | 同 T-A1 实测（custom 无 months → 启动 fail-fast） |
| **T-A4** | `parseTimeSpec("3d",0)===4320` | PASS | `time.test.ts:186` 精确断言 |
| | `parseTimeSpec("2h30m",0)===150` | PASS（偏移等价断言） | `time.test.ts:185` 断言 `parseTimeSpec("2h30m",100)===250`（= 100+150），与 `===150` 语义等价 |
| | 非法字面量抛可诊断错 | PASS | approx 下 `"2006-12-24"` 抛 `/approx/`；gregorian 下 `"2001-02-29"` 抛 `/越界/` |
| | `approx` 下与 R2.5 回归一致 | PASS | `time.test.ts:184-193` + 全量 332 绿 |
| **T-A5** | 模板声明 gregorian + startYear 2006 | PASS | `world.yaml`：`time.calendar.preset: gregorian`、`meta.startYear: 2006` |
| | `pnpm dev` 下开局时间走真实公历 | PASS（UI 实测） | `2006年1月1日 00:00`；连续 3 次「修炼」→ `04:00` → `08:00` → `12:00` |
| | 全量测试绿 + typecheck 0 错 | PASS | §0 |
| | 前端「零改动」消费 `format` | PASS | 前端直接渲染服务端投影的 `snapshot.formattedTime`（`main.tsx:332`），无公历硬编码 |

## 3. DoD 逐条核验 · WS-B 关系图谱

| 任务 | DoD 条目 | 结果 | 证据 |
|---|---|---|---|
| **T-B1** | schema 校验通过 | PASS | `shared/schema/relation.ts`：`KinshipKind`（含 `relative`）/`SocialKind`/`RelationVisibility`/`RelationEdge`(`value/gap/frozen`)/`RelationDecl`；`WorldStateV2.relations` |
| | `pnpm typecheck` 0 错 | PASS | §0 |
| | 旧模板无 `relations` 不报错 | PASS | `relations` optional；`relation-projection.test.ts:80-84`「无关系边时投影为空数组（不报错、不缺字段）」 |
| | （requirements）端点须为已声明角色或 `"player"` | PASS（实现）＋**测试缺口 D-04** | `world.ts:283-287`；实测注入 `to: npc-ghost` → 启动即 `ZodError { path: ['characters',0,'relations',4,'to'], message: '未知关系目标：npc-ghost' }`，exit 1。仓内无用例 |
| **T-B2** | 最短路径/环检测/断代用例通过 | PASS | `relations.test.ts` 24 例：BFS 直达+多跳（`:91`）、等长取字典序最小（`:107`）、`maxHops`（`:144`）、环检测只报亲属环（`:151`/`:164`）、`ancestorGaps`（`:136`）、`freezeOnDeath` 保留可遍历（`:178`） |
| | 纯函数无副作用 | PASS | `relations.test.ts:57`「addEdge 不修改原数组（纯函数）」 |
| | `pnpm` 测试绿 | PASS | §0 |
| **T-B3** | 已知路径得确定性称谓 | PASS | `relations.test.ts:235`「单跳与多跳均得确定性中文称谓」 |
| | 罕见路径回退粗称谓（不抛不静默） | PASS | `:271` 断代回退粗称谓、`:281` 库无解回退粗称谓不抛错 |
| | 确定性（同输入同输出） | PASS | `:246` 多解取字典序最小并列出全部候选 |
| **T-B4** | 事件效果可建/改/冻结关系边 | PASS | `relation-effects.test.ts:110-175`：`addRelationEdge` 建边 / 重复合并 / `frozen` 单向棘轮；`freezeRelationsOnDeath` 冻结且不再被 `adjustRelation` 改动 |
| | `unknown` 边不被误建为 known | PASS | `:71`「关系边不存在时建边，visibility 缺省 unknown（不误建为 known）」 |
| | `pnpm` 测试绿 | PASS | 9 例全绿；旧形态 `npcId` 兼容（`:51`）；矛盾配置抛可诊断错（`:99`） |
| **T-B5** | 未声明关系默认 `unknown` | PASS | `relation-projection.test.ts:38-50`；`opening.test.ts` T3-03 用例 |
| | API 返回 `relations` 不含 `unknown`/`hidden` | PASS | 真实 API 两次复跑：`REL_VISIBILITIES: ["known"]`、`EDGE_COUNT: 20`、`REL_LEAK: NONE` |
| | `hidden` 来源不泄露 | PASS（独立实验，§5.2） | 注入 `gojo→riko (father, hidden)` 后投影与干净模板**逐字节相同**，快照无 `"hidden"` 字面，称谓集合不变 |
| | 称谓只在可见子图推导 | PASS | 同上 + `:52-65` `secret-dad` 用例 |
| **T-B6** | 初始化后关系图可达 | PASS | `v2.test.ts`「characters[].relations 在新建世界时落为实例边（source=template、known）」；API 投影 20 条双向边、单 NPC 最多 8 条 |
| | 端到端查询得确定性称谓 | PASS | `v2.test.ts`「断代亲属（gap）端到端查询得确定性粗称谓，不猜代数」；API 实测 `npc-gojo>npc-yuta: 远亲` |
| | 全量测试绿 + typecheck 0 错 | PASS | §0 |

---

## 4. UI 端到端（真跑 · 两次独立复跑）

方式：worktree 内 `pnpm build` → 起 Fastify（`0.0.0.0:3000`，serve `apps/web/dist`）→ 本机 Chrome headless + `puppeteer-core` 驱动，视口 `430×932 @2x`，逐轮断言。
脚本：`D:\code\_r26-e2e\scripts\{ui-e2e,api-walk,hit-test,time-advance2,probe}.mjs`（仓库外，**未进产品代码**）
截图：第 1 轮 `D:\code\_r26-e2e\shots\`（17 张，含 hit-test/time-advance）、第 2 轮 `D:\code\_r26-e2e\shots2\`（15 张）

| # | 链路 | 结果 | 观察（两次复跑一致） |
|---|---|---|---|
| 1 | 创建世界 → `op-2006-tokyo` | PASS | 开局下拉：`(默认)=默认（2006 · 东京高专）`、`op-2006-kyoto=2006 · 京都校交流`；`POST /api/worlds` → **201** |
| 2 | 首个待决事件 | PASS | `ev-opening-wheel`「命数转盘 · 开局」，唯一选项「转动命数转盘，书写此身」 |
| 3 | **逐轮推进 43 个维度** | PASS | 共 **44 轮**（1 开场 + `ev-w01..ev-w43`）；每轮选项 **4–40 个**（最小 4；`ev-w43` 最多 40）；**无 0 选项轮、无卡死、无空白**；每次点击后 8s 内必然切换（有「标题或选项集变化」等待断言兜底）；`console` / `pageerror` / `requestfailed` **零条**；链结束自动切到「自由行动」面板 |
| 4 | 效果真的进面板 | PASS | 「十种影法术」→ 个人·技能页可见；「特级咒具·天逆鉾」→ 个人·背包可见（API `player.inventory=["item-first-aid×3","eq-watcher-charm","eq-ten-spear"]`）；「完全天与暴君」→ 状态芯片「天与咒缚」（API `statuses=[{id:"heavenly-restriction",stacks:1}]`） |
| 5 | 时间显示走真实公历 | PASS | `2006年1月1日 00:00`（`clockIsGregorian: true`、`clockIsApproxPlaceholder: false`）；三次「修炼」→ `04:00` / `08:00` / `12:00` |
| 6 | `npcs[].relations` 只含 known/inferred | PASS（数据）／已知缺口（展示） | 投影仅 `["known"]`（20 条双向边，`REL_LEAK: NONE`，快照无 `"hidden"`）；人物页仅显示 `关系 29 / 26 / 43 / 34 / 29`（第 2 轮为 37/32/36/29/31 —— UI 未固定 seed，属预期差异），**未展示关系边与称谓** → 按主理人定性记为已知缺口，不计失败 |
| 7 | 异常路径：刷新续档 | PASS | `localStorage["life-sim:worldId"]` 自动恢复：刷新后仍在原世界、`第 44 轮`、自由行动面板 |
| 8 | 异常路径：旧档拒载 | PASS | 见 §5.3 |
| 9 | 长选项列表可点性 | PASS | `ev-w01` 13 选项，滚到底用**真实鼠标**点末项「出生地不明（弃婴/孤儿）」：`elementFromPoint` 命中 `BUTTON.option`（非浮标），点击后正常进 `ev-w02` |

**渲染核验**：`02-opening-wheel.png`、`05-round-17.png` 逐字核对 —— 标题、叙述、选项按钮、玩家卡（生命/咒力/心情/六维）均正常，**无重叠、无溢出截断、无空白**。

---

## 5. 安全与边界专项

### 5.1 V1 残留符号扫描

| 检查 | 结果 | 证据 |
|---|---|---|
| `evaluateLife`（V1） | PASS（零残留） | `grep -rn "evaluateLife\b" \| grep -v evaluateLifeV2` → 仅 `boundary.test.ts` 自检正则行 |
| `advanceTurn(`（V1 引擎） | PASS（零残留） | 唯一命中 `apps/web/src/api.ts:118` 是**前端 client 方法名**，实际请求 `POST /api/worlds/:id/turns` → 服务端走 `advanceTurnV2`（`index.ts:192`）；非 V1 引擎引用 |
| `lifecycle` / `Phase` / `PhaseTransitionLog` | PASS（零残留） | 全仓仅出现在 `boundary.test.ts` 自检正则；`find` 无 `lifecycle.ts`；`game-core/src` 仅剩 `index.ts`/`rng.ts`/`types/relationship-js.d.ts`/`v2/` |
| V1 类型层 | PASS | `game-core/src/types/` 仅 `relationship-js.d.ts`；`shared/src` 仅 `schema/`、`v2.ts`、`v2-state.ts` |
| 边界检查⑤（世界观专名） | PASS | `boundary.test.ts` 5 例全绿：扫 `game-core/src/**/*.ts`（排除 `*.test.ts`），禁 咒灵/咒力/咒术/五条/夏油/高专 |
| 未引入 LLM 状态裁判 | PASS | 引擎侧无 LLM 调用；评价/结局均纯函数（`evaluateLifeV2`/`resolveEnding`） |

### 5.2 `hidden` 不泄露（独立复验，不采信他人结论）

自建对照实验：模板副本 `D:\code\_r26-e2e\tpl-c-root`，在 `npc-gojo` 下追加 `- { to: npc-riko, kind: father, visibility: hidden }`；另起服务（:3005）与干净基线（:3000）**同 seed 424242** 建世界对比：

- `npcs` 投影 JSON **完全相同**（字符串全等）
- 快照中 `"hidden"` 字面 **不存在**
- 称谓集合完全一致：仅 `["npc-gojo>npc-yuta: 远亲"]`，未因 hidden 边多出任何称谓（**无侧信道**）

结论 **PASS**，与 `relation-projection.test.ts:52-65`（`secret-dad`）结论一致。

### 5.3 旧存档拒载（三份对照）

| 构造 | 结果 |
|---|---|
| `templateFingerprint: "sha256:deadbeef…"`（指纹不符） | 拒载：`{"reason":"template_fingerprint_mismatch","msg":"save_skipped"}` |
| `schemaVersion: 1`（R2.5 前信封） | 拒载：`{"reason":"schema_version_mismatch: 1","msg":"save_skipped"}` |
| 原样合法档（对照） | 正常加载 |

`/api/worlds` 只返回对照档；启动日志 `worlds_loaded: {loaded:1, skipped:2}`。**PASS**（原因可诊断、不吞异常）。

### 5.4 确定性回归

| 口径 | 结果 |
|---|---|
| 仓内 `replay.test.ts`（9 例） | PASS |
| 我另取固定 seed `20261112`，跑两次完整 44 轮（同 seed、同选择策略、同名） | **IDENTICAL**（`{worldTime, turnIndex, player, npcs, flags}` 全等；44 vs 44 轮）；两次独立会话各跑一遍，结论一致 |
| 归一化陷阱（自我纠正记录） | 首次对比曾报 DIFF，定位为**我的脚本**把 `playerName` 纳入指纹（`确定性a` vs `确定性b`），**非产品缺陷**；同名重跑即 IDENTICAL |

### 5.5 范围污染

| 检查 | 结果 |
|---|---|
| `R-TT-01..07`（DEFERRED）/ `R-LC-01..06`（RETIRED）是否被实现/测试/计入 DoD | PASS（未混入）：本迭代规格与 `packages`/`apps` 源码内 `R-TT-`/`R-LC-` **均零命中** |
| 需求编号集合 | 仅 `R-CAL-01..06`、`R-REL-01..06`（12 条，均在 requirements 声明范围内） |

---

## 6. 缺陷 / 偏差清单（A 区，仅针对 `fc6694f`）

| # | 严重度 | 问题 | 定位 | 复现 | 建议 |
|---|---|---|---|---|---|
| **D-02** | **P2（规格偏离，唯一阻断项）** | `CalendarAdapter.ageAt` 未实现；「生日未到不加岁」不成立，年龄按日历年边界跳变 | `packages/game-core/src/v2/time.ts:54`（接口仅 `elapsedYears`）、`:291`（gregorian 按年边界）；消费点 `engine.ts:434/442`、`turn.ts:750/833` | `grep -rn "ageAt"` 零命中；`time.test.ts:197` 断言 `elapsedYears(366*1440)===1`（1-1 跳岁，非生日） | 二选一：①补 `ageAt(minute)` + 状态层生日字段 + 单测；②写 ADR 把 `R-CAL-01/03`、`T-A2/T-A3` 口径正式改为 `elapsedYears` 合一，并在 OPEN_QUESTIONS 登记偏差 |
| **D-03** | P3（测试缺口） | `custom` 无 `months` 加载期拒载**无自动化用例**（design §6「无效」类明确要求） | 缺 `packages/shared/src/schema.test.ts` 用例 | 实现已具备，我手工实测通过（§2 T-A1）；回归无护栏 | 补 1 例：`preset:"custom"` 且无 `months` ⇒ `parse` 抛 `/必须声明 months/` |
| **D-04** | P3（测试缺口） | 关系端点校验（`to` 须为已声明角色或 `"player"`）**无用例** | 实现于 `world.ts:283-287` | 手工实测通过（§3 T-B1）；回归无护栏 | 补 1 例：`to: npc-ghost` ⇒ 抛 `/未知关系目标/` |
| **D-05** | P3（已知展示缺口） | 人物页只显示 `关系 N` 标量，未消费 `npcs[].relations` 边与 `kinshipTerm` | `apps/web/src/main.tsx` `PeopleTab` | UI 实测：只有 `关系 29/26/43/34/29` | 数据已就绪（T-B5 通过），前端后续接入；**不计本轮失败**（主理人已定性） |
| **D-06** | P3（规范偏差） | 提交信息未按 `tasks.md`「注明任务 ID **与需求编号**（R-CAL-*/R-REL-*）」 | 8 条 R2.6 提交 | 均只带 `T-*` 与 ADR，无 `R-CAL-*`/`R-REL-*` | 后续提交补需求编号，追溯矩阵同步 |
| **D-07** | P3（潜在风险） | `v2/relations.ts` 未从包入口 `game-core/src/index.ts` 导出，`queryEdge`/`shortestPath`/`kinshipTerm` 外部包（server/web）不可调用 | `packages/game-core/src/index.ts`（仅 `engine.ts`/`projection.ts` 内部 import） | `grep "relations.js" index.ts` 零命中 | 若 `R-REL-01`「查询 API」需对外则补导出；若刻意封锁（防泄露原始边）应在 ADR 写明 |
| **D-08** | P3（视觉瑕疵） | 底部固定浮标「⚡ 事件待决」浮在最后一个选项之上（视觉遮挡） | `apps/web/src/style.css:709-720` `.interact-hint` | `05-round-17.png` 可见 | 已有 `pointer-events: none`，**实测不挡点击**（§4 #9）；建议留安全区或滚动时隐藏 |
| **D-09** | P3（口径待确认） | 转盘 43 维全部 0 `timeCost`：走完 44 轮世界时间仍为 `2006年1月1日 00:00` | `events.yaml` `ev-w01..ev-w43` 无 `timeCost` | UI 实测 R1→R44 时间恒 `00:00`（之后自由行动才推进） | 若「转盘 = 开局瞬时仪式」属预期，建议在 README 注明；否则需在链事件补 `timeCost` |

---

## 7. 未覆盖项与放行条件

### 7.1 未覆盖（显式声明，未用推测替代实测）

| # | 项 | 原因 |
|---|---|---|
| 1 | 真实公历**跨月/跨闰年**未在 UI 层观测 | 开局链不推进时间；UI 只观测到同日 `00:00→12:00`。跨 2 月 / 2-29 由 `time.test.ts` 单测覆盖（`format((31+28)*1440)="2000年2月29日"`），UI 层需 ~186 次点击，未做 |
| 2 | 战斗面板 / 结局面板 UI 未跑 | 转盘链与自由行动不触发战斗；未构造战斗与终止结局。非 R2.6 变更面 |
| 3 | 移动端真机 / 非 Chrome 内核未验 | 仅 headless Chrome（桌面内核，430×932 视口）；Safari/WebView、真机安全区未覆盖 |
| 4 | `relationship.js` 供应链审计 | 仅验行为（多跳称谓、回退、确定性）；未做依赖/许可证扫描（ADR-0014 已记 MIT/离线/纯算法） |

### 7.2 放行条件

**必须（阻断）**

1. **D-02 `ageAt` 二选一落地**：补实现（含生日口径 + 用例），或走 ADR 把 `R-CAL-01/03`、`T-A2/T-A3` 的 DoD 正式改写为「`elapsedYears` 合一」并在 OPEN_QUESTIONS 登记偏差。**不得两不落地。**

**建议本轮内补齐（不阻断，但 DoD 追溯不完整）**

2. **D-03 / D-04** 补两条负向用例（`custom` 无 `months`、关系端点未声明）——实现已具备且手工实测通过，仅缺回归护栏。
3. **D-06** 提交信息补需求编号；**D-07** 明确 `relations.ts` 是否对外导出并写进 ADR；**D-08 / D-09** 记录为已知瑕疵/待确认口径。

---

# B. 工作区偏离说明（仅供参考，未评审，不属 R2.6，不判 FAIL）

> **定性**：以下内容是**另一进程/会话在进行中的「咒术转盘·第二版」改造**，主理人已独立核实并与 QA 观测一致。它**不属于 R2.6 范围**，**未由 QA 评审**，**不作为本轮判定依据**，**不判 FAIL**。
> QA 未对该工作区做任何写操作（未 `checkout`/`stash`/`add`/`commit`/删未跟踪文件）。

## B.1 观测事实（测量时刻快照）

- 已修改 10 个文件：`packages/game-core/src/v2.test.ts`、`packages/game-core/src/v2/opening.test.ts`、`packages/shared/src/schema.test.ts`，以及模板 `characters/endings/events/items/opening/skills/statuses/world.yaml`
- 未跟踪：`specs/data/templates/jjk-2006/evaluation.yaml`、`咒术转盘☆第二版.wheel.json`（139 KB）、`packages/game-core/src/v2/playthrough.test.ts`
- 观测窗口内被改文件数 **6 → 10 → 11** 递增，`events.yaml` mtime 距测量仅 2 秒 —— 该进程在验收期间**持续写入**

| 文件 | 基线 `fc6694f` | 工作区当前 |
|---|---|---|
| `events.yaml` | 4335 行 / **44 事件 / 1 链**（`chain-wheel-creation`） | 1768 行 / **58 事件 / 6 链**（`chain-creation`、`chain-sp`、`chain-geto`、`chain-night`、`chain-shibuya`、`chain-finale`） |
| `evaluation.yaml` | 不存在 | 新增 |
| `world.yaml` | `defaultStep: 4 hour`；6 个行动 4h/4h/2h/8h | `defaultStep: 1 day`；新增 `explore` 行动；行动统一 1 day |

## B.2 跨基线测试数字（**跨基线污染，不用于判定**）

在**工作区**（非基线）执行同一条命令：

```
pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism
→ Test Files 2 failed | 20 passed (22)   Tests 5 failed | 327 passed (332)
```

5 条失败全部为**模板内容断言**，与工作区把链改回旧版直接相关：`v2.test.ts:44`（chains 期望 `["chain-wheel-creation"]`，实收 6 条旧链）、`:55`、`:174`、`:727`、`opening.test.ts:301`。
`pnpm typecheck` 在工作区仍为 0 错（该改造未引入类型错误）。

**结论**：这 5 条红属**基线不一致**导致，**不是 R2.6 缺陷**，A 区判定不受影响。

## B.3 风险项 R-01（客观登记，不评价对错、不由 QA 修）

| 项 | 内容 |
|---|---|
| **R-01** | **工作区改造会覆盖 ADR-0015 的内容收敛结论**：`events.yaml` 从「44 事件 / 1 链（`chain-wheel-creation`）」改回「58 事件 / 6 链（`chain-creation`…`chain-finale`）」，并新增 `evaluation.yaml`。 |
| 影响面 1 | **ADR-0015 的收敛结论被推翻**：该 ADR 记录的「删 5 条主线链、28 个事件，转盘成为开局核心」不再是磁盘现状；R2.6 的 T-B6（10 条初始关系边随 `characters.yaml` 声明）与 ADR-0015 的模板指纹前提也随模板内容变化。 |
| 影响面 2 | **模板指纹再次变更**：指纹 = 目录内全部 `*.yaml` 排序拼接后 sha256（`apps/server/src/templates.ts:101-112`）。`events.yaml`/`characters.yaml`/新增 `evaluation.yaml` 均参与计算 ⇒ 指纹必将改变 ⇒ **R2.6 期间产生的旧存档一律被拒载**（`template_fingerprint_mismatch`，§5.3 已验证该机制生效）。 |
| 影响面 3 | **测试与模板同源耦合**：该改造同时修改 `v2.test.ts`/`opening.test.ts`/`schema.test.ts` 并新增 `playthrough.test.ts`，即断言与模板一同漂移；任何「R2.6 数字」在其上复测都会失去可比性 —— 需在下一迭代重新建立基线并重跑五条口径。 |
| 影响面 4 | **DoD 追溯需重建**：ADR-0015 若被替代，应在 DECISIONS 登记新 ADR 并从 `0358cc9` 起的模板类断言重新追溯，否则 R2.6 的 T-B6 与 ADR-0015 的关联证据将指向已不存在的模板内容。 |

---

## 附. 复现指引（§9）

```bash
# 1) 干净基线（不改动主工作区；本轮结束后 worktree 保留在 D:\code\_r26-head）
git -C D:/code/ai-life-simulator worktree add D:/code/_r26-head fc6694f
#    node_modules 以 Windows Junction 复用到 root/packages/*/apps/*（无需重装依赖）

# 2) 五条认证口径（在 D:/code/_r26-head 下）
pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism   # 332 passed
pnpm --filter @life-sim/shared test                                       # 50 passed
pnpm typecheck                                                            # 0 错
pnpm build                                                                # 成功

# 3) UI 端到端（先 build，3000 才 serve 最新 dist）
LIFE_SIM_DATA_DIR=D:\code\_r26-e2e\data2 PORT=3000 pnpm --filter @life-sim/server start
node D:\code\_r26-e2e\scripts\ui-e2e.mjs     # 44 轮走查 + 截图 + 面板/续档断言
node D:\code\_r26-e2e\scripts\api-walk.mjs   # 投影 / 确定性 / 无效输入
node D:\code\_r26-e2e\scripts\hit-test.mjs   # 末项真实鼠标可点性

# 4) 清理
git -C D:/code/ai-life-simulator worktree remove D:/code/_r26-head --force
```

> 环境隔离：`LIFE_SIM_DATA_DIR` 指向 `D:\code\_r26-e2e\data*`，与主仓 `data/worlds` 完全隔离。
> 主仓工作区**未被 QA 修改**；`D:\code\_r26-head` 为 detached HEAD 的干净检出。
