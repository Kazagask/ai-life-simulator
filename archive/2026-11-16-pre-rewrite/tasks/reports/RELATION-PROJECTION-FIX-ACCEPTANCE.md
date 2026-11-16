# 关系投影泄漏 + 「NPC 视你为 X」 验收报告

- 验收对象：HEAD `ee267f5`（`feat(template/jjk-2006): 补 npc-haibara 的 to: player 初始边（收尾）`）
- 基线：`9a8ed49` 之后三个提交 —— `d36a792`（引擎+测试）、`e8bdb60`（5 条 NPC→player 边）、`ee267f5`（补 haibara）
- 起始工作区：`git status --short` 为空
- 验收人：life-sim-qa（严过关）｜验收时间：2026-11-12
- 验收方式：**自建仓库外独立探针**（不读实现方断言、不采信转述结论）+ **判据变异验证**（把实现改错，看测试是否真红）+ 四条口径自己重跑
- 探针位置（仓库外，不入库）：`D:\code\life-sim-qa-probe\`
  - `qa-acceptance.probe.test.ts`（10 例：C1/C3/C4/C5/C6/C7）
  - `determinism.probe.test.ts`（2 例：确定性）
  - `vitest.config.mjs`（alias 直连仓库源码；`--root` 指向探针目录，仓库零污染）
  - 运行：`cd packages/game-core && ./node_modules/.bin/vitest run --root D:/code/life-sim-qa-probe`
- 隔离：全部在内存里建世界，未对 `data/worlds/` 发出任何写请求；`pnpm --filter @life-sim/server start` 只做加载期冒烟，起完即停、已确认 3000 端口释放且无残留 node 进程

## 终判

**可验收（PASS）。** 两个缺陷的修复均**独立复现为有效**，且**判据选对**（改错判据会真红、回退旧实现也会真红——测试不是空转）。四条口径全绿：**typecheck 0 错 / shared 62 / game-core 465（32 文件）/ 服务加载期通过**；我的 12 例探针全绿，含**真实通关触达到 `spawnNpc` 的正向闭环**（seed 1，第 251 轮，非构造）。**无 P0/P1。** 3 条观察项均不阻断，去向见 §八。

---

## 一、四点五口径（命令与结果，全部自己重跑）

| # | 命令 | 结果 | 判定 |
|---|---|---|---|
| 1 | `pnpm typecheck` | `tsc --noEmit -p tsconfig.json`，**0 错**，`EXIT=0`，7s | PASS |
| 2 | `pnpm --filter @life-sim/shared test` | **62 passed / 4 files**，5.66s | PASS |
| 3 | `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism`（全量） | **465 passed / 32 files**，75.18s | PASS |
| 4 | `pnpm --filter @life-sim/server start` | 模板加载通过：`Server listening at http://127.0.0.1:3000`；`curl /api/templates` 返回真实 `jjk-2006` 元数据 | PASS |
| 5 | QA 独立探针（12 例） | **12 passed**，5.8s | PASS |

口径 3 的用例数对账（证明本轮只增 3 例、且无静默丢例）：

| 文件 | `9a8ed49` 基线 `it()` 数 | `ee267f5` 现数 | 差 |
|---|---|---|---|
| `src/v2/relation-projection.test.ts` | 8 | **11** | +3（新增 D-1 三例） |
| `src/v2.test.ts` | 39 | 39 | 0（同用例内替换断言，不新增用例） |
| 其余 30 个文件 | —— | 未改动（`git diff --stat` 只列 4 个文件） | 0 |
| **合计** | **462** | **465** | **+3** |

⇒ 465 本身自洽（ADR-0022 记载的 `422` 是更早 HEAD 的数目，之后另有若干批测试合入，与本轮无关）。
还原变异后**重跑全量**：**465 / 465 绿，32 文件，76.81s** —— 终判依据的是这一次（探针改动已 `git checkout` 还原、`git status --short` 为空）。

口径 4 的附带事实（非缺陷，§八观察 1）：57 个既有本地存档全部 `save_skipped`（49 `template_fingerprint_mismatch` + 8 `schema_version_mismatch: 1`），`loaded=0`。这是 ADR-0007 的指纹策略 + 模板内容变更的必然结果，三个提交信息均已显式声明（满足 `AGENTS.md §0.3` 第 2 条）。

---

## 二、改动面核对（范围污染前置检查）

```
$ git diff 9a8ed49..ee267f5 --stat
 packages/game-core/src/v2.test.ts                  | 29 ++++++-
 packages/game-core/src/v2/projection.ts            | 32 +++++++-
 packages/game-core/src/v2/relation-projection.test.ts | 94 ++++++++++++++++++++--
 specs/data/templates/jjk-2006/characters.yaml      | 20 +++++
 4 files changed, 162 insertions(+), 13 deletions(-)

$ git diff 9a8ed49..ee267f5 --stat -- packages/shared apps/server apps/web
(空)
$ git diff 9a8ed49..ee267f5 --diff-filter=A --stat
(空 —— 无新增文件)
```

- 契约面（`packages/shared`）**零改动**；`apps/**` 零改动；无新增文件。
- `schemaVersion` 未变：`apps/server/src/store.ts:34 const SCHEMA_VERSION = 2;` 未在 diff 内。
- 档位判定：模板部分 = **T-1（仅 yaml，免 ADR）**；`packages/game-core` 投影面改动已被 `9a8ed49` 的 **ADR-0022 补记 D-1** 覆盖（投影契约补记）。**档位正确，无越档**。

---

## 三、缺陷 1（投影泄漏未登场角色）逐条证据

### C1 · 泄漏剔除是真的（真实模板 jjk-2006，seed 7）

探针自建世界（`createActiveWorldV2` + 真实六文件合并模板），**先证明前提**再证结论：

| 断言 | 实测 |
|---|---|
| `state.npcs` 里 `npc-yuta` 存在且 `lifecycle.state === "unspawned"` | ✅ 前提成立（否则「不出现」无意义） |
| `JSON.stringify(snapshot)` 不含 `npc-yuta` | ✅ |
| `JSON.stringify(snapshot)` 不含 `乙骨`（连名字都不泄） | ✅ |
| `snapshot.npcs.length` == 非 unspawned 实例数 | ✅ 10 == 10 |
| `state.relations` 仍含 `npc-gojo → npc-yuta {kind: relative, gap: true}` | ✅ **state 层未被改写**（只改投影期） |
| 结构扫描：任何一行的 `withId` 都不指向 unspawned 实例 | ✅ offenders = `[]` |
| `hidden` 集合精确等于 `["npc-yuta"]` | ✅ |

**反证缺陷曾真实存在**（这条最容易被跳过，我自己补）：未过滤的可见子图上，这条边**确实在**，且**确实会算成「远亲」**：

```
projectVisibleRelations(state.relations) 含 npc-gojo → npc-yuta   → true
kinshipTerm(未过滤边集, "npc-gojo", "npc-yuta").term              → "远亲"
最终 snapshot 是否含「远亲」                                       → false
```

⇒ 修复前的面板确实会渲染「五条悟视 npc-yuta 为亲戚 · 远亲」（端点连名字都取不到，直接露开发者 id）。修复有效。

探针输出：`[C1] 上屏 NPC=10 关系行=37 hidden=npc-yuta`

### C3 · 称谓不跨未登场节点，且不吃「远亲」兜底

合成夹具（**不是**用实现方的 fixture，我自己造 bp）：甲、乙在屏，`npc-c` 经 `npcSpawnRules` 走真实路径变 unspawned。

| 局面 | 断言 | 实测 |
|---|---|---|
| 甲→C `relative{gap:true}`（真实 jjk 形状）+ C→乙 `father` + 甲→player `disciple` | 甲的行只剩 `["player"]` | ✅ |
| 同上 | 甲对乙**无行** | ✅ |
| 同上 | 甲的每一行都不带 `kinshipTerm`（不可达 ⇒ null，不兜底） | ✅ |
| 同上 | 整份 snapshot 不含「远亲」 | ✅ |
| 同上 | 整份 snapshot 不含 `npc-c` | ✅ |
| **对照**：丁→戊 `relative{gap:true}`，两端都在屏 | 行在，且 `kinshipTerm === "远亲"` | ✅ **合法断代没被误杀** |
| **对照**：丁→戊 `relative`（无 gap，库算不出） | `kinshipTerm` 与 `kinshipTerm(state.relations,...)` 同值 | ✅（实测「远亲」，ADR-0014 决策 5 老口径保留） |

⇒ 「不可达」与「断代/无解」两种「算不出」确实没被混用（决策 4 成立）。

### C4 · inactive 不被误杀（ADR-0020 决策 6）

| 夹具 | 断言 | 实测 |
|---|---|---|
| 合成：乙 `inactive`（手改 lifecycle），乙→player `father` | 乙仍上屏、`lifecycle.state === "inactive"`、行在、`kinshipTerm === "爸爸"` | ✅ |
| 真实模板：**伏黑惠**置 `inactive`（阵亡语义） | 伏黑惠→`enemy-toji`（`father`，敌人无实例）行**仍在**，称谓与 `kinshipTerm(state.relations,...)` 一致 | ✅ 实测「爸爸」 |

⇒ 「不在上屏集合内」这条错判据的第二个反例（inactive）也守住了（判据变异的补强见 §四）。

### C5 · 出生后边能回来（正向闭环）

**真实通关触达，非构造。** 我在探针里自写自动通关驱动（照 `AGENTS.md §0.3` 的最小验证集口径跑 `ev-ch*` 主线），推进到 `ev-np-01` 结算的 `spawnNpc`：

```
[C5] seed=1 turn=314 day=4737
     spawnLog=[{"npcId":"npc-yuta","ruleId":"rule-yuta-arrival","turnIndex":251,"worldTime":6292800}]
     未登场期投影抽查=9 次   spawnAt={"turn":251,"day":4370}
```

| 阶段 | 断言 | 实测 |
|---|---|---|
| 登场前（第 0/25/50…轮各抽查一次，共 9 次） | 投影不含 `npc-yuta`、不含「远亲」 | ✅ 9/9 |
| `spawnLog` | `npc-yuta` 恰好 1 条（幂等） | ✅ 1 |
| 登场后 | `npc-yuta` 上屏且 `lifecycle.state === "alive"` | ✅ |
| 登场后 | 五条悟面板**重新出现**指向乙骨的边（`kind: relative`, `direction: out`） | ✅ |
| 登场后 | 该行 `kinshipTerm === "远亲"`（`gap: true` 的合法断代） | ✅ |

⇒ 正向闭环成立：**同一个「远亲」在登场前被剔除、登场后回来**。这正是「只改投影期」的正确定义。

### C7 · 30 种子扫描

种子 1..30，各自建世界 → 投影：

```
[C7] 30 种子全部干净；unspawned 集合=npc-yuta
```

- 30/30 不含 `npc-yuta`；30/30 不含「远亲」；unspawned 集合恒为 `["npc-yuta"]`。

---

## 四、判据变异验证（本次最重要的护栏有效性证明）

做法：**临时改坏 `packages/game-core/src/v2/projection.ts`**，跑真实测试，看是否变红；跑完 `git checkout` 还原并核对文件 hash。
还原凭据：改动前 `git hash-object packages/game-core/src/v2/projection.ts` = `c983b81f856ba5833a2fb0534d45e7ee067f6b46`，还原后**同一 hash**，`git status --short` 为空。

### 变异 M1 · 把判据换成「不在上屏 NPC 集合内」（`player` 硬保留）

```diff
-  const observableRelations = projectVisibleRelations(state.relations).filter(
-    (e) => !hiddenNodeIds.has(e.from) && !hiddenNodeIds.has(e.to),
-  );
+  const projectedNpcIds = new Set(state.npcs.filter((n) => n.lifecycle.state !== "unspawned").map((n) => n.id));
+  const observableRelations = projectVisibleRelations(state.relations).filter(
+    (e) => (e.from === "player" || projectedNpcIds.has(e.from)) && (e.to === "player" || projectedNpcIds.has(e.to)),
+  );
```

**结果：真红（2 例）。** 具体用例名与失败信息：

| 文件:行 | 用例 | 失败信息 |
|---|---|---|
| `packages/game-core/src/v2/relation-projection.test.ts:61` | `R2.6-T-B5 投影 · 关系可见性（R-OP-05） > 只投影 known / inferred 边，unknown 与 hidden 不出现` | `expected [ 'player' ] to deeply equal [ 'enemy-x', 'player' ]` |
| `packages/game-core/src/v2/relation-projection.test.ts:160` | `ADR-0022 补记 D-1 · 关系投影剔除未登场端点 > player 与敌人端点必须保留（判据是「确知未登场」，不是「不在上屏集合内」）` | `expected [ 'player' ] to deeply equal [ 'enemy-x', 'player' ]` |

**外加我的探针也红 1 例**（独立见证，非复读实现方断言）：

| 用例 | 失败信息 |
|---|---|
| `C4 inactive 保留边与称谓 > 真实模板：伏黑惠转 inactive（阵亡语义）后，对甚尔的父亲边与称谓仍在` | `伏黑惠 → enemy-toji(father) 必须保留（敌人无实例也不得被误杀）: expected undefined to be defined` |

**同时必须说清的一件事（诚实记录）**：M1 下我的 **C1 / C3 / C5 / C6 / C7 全部仍然绿**，`v2.test.ts` 39 例也**全绿**。
⇒ 「缺陷 1 修好了」（C1）**并不能**证明判据选对；能证明判据选对的只有 `enemy-*` 那条公开信息边。
这正是 ADR-0022 补记 D-1 决策 1 的否证理由，也是本轮必须做变异验证的原因。

`inactive` 反例在 M1 下**不红**（inactive 实例仍在「上屏集合」内）——即 ADR 列的两个反例里，**只有「敌人永不实例化」这一条真正能区分该错判据**。此细节记入 §八观察 2。

### 变异 M3 · 回退到修复前行为（不过滤 unspawned 端点）

```diff
-  const observableRelations = projectVisibleRelations(state.relations).filter(
-    (e) => !hiddenNodeIds.has(e.from) && !hiddenNodeIds.has(e.to),
-  );
+  const observableRelations = projectVisibleRelations(state.relations);
```

**结果：真红（仓库内 4 例 + 我的探针 4 例）** ⇒ 新增/反改的测试**不是空转**。

| 文件 | 用例 |
|---|---|
| `v2/relation-projection.test.ts` | `未登场端点：已上屏 NPC 与 unspawned 之间的边不进前者的 relations`（`expected [ Array(2) ] to deeply equal []`） |
| `v2/relation-projection.test.ts` | `称谓不跨未登场节点：既不出行，也不得用「远亲」兜底（决策 4）`（`expected [ 'npc-hidden', 'player' ] to deeply equal [ 'player' ]`） |
| `v2/relation-projection.test.ts` | `player 与敌人端点必须保留（判据是「确知未登场」，不是「不在上屏集合内」）`（`expected [ 'enemy-x', 'npc-hidden', 'player' ] ...`） |
| `v2.test.ts` | `V2 引擎 · R2.6 关系图谱模板接入 > 投影只含可见边且带称谓字段（不含 unknown/hidden）`（`:1000` 反改断言 `expected true to be false`） |
| QA 探针 | `C1`（`expected '{"worldId":"qa-7",…' not to contain 'npc-yuta'`）、`C3`、`C5`（`t0 未登场期仍泄漏 npc-yuta`）、`C7`（`seed 1 投影含 npc-yuta`） |

⇒ 双向都成立：**改错判据会红，不改也会红**。护栏有效，非空转。

---

## 五、缺陷 2（面板看不到「NPC 视你为 X」）证据

### C6 · 六条边、方向、可见性、无 `value`

`state` 层（模板事实）：

| from | to | kind | visibility | value |
|---|---|---|---|---|
| npc-yaga | player | disciple | known | 无 |
| npc-gojo | player | disciple | known | 无 |
| npc-nanami | player | colleague | known | 无 |
| npc-shoko | player | colleague | known | 无 |
| npc-geto | player | friend | known | 无 |
| npc-haibara | player | friend | known | 无 |

- 6/6 存在；`kind` 分布 = **disciple×2 / colleague×2 / friend×2** ✅
- 全部 `visibility === "known"` ✅；全部 `value === undefined` ✅
- **方向未写反**：`state.relations.filter(e => e.from === "player")` 为 `[]` ⇒ 只存在「NPC → 你」，不存在反向边 ✅

投影层：6 行分别落在 6 个 NPC 自己的 `relations` 里，且**每行 `direction === "out"`**（`to` 是 `from` 的 kind ⇒ out 行读作「本体的 withId 是它的 kind」）✅
`kinshipTerm`：全部无（社会边不参与称谓推导，符合 `isKinshipKind` 口径）✅

### 前端能被现有分支消费（静态核对，非截图）

| 核对点 | 位置 | 实测 |
|---|---|---|
| `nameOf` 把 `player` 渲染成「你」 | `apps/web/src/main.tsx:2124` | 源码含 `id === "player" ? "你"` ✅ |
| `RELATION_KIND_LABEL` 含 disciple / colleague / friend | `main.tsx:2059` 起 | 三个键都在（弟子/同僚/朋友）✅ |
| 句子模板 | `main.tsx:2173-2175` | 含 `视${other}为${kindLabel}` ✅（out ⇒ `${npc.name}视${other}为${kindLabel}`） |

用真实标签表拼一次句子（探针实测输出）：

```
[C6] 夜蛾正道视你为弟子 / 七海建人视你为同僚 / 灰原雄视你为朋友
```

⇒ 面板句与用户诉求「夜蛾正道视你为弟子」逐字一致，方向语义正确。

### 副作用核对（`value` 省略是硬要求，验一下没被破坏）

卡片同时有 `relationship` 标量 chip（`main.tsx:2147-2155`）与关系句子；6 条边都无 `value` ⇒ 不会同卡出现两个互相矛盾的关系值。✅
提交说明提到「模板 4 处 `{relation: npc-x, gte: N}` 条件走标量形态」——不写 `value` 才不改既有分支；全量 465 例绿已间接验证（含 `relation-effects` / `v2.test.ts` 条件用例）。✅

---

## 六、专项检查

| 检查项 | 结果 | 证据 |
|---|---|---|
| 确定性可重现 | **PASS** | 探针：同 seed 建世界两次投影逐字节相同（seed 1/2/3）；两个独立世界按同一动作序列推进 40 轮后 `turnIndex/worldTime/relations/投影 JSON` 全部逐字节相同（`[DET] turn=40 worldTime=57600 relations=24`）；`replay.test.ts` 9 例绿 |
| DEFERRED（`R-TT-01..07`）未混入范围 | **PASS** | `git diff 9a8ed49..ee267f5 \| grep -E "R-TT-\|R-LC-"` → 空；改动只涉关系投影 + 模板边 |
| RETIRED（`R-LC-01..06`）未混入范围 | **PASS** | 同上 |
| V1 残留符号（`evaluateLife*` / `advanceTurn(` 引擎 / `PhaseTransitionLog` / `lifecycle.ts`） | **PASS** | 全仓扫描仅命中 `boundary.test.ts` 的**负向护栏**断言；`apps/web` 的 `api.advanceTurn` 是 V2 HTTP 客户端方法名，非 V1 引擎符号。`boundary.test.ts` 5 例绿 |
| 未引入 Lifecycle 状态机 / `Phase` | **PASS** | 本轮 diff 只读 `npc.lifecycle.state`（既有字段），未新增状态机；无 `lifecycle.ts`、无 `Phase` 类型 |
| `hidden` 未进入玩家端 API | **PASS** | 投影仍只下发 `known/inferred` 边（`projectVisibleRelations` 未改）；`v2.test.ts` 的 `JSON.stringify(view)).not.toContain("hidden")` 绿；探针 C1 结构扫描无未登场端点、无「远亲」 |
| LLM 不是唯一状态裁判 | **PASS（N/A）** | 本轮不涉 LLM 路径 |
| `visibleRelations` 残留符号 | **PASS** | 旧局部变量已消失；命中项只剩库函数 `projectVisibleRelations`（合法：`relations.ts:270` 定义、`relations.test.ts` 使用） |
| 新增行是否引入 `any` / 吞异常 / `Date.now` / `Math.random` | **PASS** | `git diff -U0 \| grep "^+" \| grep -E ": any\|as any\|catch\|Date\.now\|Math\.random\|randomUUID"` → **空** |
| `state.relations` 是否被写入 | **PASS** | diff 内 `state.relations` 仅出现为**读取**（`projectVisibleRelations(state.relations)`）与**测试断言**，无任何赋值 |
| 模板改动是否声明存档代价（`AGENTS.md §0.3` 第 2 条） | **PASS** | `e8bdb60` / `ee267f5` 提交信息均含「⚠ 模板指纹变化 ⇒ `data/worlds/` 旧档全部拒载（ADR-0007 既定策略）」 |

---

## 七、完成定义（DoD）逐条核验

DoD 来源：`docs/DECISIONS.md` → ADR-0022 补记 D-1 的「**验证（实施验收口径）**」段落 + 本轮派单的 8 条必须独立证明项。

| # | 完成定义条目 | 结果 | 证据 |
|---|---|---|---|
| D1 | `pnpm typecheck` 0 错 | **PASS** | §一 口径 1，`EXIT=0` |
| D2 | `relation-projection.test.ts` 新增「未登场端点剔除 / 称谓不跨未登场节点 / player 与敌人端点保留」三例 | **PASS** | 文件用例 8 → **11**（全量运行显示 `(11 tests)`）；三例均绿且 M3 下变红 |
| D3 | `v2.test.ts:981-991` 反改后转绿 | **PASS** | 反改断言（`gojo.relations.some(r => r.withId === "npc-yuta") === false`、`JSON.stringify(view)).not.toContain("npc-yuta")`、`state.relations` 仍含该边）绿；M3 下该用例变红 ⇒ 反改有效、非空转 |
| D4 | `playthrough.test.ts` 6 种子不受影响 | **PASS** | 全量运行 2 例绿（25.6s + 25.6s）；6 种子结局全部落在模板声明集合内，章节 ≥8 |
| D5 | 判据 = 「有 NPC 实例且 `lifecycle.state === "unspawned"`」，任一端命中即剔除 | **PASS** | 代码读证 + **M1 变异真红**（§四）；player 硬保留（探针 C6 六行都在） |
| D6 | `kinshipTerm` 入参 = 过滤后的同一份边集，不得回退整张图 | **PASS** | 探针 C3（无行无「远亲」/ 合法 gap 仍出「远亲」）+ M3 下 C3 红 |
| D7 | 禁止用「远亲」兜底「路径经未登场节点」；禁止生成「未知的某人」占位行 | **PASS** | 探针 C3：snapshot 不含「远亲」、不含 `npc-c`；C1：`npc-yuta`/「乙骨」均不出现 |
| D8 | 过滤只发生在投影期，不写 `state.relations`、不升 `schemaVersion`、shared 零改动 | **PASS** | §二 + §六（`state.relations` 无赋值、`SCHEMA_VERSION = 2` 未变、shared diff 空） |
| D9 | `inactive` 保留边与称谓 | **PASS** | 探针 C4 两例（合成 + 真实伏黑惠） |
| D10 | 出生后边回来（正向闭环） | **PASS** | 探针 C5（真实通关 seed 1 / 第 251 轮触达 `spawnNpc`） |
| D11 | 模板：6 条 `to: player` 边，known、无 value、方向正确 | **PASS** | 探针 C6（state + 投影双层） |
| D12 | 30 种子无泄漏 | **PASS** | 探针 C7，30/30 |

**无 FAIL 项。**

---

## 八、缺陷清单

### P0 / P1

**无。**

### 观察项（不阻断，建议去向已标注）

| # | 观察 | 影响 | 建议去向 |
|---|---|---|---|
| O1 | 模板内容变更 ⇒ `data/worlds/` 下 **57 个既有本地存档全部拒载**（49 指纹不匹配 + 8 schema v1） | 玩家侧表现为「旧局打不开、只能新开」。这是 ADR-0007 既定策略，非缺陷；三个提交信息已声明 | **发布说明**（用户可感知）｜技术侧无需动作 |
| O2 | **判据变异 M1 下 `v2.test.ts` 39 例全绿、我的 C1/C3/C5/C6/C7 也全绿**；唯一红灯在 `relation-projection.test.ts:61` 与 `:160`（`enemy-*` 公开信息边）。另：ADR 列的第二个反例 `inactive` 在 M1 下**不红**（inactive 实例仍在上屏集合内），只有「敌人永不实例化」真正能区分该错判据。**归因澄清（勿误读）**：我的 `C4` 是两例——合成夹具那例（乙 `inactive` → 视玩家为「爸爸」）在 M1 下**绿**；真实模板那例（伏黑惠 `inactive` → `enemy-toji`）在 M1 下**红**，但红灯原因是 `enemy-toji` 无实例（见 §四 M1 表第 3 行），与 `inactive` 无关，它只是「敌人端点被误杀」的第二个见证 | 后续若有人把判据改回「不在上屏集合内」，模板级断言锁不住；`inactive` 用例防的是**另一类**错判据（按 `lifecycle.state === "alive"` 白名单过滤），不应被误读成能防「集合成员」这类 | **`docs/BACKLOG.md`**：建议把「判据反例」做成 table-driven 用例（enemy / inactive / player 三条各绑一条断言）并在注释里点明各自区分哪种错法；**不必本轮做** |
| O3 | 6 条 `to: player` 边全部无 `value` ⇒ 前端 `rel-value` 不渲染，面板只有句子 + `relationship` 标量 chip | 设计如此（提交说明与 yaml 文件头都写明理由：避免同卡两个关系值矛盾、不改变既有标量条件分支） | 无需动作；若后续要做「NPC 对你的好感分」，需另立需求（会与标量 chip 冲突，要一并裁决） |

---

## 九、未覆盖项与风险

1. **未做 UI 真点击/截图**（派单明确「不必截图」）。已用数据形态 + `main.tsx` 的三个消费分支静态核对替代。**风险**：若折叠面板（`<details>`）或 CSS 出现回归，本报告不覆盖。归属：前端验收另立。
2. **30 种子扫描只覆盖建世界期（未登场期）**。中局 30 种子未扫（成本考虑）。已用 seed 1 全程通关 + 每 25 轮抽查（9 次）补强；`spawnLog` 出现前后各至少一次观测。
3. **只有 jjk-2006 一个模板**可用于真实模板回归；判据本身是引擎级（`projection.ts`），合成夹具已覆盖 unspawned / inactive / enemy / player 四类端点组合。
4. **变异验证是破坏性操作**：我在 `d36a792` 的 `projection.ts` 上做过 2 次临时改动，均已 `git checkout` 还原并核对 hash（`c983b81…`），`git status --short` 为空；还原后重跑全量 465 例绿，结论不受影响。
5. 沙箱环境坑（沿用既有报告口径）：`pnpm --filter @life-sim/game-core test`（裸 `vitest run`）在本沙箱有并行收集挂死史，本报告一律用 `--no-file-parallelism`；`pnpm --filter @life-sim/shared test` 与 `pnpm typecheck` 正常。

---

## 十、结论

**可验收（PASS）。** 两个用户报的缺陷都已按 ADR-0022 补记 D-1 的口径修好，且修复**可被独立证伪**（改错判据 → 红；回退旧实现 → 红）。放行下一阶段由主理人决定；本报告不代作放行。

（探针与运行命令见文首；报告文件：`tasks/reports/RELATION-PROJECTION-FIX-ACCEPTANCE.md`）
