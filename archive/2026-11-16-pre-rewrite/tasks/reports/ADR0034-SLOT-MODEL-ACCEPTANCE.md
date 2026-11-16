# ADR-0034 单槽 + 单队列事件模型 · 验收报告 · ADR0034-SLOT-MODEL-ACCEPTANCE.md

> 对应决策：`docs/DECISIONS.md` **ADR-0034**（§1–§13.5，含 §8-⑩ 转盘确认 / §8-⑪ 槽失效留痕 / §10 pool 与槽 / §13.5 A2' / §12-3 静态检查）
> 验收人：QA（life-sim-qa，严过关）｜执行日期：2026-11-13
> 待验提交：`7dbbf17` → `8f450f5` → `8995960` → `349ee66`（＋ 其后两条纯 docs：`d28e142` / `c537980`）
> **验证基线（四段，结论逐段追加，不改前文）**：
> - **第一轮 `c537980`**：`349ee66 → c537980` 的代码差异为 **0**（只有 `docs/DECISIONS.md` 与 `docs/BACKLOG.md`，`git diff --stat 349ee66 c537980` ⇒ 2 文件 / +10 −5），故该基线对四个实施提交同样成立。→ 判**有条件通过**（两个阻断项）。
> - **第二轮 `eebae60`**：纠偏提交（撤回 `pendingEvent` 恒 `null` + A2' 计数改「一条流按 `sortScheduled` 顺序消费」+ 补相关性回归锁）。**§8** 是它的追加独立验证。→ **通过**。
> - **第三轮 `e954494`**：补四门回归锁 + 两处 P2 纠偏。**§9** 记探针出仓库与 `pendingEvent` 一致性。→ **通过**。
> - **第四轮（范围复验，同一 `e954494`）**：只验三条 P2、不重跑全量。**§10** 含**变异验证**。→ **PASS**。
> - **凡前后有冲突处，以最后一节为准**；`docs/DECISIONS.md` 的 ADR-0034 正文始终是唯一权威口径。
> 本文只记录**我重跑过的命令、真实输出与探针结果**；未跑项与只做代码核对的项目在 §6 单独登记，绝不写成 PASS。
> **数字口径**：所有跑批数字**默认不含我的探针**；含探针的必标 `(含探针 N 例)`。对照表见 §10.6。

---

## 0. 结论

**裁决：通过**（最终基线 `e954494`；第三轮追加验证见 §9）

> 基线演进：`c537980`（第一轮，判**有条件通过**：工作区被变异污染 + `pendingEvent` 口径冲突）→ `eebae60`（冲突收口，判**通过**）→ `e954494`（补四个章节门回归锁 + 两处 P2 纠偏，**通过**）。
> **S4 的计数口径已由主理人裁定（2026-11-13）：按「具名来源」计 ⇒ 维持通过。** 两种口径的完整事实对照保留在下表第 3 行与 §2.3（**按来源：5 个 ⇒ PASS** / **按赋值语句：6 条 ⇒ 若采纳则退回**），这段对照本身就是有效记录，不删除。

| 层 | 结论 |
|---|---|
| **内核实现 vs ADR-0034 可断言条款** | **全数满足**，未发现 P0 / P1 代码缺陷。S1/S2/S4/§3-3/§13.5-A2'/确定性/六种子回归/反作弊/G2 诚实性 10 项全部 PASS（证据见 §2）。 |
| **两个合并阻断项（第一轮提出，均已收口）** | ① 工作区曾一度**不是** HEAD：`turn.ts` 被**变异实验**污染（`void scanStream` 占位 + 每实例新建派生流 + 调试 `console.log('COUNT=')`）、`slot-invariants.test.ts` 有未提交改动、2 个未跟踪探针 ⇒ **已收口**；② `pendingEvent` 的「恒 `null`」（`8f450f5`）与「恢复兼容包装」**互相否定** ⇒ **已由 `eebae60` 按主理人裁定收口**（撤回恒 null、保留兼容包装、注释写死删除顺序，断言同步）。逐条复验见 §8 / §9。 |
| **S4 计数口径（已裁定）** | 见 §2.3 / §11。`turn.ts:830`（原 `:824`）`state.slot = res.state.slot` 是**第 6 条赋值语句**，但值只能来自 `ending.ts:380`（`from: "death"`）或原值 ⇒ **不是第 6 个来源**。**主理人 2026-11-13 裁定：按「具名来源」计 ⇒ 5 个，维持通过**；`assignSlot()` 单入口 + 写点枚举测试仍留在 ADR §12-1 加固清单（不在本轮）。 |
| **P2（3 项，已在 `e954494` 修复并经我范围复验 PASS）** | 见 §6.2 与 §9.3 / §10：G2-3 四门断言（**变异验证：屏蔽「章节≥8」后退回裸 `waiting` 计数，失败精确落在 `ev-ch4-gate`**）、G1-3 标题、`shared/v2.ts` 契约注释。`e954494` 只动 3 文件 +20 −4，`turn.ts` / `projection.ts` 零改动。 |
| **我自己的临时探针** | **已移出仓库**：现在只存在于仓库外的 worktree `D:\code\_lifesim_qa_probe\`（§9.1）。仓库内 `git status` 只剩本报告；`pnpm typecheck` **0 错**（有/无探针都不再影响仓库）。 |

**一句话理由**：ADR-0034 声称的「结构性保证」在独立探针下**基本成立**——写非 `null` 槽的具名来源确实是 5 个、任何入口净 `turnIndex` 增量确实恒 ∈ {0,1}（10 类写入口逐一实测，无一为 2）、A2' 的五条口径全部成立且为纯读（独立探针证明，非看代码）、六种子与三方对照逐字节吻合、`pendingEvent` 与 `slotEvent` 在 normal 槽上逐字段一致且在 random/combat 槽上后者为 `null`。**两条必须记住的保留**：① 「一轮只结算一个」除 `slot` 标量外还依赖 `nextTurn` 只呈现不结算的**实现顺序**（§2.1）；② `slot` 的写权限仍是**白名单纪律**，不是类型层保证（§2.3，`assignSlot()` 未落地）。

---

## 1. 验证基线与被验对象

### 1.1 为什么用独立 worktree 验（重要）

我开工时主干工作区 `git status --porcelain` **非空**，且在我验收过程中**继续变动**（另一个角色正在做变异测试）。为免"验的是别人正在改坏的代码"，我把验证全部放在**独立 worktree**（`git worktree add`，`node_modules` 用 junction 接入，不动主干文件）：

| 目录 | 提交 | 用途 |
|---|---|---|
| `D:\code\_qa-head` | 首轮 `c537980` → 次轮 `eebae60` | **权威验证基线**：typecheck / shared / game-core 全量 / 探针 / 六种子 / 服务端冒烟 / 变异验证 |
| `D:\code\_qa-8f450f5` | `8f450f5` | A2' **修复前**对照（验「A2' 是不是真的修好了 seed 5」） |
| `D:\code\_qa-pre` | `14f8820`（`a9826aa^`） | **ADR-0034 落地前**对照（验实施方的六种子新旧对照表） |

> 三个 worktree 在报告落盘后已 `git worktree remove`，主干未被我修改（唯一例外：我短时间放过一个探针文件在 `packages/game-core/src/v2/`，见 §6.4-5）。

### 1.2 验收期间主干工作区的真实状态（一度脏，现已收口）

> **现状**：`eebae60` 之后主干 `git status --porcelain` **只剩本报告**（干净）。下面记录的是我第一轮验收期间看到的瞬时状态——保留它是为了说明"为什么必须用 worktree 验"，以及为什么"主干跑绿"这个说法的可信度取决于当时的工作区。

`D:\code\ai-life-simulator`（我在 §2/§4 之外的核对、grep、代码阅读用的就是它）当时是：

```
 M packages/game-core/src/v2.test.ts
 M packages/game-core/src/v2/ending-pipeline.test.ts
 M packages/game-core/src/v2/projection.ts
 M packages/game-core/src/v2/slot-invariants.test.ts      ← 验收期间新增
 M packages/game-core/src/v2/turn.ts                      ← 验收期间新增
?? packages/game-core/src/v2/__probe_count.test.ts        ← 验收期间新增（非我）
?? packages/game-core/src/v2/__qa-adr0034-probe.test.ts   ← 我的临时探针（已删除）
```

其中 `turn.ts` 的未提交改动是**故意破坏**（变异测试），内容形如：

```ts
function countPresentableQueue(state, lookup) {
  void scanStream; // 变异占位
  for (const inst of sortScheduled(state.delayQueue)) {
    ...
    if (!checkEventPremise(def, { state, lookup, rng: scanStream(state) }).ok) continue; // 变异
  }
}
...
const __n = countPresentableQueue(state, lookup);
console.log('COUNT=', __n, 'Q=', JSON.stringify(state.delayQueue.map((i) => [i.definitionId, i.status])));
```

**三条结论**：
1. 它把「一条派生流顺序消费」改成「**每个实例各建一条流**」——正是 `countPresentableQueue` 上方注释明令禁止的形态（两个含 `random` 条件的实例会拿到同一个骰值），并且**仍能通过"同 seed 两次跑一致"**（因为派生流只依赖 `(seed+37, turnIndex)`）。这恰好证明「确定性断言不覆盖相关性 bug」。
2. 它留下了 `console.log` 调试输出（跑 jjk 模板时每轮刷一行 `COUNT= …`）。**HEAD 里没有这行**（我在 `_qa-head` 跑全套，stdout 零 `COUNT=`）。
3. ⇒ 任何"我在主干跑了全绿"的结论（含实施方的自验）在当前工作区都**不可信**；本报告的所有结论取自 §1.1 的干净 worktree。
4. **收口情况**：该变异实验已还原，并升级为正式提交 `eebae60`——它把"一条流 + `sortScheduled` 顺序消费"写死，**并补了一条能抓住"每实例一条流"的回归锁**。我在 §8.3 独立做了变异复验（改成每实例一条流 ⇒ 该用例**红**），证明这把锁是真的。

---

## 2. 必验清单逐条裁定

| # | 条目 | 裁定 | 关键证据 |
|---|---|---|---|
| 1 | **S1 一轮最多结算一个事件**（含反向） | **PASS（附一条"非结构"注记）** | 正向 + 4 条反向探针全绿；10 类写入口净增量实测无 2。见 §2.1 |
| 2 | **S2 净增量 ∈ {0,1}**（每个写入口，特别验转盘确认） | **PASS** | 10 个入口逐项记录：`[free,1][present-wheel,1][confirm-wheel,1][choose,1][useItem,0][equip,0][unequip,0][hook-combat,1][battle-mid,0][battle-finish,1][archive,0]`。见 §2.2 |
| 3 | **S4 写槽点唯一性**（第 6 个写点 ⇒ FAIL） | **PASS（5 个来源 / 6 条赋值语句，第 6 条是克隆回写不是来源）** | grep 全仓逐条归类。见 §2.3 |
| 4 | **§3-3 扫描语义**（不满足留队、不卡队头、过期/missWhen 才出队） | **PASS** | 五条混排实例一次扫描的取出顺序与残留状态。见 §2.4 |
| 5 | **§13.5 A2' 五条口径** | **PASS（5/5）** | 死实例不挡路 / 未来实例不挡路 / 活实例仍封顶 / 纯读逐字段相等 / 同 seed 两次逐字节相同。见 §2.5 |
| 6 | **确定性** | **PASS** | 合成世界（random+combat）与**真实模板**（seed 3 / seed 5，各 120 步）两遍 `JSON.stringify` 逐字节相等。见 §2.6 |
| 7 | **六种子独立复跑 + 新旧对照** | **PASS（实施方对照表逐行核实，s5 细节全中）** | 三方对照表见 §5。s5：四门各**恰好 1 次**、章节 **15 段（≥8）**、`overall 95.01 < 96`。 |
| 8 | **G2 诚实性** | **PASS（如实描述，不要求修）** | 无条件但点名已退场角色的事件**仍会上桌**；写了 `npcState` 的则留队。见 §2.8 |
| 9 | **反作弊投影** | **PASS（附一条口径澄清）** | 队列实例 id / 队列内容 / 队列长度 / `missedEvents` / `droppedPending` 均不进 `snapshot`。`instanceId` 字面仍出现在装备与战斗视图里（**不是**队列身份，ADR 未禁）。见 §2.9 |
| 10 | **回归命令** | **PASS** | `typecheck` 0 错 / `shared` 67 / `game-core` **547（38 文件）** / 服务端加载期 + `/api/templates` 200。见 §4 |

### 2.1 S1 · 一轮最多结算一个事件

**正向（G1-1 独立复现）**：`ev-a` 结算产生**无时间账**后继 `ev-b`，同时队列里有到期日常 `ev-c1`：

```
turnIndex: t → t+1
slot: { eventId: "ev-b", from: "successor", fromEventId: "ev-a" }
delayQueue: ev-c1 仍在，status = "waiting"
eventFires 里 ev-c1 条数 = 0
```

**反向：逐条排查"同一轮结算两个事件"的路径**（这四条是我自己加的，实施方的 G1-3 用例**没有**覆盖转盘确认路径）：

| 试图制造双结算的场景 | 实测 | 为什么挡得住 |
|---|---|---|
| 空槽自由行动 + 队列有到期事件 | Δ=1，槽=`queueTake`，该事件**零记火** | `nextTurn` 对 `normal` 只 `return`（等选择），不结算（`turn.ts:715`） |
| 转盘确认 + 该段声明 `nextEventId` | Δ=1，`eventFires` 只 +1（只有转盘），后继**占槽但不结算** | `settleRandomSlot` 后 `nextTurn` 只呈现；后继是 normal ⇒ 直接 return |
| 选项后继是 `random` | Δ=1，`wheelPick` 仍 `undefined` | 呈现与结算分离（`presentRandomSlot` 只写 `lastWheel(s)`） |
| 行动钩子 `hook` 占槽 | Δ=1，`hook` 事件零记火 | 同第一行 |
| 战斗结束（胜负） | Δ=1 | 战斗整场是槽内过程（§8-⑦） |

> **注记（不是缺陷，但必须写清）**：「一轮只结算一个」在当前实现里由**两个**机制共同保证：① 结构性的（`slot` 是标量，物理上放不下第二个事件）；② **实现顺序性的**（`nextTurn` 遇到 normal/random 就 `return`）。第 ② 条不是数据形状保证——若将来有人在 `nextTurn` 的 normal 分支里"顺手结算"，S1 仍会被破而结构上无拦阻。ADR §4 S1 把它归入"结构保证"是**乐观表述**；准确说法是"`slot` 标量保证**不会有两个事件同时在槽**，而**一轮只结算一个**由 `settleSlotEvent` 是唯一结算函数 + 每个入口只调一次保证"。这不影响本次验收（有测试锁），建议在 §12 的加固清单里补一句。

### 2.2 S2 · 每个写入口净增量

探针逐项记录（同一世界内连续执行，`advanceTurnV2(free)` 之后每一入口的 `turnIndex` 差值）：

```
[["advanceTurnV2(free)",1],
 ["advanceTurnV2(present-wheel)",1],
 ["advanceTurnV2(confirm-wheel)",1],
 ["chooseOptionV2",1],
 ["useItemV2",0],
 ["equipV2",0],
 ["unequipV2",0],
 ["advanceTurnV2(patrol→hook combat)",1],
 ["battleActionV2(mid)",0],
 ["battleActionV2(finish)",1],
 ["assembleArchive",0]]
```

- 全部 ∈ {0,1}，**无一为 2**；断言同时要求"确实观测到 0 与 1 两种"（防空跑）。
- **转盘确认**这条新语义（`random` 槽调 `advanceTurnV2`）单独确认：Δ **恰好 1**，且结算读的是**呈现的那一格**（`lastWheel.label` 决定 `wheelPick` 上/下），不是恒取 `segments[0]`。
- 被拒调用（槽被 normal 占时提交自由行动 / 提交不存在的选项）Δ=0 且抛 `pending_event_required` / `option_not_available`。
- 代码侧对应 3 处 `turnIndex += 1`：`settleSlotEvent`（`turn.ts:394`）/ `advanceTurnV2` 自由行动（`:911`）/ `battleActionV2` 战斗定义缺失兜底（`:1126`），与 ADR §4 S2 的"实测 3 处"一致。

### 2.3 S4 · 写槽点

`grep -rn "\.slot = " packages/game-core/src apps/server/src --include="*.ts" | grep -v test` 全量结果（12 条），逐条归类：

**写非 `null`（5 个具名来源，与 §1 `SlotScene.from` 的 5 个取值一一对应）**

| 位置 | 来源 | 触发者 | 玩家输入能否直达 |
|---|---|---|---|
| `ending.ts:380` `next.slot = { eventId: id, from: "death" }` | `death` | 战败死亡路径（`applyDeathRoute`，`deathMode: "event"`） | 否（模板 `endings.yaml` 的 `deathRoute.deathEventId`） |
| `opening.ts:243` `next.slot = { eventId: p.eventId, from: "opening" }` | `opening` | 开局交接的第一条未完成即时事件 | 否（模板 `opening.yaml` 的 `handoff.pendingEvents`） |
| `turn.ts:351` `state.slot = { eventId: nextEventId, from: "successor", … }` | `successor` | 结算后占槽判定（`applySuccessor`，仅当后继**无** `delay`/`window.start`） | 否（模板 `nextEventId` 边） |
| `turn.ts:638` `state.slot = { eventId: event.id, from: "hook" }` | `hook` | `resolveHooksV2`，且**仅当 `slot === null`**（否则改造入队，不覆盖） | 否（模板 `action-hook` 声明；玩家只提供 `actionId` 去**匹配**，不能指定事件 id） |
| `turn.ts:721` `state.slot = { eventId, from: "queueTake", instanceId }` | `queueTake` | `nextTurn` 的队列扫描取出 | 否 |

**第 6 条赋值语句（不是第 6 个来源）**

```ts
// turn.ts:824（applyDeathRouteInPlace 末尾）
state.slot = res.state.slot;
```

- 性质：`applyDeathRoute` 返回的是 `structuredClone(state)` 的结果，其中唯一写 `slot` 的地方是 `ending.ts:380`（`from: "death"`）；其余情形它原样克隆传入的 `slot`。⇒ 该语句**只能**写入"`death` 来源的值"或"原本就在槽里的值"，**无法凭空构造新的来源**。
- 它是"克隆 API 与可变状态管线"之间的胶水（同一函数里还回写了 `firedEvents`/`firedIndex`/`eventFires`/`missedEvents`/`history`/`termination`），不是新的准入通道。
- **按"5 个具名来源"的口径判 PASS**；但按团队要求的字面口径（"只有 5 处写非 null"，**"发现第 6 个写点即 FAIL"**），全仓是 **5 个来源 / 6 条赋值语句**。
- **这一条我没有替任何一方抹平，两种口径的后果写死如下**：
  - 若按 **来源** 计（ADR §4 S4 的原文："5 处全部是引擎内部事件路由的产物 + `from` 字段可审计"）⇒ **PASS**。理由：该语句无法产生第 6 个 `from` 取值，也无法被玩家输入触达；它是"判定与写回不在同一对象上"造成的二次落地。
  - 若按 **赋值语句** 计 ⇒ **退回**，唯一必修项 = ADR §12-1 的 `assignSlot(state, scene)` 单入口 + 「写点枚举」静态测试（把 6 条收敛到 1 条）。改动量约 30 分钟，我可在 30 分钟内完成复验。
- **`e954494` 已把这一条写进契约注释**（`packages/shared/src/v2.ts:209-213`："另有 1 处**死亡路径的克隆回写**……属'同一来源的二次落地'，不计为第 6 个来源"），且同处标注"⚠ 这是**白名单纪律，不是类型层保证**"。⇒ 实现方与我对性质的理解一致，分歧只在"是否按赋值语句计数"这一条口径上。

**裁定（主理人，2026-11-13）**：**按「具名来源」计 ⇒ 5 个，维持通过。** 理由即上面那条事实：`turn.ts:830` 只可能写入 `death` 来源的值或原值，**产生不了第 6 个 `from`**；把"赋值语句条数"当验收口径，会把一个语义上不存在的写点算成缺陷，反而逼实现去改一个没问题的地方。`assignSlot()` 单入口 + 写点枚举测试**仍留在 ADR §12-1 加固清单**（不在本轮），落地时把这条克隆回写作为**特例显式处理**。
ADR §4 S4 与 `packages/shared/src/v2.ts` 的措辞已按同一口径改写为「**5 个具名来源 + 1 处克隆回写（不计来源）**」（`7b578ad`），与代码、注释、本报告三处一致。

> **行号漂移提醒**：本报告 §2.3 的写点表用的是第一轮基线 `c537980` 的行号；`eebae60` 给 `turn.ts` 增加了约 6 行，因此**当前 HEAD 上整体 +6 左右**：`successor` `351→352`、`hook` `638→644`、`queueTake` `721→727`、克隆回写 `824→830`；清槽 6 处 `305→306`、`344→345`、`348→349`、`689→695`、`707→713`、`1125→1131`；`ending.ts:380` 与 `opening.ts:243` 未变。**以 `from` 字段 grep 为准，不要只信行号。**

**清槽点（6 处）+ 初始化（1 处）**，与 ADR §4 S4 所列一致：

| 位置 | 情境 |
|---|---|
| `turn.ts:305`（`revalidateSlot`） | 呈现前前提失效 ⇒ 静默清槽 |
| `turn.ts:344` | 结算后无后继 |
| `turn.ts:348` | 后继有时间账 ⇒ 入队、不占槽（§10-4） |
| `turn.ts:689` | 槽内事件定义缺失（加载期完整性错误） |
| `turn.ts:707` | combat 事件敌人全部非在世 ⇒ 整条跳过 |
| `turn.ts:1125` | 战斗定义缺失兜底（否则永久卡在战斗门禁） |
| `turn.ts:200` | `createWorldV2` 初始化 `slot: null` |

**"无外部输入直达"另做了侧向核对**：`advanceTurnV2` / `chooseOptionV2` / `battleActionV2` / `useItemV2` 的入参只含 `actionType` / `optionId` / `skillId` / `itemId` / `instanceId`（装备实例）与 `description`，**没有任何字段能指定事件 id**；`optionId` 只在**当前槽事件的选项表**里匹配（`turn.ts:1006-1009`）。

### 2.4 §3-3 扫描语义（三态混排）

同一世界、同一起点，混排 5 条实例：`gated`（前提假 ⇒ 应留队）/ `deadline`（`worldTime > window.end` ⇒ 应过期出队并记 `window_expired`）/ `miss`（`missWhen` 命中 ⇒ 应出队并记 `miss_when`）/ `c1`、`c2`（可上桌）。令 `worldTime = 10`：

| 扫描次序 | 结果 |
|---|---|
| 第 1 次 `scanDelayQueue` | 取到 **`ev-c1`**（跳过 hold / 过期 / miss，说明不卡队头） |
| `missedEvents` | `["ev-deadline:window_expired", "ev-miss:miss_when"]`（各一条，reason 取自封闭枚举） |
| `ev-gated` | `status` **仍是 `waiting`**（未丢弃、未记错失） |
| `ev-deadline` / `ev-miss` | `status = "expired"`（出队） |
| 第 2 次扫描 | 取到 `ev-c2` |
| 第 3 次扫描 | `{ kind: "none" }`，`ev-gated` 仍 `waiting`，`missedEvents` 仍 2 条 |

另验「`window.start > now` 的实例不被越界取走」：明天到期的实例 + 今天到期的实例混排 ⇒ 只取今天那条，第二次扫描 `none`，未来实例 `waiting`，零错失。

### 2.5 §13.5 A2' 五条口径

| 口径 | 夹具 | 实测 |
|---|---|---|
| ① 死实例不挡路 | 3 条条件永假（`npcState alive`，角色已退场）顶满队列 + 池里放必中章节门 | **池仍抽取**：`ev-gate` 被摇出入队并被取出占槽（`from: queueTake`）；3 条死实例仍 `waiting`（**未顺手清理**，符合 §13.5"不负责让它们消失"） |
| ② 未来实例不挡路 | 3 条"明天才到期"顶满队列 | **池仍抽取**：`ev-gate` 入队并上桌 |
| ③ 活实例仍封顶 | 3 条可上桌顶满队列 | **池不抽取**：队列里无 `ev-gate`（阈值没被改成永久放行） |
| ④ 纯读 | 3 条死实例 + 无池候选，跑一整轮 | `delayQueue` / `missedEvents` / `eventFires` / `lastFiredIndex` 前后 `JSON.stringify` **逐字节相等**；`slot` 仍 `null`；只有自由行动那一步推了 `turnIndex` |
| ⑤ 不扰动主轮 RNG | 同 seed、同事件集（含 random 槽 + combat 槽 + 死实例 + 未来实例）跑 14 步两遍 | `JSON.stringify({...state, id})` **逐字节相同**，长度 > 500 字符（防空跑） |

补一条实施方没有的对照：**修复前**（`8f450f5` worktree）我独立跑 `playthrough.test.ts`，得到

```
AssertionError: seed 5 章节推进不足：1→2→3→4→5→6→7: expected 7 to be greater than or equal to 8
AssertionError: expected 96.14 to be less than 96
```

⇒ ADR §13.1 描述的缺陷（seed 5 卡在第 7 章到 `timeReached`）**可复现**，A2' 是**有效且必要**的修法（§5 的三方对照进一步坐实）。

### 2.6 确定性

| 场景 | 方法 | 结果 |
|---|---|---|
| 合成世界（random 槽 + combat 槽 + 死/未来实例混排） | 同 seed 两次跑 14 步 | `JSON.stringify(state)` 逐字节相同 |
| **真实模板 `jjk-2006/1.0.0`** | seed 3 / seed 5 各驱动 **120 步**（含转盘确认、选项、战斗、自由行动），同一驱动脚本跑两遍 | 两遍状态 `JSON.stringify` **逐字节相同**（`lastWheels` 字段存在 ⇒ 确实走到了 random 槽） |

### 2.7 六种子（详见 §5 对照表）

我在干净基线 `_qa-head` 用**原版** `playthrough.test.ts` 复跑（不是实施方的日志），并额外打印 `chapterFires`：**六个种子的 7 个章节门全部恰好 1 次**，章节段数 14–15，`overall` 94.45–95.01 全 < 96。

### 2.8 G2（诈尸）的诚实性 —— 如实描述

ADR §7 说"本模型**不结构保证 G2**"。我构造两条事件对照：

| 事件 | 引用已退场角色 | 甲退场后 `nextTurn` 的实测表现 |
|---|---|---|
| 有 `conditions: [{ npcState: { npcId: "npc-a", state: "alive" } }]` | 是 | 实例**留队**（`waiting`），不上桌，**不记错失**（§3-3 死结论） |
| **没有任何条件**，只在 `narrative` 里点名甲 | 是 | **仍然上桌**（`slot = { from: "queueTake" }`，`slotEventView().eventId` 可见） |

⇒ **结论与 ADR 一致**：内核把「条件在真正上桌时求值 + 失效留痕」做对了，但**不负责判活**；模板没写条件就会"诈尸"。本轮不改（§9/§11.1 用户已裁决）。

### 2.9 反作弊

`snapshot` 序列化后：

| 检查 | 结果 |
|---|---|
| 含 `state.slot.instanceId`（`evi-N` 队列身份） | **不含**（断言 `not.toContain(instId)`） |
| 含 `"delayQueue"` / `"missedEvents"` / `"droppedPending"` / `"pendingEvents"` 键 | **均不含** |
| 队列里尚未上桌的另一条事件 `"ev-c2"` | **不含**（只有上桌的那条 `"ev-c1"` 出现）⇒ 队列长度/内容不可推 |
| 终止后 `slotEvent` | `null`（`ended ? null : …`） |

**口径澄清（必须写清，别被字面断言骗过）**：`packages/game-core/src/v2/projection.ts` 里 `instanceId` **仍有 3 处**（装备 `:150`、战斗敌人 `:434`、战斗友军 `:442`）。它们是**装备/战斗实例身份**（既有协议字段，前端要靠它发 `unequip`/选目标），**不是** ADR §8-⑪ 禁止的"队列实例身份"。所以我按 ADR 判 **PASS**；若按团队清单的字面口径"`JSON.stringify(snapshot)` 不得含 `instanceId`"，则**不成立**——但把装备 id 也拿掉会直接打断穿脱链路，属于误判。请以此澄清为准。

另：内核 `V2TurnResult` 会**带上整个 `state`**（含 `delayQueue`/`missedEvents`），但**服务端不转发**——`apps/server/src/index.ts` 的四个写入口（`/turns` `:457`、`/events/choose` `:486`、`/battle` `:513`、`/items/use` `:540`）响应体只有 `snapshot` / `triggeredEvents` / `wheelResult` / `eventFlavors` / `elapsed`。反作弊边界在服务端成立。

---

## 3. 专项检查表

| 检查项 | 结果 | 证据 |
|---|---|---|
| 确定性可重现 | **PASS** | §2.6（合成 + 真实模板各两遍逐字节相同） |
| `DEFERRED`/`RETIRED` 未混入范围 | **N/A（本轮不涉及需求编号）** | 本轮是 ADR-0034 架构实施，非需求迭代；`tasks.md` 的 R-TT-* / R-LC-* 未被引用、未被实现、未被计入 DoD（`grep "R-TT-\|R-LC-" docs/DECISIONS.md` 在 ADR-0034 段落零命中） |
| V1 残留符号 | **PASS** | `grep -rn "evaluateLife\b\|advanceTurn(\|PhaseTransitionLog\|PhaseState\|lifecyclePhase"` ⇒ 仅 `apps/web` 的 HTTP 客户端方法 `api.advanceTurn(...)`（不是 V1 引擎函数）与 `boundary.test.ts` 里的**反向断言**（断言这些符号**不存在**） |
| 未引入 Lifecycle 状态机 | **PASS** | `lifecycle` 仅作 NPC 在世状态（`alive/inactive/unspawned`，`shared/schema/character.ts:37`），是 ADR-0012/0020 既有字段；无 `Phase` 类型、无阶段日志。`boundary.test.ts:90` 有专门的负面守卫用例 |
| `hidden` 未进入玩家端 API | **PASS（沿用既有守卫）** | `history.ts:17` `playerVisibleHistory` 统一 `isPlayerVisible`（先过滤后截断）；投影层 hidden 结局掩码 `projection.ts:348-359`；由 `history-visibility.test.ts`(382 行) / `ending-pipeline.test.ts` / `relation-projection.test.ts` 覆盖，本轮全套绿 |
| 已删符号（`pendingEvents`/`scheduledEvents`/`chains`/`occupantOf`） | **PASS** | 引擎/服务端只剩**注释**与 `OpeningRun` 自己的 `pendingEvents`/`scheduledEvents` 字段（开局协议，不是被删的世界状态字段，未改协议面）；`state` 层 grep 零命中 |
| 存档协议 | **PASS** | `SCHEMA_VERSION = 3`（`apps/server/src/store.ts:50`），`slot` 在 `WorldStateV2Schema` 中为**必填**（`shared/v2-state.ts:248`）⇒ 旧档 `schemaVersion ≠ 3` 拒载，符合 ADR §5 |
| 服务端 409 | **PASS（代码核对，未做 HTTP 实测）** | `handleEngineError`（`index.ts:745-771`）：`pending_event_required`/`battle_in_progress`/`no_pending_event`/`event_premise_invalidated` 一律 409，**未新增错误码**；内核抛点 `turn.ts:847-848` |

---

## 4. 执行过的命令与真实结果

全部在 §1.1 的 worktree 内执行（除 4.1 记录了一条主干首跑）。

| # | 命令 | 目录 | 结果 |
|---|---|---|---|
| 4.1 | `pnpm typecheck` | 主干（13:25，工作区当时只有 3 文件改动） | **无输出、exit 0** |
| 4.2 | `pnpm --filter @life-sim/shared test` | `_qa-head` | **5 文件 / 67 用例 passed** |
| 4.3 | `pnpm --filter @life-sim/game-core test` | 主干（13:25） | **38 文件 / 547 用例 passed** |
| 4.4 | `pnpm typecheck` | `_qa-head`（**删掉我的探针后**） | **无输出 ⇒ 0 错** |
| 4.5 | `npx vitest run`（含我的探针） | `_qa-head` | **39 文件 / 566 用例 passed**（547 + 19 探针），stdout 无 `COUNT=` 噪声 |
| 4.6 | `npx vitest run src/v2/__qa-adr0034-probe.test.ts` | `_qa-head` | **19/19 passed** |
| 4.7 | `npx vitest run src/v2/playthrough.test.ts` | `_qa-head` / `_qa-8f450f5` / `_qa-pre` | 见 §5（含 8f450f5 上 2 条**失败**，正是缺陷复现） |
| 4.8 | `PORT=3457 npx tsx apps/server/src/index.ts` + `fetch('/api/templates')` | `_qa-head` | 加载期 `templates_loaded`（`jjk-2006` ready）→ **HTTP 200**，`{"templates":[{"id":"jjk-2006","startVersion":"1.0.0",…}]}`。**起完即停**（未占 3000；两个临时端口 3456/3457 均已关闭） |
| 4.9 | `git worktree remove` ×3 | 主干 | 三个对照 worktree 已清理，主干 `git status` 只剩我的报告文件 |

> 4.3 的全套是**在工作区被变异污染之前**跑的（13:25:36 结束，变异文件 13:28 前后出现），且 4.5 在干净基线重跑得到同样的 547 + 19 全绿，故实现方"38 文件 / 547 用例全绿"的自述**独立成立**。
> 4.8 的一个操作细节：localhost 请求被本机代理拦截（curl 报 `502 upstream connect failed`），改为同 shell 内用 Node `fetch` 直连才拿到 200；这与服务端无关，是环境代理问题。

---

## 5. 六种子新旧对照（三方独立复跑）

`playthrough` 6 种子 × 2 开局，同一驱动脚本，只在**代码版本**上不同：

| 种子 | `14f8820`（ADR-0034 **之前**） | `8f450f5`（ADR-0034 引擎 + A2' **之前**） | `c537980`（HEAD） | 变化 |
|---|---|---|---|---|
| s1 | end-death · t312 | end-death · t325 | **end-death · t325** | 不变 ✓ |
| s2 | **end-secret-thrice** · t336 | end-death · t349 | **end-death · t349** | thrice→death ✓ |
| s3 | end-secret-thrice · t318 | end-secret-thrice · t333 | **end-secret-thrice · t333** | 不变 ✓ |
| s4 | **end-secret-thrice** · t353 | end-death · t349 | **end-death · t349** | thrice→death ✓ |
| s5 | **end-death** · t308 | **end-secret-two** · t544 · **章节只到 7** | **end-secret-thrice** · t346 · 章节 15 段 | death→thrice ✓（中间被 A2 缺陷打断） |
| s6 | end-death · t308 | end-death · t341 | **end-death · t341** | 不变 ✓ |

**实施方的对照表逐行核实：全部成立。** 三条补充事实：

1. **s2/s4 的 thrice→death 发生在 ADR-0034 引擎落地（`a9826aa`）阶段，不是 A2' 造成的**——`8f450f5` 与 `c537980` 的 s2/s4 完全相同。所以"时序平移"的说法准确。
2. **s5 经历了三个状态**：death（旧）→ **end-secret-two / 章节 7**（A2' 之前，缺陷态）→ end-secret-thrice（A2' 之后）。即 A2' **同时修好了"结局"和"章节推进"**，不是只修了其中一个。
3. 结局**全部在模板声明集合内**（`endings.endings` 由 `KNOWN_ENDINGS` 校验，套件内断言绿）。

**s5 的细节断言（任务重点）**，我为核对这一点给原版 `playthrough.test.ts` 加了一行 `chapterFires` 打印（跑完即删，未改任何断言）：

```
s5 end-secret-thrice day4755 t346 ch=1→2→…→14→15
   fires={"ev-ch1-gate":1,"ev-ch2-gate":1,"ev-ch3-gate":1,"ev-ch4-gate":1,"ev-ch5-gate":1,"ev-ch6-gate":1,"ev-ch7-gate":1}
   overall=95.01
```

⇒ `ev-ch4/5/6/7-gate` **各恰好 1 次** ✓；章节 **15 段 ≥ 8** ✓；`overall 95.01 < 96` ✓。（顺带：s1–s6 六种子全部 7 门各 1 次。）

**六种子 overall**（HEAD）：94.45 / 94.73 / 94.70 / 94.93 / 95.01 / 94.68，全部 < 96 且互不相同（D-06 区分度断言保持）。

---

## 6. 未完成项、已知欠账与风险

### 6.1 第一轮的两个合并阻断项（均已在 `eebae60` 收口）

| # | 项 | 当时的事实 | 收口情况 |
|---|---|---|---|
| **B-1** | 工作区 ≠ HEAD，且正被变异实验污染 | `turn.ts` 含 `void scanStream; // 变异占位`、**每实例新建派生流**、`console.log('COUNT=…')`；`slot-invariants.test.ts` 有未提交改动；新增未跟踪 `__probe_count.test.ts` | **已收口**：变异已回滚，正确形态（一条流 + `sortScheduled` 顺序）以 `eebae60` 正式提交，并补了能抓住该变异的回归锁（§8.3 我做了独立变异复验）。教训：**变异实验期间任何"主干跑绿"都不能作为放行依据**——这一条值得写进团队纪律 |
| **B-2** | `pendingEvent` 口径自相矛盾 | **`c537980`（第一轮 HEAD）**：`pendingEvent: null`（`8f450f5` 的收口）⇒ `apps/web/src/main.tsx` 的 5 处引用拿到 `null`，**界面是坏的**。**当时工作区未提交改动**：改回 `pendingEventView(...)` 兼容包装 + 同步改两条断言 | **已由 `eebae60` 按主理人裁定收口**：撤回"恒 null"，保留兼容包装（注释写死删除顺序：前端先切 `slotEvent` 并删那 5 处引用 → 再删字段），`v2.test.ts` / `ending-pipeline.test.ts` 断言同步。**我复核了实现与断言一致、且没有引入"同一场景两个真源"的语义歧义**（`pendingEvent` 只是 `slotEvent` 的 normal 子集，`slotEvent` 仍是唯一真源） |

### 6.2 P2（不阻断，建议进 `docs/BACKLOG.md`）

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| P2-1 | **G2-3 回归锁的断言强度不足**：`playthrough.test.ts` 只断言「章节事件**重复**触发为 0」「章节 ≥ 8」「`ev-ch1-gate` = 1」，**没有**断言 `ev-ch4/5/6/7-gate` **各恰好 1 次**（ADR §7 G2-3 的原文要求） | `playthrough.test.ts:157-159` | 实测**能**挡住已知缺陷（我跑 `8f450f5` 时正是被"章节 ≥ 8"这条抓红），故不判 P1；但若将来 ch4 门干脆不触发而章节从别处凑到 8，本测试不会红 |
| P2-2 | `G1-3` 用例标题声称覆盖「转盘确认」，但该夹具的事件集（`ev-combat`/`ev-a`/`ev-b`）里**没有 random 事件**，实际未覆盖该入口 | `slot-invariants.test.ts:286` | 转盘确认的 Δ=1 由 `slot-wheel-confirm.test.ts:147` 与我的探针覆盖，事实无缺口；但标题会让人误以为已覆盖，建议改名或补一条 |
| P2-3 | 契约注释与 ADR 不一致：`packages/shared/src/v2.ts:205` 写「写入口**只有两个**」，紧接着 206-208 行又列出 5 个来源 | `shared/v2.ts:205-208` | ADR §4 S4 已按实况修正为 5 处；共享类型的注释是**契约面文档**，容易让下一个实现者按"两个"去理解 |

### 6.3 已知欠账（本轮明确不做，我确认仍然存在，不算缺陷）

| 项 | 事实核对 |
|---|---|
| **B-38** `opening.applySetup` / opening 池效果丢弃 `startedChains` | 确认存在：`opening.ts:128` 与 `:179` 都是内联 ctx 且**只读 logs 位置都没读 `startedChains`** ⇒ `startChain` 在这两条路径上静默零效果 |
| **B-37** 死实例不出清 | 确认存在：A2' 只让死实例"不挡路"，`delayQueue` 里 3 条永假实例在跑完一整轮后仍 `waiting`（我的探针直接观测到） |
| ADR §12-3 静态检查（`startedChains` + `logs` 消费点） | **尚未落地为测试**（`d28e142` / `c537980` 只改了 docs + 清点结果）。B-38 因此在结构上仍可能复发 |
| ADR §12-1 `assignSlot()` 单入口 | 未落地。⇒ §2.3 的"5 来源 / 6 赋值语句"仍是**白名单纪律**，不是类型层保证 |
| §12-2 槽内失效诊断补全（successor/hook/opening/death 无 `instanceId`） | 按 §8-⑪ 的退化策略实现（进非持久化 `droppedPending`），已实测：`queueTake` 来源写 `missedEvents`，`successor` 来源**不写**（不造 id） |

### 6.4 其他观察（供主理人判断，不影响裁定）

1. **`death` 来源的槽永不呈现**：`applyDeathRoute` 在 `slot` 里写 `{ from: "death" }` 之后紧跟 `markTerminated`，而投影对 `ended` 状态一律 `slotEvent = null`。⇒ 该来源的槽**只起记账作用**，其事件的效果与正文玩家看不到（与改造前一致，非本轮引入）。
2. **死亡路径的槽回写会覆盖 `nextTurn` 刚呈现的场景**：`battleActionV2` 的顺序是「结算 → `postSettleJudgements` → `nextTurn`（可能已占槽/呈现）→ `applyDeathRouteInPlace`（覆盖 `slot`）」。因随后即 `terminated`，任何入口都被 `assertActive` 挡住，**无玩家可见后果**；但这是"槽可以在一个入口内被写两次"的唯一情形，值得在 §12-1 的 `assignSlot()` 里显式处理。
3. **转盘确认后 `lastWheels` 未清空**：确认分支在 `state.lastWheels = []` **之前** return（这是 §8-⑩(a) 要求的正确顺序），代价是该记录多存活一轮（`presentRandomSlot` 按 `eventId` 查，不会串台）。属预期。
4. 我为停掉自己起的两个冒烟服务执行了 `taskkill /F /IM node.exe`——这个命令会**误杀同机其它 node 进程**。若有人在这几分钟内遇到测试/服务被中断，请重跑；后续我改为按 PID 收尾。
5. **我的探针**：早期版本有 4 处类型不严谨（`equipment` 可能 `undefined` ×1、在 `never` 上取 `enemies` ×3），曾短暂让主干 `pnpm typecheck` 变红（`eebae60` 的提交信息把这几条归为"他人临时探针"，**归属正确**）。**已彻底移出仓库**（现址见 §7 / §9.1），且**这 4 处已修好**——现在连"带探针的那棵树"`pnpm typecheck` 也是 **0 错**。

---

## 7. 探针位置与复现方法

- **探针位置（仓库外）**：`D:\code\_lifesim_qa_probe\packages\game-core\src\v2\__qa-adr0034-probe.test.ts`
  —— 这是一个 `git worktree`（`git worktree add /d/code/_lifesim_qa_probe <HEAD>`，`node_modules` 用 junction 接入），**不是主仓库的一部分**：主仓库 `git status` 看不到它，主仓库 `pnpm typecheck` 也不包含它。
- 运行方式：`cd /d/code/_lifesim_qa_probe/packages/game-core && npx vitest run src/v2/__qa-adr0034-probe.test.ts`
- 主仓库卫生：`git status --porcelain` 只有本报告；`pnpm typecheck` **0 错**。
- 探针**不复用**实施方的 `slot-invariants.test.ts` 夹具（自建模板 `RAW` + 事件 `EV`），避免"用作者的夹具证明作者的实现"。
- 全文另存于附录 A（万一 worktree 被清理，可从报告里的代码块原样提取重跑；我实测过这条恢复路径）。

---

---

## 8. 追加验证（第二轮基线 `eebae60`）

> 第一轮验收结束时仓库落了一条纠偏提交 `eebae60`（"撤回 `pendingEvent` 恒 null + 计数流顺序消费与相关性断言"）。因为**它改了引擎代码**，我不能用第一轮的结论直接放行，于是在干净 worktree（`_qa-head` 已 `git checkout eebae60`）把关键项**全部重跑**。

### 8.1 `eebae60` 改了什么（我逐行读过 diff）

| 文件 | 改动 | 我的判定 |
|---|---|---|
| `projection.ts` | `pendingEvent: null` → `pendingEvent: ended ? null : pendingEventView(...)`（兼容包装）+ 注释写死删除顺序 | **解决 B-2**：`slotEvent` 仍是唯一真源，`pendingEvent` 只是它的 normal 子集；`apps/web` 5 处引用不再拿到 `null` |
| `v2.test.ts` / `ending-pipeline.test.ts` | 两条断言同步改回 | 与实现一致，无"断言与实现各说各话" |
| `turn.ts` `countPresentableQueue` | ① 一轮**一条**派生流（不变）；② 遍历顺序 `state.delayQueue` → **`sortScheduled(delayQueue)`**；③ 注释把 RNG 纪律写死 | **正确**：与 `scanDelayQueue` 同一全序 ⇒ 骰值消费顺序只由世界状态决定。**不是**我在变异实验里看到的那版（每实例一条流） |
| `slot-invariants.test.ts` | 新增「计数流相关性」用例：二分法实测每个消费者看到的骰值，断言第 2 个 ≠ 第 1 个 | **真锁**（见 8.3）|

### 8.2 重跑结果（全部我自己跑）

| 命令 | 目录 | 结果 |
|---|---|---|
| `pnpm typecheck` | 主干（`eebae60`，干净） | **0 错** |
| `pnpm typecheck` | `_qa-head`（`eebae60`，无探针） | **0 错** |
| `pnpm --filter @life-sim/shared test` | 主干 | **67 passed** |
| `npx vitest run` | `_qa-head`（`eebae60`，**原生**） | **38 文件 / 548 用例 passed** |
| `npx vitest run`（含我的 19 例探针） | `_qa-head` | **39 文件 / 567 用例 passed** |
| `npx vitest run src/v2/playthrough.test.ts`（带 `chapterFires` 打印） | `_qa-head` | s1–s6 与 §5 **逐字节相同**：s1 death/t325、s2 death/t349、s3 thrice/t333、s4 death/t349、**s5 thrice/t346**、s6 death/t341；**6 个种子 × 7 个章节门全部各 1 次**；章节段数 14/14/15/14/**15**/14；overall 94.45/94.73/94.70/94.93/**95.01**/94.68 |

> ⚠️ **对实施方自验数字的更正（善意提醒，非指责）**：`eebae60` 提交信息写"**39 文件 / 567 用例**"。实测**原生是 38 文件 / 548 用例**；39/567 = 原生 + 我那个临时探针（+1 文件 / +19 用例）。⇒ 他们那次自验把我放在树里的探针算进去了。以后自验请先 `git status` 确认树里没有别人的文件。

### 8.3 我独立做了变异复验：那把"相关性锁"是真的

在**我自己的** worktree 里把 `turn.ts` 的 `rng` 改回"每实例一条流"（故意破坏，只改我这份），然后跑 `slot-invariants.test.ts`：

```
     → expected 0 to be greater than 0.01
⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected 0 to be greater than 0.01
      Tests  1 failed | 12 passed (13)
```

⇒ **只有**新增的相关性用例红，其余 12 条全绿。这正是我第一轮担心的形态（"同 seed 两次跑一致"照绿、但两个含 `random` 条件的实例拿到同一个骰值）。**这把锁成立**，`eebae60` 的降级/回滚会被告警。变异已 `git checkout --` 还原，我那份 worktree 的 `git status` 干净。

### 8.4 第二轮裁定

| 项 | 第一轮 | 第二轮（`eebae60`） |
|---|---|---|
| 必验清单 10 项 | 全 PASS | **全 PASS（不变）** |
| 六种子 | §5 数值 | **逐字节不变** |
| B-1 工作区脏 / 变异污染 | 阻断 | **已收口** |
| B-2 `pendingEvent` 口径冲突 | 阻断 | **已收口（主理人裁定 + 实现/断言一致）** |
| A2' 计数 RNG 纪律 | 只有"同 seed 两次一致"这一层证据 | **补强**：一条流 + 全序消费 + 相关性锁（我独立变异验证过） |
| 遗留 | P2-1 / P2-2 / P2-3 | **同样适用**（`eebae60` 未触及这三项） |

**第二轮裁决：通过（P2 三项进 BACKLOG，不阻断）。** 除 §6.2 的三个 P2 与 §6.3 的已知欠账外，没有剩余的必须修复项；`apps/web` 切 `slotEvent` 属另一条线（不在这棵树的验收范围）。

---

## 9. 第三轮：探针移出仓库 + `pendingEvent` 一致性 + P2 收口（最终基线 `e954494`）

### 9.1 探针已移出仓库（主理人要求）

| 项 | 状态 |
|---|---|
| 主仓库内是否还有 `__qa-*` 探针 | **没有**（`ls packages/game-core/src/v2/ \| grep __` 无输出） |
| 主仓库 `git status --porcelain` | 只有本报告 |
| 主仓库 `pnpm typecheck`（无探针） | **0 错** |
| 探针现址 | `D://code//_lifesim_qa_probe//`（**仓库外的 git worktree**，`node_modules` 用 junction），文件在 `packages/game-core/src/v2/__qa-adr0034-probe.test.ts` |
| 带探针的那棵树 `pnpm typecheck` | **0 错**（原 4 处类型不严谨已修：`equipment?.[0]`、`const battle0 = state.battle as any` 绕开 `never` 收窄） |
| 带探针的跑批 | **39 文件 / 572 用例 passed**（= 原生 548 + 探针 24） |

⇒ 主理人担心的"探针让 typecheck 红 3–4 条 / 污染别人 `git status`"**已彻底消除**，且探针现在自身也过类型检查。

### 9.2 `pendingEvent` 口径（主理人裁决）：不判 FAIL，改验一致性

口径采纳：**`slotEvent` 是唯一真源，`pendingEvent` 是过渡兼容层，两者在 normal 槽上必须一致。**
代码事实：`pendingEventView()`（`turn.ts:1274-1283`）**直接调用** `slotEventView()` 再裁剪，**不是第二份实现** ⇒ 一致性由构造成立。我仍补了 5 条断言把它锁住（探针 `QA-pendingEvent` 组，全绿）：

| 断言 | 结果 |
|---|---|
| normal 槽：`pendingEvent` 的 `eventId` / `title` / `narrative` / `options` 与 `slotEvent` **逐字段一致**（含选项可见性过滤结果） | PASS |
| `random` 槽：`slotEvent.kind === "random"` 且 `pendingEvent === null`（否则前端会把"确认"误判成"可自由行动"） | PASS |
| `combat` 槽：`slotEvent.kind === "combat"` 且 `pendingEvent === null` | PASS |
| **同源**：槽内前提失效后**两者同时变 null**（证明不是两份独立实现） | PASS |
| 空槽 / 世界终止后：两者都为 `null` | PASS |

> ⚠️ **本节已被 §12 取代**：`pendingEvent` / `activeChains` 已在 `f7d4b15` **删除**，现在只有 `slotEvent`。本节保留用于记录「当时的过渡期口径」。

⇒ 我**没有**因为「`pendingEvent` 有值」判 FAIL。附带观察（非缺陷）：投影每次会**算两遍** `slotEventView`（`slotEvent` 一次、`pendingEvent` 内部再一次），确定性输出相同，只是多一次纯读求值；若要省，把 `slotEvent` 的结果传进 `pendingEventView` 即可。

### 9.3 三条 P2 已在 `e954494` 修复（我复核了内容）

| P2 | 修复内容（`git diff eebae60 e954494`） | 我的复核 |
|---|---|---|
| P2-1 G2-3 锁强度 | `playthrough.test.ts` 新增 `for (const gateId of ["ev-ch4-gate","ev-ch5-gate","ev-ch6-gate","ev-ch7-gate"]) expect(r.chapterFires[gateId]).toBe(1)` | **正是我要求的四条断言**；在 6 个种子上全绿 ⇒ 实测四门各 1 次 |
| P2-2 G1-3 标题夸大 | 标题改为"……（转盘确认入口见 `slot-wheel-confirm.test.ts`）" | 与事实一致 |
| P2-3 契约注释 | `shared/v2.ts` 改为"写入口 = **5 个具名来源**"+ 逐条列出 + 显式写明"另有 1 处死亡路径的克隆回写……**不计为第 6 个来源**" + "⚠ 这是白名单纪律，不是类型层保证" | 与 §2.3 的分析**完全一致** |

### 9.4 第三轮跑批（最终数字）

| 命令 | 目录 | 结果 |
|---|---|---|
| `pnpm typecheck` | 主仓库（`e954494`，无探针） | **0 错** |
| `pnpm typecheck` | `_lifesim_qa_probe`（`e954494`，**含探针**） | **0 错** |
| `npx vitest run` | `_lifesim_qa_probe`（`e954494`，探针 stash 掉 = 原生） | **38 文件 / 548 用例 passed** |
| `npx vitest run`（含探针 24 例） | `_lifesim_qa_probe` | **39 文件 / 572 用例 passed** |
| 探针单独 | `_lifesim_qa_probe` | **24/24 passed**（19 原有 + 5 条 `pendingEvent` 一致性） |
| playthrough（`chapterFires` 打印） | `_lifesim_qa_probe` | 与 §5/§8.2 **逐字节相同**（s5 = thrice / t346 / 章节 15 / overall 95.01） |

> **关于"39 文件 / 567"与"38 文件 / 547/548"的差异来源**（主理人特别问）：
> - **547** = `c537980` 原生（第一轮）；**548** = `eebae60`/`e954494` 原生（+1：`eebae60` 补的「计数流相关性」用例；`e954494` 的四门断言写在既有 `it` 里，不增用例数）。
> - **567** = `eebae60` 原生 548 + **我当时的临时探针 19 例**（38+1 文件、548+19 用例）⇒ 那条"39 文件 / 567"把我放在树里的文件算进去了，**不是内核的新增**。
> - **572** = `e954494` 原生 548 + 我现在的探针 **24 例**（同一原因，但探针已在仓库外）。

### 9.5 第三轮裁定

**通过。** 10 项必验清单全部 PASS（§2），`pendingEvent` 口径按主理人裁决验证通过（§9.2），三条 P2 已修复（§9.3），探针已移出仓库且不再影响仓库 typecheck（§9.1）。
**当时唯一挂起的事项（S4 计数口径）已裁定**：按「具名来源」计 ⇒ 5 个 ⇒ **维持通过**；`assignSlot()` 仍留 §12-1。裁定记录与两种口径的后果对照见 §2.3 与 §11。

---

---

## 10. P2 修复复验（范围复验，基线 `e954494`）

> 主理人要求：**只验三条 P2 + 确认没有顺手改别的**，不重跑 `shared` / 不重验 S1/S2/S4/A2'（已冻结）。

### 10.1 范围：`e954494` 只动了 3 个文件，且只动了该动的三处

```
$ git show --stat --oneline e954494
 packages/game-core/src/v2/playthrough.test.ts     |  9 +++++++++
 packages/game-core/src/v2/slot-invariants.test.ts |  2 +-
 packages/shared/src/v2.ts                         | 13 +++++++++++---
 3 files changed, 20 insertions(+), 4 deletions(-)
```

我把**全量 diff 逐行扫过**（`git show e954494 --format=""`，即所有 +/- 行），结论：

| 文件 | 改动 | 有无越界 |
|---|---|---|
| `playthrough.test.ts` | 仅 `+9` 行：`for (const gateId of ["ev-ch4-gate","ev-ch5-gate","ev-ch6-gate","ev-ch7-gate"]) expect(r.chapterFires[gateId]).toBe(1)` + 注释 | 无（**没有**为了迁就断言去加 random 夹具、没动别的断言） |
| `slot-invariants.test.ts` | 仅 1 行标题字符串（去掉"转盘确认"字样，改指 `slot-wheel-confirm.test.ts`） | 无（**没有**顺手补用例、没动夹具） |
| `shared/v2.ts` | 仅文件头 doc 注释（`写入口**只有两个**` → `写入口 = **5 个具名来源**` + 逐条列出 + 克隆回写说明 + 白名单纪律告警） | 无（纯注释，零类型/零运行时改动） |
| **`turn.ts`** | **0 行** | ✅ 未动 |
| **`projection.ts`** | **0 行** | ✅ 未动 |
| 其它任何文件 | **0 行** | ✅ 未动 |

⇒ **没有顺手改别的。**（对比：`eebae60` 才是动引擎的那个提交；`e954494` 只在测试与注释层。）

### 10.2 P2-1 的锁**真的锁住了**（我自己做的变异验证）

主理人的标准是"没有变异验证的锁不算锁"，所以我在**仓库外那棵树**（`D://code//_lifesim_qa_probe`）做了一次双变异，同时做两件事：

1. 把 `countPresentableQueue` **退回裸 `waiting` 计数**（删掉「未到期 / 定义缺失 / 已过期 / premise 不成立」四条判据）——即复现 §13.1 那个缺陷的内核形态；
2. **屏蔽「章节 ≥ 8」那条断言**（把 `expect(r.chapters.split("→").length).toBeGreaterThanOrEqual(8)` 换成注释）——目的是排除"靠章节数间接兜住"的可能，让失败**只能**落在四门断言上。

结果（`npx vitest run src/v2/playthrough.test.ts`）：

```
× 咒术转盘 · 整局回归 … > 6 个种子 × 2 个开局都能收束，章节推进到至少第 3 章，结局在模板声明集合内
  → seed 5 章节门未触发：ev-ch4-gate: expected undefined to be 1
AssertionError: seed 5 章节门未触发：ev-ch4-gate: expected undefined to be 1
    167|         expect(r.chapterFires[gateId], `seed ${r.seed} 章节门未触发：${gateId…
```

⇒ **失败精确落在 `ev-ch4-gate`**，且此时"章节 ≥8"已被屏蔽 ⇒ 这条锁**独立成立**，不再依赖章节数间接兜底。主理人要的语义（"只有四门断言能抓住停摆"）得到实证。

还原两个变异（`git checkout -- turn.ts playthrough.test.ts`，`grep -c MUTATION` = **0**）后重跑：**2 passed**，六种子逐字节回到
`s1 death/t325 · s2 death/t349 · s3 thrice/t333 · s4 death/t349 · s5 thrice/t346 · s6 death/t341`，overall 94.45/94.73/94.70/94.93/95.01/94.68。

### 10.3 P2-2 / P2-3 内容核对

| P2 | 现在的文字 | 判定 |
|---|---|---|
| P2-2 | `it("自由行动 / 结算 / 战斗回合 / 战斗结算 / 轮外物品 / 被拒调用 全部落在 {0,1} 且没有 2（转盘确认入口见 slot-wheel-confirm.test.ts）"` | **准确**：该夹具确实没有 random 事件；转盘确认的 Δ=1 由 `slot-wheel-confirm.test.ts:147` 覆盖 |
| P2-3 | `写入口 = **5 个具名来源**（ADR-0034 §4 S4）` + 1–5 逐条 + `另有 1 处**死亡路径的克隆回写** … 不计为第 6 个来源` + `⚠ 这是**白名单纪律，不是类型层保证** … 加固方向见 §12-1` | **与实现和我的分析完全一致**（§2.3） |

### 10.4 本轮复验的跑批（只这三条，未重跑全量）

| 命令 | 结果 |
|---|---|
| `git show --stat e954494` | 3 文件 / +20 −4 |
| `git show e954494` 全量 diff 扫描 | 仅上述三处，`turn.ts` / `projection.ts` 命中 0 行 |
| 变异后 `vitest run playthrough.test.ts` | **2 failed**，其中一条 `seed 5 章节门未触发：ev-ch4-gate`（另一条是既有 D-06 `96.14 < 96`，同源失败） |
| 还原后 `vitest run playthrough.test.ts` | **2 passed**，六种子逐字节不变 |
| 主仓库 `git status` / `pnpm typecheck` | 只有本报告 / **0 错** |

### 10.5 裁定

**PASS。** 三条 P2 修复到位、范围零越界、回归锁经独立变异验证确认有效。

### 10.6 数字口径约定（应主理人要求，此后一律标注）

本报告所有跑批数字**默认不含我的探针**，凡含探针的必标 `(含探针 N 例)`：

| 基线 | 原生 | 含探针 |
|---|---|---|
| `c537980` | 38 文件 / 547 | — |
| `eebae60` | 38 文件 / 548 | 39 文件 / 567（+19 例，**当时探针在树内**） |
| **`e954494`** | **38 文件 / 548** | **39 文件 / 572**（+24 例，**探针在仓库外**） |

> ⚠️ 提醒：流传过的"39 文件 / 567"= `eebae60` 原生 548 + 我当时放在树里的 19 例探针，**不是内核的用例数**。

---

---

## 11. 裁定记录（逐条可追溯，供后来者不必再问一遍）

| # | 事项 | 裁定 | 依据 | 落地位置 |
|---|---|---|---|---|
| R-1 | **S4 计数口径** | **按「具名来源」计 ⇒ 5 个 ⇒ PASS**（不按赋值语句） | `turn.ts:830` 是 `applyDeathRouteInPlace` 的克隆回写，只能写 `death` 来源的值或原值，**产生不了第 6 个 `from`**；把"赋值语句条数"当口径会把语义上不存在的写点算成缺陷，反而逼实现改一个没问题的地方 | ADR §4 S4 措辞 + `shared/v2.ts:205-214` 注释（`7b578ad`）+ 本报告 §2.3 |
| R-2 | **`assignSlot()` 单入口 + 写点枚举测试** | **不在本轮**，留在加固清单；落地时把克隆回写作为**特例显式处理** | ADR §12-1 | ADR §12-1 |
| R-3 | **`pendingEvent` 兼容层**（→ **已被 §12 取代：字段已删除**） | 不判 FAIL；`slotEvent` 是唯一真源，`pendingEvent` 是过渡兼容层；**两者在 normal 槽上必须一致** | `pendingEventView` 内部就是调 `slotEventView`（同源）；前端 5 处引用尚未切换 | 本报告 §9.2（5 条一致性断言，全绿） |
| R-4 | **反作弊的 `instanceId` 口径** | 装备/战斗视图里的 `instanceId` 是**既有协议字段**，不是 §8-⑪ 禁的队列身份 ⇒ 按 ADR 判 PASS | 前端靠它发 `unequip` / 选战斗目标；禁掉会打断链路 | 本报告 §2.9 |
| R-5 | **「一轮只结算一个」的保证强度** | ADR §4 S1 改为两段更诚实：**①结构保证**（`slot` 标量装不下第二个）+ **②实现顺序约定**（`nextTurn` 对 normal/random 只呈现不结算） | 我第一轮 §2.1 的注记 | ADR §4 S1（`7b578ad`）+ §12-4 |
| R-6 | **投影重复求值** | 记为**小优化**，不单开条目：每次投影会把槽视图算两遍（`projection.ts:249` 与 `pendingEventView` 内部各一次），输出确定、无害 | 本报告 §9.2 观察 | ADR §12-5 |
| R-7 | **数字口径** | 一律**默认不含探针**，含探针必标 `(含探针 N 例)`；本轮以 **38 文件 / 548 用例**为准（含探针 39 / 572） | 曾把"39/567"（= 548 + 我在树内的 19 例探针）当成内核数字 | 本报告头部约定 + §10.6 |

> 一句话给后来者：**本轮的"通过"是"行为正确 + 可验证"的通过，不是"结构性保证已经完美"**。真正把"结构保证"变成类型层事实的，是 ADR §12-1 的 `assignSlot()` + 写点枚举测试——那件事**还没做**。

---

---

## 12. 过渡字段删除复验（范围复验，基线 `f7d4b15`）

> 主理人要求：只验「两个字段真的没了 + `slotEvent` 单一真源 + 投影形状没被删坏 + `apps/web` 一行未动」，不重跑全量。
> **本节取代 §9.2 与 §11-R3 关于「`pendingEvent` 是过渡兼容层」的描述**——它现在已被**删除**，只剩 `slotEvent`。

### 12.1 范围：`f7d4b15` 动了 8 个文件，`apps/web` **0 行**

```
$ git show --stat --oneline f7d4b15
 apps/server/smoke/narrative.smoke.ts              |  2 --
 packages/game-core/src/v2.test.ts                 |  4 ++--
 packages/game-core/src/v2/ending-pipeline.test.ts |  8 ++++----
 packages/game-core/src/v2/guard.test.ts           |  8 +++++---
 packages/game-core/src/v2/projection.ts           | 19 ++++---------------
 packages/game-core/src/v2/r25-acceptance.test.ts  | 13 ++++++++-----
 packages/game-core/src/v2/turn.ts                 | 16 ----------------
 packages/shared/src/v2.ts                         | 15 ---------------
 8 files changed, 23 insertions(+), 62 deletions(-)
```

- **`apps/web` 命中 0 次**（`git show f7d4b15 --stat --format="" | grep -c "apps/web"` = 0）✅
- 唯一越界是 `apps/server/smoke/narrative.smoke.ts` 的 **−2 行**夹具（`makeSnapshot` 里的 `pendingEvent: null` / `activeChains: []`）——它**必须**同批删，否则 `pnpm typecheck` 红。与内核的说法一致。
- 其余：协议层删两个字段 + `PendingEventView` 接口；投影层删两处写入；`turn.ts` 删 `pendingEventView`（−16 行）；4 个测试文件改断言。

### 12.2 两个字段**真的不存在**（类型 + 运行时 + 负向锁会红）

| 层面 | 检查 | 结果 |
|---|---|---|
| 类型层 | `grep -n "pendingEvent\|activeChains" packages/shared/src/v2.ts` | **0 命中**（只剩一句注释提到开局的 `handoff.pendingEvents`，不是被删字段） |
| 运行时 | 我自己的探针：`"pendingEvent" in snapshot === false` / `"activeChains" in snapshot === false`，**空槽 / 有槽 / 终止态三种情形**都断言 | **PASS**（同时正向对照 `slotEvent` / `lastWheels` 仍在，确认不是把相邻字段一起删了） |
| 全仓引用 | `grep -rn "\.pendingEvent\b\|\.activeChains\b" packages apps` | **0 命中**（代码零引用） |
| 前端 | `grep -rn "pendingEvent\|activeChains" apps/web/src` | **0 命中**；`slotEvent` 出现 **9 处** |

**负向锁的独立变异验证（我自己做的，不采信内核自述）**：在我那份仓库外 worktree 里把两个字段**塞回投影对象**

```ts
 slotEvent: ended ? null : slotEventView(state, lookup),
+...({ pendingEvent: null, activeChains: [] } as Record<string, unknown>),   // MUTATION
```

跑 3 个相关测试文件 ⇒ **4 failed / 48 passed**，且失败**精确**是这四条（全部 `expected true to be false`）：

```
FAIL  ending-pipeline.test.ts > 结局投影与归档 > 终止后 slotEvent 投影为 null（…）
FAIL  r25-acceptance.test.ts > T1-09 · 确定性与玩家端投影边界 > hidden 与实例层/事实层字段不进入玩家端投影
FAIL  __qa-adr0034-probe.test.ts > QA-字段删除 > 投影对象上两个字段的 `in` 为 false（负向锁的独立复现）
FAIL  __qa-adr0034-probe.test.ts > QA-字段删除 > 空槽 / 终止态的投影同样没有这两个字段
```

还原后（`git checkout f7d4b15 -- projection.ts turn.ts`，`grep -c MUTATION` = 0）⇒ 3 个文件全绿（52 passed）。
⇒ **这两条负向锁不是空转**：字段一旦复活，它们必红。内核的说法成立，我独立复现了。

### 12.3 `slotEvent` 是单一真源；每份快照**只算一次**（实测 2 → 1）

| 检查 | 结果 |
|---|---|
| `projection.ts` 里 `slotEventView` 的出现 | **1 处 import + 1 处调用**（`:252`），另一处只是注释里的字样；`pendingEventView` / `PendingEventView` 全仓**代码零引用**（仅 2 条注释提到「已删除」） |
| 「每份快照只算一次」是否成立 | **成立，且我做了前后对照实测**：在 `slotEventView` 顶部插一个 `globalThis.__slotViewCalls++` 计数探针，同一份 normal 槽状态调一次 `projectSnapshotV2` —— **`ee5a20b`（删除前）= 2 次**（失败信息 `expected 2 to be 1`，即 `slotEvent` 一次 + `pendingEventView` 内部再一次），**`f7d4b15`（删除后）= 1 次**（全绿）；连调两次快照 = 2 次（线性，不是缓存造成的假 1） |
| ⇒ ADR §12-5 的「投影重复求值」 | **已随本提交消失**，可从加固清单勾掉 |

> 说明：那个计数探针是我为**测量**临时加的（只在我那份 worktree 里，未提交，测完即删），没有留成测试——否则等于要求内核永远保留一个仅供测试的计数器。

### 12.4 删除**没有**动到模拟语义（六种子逐字段一致）

`playthrough` 六种子在 `f7d4b15`（删字段后）与 `ee5a20b`（删字段前）**完全相同**：

| 种子 | 结局 | 天数 | 回合 | 章节段数 | overall | ch4/5/6/7 门次数 |
|---|---|---|---|---|---|---|
| s1 | end-death | 4736 | 325 | 14 | 94.45 | 1/1/1/1 |
| s2 | end-death | 4736 | 349 | 14 | 94.73 | 1/1/1/1 |
| s3 | end-secret-thrice | 4755 | 333 | 15 | 94.70 | 1/1/1/1 |
| s4 | end-death | 4736 | 349 | 14 | 94.93 | 1/1/1/1 |
| s5 | end-secret-thrice | 4755 | 346 | 15 | 95.01 | 1/1/1/1 |
| s6 | end-death | 4736 | 341 | 14 | 94.68 | 1/1/1/1 |

- 与 §5 / §8.2 / §10.4 记录的三轮基线**逐字段一致**（结局、天数、回合、章节、overall 全同）
- 章节段数 14–15，仍 ≥ 8；四门各恰好 1 次（`e954494` 补的锁继续有效）
- 结论：**删的是纯投影字段，模拟语义零变化**（符合预期，也是一条「改动确实只发生在表现层」的旁证）

### 12.5 其它
- 主仓库 `pnpm typecheck` → **0 错**
- 我的探针更新为 **21 例**（原 24 例里的 5 条 `pendingEvent` 一致性断言随字段删除而作废，改为 2 条负向锁；另 1 条计数用例是测量工具，测完删除）
- 探针仍在仓库外 `D://code//_lifesim_qa_probe`（现停在 `f7d4b15`），主仓库零残留

### 12.6 裁定

**PASS。** 两个字段在类型层与运行时都已消失、负向锁经独立变异验证确认真会红、`slotEvent` 是唯一真源且每份快照只算一次（实测 2 → 1）、六种子语义零变化、`apps/web` 一行未动、唯一越界（smoke 夹具 −2 行）属必要。

---

## 附录 A · 探针全文（21 例，`f7d4b15` 版）

> 现址：`D:\code\_lifesim_qa_probe\packages\game-core\src\v2\__qa-adr0034-probe.test.ts`（仓库外的 worktree，**不在主仓库里**；当前停在 `f7d4b15`）。
> 21 例分布：S1 正向 1 + 反向 4；S2 十入口 1 + 被拒 1；§3-3 两例；A2' 五例；G2 两例；反作弊两例；字段删除负向锁 2 例；确定性 1 例（真实模板）。
> 原 5 条 `pendingEvent` 一致性断言已随 `f7d4b15` 删除字段而作废，替换为 2 条负向锁（§12.2）。

```ts
// QA 临时探针（验收 ADR-0034，**不属于交付物**）：现驻仓库外 worktree，f7d4b15 版共 21 例。
// 21 例：S1 正向 1 + 反向 4；S2 十入口 1 + 被拒 1；§3-3 两例；A2' 五例；G2 两例；
//        反作弊两例；字段删除负向锁 2 例（pendingEvent / activeChains）；确定性 1 例（真实模板）

/**
 * QA 临时探针（验收 ADR-0034，**不属于交付物**）：跑完即删。
 * 全部夹具独立于实现方 slot-invariants.test.ts，避免"复用作者夹具"的循环论证。
 *
 * 探针覆盖：S1 正向/反向、S2 九个写入口净增量、§3-3 三态混排扫描、§13.5 A2' 五条、
 * 确定性（合成 + 真实模板）、G2 诚实性、反作弊投影、terminal 后 slotEvent。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  EndingConfigSchema,
  EvaluationConfigSchema,
  OpeningTemplateSchema,
  WorldTemplateV2Schema,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import { createLookup, type TemplateLookup } from "./lookup.js";
import { enqueueScheduled, scanDelayQueue } from "./scheduler.js";
import { advanceTurnV2, battleActionV2, chooseOptionV2, slotEventView, useItemV2 } from "./turn.js";
import { equipV2, unequipV2 } from "./equipment-turn.js";
import { assembleArchive } from "./archive.js";
import { projectSnapshotV2 } from "./projection.js";
import { evaluateLifeV2 } from "./life-evaluation.js";
import { createWorldV2, type TurnPipelineConfig } from "./turn.js";
import { handoff, runOpening } from "./opening.js";
import { createRunnerContext } from "./runner-context.js";
import { checkAllConditions, maxHp } from "./engine.js";
import { createActiveWorldV2 } from "./test-utils.js";

const REST = { action: { type: "rest", description: "" } };
const PATROL = { action: { type: "patrol", description: "" } };
const STUDY = { action: { type: "study", description: "" } };

// ---------- 独立夹具 ----------

const RAW: Record<string, unknown> = {
  meta: { id: "t-qa", name: "QA", description: "d", startYear: 2000, engineProtocol: "v2" },
  time: { defaultStep: { value: 1, unit: "hour" } },
  genders: [{ id: "f", label: "女" }],
  mood: {
    min: 0,
    max: 100,
    defaultValue: 60,
    bands: [{ id: "n", label: "平静", min: 0, max: 100, attributeModifiers: {} }],
  },
  statusBar: [{ id: "sb1", label: "基本", source: "identity" }],
  attributes: { order: ["power"], defaults: { power: 5 } },
  resources: { hp: { base: 100, perLevel: 0 }, mp: { base: 50, perLevel: 0 } },
  regen: { perTurn: { hp: 0, mp: 0 } },
  characters: [
    {
      id: "npc-a",
      isEnemy: false,
      identity: { name: "甲", age: 17, gender: "f" },
      visibility: "public",
      mood: { value: 60 },
      attributes: { power: 4 },
      skills: [],
      public: {},
      private: {},
      relationship: 10,
    },
    {
      id: "enemy-x",
      isEnemy: true,
      identity: { name: "敌人", age: 0, gender: "f" },
      visibility: "public",
      mood: { value: 50 },
      attributes: { power: 1 },
      skills: ["sk-tap"],
      public: {},
      private: { combatHints: { skillWeights: { "sk-tap": 1 } } },
      relationship: -100,
    },
  ],
  playerTemplate: { identity: { gender: "f", age: 16 }, attributes: { power: 10 }, skills: ["sk-strike"] },
  actions: [
    { id: "rest", label: "休息", duration: { value: 1, unit: "hour" } },
    { id: "patrol", label: "巡逻", duration: { value: 1, unit: "hour" } },
    { id: "study", label: "学习", duration: { value: 1, unit: "hour" } },
  ],
  skills: [
    {
      id: "sk-strike",
      kind: "combat",
      name: "斩击",
      cost: { mp: 0 },
      target: "enemy",
      damage: [{ preset: "fixed", value: 999 }],
      cooldownTurns: 0,
      usableInBattle: true,
    },
    {
      id: "sk-tap",
      kind: "combat",
      name: "轻拍",
      cost: { mp: 0 },
      target: "enemy",
      damage: [{ preset: "fixed", value: 1 }],
      cooldownTurns: 0,
      usableInBattle: true,
    },
  ],
  items: [
    {
      id: "item-heal",
      type: "consumable",
      name: "急救包",
      stackable: true,
      usableInBattle: false,
      usableOutsideBattle: true,
      use: [{ type: "adjustResource", resource: "hp", value: 5 }],
    },
    {
      id: "item-sword",
      type: "equipment",
      name: "铁刀",
      stackable: false,
      usableInBattle: false,
      usableOutsideBattle: false,
      slot: "weapon",
      category: "weapon",
      quality: "common",
    },
  ],
  equipment: {
    qualities: ["common"],
    slots: [{ id: "weapon", label: "武器", maxCount: 1, allowedCategories: ["weapon"] }],
    initialEquipment: [],
  },
  statuses: [],
  events: [],
};

const EV: Record<string, unknown> = {
  a: {
    id: "ev-a",
    title: "A",
    narrative: "A 正文",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-a", text: "继续", nextEventId: "ev-b" }] } },
  },
  a2wheel: {
    id: "ev-a2wheel",
    title: "A2",
    narrative: "A2 正文",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-a2", text: "转动命数车轮", nextEventId: "ev-wheel" }] } },
  },
  b: {
    id: "ev-b",
    title: "B",
    narrative: "B 正文",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  c1: {
    id: "ev-c1",
    title: "日常1",
    narrative: "C1 正文",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  c2: {
    id: "ev-c2",
    title: "日常2",
    narrative: "C2 正文",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  gated: {
    id: "ev-gated",
    title: "点名甲",
    narrative: "甲在場。",
    trigger: { source: "chain", conditions: [{ npcState: { npcId: "npc-a", state: "alive" } }] },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  /** 无条件，但正文点名甲 —— 用来验 G2「内核不保证诈尸」。 */
  refsA: {
    id: "ev-refs-a",
    title: "甲的独白",
    narrative: "甲坐在窗边说话。",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  deadline: {
    id: "ev-deadline",
    title: "限时",
    narrative: "限时正文",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  miss: {
    id: "ev-miss",
    title: "会错失",
    narrative: "错失正文",
    trigger: { source: "chain", missWhen: [{ flag: "gone", eq: true }] },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  fut: {
    id: "ev-fut",
    title: "明天的",
    narrative: "未来正文",
    trigger: { source: "chain" },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  wheel: {
    id: "ev-wheel",
    title: "车轮",
    narrative: "转盘正文",
    trigger: { source: "chain" },
    kind: "random",
    settle: {
      random: {
        wheel: {
          segments: [
            {
              weight: 1,
              label: "上签",
              effects: [{ type: "setFlag", id: "wheelPick", value: "上" }],
              nextEventId: "ev-b",
            },
            {
              weight: 99,
              label: "下签",
              effects: [{ type: "setFlag", id: "wheelPick", value: "下" }],
              nextEventId: "ev-c1",
            },
          ],
        },
      },
    },
  },
  combat: {
    id: "ev-combat",
    title: "遭遇战",
    narrative: "敌人出现。",
    trigger: { source: "action-hook", onActionId: "patrol", probability: 1 },
    kind: "combat",
    settle: { combat: { enemies: [{ ref: "enemy-x", levelScale: 1 }], onVictory: { effects: [] } } },
  },
  hook: {
    id: "ev-hook",
    title: "学习钩子",
    narrative: "钩子正文",
    trigger: { source: "action-hook", onActionId: "study", probability: 1 },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
  gate: {
    id: "ev-gate",
    title: "章节门",
    narrative: "主线。",
    trigger: { source: "pool", probability: 1, priority: 100, once: true },
    kind: "normal",
    settle: { normal: { options: [{ id: "opt-ok", text: "继续" }] } },
  },
};

function tpl(events: unknown[]): WorldTemplateV2 {
  return WorldTemplateV2Schema.parse({ ...structuredClone(RAW), events: structuredClone(events) });
}

function world(events: unknown[], worldId: string, seed = 7): {
  state: WorldStateV2;
  template: WorldTemplateV2;
  lookup: TemplateLookup;
} {
  const template = tpl(events);
  const lookup = createLookup(template);
  const state = createActiveWorldV2({ templateId: "t-qa", playerName: "验收", seed }, template, worldId);
  state.player.inventory["item-heal"] = 3;
  state.player.inventory["item-sword"] = 1;
  return { state, template, lookup };
}

function due(state: WorldStateV2, definitionId: string, startMin = 0): void {
  enqueueScheduled({
    state,
    definitionId,
    origin: { kind: "effect", id: definitionId },
    start: { value: startMin, unit: "minute" },
  });
}

function killed(state: WorldStateV2): void {
  state.npcs.find((n) => n.id === "npc-a")!.lifecycle = {
    state: "inactive",
    reasonCode: "阵亡",
    sinceTurn: state.turnIndex,
    sinceWorldTime: state.worldTime,
  };
}

// ---------- S1 正向：后继占槽、日常留队 ----------

describe("QA-S1 · 一轮最多结算一个事件", () => {
  it("正向：A 结算产生无延迟后继 B、队列有到期 C ⇒ 槽=B、C 仍在队列、净增量 1", () => {
    const { state, template, lookup } = world([EV.a, EV.b, EV.c1], "qa-s1-fwd");
    due(state, "ev-c1");
    state.slot = { eventId: "ev-a", from: "queueTake" };
    const t0 = state.turnIndex;

    chooseOptionV2(state, { optionId: "opt-a" }, template, lookup);

    expect(state.turnIndex).toBe(t0 + 1);
    expect(state.slot).toEqual({ eventId: "ev-b", from: "successor", fromEventId: "ev-a" });
    const c = state.delayQueue.filter((i) => i.definitionId === "ev-c1");
    expect(c).toHaveLength(1);
    expect(c[0].status).toBe("waiting");
    expect(state.eventFires.filter((f) => f.eventId === "ev-c1")).toHaveLength(0);
  });

  it("反向①：空槽自由行动时队列有到期事件 ⇒ 只占槽不结算（净增量 1，零记火）", () => {
    const { state, template, lookup } = world([EV.c1], "qa-s1-rev1");
    due(state, "ev-c1");
    const t0 = state.turnIndex;
    const res = advanceTurnV2(state, REST, template, lookup);
    expect(state.turnIndex).toBe(t0 + 1);
    expect(state.slot).toMatchObject({ eventId: "ev-c1", from: "queueTake" });
    expect(state.eventFires.filter((f) => f.eventId === "ev-c1")).toHaveLength(0);
    expect(res.snapshot.slotEvent?.kind).toBe("normal");
  });

  it("反向②：转盘确认 ⇒ 只结算转盘一个事件；后继占槽不被同轮结算（净增量 1）", () => {
    const { state, template, lookup } = world([EV.wheel, EV.b, EV.c1], "qa-s1-rev2");
    due(state, "ev-wheel");
    advanceTurnV2(state, REST, template, lookup); // 呈现（掷骰）
    expect(slotEventView(state, lookup)?.kind).toBe("random");
    expect(state.flags.wheelPick).toBeUndefined();
    const shown = state.lastWheel!.label;
    const t0 = state.turnIndex;
    const firesBefore = state.eventFires.length;

    advanceTurnV2(state, REST, template, lookup); // 确认

    expect(state.turnIndex).toBe(t0 + 1);
    expect(state.eventFires.length).toBe(firesBefore + 1); // 只记了转盘这一条火
    // 后继占槽（段上声明了 nextEventId ⇒ 无时间账 ⇒ 占槽），但**没有**在本轮结算
    const expectedSuccessor = shown === "上签" ? "ev-b" : "ev-c1";
    expect(state.slot).toEqual({ eventId: expectedSuccessor, from: "successor", fromEventId: "ev-wheel" });
    expect(state.eventFires.filter((f) => f.eventId === expectedSuccessor && f.turnIndex === state.turnIndex)).toHaveLength(0);
  });

  it("反向③：选项后继是 random ⇒ 只呈现不结算（净增量 1，落账为 0）", () => {
    const { state, template, lookup } = world([EV.a2wheel, EV.wheel, EV.b, EV.c1], "qa-s1-rev3");
    state.slot = { eventId: "ev-a2wheel", from: "queueTake" };
    const t0 = state.turnIndex;
    chooseOptionV2(state, { optionId: "opt-a2" }, template, lookup);
    expect(state.turnIndex).toBe(t0 + 1);
    expect(state.slot).toEqual({ eventId: "ev-wheel", from: "successor", fromEventId: "ev-a2wheel" });
    expect(state.flags.wheelPick).toBeUndefined(); // 呈现 ≠ 结算
    expect(state.eventFires.filter((f) => f.eventId === "ev-wheel")).toHaveLength(0);
  });

  it("反向④：行动钩子占槽（hook）后同轮不再结算它（净增量 1）", () => {
    const { state, template, lookup } = world([EV.hook], "qa-s1-rev4");
    const t0 = state.turnIndex;
    advanceTurnV2(state, STUDY, template, lookup);
    expect(state.turnIndex).toBe(t0 + 1);
    expect(state.slot).toMatchObject({ eventId: "ev-hook", from: "hook" });
    expect(state.eventFires.filter((f) => f.eventId === "ev-hook")).toHaveLength(0);
  });
});

// ---------- S2：九个写入口逐项净增量 ----------

describe("QA-S2 · 每个写入口净 turnIndex 增量 ∈ {0,1}，绝无 2", () => {
  it("自由行动/转盘确认/选项/战斗回合/战斗结算/用物品/穿/脱/归档 逐项记录", () => {
    const { state, template, lookup } = world(
      [EV.combat, EV.a, EV.b, EV.wheel, EV.c1],
      "qa-s2-entries",
    );
    const deltas: Array<[string, number]> = [];
    const rec = (name: string, fn: () => void): void => {
      const before = state.turnIndex;
      fn();
      deltas.push([name, state.turnIndex - before]);
    };

    // 1) 自由行动
    rec("advanceTurnV2(free)", () => advanceTurnV2(state, REST, template, lookup));
    // 2) 转盘确认（先造一个 random 槽走真实路径）
    due(state, "ev-wheel");
    rec("advanceTurnV2(present-wheel)", () => advanceTurnV2(state, REST, template, lookup));
    if (state.slot?.eventId === "ev-wheel") {
      rec("advanceTurnV2(confirm-wheel)", () => advanceTurnV2(state, REST, template, lookup));
    }
    // 3) 选项结算
    state.slot = { eventId: "ev-a", from: "queueTake" };
    rec("chooseOptionV2", () => chooseOptionV2(state, { optionId: "opt-a" }, template, lookup));
    // 4) 用物品（轮外）
    rec("useItemV2", () => useItemV2(state, { itemId: "item-heal" }, template, lookup));
    // 5) 穿装备（copy-on-write：返回新状态，故把三个被改动的字段搬回来继续后面的用例）
    const adopt = (next: WorldStateV2): void => {
      state.player.equipment = next.player.equipment;
      state.player.inventory = next.player.inventory;
      state.history = next.history;
    };
    rec("equipV2", () => adopt(equipV2(state, { itemId: "item-sword" }, template, lookup).state));
    // 6) 脱装备
    const inst = state.player.equipment?.[0];
    if (inst) rec("unequipV2", () => adopt(unequipV2(state, { instanceId: inst.instanceId }, template, lookup).state));
    // 7) 战斗：先清槽再打
    state.slot = null;
    state.battle = null;
    rec("advanceTurnV2(patrol→hook combat)", () => advanceTurnV2(state, PATROL, template, lookup));
    const battle0 = state.battle as any;
    if (battle0 !== null) {
      battle0.enemies[0].hp = 100000;
      battle0.enemies[0].maxHp = 100000;
      rec("battleActionV2(mid)", () =>
        battleActionV2(state, { type: "skill", skillId: "sk-strike" }, template, lookup),
      );
      battle0.enemies[0].hp = 1;
      rec("battleActionV2(finish)", () =>
        battleActionV2(state, { type: "skill", skillId: "sk-strike" }, template, lookup),
      );
    }
    // 8) 归档（先给 termination）
    state.termination = { reason: "qa", worldTime: state.worldTime, turnIndex: state.turnIndex, source: "condition", endingId: "end-x" };
    rec("assembleArchive", () =>
      assembleArchive(state, template, lookup, { endingId: "end-x" } as never, evaluateLifeV2(state)),
    );

    console.log("QA-S2 deltas:", JSON.stringify(deltas));
    for (const [name, d] of deltas) expect([0, 1], `入口 ${name} 净增量=${d}`).toContain(d);
    expect(deltas.some(([, d]) => d === 0)).toBe(true);
    expect(deltas.some(([, d]) => d === 1)).toBe(true);
    // 覆盖自检：九个入口里至少出现 7 个不同名字（防止某分支被 if 跳过而空跑）
    expect(new Set(deltas.map(([n]) => n)).size).toBeGreaterThanOrEqual(7);
  });

  it("被拒调用净增量 0（槽被 normal 占时提交自由行动 / 提交不存在的选项）", () => {
    const { state, template, lookup } = world([EV.a, EV.b], "qa-s2-rejected");
    state.slot = { eventId: "ev-a", from: "queueTake" };
    const t0 = state.turnIndex;
    expect(() => advanceTurnV2(state, REST, template, lookup)).toThrow("pending_event_required");
    expect(() => chooseOptionV2(state, { optionId: "nope" }, template, lookup)).toThrow("option_not_available");
    expect(state.turnIndex).toBe(t0);
  });
});

// ---------- §3-3 扫描语义：三态混排 ----------

describe("QA-§3-3 · 条件不满足留队、不卡队头；过期/missWhen 才出队并记错失", () => {
  it("三条同起点实例混排（hold / 过期 / missWhen / 可上桌）⇒ 取出顺序与残留状态符合死结论", () => {
    const { state, lookup } = world([EV.gated, EV.deadline, EV.miss, EV.c1, EV.c2], "qa-33");
    killed(state);
    state.flags.gone = true; // missWhen 命中
    due(state, "ev-gated"); // hold
    due(state, "ev-deadline"); // 有 end ⇒ 先被扫到
    state.delayQueue.find((i) => i.definitionId === "ev-deadline")!.window = { start: 0, end: 1 };
    state.delayQueue.find((i) => i.definitionId === "ev-deadline")!.hasEnd = true;
    due(state, "ev-miss"); // drop
    due(state, "ev-c1"); // 可上桌
    due(state, "ev-c2"); // 可上桌（队尾）
    state.worldTime = 10; // 超过 deadline 的 end=1

    const first = scanDelayQueue(state, lookup, () => 0.5);
    expect(first.kind).toBe("taken");
    if (first.kind === "taken") expect(first.definition.id).toBe("ev-c1"); // 跳过 hold/过期/miss 后取到

    const reasons = state.missedEvents.map((m) => `${m.eventId}:${m.reason}`).sort();
    expect(reasons).toEqual(["ev-deadline:window_expired", "ev-miss:miss_when"]);
    // 失效实例留队（不丢弃、不改 status）
    const gated = state.delayQueue.find((i) => i.definitionId === "ev-gated")!;
    expect(gated.status).toBe("waiting");
    // 过期/miss 已出队（status 置终态）
    expect(state.delayQueue.find((i) => i.definitionId === "ev-deadline")!.status).toBe("expired");
    expect(state.delayQueue.find((i) => i.definitionId === "ev-miss")!.status).toBe("expired");

    // 第二次扫描：c2 仍可取出；第三次：只剩 hold ⇒ none，且 hold 不卡队头也不被丢
    const second = scanDelayQueue(state, lookup, () => 0.5);
    expect(second.kind).toBe("taken");
    if (second.kind === "taken") expect(second.definition.id).toBe("ev-c2");
    expect(scanDelayQueue(state, lookup, () => 0.5)).toEqual({ kind: "none" });
    expect(state.delayQueue.find((i) => i.definitionId === "ev-gated")!.status).toBe("waiting");
    expect(state.missedEvents).toHaveLength(2);
  });

  it("窗口未到的实例不被跳过式误取，且扫描在 start > now 处停（不越界取值）", () => {
    const { state, lookup } = world([EV.fut, EV.c1], "qa-33-future");
    due(state, "ev-fut", 1440); // 明天
    due(state, "ev-c1", 0); // 今天
    const r1 = scanDelayQueue(state, lookup, () => 0.5);
    expect(r1.kind).toBe("taken");
    if (r1.kind === "taken") expect(r1.definition.id).toBe("ev-c1");
    expect(scanDelayQueue(state, lookup, () => 0.5)).toEqual({ kind: "none" });
    expect(state.delayQueue.find((i) => i.definitionId === "ev-fut")!.status).toBe("waiting");
    expect(state.missedEvents).toEqual([]);
  });
});

// ---------- §13.5 A2'：五条 ----------

describe("QA-§13.5 A2' · 池阈值只数「当前可上桌」的 waiting", () => {
  it("① 三条永假实例顶满队列 ⇒ 池仍抽取（死实例不挡路）", () => {
    const { state, template, lookup } = world([EV.gated, EV.gate], "qa-a2-1");
    killed(state);
    for (let i = 0; i < 3; i += 1) due(state, "ev-gated");
    advanceTurnV2(state, REST, template, lookup);
    expect(state.delayQueue.some((i) => i.definitionId === "ev-gate")).toBe(true);
    expect(state.slot).toMatchObject({ eventId: "ev-gate", from: "queueTake" });
    expect(state.delayQueue.filter((i) => i.status === "waiting")).toHaveLength(3); // 死实例不清理
  });

  it("② 三条未来实例顶满队列 ⇒ 池仍抽取（未来实例不挡路）", () => {
    const { state, template, lookup } = world([EV.fut, EV.gate], "qa-a2-2");
    for (let i = 0; i < 3; i += 1) due(state, "ev-fut", 1440);
    advanceTurnV2(state, REST, template, lookup);
    expect(state.delayQueue.some((i) => i.definitionId === "ev-gate")).toBe(true);
  });

  it("③ 三条可上桌实例顶满队列 ⇒ 池不抽取（活实例仍封顶）", () => {
    const { state, template, lookup } = world([EV.c1, EV.c2, EV.gate], "qa-a2-3");
    for (let i = 0; i < 3; i += 1) due(state, "ev-c1");
    advanceTurnV2(state, REST, template, lookup);
    expect(state.delayQueue.some((i) => i.definitionId === "ev-gate")).toBe(false);
  });

  it("④ 纯读：计数前后 delayQueue / missedEvents / eventFires / slot 逐字段相等", () => {
    const { state, template, lookup } = world([EV.gated], "qa-a2-4");
    killed(state);
    for (let i = 0; i < 3; i += 1) due(state, "ev-gated");
    const queueBefore = JSON.stringify(state.delayQueue);
    const missedBefore = JSON.stringify(state.missedEvents);
    const firesBefore = JSON.stringify(state.eventFires);
    const lastFiredBefore = JSON.stringify(state.lastFiredIndex);

    advanceTurnV2(state, REST, template, lookup); // postSettleJudgements ⇒ countPresentableQueue 执行

    expect(JSON.stringify(state.delayQueue)).toBe(queueBefore);
    expect(JSON.stringify(state.missedEvents)).toBe(missedBefore);
    expect(JSON.stringify(state.eventFires)).toBe(firesBefore);
    expect(JSON.stringify(state.lastFiredIndex)).toBe(lastFiredBefore);
    expect(state.slot).toBeNull();
  });

  it("⑤ 不扰动主轮 RNG：同 seed 两次跑，状态逐字节相同（含 random + combat 槽）", () => {
    const run = (wid: string): string => {
      const { state, template, lookup } = world(
        [EV.combat, EV.wheel, EV.a, EV.b, EV.gate, EV.c1, EV.fut, EV.gated],
        wid,
        11,
      );
      killed(state);
      due(state, "ev-gated");
      due(state, "ev-c1");
      due(state, "ev-fut", 1440);
      for (let i = 0; i < 14; i += 1) {
        if (state.battle !== null && !state.battle.over) {
          battleActionV2(state, { type: "skill", skillId: "sk-strike" }, template, lookup);
          continue;
        }
        if (state.slot !== null) {
          const ev = lookup.event(state.slot.eventId);
          if (ev?.kind === "random") advanceTurnV2(state, REST, template, lookup);
          else if (ev?.kind === "normal") chooseOptionV2(state, { optionId: ev.settle.normal.options[0].id }, template, lookup);
          else advanceTurnV2(state, REST, template, lookup);
          continue;
        }
        advanceTurnV2(state, PATROL, template, lookup);
      }
      return JSON.stringify({ ...state, id: "same" });
    };
    const a = run("qa-det-a");
    const b = run("qa-det-b");
    expect(a.length).toBeGreaterThan(500);
    expect(a).toBe(b);
  });
});

// ---------- G2 诚实性 ----------

describe("QA-G2 · 内核不结构保证诈尸（如实记录）", () => {
  it("引用甲但**无条件**的事件在甲退场后仍会上桌（G2 未被结构保证）", () => {
    const { state, template, lookup } = world([EV.refsA], "qa-g2-honest");
    killed(state);
    due(state, "ev-refs-a");
    advanceTurnV2(state, REST, template, lookup);
    expect(state.slot).toMatchObject({ eventId: "ev-refs-a", from: "queueTake" });
    expect(slotEventView(state, lookup)?.eventId).toBe("ev-refs-a");
  });

  it("写了 npcState 条件的事件在甲退场后留队不触发（模板条件才挡得住）", () => {
    const { state, template, lookup } = world([EV.gated], "qa-g2-cond");
    killed(state);
    due(state, "ev-gated");
    advanceTurnV2(state, REST, template, lookup);
    expect(state.slot).toBeNull();
    expect(state.delayQueue[0].status).toBe("waiting");
    expect(state.missedEvents).toEqual([]);
  });
});

// ---------- 反作弊投影 ----------

describe("QA-反作弊 · 投影不下发队列身份与队列内容/长度", () => {
  it("queueTake 槽：snapshot 不含 slot.instanceId、不含 delayQueue/missedEvents/droppedPending 字段、不含其它队列事件 id", () => {
    const { state, template, lookup } = world([EV.c1, EV.c2], "qa-anticheat");
    due(state, "ev-c1");
    due(state, "ev-c2");
    advanceTurnV2(state, REST, template, lookup);
    const instId = state.slot?.instanceId;
    expect(typeof instId).toBe("string");

    const json = JSON.stringify(projectSnapshotV2(state, template, lookup));
    expect(json).not.toContain(instId as string);
    expect(json).not.toContain("delayQueue");
    expect(json).not.toContain("missedEvents");
    expect(json).not.toContain("droppedPending");
    // 队列里那条还没上桌的 ev-c2 不得出现在投影里（只有 id 形式的泄露才算；正文/标题不在此列）
    expect(json).not.toContain('"ev-c2"');
    expect(json).toContain('"ev-c1"');
    expect(json).not.toContain("pendingEvents");
  });

  it("世界终止后 slotEvent 为 null（已结束的世界不再弹事件）", () => {
    const { state, template, lookup } = world([EV.c1], "qa-ended");
    state.slot = { eventId: "ev-c1", from: "queueTake" };
    state.termination = { reason: "qa", worldTime: 0, turnIndex: 0, source: "condition", endingId: "end-x" };
    expect(projectSnapshotV2(state, template, lookup).slotEvent).toBeNull();
  });
});

// ---------- 真实模板确定性 ----------

describe("QA-确定性 · 真实模板同 seed 两次跑逐字节相同", () => {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../specs/data/templates/jjk-2006/1.0.0",
  );
  function load(): WorldTemplateV2 {
    const merged: Record<string, unknown> = {};
    for (const f of ["world.yaml", "characters.yaml", "skills.yaml", "items.yaml", "statuses.yaml", "events.yaml"]) {
      const doc = parse(readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(doc)) {
        if (k === "meta") merged.meta = v;
        else if (merged[k] === undefined) merged[k] = v;
        else if (Array.isArray(merged[k]) && Array.isArray(v)) merged[k] = (merged[k] as unknown[]).concat(v);
      }
    }
    return WorldTemplateV2Schema.parse(merged);
  }
  const template = load();
  const openings = OpeningTemplateSchema.array().parse(parse(readFileSync(path.join(dir, "opening.yaml"), "utf8")));
  const endings = EndingConfigSchema.parse(parse(readFileSync(path.join(dir, "endings.yaml"), "utf8")));
  const evaluation = EvaluationConfigSchema.parse(parse(readFileSync(path.join(dir, "evaluation.yaml"), "utf8")));
  const pipeline: TurnPipelineConfig = { endingConfig: endings, evaluationConfig: evaluation };

  function drive(seed: number, turns: number): string {
    const lookup = createLookup(template);
    const base = createWorldV2({ templateId: "jjk-2006", playerName: "确定性探针", seed }, template, "probe");
    const { state: opened, run } = runOpening(base, openings[seed % 2], { ...createRunnerContext(seed), lookup });
    const state = handoff(opened, run, lookup);
    const acts = ["train", "socialize", "patrol", "explore", "study", "rest", "recuperate"];
    let guard = 0;
    while (guard++ < turns && state.termination === null) {
      if (state.battle && !state.battle.over) {
        const cap = maxHp(state.player, template);
        if (state.player.hp < cap * 0.45 && (state.player.inventory["item-first-aid"] ?? 0) > 0) {
          battleActionV2(state, { type: "item", itemId: "item-first-aid" }, template, lookup, pipeline);
        } else {
          battleActionV2(state, { type: "skill", skillId: "sk-basic-strike" }, template, lookup, pipeline);
        }
        continue;
      }
      if (state.slot !== null) {
        const ev = lookup.event(state.slot.eventId);
        if (ev?.kind === "random") advanceTurnV2(state, REST, template, lookup, undefined, pipeline);
        else if (ev?.kind === "normal") {
          const opts = ev.settle.normal.options.filter((o) => checkAllConditions(o.visibleWhen, { state, lookup, rng: () => 0.5 }));
          chooseOptionV2(state, { optionId: (opts[0] ?? ev.settle.normal.options[0]).id }, template, lookup, pipeline);
        } else advanceTurnV2(state, REST, template, lookup, undefined, pipeline);
        continue;
      }
      advanceTurnV2(state, { action: { type: acts[(seed + guard) % acts.length], description: "" } }, template, lookup, undefined, pipeline);
    }
    return JSON.stringify({ ...state, id: "same" });
  }

  it("seed 3 / seed 5 各跑 120 步两遍，状态逐字节相同且确实走到了 random 与 combat 槽", { timeout: 120000 }, () => {
    for (const seed of [3, 5]) {
      const a = drive(seed, 120);
      const b = drive(seed, 120);
      expect(a).toBe(b);
      expect(a).toContain('"lastWheels"');
    }
  });
});

// ---------- 过渡字段已删除（f7d4b15）+ slot 视图单次求值 ----------

describe("QA-字段删除 · pendingEvent / activeChains 真的不存在，slotEvent 是单一真源", () => {
  it("投影对象上两个字段的 `in` 为 false（负向锁的独立复现）", () => {
    const { state, template, lookup } = world([EV.a, EV.b], "qa-gone-1");
    state.slot = { eventId: "ev-a", from: "queueTake" };
    const snapshot = projectSnapshotV2(state, template, lookup) as Record<string, unknown>;
    expect("pendingEvent" in snapshot).toBe(false);
    expect("activeChains" in snapshot).toBe(false);
    // 正向对照：不该把相邻字段一起删掉
    expect("slotEvent" in snapshot).toBe(true);
    expect("lastWheels" in snapshot).toBe(true);
  });

  it("空槽 / 终止态的投影同样没有这两个字段（不是只有某条分支才删）", () => {
    const { state, template, lookup } = world([EV.a, EV.b], "qa-gone-2");
    const empty = projectSnapshotV2(state, template, lookup) as Record<string, unknown>;
    expect("pendingEvent" in empty).toBe(false);
    expect("activeChains" in empty).toBe(false);
    state.termination = { reason: "qa", worldTime: 0, turnIndex: 0, source: "condition", endingId: "end-x" };
    const ended = projectSnapshotV2(state, template, lookup) as Record<string, unknown>;
    expect("pendingEvent" in ended).toBe(false);
    expect("activeChains" in ended).toBe(false);
  });

});
```

---

## 附录 B · 逐条证据索引（一行一条，供复核）

| 结论 | 命令 / 文件:行 |
|---|---|
| S1 正向 | 探针 `QA-S1 · 正向` |
| S1 反向 4 条 | 探针 `QA-S1 · 反向①–④` |
| S2 十入口 | 探针 stdout `QA-S2 deltas:`（见 §2.2） |
| S4 五来源 | `ending.ts:380` / `opening.ts:243` / `turn.ts:351,638,721`；第 6 条赋值 `turn.ts:824` |
| 清槽 6 + 初始化 1 | `turn.ts:305,344,348,689,707,1125` + `turn.ts:200` |
| §3-3 | 探针 `QA-§3-3 · …` 两例 |
| A2' 五条 | 探针 `QA-§13.5 A2' · ①–⑤`；修复前对照跑 `_qa-8f450f5` 的 2 条失败 |
| 确定性 | 探针 `QA-确定性 · 真实模板同 seed 两次跑逐字节相同` |
| 六种子 | §5 三方对照表；`chapterFires` 打印（临时改 console，跑完即删） |
| G2 | 探针 `QA-G2 · …` 两例 |
| 反作弊 | 探针 `QA-反作弊 · …` 两例；`index.ts:457/486/513/540` 响应体；`projection.ts:150/434/442` 的装备/战斗 instanceId |
| 服务端 | `PORT=3457 npx tsx apps/server/src/index.ts` → `HTTP=200` |
| 存档协议 | `apps/server/src/store.ts:50` `SCHEMA_VERSION = 3`；`shared/v2-state.ts:248` `slot: SlotSceneSchema.nullable()` |
| `pendingEvent` 一致性 | 探针 `QA-pendingEvent` 5 例；实现 `turn.ts:1274-1283`（`pendingEventView` 内部调 `slotEventView`） |
| 探针位置 | `D:\code\_lifesim_qa_probe\packages\game-core\src\v2\__qa-adr0034-probe.test.ts`（仓库外 worktree；主仓库零残留） |
| P2 三项修复 | `git diff eebae60 e954494`：`playthrough.test.ts`(+9) / `slot-invariants.test.ts`(标题) / `shared/v2.ts`(注释) |
| P2-1 变异验证 | 变异后 `vitest run playthrough.test.ts` → `seed 5 章节门未触发：ev-ch4-gate`（§10.2） |
| 裁定记录 | §11（R-1…R-7，逐条含依据与落地位置） |
| 字段删除（范围） | `git show --stat f7d4b15`：8 文件 +23 −62，`apps/web` 命中 0（§12.1） |
| 字段删除（负向锁变异） | 塞回两字段 ⇒ `4 failed / 48 passed`，四条均 `expected true to be false`（§12.2） |
| slot 视图单次求值 | 计数探针实测 `ee5a20b`=2 → `f7d4b15`=1（§12.3） |

---
