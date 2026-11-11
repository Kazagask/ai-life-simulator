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
