# JJK-2006「第二版」玩法重构 · 验收报告（ADR-0016）

- **验收人**：严过关（测试验收工程师）
- **验收对象**：commit `6971476 feat(template)!: jjk-2006 玩法重构落地 —— 一年制命数转盘（ADR-0016）`
- **HEAD**：`64c0197f1637002eaa3234017b96d4fe3f7f5039`（`docs(R2.6): 归档 QA 验收报告`）；验收开始时 `git status --short` 为空
- **验收时间**：2026-11-12
- **复验状态**：**已有 R-02 复验（见 §十）**——本报告主体记录首次验收（HEAD `64c0197`）；D-01 / D-02 / D-04 已修复并复验通过，另新登记 D-10（回归）/D-11（内容），当前裁决以 §十 为准
- **环境**：Windows / Node v22.22.2 / pnpm 9.15.0 / Chrome（headless new）/ 视口 430×932 @2x
- **工作目录**：`D:\code\ai-life-simulator`；e2e 产物在 `D:\code\_v2-e2e\`（与上次 `_r26-e2e` 分离）
- **纪律**：本轮只测量与登记，未改动任何产品代码（报告是本轮唯一新增仓库文件）

---

## 一、验收裁决

| 项目 | 结论 |
|---|---|
| 任务 | jjk-2006 第二版玩法重构（ADR-0016） |
| 裁决 | **退回（不可验收）** |
| 一句话理由 | 引擎四条口径全绿、转盘（含命定一转）动画与机制真实兑现，但**主线章节触发器重复触发未修好**（终章在客户端连续出现 4 次、第二章至第四章各 2–3 次，5 局实测 5 局复现），直接推翻 ADR-0016「ready 门闩已修」的自述；且**五维评价在玩家端完全不可见**，验收项 C 未达成。 |

---

## 二、四条口径（本人重跑，不采信转述）

| 命令 | 退出码 | 结果 | 覆盖口径 |
|---|---|---|---|
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | 0 | **24 files / 342 tests passed**，18.49s（与期望 342 一致） | 正常/边界/无效输入 + 6 种子自动通关 |
| `pnpm --filter @life-sim/shared test` | 0 | **3 files / 50 tests passed**（与期望 50 一致） | 模板/结局/开局引用完整性 |
| `pnpm typecheck` | 0 | 0 错 | 类型 |
| `pnpm build` | 0 | typecheck + `vite build` 成功，`index-xJzBXlT1.js` 260.84 kB → `apps/web/dist` | 构建 |

服务冒烟：`GET /health` → `{"ok":true,"protocol":"v2"}`；`GET /api/templates` → 唯一模板 `jjk-2006`，两个开局 `op-2006-tokyo` / `op-2006-kyoto`。

**口径结论：4 / 4 PASS。**

---

## 三、DoD 核验表

> 说明：ADR-0016 状态为「已执行（2026-11-12 用户指令：**不走 spec**）」，因此本轮**没有 `tasks.md` 级 `T-*` 完成定义**；下表以 ADR-0016「决策 1–5 + 验证段」与主理人下发的验收项 A/B/C/D 作为 DoD 口径，逐条裁定。

| 完成定义条目 | 结果 | 证据 |
|---|---|---|
| D1 开局 = 13 步转盘，每步有真实机制后果（unlockSkill/grantItem/applyStatus/adjustAttribute/adjustRelation/flag） | PASS | 13 步交互全部有选项且推进正常（`ui-e2e-result.json.creation`）；技能页见「十种影法术」、背包见「咒具·天逆鉾」「观察者护符」、状态芯片见「咒力质感/觉悟/梦魇」（截图 13/14/15） |
| D2 末步「命定一转」= `kind: random`，前端命运之轮动画真实渲染并给出结果 | **PASS（重点）** | `events.yaml:473-514` 为 `kind: random` 6 扇区转盘；UI 实测转子 `transform` 逐帧变化、约 2.52s 缓出落定、结果「一件旧遗物」落在扇区标签集合内、命中扇区恰好 1 个高亮（截图 10/11、`wheel-probe.json`） |
| D3 行动转盘：巡逻/探索挂 `action-hook → kind: random`，扇区直连战斗/奖励 | PASS | 巡逻 1 次点击即出「巡逻遭遇」转盘（seed 7「无事发生」/ seed 3「一级咒灵」）；探索 1 次点击即出「探索遭遇」（「旧书与笔记」）；`events.yaml:940-1015` |
| D4 五章主线（星浆体→叛逃→百鬼夜行→涩谷→终章）+ `advanceTo` 跳月，**不得重复触发同一章** | **FAIL** | 章节推进本身可达（1→2→3→4→5→6，day 2/60/180/300/360/415 均到位），但**同一章重复触发**：seed 11 `ch2×2, ch3×2, ch4×3, ch5×4, epilogue×4`；UI seed 7 终章在 t41/43/45/47 连续出现 4 次。详见缺陷 D-01 |
| D5 12 个结局（含隐藏 `end-secret-savior`）由一年积累决胜 | PASS（可达性未全覆盖，见 §七） | `endings.yaml` 声明 12 个；实测走到 `end-secret-savior`（掩码「未公开的结局」）与 `end-geto-saved`（公开「挽留」）；结局面板正常渲染（截图 67、`ui-e2e-result.json.ending`） |
| D6 `evaluation.yaml` 五维（成长/羁绊/功绩/真相/自由）评述 | **FAIL（玩家端不可见）** | 引擎侧 5 维均已评分（`archive.evaluation.dimensions` 5 项），但 `snapshot.evaluation` 只下发 `summary`+`canonDeviation`；页面只渲染一句「本局共记录 N 条经历，5 项维度已评分。」，`fiveDimWords=[]`。详见缺陷 D-02 |
| D7 确定性：同初始状态 + 同输入 + 同 seed ⇒ 相同结果 | PASS | seed 7 同脚本跑两遍：`creation / wheels / chapters / chapterCounts / turns / ending / evaluation / flagsAtEnd / counters` **逐字段一致**，唯一差异是世界 id 字符串（见 §五-1） |
| D8 未引入 Lifecycle 状态机 / 未残留 V1 符号 | PASS | `grep -rn "evaluateLife\|advanceTurn(\|lifecycle\|PhaseTransitionLog" packages apps` 仅命中 `boundary.test.ts` 的自检断言与 V2 的 `evaluateLifeV2`；无 `lifecycle.ts` |
| D9 `npcs[].relations` 仅 known/inferred，无 hidden | PASS | 玩家端快照全量扫描：`relationVisibilities = ["known"]`，26 条边、7 个 NPC，无 `hidden`/`unknown` |
| D10 旧档拒载可诊断 | PASS | 以仓库 `data/worlds/` 的 11 份旧档启动：`worlds_loaded {loaded:0, skipped:11}`，逐条 `save_skipped`：8× `schema_version_mismatch: 1`、3× `template_fingerprint_mismatch`；`GET /api/worlds` 返回 `{"worlds":[]}` |
| D11 刷新续档正常 | PASS | 会话内 reload 后时间/轮次不变；**全新浏览器 profile**（无 localStorage）→ 首页列出 9 个存档 → 打开 → `第13轮 2006年1月1日`、行动面板 8 个按钮复原 |

---

## 四、UI 逐项观察（真实 headless 运行，非目测）

### A. 开局 13 步（`D:\code\_v2-e2e\scripts\ui-e2e.mjs`，seed 7）

入口 `ev-opening-wheel`（「命数转盘 · 开局」，仅 1 个选项「转动命数转盘，书写此身」）→ 12 个选项步 → 末步「命定一转」转盘。共 13 个「命」步骤 + 1 个入口 = 14 次交互，与 ADR 的 13 步清单一一对应。

| # | 步 | 选项数 | 本局所点 | 世界时间 |
|---|---|---|---|---|
| 入口 | 命数转盘 · 开局 | 1 | 转动命数转盘，书写此身 | 2006-01-01 |
| 1 | 出身 | 4 | 东京·普通上班族家庭 | 2006-01-01 |
| 2 | 咒力资质 | 4 | 咒力压倒性地多 | 2006-01-01 |
| 3 | 生得术式 | 6 | 十种影法术 | 2006-01-01 |
| 4 | 术式的应用 | 3 | 把术式推到「领域」的边界 | 2006-01-01 |
| 5 | 咒具 | 4 | 天逆鉾 | 2006-01-01 |
| 6 | 战斗风格 | 3 | 贴身肉搏 | 2006-01-01 |
| 7 | 性格 | 3 | 冷静、少话 | 2006-01-01 |
| 8 | 师承 | 4 | 五条悟 | 2006-01-01 |
| 9 | 入校的动机 | 4 | 报仇 | 2006-01-01 |
| 10 | 代价 | 4 | 名声 | 2006-01-01 |
| 11 | 人设 | 3 | 开口就是名台词 | 2006-01-01 |
| 12 | 预兆 | 3 | 悬在半空的身影与染血的长廊 | 2006-01-01 |
| 13 | **命定一转**（`kind: random`） | 0（转盘） | 转盘结果「一件旧遗物」 | 2006-01-01 |

- 每步选项数 ≥ 1（`creationMinOptions=1`），点完自动进下一步，**无卡死、无空白屏、控制台与网络 0 报错**。
- 真实后果抽查 3 类全部落到面板：
  - `unlockSkill`（生得术式·十种影法术）→ 个人页「技能」可见 **十种影法术**（截图 `14-personal-skills.png`）
  - `grantItem`（咒具·天逆鉾 / 观察者护符）→ 个人页「背包」5 种物品可见 **咒具·天逆鉾**、**观察者护符**（`15-personal-bag.png`）
  - `applyStatus`（预兆→梦魇等）→ 角色页状态芯片 **咒力质感 / 觉悟 / 梦魇**（`13-personal-character.png`）

### A3. 末步「命定一转」——本轮最关键的 UI 变更：**转盘动画真实存在并给出结果**

观察到的实际渲染形态（`11-creation-14-settled-一件旧遗物.png`、`p01..p03`）：

- 结构：`命运之轮`（kicker）→ 标题 `命定一转` → SVG 圆形转子（6 个扇区，扇区面积按 weight 等比 60/90/90/60/30/30）+ 固定顶部指针 + 中心 `命` 字轴心 + 外双金环。
- 动画：转子 `transform` 在 250ms 采样间隔内连续变化并在末段收敛（`matrix(0.86,0.51…)` → `(0.55,0.83…)` → `(0.28,0.96…)` → `(0.10,0.99…)` → `(0.02,0.99…)` → `matrix(0,1,-1,0)`），即真实的 2.6s 缓出旋转；落定耗时实测 **2511–2537 ms**（13 次转盘全部 ≈2.5s）。
- 落定后：指针所指扇区高亮（`.wheel-label.hit` 计数 = 1），下方出现结果文字 `一件旧遗物` 与「继续」按钮；旋转中显示「轮盘转动中…」。
- 结果正确性交叉验证：seed 7 下 API 直连（无 UI）得到 `ev-w13` 的 `wheelResult.label = 一件旧遗物`，与 UI 显示完全一致；几何校验 `target = 1440 + (360-270) ≡ 90°`，与最终 `matrix(0,1,-1,0)`（=90°）吻合，说明指针指示与结果一致，不是假动画。

> 结论：**「命定一转只是文字、没有转盘」的说法不成立** —— 前端 `WheelReveal` 完整复用，动画、扇区、指针、命中高亮、结果文字全部到位。

### B. 行动遭遇转盘 + 战斗（`ui-battle-probe.mjs` / `ui-battle-result.mjs`，seed 3）

| 项 | 结果 |
|---|---|
| 点「巡逻」 | 第 1 次即触发「巡逻遭遇」转盘（6 扇区），命中「一级咒灵」 |
| 命中战斗扇区 → 进战斗 | `.battle-body` 出现：「⚔ 战斗 · 第 1 回合」、敌人「一级咒灵」、技能按钮可用（`b02-battle-enter-1.png`） |
| 打完 | 4 回合结束（我方 HP 190→3） |
| 回到自由行动 | 转盘结果卡结束后 `slot-badge=自由行动`、行动面板 8 个按钮复原、轮次 13→15（`b04-back-to-action-1.png`） |
| 战果是否可见 | 可见，但位于「本轮还发生」区：`⚡ 战斗胜利 / 你击溃了敌人，尘埃落定。`（`c02-battle-result-bottom.png`，需滚动，页面高 1195 > 视口 932） |
| 探索 | 第 1 次即触发「探索遭遇」，命中「旧书与笔记」（智力+1、护符×1） |

未触发统计：本轮 **巡逻 1 次点击 / 1 次转盘，探索 1 次点击 / 1 次转盘**，不存在「多次点击都不触发」；另在 API 回归里探索点击 1 次时转盘结果被日常事件覆盖（见 D-03）。

### C. 五章与结局（`ui-e2e.mjs` 脚本化推进，seed 7；API 交叉验证 seed 3/5/7/11）

- 章节推进数值正确：`flags.chapter` 1→2→3→4→5→6；`advanceTo` 落点 day 2 / 60 / 180 / 300 / 360 / 415；终局 `timeReached` 在 day 420（第 49–60 轮）收束，符合 ADR「40–80 回合跑完一年」。
- **但「advanceTo 后是否重复触发同一章」= 未修好**（本轮 P0 缺陷，详见 D-01）：
  - UI（seed 7）实见：`终章·你成为了谁` @t41 / t43 / t45 / t47，`终章·落幕之前` @t42 / t44 / t46 / t48 —— 玩家被迫把终章与落幕各点 4 遍。
  - API（seed 11）实见：`ev-ch2-crisis 2 次 / ev-ch3-night 2 次 / ev-ch4-shibuya 3 次 / ev-ch5-finale 4 次 / ev-epilogue 4 次`；seed 7 `ch5-finale 2 次`；seed 3 `ch5-finale 2 次`；seed 5 `ch2 2 / ch3 2 / ch4 3 / ch5 4`。**5 局 5 局复现，最少 2 次、最多 4 次。**
- 结局展示：`ending-card` 正常，含标题/摘要/「第 59 轮 · 条件达成 · 隐藏结局」/「封存这一生」按钮（`67-ending.png`）。
  - 隐藏结局 `end-secret-savior` 按 ADR-0006 掩码为「未公开的结局 / 有一个不会出现在公开名录里的结局被达成了。」（符合设计，非缺陷）
  - 公开结局实测 `end-geto-saved` → 真实文案「挽留」，未误用掩码。
- **评价五维：玩家端不可见** —— 页面只有 `本局共记录 335 条经历，5 项维度已评分。`，`fiveDimWords=[]`（成长/羁绊/功绩/真相/自由 一个都没有出现）；`archive` 响应里确实有 5 个维度（全 `100/高`），但前端把响应丢弃（见 D-02）。

### D. 回归项

| 项 | 结果 | 证据 |
|---|---|---|
| `npcs[].relations` 无 hidden | PASS | 玩家端快照 JSON 全量扫描 `hidden` 出现 **0 次**；关系可见性集合 `["known"]`；历史条目 76 条全 `public` |
| 旧档拒载 | PASS | `worlds_loaded {loaded:0, skipped:11}`；8× `schema_version_mismatch: 1`、3× `template_fingerprint_mismatch`；`/api/worlds` 空 |
| 刷新续档 | PASS | 会话内 reload 后未回到首页（`hasSetup=false`），仍显示世界视图与 `2007年2月25日`；全新 profile（无 localStorage）下首页列出 9 个存档、可打开并还原 `第13轮 2006年1月1日` 与 8 个行动按钮（`r02-resumed.png`） |
| 面板无白屏 | PASS | 终局后 `bodyLen` 正常、无 `banner.error`；全程 0 console error / 0 页面异常 |

---

## 五、专项检查

| 检查项 | 结果 | 证据 |
|---|---|---|
| 确定性可重现 | PASS | seed 7 两跑全字段一致（仅 worldId 不同）；UI 与 API 在同 seed 下同一转盘得同一结果「一件旧遗物」 |
| DEFERRED/RETIRED 未混入范围 | **N/A** | 本轮 `R-TT-01..07` / `R-LC-01..06` 未被触碰；无 `tasks.md`（ADR-0016 明确「不走 spec」），无法登记 DoD 追溯 |
| V1 残留符号 | PASS | 残留扫描仅命中 `boundary.test.ts` 自检与 V2 `evaluateLifeV2`；无 `lifecycle.ts` / `Phase` |
| 未引入 Lifecycle 状态机 | PASS | 同上；`WorldStateV2` 无阶段字段 |
| hidden 未进入玩家端 API | PASS | 快照/历史/归档玩家投影 `hidden` 命中 0；隐藏结局仅以掩码文案出现 |
| LLM 未成为状态裁判 | PASS | 结局/评价/转盘均纯函数（`resolveEnding`/`evaluateLifeV2`/`pickIndex`），本轮无 LLM 调用 |

---

## 六、缺陷清单

| # | 严重度 | 问题 | 位置 | 复现步骤 | 证据 |
|---|---|---|---|---|---|
| **D-01** | **P0 阻断** | **主线章节触发器重复触发**：同一章事件在待决期间被再次抽中并再次入队，玩家被迫重玩章节选择，终章与落幕可连出 4 次 | 模板：`specs/data/templates/jjk-2006/events.yaml:1133-1146`（ch1 条件）、`1312-1321`（ch2）、`1488-1497`（ch3）、`1591-1600`（ch4）、`1693-1702`（ch5）——五章均无 `once: true`，`readyN` 只在**选项 effects** 里清零（如 `1152`、`1330`）；引擎：`packages/game-core/src/v2/turn.ts:320-345`（`random/normal` 立即入队）、`:714/:843/:886/:973`（每轮 drain 重新做 pool 抽取），无「同一事件不得重复入队」护栏 | ①`POST /api/worlds {seed:11}` → ②按脚本点完开局 → ③每次 `triggeredEvents` 里统计 `ev-ch*` 次数 | `api-play-seed11.json.chapterCounts = {ch1:1,ch2:2,ch3:2,ch4:3,ch5:4}`；`api-play-seed5-first.json` 同型；UI `ui-e2e-result.json.chapters` 终章 4 连发；截图 `48..58-chapter-*`、`56-chapter-17-终章…png` |
| **D-02** | **P1** | **五维人生评价在玩家端完全不可见**（验收项 C 未达成）：引擎算了 5 维，投影只下发一句 `summary`，前端也不消费归档里的 `dimensions` | 投影：`packages/game-core/src/v2/projection.ts:183-186`；前端渲染：`apps/web/src/main.tsx:573`、`:1459`、`:1752`（只有 summary / 偏离度）；归档响应被丢弃：`apps/web/src/main.tsx:271-279` + `apps/web/src/api.ts:143-145`（`archive: unknown`）；数据其实存在：`packages/game-core/src/v2/archive.ts:25,63-68` | 走到结局 → 看结局页/世界页/封存后页面 | `ui-e2e-result.json.evaluationShown = {fiveDimWords: [], bodyHasDimensions: false}`；`api-play-result.json.archive.evaluationDims` 有 5 项（growth/bonds/deeds/truth/freedom）；构建产物 grep「羁绊」「功绩」= 0 命中 |
| D-03 | P2 | **单轮多个转盘事件时 `wheelResult` 单槽覆盖**：同一轮里先触发的转盘结果被后触发的覆盖，玩家看不到其中一次（效果照常结算） | `packages/game-core/src/v2/turn.ts:332-337`（`result.wheelResult = {...}` 后写覆盖，唯一槽位） | seed 5 一局：点「探索」→ 同时触发 `ev-explore-wheel` 与 `ev-daily-fortune` | `api-play-seed5-first.json`：turn 57 `events=[ev-explore-wheel, ev-daily-fortune]`，但 `wheelResult=ev-daily-fortune=平`；`patrol/explore` 统计里 `explore.wheels=0` |
| D-04 | P3 | **开局 13 步期间被日常池事件插入**：`ev-daily-fortune`（今日运势转盘）在开局第 2/5 回合就触发，打断「转盘定命」的叙事纯度 | `specs/data/templates/jjk-2006/events.yaml:521-528`（pool 概率 0.25、无 `w13`/`creationDone` 门控） | 建世界后走完开局 | `api-play-result.json.counters.ev-daily-fortune=3`，其中一次发生在开局第 5 步（`wheels[0]` label `choose:ev-w04`）；UI 截图 `07/08-creation-6-*` |
| D-05 | P3 | **转盘「继续」按钮被固定底栏遮挡**：按钮 rect `867–903`，`.tabbar` `position:fixed; top:872; h:60` → 需先滚动 70px 才能点到 | `apps/web/src/main.tsx:875-877` + `apps/web/src/style.css:652`（`.wheel-foot`）、`apps/web/src/style.css:458-459`（`.tabbar { position: fixed }`），页面无对应底部留白 | 任意随机事件 → 落定后不滚动直接点「继续」 | `wheel-probe.json.rects = {viewportH:932, docH:1002, btn:{top:867,bottom:903}, tabbar:{top:872,position:"fixed"}, overlap:true}`；滚动 70px 后 overlap=false |
| D-06 | P3 | **五维评分饱和**：`ranges:[−50,100]` 下 5 维全部打满 `100/高`，评价失去区分度（3 局样本同型） | `packages/game-core/src/v2/life-evaluation.ts:134-146`（`rawScore` 无归一/上限裁剪）+ `evaluation.yaml` 区间 | 任意走完的一生 → 封存 → 看 `archive.evaluation` | seed 7/3/11 三局 `dimensions = growth/bonds/deeds/truth/freedom = 100/高`，`overall=100` |
| D-07 | P3 | **章节进度对玩家不可见**：`V2Snapshot` 无 chapter 字段，前端无任何章节指示，只能靠事件标题猜 | `packages/shared/src/v2.ts`（快照键集合）、`apps/web/src/main.tsx`（grep「章节/chapter」0 命中） | 任意时刻看顶部栏/世界页 | `regression.json.snapshotKeys` 无 `chapter`；`ui-e2e-result.json` 中章节仅来自事件标题 |
| D-08 | P3 | **战斗中道具按钮不按控制类补正禁用**：被 `cannot_use_items`（如力竭/束缚）压制时按钮仍可点，引擎回 400 `bound_items`，前端弹错误横幅 | 前端 `apps/web/src/main.tsx:1018-1028`（只判 `busy`）；引擎 `packages/game-core/src/v2/battle.ts:520` | 排到夜间战（`ev-night-fight`）且角色带 `cannot_use_items` → 低 HP 时点「急救包」 | `api-play-result.json.battles[2].rejected` = `item:… 400 {"error":"bound_items"}`（seed 7 两跑均复现） |
| D-09 | P3 | **刷新后转盘结果不可回顾**：`snapshot.lastWheel` 已持久化，但前端只用瞬态 `lastResult.wheel`，reload 后转盘画面消失（只剩历史里的文字事件） | `packages/shared/src/v2.ts:250`（`lastWheel` 有投影）vs `apps/web/src/main.tsx:621`（只读 `lastResult.wheel`） | 转盘刚结算时立即刷新 | `ui-regression.mjs` 打开刚停在命定一转的存档，落地即行动面板、无转盘区 |

### 建议修复方向（不由 QA 修）
- D-01：给五个章节触发器加 `once: true`（`hasFired` 在 fire 时记事实，能挡重复入队，见 `v2/scheduler.ts:157-158`），或把 `readyN` 改成「触发即消费」（引擎新增 `onFire` 效果位）；并建议补一条**回归断言**：单局内每个 `ev-ch*` 的触发次数 ≤ 1（现有 `v2/playthrough.test.ts:51` 只记录 chapter 数值变化，看不出重复）。
- D-02：`projectSnapshotV2` 增投影 `dimensions:[{id,label,score,level}]`，前端在结局页/世界页渲染五维；归档响应别丢。
- D-03：`wheelResult` 改为数组或按事件 id 索引，保证同轮多个转盘都能呈现。

---

## 七、未覆盖 / 未验证项（显式声明）

1. **12 个结局只实测 2 个**（`end-secret-savior` 隐藏、`end-geto-saved` 公开）。其余 10 个（含 `end-death`）**未逐一走到**；仅有 `shared` 的引用完整性测试与 `playthrough.test.ts` 6 种子间接覆盖——**未验证**。
2. **死亡线未验证**：ADR 自述「死亡结局依赖战败+受伤，自动对局样本未触发」；本轮 5 局亦未死，`end-death` **未验证**。
3. **`op-2006-kyoto` 未走 UI**：UI 只用 `op-2006-tokyo`（默认开局）；京都开局仅由引擎测试覆盖，**未验证**其 UI 表现。
4. **真机 / 触屏手势未验证**：全部在 headless Chrome 430×932@2x 下完成，未上真机，未测滚动惯性、安全区、iOS Safari。
5. **性能未测**：帧率、长历史（267–335 条）渲染耗时未量化。
6. **坏档类型只验 2 类**：只验了 `schema_version_mismatch` 与 `template_fingerprint_mismatch`；`json_parse_failed` / `state_schema_invalid` 两类坏档**未构造验证**（代码路径存在，未实测）。
7. **多标签/并发写未验证**：两个页面同一存档同时操作未测。
8. **NPC 自主行动 / AI 决策**只做了间接观察（历史里有 `npc_action` 条目、关系值随交往上涨），未做逐条规则核验。
9. **节奏观察（非缺陷，供决策）**：一局 49–60 轮里**玩家自由行动只有 7 次**，其余全是点剧情/转盘；ADR 宣称的「日常 13 池事件」在自动对局里实际只出现 4–6 种。若目标是「选择驱动」，这个比例值得复核。

---

## 八、总体结论

- **引擎与构建面：全绿。** 342 + 50 测试、typecheck、build 全通过；确定性、hidden 隔离、V1 残留、旧档拒载、续档均 PASS。
- **UI 面：转盘系统是真兑现的**（13 步开局、末步命定一转真实动画、行动遭遇转盘、扇区直连战斗并可打完回到自由行动），这部分比 ADR 自述的「已知缺口」更好。
- **但两条硬伤必须先修**：D-01（主线章节重复触发，玩家可见、5 局 5 复现、与 ADR「已修」自述直接冲突）、D-02（五维评价玩家端不可见，验收项 C 未达成）。

**裁决：退回。** 修完 D-01、D-02 后请重跑 §二 四条口径 + 本报告的 `ui-e2e.mjs`（会重新给出章节重复与五维展示的判定），再提交复验。D-03..D-09 建议同批处理，但不单独作为退回理由。

---

## 九、复现资产

| 用途 | 路径 |
|---|---|
| UI 全流程（13 步 / 行动 / 五章 / 结局 / 续档） | `D:\code\_v2-e2e\scripts\ui-e2e.mjs` → `D:\code\_v2-e2e\ui-e2e-result.json` |
| 命定一转动画与「继续」遮挡专项 | `D:\code\_v2-e2e\scripts\ui-wheel-probe.mjs` → `wheel-probe.json` |
| 巡逻转盘→战斗→回到自由行动 | `D:\code\_v2-e2e\scripts\ui-battle-probe.mjs` → `battle-probe.json` |
| 战斗战果呈现 | `D:\code\_v2-e2e\scripts\ui-battle-result.mjs` → `battle-result.json` |
| 投影回归（hidden / relations / 续档） | `D:\code\_v2-e2e\scripts\ui-regression.mjs` → `regression.json` |
| API 全流程与种子对比（含确定性比对） | `D:\code\_v2-e2e\scripts\api-play.mjs` → `api-play-result.json`、`api-play-seed7-b.json`、`api-play-seed3.json`、`api-play-seed11.json`、`api-play-seed5-first.json` |
| 旧档拒载日志 | `D:\code\_v2-e2e\server-3000b.log`（`save_skipped` × 11） |
| 截图（共 70+ 张） | `D:\code\_v2-e2e\shots\`；关键：`11-creation-14-settled-一件旧遗物.png`（命定一转落定）、`10-creation-14-spinning.png`（旋转中）、`14-personal-skills.png`、`15-personal-bag.png`、`13-personal-character.png`、`b02-battle-enter-1.png`、`b04-back-to-action-1.png`、`c02-battle-result-bottom.png`、`67-ending.png`、`56-chapter-17-终章·你成为了谁.png` |

---

## 十、复验 R-02（HEAD `3db902c`）

- **触发**：主理人转交 `fix(template,D-01,D-04)` + `feat(D-02 引擎投影)` + `feat(D-02 web 渲染)` 三个提交，要求复验。
- **复验对象**：
  - `ce6fbcc` fix(D-01/D-04)：五章触发器加 `once: true`、`ev-daily-fortune` 加 `time >= 1 hour` 闸、`playthrough.test.ts` 新增 `chapterFires` 护栏
  - `5612ebc` feat(D-02 引擎)：`EvaluationDimensionResult` 增 `label`；`V2Snapshot.evaluation` 增 `dimensions[]` / `overall`；`projection.ts` 透出
  - `3db902c` feat(D-02 web)：`EvaluationBreakdown`（人生页玩家卡 + 个人→角色属性面板）、归档改用 `archive.snapshot`
- **环境**：HEAD `3db902c`（工作区仅本报告 untracked）；独立数据目录 `D:/code/_v2-e2e/data-r2`，截图 `D:/code/_v2-e2e/shots-r2`

### 10.1 四条口径（重跑）

| 命令 | 结果 |
|---|---|
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | **342 passed / 24 files**，17.51s ✅ |
| `pnpm --filter @life-sim/shared test` | **50 passed / 3 files** ✅ |
| `pnpm typecheck` | exit 0，0 错 ✅ |
| `pnpm build` | exit 0，dist `index-BcC51XdD.js` 262.29 kB ✅ |

### 10.2 缺陷状态变化

| 原编号 | 复验结论 | 证据 |
|---|---|---|
| **D-01 章节重复触发** | **已修复，复验 PASS** | 见 10.3 |
| **D-02 五维评价不可见** | **已修复，复验 PASS**（引擎 + UI 两端） | 见 10.4 |
| **D-04 开局被日常池插入** | **已修复，复验 PASS** | 见 10.3 |
| D-05 转盘「继续」被底栏遮挡 | **未修复且恶化**（并入 D-10） | 见 10.5 |
| D-06 五维评分饱和 | **维持 P3，表述修正**：满年局（49–60 轮）仍 5 维全 100（新代码 3/3 复现）；短命局（34 轮）有区分度 `46 / 89.5×4` | `r2-archived.json`、`r2-ui-result.json` |
| D-03 / D-07 / D-08 / D-09 | 本轮未动，维持原判定 | — |
| **D-10（新）** | **P1 回归：评价分项占 367px，把主交互区挤出首屏** | 见 10.5 |
| **D-11（新）** | **P2 内容：死亡判据过宽 —— 2 回合「轻伤」+ 主动结束 = 「战殁」** | 见 10.6 |

### 10.3 D-01 / D-04 复验：PASS

**D-01（章节重复）** 三条独立证据链，结论一致：

1. **API 触发计数**（`triggeredEvents` 逐响应累计，3 个种子）：`chapterCounts` 全部为 1，`dups` 中不再出现任何 `ev-ch*` / `ev-epilogue`
   - seed 11：`{ch1:1,ch2:1,ch3:1,ch4:1,ch5:1}`（修复前同种子为 `ch2:2,ch3:2,ch4:3,ch5:4,epilogue:4`）
   - seed 5、seed 3 同为全 1
2. **事实层 `eventFires`（append-only，与上面不同数据源）**：3 个满年存档均 `ev-ch1..ch5 + ev-epilogue` 各 1 条
3. **UI 层**（seed 7 实际点完）：`第一章·星浆体 ×1、第二章·村庄 ×1、第三章·百鬼夜行 ×1、第四章·涩谷事变 ×1`，无重复弹章

**护栏有效性**：`playthrough.test.ts` 新增断言读 `state.eventFires` 统计 `ev-ch\d-* / ev-epilogue` 次数 ≤1 且 `ev-ch1-call` 恰为 1（`ce6fbcc` diff）。这条断言正是原来缺失的口径（旧 `chapterFires` 式的「chapter 数值变化」看不出重复）。我未做「剥掉 once 看是否变红」的负向验证（会改产品代码，超出 G5），但两次独立数据源都给出 1，可交叉印证。

**D-04（开局被日常池插入）**：3 个种子的开局 13 步期间**没有任何 `ev-daily-fortune`**；首次转盘为 `choose:ev-w12 ⇒ ev-w13`（命定一转，预期内）。`ev-daily-fortune` 首次出现于第一个自由行动之后（`act:rest` 等），符合 `time >= 1 hour` 的设计意图。

### 10.4 D-02 复验：PASS（引擎投影 + UI 渲染 + 归档路径）

**引擎/投影**：`GET /api/worlds/:id` 的 `snapshot.evaluation` 现为
```
{ summary, canonDeviation, dimensions:[{id,label,score,level,explanation}×5], overall }
```
`label` 为模板中文名（成长/羁绊/功绩/真相/自由），与 `evaluation.yaml` 一致；`overall` 为加权总分。

**UI（430×932，真实链路）**：

| 检查 | 结果 |
|---|---|
| 人生页玩家卡出现「评价分项」 | 5 行 + 「综合·总评」，顺序 成长/羁绊/功绩/真相/自由 |
| 每行内容 | 中文名（模板 label）+ 等级胶囊（中/高）+ 服务端原值（46 / 89.5…）+ 条形（宽度=score 截断归一） |
| 个人 → 角色 属性面板 | 同区块存在（`blockCount=1`、5 行） |
| 解释默认收起 / 点击展开 | `details.open=false` → 点击后 `open=true` 且 `.eval-dim-expl` 可见（「基于 26 条过程记录与维度规则确定性评分。」） |
| 结局后仍展示 | 5 行 + 总分 87.04（战殁局）、100（满年隐藏结局局） |
| 封存后仍展示（归档路径） | 5 行 + 总分 83.34，`.ending-card .tag=本局已封存`、出现「已归档，只读」 |
| 不再多发一次 GET | 抓包：点「封存这一生」后**只有** `POST /api/worlds/:id/archive`，无 `GET /api/worlds/:id` |
| 无 `undefined` / `NaN` 泄漏到界面 | 结局态与归档态均 `bodyHasUndefined=false` |
| 评价未生成（`dimensions` 缺省）时不渲染空块 | 代码路径可信（`dims.length===0 → null`），但**未实测**：引擎始终产出 dimensions，构造缺省需 mock，未做 |

结论：D-02 在「引擎投影 → 前端渲染 → 归档复用」三段都成立，原缺陷关闭。已知取舍（由前端声明、我确认范围可接受）：条形宽度为 0–100 截断**展示近似**（投影不下发每维区间），负分条长为 0 但数值/等级是服务端原值；标题用「评价分项」而非「五维」（多模板下不撒谎）。两者均属展示层取舍，不构成缺陷。

### 10.5 D-10（新，P1 回归）：评价分项把主交互区挤出首屏

`3db902c` 给玩家卡加了一块 **367px** 高的「评价分项」（5 行 details + 总评 + 提示），430×932 实测（scrollY=0）：

| 元素 | 位置 | 结论 |
|---|---|---|
| 玩家卡 | top 70 → **bottom 848** | 首屏被玩家卡占满 |
| 评价分项块 | 466 → 833（**height 367**） | 占视口 39% |
| 事件区 `.slot-area` | top **860** | 起于首屏底部，仅剩 72px |
| 行动按钮组 `.action-body .action-grid` | **917 → 1119** | 全部落在固定底栏（top 872）之下 ⇒ 首屏看不到 |
| 转盘 `.wheel-dial` / `.wheel-continue` | 992–1224 / **1272–1308** | 完全在视口外，需滚 637px 才可见 |

对比修复前（同一设备）：`docH 1002`、转盘「继续」按钮 `867–903`（可见但被底栏压住一角）。**修复后 `docH 1569`，主交互区整块下沉约 560px**。`.slot-area` 是 `position: relative`（`style.css:635-640`），不是 sticky，所以必须滚动才能操作。

> **基线勘误（R-04 重测）**：上面这组 `1002 / 867–903` 来自**创角期的「命定一转」**画面（玩家卡上状态芯片与物品更少），与「自由行动/巡逻转盘」不是同一槽位状态。为免用错基线，我做了同槽位 A/B：在同一页面同一状态下，把 `.eval-dims` **隐藏**（等价于 D-02 之前的布局）与**压成 48px 摘要**（A 方案模拟）分别测量（`scripts/r4-baseline-compare.mjs` → `r4-baseline-compare.json`）：
>
> | 槽位状态 | 评价块原样 | 隐藏（≈D-02 前） | 48px 摘要（A 方案） |
> |---|---|---|---|
> | 自由行动面板 | docH 1594 / slot.top 860 / 首个按钮 917 | docH **1215** / slot.top 481 / 首个按钮 **538–600** | docH 1275 / slot.top 541 / 首个按钮 **598–660** |
> | 巡逻转盘（已落定） | docH 1569 / slot.top 860 / 「继续」1272 | docH **1190** / slot.top 481 / 「继续」**893–929** | docH 1250 / slot.top 541 / 「继续」**953–989** |
>
> 结论：**同槽位的真实基线是 1190–1215，不是 1002**；评价块净高约 **379px**。A 方案（48px 摘要）能一次把行动面板救回首屏（首个按钮 598–660，全部在底栏 872 之上）。但转盘「继续」在 A 方案下仍是 953–989（整块在视口外）——注意它在**基线态**也只有 893–929（与底栏 872 重叠），也就是说「转盘按钮需滚动」早在 D-02 之前就存在，属 D-05，不是 D-10 的回归判据。

截图证据：`shots-r2/L2-action-panel-scroll0.png`（首屏只有玩家卡 + 评价分项，事件区完全不可见）、`L3-patrol-wheel-scroll0.png`（转盘在首屏外）、`L4-patrol-wheel-scrolled.png`（滚到底 637px 后才看到「继续」）。多宽度无横向溢出（375/320 均 `scrollWidth == innerWidth`）。

> 复核前端提供的「净空 24px」：该数值测的是**玩家卡底边 848 vs 底栏 872**，与主交互区是否可见是两件事，不构成 D-05 已修的证明。D-05 的原始现象（转盘「继续」不可直接点击）在修复后**加重**为「整块在视口外」。

**建议**：整块默认折叠为一行（如「评价分项 5 项 · 综合 79.06 ▾」）点开展开；或只在终局/归档视图展示；或压成两列紧凑网格。修完只需重跑 `r2-layout-probe.mjs`（首屏可见性断言）+ 一条主链路即可复验。

### 10.6 D-11（新，P2）：死亡判据过宽，主动结束被判「战殁」

- **配置**：`endings.yaml:34-44` `end-death`（战殁）的 `triggerConditions` 只有 `{ status: injured-sim, present: true }`，`priority: 60`；`deathRoute.deathMode: direct` 同一条件。判据**不看终止原因、不看伤势严重度**。
- **可被非终局途径附加**：`injured-sim` 除百鬼夜行/涩谷战败外，还能由「命定一转 · 旧伤复发」（`events.yaml:505-509`）与「探索 · 陷阱」（`events.yaml:1005-1009`）施加；本补正只是「轻伤」，`duration: {turns: 2}`（`statuses.yaml:36-39`）。
- **实测复现**：seed 5 建局，命定一转抽到「旧伤复发」（`flags.w13=旧伤`，`injured-sim` turnsLeft=1），创角完成即点「结束这一生」→ 结局标题 **「战殁」**、文案「你在咒灵的交锋中败下阵来。伤太重，这一次没能站起来。」，而 meta 显示 **「第 14 轮 · 主动收束」** —— 文案与事实冲突。
- 证据：`r2-archive-path.json`（`ending.title=战殁`、`meta=第 14 轮·主动收束`）、存档 `84b816cc-…`（`termination.source=player`、`endingId=end-death`）。
- 附带影响：ADR-0016 声称「只有百鬼夜行/涩谷战败带 `injured-sim`，与 deathRoute 联动才判死」，该前提在模板层不成立；同理，若玩家在 day 420 收束时身上仍有 `injured-sim`，满年结局也会被 `end-death` 抢走（未单独构造，**未验证**）。
- **建议**：`end-death` 增加来源约束（如 `battleDefeats >= 1` 或专用 flag `severeWound`），或把「轻伤」与「濒死」拆成两个补正，只有后者进 deathRoute。

### 10.7 R-02 裁决

| 项 | 结论 |
|---|---|
| 任务 | D-01 / D-02 / D-04 修复复验 |
| 裁决 | **退回（单点）→ 见 §10.9 更新为「有条件通过」** |
| 理由 | 三条原缺陷均已修复且我用三条独立证据链复验通过（章节触发次数全 1、五维在引擎/UI/归档三处均为真实数据）；但 **D-02 的落地引入了 P1 可用性回归 D-10**：430×932 首屏只剩玩家卡与评价分项，事件区/行动按钮/转盘「继续」全部被推到视口外，玩家每一回合都要先滚动才能操作。功能达标、可用性未达标，故不判可验收。 |
| 仅需修一项 | **D-10**（折叠/挪位评价分项）；修完重跑 `r2-layout-probe.mjs` + `r2-ui-verify.mjs` 即可复验 |
| 需用户裁决 | **D-11**（死亡判据语义：轻伤是否该致死 / 主动结束是否该判战殁）。属内容意图，不由 QA 或实现方单方决定 |
| 维持建议 | D-03（单槽覆盖）、D-06（满年评分饱和）、D-07（章节不可见）、D-08（道具按钮）、D-09（刷新丢转盘结果） |

**R-02 复现资产**：`D:/code/_v2-e2e/scripts/r2-ui-verify.mjs`（五维渲染/展开/结局/归档/章节重复）、`r2-layout-probe.mjs`（首屏可见性 + 多宽度）、`r2-archived-probe.mjs`（分项块高度 + 满年分数）、`r2-archive-probe3.mjs`（归档请求数 + 主动结束路径，含 `window.confirm` 处理）；数据 `r2-ui-result.json`、`r2-layout.json`、`r2-archived.json`、`r2-archive-path.json`、`r2-api-seed{3,5,11}.json`；截图 `D:/code/_v2-e2e/shots-r2/`（01 命定一转、02/03 人生页分项/展开、04 角色页、09 结局分项、10 归档后、L1–L7 布局）。

> 踩坑记录（供后续 e2e 参考）：点「结束这一生」会弹 `window.confirm`，headless 下不处理 dialog 会让 `page.evaluate` 一直挂到协议超时（我第一次就撞上，误判为 UI 冻结）。需 `page.on("dialog", d => d.accept())`。

### 10.8 补测（主理人追问）：评价五维是否「提前泄露走向」

**问题**：D-02 修好后 `dimensions` 是每快照实时算的，于是**建局第一屏（`第 0 轮`，待决事件还是 `命数转盘 · 开局`）就能看到五维**。这算不算提前把走向透给玩家？主理人要求用对照实验取证，不接受推断。

**实测（`scripts/r2-leak-control.mjs` / `r2-leak-control4.mjs` / `r3-ui-eval-parity.mjs`，全部走真实 HTTP + 真实 UI）**

| 实验 | 设计 | 结果 |
|---|---|---|
| ① 开局时刻（同 seed） | 同 seed 连续建两局，什么都不点，只读 `snapshot.evaluation` | **逐字段完全相同**（seed 11、seed 5 各一组，`diff=[]`） |
| ② 创角完成时刻（前缀一致） | 同 seed，创角 13 步用**完全相同**的选项（`creationPicksIdentical=true`），走完再比 | **逐字段完全相同**（`afterCreationDiff=[]`） |
| ③ 同 seed 不同未来 → 不同结局 | 创角完全相同，之后一局走剧情线并会回血，一局恒选第一项且不回血 | seed 11：`end-secret-savior`（52 轮）vs **`end-death` 战殁**（36 轮）；seed 3：`end-secret-savior` vs `end-geto-saved`（46 轮）。**两对开局五维仍逐字段相同** |
| ④ 不同 seed 同一时刻 | seed 11 与 seed 3 的建局快照 | **完全相同** ⇒ seed 不参与评分 |
| ⑤ UI 与 API 一致性 | 开局第一屏读 DOM 行，再拉 `GET /api/worlds/:id` 对比 | `dimsEqual=true`、`overallInTotal=true`（成长 33/中、羁绊 8.25/中、功绩 8.25/中、真相 8.25/低、自由 8.25/低、综合 14.19） |

**开局第一屏的实际数值**（截图 `shots-r2/E1-turn1-eval.png`）：五维 = `33 / 8.25 / 8.25 / 8.25 / 8.25`，`overall 14.19`；点开任一维的解释文案是「**基于 0 条过程记录**与维度规则确定性评分」——即这些数字就是「还没发生任何事」的地板值，`成长 33` 来自初始属性总和。

**结论（安全性）：可接受，不泄露走向。** 依据是实验③——两局在同一开局状态、同一 seed 下，未来截然不同（一个隐藏好结局、一个战殁），但开局五维连小数位都一样；分差只在过程推进后出现，且 `explanation` 明示「基于 N 条过程记录」，评价不读结局类型（`life-evaluation.ts:130-175` 只看过程信号，`phase4-evaluation.test.ts` 有对应断言）。

**建议（可读性，非安全）：倾向「分项延后到终局/归档展示」。** 三点理由，供用户/主理人裁决，我不拍板实现：
1. 设计上五维是「结局后的评述」（`DESIGN_INCREMENT` §5.4：评价输出为对过程的总结），开局显示 8.25 这种「半成品」数字容易被读成「我这局才 8 分」；
2. 开局分项没有信息量（全是地板值），但代价是 **D-10 那块 367px** 把主交互区顶出首屏；
3. 满年局普遍打满 100（D-06），过程中间态曲线本身区分度低。
--- 

### 10.9 裁决更新（R-02 终版）

| 项 | 结论 |
|---|---|
| 任务 | D-01 / D-02 / D-04 复验 + 评价泄露补测 |
| 裁决 | **有条件通过** → **2026-11-12 复验后改判「通过」，见 §10.14** |
| 已关闭 | **D-01**（章节重复：3 条独立证据链全 1）、**D-02**（五维在引擎/UI/归档三处均真实，且与 API 逐字段一致）、**D-04**（开局不再插池事件） |
| 唯一条件 | **D-10**（P1 布局回归：评价分项 367px 把 `.slot-area` / 行动按钮 / 转盘「继续」推出首屏）——修完（默认折叠或改为终局/归档展示）并重跑 `r2-layout-probe.mjs` 通过后，即可判「通过」 |
| 不阻塞（已结） | **D-11**（轻伤 + 主动收束被判「战殁」，文案与事实冲突）——用户 2026-11-12 裁决 **`Won't fix`**（由主理人记录于 ADR-0016「更正 C1」，见 `96cc08c`；QA 未直接参与该裁决），不构成验收阻断；ADR 原文的假陈述已就地标注更正 |
| 补测结论 | 评价**不泄露走向**，开局可见五维属可接受；可读性上建议延后到终局/归档（与 D-10 的修法同向） |
| 维持建议 | D-03 / D-06 / D-07 / D-08 / D-09 |

**补测资产**：`scripts/r2-leak-control.mjs`（开局/创角对照 + 跨 seed）、`r2-leak-control4.mjs`（好结局 vs 坏结局两对）、`r3-ui-eval-parity.mjs`（UI↔API 一致性 + details 隔离：只展开被点那一行 `[false,true,false,false,false]`）；数据 `r2-leak-control{,2,3,4}.json`、`r3-ui-eval-parity.json`；截图 `shots-r2/E1-turn1-eval.png`、`E2-details-second-row.png`。

### 10.10 D-10 复验器就位（自测：当前 HEAD 应判 FAIL）

为避免下次复验再出现「指标选错」，我把 D-10 的判定写成脚本并**在当前未修复的 HEAD 上先跑一遍**，确认这些门确实能区分好坏（而不是一跑就绿）：

`scripts/r5-d10-verify.mjs` —— 一次跑完 8 条门，退出码 0/1 可直接接 CI：

| 门 | 判据 | 当前 HEAD（`3db902c`，未修）自测 |
|---|---|---|
| G1 | `docH ≤ 1320` | **FAIL**（1594） |
| G2 | 折叠态 `scrollY=0` 时 `.slot-area.top ≤ 660` | **FAIL**（860） |
| G3 | 事件/行动/战斗槽位首个可交互元素 `top<872 且 bottom>0` | **FAIL**（action 917–979） |
| G4 | 375×812 无横向溢出；折叠摘要 `height≤60 且 top≥0` | PASS（375==375；无可折叠摘要时跳过严格项） |
| G5 | 展开后 5 行与 API 逐字段一致 + 合计含 `overall` | PASS（79.06） |
| G6 | 5 行默认 `open=false`，点一行只开一行 | PASS（`[F,F,F,F,F]`→`[F,T,F,F,F]`） |
| G7 | 展开态滚到底后首个可交互元素可点到（只验可操作，不验 docH） | PASS |
| G8 | 封存后归档视图仍有五维且只读 | PASS（5 行、`本局已封存`、`已归档，只读`） |

→ **G1/G2/G3 三条红、其余五条绿**：说明这套门对 D-10 是敏感且不误伤的；修复后这三条应变绿、其余不得回退（G5–G8 是防「为修布局把功能改坏」的反向护栏）。

记录值（同一脚本顺带采）：折叠前行动槽位 `docH 1594 / slot 860 / 首按钮 917–979`；巡逻转盘槽位 `docH 1597 / slot 889 / 继续 1300–1336`（滚到底后 635–671、不被底栏遮挡 ⇒ 功能可用，只是要滚）。

### 10.11 D-11 补强证据：同一动作、只差一个「轻伤」

同一次自测里「主动结束这一生」判成了 `end-retire`「提前收束」，与 §10.6 的 `end-death`「战殁」形成干净对照：

| 局 | 主动收束时身上的补正 | 结局 |
|---|---|---|
| `6b28cb96`（seed 3） | `cursed-quality / resolved / sp-omen / special-physique`（**无** `injured-sim`） | `end-retire`「提前收束」 |
| `84b816cc`（seed 5，§10.6） | 含 `injured-sim`（轻伤，`duration: {turns: 2}`） | `end-death`「战殁」+ 文案「你在咒灵的交锋中败下阵来」 |

两者 `termination.source` 都是 `player`、`reason` 都是「终止条件命中：playerRequested（AND）」，唯一差异就是那个 2 回合的轻伤补正 ⇒ **判据与终止原因无关，只与「有没有受伤」有关**，D-11 成立，等用户裁决口径。

**复验器的确定性（R-05 双跑验证）**：同一 HEAD、同一 seed(3)，`r5-d10-verify.mjs` 连跑两次（各建一个新世界，worldId 不同），除 `worldId`/截图路径外**全部字段逐字节相同**：

| 字段 | Run A | Run B |
|---|---|---|
| actionSlot | docH 1594 / slot 860 / first 917–979 | 同 |
| wheelSlot | docH 1597 / slot 889 / 继续 1300–1336 / 滚后 635–671 | 同 |
| narrow(375×812) | 375==375 / 396 / 466 | 同 |
| GATES | G1,G2,G3 FAIL；G4,G5,G6,G7,G8 PASS | 同 |
| 结局（冒烟） | 提前收束（`end-retire`） | 同 |

⇒ 门是**确定性**的：前后对比可直接逐字段比对，出现差异即代表代码或脚本被改过，不是「抖动」。（资产：`r5-run-a.json` / `r5-run-b.json`。）

> 口径提醒：§10.5 表格里巡逻转盘的 `docH 1569 / 继续 1272–1308` 出自 `r2-layout-probe.mjs`（另一个世界、另一段行动历史，玩家卡上的状态/物品不同），**不能与 `r5` 的 `1597 / 1300–1336` 直接相减当抖动**。判 D-10 一律以 `r5-d10-result.json` 为准。

### 10.12 文档更正核对（commit `96cc08c`）

主理人按本报告的 D-01 / D-11 结论更正了 ADR-0016 的两处假陈述（`docs/DECISIONS.md`，仅文档、无代码）。我逐条核对引用是否与我的实测一致：

| 更正项 | ADR 更正内容 | 与我的证据是否一致 |
|---|---|---|
| C1 死亡判据 | 「只有百鬼夜行/涩谷战败带 `injured-sim`」标注为**证伪**；写明 `end-death` 只判 `{status: injured-sim, present: true}`、不看终止原因与轻重；`injured-sim` 还可来自「命定一转·旧伤复发」「探索·陷阱」；seed 5 复现「旧伤复发 → 主动收束 → 战殁」 | ✅ 与我 §10.6 / §10.11 完全一致；`Won't fix` 的用户裁决由主理人记录，我未参与、也不代为确认 |
| C2 ready 门闩 | 「已解决 advanceTo 后重复触发」标注为**证伪**；写明 5/5 种子 `ch2×2/ch3×2/ch4×3/ch5×4/epilogue×4`、根因是 `readyN` 仅在结算时清；实际修法 `once: true` + `chapterFires` 护栏 | ✅ 与我 §10.3 一致（含我给的种子计数与修法方向） |

→ 这两处更正**没有夸大或误引** QA 结论，也没有把我的「建议」写成「已实施」。D-11 由「待裁决」改记为 `Won't fix`（不阻塞），本报告 §10.9 已同步。

> 状态快照（本次收尾时）：HEAD `96cc08c`；`apps/web/src/main.tsx` 处于未提交修改状态（D-10 修复进行中，**我不在改动中途判它**）；3000 端口上运行的是**他人**的服务（我起的服务均已停止），故未做任何干预。

### 10.13 D-10 改判 B 方案（只在结局/归档展示）后的判据与基线

**用户裁决**（2026-11-12，经主理人转达）：D-10 采用 **B 方案 —— 评价分项只在「结局页 / 归档页」展示，跑动中不出现**。因此原 A 方案（折叠摘要行）的判据作废，改为 G0–G8：

| 门 | 判据 | 说明 |
|---|---|---|
| **G0** | **跑动中 DOM 不存在评价块**：`.eval-dims` 查不到，或存在但高度为 0（两态皆接受） | B 方案的核心断言；在**创角中途 / 自由行动 / 转盘落定**三处各抽一次 |
| **G1** | `docH ≤ 1320` | 冒烟阈值，见下基线 |
| **G2** | `scrollY=0` 时 `.slot-area.top ≤ 660` | |
| **G3** | 事件 / 行动 / 战斗槽位首个可交互元素 `top < 872 且 bottom > 0` | **转盘槽位不设门**（属 D-05，见 §10.5 勘误） |
| **G4** | 375×812 无横向溢出（`scrollWidth == innerWidth`） | B 无摘要行，原「摘要 height≤60 / top≥0」作废 |
| **G5** | 结局页出现 **5 行分项 + 综合·总评** | 场景从「跑动中」改到「结局页」 |
| **G6** | 结局页 5 行与 `GET /api/worlds/:id` 的 `dimensions` **逐字段一致**，合计含 `overall` | |
| **G7** | 5 行默认 `open=false`；点一行只开一行且解释可见 | |
| **G8** | 封存后归档视图仍有 5 行分项，且呈「已归档，只读」 | |

**权威基线（本轮实测，非估算）**：来源 `scripts/r4-baseline-compare.mjs` → `r4-baseline-compare.json`，做法是**在同一页面同一状态下把 `.eval-dims` 隐藏**（等价于「块不存在」），因此可作为 B 方案的对照：

| 槽位状态 | 块隐藏后（≈B 方案） | 当时带块（D-02 后） |
|---|---|---|
| 自由行动面板 | **docH 1215 / `.slot-area.top` 481 / 首个按钮 538–600** | docH 1594 / 860 / 917–979 |
| 巡逻转盘（落定） | **docH 1190 / 481 / 「继续」893–929** | docH 1569 / 860 / 1272–1308 |

> 口径说明：这组数**不是推算**，是同一页面 A/B 的 `getBoundingClientRect()` 实测；但它来自「隐藏块」模拟，**真实 B 实现落地后我会用 `r6-b-plan-verify.mjs` 复测一次并以那次为准**（两者的差异应仅来自「块被移除」与「块被 display:none」的实现差别，不应有布局差别）。

**B 方案不改变 §10.8 的泄露结论**：五维分数仍是「每快照实时计算」（引擎事实），B 只改**展示时机**。§10.8 的对照实验（同 seed 两局、开局五维逐字段相同、结局一好一坏）依然是将来任何「想改成跑动中展示」的准入依据——结论是「不泄露、可接受」，但可读性仍建议只在终局/归档出现（与 B 一致）。

**D-11 登记（不修）**：用户 2026-11-12 裁决「不管」，本报告记为 **`Won't fix（用户裁决 2026-11-12）`**，并**保留** §10.6 / §10.11 的复现证据（seed 5「旧伤复发」→ 主动收束 → 标题「战殁」、文案与前情冲突）作为**已知内容缺陷**存档，不再作为退回条件。

**复验器**：`scripts/r6-b-plan-verify.mjs`（G0–G8 + 创角 13 步 → 自由行动 → 至少一次巡逻转盘 → 走到结局 → 封存；出口码 0/1）。因 `apps/web/src/main.tsx` 尚在未提交修改中（B 未落地），本轮只做语法校验，**未产出数值**。

### 10.14 D-10 B 方案复验结果：**G0–G8 全绿**（HEAD `a9ac32f`）

- **被验提交**：`a9ac32f fix(evaluation/ADR-0016-D-10): 评价分项仅在结局/归档展示（apps/web）`（父 `96cc08c`，仅 `apps/web/src/main.tsx`，+19/−6）。实现方式是 `EvaluationBreakdown` 按 `status` 门控——`terminated/archived` 才渲染，**跑动中直接 `return null`（不是折叠、不是隐藏高度）**，两处接入点透传 `snapshot.status`，`status` 缺省按 running 处理。与我的 G0 口径一致，且避开了「空节点进 tab 序/读屏」的副作用。
- **环境**：HEAD `a9ac32f`（工作区仅本报告 untracked）；先 `pnpm build` 重建 dist（`index-CS9YzmGn.js` 262.37 kB）；服务起在 **3100**、数据目录 `D:/code/_v2-e2e/data-r7`（避免干扰他人 3000 与其数据）。
- **四条回归**：`game-core 342/342`、`shared 50/50`、`pnpm typecheck` 0 错、`pnpm build` 成功。

**判据结果（`scripts/r6-b-plan-verify.mjs`，出口码 0）**

| 门 | 判据 | 实测 |
|---|---|---|
| **G0** | 跑动中无评价块 | 创角中途 / 自由行动 / 转盘落定 三处均 `exists:false, height:0, rows:0` **PASS** |
| G1 | `docH ≤ 1320` | **1215**（与我「隐藏块」基线逐位一致）**PASS** |
| G2 | `scrollY=0` 时 `.slot-area.top ≤ 660` | **481**（同上）**PASS** |
| G3 | 首个可交互元素 `top<872 且 bottom>0` | **538–600**（行动按钮整体在底栏 872 之上）**PASS** |
| G4 | 375×812 无横向溢出 | 375 == 375 **PASS** |
| G5 | 结局页 5 行 + 综合·总评 | `exists:true, rows:5, hasTotal:true` **PASS** |
| G6 | 结局页 5 行与 API 逐字段一致、合计含 overall | UI `58/100/100/100/100` + `综合 89.92` == API 同值 **PASS** |
| G7 | 5 行默认收起、点一行只开一行 | `[F,F,F,F,F]` → `[F,F,T,F,F]`，解释可见 **PASS** |
| G8 | 封存后归档仍有 5 行且只读 | 5 行 + `本局已封存` + `已归档，只读` **PASS** |

**主链路（脚本内建）**：创角 **13 步** → 自由行动 → **巡逻转盘**（`巡逻遭遇` 落定后被点「继续」）→ 自然走到结局（**`end-death`「战殁」，第 37 轮 · 战败**，未使用「结束这一生」兜底）→ 封存。全程 **0 console error / 0 pageerror / 0 4xx-5xx**。

**附加回归（同一次运行顺带采）**：该局存档 `eventFires` 中 `ev-ch1-call/ch2-crisis/ch3-night/ch4-shibuya` 各 **1 次** ⇒ **D-01 的修复在新 HEAD 上依然成立**（章节无重复）。

**复验器的稳定性说明（诚实记录）**：`r6` 连跑两次，**几何类门（G0–G4）逐位相同**（1215 / 481 / 538–600 / 1190 / 893–929 / 375），G0–G8 两次全 PASS；但两跑的**点击步数 27 vs 28**（脚本等待转盘动画/战斗回包的时序所致），因此**过程信号与五维分数有 ±1 分抖动**（A: 成长 58 / 总评 89.92；B: 成长 57 / 总评 89.68）。这不是产品问题——G6 比的是「同一时刻 UI 与 API 是否一致」，两次都一致；但**跨跑对比时只能比几何与门的结论，不能比原始分数**。（`r5` 因动作序列固定而完全确定，`r6` 的自适应等待则不是，已在此标注。）

**结论**：**D-10 关闭**（B 方案落地，跑动中无评价块、首屏主交互区回归基线、结局/归档五维与 API 逐字段一致）。

---

## 十一、最终裁决（HEAD `a9ac32f`，2026-11-12）

| 项 | 结论 |
|---|---|
| **总判** | **通过** |
| 已关闭 | D-01（章节重复）、D-02（五维出到玩家端）、D-04（开局插池事件）、**D-10（首屏主交互区被挤出，B 方案落地，§10.14 G0–G8 全绿）** |
| 不阻塞、用户裁决不修 | D-11（轻伤→战殁判据过宽，`Won't fix`，用户 2026-11-12；证据见 §10.6/§10.11，ADR 已在 `96cc08c` 更正措辞） |
| 遗留待办（非阻断，未修） | D-03（单轮多转盘 `wheelResult` 单槽覆盖）、D-05（转盘「继续」需滚动才可见，早于 D-02 就存在）、D-06（满年局五维易打满 100，短命局有区分度）、D-07（章节进度对玩家不可见）、D-08（战斗中道具按钮不按控制状态禁用）、D-09（刷新后转盘结果不可回顾） |
| 四条口径 | `game-core 342/342`、`shared 50/50`、`typecheck 0 错`、`build 成功`（均在 `a9ac32f` 上重跑） |
| 确定性 | 同 seed 同输入 ⇒ 相同阶段序列/结局/评价/装备/战斗结果（r5 复验器双跑逐字节相同；r6 双跑门结论相同、几何逐位相同） |
| hidden 隔离 | 玩家端快照/历史/归档 `hidden` 仅出现在 `ending.visibility` 标记（ADR-0006 设计），无内容泄漏；关系可见性仅 `known`；历史全 `public` |
| 未覆盖项 | 见 §七（12 结局只实测 4 类：隐藏 `end-secret-savior`、`end-geto-saved`、`end-death`、`end-retire`；`op-2006-kyoto` 未走 UI；真机/触屏未测；性能未测；`dimensions` 缺省态未实测需 mock） |

**一句话**：D-01/D-02/D-04/D-10 四项已修并在新 HEAD 上复验通过，四条口径全绿，hidden/确定性/残留/旧档拒载均 PASS —— 可验收；余下 6 条为不影响验收的已知遗留，建议排入后续迭代。

### 10.15 复验器自纠与最终复跑（HEAD `a9ac32f`）

主理人与前端都指出 `r6-b-plan-verify.mjs` **跑不起来**（`TypeError: s.actions.some is not a function`）。这条我认，且必须写清楚时间线，因为它影响「结论来自哪一版脚本」：

- **崩溃版本**：我第一版 r6 把主循环的 `actions` 采成了**数量**（`…length`）却在别处当数组用。我第一次运行就撞在这个 `TypeError` 上（当时是在 3000 的他人服务上跑的，所以我的日志里也留下了这个崩溃）；
- **修复顺序**：我在**第一次成功运行之前**已改了两处（主循环改采标签数组 + `s.actions > 0` → `s.actions.length > 0`），§10.14 那批「G0–G8 全绿」的结果**来自修复后的版本**；
- **本次再加固**（按主理人要求）：① 把创角循环的字段改名 `actionCount`，杜绝同一名字两种类型；② 把「挑行动按钮 + 点击」整体挪进 `page.evaluate` 对真实按钮做，消除「读快照 → 点击」之间的 DOM 竞态。

**加固后的效果（顺带修正 §10.14 的一处说法）**：连跑两次现在**逐字段完全一致**——`steps 28 / 28`、几何 `1215 / 481 / 538–600 / 1190 / 893–929 / 375` 全同、五维 `57/100/100/100/100`、`overall 89.68`、结局「第 37 轮 · 战败」、GATES 全同。
⇒ §10.14 里「r6 两跑步数 27 vs 28、分数 ±1」是**加固前**的竞态产物，**加固后已消失**，不是产品问题、也不是门本身不稳。（资产：`r6-fix-a.json` / `r6-fix-b.json`。）

**最终 G0–G8（修好后的脚本，跑 2 次，两次一致，出口码 0）**

| 门 | 判据 | 结果 |
|---|---|---|
| G0 / G0b | 跑动中无评价块（创角中途 / 自由行动 / 转盘落定） | PASS（三处均 `exists:false, height:0`） |
| G1 | `docH ≤ 1320` | PASS 1215 |
| G2 | `.slot-area.top ≤ 660` | PASS 481 |
| G3 | 首交互元素 `top<872 且 bottom>0` | PASS 538–600 |
| G4 | 375×812 无横向溢出 | PASS 375==375 |
| G5 | 结局页 5 行 + 综合·总评 | PASS |
| G6 | 结局页与 API 逐字段一致（`label` 为中文名、`overall` 并列） | PASS `成长57/羁绊100/功绩100/真相100/自由100`，`89.68` |
| G7 | 5 行默认收起、点一行只开一行 | PASS `[F,F,F,F,F]`→`[F,F,T,F,F]` |
| G8 | 封存后归档仍有 5 行且只读 | PASS |

**「已归档但未终止」边界（主理人指定重点，实测）**

| 检查 | 结果 |
|---|---|
| 未终止就归档 | `POST /archive` → **409 `not_terminated`**「世界尚未终止，无法归档」⇒ **该状态在 API 层不可达**，不需要为它单独设计展示 |
| 归档态是否拿得到五维（怕走另一条 evaluation 路径丢数据） | `GET /api/worlds/:id`（status `archived`）→ `dimensions` **5 项齐全、含中文 label**、`overall 89.68`；再 `POST /archive`（幂等）返回的 `archive.snapshot.evaluation.dimensions` 与**record 层** `archive.evaluation.dimensions` 三者**同值** ⇒ 无缺口 |
| 归档后是否还能写 | `POST /turns` → **409 `terminated`**「本局已终止或已归档，拒绝继续写入状态」⇒ 只读门禁正常 |
| 跑动中的 API 是否仍下发 dims | **仍下发（5 项）**——这是引擎事实（评价每快照实时算，见 §10.8），B 只是**前端按 `status` 不渲染**。写在这里防误读为「服务端也隐藏了」 |

**结论**：D-02 没有被 B 改坏（「展示什么」未动，只改了「什么时候展示」）；D-10 关闭；**总判仍为「通过」**。
