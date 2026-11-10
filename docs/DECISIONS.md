# 已知决策与未决项

## 当前作为工程基线采用
- 竖屏移动端、单手操作、叙事优先、卡片交互、Bottom Sheet、底部 Tab。
- TypeScript / Node.js 生态。
- 模块化单体，核心模拟引擎与 UI、API、LLM 解耦。
- 确定性规则引擎 + 受约束 AI 叙事/生成。
- 世界模板参数化，世界时间与逻辑轮次解耦。
- P0 优先验证轮次、时间、NPC、事件、信息差和人生评价闭环。

## 本 Starter 暂定技术默认值
React + Vite + PWA、Fastify、PostgreSQL、Drizzle、Zod、Vitest、pnpm workspace。
此前讨论过 Vue/React、Prisma/Drizzle 等备选，但没有形成足够明确的最终确认。若要改动，先提交 ADR，不要静默换栈。

## 明确不做
- 不要求 AI 每轮介入。
- 不让 AI 直接写入权威游戏状态。
- 不要求 P0 上微服务、Redis 或复杂多 Agent。
- 不强制原作剧情按固定顺序发生。

## ADR-0001 世界模板协议 V2 与 YAML 唯一模板源

状态：已接受（2026-11）

### 背景

V1 模板以 TypeScript 常量（`packages/game-core/src/data/jjk.ts`）定义，事件仅支持 flag/属性/关系三种效果，且缺少技能、物品栏、补正（异常状态）、战斗、随机转盘等模板概念。为支撑多世界观与模板化扩展，需要升级协议并确定模板的创作格式。

### 决策

1. **YAML 为唯一模板源**：每个世界一个目录（`specs/data/templates/<world-id>/`，实现阶段迁移至运行时可访问目录），多文件分域（world/characters/skills/items/statuses/events）。server 启动时加载 YAML，经 Zod Schema（`packages/shared/src/schema/`，协议的可执行定义）校验后进入引擎；运行时不依赖 TS 模板。
2. **通用事件协议三段式**：`trigger`（触发条件/来源/概率或权重/冷却/优先级）→ `kind`（normal | random | combat）→ `settle`（按 kind 分派的结算：选项 / 转盘扇区 / 敌人与胜负结算）。效果使用声明式 DSL，世界观专属内容只进模板不进引擎。
3. **补正（buff/debuff 统称）单定义双面**：每个补正是单一定义，内含 `simulation` 面与 `combat` 面两个可选块（至少其一）。转换规则为引擎固定逻辑，模板不可覆盖：进战斗激活 combat 面（未定义则休眠不消失）；战斗结束存续 simulation 面（仅 combat 面则清除）；战斗不消耗世界时间故 `duration.turns` 不递减；`combat.battleRounds` 控制战斗内寿命。
4. **战斗面三要素与控制白名单**：combat 面可同时携带控制语义（引擎固定集合：`cannot_act`/`cannot_use_skills`/`cannot_use_items`/`cannot_attack`/`cannot_flee`/`forced_target_self`，OR 合并，`cannot_act` 优先级最高）、数值修正（累加）、DOT/回合结算（`onRoundEnd`）。白名单之外的战斗语义（反射/吸血/复活）V0.1 不做。
5. **HP/MP 共享资源池**：战斗与模拟读写同一池子，战斗结果持久化；战斗是场景子状态不消耗世界时间；回复节奏跟模拟轮次由模板定义；战斗中 HP 默认打到 1 为止，善后由胜负结算效果承担。
6. **判定与公式模板化用 preset 白名单**：V0.1 采用 `opposed`/`fixed`/`scaled` 等预设判定器 + 参数，由引擎内置实现；自由表达式 DSL 因安全风险列入待决项。
7. **状态栏模板化**：状态栏区块由世界模板定义（属性/资源/心情/补正/自定义条目 + 可见性条件）；性别为世界自定义枚举（非二元，如男娘、无性别等档位由 `world.genders` 定义）；心情为角色计量条而非补正。

### 后果

- 模板创作门槛降低（YAML），非程序员可参与世界观设计；代价是引擎需维护完整的 Schema 校验与 preset 白名单。
- **迁移已完成（2026-11-11，与 `TEMPLATE_PROTOCOL_V2.md` §15 同步）**：YAML loader 已上线（server 启动加载 → Zod 校验 → V2 引擎消费 `WorldTemplateV2`）；`jjk.ts`、`game-core/src/data/`、V1 引擎全部源码与测试、V1 类型（`shared/src/legacy.ts`）均已删除。`shared` 只剩 V2 唯一入口，`./legacy` 子路径导出及 `tsconfig.json` / `vitest.config.ts` 的 legacy alias 一并移除。
- **例外保留 `game-core/src/rng.ts`**：它是 V2 共用的确定性 RNG（`v2/{battle,engine,npc,turn}.ts` 均 `import "../rng.js"`），不属于 V1 遗留，继续保留并从 `game-core/src/index.ts` 导出。
- **验收**：`pnpm typecheck` 0 错误；game-core 46/46、shared 23/23；web build 通过；server `/health` 返回 `protocol:v2`、`/api/templates` 正常加载 `jjk-2006`。JJK YAML 与旧 `jjk.ts` 的逐行为等价对照按项目决定未单独补齐，以 V2 全量测试与运行时验证为准。
- 协议以 Zod Schema 为单一事实来源，TS 类型经 `z.infer` 派生；V1 类型已随迁移下线。
- **阅读注记**：本文件其余章节出现的 `legacy time.ts`（ADR-0002 背景）为决策当时的历史背景；ADR-0003 中的「V1 不做…」指组队战斗的第一版实现，均不表示 V1 引擎仍存在。**ADR 编号归属（2026-11-11 用户决定）**：ADR-0003「组队战斗」保持本编号不动；R2 的终止模型 ADR 顺延为 **ADR-0004**、R3 时间穿越 ADR 为 **ADR-0005**，由实施阶段按 `specs/iteration-2026-11-11/tasks.md` 阶段 1 落盘；本轮不引入六阶段 Lifecycle 状态机。
- 所有随机（转盘/战斗判定）必须走注入 seed 的 RNG，保证同 seed 复现；hidden 信息不得进投影，投影规则沿用 ADR 之前的可见性设计。

## ADR-0002 时间系统重写（时间适配器化）+ 属性模型对齐

状态：已接受（2026-11）

### 背景

现行 v2 时间模型沿用 CORE_ENGINE V0.1 的「统一分钟 tick」：`WorldStateV2.worldTime` 为累计分钟数，年龄以 `worldTime / 525600` 硬编码推算；时间换算寄生在 legacy `time.ts`（`toMinutes` 固定单位表 + `resolveLifeStage` 硬编码 13/20/60 年龄阈值），V2 引擎反向 import legacy。这与设计增量第二节「时间类型由模板定义、核心引擎只调时间适配器、不建立统一 Tick」冲突（附录 A 的 A1/A2/A7）。同时存在 `lifeStageSteps` 声明但引擎不消费的规格-实现缺口。

属性模型方面，附录 A 的 A8 提出「通用基础属性 + 世界自定义属性」两层的可能方向，与现行 V2「属性完全世界自定义、HP/MP 为 resources 资源池、公式走 preset 白名单」存在路线张力。

### 决策

时间系统（A1/A2/A7）：

1. **时间类型由模板定义**：世界观在模板中声明时间结构与推进模式，核心引擎通过时间适配器接口调用，不再把公历换算与人生阶段阈值硬编码散落在引擎各处。工程折中：内部时间标量仍以「分钟」为最小公分母（CORE_ENGINE V0.1 建议），历法显示、年龄推进、人生阶段与轮次步长全部由 `TimeAdapter`（`packages/game-core/src/v2/time.ts`）按模板配置决定。
2. **推进模式扩展**：支持相对推进量（沿用）与绝对目标日期（剧情节点推进）两种，由事件/行动声明。
3. **历法模板化 + CalendarAdapter**：`world.yaml` 扩展历法声明位，`CalendarAdapter` 将内部时间映射为模板显示日期；前端时间格式化改为消费适配器输出，移除 `timeText` 内公历硬编码。
4. **解除 V2 → legacy 反向依赖**：时间换算与人生阶段判定抽入独立时间模块（收进 v2），不再由 V2 import legacy `time.ts` 提供 `toMinutes`/`resolveLifeStage`。
5. **人生阶段模板化**：`resolveLifeStage` 阈值改为模板可配置；`lifeStageSteps` 由轮次管线实际消费，修复「声明不消费」缺口。
6. **条件 DSL 与 schedule 语义**：新增时间比较条件；重新定义 schedule 事件在可回拨时间下的触发语义，并预留事件「实例-定义分离」的接口位（时间穿越本身仍放 P4）。

属性模型（A8/A9，附带确认）：

7. **维持纯自定义属性层**：引擎不引入 HP/ATK/DEF/SPD/HIT/EVA/CRIT/CRIT_DMG/RES 等通用基础属性语义；HP/MP 维持 `resources` 资源池模型；`effectiveAttributes` 管线不改。
8. **不内置通用公式**：伤害/命中/暴击不内置固定默认公式；世界观对公式的差异化诉求以扩展 preset 参数满足，维持 ADR-0001 拒绝自由表达式 DSL 的立场。

### 后果

- 重写影响面：`WorldStateV2.worldTime` 的分钟表示、`toMinutes`、schedule `atWorldTime >=` 语义、年龄推算、前端 `timeText`。
- 重写后需回归 JJK 模板与 v2 引擎的行为等价性；同 seed 同指令可复现不受影响。
- 时间穿越（A3）与 Steins;Gate 测试模板仍 P4 单独立项，本 ADR 预留实例-定义分离接口位以避免届时返工。
- `TEMPLATE_PROTOCOL_V2.md` 时间章节（4.1）与属性章节（4.4）在实施阶段随协议修订同步更新。

## ADR-0003 组队战斗（玩家 + AI 友军）—— 待评审草案

状态：待评审（2026-11）

### 背景

现行战斗为「单主角 vs 多敌人」1vN：`BattleState` 只有 `player`（单个镜像）+ `enemies[]`；`Combatant` 以 `isPlayer` 布尔区分敌我；`resolveTargets` 的 `ally` 目标写死为自身。百鬼夜行篇「随五条对战米格尔」「随乙骨迎战夏油杰」因此只能做成主角单挑，队友仅存在于叙事文本。要让队友真正上阵，需把战斗模型从 1vN 扩展为 NvN（玩家 + 友军 vs 敌人）。属于核心战斗数据模型变更，故先评审。

### 决策（草案）

1. **分阵营数组**：`CombatSettle` 与 `BattleState` 新增可选 `allies: CombatUnit[]`（形状同敌人），敌人数组保留。`CombatUnit` 由现有 `BattleEnemy` 泛化（字段不变，按所在数组判阵营）。
2. **阵营化 Combatant**：`isPlayer` 布尔改为 `team: "ally" | "enemy"` + 保留 `isPlayer` 标记主角（日志显示「你」）。
3. **目标按阵营解析**：`ally` → 己方存活单位；`enemy` / `all_enemies` → 敌方存活单位；`self` → 自身。
4. **友军 AI 复用现有权重选技能**（`combatHints.skillWeights`），V1 不做条件化 AI（低血治疗等，见 OPEN_QUESTIONS#13）。
5. **胜负判定**：敌全灭 → 胜利；主角 HP≤1 → 败北（友军可阵亡但不结束战斗，仅不再行动）。
6. **友军为战斗内临时单位**：`finishBattle` 不回写友军状态到世界；只有主角资源/补正持久化（沿用现状）。
7. **友军强度由 `levelScale` 控制**（默认 1），避免五条全盛数值直接碾压。

### 后果

- 影响面：`shared` 战斗类型、`battle.ts`（建场/目标解析/回合流程/胜负/收尾）、`projection.ts`（快照展示友军）、`events.yaml`（百鬼夜行两战加 `allies` + 给 `npc-gojo`/`npc-yuta` 配 `combatHints.skillWeights`）。
- 向后兼容：`allies` 为可选字段，旧模板与现有单挑战斗不受影响。
- 确定性：友军 AI 走注入 seed 的 RNG，同 seed 复现不被破坏。

### 待确认

1. 败北条件：主角阵亡即败（建议） vs 全队覆灭才败。
2. 友军 AI 深度：简单权重（建议 V1） vs 条件化（低血治疗等）。
3. 五条/乙骨的 `levelScale` 取值（避免碾压或过弱）。
4. 是否引入「玩家可指挥友军」的指令（V1 建议不引入，友军全自动）。

## ADR-0004 终止模型：二态 + 标记（不引入 Lifecycle 状态机）

状态：**已接受**（2026-11-11，用户决策 ①；对应 `specs/iteration-2026-11-11/tasks.md` T1-01）

> **编号说明**：ADR-0003 已归属「组队战斗（待评审草案）」，故 R2 终止模型顺延为 **ADR-0004**、R3 时间穿越为 **ADR-0005**（本轮不落盘）。本 ADR 不改动 ADR-0003 草案的任何内容。上游依据：`design.md` §3、§12；`requirements.md` R-TM-01..03 / R-EN-07/08。

### 背景

`WorldStateV2`（`packages/shared/src/v2.ts:148-168`）现有字段为 `id / templateId / seed / turnIndex / worldTime / playerAgeAtStart / player / npcs / flags / firedEvents / chains / pendingEvents / battle / lastWheel / history`，**没有任何「这局是否结束」的表达**。`advanceTurnV2` 是完整的 10 步管线但无终止判定；`finishBattle` 战败后仅把 HP 回写为 1 便继续模拟（`v2/battle.ts:405-407`、`:509`）；`server/store.ts` 无条件 save。

R2 原方案（补充方案 §2/§6）拟引入六阶段 Lifecycle 状态机（`CREATED → OPENING → RUNNING → ENDING → EVALUATING → ARCHIVED`）、`LifecycleState` 顶层字段、`PhaseTransitionLog`、合法迁移表与 `transition() / assertPhase()`。用户 2026-11-11 决定：**模拟终止确实需要新建，但不引入「生命周期」概念**，`R-LC-01..06` 整组 `RETIRED`，由 `R-TM-01..03` 取代。缺失的是「终止」，不是「阶段编排」。

### 决策

1. **`WorldStateV2` 只新增三个并列顶层字段**（与现有字段同级，不新增嵌套对象、不新增枚举）：

   | 字段 | 类型 | 语义 |
   |---|---|---|
   | `openingCompleted` | `boolean` | 开局 `handoff()` 完成后置 `true`；之前拒绝普通轮次推进（R-TM-02） |
   | `termination` | `TerminationRecord \| null` | `null` = 运行；非 `null` = 已终止。**唯一终止事实来源** |
   | `archived` | `boolean` | 归档只读标记；为真时拒绝任何状态写入（R-AR-02） |

   `TerminationRecord = { reason, worldTime, turnIndex, endingId?, source }`，`source ∈ condition | player | battleDefeat | event`；固化后只读，取代 `PhaseTransitionLog`。`DeathRoute = { deathMode: "event" | "direct", deathEventId?, conditions[] }` 只存在于模板，引擎不硬编码。两者定义落在 `packages/shared/src/schema/ending.ts`，**不新增 `lifecycle.ts` / `termination.ts` 模块**。

2. **门禁集中于 `assertActive(state)`**：在 `advanceTurnV2` 入口调用。`openingCompleted === false` ⇒ `NOT_ACTIVE`；`termination !== null || archived === true` ⇒ `TERMINATED`；两者都返回可诊断结果且**逐字段不改变世界状态**。终止条件只在明确的模拟边界检查（事件结算后 / 时间推进后 / 玩家主动结束，R-EN-02），命中后**先结算完当前事件**再写 `termination`，不产生半更新状态（R-TM-01）。

3. **终止写入唯一入口 `v2/ending.ts`**：`markTerminated(state, rec)` 幂等且不可逆——重复调用返回同一 `TerminationRecord`、不追加记录、不改写世界状态（P2）；`checkTermination()` 同样归 `ending.ts`。轮次引擎、事件引擎、UI 与 server 均不得自行判定「游戏是否开始或结束」；但这**不需要**额外的阶段编排模块。

4. **归档只读**：`v2/archive.ts` 组装最终快照、事件历史、结局、评价与 `TerminationRecord` 后置 `archived = true`；`v2/life-evaluation.ts` 只读过程记录，不回写 `state.player` 或结局（P3 / R-EV-06 / R-AR-02）。沿用现有存档机制，不新增独立存档子系统。

5. **HP 与死亡结局解耦**（用户决策 ④，P9）：模拟中玩家 HP 始终 `>= 1`（现有 `battle.ts:405-407 / :509`、`engine.ts:269` 的 clamp 保持），**HP 不得作为终止条件或死亡判据**。战败（`over = "defeat"`）且模板死亡条件满足时，按 `deathMode: event` 生成模板死亡事件走既有 chains 结算后触发结局，或按 `deathMode: direct` 直接触发结局；两条路径都不改写 HP、不新增事件类型枚举、都统一走 `markTerminated()`；战败但条件不满足则继续模拟。NPC 侧死亡实体语义仍属未决（OPEN_QUESTIONS #21/#22），本轮不在引擎层增加存活状态机。

6. **明确否决替代方案「六阶段 Lifecycle 状态机」**：

   | 六阶段状态机提供 | 玩家/系统真正需要 | 本 ADR 的表达 |
   |---|---|---|
   | `CREATED` / `OPENING` 枚举与门禁 | 开局没跑完不能推进轮次 | `openingCompleted` + `assertActive()` |
   | `RUNNING → ENDING → EVALUATING → ARCHIVED` 迁移链 | 条件命中后停止行动、结算完当前事件、固化状态 | `TerminationRecord` + 幂等 `markTerminated()` |
   | `PhaseTransitionLog` / 合法迁移表 / 阶段序列回放 | 归档后只读、评价不回写 | `archived` 只读标记 |

   否决理由：三条玩家可见行为全部可由二态 + 标记表达；状态机会额外引入 1 个模块、1 个顶层嵌套对象、1 套迁移表与阶段日志、6 条需求，以及协议/UI 对 `phase` 的感知，并使 `R-NFR-01` 的回放断言依赖阶段序列。退役后 P2/P3 改写为「终止幂等 / 归档只读」，新增 P9（HP ≥ 1）。R3 时间穿越的三个 seam（事件实例-定义分离、时间适配器不写死单调假设、投影 `visibility` 过滤）**均不依赖 phase**，故本决策不会堵死 R3。

7. **禁止产物**：`lifecycle.ts`、`Phase` 枚举、`LifecycleState`、合法迁移表、`transition()` / `assertPhase()`、`PhaseTransitionLog`、阶段序列回放断言。由 T2-03 静态边界检查纳入 `pnpm test` 强制执行（R-TM-03）；`ending.ts` 静态检查不得读取 HP 作为死亡判据。

### 后果

- **影响面**：`shared/src/v2.ts`（三字段 + Zod schema）、新增 `shared/src/schema/ending.ts`、`game-core/src/v2/ending.ts` / `opening.ts` / `archive.ts` / `life-evaluation.ts`、`v2/turn.ts` 入口门禁、`server/store.ts` 归档只读、`web` 投影展示终止状态。改动前先有本 ADR（AGENTS.md §0）。
- **向后兼容**：三个字段均有默认值（`false` / `null` / `false`）；旧存档按默认值补齐，现有单挑战斗、事件链与 schedule 行为不变。
- **确定性**：`R-NFR-01` 的同 seed 回放逐字段相等**不含阶段序列**；`markTerminated()` 幂等保证终止后状态稳定；装备动态补正与 AI 决策继续走注入 seed 的 RNG。
- **本轮不交付**：时间穿越、`WorldLineRecord`、`jumpTo()`、ADR-0005、Steins;Gate 穿越剧本，以及任何阶段状态机。

### 验收

- 正常终止 / 重复终止 / 终止后写状态三类测试通过（T2-01，P2/P3）；`NOT_ACTIVE` / `TERMINATED` 被拒且世界时间与事件历史不变（T2-02）；现有 v2 回归测试全绿。
- T2-03 静态检查失败时能指向具体文件；死亡路径 `event` / `direct` 各有测试且 HP 不被改写（T4-01/02，P9）。
- `pnpm typecheck` 0 错误、`pnpm test` 全绿；`docs/OPEN_QUESTIONS.md` #27 编号冲突登记为已解决。


