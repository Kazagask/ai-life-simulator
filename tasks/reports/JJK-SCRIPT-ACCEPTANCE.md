# JJK-2006 剧本重构 + 生命周期/spawn 接线 · 验收报告

- 验收人：life-sim-qa（严过关）
- 时间：2026-11-12
- HEAD：`8c99cf37df71b64de79172183bbf2ef9361b853a`
- 工作区：干净（`git status --short` 无输出；本报告为未跟踪文件）
- 验收对象（三个提交）：

```
8c99cf3  feat(template)  死灭回游/新宿战斗密度与群像 + 七海谢幕
b7a53ee  fix(template)   P0 因果断层 9 项
0ca88d0  feat(template)  接入生命周期与刷新机制：身体争夺状态切换 + 乙骨登场
```

改动面（`git diff --stat 0ca88d0^ HEAD`，7 文件 +1534/−52）：

| 文件 | 增量 | 性质 |
|---|---|---|
| `specs/data/templates/jjk-2006/events.yaml` | +943 | 剧本内容（91→109 事件） |
| `specs/data/templates/jjk-2006/endings.yaml` | +51 | 结局/终止条件 |
| `specs/data/templates/jjk-2006/characters.yaml` | +47 | 两张宿傩卡 |
| `specs/data/templates/jjk-2006/world.yaml` | +12 | `npcSpawnRules` |
| `packages/game-core/src/v2/lifecycle-switch.test.ts` | +494（新） | 机制用例 |
| `packages/game-core/src/v2/combat-refs.test.ts` | +33/−1 | 用例改名 + 新用例 |
| `packages/game-core/src/v2/playthrough.test.ts` | +6/−1 | `overall` 阈值 95→96 |

**产品代码（`packages/*/src/**` 非测试文件）零改动** —— 本轮是纯模板内容 + 用例改动。

---

## 验收裁决

- 任务：jjk-2006 剧本重构 + 生命周期/spawn 接线（`0ca88d0` `b7a53ee` `8c99cf3`）
- 需求：用户诉求 6 条（逻辑通顺 / 不诈尸 / spawn+生命周期活起来 / 身体争夺 cause / 死灭-新宿密度群像 / 涩谷宿傩战斗 / 决战二番战两个 NPC）+ 实现方自述的 P0 因果 9 项 + 生命周期与 spawn 机制验收标准（ADR-0012 / ADR-0020 / ADR-0022）
- **R1 裁决：退回**
- 一句话理由：技术口径（类型检查 / 504 项测试 / 构建 / 确定性 / spawn 幂等 / 二番战两阶段 / P0 因果 9 项）**全部通过**，但用户点名的第一条「死亡角色不能诈尸」有 **2 个 P1 未达成**：`npc-riko` 在 100% 的对局里死了却仍以「在世」上屏；灰原/伏黑在约 1/3 的对局里仍以正文 + 可选选项出场。

> **R2 复验（HEAD `b1321ec`）：通过。** 两个 P1 均已闭合，30 种子诈尸扫描归零，另加验了旧 optionId 必失败 / 零选项死锁 / 年龄冻结 / 槽位让位 / 跨版本逐字节前缀 / 结局漂移归因。详见 **§十四**（本文件下半部分），§一~§十三 为 R1（HEAD `8c99cf3`）原始记录，保留不动。

---

## 一、四条口径（自跑，不采信转述）

| 命令 | 退出码 | 结果 | 与实现方自述 |
|---|---|---|---|
| `pnpm typecheck` | 0 | 无输出（通过） | — |
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | 0 | **31 files / 442 tests passed**，67.30s | 报 442 ✅ 一致 |
| `pnpm --filter @life-sim/shared exec vitest run --no-file-parallelism` | 0 | **4 files / 62 tests passed**，6.54s | 报 62 ✅ 一致 |
| `pnpm build` | 0 | typecheck + `vite build` 成功，`index-*.js 269.15 kB (gzip 83.21 kB)` | — |

---

## 二、A 不诈尸（用户点名的第一条）—— **FAIL（2×P1）**

### A-1 逐个角色收尾态（12 局 = 6 种子 × 2 开局，全部一致）

| 角色 | 期望 | 实测 | 判 |
|---|---|---|---|
| `npc-nanami` | 涩谷后 `inactive(阵亡)` | `inactive(阵亡)`（12/12） | PASS |
| `npc-haibara` | `inactive(阵亡)` | `inactive(阵亡)`（12/12） | PASS |
| `npc-megumi` | `inactive(被宿傩夺舍)` | `inactive(被宿傩夺舍)`（12/12） | PASS |
| `npc-gojo` | 仅封印线 `inactive(封印)` | `alive` ‖ `inactive(封印)`（按线而定） | PASS |
| `npc-nobara` | 仍 `alive`（只受伤不写死） | `alive`（12/12），全模板无 `setNpcLifecycle(npc-nobara)` | PASS |
| `npc-yuji` | 归还后 `alive` | `alive`（12/12） | PASS |
| **`npc-riko`** | 死亡应 `inactive` | **`alive`（12/12），而 `rikoDead=true` 12/12** | **FAIL** |

`setNpcLifecycle` 全模板写入点（静态扫描，**14 个 effect 实例**；下表 7 行按事件归并，括号内为逐选项展开的份数，合计 14 个实例）：

```
ev-df-02  npc-haibara  inactive  阵亡        (×3 选项)
ev-bs-05  npc-haibara  inactive  阵亡        (×2 选项)
ev-sh-03  npc-gojo     inactive  封印        (×2 选项)
ev-sh-03b npc-yuji     inactive  宿傩受肉
ev-sh-04n npc-nanami   inactive  阵亡        (×2 选项)
ev-sh-05  npc-yuji     alive                 (×3 选项)
ev-cg-04  npc-megumi   inactive  被宿傩夺舍
```

→ 写入面覆盖 haibara / gojo / yuji / nanami / megumi，**漏了 riko**。

### A-2 引用面 ①：战斗 `enemies`/`allies` ref 的引擎自动过滤

| 场景 | 实测建场 | 判 |
|---|---|---|
| 封印线 `ev-sj-02`（模板静态声明 allies 含 `npc-gojo`） | `enemy-sukuna-megumi \| allies=npc-yuji` —— **五条被引擎判活滤掉** | PASS |
| 未封印线 `ev-sj-02-gojo` | `enemy-sukuna-megumi \| allies=npc-gojo+npc-yuji` —— 五条在场 | PASS |
| `unspawned` 的 `npc-yuta` 作 allies | 叛逃线全程无 `ev-sj-02c`，无异常建场 | PASS |
| `ev-cg-02c`（allies 含 `npc-megumi`） | 链序 `ev-cg-02c → ev-cg-03 → ev-cg-04`（夺舍在后），无「夺舍后仍当友军」 | PASS |
| `ev-jv-01` / `ev-sj-01c`（allies 含 `npc-nobara`，她始终 alive） | 正常 | PASS |

### A-3 引用面 ②：日常池事件的判活条件

| 事件 | 条件 | 判 |
|---|---|---|
| `ev-d3-yuji` | `npcState npc-yuji alive` + `yujiJoined` | PASS |
| `ev-d3-megumi` | `npcState npc-megumi alive` | 条件本身正确（见 A-5） |
| `ev-d3-yuta` | `npcState npc-yuta alive` + `yutaGone ne true` | PASS |
| `ev-d-gojo` | `era==1` + `gojoGone ne true` | PASS |
| `ev-d-spar` | `era==1` + `nanamiGone ne true` | PASS |
| `ev-d-haibara` | `era==1` + `haibaraDead ne true` | 条件本身正确（见 A-5） |
| **`ev-d-canteen`** | **只有 `era==1`，无任何判活**；正文「一张是七海和灰原」、`opt-ct-2`「坐到七海和灰原那桌」 | **FAIL** |
| `ev-d-class` | 只有 `era==1`（引用七海；七海死于 era 3，实际不受影响） | 可接受 |
| `ev-social-hook`（action-hook，跨全 era） | 每个 option 都带 `*Gone ne true` + `npcState alive` | PASS |

### A-4 引用面 ③：分支文本条件化

`ev-sj-01` 的「五条站在你旁边」带 `visibleWhen: gojoSealed ne true`，「没有五条」带 `gojoSealed eq true` —— 互斥且都可达（封印线实测走 `opt-sj1-alone`）。PASS。

### A-5 **【P1-1】已 inactive 却仍能出场 —— 运行时反例搜索**

方法：30 种子全量驱动，在每条事件**结算时刻**逐条求值 `visibleWhen`，只统计「正文点名已故角色」或「可见选项的效果仍指向已故角色」，排除死亡写入事件本身，排除被 `visibleWhen` 挡住的选项。

| 反例 | 命中 | 类型 | 出处 |
|---|---|---|---|
| `ev-d-canteen ⇐ npc-haibara` | **11/30 种子**（1,6,7,11,13,16,17,19,20,27,28） | 可见选项 `opt-ct-2` 仍可对已故角色生效 + 正文点名 | `events.yaml:686-718`（`opt-ct-2` 在 `:707`） |
| `ev-d-haibara ⇐ npc-haibara` | **9/30 种子**（1,6,13,16,17,20,26,27,28） | `opt-hb-1/2/3` 全可见 + 正文「灰原把一个巨大的便当盒拍在你桌上」 | `events.yaml:858` |
| `ev-d3-megumi ⇐ npc-megumi` | **5/30 种子**（3,4,10,11,27） | `opt-mg-1/2/3` 全可见 | `events.yaml:1176` |

**已排除的误报**（记录于此，避免重复劳动）：
- `ev-social-hook`（粗匹配 30/30）：所有 option 都带 `npcState alive` + `*Gone`，属我第一版 JSON 粗匹配误报。
- `ev-sj-01`（24/30）：`opt-sj1-gojo` 被 `gojoSealed` 挡住。
- `ev-sh-05`（17/30）：它本身就是「归还身体 ⇒ alive」的唯一写回入口，不是诈尸。

**根因（精确定位，非猜测）**：池事件在 **fire 时刻**通过判活，随后进入 `state.pendingEvents` 队列排队，等玩家逐条结算；**期间角色死亡，引擎不再复核，事件照原样呈现**。`scheduler.evaluateDue` 只对 `scheduledEvents` 在出队时复核条件（`scheduler.ts:248`），`pendingEvents` 已是「已触发」状态，没有二次校验。

实测证据（种子 1，逐条打印 fire 轮 / 结算轮 / 队列长度）：

```
ev-d-canteen  fire@t212 → settle@t220   排队 8 轮，pendingQueueLen=5，haibara 已 inactive(阵亡)、era 已 1→2
ev-d-haibara  fire@t216 → settle@t223   排队 7 轮，pendingQueueLen=2，haibara 已 inactive(阵亡)
ev-d3-megumi  fire@t280 → settle@t282   排队 2 轮，megumi 期间被夺舍
```

fire 时刻条件为真（haibara 尚 alive、era 仍 1），结算时刻条件已假 —— **但没人再看一眼**。

附带发现：`pendingEvents` 可积压到 **5 条**（种子 1，t220），这本身也是体验问题（见风险 R2）。

### A-6 **【P1-2】`npc-riko` 死亡不落 lifecycle**

```
npc-riko  lifecycle = alive
flags.rikoDead = true                （12/12 局，100%）
玩家端面板出现 = 是，面板 lifecycle = alive，age = 26
面板条目 = {"id":"npc-riko","name":"天内理子","age":26,...,"lifecycle":{"state":"alive",...}}
```

死亡写入点全部只写 flag，没有 lifecycle：

- `ev-sp-05b`（`events.yaml:1816`，3 个选项都在 `:1828/:1835/:1843` 写 `rikoDead`）
- `ev-sp-00b`（`:1610` / `:1619`，留守线的「事后通报」同样确认死亡）
- `opt-sp5a-sacrifice`（`:1794`，同化消失）

后果：一个原文必死、本模板 100% 死掉的角色，在玩家面板上一直「在世」，**年龄还一路长到 26 岁**。这正是用户第一条要求直接禁止的现象。

补充：`characters.yaml:161` 给 `npc-riko` 标了 `visibility: hidden`（协议 `TEMPLATE_PROTOCOL_V2.md:169` 写「hidden 角色不进投影」），但她仍出现在 `/api/worlds/:id` 的 `snapshot.npcs` 里 —— 见 §六 F-3（P2，引擎侧、pre-existing）。也就是说 P1-2 在当前 HEAD 上**是玩家看得见的**。

---

## 三、B 身体争夺（状态切换 + cause）—— PASS

两条路各真跑一遍。引擎级探针（`chooseOptionV2` 直调，与 API 同一函数）+ HTTP 端到端探针（`POST /api/worlds/:id/events/choose` 直推）双证。

### B-1 放任（`opt-sh3b-let`）

```
ev-sh-03b 结算时        ：npc-yuji = alive
ev-sh-04（伏魔御厨子）   ：触发 ✅，敌人 = enemy-sukuna@0.5，allies 为空（虎杖此时 inactive）
ev-sh-05 待决时(t290)   ：npc-yuji = inactive(宿傩受肉)     ← HTTP 直推实测
ev-sh-05 结算后(t293)   ：npc-yuji = alive，reasonCode 已清
sukunaTookOver=true / shibuyaSurvived=false / sukunaRepelled=false
代价：玩家 HP 206 → 1（几乎被打死），mood 100 → 54
```

### B-2 压制（`opt-sh3b-hold`）

```
ev-sh-04                ：未触发 ✅（eventFires 精确匹配，非子串）
npc-yuji                ：全程 alive ✅
代价（三重，非白给）     ：mood −20、adjustRelation npc-yuji −8（实测 rel 92 vs 放任 100）、
                          applyStatus exhausted 1 层
shibuyaSurvived=true，玩家 HP 保持 206（毫发无伤换人格代价）
```

> 注：HTTP 探针中 `startedSh04` 一度因 `ev-sh-04n` 的 id 子串误报，已改为精确匹配；上表以 `eventFires` 精确 id 为准。

### B-3 「cause 只是字符串」—— 已证明

同一 NPC、同一 `state: inactive`、四种 `reasonCode`（`阵亡` / `宿傩受肉` / `被宿傩夺舍` / 无）：

| reasonCode | 投影（去掉 reasonCode 后）逐字节一致 | `npcState inactive` | `npcState alive` | 关系写入冻结 |
|---|---|---|---|---|
| 阵亡 | ✅ true | true | false | ✅ 生效 |
| 宿傩受肉 | ✅ true | true | false | ✅ 生效 |
| 被宿傩夺舍 | ✅ true | true | false | ✅ 生效 |
| （无） | ✅ true | true | false | ✅ 生效 |

代码侧同一结论：`engine.ts:487` 是 `if (effect.state !== "alive") state.relations = freezeOnDeath(...)` —— 只读 `state`，从不读 `reasonCode`；`engine.ts:215-216` 的 `npcState` 条件同样只比 `state`。

---

## 四、C 二番战与两个宿傩 —— PASS

### C-1 链路（受控胜利，种子 1）

```
ev-ch7-gate@t309 → ev-sj-01b@t310 → ev-sj-01c@t311 → ev-sj-01@t312
→ ev-sj-02-gojo@t313（敌 enemy-sukuna-megumi）
→ ev-sj-02b@t314（敌 enemy-sukuna-incarnate）   ← 二番战
→ ev-sj-02c@t315（敌 enemy-kenjaku）
→ ev-sj-03@t316（命运轮）→ ev-sj-04@t316
beatSukuna=true / beatSukunaIncarnate=true
```

### C-2 战败收尾

| 场景 | 构造方式 | 结果 | `ev-sj-04` |
|---|---|---|---|
| 一阶段战败（`ev-sj-02-gojo`） | `ev-sj-01` 结算前削弱玩家（战斗在 `createBattle` 时快照 `player.hp`） | `finalEnd=hero-death` → **end-death**，day 4736，`ev-sj-02b/03/04` 全未触发 | **false** ✅ |
| 二番战战败（`ev-sj-02b`） | 二番战建场后每次出手前把 `battle.player.hp=1` + `state.player.attributes` 压到 1（`playerCombatant` 现读 `state.player.attributes`，两者都要改） | `finalEnd=hero-death` → **end-death**，`ev-sj-02b` 已触发、`ev-sj-02c/03/04` 全未触发 | **false** ✅ |

→ 「战死还去喝咖啡」已彻底修掉（12 局全量复核：所有 `finalEnd=hero-death` 的局 `ev-sj-04` 均为 false）。

### C-3 两张宿傩卡数值（`characters.yaml` 实读，非转述）

| 卡 | 名称 | cursedEnergy | intellect | physique | agility | skills |
|---|---|---|---|---|---|---|
| `enemy-sukuna`（涩谷·借虎杖） | 两面宿傩 | 72 | 11 | 12 | 11 | dismantle, cleaves, fuga, malevolent |
| `enemy-sukuna-megumi`（一阶段·借伏黑） | 两面宿傩（伏黑惠之身） | **78** | 11 | 13 | 12 | 上述 4 项 **+ sk-ten-shadow** |
| `enemy-sukuna-incarnate`（二阶段·受肉） | 两面宿傩（受肉） | **105** | 12 | 15 | 12 | 上述 4 项（**无 ten-shadow**） |

二阶段 − 一阶段 = `{cursedEnergy +27, intellect +1, physique +2, agility 0}`。
`levelScale`：一阶段 0.58、二阶段 0.55 → 有效 CE 45.24 vs 57.75，**二阶段确更强**（即使算上 0.55 的缩放）。

> 观察（P3，不阻断）：二阶段「更强」只体现在属性；一阶段反而多一门 `sk-ten-shadow`。技能多样性上二阶段是「减法」。

---

## 五、D P0 因果修复可达性（逐条真跑）—— PASS（D8 形态偏差、D9 登记）

| # | 项 | 实测 | 判 |
|---|---|---|---|
| D1 | `ev-sp-04` `tojiBeaten` ⇒ 理子线变化可达 | 跟去线：`ev-sp-03` 胜 → `ev-sp-04a` → `opt-sp4a-shield` → **`savedRiko=true`** → `ev-sp-05a`；败 → `ev-sp-04` → `ev-sp-05b` → **`rikoDead=true`、`savedRiko=false`** | PASS |
| D2 | `ev-sp-00` 留守线不再「不在场却目击现场」 | 留守线只触发 `ev-sp-00 → ev-sp-00b → ev-sp-06`，**`ev-sp-03/04/05b` 全未出现**；`ev-sp-00b` 文案全为「通报 / 事后转述」 | PASS |
| D3 | `ev-d3-eve` 现在可达 | 12/12 局与 30 种子扫描中均命中（条件 `era==3 && chapter==9 && shDone ne true && time>=4674d`） | PASS |
| D4 | 封印五条的阵容差异，两条分别可达 | 封印线 → `ev-sj-02`（allies 实测只剩 `npc-yuji`）；未封印线 → `ev-sj-02-gojo`（allies=`npc-gojo+npc-yuji`） | PASS |
| D5 | 叛逃线 `ev-df-01..04` 可达，`end-defected` 不被 legend 抢走 | 4 条全触发，结局 = **`end-defected`**（priority 68 > legend 63） | PASS |
| D6 | `finalEnd=survived` 有对应结局 | 真跑 `resolveEnding`，7 个 `finalEnd` 全部落到专属结局：`survived→end-survived`、`lost→end-lost`、`hero-death→end-death`、`special→end-special`、`legend→end-legend`、`retire→end-retire`、`lost-all→end-lost-all` | PASS |
| D7 | 6 处假选择，每个 ≥2 选项且后果不同 | `ev-sp-06`(2)、`ev-bs-06`(2)、`ev-np-04`(2)、`ev-sh-05`(3，其中 1 带 `visibleWhen`)、`ev-jv-03`(2)、`ev-sj-04`(2)；后果签名去重 = 选项数，逐条已列 | PASS |
| D8 | `cgPath` 三分支在 `ev-cg-02*`/`cg-03` 真被读 | **部分成立**：`cgPath` flag 本身**只写不读**（写于 `events.yaml:3178/3186/3199`，读点为空）；真实分支由 `ev-cg-01` 三个选项的 `nextEventId` 分到 `ev-cg-02` / `ev-cg-02s` / `ev-cg-02r`（三条中间步各有独立后果），且 `ev-cg-03` 的 `opt-cg3-rule` 读 `cgRuleHacked`。功能上三分支真跑通，字面「cgPath 被读」不成立 | 形态偏差，登记 |
| D9 | `heldLine`/`shAggressive`/`usedPrep` 类只写不读 flag 是否仍存在 | **仍存在且规模很大**：全模板 163 flag 被写、47 被读、**119 只写不读**。点名：`heldNanamiLine`(`:3051`)、`shAggressive`(`:2857`)、`cgPath`、`ruleSavedMegumi`(`:3391`)、`beatSukuna`/`beatSukunaIncarnate`/`beatKenjaku`/`beatJogo`/`beatMahito`、`cgEscorted`/`cgSoldRule`/`cgBeatHorde`/`cgHordeLost`/`cgSplit`/`cgHordeLine`、`sjFrontLost`/`sjClearedFront`/`sjPair`、`noGojo`、`avengedNanami`、`froze`、`spHurt`、`dfRole`/`defectedLine`/`doubleAgent`/`defectedRaided`/`defectedWatcher`/`dfLeftTokyo`、`megumiTaken`、`nobaraHurt`…（`usedPrep` 模板内不存在，实现方自述的「heldLine」实为 `heldNanamiLine`）。另有 1 个「只读不写」`yutaGone`，由 `opening.yaml:38/100` 初始化为 false，属正常初始旗标，不算缺陷 | 如实登记，按要求不计退回理由 |

---

## 六、E 密度与代价 —— PASS（附平衡观察）

### E-1 事件/战斗增量（对比 `0ca88d0^`，逐 id 集合差集，非估数）

```
事件   91 → 109（+18，−0）
战斗   12 →  18（+6）
```

新增 18 事件：`ev-sp-00b` `ev-sp-04a`（P0 因果）、`ev-df-01/02/03/04`（叛逃线）、`ev-sh-03b` `ev-sh-04n`（身体争夺 + 七海谢幕）、`ev-cg-02s/02r/02b/02c`（死灭三分支 + 群像）、`ev-sj-01b/01c/rogue/02-gojo/02b/02c`（新宿群像 + 二番战 + 叛逃收束）。

新增 6 战斗：`ev-sh-04`（涩谷宿傩）、`ev-cg-02c`（死灭群像）、`ev-sj-01c`（新宿先头部队）、`ev-sj-02-gojo`（一阶段五条在场）、`ev-sj-02b`（二阶段受肉）、`ev-sj-02c`（羂索）。

按章：死灭回游 `ev-cg-*` 4 → **8** 事件（战斗 1 → **2**）；新宿 `ev-sj-*` 4 → **10** 事件（战斗 1 → **5**）。

### E-2 新增战斗的胜/负回报（全部 ≥2 项胜利回报、≥1 项失败后果，无白给）

| 事件 | 敌（levelScale） | 友军 | 胜利回报 | 失败后果 |
|---|---|---|---|---|
| `ev-sh-04` | enemy-sukuna@0.5 | — | 5 项 | 5 项 |
| `ev-cg-02c` | grade1@1.2 + curse-user@1.0 | nobara@0.9, megumi@0.9 | 7 项 | 5 项（含 `nobaraHurt`） |
| `ev-sj-01c` | grade1@1.4 + curse-user@1.2 + grade2@1.6 | nobara@1.0, yuta@0.9 | 8 项（含 hp+35 / mp+20 换防喘息） | 4 项（含 `sjFrontLost`） |
| `ev-sj-02-gojo` | sukuna-megumi@0.58 | gojo@1.0, yuji@0.8 | 5 项 | 4 项（= hero-death） |
| `ev-sj-02b` | sukuna-incarnate@0.55 | gojo@1.0, yuji@0.8 | 4 项 | 5 项（= hero-death） |
| `ev-sj-02c` | kenjaku@0.5 | yuta@0.9, yuji@0.8 | 5 项 | 4 项（不是终局死，`kenjakuEscaped`） |

### E-3 群像：五位角色各有可辨识戏份（不是一句台词）

| 角色 | 处数 | 具体 |
|---|---|---|
| 七海建人 | 1（专属） | `ev-sh-04n`「七海建人」整场谢幕：2 选项后果不同（守完出口 `heldNanamiLine` + 救人数 +4 vs 去复仇 `avengedNanami` + 真相 +2），两条路都落 `inactive(阵亡)` |
| 钉崎野蔷薇 | 4 | `ev-cg-02b`（数「九只」的对白 + 选边）、`ev-cg-02c`（友军 ref + 胜/负分支，败时「她为了把你拖出来挨了一下」）、`ev-sj-01b`（选她当搭档）、`ev-sj-01c`（友军 ref，先头部队） |
| 伏黑惠 | 4 | `ev-cg-02b`（「十一只」对白）、`ev-cg-02c`（友军 ref，夺舍前最后一次并肩）、`ev-cg-03`（被塞手指的现场）、`ev-cg-04`（lifecycle → 被夺舍） |
| 乙骨忧太 | 3 | `ev-sj-01b`（搭档选项）、`ev-sj-01c`（友军 ref，先头部队）、`ev-sj-02c`（友军 ref，对羂索） |
| 虎杖悠仁 | 7 | `ev-sh-03b`（身体争夺主戏）、`ev-sh-05`（归还）、`ev-sj-01b` + `ev-sj-02-gojo/02/02b/02c`（4 场决战友军 ref） |

### E-4 验实现方的一个说法：`ev-sj-01c` 的 `levelScale` 是否偏难

12 局（6 种子 × 2 开局，默认自动策略）战败分布：

| 局 | 战败点 |
|---|---|
| s1/o0, s1/o1 | 无战败（全胜，`end-legend`） |
| s2/o0, s2/o1 | `ev-sj-01c` 败 → `ev-sj-02` 败 |
| s3/o0, s3/o1 | `ev-sj-01c` 胜 → `ev-sj-02` 败 |
| s4/o0, s4/o1 | `ev-sj-01c` 胜 → `ev-sj-02` 败 |
| s5/o0, s5/o1 | `ev-sj-01c` 败 → `ev-sj-02` 败 |
| s6/o0, s6/o1 | `ev-sj-01c` 败 → `ev-sj-02` 败 |

- `ev-sj-01c` **6 胜 6 败（50%）**；
- **真正的死亡瓶颈是一阶段 `ev-sj-02`（levelScale 0.58）：10 败 / 12（83%）**；
- 连带效应：**默认策略下只有 2/12 局能走到二番战（`ev-sj-02b`）** —— 用户点名的「战胜后继续二番战」内容在自动通关里几乎看不到；
- `ev-sj-01c` 败北会让玩家无喘息进入 boss（败北无回血，胜利才有 hp+35/mp+20），构成「先头部队失手 ⇒ boss 必死」的连锁。
- 结论：**`ev-sj-01c` 偏难的说法只对了一半**（50% 战败率偏高，但不是主因）；要调的是 `ev-sj-02` 的 levelScale 或 `ev-sj-01c` 失败后的补偿。

---

## 七、F 回归 —— PASS（F-3 为 pre-existing P2）

| # | 项 | 实测 | 判 |
|---|---|---|---|
| F-1 | `playthrough` 6 种子 × 2 开局绿 | 12/12 全部收束，结局均在 `endings.yaml` 声明集合内（`end-legend` ×2、`end-death` ×10），day 4736–4755 | PASS |
| F-2 | 同 seed 两次运行逐字节一致 | 对 `turnIndex/worldTime/hp/mp/mood/attributes/flags/全部 npc(lifecycle+relationship+mood)/eventFires(含轮次与世界时间)/termination` 做 JSON 指纹，s1/o1、s2/o0、s3/o1 三组**两次运行完全一致** | PASS |
| F-3 | hidden 不进玩家端 API | `/api/worlds` 响应中 `secrets`/`private`/`combatHints`/`skillWeights`/`goals`/`traits` **均不出现** ✅；但 `characters[].visibility: hidden` 未生效 —— `npc-riko`（`characters.yaml:161` 声明 hidden）出现在 `snapshot.npcs`（玩家端 10 个 NPC 含她）。协议 `TEMPLATE_PROTOCOL_V2.md:169` 明确「hidden 角色不进投影」，而 `projection.ts:152-153` 只过滤 `unspawned`，不过滤 `visibility`。**pre-existing（本轮零改 projection.ts）** | 部分 FAIL（P2） |
| F-4 | `spawnLog` 恰好 1 条（`rule-yuta-arrival` 幂等） | 12/12 局 `spawnLog` 恰 1 条（t250–t259），`spawnRules` 恒为 `rule-yuta-arrival:spawned`；`ev-np-01` 在 `onVictory` 与 `onDefeat` 各写一次 `spawnNpc`，幂等生效 | PASS |
| F-5 | `npc-yuta` 2017 前不上屏、触发后上屏 | 新建世界 API 响应中 `npc-yuta` **不在** `snapshot.npcs`（`unspawned` 被投影过滤）；spawn 后首次上屏轮 ≥ spawn 轮（12/12，最早 s5 同轮 t250，最晚 s3 t280 vs spawn t251） | PASS |

### F-6 关于 `playthrough.test.ts` 的 `overall < 95` → `< 96`：**可接受，但建议收紧（P2）**

- 我实测 12 局 `overall` 区间 **94.51 – 95.02**，其中 2 局（s1/o0=95.01、s1/o1=95.02）越过旧的 95。
- 不饱和不变式**仍成立**：每维严格小于模板上界（最紧的是 `truth`/`freedom` 96.52–96.69 < 100，`growth` 89.8–91.59，`bonds`/`deeds` 95.45–95.66）；`overall` 12 个取值互不相同（区分度成立）。
- 因此**这个改动没有掩盖真问题**，按口径可接受。
- 但放宽幅度与实测漂移不匹配：为 0.02 的漂移让出 0.98 的余量（≈49×），等于把有效上界从 95 放宽到 96。建议改成 `95.1`，或改成「相对基线 + 明确预算」的断言，避免以后每轮内容增长都能靠抬阈值过。
- 另注：`truth`/`freedom` 两维在 12 局里的极差只有 0.17/0.17，已接近「无区分度」；当前不变式只要求 `< 上界`，所以不算失败，但值得作为下轮观察项。

---

## 八、专项检查

| 检查项 | 结果 | 证据 |
|---|---|---|
| 确定性可重现 | PASS | 同 seed 同开局两次运行状态指纹逐字节一致（s1/o1、s2/o0、s3/o1） |
| DEFERRED/RETIRED 未混入范围 | PASS | 本轮全部改动集中在模板 YAML 与测试；未出现 `R-TT-*` / `R-LC-*` 的实现或断言 |
| V1 残留符号 | PASS | `evaluateLife` / `advanceTurn(` / `PhaseTransitionLog` 在 `packages`/`apps` 的非测试代码中零命中；`apps/web/src/api.ts:132` 的 `advanceTurn` 是 HTTP 客户端方法名，非 V1 引擎符号 |
| 未引入 Lifecycle 状态机 | PASS | 不存在 `lifecycle.ts`；`Phase` 仅出现在 `boundary.test.ts` 的**反例断言**里；三态仍只有 `alive`/`inactive`/`unspawned` + 自由 `reasonCode` |
| hidden 未进入玩家端 API | 部分 FAIL | `private`/`secrets`/`combatHints` 未泄露 ✅；`visibility: hidden` 未生效（`npc-riko` 上屏）→ 见 F-3 |
| 未让 LLM 成为唯一状态裁判 | N/A | 本轮无 LLM 参与状态裁决；判定全部走声明式 `conditions` / `effects` |
| 服务已停止 | PASS | 端口 3000 无 LISTENING；`curl /health` 无响应 |

---

## 九、必须修复项（退回依据，只列 P0/P1）

| # | 严重度 | 问题 | 位置 | 建议 |
|---|---|---|---|---|
| 1 | **P1** | `npc-riko` 死亡不落 lifecycle：`rikoDead=true`（12/12 局）却仍 `alive`，且以「在世 · 26 岁」出现在玩家端 NPC 面板 | `events.yaml:1816`（`ev-sp-05b`，三个选项分别在 `:1828/:1835/:1843`）、`events.yaml:1610/:1619`（`ev-sp-00b`）、`events.yaml:1794`（`opt-sp5a-sacrifice`）；`characters.yaml:159` | 在上述四处各补 `{ type: setNpcLifecycle, npcId: npc-riko, state: inactive, reasonCode: 阵亡 }`（同化消失可用 `reasonCode: 同化`）。`savedRiko`/`rikoEscaped` 路径保持 `alive` |
| 2 | **P1** | 待决事件不复核判活：池事件 fire 时角色在世，排队 2–8 轮后角色已死，事件仍以原文案 + 可见选项呈现（实测 `ev-d-canteen` 11/30、`ev-d-haibara` 9/30、`ev-d3-megumi` 5/30 种子） | `events.yaml:686`（`ev-d-canteen` 无任何判活）、`:858`（`ev-d-haibara`）、`:1176`（`ev-d3-megumi`）；机制侧 `scheduler.ts:248` 只复核 `scheduledEvents` | 模板侧最小修：给引用在世角色的 option 补 `visibleWhen: [{ npcState: { npcId: …, state: alive } }]`（`ev-social-hook` 已是这个写法，照抄即可），并把 `ev-d-canteen` 的 `era==1` 补上 `haibaraDead ne true`。文案层若要彻底干净，需引擎侧在 pending 事件结算前复核 `trigger.conditions`（本轮产品代码零改，属下一轮 ADR 议题） |

---

## 十、非阻断缺陷与风险（P2/P3，登记不阻验收）

| # | 严重度 | 问题 | 位置 | 说明 |
|---|---|---|---|---|
| P2-1 | P2 | `characters[].visibility: hidden` 未在投影层生效，协议明写「hidden 角色不进投影」 | `packages/game-core/src/v2/projection.ts:152-153`；协议 `specs/core/TEMPLATE_PROTOCOL_V2.md:169` | pre-existing（本轮零改 projection.ts）。它把 P1-2 的 riko 诈尸变成玩家可见 |
| P2-2 | P2 | `playthrough.test.ts` 阈值 95→96，放宽 0.98 只对应实测 0.02 漂移 | `playthrough.test.ts:187` | 不变式仍成立故可接受；建议收紧到 95.1 或改相对断言（详见 F-6） |
| P2-3 | P2 | `pendingEvents` 队列积压到 5 条，玩家需要连续结算 5 个待决事件，且积压期状态漂移导致叙事失真 | 运行时观测（种子 1，t220） | 与 P1-2 同源；可作为下轮「待决队列上限 / 优先级」议题 |
| P2-4 | P2 | `cgPath` flag 只写不读，分支实际靠 `nextEventId` + `cgRuleHacked` 实现 | `events.yaml:3178/3186/3199` | 功能正确，命名误导；与 D9 同类 |
| P3-1 | P3 | `opt-cg3-rule` 的文案「用你改过的那条规则，把结界挪开三米」+ flag `ruleSavedMegumi`，但 `ev-cg-04` 无论如何都把 `npc-megumi` 置 `inactive(被宿傩夺舍)` | `events.yaml:3386-3396`、`:3416` | 玩家的「救人」选择在机制上不改变伏黑的结局，flag 名与文案形成反期待 |
| P3-2 | P3 | 二阶段宿傩「更强」只体现在属性，一阶段反而多一门 `sk-ten-shadow`；技能多样性上二阶段是减法 | `characters.yaml:388-426` | 数值上成立（CE 45.24 → 57.75），观感上略违和 |
| P3-3 | P3 | 119 个只写不读 flag（含 `heldNanamiLine` / `shAggressive` / `beatSukuna` / `cgEscorted` 等），模板「旗标即叙事」的意图大量落空 | 全模板 | 实现方已自述未清理，按要求不计退回理由；建议下轮统一清理或接进结局/评价维度 |
| P3-4 | P3 | 默认策略下只有 2/12 局能看到二番战；`ev-sj-02` 战败率 83% | `events.yaml:3620/3650/3692` | 见 E-4；不是功能缺陷，是可达性/平衡问题 |

---

## 十一、未覆盖项（显式「未验证」+ 原因）

| # | 未验证项 | 原因 |
|---|---|---|
| 1 | 命运轮真能转到 `finalEnd=survived` 并收束为 `end-survived` | 12 局里没有一局落到该段（weight 20 + `weightBy.physique` 被 `lost`/`retire`/`lost-all` 分流，且 10/12 局在 `ev-sj-02` 就战败止步，根本没到命运轮）。我只验证了**映射**（真跑 `resolveEnding`，7 个 `finalEnd` 全部落到专属结局），未验证**运行期命中率** |
| 2 | `ev-sj-02c`（羂索）战败后的分支后果（`kenjakuEscaped`） | 12 局里 `ev-sj-02c` 只在 s1 的 2 局触发且均胜；未构造受控战败 |
| 3 | `opt-cg3-deal`（需 `secondTech`）、`opt-cg1-kill`（需 `cgJoined`）等带 `visibleWhen` 的稀有选项 | 默认策略未覆盖到这些前置旗标组合，未逐条强推 |
| 4 | 12 局以外的种子（我用了 6 种子的正式回归 + 30 种子的诈尸扫描，两种集合不同） | 30 种子扫描只用于诈尸反例搜索（跑完即弃，不做全量断言），未对 30 种子逐局核对结局分布 |
| 5 | Web 端实际渲染（隐藏角色在面板上的观感、5 条待决事件的 UI） | 本轮不做视觉验收，仅验证 API 投影 |
| 6 | 真实玩家（非自动策略）下的平衡 | 自动策略只按 MP 排序放技能 + 45% 血线补药，不代表人类打法；E-4 的战败率是「机器人战败率」 |

---

## 十二、探针与证据文件

全部放在 `D:\code\_script-e2e\`，报告保持未跟踪：

| 文件 | 作用 |
|---|---|
| `lib-load.js` | 直接解析模板 YAML（不经 zod），用于静态扫描 |
| `harness.ts` | 引擎级驱动夹具（`makeState` / `drive` / `summary`，含 `pick` / `onStep` / `beforeStep` 钩子） |
| `probe-A-static.mjs` | A-1/A-2/A-3：lifecycle 写入点、战斗 ref、池事件判活条件 |
| `probe-A-runtime.ts` | A-6：riko 收尾态 vs 面板；A-3：`ev-d-canteen` 在灰原阵亡后条件仍通过 |
| `probe-A2.ts` | 30 种子诈尸粗筛（含已排除的误报） |
| `probe-A3.ts` | 30 种子诈尸**精确**检测（逐条求值 `visibleWhen`） |
| `probe-A4.ts` | P1-2 根因定位：fire 轮 vs 结算轮 vs `pendingEvents` 队列长度 |
| `probe-B.ts` | B：放任 / 压制两条路（引擎级） |
| `probe-B3.ts` | B-3：cause 只是字符串（投影逐字节 + 条件 + 关系冻结） |
| `probe-C.ts` | C：二番战链路 + 一/二阶段战败收尾 + 两张卡数值 |
| `probe-D.ts` | D1/D2/D4/D5：五条可达性线（含 3 条战斗 trace，带 allies） |
| `probe-D-static.mjs` | D7/D8/D9 + E-1：假选择、cgPath 读写矩阵、只写不读 flag、战斗回报 |
| `probe-D6D7.ts` | D6：7 个 `finalEnd` → 结局真跑；D7 选项逐条列 |
| `probe-EF.ts` | F：12 局回归 + 五维不饱和 + spawnLog + yuta 上屏时序 + 确定性 |
| `probe-G.ts` | C-2：12 局战败点（解析 `history` 的战斗结算记录） |
| `probe-E-cast.mjs` | E-2/E-3：新增战斗敌我阵容、五位角色戏份 |
| `probe-api.mjs` | 端到端 HTTP：`POST /api/worlds` → `turns` → `events/choose`（放任 / 压制各一局） |
| `old-events.yaml` | `0ca88d0^` 的 events.yaml 快照，用于 E-1 增量差集 |

复现命令（工作目录 `D:\code\ai-life-simulator`）：

```bash
pnpm --filter @life-sim/server exec tsx D:/code/_script-e2e/probe-C.ts
pnpm --filter @life-sim/server exec tsx D:/code/_script-e2e/probe-A3.ts     # 30 种子，约 4 分钟
pnpm --filter @life-sim/server exec tsx D:/code/_script-e2e/probe-EF.ts     # 12 局，约 4 分钟
node D:/code/_script-e2e/probe-D-static.mjs
# HTTP 探针需先 `pnpm --filter @life-sim/server start`，完事记得停
node D:/code/_script-e2e/probe-api.mjs
```

---

## 十三、总判

**退回**。必须修复项只有 2 条 P1（见 §九）：

1. `npc-riko` 死亡不落 lifecycle（100% 对局必现，玩家端可见「已死角色在世且长到 26 岁」）；
2. 待决事件在排队期间角色死亡后仍按原文呈现（`ev-d-canteen` 11/30、`ev-d-haibara` 9/30、`ev-d3-megumi` 5/30 种子）。

其余全部 PASS：四条口径、不诈尸的其余 6 个角色与三类引用面（战斗 ref 过滤实测五条不在场）、身体争夺的双向切换与 cause 字符串性、二番战两阶段与战败收尾、P0 因果 9 项可达性、密度与群像、12 局回归与确定性、spawn 幂等与 yuta 上下屏时序。

修完第 1、2 条后建议直接以本报告的 `probe-A3.ts` 与 `probe-A-runtime.ts` 复跑做回归门——两者都是确定性输出，跑通即闭合。

---
---

# 十四、复验 R2（HEAD `b1321ec`）

- 验收人：life-sim-qa（严过关）
- 时间：2026-11-12
- HEAD：`b1321ec500979b53d47e0532039b00950b0cedd5`
- 工作区：`git status --short` 只有本报告（未跟踪）
- 复验对象：

```
b1321ec  fix(projection)  已故者年龄冻结在死亡时刻（P1-2 任务 C / ADR-0024 补遗）
bbb440b  feat(engine)!    待决事件的「呈现前前提复核」—— pending 不是已定论（ADR-0024）
0759497  fix(template)    npc-riko 死亡落 lifecycle（QA P1-1）
```

改动面（`git diff --stat 8c99cf3 HEAD`，+1064/−21）：

| 文件 | 增量 | 性质 |
|---|---|---|
| `packages/game-core/src/v2/turn.ts` | +145 | `revalidatePendingV2` + 四个入口 + 投影前收敛 |
| `packages/game-core/src/v2/scheduler.ts` | +56 | `checkEventPremise` 单一谓词；`evaluateDue` 等价重构 |
| `packages/game-core/src/v2/projection.ts` | +9 | 年龄基准改为 lifecycle |
| `apps/server/src/store.ts` / `index.ts` | +25 / +12 | `hydrate` 规范化 + `event_premise_invalidated ⇒ 409` |
| `specs/data/templates/jjk-2006/events.yaml` | +19 | riko lifecycle ×7 + `ev-d-canteen` 前提 |
| `pending-premise.test.ts`（新） / `npc-age-projection.test.ts` | +396 / +72 | 用例 |
| `docs/DECISIONS.md` | +351 | ADR-0024（不参与验收） |

## 14.0 R2 裁决

- **裁决：通过**
- 一句话理由：R1 的两条退回依据（`npc-riko` 死亡不落 lifecycle、待决事件排队期间死人不撤）**均已闭合**：30 种子精确诈尸扫描 **0 命中**（R1 为 18 命中）；连带验明「旧 optionId 必失败」「零选项死锁不存在」「丢弃不吞轮次」「年龄冻结」「跨版本前缀逐字节相同且首差只在 `pendingQueue`」全部成立。新发现 3 条 P3 + 1 条未复现的 P2 结构性风险 + 1 条归因修正，均不阻断。

## 14.1 四条口径（自跑）

| 命令 | 退出码 | 结果 | 与实现方自述 |
|---|---|---|---|
| `pnpm typecheck` | 0 | 通过 | — |
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | 0 | **32 files / 462 tests passed**（R1 为 442，+20：`pending-premise` 16 + `npc-age-projection` +4），69.6s | — |
| `pnpm --filter @life-sim/shared exec vitest run --no-file-parallelism` | 0 | **4 files / 62 passed** | 与 R1 一致（`packages/shared` 本轮零改动） |
| `pnpm build` | 0 | typecheck + `vite build` 成功（269.15 kB） | — |

`replay.test.ts` 本轮**零改动**（`git diff` 为空）且 9/9 通过 —— 但注意它是「同 seed 两次回放逐字段相等」的**确定性**断言，不是行为金标；真正能发现行为漂移的是 §14.6 的跨版本前缀对比。

## 14.2 P1-1 闭合：`npc-riko` 死亡落 lifecycle —— PASS

effect 实例从 **14 个增到 21 个**（+7 全部是 riko；按事件 walk 统计，`grep -c` 的 23 行含 2 行注释），riko 现覆盖 7 处（`ev-sp-05b` ×3、`ev-sp-00b` ×2、`opt-sp5a-sacrifice`、`opt-sp5a-escape`）。

12 局实测（6 种子 × 2 开局）：

```
s1/o0 end-death   day=4736 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s1/o1 end-death   day=4736 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s2/o0 end-legend  day=4755 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s2/o1 end-legend  day=4755 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s3/o0 end-survived day=4755 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s3/o1 end-survived day=4755 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s4/o0 end-death   day=4736 rikoDead=true lifecycle=inactive(阵亡) 死亡日=216 面板age=14 stage=youth/青年
s4/o1 end-death   day=4736 rikoDead=true lifecycle=inactive(阵亡) 死亡日=216 面板age=14 stage=youth/青年
s5/o0 end-death   day=4736 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s5/o1 end-death   day=4736 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s6/o0 end-death   day=4737 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年
s6/o1 end-death   day=4737 rikoDead=true lifecycle=inactive(阵亡) 死亡日=215 面板age=14 stage=youth/青年

收尾态取值集合 = ["inactive(阵亡)"]      ← R1 为 ["alive"]
面板 age 取值集合 = [14]                 ← R1 为 [26]，且年年长岁
```

另外两条支线（默认策略不走，用强制选项覆盖）：

| 支线 | flags | lifecycle | 面板 age | 判 |
|---|---|---|---|---|
| 逃生（`opt-sp4a-shield` → `opt-sp5a-escape`） | `savedRiko=true`,`rikoEscaped=true` | **`alive`** | 26（随 worldTime 正常增长） | PASS |
| 同化（`opt-sp5a-sacrifice`） | `savedRiko=false` | **`inactive(被同化)`** | 14（冻结） | PASS |

> 结论：R1 判的 `npc-riko` P1 **已闭合**，包括「已死却显示在世」与「死人长岁」两个症状。`visibility: hidden` 未生效（riko 仍上屏）是另一件事、pre-existing，见 14.7-P2(2)。

## 14.3 P1-2 闭合：呈现前前提复核 —— PASS

### 14.3.1 30 种子精确诈尸扫描归零（R1 的退回依据，亲自证伪）

沿用 R1 的 `probe-A3.ts`（逐条在**结算时刻**求值 `visibleWhen`，只统计「正文点名已故角色」或「可见选项的效果指向已故角色」）。唯一的方法是**修正一处误报排除**：把「本事件是该作者 lifecycle 写入点（含 `alive` 写回）」一并排除 —— `ev-sh-05` 本来就是把虎杖写回 `alive` 的入口，此刻他 `inactive` 是**前提**而非诈尸（R1 已人工识别过这条误报）。

| 版本 | 命中 |
|---|---|
| R1（`8c99cf3`） | `ev-d-canteen` 11/30、`ev-d-haibara` 9/30、`ev-d3-megumi` 5/30（去重前 18 条命中） |
| **R2（`b1321ec`）** | **无（0 命中）** |

抛除两类误报后（`ev-social-hook` 的选项全带 `npcState`、`ev-sj-01` 的 gojo 选项被 `gojoSealed` 挡住），R2 的 30 种子扫描**一条不剩**。

### 14.3.2 丢弃机制真的在跑（不是「事件根本没触发」的假阴性）

30 种子队列差分统计（`droppedPending` 不在返回结构上，改从 `pendingEvents` 前后差分观测，见 14.7-P3(1)）：

```
含丢弃的局 = 29/30      总丢弃 = 87 条
once 事件被丢弃 = 0      未收束（软锁）= 0/30
章节门触发数：30 局全部 7/7（ch1..ch7 一个不丢）

按事件：ev-d-spar 11 | ev-d-shoko 10 | ev-d3-megumi 10 | ev-d-class 7 | ev-d-gojo 6
        ev-d-haibara 5 | ev-d-mission 5 | ev-d-market 5 | ev-d-geto 4 | ev-d2-overtime 4
        ev-d2-train 4 | ev-d-rumor 4 | ev-d2-solo 3 | ev-d-canteen 2 | ev-d2-kouhai 2
        ev-d2-investigate 2 | ev-d2-grave 2 | ev-d3-yuji 1
```

关键读数：`ev-d-canteen` 只被丢 2 次（模板侧补了 `npcState npc-haibara alive` 前提，多数情况下它**根本不会入队**）；而 `ev-d-haibara`（flag 判活）5 次、`ev-d3-megumi`（`npcState` 判活）10 次仍被丢 —— **证明模板条件本来就写对的那两类，只靠模板永远挡不住，必须靠引擎复核**。这与 ADR-0024 的立论一致。

### 14.3.3 旧 optionId 提交必须失败 —— PASS（R1 未验过的最深一条）

真实模板、真实对局状态，手工破坏前提（`flags.era` 1→2）后提交该事件原有的 optionId：

```
靶子=ev-d-gojo 选项=opt-gj-1
  抛错=event_premise_invalidated                              PASS
  计数不变：t 16→16 wt 135360→135360 history 47→47 fires 17→17 missed 0→0   PASS
  队列 ["ev-d-gojo","ev-d-geto","ev-d-class"] → []
  再提交同一 optionId → no_pending_event                      PASS

靶子=ev-d-spar 选项=opt-sp-1
  抛错=event_premise_invalidated                              PASS
  计数不变：t 17→17 wt 136800→136800 history 54→54 fires 18→18 missed 0→0   PASS
  队列 ["ev-d-spar"] → []
  再提交同一 optionId → no_pending_event                      PASS

靶子=ev-d-spar 选项=opt-sp-1（第三例，t22）
  抛错=event_premise_invalidated                              PASS
  计数不变：t 22→22 wt 144000→144000 history 80→80 fires 21→21 missed 0→0   PASS
```

要点：**前提已假却还能结算成功**这条路径被堵死，且失败是「静默排空 + 明确错误码」而不是「结算成功」或「选项不存在」这种误导性报错。错误码与 HTTP 映射：`apps/server/src/index.ts` 把 `event_premise_invalidated` 与 `pending_event_required` 等放进同一 `interactionErrors` 集合 ⇒ 409（该集合路径实测有效：待决时再推一轮返回 `{"error":"pending_event_required"} HTTP=409`）。

### 14.3.4 零选项死锁 —— 不存在（严格判据）

R1 我曾担心「全选项失效 ⇒ `pendingEvent.options === []` ⇒ 玩家无路可走」，实现方据此否决了我那个补丁（ADR §五）。复核判据收紧为 **`termination === null` 且 `pendingEvents.length > 0` 且 投影 `pendingEvent === null`（或 `options.length === 0`）**：

```
30 种子严格扫描：0 命中 ✅
```

诚实记录：我第一版检测器报了 10 处「零选项」，**全部是误报** —— 因为没排除「已终止」状态（`projectSnapshotV2` 里 `pendingEvent: ended ? null : …`）。10 处全部落在终局战斗/时间到点的最后一步。收紧判据后归零。

### 14.3.5 槽位让位不吞轮次 —— PASS

队首前提失效后调 `advanceTurnV2`：

```
s1 事件=ev-d-gojo  advanceTurn 抛错=(无) | t 16→17 wt 135360→136800 fires 17→18 missed 0→0
   队列 ["ev-d-gojo","ev-d-geto","ev-d-class"] → ["ev-d2-overtime"]
   判：不被挡=PASS 恰好+1轮=PASS missed不变=PASS
s3 事件=ev-d-gojo  advanceTurn 抛错=(无) | t 13→14 wt 132480→133920 fires 14→14 missed 0→0
s5 事件=ev-d-rumor advanceTurn 抛错=(无) | t 23→24 wt 145440→146880 fires 18→18 missed 0→0
```

- 「不被 `pending_event_required` 挡」= PASS（这是决策 2.5 的硬死锁点）
- 「恰好推进 1 轮」= PASS
- 「丢弃本身不动 `turnIndex/worldTime/history/eventFires/missedEvents`」= PASS（由 14.3.3 的 `chooseOption` 路径证明：一次纯丢弃，五个计数**全部不变**）

> 口径说明：14.3.5 里 `advanceTurn` 之后 `history` 会增长，那是**这一轮自己的行动历史**（正常写），不是丢弃造成的。若把两者混在一行里看会误判成 FAIL —— 实现方自测的那条「丢弃前后长度全不变」测的是一次纯 `revalidatePendingV2`，口径正确。

### 14.3.6 前提求值单一谓词等价性 —— PASS

把 `8c99cf3` 的 `evaluateDue` 序 1/序 2 逻辑**内联重写**，与新的 `checkEventPremise` 版在同一真实中局状态（t=157, day=184, ch=1, era=1）上逐事件比对：

```
一致=109  差异=0（共 109 事件）→ PASS
```

口径限制（如实写）：此对比覆盖 `drop(miss_when)` 与 `hold(conditions)` 两个分支；「前提全过 ⇒ 只剩冷却」那一步两边调的是同一个 `evaluateDue`，属同义反复。**冷却分支的等价性由 §14.6 的跨版本整段前缀比对间接覆盖**（前缀 233–288 步逐字节相同，其中含大量冷却判定）。

## 14.4 逐条 PASS/FAIL

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | 30 种子诈尸扫描重跑 → 0 命中 | **PASS** | §14.3.1：0（R1 为 18）；同时 §14.3.2 证明机制在跑（87 条丢弃）|
| 2 | ① 投影不呈现 ② 队列排空 ③ 旧 optionId 提交必须失败 | **PASS** | §14.3.3：`event_premise_invalidated` + 队列 `[…]→[]` + 再提交 `no_pending_event`；`pendingEventView` 还有 `+37` 独立流的只读兜底 |
| 3 | 零选项死锁不可观测 | **PASS** | §14.3.4：严格判据 0 命中（并记录了我第一版 10 处误报的成因）|
| 4 | 年龄冻结；复活后恢复 | **PASS** | §14.5 |
| 5 | 槽位让位不吞轮次（五项计数不变） | **PASS** | §14.3.5 + §14.3.3 |
| 6 | S1 确定性判据（首丢之前前缀逐字节相同 + 首差落在丢弃轮次） | **PASS**（我按新表述独立复核，见 §14.6） | 跨版本比对：6 局前缀全部逐字节相同，**首差步唯一差异字段恒为 `queue`**；三种策略重复验证 |
| 7 | 结局分布 6 局全漂移：因果对齐漂移 or 掩盖回归 | **PASS，但归因需修正** | §14.6：我**完全复现**了实现方报的 6/6 漂移（含具体结局串）；但用「内容稳定策略」对照后只有 1/6 漂移 ⇒ 主因是自动策略的索引敏感性，不是内容因果；判定「非回归」的四条独立依据见 §14.6.3 |
| 8 | `hidden` 不泄露 / `spawnLog` 恰 1 / `yuta` spawn 前不上屏 / `replay` 不变 | **PASS**（`hidden` 保留 1 条 pre-existing P2） | §14.4.1 |

### 14.4.1 第 8 项的实测

```
POST /api/worlds 响应 9595 B：
  泄漏(secrets)=false 泄漏(private)=false 泄漏(combatHints)=false
  泄漏(skillWeights)=false 泄漏(traits)=false 泄漏("goals")=false
  snapshot 是否含 pendingEvents/spawnLog/eventFires/scheduledEvents → 全部 false
  （⇒ ADR 决策 4 的 droppedPending 也不可能出现在玩家端）
NPC 上屏 10 个：yaga,gojo,geto,shoko,nanami,haibara,riko,yuji,megumi,nobara
  npc-yuta 在玩家端? false（spawn 前不上屏）✅
  npc-riko 面板 = {age:14, stage:youth, life:{state:"alive"}}（2006 开局她确实在世，正确）
```

12 局 `spawnLog` 全部**恰好 1 条** `rule-yuta-arrival`（t243–t262），`spawnRules` 恒 `spawned`；`npc-yuta` 首次上屏轮 ≥ spawn 轮（12/12）。`replay.test.ts` 零 diff、9/9 通过。

## 14.5 年龄冻结 —— PASS

合成对照（riko，`birthTime = birthTimeFromAge(14)`）：

```
死亡当刻(day300)   age=14 stage=youth inactive
推到 day4755       age=14 stage=youth inactive   ← 与上一行完全一致（冻结 4455 天）
复活@day4755       age=27 stage=youth alive      ← sinceWorldTime 刷到当下，按真实年龄派生
再推到 day5000     age=27 stage=youth alive
再推到 day5600     age=29 stage=youth alive      ← 恢复增长
参照 ageAt(birth,4755d)=27  ageAt(birth,5600d)=29 （与活着的算法一致）
冻结=PASS  复活后恢复增长=PASS
```

真实对局侧见 §14.2：12 局面板 `age` 恒 14，而终局 day 已到 4736/4755 —— 死亡后不再长岁。

一个可接受的观感副作用：复活瞬间年龄会从冻结值「跳」到真实年龄（14 → 27）。这是语义正确的（她确实该 27 岁），但若前端有年龄变化动画会显得突兀 —— 记录，不阻断。

## 14.6 S1 确定性与结局漂移归因

### 14.6.1 方法（跨版本真比对，不是读代码推断）

把 `8c99cf3` 的 `packages/game-core/src` 用 `git archive` 取到 `D:/code/_script-e2e/old-core`（配 `@life-sim/shared` 与 `relationship.js` 的 junction），然后**同一个探针脚本、同一策略**分别跑旧/新引擎，逐步记录状态指纹（turnIndex / worldTime / hp / mp / mood / attributes / skills / flags / 全部 npc(lifecycle+relationship+mood) / eventFires(含轮次与世界时间) / pendingQueue / chains / termination），再逐字节比。三种策略各跑 6 种子。

### 14.6.2 结果

**策略 = 完全复刻 `playthrough.test.ts`**（preferred 正则优先，否则 `(seed+picks++)%len`）：

```
s1 old=end-death@d4736(395)        new=end-death@d4737(396)        相同前缀=259 首差字段=["queue"]
s2 old=end-lost-all@d4755(437)     new=end-legend@d4755(437)       相同前缀=324 首差字段=["queue"]
s3 old=end-secret-thrice@d4755(337) new=end-secret-thrice@d4755(330) 相同前缀=219 首差字段=["queue"]
s4 old=end-death@d4736(368)        new=end-survived@d4755(364)     相同前缀=244 首差字段=["queue"]
s5 old=end-secret-thrice@d4755(366) new=end-lost@d4755(369)         相同前缀=237 首差字段=["queue"]
s6 old=end-secret-thrice@d4756(343) new=end-death@d4736(326)        相同前缀=220 首差字段=["queue"]

6 局首差字段均只有 queue = true   结局相同局数 = 2/6
旧：death / lost-all / secret-thrice / death / secret-thrice / secret-thrice
新：death / legend / secret-thrice / survived / lost / death
```

⇒ **我完全复现了实现方报的结局串（6/6 漂移）**，并给出 S1 需要的两个量：相同前缀长度、首差步。

**策略 = 索引轮换**（`(seed+picks++)%len`，无 preferred 正则）：前缀 240/233/253/234/246/278，首差字段均只有 `queue`，**结局 5/6 相同**。
**策略 = 内容稳定**（`hash(seed, eventId) % len`，与「迄今选过多少次」无关）：前缀 278/234/239/288/252/236，首差字段均只有 `queue`，**结局 5/6 相同**。

### 14.6.3 判定

**(a) S1 判据成立 —— PASS。** 6 局 × 3 策略共 18 组：首丢之前的状态前缀**逐字节相同**；首差步的**唯一**差异字段是 `pendingQueue`（flags / attributes / hp / mp / mood / eventFires / chains / termination 全部相同）；首差步恰好是首个被丢弃事件的落点（首丢前一步的队列里它还在，首丢步它不在了）。这说明 ADR 没有污染主 RNG 流（`+37` 独立派生盐生效），也没有在丢弃之前改动任何事实。

> 与实现方报的步数（260/325/222/245/238/221）相比，我的首差步索引是 259/324/219/244/237/220 —— 5 个种子恰好差 1、s3 差 3，属**计数口径差异**（是否把丢弃步计入前缀、是否把 opening 的 13 步计入、是否把战斗回合计为一步）。**性质一致，数值口径不同**，我以自己这套口径为准记录；建议 ADR 明确「步」的定义，否则这条判据不可被他人复算。

**(b) 结局漂移：不是回归 —— 归因需修正。**

实现方称「ADR 预期的因果对齐漂移」。我的对照实验说明这句话**只说对了一半**：

- 在 `playthrough.test.ts` 那套策略下确实 6/6 漂移；
- 换成**与「历史出现过多少事件」无关**的内容稳定策略后，只有 **1/6** 漂移。
- 差别的原因很直白：`playthrough.test.ts` 的兜底是 `opts[(seed + picks++) % opts.length]` —— 少呈现一个场景就少调一次 `picks++`，**其后每一次选择的下标整体错位一格**，于是分岔被指数放大。这不是内容因果，是**测试策略的索引敏感性**。

**判定「非回归」的四条独立依据：**

1. 30 种子：0 未收束、0 `once` 事件被丢、0 零选项死锁、7/7 章节门全触发（若是回归，最先崩的会是这些）；
2. 6 局 × 3 策略的前缀逐字节相同、首差只在 `pendingQueue`（没有隐藏状态被改坏）；
3. `evaluateDue` 逐事件等价 109/109（前提分支无语义漂移）；
4. 被丢弃的 87 条**全部**是「本该撤下」的场景：era 已翻页（`ev-d-class/geto/shoko/spar/rumor/market/mission/gojo`）或引用角色已死（`ev-d-haibara`/`ev-d3-megumi`/`ev-d3-yuji`/`ev-d-canteen`）。既然是撤回本该消失的场景，新结局是**修正后**的结局。

**但要给主理人一个提醒：** 正因为漂移被策略放大，**「6 个种子的结局分布」不适合当回归判据**（它测的是策略扰动，不是内容质量）。现在的 `playthrough.test.ts` 只断言「能收束 / 在声明集合内 / 章节推进 / 不重复触发 / 五维不饱和」，没有断言分布 —— 这个现状是对的，**不要**为了让分布回滚去调模板。

## 14.7 新发现（`file:line` + 严重度）

| # | 严重度 | 问题 | 位置 | 说明 / 建议 |
|---|---|---|---|---|
| 1 | **P2（结构性风险，未复现）** | `once: true` 的池事件若在待决期间前提变假，会被**静默丢弃**而 `once` 已烧掉（`firedEvents` 在 fire 时已写）⇒ 该事件永久不再触发。7 个章节门全是 `once + pool`，一旦命中就是**章节软锁** | 7 个门：`events.yaml:1545/1909/2410/2650/2815/3154/3456`；机制：`turn.ts` 的 `revalidatePendingV2` 丢弃分支不退还 `once` | 30 种子 0 例，正常玩法不可达（章节门待决期间玩家无法行动；唯一轮外入口 `useItem` 只会治疗）。但这是 ADR-0024 决策 3「静默丢弃」的直接推论。建议：**丢弃时若 `once` 已烧，落一条可诊断事实**（扩 `MissReason` 或在 `Result.droppedPending` 里标原因），或对 `once` 事件退还 `firedEvents` |
| 2 | **P2（pre-existing，R1 已记）** | `characters[].visibility: hidden` 未在投影生效，`npc-riko` 出现在玩家端 `npcs` | `packages/game-core/src/v2/projection.ts:152-153`；协议 `specs/core/TEMPLATE_PROTOCOL_V2.md:169` | 本轮**零改**投影可见性逻辑，故仍是 pre-existing。R1 的 P1（她在面板上「在世」）已闭合（现在是「已故 · 阵亡 · 14 岁」），但「hidden 角色该不该上屏」仍未解决 |
| 3 | **P3** | `droppedPending` 只存在于内部 `TriggerResult`，**没有出现在 `V2TurnResult`**，端到端（含测试与排障）无法断言「这一轮丢了什么」，只能靠队列差分反推（我这次就是这么做的） | `turn.ts:266`（字段在 `TriggerResult`）；`packages/shared/src/v2.ts:631` 的 `V2TurnResult` 无此字段 | ADR 决策 4 说「供测试与本地排障断言」。建议在 `V2TurnResult` 加只读诊断字段（不进 `snapshot`、不进存档 —— 现有 API 响应已证明 `snapshot` 不含它） |
| 4 | **P3** | `revalidatePendingV2` 对**整个队列**共用一个 `+37` rng 流：若某个**非队首**条目带 `random` 条件，它会消耗流，使其后条目与本条目「成为队首时」的判定不一致（队首自身不受影响，它总是第一个被求值） | `turn.ts` `revalidatePendingV2` 内 `const rng = createRng(...)` 一次、循环内复用 | 当前 `jjk-2006` 带 `random` 条件的池事件数 = **0**（已扫），故零暴露。建议注释点明，或按条目派生（`deriveTurnSeed(seed+37, turnIndex*1000+idx)`）|
| 5 | **P3** | 入口复核发生在部分前置校验**之前**：`battleActionV2` 先复核再判 `battle_not_active`，`chooseOptionV2` 先复核再判 `battle_in_progress` ⇒ 这些错误路径会**先改状态再抛错** | `turn.ts` `battleActionV2` / `chooseOptionV2` 首行 | 丢弃是规范化（非玩家动作），下一次快照即一致，影响可忽略；仅记录「副作用先于校验」这一形态 |
| 6 | **P3（归因修正，非缺陷）** | 「结局 6 局全漂移是 ADR 预期的因果对齐漂移」—— 实测主因是自动策略的索引敏感性 | `packages/game-core/src/v2/playthrough.test.ts:88`（`opts[(seed + picks++) % opts.length]`） | 见 §14.6.3(b)。建议 ADR 更正措辞；并明确「不要用 6 种子结局分布当回归判据」 |
| 7 | **P3（观测）** | 复活瞬间年龄从冻结值跳到真实年龄（14 → 27） | `projection.ts`（`ageBasis` 切换处） | 语义正确（她确实该 27 岁），仅提示前端注意观感 |

## 14.8 未覆盖项（显式「未验证」+ 原因）

| # | 未验证项 | 原因 |
|---|---|---|
| 1 | S1 判据**自动化为用例** | 我按新表述做了跨版本手工复核（§14.6），但仓库里**没有**对应的自动化用例 —— `pending-premise.test.ts` 的 16 条测的是机制，不含「6 种子前缀」断言。实现方报的 260/325/… 是手工数据。建议把 S1 落成用例，否则下轮回归又要重做这套搭建（`git archive` + junction 才有旧基线）|
| 2 | `once` 事件被丢弃的软锁（14.7-P3/P2-1）是否会在**真实玩家**操作下发生 | 正常玩法不可达（见 14.7-P2(1)），只能靠手改存档构造；我没造，因为造出来也只是证明「手改存档能坏」，不增加决策价值 |
| 3 | HTTP 层的 `event_premise_invalidated ⇒ 409` | 我验了该错误码引擎侧会抛（§14.3.3）、且 `interactionErrors` 集合的 409 通路有效（`pending_event_required` 实测 409）；但没为 `event_premise_invalidated` 单独构造一局 HTTP 场景（需驱动到指定待决状态再改存档）|
| 4 | 前端消费 409 后「自动重取快照」的实际体验 | 视觉/交互层不在本轮验收范围 |
| 5 | 30 种子以外的大样本 | 诈尸扫描与丢弃统计都是 30 种子；结局分布只做 6 种子（对齐实现方口径）|

## 14.9 R2 结论

**通过。** R1 的两条 P1 均已闭合，且是用**我自己的探针**独立证伪的（不是重跑实现方的用例）：

1. `npc-riko`：12/12 局 `inactive(阵亡)`，面板 age 恒 14，另有逃生线 `alive` / 同化线 `inactive(被同化)` 两条支线被强制覆盖验证；
2. 待决事件前提复核：30 种子精确扫描 **0 命中**（R1 为 18），同时 87 条丢弃证明机制在跑而不是静默失效；旧 optionId 提交被 `event_premise_invalidated` 挡住且五项计数不变；零选项死锁在严格判据下不可观测；丢弃不吞轮次；年龄冻结与复活恢复均成立；6 局 × 3 策略的跨版本前缀逐字节相同且首差只在 `pendingQueue`。

不放行的只有 §14.7 的 P2(1)（`once` 被吞的潜在软锁，未复现）—— 它属于「ADR 决策 3 的直接推论需要补一条可诊断事实」的下轮事项，不是本轮阻断项；判它不阻断的依据是：30 种子 0 例、正常玩法路径不可达、且章节门是 `once+pool` 里唯一有软锁风险的一类，实测 7/7 全触发。

回归口径提醒（写进结论，避免下轮误判）：**「6 种子结局分布漂移」不能作为回归判据**，它被自动策略的选项索引错位放大（对照实验：内容稳定策略下只 1/6 漂移）。
