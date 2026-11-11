# 迭代 R2.3 设计（Design）

**版本：2026-11-11（R2.3 立项）｜上游：`README.md`、`requirements.md`｜下游：`tasks.md`**

本文件回答「怎么做、边界在哪、哪里会冲突」。所有 `file:line` 基于 **2026-11-11 13:40 的 HEAD**；实施前若漂移，先报告再动手。

------------------------------------------------------------------------

## 1. 现状盘点（本轮四项的事实基础）

### 1.1 可见性

| 事实 | 位置 |
|---|---|
| `HistoryEntryV2` 无可见性字段（`id / turnIndex / worldTime / formattedTime / type / summary / detail?`） | `packages/shared/src/v2.ts:146-155` |
| 回合结果里 `playerVisibleHistory: state.history.slice(-20)` —— 取末 20 条，**不过滤** | `packages/game-core/src/v2/turn.ts:584` |
| `GET /api/worlds/:id/history` 直接 `return { history: world.history }` —— **全量** | `apps/server/src/index.ts:257-262` |
| 前端「日志」Tab 调该接口并逐条渲染 `summary` | `apps/web/src/main.tsx:1122-1141` |
| 归档记录 `history: archived.history.map(...)` —— **全量**，随 `POST /archive` 返回 | `packages/game-core/src/v2/archive.ts` |
| 历史写入点共 **7 处**：`battle.ts:616`（battle）、`ending.ts:368`（event）、`npc.ts:63`（npc_action）、`turn.ts:220`/`653`（event）、`turn.ts:532`/`785`（player_action） | 见左 |
| `EventV2Schema` **没有** `visibility` 字段 | `packages/shared/src/schema/event.ts`（grep 无命中） |
| `EndingTemplateSchema.visibility` 已存在，默认 `public` | `packages/shared/src/schema/ending.ts:124` |
| `NpcAction` 无可见性字段 | `packages/shared/src/schema/character.ts`（行为段） |

**结论**：今天的泄漏源是**事件**与**结局**——两者都有"不该让玩家看到"的语义（`hidden` 结局已有掩码），却没有一条进入历史的记录带可见性，而历史接口是全量的。`npc_action` 的 `summary` 由模板撰写、内容是"可见行为"（NPC 秘密在 `def.secrets`，不进 summary），本轮判定其属于公开世界动态，**不分级**（登记 `OPEN_QUESTIONS` #32）。

### 1.2 持久化

| 事实 | 位置 |
|---|---|
| `const worlds = new Map<string, WorldStateV2>()`，注释「内存仓储：P0 阶段不持久化，重启即清空」 | `apps/server/src/store.ts:13` |
| 前端已把 `worldId` 存 `localStorage`，启动即尝试续玩 | `apps/web/src/main.tsx:1146` 起 |
| 服务端**没有** `WorldStateV2` 的 Zod schema（只有 TS 类型） | `packages/shared/src/` 全局 grep 无命中 |
| `worldStore.save()` 已带归档门禁；`seal()` 是其唯一例外通道 | `apps/server/src/store.ts` |

**结论**：续玩逻辑在前端已存在，缺的是服务端持久层与"世界列表"。落盘还必须解决"加载时如何校验"——目前没有可用的状态 schema，这是本轮最大的一块工作量。

### 1.3 时间跨度

| 事实 | 位置 |
|---|---|
| 每轮时长 = 行动 `duration`（2–8 小时），无行动时用阶段步长 | `v2/turn.ts:519`、`time.ts:98-102` |
| 阶段步长：childhood 1 天 / youth 4 小时 / adulthood 6 小时 / elderhood 1 天 | `specs/data/templates/jjk-2006/world.yaml:11-16` |
| 16 → 60 岁 ≈ 44 年 ≈ **6.4 万轮**（按 6 小时/轮），寿终条件为 44 年 | `endings.yaml`、`world.yaml` |
| `mode?: "single" \| "fast"` 已声明，**全仓无读取点** | `v2/turn.ts:492` |
| 轮次管线有 10 个固定步骤（行动效果 → 链 → 时间触发 → 行动触发 → 回复 → 状态结算 → 年龄 → NPC 行动 → 事件池 → 终止边界） | `v2/turn.ts:527-570` |
| RNG 按 `deriveTurnSeed(seed, turnIndex)` 派生 | `rng.ts:19-24` |

**结论**：不能让"一次点击 = 一小时"承载 44 年。必须在**时间维度上分两层**，而不是把步长调大。

### 1.4 装备穿脱

| 事实 | 位置 |
|---|---|
| `equipItem(input, itemId, lookup)` / `unequipItem(input, instanceId, lookup)` 纯函数，返回新数组 + 7 种错误码 | `v2/equipment.ts:92,122` |
| 输入只需 `{ equipment, inventory }`（`EquipmentOwnerInput`） | `v2/equipment.ts:73-78` |
| 服务端无端点；前端装备栏只读 | `apps/server/src/index.ts`（无 equipment 路由） |
| 背包投影字段：`itemId / name / description / count / usableOutsideBattle / usableInBattle` —— **缺 `type` / `slot`** | `packages/shared/src/v2.ts:303` |

**结论**：引擎侧齐备，缺的是"编排函数 + 端点 + 投影字段 + 交互"。必须走 `game-core` 编排，不能由 server 直接改状态。

------------------------------------------------------------------------

## 2. 可见性设计（`R-VS-01..05`）

### 2.1 判定原则

> **只有 `public` 进玩家端；`hidden` / `unknown` 一律不进；缺字段视为 `public`。**

最后一条是**兼容策略**，不是语义主张：R2.2 及以前的存档里没有该字段，若缺省当 `hidden`，升级瞬间所有玩家的日志会清空，且无法区分"老数据"与"新写的隐藏条目"。写入侧靠**类型强制**保证新数据一定带值（见 2.2），所以"缺省 = public"只影响老数据。

### 2.2 数据模型与写入侧

```ts
// packages/shared/src/v2.ts
export type HistoryVisibility = "public" | "hidden" | "unknown";

export interface HistoryEntryV2 {
  // ...既有的 id / turnIndex / worldTime / formattedTime / type / summary / detail?
  /** 可选是为了兼容 R2.2 及以前的存档；写入侧由函数签名强制提供 */
  visibility?: HistoryVisibility;
}

/** 唯一判定入口：读取侧不得各自写 `=== "public"` */
export function isPlayerVisible(entry: HistoryEntryV2): boolean {
  return (entry.visibility ?? "public") === "public";
}
```

`pushHistory()` 的签名改为**必填**：

```ts
function pushHistory(
  state: WorldStateV2,
  template: WorldTemplateV2,
  entry: Omit<HistoryEntryV2, "turnIndex" | "worldTime" | "formattedTime" | "visibility"> & {
    visibility: HistoryVisibility;
  },
): void
```

`npc.ts` 里那处直接 `state.history.push({...})` 不走 `pushHistory`，同样必须显式赋值。

**写入侧映射表（7 处，实施时逐处核对）**

| 位置 | `type` | `visibility` 取值 |
|---|---|---|
| `battle.ts:616` | `battle` | `"public"` |
| `ending.ts:368` | `event` | 结局 `visibility`（`hidden` → `"hidden"`） |
| `npc.ts:63` | `npc_action` | `"public"`（本轮不分级，见 2.6） |
| `turn.ts:220` | `event` | 事件定义 `visibility`（新增可选字段，缺省 `"public"`） |
| `turn.ts:532` | `player_action` | `"public"` |
| `turn.ts:653` | `event` | 事件定义 `visibility` |
| `turn.ts:785` | `player_action` | `"public"` |

**事件定义需新增可选字段**（`EventV2Schema` 目前没有）：

```ts
// packages/shared/src/schema/event.ts
visibility: z.enum(["public", "hidden"]).default("public"),
```

理由：`hidden` 事件今天会被写进历史并被玩家读到；没有这个字段就只能靠 `kind` 猜，不可维护。这是协议 §8 的**向后兼容扩展**（缺省 `public`，既有模板零改动），需在阶段 1 的协议修订里记一笔。

### 2.3 读取侧（三个出口，一个判定）

| 出口 | 现状 | 改法 |
|---|---|---|
| `V2TurnResult.playerVisibleHistory` | `slice(-20)` | `filter(isPlayerVisible).slice(-20)` —— **先过滤再截断**，否则 20 条里可能全是 hidden，玩家看到空列表 |
| `GET /api/worlds/:id/history` | 全量 | `world.history.filter(isPlayerVisible)` |
| `POST /api/worlds/:id/archive` 响应 | 全量 | `projectArchiveForPlayer()`（见 2.4） |

三个出口必须都走 `isPlayerVisible`，不允许各自写比较表达式——否则新增出口时会漏。建议在 `game-core` 导出 `playerVisibleHistory(state, limit)` 与 `playerVisibleEntries(entries)` 两个纯函数，server 只调函数。

### 2.4 归档口径（**需用户确认**）

`assembleArchive()` 产出的 `ArchiveRecord` 是**存档事实**，服务端必须保留全量（否则历史不可追溯、评价证据可能指不到条目）。但**下发给玩家端**的响应应当与投影一致：

```ts
export function projectArchiveForPlayer(record: ArchiveRecord): ArchiveRecord & { hiddenHistoryCount: number } {
  const visible = record.history.filter(isPlayerVisible);
  return { ...record, history: visible, hiddenHistoryCount: record.history.length - visible.length };
}
```

- **建议**：`POST /archive` 返回过滤后的记录 + 计数；完整记录只落盘。
- **替代方案**：归档响应也返回全量（视为"玩家自己的存档复盘"）。缺点是玩家刚封存就能读到本局从未揭示的秘密，等于给了一个"看答案"按钮，会让 `R-VS-02` 失去意义。
- 若用户选择替代方案，`R-VS-04` 需改口径；**本包默认采用建议方案**，并在 `OPEN_QUESTIONS` #32 登记待确认。

### 2.5 渗透测试（`R-VS-05`）

构造一局故意含 `hidden` 事件 + `hidden` 结局的世界，对四个出口做**递归扫描**：

```
遍历 JSON 的每个字符串值 → 命中 hidden 条目的 id / summary 片段 ⇒ 失败
```

放在 `history-visibility.test.ts`，作为常驻用例。这条测试的存在本身就是 `R-NFR-04` 的回归防线；阶段 8 延期后，它是唯一能挡住"新出口又漏"的东西。

### 2.6 已知取舍（诚实登记）

`npc_action` 本轮一律 `public`。这意味着"玩家不在场时 NPC 在做什么"仍对玩家可见。真正的解法需要**在场/距离模型**（`OPEN_QUESTIONS` #23/#25 的清理与关系网络议题），超出本轮。登记 #32。

------------------------------------------------------------------------

## 3. 持久化设计（`R-PS-01..07`）

### 3.1 选型（先落 ADR-0006）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **JSON 文件 + 原子写** | 零新增依赖（DoD 第 6 条）；可读、可手改、便于调试与回放取证 | 无事务、无索引；全量重写 | **采用** |
| `node:sqlite`（Node 22 内置） | 有事务、单文件 | 实验性 API（22.5+ 需 flag），跨 Node 版本不稳 | 不采用，记入 ADR 备选 |
| `better-sqlite3` / `pg` | 成熟 | **新增 npm 包，破 DoD 第 6 条** | 不采用 |
| 只存 seed + 命令日志，加载时回放 | 体积最小、天然可复现 | 模板一改就回放不一致；加载即重算，启动变慢 | 不采用，记入 ADR 备选 |

### 3.2 落盘格式

目录：`apps/server/.data/worlds/`（`WORLDS_DIR` 环境变量可覆盖；加进 `.gitignore`）。

单局一文件 `<worldId>.json`：

```jsonc
{
  "schemaVersion": 1,
  "savedAt": "2026-11-11T13:40:00.000Z",
  "templateId": "jjk-2006",
  "templateFingerprint": "sha256:…",   // 模板 YAML 全量指纹
  "state": { /* WorldStateV2 */ }
}
```

**模板指纹**：对模板目录内全部 YAML 文件按文件名排序后拼接 `name + "\0" + content`，`createHash("sha256")`。在 `templates.ts` 加载时顺手算出并缓存。

存在的理由：模板是权威语义的一部分。模板改了措辞/数值/技能表，旧存档照样能加载但语义已经漂移（例如某个技能被删、某条终止条件被改）。指纹不匹配时**拒绝加载**比"悄悄加载出一个行为诡异的存档"更安全。

### 3.3 写入（`R-PS-01` / `R-PS-05`）

在 `worldStore.save()` 与 `seal()` 内落盘（`save()` 已被所有写入口调用，不需要在 7 个路由里各加一次）：

```ts
function persist(state: WorldStateV2): void {
  const envelope = { schemaVersion: 1, savedAt: new Date().toISOString(), templateId: state.templateId, templateFingerprint: fingerprintOf(state.templateId), state };
  const tmp = path.join(storeDir, `${state.id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(envelope, null, 2), "utf-8");
  renameSync(tmp, path.join(storeDir, `${state.id}.json`));  // 同分区原子替换
}
```

- 失败时删除 `.tmp` 并把错误**抛给调用方**（不吞）；HTTP 层落到 `handleEngineError` → 500 带可读信息。
- Node 单线程同步写，同一进程内不会撕裂；写入体积按当前规模为 10² KB 量级。
- 归档世界：`seal()` 也落盘（`archived` 标记必须在文件里），但后续任何 `save()` 仍被既有门禁拒绝（`R-PS-06`）。

### 3.4 加载与校验（`R-PS-02` / `R-PS-03`）

启动顺序：`loadTemplates()` → 算指纹 → 扫目录 → 逐个 `loadOne()`。

`loadOne()` 的三道检查，任一不过就 `app.log.error({ file, reason })` 并跳过（**不阻断启动**）：

1. `JSON.parse` 成功；
2. `schemaVersion === 1`；
3. `templateFingerprint` 与当前模板一致；
4. `WorldStateV2Schema.safeParse(state).success`。

**必须新建 `WorldStateV2Schema`**（`packages/shared/src/v2-state.ts`）。这是本轮最大的一块工作，也是唯一"看起来能省但不该省"的地方：加载磁盘文件本质是**处理不可信输入**，`AGENTS.md` 要求对外输入一律 Zod 校验。

双维护风险与缓解：

- Zod schema 与 TS 接口会漂移。用双向断言把漂移变成**编译错误**：

```ts
// 只要两者不一致，下面两行就报错
const _forward: WorldStateV2 = {} as z.infer<typeof WorldStateV2Schema>;
const _backward: z.infer<typeof WorldStateV2Schema> = {} as WorldStateV2;
```

- 覆盖范围：`WorldStateV2` 全字段（`player` 含 `equipment`、`statuses`、`skills`、`inventory`；`npcs`；`flags`；`history`；`chains`；`pendingEvents`；`battle`；`termination`；`archived`；`seed`；`worldTime`；`turnIndex`）。
- 已知代价：约 200 行 schema + 一条一致性测试；换来的是坏档不会把非法状态塞进内核。

### 3.5 列表接口（`R-PS-04`）

```
GET /api/worlds  →  { worlds: Array<{ id, templateId, playerName, turnIndex, worldTime, formattedTime, status, endingTitle? }> }
```

- `status` 由 `archived` / `termination` 推导：`archived → "archived"`；`termination !== null → "terminated"`；否则 `"running"`。
- 排序：`savedAt` 倒序（最近玩的在前）。
- 空目录返回 `{ worlds: [] }`，不返回 404。

附带 `DELETE /api/worlds/:id`（删文件 + 删 Map 条目）：没有它，存档目录只增不减，几个月后列表会变成一片废墟。是否需要"删除前确认"由前端负责。

### 3.6 归档只读（`R-PS-06`）

不需要新逻辑：`save()` 的 `archived` 门禁已存在。本轮只需保证**加载后**的 `archived` 世界走同一条 `save()` 路径（而不是被 `loadOne` 绕过）。验收要覆盖 5 个写入口全部 409。

### 3.7 往返一致性（`R-PS-07`）

同一 seed 两局，一局每轮 `save → 重新加载`，另一局常驻内存，各推进 10 轮后逐字段比对。这条测试守两件事：落盘不丢失字段（尤其 `flags` / `chains` / `firedEvents`）、加载不悄悄补默认值。

### 3.8 前端口径

- 首屏从"只有新建"变成"新建 + 我的世界"两段；列表项显示模板名、玩家名、第 N 轮、状态徽标。
- `localStorage` 里的 `worldId`：POST 不存在时不再直接报错，而是提示「这一局已不存在（可能已被删除）」并回到列表。
- 归档世界在列表里可见但只读（点进去看结局面板）。

------------------------------------------------------------------------

## 4. 时间跨度设计（`R-TS-01..05`）

### 4.1 核心判断

把步长调大（4 小时 → 1 个月）是**错的**：一次点击跨半月，事件密度会崩，叙事变成流水账。正确做法是把**时间分辨率分成两层**：

| 层 | 粒度 | 用途 | 结算内容 |
|---|---|---|---|
| **日常轮**（现状不变） | 2–8 小时 | 具体行动、遭遇、战斗、事件选择 | 完整 10 步管线 |
| **跨度轮**（新增） | 1 天～1 年 | 「接下来这一年我专心修行」 | 分片推进 + 事件限流，跳过逐时 NPC 效用与逐时状态衰减 |

两层共用同一条管线与同一套 RNG 派生，只是**分片内部允许省略**。

### 4.2 模板配置与命令

```yaml
# world.yaml
time:
  spanSteps:
    enabled: true
    slice: { value: 1, unit: day }       # 分片粒度
    maxSpan: { value: 1, unit: year }    # 单次跨度上限
    maxEventsPerSpan: 3                  # 每跨度事件上限（含池事件）
    npcActionsPerSpan: 2                 # 每跨度 NPC 行动抽样次数
```

命令（复用既有死参数 `mode`，不新增字段）：

```jsonc
{ "action": { "type": "train", "description": "闭关" }, "mode": "fast", "span": { "value": 1, "unit": "year" } }
```

- 未声明 `spanSteps` 的模板收到 `mode: "fast"` → 400 `span_not_supported`。
- `span > maxSpan` → 400 `span_exceeds_max`（不静默截断，避免玩家以为推了 10 年其实 1 年）。

### 4.3 分片结算（`R-TS-02`）

```
elapsed = span
sliceCount = ceil(span / slice)
per-slice:
  worldTime += slice
  turnIndex += 1                     // 关键：轮次照常递增，冷却/链/上限按真实时间推进
  resolveScheduleV2()                // 时间触发
  resolvePoolV2()                    // 事件池，受 maxEventsPerSpan 约束
  advanceChainOnSettle()             // 链推进
skip per-slice:
  npcAutonomous()                    // 改为每 ceil(sliceCount / npcActionsPerSpan) 片跑一次
  tickSimulationStatuses()           // 改为跨度末按总时长一次结算
after-span:
  回复、年龄重算、终止边界（R-EN-02）
```

三点必须写死：

1. **`turnIndex` 在跨度内递增 N**，不是 +1。否则事件冷却（按轮计）、`firedEvents` 时间戳、`history.turnIndex` 全部错位。
2. **事件限流优先于概率**：达到 `maxEventsPerSpan` 后，剩余分片只推进时间，不再抽事件。
3. **状态衰减一次算**：按总时长套用现有规则，而不是逐片累加（逐片累加会让 1 年跨度把玩家状态打到地板）。若某状态定义依赖"每轮"语义，按其 `duration.turns` 与总轮数换算。

### 4.4 终止边界（`R-TS-03`）

只在跨度**结束后**判定一次，沿用 `applyEndingBoundary(state, lookup, rng, pipeline, { atBoundary: true, boundary: "afterTimeAdvance" })`。

理由：`R-EN-02` 要求"结算完成后判定"。若在分片中途判定，会出现"跨度推到一半终止，但玩家看到的是完整跨度摘要"的半更新态。

### 4.5 确定性（`R-TS-04`）

因为 `turnIndex` 逐片递增，`deriveTurnSeed(seed, turnIndex)` 天然给出每片独立的确定性序列，不需要新的派生函数。禁止在跨度里用 `Math.random`、禁止复用同一 rng 跨片（会导致"改一个参数全盘重排"）。

### 4.6 可玩性目标（`R-TS-05`）

44 年 ÷ 1 年/跨度 = 44 次「投入一年」，即使每跨度 3 个事件，一生也有 100+ 个事件节点。验收用脚本跑到底并**记录实际轮次作为基线**（预计 40–120 轮），门槛设 800 轮留足余量。

### 4.7 已知影响与风险

| 风险 | 说明 | 处理 |
|---|---|---|
| 既有测试假设"一次推进 = 1 轮" | 有测试断言 `turnIndex + 1` | 跨度路径单独断言 `+N`；单步路径保持 `+1`，不改既有断言 |
| 前端"第 N 轮"会跳变 | 跨度后从第 5 轮变第 370 轮 | 响应里给 `elapsed` 与 `advancedTurns`，前端显示「推进了 1 年（365 个时间片）」 |
| NPC 变"静" | 跨度内只抽样 2 次 | 模板可调 `npcActionsPerSpan`；默认值由内容侧定 |
| 战斗与跨度冲突 | 跨度内触发的 combat 事件无法逐回合交互 | 跨度内**不触发 combat 事件**（跳过并延后到下一个日常轮），否则会卡在"无主的战斗" |

------------------------------------------------------------------------

## 5. 装备穿脱设计（`R-EQ-07..10`）

### 5.1 编排层（必须放在 `game-core`）

新增 `v2/equipment-turn.ts`：

```ts
export function equipV2(state, command: { itemId: string }, template, lookup): V2TurnResult
export function unequipV2(state, command: { instanceId: string }, template, lookup): V2TurnResult
```

职责，与其它四个行动入口**同构**：

1. `assertActive(state)` 门禁（已终止/已归档 → 抛错，server 映射 409）；
2. 调 `equipItem` / `unequipItem`（纯函数，不修改入参）；
3. 失败 → 抛 `[equip] <code>` / `[unequip] <code>`，**不写状态**；
4. 成功 → 写回 `state.player.equipment`，`pushHistory({ type: "player_action", visibility: "public", summary })`；
5. **不推进 `worldTime`、不递增 `turnIndex`**（`R-EQ-08`）；
6. `projectSnapshotV2()` 返回。

`pushHistory` 目前在 `turn.ts` 内部（非导出）→ 需提取为模块级工具，供 `equipment-turn.ts` 复用，避免复制粘贴。

### 5.2 端点与错误码映射（`R-EQ-07`）

| 路由 | body | 状态码 |
|---|---|---|
| `POST /api/worlds/:id/equipment/equip` | `{ itemId }` | 200 / 400 / 404 / 409 |
| `POST /api/worlds/:id/equipment/unequip` | `{ instanceId }` | 同上 |

| 引擎错误码 | HTTP | 语义 |
|---|---|---|
| `slot_full` | 409 | 槽位已满，可换不可加 |
| `slot_category_mismatch` | 409 | 品类不符（刀不能戴在饰品槽） |
| `slot_not_found` | 400 | 模板未声明该槽位 |
| `item_not_equipment` | 400 | 物品不是装备 |
| `not_owned` | 400 | 背包没有该物品 |
| `instance_not_found` | 400 | 要卸下的实例不存在 |
| `item_not_found` | 400 | 物品定义不存在 |

409 用于"状态冲突但请求合法"，400 用于"请求本身不对"——沿用 `handleEngineError` 的既有分类习惯。

### 5.3 投影与前端（`R-EQ-09` / `R-EQ-10`）

背包投影补三个**展示字段**（来自 `lookup.item()`，不含任何补正结果）：

```ts
inventory: Array<{ itemId, name, description, count, usableOutsideBattle, usableInBattle,
  type: "consumable" | "material" | "key" | "equipment",
  slot?: string, category?: string }>
```

前端：
- 背包里 `type === "equipment"` 的条目不显示「使用」，改显示「装备」；
- 装备栏每条给「卸下」；
- 两者都调对应端点，成功后用返回的 `snapshot` 直接替换（与其它行动一致）。

### 5.4 约束

- `EquipmentInstance` 仍**不得**含任何补正结果字段（R2.2 的 `R-EQ-04`）；
- 穿脱不带时间推进，所以不需要终止边界判定（但 `assertActive` 仍要）；
- 不新增 `EquipmentDefinition` 字段，不改 `evaluateDynamicModifier`。

------------------------------------------------------------------------

## 6. 正确性属性（延续 `design.md §11` 的 P1–P9）

| 属性 | 内容 | 本轮如何被覆盖 |
|---|---|---|
| P1 | 同 seed 同输入 ⇒ 同结果 | `R-TS-04`、`R-PS-07` |
| P2 | 终止后拒绝一切行动 | `R-PS-06` + 新增两个穿脱入口 |
| P3 | 归档只读 | `R-PS-06` |
| P5 | 事件/链顺序稳定 | 跨度内 `turnIndex` 递增保证冷却与排序语义不变 |
| P6 | 模板不可变 | 跨度参数、事件可见性全部来自模板 |
| P7 | `hidden` 不进投影 | `R-VS-02`、`R-VS-05` |
| P8 | 装备补正不写回基础属性 | `R-EQ-10` |
| P9 | HP 不作为死亡判据 | 不受本轮影响；跨度只在边界判定，不读 HP |

**新增属性**

- **A1**：任意状态下 `history.filter(isPlayerVisible).length === 玩家端可见条数`（三个出口一致）。
- **A2**：存档往返后 `JSON.stringify(state)` 与往返前相等（同进程内的严格等价）。
- **A3**：跨度推进 N 个时间片后 `turnIndex` 增加 N，且 `worldTime` 增加 `span`。
- **A4**：穿脱请求前后 `player.attributes` 逐字段相等。

------------------------------------------------------------------------

## 7. 冲突对齐与未决项

### 7.1 与既有规格的关系

| 既有约束 | 本轮如何遵守 |
|---|---|
| `R-EN-02`「只在结算边界判定终止」 | 跨度只在结束后判定（§4.4） |
| `R-EQ-04`「补正不写回、实例不含补正结果」 | 穿脱不碰补正（§5.4） |
| `R-AR-03`「首版沿用现有存档机制」 | 本轮把它从"内存"补成"落盘"，不新增独立存档子系统 |
| ADR-0002「不开放自由表达式 DSL」 | 跨度参数只有固定枚举与时间量，无表达式 |
| 禁新增 npm 包 | JSON 落盘，零依赖（§3.1） |
| 不引入 Lifecycle 状态机 | 全局状态仍由 `openingCompleted / termination / archived` 三标记表达 |

### 7.2 需登记 `OPEN_QUESTIONS`

| # | 内容 | 本包建议 |
|---|---|---|
| #32 | 归档记录是否向玩家端暴露 hidden 历史 | 不暴露，只给计数（§2.4） |
| #33 | `npc_action` 是否按"玩家在场"分级 | 本轮一律 public；需要先有在场/距离模型 |

### 7.3 已知缺口（不在本轮）

- 跨模板验证（阶段 8）延期 → `R-NFR-06` 仍无证据；
- LLM 叙事未接 → `narrativeSource` 恒为 `template`；
- 存档为单机单文件 → 多设备需 #1/#2 的账号体系；
- `#28`、`#31` 未动。

------------------------------------------------------------------------

## 8. 需 ADR 清单（实施前必写）

| ADR | 主题 | 必须写清的内容 |
|---|---|---|
| **ADR-0006** | 存档持久化：选型与落盘格式 | 为什么不用 DB/新增依赖；信封结构与 `schemaVersion`；模板指纹的作用与代价；加载失败策略（拒绝 vs 修复）；`WorldStateV2Schema` 双维护的缓解；与 `R-AR-03` 的关系 |
| **ADR-0007** | 时间跨度：双层时间分辨率 | 为什么不是"调大步长"；跨度内 `turnIndex` 递增语义；事件限流与 NPC 抽样；状态衰减一次结算的近似口径；combat 事件在跨度内延后的理由；对 R-EN-02 边界判定的影响 |

两个 ADR 的编号依据：ADR-0005 已被时间穿越预留（R3），不得占用。

------------------------------------------------------------------------

## 9. 文件归属（避免并行写冲突）

| 目录/文件 | 本轮责任 |
|---|---|
| `packages/shared/src/v2.ts` | `HistoryVisibility`、`HistoryEntryV2.visibility`、`isPlayerVisible`、背包投影字段 |
| `packages/shared/src/v2-state.ts`（新） | `WorldStateV2Schema` |
| `packages/shared/src/schema/event.ts` | 事件 `visibility`（可选，缺省 public） |
| `packages/shared/src/schema/world.ts` | `time.spanSteps` 配置段与校验 |
| `packages/game-core/src/v2/turn.ts` | `pushHistory` 提取导出；跨度分支；历史过滤 |
| `packages/game-core/src/v2/equipment-turn.ts`（新） | `equipV2` / `unequipV2` |
| `packages/game-core/src/v2/archive.ts` | `projectArchiveForPlayer` |
| `packages/game-core/src/v2/history.ts`（新） | `playerVisibleHistory` / `playerVisibleEntries` / `isPlayerVisible` 的引擎侧封装 |
| `apps/server/src/store.ts` | 落盘、加载、列表、删除 |
| `apps/server/src/templates.ts` | 模板指纹 |
| `apps/server/src/index.ts` | `/api/worlds`、`/equipment/*`、历史过滤接线 |
| `apps/web/src/*` | 世界列表、跨度入口、装备交互、日志过滤（前端不再依赖后端误给的数据） |

**同一时刻仍只允许一个 Agent 写 `packages/`**（`AGENTS.md` G4）。
