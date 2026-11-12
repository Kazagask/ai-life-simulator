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



### 变更记录（2026-11-11，T5-01 装备分域落地）

- `V2Player` 新增**可缺省**字段 `equipment?: EquipmentInstance[]`（协议 §19 / R-EQ-02）：缺省语义为 `[]`，旧存档与旧模板不受影响；本字段为 T5 轮次唯一允许的状态结构变更，不改动本 ADR 的既有三字段（`openingCompleted` / `termination` / `archived`）与门禁语义。
- 装备实例**只存本局状态**（`instanceId / itemId / ownerId / slot / stacks? / durability?`），不存任何补正结果字段；动态补正每次经 `evaluateDynamicModifier` 现算进 `effectiveAttributes` 运行时累加链（基础值 → 状态补正 × 层数 → 装备动态补正 → 心情档位 → caps），不写回 `state.player.attributes`（P8）。
- `equipItem` / `unequipItem` 穿脱操作为纯函数（失败返回可诊断错误码、状态不变）；初始装备经 `equipment.yaml` 的 `initialEquipment` 在 `createWorldV2` 注入，实例 id 确定性生成，同 seed 回放补正序列逐次相等（R-EQ-05 / R-NFR-01）。

### 变更记录（2026-11-11，阶段 4 遗留 #29 / #30 接线）

- **终止 → 结局管线接通**：新增 `terminateWithEnding()`（`v2/ending.ts`）。存在的理由是 `markTerminated()` 幂等且 `applyTermination()` 不决胜结局——先写 `termination` 再补 `endingId` 会被幂等门丢掉。该函数在**同一状态快照**上先 `resolveEnding()` 再一次性 `markTerminated()`，避免「已终止但无结局」的半更新态。
- **判定边界**（R-EN-02）：`advanceTurnV2` 在时间推进 / 事件结算 / 年龄重算之后判定（`afterTimeAdvance`）；`chooseOptionV2` 在选项结算后（`afterEventSettle`）；`battleActionV2` 在战斗结算后（`afterBattleSettle`，先走死亡路径再走终止条件）；`useItemV2` 在物品效果结算后。结算中途不判定。
- **配置注入**：新增 `TurnPipelineConfig { endingConfig?, evaluationConfig? }` 作为轮次函数的**可选尾参**。不传时行为与接线前逐字段一致（零终止条件 = 永不终止）；内核不读文件，配置由 `apps/server` 从 `endings.yaml` / `evaluation.yaml` 注入。
- **死亡路径接线**：战败且 `deathRoute.conditions` 命中时走 `applyDeathRoute`（`direct` / `event` 两路径不变），判死仍只看 `battleDefeat` 信号，不读取 HP（R-EN-07 / P9）。
- **主动收束**：轮次命令新增可选 `endLife?: boolean`，映射为边界信号 `playerRequested`；模板需声明 `type: playerRequested` 的终止条件才会生效。此为本轮新增的命令字段，不改变既有请求形状（省略即默认行为）。
- **投影**：`V2Snapshot` 新增可选 `status: "running" | "terminated" | "archived"` 与 `ending: EndingView | null`；终止/归档后 `pendingEvent` 置 `null`、`availableActions` 置空。hidden 结局即便命中也不外泄模板文案（title/summary 掩码、`evidenceIds` 置空），仅保留 `endingId` 与 `visibility`（R-EN-05 / R-NFR-04）。
- **装备投影**：`snapshot.player.equipment` 下发实例展示字段（`instanceId / itemId / slot / name / slotLabel / stacks? / durability?`），**不含任何补正结果**（R-EQ-04 / P8）；前端已有装备栏由此获得数据源。
- **归档封存**：`worldStore.seal()` 作为 `save()` 的唯一例外通道，仅接受已终止世界；`save()` 的 archived 拒写门禁不变（R-AR-02）。新增 `POST /api/worlds/:id/archive`，幂等。
- **内容**：`jjk-2006` 新增 `endings.yaml`（寿终 / 战败 / 星浆体三支线 / 主动收束 / 兜底 / 1 个 hidden）与 `opening.yaml`（东京 / 京都两开局，待决事件引用真实事件 id）。

## ADR-0006 结局可见性 DSL 化：删除 `EndingTemplate.visibility`，统一 `unlockConditions` + `narrativeConfig.masked`

状态：**已接受**（2026-11-11，用户裁决：「隐藏结局是业务语义，工程上应该是模板 DSL 条件配置」）

### 背景

`EndingTemplateSchema.visibility: "public" | "hidden"`（`packages/shared/src/schema/ending.ts:124`，缺省 `public`）有两个消费点：

1. **门控**（`v2/ending.ts:239`）：`visibility === "hidden"` 时要求 `unlockConditions` 全满足才进候选集；**public 结局的 `unlockConditions` 被静默忽略**——同一字段配在不同结局上语义不同，是配置陷阱。
2. **投影掩码**（`v2/projection.ts:182`）：命中的 hidden 结局 title/summary 被替换为**引擎硬编码**文案（「未公开的结局」），`evidenceIds` 置空；`EndingView.visibility` 下发给前端（`apps/web/src/main.tsx:517/523`）用于样式与「隐藏结局」标注。

问题：门控本质是 DSL 条件（`unlockConditions`），却与 `visibility` 枚举耦合——hidden + 空 `unlockConditions` 静默放行，public + 非空 `unlockConditions` 静默失效；掩码文案属表现层关注点，却硬编码在引擎里且不可配置。

### 决策

1. **删除 `EndingTemplateSchema.visibility` 字段**。strict schema 下含该字段的旧模板将被加载期拒绝；仓库内模板与测试夹具同步迁移。
2. **`unlockConditions` 统一语义**：任何结局，非空 `unlockConditions` 必须全部满足才进候选集（`checkAllConditions([]) === true`，空数组即现状，向后兼容）。隐藏/公开不再参与门控判定。
3. **掩码改为叙事配置**：`narrativeConfig.masked?: { title?, summary? }`（strict）。**存在 `masked` 即隐藏结局**（业务语义由模板声明）；掩码文案取 `masked.title / masked.summary`，缺省回退引擎默认文案（与原硬编码一致）；命中的掩码结局 `evidenceIds` 置空不变。
4. **`EndingView.visibility` 保留为玩家端派生输出**：投影层按「是否套用掩码」派生 `"hidden" / "public"`，前端消费不变。它是"达成记录的显示标志"，不是模板配置。
5. 隐藏语义只存在于结局——与 OPEN_QUESTIONS #33 裁决（事件无隐藏语义）同口径。

### 后果

- **玩家可见行为不变**：jjk-2006 唯一 hidden 结局（end-sp-aware）的 unlockConditions 门控与掩码文案随模板迁移，投影输出逐字段一致。
- **影响面**：`shared/src/schema/ending.ts`、`game-core/src/v2/ending.ts` / `projection.ts`、`specs/data/templates/jjk-2006/endings.yaml`、`TEMPLATE_PROTOCOL_V2.md`（§21 结局字段表与示例）、相关测试；R2.3 规格中"按结局 `visibility` 继承"的措辞改为"按结局叙事掩码继承"。
- **ADR 编号**：本 ADR 占用 0006；R2.3 计划中的持久化 / 时间跨度 ADR 顺延为 **ADR-0007 / ADR-0008**。

## ADR-0007 存档持久化：JSON 文件原子写，仓库根可挂载数据目录

状态：**已接受**（2026-11-11，T1-01）

### 背景

`apps/server/src/store.ts:15-16` 的 `worlds` 是纯内存 Map，重启即清空；前端已把 `worldId` 存 localStorage 并启动续玩（`main.tsx:1149-1169`），缺的是服务端持久层。R-PS-01..07 要求落盘，且用户裁决：**数据目录不得在 `apps/server` 下，必须可挂载**。

### 决策

1. **存储介质：JSON 文件 + tmp→rename 原子写**。零新增 npm 依赖（DoD 第 6 条）；可读、可手改、便于调试取证。
2. **数据目录**：默认 `<仓库根>/data/worlds/`，由 server 模块位置上溯解析，**不依赖进程 cwd**；环境变量 `LIFE_SIM_DATA_DIR` 可覆盖为任意绝对路径（Docker volume / NAS 挂载点）；`.gitignore` 追加 `/data/`。
3. **信封结构**：`{ schemaVersion: 1, savedAt, templateId, templateFingerprint, state }`，单局一文件 `<worldId>.json`。`schemaVersion` 现为 1，格式不兼容变更时递增。
4. **模板指纹**：模板目录内全部 YAML 按文件名排序拼接 `name + "\0" + content` 后 sha256，加载时缓存。**指纹不匹配 → 拒绝加载**（记录 error 并跳过该档，不阻断启动）——模板是权威语义的一部分，"悄悄加载出行为漂移的存档"比"旧档作废"更危险；被否决的备选是"警告并加载"。
5. **加载校验四道关**：JSON.parse → `schemaVersion === 1` → 指纹一致 → `WorldStateV2Schema.safeParse`（新建于 `packages/shared/src/v2-state.ts`，与 TS 接口双向类型断言防漂移）。任一不过 log.error 跳过。
6. **写入口收口**：落盘在 `worldStore.save()` 与 `seal()` 内实现（`save()` 已被全部写入口调用）；失败删 tmp 并抛错，不吞异常。
7. **归档只读**：加载后的 archived 世界仍走既有 `save()` 归档门禁（R-PS-06），`seal()` 是唯一例外通道。
8. 列表 `GET /api/worlds`（savedAt 倒序）与 `DELETE /api/worlds/:id`（删文件 + 删 Map）由 server 提供；删除确认由前端负责。

### 被否决的备选

- **`node:sqlite`（Node 22 内置）**：实验性 API（22.5+ 需 flag），跨 Node 版本不稳。
- **`better-sqlite3` / `pg`**：新增 npm 包，破 DoD 第 6 条。
- **只存 seed + 命令日志回放**：模板一改回放即不一致；启动即重算，加载变慢。

### 后果

- 新增约 200 行 `WorldStateV2Schema` + 一条往返一致性测试（R-PS-07）——加载磁盘文件本质是处理不可信输入，这步不能省。
- 全量重写（无增量/事务），当前规模 10² KB 量级，Node 单线程同步写无撕裂。
- 迭代期每次改模板 YAML，旧档作废（指纹拒绝）——接受该代价，模板稳定后可引入迁移机制。
- 与 `R-AR-03` 的关系：R-AR-03 说"首版沿用现有存档机制"，本轮把该机制从内存补成落盘，不是新增独立存档子系统。

## ADR-0008 背包与装备栏物理分离：库存只存未穿戴物品

状态：**已接受**（2026-11-11，R2.4 用户裁决）

### 背景

R2.3 交付装备穿脱后用户实测发现两个问题：

1. **卸下即遗失**：`initialEquipment`（equipment.yaml 初始装备）授予的实例**不在背包里**（`turn.ts` 只把 `playerTemplate.items` 写入 `inventory`），卸下后实例被删除、背包又没有计数，物品凭空消失。
2. **装备重复出现在物品栏**：`inventory` 计数是"总持有量"，穿上装备不扣减，导致同一件装备同时出现在物品栏与装备栏。

### 决策

1. **`inventory` 语义改为「背包 = 未穿戴物品」**：装备穿脱是背包与装备栏之间的**物理移动**——穿上时背包 `count - 1`（归零删键），卸下时背包 `count + 1`。同一件物品不会同时存在于两栏。
2. **`equipItem` / `unequipItem` 纯函数返回值扩展为 `{ equipment, inventory }`**，编排层（`equipV2` / `unequipV2`）把两者一起写回；失败不写任何状态。
3. **`initialEquipment` 是独立的穿戴授予，不从背包扣除**：模板若同时在 `playerTemplate.items` 写了同一 itemId，玩家得到「1 件穿戴 + 1 件备用」。卸下后按常规回流背包（修掉"卸下即遗失"）。
4. **条件 `{ inventory: X, gte: n }` 语义随之变为「背包内数量」**，不再等于总持有量；模板需要"不论穿脱都算持有"时应使用装备相关条件或 flag（协议 §12 注记）。
5. **投影补齐槽位定义**：`V2Snapshot.equipmentSlots[]`（id / label / maxCount / allowedCategories）由模板 `equipment.yaml` 下发，前端据 `maxCount` 渲染固定格数、据 `allowedCategories` 过滤可装备物品，**不从已装备实例反推槽位**（否则空槽消失）；装备实例与背包条目补充 `description / category / quality / slotLabel` 展示字段（不含任何补正结果，P8 不变）。
6. **前端交互（用户裁决 ③）**：装备栏与物品栏均为**方格**，选中后由统一的详情区展示说明与操作——装备/卸下操作在装备页完成（空槽详情列出背包内可装备物品），使用操作在物品页完成。

### 被否决的备选

- **inventory 保持"总持有量"、仅前端隐藏已装备条目**：初始装备不在背包的旧数据仍会遗失；且 `count - wornCount` 的隐式算术分散在展示层，容易漂移。
- **卸下时凭空补一条背包计数**：与"装备不动背包"的旧语义叠加会造成双份计数。

### 后果

- 旧存档（R2.3 及以前）中已装备且背包同 id 计数 ≥1 的物品，加载后会出现"1 件穿戴 + N 件背包"——计数语义变化属模板指纹保护范围内（模板未变，存档照载）；无自动迁移，用户重开即可。
- `schema/ending.ts` 等无关分域不受影响；战斗内物品列表、`grantItem` 效果、使用消耗逻辑不变（它们本来就是背包语义）。
- 快照新增 `equipmentSlots` 与若干展示字段；`packages/shared/src/v2.ts` 类型已同步，旧调用方不受影响（全部为可选/追加字段）。

## ADR-0009 个人面板模板化（DNF 式）：槽位摆位 + 背包分区

状态：**已接受**（2026-11-11，R2.4 用户二次裁决）

### 背景

R2.4 第一轮交付后用户补充两点：① 背包里装备和物品要**分区**（像 DNF 的背包分页）；② 个人页按 DNF 的「背包 / M 人物面板」思路设计。并追问：**装备栏是否模板化**——能装备多少东西必须由模板决定。

### 决策

1. **装备容量本来就模板化**（R2.3 已落地，此处确认并补文档）：`equipment.yaml` 的 `slots[]` 条数 = 槽位种类，每项 `maxCount` = 该槽可同时穿戴件数，`allowedCategories` = 该槽接受品类；装备定义在 `items.yaml` 用 `slot` 指槽。引擎与前端都不写死。
2. **新增槽位摆位字段 `panelSide: left | right | bottom`（可选，缺省 `bottom`）**：只影响人物面板的视觉摆位——左列 / 右列 / 底部方块区。加载期 Zod strict 校验，非法取值拒绝、不静默降级。未声明时退化为旧的「槽位方块横排」，老模板行为不变。
3. **个人页重排为「角色 / 背包 / 技能」三页签**（原「装备 / 物品 / 技能 / 面板」四页签，面板内容并入角色页）：
   - **角色页 = 人物面板**：左列（panelSide=left 槽位）+ 中央人物（名字 / 年龄性别 / HP·MP 紧凑条 / 人生阶段）+ 右列（panelSide=right），底部锚定槽位排在面板下方；下方属性网格 + 状态 + 摘要 + 详情区。
   - **背包页 = 分区背包**：装备 / 消耗品 / 材料 / 其他（key）四个分区页签（带数量徽标），每区独立方格；切分区清空选中。分区按 `item.type` 划分，**分区集合是前端展示约定**，不进模板（模板尚未出现"自定义物品大类"的需求，出现时再模板化并走 ADR）。
4. **背包与装备栏互斥语义不变**（ADR-0008 维持）：穿在身上的装备只在人物面板出现，背包各分区只显示未穿戴物品。

### 被否决的备选

- **摆位写死在前端**（如"第一个槽放左列"）：不同世界槽位结构不同（示例模板 B 组护甲分部位），前端无法推导合理摆位；摆位是模板作者的叙事选择，必须进模板。
- **背包分区集合模板化**：当前四种类型已覆盖 Schema 白名单，无自定义需求；过早模板化增加模板负担。

### 后果

- `EquipmentSlotSchema` 新增可选 `panelSide`；模板指纹随之变化，**旧存档（含 R2.4 第一轮测试档）被指纹拒载**，需重开（既定设计，迭代期接受）。
- 快照 `equipmentSlots[]` 每项恒带 `panelSide`（缺省 bottom），前端 `buildSlotCells` 据此分列。
- 测试 +2：模板声明 panelSide 时投影按声明下发；非法取值加载期拒绝。

## ADR-0010 配置/实例/事实三层分离

状态：**已通过（2026-11-12 G1 评审）**（2026-11-11 R2.5 起草；对应 `specs/iteration-2026-11-11-r25/design.md` §1/§2；评审修订与第二批裁决已逐条并入正文，见文末「第二类裁决回填（2026-11-12 第二批）」）

### 背景

现状事件与 NPC 侧存在系统性三层混杂（design.md §1 M1-M10 逐条核实）：`resolveScheduleV2`（`v2/turn.ts:374-383`）把模板事件当调度器每轮全量扫描，调度没有实例可回溯；`firedEvents` 只存 turnIndex，冷却绑定轮次维度；`flags` 同时承载模板语义 flag、NPC 行动冷却、投影状态、开局排程补丁、冗余轮次计数五类东西，模板条件 DSL 可以读到引擎内部记录；`ChainStateV2.stepIndex` 是派生状态却存成事实且有双写入口（`engine.ts:370-375` 与 `turn.ts:302-305`）；`EventInstanceSchema` 存在但 `handoff()` 只写 `flags["openingScheduled:*"]`，运行时调度不消费实例；NPC 年龄静态、relationship 单值混合好感/亲属/师承、isEnemy 与 visibility 语义重叠。用户裁决：**先梳理清楚配置、实例、事实再编码**。

### 决策

1. **三层模型与读写硬约束**（design.md §2）：
   - **配置层** = 模板 YAML（Zod strict、只读、指纹保护）。只允许在两个时刻被读：入队/实例化时（固化判定参数）、条件求值时（读定义结构）。**调度循环不得遍历 `template.events`**，只遍历 `state.scheduledEvents`。
   - **实例层** = 本局对象（事件实例、待决事件、链实例、NPC、战斗、装备），有 id、有 status、可序列化，写入口收口（调度唯一入口 `v2/scheduler.ts`、链推进单一规则）。
   - **事实层** = 只追加记录（history、`eventFires: Array<{eventId, turnIndex, worldTime}>` 触发日志、`missedEvents`、`relationLog`）。**注意：现 `firedEvents`（按 eventId 覆盖写"最近一次"）不是合法的事实形态**——覆盖违反 R-LM-03「事实只追加、逐字段不变」；拆为两层：append-only 的 `eventFires[]` 日志 + **派生索引 `lastFiredIndex`（显式标注为可重建缓存、不是事实）**承接 once/冷却/结局 `eventOccurred`（`v2/ending.ts:134`）的按 id O(1) 查询；索引与日志不一致时以日志为准重建。事实的合法消费只有三种：条件求值的只读输入、投影展示、结局证据。**事实不得反向驱动调度**——触发只能来自玩家行动、效果 DSL、延时队列到期。
2. **flags 拆分**：`flags` 定位收窄为「模板语义黑板」（setFlag/adjustFlag/clearFlag/FlagCondition 的专属域）；系统内部记录全部迁出——`npcAction:*` 迁 NPC 实例冷却记录（R2.6）、`infoVisibility:*` 迁 NPC 实例字段（R2.6）、`relationSource:*` 迁关系边 source（R2.6）、`openingScheduled:*` 被延时队列实例取代（R2.5 删除）、`turnsPlayed` 删除（≡ turnIndex）。
3. **调度判定器纯函数化**：`evaluateDue(instance, worldTime, facts)` 输入全显式、无隐藏读取，保证确定性可测。
4. **配置域只读字段与配置层边界（2026-11-12 G1 评审修订并入）**：六字段 `probability/weight/once/priority/conditions/onActionId` 经代码核查确认为**配置域只读**（`schema/event.ts:13-43` 定义、`turn.ts:329-383` 只读、从不写入状态/存档）；**事件实例不得复制它们**（原 `snapshot` 设计作废）。配置层 ≠「只能有 yaml 文件」，但**运行时不生成新的配置层模板定义**：刷新规则写 yaml（配置）→ 世界初始化把规则**实例化**为 `SpawnRuleInstance`（实例层、进存档）→ 事件效果 `spawnNpc(ruleId)` 依规则建 NPC 实例（`unspawned → alive`）并只追加 spawn 事实（R-LM-04）。**2026-11-12 第二批裁决 #46 关闭：用户明确「不做」**——运行时按 seed 生成**配置层模板定义**的能力不实现（更强形式「须确定性、不参与指纹、先写 ADR」的候选 B 作废）；常规路径保留并归 R2.6。
5. **世界时间精度（2026-11-12 G1 评审修订 + 第二批 #45 裁决并入）**：世界时间为**整数分钟**（`number`）；无限期窗口用 `undefined` + 显式 `hasEnd` 标记，**删除 `MAX_SAFE_INTEGER` 数值哨兵**。**#45 裁决「保持现状、下期决策」：本轮不加 `MAX_WORLD_TIME = 2^52` 上界拒载、不加 `{epochIndex, minuteInEpoch}` 双字段/BigInt**，`worldTime` 维持现状（number 分钟）；`R-LM-05` 本轮验收口径收缩为「整数分钟 + `hasEnd` 无数值哨兵」，上界校验与年号/纪元 `CalendarAdapter.format` 渲染随 #39/#43 下一期（R2.6）首批一并验收。

### 被否决的备选

- **保留每轮全模板扫描（现状）**：零改动成本，但调度无实例可回溯（R3 时间回拨时无法判断"哪些排程实例已触发/已过期"），窗口结束/相对时间/错失语义全部无法表达；且 O(n) 扫描随模板增长无界。用户明确要求梳理后再编码，此备选与诉求直接冲突。
- **只给 flags 加命名空间约定（前缀规范）而不迁出**：模板条件 DSL 仍可读引擎内部记录，层级墙依然被穿透；键名字符串拼接依旧无 schema 保护。治标不治本。
- **事实层完全只读、连冷却/once 判定也不读**：不可行——once/冷却本质是"历史事实约束未来触发"，必须以事实为只读输入；本 ADR 把"只读输入"划为合法消费，禁止的是"事实作为触发源反向驱动调度"。

### 后果

- 影响面：`shared/src/v2.ts`（新增 scheduledEvents/enqueueSeqCounter/missedEvents/relationLog/eventFires/lastFiredIndex，旧 `firedEvents` 下线）、`game-core/src/v2/scheduler.ts`（新）、`turn.ts`/`engine.ts`/`opening.ts`/`npc.ts`/`projection.ts` 写入点迁移、模板 events.yaml/characters.yaml 随指纹升级。
- 确定性：调度与判定全部纯函数化、RNG 消耗顺序固化入规范；同 seed 结果序列相对 R2.4b 会改变（一次性，见 ADR-0011）。
- 迁移成本：schemaVersion 1→2，旧存档拒载（与模板指纹拒旧档叠加，迭代期接受重开）；jjk-2006 模板迁移量小（无 atTurn、全链 onSettle）。
- R3 seam：调度从模板扫描改为实例队列，时间回拨只需对实例重算到期，**加强**而非封死穿越预留。

## ADR-0011 事件触发收敛为立即/延时两类 + 时间窗口队列

状态：**已通过（2026-11-12 G1 评审）**（2026-11-11 R2.5 起草；对应 `design.md` §3；评审修订与第二批裁决已逐条并入正文，见文末「第二类裁决回填（2026-11-12 第二批）」）

### 背景

现行 `EventTriggerSchema.source` 四值（pool/chain/schedule/action-hook）混入了两种不同概念：触发时机（schedule/action-hook）与抽取来源（pool）。`atTurn`（x 轮后）无法换算为世界时间（轮次时长由行动/人生阶段决定不可预知）；`cooldownTurns` 把轮次当时间单位；`resolvePoolV2` 抽中即立即呈现，无延时语义。用户裁决：轮次槽位唯一；触发分立即/延时两类；延时按绝对时间窗口入队、出队判定，排序 `start asc → end asc（空视为最大）→ 入队顺序`；退役 x 轮后触发；pool 只能触发延时事件。

### 决策

1. **触发分类收敛**：立即触发 = `action-hook`（**保留旧名不改名**，Q-R25-01 关闭；未声明 `window/delay`）+ `chain`（无 `delay` 的步骤）；延时触发 = 声明了 `window/delay` 的 `action-hook`、`chain` 延时步、`schedule`（世界初始化/效果入队）、pool 抽中实例。**立即/延时的判据是「是否声明时间窗」，不是 `source` 取值**；`action-hook` 与 `chain` 延时步均可入队。`pool` 降格为抽取器：门控通过才入延时队列，不得立即呈现。
2. **时间窗口队列**：`WorldStateV2` 新增 `scheduledEvents: ScheduledEventInstance[]`（instanceId/definitionId/origin/chainId?/window{start,end?}/enqueuedAt/enqueueSeq/status/**无 snapshot**）与 `enqueueSeqCounter`。**`TimeExpr` 二分支收敛为单一 `TimeSpec`**（默认相对**入队时刻**，兼容时间格式；删除 `absolute/relative` 二分支，OQ-#37 关闭）：**入队即换算固化**为分钟窗口（回拨/前拨不影响已固化窗口）。**#44 方向定 A、实现延期**：用户原话「符合事件+字面量」按「**复合时长 + 字面量**」解读（候选 A：`3d`/`2h30m` 复合时长 + 历法日期字符串字面量，文档须注明这是对原文的解读）；实现与 #39/#43 一并排下一期；**本轮 `TimeSpec` 只实现 `TimeAmount {value, unit}`，字符串语法只留 `CalendarAdapter.parseTimeSpec` seam、不做加载期解析**。排序键严格 `start asc → end asc（undefined ≡ +∞）→ enqueueSeq asc`，`enqueueSeq` 全局唯一保证全序与排序稳定性（design.md §3.3 证明）。
3. **drain 与判定（评审修订 + #36 裁决并入）**：三个 drain 入口（轮次推进后、效果推进时间后、入队即到期）；循环取队首，`start > now` 即停（有序队列）。**入队门控前置**：六策略（`once`/`probability` + pool 的 `conditions`/`weight`/`priority`）在候选产生时决定是否入队，失败**不产生实例、不构成错失**。出队判定固定为 `missWhen`（drop，`miss_when`）→ `conditions` 终判（hold）→ `cooldown`（hold）→ fire；`MissReason` 收缩为 `window_expired | miss_when`（OQ-#42 按推荐 ① 通过）。**#36 关闭，采用候选②「留在队列」**：窗口内 `conditions`/`cooldown` 不满足一律 **hold 留队、每轮 drain 重估、不记错失**；仅当 `worldTime > window.end` 才出队并追加 `reason="window_expired"` 的错失事实；无 `window.end` 永不因时间过期，由显式 `missWhen` 兜底（R-EV-12/#42）；门控失败不构成错失。原「once→conditions→cooldown→probability 出队判定」与「概率失败丢弃」表述作废。
4. **退役**：`atTurn` 删除（现存模板零使用，但 v2.test.ts:737/768 夹具在用，需换形迁移）；`cooldownTurns` 改 `cooldown: TimeSpec`（时间维度，依赖 `firedEvents` 两层拆分：`eventFires[]` 日志 + `lastFiredIndex` 派生索引）。补正 `duration.turns` 与 NPC 行动冷却本轮不动（Q-R25-04）。
5. **槽位唯一 + #35 加载期强制（评审修订 + #35 裁决并入）**：`pending_event_required` 守卫语义收窄为"槽位被占用时拒绝新自由行动"；立即事件的呈现排队沿用既有 `EVENT_SOURCE_PRIORITY`，不新增排序结构。**事件结算推进轮次**（OQ-#34 关闭）：新增 `timeCost`（缺省 0）、战斗结束算结算轮、用物品暂不算、事件轮跑完整管线、同窗多事件逐轮各占一槽（R-EV-14），RNG 序列变更范围随之扩大。**#35 关闭：同一轮至多一个立即触发事件采用候选①「加载期静态拒绝」（`superRefine`）**，并显式豁免延时事件——只统计「未声明 `window`/`delay` 的立即 `action-hook`」并按 `onActionId` 分组，同组 ≥2 条才报错；声明了 `window`/`delay` 的 `action-hook`（延时）、`chain` 延时步、`schedule`、`pool` 全部不受约束（延时事件不占同一轮槽位）；错误信息须提示「可为后续 hook 声明 window/delay 转为延时」。
6. **链组合**：`ChainStep.delay?: TimeSpec` 表达"3 天后触发"；链断链判定 `evaluateChain()` 纯函数——链 active 的充分条件之一是时间队列存在该链的未触发实例（修复 stepIndex 双写漂移的结构性风险）；`advanceWhen: nextTurn` 保留（"下一轮"是槽位语义，非 x 轮后，Q-R25-06）。

### 被否决的备选

- **用轮次做延迟（保留 atTurn + cooldownTurns）**：轮次时长不可预知（rest 一轮 8h、冒险一轮 1h），"3 轮后"在不同行动序列下时间跨度完全不同，无法满足用户"按绝对时间窗口"的诉求；且轮次延迟在时间穿越场景下语义崩溃。**会改变同 seed 结果**：任何与 R2.4b 兼容的混合方案都不成立，本 ADR 显式接受 RNG 序列一次性变化。
- **不引入队列入队序号、仅靠数组插入顺序**：数组顺序在取消/过期/重排序后不可靠，无法保证同键条目的确定定序；enqueueSeq 是廉价的确定性 tie-breaker。
- **事件栈/未来事件队列另建调度结构**：违反"映射到既有结构不新增调度器"约束；本决策的 scheduledEvents 是实例层状态而非新的调度器模块，drain 复用既有管线位次（步骤 3）。
- **概率失败留队重试**：每轮重掷消耗 RNG、概率语义失真；一次性判定 + 错失事实可查询、可投影（"你错过了…"）。

### 后果

- 影响面：`schema/event.ts`、`schema/event-instance.ts`（统一实例 schema）、`schema/common.ts`（`TimeSpec`，取代原 `TimeExpr` 二分支）、`v2/scheduler.ts`（新）、`v2/turn.ts`（删 resolveScheduleV2 全模板扫描、pool 改入队、onCooldown 改时间维度）、`v2/opening.ts`（handoff 真入队）、jjk-2006 events.yaml。
- **确定性声明**：drain/pool 的 RNG 消耗顺序与 R2.4b 不同，**同 seed 事件序列与转盘结果会改变**——新行为完全可复现，但旧回放断言需重录、旧存档拒载（schemaVersion 2）。
- 迁移成本：strict schema 下旧字段加载期即拒绝，模板随指纹一并升级；jjk-2006 迁移量小（1 schedule、5 pool、1 action-hook、~20 chain 全 onSettle、无 atTurn）。

## ADR-0012 NPC 生命周期与投影解耦 / 出生时间与年龄派生

状态：**已通过（2026-11-12 G1 评审）**（2026-11-11 R2.6 起草；对应 `design.md` §4；评审修订与第二批裁决已逐条并入正文；实施归下一期 R2.6，见文末「第二类裁决回填（2026-11-12 第二批）」）

### 背景

NPC 现无任何存活状态：死亡/失联的 NPC 照样被效用评分选中去行动（`npc.ts` 只跳过 `isEnemy`）；`identity.age` 是创建时静态快照永不更新；`relationship` 单值混合好感/亲属/师承；`isEnemy` 与 `visibility: public|hidden` 语义重叠。用户裁决：① 投影与生命周期解耦（开局已死亡的重要角色也可上屏）；② NPC 完整生命周期 spawn-alive-dead，默认判活且不与业务语义耦合（失联也是 dead）；③ 年龄动态计算、NPC 挂出生时间、支持三种时间模型；④ 关系模型拆分 affinity 与类型化边，亲属/师承由 parents/masterId 推导。

### 决策

1. **生命周期字段**：`V2Npc.lifecycle = { state: "alive" | "inactive" | "unspawned", reasonCode?, sinceTurn, sinceWorldTime }`。**引擎只判 `alive`**，`reasonCode` 是模板自由字符串（dead/missing/sealed…），**引擎不得对 reasonCode 分支**；"死人才能…"的业务语义由模板条件表达（新增 `{ npcState: { npcId, state } }` 条件，只匹配状态不匹配 reasonCode）。不引入 lifecycle.ts/阶段枚举（ADR-0004 禁令继续有效）——这是角色级三态字段，不是流程编排。
2. **默认判活四处**（模板零书写）：NPC 自主行动循环过滤（npc.ts）、战斗参战 ref 解析时**跳过该场战斗整条触发并记一条事实**（沿用现 combat 冲突口径：不消耗 once/冷却、不写触发提示；`enemies` 与 `allies` 同规则——不在建场期硬报错，「分支里先死、之后再引用同一 NPC 的战斗」是合法剧情，事件条件层可用 `npcState` 另行把关；仅 `characterId` 在模板中不存在才加载期报错，属引用完整性）、关系/affinity 写入对 inactive 冻结、NPC 行动候选先于条件求值过滤。复活/死亡/spawn 走统一效果 `{ type: "setNpcLifecycle", npcId, state, reasonCode? }`，无特权通道。
3. **投影与生命周期解耦（#41 合并裁决并入）**：`projectNpc(npc, state, template) → NpcView | null` 作为**单一判定入口**。**2026-11-12 第二批裁决 #41 关闭：采用候选①「合并」**——`visibility: public|hidden` 并入「NPC 投影原则」的该单一判定入口 `projectNpc()`，**不再与动态已知标记各设一套判定**（合并 ≠ 原「保留 visibility 静态闸并 AND 组合」两套并存，Q-R25-07 的 A 案据此改写）；历史条目可见性 `R-VS-03` / `isPlayerVisible()` 口径不变。输入 = NPC public 字段 + 动态已知标记 `infoVisibility`（自 flags 迁入实例）+ 模板 `projection` 配置（`alwaysVisible`/`revealFields`/`showLifecycle`）；unknown 且非 alwaysVisible → 不上屏；inactive 照常上屏（age 冻结、状态标注由模板 label 映射 reasonCode）。关联 R-NP-01、T2-03。
4. **出生时间与年龄**：`V2Npc.birthTime: number`（世界分钟，可为负）取代静态 age；`ageAt(birth, now)` 统一经 `CalendarAdapter`（新增 `toMinutes(amount, fromMinute)` / `ageAt(birth, now)` 方法与模板 `calendar.preset` 声明位）。三种时间模型 = ① 固定年长近似 / ② 真实公历 / ③ 自定义历/年号/洪荒纪元，**统一接口 + 模板声明切换，本轮只实现 ①**。**2026-11-12 第二批裁决 #39/#43：继续延期，下一期（R2.6）首批解决**——本轮 R2.5 不实现 ②真实公历/③自定义历+年号，`CalendarAdapter` 接口形状保持预留；Q-R25-05 标注「下期首办」（原「待用户确认交付边界」作废）。玩家与 NPC 统一 birthTime 派生（退役 `playerAgeAtStart + elapsedYears`，Q-R25-08）。
5. **关系模型**：`affinity`（数值，现 relationship 改名）与类型化关系边分离；**只写单向事实**（`parents: string[]`、`masterId`），child/sibling/apprentice/同门反向推导（倒排索引 O(N+E)），辈分上溯 BFS/DFS，写入时环检测（上溯校验目标非自身后代/徒链）；`custom` 关系留类型位给用户后续的通用 yaml 模板机制；`relationLog` 为事实层只追加记录。**分层复用（2026-11-12 G1 评审修订，原「不引入第三方依赖」作废）**：图遍历/环检测/断代/师承自研 `v2/relations.ts`（确定性、离线）；已知跳数亲属路径转成关系链记号交给 `relationship.js`（MIT/v1.2.9/零运行时依赖/纯查表确定性）出中文称谓；断代用显式 `ancestorGaps` + 粗称谓（不猜代数、不补节点）；师承称谓走模板 `titleRules`。OQ-#40 关闭、R-NP-08 新增；**引入 `game-core` 第三方依赖前须单独 ADR**。
6. **NPC 行动与事件边界**：NPC 行动只能写事实/实例状态/白名单效果；需要排程时只能经 `enqueueEvent` 效果入延时队列，不得直接触发模板事件（现 startedChains 收集→路由触发的模式保留）。

### 被否决的备选

- **给 NPC 加业务 status 枚举（dead/missing/sealed/fell… 作为引擎枚举）**：引擎必须对每个枚举值分支（死了不能行动、失联不能行动、封印不能行动…），每新增一种世界观语义就要改引擎——违反"世界观规则只进模板"。三态 + 自由 reasonCode 把语义留给模板、结构留给引擎。
- **沿用 isEnemy/flags 表达存活（如 `flags["npcDead:<id>"]`）**：模板条件可读引擎内部记录（层级墙穿透，ADR-0010 否决过同型方案）；判活逻辑散落各消费点、模板需要自己写 alive 条件（违背"默认判活"诉求）。
- **引入第三方族谱/称谓库（relationship.js）——【2026-11-12 G1 评审作废】**：实查确认存在成熟库 `relationship.js`（npm，mumuy/relationship；MIT，v1.2.9，约 3.7k stars，`dependencies: {}`，纯 JS 数据表算法、Node 离线、确定性），支持 `type:'chain'`、`optimal` 最短关系、`setMode` 方言、多跳中文称谓。原「与确定性结构图不同构、依赖治理成本 > 自研成本」的判断作废，改为**分层复用**（见决策 5）：自研图内核（遍历/环检测/断代/师承）+ 该库承担「已知亲属链 → 中文称谓」的纯函数展示层；师承称谓走模板 `titleRules`；断代用显式 `ancestorGaps` + 粗称谓（不猜代数、不补节点）。OQ-#40 关闭、R-NP-08 新增。**引入 `game-core` 第三方依赖前须单独 ADR**；lunar-javascript 本轮不引（#39/#43 延期，②③ 实现排下一期）。
- **age 保留为每轮 tick 更新的缓存字段**：多一个每轮写入口、漂移风险与 stepIndex 同型；派生计算（一次除法/历法差）成本可忽略，ageAt 即可。

### 后果

- 影响面（R2.6）：`schema/character.ts`（lifecycle/birthTime/parents/masterId/projection）、`shared/src/v2.ts`（V2Npc/V2Player）、`v2/npc.ts`、`v2/battle.ts`（参战 ref 判活跳过 + 建场 age 快照）、`v2/engine.ts`（setNpcLifecycle/npcState/关系冻结）、`v2/projection.ts`（projectNpc；`player.age`/`npcs[].age` 形状不变、内部改 ageAt 现算）、`v2/time.ts`（CalendarAdapter 扩展）、`v2/relations.ts`（新）、jjk-2006 characters.yaml。前端 `apps/web` 的 age 消费点零改动（视图形状保持）。
- 确定性：判活过滤改变 NPC 行动候选集与 RNG 消耗（同一 NPC 行动与否影响后续骰序），与 ADR-0011 一并随 schemaVersion 2 边界一次性生效。
- 裁决状态（2026-11-12 第二批）：**#41 已关闭（合并）**——`visibility` 并入 `projectNpc()` 单一判定入口，Q-R25-07 的 A 案据此改写；**#39/#43 继续延期、下一期（R2.6）首批解决**（Q-R25-05 标注「下期首办」），三种时间模型 ②③ 实现不在本轮、`CalendarAdapter` 接口形状保持预留；Q-R25-08（玩家统一 birthTime）、Q-R25-10（inactive 关系冻结）不阻塞 ADR 方向本身，按推荐口径（A）执行。

---

## 第二类裁决回填（2026-11-12 第二批）

> 用户 2026-11-12 第二批裁决原文：「35 加载期静态拒绝 但是注意别误伤了延时事件 / 36 留在队列 / 39 43 继续延期 下一期马上解决 / 41 合并 / 44 符合事件+字面量，和39 43 下期排期解决 / 45 先保持现状 时间问题 下一期决策 / 46 不做 / 没问题就施工」。**G1 已过**（用户上一轮「其余默认通过」）、G2 已过，本轮进入实施，从 `T1-01` 起按 G3 单任务推进；范围是本批 **R2.5 事件模型（T1-01..T1-09）**，R2.6/NPC（`T2-*`）为下一期。ADR-0010/0011/0012 状态由「待评审」改为「**已通过（2026-11-12 G1 评审）**」。
>
> 原「评审修订补记（2026-11-12，G1 评审通过）」的 **ADR-0010/0011/0012** 要点（配置域只读 / 运行时不生成定义 / 删 `MAX_SAFE_INTEGER` 哨兵 / `action-hook` 不改名 / 入队门控前置 / `TimeSpec` 收敛 / 结算推进轮次 / `relationship.js` 分层复用 / 三时间模型枚举）**已逐条并入上述 ADR 正文**；以下 8 条为第二批裁决要点，**亦已并入正文（逐条注明「已并入正文」）**，权威修订总表见 `specs/iteration-2026-11-11-r25/design.md` §0.2 与 §0.3。

1. **#35 关闭（已并入正文）**：候选①「加载期静态拒绝」（`superRefine`）+ 延时豁免——只按 `onActionId` 分组统计「未声明 `window`/`delay` 的立即 `action-hook`」，同组 ≥2 条报错；声明 `window`/`delay` 的 `action-hook`、chain 延时步、schedule、pool 不受约束；错误信息提示「可为后续 hook 声明 window/delay 转为延时」。**落点**：ADR-0011 决策 5、R-EV-03、T1-01/T1-07、`design.md` §0.3/#1、`OPEN_QUESTIONS.md` #35。
2. **#36 关闭（已并入正文）**：候选②「留在队列」——窗口内 `conditions`/`cooldown` 不满足一律 hold 留队、每轮 drain 重估、不记错失；仅 `worldTime > window.end` 才出队并追加 `reason="window_expired"`；无 `window.end` 由显式 `missWhen` 兜底（R-EV-12/#42）；门控失败不构成错失。**落点**：ADR-0011 决策 3、R-EV-07、T1-03、`design.md` §3.4 判定表/§0.3/#2、`OPEN_QUESTIONS.md` #36。
3. **#39 / #43 延期（已并入正文，不写成已关闭）**：「继续延期，下一期马上解决」——本轮 R2.5 不实现 ②真实公历/③自定义历+年号，`CalendarAdapter` 接口形状保持预留；下一期（R2.6）首批解决；保留原有候选与推荐描述。**落点**：ADR-0012 决策 4/后果、`design.md` §3.5/§4.4/§7（Q-R25-05 标注「下期首办」）、`requirements.md` R-NP-04、`OPEN_QUESTIONS.md` #39/#43、`design.md` §0.3/#3。
4. **#41 关闭（已并入正文）**：候选①「合并」——`visibility: public|hidden` 并入 `projectNpc()` 单一判定入口，不再与动态已知标记各设一套判定；`R-VS-03`/`isPlayerVisible()` 口径不变；ADR-0012 决策 3 与 Q-R25-07 的 A 案按此改写（合并 ≠ 简单 AND 两套并存）。**落点**：ADR-0012 决策 3、R-NP-01、T2-03、`design.md` §4.3/§7、`design.md` §0.3/#4、`OPEN_QUESTIONS.md` #41。
5. **#44 方向定 A、实现延期（已并入正文，不写成已关闭）**：「符合事件+字面量」按「**复合时长 + 字面量**」解读（候选 A：`3d`/`2h30m` + 历法日期字符串字面量，文档须注明这是对原文的解读）；实现与 #39/#43 一并排下一期；本轮 `TimeSpec` 只实现 `TimeAmount {value, unit}`，字符串语法只留 `CalendarAdapter.parseTimeSpec` seam、不做加载期解析。**落点**：ADR-0011 决策 2、`design.md` §3.1/§3.5、`test-design.md` 第 13 项、`design.md` §0.3/#5、`OPEN_QUESTIONS.md` #44。
6. **#45 保持现状、下期决策（已并入正文，不写成已关闭）**：本轮不加 `MAX_WORLD_TIME = 2^52` 上界拒载、不加 `{epochIndex, minuteInEpoch}` 双字段/BigInt，`worldTime` 维持 number 分钟；`R-LM-05` 验收收缩为「整数分钟 + `hasEnd` 无数值哨兵」；上界校验与年号/纪元渲染随 #39/#43 下一期一并验收。**落点**：ADR-0010 决策 5、R-LM-05、T1-02 DoD（删「上界」）、`design.md` §3.5/§6、`test-design.md` 第 14 项、`design.md` §0.3/#6、`OPEN_QUESTIONS.md` #45。
7. **#46 关闭（已并入正文）**：用户明确「不做」——运行时按 seed 生成配置层模板定义的能力不实现；R-LM-04 常规路径（规则写 yaml → 世界初始化实例化 `SpawnRuleInstance` → 效果 `spawnNpc(ruleId)` 建 NPC 实例）保留，归 R2.6。**落点**：ADR-0010 决策 4、`design.md` §2、`design.md` §0.3/#7、`OPEN_QUESTIONS.md` #46。
8. **施工状态（已并入正文）**：G1 已过、G2 已过，本轮进入实施，从 `T1-01` 起按 G3 单任务推进；范围 R2.5 事件模型（T1-01..T1-09），R2.6/NPC（`T2-*`）为下一期；ADR-0010/0011/0012 状态「已通过（2026-11-12 G1 评审）」。**落点**：三篇 ADR 状态行、`PROJECT.md` §2、`tasks.md` 顶部、`README.md` 门禁状态、`design.md` §0.3/#8。

> 与 `design.md` §0.2 冲突处，以 §0.3（第二批裁决）为准：`§0.2` 的「`worldTime` 加显式上界」「年号/纪元本轮渲染」「字符串加载期解析」等表述已被 #45 / #39 / #43 / #44 修订。

---

## ADR-0013 时间适配器落地：真实公历 + 自定义历/年号（R2.6 首批）

- **状态**：**已通过（2026-11-12 用户确认路线「两块全做」，G1/G2 清除）**。依据 AGENTS.md §0「改核心数据模型 / 配置前先写 ADR」。
- **背景**：R2.5 仅实现三种时间模型中的 ①近似标量（`UNIT_MINUTES` 固定 30 天月/365 天年），`CalendarAdapter.toMinutes`/`parseTimeSpec` 仅留 seam 未实现（见 `time.ts:57-64`）。#39/#43 用户在 2026-11-12 裁决「继续延期，下一期（R2.6）首批解决」；#44 方向定 A（复合时长 + 历法日期字面量）；#45 保持现状（不加时间上界）。
- **决策**：
  1. 实现 ②真实公历 与 ③自定义历/年号/纪元；模板经 `time.calendar.preset` 声明切换，引擎不再硬编码历法。
  2. `CalendarAdapter` 三方法落地：`toMinutes(amount, from)`（TimeSpec→分钟，按历法）、`parseTimeSpec(spec, from)`（字符串字面量解析）、`format(minute)`/`ageAt(minute)` 按 `preset` 分支渲染（含年号）。
  3. 字符串 `TimeSpec` 语法：复合时长 `3d`/`2h30m`/`1y2m` + 历法日期字面量（`2006-12-24`、年号纪元串），加载期由 `parseTimeSpec` 解析（#44 方向 A）。
  4. 引擎内所有「TimeSpec→分钟」换算（`enqueueScheduled`/`delay`/`timeCost`/`advanceBy` 等）统一经 `CalendarAdapter.toMinutes`，不再直接读 `UNIT_MINUTES`（除 `approx` preset 内部仍用它）。
  5. #45 本轮**不**加 `MAX_WORLD_TIME` 上界、不引入 `{epochIndex, minuteInEpoch}`/BigInt；`worldTime` 维持 `number` 分钟；年号/纪元渲染随本 ADR 落地；若 `era.epochStartMinute` 超出 `number` 范围再单独评估（保持 `number` 不变）。
- **数据模型**（配置层，属 breaking 变更 → 指纹必变 → 旧档一致拒载）：
  - `WorldTemplateV2.time` 增 `calendar?: { preset: "approx" | "gregorian" | "custom"; era?: { name: string; epochStartMinute: number }; months?: Array<{ name: string; days: number }>; leapRule?: "gregorian" | "none" | string }`。
  - 缺省 `calendar` ⇒ `preset: "approx"`（= 现状），零迁移，字节兼容。
- **影响面**：`shared/src/schema/world.ts`（calendar 配置 schema + `superRefine` 校验 months 天数/leapRule 合法）；`v2/time.ts`（`createTimeAdapter` 按 preset 选实现，保留 `approx` 分支）；`v2/engine.ts`（`TimeSpec`→分钟走 `toMinutes`）；模板 `world.yaml`（jjk-2006 声明 `calendar: { preset: "gregorian", startYear: 2006 }` 验证真实公历）；`apps/web` 时间展示走 `format`，零改动。
- **确定性**：历法计算全部纯函数，零 `Date`/`Math.random`/种子依赖；`startYear`/`era` 为模板常量。
- **验收/DoD**：见 `specs/iteration-2026-11-12-r26/tasks.md` T-A*。关联需求 R-NP-04、#39/#43/#44/#45。

### ADR-0013 修订 R1（2026-11-12，QA 验收 D-02 触发 · 用户裁决「改规格」）

- **问题**：原文决策 2 与 R-CAL-01/03 承诺 `ageAt(minute)`「生日未到不加岁」，但代码只实现 `elapsedYears`（语义 = **日历年边界跳岁**，`time.test.ts:197` 断言 `elapsedYears(366*1440) === 1` 即跨 2001-01-01 即 +1 岁）。全仓 `grep -rn "ageAt"` 在 `packages/`、`apps/` **零命中**，状态层亦**无生日字段**（`V2Player`/`V2Npc` 只有 `age` 与 `playerAgeAtStart`）。
- **根因**：生日精度需要「出生月日」作为数据源，但模板 `identity` 无 `birthday`，角色创建（咒术转盘 43 维）也不采集生日。承诺了一个**无数据支撑**的语义，属规格过述，不是实现缺陷。
- **裁决**（用户 2026-11-12 选定候选①）：**规格让一步**，把口径正式改写为「**年龄按日历年边界推进**」：
  - `CalendarAdapter` 对外方法名为 `elapsedYears(minute): number`，**不新增 `ageAt`**；`player.age = playerAgeAtStart + elapsedYears(worldTime)`（`engine.ts`、`turn.ts` 现有写法即为正确实现）。
  - `approx` 下 `elapsedYears = floor(minutes / 525600)`；`gregorian`/`custom` 下按历法「年」字段差值计算（跨年界即 +1，与生日无关）。
  - 「生日未到不加岁」的精度承诺**撤回**，改登记 `OPEN_QUESTIONS #47`（若将来需要，须先给 `identity` 加 `birthday`，属核心数据模型变更，另立 ADR）。
- **影响面**：`requirements.md` R-CAL-01/R-CAL-03 措辞、`tasks.md` T-A2/T-A3 的 DoD、`PROJECT.md` 的自评表述；**代码零改动**（现状即为修订后口径）。
- **验收**：`time.test.ts` 现有 `elapsedYears` 用例即为修订后口径的护栏；新增断言「`ageAt` 不存在」不必要，改为文档一致即可。

---

## ADR-0014 关系图谱：NPC↔NPC 图 + 多跳中文称谓（relationship.js 分层复用）

- **状态**：**已通过（2026-11-12 用户确认路线「两块全做」，G1/G2 清除）**。依据 AGENTS.md §0「引入 game-core 依赖前先写 ADR」。
- **背景**：现状 `CharacterSchema.relationship` 是单值标量 `z.number().min(-100).max(100)`（NPC→玩家单向，见 `character.ts:56`）；`npc.ts` 只读该标量。OPEN_QUESTIONS #25 指出：无 NPC↔NPC、无关系来源/档位/阈值/传播；R-OP-05 要求「不得默认所有 NPC 都认识主角」。谱系/亲属/师承推导 #40（已关闭）裁定**分层复用 `relationship.js`**（npm `mumuy/relationship` MIT v1.2.9，确定性、离线、零运行时依赖）。
- **决策**：
  1. **引入 `relationship.js` 进 `game-core`**（G2 依赖门禁）：锁版本、零运行时依赖；仅用于「已知跳数亲属路径 → 中文称谓」这一纯算法，不承载图遍历/环检测/断代/师承（自研）。
  2. **图内核自研** `v2/relations.ts`：边增删查、最短路径（BFS）、环检测、`ancestorGaps` 断代（显式 gap 标记 + 粗称谓，不猜代数、不补节点）、师承称谓走模板 `titleRules`。
  3. **关系模型统一为边 `RelationEdge`**：`{ from, to, kind, source, visibility: "known"|"inferred"|"unknown", tier?, value? }`，NPC↔NPC 与 NPC↔玩家同构表达；保留 `npc.relationship` 标量作为「NPC→玩家」便捷只读投影（初始化时由种子边生成，向后兼容），新代码优先读边。
  4. **默认不认识**（R-OP-05）：所有关系边初始 `visibility: "unknown"`；仅模板 `characters.yaml` 显式声明或事件/效果建立的边才 `known`/`inferred`。
  5. **多跳中文称谓**：已知亲属跳数路径 → 转关系链记号（`f/m/s/d/xb/ob/lb/xs/os/ls`…）→ `relationship.js` 出称谓（舅外公、甥外孙…）；路径不唯一取**最短路径 + 确定性次序**（字典序），与库 `optimal` 语义一致。
  6. **关系变化触发 NPC 行动**：本轮只建模型 + 查询 API；关系条件接入 NPC 行动效用（`goalMatch`/条件 DSL 已支持关系）留接口，不强制触发。
- **数据模型**（实例/事实层，breaking → 指纹变 → 旧档拒载）：
  - `WorldStateV2` 增 `relations: RelationEdge[]`。
  - `shared/src/schema/character.ts`：`relationship` 标量保留作初始化便捷；`characters.yaml` 可增 `relations: RelationEdge[]` 初始声明（可选）。
  - 效果 DSL：`adjustRelation` 扩为支持 `fromId`/`toId` 双向；新增 `addRelationEdge`/`freezeRelationsOnDeath`（死亡/NPC 失联时关系冻结，Q-R25-08 口径）。
- **影响面**：`shared/src/schema/{character,world,state}.ts`、`v2/relations.ts`（新）、`v2/engine.ts`（效果消费）、`v2/npc.ts`（图查询供效用/条件）、`v2/projection.ts`（`projectNpc` 关系可见性投影）、`package.json`（依赖）、jjk-2006 `characters.yaml`（声明初识关系边，如 五条/夏油/硝子 互识）。`apps/web` 关系消费点按需，不强行扩展。
- **确定性**：`relationship.js` 纯算法；图操作纯函数；无外部时间/随机；同输入 ⇒ 同输出。
- **风险**：多跳称谓依赖库数据表覆盖度；罕见路径库无结果时回退粗称谓（`ancestorGaps`/kind 标签），不抛异常、不静默。
- **验收/DoD**：见 `specs/iteration-2026-11-12-r26/tasks.md` T-B*。关联需求 R-NP-08、#25、R-OP-05、Q-R25-08。

---

## ADR-0015 jjk-2006 内容收敛：删除主线剧情事件链，咒术转盘成为开局核心

- **状态**：**已执行（2026-11-12 用户指令）**。属模板内容治理，不改引擎规则；按 AGENTS.md §0 显式记录以免「静默更改游戏规则」。
- **背景**：转盘在模板中的落地分两层——①`specs/data/templates/jjk-2006/咒术转盘☆第二版.wheel.json`（B 站 meme-auto-wheel 导出，untracked 参考物，加载器只读 `*.yaml`，永不进引擎）；②`events.yaml` 的 `ev-opening-wheel` + `ev-w01..ev-w43` + `chain-wheel-creation`。原 `ev-opening-wheel` 为 `source: schedule`（window +1 分钟、priority 100），而开局 `handoff.pendingEvents` 直塞以主线 `ev-curse-sighting` 为队首，UI 只渲染 `pendingEvents[0]` ⇒ 玩家开局看不到转盘，须先推进一轮且排在主线之后。
- **决策**：
  1. 删除全部非转盘主线事件链：`chain-curse-investigation` / `chain-finger-hunt` / `chain-star-plasma` / `chain-night-parade` / `chain-shibuya` 及其 28 个事件（含 `ev-curse-sighting`、`ev-exchange`、`ev-finger`、`ev-shrine-lottery`、`ev-sp-*`、`ev-night-*`、`ev-fight-*`、`ev-shibuya*`）。
  2. `ev-opening-wheel` 触发改为 `source: chain`（不属于任何链）：不进 `schedule-init` 队列、不进随机池，待决排序按 chain 源置顶。
  3. `opening.yaml` 两个开局的 `handoff.pendingEvents` 均改为 `[ev-opening-wheel]` ⇒ **创建世界后的首个待决事件即开局转盘**，与调度时序解耦。
  4. 保留全部世界观资产（characters / skills / items / statuses / endings / world 配置）；`endings.yaml` 中仅以 flag 为条件的星浆体/涩谷结局成为不可达数据，属已知残留，后续内容治理决定去留。
- **影响面**：`specs/data/templates/jjk-2006/{events.yaml, opening.yaml}`；测试夹具迁移（`v2.test.ts` / `opening.test.ts` / `schema.test.ts` / `r25-schema.test.ts` 改用剩余转盘内容或合成事件）；**模板指纹变化 ⇒ 旧存档一致拒载**（本机 `data/worlds/*.json` 旧档需重开）。
- **验收**：`pnpm typecheck` 0 错误；game-core 287/287、shared 50/50；真实 API 验证：`POST /api/worlds`（op-2006-tokyo）返回 `pendingEvent = ev-opening-wheel`，选 `opt-begin` 后进入 `ev-w01`（出身地点）。
- **已知缺口**：转盘创建链仍为 43 个普通选项事件（`kind: normal`），前端「命运之轮」旋转盘（`WheelResultView`）只用于 `kind: random` 事件，创建链不走旋转动画；如需 B 站式转盘观感，需引擎侧为 normal 事件产出 `wheelResult` 或在 web 侧新接转盘展示（另行立项）。

---

## ADR-0016 jjk-2006 玩法重构：一年制的「命数转盘」人生（内容重做，非引擎改造）

- **状态**：**已执行（2026-11-12 用户指令：按资深玩家理解把游戏做得好玩，不走 spec）**。只改模板数据 + 测试，不改引擎规则。
- **设计支柱**：转盘负责「命」，玩家负责「选择」。
  1. **开局 = 命**：13 步转盘（家族/资质/生得术式/术式应用/咒具/战斗风格/性格/师承/动机/代价/人设/预兆/命定一转），
     每一步都给真实机制后果（unlockSkill / grantItem / applyStatus / adjustAttribute / adjustRelation / flag），
     最后一步是真正的 `kind: random` 转盘（即时结算、走前端命运之轮动画）。
  2. **日常 = 选择**：13 个池事件（点名/食堂/夜谈/五条翘课/夏油的思想/硝子治疗/切磋/委托/传说/黑闪·领域·反转觉醒/黑市），
     全部 `random: 0.03` 稀有门控 + 冷却，避免「选项→事件」死循环。
  3. **行动 = 转盘**：巡逻/探索各挂一个 `action-hook → kind: random` 遭遇转盘（无事/咒灵/诅咒师/咒具/求救/一级咒灵），
     扇区直接 `nextEventId` 连战斗或奖励；交往挂「今天和谁过」。
  4. **主线 = 五章**：`chapter` flag + `time.gte` 门控的池触发器（星浆体 → 夏油叛逃 → 百鬼夜行 → 涩谷 → 终章），
     章与章之间 `advanceTo` 跳月（2/60/180/300/360/415 天），一年节奏在 40-80 回合内跑完。
  5. **结局 = 兑现**：12 个结局（含隐藏 `end-secret-savior`），全部由一年里攒下的 flag/属性决胜；
     `endings.yaml` 的 flag 与事件链一一对应（有测试断言，杜绝「写了拿不到」）。
- **关键内容**：新增 `evaluation.yaml`（成长/羁绊/功绩/真相/自由）；新增友军参战（百鬼夜行带乙骨、涩谷带五条+七海）；
  新增敌人 甚尔/一级咒灵/诅咒师/漏瑚/真人、同伴 七海/灰原；新增 咒力糖/线香/理子发带/「帐」补正/大吉·厄运·动摇·梦魇·觉悟·力竭。
- **两处刻意的平衡取舍**：
  - **死亡只留给终局**（**原表述，2026-11-12 QA 实测证伪，见文末「更正 C1」**）：日常/切磋/星浆体/夏油战败只给「力竭」或士气惩罚；只有百鬼夜行/涩谷战败带 `injured-sim`，
    与 `deathRoute` 联动才判死。避免新玩家在第 1 章就被甚尔劝退。
  - **章节 ready 门闩**：章节触发器用 `readyN` flag 由上一章最后一步放出、被本章触发器消费。
    否则 `advanceTo` 后多次结算会重复抽到同一章触发器（实测出现重复链）。
- **验证**：
  - `pnpm typecheck` 0 错误；game-core 342/342（含新增 `v2/playthrough.test.ts`：6 种子 × 2 开局自动通关，
    断言「必定收束 + 章节 ≥3 + 结局在声明集合内 + 至少一局走完学年」）；shared 50/50（模板/结局/开局引用完整性）。
  - 真实 API：建世界 → `ev-opening-wheel` → 13 步 → 命定一转（转盘结果）→ 日常池 → 巡逻转盘 → 第 1 章在第 2 天触发 →
    `ev-sp-after` 放出第 2 章，无重复触发。
  - 自动通关样本：`s1 挽留 / s2 同行者 / s3 两个都没失去（隐藏）/ s4 星浆体幸存 / s5 挽留 / s6 挽留`，39-80 回合。
- **已知缺口**：模板指纹变化 ⇒ 旧存档全部拒载（`data/worlds/` 内旧档需重开）；转盘只服务 `kind: random`，
  13 步创建链仍是选项点击（无旋转动画）；`死亡结局` 依赖战败+受伤，自动对局样本未触发（人工乱打可触发）。

### ADR-0016 更正 C1（2026-11-12 QA 实测 · 用户裁决「不修」）

- **原表述**：「死亡只留给终局……只有百鬼夜行/涩谷战败带 `injured-sim`」。
- **实测不符**（QA `JJK-V2-ACCEPTANCE.md` D-11）：`endings.yaml` 的 `end-death`（战殁）只判
  `{ status: injured-sim, present: true }`，**不看终止原因、不看伤势轻重**；而 `injured-sim`
  除章节战败外，还能由「命定一转 · 旧伤复发」与「探索 · 陷阱」施加。
- **复现**：seed 5 抽到「旧伤复发」→ 创角结束后点「结束这一生」（主动收束）→ 结局标题为**战殁**、
  文案「你在咒灵的交锋中败下阵来……」，与 meta「第 14 轮 · 主动收束」自相矛盾。
- **裁决**：用户 2026-11-12 明确「不管」，本条记为 **`Won't fix`**，不构成验收阻断。
- **若将来要修的建议方向**（未实施）：`end-death` 增来源约束（`battleDefeats >= 1`，或改用专用
  `severeWound` 补正而非通用 `injured-sim`）；主动收束走独立结局，不得复用战殁文案。

### ADR-0016 更正 C2（2026-11-12 实现修正）

- **原表述**：「章节 ready 门闩」已解决 `advanceTo` 后重复抽到同一章触发器。
- **实测不符**（QA D-01，5/5 种子复现 ch2×2 / ch3×2 / ch4×3 / ch5×4 / epilogue×4）：`readyN`
  只在选项 effects 里清（结算时才清），事件**待决期间**每轮 drain 的 `resolvePoolV2` 仍满足
  conditions，于是重复入队。
- **实际修法**（`ce6fbcc`）：五章触发器各加 `once: true`，由 `enqueueCandidate` 的入队门控读
  `hasFired` 挡住重复入队；`readyN` 保留作章节前置语义。
- **护栏**：`playthrough.test.ts` 新增 `chapterFires` 计数（读 append-only `eventFires`），
  断言每局每章 ≤1。已做变异验证（剥掉 `once` 后 seed 1 立刻报 `ch2×2, ch3×2, ch4×2`）。

### ADR-0016 补记 D-10（评价展示时机 = 前端渲染门，非服务端过滤）

- **用户裁决**（2026-11-12）：五维评价**只在结局/归档展示**，跑动中不显示。
- **实现位置**：`apps/web/src/main.tsx` 的 `EvaluationBreakdown` 加 `status` 门
  （`status !== "terminated" && status !== "archived"` ⇒ 整块 `return null`，不挂载）。
- **必须知道的边界**：服务端在 `running` 态**仍然下发** `evaluation.dimensions`
  （引擎每快照实时算，属事实层）。也就是说这是一个**客户端渲染门**，不是服务端过滤。
  由此带来两个后果，后续改动请留意：
  1. 任何**第二客户端**（另一个前端、脚本、调试工具）拿到的仍是五维，若产品要求
     「跑动中绝不可见」，需要在服务端 `projectSnapshotV2` 按 `status` 过滤，
     而不是靠每个客户端各自加门。
  2. 该门只影响「何时展示」，不影响「展示什么」——结局/归档页五维与 API 逐字段一致，
     已由 QA `G5–G8` 断言。
- **安全性依据**：评价只读过程信号、不含结局类型（`life-evaluation.ts` 既有约束）；
  QA 对照实验（`JJK-V2-ACCEPTANCE.md` §10.8）证明：同 seed、同创角、之后走向不同结局，
  **开局时刻五维逐字段相同** ⇒ 提前可见不泄露走向。故当前「服务端仍下发」不构成信息泄露，
  只是展示策略问题。
- **归档边界**（QA §10.15 实测）：未终止即归档 ⇒ `POST /archive` 返回 409 `not_terminated`，
  「已归档但未终止」在 API 层不可达；归档态 `GET`、幂等 `POST /archive` 的
  `archive.snapshot.evaluation`、record 层 `archive.evaluation` 三者同值；归档后
  `POST /turns` 返回 409 `terminated`（只读门禁正常）。

---

## ADR-0017 遗留缺陷清理批：投影如实性、评分有界饱和、战斗命令单一真源

- **状态**：**已实施（2026-11-12，用户裁决「yaml 模板问题不处理，游戏内核/前后端 bug 就修复」）**。
- **背景**：`JJK-V2-ACCEPTANCE.md` 遗留 6 条（D-03/05/06/07/08/09）经逐条定性，全部属内核或前后端问题，无一是模板内容问题；修复过程中又连带发现 **D-12/13/14/15/16**。验收见 `tasks/reports/JJK-V2-FIXES-ACCEPTANCE.md`。

### 决策 1（架构原则）：投影不得让玩家看到引擎会拒绝的操作

- **问题模式**：引擎在 `battle.ts` 里有若干守卫（`cannot_use_items` / `cannot_flee` / `cannot_act` / `sealed_skills` 等），
  但 `BattleView.player` 只暴露 `canFlee`（且只反映模板 `settle.canFlee`，未合并补正）。结果是**投影说可以做、引擎拒绝**：
  玩家点击后收 400，或更糟——`cannot_act` 分支**不抛错只跳过**，玩家白丢一个战斗回合且无任何提示。
- **决策**：凡「引擎会拒绝或静默跳过」的操作，投影**必须**给出对应布尔位，且判定与引擎**同源**（复用 `controlOf`，
  禁止在前端或服务端各写一套）。当前统一为 `canUseItems` / `canFlee`（= settle 声明 AND 未被 `cannot_flee` 压制）/ `canAct`。
- **已知未覆盖**：`sealed_skills`（模板 `seal` 状态有定义但零处施加，当前不可达）、`cannot_attack`（不可达）。
  二者不预加字段——**不为不可达状态提前建抽象**；等真可达时按同一原则补。
- **风险**：若某模板把控制类补正声明为 `visibility: hidden`，会出现「布尔位为 false 但 `statuses[]` 里没有原因」。
  当前模板全部 `known`，不可达。

### 决策 2（游戏规则变更）：五维评价改为有界饱和

- **问题**：旧公式 `score = clamp(raw, lo, hi)`，而 `raw` 对多数维度随过程信号**线性增长**（如 `growth = attributeSum + actions×2`）。
  长局必然远超上限 ⇒ 满年局五维全 100、`overall` 恒高，**评价失去区分度**。
- **决策**：改为 `score = lo + (hi − lo) · x/(x + k)`，`x = max(0, raw − lo)`，`k = SATURATION_K_RATIO × (hi − lo)`，`SATURATION_K_RATIO = 0.30`。
  单调递增、**严格小于 `hi`**、`k` 与模板绝对分无关（窄区间模板自动等比缩放）。
- **标定依据**：6 个种子实测，满年局 `x` 中位 ≈ 291、区间宽 150（中位局 ≈ 1.94×宽度）。
  若字面取 `k = x_med`，中位满年局只能落在区间 ~50%（约 25 分）——等于用一个缺陷换另一个；故锚定「中位满年局 = 区间 86.7%」反解出 `k/宽度 ≈ 0.3`。
- **实测区间**：满年局 成长 62.5–72.2 / 羁绊·功绩 78.7–82.5 / 真相·自由 82.6–85.9 / `overall` 76.3–81.2（旧：全 100）；短局有梯度（t10≈60 → t20≈71 → t30≈78）。
- **确定性**：`k` 为常数，**禁止**按本局最大值归一（会让不同长度的局不可比）；无随机、无跨局依赖。
- **影响面**：所有世界的评价数值整体下移；评价每次投影重算、不持久化，故旧档无迁移问题。**已知限制**：模板 4 个专属维度
  （bonds/deeds/truth/freedom）同落 `rawScore` 的 `default` 分支 ⇒ 彼此恒等；真区分需 `explanationRules → 规则 id` 映射机制（协议变更，另立项）。

### 决策 3（契约变更）：`BattleCommand` 增 `pass`，且 schema 单一真源

- **背景**：`cannot_act`（眩晕）时引擎跳过命令但**仍需一次命令提交**才推进回合。若 UI 把所有按钮禁死，眩晕永不到期 ⇒ **战斗硬卡死**。
  前端被迫借 `{type:"flee"}` 提交（当时安全，因眩晕分支排在命令分发之前），但这是**顺序依赖**：一旦调换分支顺序，
  眩晕玩家点「硬撑」会真的执行逃跑。
- **决策**：`BattleCommand` 增 `{ type: "pass" }`（本回合不做任何事、仍消耗一回合；不扣 MP/道具/冷却、不掷逃跑判定）。
  平衡性判据：每回合敌人照常出手、DoT 照常结算 ⇒ 拖延有代价；且未新增可达状态（此前已可用无伤害技能循环达成僵持）。
- **同时**：`apps/server` 原有一套**手写**的战斗命令 zod，与 `packages/shared` 类型是两份真源——加 `pass` 时服务端直接 400 拒绝。
  现收敛为 `packages/shared/src/v2-command.ts` 的 `BattleCommandSchema`，类型用 `z.infer` 派生，服务端只引用；
  另加源码守卫（服务端不得再出现 `discriminatedUnion(`）防止第二份定义复辟。
- **不做**：不顺手统一其它路由 schema（它们服务端独占、无漂移风险）。

### 决策 4（投影补充）：轮次转盘结果与标题随结果持久化

- `state.lastWheels: WheelResultView[]` 承接**当轮全部**转盘结果（`lastWheel` 保留为末项，向后兼容）；三个轮次起点清空（均在守卫之后，
  被拒指令不抹掉上一轮可见结果）；`useItemV2` 为轮外操作故不清空。
- `WheelResultView.title?`（= `EventV2.title`）随结果写入：此前前端靠 `eventId` 去**本次响应**的 `triggeredEvents` 反查标题，
  刷新后必然查空 ⇒ 标题回落「随机事件」。写进结果后刷新与旧档均自洽。**旧档无法追溯**（历史上没存过），仍显示兜底文案——属数据缺失，非缺陷复发。
- 存档兼容：`lastWheels` 在状态 schema 与 TS 均为**可选**、读侧 `?? []`，**不升 `schemaVersion`**（升版会拒载 `data/worlds/` 下全部在跑存档，
  为 P2 呈现缺陷付此代价不成比例）；沿用 `history.visibility` 的既有兼容先例。

### 决策 5（展示策略）：`storyChapter` 仅数字，评价分项仅结局/归档展示

- 投影输出 `storyChapter?: number`（仅当 `flags.chapter` 是 number）；**不**下发章节中文名（模板无章节名表，不自造）。
- 五维分项沿用 ADR-0016 补记：跑动中**不渲染**（实测该块 379px 会把主交互区推出首屏），只在 `terminated` / `archived` 展示。
  注意这是**前端渲染门**，服务端在 running 态仍下发 `dimensions`。

### 决策 6（协议层 · 破坏性校验收紧）：属性键必须 ⊆ `attributes.order`

- **缺口**：`world.ts` 的 superRefine 已校验性别 / 技能 / 物品 / 关系目标 / `attributes.labels` 键集等 8 类交叉引用，
  **唯独 `attributes.defaults` 与 `playerTemplate.attributes` 的键没查**。引擎会把它们直接写进 `player.attributes`，
  而投影的 `labels.attributes` 只覆盖 `attributes.order` ⇒ 玩家端那一格显示机器名（如 `luck`），加载期不报错、页面不空白、极难归因。
- **本质是不对称**：`attributes.labels` 的键**被强制 ⊆ order**（既有 L258），`defaults` 的键却没有 —— 于是模板能在
  defaults 里声明一个 order 外属性，而 labels 永远不可能有它的中文名。
- **决策**：加载期补齐两条断言（`defaults` / `playerTemplate.attributes` ⇒ 路径精确到键名，消息含键与 `attributes.order`）。
  **`characters[].attributes` 不新增校验** —— 它早在既有 superRefine 中已校验（路径 `characters[i].attributes`，不含键名），
  本次仅加一条「命中恰好 1 条」的回归断言，防止将来重写循环时重复上报。
- **破坏性**：不合规模板从「能加载、静默退化」变为「加载失败」。这是 fail-fast 收紧，与既有 8 类引用校验口径一致；
  现网 jjk-2006（defaults 6 键 / playerTemplate 6 键 / 16 角色各 5 键，越界 0）与全部测试夹具均通过。
  **对第三方模板作者属一次破坏性升级**，需在模板协议文档「属性声明」小节标明（文档本轮未改，待授权）。
- **刻意不做**：不改成"投影让 `attributeLabels()` 覆盖 `player.attributes` 键集"——那是替模板作者的错打掩护，
  会让漏配永远不可见。守卫放在**加载期 + 测试**，不放在运行时兜底。

### 验证

`pnpm typecheck` 0 错；game-core **367/367**、shared **62/62**；`pnpm build` 通过。
10 条缺陷逐条 PASS + 9 项回归 PASS（hidden 不泄露、旧档指纹拒载、章节不重复触发、确定性、V1 残留扫描等），见验收报告。

---

## ADR-0017b 体验修正：节奏 / 时间尺度 / 转盘驱动主线（对 ADR-0016 的修订）

> **编号说明**：本条原编号与 `ADR-0017 遗留缺陷清理批` 冲突（两者都是 0017）。为不重排已发布的
> ADR-0018，此处改为 **0017b**：它是 ADR-0016 的内容修订，与 ADR-0017（引擎缺陷清理）无关。
> 内容与改动范围不变。

- **状态**：**已执行（2026-11-12 用户试玩反馈）**。仅改模板与测试。
- **问题与修法**：
  1. **主线太密集、没有喘息** → 七章之间用 `advanceTo` 跳到「下一章前 9–15 天」，
     给自由行动窗口；章节触发器 `once: true` + `readyN` 门闩，杜绝重复/连环触发。
  2. **战败后没时间恢复、容易死** → 战斗败北一律只给「力竭（exhausted）」，不再给「受伤（injured）」；
     `deathRoute` 只在「带伤进入战斗并再次战败」时触发。新增行动 **疗养**（2 天：治伤 + 治力竭 + 回血蓝）；
     章节开转条件显式要求 `status injured-sim/exhausted present:false`——带伤时命运不会推你上下一场。
  3. **时间尺度缺失** → 全流程锚定公历：入学式 2006-04-03（第 92 天），
     关键事件 2006-04-10 / 07-20，涩谷 2006-11-15，死灭回游 2007-03-15，新宿决战 2007-07-15，
     成长 2007-10-10，终局 2007-12-10，落幕 2007-12-24（第 722 天）；年龄随公历自然增长（16 → 17），
     每个过场旁白标注具体日期与间隔（「三个月后」「四个月后」）。
  4. **事件池矛盾（百鬼夜行后还刷夏油）** → 新增 `getoGone` flag（叛逃/黑化时置位），
     食堂与交往里的「找夏油」选项 `visibleWhen` 隐藏；`ev-daily-geto` 同时要求 `chapter lte 2` 与 `getoGone != true`。
  5. **选开局时 NPC 仍在行动** → 所有 `npcActions` 加 `conditions: [{ flag: creationDone, eq: true }]`；
     `creationDone` 只在入学式（第 14 步）置位，13 步转盘期间 NPC 完全冻结。
  6. **主线不该沿用旧主线，要按转盘内容走** → 删除「星浆体 / 夏油叛逃 / 百鬼夜行 / 涩谷 / 终章」旧链，
     改为 **七次命运之轮**，内容直接取自 `咒术转盘☆第二版.wheel.json` 的维度：
     关键事件1（8 扇区：丧亲/丧师/弑友/诬陷/觉醒/交易/救人/身世）→
     关键事件2（8：领域/黑闪/反转/咒具/成名/羁绊/错误/逆命）→
     涩谷经历（6，含战斗）→ 死灭回游（6，含战斗）→ 新宿决战（6，含宿傩战，友军五条）→
     成长突破（6）→ 最终结局（8：生还/退出/战死/失力/叛逃/特级/传说/归隐）。
     每章是一个 `kind: random` 轮盘：玩家点一次、看「命运之轮」停下，落到的事件再给选择或战斗。
- **结局重写**：`endings.yaml` 12 个结局，按 `finalEnd` 八选一 + 隐藏结局（逆命 + 救五条 + 涩谷存活 =
  「三次逆行」）。`重伤丧失咒力` 不再附带 injured（否则会被 deathRoute 抢成战殁）；
  终章 `ev-ch7-epilogue` 治愈残留伤势，避免「活到年末却判战殁」。
- **新增资产**：敌人 `enemy-sukuna`（技能 解 / 火虞法）、行动 `recuperate`（疗养）。
- **验证**：`npx tsc --noEmit` 0 错误；shared 62/62；game-core 367/367
  （6 种子 × 2 开局全部跑满 722 天，章节 1→8 各触发一次；结局分布：传说 / 失力 / 叛逃×2 / 退出）。
  API 实测：入学式 day92、第 1 章 day100、第 2 章 day200、涩谷 day318、死灭 day438，
  章节间留 14–15 天自由行动；创建期间 NPC 行动键为空。

---

## ADR-0018 按原作重做：十二年时间线、术式体系、因果链与 if 分支

- **状态**：**已执行（2026-11-12 用户七点反馈）**。含一处引擎增量（`setIdentity` 效果），其余为模板内容重做。
- **反馈与对应改动**：
  1. **时间尺度不符原作、开局谬误（师承）**
     - 时间线改为原作公历：入学 2006-04-03（day 92）→ 怀玉 2006-08（day 215）→ 玉折 2007-06（day 526）
       → 百鬼夜行 2017-12-24（day 4375）→ 少年院 2018-06（day 4538）→ 涩谷 2018-10-31（day 4680）
       → 死灭回游 2018-11（day 4700）→ 新宿决战 2018-12-24（day 4736）→ 落幕 2019-01（day 4752，终止 4755）。
     - 人物关系按原作校正：玩家是 **2006 年一年生**，与 **七海建人、灰原雄同班**；**五条悟、夏油杰、家入硝子是二年生学长**；
       夜蛾正道是一年生班主任。原「师承：五条/夏油/硝子/七海」是错的（他们不是老师），改为「**引路人**」四选一（夜蛾/五条/夏油/硝子），
       语义是「谁会在你走错路时多看你一眼」，不再是师徒。
     - 2007→2017 的十年用 `ev-bs-04` 的**蒙太奇选择**度过（前线 / 留校教书 / 钻档案室 / 离开咒术界几年），
       每条给不同属性与 flag，把「十年空白」变成一次有代价的抉择。
  2. **事件太固定、缺 if 线** → 每章改为「gate 选择 + 4–6 步链 + 分支汇合」：
     星浆体可加入或留守、可挡枪救理子或目送；苦夏四条出路（**拦下夏油 / 听他说完 / 上报 / 跟他走**）；
     2017 百鬼按 `getoStayed` 分成「夏油来袭」与「羂索来袭」两套敌人与文本；
     涩谷有 `moleClue` 才能**提前拆掉狱门疆**（救五条 AU）；死灭回游三条玩法路线 + 「吞手指」隐藏分支；
     终章是 8 扇区命运轮（生还 / 失力 / 战殁 / 特级 / 传说 / 退隐 / 叛逃 / 一无所有）。
  3. **战斗内容太少、术式不该只是技能、领域没实装、黑闪** →
     - 生得术式改为「**角色级补正 + 2–3 个技能**」（`tech-ten-shadow` / `tech-red-blood` / `tech-doll` / `tech-thunder` / `tech-speech`），
       补正给持续属性与战斗增幅，技能是它的外显；`multi-technique` 支持**一人多个术式**（宿傩四技能、羂索双术式、玩家隐藏分支）。
     - **领域展开实装**：`sk-domain-expansion` 对全体敌人结算 → 自身挂 `domain-active`（命中 +0.3 / 伤害 +0.6 / 受伤 −0.25，**3 回合**）
       + 敌人挂 `domain-pin`（受伤 +0.35 / 命中 −0.25，3 回合）。宿傩另有 `sk-domain-malevolent`（伏魔御厨子）。
     - **黑闪**：引擎**没有暴击机制**，故不做随机暴击，改为「**会心窗口**」——必中的一记重击 + 自身 1 回合 `damageDealt +0.5`，
       真正的杀招落在下一击（模板已注明，不伪装成 crit）。
  4. **玩家还挂着旧 demo 物品/技能** → `playerTemplate` 清空为「一具身体 + 体术打击 + 1 个急救包」；
     `equipment.initialEquipment` 删除；旧 demo 的 `item-grade1/2-tool`、`item-curse-tool`、`eq-watcher-charm` 一并删除。
  5. **事件之间逻辑差、突兀** → 全部关系走 flag：`savedRiko → getoDoubt → 能否拦下夏油`、
     `getoStayed / getoGone → 2017 敌人身份`、`moleClue → 涩谷能否救五条`、`gojoSealed → 死灭回游与新宿阵容`。
     日常池按 `era`（1 学生 / 2 独当一面 / 3 东京）分段，并带人物存活门（`getoGone` / `haibaraDead` / `yujiJoined` 等）。
  6. **开局要能选性别与年龄** → 新增引擎效果 **`setIdentity { gender?, age? }`**（改年龄同步重置 `playerAgeAtStart`），
     创建链第 1、2 步即可选性别与 15/16 岁；实测 `gender` 与 `age` 都会写进投影。
  7. **主线太短撑不起剧情** → 事件从 75 个增到 283 个条目：8 章 × 4–6 步链 + 24 个日常 + 3 类遭遇转盘 + 13 步创建。
- **引擎增量**：`packages/shared/src/schema/common.ts` 增 `setIdentity`；`packages/game-core/src/v2/engine.ts` 实现；
  新增 `v2/identity-effect.test.ts`（3 例，含「跨年后年龄 = 新基准 + 经过年数」）。
- **结局**：12 个（含隐藏 `end-secret-thrice`「四度逆行」：救理子 + 拦夏油 + 拆狱门疆 + 涩谷存活，priority 66 压过普通终局但低于战殁）。
  **取消 deathRoute** —— 死亡只由终章战败（`ev-sj-02 onDefeat → finalEnd=hero-death`）表达，前三章战败只给力竭/重伤，留出疗养时间。
- **验证**：`pnpm typecheck` 0；game-core **370/370**（含重写的整局回归）；shared **62/62**。
  6 种子 × 2 开局自动通关：day 4755、章节 1→15、约 310–320 回合，结局分布 `战殁×2 / 四度逆行×2 / 传说 / 守护者`。
  真实 API：建世界 → 13 步创建（性别男/女、15/16 岁、术式补正 + 6 技能、天逆鉾）→ 入学式 2006-04-03（day 92，chapter 1）
  → 日常池 → 第一章 day 215 → 甚尔战（夏油友军、领域展开生效）→ 救下理子 → 时间跳跃 2007-06-03（age 16）。
- **已知缺口**：`combat-ai.yaml` 的 `sk-domain-void` 已随改名同步为 `sk-domain-empty`；
  创建链仍是点击式（转盘动画只服务 `kind: random` 事件，`ev-w12` 与 `ev-sj-03` 会真正旋转）。

---

## ADR-0019 NPC 面板投影：补 `statuses` / `lifeStage`

- **状态**：**已实施（2026-11-12 用户要求「前端还没实现 NPC 面板，关系/生命周期/状态先实现了」）**。
  属 T-2（投影契约变更），故先补本条 ADR。
- **背景**：`V2Snapshot.npcs[]` 原本只有 `id/name/age/genderLabel/personality/relationship/knownGoals/relations`。
  关系边在 R2.6（ADR-0014）已就绪，但**状态与人生阶段从未投影**，前端人物页只能显示姓名、年龄与一个关系数值。
- **决策**：
  1. `npcs[].statuses: { id, name, stacks }[]` —— **只透 `visibility === "known"` 的补正定义**，与玩家补正同一过滤口径。
     `unknown` / `hidden` 补正既不进数组、也不留任何字符串痕迹（避免「状态列表」成为 `hidden` 的侧信道）。
  2. `npcs[].lifeStage` / `lifeStageLabel` —— 由 NPC **年龄**经与玩家同一个 `CalendarAdapter.resolveLifeStage`
     推导（模板配置阶段表时走阶段表，否则走内置 4 段兜底），**不在状态层存储推导结果**（延续 ADR-0012「生命周期与投影解耦」）。
- **明确不做**：
  - **不新增 NPC 生死状态**。引擎当前没有 `alive` / 死亡建模，面板因此只显示「阶段 · 年龄」，
    不显示「已故」。真要做得先定「NPC 何时死」这条游戏规则（属核心规则变更，另立项），
    见 `docs/BACKLOG.md` §0。**不得用「年龄大就当作已故」这类推测在投影层伪造。**
  - 不下发 `hp/mp/mood` 与 `attributes`：NPC 战斗数值属战斗域，日常面板不需要，暴露反而成为推理材料。
  - 不下发关系另一端的**名字**：前端用 `npcs[].id → name` 自建索引即可（同屏数据已足够），
    避免投影为每个 NPC 重复内联全部人名。
- **前端**：`apps/web/src/main.tsx` 的 `PeopleTab` 改为可展开的 `NpcCard`，
  三块「关系 / 状态 / 生命周期」。关系行**双方向都写成完整句**（`A 视 B 为师父` / `B 视 A 为弟子`），
  因为边语义是 `{from, to, kind}` = 「to 是 from 的 kind」，只写单个关系词会被读反。
  kind 的中文名放前端常量表（`RELATION_KIND_LABEL`）——枚举封闭，属展示文案，不进内核。
- **副作用（已修）**：面板上线后立刻暴露一条模板数据错误——`characters.yaml` 里夜蛾正道声明
  `{to: npc-gojo, kind: mentor}`，按边语义读成「五条是夜蛾的师父」（原作相反）。已改为 `kind: disciple`
  （T-1 内容修正）。这正是「投影如实」的价值：数据反了，面板会直接读出来。
- **验证**：`pnpm typecheck` 0 错；game-core **373/373**（新增 `v2/npc-panel-projection.test.ts` 3 例：
  known-only 过滤 + hidden 不留痕迹、阶段按年龄推导三档、无补正给空数组）；shared 62/62；`pnpm build` 通过。
  浏览器实测（430×932 DPR2）：人物页 16 张卡片、展开后三块齐全、`docH 2933 / 横向溢出 0`、控制台零报错。

---

## ADR-0020 NPC 生命周期落地（补 ADR-0012 决策 1/2/3 的欠账）

- **状态**：**已实施（2026-11-12）**。属 T-2（协议 + 状态 + 投影），故先补本条。
- **欠账事实**：ADR-0012 决策 1/2/3 早在 2026-11-12 已通过（G1 评审）并写明「实施归下一期 R2.6」，
  但 **R2.6 只落地了 WS-A（日历）与 WS-B（关系图）两条工作流**，NPC 生命周期整批（`T2-*`）从未实施——
  核实方式：全仓 `grep -rn "lifecycle"` 零命中，`V2Npc` 无任何存活字段，死亡/失联的 NPC 照样被
  效用评分选中去行动，`end-death` 之类只能靠 flag 间接表达。
- **决策（沿用 ADR-0012，不新造）**：
  1. **状态字段** `V2Npc.lifecycle = { state: "alive" | "inactive" | "unspawned", reasonCode?, sinceTurn, sinceWorldTime }`。
     引擎**只判 `alive`**；`reasonCode` 是模板自由字符串（阵亡 / 叛逃 / 下落不明…），引擎不对它分支。
     **不引入 `lifecycle.ts` 或阶段枚举**（ADR-0004 禁令继续有效）——这是角色级三态字段，不是流程编排。
  2. **默认判活三处**（模板零书写）：NPC 自主行动候选（`runNpcActionsV2` 首行过滤）、
     关系/affinity 写入（标量与关系边两种形态都冻结）、`addRelationEdge` 建边。
  3. **单一写入口** 效果 `setNpcLifecycle { npcId, state, reasonCode? }`：复活/死亡/失联走同一通道；
     `__self__` 可解析为当前 NPC；指向未知 NPC 抛可诊断错误（不静默跳过）。
     离开 `alive` 时**顺带冻结相连关系边**，且**复活不解冻**（与 `freezeRelationsOnDeath` 同一条单向棘轮）。
  4. **条件 DSL** `{ npcState: { npcId, state } }`：只匹配状态、不匹配 `reasonCode`；
     「死人才能…」这类业务语义由模板用它组合表达。未知 `npcId` 一律 `false`，不猜测。
  5. **模板可声明初态** `characters[].lifecycle`：用于「开局即已故/失踪」的角色；缺省在世。
  6. **投影与上屏解耦**：`inactive` 的 NPC **照常上屏**，只是带状态标注（ADR-0012 决策 3 原意）；
     前端把卡片降饱和 + 标题加删除线 + 状态胶囊。
- **兼容**：`V2NpcSchema.lifecycle` 为**可选 + 默认 `alive`**，旧存档加载时补默认，**不升 `schemaVersion`**
  （沿用 `lastWheels` 先例）。「找不到该 id 的关系端点」按可写处理，只拦**确知**非在世——
  否则会把指向未实例化角色的边一并挡掉（首版就是这么写坏的，`relation-effects` 6 条测试立刻红）。
- **本次未做（明确记录，非遗漏）**：
  - **决策 4 的 `birthTime` / `ageAt` 派生未做**：`V2Npc.age` 仍是 `identity.age` 静态快照。
    它牵动玩家侧年龄派生（退役 `playerAgeAtStart`）、`CalendarAdapter.ageAt` 与存档迁移，
    属独立一刀，记在 `docs/BACKLOG.md` §3。
  - **战斗参战 ref 判活跳过未做**：当前模板没有任何路径把 `inactive` 角色作为 `enemies`/`allies` 引用，
    不可达；按「不为不达状态提前建抽象」暂缓，真出现时按 ADR-0012 决策 2 原口径补
    （跳过整条触发并记一条事实）。
  - **`projectNpc()` 单一判定入口未抽出**：`visibility` 过滤仍在 `turn.ts` 建实例时按 `isEnemy`/
    `visibility` 处理；抽公共入口属重构，与本轮功能无耦合，留待需要 `revealFields` 时一并做。
- **模板接线（T-1）**：`ev-bs-05` 两个「确认灰原阵亡」选项后追加
  `setNpcLifecycle npc-haibara inactive reasonCode 阵亡`，其后对他的 `adjustRelation` 会被自动冻结。
  **夏油（`npc-geto`）刻意不置 inactive**：`getoGone` 是「叛逃」，剧情中他后续仍以敌人身份出场，
  标成 inactive 会与内容自相矛盾——`reasonCode` 的语义留给模板判断，引擎不替它决定。
- **验证**：`pnpm typecheck` 0 错；game-core **380/380**（新增 `v2/lifecycle.test.ts` 7 例：默认判活、
  模板初态、效果写 since、未知 id 抛错、inactive 不自主行动、关系冻结且复活不解冻、`npcState` 条件、
  投影透出）；shared 62/62；`pnpm build` 通过。
  浏览器实测（注入 `lifecycle: inactive` 的灰原，430×932）：卡片降饱和 0.72、胶囊与生命周期块均显示
  「已故 / 失联 · 阵亡」，控制台零报错。**注入已还原，模板不留该声明。**

---

## ADR-0021 NPC 生命周期补强：原因展示 / 属性投影 / 战斗参战判活 / 出生时间派生

- **状态**：**已裁决方向（2026-11-12 用户四条反馈）· 待 G1 门禁**。
  四条反馈分别动了引擎判定点（战斗参战 ref）、投影契约（`npcs[].attributes`）、
  状态 schema（`V2Npc.birthTime`）与展示口径（`reasonCode`），按 `AGENTS.md` §0.3 全部落在 **T-2**，故先出本条 ADR。
  本条**局部修订 ADR-0012 决策 2**（「整条跳过并记一条事实」→ 单位级过滤 + 不落盘事实）
  与**决策 4 的实施边界**（先只做 NPC 侧，玩家 `playerAgeAtStart` 统一延后）。
- **起草人**：系统架构师（高见远）；核实基线 HEAD `465c636`。

### 用户原始反馈（2026-11-12，原文）

> 1. npc ref判活必须做 否则模板侧所有战斗都要写很长的dsl判断
> 2. 引擎不认reasonCode是对的 但是前端需要渲染具体的原因 模板需要区分具体场景 是阵亡 失踪 叛逃 前端不应该展示已故/失联 只展示阵亡
> 3. 模板层面 现在支持npc自定义属性的渲染吗 支持的话生得术式应该有属性的 补正是术式的副产物 如查理的预见未来 称金次的大奖
> 4. birthTime如果改yaml就能解决 顺手改了

### 现状核实（以代码为准，不是以旧 spec 为准）

| 事项 | 核实结论 | 证据 |
|---|---|---|
| 战斗参战 ref 判活 | **未做**。`buildUnits` 只按 `lookup.character(ref.ref)` 取模板定义，完全不读 `state.npcs` 的 `lifecycle` | `battle.ts:150-157`、`battle.ts:177-208` |
| 敌人是否有实例 | **没有**。`createWorldV2` 只实例化 `!isEnemy` 的角色；`enemy-*` 21 个角色全部被滤掉 | `turn.ts:115-116`；`characters.yaml` 21 处 `isEnemy: true` |
| 友军是否有实例 | **有**（`npc-geto / npc-yuta / npc-gojo / npc-yuji / npc-megumi` 都是实例 NPC） | `events.yaml` 5 处 `allies:` |
| NPC 属性在实例层 | **已在**（`V2Npc extends V2CombatantBase` 就有 `attributes`，建实例时从模板拷入） | `v2.ts:42-47`、`turn.ts:122` |
| NPC 属性在投影 | **没有**（`npcs[]` 无 `attributes`；`labels.attributes` 是全局的，可直接复用） | `projection.ts:150-198`、`v2.ts:497-537` |
| `birthTime` | **不存在**。`V2Npc.age` 是 `identity.age` 静态快照，此后从不重算 | `turn.ts:121`；全仓 `grep birthTime` 零命中 |
| 历法负分钟 | **不支持**。`minutesToView` 首行 `Math.max(0, …)` 把负值钳为 0；`viewToMinutes` 只从 `startYear` 正向累加 | `time.ts:130`、`time.ts:147` |
| `elapsedYears` 口径 | `approx` = `floor(minutes/525600)`；历法 = `max(0, view(minutes).year − startYear)`（**相对 startYear**） | `time.ts:215`、`time.ts:291-294` |
| `reasonCode` 现状 | 投影原样透出，前端却优先渲染通用态标签「已故 / 失联 · 阵亡」 | `projection.ts:174-179`、`main.tsx:2088-2118` |

### 决策 1：战斗参战 ref 判活 —— 单位级过滤，敌人耗尽才整条跳过

**1.1 判据单一入口**（新增纯函数，`battle.ts` 导出）

```ts
resolveCombatRefs(state, settle) -> { enemies, allies, enemiesExhausted: boolean }
```

- 对每个 `{ ref, levelScale }`：在 `state.npcs` 找同 id 实例，**存在且 `lifecycle.state !== "alive"` ⇒ 确知非在世，移出参战列表**；**找不到实例 ⇒ 视为可用**（不猜）。
  依据：敌人角色永不实例化（见上表），若把「无实例」当死亡，jjk-2006 全部 12 场战斗的敌人会被清空。
  同口径先例：ADR-0020 关系冻结「只拦确知非在世，找不到端点按可写处理」。
- `buildUnits` 改签名（接收**已解析**的 refs，不再自己从 `settle` 取），`createBattle` 只调一次 `resolveCombatRefs`。
  规则只写一处（与 `controlOf` 的 D-08 同型：多消费点共用一个函数，不各自复制判定）。

**1.2 处置规则**

- **allies 过滤后为空 ⇒ 战斗照常。** 友军是可选支援（`settle.allies` 本就 optional），缺席不改战斗成立性。
  典型：`ev-sj-02` 的 `npc-gojo` 若被封（`reasonCode: 封印`），涩谷终战仍要打，只是没有五条在场——
  这正是用户第 1 条的诉求：模板不必为每条 combat 写一遍 `npcState` 长条件。
- **enemies 过滤后为空 ⇒ 战斗不成立，整条触发跳过。**
  理由：`checkBattleEnd` 对空 `enemies` 的判定是 `every(!alive) === true`（`battle.ts:488`）⇒ 建场即「胜利」，白送 `onVictory`（声望、flag、`nextEventId` 推进），是可利用漏洞。
  跳过位置与既有 combat 并发 skip **同一处**（`triggerEventV2` 入口、`recordFire` 之前，`turn.ts:312-314`），口径完全复用：
  **不写 `firedEvents`/`eventFires`/`lastFiredIndex`、不入 `pendingEvents`、不进 `triggered`（无触发提示）、不写 history、不消耗 once/冷却、不推进 `timeCost`、不动链状态。**

**1.3 与 ADR-0012 原句「不在建场期硬报错……事件条件层可用 `npcState` 把关」如何共存**

- **仍然不报错**。死者重新出现不视为模板错误，而是「该单位不在场」——「分支里先死、之后仍引用同一 NPC 的战斗」继续成立，剧情不断。
- 「`npcState` 把关」保留为**可选**能力，不再是**必需**：模板要「这场彻底不发生」（整段剧情作废）才写条件；只想要「他不在场」就什么都不用写。
- **修订点**：ADR-0012 决策 2 的「跳过该场战斗整条触发并记一条事实」改为「单位级过滤；仅敌人耗尽才跳过整条；**不落盘事实**」（理由见 1.4）。

**1.4 「记的那条事实」放哪 —— 裁定：不落盘**（对 ADR-0012 决策 2 的显式修订）

| 候选 | 否决理由 |
|---|---|
| `state.flags` | ADR-0010 决策 2 明令系统内部记录不得进 flags（模板条件可读引擎内部记录＝层级墙穿透） |
| `missedEvents` | schema 要求每条记录必须对应 `scheduledEvents` 里的 `instanceId`（`v2.ts:168-178`），链内/action-hook 战斗没有排程实例；`MissReason` 只有 `window_expired`/`miss_when`，扩枚举＝协议变更且语义误导（不是时间错过，是剧情不成立） |
| `eventFires` | 那是「已触发」日志（append-only 触发事实）；给未触发事件写一条＝伪造事实，并污染 `lastFiredIndex` 的 once/冷却推导 |
| `history` | 事实层里唯一玩家可见的叙事通道；写「因为某人已死，这场没发生」会把调度内部原因变成玩家叙事，且每场一条噪音 |
| 新事实层字段 | 违反「不为不达状态提前建抽象」；该信息已在实例层 `lifecycle.state/sinceTurn/sinceWorldTime`，模板用 `npcState` 即可读，另存＝第二真源 |

⇒ 结论：「该死的人不在场」由 **`lifecycle` 实例字段**承担（append-only、可投影、可条件读取），不新增任何持久化记录。
**可诊断性补偿**：`TriggerResult`（`turn.ts:215-220`，引擎内部类型，不进存档/投影/API）增加**非持久化**字段
`skipped?: Array<{ eventId, reason: "combat_refs_inactive", npcIds: string[] }>`，供测试与本地排障断言「这场为什么没打」。
若主理人认为连这个也不必要，可退化为零记录（测试改用副作用断言）——功能语义不受影响。

**1.5 明确不做（决策 1 边界）**

- **不做**模板期 / 建世界期的「combat 全 enemies 恒非在世」静态矛盾校验：当前 12 场战斗的敌人全是无实例的 `enemy-*`，不可能失败触发；真写了属内容错误。顺带记录事实：`character_not_found` 现在也是**建场期**抛错（`battle.ts:184`），不是 ADR-0012 所说的加载期——引用完整性校验在建仓时就不存在，本 ADR 不补。→ 登记 `BACKLOG`。
- **不新增** `ChainStatus` 枚举、不修「链因战斗被跳过而悬空」：`evaluateChain` 只看「队列 waiting / 待决 / 该步定义存在」（`scheduler.ts:327-341`），跳过不改链 ⇒ 链停在 active。该风险在**既有** combat 并发 skip 上已存在（同型缺陷，不是本决策引入）；正确解法是新状态 `broken` + 协议变更，另立项。→ 登记 `BACKLOG`。

### 决策 2：reasonCode 展示口径 —— 具体原因优先，通用标签降级为兜底

- **投影不变**：`npcs[].lifecycle.reasonCode` 继续原样透传（`projection.ts:174-179`），引擎仍不解释、不映射、不校验取值。
- **前端口径**（`main.tsx:2088-2092 / 2113-2118 / 2188-2190`）：
  1. `state !== "alive"` 且 `reasonCode` 存在 ⇒ **只显示 `reasonCode`**，去掉 `NPC_LIFECYCLE_LABEL[state] + " · "` 前缀。
  2. `reasonCode` 缺失 ⇒ 回退通用标签，且**文案收窄**：`inactive` 由「已故 / 失联」改为「**已离场**」。
     理由：「已故」「失联」都是在无数据时对原因做推测（用户明确反对界面上出现这两个词），而 `inactive` 的引擎语义只是「非在世 / 不参与」，叛逃、封印、下落不明同落一态；与其二选一猜错，不如给中性词。
     `unspawned` 保持「尚未登场」，`alive` 不显示标签。卡片降饱和 / 删除线保持不变。
- **模板约定（不是引擎约束）**：每个非在世场景应给具体 `reasonCode`（阵亡／失踪／叛逃／封印／下落不明…）。
  引擎**不**提供枚举、**不**做必填校验、**不**维护中文映射表——世界观词表属模板（AGENTS.md §5「不得把世界观专属规则硬编码进通用引擎」）。
  现有范例：`ev-bs-05` 的 `setNpcLifecycle npc-haibara inactive reasonCode 阵亡`（ADR-0020）。
- **明确不做**：不给 `reasonCode` 加白名单/枚举；不在投影做 code→中文；不因缺失而告警（缺省不是错误）。

### 决策 3：NPC 属性投影 —— 下发模板声明的 base 属性，不新增派生值

- `V2Snapshot.npcs[].attributes: Record<string, number>`（**必填，空对象而非缺省**——前端直接遍历，`undefined` 会炸）。
  数据源已在实例层（`turn.ts:122`），**本决策纯投影 + 前端，无状态模型改动**。这也直接回答了用户第 3 条的前半句：
  **属性一直存在，只是没下发。**
- **键集**：只透 `template.attributes.order` 内的键，按 `order` 顺序构造；order 外的键一律不透（避免把内部/派生键，如玩家侧的 `proficiency*`，漏成新 API 面）。
- **值**：base 原值（模板声明值；`levelScale` 与补正一概不叠）。**不新增** `attributeModifiers` / `effectiveAttributes` / `attributesDelta` 等派生字段。三条理由：
  1. 与玩家面板同口径（`player.attributes` 也是 base + 独立 `statuses` 列表），前端可复用同一渲染；
  2. 面板若要显示「实效值」，必须先按 `visibility=known` 过滤补正再算，结果必然与引擎实算不一致（hidden 术式补正被滤掉）——面板数字与战斗数字不符，比不显示更坏；反之不过滤即成 hidden 侧信道（ADR-0019 已立的红线）；
  3. 若复用 `engine.effectiveAttributes()` 求同源，则必须接受输入未经可见性过滤 ⇒ 直接泄漏 hidden 补正差值，二者不可兼得（`engine.ts:71-101`）。
- **术式与补正的分层（回答用户第 3 条后半句）**：
  - 术式在模板里**就是状态**（`statuses.yaml` 的 `tech-*`，带 `simulation.attributeModifiers`，如 `tech-ten-shadow → { cursedEnergy: 4, intellect: 1 }`），因此它在人物面板上表现为**补正一项**，不进 base 属性——「补正是术式的副产物」的现有表达已经成立。
  - 若要让「术式带来的属性」出现在属性区，走**模板约定**（内容侧，T-1 单独立项）：把永久天赋并入 `characters[].attributes`，同时**不要**再在同一术式状态里重复声明同一份 `attributeModifiers`（否则战斗侧双算）。引擎不提供叠加计算，也不替模板判断该放哪边。
  - base 与实效值不相等在界面上是**可接受**的：玩家面板本来就这么显示。
- **维持 ADR-0019 其余边界**：`hp/mp/mood` 仍不下发（战斗域数值），关系另一端名字仍不内联。
- **ADR-0019「不下发 attributes」一条被本条部分替代**：原文理由「NPC 战斗数值属战斗域，暴露即成推理材料」让位于用户明确的展示诉求；实际风险有限——`attributes` 是模板公有声明，不含 hidden 派生值。

### 决策 4：birthTime 与年龄派生 —— 先做 NPC 侧，玩家侧延后

**4.1 数据模型**

- `V2Npc.birthTime?: number`（**世界分钟，可为负**；负＝世界起点之前出生）。**可选 + 读侧反推，不升 `schemaVersion`**（沿用 `lifecycle` 先例，`v2-state.ts:64-77`）。
- 反推口径：缺失时 `birthTime = yearsBack(npc.age, 0)`——按整年从**世界起点**回溯，与 `identity.age` 的语义（世界起点时的年龄）严格对齐，保证 `ageAt(birthTime, 0) === npc.age`。
- **`V2Npc.age` 语义收窄**：由「当前年龄」降级为「起始年龄快照」，唯一合法读者是反推兜底；建实例仍写 `identity.age`（旧档字节兼容），此后不再重算、也不再被投影读。
- **投影**：`npcs[].age = ageAt(birthTime, worldTime)`，**形状不变**（前端 `npc.age` 消费点零改动，`main.tsx:2107 / 2193`）；`lifeStage` 顺势改用派生年龄（`projection.ts:153`）。

**4.2 派生函数（关键：不要写 `elapsedYears(now − birthTime)`）**

- `CalendarAdapter` 新增 `yearOf(minute): number` 与 `ageAt(birth, now) = yearOf(now) − yearOf(birth)`。
- **为什么不能复用 `elapsedYears`**：它的语义是「相对 `startYear` 的整年差」，把它喂给「两个时刻之差」得到的是**生日口径**（满周年才加岁），与 ADR-0013 修订 R1 已定的「**跨年界即 +1**」不一致，二者在 gregorian/custom 下会差 1 岁。
  真实反例：生于 1991-04-03、观察点 2007-01-15 —— 跨年界口径 16 岁；`elapsedYears(now − birth)` = 15 岁。
  `approx` 下两者**恰好等价**（525600 整除，`age × Y` 是整数倍），所以这个坑只会在 jjk-2006 这类 `preset: gregorian` 模板上炸。

**4.3 前置阻塞（必须一起做，否则 gregorian 下静默算错）**

- `CalendarAdapter` 当前**不支持负分钟**：`minutesToView` 首行 `Math.max(0, Math.floor(minutes))` 钳位（`time.ts:130`），`viewToMinutes` 只从 `startYear` 正向累加（`time.ts:147`）。
  于是 `toMinutes({ value: -15, unit: "year" }, 0)` 会**静默返回 0**，`yearOf(负分钟)` 全部退化成 `startYear`。
  而 15 岁角色在世界起点的出生分钟必然是负值（−15 年）——**不修负分钟，birthTime 在 gregorian 下根本无法成立**。
- ⇒ 本决策包含一处**必要的 `time.ts` 扩展**：`minutesToView` 支持从 `startYear-01-01` 向回走整年、`viewToMinutes` 支持 `year < startYear` 的负累加（`eraYearBase` 已有手写负分支 `time.ts:169-185`，复用同款思路）。
  约束：`minutes ≥ 0` 的全部输出**字节不变**（现有 `time.test.ts` 必须全绿）。
- 附带收益：R3 时间穿越需要的「回拨 / 负时间」seam 由「被钳位封死」变为「可用」，**加强**而非封死预留点。
- **注意回答用户第 4 条的原话**：`birthTime` **不可能只改 yaml 解决**。yaml 能声明出生时间（配置层），但「按世界时间推进年龄」必须有引擎参与——现状年龄是静态快照、投影直读该快照，引擎不重算就永远不变；且本仓没有任何 `birthTime` 字段可写。所以这条**必须**改 `packages`（T-2，走 ADR），不是 T-1。

**4.4 玩家侧：不做统一、不退役 `playerAgeAtStart`**（对 ADR-0012 决策 4 的范围修订）

1. 玩家派生**已正确**：`player.age = playerAgeAtStart + elapsedYears(worldTime)`（`engine.ts:491/499`、`turn.ts:768/853`），ADR-0013 修订 R1 已确认口径，无缺陷可修；
2. 退役要动 `v2-state.ts:198` 必填字段 + `setIdentity`（ADR-0018，`engine.ts:359-368`）+ 至少 6 处断言（`v2.test.ts:166/903`、`r25-acceptance.test.ts:99`、`identity-effect.test.ts` 4 例）⇒ 改动面是 NPC 侧的 2 倍，且动的是**当前在绿**的功能；
3. **语义等价、不会漂移**：birth 由整年回溯构造时，`playerAgeAtStart + (yearOf(now) − yearOf(0))` ≡ `yearOf(now) − yearOf(birth)`，两条路径数值恒等；
4. **无跨读**：全仓无条件 DSL 读 age（`schema/common.ts` 无 age 条件）、评分不读 age（`life-evaluation.ts` 零命中）、战斗不读 age（`battle.ts` 只读 attributes）⇒ 两条路径彼此不可见。

⇒ 登记 `BACKLOG B-12` 改写：**NPC 部分由本 ADR 关闭**；「玩家 `birthTime` 统一」仍为独立一刀（届时 `setIdentity` 等价改写为 `birthTime = yearsBack(age, worldTime)`，无新语义）。

**4.5 明确不做**：`identity.birthday`（月日精度）与「生日未到不加岁」维持 `OPEN_QUESTIONS #47` 不实现；`spawnNpc`（ADR-0010 决策 4 路径）仍缺，故 `birthTime` **只在建世界期反推一次，不新增写入点**。

### 决策 5：确定性影响

| 改动 | RNG 消耗 | 状态写入 | 同 seed 结果 |
|---|---|---|---|
| 战斗 ref 判活过滤 | **零**（纯读，不调 rng） | 无 | 仅当存在「确知非在世」ref 时，该场**单位构成**变化 ⇒ 该场战斗骰序不同。当前 12 场战斗 `enemies` 全是未实例化的 `enemy-*`（恒不触发），`allies` 是实例 NPC ⇒ 只有「友军已非在世」才触发 |
| `npcs[].attributes` | 零 | 零（纯读实例） | 不变 |
| `reasonCode` 展示 | 零 | 零（纯前端） | 不变 |
| `birthTime` 派生 | 零 | 零（**投影期计算**，不写 `state.npcs[].age`） | 不变；但 `npcs[].age` 由「恒定」变为「随世界时间增长」⇒ 依赖恒定值的旧断言需改写 |
| `time.ts` 负分钟支持 | 零 | 零 | `minutes ≥ 0` 输出不变 |

| 不变量 | 现状 | 本改动影响 | 保护措施 |
|---|---|---|---|
| 同 seed 同输入同结果 | 绿 | 判活引入状态读取，但仍是纯函数 | `resolveCombatRefs` 无 rng 入参；`replay.test.ts` + 新增夹具 |
| hidden 不进入玩家端 API | 绿 | 属性下发面扩大 | 只透 `attributes.order` 内键；不新增 effective/派生值 |
| 世界观规则只进模板 | 绿 | `reasonCode` 文案与术式加成落点都在模板 | 引擎不校验/不映射 `reasonCode`；不硬编码「阵亡」等词 |
| 时间/随机/ID 可注入 | 绿 | `ageAt` 走注入的 `CalendarAdapter` | 纯历法运算，不引入 `Date` |
| R3 穿越 seam 未被封死 | **负分钟被封死** | 由本次修复转为可用 | `yearOf/ageAt` 支持负分钟，`toMinutes` 负值语义用测试固化 |

### 被否决的备选

- **只在建场期过滤（最省事）**：敌人全被滤空 ⇒ `checkBattleEnd` 立即胜利 ⇒ `onVictory` 白送（`battle.ts:488`）。必须配「敌人耗尽 ⇒ 不建场」。
- **只在触发前整条跳过（ADR-0012 字面口径）**：一条命中的死敌人就让整场战斗消失，与「先死一半敌人、剩下照打」冲突；且 `ev-sj-02` 友军被封会整场不打，直接断掉终章。
- **建场期硬报错 / 加载期报错**：ADR-0012 已否决（分支先死是合法剧情），且把「可变状态」与「模板错误」混为一谈。
- **把跳过写进 `flags` / `missedEvents` / 新增事实字段**：见决策 1.4 逐条排除。
- **投影下发 `effectiveAttributes`**：hidden 补正过滤与「面板＝战斗」不可兼得，且构成第二真源。
- **用 `elapsedYears(now − birth)` 算年龄**：gregorian 下与 ADR-0013 R1 的跨年界口径差 1 岁（反例见 4.2）。
- **从 schema 删掉 `age`、只留 `birthTime`**：`CombatantBaseSchema.age` 是 strict 存档必填（`v2-state.ts:35`），删字段＝旧档全拒载 + 玩家侧连带，收益为零。
- **本轮顺手统一玩家 `birthTime`**：动在绿路径、改动面翻倍、语义等价无收益（见 4.4）。

### 后果 / 影响面

- `packages/shared/src/v2.ts`：`NpcView` 增 `attributes`（必填）；`V2Npc` 增 `birthTime?`。
- `packages/shared/src/v2-state.ts`：`V2NpcSchema` 增 `birthTime: z.number().optional()`（注释沿用 lifecycle 口径；**不升 schemaVersion**）。
- `packages/game-core/src/v2/battle.ts`：新增导出 `resolveCombatRefs`；`buildUnits` 改签名；`createBattle` 走解析结果。
- `packages/game-core/src/v2/turn.ts`：`triggerEventV2` 的 combat 前置门增「enemies 耗尽 ⇒ return」（与并发 skip 同一位置）；建实例写 `birthTime`；`TriggerResult` 增非持久化 `skipped?`。
- `packages/game-core/src/v2/time.ts`：`yearOf` / `ageAt` / 负分钟支持。
- `packages/game-core/src/v2/projection.ts`：`npcs[].attributes` + `age = ageAt(...)`。
- `apps/web/src/main.tsx`：`NpcCard` 增属性区（复用 `PlayerCard` 的 `labelOrder` + 排序逻辑，抽公共组件）；`reasonCode` 优先展示；`inactive` 兜底文案改「已离场」。
- **模板零改动**：本 ADR 不碰 `specs/data/templates/**` ⇒ 模板指纹不变，**不因本 ADR 拒载存档**（`birthTime` 可选带来的读侧兼容）。
- 迁移成本：旧档无感（反推在读取侧）；测试新增约 10 例、改写 1 类断言（NPC age 恒定）。

### 验证要点（必须有测试）

1. **死人不参战（友军）**：置 `npc-gojo` inactive ⇒ `ev-sj-02` 照打、`battle.allies` 不含 gojo、敌人列表不变。
2. **死人不参战（敌人，合成夹具）**：两敌一死一活 ⇒ 只滤死者、照打。
3. **敌人耗尽 ⇒ 整条跳过**：`eventFires`/`firedEvents`/`history`/`pendingEvents` 全无新增、`triggered` 不含该 id、once/冷却未消耗、`worldTime` 未被 `timeCost` 推进。
4. **友军为空照打**：allies 全滤空、enemies 非空 ⇒ 建场成功、`battle.allies === []`。
5. **未知 ref id（无实例）⇒ 视为可用、不跳过**（防「把整场战斗干掉」回归）。
6. **属性透出**：键集 ⊆ `attributes.order`；注入 order 外键不出现；值等于模板声明；无声明 ⇒ `{}`。
7. **`reasonCode` 展示**：有值 ⇒ 界面只出现该值（不含「已故」「失联」字样）；无值 ⇒ 回退「已离场」。
8. **跨年 +1（gregorian）**：世界时间越过 1 月 1 日 ⇒ 投影 `npcs[].age` +1，而 `state.npcs[].age` 不变。
9. **旧档缺 `birthTime`**：加载后投影 `age === identity.age`，且随世界时间推进增长（反推正确）。
10. **负分钟**：`yearOf(-n)` / `ageAt` 回溯 / `minutes ≥ 0` 输出字节不变（现有 `time.test.ts` 全绿 + 新增负值用例）。

### 建议拆任务（4 个 T-2 任务，按序施工）

| 序 | 任务 | 主改点 | 依赖 |
|---|---|---|---|
| T1 | 战斗参战 ref 判活 | `battle.ts`（`resolveCombatRefs`）+ `turn.ts`（前置门） | 无 |
| T2 | NPC 属性投影 + 前端属性区 | `projection.ts` + `main.tsx` | 无 |
| T3 | 展示口径：`reasonCode` 优先 + 「已离场」兜底 | `main.tsx` | 可与 T2 合并为同一前端提交 |
| T4 | `birthTime` 派生 | `time.ts`（负分钟 + `yearOf/ageAt`）→ `v2.ts`/`v2-state.ts`/`turn.ts`/`projection.ts` | **内部顺序不可反**：先历法能力、后数据字段（否则 gregorian 下年龄静默算错） |

---

## ADR-0022 NPC 刷新（出生队列）落地 —— 补 ADR-0010 决策 4 / R-LM-04 的欠账

- **状态**：**已实施（2026-11-12）**。属 T-2（协议 + 状态 + 效果 + 投影），故先补本条。
- **欠账事实**：ADR-0010 决策 4 与 R-LM-04 在 2026-11-12 已通过并写明「常规路径归 R2.6」：
  *刷新规则写 yaml → 世界初始化实例化 `SpawnRuleInstance` → 效果 `spawnNpc(ruleId)` 建 NPC 实例*。
  但 R2.6 只落地 WS-A / WS-B，**刷新机制从未实施**——全仓 `grep spawn` 只有 `lifecycle` 的
  `unspawned` 枚举值孤立存在，**没有任何路径能进入该状态**；`TEMPLATE_PROTOCOL_V2.md:540` 至今写着
  「`spawnNpc` 本轮未实现、模板不得使用」。与 ADR-0020（生命周期）是同一次遗漏的两个部分。
- **决策**：
  1. **配置层** `npcSpawnRules?: Array<{ id, characterRef, age? }>`（`schema/world.ts`）：
     只声明「将来会有这个角色」+ 出生年龄（`0` = 新生儿；缺省沿用 `identity.age`）。
     **刻意不提供 `spawnAt`**：R-LM-04 明确「spawn 不得由已有某事实自动触发」——时间到达也是事实，
     提供它等于把规则变成隐式调度器，与「触发权归模板事件效果」冲突。
  2. **实例层** `WorldStateV2.spawnRules: SpawnRuleInstance[]`（`{ ruleId, characterRef, status: pending|spawned, spawnedTurn, spawnedWorldTime }`）：
     世界创建时由配置实例化，进存档、可序列化；**只记引用，不复制配置域定义**（ADR-0010 决策 4）。
     `V2Npc.spawnRuleId?` 标记「由哪条规则生出」。
  3. **事实层** `WorldStateV2.spawnLog: SpawnFact[]`：**append-only**，只由 `spawnNpc` 追加，
     与 `eventFires` / `missedEvents` 同级。不写 `flags`（ADR-0010 禁令）。
  4. **建世界期**：被规则涵盖的角色初始为 `lifecycle.state = "unspawned"`（**不是 alive**）；
     **投影过滤掉 `unspawned`**——实例存在的唯一理由是让模板能用 `npcState` 条件判「还没出生」，
     它不该出现在人物列表里。仍受默认判活约束（非 alive 不自主行动、不走关系写入、不参战）。
  5. **效果** `{ type: "spawnNpc", ruleId }`：只接受**规则 id**，不接受角色 id（运行时不得拼装配置域定义）。
     幂等——已 `spawned` 则什么都不做（不重复建实例、不重复追加事实），因为模板可能重复触发同一效果。
     `rule.age` 显式声明时按它重算 `birthTime`（`worldTime + birthTimeFromAge(age)`），
     否则沿用建世界期的年龄快照。
  6. **加载期校验**：`characterRef` 必须存在、不得是 `isEnemy` 角色（敌人由 combat settle 直接 ref 引，
     不属「将来出生」语义）、规则 id 不得重复。
- **兼容**：`spawnRules` / `spawnLog` 均为**可选 + 默认 `[]`**，旧档加载补空数组，**不升 `schemaVersion`**。
  模板不声明 `npcSpawnRules` 时**行为零变化**（jjk-2006 当前未声明）。
- **本次未做（明确记录）**：
  - **不做时间驱动的自动出生**（`spawnAt`）：见决策 1 的理由。
  - **不做运行时按 seed 生成配置层定义**：#46 已由用户裁决「不做」，本轮不重新打开。
  - **不新增 `spawnRule` 条件**（如「某规则是否已触发」）：当前可用 `npcState: unspawned` 表达，
    不为未出现的需求提前建抽象。
  - **不做「NPC 出生后刷新关系/技能」**：出生即完整实例，属性与关系在模板里声明即可。
- **连带影响**：`birthTime` 此前只有建世界期一个写入点（ADR-0021 遗留项），现在 `spawnNpc`
  成为第二个写入点 ⇒ 「中途出生的角色」从概念变为可表达。
- **验证**：`pnpm typecheck` 0 错；game-core **422/422**（新增 `v2/spawn-rules.test.ts` 7 例：
  实例化队列 + unspawned 不上屏、出生后转 alive 且年龄取规则值、重复调用幂等、不自动触发、
  未知 ruleId 抛错、`npcState` 可判 unspawned、加载期三类拒载）；shared 62/62。

### ADR-0022 补记 D-1（2026-11-12）：关系投影必须剔除未登场端点

> **性质**：**投影契约补记（T-2 轻量）**，不是新决策。决策 4 只写了「人物列表」，没写「关系边与称谓子图」，
> 本补记把同一条意图补齐到关系面。属**实现缺陷修复**（现状违反既有口径），方向未变；
> `packages/shared` 零改动、不升 `schemaVersion`、存档结构不动。

- **问题（实证）**：`projection.ts:152-153` 只用 `lifecycle.state !== "unspawned"` 过滤**上屏 NPC 列表**，
  而 `:200-216` 的 `relations` 只按 `e.from === npc.id || e.to === npc.id` 过滤，**未剔除另一端未登场的边**；
  `:206-207` 的称谓推导又用未过滤的 `visibleRelations`（整张 known/inferred 子图）。
  复现：`characters.yaml:62` 有 `npc-gojo → npc-yuta {kind: relative, gap: true}`，而 `npc-yuta` 由
  `world.yaml:170-171` 的 `npcSpawnRules[rule-yuta-arrival]` 管辖、建世界期为 `unspawned`
  ⇒ 面板出现「五条悟视 `npc-yuta` 为亲戚 · 远亲」（未上屏的端点连名字都取不到，直接露出开发者 id）。
- **决策 1（判据）**：关系边端点「已显影」的判据 = **该 id 有 NPC 实例且 `lifecycle.state !== "unspawned"`**；
  一条边的**任一端**处于 `unspawned` ⇒ 整条边不进投影（列表行与称谓子图同时剔除）。
  - **否证「不在投影后 NPC 集合内」**（听起来更省事，实为错判据），两条反例：
    1. **敌人永不实例化**：模板敌人（`enemy-*`）不在 `state.npcs` 里，用该判据会把「A 视 B 为敌人」这类
       **公开信息**一并误杀——`relation-projection.test.ts:47` 现在正是正向断言 `["enemy-x","player"]` 必须存在。
       这与 ADR-0020 兼容段同一条教训同源（写入侧「找不到该 id 的关系端点按可写处理，只拦确知非在世」），
       投影侧必须同口径，否则同一个坑换一层再踩一次。
    2. **`inactive` 必须保留边与称谓**：ADR-0020 决策 6「`inactive` 照常上屏、只带状态标注」+
       `relations.ts` 的 `freezeOnDeath` 注释「逝去的祖父依旧是祖父」。「不在列表内」是**结果**不是判据，
       用它会让「上屏规则」与「关系过滤规则」互相引用，任何列表口径调整都会静默改掉关系可见性。
  - **⚠ 实测修正（2026-11-12 · QA 判据变异验证 M1）：两条反例的适用边界不同，不得混用**
    （判据本身不变，此处只限定两条反例各自能证明什么）：
    - 「**敌人永不实例化**」用于否证「**不在投影后 NPC 集合内**」：M1 把判据换成「不在上屏集合内」后，
      真红的只有 `relation-projection.test.ts` 两例——`「只投影 known / inferred 边，unknown 与 hidden 不出现」`
      与 `「player 与敌人端点必须保留」`，红灯原因均为 `["enemy-x","player"]` 少了 `enemy-x`。
      （补记起草时该断言位于 `:47`，实施后随新增用例下移到 `:61` / `:160`。）
    - 「**`inactive` 必须保留**」**不能**用于否证 M1，它防的是**另一类错法**——按
      `lifecycle.state === "alive"` 做白名单过滤。`inactive` 的 NPC 本来就上屏、本来就在投影集合内，
      故 M1 下「`inactive` 应当保留」这一**命题本身不红**（诚实记录：M1 下 `v2.test.ts` 39 例全绿；
      探针 `C4` 的**合成夹具**用例「乙 `inactive` → 乙视玩家为爸爸」亦绿。`C4` 的**真实模板**用例
      「伏黑惠 `inactive` → `enemy-toji(father)` 父亲边与称谓仍在」在 M1 下**会红**，但红灯原因是
      `enemy-toji` **无实例**、与 `inactive` 无关 —— 它反而是「敌人端点被误杀」的**第二个独立见证**，
      不是「inactive 能防 M1」的证据）。
    - 依据：`tasks/reports/RELATION-PROJECTION-FIX-ACCEPTANCE.md` §四（判据变异验证）与 §八 观察 2。
      「三条反例各绑一条断言、并在注释里写明各自区分哪种错法」的测试补强见 `docs/BACKLOG.md` B-23。
- **决策 2（`player` 端点硬保留）**：`player` 没有 NPC 实例，永不进 `hiddenNodeIds`。这条要写成实现侧的
  注释级硬约束 + 测试用例（防止后续被改造成「白名单」时静默丢掉 NPC↔玩家边，正好反噬本补记要修的另一半）。
- **决策 3（称谓子图必须收敛）**：`kinshipTerm(...)` 的入参必须是**过滤后的同一份边集**，
  与列表行共用一次收敛结果。依据 `specs/core/GAME_RULES.md §6`：「中文称谓**只在可见子图上推导**
  （否则 hidden 边会成为推理侧信道）」——未登场角色不是「可见」。`projection.ts:40-41` 的注释本就是这个
  意图，本补记只是把它落实到 `unspawned` 这一档。
- **决策 4（不可达 vs 断代，两种「算不出」不许混用）**：
  - **不可达 ⇒ 不下发 `kinshipTerm`**（`shortestPath` 为 null）；
  - **可达但断代（`gap`）/ 库无解 ⇒ 「远亲」**（`COARSE_KINSHIP_TITLE`，`exact: false`，ADR-0014 决策 5 原口径）。
  - **禁止**用「远亲」兜底「有路径但算不出」（即路径经过未登场节点）：那会向玩家**断言一条他没有任何边支撑的
    亲属关系**，并暗示「中间还有一个你不知道的人」，正是要堵的侧信道。同理**禁止**生成「未知的某人」占位行。
  - 典型场景裁定：A、B 都在屏，唯一亲属路径经未登场 C ⇒ A 与 B 之间**既无行也无称谓**（不是「远亲」）。
- **决策 5（修复点单一）**：过滤**只能**发生在 `projectSnapshotV2`（投影期）。
  **严禁写入 state 层**（改 `state.relations`）：那会同时打坏引擎侧条件（`relation` 边形态 / `npcState` 仍需读
  未登场角色）、存档内容与确定性。反过来说，正因为只动投影期，**旧档零迁移**。
- **测试反改背书**：`v2.test.ts:981-991` 现有断言（注释「五条 → 乙骨 的远亲边应带粗称谓」、
  `expect(kin?.kinshipTerm).toBe("远亲")`）**固化的是本补记认定的缺陷行为**，本次按本补记**反改**该断言，
  不得以「保持既有测试绿」为由保留泄漏。
- **本次未做（明确记录）**：
  - 不动 `characters[].visibility`（隐藏角色的上屏过滤）——与 ADR-0020 记载的既有偏差另记 BACKLOG，
    把本判据建立在 `visibility` 上会顺手改掉未裁决的展示口径。
  - 不起用 `flags["infoVisibility:<npcId>"]`（`opening.ts` 只写不读）作为投影红线判据——属新机制，另需 ADR。
- **验证（实施验收口径）**：`pnpm typecheck` 0 错；`v2/relation-projection.test.ts` 新增「未登场端点剔除 /
  称谓不跨未登场节点 / player 与敌人端点保留」三例；`v2.test.ts:981-991` 反改后转绿；
  `playthrough.test.ts` 6 种子不受影响（引擎路径不变，该文件不调 `projectSnapshotV2`）。

---

## ADR-0023 运行时生成 NPC 实例：`generated` 刷新规则（「造实例」≠「生成配置层定义」）

- **状态**：**草案 · 待 G1 门禁**（含一条必须由用户拍板的边界裁决，见文末「需用户裁决」）。
  属 **T-2**（`packages/shared` 协议族 + `packages/game-core` 内核 + 效果 DSL + 存档结构），按 `AGENTS.md` §0.3 先出本条。
- **起草人**：系统架构师（高见远）；核实基线 HEAD `080b9f1`、工作区干净。
- **关联**：ADR-0010 决策 4、ADR-0012 决策 1/3/5、ADR-0014、ADR-0020、ADR-0021、ADR-0022、OQ #46。

### 用户诉求（原文）

> 现在的生成机制解决不了随机npc生成 如玩家的子女 得想个办法

### 现状核实（以代码为准，不以旧 spec 为准）

| 事项 | 核实结论 | 证据 |
|---|---|---|
| 规则形态 | `NpcSpawnRuleSchema = { id, characterRef, age? }`，`characterRef` **必须**指向 `characters[]` 已声明角色 | `schema/world.ts:196-205` |
| 只能唤醒**预定义**角色 | 建世界期把规则实例化为 `SpawnRuleInstance`，角色 `lifecycle.state = "unspawned"` 且被投影过滤（不上屏）；`spawnNpc(ruleId)` 把**已有实例**翻成 `alive` | `v2/turn.ts:112-119`、`turn.ts:156-168`、`v2/engine.ts:439-472`、`v2/projection.ts:150-153` |
| 无法凭空造 NPC | 姓名/性别/属性/初始关系边全部来自 yaml `characters[]`；运行时**零**「造角色」路径 | `schema/character.ts` + 同上 |
| 确定性工具 | `createRng`（mulberry32）/`deriveTurnSeed`/`pickWeighted`；各域用 `deriveTurnSeed(seed + K, 维度)` 做**域隔离盐**（+7 选项、+13 战斗、+29 物品） | `rng.ts:1-40`、`turn.ts:772/891/961/1050/1095` |
| 实例 id 先例 | `evi-${enqueueSeqCounter}`：自增序列、进存档、跨重放稳定；全仓无 `randomUUID`/`Date.now` | `scheduler.ts:106-127` |
| 关系边语义 | `{from:A, to:B, kind}` = 「**B 是 A 的 kind**」；`kinshipTerm` **只沿出边**推导，反向边不反推称谓 | `schema/relation.ts:1-25`、`relations.ts`（`shortestPath`/`kinshipTerm`）、`projection.ts:196-208`、`GAME_RULES.md §6` |
| `detectCycles` 现状 | 已实现但**无任何运行时/加载期调用点**（纯库函数，仅测试引用） | `relations.ts:214`；`grep detectCycles packages apps` 仅命中定义 |
| 生成 NPC 能否进战斗 | **不能**：`buildUnits` 按 `ref` 走 `lookup.character(ref)` 取**模板定义** | `battle.ts:189/243` |
| `npcs[]` 来源 | 只装 `!isEnemy` 的模板角色；敌人永不实例化 | `turn.ts:120-160` |
| 年龄派生 | `birthTimeFromAge(age, adapter) = adapter.toMinutes({value:-age,unit:"year"},0)`；`age=0 ⇒ 0` | `time.ts:396-398`、ADR-0021 决策 4 |

### 决策 0（边界裁决）：「造一个实例」**不**构成「生成配置层定义」

**结论：不越界。** 按 seed 派生一个**实例**，产物是 `WorldStateV2` 里的本局活对象（进存档、随局销毁、不进模板 id 空间），
与 #46 禁止的「运行时按 seed 生成**配置层模板定义**」不是同一件事；模板给的是**池与规则**（authoring-time 写进 yaml），
seed 只决定**这一次抽到哪一个**。ADR-0010 决策 4 的禁令原文是「运行时不生成**新的配置层模板定义**」，
本 ADR **不改**该禁令、**不重开** #46 的候选 B。

为避免「不越界」变成一句口号，把判据写成**三条充分判据 + 四条可执行守卫**（命中任一即越界）：

| # | 越界判据 | 本 ADR 的产物 |
|---|---|---|
| ① | 产物参与/需要参与**模板指纹**，或需随模板分发到其它局 | 不进指纹；不进 `specs/data/templates/**`；销毁随局 |
| ② | 产物占用**配置层主键空间**（`characters[].id` / `skills[].id` / `events[].id` / `endings[].id`），会被加载期引用完整性校验当作「定义」 | 占实例命名空间 `npc-gen-<ruleId>-<seq>`，加载期**禁止**模板字符 id 使用 `npc-gen-` 前缀（守卫 a） |
| ③ | 产物**可被模板按 id 引用**（`characterRef` / `combat.enemies.ref` / `characters[].relations.to` / 事件选项 `requiresSkill`…） | 结构上不可引用（守卫 b/c） |

| 守卫 | 内容 | 为什么是「可执行」的边界而非注释 |
|---|---|---|
| (a) | 加载期拒绝 `characters[].id` 以 `npc-gen-` 开头 | 生成 id 永不与模板 id 撞名 ⇒ 不会出现「运行时生成的 id 被模板引用」的既成事实 |
| (b) | 生成 NPC 恒 `isEnemy: false` | 敌人只能由 combat `ref` 走模板定义 ⇒ 生成 NPC 永不可能成为战斗单位定义 |
| (c) | `buildUnits` 仍只认 `lookup.character(ref)` | 模板即便手写 `npc-gen-...` 也只会拿到 `character_not_found`，不会"碰巧"生效 |
| (d) | `npcSpawnRules[].characterRef` 仍必须命中 `characters[]` | 规则不能把实例 id 当定义引用 |

**顺手把边界写成一句话**（供协议文档引用）：
> **定义**是 authoring-time 的、跨局共享的、可被其它定义按 id 引用的；**实例**是 run-time 的、局内唯一的、只被本局状态引用的。
> 生成 NPC 只满足后者 ⇒ 不越界。反过来：**运行时生成新的事件链 / 技能 / 物品 / 状态 / 结局定义，或生成一条进入 `characters[]` 的条目 = 越界，仍需 ADR（且 #46 已裁「不做」）。**

### 决策 1：规则形态 —— 判别联合（`kind`），模板只给「池与规则」

```yaml
npcSpawnRules:
  - id: rule-player-child          # ASCII slug：^[a-z0-9][a-z0-9-]*$（新加载期校验，见下）
    kind: generated                # 缺省 "character"（旧 yaml 零改动）
    age: 0                         # 缺省 0 = 出生当下；>0 = 登场时已 n 岁（birthTime 反推）
    maxSpawns: 3                   # 缺省 1（= 与 ADR-0022 的幂等语义对齐）
    gender: { weights: { male: 1, female: 1 } }
    name:
      surnamePool: surname-common  # 可选；省略 = 无姓
      givenPool: { male: given-m, female: given-f, default: given-n }
    attributes:
      scheme: inherit              # fixed | range | inherit
      spread: { cursedEnergy: 1, physique: 1 }
      ranges: { luck: { min: 1, max: 8 } }   # 优先级 fixed > range > inherit > defaults
    parents:
      - { id: player, kind: father }         # kind 由模板给，引擎不按 gender 猜
      - { id: npc-x, kind: mother }
    childKind: { male: son, female: daughter, default: son }
    relation: { visibility: known }          # 缺省 known（出生是双方可观测事实）
    relationship: 60                         # 对玩家标量初值，缺省 0
    visibility: public                       # 角色投影闸（public|hidden）
    personality: 模板静态文案                 # 可选
    skills: []                               # 静态声明，加载期校验存在；不随机抽
```

- `kind: "character"` 保留现状全部语义（`characterRef` 必填，`age` 可选）；`kind` **缺省 `"character"`** ⇒ 现有 yaml/存档零迁移。
- **模板能给「池与规则」，不能给「结果」**：`namePools` 是模板顶层新表（`Record<poolId, {text, weight}[]>`，与 `npcs` 同域放 world.yaml），生成器只做「按权重抽一个」。
- 加载期新增校验（**必须写在 `superRefine` 顶层**，理由见 §存量缺陷 D-1）：
  1. `kind: generated` 时 `characterRef` 必须缺省、`kind: character` 时 `characterRef` 必填（互斥）；
  2. `id` 匹配 `^[a-z0-9][a-z0-9-]*$`；
  3. `namePools` 引用的每个池存在、非空、`weight ≥ 0` 且合计 `> 0`；`givenPool` 的键 ⊆ `genders[].id ∪ {"default"}`；
  4. `gender.weights` 的键 ⊆ `genders[].id`；
  5. `attributes.ranges`/`fixed`/`spread` 的键 ⊆ `attributes.order`（D-17 同一教训：键集越界必须在加载期炸，不能静默落成 `undefined` 属性）；
  6. `parents[].id ∈ characters[].id ∪ {PLAYER_ID}`，`parents[].kind ∈ KinshipKind`，`childKind` 的值 ⊆ `{son, daughter}`、键 ⊆ `genders ∪ {"default"}`；
  7. `skills` 引用存在；`maxSpawns ≥ 1` 的整数。

### 决策 2：确定性 id —— `npc-gen-<ruleId>-<seq>`，禁止 `randomUUID`

- **格式**：`npc-gen-${ruleId}-${seq}`，`seq` = 该规则的**第几次出生**（从 1 起，取 `SpawnRuleInstance.spawnedCount + 1`，效果成功后 `spawnedCount += 1`）。
- 为什么不能用 `randomUUID`：① 同 seed 必须逐字段同结果，`randomUUID` 直接破坏 R-NFR-01 回放断言；
  ② 该 id 会进 `state.relations`（`from`/`to`）、`spawnLog.npcId`、`history` 条目 id（`t${turn}-npc-${id}`），一旦不确定，**存档字节不等**；
  ③ `seq` 派生 id 天然可读、可排障（`npc-gen-rule-player-child-1` 一眼看出第二次出生）。
- 保留前缀 `npc-gen-` 由守卫 (a) 保护；`PLAYER_ID = "player"` 不受影响。

### 决策 3：RNG 隔离 —— 独立派生流 + 固定骰序表

- **绝对不用 `ctx.rng`**（主轮流）。`applyEffectsV2` 的 `ctx.rng` 是 `deriveTurnSeed(state.seed + 7, turnIndex)` 一类的**既有域流**，
  在效果里多消耗一颗骰就会让同 seed 的既有 playthrough 基线整体漂移（ADR-0011 已付过一次这种代价，不再付第二次）。
- 新派生流（落 `rng.ts`，与 `deriveTurnSeed` 同族）：

```ts
export function hashString(s: string): number;            // FNV-1a 32bit，纯函数、无 Date/随机
export function deriveSpawnSeed(worldSeed: number, ruleId: string, seq: number): number {
  const h = (worldSeed ^ hashString(ruleId) ^ 0x5f356495) >>> 0;  // 域盐：spawn
  return deriveTurnSeed(h, seq);                                   // 复用既有混合器
}
```

- 与 `deriveTurnSeed(worldSeed, turnIndex)` 的关系：**同族、不同参数位**——既有域把「维度」放第二参（`turnIndex`/`round`），
  出生流放的是 `(ruleId, seq)`，**不含 `turnIndex`**。理由：出生骰只应由「第几次出生」决定，
  含轮次会让「同一次出生在不同轮次」得到不同结果，R3 时间回拨时最难解释；不含轮次则「重放同一次出生 = 同结果」。
- **骰序表（顺序固定，实现必须照抄；新增随机取值只能追加在表尾）**：

| # | 步骤 | 触发条件 | 骰数 | 取值 |
|---|---|---|---|---|
| 1 | 性别 | 规则声明 `gender.weights`（只用 1 个选项也照掷，「声明即掷」） | 1 | `pickWeighted(genders, w => w[id], rng)` |
| 2 | 姓氏 | 规则声明 `name.surnamePool` | 1 | `pickWeighted(pool, x => x.weight ?? 1, rng)` |
| 3 | 名 | 恒有（`name.givenPool`） | 1 | 同上；性别无专属池时用 `default` |
| 4..k | 属性 | 按 `attributes.order` 顺序逐项：`range` 1 骰 / `inherit` 1 骰 / `fixed`、缺省 0 骰 | 0..n | 见决策 5 |
| 末尾 | 心情 | 规则声明 `mood.range` | 1 | `min + floor(rng() * (max - min + 1))` |

- **失败不掷骰**：所有合法性都在**加载期**校验完；运行期 `spawnNpc` 先判 `maxSpawns`/规则存在，再开掷，
  保证「掷了半截再抛错」不可能发生（否则存档会被写脏一半）。
- 骰序与**状态无关**：即使父母缺失/死亡，`inherit` 那一步**仍消耗 1 骰**（值回落 `defaults`），
  否则「父母是否在世」会改变属性骰序 ⇒ 生成结果更难复现。

### 决策 4：父母与关系边 —— 规则静态声明 + **成对写入**

- **父母写在规则里**（`parents: [{id, kind}]`），**不给 `spawnNpc` 加参数**。理由：① ADR-0022 已定「效果只接受 `ruleId`，其余归规则」；
  ② 静态父母覆盖用户诉求（玩家子女、两 NPC 子女）；③ 静态才能在**加载期**校验 `parents[].id` 存在 —— 效果参数只能运行期炸。
- **`kind` 由模板显式给**（`father`/`mother`），**引擎不按 `gender` 猜**：`genders` 是模板自定义枚举（本仓有 `femboy`/`agender`/`custom-heli`），
  引擎按性别推亲属称谓就是把世界观规则硬编码进内核（`AGENTS.md` §5 红线）。
- **每个父母写两条边**（同一次效果内原子完成，顺序固定：建 NPC → 写边 → 追加 `spawnLog`）：

| 边 | 语义 | 用途 |
|---|---|---|
| `{from: childId, to: parentId, kind: father\|mother, source: "effect", visibility}` | 「**parent 是 child 的** father/mother」 | 孩子卡片上出 `kinshipTerm`（"爸爸"/"妈妈"） |
| `{from: parentId, to: childId, kind: son\|daughter, source: "effect", visibility}` | 「**child 是 parent 的** son/daughter」 | 父母卡片上出「视孩子为儿子/女儿」+ `kinshipTerm`（"儿子"/"女儿"） |

  `child↔kind` 的映射由规则 `childKind` 给（按 `genders[].id`），同样不在引擎里按性别硬编码。
- **为什么必须成对**：`kinshipTerm` 只沿**出边**推导（`GAME_RULES.md §6`「反向边不反推称谓」），
  只写 `child→parent` 时，`kinshipTerm(player → child)` 直接 `null`，玩家永远看不到"这是你儿子"。成对写入让两个方向都可读，且都走同一个推导函数（单一真源）。
- **`visibility` 缺省 `known`**：出生是双方可观测事实。要「秘密生子」就显式写 `unknown`（边不上屏、称谓不可推 —— 这正是 hidden 语义该有的表现）。
  这与 R-OP-05「默认不认识」不冲突：那条约束针对 NPC↔玩家**初识**，亲子是模板显式声明的关系。
- **与 ADR-0014 的「称谓只在可见子图上推导」完全一致**：投影先 `projectVisibleRelations`，`kinshipTerm` 拿的是过滤后的边集；
  `unknown` 边既不展示也不参与称谓 ⇒ 无侧信道。
- **连带要求（本轮必须做）**：`detectCycles` 需对「配对反向边」豁免，否则每一条亲子关系都会被报成谱系环。见 §存量缺陷 D-2。

### 决策 5：属性继承 —— 确定性公式（父母均值 + 有界抖动 + 夹取）

对 `template.attributes.order` 里**每一项**按序求值（只写 order 内键，不引入 order 外键）：

```
value(attr) =
    fixed[attr]                                      若声明 fixed
  : min + floor(rng() * (max - min + 1))             若声明 ranges[attr] = {min,max}（闭区间整数）
  : clamp( Math.round(mean + jitter), lo, hi )       若 scheme = inherit
       mean   = 所有可解析父母的 base 值算术平均
       jitter = Math.round((rng() * 2 - 1) * (spread[attr] ?? 0))
  : attributes.defaults[attr] ?? 0                   其余
最终再 clamp 到 attributes.caps[attr]（若声明）
```

- `base` 的取法：`parents[].id === PLAYER_ID` ⇒ `state.player.attributes[attr]`；否则找 `state.npcs` 同 id 实例的 `attributes[attr]`；
  **找不到实例的父母被忽略**（与 ADR-0020「只拦确知非在世」同口径：不猜）；全父母缺 `mean` 来源 ⇒ `mean = defaults[attr] ?? 0`，**骰照掷**。
- 读的是**实例当前 base 属性**（不是投影值、不叠 `levelScale`/`statuses` 补正）——与 ADR-0021 决策 3「投影只下发 base」同源，避免第二真源。
- `Math.round`（半数向上）与 `Math.floor`（闭区间抽值）在 JS/V8 上确定；**禁用** `toFixed`/字符串比较/`Number.EPSILON` 花活。
- 范围默认 `lo = 0`、`hi = attributes.caps[attr] ?? +∞`；`inherit.range` 可显式收窄（新生儿属性不该等于成年父母）。

### 决策 6：存档与投影

- **不升 `schemaVersion`**（沿用 `lifecycle` / `birthTime` / `spawnRules` 先例）。三条理由：
  ① `spawnRules` / `spawnLog` 在旧档里**恒为 `[]`**（jjk-2006 从未声明 `npcSpawnRules`，真实存档里没有一条规则实例），加字段无既存数据可冲突；
  ② 新字段全部 **optional + 读侧默认**（`kind` 缺省 `"character"`、`spawnedCount` 缺省 0、`spawnSeq` 缺省 undefined）；
  ③ 升版本会让 `schemaVersion` 校验拒载**全部**旧档，代价远大于收益。
- 结构变更（实例层判别联合）：

```ts
type SpawnRuleInstance =
  | { ruleId; kind: "character"; characterRef: string; status; spawnedTurn; spawnedWorldTime; spawnedCount }
  | { ruleId; kind: "generated"; status; spawnedTurn; spawnedWorldTime; spawnedCount };

interface SpawnFact { npcId; ruleId; seq: number; turnIndex; worldTime; parentIds?: string[] }
// V2Npc 增 spawnSeq?: number（与既有 spawnRuleId 配对，便于回放/排障）
```

- **投影零改动**：`NpcView` **不新增** `spawnRuleId`/`spawnSeq`/`generated` 之类的"随机生成"标记。
  生成 NPC 与预定义 NPC 在玩家端**完全同形**——玩家不该看出"这是随机生成的"。
  （`spawnRuleId` 现状也未下发，见 `projection.ts:150-215`，本 ADR 维持。）
- 生成 NPC 出生即 `alive`（不经过 `unspawned`）：规则语义就是「生出来」，两步式只会让模板多写一条 `npcState` 条件。`unspawned` 语义保持给 `kind: "character"` 用。

### 决策 7：明确不做（本轮边界）

| 不做 | 理由 |
|---|---|
| 运行时生成**事件链 / 技能 / 物品 / 状态 / 结局**定义 | 越界（决策 0 判据 ①②③ 全中）；#46 已裁「不做」 |
| 生成一条进 `characters[]` 的模板条目 | 同上；配置层只读（ADR-0010 决策 4） |
| 让生成 NPC 作为 `combat.enemies/allies.ref` 或 `characterRef` | 越界（守卫 b/c）；真要做须另立 ADR 引入"实例即战斗单位"语义 |
| 技能/补正**随机池抽取** | 会扩骰序表、且出生即 0 岁本不该有技能；静态 `skills` 声明够用，成长走模板事件 `unlockSkill` |
| 属性随年龄成长 | 世界规则，不该由生成器代劳；模板用事件效果调 |
| 生成 NPC 之间自动结亲/繁衍（NPC 自我增殖） | 指数增殖 + 触发权必须归模板（R-LM-04）；本轮只有效果能触发 |
| 已出生实例的「重掷 / respec」 | 会破坏「事实只追加、逐字段不变」；且属未出现需求 |
| 时间驱动自动出生（`spawnAt`） | ADR-0022 决策 1 已否，维持 |
| **LLM 生成姓名 / 性格 / 属性** | ① 破坏同 seed 可复现；② 撞 `AGENTS.md` §5「不得让 LLM 成为唯一裁判」。LLM 若参与，只能产叙事文本（结构校验 + 回退模板，`narrative.ts` 同款），且姓名/属性仍由模板池 + seed 决定 |
| 全局 `maxAlive` 人口上限 | 属"世界规模/性能"整体议题，不是本功能的前置；本轮只给 **per-rule `maxSpawns`**（缺省 1）防重复触发爆炸，超限**不掷骰、不改状态、无操作**（ADR-0022 幂等语义的自然延伸），另记可诊断 `logs` |
| `spawnNpc` 效果加 `parentIds` 参数 | 见决策 4；将来真需要「运行时决定父母」，走规则字段 `parentsFrom: "spawner"` 并另立 ADR（要引效果上下文注入） |

### 决策 8：验证要点（必须有测试）

1. **同 seed 逐字段相同**：两个独立 world（同 seed、同模板、同一触发路径）比对 `state.npcs`（生成实例的 `id/name/gender/attributes/birthTime/spawnSeq`）、新增关系边、`spawnLog` 的 JSON —— 完全相等。
2. **主轮 RNG 零污染**：`spawnNpc` 执行前后 `ctx.rng` 的调用计数不变（spy）；另一条断言：把生成效果替换成 `setFlag` 空操作的同 seed playthrough，`lastWheels`/`history` 的事件序列一致 ⇒ 既有基线不漂移。
3. **骰序表固化**：给定 `(seed, ruleId, seq)` 直接调 `deriveSpawnSeed` + 生成器，断言性别/姓/名/各属性的具体取值（钉死骰序，防后人插入新骰）。
4. **幂等 + `maxSpawns` 护栏**：`maxSpawns: 1` 重复触发 ⇒ 只 1 个实例、1 条 `spawnLog`、`spawnedCount` 不再增长；`maxSpawns: 3` 连触 4 次 ⇒ 恰好 3 个实例，第 4 次不掷骰（计数不变）。
5. **父母边方向正确 + 称谓可推**：`kinshipTerm(relations, childId, PLAYER_ID) === "爸爸"/"妈妈"` 且 `kinshipTerm(relations, PLAYER_ID, childId) === "儿子"/"女儿"`；`visibility: unknown` 时两者皆 `null` 且边不上屏。
6. **`detectCycles` 不误报**：成对亲子边 ⇒ `detectCycles` 返回 `[]`；故意造 `a→b father, b→a father`（同向配对错误）仍上报。
7. **属性继承确定性**：父母 base 已知 ⇒ 断言 `round(mean + jitter)` 结果与夹取；父母实例缺失 ⇒ 回落 `defaults` 且**骰数不变**；`spread` 缺省 0 ⇒ 恰为均值（整数化后）。
8. **加载期拒载**（每条断言 **issue path**，不只看 `success === false`）：`kind: generated` 带 `characterRef` / `id` 非 slug / 池不存在 / 池空 / 权重和 0 / `parents` 引用未知 / `childKind` 键非法 / 属性键越界 —— 各一条。
9. **投影同形**：`NpcView` 上不出现 `spawnRuleId`/`spawnSeq`；生成 NPC 与预定义 NPC 的字段集完全一致。
10. **模板零改动不回归**：jjk-2006 未声明 `npcSpawnRules` ⇒ `playthrough.test.ts`（6 种子 × 2 开局）基线不变。

### 施工期发现的两个存量缺陷（本 ADR 必须一并处理，不得留作"顺手"）

**D-1（协议层，严重）：ADR-0022 的刷新规则加载期校验是死代码，且其测试是假绿。**
`schema/world.ts:588-601` 的整段 `npcSpawnRules` 校验被**插进了** `Object.entries(ai.assignments).forEach(...)` 的回调体内（`world.ts:585` 开、`world.ts:602-603` 闭），位于 `if (ai)` 之内。
后果：**模板未声明 `combatAi` ⇒ 刷新规则的「未知角色 / 指向敌人 / 重复 id」三条校验全不生效**；声明了 `combatAi` 则按 assignment 条数重复报错。
而 `v2/spawn-rules.test.ts:115` 的三条断言之所以"绿"，是因为 `makeTestTemplate()` 本身**另有一处既有非法引用**（`events[0].settle.normal.options[0].visibleWhen[0].requiresSkill = "sk-none"`），
`safeParse` 无论如何都返回 `false` —— 实测 `ISSUES: [["events.0.settle.normal.options.0.visibleWhen.0","未知技能：sk-none"]]`，`npcSpawnRules` 一条 issue 都没有。
⇒ **要求**：把该段提到 `superRefine` 顶层，并改用**issue path 断言**（含一条「本 case 必须恰好命中 `npcSpawnRules.*`」）。本 ADR 新增的 7 条生成的校验也必须落在顶层。

**D-2（内核层，中等）：`detectCycles` 无接线，而本 ADR 首次产生**成对**亲属边。**
`detectCycles` 已实现却无任何生产调用点（只有测试引用）。一旦有人把它接成加载期/保存期门禁，**每一条亲子关系都会爆环**。
⇒ **要求**：本轮给 `detectCycles` 加「配对反向边」豁免（仅直系五对：`father↔son`、`father↔daughter`、`mother↔son`、`mother↔daughter`、`husband↔wife`；
兄弟/姐妹配对本轮不做，模板仍单向声明），并补两向测试（合法配对 `[]`、同向伪配对仍上报）。理由：本 ADR 是**第一个**产生双向亲属边的路径，埋雷成本远高于 3 行豁免。

### 被否决的备选

- **给 `spawnNpc` 效果加 `parentIds` / `name` 等参数（把配置搬进事件）**：效果变成"半个定义"，
  加载期无法校验（父母 id、姓名池只能在运行期炸），且与 ADR-0022「效果只吃 `ruleId`」的口径分裂。规则侧静态声明一次性解决。
- **用主轮 `ctx.rng` 掷出生骰**：最省事，但同 seed 的既有 playthrough 基线整体漂移（ADR-0011 已付过账），
  且出生骰会与选项/转盘骰序耦合——模板加一条出生就改掉整局随机序列，不可接受。
- **`deriveSpawnSeed` 里带 `turnIndex`**：会让「同一次出生」在重放/回拨时得到不同结果，把确定性依赖扩大到轮次维度。
- **用 `randomUUID()` / `Date.now()` 做实例 id 或出生时间**：直接违反 R-NFR-01 与 `AGENTS.md` §2；存档字节不可比。
- **只写 `child→parent` 单向边**：省一组边，但 `kinshipTerm(player → child)` 恒 `null`（只沿出边推导），
  玩家永远看不到"这是你儿子"——正好砸在用户诉求上。
- **引擎按 `gender` 推 `father/mother`、`son/daughter`**：`genders` 是模板自定义枚举，引擎按性别分支＝硬编码世界观规则。
- **生成 NPC 走 `unspawned` 再翻 `alive` 两步**：多一次状态迁移、模板要多写条件，收益为零。
- **给 `NpcView` 加 `generated: true`**：等于在玩家端标注"这是随机 NPC"，破坏沉浸且是新信息面。
- **升 `schemaVersion` 到 3**：旧档全拒载，而真实旧档里 `spawnRules` 恒为空数组，纯亏。
- **全局 `maxAlive` 人口上限**：属性能/世界规模议题，先加会变成"猜需求"的抽象（`AGENTS.md` §2 禁止为未使用需求提前搭抽象）。

### 后果 / 影响面（文件归属按 `ARCHITECTURE.md §2` 依赖方向）

| 改动点 | 归属 | 依据 | 是否与其它任务写冲突 |
|---|---|---|---|
| `NpcSpawnRuleSchema` 判别联合 + `NamePoolSchema` + 生成规格 + **7 条加载期校验（顶层）** + 修 D-1 | `packages/shared/src/schema/world.ts` | 协议族变更（T-2） | 与任何改 `world.ts` 的任务冲突（本任务独占） |
| `SpawnRuleInstance` 判别 / `SpawnFact` 扩 / `V2Npc.spawnSeq?` | `packages/shared/src/v2.ts` | 实例层结构 | 与投影/生命周期类任务可能同文件（需串行） |
| 对应 zod | `packages/shared/src/v2-state.ts` | 存档结构 | 低 |
| `hashString` + `deriveSpawnSeed` | `packages/game-core/src/rng.ts` | 可注入确定性（`AGENTS.md` §2） | 低（新增导出，不改既有） |
| `createGeneratedNpc()` 纯函数 + 骰序表 | `packages/game-core/src/v2/spawn.ts`（**新**） | 内核确定性、可单测 | 无 |
| `spawnNpc` 分支（generated）+ 关系边双写 + `spawnLog` | `packages/game-core/src/v2/engine.ts` | 效果唯一写入口 | 与其它改 effects 的任务冲突 |
| 建世界期实例化 `kind`/`spawnedCount` | `packages/game-core/src/v2/turn.ts` | 配置→实例 | 冲突面最大（turn.ts 是热点） |
| `detectCycles` 配对反向边豁免（修 D-2） | `packages/game-core/src/v2/relations.ts` | 图内核 | 低 |
| 投影：**零改动** | `packages/game-core/src/v2/projection.ts` | 投影同形 | 无 |
| 模板接线（声明 1 条 generated 规则 + 1 个出生事件） | `specs/data/templates/**` | T-1，免 ADR | 改动必然变指纹 ⇒ 旧档拒载（既定代价） |
| 前端：**零改动** | `apps/web` | 投影形状不变 | 无 |

- **确定性**：新增独立派生流，**不消耗主轮 RNG**；生成结果只依赖 `(state.seed, ruleId, seq, 模板, 生成瞬间的 base 属性)` —— 全部是已有输入的纯函数。
- **迁移成本**：旧档零感（`spawnRules`/`spawnLog` 恒空 + 可选字段读侧默认）；模板零改动即零回归；新增测试约 20 例。
- **R3 穿越 seam**：出生流不含 `turnIndex` ⇒ 回拨重放同一次出生得同结果，**加强**而非封死预留点。

### 建议拆任务（4 个 T-2 任务，按序施工）

| 序 | 任务 | 主改点 | 依赖 |
|---|---|---|---|
| T1 | 协议与加载期：规则判别联合 + 生成规格 + 7 条顶层校验 + **修 D-1（含测试改 issue path 断言）** | `shared/src/schema/world.ts`、`shared/src/v2.ts`、`v2-state.ts` | 无 |
| T2 | 确定性生成器：`hashString`/`deriveSpawnSeed` + `createGeneratedNpc()` + 骰序表 + 继承公式 | `rng.ts`、`v2/spawn.ts`（新）、单测 | T1 |
| T3 | 引擎接线：`spawnNpc` generated 分支 + `maxSpawns` + 关系边双写 + `spawnLog` + **修 D-2（配对豁免）** | `v2/engine.ts`、`v2/turn.ts`、`v2/relations.ts`、单测 | T1、T2 |
| T4 | 模板接线与端到端：声明 1 条 generated 规则 + 1 个出生事件；跑加载期 + `playthrough.test.ts` 基线不变 | `specs/data/templates/**`（T-1） | T3 |

### 需用户裁决（1 条，阻塞 G1/G2）

**「按 seed 派生 NPC 实例」确认不属于 #46 所禁的「运行时生成配置层定义」**，并认可决策 0 的三条越界判据 + 四条守卫
（尤其是：生成 NPC 恒非敌人、永不可被模板按 id 引用、不支持生成新技能/事件链/结局定义）。
若用户认为**任何**运行时生成（含实例）都应保守地归入 #46 的禁令，则本 ADR 作废，替代方案只有两条：
① 玩家子女也必须预先在 `characters[]` 里声明 N 个占位角色（模板作者手工枚举，姓名字段写死）；
② 走 LLM 生成后落 yaml 的离线流程（非运行时）。二者都明显更差，但**属于用户可选项**，不由架构自行否决。

---

## ADR-0024 待决事件的「呈现前前提复核」——pending 不是已定论

> **本条覆盖两件事**：①引擎的「呈现前前提复核」（决策 0–8，主体）；②**已故者年龄冻结**（决策 9，
> 实施期由同一条 QA 项 P1-2 牵出的投影侧补强）。两者同属「不让已死的角色继续以活人姿态出现」。

- **状态**：**已实施（2026-11-12）**。属 **T-2**：动的是「触发策略语义 + 呈现契约」（`packages/game-core` 的
  `pendingEvents` 生命周期、`TriggerResult` 诊断位）与 `apps/server` 的载入路径；**`packages/shared` schema 零改动**、
  不升 `schemaVersion`、不扩 `MissReason`。按 `AGENTS.md` §0.3 先出本条。
  - 落地提交：`bbb440b`（引擎侧复核 + `ev-d-canteen` 模板补丁）、`b1321ec`（决策 9 投影年龄冻结）、
    `0759497`（模板侧 QA P1-1 `npc-riko` 落 lifecycle，前置依赖）。验证：`game-core` **462/462**、
    `shared` 62/62、`pnpm typecheck` 0 错。
  - **与初稿的三处偏差已在文末「实施偏差记录」固化**（`checkEventPremise` 返回判别对象、
    `revalidatePendingV2` 不接 rng、S1 判据改写）；决策 1–8 的**方向**未变，仅决策 9 为实施期新增。
- **起草人**：系统架构师（高见远）；起草基线 HEAD `8c99cf3`、工作区干净（唯一未跟踪文件是 QA 验收报告
  `tasks/reports/JJK-SCRIPT-ACCEPTANCE.md`）；实施核验基线 HEAD `b1321ec`。
- **关联**：ADR-0010（配置/实例/事实三层）、ADR-0011 决策 3（入队门控前置、门控失败不构成错失）与决策 6（链对齐）、
  ADR-0012 决策 1/2（默认判活）、ADR-0020（生命周期落地）、ADR-0021 决策 1.1/1.4（判定单一入口、错失事实不落盘）
  与决策 4.1（年龄投影期现算，决策 9 的直接前身）、ADR-0022。

### 问题（QA 实测，非推测）

用户点名的第一条要求是「死亡角色不能诈尸」。QA 用 30 种子逐条求值 `visibleWhen`，在**结算时刻**发现三类反例：

| 反例 | 命中 | 表现 | 事件级条件现状 |
|---|---|---|---|
| `ev-d-canteen ⇐ npc-haibara` | **11/30 种子** | 正文点名灰原，`opt-ct-2`「坐到七海和灰原那桌」仍可选 | **只有** `era==1`，**无任何判活** |
| `ev-d-haibara ⇐ npc-haibara` | **9/30 种子** | 3 个选项全可见，正文「灰原把便当盒拍在你桌上」 | **已有** `haibaraDead ne true` |
| `ev-d3-megumi ⇐ npc-megumi` | **5/30 种子** | 3 个选项全可见（伏黑已被夺舍） | **已有** `npcState npc-megumi alive` |

关键事实：**3 例里有 2 例的模板条件本来就是对的**（`events.yaml:869` 的 `haibaraDead ne true`、`:1189` 的
`npcState npc-megumi alive`），它们只是在 fire 时为真、排队期间变假。所以这**不是模板漏配问题**，
是引擎的复核时机问题。

对照证据（说明「事件级条件」与「选项级 `visibleWhen`」在这套 DSL 里本就分工不同，不是本 ADR 自造的区分）：
`ev-social-hook` 的每个选项都写了 `visibleWhen`（`events.yaml:1418-1422` 等），QA 判它 PASS —— 因为它的正文是
「找谁」这种**不点名**的通用文案，隐藏掉一个选项后卡片依然自洽；而那 3 个反例的正文**点名**了具体角色、
且**全部**选项都指向同一个人，隐藏选项只会剩下空卡片。

QA 定位的轨迹（种子 1）：`ev-d-canteen` fire@t212 → settle@t220（排队 8 轮，其间 haibara 阵亡、`era` 1→2）；
`ev-d-haibara` fire@t216 → settle@t223；`ev-d3-megumi` fire@t280 → settle@t282。`pendingEvents` 实测积压到 5 条。

### 现状核实（以代码为准，不以旧 spec 为准）

| 事项 | 核实结论 | 证据 |
|---|---|---|
| `pendingEvents` 元素形状 | `{ eventId, chainId? }` —— **没有 instanceId**，也**不复制**任何配置域字段 | `shared/src/v2.ts:202-206`、`:314` |
| 入队路径 | `triggerEventV2` 对 `kind: normal` 调 `enqueuePendingEvent`（按 `EVENT_SOURCE_PRIORITY` 插位，同优先级稳定 FIFO） | `turn.ts:384-387`、`:321-339` |
| 结算路径 | `chooseOptionV2` 取 `pendingEvents[0]` → 找可见选项 → `shift()` → 推进 `turnIndex`/`timeCost` → 写 history → 效果 → 结算后管线 | `turn.ts:886-947` |
| **事件级 `conditions` 求值次数** | **只有 1 次**：候选产生时（`resolvePoolV2` / `resolveHooksV2` / `enqueueCandidate` 门控）或出队终判（`evaluateDue`）。进 `pendingEvents` 后**再无人看** | `turn.ts:536-541`、`:561-570`、`scheduler.ts:162`、`:244-251` |
| **选项级 `visibleWhen` 求值次数** | **每次读都算**：投影 `pendingEventView` 一次（`turn.ts:1102`），结算 `chooseOptionV2` 再一次（`turn.ts:893-895`） | 同上 |
| `scheduledEvents` 是否已复核 | **已复核**：`drainScheduledEvents` 每轮对每个 waiting 实例跑 `evaluateDue`（`missWhen` → `conditions` → `cooldown` → fire/hold/drop） | `scheduler.ts:268-317`、`:236-252` |
| 投影是否纯读 | **是**：`projectSnapshotV2` 只读 `state`，`pendingEvent` 由纯函数 `pendingEventView` 产出 | `projection.ts:212`、`turn.ts:1090-1105` |
| 槽位语义 | `pendingEvents` 是「**只承载槽位呈现**」的 FIFO；投影只取队首；`pendingEvents.length > 0` 时**拒绝自由行动** | `v2.ts:313-314`、`turn.ts:762`、`turn.ts:1091` |
| fire 时已落哪些事实 | `recordFire`（三处索引）+ `pushHistory`（`visibility: public`，玩家可见）+ `result.triggered`（本响应回给前端） | `turn.ts:374-382` |
| 轮次入口清单 | `advanceTurnV2` / `chooseOptionV2` / `battleActionV2` / `useItemV2` —— 四者都能改状态；**`useItemV2` 没有 `pending_event_required` 守卫** | `turn.ts:759-762`、`:885`、`:959`、`:1044-1048` |
| 现有 RNG 盐 | `+0`（主轮）、`+7`（选项/`visibleWhen`）、`+13`（战斗）、`+29`（物品）；`+37` 空闲 | `grep deriveTurnSeed` |
| 存档载入 | 指纹不匹配即拒载；同一入口还做 `WorldStateV2Schema` 校验 | `apps/server/src/store.ts:110-125`、`:136-140` |

### 决策 0（定性）：这是「呈现层二次门控」，与 ADR-0011 决策 3 同源

ADR-0011 决策 3 立的口径是「**入队门控前置，门控失败不产生实例、不构成错失**」。`pendingEvents` 是**已过门控**的
队列，但它的前提状态在**入队之后**仍会变。所以本 ADR 加的是**第二道门**，且这道门的性质是**呈现门**而非**调度门**：

| | 调度门（ADR-0011） | 呈现门（本 ADR） |
|---|---|---|
| 何时 | 候选产生时 | 每次呈现/结算前 |
| 队列 | `scheduledEvents`（等**待**层，玩家看不见） | `pendingEvents`（**已占**玩家视野） |
| 失败处置 | 不入队（drop）/ 留队 hold | **必须出队**（见决策 3；理由见决策 2.4） |
| 记错失 | 不记 | **不记**（见决策 4） |

### 决策 1：复核对象 = 事件级 `trigger.conditions`（+ `missWhen`）；`visibleWhen` **不进本次复核**

| 候选 | 结论 | 理由 |
|---|---|---|
| A. 复核选项级 `visibleWhen` | **不需要** | 它**每次读都在算**（投影一次 + 结算一次，见上表）。当前实现没有缺口，再加一层只是把同一判定算第三遍 |
| B. 复核事件级 `trigger.conditions` | **必须做** | 唯一存在缺口的判定。它有且只有一次求值机会，而 `pendingEvents` 的排队窗口实测可达 8 轮 |
| C. B + `missWhen` | **做** | `missWhen` 是模板显式声明的「前提永久失效」，比 `conditions` 更强；同一处不判它，下一轮还得回来补一次 ADR |
| D. A + B「两者都要」 | **不做** | 「都要」在执行层是重复计算；且会诱导模板把「场景前提」写进 `visibleWhen`，与 E 的边界冲突（见决策 7） |

**判定口径一句话**：`trigger.conditions` = **这个场景现在成不成立**（事件级、影响正文与全部选项）；
`option.visibleWhen` = **这个选项现在该不该给玩家**（选项级、只影响可选项集合）。
「人已经死了」属于前者，永远不该用后者表达。

**不复核的东西**（显式列出，防下轮重复讨论）：`cooldown`（它是「刚触发过」的时间约束，fire 时已判定；
pending 期间再判会把玩家已看到的场景判成不合法）、`window`（pending 已无窗口语义）、`probability`/`once`/`weight`（入队门控已消费）。

**「不设条件种类白名单」**：复核用**同一个条件数组、同一个求值器**，不区分单调量（`flag`/`npcState`/`time`）与
振荡量（`mood`/`attribute`/`relation`/`inventory`）。理由：给引擎加「哪些条件可以复核」的知识＝把条件语义
拆成两套，模板作者无法从 DSL 看出差别。代价与用法约束见决策 7 的「模板作者须知」。

### 决策 2：复核点位置 —— 三层防线，缺一层就有幽灵或死锁

#### 2.1 单一纯谓词（规则只写一处，沿用 ADR-0021 决策 1.1 的同型手法）

```ts
// scheduler.ts（与 evaluateDue 同域：事件前提求值的唯一处）
export type EventPremiseVerdict =
  | { ok: true }
  | { ok: false; missWhen: true; label?: string }
  | { ok: false; missWhen: false };
export function checkEventPremise(def: EventV2, ctx: ConditionContext): EventPremiseVerdict
```

**返回判别对象而不是裸 boolean**（实施期修订，见「实施偏差记录 (a)」）：`missWhen` 命中与 `conditions` 不满足是
**两种处置**（前者 drop + 记错失，后者 hold 留队），压成 boolean 就得**再求值一次**才能分辨，而条件里的 `random`
每求值一次都消耗 RNG ⇒ 破坏「逐字节等价」。需要布尔语义的调用方读 `.ok`。

`evaluateDue` 的序 1/序 2 改为调用它（**每个条件数组恰好求值一次，判定结果不变**），`pendingEvents` 复核复用
**同一个函数**。这样「什么算前提失效」只有一份定义 —— 也就是主理人担心的「两套判定」在结构上不成立。

#### 2.2 单一排空函数

```ts
// turn.ts（pendingEvents 的归属层；不新建文件）
export function revalidatePendingV2(state: WorldStateV2, lookup: TemplateLookup): { dropped: string[] }
```

按队列顺序**全队列**扫描（不只队首）：谓词为假即从数组移除，返回被移除的 `eventId` 列表（保序，确定性）。
不推 `turnIndex`、不加 `worldTime`、不写 history、不记 `missedEvents`（见决策 4）、不动 `eventFires`。
**不接受外部 rng 参数**：内部自建 `deriveTurnSeed(seed + 37, turnIndex)`（决策 8），否则复核开销会被记到
调用方的随机序列账上（见「实施偏差记录 (b)」）。定义缺失的条目**保留**（那是加载期完整性问题，不属前提失效）。

#### 2.3 调用点清单（这是本 ADR 的硬约束）

| # | 位置 | 时机 | 作用 |
|---|---|---|---|
| 1 | `advanceTurnV2` 首行（`assertActive` 之后、**槽位守卫之前**） | 命令入口 | 保证槽位守卫看到的是干净队列 |
| 2 | `chooseOptionV2` 首行 | 命令入口 | **权威门**：即便状态被外部改坏 / 旧档残留，也不可能结算一个前提已假的事件 |
| 3 | `battleActionV2` / `useItemV2` 首行 | 命令入口 | 二者都能在两轮之间改状态（`useItemV2` **没有** `pending_event_required` 守卫，`turn.ts:1044-1048`） |
| 4 | **`projectWithConfig()` 之前**（四个入口各自末尾，建议收敛成一个共享小函数，如 `revalidateThenProject()`） | 响应生成前 | **唯一的必做项**：保证任何返回给玩家的 `snapshot` 里没有幽灵 |
| 5 | `worldStore.hydrate()` 逐世界一次 | 载入 | 旧档 / 手改档一次性规范化（有变更则 `persist`） |
| 6 | `pendingEventView` 的**只读守卫** | 投影 | 队首前提为假 ⇒ 返回 `null`（防御；正常流程不命中） |

#### 2.4 投影「只看队首，绝不跳读」

即使队首已失效，`pendingEventView` **也不得**跳到下一个有效事件呈现。若跳读，投影呈现的会是
`pendingEvents[k]`，而 `chooseOptionV2` 取 `pendingEvents[0]`（`turn.ts:886`）—— 玩家点的是 A 的选项、
引擎在找 B 的选项 ⇒ 必然 `option_not_available`。**「呈现集合 = 队首」是不可破的耦合**，所以失效队首只有
两条出路：**排空**（本 ADR）或**呈现 null**，没有第三条。

#### 2.5 各项的必要性与「单独上线会坏在哪」

先补一个容易被忽略的实现事实：`worldStore.get()` 返回的是**内存里的同一个对象**，轮次函数**原地改**它
（`apps/server/src/index.ts:95`、`:191-192`；无 `structuredClone`）。所以抛错路径虽然不落盘，**内存已被改**。
下面按这一点如实描述：

| 只做 | 后果 |
|---|---|
| **只做 #6 投影守卫** | 队首失效 ⇒ 呈现 null，而**没有任何路径会清掉队首** ⇒ 自由行动永被 `pending_event_required` 拒绝（`turn.ts:762`）＝**硬死锁**。这是本 ADR 唯一真正致命的组合，也是「投影过滤不排空」必须被否决的原因 |
| 只做 #4（尾部排空） | 常态已够（每次响应都干净）；但状态被外部改坏 / 旧档残留时，第一个命令会**先结算再排空**，即**结算了一个前提已假的事件**——缺陷在最需要它的那条路径上没起作用 |
| 只做 #1-3（入口排空） | 命令侧安全了，但**本轮内「fire 后立刻失效」**（同轮死亡 + 触发）的条目仍留在本次响应的 `snapshot` 里，玩家会看到一张下一轮就消失的卡 |
| 不做 #5（载入规范化） | 只影响**同模板指纹的旧档**。若同批改 yaml（必然改指纹 ⇒ 旧档拒载，`store.ts:114-118`）则此场景不可达，故非阻塞；**仍建议做**：成本约 1 行、幂等，且覆盖测试夹具与手改存档 |
| #1-3 缺少时的隐藏代价 | 抛错虽不落盘，内存已改 ⇒ 玩家侧表现为「一次假报错 + 刷新后恢复正常」（无死锁，但难看）。所以 #1/#2 的目的是**不让假报错发生**，而不是防死锁 |

### 决策 3：复核失败的处置 —— **静默移出待决队列**（drop），槽位立即让位

| 候选 | 否决/采纳理由 |
|---|---|
| **① 丢弃待决事件**（**采纳**） | 唯一不产生新状态语义的处置。不占轮次、不写事实、不留僵尸引用；与 ADR-0011 的 `miss_when` 出队同型 |
| ② 只隐藏失效选项、保留事件 | **会造出「零选项卡片」**：`pendingEventView` 的 `options` 是过滤结果，可以是空数组（`turn.ts:1100-1104`）；此时 `chooseOptionV2` 任何 `optionId` 都抛 `option_not_available`（`turn.ts:896`），而自由行动又被槽位守卫拒绝（`turn.ts:762`）⇒ **玩家硬死锁**。这正是本 ADR 最不能采纳的选项，而它恰好是 QA 建议的短期补丁形态（见决策 7） |
| ③ 保留事件但「叙事降级」 | **引擎不做叙事**：①`AGENTS.md` §1「AI/引擎不承载世界观规则」，`narrative` 是模板的单一字符串，DSL 里**没有**「按条件换正文」的位置；②要支持就得加 schema（条件化文案），属新协议面且与本缺陷不成比例；③正确做法是把一个场景**拆成两个互斥条件的事件**，写在 yaml 里（T-1，免 ADR） |
| ④ 重新入队延后 | 需要「还能不能变回真」的知识，引擎没有；振荡量场景会与 valid 事件争队首造成顺序抖动；若全队列都失效仍需兜底 drop ⇒ 复杂度换零收益。另：死亡是**棘轮**（ADR-0020 决策 3「复活不解冻」同型），反向重估在绝大多数场景不会发生 |

**默认处置 = ①**，细则：

- **不占轮次**：不推进 `turnIndex`、不结算 `timeCost`、不写 `history`（玩家没做选择、世界没花时间）。
- **槽位立即让位**：同一响应里，下一个占位者（若有）成为新队首并呈现；队列清空则该轮回到「空槽」（可自由行动）。
- **不退还 `once` / 冷却**：fire 时的 `recordFire` 三处写已发生，事实层 append-only，退还＝删事实（见决策 4）。
- **附则（建议同批做，2 行）**：把本轮被丢弃的 `eventId` 从 `result.triggered` 中剔除。否则「同一轮内死+触发」时，
  同一响应的 `triggeredEvents` 会报「食堂的三张桌子」而 `snapshot.pendingEvent` 却是 `null`，前端两处观感不一致。

**玩家可见后果（精确描述，不夸大也不掩饰）**：

1. **正常路径：完全不可见。** 因为排空发生在**每次响应生成之前**（2.3 的 #4），前提一旦失效，下一个响应里
   这条待决事件就不存在了 —— 玩家从未见过它。
2. 唯一的「消失」窗口是「**呈现之后、结算之前又发生了状态变更**」。当前这种入口只有 `useItemV2`（轮外操作、
   无 pending 守卫）。把排空也接进 `useItemV2`（2.3 #3）之后，丢弃与「玩家刚做的那个动作」出现在**同一个响应**里，
   因果是连贯的：你用了道具 → 世界变了 → 那个场景不再成立。
3. fire 那一轮的响应里已经下发过 `result.triggered`（标题 + 正文，`turn.ts:375`）与一条 `history`（`turn.ts:376-382`）。
   那是 **fire 时刻**的记录，此刻前提为真 ⇒ **不构成诈尸**，语义上是「被旁白带过的场景，玩家没赶上做选择」。
   这条历史条目**保留**（事实层只追加），是否要改成「结算时才落叙事」见「明确不做」。

### 决策 4：**不记 `missedEvents`**、不扩 `MissReason`、不退还 fire 事实

三条理由，任一独立成立：

1. **结构不允许**：`MissedEventRecord` 要求每条记录有 `instanceId`（`v2.ts:213-223`），而 `PendingEvent` 只有
   `{ eventId, chainId? }`（`v2.ts:202-206`）。要写就得**编造一个 instanceId** —— 伪造事实。
   （同型判决见 ADR-0021 决策 1.4 对「战斗因判活被跳过」的处理。）
2. **语义不对**：`MissReason` 现为 `window_expired | miss_when`。本情形既非窗口过期、也非模板声明的 `missWhen`；
   扩枚举＝协议变更，且会把「呈现层失效」说成「调度层错失」，误导后续消费者（错过列表、投影文案）。
3. **与 ADR-0011 决策 3 一致**：门控失败不构成错失。本 ADR 加的是第二道门（决策 0），第二道门失败同理不记。
   这也是对主理人倾向（「不记，因为这不是调度层错失，是呈现层失效」）的确认：**同意，且这不构成对 ADR-0011 的修订**。

**可诊断性补偿**（沿用 ADR-0021 决策 1.4 的手法，**非持久化**）：`TriggerResult` 增加
`droppedPending?: string[]`（本轮被排空的 `eventId`，保序）。**不复用现有 `skipped?: string`** —— 那是单槽，
同一轮里被战斗判活跳过写一次、再被本机制覆盖，会丢掉前者（`turn.ts:243-262` 已自陈该局限）。
不进存档 / 投影 / 玩家端 API。

### 决策 5：**不并入「默认判活清单」**，另立「前提复核」条目

ADR-0020/0021/0022 的「默认判活」清单（自主行动 / 关系写入 / 战斗参战 ref，加上出生规则的非 alive 过滤）回答的是
「**这个 NPC 现在能不能被引擎拿来做事**」—— 它不依赖模板书写。本 ADR 回答的是
「**模板给这个场景声明的必要前提现在还成不成立**」—— 前提可以是 `flag`/`era`/`time`/`npcState` 任意组合。

把它挂进「判活」名下会造成两个错误预期：①读者以为它只管死人，将来条件复核扩展到时间穿越的可见性投影时
会以为要新建机制；②模板作者会以为「只要 NPC 活着就没事」，而实际上 `era` 翻页、`chapter` 推进同样会让场景失效。

**结论**：记为一条**独立机制**「呈现前前提复核」，并在 ADR 索引里注明它**顺带覆盖**了「已死角色仍出场」这一类，
覆盖方式是「模板用 `npcState` 把这个前提写进 `trigger.conditions`」—— 也就是说，它拿到的是判活的**效果**，
但机制上不属于判活。默认判活清单**不加第四条**。

### 决策 6：链条目被丢弃时**不处置链**（已知限制，附重开条件）

pending 里带 `chainId` 的事件被丢弃后，`advanceChainOnSettle` 不会执行 ⇒ `chain.stepIndex` 停在那一
步、`chain.status` 保持 `active`；而 `evaluateChain` 只要该步的定义还在就返回 `active`（`scheduler.ts:327-341`），
所以 `advanceNextTurnChains` 的「非 active 即完结」兜底（`turn.ts:606-609`）永远不会触发 ⇒ **僵尸链**。

**裁决：本轮不处置。** 三条理由：

1. **窗口极窄且当前不可达**：链事件的待决优先级是 0（`EVENT_SOURCE_PRIORITY.chain`，`turn.ts:304-309`），
   入队插在队首 ⇒ 待决窗口 ≤ 1 轮；实测 3 例反例**全部**是 pool 事件（优先级 3）。jjk-2006 的链步骤也没有会在
   1 轮内翻转的条件。
2. **没有任何消费者读「链已完结」**：`evaluateChain` 的返回值只回喂给 `advanceNextTurnChains` 自己；
   结局/解锁目前只读 `flags`。所以僵尸链今天**无玩法影响**。
3. **两种「处置」都要引擎替模板判断叙事**：主动 `completed`（＝提前宣布主线到此结束）或 `alignChainStep`
   跳步（＝替模板决定「跳过这一步、继续后面」），都违反 ADR-0012「引擎不替模板决定语义」。

**重开条件（写死在这里，不留口头共识）**：出现以下任一情况必须回来补「丢弃时按 `alignChainStep` 无参形态
对齐到下一个 `advanceWhen: nextTurn` 步」：①模板出现带 `trigger.conditions` 的链步骤；②出现任何读
`chain.status === "completed"` 的消费者（结局、解锁、评价维度）。

### 决策 7：模板侧 —— **补数据可以，补 option 级 `visibleWhen` 不行**

QA 建议「给引用在世角色的 option 补 `visibleWhen: npcState alive`」作为短期补丁。裁决分两半：

| 补丁形态 | 裁决 | 理由 |
|---|---|---|
| 给 `ev-d-canteen` 的 **`trigger.conditions`** 补判活（`haibaraDead ne true` 或 `npcState npc-haibara alive`） | **做**（T-1，免 ADR） | 它确实是漏配（3 例里唯一一个）。补齐后事件**不再在灰原死后 fire**。**建议用 `{ npcState: { npcId: npc-haibara, state: alive } }`**：`lifecycle` 是单一真源（ADR-0020），与 `ev-d3-megumi:1189` 写法一致；`haibaraDead` 是模板自己的黑板，可能与 `lifecycle` 漂移（已有分支只写其一时会出现双真源） |
| 给任何事件的 **`option.visibleWhen`** 补判活 | **不做** | ①**治不了正文**：`narrative` 是事件级单一字符串，选项被隐藏后卡片仍在说「灰原把便当盒拍在你桌上」；②**会造死锁**：这 3 个事件的全部选项都指向同一个已故角色 ⇒ 全被隐藏 ⇒ 零选项卡片（见决策 3 候选 ②的证据链）；③**与引擎复核重复**：若引擎已复核 `conditions`，选项级判活是同一事实的第二处判定，主理人担心的「两套判定」正是这个 |
| 「引擎根治后，模板补丁反而有害？」 | **分情况** | 补 `trigger.conditions` **无害且必要**——引擎复核的正是它，不写引擎就无从判断（引擎不许猜「哪些 NPC 被正文点名」）；补 `visibleWhen` **有害**，理由同上 |

**模板作者须知（本 ADR 的用法约束，建议同步进 `TEMPLATE_PROTOCOL_V2.md`）**：
`trigger.conditions` 是**场景前提**，会在「入队时」和「每次呈现前」两次求值 ⇒ **不要把会振荡的量写进前提**
（`mood.gte`、`relation.gte`、`attribute.gte`、`inventory.gte`）。写了就会在低潮期把已经排队的好场景丢掉，
而丢掉不记错失、不退冷却，内容静默损失。振荡型条件应写到效果层或选项级 `visibleWhen`。

### 决策 8：schema / 协议 / RNG

- **`packages/shared` 零改动**：`PendingEvent` 形状不变、`MissReason` 不扩、不新增「允许失效丢弃」声明位
  （`invalidateOn`/`presentWhen` 之类）。**不升 `schemaVersion`**（旧档可直接载入，载入时由 2.3 #5 规范化）。
- **不加「允许失效」声明位的理由**：那等于给模板一个「允许出现幽灵场景」的开关，默认值无论取哪边都错
  —— 默认允许＝缺陷保留，默认禁止＝开关无意义。正确性不能是可选项。
- **错误码**：`chooseOptionV2` 排空后若 `command.optionId` 所属事件本轮被丢弃，抛 `event_premise_invalidated`
  （区别于 `option_not_available`，便于客户端区分「状态过期，请重取快照」与「请求非法」）。
  `apps/server/src/index.ts:435` 的 `interactionErrors` 加入该码 ⇒ 409（语义是状态冲突，与 `pending_event_required` 同级）。
- **RNG**：复核使用**独立派生流** `createRng(deriveTurnSeed(state.seed + 37, state.turnIndex))`。
  `+37` 在现有盐 `{0, +7, +13, +29}` 之外，**不污染主轮与选项/战斗/物品序列**。若前提里写了 `random` 条件，
  它只消耗这条独立流：同一 `(seed, turnIndex, state)` 恒得同一结果（确定性成立），且它的取值与 fire 时那次
  求值无关（＝重新掷一次，这是「复核」的应有语义）。

### 决策 9：已故者年龄冻结在 `lifecycle.sinceWorldTime`（实施期新增，投影侧）

#### 9.1 背景：这是「诈尸」的隐蔽变体

QA P1-1 把 `npc-riko` 的 `state`/`reasonCode` 修对之后，面板变成「天内理子 · 已故 · 阵亡 · **26 岁**」——
**而年龄仍在年年长**（实测修前 26→27）。根因：`projection.ts` 的 `npcs[].age` 一律按
`ageAt(birthTime, worldTime)` 现算，**完全不看 lifecycle**。死人不该过生日，`era` 一翻页就自己长了一岁，
比"选项还能点"更隐蔽，但玩家一眼就能看到。

#### 9.2 决策

```ts
// projection.ts（纯投影；零状态写、零 schema）
const ageBasis = npc.lifecycle.state === "alive" ? state.worldTime : npc.lifecycle.sinceWorldTime;
const npcAge = adapter.ageAt(npc.birthTime ?? birthTimeFromAge(npc.age, adapter), ageBasis);
```

1. `alive` ⇒ 基准 `worldTime`（行为**逐字段不变**，不误伤活人）。
2. **非 alive（`inactive` / `unspawned`）⇒ 基准 `lifecycle.sinceWorldTime`**，即「状态变更那一刻」。
3. **`lifeStage` / `lifeStageLabel` 与 `age` 用同一个 `npcAge` 派生**，不另设基准 —— 否则年龄冻结而阶段单独漂移，
   正是「双基准」这类缺陷的经典形态。
4. 判据**只读 `lifecycle.state`，不读 `reasonCode`**（ADR-0012 决策 1 的禁令继续有效：阵亡 / 被夺舍 / 封印 / 未登场
   一律同口径）。
5. 复活（回 `alive`）后 `sinceWorldTime` 已被 `setNpcLifecycle` 刷新到当下 ⇒ **自动**恢复按 `worldTime` 增长，
   不需要额外分支。

#### 9.3 为什么**不**用「把死亡时年龄单独存一个字段」

| 候选 | 否决理由 |
|---|---|
| `V2Npc.deathAge` / `ageAtDeath` 缓存字段 | 与 `ageAt(birthTime, …)` 形成**第二真源**：同一个数字有两个来源，任何一处漏更新就漂移。而且它要进存档 ⇒ 迁移成本 + 旧档语义（老存档没有这个字段，得回填）。同型判决已两次：ADR-0012 否决「`age` 保留为每轮 tick 更新的缓存字段」、ADR-0020 决策 4 用 `birthTime` 派生而非存年龄 |
| `flags` 里记 `ageFrozenAt` | ADR-0010 决策 2 明令引擎内部记录不得进 flags（模板条件可读引擎内部记录＝层级墙穿透） |
| 在死亡效果里把 `identity.age` 写成终值 | 那会把「快照」和「派生」混成一个字段，且复活后无法恢复增长 |

**`sinceWorldTime` 天然就是正确锚点**：它是 lifecycle 状态变更的唯一时间戳（ADR-0020 决策 1），
「非 alive 区间」=[`sinceWorldTime`, 复活时刻) 由状态机自己维护 ⇒ 引擎不需要新字段、不需要新逻辑，
也不需要知道「死」这个语义。这正好符合「世界观规则只进模板、结构留给引擎」。

#### 9.4 边界

- **投影不回写**：`state.npcs[].age` 仍是起始年龄快照，冻结只发生在投影期（与 ADR-0021 决策 4.1 的
  「年龄投影期现算」一脉相承）。
- **`unspawned` 同口径**：还没登场的角色按建世界时刻计龄，不会「凭空长大」；`spawnNpc` 翻 `alive` 时
  `sinceWorldTime` 刷新 ⇒ 登场后按当下世界时间计龄。
- **零 schema / 零 `schemaVersion`**：判据全在既有字段上，旧档加载后即刻生效（不需要回填）。
- **附带修掉一个潜伏缺陷**：若模板用 `characters[].lifecycle` 声明「开局即已故」的角色（建世界期 `sinceWorldTime = 0`），
  此前它也会随 `worldTime` 一路长大（「死了一百年的人按当下年龄上屏」）；现在按声明年龄冻结。
- **已知语义假设（必须写明，否则会被当成缺陷报回来）**：本决策把 `inactive` **一律**视为「不计龄」，
  因此「失踪 / 封印 / 长眠十年后归来」这类**时间仍在流逝**的角色，复活（回 `alive`）后年龄**不会**补上这十年。
  **这不是疏忽，是当前三态模型下的唯一可选项**：要区分「死亡不计龄」与「失踪照常计龄」就必须按 `reasonCode`
  分支，而 ADR-0012 决策 1 明令引擎不得对 `reasonCode` 分支（那是模板自由字符串）。
  **若模板真需要「失踪期间照常长大」**，正确做法是给 lifecycle 加一个**结构位**（如 `ageFrozen: boolean`，
  缺省按 `state === "alive"` 派生，模板可显式覆盖），而不是让引擎猜 `reasonCode` —— 那属协议变更，需单独 ADR。
  **重开条件**：出现任一「时间流逝型 inactive」角色（失踪 / 长期封印 / 沉睡）需要正确计龄时，回来做 `ageFrozen`。

#### 9.5 验证要点（已落 `v2/npc-age-projection.test.ts` 4 例）

1. 置 `inactive` 后推进 5 年，`age` / `lifeStage` / `lifeStageLabel` **三者都不变**，且 `state.npcs[].age` 未被回写。
2. 同局未死的 NPC 照常增长（证明「只冻结非 alive」，不是一刀切冻全表）。
3. 复活后按 `worldTime` 恢复增长（断言等于 `ageAt(birthTime, worldTime)` 且严格大于死亡时年龄）。
4. `unspawned` 按 `sinceWorldTime` 计龄，登场后按当下世界时间计龄。
5. 端到端（jjk-2006，临时探针已删）：`npc-riko` 于 2006-08 置 `inactive(阵亡)`，投影 2006-08 / 2018 / 2019 末
   的 `age` 恒为 **14**（修前 26 → 27），`lifeStage` 恒为 `youth`。

### 实施偏差记录（2026-11-12）

> 本节的存在理由：**禁止后来者照本 ADR 初稿的签名"重写一遍"**。以下四条是实现时的定稿，与初稿不同或初稿未写明。

**(a) `checkEventPremise` 返回判别对象 `EventPremiseVerdict`，不是裸 boolean**

```ts
type EventPremiseVerdict = { ok: true } | { ok: false; missWhen: true; label?: string } | { ok: false; missWhen: false };
```

初稿写的是 `: boolean`，**不要改回去**。原因：`evaluateDue` 对两种失败的处置不同（`missWhen` ⇒ drop + 记错失；
`conditions` ⇒ hold 留队）。压成 boolean 后调用方要分辨就得**再求值一次**，而条件里的 `random` 每求值一次都消耗
RNG ⇒ 「逐字节等价重构」立刻不成立（RNG 流被多扣一次，全模板基线平移）。需要布尔语义的调用方读 `.ok`。

**(b) `revalidatePendingV2(state, lookup)` 不接受 `rng` 参数**

初稿签名即如此（决策 2.2），此处固化理由：若把调用方的 rng 传进来，复核开销会**记到调用方随机序列账上**
（`chooseOptionV2` 的 `+7` 流、`battleActionV2` 的 `+13` 流…），等于「每多挂一个调用点就改一次骰序」。
内部自建 `createRng(deriveTurnSeed(state.seed + 37, state.turnIndex))` ⇒ 复核是**完全独立的一条流**，
同一个 `(seed, turnIndex, state)` 恒得同一结果，且不污染任何既有序列。

**(c) S1 判据改写**（原「0 丢弃局指纹不变」作废，理由见「确定性影响」节 S1）

**(d) 初稿的"建议"在实施中的落定形态**

| 初稿表述 | 实际落定 |
|---|---|
| 决策 2.3 #4「建议收敛成一个共享小函数，如 `revalidateThenProject()`」 | 已落地 `revalidateThenProject()`（`turn.ts`），四个入口末尾统一调用，内含「排空 + 并入 `droppedPending` + `projectWithConfig`」 |
| 决策 2.3 #6「`pendingEventView` 只读守卫」 | 已落地在 `pendingEventView` 内（用独立盐 `+37`），**`projection.ts` 因此零改动**（符合影响面表） |
| 决策 3 附则「把本轮丢弃的 id 从 `result.triggered` 剔除」 | 已落地（`recordDroppedPending()`） |
| 决策 8「`event_premise_invalidated` 进 `interactionErrors` ⇒ 409」 | 已落地（`apps/server/src/index.ts:442`） |
| 决策 2.2「定义缺失的条目保留」 | 已落地并加了显式说明：那是加载期完整性问题（`pendingEventView` 已返回 null），复核不越权删除 |

### 被否决的备选（总表）

- **只在投影层过滤、不动队列**：造成 UI 死锁（决策 2.5）与「点击选项必然失败」的双重故障。**否决**。
- **投影跳读下一个有效事件**：破坏「呈现集合 = 队首」的耦合，结算入口按 `[0]` 取值 ⇒ 必然错位。**否决**。
- **给 `pendingEvents` 加 `instanceId` 以便记错失**：为一条不需要的记录扩协议，且会诱导把 pending 当 scheduled 用
  （两套实例生命周期）。**否决**。
- **在 `setNpcLifecycle` 里追溯清理引用该 NPC 的待决事件**：①死亡不是唯一失效源（`era`/`chapter`/`flag`/`time` 都会变），
  按事实种类逐个补出口＝把一个通用复核拆成 N 个特化路径；②效果层反向感知呈现层，破坏 ADR-0010 的分层方向；
  ③写入时不知道哪些事件引用了该 NPC，要反查配置域（违反「配置/实例分离」）。**否决**。
- **对 `scheduledEvents` 也加「同样的复核」**：`evaluateDue` 已经在做（`missWhen` → `conditions` → `cooldown`），
  再加一层是同一判定算两遍，还会让 `hold` 语义分叉。**否决（重复劳动）**。
- **把 `recordFire` / `pushHistory` 从 fire 时移到 settle 时**（从根上消除「已落事实但未呈现」）：
  这是更干净的模型，但它同时改 `once`/冷却的时点语义、改 `V2TurnResult.triggeredEvents` 的契约
  （前端靠它在 fire 那轮弹提示），并让所有 `eventFires` 基线平移 —— 收益（消除一条时间戳正确的历史条目）
  与代价严重不成比例。**本轮不做**，若将来要动，独立 ADR。
- **给 `pendingEvents` 设长度上限 / 改优先级**（QA P2-3 提的积压问题）：属调度策略议题，与本缺陷正交，
  且改优先级会动 `EVENT_SOURCE_PRIORITY` 的既有契约。**本轮不做**，记 `docs/BACKLOG.md`。

### 影响面与文件归属（按 `ARCHITECTURE.md` §2 依赖方向）

| 改动点 | 归属 | 依据 | 写冲突 |
|---|---|---|---|
| `checkEventPremise()` 纯谓词 + `evaluateDue` 等价重构 | `packages/game-core/src/v2/scheduler.ts` | 事件前提求值的唯一处（与 `evaluateDue` 同域） | 与任何改调度器的任务冲突（本任务独占） |
| `revalidatePendingV2()` + 四个入口首行 + 四个入口末尾（`projectWithConfig` 之前收敛成一个共享小函数）+ `pendingEventView` 守卫 + `TriggerResult.droppedPending:` + `result.triggered` 剔除 | `packages/game-core/src/v2/turn.ts` | `pendingEvents` 归 turn 层 | **turn.ts 是热点**，与任何改轮次管线的任务必须串行 |
| 载入时规范化 | `apps/server/src/store.ts`（`hydrate`）/ 或在 `index.ts` 启动序列 | server → game-core 合法 | 低 |
| `event_premise_invalidated` 加入 `interactionErrors` | `apps/server/src/index.ts:435` | 错误映射层 | 低 |
| 投影 | `packages/game-core/src/v2/projection.ts` **零改动**（守卫在 `turn.ts` 的 `pendingEventView` 内） | 投影形状不变 | 无 |
| `packages/shared` | **零改动** | schema 不变 | 无 |
| 模板 | `ev-d-canteen` 补 `trigger.conditions` 判活（决策 7） | T-1，免 ADR；**改动必然变模板指纹 ⇒ 旧档拒载（ADR-0007 既定代价，须写进交付说明）** | 与任何改 `events.yaml` 的任务冲突 |
| 前端 | **零改动**（`pendingEvent: null` 已是既有形状；新错误码走既有 toast 通道） | 投影契约不变 | 无 |

**并行施工提示（起草时实测）**：起草期间 `specs/data/templates/jjk-2006/events.yaml` 已被另一任务改动
（`npc-riko` 补 `setNpcLifecycle`，即 QA P1-1，`git status` 可见）。因此：①本 ADR 决策 7 的模板补丁
（`ev-d-canteen`）**必须与该任务的提交串行**，不能两人同时改同一文件；②模板指纹本批必然变化 ⇒ 旧档拒载，
决策 2.3 #5 的载入规范化在本批属「防御性冗余」（仍建议做，成本极低）；③`npc-riko` 变 `inactive` 本身
不会触发新的丢弃（现存模板没有任何 `trigger.conditions` 引用 `npc-riko`，已核查）。

### 不变量检查表

| 不变量 | 现状 | 本改动影响 | 保护措施 |
|---|---|---|---|
| 同 seed 同输入同结果 | 成立 | **会改变受影响 seed 的轨迹**（丢弃 ⇒ 少一轮 `turnIndex`/`worldTime`） | 独立 RNG 盐 `+37` 不污染主流；断言「**首次丢弃之前的逐轮指纹与基线逐字节相同**」（S1 改写见下） |
| hidden 不进入玩家端 API | 成立（另有 QA P2-1 `visibility` 未生效的 pre-existing 缺陷） | 无影响 | 本次不碰投影字段集；危险不在本次范围 |
| 世界观规则只进模板 | 成立 | **强化**：复核只读 `trigger.conditions`，引擎不内建「死人不能出场」 | 不新增任何「按 reasonCode / 按 NPC 分支」的引擎逻辑 |
| 时间/随机/ID 可注入 | 成立 | 复核引入新 RNG 派生（盐 `+37`），仍由 `state.seed` 决定 | 不读 `Date`/`Math.random`；派生点写在一处 |
| R3 穿越 seam 未被封死 | 三个预留点（事件实例标识 / `TimeAdapter` / 可见性投影）均未硬化 | **正向**：复核是「呈现前求值」，时间回拨后同一事件可重估前提，不写死时间单调 | 复核不缓存结果、不在 fire 时固化前提真值 |
| 引擎不替模板判断语义 | 成立 | 丢弃＝「不呈现」，不是「剧情作废」；不 `completed` 链、不写错失 | 决策 3 / 决策 6 |

### 确定性影响与「变化是预期的、不是回归」的判据

1. **预期变化的范围**：只有「排队期间前提翻转」的 seed 会变。QA 实测上限是 11/30、9/30、5/30（三个事件，
   种子集合不同）。变化形态：该事件被丢弃 ⇒ 少一次结算轮 ⇒ 后续 `turnIndex` / `worldTime` / 属性 / 骰序整体平移。
2. **可断言的非回归判据（这是核心，别用「看着差不多」替代）**：
   - **S1（已改写，原表述作废）**：对每个种子记下「第一次丢弃发生的轮次」`T_d`，断言
     **`T_d` 之前（含 `T_d` 那一步）每一轮的逐轮状态指纹与基线逐字节相同**，且**首个差异恰好出现在
     `T_d` 之后的第一步**（＝丢弃那条命令的后一步）。
     **原表述为什么必须作废**：「凡 `droppedPending === 0` 的局，指纹逐字节不变」在这套样本上**不可证伪**
     —— `era` 翻页会必然让 era 相关池事件失效，实测 6 个种子**全部**至少丢一条，所以「0 丢弃局」集合是空集，
     该断言恒真（vacuously true）、永远不会红。
     **改写版更强而不是更弱**：它表达的是这个不变量真正想说的东西 —— **差异只能由丢弃引起，且不能早于丢弃**。
     在一个「必然发生丢弃」的样本上它仍然可证伪：`T_d` 之前出现任何一位差异 ⇒ 红；
     首个差异出现在 `T_d` 之后第二步及更晚（说明还有一个未被 `droppedPending` 记录的扰动源）⇒ 红。
     实测前缀等价步数：s1 前 260 步、s2 325、s3 222、s4 245、s5 238、s6 221 **全部相同**，
     首个差异恰好落在丢弃那条命令的后一步。
   - **S2**：凡计数 > 0 的局，**首个差异字段必须出现在「第一次丢弃发生的那个轮次」或其之后**。早于它出现差异 ⇒ 回归。
     （S2 是 S1 的弱化版，保留作独立断言，便于失败时快速分辨「早于」与「晚于」两种成因。）
   - **S3**：`playthrough.test.ts` 的**结构性断言必须全绿**（结局在声明集合内、章节数 ≥ 8、`turns < 700`、
     `day ≥ 4300`、章节事件不重复、五维严格小于上界）。**允许变化的只有 `console.log` 的读局摘要**。
     若某个 seed 掉到 `day < 4300` 或章节数 < 8 ⇒ 说明丢弃吃掉了主线，是真回归。
   - **S4**：`replay.test.ts` 逐字节不变（其模板无普通待决事件，池事件是 `kind: random`，不经过 `pendingEvents`）。
3. **实测结论（实施期）**：
   - `droppedPending` 6 种子合计 **13 条**，**全部**是「前提本该失效」的池事件（`era` 翻页 / 伏黑被夺舍），
     **无一条是模板误配** —— 佐证决策 1「这是引擎复核时机问题，不是模板漏配问题」的判断。
   - 模板补丁（`ev-d-canteen` 加 `npcState`）在 6 个种子上**不改变任何轨迹**（有/无补丁的逐轮指纹一致）⇒
     它是**防御性正确**，不是「修掉实际命中」。**这不削弱决策 7**：命中与否取决于种子，而该事件确实是
     3 例里唯一缺前提的一个；缺了它，引擎再复核也**无从判断**（引擎不许猜「正文点名了谁」）。
4. **已知的必然漂移**：受影响 seed 的 `day` 会略减（少若干次结算轮）。QA 基线是 `day 4736–4755`，余量充足。
   `evaluation.overall` 可能微动（QA 基线 94.51–95.02，断言区间 60–96，余量充足）。
5. **反向检查（防「改了个寂寞」）**：必须有一条用例证明修复真的生效 —— 构造「排队期间死亡」的受控场景，
   断言该事件**不再呈现、也不再能结算**；此用例在修复前必须为红（已落 `v2/pending-premise.test.ts` ①）。

### 明确不做（边界）

| 不做 | 理由 |
|---|---|
| 不动 `scheduledEvents` 的复核 | `evaluateDue` 已在做（「被否决的备选」第 5 条），重复即二次判定 |
| 不做「角色死亡时追溯清理 pending」 | 通用复核已覆盖，且会造成效果层 → 呈现层的反向依赖（「被否决的备选」第 4 条） |
| 不处置僵尸链 | 决策 6（含重开条件） |
| 不记 `missedEvents`、不扩 `MissReason`、不退还 `once`/冷却 | 决策 4 |
| 不改 `pendingEvents` 元素形状、不加「允许失效」声明位、不升 `schemaVersion` | 决策 8 |
| 不做条件种类白名单（不区分单调量/振荡量） | 决策 1；改为「模板作者须知」的书写约束 |
| 不改 `EVENT_SOURCE_PRIORITY` / 不设待决队列上限 | QA P2-3 属调度策略议题，与本缺陷正交 |
| 不把 `recordFire`/`pushHistory` 移到 settle 时 | 见「被否决的备选」最后两条 |
| 不修 QA P1-1（`npc-riko` 未落 lifecycle）与 P2-1（`visibility: hidden` 未在投影生效） | P1-1 已作为**独立模板提交** `0759497` 修完（T-1，本 ADR 只把它列为前置依赖）；P2-1 是 pre-existing 投影缺陷，各自独立，不并入本 ADR |
| 不做「已故者的关系/装备/技能也不随时间变化」之类的外延 | 只处理玩家**看得见且会自己长大**的那一项（年龄，决策 9）。其余由 `lifecycle` 的既有语义与模板条件承担，不为未出现的症状提前建抽象 |
| 不做前端改动 | `pendingEvent: null` 是既有形状；新错误码走既有 toast |

### 验证要点（含落地用例位置）

> ①②③④⑥⑦⑧ 与决策 3 附则已落 `packages/game-core/src/v2/pending-premise.test.ts`（6 个 `describe` / 16 例）；
> 决策 9 落 `npc-age-projection.test.ts`（12 例，其中 4 例为本决策新增）。下表保留原始验收口径，便于 QA 复核「测的是不是该测的」。

1. **排队期间死亡 ⇒ 不再呈现**：构造 A（池事件 fire）→ 另一轮里 `setNpcLifecycle inactive` → 断言该事件
   **既不在 `snapshot.pendingEvent`、也不在 `pendingEvents`**，且再次提交它的 `optionId` **不可能成功**
   （正常时序下队首已换人或队列已空 ⇒ `no_pending_event` / `option_not_available`；只有在「同一命令内先丢弃、
   再由该命令提交旧 `optionId`」时才走 `event_premise_invalidated`）。**本用例修复前必须为红**。
2. **全选项失效 ≠ 死锁**：断言不存在「`options: []` 且 `pendingEvents.length > 0`」的可观测状态；
   丢弃后若队列还有下一个有效事件，**同一响应**即呈现它；若队列清空，`advanceTurnV2` 正常推进（不抛 `pending_event_required`）。
3. **未死亡 ⇒ 行为与现状逐字节一致**：按 **S1（改写版）**验证「前缀等价 + 首个差异落在首次丢弃轮次的后一步」，
   并单独断言 `evaluateDue` 重构前后对同一状态返回相同 `DueDecision`、且**条件数组的求值次数不变**
   （等价重构的回归网；这条同时守住实施偏差 (a)：若有人把谓词改回 boolean，求值次数会翻倍）。
4. **槽位让位不吞轮次**：丢弃前后 `turnIndex` / `worldTime` / `player.age` 不变；`history` 长度不变；
   `eventFires` 长度不变；`missedEvents` 长度不变。（防「顺手把丢弃做成了结算」）
5. **同 seed 基线变化可解释**：跑 S1–S4 四条判据，输出「每局 `droppedPending` + 首个差异轮次」一表，作为交付附件。
6. **链条目丢弃不产生悬空引用**：`ev-social-hook`（action-hook）之外的链事件若被丢弃，断言
   `evaluateChain` 仍返回 `active`（僵尸链被**如实**暴露，而不是伪装成 completed）；此用例目的是把决策 6 的限制钉死。
7. **确定性**：同 seed 两次运行的 `droppedPending` 列表与最终指纹一致（复核用 `+37` 盐 ⇒ 不引入时间/随机依赖）。
8. **旧档**：手工构造一个含「失效队首」的 `WorldStateV2` 落盘 → 重启/`hydrate` → 断言该条目已被清理且状态已持久化；
   同时断言 `schemaVersion` 未变、`WorldStateV2Schema.parse` 仍通过（证明零协议变更）。
9. **已故年龄冻结（决策 9）**：置 `inactive` 后推进**一年**，`age` **与 `lifeStage`/`lifeStageLabel` 三者均不变**；
   复活回 `alive` 后恢复按 `worldTime` 增长（严格大于死亡时年龄）；同局未死者照常增长；`unspawned` 同口径计龄。

### 起草时列为待确认的两条（实施时已按默认口径落地）

1. **默认处置「静默不出场」** —— 已按此实施（`bbb440b`）：不呈现、不记错失、不退 `once`/冷却，fire 时刻写在
   `history` 的那条旁白保留。**若将来用户改口要求「必须让玩家知道这件事没发生」**，代价仍是扩 `MissReason` +
   给 `PendingEvent` 加 `instanceId`（协议变更，见决策 4），届时需改写本节与决策 3/4。
2. **僵尸链接受为已知限制** —— 已按此实施，并用用例把它**钉死**（`pending-premise.test.ts` ⑥ 断言链仍为 `active`
   而不是被伪装成 `completed`）。**重开条件不变**：模板出现带 `trigger.conditions` 的链步骤，或出现任何读
   `chain.status === "completed"` 的消费者时，必须回来补 `alignChainStep` 无参形态对齐，并同步改写该用例。
