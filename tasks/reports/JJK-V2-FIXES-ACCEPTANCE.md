# JJK V2 · 遗留缺陷清理批 验收报告

- 验收对象：HEAD `ecc5bb6`（`refactor(schema/D-15): BattleCommand 收敛为单一真源`），工作区起始状态 `git status --short` 为空
- **追加复验 1**：D-16（QA P2-2 转正为 bug）在 HEAD `e3884ae` 上做定点复验，见 §九
- **追加复验 2**：D-17（属性键交叉引用缺口）在 HEAD `bbf734d` 上做定点复验，见 §十
- 本轮范围：D-03 / D-05 / D-06 / D-07 / D-08 / D-09 / D-12 / D-13 / D-14 / D-15 共 10 条 + D-16（P2-2 转正）+ D-17（属性键校验）
- 验收人：life-sim-qa（严过关）｜验收时间：2026-11-12
- 验收方式：**自己重跑四条口径 + 自建世界走真实 HTTP + 430×932 DPR2 headless Chrome 真点击**；未采信任何转述结论与截图
- 验收资产：脚本 `D:\code\_v2-fix-e2e\scripts\`｜截图 `D:\code\_v2-fix-e2e\shots\` + `shots-d16\`｜原始观测 JSON `D:\code\_v2-fix-e2e\*.json`｜服务日志 `server*.log`
- 隔离：服务以 `PORT=3101 LIFE_SIM_DATA_DIR=D:/code/_v2-fix-e2e/data` 独立端口 + 独立数据目录运行，全程未对 `data/worlds` 内的既有存档发出任何写请求

## 终判

**可验收（通过）。** 10 条缺陷全部 FAIL→PASS，**D-16（P2-2 转正）定点复验 3/3 PASS**，**D-17（属性键校验）定点复验 4/4 夹具 PASS**，四条口径全绿（D-17 后：**367 / 62 / 0 错 / build 成功**），无 P0/P1 遗留。P2-2 已修、P2-1 与 P2-3 经用户裁决**不修**，另有 4 条未覆盖项与 1 条环境风险（裸 `vitest run` 在本沙箱挂死），均不阻断。

---

## 一、四条口径

| # | 命令 | 结果 | 判定 |
|---|---|---|---|
| 1 | `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | **366 passed / 24 files**，20.00s | PASS |
| 2 | `pnpm --filter @life-sim/shared exec vitest run --no-file-parallelism` | **58 passed / 4 files**，3.58s | PASS |
| 3 | `pnpm typecheck` | `tsc --noEmit -p tsconfig.json`，**0 错**，4s | PASS |
| 4 | `pnpm build` | `vite build` 成功，`dist/assets/index-CfFqozUU.js 266.11 kB` | PASS |

> 口径 2 的说明（环境坑，非缺陷）：`pnpm --filter @life-sim/shared test`（脚本 = 裸 `vitest run`）在本沙箱**挂死**（实测挂 13 分钟无输出无退出，与 `game-core` 同样的已知并行收集问题），加 `--no-file-parallelism` 后 3.58s 正常跑完。报告以串行结果为准。

---

## 二、DoD 逐条核验（10 条缺陷 FAIL→PASS）

| # | 缺陷 | 复现的 FAIL 口径 | 修复后实测 | 判定 |
|---|---|---|---|---|
| D-03 | 单轮两个 `random` 转盘互相覆盖 | 修复前 `lastWheel` 单槽，后一枚覆盖前一枚 | 见 §3.1 | **PASS** |
| D-05 | 转盘「继续」被底栏压住 | — | 见 §3.2 | **PASS** |
| D-06 | 满年局五维全 100 | 旧实现 `min(hi, raw)` 长局全钉 100 | 见 §3.3 | **PASS** |
| D-07 | 章节进度玩家不可见 | 投影无章节字段 | 见 §3.4 | **PASS** |
| D-08 | 受限时道具按钮仍可点，点了收 400 | 点击发请求 → `400 bound_items` | 见 §3.5 | **PASS** |
| D-09 | 刷新后转盘结果丢失 | 刷新后事件区无转盘 | 见 §3.6 | **PASS** |
| D-12 | `canFlee` 未合并 `cannot_flee` | 投影 `canFlee` 只读 `settle.canFlee` | 见 §3.7 | **PASS** |
| D-13 | 眩晕时按钮全亮、白丢一回合无提示 | `canAct` 不存在 | 见 §3.8 | **PASS** |
| D-14 | `BattleCommand` 缺「空过」，前端借 `flee` | 无 `pass` 命令 | 见 §3.9 | **PASS** |
| D-15 | 服务端手写第二份战斗命令 schema | 此前加命令会静默 400 | 见 §3.10 | **PASS** |

### 3.1 D-03 单轮多个转盘结果不再互相覆盖

**内核（真实 HTTP，seed 7，第 15 轮）**

```
randomEvIds : ["ev-explore-wheel", "ev-daily-fortune"]
wheelIds    : ["ev-explore-wheel", "ev-daily-fortune"]        ← 顺序 = 触发顺序
wheelLabels : ["ev-explore-wheel:旧书与笔记", "ev-daily-fortune:平"]
legacy lastWheel : "ev-daily-fortune:平"                       ← 兼容字段 = 列表末元素
assert ok   : true
```

「当轮」语义的全量断言（每一处轮次起点 `lastWheels` 必须精确等于本轮随机事件集合，条数+顺序）：
- seed 7 全流程：**35 / 35 turn-start 通过，0 失败**（含该双转盘轮之后的清空轮）
- seed 3 全流程两次（确定性对照）：**45 / 45 通过 / 0 失败**（两次相同）

**UI（430×932 DPR2，现场点「探索」触发该轮，见 `shots/F01-D03-双转盘.png`）**

| 观测 | 值 |
|---|---|
| 首枚转盘标题 | **探索遭遇**（命中「旧书与笔记」） |
| 同轮其余条目 | 「同一轮另有 **1** 次命运抉择」→ **命数转盘 · 今日运势** ｜ **平** |
| 标题是否回退「随机事件」 | 否（两张卡标题互不相同，均取自本轮 `triggeredEvents`） |
| 轮次 chip | 第 15 轮 |
| 卡片总数 | 2（1 主转盘 + 1 紧凑卡，无重复） |

> 关键：两枚转盘**各自显示自己的事件标题**，不是两行「随机事件」，也不是只有最后一个。

### 3.2 D-05「继续」不再落到底栏下方（430×932 DPR2）

```
继续按钮  rect.top=790  rect.bottom=826
浮标 .interact-hint  top=838
底栏 nav.tabbar      top=872
遮挡线 limitLine = min(838, 872) = 838
window.scrollY = 217（自动滚入，未要求玩家自己滑）
判定：826 < 838 < 872  ⇒ PASS（严格满足 hint.top < tabbar.top 且按钮底部在两者之上）
```

截图：`shots/F01-D03-双转盘.png`（「继续」在「事件待决」浮标与底栏之上，均完整可见）

### 3.3 D-06 五维评分有界饱和 + 可重现

**满年局（day 420 / 第 45 轮 / 结局 end-geto-saved，真实 HTTP 走完一年）**

| 维度 | 分数 | team-lead 预期区间 |
|---|---|---|
| 成长 growth | 72.22 | 62–71（略高 1.2，见下） |
| 羁绊 bonds | 82.49 | 79–82（略高 0.5） |
| 功绩 deeds | 82.49 | 79–82（略高 0.5） |
| 真相 truth | 85.90 | 83–85（略高 0.9） |
| 自由 freedom | 85.90 | 83–85（略高 0.9） |
| **总评 overall** | **81.18** | 76–80（略高 1.2） |

- **不再全 100**：五维 72.22–85.90 有明确梯度 ⇒ 核心缺陷已消除
- **同 seed 同输入同分**：同一脚本连跑两次，`traceSig`（60 步 × 轮次/时间/状态/事件/转盘/章节/HP/MP/心情）**逐字节相同**，评价 5 维与 overall 完全相同；归档接口返回的评价与快照评价一致（`overall=81.18`，5 维同值）
- **短局仍有梯度**：seed 3 早亡局 overall 74.37（成长 58.59）／seed 5 75.43（58.59）／seed 7 76.76（62.71），短局分数明显低于满年局
- **偏差说明**：我的采纳路径比内核标定用的 `playthrough.test.ts` 脚本采集到更多过程信号（探索 7 次 + 战利品 + 额外战斗），故整体高约 1 分；内核自己的 6 种子输出（成长 62.50–70.91、羁绊 78.67–81.79、真相/自由 82.55–85.29、overall 76.25–80.37）印证标定区间成立。**不构成缺陷，见 P2-1。**

### 3.4 D-07 章节进度对玩家可见 / 缺省不渲染

**内核**
- 全部 45 个轮次起点：`snapshot.storyChapter` 与落盘 `flags.chapter` **0 处不一致**（38 次有值样本全部相等）
- 章节推进序列单调：`1 → 2 → 3 → 4 → 5 → 6`（无跳号、无回退）
- 构造 `flags.chapter` 缺失的世界（删字段后重启加载）：快照 **不含** `storyChapter` 字段（`hasOwnProperty=false`），未出现 `0`/`null`

**UI**：`shots/F03-D07-有章节.png` —— 个人页「属性」面板 `meta-row` 内渲染 **第 1 章** chip；对照世界（无 chapter）chip 数量 **0**，整页文本不含「第 0 章」。

### 3.5 D-08 受限时道具按钮禁用 + 原因 + 0 请求

**内核**：注入 `bind`（`combat.control: [cannot_use_items]`）后投影 `canUseItems=false`；同模板同事件的对照世界 `canUseItems=true`。引擎侧同源拒绝：`POST /battle {"type":"item"}` → **400 `bound_items`**。（另有一局由敌方 `sk-curse-crush` **自然**施加「束缚」，投影同样 `canUseItems=false`。）

**UI（`shots/F05-D08D12-受限禁用.png`）**：

| 观测 | 值 |
|---|---|
| 道具按钮 1 | 「急救包 ×3」`disabled=true` / `aria-disabled="true"` / 副文案「受制于人，用不了道具」 |
| 道具按钮 2 | 「咒力糖 ×3」同上 |
| 区域提示 | 「你被束缚住了：本回合无法使用道具。」 |
| 真鼠标点击 2 个道具按钮后发出请求数 | **0** |

### 3.6 D-09 刷新后转盘结果仍在且不重播动画

真 `page.reload()`（同一存档，第 15 轮双转盘）后的观测：

| 观测 | 值 |
|---|---|
| 转盘卡片总数 | **2**（1 主 + 1 紧凑卡，**无重复**，不是 4 张） |
| `.wheel-spinning-text`（转动中） | **0** |
| 「继续」可见耗时 | **42 ms**（远小于 2.6s ⇒ 未重播旋转动画） |
| 转子样式 | `transition: none`，`transform` 直接停在命中角 |
| 结果标签 | 「平」保留（命中扇区不丢） |

截图：`shots/F02-D09-刷新后.png`

### 3.7 D-12 `canFlee` 合并 `cannot_flee` 补正

同事件 A/B 对照（均为 `ev-sp-ambush`，settle 本身允许逃跑）：

| 世界 | 注入 | `canFlee` |
|---|---|---|
| 对照世界 `0ad6245d` | 无 | **true** |
| 受限世界 `4366a149` / `50aaa31d` | `bind`（含 `cannot_flee`） | **false** |

引擎侧同源拒绝：`POST /battle {"type":"flee"}` → **400 `cannot_flee`**；另有 7 个战斗回合因 `settle.canFlee=false` 自然为 false（声明优先分支同时成立）。

**UI**：逃跑按钮 `disabled=true` / `aria-disabled="true"` / 文案「退路已被封死」+ 区域提示「此战无法逃离：局势不允许脱身。」；点击后发出请求数 **0**。

### 3.8 D-13 眩晕覆盖层 + 回合照常消耗

**内核**：注入 `stun` 后投影 `canAct=false`（两处世界均如此）；提交一次命令后下一回合 `canAct=true`（解除）。

**UI（`shots/F06-D13-眩晕覆盖层.png` → `shots/F07-D13-硬撑之后.png`）**

| 观测 | 值 |
|---|---|
| 覆盖层标题 | **「无法行动 · 眩晕」**（眩晕名取自投影 statuses，非前端编造） |
| 覆盖层副文案 | 「技能、道具、逃跑本回合全部不可用，只能硬撑过去。」 |
| 覆盖层几何 | 368×280，覆盖行动区；背后 8 个技能按钮 `disabled=true` |
| 推进出口 | 按钮「硬撑过这一回合」 |
| 点一次后 | 覆盖层 **消失**（`.battle-locked` 为 null），回合已推进（见 §3.9 的 round 1→2） |
| 战斗日志 | 「R1 你无法行动。」（如实告知，不再无声白丢一回合） |

### 3.9 D-14 `{type:"pass"}` 空过一回合

**真 HTTP 双分支（同一战斗，逐项对比）**

| 分支 | HTTP | 回合 | MP | 道具 | 技能冷却 | 日志 |
|---|---|---|---|---|---|---|
| 眩晕态 `{"type":"pass"}` | **200** | 1 → 2 | 57 → 57 | 不变 | 不变（全 0） | 「R1 你无法行动。」 |
| 正常态 `{"type":"pass"}` | **200** | 2 → 3 | 57 → 57 | 不变 | 不变（全 0） | 「R2 你按兵不动。」 |

**UI 抓包**：点「硬撑过这一回合」→ 唯一一条 `POST /api/worlds/<id>/battle` 的 body = `{"type":"pass"}`（**逐字符匹配**），返回 200，覆盖层消失。整个 UI 会话里除「探索」的一次 `/turns` 外，仅此一条 battle 请求。

### 3.10 D-15 战斗命令单一真源

- `POST /battle {"type":"pass"}` → **200**（不再被服务端第二份 schema 静默拒收）
- `POST /battle {"type":"nope"}` → **400** `invalid_body`，错误信息里的枚举为
  `Expected 'skill' | 'item' | 'flee' | 'pass'` ⇒ 服务端确实在用 shared 的那份 schema
- 代码面：`BattleCommandSchema` 以 zod 为唯一真源、`BattleCommand = z.infer<...>`；`apps/server/src/index.ts` 改为 `import { BattleCommandSchema } from "@life-sim/shared"`

---

## 四、回归项

| 检查项 | 结果 | 证据 |
|---|---|---|
| **hidden 不泄露** | PASS | 玩家端快照全字段扫描：无 `hidden` / `secrets` / `private` 键，`visibility` 取值仅 `"known"`；1 次战斗态 + 1 次终局态均如此 |
| **旧档指纹拒载** | PASS | 拷入 2 个旧档后重启：`save_skipped` × 2 = `schema_version_mismatch: 1` + `template_fingerprint_mismatch`，启动未被阻断（`loaded:19 skipped:2`）。原档只读拷贝，未改动 `data/worlds` |
| **D-01 章节不重复触发** | PASS | 满年局中 `ev-ch1-call`/`ev-ch2-crisis`/`ev-ch3-night`/`ev-ch4-shibuya`/`ev-ch5-finale` **各 1 次**；`storyChapter` 变化序列 `1→2→3→4→5→6` |
| **确定性回归（全链路）** | PASS | 同 seed 同脚本两次：60 步 `traceSig` 逐字节相同，结局 / 五维 / overall / 归档评价全同 |
| **D-03 转盘不跨轮残留** | PASS | seed 7：35/35 轮次起点条数与顺序精确匹配；seed 3：45/45（两次运行均如此） |
| **V1 残留符号** | PASS | `grep "evaluateLife\b\|advanceTurn(\|PhaseTransitionLog"` 无 V1 引擎命中；`advanceTurn` 仅命中 `apps/web/src/api.ts` 的**客户端方法名**（POST 到 `/turns`，V2 端点），非 V1 引擎符号 |
| **未引入 Lifecycle / Phase** | PASS | 无 `lifecycle.ts`；`Phase`/`PhaseTransitionLog`/`LifecycleState` 仅出现在 `v2/boundary.test.ts` 的**禁用清单**（守卫自身），源码零命中 |
| **DEFERRED/RETIRED 未混入** | PASS | `R-TT-*`/`R-LC-*` 仅出现在 `specs/iteration-2026-11-11/*.md` 的状态声明里，本轮 10 条改动无任何 `R-TT`/`R-LC` 实现或测试 |
| **未手改产品代码** | PASS | `git status --short` 全程为空，HEAD 仍为 `ecc5bb6` |

---

## 五、专项检查

| 检查项 | 结果 | 证据 |
|---|---|---|
| 确定性可重现 | PASS | 见 §3.3 / §四；同 seed 同输入 ⇒ 阶段序列、结局、五维、归档评价一致 |
| DEFERRED/RETIRED 未混入范围 | PASS | 见 §四 |
| V1 残留符号 | PASS | 见 §四 |
| 未引入 Lifecycle 状态机 | PASS | 见 §四 |
| hidden 未进入玩家端 API | PASS | 见 §四 |
| 引擎拒绝与投影告知**同源** | PASS | 投影 `canFlee=false` ⇔ 引擎 400 `cannot_flee`；`canUseItems=false` ⇔ 400 `bound_items`；`canAct=false` ⇔ 引擎跳过玩家动作记「你无法行动。」 |

---

## 六、未覆盖项（显式声明）

| # | 未覆盖 | 原因 |
|---|---|---|
| 1 | 真实手机 / iOS Safari 上的 D-05 滚动与 `100dvh` 行为 | 本轮只跑 headless Chrome 430×932 DPR2；真机未验证 |
| 2 | `prefers-reduced-motion: reduce` 下 D-05 / D-09 的分支 | headless 未开启该媒体特性，代码分支存在但未实测 |
| 3 | 眩晕的**自然**获取路径 | 模板中能致玩家眩晕的敌方技能命中率最高 0.8，且 `stun` 的 `battleRounds: 1` 会在同回合末清掉，纯 RNG 无法稳定命中 ⇒ 按主理人授权**注入 `stun`**（脚本 `inject-fixtures.mjs` / `inject-fixtures-2.mjs`，只写验收数据目录）。`bind` 则同时拿到注入与一例**自然**施加（敌方 `sk-curse-crush`） |
| 4 | 3 个以上的同轮转盘（3+ 张卡） | 模板只有 4 个 `kind: random` 事件，单轮可同时命中的组合实际只有 2 个（行动钩子 + 今日运势）；3+ 未构造 |

---

## 七、P2 观察项与裁决（已全部落定）

| # | 观察 | 裁决 | 说明 |
|---|---|---|---|
| P2-1 | D-06 标定区间略保守：我的满年局落在 72.22–85.90、overall 81.18，比预期上限高约 1 分；内核自己的 6 种子输出里 s1 overall=80.37 也已略超 80 | **不修（已接受）** | 用户裁决：判定为「采样路径信号更多」而非公式差异，为 1 分调 `SATURATION_K_RATIO` 会挪动整条标定曲线，风险大于收益。文档口径放宽为**各维 70–87 / overall 75–82**。 |
| P2-2 | 刷新后转盘卡标题回落「随机事件」 | **已修（D-16 / `0081844` + `e3884ae`）** | 判定为 bug 而非观察：现场触发正常、刷新后两张卡同名，是 D-03 的半截尾巴。复验证据见 §九。 |
| P2-3 | 刷新后若上一轮转盘结果仍在，「继续」未读掉时事件区被转盘占位，战斗界面被顶掉 | **不修（设计取舍）** | 用户裁决：事件区「转盘 > 战斗 > 待决事件 > 自由行动」的占位优先级是**设计取舍**，不是缺陷。玩家多点一次「继续」即可回到战斗，状态不丢、不误操作。**后续请勿重新发现/重新立案。** |
| R-1 | 环境风险：`pnpm --filter @life-sim/shared test`（脚本 = 裸 `vitest run`）在沙箱内**挂死 14 分钟**无输出无退出；`pnpm test`（根脚本 = game-core 裸 `vitest run`）同理 | **风险已知，未修** | 与 game-core 同一个并行收集问题，加 `--no-file-parallelism` 后 shared 3.58–4.31s / game-core 20–23s 正常。**不是产品缺陷**。建议后续把两个包的 `test` 脚本直接写成带 `--no-file-parallelism`，否则下一个跑验收的人必然再踩一次并怀疑产品坏了。 |

---

## 八、结论

- **四条口径：4/4 PASS**（366 / 58 / typecheck 0 错 / build 成功）— 此为 `ecc5bb6` 基线；D-16 后重跑见 §九（367 / 58 / 0 错 / build），D-17 后重跑见 §十（**367 / 62 / 0 错 / build**）
- **10 条缺陷：10/10 PASS**，每条都有真实 HTTP 或真浏览器点击证据（含 A/B 对照与抓包 body 逐字符比对）
- **D-16 复验：3/3 PASS**（P2-2 转正项已修，旧档兜底正确，D-03/D-09 未被带坏）
- **D-17 复验：4/4 夹具 PASS**（a/b 两条真漏洞已补、c 组既有能力未劣化且仍只报 1 条、d 对照正常加载；现网模板与 20 个既有存档零误伤）
- **回归项：9/9 PASS**（hidden、旧档拒载、D-01 章节、确定性、转盘不跨轮、V1 残留、Lifecycle、范围污染、未改产品代码）
- **遗留：0 条 P0 / 0 条 P1 / 0 条待办 P2（P2-2 已修、P2-1 与 P2-3 已裁决不修） / 4 条未覆盖项 / 1 条环境风险（R-1）**

**裁决：可验收（通过）。** 主理人可归档提交并放行下一阶段。P2-1「不调 k」与 P2-3「占位优先级属设计取舍」已按用户裁决落定，**后续不要再当缺陷重新立案**。D-17 的验收口径请注意 §10.0：`characters[].attributes` 属**既有能力回归项**，不是新增拦截。

---

## 九、D-16 定点复验（HEAD `e3884ae`）

### 9.0 复验范围与口径

只验三点（P2-2 转正、旧档兜底、D-03/D-09 无回归），未重跑全量 10 条；但**因内核动了 `WheelResultView`/存档 schema、前端动了标题取值，仍重跑了四条口径**：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0 错** |
| `pnpm --filter @life-sim/shared exec vitest run --no-file-parallelism` | **58 passed / 4 files**，4.31s |
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | **367 passed / 24 files**，22.77s（较 `ecc5bb6` 的 366 多 1 条 = 新增 D-16 用例） |
| `pnpm --filter @life-sim/web build` | 成功（`dist/assets/index-CB0mFKpR.js 266.01 kB`） |

改动面核对：`WheelResultView.title?: string`（= `EventV2.title`，可选）、`turn.ts` 随机分支写入 `title: event.title`、`WheelResultViewSchema` 同步加可选项、投影**直接透传**（`lastWheel: state.lastWheel` / `lastWheels: state.lastWheels ?? []`，未做任何字符串化）、前端 `title: wheel.title ?? "随机事件"`。

### 9.1 第 1 点 —— P2-2 转正：新档刷新后标题仍是各自事件名

用 **D-16 之后产生的档** `83ac953e`（seed 7，冻结在双转盘前一回合，UI 现场点「探索」触发第 15 轮双转盘）：

| 观测 | 现场触发 | **真 `page.reload()` 之后** |
|---|---|---|
| 主卡标题 | 探索遭遇 | **探索遭遇** |
| 同轮第二卡标题 | 命数转盘 · 今日运势 | **命数转盘 · 今日运势** |
| 卡片数 | 2 | 2 |
| 命中标签 | 旧书与笔记 / 平 | 旧书与笔记 / 平 |
| 「继续」可见耗时 | — | **41 ms**（未重播 2.6s） |

服务端下发的持久化数据（`GET /api/worlds/83ac953e`）：

```json
[{"eventId":"ev-explore-wheel","label":"旧书与笔记","title":"探索遭遇"},
 {"eventId":"ev-daily-fortune","label":"平","title":"命数转盘 · 今日运势"}]
```

落盘文件同样是 `keys = ["eventId","title","label","segments"]`；**重启服务后重新 hydrate，title 仍在**（save → disk → load 全链路通过）。
截图：`shots-d16/D16-01-新局-现场双转盘.png`、`shots-d16/D16-02-新局-刷新后.png`

### 9.2 第 2 点 —— 旧档不炸（兜底是否真的靠 `??` 生效）

用**修复前**产生的档 `c8f0556e`（同轮双转盘，`lastWheels` 两条都**没有** `title` 字段）：

| 观测 | 加载后 | 刷新后 |
|---|---|---|
| 主卡标题 | **随机事件** | **随机事件** |
| 第二卡标题 | **随机事件** | **随机事件** |
| 命中标签 | 平（保留） | 平（保留） |
| 页面是否出现字面 `undefined` / `NaN` / `[object Object]` | **否** | **否** |
| 卡片数 | 2 | 2 |

服务端 JSON 的关键点：两条 wheel **根本没有 `title` 键**（`hasOwnProperty('title') === false`），而不是 `"title":"undefined"` —— 这正是 `?? ` 能生效的前提，内核没有把 `undefined` 字符串化。
截图：`shots-d16/D16-03-旧档-load.png`、`shots-d16/D16-04-旧档-刷新后.png`

**旧档写回 + 重载（strict schema 兜底）**：写回路径 `persist()` 不做 schema 校验，真正的闸门在 `hydrate()` 的 `WorldStateV2Schema.safeParse`。验证方式：
1. 对旧档执行 `POST /items/use`（轮外操作，**不清空 `lastWheels`**）→ 200，落盘文件中两条 wheel 仍只有 `eventId/label/segments`；
2. 重启服务 → `worlds_loaded loaded:20 skipped:2`（跳过的 2 个是我刻意拷入的 `schema_version_mismatch: 1` 与 `template_fingerprint_mismatch` 样本，与本项无关），旧档**正常加载**、两条 title-less wheel 原样保留。

> 修正一处我自己的探针误报：首次尝试用 `POST /turns` 做写回，收到 **409 `pending_event_required`**——原因是该旧档槽位被待决事件 `ev-ch1-call` 占住，引擎按设计拒绝提交自由行动，**与 D-16 无关**（是我的探针选错写回入口），已改用 `/items/use` 重做。

### 9.3 第 3 点 —— D-03 / D-09 没有被这次改动带坏

| 检查 | 结果 |
|---|---|
| 同轮双转盘仍是两张卡（现场） | 2 张，标题「探索遭遇」/「命数转盘 · 今日运势」（互不相同） |
| 刷新后仍是两张卡、不重复 | 2 张（不是 4 张） |
| 刷新后不重播旋转动画 | `.wheel-spinning-text` = 0；「继续」41 ms 出现 |
| 标题与刷新前一致 | 完全一致（这正是 D-16 的修复点） |
| 旧档路径 | 两张卡都回落「随机事件」文案，但命中标签仍在、无 `undefined` |

> 注意（给后续验收的人）：**用修复前的旧档看「随机事件」是数据缺失，不是回归**；要验 D-16 本体必须用 D-16 之后产生的档。

### 9.4 D-16 复验结论

**通过。** P2-2 判定为 bug 成立、修法与根因对得上（数据随结果持久化，而非继续依赖当次响应上下文）；旧档兜底是「字段缺失 + 前端 `??`」，不是字符串 `"undefined"`；D-03/D-09 无回归；四条口径全绿。

> HEAD 备注：复验期间 HEAD 由 `e3884ae` 前移为 `06c7fcb`（`docs(ADR-0017)`），`git diff e3884ae 06c7fcb` 只动 `docs/DECISIONS.md`（+64 行，无代码），故 §九 全部结论对 `06c7fcb` 同样成立。

---

## 十、D-17 定点复验（HEAD `bbf734d`）

### 10.0 任务书前提的一处更正（先钉住，免得结论被误读）

任务书原口径：「`superRefine` 查了 8 类交叉引用，**唯独属性键没查**，`defaults` / `playerTemplate.attributes` / `characters[].attributes` 三条路都漏」。我在 HEAD `06c7fcb` 上逐行核对后确认**只有两条漏**：

| 路径 | 改动前 | 依据（`git show 06c7fcb:packages/shared/src/schema/world.ts`） |
|---|---|---|
| `attributes.defaults` | **未校验**（真漏洞） | 全文件仅在 `L163` 有 `defaults: z.record(z.string(), z.number())` 声明，`superRefine` 内**零引用** |
| `playerTemplate.attributes` | **未校验**（真漏洞） | `L289-299` 只查 `identity.gender` / `skills` / `items`，未查 `attributes` 的键 |
| `characters[].attributes` | **已有校验** | `L317-321`：`add(["characters", i, "attributes"], \`未知属性：${k}\`)` |

内核工程师在实现期独立发现了同一处笔误并自我修正（第一版真的加了重复校验、会产生两条 issue，已在同一提交内回退）。因此本节的判定口径是：**a/b 两组 = 新增拦截；c 组 = 既有能力未被改坏的回归项**，不能把 c 组算成 D-17 的新增战果。

> 基线说明（诚实交代）：a/b 的「改动前能加载」是**代码面基线**（上述行号可被任何人复核），我没有为了造一条运行时 FAIL 去 `git worktree` 另装依赖或改动工作区。运行时基线需要用旧代码跑我的夹具，收益不足以抵掉污染工作区的风险。

### 10.1 四条口径（HEAD `bbf734d`，工作区干净）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0 错** |
| `pnpm --filter @life-sim/shared exec vitest run --no-file-parallelism` | **62 passed / 4 files**，4.49s（58 + 4 = 新增 4 条 schema 用例） |
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | **367 passed / 24 files**，17.68s（与 D-16 后持平 ⇒ 未误伤任何 game-core 夹具） |
| `pnpm --filter @life-sim/web build` | 成功（`dist/assets/index-CB0mFKpR.js 266.01 kB`） |

改动面：`git show --stat bbf734d` = `packages/shared/src/schema.test.ts (+59)`、`packages/shared/src/schema/world.ts (+16)`，两文件，无其他包被牵动。

### 10.2 正例：现网模板不被新校验误伤

| 检查 | 结果 |
|---|---|
| 启动加载 | `worlds_loaded loaded:20 skipped:2` —— **与 D-17 之前逐项一致**（跳过的 2 个仍是我刻意拷入的 `schema_version_mismatch: 1` 与 `template_fingerprint_mismatch` 样本，无新增拒载） |
| `GET /api/templates` | `jjk-2006`（2 个开局）正常 |
| 建世界 | `POST /api/worlds` ⇒ **201**，首个待决 `ev-opening-wheel` |
| 玩家属性键 vs 显示名 | 6 个键 `[cursedEnergy, intellect, physique, agility, luck, reputation]`，**缺显示名的键 = 空**（`luck` 有「幸运」，不会退化成机器名） |
| 走一轮 | `POST /events/choose` ⇒ **200**，`turn 1`，下一步待决 `ev-w01` |

另跑一份原样复制的模板副本（`tpl-d17/d-control`）作为夹具对照组：**加载成功、0 条 issue** ⇒ 后面三组的拒载确实是「多加的那个键」导致，不是夹具把模板弄坏了。

### 10.3 反例三条：必须拒载，且 issue 指到具体键

用 `TEMPLATES_DIR` 指向我的夹具根启动真实服务，抓 `loadTemplate` 抛出的 ZodError：

| 夹具 | 期望 | 实测 issue path | 实测 message | 条数 | 判定 |
|---|---|---|---|---|---|
| `a-defaults`（`world.yaml:62` defaults 里加 `phantomAttr: 3`） | 拒载 | `["attributes","defaults","phantomAttr"]` | `未知属性：phantomAttr（未在 attributes.order 中声明）` | **1** | PASS |
| `b-player-template`（`characters.yaml:359` playerTemplate.attributes 加同键） | 拒载 | `["playerTemplate","attributes","phantomAttr"]` | 同上 | **1** | PASS |
| `c-character`（`characters.yaml:13` 首个角色 attributes 加同键） | 拒载（**既有能力**） | `["characters",0,"attributes"]`（**不含键名**） | `未知属性：phantomAttr`（**无后缀**） | **恰好 1** | PASS |
| `d-control`（原样复制，不注入） | 加载成功 | — | — | 0 | PASS |

**总判：4/4 PASS。**

两个细节值得记下来，它们是判定「c 组没被重复实现」的证据而非巧合：
- c 组的 path **不含键名**、message **没有**「（未在 attributes.order 中声明）」后缀 —— 与 a/b 的格式**故意不同**，说明它命中的是 `06c7fcb` 就存在的旧代码路径，不是新 helper；
- c 组 issue 数**恰好 1** —— 内核工程师自述「第一版曾重复校验、会报两条，已回退」，此条正是对该回退的独立验证。

### 10.4 D-17 复验结论

**通过。** 两条真漏洞（`defaults` / `playerTemplate.attributes`）已从「能加载、静默退化成机器名」变为「加载期 fail-fast，issue 指到具体键、消息带归因提示」；`characters[].attributes` 的既有能力保持单条 issue 未劣化；现网模板与全部既有存档（20 个）无一被误伤；四条口径全绿。

---

## 附：验收资产清单

```
D:\code\_v2-fix-e2e\
├─ scripts\
│  ├─ d-fix-core-probe.mjs        内核全流程探针（D-03/06/07/08/12/13/14/15）
│  ├─ d-fix-ui-probe.mjs          UI 复验（430×932 DPR2）
│  ├─ pass-and-leak-probe.mjs     D-14 双分支 + hidden 扫描
│  ├─ inject-fixtures.mjs         构造 stun / bind / 无章节 前置状态（只写验收数据目录）
│  ├─ inject-fixtures-2.mjs       第二轮构造
│  ├─ d16-fix-probe.mjs           D-16 定点复验（新档刷新 / 旧档兜底 / D-03·D-09 回归）
│  ├─ d17-build-fixtures.mjs      D-17 反例夹具生成（3 注入 + 1 对照，带打桩锚点断言）
│  ├─ d17-parse-fixtures.mjs      D-17 夹具日志解析（核 issue path 前缀与条数）
│  └─ dbg-bind.mjs                调试用页面转储
├─ shots\                         F01–F07 截图（D-03/D-09/D-07×2/D-08D12/D-13×2）
├─ shots-d16\                     D-16 复验截图（新档现场/新档刷新/旧档加载/旧档刷新）
├─ tpl-d17\{a-defaults,b-player-template,c-character,d-control}  D-17 四组模板根
├─ fixture-*.log                  D-17 各组启动输出（含完整 ZodError）
├─ det-d1.json / det-d2.json      确定性对照（seed 3 × 2）
├─ core-seed7-a.json              D-03 双转盘内核证据（含 35/35 断言）
├─ ui-result.json                 UI 八项检查全量明细
├─ pass-probe.json                D-14 双分支 + hidden 扫描明细
├─ d16-result.json                D-16 六项检查全量明细
├─ d17-fixtures.json              D-17 四组夹具判定明细（path/message/条数）
├─ world-*.json                   各冻结世界（含脚本侧观测）
└─ server*.log                    启动/拒载日志（含 D-16/D-17 各轮 server-d16*.log、server-d17.log）
```

**服务已在每次验收结束后停止（3101 / 3109 端口无监听）；`git status --short` 只有本报告一条 `??`。**
