# 验收巡游剧本 · 契约（CONTRACT）

**目的**：一个**最小**但**覆盖全部引擎功能**的剧本，让 `pnpm test:acceptance` 一条命令证明
「引擎的每一种能力都真的能跑通」，并作为 CI 的唯一端到端门禁。

**载体**：`specs/data/templates/demo-acceptance/1.0.0/`（新目录，与 `demo-agentic` 平级）。
`demo-agentic` 保持「最小骨架」定位不动 —— 它是"能跑"，本模板是"全都验一遍"。

**驱动**：`packages/game-core/src/acceptance.min.test.ts`。跑 3 遍同一剧本（每遍在最关键的分歧点
选不同选项），**并集**覆盖全部效果；每遍都断言结构性质（不崩、收束、无泄漏）。

---

## 一、世界

| 项 | 值 |
|---|---|
| `meta.id` | `demo-acceptance` |
| 默认步长 | 1 天 |
| 属性 | `body` / `mind` / `luck`（3 个足够） |
| 属性栏 | 3 条，覆盖 `source: attribute` 与 `source: identity` |
| 心情档位 | 2 档，带 `attributeModifiers`（验证心情补正链路） |
| 终止 | `timeReached >= 45 day` + `afterSettle`，另有一条 `flagSet tourFinished` 的 `eventOccurred` 路径 |
| 行动 | 4 条：`act-wait`（1 天）/ `act-train`（1 天）/ `act-social`（2 小时）/ `act-quick`（1 小时） |

## 二、角色（4 个）

| id | 用途 | 关键字段 |
|---|---|---|
| `npc-guide` | 关系 / 知识 / 状态载体 | `relations: [{to: player, kind: mentor, visibility: known}]`，`private.knowledge`、`private.secrets` 各 1 条 |
| `npc-mute` | **不展示**角色 | `visibility: hidden`（验证展示门：有实例但不上屏） |
| `npc-late` | 刷新规则目标 | 由 `npcSpawnRules` 管辖 ⇒ 建世界时 `unspawned`（验证"未登场不上屏、关系仍可见"） |
| `enemy-a` / `enemy-b` | 多敌人战斗 | `isEnemy: true`，各自 1 个技能（验证多目标 + onVictory/onDefeat） |

## 三、事件链（每步只证明一件事，顺序固定）

| # | 事件 id | kind | 证明什么 |
|---|---|---|---|
| S1 | `evt-tour-wheel` | random | 转盘：3 格、`weightBy`（用 `luck`）+ 每格写一个 flag → `evt-tour-showcase` |
| S2 | `evt-tour-showcase` | normal | **三选一**，三条互斥效果带（见 §四）→ `evt-tour-battle` |
| S3 | `evt-tour-battle` | combat | `enemies: [enemy-a, enemy-b]`、`canFlee`、`onVictory`/`onDefeat`/`onFlee` 三路各写不同 flag → `evt-tour-dusk` |
| S4 | `evt-tour-dusk` | normal | `timeCost: 2 hour`；选项 A 走 `startChain`（`chain-tour`），选项 B 只 `nextEventId`。两条路都进 `evt-tour-late` |
| S5 | `evt-tour-late` | normal | `window` + `delay` + `cooldown` + `missWhen`（用 `tourLateDone` 防重入）→ `evt-tour-final` |
| S6 | `evt-tour-final` | normal | 两个选项：A 设 `tourFinished`（走 `eventOccurred` 结局路径），B 不设（走时间路径） |

**链**：`chains: [{ id: chain-tour, steps: [...] }]`，由 S4-A 的 `startChain` 启动，
只跑一步就 `advanceChain` 到底（验证 start/advance/cancel 三个效果里的两个；`cancelChain` 由 S4-B 的一个旁路选项触发）。

## 四、S2 的三条效果带（**必须用齐 24 种效果**）

选 A「符咒」→ 玩家侧：
`setFlag` / `adjustFlag` / `clearFlag` / `adjustAttribute` / `adjustResource`(hp) / `adjustMood` /
`applyStatus` / `cureStatus`（对已有状态）/ `unlockSkill` / `adjustProficiency` / `adjustGrowth` /
`setIdentity`（只改 age）/ `log`

选 B「人情」→ 关系侧：
`adjustRelation`（标量形态，`npcId: npc-guide`）/ `adjustRelation`（边形态 `fromId+toId+kind`）/
`addRelationEdge` / `freezeRelationsOnDeath`（对 `npc-guide`；只冻结不动可见性）

选 C「世道」→ 世界侧：
`spawnNpc`（`rule-late`）/ `setNpcLifecycle`（`npc-guide` → `inactive` + `reasonCode: retired`）/
`enqueueEvent`（`evt-tour-late`，`delay: 1 day`）/ `advanceBy`（2 hour）/ `removeItem`（先由 A 里 grant 的物品）/
`advanceTo`（绝对时间，用一个已过的相对量表达，按 schema 允许的形状）

> 三遍跑完，24 种效果每种至少出现一次。**驱动按选项序号选**（0/1/2），不随机。

## 五、规则文件 `rules.yaml`

- `knowledgeGrants`：3 条 —— `eventResolved(evt-tour-showcase)` → player 得 `fact:tour-done`；
  `always` → `npc-guide` 得自己的 secret；`flagSet(tourLlm)` → player 得 `fact:llm-fired`
- `inferenceRules`：1 条 —— `flagSet(tourFinished)` → `npc-guide` 推断 `fact:tour-ended`
- `llmTriggers`：**1 条** —— `flagSet(tourLlm)`，`toolProfile: narrative`，
  允许 `["narrative.write", "fact.setKnowledge", "fact.enqueueEvent"]`
- `fallbackDag`：3 节点 2 边，`n1`(ready) → `n2`(guards: nodeCompleted n1) → `n3`
  + 第 3 个节点 `visibility: hidden`（验证 DAG 节点可见性不泄漏）

## 六、装备 / 物品 / 状态

- `items.yaml`：1 件装备（`type: equipment` + `slot: weapon` + 属性 `perAttribute` 补正）、
  1 个消耗品（`usableOutsideBattle: true` + `usableInBattle: true`）、1 个只读杂物
- `equipment.yaml`：`slots: [weapon]`（`maxCount: 1`）+ `initialEquipment: [那件装备]`
- `statuses.yaml`：2 条 —— ① `simulation.attributeModifiers`（持续属性修正 + `moodDeltaPerTurn`）；
  ② `combat.control: [cannot_use_items]`（验证战斗控制）；两条都 `visibility: known`

## 七、资源

`assets/manifest.yaml`：1 张立绘，`characterRef: npc-guide`，`visibility: public`，`license: demo-placeholder`。
（复用 `demo-agentic` 的 `portraits/mentor-neutral.png` 复制一份，不改原文件。）

## 八、结局 / 评价

- `endings.yaml`：2 个结局 —— `end-good`（`priority: 10`，条件 `flagSet tourFinished`）、
  `end-plain`（`priority: 0`，`fallback: true`）。验证**优先级选择**而不是"只有一个"。
- `evaluation.yaml`：1 个通用维度 + **1 个 `worldSpecificDimensions`**（验证模板自定义维度不写死引擎）。

## 九、不在模板里、由驱动直接调 API 的

| 能力 | 调用 |
|---|---|
| 装备穿脱 | `equipItem` / `unequipItem`（`v2/equipment.ts`），并在穿完后断言 `effectiveAttributes` 变化 |
| 战斗内用物品 | `battleActionV2({type:"item"})` |
| 战斗内空过 | `battleActionV2({type:"pass"})` |
| 逃跑 | `battleActionV2({type:"flee"})`（在 S3 的一遍里专跑这条） |
| NPC 自主行动 | `npcActions` 声明 1 条 `probability: 1` + `cooldownTurns: 1`，断言 `state.flags["npcAction:<id>:<actionId>"]` 被写 |
| LLM 一轮 | 假 gateway 返回 `narrative.write` + `fact.setKnowledge` + `fact.enqueueEvent` + `agent.submit` 的 tool_calls；断言 trace 与 state 的落账 |
| 投影 | `projectSnapshotV2`：关系行有 `withName`、`npc-mute`/`npc-late` 不在 `npcs`、secrets 不出现 |
| 存档 round-trip | `WorldStateV2Schema.parse(JSON.parse(JSON.stringify(state)))` 通过且关键字段相等 |

## 十、完成判据（驱动里的 coverage 集合）

```
COVER = [
  opening, wheel, weightBy, normal-option, combat, multi-enemy, victory, defeat, flee,
  effect:setFlag, effect:adjustFlag, effect:clearFlag, effect:adjustAttribute,
  effect:adjustResource, effect:adjustMood, effect:setIdentity, effect:adjustRelation,
  effect:addRelationEdge, effect:freezeRelationsOnDeath, effect:spawnNpc,
  effect:setNpcLifecycle, effect:grantItem, effect:removeItem, effect:applyStatus,
  effect:cureStatus, effect:unlockSkill, effect:adjustProficiency, effect:adjustGrowth,
  effect:advanceTo, effect:advanceBy, effect:startChain, effect:advanceChain,
  effect:cancelChain, effect:enqueueEvent, effect:log,
  chain, window, delay, cooldown, missWhen, timeCost,
  spawn-rule, lifecycle-inactive, relation-edge, kinship-or-social-label,
  knowledge-grant, inference-rule, task-dag-seed, dag-node-completed,
  npc-action, llm-trigger, llm-tool-call, trace, ending-priority, evaluation-world-dim,
  equipment-equip, equipment-unequip, item-outside-battle, item-in-battle, status-modifier,
  combat-control, projection-hidden, projection-relation-name, save-roundtrip,
  hidden-node-not-projected, multi-run-determinism,
]
```

断言方式：驱动维护 `seen: Set<string>`，每步实际观察到的能力加进去；**最后一次断言
`COVER` 里每一项都在 `seen` 里**，缺哪项就报哪项。这样"哪个功能没被验到"是**可指认的**，
而不是靠人肉回忆。
