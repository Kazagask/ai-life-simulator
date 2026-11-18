# 设计：随机开局 / 前实例化

## 1. 现状（代码事实，非推测）

- `createWorldV2`（`game-core/v2/turn.ts:98`）：`player.name = input.playerName`、
  性别/年龄取 `playerTemplate`，`selfId = PLAYER_NODE_ID`（`"player"`），NPC/关系/时间锚一次就位。
- `state.selfId` 已存在但可选（`shared/v2.ts:344`），缺省回落 `"player"`；`selfIdOf(state)`
  已实现（`game-core/v2/actors.ts:39`），`actorOf` 先查实例再查玩家——**切存储的兼容点已备好**。
- 投影末尾用 `state.player` 覆盖 self 那条演员条目（`projection.ts:419-434`）；
  战斗读 `state.player.attributes/hp/mp`（`battle.ts:44-56`）。这两处是 self 切换要改的写死点。
- `runOpening`（`opening.ts:137-220`）只跑 setup / npcSetup / eventPools / handoff；
  `entryConditions` / `steps` / `choices` / `choiceRecords` 是**声明了但不执行**的字段。
  `OpeningRun` 在 `store.ts` 里被丢弃，没落盘。
- 开局 13 步是 `events.yaml` 里 `source: chain` + `startChain: chain-creation` 的普通事件，
  每步 `choose` 推进 `turnIndex`——等身份定完世界已跑 N 轮。
- 引擎已有完整转盘：`kind: random` + `settle.random.wheel.segments`（weight / weightBy / effects /
  nextEventId），掷骰在事件呈现时（`turn.ts:490-522`），确认时结算已呈现那格（`turn.ts:526-560`）。
- 本轮前置已落地：YAML branch `as` → `selfIs` 条件（见 README 前置）。
- **当前无测试**（2026-11-17 用户裁决全删）；CI 只剩 typecheck / web build / 冒烟。

## 2. 数据模型

### 2.1 OpeningParam（引擎闭集，shared）

参数定义与落点注册在 core，模板只写 `{ id, kind, 约束, label, order }`（渲染提示暂内联，
`ui.yaml` 定案后再迁出）。值形状扁平，不嵌 `who`：

| 参数 | 值形状 | 类别 | 落点 |
|---|---|---|---|
| `self` | `{ npcId } \| { new: {...} }` | 决定基线 | 移动 `selfId` / 固定实例化 |
| `name` | `string` | 基本 | self actor `.name` |
| `gender` | `enum` | 基本 | self actor `.gender` |
| `age` | `int` | 基本 | self actor `.age` |
| `attribute` | `{ id, value, mode: set\|add }` | 基本(set)/附加(add) | self actor `.attributes` |
| `status` | `statusId \| statusId[] \| { id, stacks? }` | 附加 | self actor `.statuses`（commit 时统一获得，`turnIndex=0`） |
| `skill` | `skillId` | 附加 | self actor `.skills` |
| `item` | `{ itemId, count }` | 附加 | self actor `.inventory` |
| `relation` | `{ with, value, kind? }` | 附加 | 关系边/标量 |
| `flag` | `{ id, value }` | 附加 | `state.flags` |
| `time` | `{ value, unit }` | 开局时间锚 | `state.worldTime`（替代旧 `advanceTo`） |
| `points` | `AllocationSpec` | 附加 | 属性分配 |
| `extensions` | `Record<string, unknown>` | 保留 | 核心不解释、扩展自取 |

**基本 vs 附加的推理规则**（R-OP-04）：`self` 指向已有角色 ⇒ 基本属性整组取该角色、开局参数中
同名字段被忽略（不 roll 不 choose）；`self` 为新建 ⇒ 基本属性从开局参数读；附加属性两种都叠加。
`attribute` 的 set 归基本、add 归附加。

### 2.2 OpeningSession（server 内存/持久化，非 WorldStateV2）

```
Session = { id, templateRef, seed, results: [{ nodeId, optionId?, rollIndex? }] }
```

- `results` 只记结果，不记 Draft、不记中间 `WorldStateV2`；
- **无 `facts`（D-4 裁决：不支持 `weightBy`）**：开局期世界未实例化，补正/最终面板无法计算，
  世界属性加权机制复用不了。后续需要时新增开局字段扩展 + 保留位，落 backlog。
- 会话里没有世界、没有 NPC 实例、没有 delayQueue——所以不需要"NPC 生成补丁 / 事件冻结补丁"。

### 2.3 commit 时的写状态顺序

1. 由 `results` 解析出最终参数表（纯函数，不重放 effect DSL）；
2. `createWorldV2` 一次建世界，`self` / 基本属性在 NPC 实例化前就位；
3. 附加属性按声明顺序写入（无 effect 解释器，直接按落点写）；
4. `handoff` 退化为纯交接（可选）；开局记录 `opening: { id, results }` 作为可选 state 切片落盘。

## 3. 会话流程（create / step / commit）

```
POST /openings          建会话 → 返回首节点（roll 自动掷/choose 返回选项）
POST /openings/:id/step 推进一步 → 返回下一节点 or done
POST /openings/:id/commit 一次建世界 → 返回 worldId
```

- roll 节点：服务端按 `derive(seed, openingId, nodeId)` 掷，结果记 `results`，自动推进；
- choose 节点：按当前 `facts` 算 `visibleWhen`（含 `selfIs`），返回选项等玩家点；
- allocate 节点：返回 `AllocationSpec`，校验后写 `results`；
- 前端动画只是"已决定结果的呈现"，与现有转盘同构；不信任客户端掷骰结果。

## 4. 正确性与 RNG

- `deriveOpeningRoll(seed, openingId, nodeId)` 纯派生，不改世界 RNG 流；建世界仍用原 seed。
- 同 seed + 同选项序列 ⇒ 同一 `results` ⇒ 同一世界（确定性内核不变量）。
- 中间插/删节点不影响后续骰子（按 node 派生，非游标）。
- "重抽"不存在：同 node 再算同结果（R-OP-07）。
- `hidden` 参数/信息不得进玩家端投影（沿用 SPEC 信息分层）。

## 5. 改名与投影

- `setIdentity` 加 `name?`（只写传入字段、不清空其他，照 fatherId/motherId 先例）；
- 新增玩家改名端点；世界列表读 `player.name` 自动同步；
- 投影末尾去掉 `state.player` 对 self 条目的覆盖（R-SELF-02）；战斗改读 self actor。

## 6. 模板重写

- 新版本目录 `specs/data/templates/jjk-2006/2.0.0/`，保留 1.0.0。
- opening 段：`opening.yaml` 增加 branch DAG 声明，13 步从 `events.yaml` 迁入；
  性别/年龄/术式/咒具/引路人等用 roll/choose 表达，效果逐项等价。
- **天内理子短线**：同一事件用 `as` 分派出两个 badend（十二年前必死），验证原著人物复用分支语法。
- 主线 `source: chain` **不改**（D-2 裁决）。

## 7. 裁决结果（2026-11-18 用户拍板，closed）

| 编号 | 问题 | 裁决 | 落地 |
|---|---|---|---|
| **D-1** | self 完整切换是否提前？ | **提前，且是第一步实施**——先做好才做后面 | T2 先于 T3/T4/T6 |
| **D-2** | jjk-2006 重写范围 | **只重构开局 + 加天内理子短线**（两个 badend，验证 `as` 新语法）；主线 chain 保留 | T6 |
| **D-3** | schemaVersion | **升 5**，旧档拒载（如实告知） | T2 |
| **D-4** | 属性加权 `weightBy` | **不支持**；后续新增开局字段扩展，不复用世界加权机制；落 backlog | T3 + backlog |
| **D-5** | 新建 self 不填名字 | **允许**，本轮一律显示 **"无名氏"** | T1/T4/T5 |

## 8. 需 ADR 的点（G2）

- self 存储从 `state.player` 迁到 `state.npcs[selfId]`（核心数据模型）→ `docs/ADR-001`。
- 开局会话作为新的 server 资源（新协议，非 WorldState 字段）→ 同一 ADR 记录。
- 不新增 settle kind、不重建 taskDag——已裁决，写进 ADR 的"不做"段而非新开条目。
