# 核心流程决策（GAME_RULES）

> **本文件是「默认必读」的一页纸**：只收**影响游戏核心流程**的已定决策，每条给结论 + 唯一权威出处。
> 不写实现细节、不写待办、不写历史过程。细节看 `specs/core/` 其余文件与 `docs/DECISIONS.md` 的 ADR 正文。
> 维护规则：**只有在核心流程被改变时才改这里**；改动必须同步对应 ADR。新增细节一律进 `docs/BACKLOG.md`，不进本文件。

## 1. 分层边界（不可越）

| 层 | 职责 | 禁止 |
|---|---|---|
| `packages/game-core` | 确定性模拟内核 | 依赖 React / Fastify / DB / LLM SDK |
| `apps/server` | API、持久化、鉴权边界、编排 | 在路由层写游戏规则 |
| `apps/web` | 展示与交互 | 承载权威游戏规则、重算权威数值 |

**确定性**：同初始状态 + 同输入 + 同 seed ⇒ 相同结果。时间、随机、ID 必须可注入。
出处：`AGENTS.md` §1，`specs/core/CORE_ENGINE.md`。

## 2. 时间与轮次

- **逻辑轮次（`turnIndex`）与世界时间是两个概念**，不一一对应。
- 世界时间用**分钟整数**表示，有上界（`hasEnd` 取代 `MAX_SAFE_INTEGER` 哨兵）；`toMinutes` 是**增量**语义。
- 历法由 `time.calendar.preset` 决定：`approx`（缺省，零迁移）/ `gregorian`（真实月长 + 闰年）/ `custom`（自定义月长 + 年号 `era`）。缺省 `approx` 保证旧模板可用。
- **年龄按日历年边界推进**（跨 1 月 1 日统一 +1 岁），对外方法为 `CalendarAdapter.elapsedYears(minute)`。**不存在 `ageAt`，也不做生日精度**（无生日数据源）。
- 年号/纪元只经 `CalendarAdapter.format` 输出，引擎不拼日期字符串。
- 出处：ADR-0002、ADR-0013（含**修订 R1**）、`docs/OPEN_QUESTIONS.md` #47（生日精度候选，已按「不做」关闭）。

## 3. 事件模型（最核心）

- **三层分离**：配置层（模板 yaml，只读）/ 实例层（本局活对象，可序列化）/ 事实层（append-only 记录）。
- **只有两类触发**：立即（`immediate`）与延时（`timed`，进时间窗队列）。退役「x 轮后触发」。
- **触发策略六项**：`probability` / `weight` / `once` / `priority` / `conditions` / `onActionId`。**配置域只读，实例不复制**。
- **入队门控前置**：条件不满足即不入队，**失败不计入「错失」**。
- **出队顺序**：`missWhen` → `conditions` → `cooldown` → `fire`；未触发的原因封闭为 `MissReason = window_expired | miss_when`。
- **`pool` 只产出延时事件；`combat` 不入池**，由 `normal` / `random` 经动作链立即步触发。
- **结算推进轮次并占槽**；`timeCost` 缺省 0。用物品**不**推进轮次。
- **单轮可结算多个随机事件**：`lastWheels[]` 承接当轮全部结果（`lastWheel` 为末项兼容），轮次起点清空。
- **槽位呈现优先级**：转盘 → 战斗 → 待决事件 → 自由行动（空槽），一轮只呈现一个。
- 出处：ADR-0010、ADR-0011、ADR-0017 决策 4、`specs/core/TEMPLATE_PROTOCOL_V2.md` §22。

## 4. 终止与结局

- **二态 + 标记**：`status ∈ {running, terminated}` + `termination{endingId, source, reason}`。**不引入六阶段 Lifecycle 状态机**。
- 终止后世界**只读**（写入返回 409 `terminated`）；未终止不可归档（409 `not_terminated`）。
- 结局可见性：`unlockConditions` + `narrativeConfig.masked`（隐藏结局显示掩码），**不再有 `EndingTemplate.visibility`**。
- 出处：ADR-0004、ADR-0006。

## 5. 人生评价

- 五维（模板可定义 5–6 维），**有界饱和**评分：`score = lo + (hi − lo)·x/(x+k)`，`x = max(0, raw − lo)`，`k = 0.30 × (hi − lo)`。单调递增、严格小于上限，**禁止按本局最大值归一**。
- 评价**只读过程信号，不含结局类型**；每次投影实时重算，不持久化。
- 玩家端**只在结局/归档展示分项**（跑动中不渲染；服务端仍下发 `dimensions`，这是前端渲染门）。
- 出处：ADR-0017 决策 2 与决策 5、ADR-0016 补记 D-10。

## 6. 人物、关系与战斗

- **NPC 生命周期与投影解耦**：状态层不存「人生阶段」推导结果；年龄由出生时间派生。
- **关系边语义**：`{from: A, to: B, kind: father}` = **「B 是 A 的父亲」**。可见性四档 `known / inferred / unknown / hidden`。
- **中文称谓只在可见子图上推导**（否则 hidden 边会成为推理侧信道）；反向边不反推称谓；断代亲属只出粗称谓且 `exact=false`，不猜代数。
- 战斗为**组队**（玩家 + AI 友军）。战斗控制位三件套 `canUseItems` / `canFlee` / `canAct` **共用 `controlOf` 单一判定**，投影与引擎同源。
- `BattleCommand` 四型：`skill` / `item` / `flee` / `pass`；**schema 单一真源**在 `packages/shared/src/v2-command.ts`，服务端只引用。
- 出处：ADR-0003、ADR-0012、ADR-0014、ADR-0017 决策 1/3。

## 7. 状态、投影与持久化

- **投影铁律一**：`hidden` 信息**不得**进入玩家端 API。
- **投影铁律二**：**投影不得让玩家看到引擎会拒绝或静默跳过的操作**。凡引擎有守卫（`cannot_use_items` / `cannot_flee` / `cannot_act` 等），投影必须给对应布尔位，且判定复用引擎同一入口。
- 持久化：**JSON 文件原子写**（tmp → rename），仓库根 `data/worlds/` 可挂载（`LIFE_SIM_DATA_DIR`）。
- **模板指纹拒载**：目录内全部 `*.yaml` 排序拼接 sha256，不匹配即拒载；`schemaVersion` 不匹配同样拒载。**改模板内容必然作废旧存档**，这是既定代价。
- 处境：ADR-0007、ADR-0017 决策 1。

## 8. 模板与内容边界

- **YAML 是唯一模板源**；Zod Schema 在 `packages/shared/src/schema/`；运行时**不生成**模板定义。
- 世界观专名**只允许**出现在模板与前端文案，`game-core/src` 运行时源码零专名（`boundary.test.ts` ⑤ 强制）。
- 属性键必须 ⊆ `attributes.order`（加载期 fail-fast）。
- 出处：ADR-0001、ADR-0017 决策 6。

## 9. AI 的位置

- AI **只**产候选行动、事件草案、叙事文本。
- AI **不能**写权威状态、不能决定评分、不能做唯一裁判。
- LLM 输出**必须结构校验**，失败回退模板文案；世界观规则只能进模板。
- 出处：`AGENTS.md` §1 / §5。（当前**未实现**，见 `docs/BACKLOG.md` §0。）

## 10. 明确不做（避免重复提案）

| 不做 | 理由/出处 |
|---|---|
| 六阶段 Lifecycle 状态机 | ADR-0004 |
| V1 引擎（`evaluateLife` / `advanceTurn` 等符号） | 已下线，仅保留 V2 共用 `rng.ts` |
| `CalendarAdapter.ageAt` / 生日精度 | ADR-0013 修订 R1、OQ #47 |
| 按本局最大值归一评分 | ADR-0017 决策 2（跨局不可比） |
| 为不可达状态预加投影字段（如 `sealed_skills`） | ADR-0017 决策 1 |
