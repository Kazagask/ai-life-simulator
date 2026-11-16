# ADR-0021 验收报告（NPC 生命周期补强四项）

- **验收人**：测试验收工程师 严过关（life-sim-qa）
- **验收对象**：`439ac27` `docs(ADR-0021): NPC 生命周期补强…`（工作区干净，`git status --short` 空）
- **对比基线**：`465c636`（ADR-0021 起草时核实基线）
- **裁决依据**：`docs/DECISIONS.md` ADR-0021 全文（808–1016 行）+ user 四条反馈 + 主理人 A–E 验收清单
- **验收日期**：2026-11-12
- **产物位置**：探针脚本 `D:\code\_adr21-e2e\scripts\`；截图与 JSON `D:\code\_adr21-e2e\shots\`（均在仓库外，未污染工作区）
- **本轮无 `tasks.md`**：ADR-0016 明确本仓迭代不走 spec 包，故 DoD 表以 ADR「验证要点 1–10」+ ADR「建议拆任务 T1–T4」+ user 四条反馈为条目来源。

---

## 验收裁决

- **任务**：ADR-0021（T1 战斗参战判活 / T2 属性投影+前端属性区 / T3 reasonCode 展示口径 / T4 birthTime 派生）
  ｜**需求**：user 2026-11-12 四条反馈（无 R-编号，ADR 为需求载体）
  ｜**裁决：通过（可验收）**
- **一句话理由**：四条口径（typecheck / game-core 412 / shared 62 / build）全绿；A–E 五组行为均以**独立探针**（37 条断言，非采信实现方用例）逐条证实，含「跳过档与事件不存在档状态逐字节相同」这类无法糊弄的强断言；无 P0/P1 缺陷，仅 2 条 P2/P3 契约漂移与 1 条 P3 文案边界，均不阻断放行。

---

## 一、四条口径（自行重跑，数字与实现方一致）

| 命令 | 退出码/结果 | 覆盖口径 |
|---|---|---|
| `pnpm typecheck` | **0**（无输出） | 全仓 TS 类型 |
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | **0**｜29 files / **412 tests passed**（60.9s） | 正常/边界/无效输入/契约 |
| `pnpm --filter @life-sim/shared exec vitest run --no-file-parallelism` | **0**｜4 files / **62 tests passed**（5.0s） | schema/命令/开局 |
| `pnpm build` | **0**｜typecheck + vite build（`dist/index.html` + 269.11 kB js / 24.01 kB css） | 产物可构建 |

> 沙箱坑已按提示带 `--no-file-parallelism`，未出现挂死。
> 实现方报的 412 / 62 与实测一致，不是虚报。

---

## 二、DoD / 验证要点核验表

| # | 条目（来源） | 结果 | 证据 |
|---|---|---|---|
| 1 | 死人不参战（友军）：置 `npc-gojo` 非在世 ⇒ `ev-sj-02` 照打、allies 不含 gojo、敌人列表不变（ADR 验证要点 1） | **PASS** | §A1：`[npc-gojo,npc-yuji] → [npc-yuji]`，enemies `[enemy-sukuna]` 零变化，战斗仍成立 |
| 2 | 死人不参战（敌人）：两敌一死一活 ⇒ 只滤死者（要点 2） | **PASS** | §A2（真实 `ev-jv-01` 三友军死一）+ §A5（敌人全死→exhausted） |
| 3 | 敌人耗尽 ⇒ 整条跳过，事实层零写入（要点 3） | **PASS** | §A6：跳过档与「事件不存在」档 `state` **逐字节相同**；history/rep/worldTime/turnIndex delta 与对照完全一致 |
| 4 | 友军为空照打：allies 全滤空、enemies 非空 ⇒ 建场、`battle.allies === []`（要点 4） | **PASS** | §A4 |
| 5 | 未知/无实例 ref ⇒ 视为可用、不跳过（要点 5） | **PASS** | §A3（`enemy-sukuna` 无实例仍参战）、§A6++；未知 id 仍抛 `character_not_found` |
| 6 | 属性透出：键集 ⊆ order、order 外键不出现、值 = 模板声明、无声明 ⇒ `{}`（要点 6） | **PASS（附 1 处 N/A）** | §C1/C2/C4；`order` 为空不可达（`world.ts:162` `.min(1)`）⇒ `{}` 分支 N/A，见缺陷 D-2 |
| 7 | `reasonCode` 展示：有值只显示该值（无「已故/失联」）；无值回退「已离场」（要点 7） | **PASS** | §B：真实浏览器三档，`document.body.innerText` 全局无关禁词 |
| 8 | 跨年 +1（gregorian）：投影 age +1 而 `state.npcs[].age` 不变（要点 8） | **PASS** | §D4：11/11 NPC +1；快照仍 `34,17,17,17,15,15,14,16,15,15,15` |
| 9 | 旧档缺 `birthTime`：加载后 age === identity.age 且随世界时间增长（要点 9） | **PASS** | §D5（schema 关）+ §D5b（**真实 store 加载链** + 临时数据目录） |
| 10 | 负分钟：`yearOf(-n)/ageAt` 成立、`minutes ≥ 0` 输出字节不变（要点 10） | **PASS** | §D1/D6：gregorian 7424 + approx 12412 采样 **0 差异** |
| U1 | user#1 npc ref 判活必须做（否则模板侧每场战斗都要写长 DSL） | **PASS** | 判活为**单位级过滤**且**默认成立**：12 场真实战斗模板零改动即生效（§E2） |
| U2 | user#2 引擎不认 reasonCode、前端渲染具体原因、不得出现「已故/失联」 | **PASS** | 投影原样透出（`projection.ts:183-188`）；`apps/web/src/main.tsx` 全文仅在注释中出现「已故/失联」 |
| U3 | user#3 NPC 自定义属性渲染（术式补正是副产物） | **PASS** | §C2c：面板 120（base）vs 战斗实效 140，补正以「六眼」状态呈现 |
| U4 | user#4 birthTime 顺手改（ADR 明确「不可能只改 yaml」） | **PASS** | §D：`birthTime` 引擎写入 + 读侧反推 + 投影派生，无需改 yaml |
| T1–T4 | ADR 拆任务四笔提交（`8c0af4d / c122d1f / 98e97e6 / 022a3e7`） | **PASS** | `git log` 四笔均可定位；T4 内部顺序「先历法后字段」正确（`time.ts` 先具备 `ageAt`，`turn.ts:128` 才写 `birthTime`） |

---

## 三、A–E 逐项证据（独立探针，不采信实现方用例）

探针统一入口（仓库外运行，alias 复用仓库源码，`--no-file-parallelism`）：

```bash
cd /d/code/_adr21-e2e/scripts
node /d/code/ai-life-simulator/node_modules/vitest/vitest.mjs run --no-file-parallelism --config ./vitest.config.ts
# → Test Files 6 passed (6) | Tests 37 passed (37)
```

### A. 战斗参战 ref 判活（`a-combat.probe.test.ts`，11 例，seed 20261112，真实 jjk-2006）

| 用例 | 实测输出 |
|---|---|
| A1 `ev-sj-02` 友军 gojo 非在世 | baseline `allies=[npc-gojo,npc-yuji] enemies=[enemy-sukuna]` → 置 `npc-gojo` inactive 后 `allies=[npc-yuji] enemies=[enemy-sukuna]`（**敌人零变化 ⇒ 不是整场消失**，`allies[0].hp>0`） |
| A2 `ev-jv-01` 三友军死一人 | `[npc-yuji,npc-megumi,npc-nobara] → [npc-megumi,npc-nobara]`（单位级过滤，长度 -1） |
| A3 敌人无实例 | `state.npcs.some(id==="enemy-sukuna")===false`；`resolveCombatRefs` → `enemies=[enemy-sukuna]`、`exhausted=false`；建场 1 敌 |
| A4 友军全非在世 | `allies=[]`、`enemies=1`、`enemiesExhausted=false`、`inactiveNpcIds=[npc-gojo,npc-yuji]`；`createBattle` 成功且 `battle.allies=[]` |
| A5 敌人全非在世 | `enemies=0 exhausted=true`；**危害证明**：绕过门直接建场 ⇒ `battle.enemies=[]`，`checkBattleEnd` 立即 `over="victory"`（⇒ 门必须存在，ADR 1.2 判断成立） |
| A6 整条跳过（turn 入口） | 注入 action-hook 战斗（敌人 = 有实例的 `npc-yuji`，`onVictory: setFlag qaVictoryFlag`）；`npc-yuji` 置 inactive 后：`state.battle===null`、`snapshot.battle===null`、`triggeredEvents=[]`、`eventFires.length=0`、无 `qaVictoryFlag/qaDefeatFlag`、`history` delta 与对照相同、`reputation` delta 相同；**与「事件根本不命中」对照档 `state` 深度相等（JSON 逐字节）** |
| A6+ 阳性对照 | 同夹具、`npc-yuji` 在世 ⇒ `battle.eventId="qa-combat-probe"`、`enemies=[npc-yuji]`、`eventFires` +1 ⇒ 证明 A6 的跳过确由**判活**引起，不是夹具坏了 |
| A6++ 无实例敌人对照 | 敌人 = `enemy-sukuna`（无实例）⇒ 不跳过，照常建场 |
| 结构检查 | 全仓 `createBattle(` 仅 1 处调用点（`turn.ts:392`，门就在同函数 339 行之前）⇒ **无绕过路径** |

> 「`TriggerResult.skipped` 只能间接断言」的处理：**已独立证明效果等价**（A6 逐字节等价 + 三档对照），并在 §五 显式登记该字段不可观测（缺陷 D-1），未含糊。

### B. reasonCode 文案（`ui-probe.mjs`，430×932 DPR2 headless Chrome）

| 档 | worldId | 实测 |
|---|---|---|
| B 注入 `reasonCode:"阵亡"` | `c606e0a4-d33f-44da-920c-6489e089499a` | 胶囊 `"阵亡"`；生命周期块 `"阵亡 · 壮年 · 34 岁"`；`document.body.innerText` **无「已故」「失联」**（11 张卡全量扫描） |
| C 注入 inactive 但**省略** reasonCode | `92e41b0a-01cc-42b2-9043-047fad85079a` | 胶囊 `"已离场"`；块 `"已离场 · 壮年 · 34 岁"`；同样无禁词 |
| A 真实 alive 档 | `edb537eb-44e6-434b-8e97-1206e92778c5` | **无顶部胶囊**（`chip=null`）；块 `"在世 · 壮年 · 34 岁"` |

- 注入内容已**自行复核属实**（直接查 API 而非相信备注）：`c606e0a4` → `{"state":"inactive","reasonCode":"阵亡"}`；`92e41b0a` → `{"state":"inactive"}`（无 reasonCode）；`edb537eb` → 11 名 NPC 全 `alive`。
- 三个 world 的 `pageErrors` = **0**。
- 截图（绝对路径）：
  - `D:\code\_adr21-e2e\shots\qa-B_reasonCode.png` / `qa-B_reasonCode-card0.png`
  - `D:\code\_adr21-e2e\shots\qa-C_noReasonCode.png` / `qa-C_noReasonCode-card0.png`
  - `D:\code\_adr21-e2e\shots\qa-A_alive.png` / `qa-A_alive-card0.png`
  - 原始断言数据 `D:\code\_adr21-e2e\shots\qa-ui-result.json`

### C. NPC 属性渲染 + 投影口径（UI + `c-attrs-hidden.probe.test.ts` 9 例）

| 检查 | 实测 |
|---|---|
| 每卡属性项数 == `attributes.order` 长度（6） | **11/11 卡** 均为 6 项；摘要行 `"关系 N · 状态 M · 属性 6"` 全部命中 |
| 值 == 模板 base 原值 | UI 逐卡与 API `npcs[].attributes` 完全相等；引擎侧逐 NPC×逐键比对 `characters[].attributes`，**mismatches: none** |
| 五条悟（有补正）| 面板 `{咒力120,智力10,体术9,敏捷11,幸运0,声望60}`；战斗实效 `cursedEnergy 140 / agility 21 / intellect 20`（`six-eyes` 补正 +20/+10/+10）⇒ **面板≠战斗不是漏算**，补正以「六眼」状态项呈现（UI 摘要 `状态 1`） |
| `0` 正常显示 | 11/11 NPC 幸运未声明 ⇒ 界面全部显示「幸运 0」，未被当缺失过滤 |
| 中文名、无机器名 | 属性名序列 == `labels.attributes` 值序列；无 `^[a-zA-Z_]` 机器名 |
| 横向不溢出 | 三档均 `document.documentElement.scrollWidth === window.innerWidth === 430`；属性区块 `scrollWidth-clientWidth = 0` |
| 键集边界 | 11 名 NPC `Object.keys(attributes)` **深等于** `template.attributes.order`（顺序一致）；模板 order 外键零出现 |
| 空态 | 实例 `attributes={}` ⇒ 下发 6 键全 0（不缺键）；`order=[]` 不可加载（见 D-2） |

### D. birthTime / 年龄派生 / 负分钟（`d-time-age.probe.test.ts` 12 例 + `d5b-legacy-load.probe.test.ts`）

| 检查 | 实测 |
|---|---|
| 负分钟修复 | `toMinutes({value:-15,unit:"year"},0)` = **-7889760**（= -(15×365+4)×1440，含 1992/96/2000/04 四个闰年），`format` = `1991年1月1日 00:00`；旧实现为 0（对照实现已内联） |
| 回溯/正向往返 | -1/-5/-15/-34 年往返 `back + forward === 0`（`-525600 / -2629440 / -7889760 / -17883360`） |
| 反推自洽 | `ageAt(birthTimeFromAge(age),0) === age`，**0..120 岁全通过，mismatches: none** |
| 建世界时刻年龄 | 11/11 NPC 投影年龄 == `characters[].identity.age`：`34,17,17,17,15,15,14,16,15,15,15`；`birthTime` 全为负 |
| 跨年界即 +1 | `worldTime = 2006-12-31 00:00 → +1440min`：11/11 全部 +1（`34→35, 17→18, …, 15→16`）；`state.npcs[].age` 快照**未回写** |
| ADR 反例（分工口径分水岭） | 生 1991-04-03、观察 2007-01-15：`ageAt = 16`，`elapsedYears(now-birth) = 15`，**差 1 岁**（证明实现走的是年差口径，不是生日口径） |
| 闰年干扰 | 2008-02-28 → 2008-03-01 年龄不变；`format(2008-02-29)` = `2008年2月29日 00:00` |
| 旧档（无 birthTime） | 删字段后 `WorldStateV2Schema` 通过；投影年龄与带字段时**完全一致**；世界时间 +1 年后 11/11 +1 |
| 旧档真实加载链 | `apps/server` `loadPersistedWorlds`（JSON→schemaVersion→指纹→WorldStateV2Schema）+ 临时数据目录：`loaded:1 errors:[]`，加载后年龄与原档逐一相等 |
| `minutes ≥ 0` 字节不变 | gregorian：逐日 0–20 年（7321 采样）+ 前 3 年逐小时（73）+ 月末/闰日/年界邻域（30）= **7424 采样，差异 0**；approx：逐日 0–10 年（3651）+ 首年逐小时（8761）= **12412 采样，差异 0** |
| 负分钟反证 | 旧实现 `format(-1) === format(0) === "2006年1月1日 00:00"`；新实现 `format(-1) = "2005年12月31日 23:00"`、`format(-525600) = "2005年1月1日 00:00"`（`format` 只到小时粒度，属既有粒度） |
| day/week/hour/minute | 不随负分钟改动漂移（from ∈ {0, ±12345678}） |

### E. 回归与确定性（`e-determinism.probe.test.ts` + 仓库既有门禁）

| 检查 | 实测 |
|---|---|
| 同 seed 同指令 ⇒ 同结果（判活生效期间） | 同 seed 20261112、同一指令序列跑 20 轮，中途第 5 轮把 `npc-gojo` 置 `inactive/封印`；两次独立运行 `state` JSON **各 13257 字节、逐字节相等** |
| 判活对正常战斗是恒等变换 | 12 场真实战斗 `resolveCombatRefs` 输出全部 `==` 模板声明（`E1/1 A0/0 … ev-jv-01 E1/1 A3/3 … ev-sj-02 E1/1 A2/2`），`inactiveNpcIds=[]`、`exhausted=false` ⇒ **无人非在世时同 seed 结果不可能改变** |
| 纯函数性 | 同一输入调用 1000 次：输出去重 = 1；`state` 序列化前后不变（无写、无 rng 入参） |
| `playthrough` 6 种子 × 2 开局 | 绿：`s1 end-secret-thrice day4755 t326 | s2 … | s3 end-legend | s4 … | s5 end-special | s6 …`，五维 overall 94.72–94.99 |
| `replay` | 绿（9 例） |
| `hidden` 未进玩家端 | 真实 HTTP `/api/worlds/edb537eb…`：`secrets/combatHints/skillWeights/hidden/proficiency/birthTime` **全部 absent**；`npcs[0]` 键集 = `id,name,age,genderLabel,personality,relationship,knownGoals,attributes,statuses,lifeStage,lifeStageLabel,lifecycle,relations` |
| 投影侧 hidden 过滤 | 注入 `enrage`（hidden）不出现、`cursed-king`（known）照常出现；注入 `visibility:"hidden"` 关系边被过滤，投影内可见性集合 = `{known}` |
| 模板指纹未变 | `git diff --name-only 465c636..HEAD -- specs/data/templates/` = **0 个文件**；`apps/server` 零改动；`schemaVersion` 仍为 2 |

---

## 四、专项检查

| 检查项 | 结果 | 证据 |
|---|---|---|
| 确定性可重现 | **PASS** | §E1/E2 + `replay`/`playthrough` 绿 |
| DEFERRED/RETIRED 未混入范围 | **PASS** | `git diff 465c636..HEAD \| grep -E "R-TT-\|R-LC-"` 空；`R-TT-01..07`/`R-LC-01..06` 未实现、未测试、未计入 DoD |
| V1 残留符号 | **PASS** | 精确扫描 `\bevaluateLife\b\|\badvanceTurn(\|PhaseTransitionLog\|class Phase\|assertPhase` 仅命中：① `apps/web/src/api.ts:132` 的**前端 HTTP 方法名** `advanceTurn(...)`（V1 引擎无关、本轮未改）；② `boundary.test.ts` 自身（守门用例）。无 `lifecycle.ts` |
| 未引入 Lifecycle 状态机 | **PASS** | `boundary.test.ts` ① ② 用例在 412 中通过；`lifecycle` 仅为 `V2Npc.lifecycle` 事实字段（`state/sinceTurn/sinceWorldTime`），无 `Phase`/转移函数 |
| hidden 未进入玩家端 API | **PASS** | §E 表两项 |
| LLM 非唯一状态裁判 | **PASS（N/A）** | 本轮无 LLM 参与状态判定（引擎纯函数；`reasonCode` 原样透传，引擎不解释） |

---

## 五、缺陷清单

> 无 P0 / P1。下列 4 条不影响用户可见行为与放行，建议随手收敛或在 BACKLOG 登记。

| # | 严重度 | 问题 | 位置 | 复现 | 建议 |
|---|---|---|---|---|---|
| D-1 | **P2** | `TriggerResult.skipped` **与 ADR 1.4 契约不符且无任何读者**：ADR 要求 `Array<{eventId, reason:"combat_refs_inactive", npcIds}>`，实现为 `skipped?: string`（常量 `"all_enemies_inactive"`，丢弃 `npcIds`，多条同时跳过时后写覆盖）；且全仓无读取点，`V2TurnResult` 不含该字段 ⇒ 经 `advanceTurnV2` **观测不到**，ADR 承诺的「诊断可断言」只达成一半（本次只能以「跳过档 ≡ 事件不存在档」间接证明效果） | `packages/game-core/src/v2/turn.ts:231`、`:238`、`:339-341` | 单测断言 `(result as any).skipped` 恒为 `undefined`（探针 [A6] 实测 `undefined`） | 二选一：① 删掉（ADR 已允许「退化为零记录」，测试改副作用断言）；② 补成数组并加读取点（如测试专用导出或 `log.debug`），否则它是死代码 |
| D-2 | **P3** | ADR 验证要点 #6 末句「无声明 ⇒ `{}`」在当前契约下**不可达**：`attributes.order` schema 要求 `min(1)`，任何可加载模板都不可能得到空 order；只有「NPC 未声明属性 ⇒ 补 0」可达（已验） | `packages/shared/src/schema/world.ts:162`；`packages/game-core/src/v2/projection.ts:256-266` | `WorldTemplateV2Schema.safeParse({attributes:{order:[]}})` → `too_small, minimum 1` | 把该分支标注为防御性代码（ADR 改为「不可达」），或放宽 schema（不推荐：空 order 会让玩家面板无属性） |
| D-3 | **P3** | `lifecycleText` 用**真值**判断 `reasonCode`，而 schema 只用 `min(1)`：若模板写入纯空白 `reasonCode: " "`，会命中「有原因」分支并渲染一颗近乎空白的胶囊，且不再回退状态词 | `apps/web/src/main.tsx:2104-2107`（配合 `packages/shared/src/v2-state.ts:72` `z.string().min(1)`） | 把注入档 `reasonCode` 改为 `" "` 后重放 §B | `reasonCode?.trim()` 后再判断（前端一行），或 schema 加 `.trim().min(1)` |
| D-4 | **P3（既有，非本轮引入）** | 角色级 `visibility: hidden` 的 NPC（如 `npc-riko` 天内理子）仍随 `state.npcs` 上屏，「hidden 不泄露」在**NPC 存在性**维度本就不成立。已比对 465c636 的 `projection.ts:150-151` 与本轮代码：投影口径未变，**本轮未放宽** | `packages/game-core/src/v2/projection.ts:150-198` | `projectSnapshotV2` 输出含 `npc-riko`（基线同样含） | 另立项：NPC 卡是否按 `infoVisibility:*` 过滤整卡（本轮不属 ADR-0021 范围） |

---

## 六、未覆盖项与风险（显式「未验证」）

| # | 项 | 状态 | 原因 / 补偿 |
|---|---|---|---|
| 1 | 与 `465c636` 的**同 seed 端到端产物**逐字节对比 | **未验证** | 需另一套可运行基线（工作树 `node_modules`/pnpm workspace 不可复用，成本超本轮范围）。补偿：§E2 证明「无人在世时判活是恒等变换」+ §E1 同 seed 逐字节 + `replay`/`playthrough` 绿 |
| 2 | `TriggerResult.skipped` 赋值的**直接观测** | **未验证（不可观测）** | 字段非持久化且不进 `V2TurnResult`；已用「跳过档 ≡ 事件不存在档」等价证明替代，并登记为 D-1 |
| 3 | 非 gregorian（`custom` 历法）的**负分钟** | **未验证** | 模板库仅 `jjk-2006`（`preset: gregorian`）+ `approx` 既有路径；无 custom 模板可测。代码走 `viewToMinutes` 同一负分支（`time.ts:178-187`），风险低 |
| 4 | 「敌人全非在世 ⇒ 不建场」的**真实数据**路径 | **不可达（合成夹具验证）** | 12 场真实战斗 enemies 全为未实例化的 `enemy-*`（恒不触发）；ADR 1.1 已说明。故该项只能注入 action-hook 战斗验证（§A6），且已用「同一夹具换活敌人必开打」做阳性对照 |
| 5 | `advanceWhen: "nextTurn"` 链步上的「不动链状态」 | **代码阅读，未实测** | `advanceNextTurnChains` 先 `alignChainStep`（`turn.ts:592`）再 `triggerEventV2`（`:604`）⇒ 该路径上链步会先推进，「不动链状态」不字面成立；但 jjk-2006 全部链步为 `onSettle`（`events.yaml:3014+`），**当前无暴露**。属既有并发 skip 同型行为，ADR 未要求修 |
| 6 | 链上战斗被跳过 ⇒ 链停在 active（剧情可能悬空） | **风险（ADR 已承认并登记 BACKLOG）** | ADR 1.5 明确本轮不修（需新增 `broken` 状态＝协议变更）；实测今日不可触发（敌人无实例） |
| 7 | 真机 / 非 headless 浏览器 | **未验证** | 仅 430×932 DPR2 headless Chrome（与既有验收口径一致） |
| 8 | `data/worlds/` 中 46 个旧档被跳过（`template_fingerprint_mismatch` / `schema_version_mismatch: 1`） | **确认属预期环境现象，非本轮缺陷** | 启动日志 `worlds_loaded loaded:3 skipped:46`；三个在用档（seed 20261112 / 两个注入档）加载正常；模板零改动 ⇒ 指纹不变，拒载原因在 **V1 时代旧档** |

---

## 七、复跑指引

```bash
# 四道门禁
cd /d/code/ai-life-simulator
pnpm typecheck
pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism
pnpm --filter @life-sim/shared exec vitest run --no-file-parallelism
pnpm build

# 引擎级探针（A/C/D/E，37 条断言；仓库外运行，不污染工作区）
cd /d/code/_adr21-e2e/scripts
node /d/code/ai-life-simulator/node_modules/vitest/vitest.mjs run --no-file-parallelism --config ./vitest.config.ts

# 前端探针（需先起服务并完成 web 构建）
cd /d/code/ai-life-simulator && PORT=3100 pnpm start &
node /d/code/_adr21-e2e/scripts/ui-probe.mjs
# 断言结果落盘：D:/code/_adr21-e2e/shots/qa-ui-result.json
```

> 探针 `vitest.config.ts` 用 alias 把 `@life-sim/game-core` / `@life-sim/shared` / `yaml` 指回仓库源码，故跑的是 **HEAD 439ac27 的真实实现**，无副本漂移。

---

## 八、结论

四项用户反馈均已落地且行为经独立复现：**判活是真的判活（单位级、有阳性对照、零副作用可逐字节证明）、属性是真 base（且 0 不被吞）、原因文案只显示原因（全页无「已故/失联」）、年龄是真随年界增长（不是生日口径、不是静态快照）**。四条口径全绿，12 项 DoD/验证要点 11 项 PASS + 1 项 PASS（附不可达分支 N/A）。

唯一需要实现方回一句的是 **D-1（`skipped` 死字段）**：要么删、要么补读取点——它不影响任何用户可见行为，故**不构成退回理由**。

**裁决：通过（可验收）**。建议放行，并把 D-1 随手收敛、D-2/D-3 记为 nit、D-4 与 §六.6 登记 BACKLOG。
