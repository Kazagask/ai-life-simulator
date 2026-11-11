# 迭代 R2.3 需求规格（Requirements）

**版本：2026-11-11（R2.3 立项）｜状态：草案｜上游：`README.md`｜下游：`design.md`、`tasks.md`**

本文件只回答「系统要做什么、怎样算做到了」。实现方案、数据结构与模块边界在 `design.md`；顺序与验收在 `tasks.md`。

------------------------------------------------------------------------

## 0. 约定

### 0.1 编号与来源

需求编号 `R-<组>-<序号>`。R2.3 新增四组，**不重排 R2.2 的任何编号**：

| 组 | 含义 | 状态 |
|---|---|---|
| `VS` | Visibility / 可见性收口 | 新增，5 条 ACTIVE |
| `PS` | Persistence / 存档持久化 | 新增，7 条 ACTIVE |
| `TS` | Time Span / 时间跨度 | 新增，5 条 ACTIVE |
| `EQ` | Equipment / 装备（**续 R2.2 编号**，从 `R-EQ-07` 起） | 新增，4 条 ACTIVE |
| `NFR` | 横切约束 | **沿用 R2.2 的 `R-NFR-01..06`**，本轮不新增编号 |

来源标记：

- `GAP §x` = `tasks/reports/R2-GAP-ANALYSIS.md` 对应小节
- `R2.2 R-*` = `specs/iteration-2026-11-11/requirements.md` 既有需求（引用，不修改）
- `S3 #n` = `docs/OPEN_QUESTIONS.md` 第 n 条
- `USR` = 用户 2026-11-11 决定（「先 P0 后体验，阶段 8 延期」）

### 0.2 需求状态

| 状态 | 含义 | 本轮处理 |
|---|---|---|
| `ACTIVE` | 本轮验收范围内 | 必须有测试、任务引用与完成定义；**共 21 条** |
| `DEFERRED` | 延期，编号与原文保留 | 不实现、不测试、不派任务、不计入 DoD |

**本轮 ACTIVE 组成**：`VS` 5 + `PS` 7 + `TS` 5 + `EQ` 4 = **21 条**。

**本轮无 `RETIRED`。** R2.2 的 45 条 ACTIVE 已全部验收完毕，本轮不重开、不改状态；其中 `R-NFR-04`（hidden 不得进投影）在 R2.2 阶段 4 被标为「部分实现」，**本轮由 `R-VS-*` 补齐并重新验收**（见 `design.md` §2.1）。

**阶段 8 相关需求**（`R-NFR-05` 跨模板、`R-NFR-06`）**状态保持 ACTIVE 但本轮不派任务**，延期理由与恢复方式登记在 `tasks.md` 附录 A；不计入本轮 21 条。

### 0.3 句式（EARS）

| 类型 | 句式 |
|---|---|
| 普遍 | 系统应当…… |
| 事件驱动 | 当……时，系统应当…… |
| 状态驱动 | 当处于……状态时，系统应当…… |
| 非期望行为 | 如果……，系统应当…… |
| 可选特性 | 在模板配置了……时，系统应当…… |

验收用 `Given / When / Then`，必须可由自动化测试断言；不写「体验良好」这类不可测描述。

------------------------------------------------------------------------

## 1. 用户故事

| ID | 角色 | 故事 |
|---|---|---|
| US-1 | 玩家 | 我不该看见自己无从知晓的事。谁在背后做了什么、世界瞒着我什么，得靠剧情揭开，而不是我在「日志」里读到。 |
| US-2 | 玩家 | 我关掉页面、隔天再来，这一生还在那儿等我，不用从头开始。 |
| US-3 | 玩家 | 我想真的把一辈子过完——不是点六万次「修炼」，而是能说「接下来这一年我专心修行」，然后看世界自己发生什么。 |
| US-4 | 玩家 | 我打到一把更好的刀，应该能当场换上，而不是只能看着背包发呆。 |
| US-5 | Coding Agent | 我希望每一处改动都有编号、有验收、有 ADR，不要再用「后续迭代」含糊掉硬约束违反。 |

------------------------------------------------------------------------

## 2. 功能需求

### 2.1 可见性收口（`R-VS`）

> 现状：`HistoryEntryV2` 无可见性字段（`packages/shared/src/v2.ts:146`）；`playerVisibleHistory` 直接 `slice(-20)`（`v2/turn.ts:584`）；`GET /api/worlds/:id/history` 返回 `world.history` 全量（`apps/server/src/index.ts:257`）；前端「日志」Tab 原样渲染（`apps/web/src/main.tsx:1122`）。`hidden` 结局触发写入的历史条目因此对玩家可见 —— `R-NFR-04` 现状不成立（`GAP §6.5`）。**注（2026-11-11 用户裁决，OPEN_QUESTIONS #33）**：事件不设隐藏语义，`EventV2Schema` 不加 `visibility` 字段；隐藏能力只由结局表达。

**R-VS-01（普遍）** 系统应当为每一条历史记录携带可见性标记，取值 `public` / `hidden` / `unknown`，且**写入侧不得省略**。

- 验收：Given 任意一次写历史的代码路径，When 编译 TypeScript，Then 缺少可见性参数的调用点应报类型错误；Given 一条历史记录，When 序列化进世界状态，Then 其 `visibility` 字段存在且取值合法。
- 追溯：`design.md §2.2`｜任务 `T2-01`

**R-VS-02（状态驱动）** 当历史记录的可见性不是 `public` 时，系统应当在**全部**玩家端出口排除该条目：回合结果 `playerVisibleHistory`、`GET /api/worlds/:id/history`、归档响应中的历史列表。

- 验收：Given 一条 `visibility: "hidden"` 的历史，When 请求上述三个出口，Then 响应中均不含该条 `id`；Given 一条 `public` 记录，Then 三个出口均包含。
- 追溯：`design.md §2.3`｜任务 `T2-02`

**R-VS-03（事件驱动）** 历史记录的可见性应当只由来源语义决定：事件来源的历史条目一律 `public`（事件没有隐藏语义，OPEN_QUESTIONS #33 已裁决）；由**隐藏结局**（模板声明 `narrativeConfig.masked`，ADR-0006）触发写入的历史条目（结局揭示）应当为 `hidden`。

- 验收：Given 任意事件被触发并写入历史，Then 该条目 `visibility === "public"`；Given 模板声明 `narrativeConfig.masked` 的结局命中并写入历史，Then 该条目 `visibility === "hidden"`。
- 追溯：`design.md §2.2`｜任务 `T2-01`

**R-VS-04（普遍）** 归档响应应当只向玩家端下发 public 历史，并给出被隐藏条目的计数（`hiddenHistoryCount`），完整历史仅保留在服务端存档中。

- 验收：Given 一局含 3 条 hidden 历史的已终止世界，When `POST /archive`，Then 响应 `archive.history` 长度 = public 条数、`archive.hiddenHistoryCount === 3`；Given 该世界重新 `GET`，Then 玩家端仍看不到这 3 条。
- 追溯：`design.md §2.4`｜任务 `T2-02`

**R-VS-05（非期望行为）** 如果任一次投影或接口响应中出现可见性非 `public` 的历史条目（含嵌套 `detail` 文本命中），系统应当由自动化测试判定失败。

- 验收：Given 一个故意触发 `hidden` 结局（其揭示条目为 `hidden`）的世界，When 遍历 `snapshot`、`turnResult`、`/history`、`/archive` 四个出口递归扫描，Then 断言无命中；该用例作为常驻渗透测试保留。
- 追溯：`design.md §2.5`｜任务 `T2-03`

### 2.2 存档持久化（`R-PS`）

> 现状：`worldStore` 为内存 `Map`，注释写明「P0 阶段不持久化，重启即清空」（`apps/server/src/store.ts:13`）；前端已把 `worldId` 存 `localStorage` 并尝试续玩，但服务端一次重启即 404。`R-AR-03`「服务重启后恢复」现状不成立（`GAP §6.8`）。

**R-PS-01（事件驱动）** 当世界状态发生任何成功变更（轮次推进、选项结算、战斗行动、使用物品、装备穿脱、归档封存）时，系统应当在同一请求内完成落盘，响应返回前数据已持久。

- 验收：Given 一局推进 1 轮，When 进程被强杀并重启，Then `GET /api/worlds/:id` 返回的 `turnIndex`、`worldTime`、`player.hp` 与强杀前一致。
- 追溯：`design.md §3.3`｜任务 `T3-02`

**R-PS-02（事件驱动）** 当服务启动时，系统应当从落盘目录恢复全部世界，且 `worldId`、`templateId`、`seed`、`turnIndex`、`worldTime`、`history`、`termination`、`archived` 逐字段不变。

- 验收：Given 3 局不同状态的世界（进行中 / 已终止 / 已归档），When 重启服务，Then `GET /api/worlds` 返回 3 条且状态分类正确；逐字段比对与重启前快照相等。
- 追溯：`design.md §3.4`｜任务 `T3-02`

**R-PS-03（非期望行为）** 如果存档损坏、`schemaVersion` 不匹配或模板指纹不匹配，系统应当拒绝加载该局并记录可诊断错误（含文件名与原因），且**不得**阻断其它世界的加载或导致启动失败。

- 验收：Given 一个被截断的 JSON 文件、一个 `schemaVersion: 999` 的文件、一个模板指纹被篡改的文件，When 启动，Then 启动成功、三者均不出现在列表中、日志各有 1 条 error 且包含文件名与原因；Given 一份合法存档，Then 正常加载。
- 追溯：`design.md §3.4`｜任务 `T3-02`

**R-PS-04（普遍）** 系统应当提供世界列表接口 `GET /api/worlds`，返回每局的 `id`、`templateId`、玩家名、`turnIndex`、世界时间（含格式化文本）、状态（`running` / `terminated` / `archived`）。

- 验收：Given 3 局不同状态，When `GET /api/worlds`，Then 返回 3 条且字段齐全、状态与 `termination` / `archived` 一致；空目录返回空数组而非 404。
- 追溯：`design.md §3.5`｜任务 `T3-03`

**R-PS-05（普遍）** 系统应当以「写临时文件 + 原子替换」的方式落盘，写入中途失败不得破坏已有存档。

- 验收：Given 一份已有存档，When 模拟写入阶段抛错（注入失败），Then 磁盘上的旧文件内容不变、仍可加载；Given 正常写入，Then 目录中不残留 `.tmp` 文件。
- 追溯：`design.md §3.3`｜任务 `T3-02`

**R-PS-06（状态驱动）** 当加载的世界 `archived === true` 时，系统应当以只读方式呈现，任何写入入口返回 409。

- 验收：Given 一局已归档世界，When 调用 `/turns`、`/events/choose`、`/battle`、`/items/use`、`/equipment/equip`，Then 全部 409 且存档文件未被改写。
- 追溯：`design.md §3.6`｜任务 `T3-02`

**R-PS-07（可选特性）** 在启用落盘时，同一 seed 下「落盘 → 重启 → 继续推进 N 轮」的结果应当与「不落盘直接推进 N 轮」逐字段相等。

- 验收：Given 同 seed 同命令序列的两局，一局每轮重启，When 各推进 10 轮，Then 两局 `snapshot`、`history` 逐字段相等。
- 追溯：`design.md §3.7`｜任务 `T3-05`

### 2.3 时间跨度（`R-TS`）

> 现状：`world.yaml` 默认步长 4 小时，阶段步长 4 小时～1 天（`world.yaml:11-16`），行动时长为 2–8 小时；16 岁到 60 岁需约 6 万轮，寿终条件（44 年）实际不可达，`endLife` 成为唯一现实的收束方式。`mode: "single" | "fast"` 已声明但全仓无读取点（`v2/turn.ts:492`）。

**R-TS-01（可选特性）** 在模板声明了跨度步长（`time.spanSteps`）时，玩家应当可以提交跨度动作，一次推进不少于 1 天；该动作复用既有 `mode: "fast"` 字段承载，不新增命令字段。

- 验收：Given 声明了跨度步长的模板，When 提交 `{ action, mode: "fast", span: { value: 1, unit: "month" } }`，Then 世界时间前进 1 个月、响应 `elapsed` 为 1 个月；Given 未声明跨度步长的模板，Then 该请求返回 400 且给出「本模板未启用跨度推进」。
- 追溯：`design.md §4.2`｜任务 `T4-01`

**R-TS-02（普遍）** 系统应当按时间片推进跨度：每片只结算时间触发事件、事件池（受每跨度事件上限约束）与事件链推进；**不**执行逐片 NPC 效用行动与逐片状态衰减，NPC 行动在每个跨度内按固定抽样次数结算。

- 验收：Given 一个跨度为 30 天、事件上限 3 的跨度动作，When 结算完成，Then 新增事件数 ≤ 3、NPC 行动次数 ≤ 模板声明的抽样次数、状态衰减按整段时间一次结算（数值与逐片累加等价或按声明的近似规则）。
- 追溯：`design.md §4.3`｜任务 `T4-02`

**R-TS-03（事件驱动）** 当跨度跨过寿限门槛时，系统应当在跨度结束时判定终止并给出结局，判定边界与 R2.2 的 `R-EN-02` 保持一致（只在结算边界判定，不在片中途判定）。

- 验收：Given 玩家年龄 59、寿限 60 的模板，When 提交 1 年跨度，Then 世界 `status === "terminated"`、`ending` 非空、`termination.source === "condition"`；Given 一次跨度只跨半年，Then 不终止。
- 追溯：`design.md §4.4`｜任务 `T4-01`

**R-TS-04（普遍）** 相同 seed + 相同命令序列（含跨度动作）应当产生逐字段相等的结果，包括跨度内每个时间片的 RNG 消耗顺序。

- 验收：Given 同 seed 的两局，When 各执行 5 次跨度动作，Then `snapshot`、`history`、`termination` 逐字段相等；并断言跨度内的随机事件序列一致。
- 追溯：`design.md §4.5`｜任务 `T4-03`

**R-TS-05（普遍）** 使用默认模板（`jjk-2006`）的新世界，仅使用跨度动作应当能在 800 轮以内到达寿终结局。

- 验收：Given 一个 16 岁开局的世界，When 循环提交最大跨度动作直到 `status === "terminated"`，Then 总轮次 ≤ 800 且结局为寿终类；该用例记录实际轮次作为基线，超过 800 即失败。
- 追溯：`design.md §4.6`｜任务 `T4-03`

### 2.4 装备穿脱（`R-EQ-07..10`，续 R2.2 编号）

> 现状：`equipItem` / `unequipItem` 为纯函数，返回新数组 + 7 种错误码，25 项测试覆盖（`v2/equipment.ts:92,122`、`equipment.test.ts`）；但无服务端端点、无前端交互，玩家中途无法换装；背包投影缺 `type` / `slot` 字段，前端无法判断哪些物品可装备。

**R-EQ-07（普遍）** 系统应当提供装备与卸下端点，失败时返回可诊断错误码（`slot_not_found` / `slot_category_mismatch` / `slot_full` / `item_not_equipment` / `not_owned` / `instance_not_found`），且世界状态不变。

- 验收：Given 背包有装备物品、目标槽位有空位，When `POST /equipment/equip`，Then 200 且 `player.equipment` 增加一条实例；Given 槽位已满，Then 409 且 `error` 为 `slot_full`、`player.equipment` 与请求前逐字段相等。
- 追溯：`design.md §5.2`｜任务 `T5-01`

**R-EQ-08（普遍）** 装备与卸下不消耗世界时间，成功时写入一条 `public` 历史记录。

- 验收：Given 一次成功装备，When 结算完成，Then `worldTime` 与请求前相等、新增 1 条 `type: "player_action"` 且 `visibility: "public"` 的历史。
- 追溯：`design.md §5.2`｜任务 `T5-01`

**R-EQ-09（普遍）** 玩家端背包投影应当包含装备类物品的 `type`、`slot`、`category` 展示字段，且不含任何补正结果字段。

- 验收：Given 背包含 1 件装备与 1 个消耗品，When 请求快照，Then 装备条目含 `type === "equipment"` 与 `slot`，消耗品含 `type === "consumable"`；两条目均不出现 `dynamicModifier`、补正数值或 `attribute` 字段。
- 追溯：`design.md §5.3`｜任务 `T5-02`

**R-EQ-10（普遍）** 穿脱后玩家基础属性逐字段不变，仅 `effectiveAttributes()` 输出变化；已装备实例不得包含任何补正结果字段。

- 验收：Given 装备一件 `+power` 的装备，When 前后对比 `player.attributes`，Then 逐字段相等；`effectiveAttributes()` 的 `power` 差值等于装备补正值；`player.equipment[0]` 的键集合不含补正字段。
- 追溯：`design.md §5.3`｜任务 `T5-04`

------------------------------------------------------------------------

## 3. 非功能需求（沿用 R2.2，不新增编号）

| 编号 | 要求 | 本轮如何被影响 |
|---|---|---|
| `R-NFR-01` | 同 seed 同输入 ⇒ 同结果 | 新增 `R-TS-04`（跨度）、`R-PS-07`（落盘往返）作为具体化 |
| `R-NFR-02` | 时间/随机/ID 可注入 | 跨度分片必须用可注入 RNG，禁止 `Math.random` |
| `R-NFR-03` | LLM 失败可回退 | 本轮不动 LLM 路径，仅确保新增端点不引入网络调用 |
| `R-NFR-04` | `hidden` 不得进投影 | **本轮由 `R-VS-02` / `R-VS-05` 补齐并重新验收**（R2.2 标「部分实现」） |
| `R-NFR-05` | 模板差异只通过配置表达 | 跨度参数（步长、事件上限、抽样次数）必须模板可配；阶段 8 延期 |
| `R-NFR-06` | 跨模板验证 | 阶段 8 延期；本轮只在 `jjk-2006` 上验证，**登记为已知缺口** |

------------------------------------------------------------------------

## 4. 追溯矩阵

| 需求 | 设计章节 | 任务 | 测试落点 |
|---|---|---|---|
| `R-VS-01` | `design §2.2` | `T2-01` | `history-visibility.test.ts` |
| `R-VS-02` | `design §2.3` | `T2-02` | 同上 + `history-visibility.test.ts`（出口遍历） |
| `R-VS-03` | `design §2.2` | `T2-01` | 同上 |
| `R-VS-04` | `design §2.4` | `T2-02` | `archive-visibility.test.ts` |
| `R-VS-05` | `design §2.5` | `T2-03` | 渗透测试用例（常驻） |
| `R-PS-01` | `design §3.3` | `T3-02` | 手动强杀 + `store-persistence.test.ts` |
| `R-PS-02` | `design §3.4` | `T3-02` | `store-persistence.test.ts` |
| `R-PS-03` | `design §3.4` | `T3-02` | 同上（三类坏档） |
| `R-PS-04` | `design §3.5` | `T3-03` | 端点冒烟 + 前端列表 |
| `R-PS-05` | `design §3.3` | `T3-02` | 注入写失败 |
| `R-PS-06` | `design §3.6` | `T3-02` | 归档只读回归（复用 R2.2 用例） |
| `R-PS-07` | `design §3.7` | `T3-05` | `store-replay.test.ts` |
| `R-TS-01` | `design §4.2` | `T4-01` | `span-turn.test.ts` |
| `R-TS-02` | `design §4.3` | `T4-02` | 同上（限流与抽样计数） |
| `R-TS-03` | `design §4.4` | `T4-01` | 同上（跨寿限） |
| `R-TS-04` | `design §4.5` | `T4-03` | `span-replay.test.ts` |
| `R-TS-05` | `design §4.6` | `T4-03` | 端到端脚本（记录基线轮次） |
| `R-EQ-07` | `design §5.2` | `T5-01` | `equipment-api.test.ts` |
| `R-EQ-08` | `design §5.2` | `T5-01` | 同上 |
| `R-EQ-09` | `design §5.3` | `T5-02` | `equipment.test.ts` 扩充 |
| `R-EQ-10` | `design §5.3` | `T5-04` | 同上 |

------------------------------------------------------------------------

## 5. 本轮明确不验收

| 项 | 原因 |
|---|---|
| 阶段 8 四项（三世界观 / 属性回归套件 / LLM 失败注入 / R2-COMPLETION） | 用户决定延期；`tasks.md` 附录 A 保留原文 |
| 多设备同步 / 账号 / PostgreSQL | `OPEN_QUESTIONS` #1/#2；本轮只做本地单机落盘 |
| LLM 叙事与失败注入 | `OPEN_QUESTIONS` #5；本轮 `narrativeSource` 仍恒为 `template` |
| `#28` 评价维度名对齐 | 未变，仍待规格文字对齐 |
| `#31` `deathMode: "event"` 不重放事件效果 | 未变；`jjk-2006` 使用 `direct`，不暴露 |
| NPC 生命周期 / 关系网络（#21–#25） | 需先立 Spec/ADR |
