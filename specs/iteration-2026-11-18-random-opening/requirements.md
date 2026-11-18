# 需求：随机开局 / 前实例化

> EARS 格式。`R-OP` 参数与会话 / `R-SELF` 指针切换 / `R-TPL` 模板重写 / `R-CMP` 兼容。
> 每条带验收标准；`DEFERRED` 组只登记不实现。追溯矩阵见末节。

## R-OP 组：开局参数与前实例化

### R-OP-01 开局是生成参数而非世界内事件
开局步骤在**世界实例化之前**完成；`commit` 之前不存在 `WorldStateV2`、NPC 实例、
`delayQueue`、事件槽。进游戏后才获得的东西属于开局之后，不得塞进开局。
- **验收**：`commit` 前任意时点查询无世界文件、无 `npcs[]`、无 `delayQueue`；`turnIndex === 0`。

### R-OP-02 连续 n 步混合编排
开局是一段**连续**的步骤序列，形状复用 branch DAG（`node` / `options` / `goto`）。
每一步可为 roll（引擎按权重掷）、choose（玩家点选）、allocate（玩家加点），任意交错。
- **验收**：同一分支内 roll 与 choose 可按任意顺序排列；roll 节点自动推进、choose 节点返回选项等待。

### R-OP-03 引擎持有封闭参数表
参数类型与"写到世界哪里"由**引擎注册表**定义，模板只声明用哪些参数、取值范围与展示提示。
参数值形状保持简单，不做 ActorRef 式的 `who` 嵌套；引擎负责推理落点。
- **验收**：模板无法自定义参数落点；新增参数类型需改 core + ADR。

### R-OP-04 两类参数：基本属性 / 附加属性
- **基本属性**（`name` / `gender` / `age` / 基础 `attribute` set）：定义"你是谁"。
  当 self 复用人物路径时，**整组取自该角色、不读开局参数**（新建 self 除外）。
- **附加属性**（`skill` / `item` / `relation` / `flag` / `points` / `attribute` 的 add/sub）：
  在基线上加减，两种 self 形态都照常叠加。
- **验收**：self=npc-gojo 时 `name` 恒为五条悟且 roll/choose 对该字段无效；附加属性仍全部生效。

### R-OP-05 参数闭集与扩展保留位
v1 闭集：`self / name / gender / age / attribute / status / skill / item / relation / flag / time / points`。`status` 在 commit 时统一获得（值可为 id / id[] / `{id, stacks?}`，沿用模板 duration/stacking）；`time`（`{value, unit}`）是开局时间锚，替代旧 `advanceTo`；**`mood` 不入闭集**，原开局步骤的 `adjustMood` 在模板重写时移除。
不设 `character`（新人物固定实例化，不进刷新规则）、不设 `npcSpawn`。
另设 `extensions: Record<string, unknown>` 保留字段给 RPG 扩展挂载，核心不解释、不校验内容。
- **验收**：闭集外的参数键加载期拒载；`extensions` 透传且不影响核心结算。

### R-OP-06 新人物固定实例化
开局新建的人物在 `commit` 时固定建一个 NPC 实例，不进 `npcSpawnRules`、不受刷新管辖。
- **验收**：新人物不因刷新规则被裁掉或重复生成。

### R-OP-07 抽到即认，不可重抽
延续 SPEC §1.4「不做放弃转盘」。同一节点重复求值仍得同一格。
- **验收**：对同一 roll 节点发起两次解析，结果一致；无重抽入口。

## R-RNG 组：种子与随机

### R-RNG-01 按节点派生，不消耗主流
开局 roll 用 `derive(seed, openingId, nodeId)` 的纯函数派生 RNG，不从世界 RNG 游标取数。
开局不消耗建局 seed，也不改变进世界后的事件序列。
- **验收**：同 seed + 同选择序列 ⇒ 同一开局 + 同一世界；中间插/删一步不改变后续骰子。

### R-RNG-02 属性加权：v1 不支持（D-4 已裁决）
**不支持 `weightBy`**，只静态 `weight`。理由：开局期世界未实例化，补正与最终面板无法计算，
世界实例化后的属性加权机制**复用不了**。后续需要时以「新增开局字段 + 扩展保留位」方式增加，
不复用世界属性机制；该议题落 backlog。
- **验收**：开局 roll 声明 `weightBy` ⇒ 加载期拒载；backlog 有登记条目。

## R-SELF 组：self 完整切换

### R-SELF-01 玩家实体进 npcs
`createWorldV2` 时玩家作为一个 NPC 实例进入 `state.npcs`（id = `selfId`），
`selfId` 可指向任意角色。`state.player` 退化为 self 的别名/缓存，引擎统一走 `actorOf(selfId)`。
- **验收**：self 指向 npc-gojo 后，属性/战斗/投影一律读该实例，无同步补丁。

### R-SELF-02 投影与战斗改读 self actor
投影最终不再用 `state.player` 覆盖 self 条目；战斗读 self actor 的 `attributes/hp/mp`，
不再写死 `state.player`。
- **验收**：扮演五条悟时，人物卡与战斗面板显示的是该实例数据。

### R-SELF-03 self 切换驱动角色分派
`selfIs` / `selfIsNot` 一等条件（本轮前置已落地）随 self 移动生效；branch 的**同一 node 别名**可写多份
`as` 变体，每份有各自正文与选项，self 决定命中哪一份（天然互斥，不是"某些角色才有的选项"）。
**首节点亦可写 `as`**：多个首节点变体共用父 trigger，兜底变体带一组 `selfIsNot` 排除所有 as。
- **验收**：self=npc-gojo 的局只呈现 `as: npc-gojo` 节点正文/选项；self=npc-yuji 走另一份；
  goto 到多变体节点、或外部 nextEventId 指向多变体首节点父 id 时，玩家仍只看到一条选项、不额外耗轮次；
  random/combat 的 nextEventId 指向多变体首节点 ⇒ 加载期拒载。

## R-NAME 组：名字

### R-NAME-01 名字可空
建局请求 `playerName` 改为可选；不填时走开局参数，仍无则留空（占位显示"无名"）。
- **验收**：不传 playerName 可建局，存档列表显示 **"无名氏"**（本轮占位统一口径）而非报错。

### R-NAME-02 开局后改名
提供玩家改名入口，`setIdentity` 支持 `name`；存档列表读 `player.name` 自动同步。
- **验收**：改名后世界列表条目随之更新。

## R-TPL 组：jjk-2006 模板重写

### R-TPL-01 用 branchDag 重写开局
jjk-2006 的 13 步创建从 `events.yaml` 的 `chain-creation` 迁到 opening 的 branch DAG，
用 roll/choose 表达；`turnIndex` 保持 0，无延时事件。
- **验收**：开局全程无 `delayQueue`、无事件槽推进；效果逐项等价（属性/技能/道具/flag/关系）。

### R-TPL-02 去掉开局事件链写法（D-2 已裁决）
本轮**只重构开局**：jjk-2006 的 13 步创建从 `events.yaml` 迁出；主线 `source: chain` 保留。
- **验收**：开局段无 chain 创建事件；模板加载期 fail-fast 通过。

### R-TPL-04 天内理子短线验证新 branch 语法（新增）
在 jjk-2006/2.0.0 内加一条**原著人物短线**：用新 YAML branch `as` 语法验证「同一事件不同角色
不同分支」。只做**两个 badend**，明确必然活不到十二年后（时间线收束），不做完整长线。
- **验收**：两个 badend 均可在十二年前触达；`as` 分派按当前 self 命中唯一分支；LLM 侧不开放 `as`。

### R-TPL-03 版本化落地
opening.yaml / events.yaml 改动进语义指纹，建议新建 `jjk-2006/2.0.0/` 版本目录，
保留 1.0.0 旧档可载。
- **验收**：1.0.0 与 2.0.0 并存，各自指纹独立。

## R-CMP 组：兼容

### R-CMP-01 旧档策略：schemaVersion = 5（D-3 已裁决）
按用户裁决**升 5**；v1–v4 旧档一律拒载，发布时如实告知旧档代价。
- **验收**：envelope `schemaVersion !== 5` ⇒ 封闭拒载码；新档可正常存取。

### R-CMP-02 LLM 不参与开局
LLM 不决定开局、不写开局参数；`submitBranch` 不开放 `as` 与开局参数字段。
- **验收**：mock/真实 provider 均无开局写入口。

## DEFERRED（登记不实现，编号保留）

- `R-DEF-01` 自由文本开局行动（#26）
- `R-DEF-02` 多 Agent 开局（#3）
- `R-DEF-03` flavor 流式输出
- `R-DEF-04` 跨模板验证（需第二份真实开局模板证明需求）
- `R-DEF-05` 世界内加点的新操作端点（第三种 allocate 已在开局内实现；世界内复用同一
  `AllocationSpec` 校验器，但**不新增 settle kind**，另立任务）

## 追溯矩阵

| 需求 | 设计章节 | 任务 |
|---|---|---|
| R-OP-01..07 | design §2/§3 | T2/T3 |
| R-RNG-01..02 | design §4 | T3 |
| R-SELF-01..03 | design §2 | T2 |
| R-NAME-01..02 | design §3/§5 | T1/T4/T5 |
| R-TPL-01..03 | design §6 | T6 |
| R-CMP-01..02 | design §7 | T1/T6 |
