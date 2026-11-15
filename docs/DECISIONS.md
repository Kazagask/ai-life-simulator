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

> **〔被 ADR-0031 补充，2026-11-13〕** 决策 3 的「`schemaVersion` 格式不兼容变更时递增」**不适用于** ADR-0031：本次只在 `state` 内新增两个**可选字段**（`pendingWheels` / `wheelSeqCounter`，读侧缺省 `[]` / `0`），信封结构、文件布局、指纹算法与四道加载关**全部不变** ⇒ `schemaVersion` 保持 2，旧档照常载入。判定口径与本 ADR 之后的三次可选字段追加（`lastWheels` / `history.visibility` / `spawnRules`）一致：**「旧档缺该字段」必须能表达一个精确语义**（此处 = 旧档不存在待结算转盘，因为旧档的 random 都是即时结算的），才允许不升版；表达不出精确语义时仍须升版拒载。

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

> **〔被 ADR-0026 修订，2026-11-13〕** 本决策中「立即事件的呈现排队沿用既有 `EVENT_SOURCE_PRIORITY`，不新增排序结构」「同窗多事件逐轮各占一槽（R-EV-14）」的**队列化表述已撤销**：`pendingEvents` 不再是可积压多条的 FIFO，运行期由 `triggerEventV2` 顶部「槽位守卫」强制恒 ≤ 1（单槽），多 normal 事件经 `enqueueScheduled(ZERO_SPEC)` 串行化进槽位。**R-EV-14 须拆分**：「结算推进轮次（占槽）」一半保持不变（仍由 T1-07 战斗结算用例断言）；「同窗多事件逐轮各占一槽」一半被本 ADR 取代。`#35` 加载期拒绝同 `onActionId` 立即 `action-hook` 仍保留，但「单轮至多 1 个立即事件」改由运行期守卫强制。详见 ADR-0026。

> **〔再修订（ADR-0030），2026-11-13〕** 本决策「槽位唯一」的**语义边界**被 ADR-0030 扩围：槽位不是 `pendingEvents`，而是「一个轮次只呈现一个」的**四方共用位**（`wheel | battle | event | action`，前端 `apps/web/src/main.tsx:203-204`/`:1308-1315`）。ADR-0026 的「单槽 ≤1」不撤销，但只是四类占用者中的 `event` 一类：`battle` 占位时 `pendingEvents` 允许为空（守卫盲区，normal 可抢入事件槽），`random` 结算时占位却从不进 `pendingEvents`。准入判据改由派生式 `slotTakenFor()` 给出（L1 pending ∨ L2 battle ∨ L3 chainReserve，含链自身豁免），见 ADR-0030 决策 1/2；「续步优先于 drain」作为独立修复项 F2（ADR-0030 决策 3）覆盖 `nextEventId` 伪链。

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

> **〔被 ADR-0031 修订，2026-11-13〕** `lastWheels` / `lastWheel` 的语义**收窄为「已结算」**：转盘的「决定」（选扇区）与「落账」（应用 effects）被拆开，未结算项改由新增的 `WorldStateV2.pendingWheels`（可选 + 读侧 `?? []`）承接，`lastWheel(s)` 改在**结算时**追加而非触发时写入。**顺序口径随之修订**：`lastWheels` 由「当轮触发顺序」改为「**结算顺序**（= 玩家点击顺序）」；D-03 关心的「同轮多条不再互相覆盖」不变，触发顺序仍可从 `PendingWheel.seq` 追溯（不进投影）。`title` 持久化的理由（D-16）同样适用于 `PendingWheel.title`。**`schemaVersion` 仍不升**（沿用本决策的可选字段先例）。

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
    - 依据：`tasks/reports/RELATION-PROJECTION-FIX-ACCEPTANCE.md` §四（判据变异验证，M1 表第 3 行）
      与 §八 观察 2（`inactive` 归因澄清见 `ca458f9`，报告为最新版）。
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

### ADR-0022 补记 D-1 修订（2026-11-12 · QA 二次复查）：敌人端点同样从关系投影剔除

> **性质**：对 D-1 的**追加修订（append-only）**，不是新决策，也不改 D-1 已落地的「unspawned 剔除」与「决策 5 投影期单一修复点」。本次只补 D-1 漏掉的一档：**敌人端点（即用户所指『漏修复的敌人 NPC 关系』）**。

- **实证（用户 QA 二次复查）**：D-1 落地后，用户在实际模板与投影输出中仍观察到**敌人 NPC 的关系边泄露**——敌对角色视玩家为敌、或敌对角色作为某 NPC 的父亲边，照样出现在玩家可见的 `relations` 与快照字符串里。D-1 当初**刻意**保留了敌人端点可见（见 D-1「敌人永不实例化……`[enemy-x,player]` 必须存在」「敌人永不实例化用于否证『不在投影后集合内』」两处），把「敌人端点必须保留」当成对「用上屏集合补集做判据」那类错法的反例。但这一反例**被过度适用**了：它确实否证了「用上屏集合补集做判据」，却**不等于**「敌人端点必须可见」。D-1 漏修的正是这后一半。本质即用户所判：**关系投影可见性问题，从根源上漏了一档**。

- **根因（投影期）**：`projection.ts` 的 `hiddenNodeIds` 原只由 `state.npcs.filter(n => n.lifecycle.state === "unspawned")` 构成。敌人角色在建世界期即被 `turn.ts:149`（`template.characters.filter(c => !c.isEnemy)`）剔出 `state.npcs`，故**从不在** `state.npcs`；但 `state.relations` 的边仍可能引用敌人 id（如 `e("npc-a","enemy-x","enemy")`、`e("enemy-x","npc-b","father")`）。旧 `hiddenNodeIds` 只剔 `unspawned` ⇒ 敌端点边**幸存**并随其他 NPC 的 `relations` 与快照泄露。

- **修复（投影期单一修复点，决策 5 不变）**：`hiddenNodeIds` 扩展为 `unspawned ∪ 敌人`，敌 id 取自 `template.characters.filter(c => c.isEnemy).map(c => c.id)`。仍为**纯投影期过滤**：`state.relations` 在 state 层保留全部敌端点边（引擎侧条件 / 存档 / 确定性不受影响），仅投影层剔除。

- **推翻 D-1 旧裁定**：D-1 关于「敌人端点必须保留 / `[enemy-x,player]` 必须存在」的论断**即日起作废**，由本修订取代：敌人端点是**显式** `hiddenNodeIds` 成员，与 `unspawned` 同档。D-1 关于 `inactive` 必须保留的两条反例**仍成立、不受本修订影响**（敌人 ≠ inactive，二者拦截理由不同）。

- **连带修正（测试）**：`v2/relation-projection.test.ts` 中两例原在断言错误（敌端点可见）行为，已反改：
  - 「只投影 known / inferred 边」一例的 `e("npc-a","enemy-x","friend",{visibility:"inferred"})` 改为 `e("npc-a","npc-b","friend",{visibility:"inferred"})`，期望 `withId` 由 `["enemy-x","player"]` → `["npc-b","player"]`；
  - 「player 与敌人端点必须保留」整例重写为「敌人端点与未登场端点都从关系投影剔除；player / inactive 仍保留」，期望 `npc.relations.map(r=>r.withId)` 仅 `["player"]` 且快照字符串不含 `enemy-x` / `npc-hidden`。
  - 新增回归例「敌人 NPC 的关系端点不进入任何 NPC 的 relations，也不泄露其 id（投影期剔除，state 层边保留）」：构造敌端点边 `e("npc-a","enemy-x","enemy",{value:-80})`、`e("enemy-x","npc-b","father")`、`e("npc-a","player","mentor")`；断言任意 NPC 的 `relations` 均不含 `enemy-x`、快照无 `enemy-x`、且 `state.relations` 仍保留 2 条敌端点边（证明仅为投影期收敛）。

- **验证（本轮）**：`pnpm typecheck` 0 错；`v2/relation-projection.test.ts` 12/12；`v2/guard.test.ts` 5/5、`v2/scheduler.test.ts` 21/21、`v2/npc-panel-projection.test.ts` 8/8、`v2/history-visibility.test.ts` 12/12、`v2/boundary.test.ts` 5/5、`v2/spawn-rules.test.ts` 7/7、`v2/lifecycle-switch.test.ts` 19/19 全绿（完整 `src/v2` 套件后台核对中）。

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

> **〔被 ADR-0026 调和，2026-11-13〕** 本 ADR「问题」节与「现状核实」中「`pendingEvents` 是只承载槽位呈现的 FIFO」「积压到 5 条」等表述，及隐含的「加固而非退役」定调，**已被 ADR-0026 修正**：`pendingEvents` 现定义为**单槽（≤1）**，非积压队列。**本 ADR 的前提复核机制本身（决策 1–4、决策 8 的 `event_premise_invalidated`、决策 2.2 的 `revalidatePendingV2`、决策 2.1 的 `checkEventPremise`、决策 4 的 `droppedPending`）全部保留为纵深防御**——且因串行化后事件改走 `drainScheduledEvents→evaluateDue` 每轮重估条件，复核覆盖面反而更全。状态行「已实施」维持有效（复核机制仍生效），仅定性被修正。

## ADR-0025 云服务接入：账号登录 + 人生档案（只上云投影可见字段）

状态：**已接受**（2026-11-13，云服务接入轮）。关联 ADR-0007（存档策略）/ ADR-0010（三层模型）/ ADR-0022（未登场过滤）。**零协议改动**：`packages/shared`、`packages/game-core`、`apps/server` 一行不改。

### 背景

- 世界存档在服务端 JSON 文件（ADR-0007），重新发布即清空 ⇒ 玩家换设备、换次发布后「这一生」全部丢失。
- 云环境已开通，但**服务端没有上云通道**：cloud SDK 的身份来自浏览器侧 `cloud.auth` 会话，RLS 判据是 `owner_id = auth.uid()`；Fastify 既无平台凭据，也构造不出用户会话。任何「服务端代写云端表」的方案都只能靠特权身份绕过 RLS，见「被否决的备选」。
- 因此本轮上云的只是**投影副本**：玩家在结算页**已经看到**的结局摘要，按 WorkBuddy 账号隔离，可跨设备/跨次发布查看与删除。

### 决策

1. **服务端不上云、权威状态不迁移**：世界照旧 `data/worlds/*.json`，引擎与协议零改动；云端行**永不回读进引擎**，只做展示。
2. **只落玩家已可见的字段**，唯一数据源是 `V2Snapshot` + `EndingView`（**不是模板原文**）：`worldId`/`templateId`/`worldName`、`player.name`/`player.age`、`ending.title`/`endingId`/`endingType`、`Math.floor(worldTime/1440)`（与 QA 基线 `day` 同口径，`worldTime` 单位是分钟、0 = 开局当天）、`formattedTime`、`storyChapter`、`evaluation.overall` 与 `dimensions` 的 `{id,label,score,level}`、`npcs.length`、`runStatus`。
3. **hidden 红线（落库即违规）**：`visibility:hidden` 的 NPC 名与补正、未登场角色（ADR-0022 `hiddenNodeIds` 之后仍未生效的 `visibility` 过滤见 B-22）、`missedEvents`、`history` 的 hidden 条目、五维 `explanation` 长文案、模板原文（hidden 结局只落**投影已掩码**的标题，绝不回 `endings.yaml` 取原文）、邮箱/手机号/token/openid 之类身份字段。
4. **一个身份源：WorkBuddy 账号登录**（`signInWithOAuth({provider:'workbuddy'})` + 启动期 `handleWorkBuddyCallback`）。**不做邮箱/短信兜底**：① 新开通环境的 `workbuddy_login_enabled` 默认 on，「开关未开」是**运维项**而非设计约束（`references/auth/management.md` 明载）；② SDK 不提供 provider 绑定/合并 ⇒ 多身份源必然造出「同一自然人两个 uid、档案分裂且无法合并」，比登录失败更糟且不可逆；③ Email 是唯一可能 `degraded` 的 provider，多一条身份源就多一条失败面，收益仅为「第二个身份」。
5. **认证不阻塞游戏**：未登录可完整玩；只有「人生档案」入口要求登录。不引入匿名登录、不造 localStorage 假会话（`getSession()` 无 session 即未登录）。
6. **数据所有权在数据库**：表 `public.life_records`，`owner_id text not null default auth.uid()`，RLS 四条策略一律 `owner_id = auth.uid()`。前端**不发送 `owner_id`**；`owner_id` 只用于 UI 判断，**不当安全边界**。
7. **幂等**：唯一索引 `(owner_id, world_id)` + `upsert(onConflict:'owner_id,world_id')` ⇒ 刷新、重复调用、「已终止 → 已归档」都只留一行。
8. **写是玩家可见动作**：已登录时，结局产生（`terminated`/`archived`）或手动归档成功后写；未登录**不写、不弹窗、不打断结算**，登录回跳后**不自动补写**（隐私最小化），由玩家在档案页显式点「把这局存进档案」。
9. **删是玩家的**：`.delete().eq('id', …).select()`（RLS 用 `using`）；返回 0 行 = 不存在或无权 ⇒ 必须提示，不得当成功。

### 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 服务端（Fastify）持 `publishableKey` 代写 | `publishableKey` 只是「标识哪个应用」的公开值且服务端做 Origin 强匹配，持它仍拿不到用户会话；强行代写等于建一条绕过 RLS 的特权通道 |
| 存档上云 / 跨设备续玩 | 需要「输入日志 + 确定性重放」，见「明确不做」 |
| 邮箱 OTP / 短信兜底 | 决策 4 三条理由；且账号绑定能力不存在，分裂后无解 |
| 匿名登录 / localStorage 假用户 | 档案的意义就是「归属某个账号」；匿名登录不在 SDK 契约内，且 `auth.uid()` 为空时 RLS 恒不成立 |

### 后果

- 云端行是**客户端自报**的副本：玩家可篡改自己的档案（只影响自己的展示，不进评分、不进任何权威路径）；服务端删世界**不联动**删云端行 ⇒ 云端档案可能比存档活得久（本轮接受，重新发布后它反而是唯一留存）。
- 两份真相天然不同步。ADR-0010 三层模型不变：云端不是第四层，只是投影的又一份拷贝。
- 客户端新增依赖 `@tencent-ai/workbuddy-cloud-sdk@dev`，**只有 `apps/web` 是调用方**；服务端零新增依赖、零新增环境变量。

### 明确不做（→ BACKLOG B-24）

| 不做 | 理由 / 重开条件 |
|---|---|
| 存档上云、跨设备续玩 | 必须存「seed + 模板指纹 + 逐条命令」并在启动期 replay；ADR-0007 已否决「只存 seed + 命令日志回放」（模板一改即失效），要做须同时定「指纹不匹配时的处置」 |
| 服务端校验/去重档案 | 服务端无身份凭据，无法判定归属；越权判定只能交给 RLS |
| 多身份源 / 账号绑定 / 账号合并 | 见决策 4 |
| 云端档案反哺游戏（成就、排行、跨局继承） | 会让「可篡改的副本」进入权威路径，违反 `AGENTS.md` §5 |
| 重新发布不清档 | ADR-0007 既定策略，另立项 |

### 验收口径

1. **建表与 RLS**：`list_tables` 见 `life_records`（RLS on），`list_rls` 见 4 条策略均为 `owner_id = auth.uid()`。
2. **已登录往返**：写一次读回同一行；同 `world_id` 再写仍 1 行且字段被更新（唯一索引 + upsert 生效）。
3. **未登录**：`getSession()` 无 session ⇒ 档案页只给登录入口，**不发**数据库请求。
4. **越权**：用另一账号的行 id 调 `.delete()` / `.update()` ⇒ 返回 `[]`，UI 报错；不得静默当成功。
5. **失败面完备**：断网、401（`endpoint` 与发布域名不匹配）、42501、23505、超配额各有明确文案。
6. **红线抽查**：库里任一行都不含 hidden NPC 名、`missedEvents`、dimension `explanation`、邮箱/手机号/token。
7. **证据缺口声明**：跨用户隔离只有**两个真实账号**能证明；`exec_sql` 是特权通道，**不作为** RLS 证据。

## ADR-0026 槽模型转正：pendingEvents 串行化守卫

> **本条覆盖**：将 2026-11-13 落地、并已经 QA 云端验收（用户实测「没发现大问题」）的「槽位守卫」实验**转正为正式决策**；以 append-only 方式**修订 ADR-0011 决策 5** 的队列化表述、并**调和 ADR-0024** 的定调。属于 **T-2 最小可逆实验转正**：引擎改动**未提交**、纯语法糖、可整块删除回退；`packages/shared` schema 零改动、不升 `schemaVersion`、协议/投影/存档结构全不变。

- **状态**：**已通过（2026-11-13，QA 云端验收转正）**。依据 `AGENTS.md` §0「改核心数据模型/配置前先写 ADR」——本 ADR 不引入新数据模型，仅对既有 `pendingEvents` 的**运行期语义**做权威裁定（单槽，非积压队列），并显式修订 ADR-0011 决策 5 与 ADR-0024 的相关口径。
  - 落地改动（工作区未提交，纯引擎语法糖，可整块删除回退）：`packages/game-core/src/v2/turn.ts`（守卫块 + 顶部常量注释）、`packages/game-core/src/v2/v2.test.ts` / `lifecycle-switch.test.ts`（守卫相关用例**改写**：断言单槽 ≤1 与串行化回放——首条 normal 入 `pendingEvents`、其余转 `scheduledEvents` 且 `origin.kind==='effect'`、`status==='waiting'`，被拦事件后续轮次回 `pendingEvents` 可结算）。`r25-acceptance.test.ts` 的 `T1-07 · 槽位守卫与结算轮` / `T1-07 · 战斗结束算一次结算轮（R-EV-14）` 为 R2.5 #34 **既有验收用例（本变更未改）**，佐证结算占槽与「战斗结束推进一次 turnIndex」语义。验证：核心单测 **465/0 全绿**（含守卫用例）；`pnpm typecheck` 0 错。
  - **回退方式**：删除 `turn.ts` 顶部 `SLOT_GUARD_DELAY` 常量注释块（`:64-80`）与 `triggerEventV2` 内 `recordFire` 之前的守卫拦截块（`:465-485`），即可恢复「多事件可同时入 `pendingEvents`」的旧行为；不动类型/yaml/协议/投影/存档。
- **起草人**：系统架构师（高见远）；起草基线 = 当前工作区（引擎守卫已实现、未提交）；与 ADR-0011/0024/OPEN_QUESTIONS #48 直接关联。
- **关联**：ADR-0011 决策 5（**被本 ADR 修订**：撤销队列化表述与 R-EV-14 的 FIFO 解读）、ADR-0024（**被本 ADR 调和**：前提复核保留为纵深防御，但「pending 是永久 FIFO、加固而非退役」定调撤回）、ADR-0004（二态终止）、OPEN_QUESTIONS #48（结论见本 ADR）。

### 背景

用户原始口径（「B 决策」）为「立即触发 不入队 / 单轮单槽 / 无积压队列」，但既有文档与之冲突：

- `ADR-0011` 决策 5 把立即事件落成进 `pendingEvents` **FIFO**（可积压多条，即「同窗多事件逐轮各占一槽 / R-EV-14」），并显式豁免延时/pool/schedule/chain 不受「单轮 ≤1 立即事件」约束——该约束只靠 `#35` 加载期静态拒绝「同 `onActionId` 的立即 `action-hook` ≥2」。
- `ADR-0024` 在发现「诈尸」bug 后**加固**了 `pendingEvents`（新增 `checkEventPremise` + `revalidatePendingV2` 在每次呈现/结算前复核队首前提），其定性是「`pendingEvents` 是只承载槽位呈现的 FIFO」「加固而非退役」，且 QA 实测积压可达 5 条（`ev-d-canteen` fire@t212 → settle@t220，排队 8 轮）。

`pendingEvents` 作为「可积压多条的 FIFO」带来两类风险：① **因果链断裂**——多个 normal 事件在排队期间相互依赖的前提被后续结算翻转；② **诈尸**——已死/已失效角色的事件在排队窗口内被呈现/可结算（ADR-0024 已证实 3 例）。2026-11-13 做**最小化实验**验证「槽模型」可行性：在 `triggerEventV2` 顶部加一道「槽位守卫」，使运行期 `pendingEvents` 实际恒 ≤ 1，多事件被串行化进槽位而非积压。QA 云端验收结论：用户实测「没发现大问题」，满足采纳标准（槽模型可行 ⇔ 游戏流程无体验问题）。

### 现状核实（以代码为准，不以旧 spec 为准）

| 事项 | 核实结论 | 证据 |
|---|---|---|
| 守卫位置 | `triggerEventV2` 内、`recordFire`（`turn.ts:487`）**之前** | `turn.ts:465-485` |
| 守卫常量 | `SLOT_GUARD_DELAY = ZERO_SPEC`（`{value:0,unit:"minute"}`，相对入队时刻 0 延迟，不依赖历法） | `turn.ts:79`、`scheduler.ts:39` |
| 守卫条件 | `event.kind === "normal" && state.pendingEvents.length > 0` | `turn.ts:471` |
| 命中动作 | `enqueueScheduled({ state, definitionId: event.id, origin:{kind:"effect",id:event.id}, start: ZERO_SPEC, ...(chainId?), calendar: undefined })` 后 `return` | `turn.ts:472-483` |
| 回检路径 | `drainScheduledEvents`（`scheduler.ts:310`）按 `start asc→end asc→enqueueSeq asc` 排序；该实例 `start=now` 立即到期 → `evaluateDue` 重估 `missWhen→conditions→cooldown` → 通过则 `onFire→triggerEventV2` 再次进入；此时槽位若空则 `recordFire + enqueuePendingEvent` | `scheduler.ts:113`（`start=now`）、`:310-357` |
| 不 recordFire 约定 | 守卫在 `recordFire` 之前，命中即 `return`：命中事件**不**写 `firedEvents/lastFiredIndex/eventFires`、不入 `pendingEvents`、不进 `result.triggered`、不写 `history`；只在真正入 `pendingEvents` 的那一刻记一次 fire（与「立即触发不入队」口径一致，避免重复记火） | `turn.ts:70-71`、`:465-487` 注释 |
| 单槽不变量 | 运行期 `pendingEvents.length ≤ 1`（槽位被占用时新 normal 事件一律改走延时队列，不入队） | 守卫条件 + 命中 return |
| combat/random 不受影响 | combat 走 `createBattle`、random 走转盘分支，二者均不经 `pendingEvents`，不受守卫影响 | `turn.ts:451-464`、`497-499` 注释 |
| 硬约束达成 | `PendingEvent` 类型（`v2.ts:202-206`）、`WorldStateV2.pendingEvents`（`v2.ts:313-314`）、`schemaVersion`、投影 `pendingEvent: PendingEventView|null`（`v2.ts:595`）均**未改**；`V2Snapshot` 字段集不变 | `git diff` 仅 `turn.ts`/`scheduler.ts`/`*.test.ts`，无 `shared` 改动 |
| 投影契约 | `alsoHappened` 底栏（`apps/web/src/main.tsx:903-979`）基于 `V2TurnResult.triggeredEvents`（当轮已结算事件）派生，契约不变；串行化后同轮 normal 事件至多 1 条入槽，其余延迟到后续轮次，该底栏不再承载「同轮积压的多个 normal 事件」，但渲染逻辑不动 | `main.tsx:906` |

### 决策 1：槽模型定义 —— `pendingEvents` 是**单槽（≤1）**，不是积压队列

1. **运行期语义裁定**：`pendingEvents` 自本 ADR 起**权威定义为单槽**——同一时刻至多承载 1 个待玩家决策的 normal 事件；`pendingEvents.length > 1` 在正确实现下不可达（守卫保证）。它**不再是可积压多条的 FIFO**。
2. **撤销 `ADR-0011` 决策 5 的队列化表述**：删除「立即事件的呈现排队沿用既有 `EVENT_SOURCE_PRIORITY`，不新增排序结构」「同窗多事件逐轮各占一槽（R-EV-14）」中「多事件可积压进 `pendingEvents` FIFO」的解读。**注意 R-EV-14 的两半须拆分**：
   - **保留**（不变）：R-EV-14 的「**结算推进轮次（占槽）**」一半——事件结算推进 `turnIndex`、`timeCost` 缺省 0（`r25-acceptance.test.ts` T1-07 战斗结算用例 `:137-196` 仍断言此语义，本 ADR 不改）。
   - **撤销**（被本 ADR 取代）：R-EV-14 的「**同窗多事件逐轮各占一槽**」一半——多事件不再各自占槽，改为串行化（决策 2）。
3. **「无积压队列」落地**：多 normal 事件不再同时入 `pendingEvents`；超出槽位的事件经延时队列串行回放（决策 2），语义上等价「同一窗口的事件按序逐轮各占该单槽」，而非「并排占多条槽」。

### 决策 2：串行化机制 —— normal 事件遇槽位占用改走延时队列，下一轮 drain 回检

1. **机制**：当 `state.pendingEvents.length > 0` 时，新 normal 事件的 fire 不被直接入队，而是 `enqueueScheduled({ start: ZERO_SPEC, origin:{kind:"effect",id:event.id} })`（延迟 0 分钟 ⇒ `resolveTimeSpec` 得 `now`，立即到期）；等槽位空出后由 `drainScheduledEvents → onFire` 再次进入 `triggerEventV2`，此刻若槽位空闲则 `recordFire + enqueuePendingEvent` 真正入槽呈现。
2. **不 recordFire 约定（防重复记火）**：守卫位于 `recordFire` 之前，命中即 `return`，被延后的事件在「转入延时队列」那一刻**不**写触发事实；只在它真正进入 `pendingEvents` 的那一刻记一次 fire——与「立即触发不入队」口径一致，避免 `once`/冷却/事实日志错乱。
3. **combat / random 不受影响**：二者走各自分支、不经 `pendingEvents`，不受守卫约束（战斗仍按「同一时刻至多一场」既有口径；转盘仍按 `lastWheels` 同轮多结果呈现）。

### 决策 3：`#35` 保留但重新定性 —— 加载期拒绝 + 运行期守卫双重保险

1. **`#35` 加载期静态拒绝保留**：同 `onActionId` 的立即 `action-hook` ≥2 仍在加载期 `superRefine` 报错（ADR-0011 决策 5 原文不变），显式豁免延时事件（声明 `window`/`delay` 的 `action-hook`、chain 延时步、schedule、pool）。
2. **「单轮至多 1 个立即事件」改由运行期守卫强制**：`#35` 只挡「同 `onActionId` 的立即 hook」这一类静态可判定冲突；**跨来源**（pool/chain/schedule/延时步经 drain 落地的 immediate、不同 `onActionId` 的 hook 同轮触发）的多 normal 事件冲突，由**运行期槽位守卫**兜底。即：单槽不变量 = `#35`（加载期）+ 槽位守卫（运行期）共同保证，而非仅靠加载期校验。

### 决策 4：与 `ADR-0024` 调和 —— 前提复核保留为纵深防御，但「pending 永久 FIFO」定调撤回

1. **前提复核机制全部保留**：`ADR-0024` 的 `checkEventPremise`（`scheduler.ts`）、`revalidatePendingV2`（`turn.ts`）、错误码 `event_premise_invalidated`、`TriggerResult.droppedPending` **继续生效**，作为**纵深防御**。理由：单槽 `pendingEvents[0]` 在其 fire→settle 窗口内仍可能因 `useItemV2`（轮外操作）等发生状态变更，仍需复核防诈尸。
2. **复核覆盖面反而更全**：串行化后，被延迟的 normal 事件在**每一次 drain** 都经 `evaluateDue`（`missWhen→conditions→cooldown`）重估条件，比旧模型「入 `pendingEvents` 后无人再看」更严——原 ADR-0024「被否决的备选」第 5 条「对 `scheduledEvents` 也加同样复核」的顾虑在此自然消解（事件现在本就走 `scheduledEvents` 路径）。
3. **撤回 ADR-0024 的定调**：ADR-0024「问题」节与「现状核实」中「`pendingEvents` 是只承载槽位呈现的 FIFO」「积压到 5 条」、以及隐含的「加固而非退役」定性，**被本 ADR 修正**——`pendingEvents` 现定义为**单槽（≤1）**，非积压队列。ADR-0024 的**复核机制本身不被撤销**，其状态行「已实施」维持有效（只修正定性）。

### 决策 5：硬约束（最小可逆实验转正）

1. **类型/字段不动**：`PendingEvent`（`v2.ts:202-206`）、`WorldStateV2.pendingEvents`（`v2.ts:313-314`）**保留原状**；不新增 `instanceId`、不加「允许失效」声明位。
2. **yaml / 协议 / 投影 / 存档结构全不变**：`schemaVersion` **不升**（旧档可直接载入）；`V2Snapshot` 字段集不变（`pendingEvent: PendingEventView|null`、`lastWheels`、`alsoHappened` 底栏契约不变）；前端零改动。
3. **守卫可整块删除回退**：删除 `turn.ts` 顶部 `SLOT_GUARD_DELAY` 常量注释块（`:64-80`）与 `triggerEventV2` 内守卫拦截块（`:465-485`），即恢复「多事件可同时入 `pendingEvents`」旧行为——这是本转正决策的**可逆性硬保证**，也是它能被定为「最小实验」而非「协议变更」的原因。

### 决策 6：确定性影响（与 ADR-0024 同口径：变化是预期的、非回归）

1. **守卫本身不耗 RNG**：命中守卫只是 `enqueueScheduled`（纯状态写，无随机），故不改变任何 RNG 序列；延迟实例在 drain 时若含 `random` 条件才会经 `evaluateDue` 消耗 `ADR-0024` 的独立 `+37` 盐（仍由 `state.seed` 决定，确定性成立）。
2. **受影响 seed 轨迹变化**：凡「同轮多个 normal 事件本应积压」的 seed，其事件呈现顺序/时点会因串行化（延迟 + 每轮重估条件）而改变；若某延迟事件在重估时条件已不满足，则被 `drop`（同 ADR-0024 处置，不记错失、不退 once/冷却）。这与 ADR-0024 的「变化是预期的、非回归」判据同构。
3. **QA 基线未漂移**（实施核验）：6 种子 × 2 开局收束、`day≈4736–4756`、章节 ≥ 8、五维评分区间不变、核心单测 465/0 全绿——即结构断言全绿，允许变化的只有逐事件时序细节。

### 被否决的备选

- **维持 ADR-0011 现状队列（多事件积压进 `pendingEvents` FIFO）**：已被 ADR-0024 QA 反例证实风险（积压 5 条、排队 8 轮、3 例诈尸/因果链断裂），与用户 B 决策「无积压队列」直接冲突。**否决**。
- **fire 与 settle 原子化在同轮内完成（立即事件 fire 即 settle、彻底无队列）**：更干净的模型，但需重写「结算推进轮次（占槽）」语义、改 `once`/冷却的时点、改 `V2TurnResult.triggeredEvents` 契约（前端靠它在 fire 轮弹提示），并让所有 `eventFires` 基线平移——收益（消除一条时间戳正确的历史旁白）与代价严重不成比例。本守卫已在不改结算语义、不动协议的前提下达成单槽，**否决**（若将来要动，独立 ADR）。
- **完全退役 `pendingEvents` 字段 / 改用纯 `scheduledEvents` 承载待决**：违反决策 5 硬约束（`WorldStateV2.pendingEvents` 字段不动、不升 `schemaVersion`、旧档兼容），且破坏既有投影契约（`snapshot.pendingEvent`）与 `pending_event_required` 守卫语义。**否决**。

### 影响面与文件归属

| 改动点 | 归属 | 依据 | 写冲突 |
|---|---|---|---|
| 槽位守卫（`SLOT_GUARD_DELAY` 常量注释块 + `triggerEventV2` 内拦截块） | `packages/game-core/src/v2/turn.ts` | 守卫在 `pendingEvents` 归属层；可整块删除回退 | `turn.ts` 是热点，与任何改轮次管线的任务必须串行 |
| 守卫相关用例（单槽 ≤1 与串行化回放断言） | `packages/game-core/src/v2/{v2.test.ts,lifecycle-switch.test.ts}`（改写）；`r25-acceptance.test.ts` 的 `T1-07` 为 R2.5 #34 既有用例（未改） | 测试 | 低 |
| `packages/shared` | **零改动**（schema / `PendingEvent` / `schemaVersion` 不动） | 决策 5 | 无 |
| 投影 / 前端 | **零改动**（`V2Snapshot` 字段集不变；`alsoHappened` 底栏契约不变，运行期恒不再承载同轮积压 normal 事件） | 决策 5 | 无 |
| 存档 / 载入 | **零改动**（不升 `schemaVersion`；旧档可直接载入） | 决策 5 | 无 |

### 不变量检查表

| 不变量 | 现状 | 本决策影响 | 保护措施 |
|---|---|---|---|
| 同 seed 同输入同结果 | 成立 | 受影响 seed 的轨迹因串行化 + drain 重估而改变（预期，非回归） | 守卫不耗 RNG；结构化断言（day/章节/五维）全绿；延迟实例随机条件走 `+37` 独立盐 |
| hidden 不进入玩家端 API | 成立 | 无影响 | 不动投影字段集 |
| 世界观规则只进模板 | 成立 | 强化：单槽 + 串行化不引入任何「按 reasonCode/NPC 分支」的引擎逻辑 | 守卫只判 `kind==="normal" && length>0`，不读模板语义 |
| 时间/随机/ID 可注入 | 成立 | 守卫纯状态写、不读 `Date`/`Math.random`；延迟实例重估沿用既有 `+37` 盐 | 派生点写在一处 |
| R3 穿越 seam 未被封死 | 三个预留点（事件实例标识 / `TimeAdapter` / 可见性投影）均未硬化 | **正向**：串行化使事件改走 `drainScheduledEvents→evaluateDue` 每轮重估条件，时间回拨后同一事件可重估前提，不写死时间单调 | 复核/重估不缓存结果、不在 fire 时固化前提真值 |
| `pendingEvents` 单槽（≤1） | 旧：FIFO 可积压多条 | **裁定为单槽**（撤销 ADR-0011 队列化表述） | 运行期守卫 + 加载期 `#35` 双重保证 |
| `pending_event_required` 守卫语义 | 槽位被占用时拒绝自由行动 | 不变（仍为「槽位占用 ⇒ 拒绝新自由行动」） | `turn.ts:893` 维持 |

### 验证要点（含落地用例位置）

1. **运行期恒 ≤ 1**：构造同轮触发 2 个 normal 事件的场景，断言 `state.pendingEvents.length` 峰值恒为 1（另一个被延迟到 `scheduledEvents`）；由 `v2.test.ts:726` 与 `lifecycle-switch.test.ts:486` 覆盖（`r25-acceptance.test.ts` T1-07 佐证结算占槽语义）。
2. **串行化回放**：槽位被占时新 normal 事件进 `scheduledEvents`（`origin.kind==="effect"`）；槽位空出后下一轮 drain 入槽呈现，且**只在入槽那一刻 `recordFire` 一次**（验证不重复记火：`eventFires` 长度与入槽次数一致）。
3. **combat/random 不受影响**：战斗仍按「同一时刻至多一场」、转盘仍按 `lastWheels` 同轮多结果呈现；守卫只对 `kind==="normal"` 生效。
4. **单槽不变量 = `#35` + 守卫**：加载期仍拒绝同 `onActionId` 立即 `action-hook` ≥2；运行期跨来源冲突由守卫兜底。
5. **确定性 / 基线未漂移**：核心单测 465/0 全绿；`playthrough.test.ts` 6 种子 × 2 开局结构性断言全绿（`day≈4736–4756`、章节 ≥ 8、五维区间不变）。
6. **回退验证（可逆性硬保证）**：删除 `turn.ts` 守卫块（`:64-80` + `:465-485`）后，构造同轮 2 normal 事件，断言旧行为恢复（可同时入 `pendingEvents`，length 可达 2）；且 `shared`/schema/投影/存档无任何回退改动。

### 明确不做（边界）

| 不做 | 理由 |
|---|---|
| 不动 `PendingEvent` 类型 / `WorldStateV2.pendingEvents` 字段 / `schemaVersion` | 决策 5 硬约束（最小可逆、旧档兼容） |
| 不引入新协议面（不扩 `MissReason`、不加 `instanceId`） | 与 ADR-0024 决策 8 同口径；正确性不靠开关 |
| 不改 `alsoHappened` 底栏 / `V2Snapshot` 字段集 | 投影契约不变；串行化后该底栏运行期不再承载同轮积压 normal 事件，但渲染逻辑不动 |
| 不把 `recordFire`/`pushHistory` 移到 settle 时 | 决策 6 同 ADR-0024「被否决的备选」最后一条 |
| 不撤销 ADR-0024 的前提复核机制 | 决策 4：单槽窗口内仍需复核防诈尸，且串行化后覆盖更全 |
| 不处置僵尸链（ADR-0024 决策 6） | 与本 ADR 正交，重开条件不变 |

### 对 ADR-0011 决策 5 与 ADR-0024 的修订回指（append-only 注记，供落地）

**插入 ADR-0011 决策 5 末尾：**
> **〔被 ADR-0026 修订，2026-11-13〕** 本决策中「立即事件的呈现排队沿用既有 `EVENT_SOURCE_PRIORITY`，不新增排序结构」「同窗多事件逐轮各占一槽（R-EV-14）」的**队列化表述已撤销**：`pendingEvents` 不再是可积压多条的 FIFO，运行期由 `triggerEventV2` 顶部「槽位守卫」强制恒 ≤ 1（单槽），多 normal 事件经 `enqueueScheduled(ZERO_SPEC)` 串行化进槽位。**R-EV-14 须拆分**：「结算推进轮次（占槽）」一半保持不变（仍由 T1-07 战斗结算用例断言）；「同窗多事件逐轮各占一槽」一半被本 ADR 取代。`#35` 加载期拒绝同 `onActionId` 立即 `action-hook` 仍保留，但「单轮至多 1 个立即事件」改由运行期守卫强制。详见 ADR-0026。

**插入 ADR-0024 末尾：**
> **〔被 ADR-0026 调和，2026-11-13〕** 本 ADR「问题」节与「现状核实」中「`pendingEvents` 是只承载槽位呈现的 FIFO」「积压到 5 条」等表述，及隐含的「加固而非退役」定调，**已被 ADR-0026 修正**：`pendingEvents` 现定义为**单槽（≤1）**，非积压队列。**本 ADR 的前提复核机制本身（决策 1–4、决策 8 的 `event_premise_invalidated`、决策 2.2 的 `revalidatePendingV2`、决策 2.1 的 `checkEventPremise`、决策 4 的 `droppedPending`）全部保留为纵深防御**——且因串行化后事件改走 `drainScheduledEvents→evaluateDue` 每轮重估条件，复核覆盖面反而更全。状态行「已实施」维持有效（复核机制仍生效），仅定性被修正。

> **〔被 ADR-0030 扩围，2026-11-13〕** 本 ADR 的「单槽」结论**维持有效、不撤销**，但被明确为**四分之一**：决策 1 把槽定义为 `pendingEvents ≤ 1`、决策 2 把机制定义为「入队互斥」、决策 3 的「`combat` / `random` 不受本守卫影响」一节，在实测中被证伪为**盲区**——`battle` 占位时 `pendingEvents` 可为空（战斗进行中尾管线仍可把 normal 放进事件槽，`turn.ts:453` 只挡 combat），`random` 结算时占位却从不进 `pendingEvents`（守卫看不见转盘）。**量化基线**：守卫把「normal 链步被日常插队」严口径中断从 6 次降到 **0 次**（有效，成果归本 ADR），但线上 326 轮存档仍留 **2 次 combat 型链中断**（一次未覆盖）。后续由 ADR-0030 把准入扩为 `L1 pending ∨ L2 battle ∨ L3 chainReserve`（派生式，禁置位标记），并把「续步优先于 drain」作为独立修复项 F2。本 ADR 决策 5 的「守卫可整块删除回退」性质**保留**（ADR-0030 不改变其可逆性判定），但删除守卫后的行为不再视为「正确行为」，只视为「旧行为」。

> **〔术语与槽定义被 ADR-0032 收窄，2026-11-13〕** 本 ADR 的「槽 = `pendingEvents ≤ 1`」这一**等式作废**：`pendingEvents` 的语义收窄为「`event` 占用者的载体」（ADR-0032 术语 T2），**呈现槽**是跨层概念 `PresentationSlot`（T1，四类占用者 `wheel/battle/event/action`，定义在前端 `apps/web/src/main.tsx:203-204`/`:1299-1315`，引擎侧目前无对应物）。本 ADR 的守卫作为**运行期约定**（ADR-0032 §3 R1）保留其事实地位，但**不得再被称为「槽模型」**；其可被旁路破的事实（`opening.ts:241`、`ending.ts:379`）已在 ADR-0032 §3 R1 登记。

> **〔守卫条件被 ADR-0033 替换，2026-11-13〕** 本 ADR 决策 2 的守卫条件 `event.kind === "normal" && state.pendingEvents.length > 0` **被替换为** `event.kind === "normal" && occupantOf(state) !== "action"`（ADR-0033 决策 3；`occupantOf` 见同 ADR 决策 1）。**决策 2 的其余部分（命中动作 = `enqueueScheduled(ZERO_SPEC)` 后 return、位于 `recordFire` 之前、不记火不写历史）全部保留不变**，决策 5 的「可整块删除回退」性质也保留（回退即恢复旧条件）。本 ADR 的量化基线与「normal 串行化」成果仍有效。

> **〔被 ADR-0034 取代，2026-11-13〕** 本 ADR 的「槽 = `pendingEvents ≤ 1`」与"入队互斥式守卫"**整体作废**：用户口述模型把槽定为**状态字段** `WorldStateV2.slot`（记录"下一个要处理的事件"），`pendingEvents` 字段被删除；"准入"问题随之消失（写 `slot` 的入口只有两个：队列取出、当前事件的后继）。本 ADR 保留的只有**事实与教训**：量化基线（normal 链中断 6→0 / combat 2 次）、守卫必须位于 `recordFire` 之前、以及「运行期约定不等同结构保证」这一方法论。

## ADR-0027 AI 叙事层接入：LLM Provider 抽象 + 服务端编排 + 确定性边界

> **本条覆盖**：将 2026-11-13 与用户讨论确定的「AI 叙事层（LLM 接入）」落地为正式决策——`LLMProvider` 统一接口（Mock / WorkBuddy 云服务 SDK / OpenAI 兼容）、服务端凭证路由、确定性边界、strict Zod + 证据白名单回退、事件 flavor 异步生成。属于 **T-2 协议/契约变更**（动 server/engine 编排契约 + shared schema 新增），须先写 ADR（AGENTS §0.3）。

- **状态**：**已实施（事后补记，2026-11-13）**。
  - **〔起草期状态原文，留档备查，不删改〕**：**草案（2026-11-13，G1 待评审）**。依据 `AGENTS.md` §0.3：本轮虽多数改动在 `apps/server` 且不升 `schemaVersion`（shared 仅纯新增 `EventFlavorOutputSchema`，`WorldStateV2` 零改动），但动到「server/engine 编排契约 + 叙事来源语义（`narrativeSource` 取值从恒 `template` 变为 `template/llm/fallback` 由运行时决定）」，属契约面变更，故走 ADR。
  - **状态变更缘由（事后补记）**：2026-11-13 无人值守定时任务中，用户裁决「**本次免除前置 ADR 流程**」，并明确要求「在全部功能与冒烟验证**完成之后**，再事后补记 ADR 内容（涵盖变更范围与决策结果）」，无需等待确认。故本 ADR 未按 G1/G2 门禁先行评审，而是在 **Phase 3 全部功能完成（10 个 commit，HEAD `ba889ba`）+ Phase 4 冒烟验证由 QA 裁定通过** 之后补记；`docs/DECISIONS.md` 在此之前全程未被改动（起草人与主理人此前的现状盘点均为只读）。本节状态据此由「草案」更新为「已实施（事后补记）」，并新增下列「变更范围（实绩）／决策结果（落地口径）／验证结果（冒烟级）／附录：遗留与风险」四个小节。
  - 🔴 **流程例外声明（显著 · 仅适用本次任务，不延续）**：**「免除前置 ADR 流程」与「事后补记 ADR」的约定仅适用于本次 2026-11-13 无人值守任务，不延续到后续任何任务。** 后续任务一律恢复 `AGENTS.md` §0.3 的 **G1 / G2 正常门禁**：凡动 `packages/shared` / `packages/game-core` / `apps/**` 契约面（T-2），仍须**先写 ADR 并经评审通过后再实施**；不得援引本条作为「先实施、后补 ADR」的先例。
  - **起草人**：系统架构师（高见远）；起草基线 = `packages/game-core/src/v2/narrative.ts` 既有 scaffold + 用户 2026-11-13 provider/凭证/延迟面决策。
- **关联**：ADR-0025（WorkBuddy 登录 + 人生档案，登录会话作为云端 SDK 凭证来源）、AGENTS §1（game-core 不引 LLM SDK/网络）、AGENTS §5（不得客户端直连 LLM / 不得外部账号依赖 / 错误可诊断）、OPEN_QUESTIONS #3（多 Agent，DEFERRED）、#5（provider/模型，先接口与 Mock）、#26（自由文本行动，DEFERRED）。

### 背景

当前 `narrative.ts` 已建好 LLM 接入的**护栏与注入点**——只读 `NarrativeRequest`、`NarrativeAdapter = (req) => unknown` 注入、`EndingNarrativeOutputSchema`/`EvaluationSummaryOutputSchema` 的 **strict** Zod 校验、证据白名单 `allowedEvidenceIds` 防虚构事实、`template/llm/fallback` 三来源 + `diagnostic`。但 LLM 路径**从未接通**：`narrativeSource` 恒为 `"template"`（无 adapter 注入），且 game-core 按 AGENTS §1 严禁任何 LLM SDK / 网络调用。

`BACKLOG.md` §0 将 AI 叙事层列为产品核心模块、主线缺口序列第一。2026-11-13 用户拍板 provider/部署决策：① 参考适配器双轨（OpenAI 兼容 + WorkBuddy 云服务 SDK 免密钥）+ Mock 默认；② 凭证全服务端、客户端零凭证（用户「自带 key」经登录后云端 SDK 消解）；③ 延迟面含事件 flavor 异步。本 ADR 将这些决策固化为实施约束。

### 现状核实（以代码为准）

| 事项 | 核实结论 | 证据 |
|---|---|---|
| 叙事护栏 | `NarrativeRequest` 只读、无可写状态；`resolveEndingNarrative`/`finalizeEvaluationSummary` 已做 strict Zod + 证据白名单 + 三来源 + `diagnostic` | `packages/game-core/src/v2/narrative.ts` |
| 输出契约 | `EndingNarrativeOutputSchema`{title,summary,evidenceIds} strict；`EvaluationSummaryOutputSchema`{summary} strict；`NarrativeSource` enum `["template","llm","fallback"]` | `packages/shared/src/schema/evaluation.ts:98-118`、`ending.ts:37` |
| 确定性内核 | `packages/game-core` 无任何 LLM SDK / 网络调用 | AGENTS §1；全仓扫描无 LLM import |
| LLM 路径 | `narrativeSource` 恒 `"template"`，无 provider、无路由、无回退触发 | `narrative.ts`（无 adapter 注入点被填满） |
| 凭证前提 | ADR-0025 已接 WorkBuddy 登录 + 人生档案（前端 `2991eb2`/`dee5570`）；登录会话可作云端 SDK 凭证来源 | `docs/DECISIONS.md` ADR-0025、`git log` |

### 决策 1：LLMProvider 接口定义在 `apps/server`，game-core 只保留纯函数

1. **`LLMProvider` 接口**（`complete(request, schema, opts?): Promise<unknown>`）定义于 `apps/server`（不在 `packages/game-core`），实现（Mock / WorkBuddy 云端 SDK / OpenAI 兼容）均在服务端。game-core **不新增任何 LLM SDK / 网络调用**（AGENTS §1 硬约束）。
2. **game-core 抽出导出的纯函数**：`buildEndingNarrativeRequest` / `buildEvaluationSummaryRequest` / `buildEventFlavorRequest` / `validateNarrativeOutput(schema, candidate, allowedEvidenceIds)`。前者构造只读请求，后者复用既有 strict 校验 + 证据白名单逻辑——保证「校验」单一事实来源在 game-core，服务端只调不重写。
3. 既有 `resolveEndingNarrative(request, adapter?)` / `finalizeEvaluationSummary(record, adapter?)` 保留为同步 adapter 路径（本地/测试用），生产主路径改为服务端编排。

### 决策 2：三层凭证路由，客户端零 LLM 凭证

1. **路由优先级**（服务端持有）：① 存在 WorkBuddy 登录会话 ⇒ 云端 SDK（免密钥，部署/登录态默认）；② 配置了 `LIFE_SIM_LLM_BASE_URL`/`MODEL`/`API_KEY` ⇒ OpenAI 兼容（DeepSeek / 国产 / 本地端点）；③ 否则 ⇒ Mock（返回确定性/模板化文本，demo/测试零外部依赖）。
2. **客户端绝不持有 LLM 凭证**（AGENTS §5「不得外部账号依赖 / 客户端不直连」）：用户「自带 key」概念经「登录后云端 SDK 免密钥」消解——登录用户凭 ADR-0025 登录会话调平台 LLM，无 key 暴露、无客户端直连。
3. **密钥仅经环境变量**：`LIFE_SIM_LLM_*` 缺省即视为不可用并回退 Mock；**绝不硬编码、绝不提交**；仓库密钥字面量纳入既有扫描护栏（类比 `boundary.test.ts` 世界观专名扫描）。

### 决策 3：确定性边界——LLM 文本仅展示，排除在 replay 契约外

1. LLM 只填充不参与状态转移 / 评分的**展示字段**；候选与评分仍由规则确定性生成（同 seed 同输入同结果）。
2. **叙事文本明确排除**在「同 seed 同输入同结果」回放契约之外：归档时把当时生成的叙事原文作为**展示快照**存入档案；重放断言只比对状态/事件/结局/评分，不比对叙事文本。
3. `EventFlavorOutputSchema` 等 LLM 输出契约均为 **strict**，拒绝任何试图写状态/分数/维度的字段（沿用 R-EN-06 / R-EV-05 既有约束）。

### 决策 4：回退与可诊断——strict Zod + 证据白名单 + 超时/错误 → fallback

1. `generateNarrative(request, schema, provider)` 编排：`provider.complete` → `validateNarrativeOutput` → 成功返回 `{source:"llm", ...}`；**失败/超时/虚构证据**（`evidenceIds` 越出 `allowedEvidenceIds`）一律返回 `{source:"fallback", diagnostic}`。
2. `diagnostic` 必须非空且区分原因（非法 schema / 虚构证据 / 超时 / adapter 不可用）——错误可诊断，不静默忽略（AGENTS §2）。
3. LLM 失败**绝不阻塞玩法管线**：回合结算、结局、总结不因 LLM 异常/超时中断。

### 决策 5：事件 flavor 异步生成，存非权威缓存

1. 事件 flavor 在回合管线**之外**后台（`fire-and-forget`）生成，超时即回退模板，不占用/阻塞当轮结算。
2. 生成结果存**非权威服务端缓存**（键 `worldId + eventInstanceId + worldTime`），**不写入 `WorldStateV2`、不进 replay**；投影优先取缓存，缺失/超时取模板文案。`WorldStateV2` 序列化字节不受缓存影响。

### 决策 6：配置与密钥管理

1. OpenAI 兼容仅经 `LIFE_SIM_LLM_*` 注入；缺失即回退 Mock，启动不报错。
2. WorkBuddy 云服务 SDK 免密钥 LLM 的真实接入方式（凭 ADR-0025 登录令牌调平台端点）在 T-P2 实施时确认；纯本地 dev 不可达属预期，回退 Mock/OpenAI 兼容。
3. 密钥字面量不进仓库（扫描护栏覆盖）。

### 被否决的备选

- **客户端直连 LLM（浏览器持 key 调 provider）**：违反 AGENTS §5（key 暴露 / XSS / 绑定外部账号）。**否决**；如需用户身份，统一走服务端「登录后云端 SDK」。
- **LLM 写权威状态 / 决定评分**：违反 AGENTS §1/§5 与既有 strict 契约。**否决**——叙事文本严格排除在状态/评分之外。
- **把 LLM SDK 引入 game-core**：违反 AGENTS §1 确定性内核边界。**否决**——LLM 调用全在 `apps/server`。
- **自由文本行动解析（自然语言→结构化候选行动）并进首轮**：OPEN_QUESTIONS #26 未决，需先定规格归属与校验责任。**否决（DEFERRED）**。
- **多 Agent 运行时**：OPEN_QUESTIONS #3 明确 P0 不要求。**否决（DEFERRED）**。
- **事件 flavor 流式输出**：本轮只做异步生成 + 超时回退，流式是后续增强。**否决（延后）**。

### 影响面与文件归属

| 改动点 | 归属 | 依据 | 写冲突 |
|---|---|---|---|
| `apps/server/src/llm/{provider,mock,workbuddyCloud,openaiCompatible}.ts` | `apps/server` | 决策 1/2 | 新文件；服务端热点，与任何改 world 路由的任务串行 |
| `apps/server/src/narrative/generate.ts` | `apps/server` | 决策 4 | 新文件 |
| `packages/game-core/src/v2/narrative.ts` | `packages/game-core` | 决策 1 | 抽纯函数 + 新增 `buildEventFlavorRequest`；不引 LLM |
| `packages/shared/src/schema/{event,narrative}.ts` | `packages/shared` | 决策 3 | 纯新增 `EventFlavorOutputSchema`（strict）；不升 `schemaVersion` |
| `apps/server` 事件 flavor 缓存 | `apps/server` | 决策 5 | 非权威 `Map`；不进 `WorldStateV2` |
| `apps/web` 投影 | `apps/web` | 决策 3/5 | 消费 `eventFlavor` / `narrativeSource`；缺省模板文案 |

### 不变量检查表

| 不变量 | 现状 | 本决策影响 | 保护措施 |
|---|---|---|---|
| 同 seed 同输入同结果 | 成立 | 叙事文本排除在契约外（预期变化）；状态/事件/结局/评分不受影响 | 重放断言不比对叙事；LLM 不写状态/评分 |
| hidden 不进入玩家端 API | 成立 | 无影响 | 不动投影字段集；flavor 仅文本 |
| 世界观规则只进模板 | 成立 | 强化：LLM 不引入按世界观分支的引擎逻辑 | provider 只产文本，不读模板语义 |
| 时间/随机/ID 可注入 | 成立 | LLM 调用不消耗游戏 RNG；缓存键不含随机 | 异步生成在管线外；缓存键确定性 |
| game-core 无 LLM 依赖 | 成立 | **裁定维持**：LLM SDK/网络只在 `apps/server` | 接口定义在 server；game-core 只抽纯函数 |
| 客户端零 LLM 凭证 | 旧：无 LLM | **裁定为硬约束** | 路由全服务端；密钥仅 env；客户端不持 key |
| `WorldStateV2` 不变 | 旧：无 flavor 缓存 | **裁定零改动** | 缓存非权威、在状态外 |
| `schemaVersion` 不升 | 旧：=2 | **裁定不升**（shared 仅纯新增） | 旧档可直接载入 |
| 🔴 **隐藏结局（`narrativeConfig.masked`）原文绝不进入 LLM adapter 注入与玩家可见响应**〔事后补记新增行，草案遗漏项〕 | 草案第 2 行「hidden 不进入玩家端 API｜无影响｜不动投影字段集」**不足以覆盖响应层装饰**——LLM 的 title/summary 若直接覆盖 `snapshot.ending` 会绕过 ADR-0006 掩码泄漏 hidden 原文（违反 R-NFR-04 / `GAME_RULES §7`） | 裁定为硬约束：masked 结局一律跳过 LLM adapter 注入**与**响应层装饰，保留模板掩码文案 | **双层实现**：① `isMaskedEnding(resolution)`（`apps/server/src/index.ts:174-178`）按 `endingId` 回查 `narrativeConfig.masked`，命中即 `TEMPLATE_OUTCOME`，结局叙事 / 人生总结 / 归档路由三处同步跳过；② `decorateEndingView`（`apps/server/src/narrative/generate.ts:106-118`）判 `ending.visibility === "hidden"` 原样返回；前端 `AiNarrativeTag` 仅在 `narrativeSource === "llm"` 显示 |

> **〔事后补记注记，草案 8 行原文保留不改〕** 上表第 9 行是 Phase 3 实绩暴露的**草案遗漏项**，由主理人 G6 裁决确认为硬约束后补入本表。另补两条**契约面事实**（供后续核对，非新增不变量）：① **模板指纹不变**——本轮未改任何 `*.yaml`，而 `computeFingerprint`（`apps/server/src/templates.ts:101-112`）只 hash `specs/data/templates/**/*.yaml`，故指纹不变、旧档可直接载入（`apps/server/src/store.ts:96-133` 四道关全过）；② **`V2Snapshot.evaluation` 不含 `summarySource` 字段**，本轮不扩投影契约，玩家侧仅从 `archive.evaluation.summarySource` 读取（见决策结果小节）。

### 验证要点（含落地用例位置）

1. **零回归默认**：无 `LIFE_SIM_LLM_*` 且无登录态 ⇒ Mock 默认、叙事恒模板；`pnpm --filter @life-sim/server start` 加载期不报错。
2. **回退三反例**：注入非法 schema / 虚构 `evidenceIds` / 超时 ⇒ 均回退 `fallback` + `diagnostic` 区分原因；玩法不中断。
3. **确定性**：同 seed 重放断言不比对叙事文本；注入 LLM 前后维度/分数/证据逐字段相等。
4. **事件 flavor 异步**：事件结算不被 LLM 延迟；超时（极短 timeout）后展示仍模板；`WorldStateV2` 两次序列化字节一致。
5. **密钥护栏**：仓库无明文 key；`API_KEY` 缺失自动 Mock 不报错；密钥字面量不进提交。
6. **类型**：`pnpm typecheck` 0 错；game-core / shared 测试全绿；`playthrough.test.ts` 6 种子结构性断言（day/章节/五维）不变。

### 明确不做（边界）

| 不做 | 理由 |
|---|---|
| 不把 LLM 引入 game-core | 决策 1（AGENTS §1 硬约束） |
| 不允许客户端直连 LLM | 决策 2（AGENTS §5） |
| 不升 `schemaVersion` / 不改 `WorldStateV2` | 影响面表（旧档兼容、缓存非权威） |
| 不把 LLM 写入状态/评分 | 决策 3（AGENTS §5、既有 strict 契约） |
| 自由文本行动（#26）/ 多 Agent（#3）/ 流式输出 | DEFERRED，本轮只登记不实现 |
| **不宣称 WorkBuddy 云端 SDK 免密钥 LLM 已接通**〔事后补记新增行〕 | 决策 2/6 修正 + `OPEN_QUESTIONS #49`：ADR-0025 已定「服务端零凭据」，登录会话只存在于浏览器 SDK 且该 SDK 仅支持 streaming；`apps/server` 无该依赖、拿不到浏览器登录态。本轮只落地 env 注入 session 的**可运行降级形态**，未注入即 `LLMUnavailableError` 回退模板；真实「登录用户 → 服务端免密钥」链路**待用户裁决，不得写成已解决**。 |

> **〔事后补记注记〕** 上表第 6 行为新增行；原 5 行（含 DEFERRED 四项「自由文本行动 #26 / 多 Agent #3 / 流式输出」及「不允许客户端直连 LLM」）**原文保留不改，仍只登记不实现**。

---

### 〔事后补记〕变更范围（实绩）

> 本节及以下三节为 **2026-11-13 事后补记新增**，草案的「背景／现状核实／决策 1–6／被否决的备选／影响面与文件归属／不变量检查表／验证要点」原文一律保留不改，便于后续核对。实绩基线 `ad53d01`（R2.7 起草时 HEAD）→ `ba889ba`（Phase 3 功能完成 HEAD）；`git diff --stat ad53d01..ba889ba` = **18 files changed, 1767 insertions(+), 53 deletions(-)**。本节补记本身（仅 `docs/DECISIONS.md`）在 `ba889ba` 之后单独提交，不计入上述 18 文件。

#### 实绩 1 · 契约面事实（技术判定不变）

| 项 | 落地结论 | 核验证据 |
|---|---|---|
| 变更类别 | **T-2 协议/契约变更**（动 `packages/shared` + `packages/game-core` + `apps/**`） | `AGENTS.md §0.3` 判据；草案 `:2118/:2120` 定性成立。用户免除的是**前置 ADR 流程**，不是降级为 T-1。 |
| `schemaVersion` | **保持 2，不升** | `apps/server/src/store.ts:34` `const SCHEMA_VERSION = 2` 未改；加载四关（`:114` 版本 → `:119` 指纹 → `:123` `WorldStateV2Schema.safeParse`）不变。 |
| `WorldStateV2` | **零改动** | `packages/shared/src/v2-state.ts` 未改（`git diff --name-only` 反向核验通过）；缓存为 `apps/server` 模块级 `Map`，不进 state/flags/history。 |
| 模板指纹 | **不变** | 本轮未改任何 `*.yaml`；`computeFingerprint`（`templates.ts:101-112`）只 hash `specs/data/templates/**/*.yaml`。 |
| 旧档 | **不拒载（可直载）** | 未动 `WorldStateV2Schema`、未升版本、未改 yaml ⇒ 四关全过。⚠️ 与以往「改模板 ⇒ 旧档全拒载」不同：`AGENTS.md §0.3` 的「主动声明存档代价」**只对 yaml 改动生效**，本轮不适用。 |
| 运行时依赖 | **无新增** | `apps/server/package.json`、`apps/web/package.json`、`pnpm-lock.yaml` 均未在 `git diff --name-only` 中；未 import `@tencent-ai/workbuddy-cloud-sdk`（server 无该依赖）。 |
| 投影契约 | **`EndingView` / `V2Snapshot` / `projectSnapshotV2` / `buildEndingView` 零改动** | `packages/shared/src/v2.ts`、`packages/game-core/src/v2/projection.ts` 均未改；玩家可见 llm 来源由**服务端出口响应层装饰**实现（见「决策结果」）。 |

#### 实绩 2 · 18 个改动文件与归属（`git diff --name-only ad53d01..ba889ba`）

| # | 文件 | 包 / WS | 角色 |
|---|---|---|---|
| 1 | `apps/server/src/llm/provider.ts` | server / WS-P | `LLMProvider` 接口（`id` + `complete`）、`LLMConfig`、`readLLMConfig`、`createLLMProvider` 三层路由 |
| 2 | `apps/server/src/llm/mock.ts` | server / WS-P | `MockProvider`（确定性文本；默认路由由 `generateNarrative` 短路，不调 `complete`） |
| 3 | `apps/server/src/llm/openaiCompatible.ts` | server / WS-P | OpenAI 兼容 provider（纯 `fetch` + `LIFE_SIM_LLM_*`，`AbortSignal.timeout`） |
| 4 | `apps/server/src/llm/workbuddyCloud.ts` | server / WS-P | 云端**可运行降级形态**：env session + SSE 聚合；未注入 session 抛 `LLMUnavailableError` |
| 5 | `apps/server/src/llm/errors.ts` | server / WS-P | `LLMUnavailableError` / `LLMTimeoutError` / `isTimeoutLike`；错误体绝不含 key/token/session |
| 6 | `apps/server/src/narrative/generate.ts` | server / WS-P+WS-S | `generateNarrative`（预取 + 超时竞速 + 校验）、`adapterFromOutcome`（同步桥）、`decorateEndingView`（响应层装饰 + hidden 护栏） |
| 7 | `apps/server/src/narrative/flavorCache.ts` | server / WS-S | 非权威 `Map` + 确定性复合键 + `scheduleEventFlavors` fire-and-forget |
| 8 | `apps/server/src/index.ts` | server / WS-P+WS-S | **唯一路由文件**（草案/设计稿误写的 `apps/server/src/v2.ts` 并不存在）：`isMaskedEnding`、快照装饰统一入口、归档 adapter 注入、flavor 调度与响应合并 |
| 9 | `apps/server/smoke/narrative.smoke.ts` | server / T-S4 | 冒烟脚本 6 项（`node:assert` + `tsx`，不引 vitest） |
| 10 | `apps/web/src/api.ts` | web / WS-S | `EventFlavorMap`、`resolveEventNarrative`、补齐 `ArchiveResponse.archive` 的 `ending`/`evaluation`/`termination` 类型 |
| 11 | `apps/web/src/main.tsx` | web / WS-S | `AiNarrativeTag`、消费 `eventFlavors` / `summarySource`、GET/409 刷新路径合并 |
| 12 | `apps/web/src/style.css` | web / WS-S | AI 叙事标记样式 |
| 13 | `packages/game-core/src/v2/narrative.ts` | game-core / WS-P+WS-S | 导出 `buildEvaluationSummaryRequest`（原私有 `summaryRequest` 提升）、`buildEndingNarrativeRequest`、`buildEventFlavorRequest`（`Object.freeze`）、`validateNarrativeOutput`、`NarrativeInput`/`NarrativeOutputSchemaLike`；**既有同步签名零改动、不引 LLM/网络** |
| 14 | `packages/game-core/src/v2/narrative-llm.test.ts` | game-core / T-S4 | 定向 12 例 |
| 15 | `packages/shared/src/schema/event.ts` | shared / WS-S | 新增 `EventFlavorOutputSchema = z.object({flavor}).strict()`（**落在 `event.ts`，导出链零改动**；未挂进任何 `*Template*Schema`） |
| 16 | `packages/shared/src/event-flavor.test.ts` | shared / T-S4 | 定向 5 例 |
| 17 | `docs/OPEN_QUESTIONS.md` | 文档 | **#49** 登记（由实施工程师写入，本补记不改） |
| 18 | `specs/iterations/2026-11-13-ai-narrative/tasks.md` | 规格 | T-* 状态 + T-S4 收窄说明（由实施工程师写入，本补记不改） |

#### 实绩 3 · 10 个 commit 与任务/需求编号（`git log --oneline ad53d01..ba889ba`，由旧到新）

| # | commit | 任务 / 需求 | 内容 |
|---|---|---|---|
| 1 | `42ffa17` | T-P1 / R-LLM-01, R-LLM-03 | 叙事纯函数抽取与 `LLMProvider` 契约 |
| 2 | `e189d03` | T-P2 / R-LLM-02, R-LLM-06 | 三层 Provider 与凭证路由 |
| 3 | `6242981` | T-P3 / R-LLM-04, R-NAR-01 | 叙事编排与同步/异步桥 |
| 4 | `3b567dd` | T-P4 / R-LLM-05, R-NAR-03 | 事件 flavor 异步非权威缓存 + 冒烟脚本 |
| 5 | `c4f59e1` | T-S3 + T-S1/T-S2 / R-NAR-03 | 前端消费 `eventFlavors` + 玩家可见 AI 叙事标记 |
| 6 | `80379c4` | T-S1 / R-NAR-01 | 结局叙事接真实 LLM + 响应层装饰 |
| 7 | `00a5649` | T-S2 / R-NAR-02 | 人生总结接真实 LLM |
| 8 | `0501e98` | T-S3 / R-NAR-03 | 事件 flavor 服务端接入 + 投影下发 |
| 9 | `ef28d26` | 冒烟护栏 | 冒烟脚本路由占位值改具名常量，消除密钥字面量扫描误报 |
| 10 | `ba889ba` | T-S3 / R-NAR-03 | 补齐 GET / 409 刷新路径 `eventFlavors` 合并缺口（Phase 3 HEAD） |

> 提交颗粒度符合 `tasks.md`：每个 `T-*` 一个 commit、信息注明任务 ID 与需求编号。本补记为第 11 个 commit，**只改 `docs/DECISIONS.md`**。

---

### 〔事后补记〕决策结果（落地口径）

> 本节把草案决策 1–6 与**实际实现的差异**逐条固化，并固化主理人 6 条 G6 裁决。草案决策编号与措辞原文保留不改。

1. **决策 1（LLMProvider 在 server，game-core 只保留纯函数）——落地一致，补充两点**：① `LLMProvider.complete(request: NarrativeInput, schema: NarrativeOutputSchemaLike, opts?): Promise<unknown>` 定义于 `apps/server/src/llm/provider.ts`，多一个 `readonly id: "mock" | "workbuddy-cloud" | "openai-compatible"` 供编排层短路；② 校验单一事实来源落在 game-core 的 `validateNarrativeOutput(schema, candidate, allowedEvidenceIds)`，返回 `{ok:true,data}` 或 `{ok:false, reason:"invalid_schema"|"fabricated_evidence"}`，`NarrativeOutputSchemaLike` 让 game-core **不直接 import zod**；`buildEventFlavorRequest` 返回 `Object.freeze` 的只读请求。既有 `resolveEndingNarrative` / `organizeEvaluationSummary` / `finalizeEvaluationSummary` **同步签名零改动**。

2. **决策 2 / 决策 6（凭证路由、密钥管理）——修正，🔴 不宣称云端 SDK 接通（主理人 G6 裁决 1）**：草案写「登录会话 → 云端 SDK（免密钥）」，但 **ADR-0025 已定「服务端零凭据」**（`:1934/:1939/:1958/:1967/:1974`），登录会话只存在于浏览器 `apps/web` 的 SDK 单例（`cloud.ts:26-30`），该 SDK 的 `chat.completions.create()` **仅支持 streaming SSE** 且会话以 localStorage 为唯一真源、client 刻意不暴露 `sessionToken`；`apps/server` 无该依赖、前端 `api.ts` 也无任何凭据头。故本轮**不接通、不写成已解决**，落地为**可运行降级形态**：env 注入 `LIFE_SIM_WORKBUDDY_SESSION` + `LIFE_SIM_WORKBUDDY_CLOUD_URL`（未配置时用占位默认端点 `http://127.0.0.1:8787`）→ 全局 `fetch` 调 `${cloudUrl}/.cloud/llm/chat/completions`（`stream:true`）→ `collectSseContent` 聚合 SSE `data:` 行的 `choices[0].delta.content` → `JSON.parse`；**未注入 session 即抛 `LLMUnavailableError` 并回退模板，绝不假装成功**，不可达 / 超时同样回退。真实链路登记 **`docs/OPEN_QUESTIONS.md #49` 待用户裁决**（候选 A 服务端长期凭据 / B 平台可校验短期会话令牌 / C 保持现状；不决策后果即 C）。实际路由优先级：`cloudSession + cloudUrl` ⇒ workbuddy-cloud；三项 `LIFE_SIM_LLM_*` 齐备 ⇒ openai-compatible；否则 ⇒ mock（`createLLMProvider`，`provider.ts:67-80`）。密钥仅经 env，三项缺任一即整组不可用、启动不报错；错误体与日志绝不含 key / token / session。

3. **Mock 语义（主理人 G6 裁决 2，解决 R-LLM-02 与 T-P3 DoD 的口径矛盾）**：**默认路由短路 `template`**——`generateNarrative` 见 `provider.id === "mock"` 直接返回 `{source:"template", data:null, diagnostic:null}`，**根本不调 `complete`**（零回归、零延迟、零外部依赖）；`MockProvider.complete` 保留供单测 / 显式注入，返回满足 strict 契约的确定性合法候选 ⇒ `source:"llm"`；显式注入合法候选或 OpenAI 兼容 env 齐备 ⇒ `llm`。据此 R-LLM-02「无 env 无登录态 ⇒ 叙事恒模板」与 `tasks.md T-P3 DoD`「Mock 返回合法候选 ⇒ llm」两者均成立，不再冲突。

4. **同步 / 异步桥 + 玩家可见准绳（主理人 G6 裁决 3）**：服务端 `generateNarrative` 预取（`await provider.complete` + `Promise.race` 超时竞速，provider 忽略 opts 也挂不住管线）→ 产出 `NarrativeOutcome {source, data, diagnostic}` → `adapterFromOutcome` 转成 game-core 既有**同步** `NarrativeAdapter`（`template` ⇒ `undefined` 不注入；`llm` ⇒ 返回已校验候选交既有 strict Zod 二次确认；`fallback` ⇒ 抛错借用既有 catch 分支产出 `narrativeSource`/`summarySource === "fallback"`），回注 `resolveEnding` 的 `narrativeAdapter` 与 `finalizeEvaluationSummary`。**game-core 同步签名零改动、无网络、无 Promise**。玩家可见 `narrativeSource:"llm"` 由出口 `decorateEndingView` 做**响应层装饰**（`apps/server/src/narrative/generate.ts:106-118`）：只覆盖已终止且 `visibility === "public"` 的 `snapshot.ending.{title,summary,narrativeSource}`，`fallback` 只置来源、保留模板 title/summary；`decorateSnapshot`（`index.ts:210-225`）以 `${world.id}:${snapshot.turnIndex}` 缓存 outcome 保证重复 GET 一致。**不改 `EndingView` / `V2Snapshot` / `projectSnapshotV2` / `buildEndingView` 任何契约**。🔴 LLM 注入**绝不发生在 turn 管线 / `advanceTurnV2` 内**（`resolveEnding` 在引擎内被 `ending.ts:217/:381` 调用），只在归档 / 读取 / 响应出口按需生成，回放与零回归不受影响。

5. **决策 3（确定性边界）+ 主理人 G6 裁决 4**：LLM 文本只进 `EndingRecord` / `EvaluationRecord` 的展示字段与响应对象，不进 `WorldStateV2`、不进存档信封（`store.ts:39-45`）、不进 replay。**`summarySource` 不进 `V2Snapshot.evaluation`**（保持投影契约零改动），玩家侧仅从 `archive.evaluation.summarySource` 读取（`apps/web` 以瞬态展示元数据消费，不落库、不进人生档案）；**事件 flavor 不进 `ArchiveRecord`**（不动 game-core 类型）。归档时 `assembleArchive(..., ending, evaluation, endings)` 已收两个对象、`projectArchiveForPlayer` 只过滤 `history` 其余原样透传 ⇒ 归档响应天然带 `archive.ending.narrativeSource` / `archive.evaluation.summarySource`，**`assembleArchive` 签名零改动**。

6. **决策 4（回退与可诊断）——落地一致，补充 diagnostic 落点**：`EventFlavorOutputSchema` / `EndingNarrativeOutputSchema` / `EvaluationSummaryOutputSchema` 均 `.strict()`，拒任何额外字段（LLM 常附带 `reasoning`/`usage` ⇒ provider 须先产出严格 JSON）；`validateNarrativeOutput` 二次拒绝 `evidenceIds` 越出 `allowedEvidenceIds`。`diagnostic` 区分 `invalid_schema` / `fabricated_evidence` / `[超时]` / `[不可用]` 四类，非空且互不相同。⚠️ **`diagnostic` 在 `EndingRecordSchema` / `EvaluationRecordSchema` 中无字段且 strict** ⇒ 只能留在 `NarrativeOutcome` 与服务端可诊断日志（`request.log.warn({diagnostic}, "narrative_fallback")`，不含 key/token/session），**不写进 shared 契约或 state**；这是草案未明确的口径差，固化于此。LLM 失败/超时一律不阻塞玩法管线。

7. **决策 5（事件 flavor 异步缓存）+ 主理人 G6 裁决 5（缓存键修正）**：草案键 `worldId + eventInstanceId + worldTime` 中的 **`eventInstanceId` 在本轮 `WorldStateV2` / 投影 / 代码中不存在**（全仓仅 4 处规格文档提及）；现有 `instanceId` 是状态层延时队列实例（`event-instance.ts:41/67`，`evi-<seq>`，不进玩家投影），`triggeredEvents[].id` 是**定义 id**。故实绩改用**确定性复合键** `worldId|turnIndex|worldTime|eventId|occurrenceIndex`（`flavorCache.ts:25-33`，`occurrenceIndex` 由同轮 `triggeredEvents` 下标派生），**严禁 `Math.random()` / `Date.now()` / `randomUUID()` 参与键**；`worldId` 是建世界时一次性注入的既有标识，可作前缀。缓存是 `apps/server` 模块级独立 `Map`，只存 flavor 文本，**绝不挂到 state 上**；`worldStore.save(res.state)` 在生成前完成；`WorldStateV2` 与 schema 一行未动 ⇒ 两次 `JSON.stringify(state)` 逐字节一致。`eventFlavors` 只作**响应级可选 map** 下发（不改 `V2TurnResult`/`V2Snapshot` 结构），前端 `resolveEventNarrative` 空值回退模板文案（「字段缺失 = 与改前逐字相同」）。**不进 replay、不落盘**。**R3 seam 保护**：未为缓存键给 `WorldStateV2` 新增实例 id 字段（否则升 `schemaVersion`、动存档、绑死时间穿越预留点），键含 `worldTime` 但**不写死时间单调假设**。

8. **🔴 新增不变量（草案遗漏，主理人 G6 裁决 6）**：`masked` 隐藏结局**一律跳过 LLM adapter 注入与响应层装饰**，绝不把 hidden 原文写进玩家可见响应。已**双层实现**：① 服务端 `isMaskedEnding(resolution)`（`index.ts:174-178`）按 `endingId` 回查模板 `narrativeConfig.masked`，命中即 `TEMPLATE_OUTCOME`，结局叙事 / 人生总结 / 归档路由三处同步跳过；② `decorateEndingView`（`generate.ts:106-118`）判 `ending.visibility === "hidden"` 原样返回。前端 `AiNarrativeTag` 也仅在 `narrativeSource === "llm"` 时显示，hidden 结局恒非 llm。该行已补入「不变量检查表」（见上）。

9. **验收口径补齐（实施期发现并修复）**：事件 flavor 为 `fire-and-forget`，首次结算响应可能早于后台生成 ⇒ `GET /api/worlds/:id` 与 409 冲突刷新路径的 `eventFlavors` 合并缺口由 `ba889ba` 补齐（`index.ts` 的 `responseEventFlavors` 合并「该世界历史缓存 ∪ 本轮缓存」；`main.tsx` 的 `withMergedFlavors` / `mergeEventFlavors`），弥合固有延迟；`apps/web/src/api.ts` 补齐 `ArchiveResponse.archive` 类型（草案/设计阶段前端只声明了 `snapshot` + `hiddenHistoryCount`，与后端返回全量 `ArchiveRecord` 不对齐）。

---

### 〔事后补记〕验证结果（冒烟级）

> 依据主理人转达的 **QA 裁定：通过**（S1–S9 全 PASS、零 P0/P1）。本 ADR 只如实登记验证范围与结论，**不重新出测试结论**。

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | **0 错**（全仓 `tsc --noEmit -p tsconfig.json`，覆盖 `packages/**/*.ts` + `apps/**/*.ts(x)`） |
| 定向用例 | `packages/game-core/src/v2/narrative-llm.test.ts` **12 例** + `packages/shared/src/event-flavor.test.ts` **5 例**，全绿 |
| 服务端冒烟 | `apps/server/smoke/narrative.smoke.ts` **6 项全 PASS**：① `createLLMProvider` 三层路由 / `API_KEY` 缺失自动 Mock 不抛；② `generateNarrative` 三类反例（非法 schema / 虚构证据 / 超时）回退且 diagnostic 可区分；③ 合法候选 ⇒ `llm`、mock ⇒ `template` 且不调用 `complete`；④ `finalizeEvaluationSummary` 注入 LLM 前后 `dimensions`/`evidenceIds`/`overall` 逐字段相等；⑤ `decorateEndingView` 对 hidden 结局原样返回、public 才装饰；⑥ flavorCache 键确定性 + 缓存不进状态 |
| 加载期 / 构建 | `apps/server` 加载期 `/health` 与 `/api/templates` **200**；`apps/web` **build 通过** |
| 安全护栏 | 隐藏信息**零泄漏**（含 masked 隐藏结局护栏）；仓库**密钥零字面量**（`ef28d26` 消除扫描误报） |
| 零回归 | 无 `LIFE_SIM_LLM_*` 且无登录态 ⇒ 叙事恒 `template`、不调 `complete`，与改前逐字相同 |

> 🔴 **按用户裁决仅执行冒烟级验证，明确未执行：全量测试套件 / `playthrough.test.ts` 6 种子回归 / UI e2e / 全流程测试。** 不得把未跑项目写成已验证。草案「验证要点」第 6 条所列 `playthrough.test.ts` 6 种子结构性断言**本轮未执行**；`tasks.md` T-S4 原文任务编号保留，仅按用户裁决收窄本轮验证范围（见 `specs/iterations/2026-11-13-ai-narrative/tasks.md`「T-S4 收窄说明」）。这是**有意的验收边界**，不是缺陷或遗漏。

---

### 〔事后补记〕附录：遗留与风险

| 项 | 状态 | 说明 |
|---|---|---|
| `OPEN_QUESTIONS #49` 登录用户 → 服务端免密钥 LLM 真实注入链路 | **待用户裁决（未解决）** | 候选 A（服务端长期凭据，等价 OpenAI 兼容 env 路由）/ B（平台可校验短期会话令牌，需定令牌形态、下发通道、过期与撤销）/ C（保持现状，登录用户仍只走 Mock / OpenAI 兼容，云端免密钥 LLM 在生产不可用）。**不决策后果即 C**。选 A/B 需先定契约并走 T-2 变更 + ADR 补记；本条事后补记**不覆盖此项**。 |
| `summarySource` 玩家随时可见性 | **待决（不阻断）** | 本轮只在归档路径从 `archive.evaluation.summarySource` 读取；若产品要求跑动中随时可见，须给 `V2Snapshot.evaluation` 加可选字段（**动投影契约 = T-2 + ADR**）。 |
| QA 建议：`narrativeSource` / `summarySource` 端到端展示断言 | **下轮补强，不阻断** | 本轮仅冒烟级验证；端到端展示断言留待后续迭代。 |
| 事件 flavor 在刷新 / 409 后合并 | **已补齐** | `ba889ba`（T-S3 补齐 GET/409 刷新路径 `eventFlavors` 合并），见「决策结果」第 9 条。 |
| `diagnostic` 未持久化 | **已知边界** | `EndingRecordSchema`/`EvaluationRecordSchema` strict 且无该字段 ⇒ 仅存在于 `NarrativeOutcome` 与服务端日志；若产品要求可追溯，须另立 T-2 + ADR。 |
| WorkBuddy SDK 仅 streaming 与 `complete(): Promise<unknown>` 的签名落差 | **已在本轮降级形态内消化** | `workbuddyCloud.ts` 聚合 SSE chunk 成完整文本后再交 `JSON.parse` + Zod；若将来接真实 SDK 仍须保持此适配。 |
| 缓存 TTL / 容量 | **已知边界** | 缓存为进程级 `Map`（非权威、随进程生命周期），`worldStore.delete` 时清理对应 `worldId` 分桶；不落盘、不进 replay。 |
| 免流程与事后补记 | 🔴 **仅适用本次任务，不延续** | 见本 ADR 状态行「流程例外声明」：后续任务一律恢复 `AGENTS.md §0.3` 的 **G1 / G2 正常门禁**，动契约面（T-2）必须先写 ADR 并经评审通过后再实施。 |

> **本补记的边界声明**：只修改 `docs/DECISIONS.md` 的 ADR-0027 一节（状态行改写 + 「不变量检查表」新增 1 行 + 「明确不做」表新增 1 行 + 4 个新增小节）；ADR-0001..0026 历史正文**一字未动**；不涉及「对 ADR-0011 决策 5 与 ADR-0024 的修订回指」（该 append-only 注记属 ADR-0026，见本文件 `:2108-2114`）。未改代码、未改 spec、未改 `PROJECT.md`、未改 `OPEN_QUESTIONS.md`（#49 已由实施工程师登记）。

---

### ADR-0028：放开用户自带 LLM Key + 平台免密 LLM 路由 + 前端收敛

- **状态**：**草案（G2 门禁产物，待评审）**。用户于 R2.7 收口后给出三条一次性裁决（推翻 §5 客户端直连禁令 / 平台免密也做 / 前端收敛）作为决策方向；按 `AGENTS.md §0.3` 本 ADR 须经 G2 评审通过后再实施（不沿用 R2.7 的免前置 ADR 例外）。
- **关联**：ADR-0025（服务端零凭据 / 前端 cloud SDK 单例）、ADR-0027（LLMProvider 三层 / 凭证路由 / 缓存键 / 事后补记）、OPEN_QUESTIONS #49（登录用户 → 服务端免密钥 LLM 真实链路）、AGENTS §5（禁止事项）。

#### 背景

R2.7 已实现 `LLMProvider` 三层路由（mock / workbuddy-cloud / openai-compatible），但仅冒烟级验证，且平台侧「登录用户 → 服务端免密钥 LLM」链路（OPEN_QUESTIONS #49）始终未证实，落地为 env 注入 session 的降级形态。用户本轮裁决：

1. **推翻 `AGENTS.md §5`「不允许客户端直连 LLM」这条硬约束** —— 允许在登录页配置自定义 `apiKey` + `model`（可选 `baseUrl`）；服务端内存记录、绝不落盘；风险用户自担。本质是「客户端把 key 交给服务端、服务端代调 LLM」，服务端仍是 LLM 调用方（不鼓励浏览器直连外部 LLM），只是放开「允许使用用户自带 key」。
2. **平台免密 LLM 也做** —— 服务端 LLM 路由优先级：`用户配置的 key（OpenAI 兼容）＞ 平台免密 LLM（cloud-service 的 cloud.llm）＞ mock`；两路都保留。
3. **前端收敛** —— 按钮收拢；NPC 记录归并到「世界」视图，用分 tab / 可展开方式呈现。

#### 现状核实（以代码为准）

- `AGENTS.md §5` 禁止事项实为第 102 行「不得在未获授权时加入付费服务、外部账号依赖或云端模型强绑定」；R2.7 README 据此转述为「严禁（外部账号依赖 / key 暴露）」。第 101 行「不得把隐藏信息返回给玩家端 API」**保留**。
- `apps/server/src` **无任何 login / session / auth 中间件**（grep 仅命中 LLM 的 `cloudSession` env 变量与注释）；登录是纯前端 cloud SDK 行为（`apps/web/src/cloud.ts` + `main.tsx` 的 `login`）。服务端当前无「会话」概念。
- 现有 LLM 路由（`apps/server/src/llm/provider.ts:47` `readLLMConfig` / `:67` `createLLMProvider`）：env 三层 `cloudSession+cloudUrl ⇒ workbuddy-cloud` ＞ `LIFE_SIM_LLM_*` 齐备 ⇒ `openai-compatible` ＞ `mock`。平台侧走 `WorkBuddyCloudProvider`（`workbuddyCloud.ts`）：env 注入 `LIFE_SIM_WORKBUDDY_SESSION` + `LIFE_SIM_WORKBUDDY_CLOUD_URL` → `fetch ${cloudUrl}/.cloud/llm/chat/completions`（SSE 聚合），降级形态，OPEN_QUESTIONS #49 未决。
- 前端 `cloud.llm` 是**客户端**能力：`createWorkBuddyCloud({ endpoint, oauthRelayBaseUrl, publishableKey }).cloud.llm`（`apps/web/src/cloud.ts`）；`publishableKey` 是「半公开」、仅标识应用、不带权限的客户端凭证，可打进前端产物但不得打进日志。服务端无 `@tencent-ai/workbuddy-cloud-sdk` 依赖（ADR-0025 服务端零凭据）。

#### 决策 1：放开用户自带 key（限定 §5 第 102 行适用边界，非彻底删除）

- 服务端**仍代调 LLM**，不鼓励浏览器直连外部 LLM；放开的是「允许使用用户自带 key」——用户在登录页填 `apiKey` + `model`（可选 `baseUrl`），客户端把 key 交给服务端、服务端代调。
- 服务端**内存记录、绝不落盘**；按会话索引、登出 / 重启即清；风险由用户自担（填错 key / 泄露由用户负责）。
- **不改动**：`packages/game-core` 仍零 LLM SDK / 网络；`hidden` 不进玩家端投影（§5 第 101 行保留）。

#### 决策 2：路由优先级 user-key ＞ platform-keyless ＞ mock

- 每个 LLM 触发请求按序选择：① 该请求会话携带的**用户 key**（OpenAI 兼容：`apiKey`+`model`+`baseUrl?`）＞ ② **平台免密**（WorkBuddyCloudProvider：env 注入或云端沙箱注入的 session，命中 `/.cloud/llm/chat/completions`）＞ ③ `mock`。
- **⚠️ 卡点（需平台侧确认）**：cloud-service 的免密钥 LLM（`cloud.llm`）按当前技能 / SDK 仅以**前端 / 客户端**形态提供（`publishableKey` 是客户端凭证），**没有服务端 SDK / 服务端密钥**。服务端当前唯一可用的「平台侧」LLM 通道是 `WorkBuddyCloudProvider` 的 env 注入 session 降级形态；是否由**云端发布沙箱自动为服务端注入 server identity / session** 以启用该 endpoint，现有技能 / 文档**未证实**。
  - 若云端沙箱 / 运维为服务端注入有效 session（env）→ 平台免密在 server 侧可用，路由 ② 生效。
  - 若未注入 → 平台免密在 server 侧不可用，路由 ② 退化为 `mock`（用户无 key 时），与 OPEN_QUESTIONS #49 候选 C 一致；此时「平台免密」仅在**前端** `cloud.llm` 可用（前端能力不变）。
- **降级设计**：云端环境若无法服务端免密，则云端只走 user-key 或 mock，平台免密仅前端可用；**不把前端 `publishableKey` 当作服务端凭证使用**。

#### 决策 3：前端结构（世界中心 + tab / 展开）

- **登录页**：`apiKey` / `model` 输入框**可折叠、可选**；提交后与服务器建 LLM 会话（取回 `sessionId`）。
- **世界视图**：NPC 记录归并到「世界」视图，用**分 tab / 可展开**方式呈现；散落的按钮收拢。

#### 数据模型 / 文件计划 / 接口形状（实施计划，非本次落地）

- **登录载荷新字段**（新服务端 API，非 `packages/shared` schema）：`{ apiKey: string; model: string; baseUrl?: string }`，由新端点 `POST /api/llm-credentials` 接收；服务端校验后 mint 不透明 `sessionId` 返回，后续请求携带（header 或世界操作入参）。落点：`apps/server/src/index.ts`（新增路由）。
- **内存凭证结构**（纯服务端，不进 schema、不持久化）：`apps/server/src/llm/userCredentials.ts`（新）— `Map<sessionId, { apiKey; model; baseUrl? }>` + `mintCredentials()` / `lookupCredentials(id)` / `clearCredentials(id)`；登出 / 进程退出即清。
- **`readLLMConfig` / `createLLMProvider` 扩展**：`readLLMConfig(env, userCreds?)` 增加 userCreds 入参，返回合并 `LLMConfig`（增 `userKey?`）；`createLLMProvider` 或新增 `resolveProviderForRequest(userCreds, platformConfig)` 实现「user-key ＞ platform-keyless ＞ mock」三级；落点：`apps/server/src/llm/provider.ts`。
- **前端登录页 / 世界视图**：`apps/web/src/main.tsx`（登录页可折叠 key/model 输入）、`apps/web/src/**`（世界视图 tab / 展开）、`apps/web/src/api.ts`（携带 `sessionId`）。

#### 备选方案与代价

- **A（服务端长期凭据 = OpenAI 兼容 env）**：已被 user-key 路径实质覆盖（用户自带 key 即运行时版 A）；运维也可继续用 `LIFE_SIM_LLM_*`。
- **B（平台可校验短期会话令牌下发）**：依赖平台为服务端提供 token 形态 / 下发通道 / 过期撤销——当前未证实（卡点）。
- **C（保持现状，登录用户只走 Mock / OpenAI 兼容，云端免密生产不可用）**：OPEN_QUESTIONS #49 原默认；本轮 user-key 已绕开它，平台免密在 server 侧仍可能落 C。
- **客户端直连外部 LLM（浏览器 fetch OpenAI）**：**否决**——违反 §5「外部账号依赖 / key 暴露」本质，且不可诊断、不可回退模板；本 ADR 仍要求服务端代调。

#### 契约影响判定（T-2）

- 新 `/api/llm-credentials` 请求 / 响应：新增服务端 API 契约，但**不修改** `packages/shared` 的 `WorldStateV2` / `V2Snapshot` / archive / event schema ⇒ **非 shared-T-2**；由本 ADR（G2 产物）覆盖为新增运营接口。若未来要把 llm 配置**持久化**或**进投影** ⇒ 另立 T-2 + ADR。
- 内存凭证结构：纯服务端 `Map`，不进 schema、不落盘 ⇒ 非 T-2。
- 投影：`hidden` / `key` / `token` / `session` **不得**进玩家端投影（§5 第 101 行保留）= 约束，非变更。
- `readLLMConfig` / `createLLMProvider` 扩展：服务端内部逻辑 ⇒ 非 T-2。
- **结论**：本轮无需动 `packages/shared` / `WorldStateV2` / 投影契约；ADR-0028 即 G2 产物覆盖新增运营接口，不触发额外 T-2 门禁（除非后续决定持久化 / 投影）。

#### 迁移成本 / 未采纳理由 / 待平台确认

- 迁移成本：低（新增 1 端点 + 1 内存模块 + provider 优先级分支 + 前端两处 UI）；无 schema 迁移、无存档变更、旧档可直载。
- 待平台确认（卡点）：云端发布沙箱是否 / 如何为 `apps/server` 注入 server 侧 `cloud.llm` 身份（`LIFE_SIM_WORKBUDDY_SESSION` / `LIFE_SIM_WORKBUDDY_CLOUD_URL` 或新机制）。未确认前，平台免密在 server 侧按降级（→ mock）处理，不阻塞 user-key 路径。
- OPEN_QUESTIONS #49 处理：user-key 路径已定（新增），「平台 server-side 免密」仍留卡点待平台确认；#49 由「待决」改为「部分落地 + 平台卡点保留」。

#### 待同步更新文件

| 文件 | 改动 | 备注 |
|---|---|---|
| `docs/DECISIONS.md` | 新增 ADR-0028（本 ADR，G2 产物） | 本次写入 |
| `AGENTS.md §5` | 第 102 行修订：放开「用户自带 key（服务端代调、内存、不落盘）」例外；第 101 行保留 | 推翻禁令的适用边界 |
| `specs/iterations/2026-11-13-ai-narrative/README.md` | 状态 / 设计对齐：§5 禁令已推翻、路由优先级变更、平台免密卡点 | 新任务明确列入 |
| `specs/iterations/2026-11-13-ai-narrative/design.md` | 同步：凭证路由章节对齐决策 1/2 | 同上 |
| `docs/OPEN_QUESTIONS.md #49` | 由「待决」改「部分落地 + 平台卡点保留」 | 落地 user-key，平台链路待确认 |
| `tasks/CLOUD_TASKS.md` | 如涉及（新端点 / 前端收敛任务登记） | 待需求策划师同步 |

---

## ADR-0029 轻量模板治理：目录即元数据 + 只读列表 + 运行时热加载

- **状态**：**已通过（2026-11-13，G1/G2 前置评审产物）**
- **覆盖**：模板身份（目录名 + 版本目录名）、存储布局（`<id>/<version>/`）、加载与热加载、存档引用（只记引用、不存字节）、分层指纹与文件角色、可诊断拒载、旧档去向。
- **不覆盖**：导入/上传端点（用户裁决砍掉）、删除与引用守卫、模板市场、owner/审核、字节快照、资源下发、自定义函数执行。
- **关联**：修订 **ADR-0007** 决策 3/4/5；**ADR-0010** 决策 4 不冲突；**ADR-0025** 决策 3 与 `BACKLOG B-24` 不解除；ADR-0026 正交。`OPEN_QUESTIONS #6 / #15` 以本 ADR 关闭。
- **迭代包**：`specs/iterations/2026-11-13-template-governance/`（`requirements.md` 8 ACTIVE / `design.md` 本 ADR 全文 / `tasks.md`）。

### 背景

`OPEN_QUESTIONS #6 / #15` 长期未关；前端已有「多模板」接口形态，后端却把身份硬编码为「目录名 = `meta.id` = 唯一模板」，加第二个模板只能往 `specs/data/templates/` 塞 git 目录。三条已验证证据：① 六个模块级 Map 全按 `meta.id` 索引（`apps/server/src/templates.ts:37-42,121-133`），两目录同 id 会静默互相覆盖；② `persist()` 每轮现查 `getTemplateFingerprint(templateId) ?? "sha256:unknown"`（`apps/server/src/store.ts:66`），运行期换模板会**静默改写旧档指纹**且不可诊断；③ 不可载的档只进启动日志、`GET /api/worlds` 只列内存世界（`apps/server/src/index.ts:566-606`）⇒ 前端 localStorage 留着 `worldId`、点开 404（BACKLOG E-03）。

用户裁决（2026-11-13）依次为：轻量、不做市场；服务端生成 id + 显式版本 + 先选模板再选版本；快照只记引用（「可复现只在模板还在的时候有价值」）；模板包需能装资源、未来可开自定义函数口子但本次只保留扩展性；最后**砍板**——只做读、砍掉前端导入、直接改服务端文件、运行时可热加载、丢模板报错可容忍。

### 决策

**A. 身份与版本**
1. **模板身份 = `(<id> 目录名, <version> 版本子目录名)`**，二者组合唯一。id 不由服务端生成、不从 yaml 读；`version` 不写进 yaml（`meta` 为 `.strict()`，加字段即 shared T-2），由目录名承载。
2. **版本号格式 `^\d+(\.\d+){0,2}$`**（用户裁决 B）；`2` 与 `2.0.0` 是**不同**版本，不做等价归一。
3. **`meta.id` 必须等于 `<id>` 目录名**：启动期不等 ⇒ `throw`；运行期不等 ⇒ 跳过该目录 + `warn`。理由：`createWorldV2` 直接写 `templateId: template.meta.id`（`packages/game-core/src/v2/turn.ts:142`），身份一致只能靠这一条断言强制。
4. 新版本 = `mkdir <version>/`；服务端**零写入端点**，故无导入幂等/冲突判定。

**B. 存储与加载**
5. 布局 `specs/data/templates/<id>/<version>/`；内置 `jjk-2006` 迁入 `1.0.0/`。语义指纹只拼 **文件名 + `"\0"` + 内容**、**不含路径** ⇒ 迁移不改指纹。
6. 注册表 `Map<id@version, Entry>`，`Entry = { ref, status: "ready" | "invalid", template, lookup, semanticFingerprint, assetFingerprint, assetCount, openings, endingConfig, evaluationConfig, pipeline, mtime }`；六个旧 Map 收敛为一条。
7. 不设任何清单文件（`_meta.json` 取消）——**目录结构即元数据**，指纹实时计算。
8. **空版本目录**（无任何 `*.yaml`）忽略 + `warn`，**两个时机都不 fail-fast**；只有「含 ≥1 yaml 但校验失败」才算坏模板（启动期 `throw` / 运行期 `invalid`）。整个模板目录零模板 ⇒ 启动 `throw`。

**C. 存档与拒载**
9. 信封新增 `templateVersion?: string`，**`schemaVersion` 保持 2**（升 3 会一次性拒载现存全部可载档）。
10. 缺 `templateVersion` 的档按「该 id 下唯一版本 + 指纹相等」推断并**启动期回填**；≥2 版本 ⇒ `template_version_ambiguous`（用户裁决 A：**报错要求手工补填**，不得默认取最高版）。
11. **判定顺序写死：先定版本、再比指纹。**
12. **`persist()` 必须读世界自身固化的 ref**（`refs` 与世界内存快照合并为一条 record），**禁止**现查全局指纹表、禁止 `"sha256:unknown"` 占位；缺 ref ⇒ `template_ref_missing`（500）。这是本 ADR 唯一触碰确定性相关代码之处。
13. 载入基准 = 该版本目录**实时重算的 `semanticFingerprint`** vs 信封 `templateFingerprint`，不等 ⇒ `template_content_drift`；`assetFingerprint` 与资源存在性**不参与拒载**。
14. 封闭拒载枚举 **8 个、一个都不能合并**：`envelope_json_invalid` / `envelope_schema_version_unsupported` / `template_missing` / `template_version_missing` / `template_version_ambiguous` / `template_invalid` / `template_content_drift` / `world_state_invalid`。世界列表区分「可载 / 存在但不可载」，`GET /api/worlds/:id` 返回 409 而非 404（修 E-03）。

**D/E. 导入管线与删除守卫：整章撤回**
15. 用户裁决砍掉导入：无 `POST /api/templates/imports`、无六层校验、无上传体积/编码/鉴权、无前端上传控件。随之失效 14 个 `import_*` 错误码。
16. 删除/下架/引用守卫全部不做：**「运行时丢模板导致报错可容忍」是用户明确接受的代价**。下架 = 挪走目录，删除 = `rm -rf`，覆盖 = 直接改文件。

**F. 与既有决策的关系**
17. ADR-0007 决策 3（信封结构）/4（指纹拒载）/5（四道关）**修订**；决策 4 的原意（防的是「行为漂移」而非「必须拒载」）被继承。
18. ADR-0010 决策 4「运行时不生成配置层定义」**不冲突**：手工放模板是「外部给定 + 加载期校验」，注册后对象不可变。
19. `AGENTS §0.3` 判据**不因资源/非 yaml 文件加分支**（用户裁决 A 关闭）；只补一句「新增 `<id>/<version>/` 目录 ≠ 改 yaml」。`AGENTS §0.1` 第 13 行「`specs/data` 禁止移动改名」按新布局修订一句。
20. **导入模板原文不得上云**（ADR-0025 决策 3 红线延伸）；`BACKLOG B-24` 不解除。

**G. 旧档**
21. 现存 `data/worlds`（实测 65 份：`schemaVersion` 1×8 / 2×57，12 个指纹，8 份匹配当前语义指纹）中，可载档**数量不减少**；其余从「启动日志一行」变为「列表可见 + 封闭 reason + 可删」。
22. **计数纪律**：验收判据一律写「迁移前后可载档数量不减少」，**不得写死份数**（冒烟每次建局 +1）；取证必须用**固化夹具存档**，不得依赖 `data/worlds` 实时内容。
23. 不抢救历史档：仅恢复 yaml 也无法复原当时语义（同期改过 ADR-0004/0017/0020/0021/0026）；用户已裁不要求可复现。

**H. 可扩展模板包**
24. 文件**角色**四分类（取代文件名白名单）：`declarative`（白名单 11 个 yaml，进校验与语义指纹）/ `asset`（`assets/**`，进资产指纹，**引擎不消费、前端不下发**）/ `meta`（已删除，若出现按 `code` 处理）/ `code`（其余一切，**加载期 warn + 忽略**）。没有第 5 类。
25. **指纹分层**：`semanticFingerprint` **只 hash 白名单 11 个 yaml**（口径与旧实现同值；**游离 yaml 不参与**——「被忽略的东西不该有让存档失效的权力」）；`assetFingerprint` 算 `assets/**`，空集取 `sha256:e3b0c442…b855`；**载入只读 semantic**。资源缺失或变化 ⇒ 只降级展示。**模拟可载性与展示完整性解耦。**
26. **`computeFingerprint` 必须改实现**（`filter(f => f.endsWith(".yaml"))` → 按白名单名过滤）。对当前模板字节结果相同，但代码要动。
27. **自定义函数 seam = 禁止 + 四条前置**：服务端沙箱（独立进程/worker，`node:vm` **不是**安全边界）/ 不得进 `packages/game-core` / 必须进 `semanticFingerprint` / 独立 ADR + G2。本轮唯一动作是 `files[].role` 枚举位，代码路径上 `eval`/`new Function`/`vm` 零命中。
28. **资源下发 DEFERRED**：本轮无 schema 引用字段、无下发端点，`assets/` **存得进、用不上**，唯一可观测效果是 `assetCount`。

**I. 运行时热加载**
29. **请求驱动**：`resolve` / `listTemplates` 前 `ensureFresh()`，比对**版本目录内所有文件的 mtime 最大值**（顶层 yaml + `assets/**` 递归），**不得用目录 mtime**（就地编辑不改父目录 mtime）。成本 ≤ 43 次 `stat`/请求。**不用定时器、不用 `fs.watch`**（Windows / 容器挂载丢事件）。已知局限：最多晚一次请求看到变更。
30. **内存快照隔离**：已载入世界持有自身 `{state, template, lookup, entry}`，热加载替换注册表 Entry **不改变**它；只影响新建世界与后续载入。理由：否则运行中改 yaml 会让玩家这局中途换语义，污染阶段序列与评价证据。
31. **运行期单目录隔离失败**，绝不 fail-fast；同 `(id,version)` 内容被改 ⇒ 新 Entry 顶替，旧世界靠快照，重启后因指纹不符 ⇒ `template_content_drift`；目录被删 ⇒ 移除 Entry、已载入世界继续跑，重启后 `template_missing`。

### 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 内容寻址快照库 / 存档内嵌模板字节 | 用户裁决「引用即可」；存档中位 36 KB vs 模板 yaml 257 KB ⇒ 按 65 份估算约 9 倍放大；且引擎仍在改（ADR-0020/0021/0026），字节一样也复现不出当时语义 |
| 服务端生成 `tpl-` id + 导入管线 | 无导入后「防作者自报撞车」的威胁模型消失；生成 id 还需持久化映射，重启即变 |
| 指纹改成「目录全量 hash」 | 实测 yaml-only 与全量两个 hash 不等 ⇒ 会一次性打死现存可载档。正确解法是分层，不是扩大覆盖面 |
| 导入后需重启 / 保留 `fs.watch` 热加载 | 前者中断在跑世界；后者在 Windows/容器挂载上丢事件是常态 |
| 覆盖同 `(id,version)` 内容并提示「N 局将不可载」 | 覆盖不可撤销；提示只是把不可逆包装成「已知悉」。要改内容就发新版本 |
| 升 `schemaVersion` 到 3 | 一次性拒载现存可载档，收益为零 |
| 多版本歧义时默认取最高版 | 静默选错，可能把玩家另一条人生线当成这条打开（用户裁决 A 否决） |

### 后果

- **影响面**：`apps/server/src/templates.ts`（重写 ≈156→300 行）、`apps/server/src/store.ts`（信封 + refs/record 合并 + 拒载枚举）、`apps/server/src/index.ts`（18 处调用点 + 两级列表 + 建局版本校验）、`apps/web/src/main.tsx` + `api.ts`（两级选择 + `openings` 归属修正）。**`packages/shared` 与 `packages/game-core` 零改动**（`StoreEnvelope` 是服务端私有 interface）。
- **存档代价**：可载档数量不减少；新增 `templateVersion` 字段；不升 `schemaVersion`。
- **确定性**：引擎零改动 ⇒ 同 seed 同输入同结果不变；承诺边界收紧为「同一 `(id, version, semanticFingerprint)` 内成立」，存档不再承诺终身可载。
- **验证要求**（旧档迁移）：① 迁移**前**一次性留档（几份可载 / 各自 reason），**不入 CI**；② CI 永久跑**四格夹具矩阵**——正 1（有版本号）/ 正 2（无版本号，验回填且只锁 `state` + `templateId`/`templateFingerprint`）/ 负 1（指纹不符 ⇒ `template_content_drift`）/ 负 2（版本目录缺失 ⇒ `template_version_missing`，**其基线列 = N/A**，旧 loader 不读 `templateVersion`）；③ 回归判据**四类**：原本被拒载现在被接受 / 正样本载不进来 / 任一格相对自身基线的差异无法归入「新增拒绝」或「原因细分」/ 无基线格的绝对期望未满足。**「新增拒绝」与「原因细分」不算回归**（fail-closed）。
- **判据纪律**：验收判据须满足三条——**会红**（说得出什么情况下失败）、**能长期重复**、**红了能指认是哪一层**。

### 明确不做

模板市场 / 搜索 / 评分 / 导出；任何导入端点与导入 UI；删除 / 下架 / 引用守卫；模板副本 GC；zip；`fs.watch` / 定时器式热加载；资源下发（schema 引用字段 + 端点 + 消毒）；自定义函数执行；模板字节快照；存档上云 / 跨设备续玩；`schemaVersion` 升 3；抗 YAML 别名炸弹防护（未实测，不得写进验收）。

## ADR-0030 呈现槽准入统一：四类占用者 + 链续步保留

> **本条覆盖**：把「单槽」从**入队互斥**（ADR-0026 的 `pendingEvents ≤ 1`）扩为**呈现槽准入**——槽位是前端一个轮次只呈现一个的**四方共用位**（`wheel | battle | event | action`），引擎侧必须为四类占用者统一判定准入，并为「链续步已结算、尚未入槽」的空窗保留槽位。属 **T-2 触发策略语义变更**（`AGENTS.md` §0.3）：改 `packages/game-core` 的运行期准入语义 ⇒ 必须先 ADR。
> **本条不改协议面**：`packages/shared` 零改动（`PendingEvent` / `ChainStateV2` / `MissReason` / `schemaVersion` / 投影字段集全不动）⇒ **旧档可直接载入**。

- **状态**：**已接受（2026-11-13，待用户批准实施）**。ADR 先行落档，实现等用户点头（实施顺序见「决策 8」）。
  > **〔状态变更 2026-11-13：已被打回，待重审〕** 用户打回设计，原话「打回重新设计 把槽 事件队列 行动 轮次 梳理清楚再设计」。**本 ADR 正文保留不改**，但其**全部决策（含 L1/L2/L3 分层准入、`slotTakenFor`、F2 续步优先、F4 去重、F5 random 纳入、`slotDeferred` 诊断位）在本轮一律不得据以派实施**。重审前置：先产出「槽 / 事件队列 / 行动 / 轮次」的概念模型与混淆点清单，模型定稿后才谈机制；重审时本文的「问题」节与量化基线（normal 6→0、combat 2 次）仍有效，可直接复用为问题清单。
- **起草人**：系统架构师（高见远）；证据复核与量化基线来自内核复现报告（同迭代 `event-slot-rootcause`）。
- **关联**：**ADR-0026（被本条扩围，见文末回指注记）**、ADR-0011 决策 5（再修订）、ADR-0024（前提复核保留为纵深防御，不变）、ADR-0012/0021（combat 判活 skip，不变）、OPEN_QUESTIONS 事件冲突议题。

### 问题：槽位语义只落地了四分之一

结构性事实（以代码为准）：

| 事实 | 证据 |
|---|---|
| 前端「轮次槽位」是**一个区域四类占位者共用**，优先级 `wheel > battle > event > action` | `apps/web/src/main.tsx:203-204`（`type SlotOccupant`）、`:1308-1315`（`occupant` 取值） |
| 引擎「槽位」只读 `pendingEvents` | `turn.ts:471`（`event.kind === "normal" && state.pendingEvents.length > 0`） |
| ⇒ **battle 占位时 `pendingEvents` 可为空**：战斗进行中，尾管线仍可把 normal 事件放进事件槽 | 战斗互斥只挡 combat（`turn.ts:453`）；`advanceTurnV2` 步骤 2 可起战，步骤 3 / 步骤 8 照常 drain + pool |
| ⇒ **random 结算时占位却从不进 `pendingEvents`**：守卫完全看不见转盘 | `turn.ts:497-499` 注释与 random 分支 |
| ⇒ **链续步在「已结算、未入槽」的空窗没有保留位**：延时链步、`nextEventId` 直连被 drain 抢在前面 | `turn.ts:597-608`、`:736-745`；`:1074-1078`、`:1140-1150`、`:1223-1226`（drain 均在续步链接之前） |

**量化基线（本次最硬的证据）**：

| 样本 | 链中断（严口径） | 按类型 |
|---|---|---|
| 守卫上线前的本地旧档 | **8 次** | A = normal 6 / random 2 |
| 守卫上线后的线上 326 轮存档（世界 `aa775496-…`） | **2 次** | A **全部是 combat** |

⇒ **定性：语法糖有效，但只覆盖四分之一，不是「临时实验失败」。** 守卫把「normal 链步被日常插队」从 6 降到 0（这部分成果由 ADR-0026 持有、本条不撤销），而 **combat / random 型链步一次未覆盖**；normal 一侧只剩「battle 占位时的事件槽盲区」。

**为什么不能靠 `state.chains` 覆盖伪链（写死理由，防后来者重走）**：模板 `chains:` 只有 `chain-creation` 一条（`specs/data/templates/jjk-2006/1.0.0/events.yaml:3881-3899`，13 步全 `onSettle`），而 `trigger.source: "chain"` 的事件有 78 条，其中涩谷 / 死灭回游 / 新宿全是 `nextEventId` 串起来的**伪链**：`advanceChainOnSettle` 对它们走「chainState 未命中 ⇒ 立即 `triggerEventV2(next)`」分支（`turn.ts:571-576`），**不写 chainId、不产生 chainState**。所以 `state.chains` 里查不到它们，链保留判据（L3）**只覆盖「声明了 delay 的真链步」**，伪链的主战场必须靠 **F2 排程顺序**解决。

### 决策 1：准入判据必须是**派生式**，禁止存布尔标记

1. **派生式定义**（纯读、无新状态、无新字段）：

```
slotTakenFor(state, def, chainId):
  L1  normalOnly   : def.kind === "normal" && state.pendingEvents.length > 0
  L2  battle       : state.battle !== null && !state.battle.over
  L3  chainReserve : ∃ c ∈ state.chains:
                       c.status === "active"
                       && state.scheduledEvents.some(i => i.chainId === c.id && i.status === "waiting")
                       && c.id !== chainId            // 自身豁免：链自己的续步不得被自己的保留位挡死
```

2. **明确禁止「置布尔标记 / 存 reservation 字段」**：链步可能 `hold`（条件不满足、窗口内留队）或 `drop`（`missWhen` / `window_expired`），处置在 `evaluateDue`（`scheduler.ts:276-294`）与 drain 循环头（`:330-340`）里。**置位式标记一旦链步掉队就永久占槽 ⇒ 全服池事件永久被挡**（单点故障放大成全局饥饿）。派生式则天然自愈：实例一 `expired` / `cancelled`，谓词自动为假。
3. **L3 只认「有 waiting 链步实例」而不认「链 status === active」**：`ChainStateV2.status` 只有 `active | completed`（`packages/shared/src/v2.ts:240-246`，**没有 paused / cancelled**）。因此「已结束或被取消」= `completed` ⇒ 排除；`active` 却无待发实例 = 要么正被玩家决策（L1 已占位）、要么是断链僵尸 ⇒ **不保留**。这条把 ADR-0026「不处置僵尸链」的已知风险挡在门外，**不得**改用 `evaluateChain() === "active"`（`scheduler.ts:369-383` 的第三分支「还有 steps 没走」会让僵尸链永久占位）。

### 决策 2（F1）：准入三层落地，`pendingEvents` 不再是「槽位」的唯一等价物

守卫位置不变（`turn.ts:465-485`，`recordFire`（`:487`）之前，命中即 `return`、不记火、不进 `triggered`、不写 `history`），只把**条件**从 L1 扩为 `L1 ∨ L2 ∨ L3`。抽成纯函数 `slotTakenFor()` 供 `triggerEventV2` 与测试单点调用。

### 决策 3（F2）：`nextEventId` / `advanceChainOnSettle` 续步必须**先于 drain**

这是修 78 条线性伪链的关键，**独立于 F1**（即使 L2/L3 全开，只要 drain 跑在续步链接之前，日常事件仍会先抢到空槽）。三处结算路径把「续步链接」提到「drain」之前：

| 入口 | 现状次序 | 目标次序 |
|---|---|---|
| 事件结算 | `chooseOptionV2:1074-1078`（effects → drain → chainStarts → `advanceChainOnSettle`） | effects → chainStarts → **续步链接** → drain |
| 战斗结算 | `battleActionV2:1140-1150`（outcome effects → drain → chainStarts → `nextEventId`） | outcome effects → chainStarts → **`nextEventId`** → drain |
| 用物品 | `useItemV2:1223-1226`（effects → drain → chainStarts） | effects → **chainStarts** → drain |

理由：续步事件是**同一叙事序列的下一环**，它与「恰好到期」的延时实例竞争同一个槽时，语义上必须由续步先呈现；否则「先到先得」会把主线切碎。此改动**不新增调度结构**（复用既有 `drainDue` 接线点，只调整调用次序）。

### 决策 4（F4）：守卫分支必须去重，否则实例膨胀

`drainScheduledEvents` 单 pass 遍历**排序快照**（`scheduler.ts:317`），本 pass 内新入队的实例不在快照里、`start > now` 即 `break`（`:321`）⇒ **同 pass 不会自旋**。但 `drainDue`（`turn.ts:302-325`）允许 `MAX_DRAIN_PASSES = 8`（`:295`）：守卫命中路径**不置** `result.drainRequested`，正常单 pass 收敛；**一旦同轮别的触发（random 段效果推进时间 / `enqueueEvent`）置了 `drainRequested`**，下一 pass 会再次撞上「`start = now` 恒到期」的被挡实例 ⇒ **同一次 `drainDue` 内最多堆 8 个同事件实例**，而 `scheduledEvents` 只增不删（无 GC，见 BACKLOG）。裁定：守卫分支在 `enqueueScheduled` 之前**按 `(definitionId, chainId)` 去重**（已存在 `status === "waiting"` 的同事件实例则直接 `return`），把「每次重试都新建实例」压成「一个实例反复重判」。

### 决策 5（F5）：random 纳入 L2 / L3，**不纳入 L1**

| kind | L1 `pendingEvents` | L2 `battle` | L3 `chainReserve` |
|---|---|---|---|
| normal | 挡 | **挡（新增，本轮真凶修复）** | 挡 |
| random（转盘） | **不挡** | **挡（新增）** | 挡 |
| combat | **本轮不挡**（见决策 7 边界） | 挡（既有 `turn.ts:453`） | 挡 |

- random **不进 L1**：转盘与事件卡片本就并存（前端 `wheel > event` 只是视觉优先），若被 `pendingEvents` 挡，会被日常事件长期压死。
- random 延后**语义安全**：守卫位于 `recordFire`（`turn.ts:487`）之前，命中即 `return` ⇒ 不记火、不选 segment、不 `applyEffectsV2`、不写 `lastWheel(s)`；重放到期时在**那一轮**才结算并写 `lastWheel(s)`。代价：转盘呈现晚一轮（`D-03` 当轮语义仍自洽），**不会重复结算**。

### 决策 6（诊断位）：`TriggerResult.slotDeferred`

新增**非持久化**诊断位 `slotDeferred?: { eventId: string; by: "pending" | "battle" | "chainReserve" }[]`，口径与既有 `skipped` / `droppedPending` 相同（引擎内部 `TriggerResult`，**不进 `WorldStateV2` / 不进投影 / 不进 API / 不进存档**）。理由：没有它，线上只能靠历史差分反推「这轮为什么没出卡」（同 BACKLOG B-14 的教训）。

### 决策 7：边界 —— 本轮不做

| 不做 | 理由 |
|---|---|
| **combat 被 `pendingEvents` 挡**（反向对称洞：战斗在事件卡占槽时仍可开打，同样会遮住卡片） | 与 L2 同构但方向相反，**无观察到的事例**（线上 2 次 A 全为「normal 在战斗期间抢槽」）；扩大改动面会动既有战斗用例 ⇒ 记 BACKLOG，另案 |
| 改 `pendingEventPriority`（`turn.ts:332-342`）或把 admission 改成「按优先级择优」 | 单槽下优先级**实际已失效**（被延后事件重新入队拿新 `enqueueSeq`，admission 只看 `(start, hasEnd, end, enqueueSeq)`，`scheduler.ts:71-82`，从不读 priority）；修它会改主轮 RNG 顺序 ⇒ 记 BACKLOG |
| 改 `opening.handoff` 直写 `pendingEvents`（`opening.ts:239-241` 绕过守卫） | 开局一次性注入，`#34` 已有其门禁 ⇒ 记 BACKLOG |
| `scheduledEvents` 的 GC / 归档裁剪 | 与本条正交；当前只影响存档体积 ⇒ 记 BACKLOG |
| 扩 `MissReason` / 给实例加「允许失效」位 / 升 `schemaVersion` | 违反 ADR-0024 决策 8、ADR-0026 决策 5「不扩协议面」 |

### 决策 8：实施顺序（依赖方向不可反）

1. **F1**（`slotTakenFor` 三层，`turn.ts:465-485`）—— 先有准入，后面才有意义。
2. **F2**（三处结算路径的续步优先，`turn.ts:1074-1078` / `:1140-1150` / `:1223-1226`）—— 独立于 F1，可并行落；修伪链主战场。
3. **F4**（守卫去重）+ **F5**（random 纳入 L2/L3）—— 依赖 F1 的函数形态。
4. **决策 6 诊断位** —— 与测试同步落，否则回归只能靠差分反推。

### 被否决的备选

- **在 `WorldStateV2` 加 `slotReservation?: { chainId, until }` 并置位**：直接违反决策 1 第 2 条（链步 `hold`/`drop` 后标记无法回收 ⇒ 永久饥饿）；且新增持久化字段 = 改存档结构（T-2 协议变更），旧档兼容要靠可选字段补丁，收益不成比例。**否决**。
- **用 `state.chains` / `evaluateChain()` 做唯一判据**：对伪链覆盖 0 例（问题节已写死理由）；`evaluateChain` 第三分支还会让僵尸链永久占位。**否决**。
- **退役 `pendingEvents`，全部改走 `scheduledEvents` 单队列**：破坏投影契约（`snapshot.pendingEvent`）与 `pending_event_required` 语义，且要升 `schemaVersion` 拒载旧档。**否决**（与 ADR-0026「被否决的备选」同口径）。
- **把「章节门 `time >=` 滞后」也当引擎缺陷修（例如让 drain 主动推进世界时间到下一个门）**：引擎替模板做时间决策＝把游戏规则塞进通用内核，违反 `AGENTS.md` §5「不得把世界观专属规则硬编码进通用引擎」。**否决**（见「不予修复 / 另案」）。

### 影响面与文件归属

| 改动点 | 归属 | 依据 | 写冲突 |
|---|---|---|---|
| F1 `slotTakenFor` + 守卫条件扩围 | `packages/game-core/src/v2/turn.ts:465-485` | 准入判定在 `triggerEventV2`（槽位语义归属层） | `turn.ts` 是热点，须与其它改轮次管线的任务串行 |
| F2 续步优先 | `turn.ts:1074-1078`、`:1140-1150`、`:1223-1226` | 结算路径次序 | 同上 |
| F4 去重 / F5 random 纳入 / 诊断位 | `turn.ts:465-485`、`:263-286`（`TriggerResult`） | 同上 | 同上 |
| 测试 | `packages/game-core/src/v2.test.ts`、`lifecycle-switch.test.ts`、`playthrough.test.ts` | 见「验证要点」 | 低 |
| `packages/shared` / 投影 / 前端 / 存档 | **零改动** | 决策 7 边界 | 无 |

### 不变量检查表

| 不变量 | 现状 | 本决策影响 | 保护措施 |
|---|---|---|---|
| 同 seed 同输入同结果 | 成立 | **F2 改变 drain 与续步链接的相对次序 ⇒ 条件 `random` 的 RNG 消耗顺序变化** | 变化一次性、可复现；按 ADR-0026 决策 6 口径属「预期非回归」；结构性断言（章节 ≥8、`chapterFires` 不重复、`pendingEvents ≤1`）必须仍绿 |
| hidden 不进入玩家端 API | 成立 | 无影响 | `slotDeferred` 只进引擎内部 `TriggerResult`，不进投影 |
| 世界观规则只进模板 | 成立 | 强化：引擎仅判 `kind` / `battle` / `chainId`，**不读模板语义**，不按章节/角色分支 | 决策 1 谓词不含任何模板专有名词；时间锚错位留模板侧（T-1） |
| 时间/随机/ID 可注入 | 成立 | 准入是纯读判定，不新增 `Date` / `Math.random` / 新 ID 源 | 谓词无副作用；F2 只调整调用次序 |
| R3 穿越 seam 未被封死 | 三个预留点未硬化 | 中性偏好：链保留判据读实例 `status` 而非时间单调假设（`window.start` 只用于 drain 排序） | 不得把「链步已到期」写死成「时间只会向前」 |
| `pendingEvents` 单槽（≤1） | 成立（ADR-0026） | **不变**（本条是扩围，不是撤销） | L1 原样保留 |
| `pending_event_required` 守卫 | 成立（`turn.ts:893`） | 不变 | 不动 |

### 验证要点

1. **战斗期间不吸纳 normal**：尾管线在战斗进行中触发 normal ⇒ 断言 `pendingEvents` 仍为空、该事件进 `scheduledEvents` 且 `slotDeferred[].by === "battle"`。
2. **战斗结束后续步先于日常**：combat 结算 + 同轮另有 due 的 pool 实例 ⇒ 断言 `pendingEvents[0].eventId` 是 `nextEventId` 续步，日常实例仍 `waiting`。
3. **链延时步保留槽位**：构造 `ChainStep.delay` 的真链，续步入队后触发 pool 事件 ⇒ 断言被挡（`by === "chainReserve"`）；链步 `expired`/`drop` 后**自动解除**（不置位、不自愈失败）。
4. **自身豁免**：链自己的续步 arrival 不被自己的保留位挡死（无 `chainId` 匹配时不进 L3）。
5. **F4 去重**：一次 `drainDue` 内 `pass > 1` 的场景（random 段效果推进时间）⇒ 断言同 `(definitionId, chainId)` 的 waiting 实例 ≤ 1。
6. **random 延后不重复结算**：被挡的 random 在重放的那一轮只写一次 `lastWheel(s)`、只 `recordFire` 一次。
7. **必跑回归**：`v2.test.ts:725-800`（单槽 ≤1 + 串行化回放；**实例计数断言会因 F4 去重需改写**）、`lifecycle-switch.test.ts:480-497`（守卫延后 + 经链回归）、`playthrough.test.ts:133-155`（6 种子 × 2 开局结构性断言）、`scheduler.test.ts:308-433`（队列长度）、`combat-refs.test.ts:227-228`（`pendingEvents === []`）、`r25-acceptance.test.ts:71+`（T1-07 结算占槽）。
8. **回归预期幅度**：F2 挪动次序 ⇒ 逐事件时序与个别种子 `day` 值会变（`day ≈ 4736–4756` 基线须重录）；**允许变化的只有逐事件时序细节**，章节数 / `chapterFires` 唯一性 / 五维区间必须不动。

### 不予修复 / 另案（两类证据被重新定性）

| 现象 | 定性 | 归属 |
|---|---|---|
| `t297 ev-sh-05 → d3-megumi → t304 ev-ch6-gate` | **不是链中断**：`ev-sh-05` 是涩谷弧收束（无 `nextEventId`），三选项均 `advanceTo day 4694`（`events.yaml:3110/3124/3140`）< 第六章门 `time >= 4700`（`:3162`）⇒ **结构性 6 天空窗**，期间日常事件是正确的 | **模板时间锚错位**，T-1（免 ADR，`AGENTS.md` §0.3）。修法：`advanceTo` 对齐门的 `time >=`，或把门改成「flag + priority」立即门。**需用户裁决**；改动会使模板语义指纹变化 ⇒ **全部旧档拒载**（ADR-0007 / ADR-0029 既定策略） |
| `t311 ev-cg-04 → d3-nobara → t320 ev-ch7-gate` | 同构：`cg-04 advanceTo 4728`（`:3442`）< 第七章门 `time >= 4736`（`:3464`）⇒ 8 天空窗 | 同上 |

**不要在引擎里兜这件事**（见「被否决的备选」最后一条）：空窗是模板作者的时间编排选择，引擎强行补齐＝把游戏规则写进内核。

### 遗留登记（同步 `docs/BACKLOG.md`）

combat 被 `pendingEvents` 挡（对称洞）/ `pendingEventPriority` 在单槽下实际失效（admission 不读优先级）/ `opening.handoff` 绕过守卫 / `scheduledEvents` 无 GC。

### 回指注记（append-only，已落地）

原 ADR 正文一律未删未改，只在两处末尾追加了修订注记：

| 位置 | 注记内容摘要 |
|---|---|
| ADR-0011 决策 5 末尾（本文件 `:358`，紧接 ADR-0026 的注记之后） | 「槽位唯一」的语义边界被扩围为四方共用位；ADR-0026 的单槽 ≤1 不撤销，只对应 `event` 一类；准入判据改由 `slotTakenFor()` 派生 |
| ADR-0026 末尾（本文件 `:2118`） | 决策 1/2 的单槽定义、决策 3 的「combat / random 不受影响」被证伪为盲区；附量化基线（normal 6→0、combat 2 次未覆盖）；本 ADR 决策 5 的「可整块删除回退」性质保留，但删除后的行为不再视为正确行为 |

> **〔被 ADR-0031 补充，2026-11-13〕** 准入谓词在 L1/L2/L3 之前**新增 L0 层**：`(state.pendingWheels?.length ?? 0) > 0`（未结算转盘），**对所有 kind 生效**（normal / random / combat 一律被挡）；自身豁免同样成立——结算入口在移除 `pendingWheels` 项**之后**才执行效果，故轮盘触发的事件不会被「自己」挡住。依据与前端 `SlotOccupant` 优先级完全一致（`apps/web/src/main.tsx:1308-1315`：`wheel > battle > event > action`）。**本 ADR 决策 5 的两句话须按此收窄**：`normal / random / combat × L1(pendingEvents)` 的组合表不变，但「combat / random 不受守卫影响」仅对 **L1** 成立，对 **L0** 不成立。槽位层级完整顺序：**L0 wheel → L1 pending → L2 battle → L3 chainReserve**。

> **〔其术语与分层被 ADR-0032 取代，2026-11-13〕** 本 ADR 已先被用户打回（见状态行下的注记），现进一步明确：**其术语（「呈现槽」的用法）与分层（L1/L2/L3、`slotTakenFor`）不再作为团队口径**，一律以 ADR-0032 §1（术语表）与 §3（不变量两栏）为准。本 ADR 可复用的部分只剩事实与证据：**「问题」节的四类占位者结构性事实、量化基线（normal 链中断 6→0 / combat 2 次）、以及 `state.chains` 无法覆盖伪链的论证**——后者是 ADR-0032 §5 Q3 的输入。任何重新设计都必须先引用 ADR-0032，不得直接复活 L 分层。

> **〔被 ADR-0034 取代，2026-11-13〕** 本 ADR 的全部决策（L0–L3 分层准入、`slotTakenFor`、F1–F5、`slotDeferred` 诊断位）**作废**：`slot` 成为标量状态字段后，"谁可以占位"不再是一个判定问题，而由"两个写入口"结构保证（ADR-0034 §4 S4）。本 ADR 可复用的只有「问题」节的四类占位者观察与量化基线。

## ADR-0031 随机事件延迟结算：决定与落账分离

> **本条覆盖**：把 `kind: "random"`（转盘）的「**选扇区**」与「**应用效果**」拆成两个时点——选扇区仍在触发当轮完成（RNG 位置不变），效果改由玩家**点击**触发的独立入口落账。属 **T-2 协议/契约变更**（新增 `WorldStateV2` 字段、新增投影字段、新增 API 与两个封闭错误码、改 `lastWheels` 语义）⇒ 必须先 ADR（`AGENTS.md` §0.3）。
> **本条与 ADR-0030 正交但相邻**：ADR-0030 管「谁可以占呈现槽」，本条管「转盘占着槽时要等玩家点」。两者的接缝由本文**决策 5** 定义为 ADR-0030 准入谓词的新增 L0 层。

- **状态**：**已接受（2026-11-13，待用户批准实施）**。
  > **〔状态变更 2026-11-13：已被打回，待重审〕** 与 ADR-0030 同因被打回（用户：「把槽 事件队列 行动 轮次 梳理清楚再设计」）。**本 ADR 正文保留不改**，但其**全部决策（含 `pendingWheels` / `wheelSeqCounter` 字段、`settleWheelV2` 入口、`/wheels/settle` 路由、`pending_wheel_required` 门禁、L0 层、`lastWheels` 顺序改「结算顺序」）在本轮一律不得据以派实施**——它依赖的「呈现槽」概念本身就在被打回的范围内（例如 `pendingWheels` 是否该独立成一层，取决于槽模型重审结论）。重审时「效果落账早于演出」这一事实与 `engine.ts` 效果零 RNG 的核实结论仍有效。
- **起草人**：系统架构师（高见远）。
- **用户原话**：「现在随机事件后端直接结算了，前端看起来就是转盘还在转，但是状态、事件已经打上了……会降低期待感。把随机事件的结算时机改成前端点击，后端只返回结果，前端点击才结算。」
- **关联**：ADR-0030（呈现槽准入，本文补 L0 层）、ADR-0017 决策 4（`lastWheels` / D-03 / D-16 的既定语义，**被本文修订顺序口径**）、ADR-0007（存档信封与 `schemaVersion` 口径）、ADR-0024 决策 8（独立派生流的盐约定）、ADR-0029（模板热加载的快照隔离，本文「定义缺失」兜底的不可达性依据）。

### 现状核实（以代码为准）

| 事项 | 事实 | 证据 |
|---|---|---|
| 选扇区 | `pickIndex(weights, rng)` —— 按 `weight` + `weightBy` 现算权重后**吃 1 次 RNG** | `turn.ts:502-512`、`:539-548` |
| 落账 | 同一处紧接着 `applyEffectsV2(seg.effects)` + `triggerChainStarts` + `advanceChainOnSettle(seg.nextEventId)` | `turn.ts:525-532` |
| 事实与投影写入 | `recordFire` / `pushHistory` **在 kind 分支之前**（对所有 kind 生效）；`lastWheel` / `lastWheels` 在 random 分支内写 | `turn.ts:487-495`、`:523-524` |
| 前端只是表演 | 落点角 = `360*4 + (360 - hit.center)`，由**服务端给的 label** 反算；动画 `transition: transform 2.6s cubic-bezier(.13,.72,.06,1)`；动画结束才出「继续」按钮 | `apps/web/src/main.tsx:1523`、`:1580`、`:1649-1652` |
| 同轮多转盘 | `lastWheels` 承接当轮全部，轮次起点清空（D-03）；前端 `wheel-rest` 列表**直接把其它转盘的 `label` 也显示出来** | `turn.ts:521-524`、`main.tsx:1770-1782` |
| 效果是否吃 RNG | **不吃**：`engine.ts` 全部效果分支零 `rng()` 调用，唯一 `rng()` 在条件 DSL 的 `random` 条件（`engine.ts:258`） | `grep rng()` |

⇒ 缺陷确认：玩家看到指针还在转的时候，属性 / 道具 / flag / 历史已经全部落账，且刷新即可见结果；「继续」只是个装饰按钮。

### 决策 1：切分点 —— 选扇区留原处，落账搬到点击

1. **`pickIndex` 必须留在触发当轮**（`turn.ts:511` 不动）。理由：前端要用「命中扇区」算落点角（`main.tsx:1523`），没有结果就没有动画；且 RNG 消耗位置一旦挪动，同 seed 的后续序列全部漂移。
2. **搬到结算时执行的清单**：`applyEffectsV2(seg.effects)`（`:526`）、`triggerChainStarts(segCtx.startedChains)`（`:530`）、`advanceChainOnSettle(event, seg.nextEventId)`（`:531`）、`result.drainRequested` 的置位与随后的 `drainDue`（`:529`）。
3. **不搬的清单**：`recordFire`（`:487`）、`pushHistory`（事件叙述，`:489-495`）、`pickIndex`、`lastWheel/lastWheels` 的**写入位置**（写入动作搬，见决策 2）。理由：`once` / 冷却 / 事实日志的时点保持「事件发生的那一轮」，与 ADR-0026 决策 2「只在真正发生时记一次火」同口径；轮盘事件确实在那一轮发生了，只是「结果的影响」延后落地。
4. **确定性不变量（本文最重要的一条）**：`pickIndex` 的调用次数与位置不变 ⇒ **命中扇区与今天逐 seed 完全一致**；当前模板的全部 wheel 扇区 `effects` 零 RNG（上表已核实），故**落账搬走不改任何随机序列**。唯一变化是「效果生效的世界时刻」从触发轮变成结算轮。
5. **结算侧的 RNG 必须用固化派生流**：结算时执行 `triggerChainStarts` / `advanceChainOnSettle` 会再次进入 `triggerEventV2`，其后代事件的条件 DSL 里若有 `random` 条件就会吃 RNG。裁定：结算 rng = `createRng(deriveTurnSeed(state.seed + 53, whl.seq))`：
   - 盐 **53** 取自既有约定 `{0, +7, +13, +29, +37}` 之外（ADR-0024 决策 8 先例），不污染主轮 / 选项 / 战斗 / 物品 / 复核流；
   - 键取 `seq`（全局单调触发序号）而非 `turnIndex` ⇒ **结算结果与「玩家什么时候点、隔几轮点、刷新几次再点」无关**，这是延迟结算能保住确定性的关键；
   - 预期漂移：凡「random 事件的效果带 `startChain` 或扇区带 `nextEventId`」者，其下游触发改用该独立流 ⇒ 逐事件时序可能变化（一次性、可复现），按 ADR-0026 决策 6 口径属**预期非回归**。

### 决策 2：待结算状态的持久化

1. **新增实例层（与 `pendingEvents` / `scheduledEvents` 同级，不是事实层）**：

```ts
export interface PendingWheel {
  wheelId: string;          // `whl-<seq>`；客户端唯一句柄，不透明，前端不得解析
  seq: number;              // 全局单调触发序号：排序 + 结算 RNG 派生键
  eventId: string;
  title: string;            // 同 D-16 理由：刷新/重连不依赖本次响应上下文
  segments: Array<{ label: string; weight: number }>;  // 供动画，与 WheelResultView 同形
  segmentIndex: number;     // 已决定的命中扇区（RNG 已在触发轮消费，此处只固化结果）
  label: string;            // 冗余但必要：定义被改/丢时的兜底显示
  turnIndex: number;        // 触发轮：诊断 + 兜底排序，不参与 RNG 派生
}
```
`WorldStateV2.pendingWheels?: PendingWheel[]` + `WorldStateV2.wheelSeqCounter?: number`（与 `enqueueSeqCounter` 同族的纯状态计数器，不消耗 RNG）。

2. **`schemaVersion` 不升（结论）**：两个字段均为**可选 + 读侧 `?? []` / `?? 0`**，与 `lastWheels`（ADR-0017 决策 4）、`history.visibility`、`spawnRules`（ADR-0022）完全同策略。旧档缺该字段的语义是**精确的**——旧档的 random 全部是即时结算的，不存在待结算项，补 `[]` 即等价。**不复制 ADR-0007 的「格式不兼容才递增」**：这里格式兼容。→ 需用户确认（见文末裁决点，理由：这是唯一会让 `data/worlds/` 下存量档命运分歧的一条）。
3. **与 `lastWheel` / `lastWheels` 的关系（裁定：并存，且语义收窄）**：
   - `pendingWheels` = **未结算**（含已决定但未落账的扇区）；
   - `lastWheel` / `lastWheels` = **已结算**（玩家已经看过、效果已经落账），继续承担 D-09 刷新回放 / D-16 标题持久化 / D-03 同轮多条；
   - 触发时**不再**写 `lastWheel(s)`（今天在 `turn.ts:523-524` 写），改由结算入口追加。
   - **自洽性论证**：`advanceTurnV2` 在轮次起点清空 `lastWheels`（`:896`），而结算必然发生在下一轮推进**之前**（决策 3 的 `pending_wheel_required` 保证）⇒ 追加时机永远早于清空时机，不存在「结算结果被下一轮清掉」的窗口。

### 决策 3：结算入口、幂等与阻断范围

1. **引擎入口（唯一）**：`settleWheelV2(state, { wheelId }, template, lookup, pipeline?) → V2TurnResult`。**引擎内不存在任何自动结算路径**——这是硬约束，测试须断言（见验证要点 6）。
2. **HTTP**：`POST /api/worlds/:id/wheels/settle`，body `{ wheelId: string }`（Zod strict）。返回与 `events/choose` 同形：`{ worldId, snapshot, triggeredEvents, wheelResult, eventFlavors }`，其中 `wheelResult` 是**本次结算的**那一枚（供前端点亮命中扇区）。**返回完整快照**而非增量：与既有四个写入口一致，前端不需要自己合并。
3. **幂等语义（裁定）**：结算的落账点是 `pendingWheels` 的**移除**，因此「同一 `wheelId` 只会被应用一次」。重复提交（连点 / 网络重试 / 多标签）第二次必得 `409 wheel_not_pending`，**不会重复应用效果**——这是天然的、不依赖任何去重表的幂等。前端收到 409 的正确反应是「重取快照」而非报错。
4. **阻断范围**：未结算转盘存在时，以下写操作一律被引擎拒绝（抛 `pending_wheel_required`，服务端映射 409）：`advanceTurnV2`（自由行动）、`chooseOptionV2`、`battleActionV2`、`useItemV2`、`equipV2` / `unequipV2`。
   - **为什么连 `battle` 也挡**：前端占位优先级是 `wheel > battle`（`main.tsx:1308-1315`）⇒ 轮盘未结算时战斗 UI 本就不可达；不挡会让「世界里已有一个未落账的效果」与「玩家正在做战斗决策」并存，破坏因果一致性。
   - **不挡**：`settleWheelV2` 本身、`archive`（终局是逃生口，见决策 4）、全部 `GET`（`/history`、`/api/worlds`、records）。
   - 位置：与 `pending_event_required`（`turn.ts:893`）同一处门禁区、同一风格（引擎抛错 + `handleEngineError` 映射），不放服务端各自判断。

### 决策 4：玩家永不点击怎么办（裁定：**永不自动结算**）

1. **不自动结算**。「下一轮推进时自动落账」会把用户要的「点击才结算」退化成「延迟一拍的自动结算」，期待感归零；且需要「上一轮有未结算转盘」的隐式状态机，比持久化 `pendingWheels` 更脏。
2. **持久化即答案**：关页面 / 刷新 / 换设备（同档）后，`pendingWheels` 仍在存档里 ⇒ 重新进入看到同一个未结算转盘、停在同一个命中扇区（`segmentIndex` 已固化，不需重转），点掉才继续。**这正是用户要的体验**。
3. **逃生口只有一个：`archive`（结束这一生）**。除此之外没有任何「跳过 / 放弃 / 超时」通道——不引入基于真实时钟的超时（`Date.now` 不可注入，违反 `AGENTS.md` §2）。
4. **两端必须配合的文案约束**：转盘区在未结算时不得出现「继续」以外的推进出口；自由行动区必须显示「先把命运之轮点掉」而非静默禁用。→ 需用户确认是否接受「不点就完全不能继续」（见文末裁决点）。

### 决策 5：与 ADR-0030 槽模型的交互 —— 未结算转盘**占槽**，且是最优先的 L0 层

ADR-0030 的准入谓词（`slotTakenFor`）由 L1 `pendingEvents` / L2 `battle` / L3 `chainReserve` 三层构成，**不含未结算转盘**。本文补一层：

```
L0 wheel : (state.pendingWheels?.length ?? 0) > 0     // 对所有 kind 生效（含 normal / random / combat）
```
- 依据与前端完全一致：`SlotOccupant` 的优先级就是 `wheel > battle > event > action`（`main.tsx:1308-1315`）；引擎不按同一优先级占位，就必然出现「轮盘还没点，先弹一张事件卡/开一场战斗」。**compat 说明**：`turn.ts:470` 的注释「combat / random 走各自分支、不经 pendingEvents，不受本守卫影响」在本文之后只对 L1 成立，对 L0 不成立。
- 自身豁免同样适用：结算入口内部触发的事件不得被「自己」挡住（结算在移除 `pendingWheels` 项**之后**再执行效果，天然满足）。

### 决策 6：投影契约 —— 只下发「落在哪一格」，不下发「这一格做了什么」

1. **新增** `V2Snapshot.pendingWheels: PendingWheelView[]`（缺省 `[]`）：
```ts
export interface PendingWheelView {
  wheelId: string;
  eventId: string;
  title: string;
  segments: Array<{ label: string; weight: number }>;
  label: string;            // 命中扇区：必须下发，否则前端无法算落点
}
```
2. **必须下发的理由**：`label` 是演出所需（`main.tsx:1523` 由 `hit.center` 反算角度），它**不是**「剧透」——指针最终停在哪一格本来就是这次转盘的公开结果。真正要藏的是「这一格干了什么」。
3. **不得下发**：扇区 `effects`（任何形态）、结算后的属性/物品/flag/关系数值、`PendingWheel.segmentIndex` 与 `seq`（内部实现细节，暴露无益）。**现状 `WheelResultView` 也没有 `effects` 字段**（`shared/v2.ts:338-355`）⇒ 本条是「维持不扩散」，不是新增约束。
4. 结算之后，效果通过既有三条路呈现：`history`（`log` 效果写的公开条目）、`triggeredEvents`（续步事件）、`snapshot`（数值已变）。

### 决策 7：多转盘同轮 —— **逐个点击结算，一次一枚**

1. 一次请求只结算 body 指定的那一个 `wheelId`；其余留在 `pendingWheels` 里，前端按 `seq` 升序（= 触发顺序）**逐枚**呈现与结算。
2. **不做「一键全部结算」**：与决策 4 的期待感取向冲突（用户要的是「每转一次都点一下」）。
3. **`lastWheels` 的顺序语义随之修订**：由「当轮触发顺序」改为「**结算顺序**（= 玩家点击顺序）」。理由：玩家实际体验的顺序由点击决定，且点击顺序属于命令流，天然可复现。D-03 关心的「多条不再互相覆盖」不受影响；触发顺序仍可从 `seq` 追溯（不进投影）。

### 决策 8：失败路径与错误码

| 场景 | HTTP | `error` | 前端文案要点 |
|---|---|---|---|
| world 不存在 | 404 | `world_not_found` | 回列表 |
| world 存在但不可载（指纹/版本） | 409 | `world_unloadable`（既有） | 沿用既有 R-TG-10 文案 |
| body 缺 / 非法 `wheelId` | 400 | `invalid_body`（既有） | 不该出现；属前端 bug |
| `wheelId` 不在该 world 的 `pendingWheels` | **409** | **`wheel_not_pending`** | 「这一转已经结算过了」+ 自动重取快照 |
| 未结算时提交其它写操作 | **409** | **`pending_wheel_required`** | 「先把命运之轮点掉」+ 高亮轮盘区 |
| 已终止 / 已归档 | 409 | `terminated` / `archived`（既有） | 沿用既有 |
| 事件定义或扇区下标解析失败 | —— | **不外抛** | 理论上不可达（ADR-0029 的世界自持模板快照 + 内容漂移 ⇒ 重启后 `template_content_drift` 拒载）；仍兜底为「移除该项 + 写一条公开 `history`」以免永久锁死 |

- 「不存在 / 已结算 / 属于别的世界」**必须合并为同一个码** `wheel_not_pending`：细分等于向客户端确认「这个 id 在别处存在」，是无必要的跨世界信息泄露。
- 两个新码必须加进 `apps/server/src/index.ts:744-752` 的 `interactionErrors` 集合（409 语义，不是 400）。

### 决策 9：唯一入口原则与自动通关/回放脚本的强制改造

1. **引擎内不存在自动结算**（决策 3.1）；因此**所有**驱动脚本必须显式点掉转盘：
   - `playthrough.test.ts`（6 种子 × 2 开局）：主循环需在 `pendingEvents` 分支**之前**处理 `state.pendingWheels`，调用 `settleWheelV2({ wheelId: pendingWheels[0].wheelId })`；否则 `advanceTurnV2` 会抛 `pending_wheel_required` ⇒ **整关卡死**。这是本条最需要提前告知实施方的约束。
   - `replay.ts`（`advanceTurnV2` 单指令循环，`:46-48`）同理；`ReplaySpec.commands` 需能表达「结算某一枚」（或回放内部直接按 `seq` 顺序结算，并在注释里声明「回放不含玩家迟疑」）。
2. 开局侧无需特别处理：`ev-opening-wheel` 是 **normal**（`events.yaml:28-40`，「转动命数转盘」卡片 → `startChain`），创建链里唯一的 random 是 `ev-w12`（`events.yaml:553-580`，扇区级 `nextEventId: ev-w13`）⇒ 玩家点到第 12 步才会遇到第一枚待结算转盘，点掉才推进到 `ev-w13`。语义正确，不加特例。

### 被否决的备选

- **触发时照常落账，只是前端晚 2.6 秒揭示**（纯前端延后渲染）：世界状态已经变了，刷新即剧透，存档/GM 视角同样穿帮；且无法解决「同轮其它转盘的 label 被 `wheel-rest` 提前列出」。**否决**（不解决用户提的问题）。
- **把 `pendingWheels` 做成事实日志（append-only，加状态位）**：读侧要每次过滤，且 `pendingEvents` / `scheduledEvents` 的既有形态都是「实例层 + status」，无 status 的 append-only 表会引入第二套生命周期。**否决**。
- **用 `scheduledEvents` 承载待结算转盘**（`start = +∞` 之类）：转盘不是时间触发的，塞进时间队列会污染排序键与 `evaluateChain` 的 waiting 判定，还会让它被 drain 自动消费——**恰好违反决策 4「永不自动结算」**。**否决**。
- **`schemaVersion` 升 3 并拒载旧档**：为两个可选字段付「`data/worlds/` 存量全灭」的代价，与 ADR-0017 决策 4、ADR-0022 的既定选择相反。**否决**。
- **结算时直接用主轮 rng / `turnIndex+1` 派生**：结算发生时 `turnIndex` 已变，同一次点击在「隔一轮点」与「当场点」下会得到不同结果 ⇒ 引入「取决于玩家手速」的非确定性。**否决**（改用 `seq` 键 + `+53` 盐）。
- **提供「一键结算全部」或超时自动结算**：与用户明确的期待感取向冲突。**否决**。

### 影响面与文件归属

| 改动点 | 归属 | 依据 | 写冲突 |
|---|---|---|---|
| `PendingWheel` / `PendingWheelView` / `WorldStateV2.pendingWheels` / `wheelSeqCounter` / `V2Snapshot.pendingWheels` | `packages/shared/src/{v2.ts,v2-state.ts}` | 协议面（schema 可选字段 + 读侧缺省） | 与任何改 `shared` 的任务串行 |
| random 分支切分 + `settleWheelV2` + `pending_wheel_required` 门禁 | `packages/game-core/src/v2/turn.ts:501-533`、门禁区 `:890-900` | 引擎唯一入口 | **与 ADR-0030 的 `turn.ts` 实施强冲突**（同一函数、同一门禁区）⇒ 必须排在 ADR-0030 之后或与之同批串行 |
| 新增路由 + `interactionErrors` 两个码 | `apps/server/src/index.ts`（新 `POST /wheels/settle` + `:744-752`） | 服务端编排 | 低 |
| 前端四处 | `apps/web/src/main.tsx`（见下） | 展示层 | 低 |

**前端影响面（ADR 不管视觉参数，但必须改的四处）**：
1. **落点演出**：`WheelItem`（`main.tsx:1545-1652`）的 `transition: transform 2.6s cubic-bezier(.13,.72,.06,1)` 要改成「越转越慢、缓慢落针」——推荐 CSS `@keyframes`（先快后慢再极慢收尾）或分段 transition，时长 ≥3s；`prefers-reduced-motion` 分支保持「直接停位」。
2. **标签折行与截断**：SVG `<text>{s.label}`（`:1592-1607`）需改为 `<tspan>` 多行（或 `foreignObject`），每行上限 **20 字**（暂定，建议提为常量 `WHEEL_LABEL_MAX = 20`），超出省略号；`aria-label` 同步。
3. **点击态**：现在「继续」按钮在动画结束后出现并直接推进（`:1649-1652`）；改为**先调 `wheels/settle`**：请求期间禁用按钮（防连点）、失败按决策 8 文案提示、成功后展示效果并进入下一枚或回到正常界面。
4. **`wheel-rest` 列表去剧透**：`main.tsx:1770-1782` 现在把同轮其它转盘的 `item.wheel.label` 直接显示出来；必须改为只显示标题 + 「另有 N 次命运抉择（依次转动）」，`label` 一律不显示。

### 不变量检查表

| 不变量 | 现状 | 本决策影响 | 保护措施 |
|---|---|---|---|
| 同 seed 同输入同结果 | 成立 | 命中扇区**不变**（`pickIndex` 位置不变）；下游触发改走 `+53` 独立流 ⇒ 时序一次性变化 | 结算 rng 以 `seq` 为键 ⇒ 与点击时点无关；断言「同 seed 同点击序列 ⇒ 逐字段相同」 |
| hidden 不进入玩家端 API | 成立 | 新增投影字段只含 `label` / `segments` / `title` | 决策 6 明确禁止下发 `effects` / 结算后数值 / `segmentIndex` / `seq` |
| 世界观规则只进模板 | 成立 | 无影响 | 引擎只做「取扇区 / 执行模板 effects」，不新增任何按模板分支的逻辑 |
| 时间/随机/ID 可注入 | 成立 | 新增 `wheelSeqCounter`（纯状态计数，无随机）；结算 rng 由 `seed + 53` 派生 | 不引入 `Date` / `Math.random`；不做基于真实时钟的超时 |
| R3 穿越 seam 未被封死 | 未硬化 | 中性：`PendingWheel` 固化的是「结果」而非「时间窗口」，时间回拨不会让已决定的扇区失效 | 结算不重掷扇区（`segmentIndex` 只读） |
| 呈现槽唯一（ADR-0030） | 三层准入 | **新增 L0**：未结算转盘对所有 kind 占位 | 决策 5；L0 在 L1/L2/L3 之前求值 |
| `pendingEvents` 单槽（≤1） | 成立 | 不变 | 不触碰 L1 |
| 引擎无自动落地路径 | —— | **新增硬约束** | 验证要点 6 断言「不调 `settleWheelV2` 则效果永不落账」 |

### 验证要点

1. **切分正确**：触发一枚转盘 ⇒ `pendingWheels` 长 1、`pendingWheels[0].label` 等于按 seed 复算的命中扇区、`lastWheels` 仍为空、属性/物品/flag **未变**、`history` 只有事件叙述无效果叙述。
2. **结算落账**：`settleWheelV2` 后 ⇒ 属性按扇区 `effects` 改变、`lastWheels` +1、`pendingWheels` 空、`history` 出现效果条目、扇区 `nextEventId` 的续步被触发。
3. **幂等**：同一 `wheelId` 连点两次 ⇒ 第二次 409 `wheel_not_pending`，且属性**只变一次**（用「属性差值」断言，不要只看错误码）。
4. **阻断**：`pendingWheels` 非空时 `advanceTurnV2` / `chooseOptionV2` / `battleActionV2` / `useItemV2` 全部抛 `pending_wheel_required`；`archive` 与 `GET` 不受影响。
5. **L0 占槽**：`pendingWheels` 非空时触发一个 normal / 一个 pool 事件 ⇒ 均被挡（照 ADR-0030 的 `slotDeferred.by` 断言机制）；`pendingWheels` 清空后它们回到槽位。
6. **无自动结算**：跑 30 轮不调 `settleWheelV2` ⇒ 断言效果始终未落账、`advanceTurnV2` 始终抛 `pending_wheel_required`（这条锁死「不得偷偷自动结算」）。
7. **投影不剧透**：`V2Snapshot` 里 `pendingWheels[0]` 的键集恰为 `{wheelId,eventId,title,segments,label}`；断言不含 `effects` / `segmentIndex` / `seq`。
8. **存档往返**：`persistence.test.ts` 需覆盖 `pendingWheels` / `wheelSeqCounter` 的写读一致；**缺该字段的旧档**加载后 `pendingWheels === []` 且可继续玩（`schemaVersion` 不升的证据）。
9. **多转盘**：同轮两枚 ⇒ 逐个结算，`lastWheels` 顺序等于点击顺序（先点第二枚则它在先）。

### 回归影响清单（必须先告知实施方）

| 受影响 | 影响 | 处置 |
|---|---|---|
| `playthrough.test.ts`（6 种子 × 2 开局） | **不点转盘就抛 `pending_wheel_required`，整关卡死** | 主循环在 `pendingEvents` 分支之前加「有 `pendingWheels` 就先结算」；`day` / 章节基线可能微动，结构性断言必须仍绿 |
| `replay.ts` / `replay.test.ts` | 同上（单指令循环） | 回放内部按 `seq` 顺序结算，并在注释声明「回放不含玩家迟疑」 |
| `v2.test.ts`（15 处 `lastWheels`/`wheelResult` 断言） | 触发后不再写 `lastWheels`；`wheelResult` 改由结算响应给出 | 逐处改写：触发侧断言 `pendingWheels`，结算侧断言 `lastWheels`/`wheelResult` |
| `combat-refs.test.ts` / `lifecycle-switch.test.ts` / `slot-admission.test.ts` | 含 `kind: "random"` 的事件不再即时落账 | 断言前先调 `settleWheelV2`，或改用 normal 事件构造 |
| `persistence.test.ts` | 状态 schema 新增两个可选字段 | 补往返用例 + 旧档缺字段用例 |
| `apps/server/src/index.ts` | 新路由 + `interactionErrors` 两个码 | 补路由级用例（409 语义） |
| 前端 | 四处（见影响面） | 由前端任务承担；`wheel-rest` 去剧透是**必修**，不是优化 |

### 明确不做

- 转盘的视觉参数（动画时长 / 缓动曲线 / 配色 / 尺寸）——不进 ADR，由前端与用户验收决定；本文只给「必须能表达越转越慢 + 20 字截断」的约束。
- 不改 `pendingEvents` / `scheduledEvents` 的任何既有语义（含 ADR-0030 的 L1/L2/L3）。
- 不引入「跳过 / 放弃 / 超时自动结算」中的任何一种。
- 不改 `WheelResultView` 的既有字段（只新增 `PendingWheelView`）。
- 不升 `schemaVersion`、不做旧档迁移脚本。
- 不让 random 事件的 **定义** 进 `pendingEvents`（它仍不进；`pendingWheels` 是独立实例层）。

### 待用户裁决点

1. **`schemaVersion` 是否保持 2**（本文结论：保持，靠可选字段 + 读侧缺省；代价是「新档在旧版本服务端上会被 `strict` 拒」——但那本来就被 `templateFingerprint` 挡着）。
2. **「不点就完全不能继续」是否接受**（本文结论：接受，唯一逃生口是「结束这一生」；若用户要求更强的兜底，需要新开 ADR 定义「放弃转盘」语义与其因果代价）。
3. 以下两条我**已直接定**，如你或用户不同意请回退指示：`battle` 也受 `pending_wheel_required` 约束（决策 3.4）；`lastWheels` 顺序语义改为「结算顺序」（决策 7.3）。

### 回指注记（append-only，已落地）

| 位置 | 注记摘要 |
|---|---|
| ADR-0017 决策 4 末尾 | `lastWheels` / `lastWheel` 的语义收窄为「**已结算**」；新增 `pendingWheels` 承接未结算；`lastWheels` 顺序口径由「触发顺序」改为「结算顺序」；`schemaVersion` 仍不升 |
| ADR-0030 末尾 | 准入谓词增加 **L0 `wheel`** 层（未结算转盘对所有 kind 占位，优先级与前端 `SlotOccupant` 一致）；ADR-0030 决策 5 的「combat / random 不受守卫影响」只对 L1 成立 |
| ADR-0007 决策 3 末尾 | 本条不递增 `schemaVersion`：信封结构未变，`state` 内新增字段均为可选 + 读侧缺省（同 `lastWheels` 先例），与决策 3「格式不兼容变更才递增」不冲突 |

> **〔其术语与分层被 ADR-0032 取代，2026-11-13〕** 本 ADR 与 ADR-0030 同因被用户打回，且**其术语（尤其是把「未结算呈现物」当作准入分层 L0）与全部分层设计被 ADR-0032 取代**，一律以 ADR-0032 §1 术语表与 §4（P1/P3）为准。本 ADR 可复用的部分只剩两条**事实**：①「`random` 的效果落账早于演出、玩家看到指针还在转时属性/道具/flag/历史已变」（`turn.ts:501-533`，`applyEffectsV2` 在 `:526`）；②`engine.ts` 全部效果分支零 `rng()`（唯一 `rng()` 在条件 DSL `engine.ts:258`）——后者是 ADR-0032 §5 Q5 的输入。**`pendingWheels` / `wheelSeqCounter` / `settleWheelV2` / `/wheels/settle` / `pending_wheel_required` 等设计不进入任何口径**，重设计时按 ADR-0032 §5 Q1（呈现槽是否成为一等对象）重新取舍。

> **〔被 ADR-0034 取代，2026-11-13〕** 本 ADR 的全部设计（`pendingWheels` / `wheelSeqCounter` / `settleWheelV2` / `/wheels/settle` / `pending_wheel_required` / L0 层 / `lastWheels` 顺序口径）**作废**：在单槽模型中，转盘不需要独立容器——它就是当前 `slot` 场景的内部过程，"未确认"是 `slot` 的天然状态（ADR-0034 §6）。本 ADR 保留两条**事实**：①`random` 的效果落账早于演出（`turn.ts:501-533`）；②`engine.ts` 效果分支零 `rng()`（唯一 `rng()` 在条件 DSL）。这两条对 ADR-0034 的"槽内结算"仍是有效证据。

## ADR-0032 概念模型：呈现槽 / 待决事件队列 / 待触发队列 / 行动与轮次

> **本条覆盖**：在用户打回 ADR-0030/0031 之后，先把「槽 / 事件队列 / 行动 / 轮次」四个概念的**命名与边界**定死（唯一术语、可判定定义、归属、不变量两栏、三条默认口径、重设计待解问题）。**本条不做机制设计**：不含任何准入算法、字段增删、路由、错误码实现，也不再给「怎么改」的方案。
> **本条是口径文件**：定义冲突时以本条为准；任何据「槽」做机制设计的 ADR，必须先引用本条并说明它落在哪一节。

- **状态**：**已接受（2026-11-13；P1–P3 三条默认口径待用户确认）**。第 4 节三条口径按主理人建议**默认采用**，用户可否决；否决只改口径，不影响第 1–3 节。
- **起草人**：系统架构师（高见远）。依据：本轮三方梳理（架构 / 需求侧 / 内核）+ 全仓只读核对（结论均系于 `文件:行号`）。
- **用户原话（触发本条）**：「打回重新设计 把槽 事件队列 行动 轮次 梳理清楚再设计」。
- **关联**：ADR-0026（单槽守卫，**术语与槽定义被本条收窄**）、ADR-0030（已被打回；**其术语与分层被本条取代**）、ADR-0031（已被打回；**同上**）、ADR-0011 决策 5（轮次/槽位原始口径）、ADR-0024（前提复核，未触及）、ADR-0017 决策 4（`lastWheels`，未触及）。

### 1. 术语表（唯一口径，团队以此为准）

| # | 概念 | 唯一中文名 | 唯一标识符 | 定义（可判定一句话） | 现有名字处置 |
|---|---|---|---|---|---|
| T1 | 呈现位 | **呈现槽** | `PresentationSlot`（引擎与前端**共用一份定义**） | 一次玩家可见交互中「这一格现在演谁」的那个唯一位置；占用者是闭合枚举 `wheel / battle / event / action` | 现状：前端 `apps/web/src/main.tsx:203-204`（类型）+ `:1299-1315`（优先级 `wheel > battle > event > action`）；**引擎侧无对应物**（只有 `pendingEvents`，见 T2）。`SlotOccupant` 由前端迁为共用 |
| T2 | 待决事件 | **待决事件队列** | `pendingEvents`（字段名可不动） | 已触发、正在等玩家做决定的 `normal` 事件载体，按优先级有序 | 语义**收窄**为「`event` 占用者的载体」；**禁止**再用它代表整个呈现槽 |
| T3 | 待触发 | **待触发队列** | `scheduledEvents`（字段名可不动） | 已入队、尚未到期或不满足出队条件的实例集合，全序由 `start→hasEnd→end→enqueueSeq` 决定 | **废弃「延时队列」叫法**（它同时承载定时事件与被其它规则退回的即时事件） |
| T4 | 事件链（声明式） | **声明式链** | `chains[]` / `ChainStateV2` | 模板 `chains:` 段里显式声明、带 `steps[]` 与 `stepIndex` 的线性序列 | 「**链**」一词**仅指此物** |
| T5 | 续步 | **续步链接** | `nextEventId`（保持） | 事件结算时按 `nextEventId` 直接触发的下一环，**不产生链状态** | **禁止**称「链」；模板 `source: chain` 是**标签/来源**，不是机制 |
| T6 | 轮次 | **轮次** | `turnIndex` | 逻辑轮次计数器，唯一自增点在玩家输入被接受后的结算处 | 文档须写明它**不是时间**；现状还兼 RNG 键 / 历史 id 前缀 / 冷却索引（见 §5 Q4） |
| T7 | 本轮呈现集 | **本轮呈现集** | `lastWheels` / `lastWheel` | 本轮已发生并呈现过的转盘结果的集合（单槽别名 = 末项） | 「当轮」一律改称「本轮呈现集」，且必须与 `turnIndex` 的清空点一致（见 §3 I6） |

**两条硬约束**（写进口径，防复辟）：
1. **「呈现槽」是「呈现」概念，不是「互斥」概念**。互斥性（一格只演一件事）是「一个区域只能演一件事」的**推论**，不是它的定义；任何把呈现槽当锁来实现的写法都属误用。
2. **`pendingEvents` ≠ 呈现槽**。它是 `event` 这一类占用者的载体；`battle` / `wheel` / `action` 三类占用者**没有**对应容器，「谁占这一格」目前**靠三类状态外加前端优先级派生**（见 §5 Q1）。

### 2. 四个概念的可判定定义与归属

#### 2.1 呈现槽（`PresentationSlot`）
- **定义**：见 T1。可判定表述：给定 `WorldStateV2` 的一个快照，**存在唯一的 occupant**，取值于 `{wheel, battle, event, action}`；判定次序（当前唯一实现处在前端）：`wheel`（本轮呈现集非空）→ `battle`（`state.battle` 非空且未结束）→ `event`（`pendingEvents` 非空）→ `action`（空槽）。
- **归属**：**跨层概念**，但现状定义不对称——前端 5 行实现了完整优先级（`main.tsx:1299-1315`），引擎只有 `event` 一个分支（`turn.ts:471`）。这是「两套定义」的来源（§3 R5）。
- **生命周期**：随玩家输入切换；**不进存档**（它必须是派生量；存档里只有它的三个来源：`pendingEvents` / `battle` / `lastWheels`）。
- **谁写**：无独立写点（派生）。**谁读**：前端渲染（`main.tsx:1308-1315`）；引擎侧**目前无人读**（这正是问题）。

#### 2.2 待决事件队列（`pendingEvents`）
| 维度 | 内容 |
|---|---|
| 形态 | `PendingEvent[]`，元素 `{ eventId, chainId? }`（`packages/shared/src/v2.ts:202-206`、`:313-314`） |
| 谁写 | `turn.ts:366`（`enqueuePendingEvent` 按优先级插入）/ `:409`（前提复核后留存重建）/ `:1043`（结算 `shift`）/ `opening.ts:241`（开局交接**批量 push**）/ `ending.ts:379`（死亡结局事件 push）/ 初始化 `turn.ts:212` |
| 谁读 | `turn.ts:893`（门禁）/ `:522`（投影队首）/ `scheduler.ts:379`（`evaluateChain`）/ `projection.ts`（`pendingEventView`） |
| 生命周期 | 触发 → 玩家选择 → `shift`。**无过期、无取消、无超时**；长度上限**无结构保证**（见 §3 R1） |
| 进存档 | 是 |
| 明确**不**承担 | 不代表呈现槽整体；不承载 `random` / `combat`；不做延时（延时归 T3） |

#### 2.3 待触发队列（`scheduledEvents`）
| 维度 | 内容 |
|---|---|
| 形态 | `ScheduledEventInstance[]`（`instanceId/definitionId/origin/chainId?/window/enqueuedAt/enqueueSeq/status`），`shared/v2.ts:303` |
| 谁写 | **唯一入队入口** `scheduler.ts:110-131`（`enqueueEvent` / `enqueueCandidate` 都经它）；出队只改 `status`（`:319/325/331/345/356`） |
| 谁读 | `scheduler.ts:317`（`drainScheduledEvents` 排序快照）/ `:378`（`evaluateChain` 判链活性）/ `turn.ts:471`（槽位守卫，仅作旁证） |
| 生命周期 | 只增不删：`waiting → fired / expired / cancelled` 后**永久保留**（无 GC，见 BACKLOG B-30） |
| 进存档 | 是 |
| 明确**不**承担 | 不是「未来的事件队列」的通用表述——它同时装四类语义（定时 / 暂存 / 续步 / 效果入队），见 §5 Q2 |

#### 2.4 行动与轮次
**行动**定义：玩家的外部输入，判据说三件事——**是否推进轮次 / 是否被呈现槽挡 / 是否重置本轮呈现集**。

| 入口 | 推进 `turnIndex` | 被 `pendingEvents` 挡 | 重置本轮呈现集 | 与两个队列的关系 |
|---|---|---|---|---|
| `advanceTurnV2`（自由行动，`turn.ts:882`） | ✅ `:912`（绝对）/ `:917`（相对） | ✅ `:893` | ✅ `:899` | 起手 `triggerChainStarts`+`advanceNextTurnChains`（`:940/941`）→ `drainDue`（`:946`）→ 尾管线 `runTurnTail`（`:968`，内含 NPC 行动 `:841`、pool `:845`、drain `:848`、终止判定 `:850`） |
| `chooseOptionV2`（选项，`:1035`） | ✅ `:1051` | **需要它**（`shift` `:1043`） | ✅ `:1042` | 出队→效果→`drainDue`（`:1075`）→`triggerChainStarts`（`:1077`）→尾管线（`:1081`） |
| `battleActionV2`（战斗命令，`:1108`） | ❌（**仅战斗结束时** ✅ `:1124`） | ✅（`battle_in_progress` `:894`） | 仅结束时 `:1126` | **回合内完全不碰两个队列**；结束时 `drainDue`（`:1141`）+`triggerChainStarts`（`:1143`） |
| `useItemV2`（用物品，`:1191`） | ❌ | ❌（现状） | ❌（`:1209` 注释明写） | 仅 `drainDue`（`:1224`）+`triggerChainStarts`（`:1226`） |
| `equipV2` / `unequipV2`（`equipment-turn.ts:45/71`） | ❌ | ❌ | ❌ | 不接触两个队列 |

**轮次**：`turnIndex += 1` **只有 4 处**——`turn.ts:912`、`:917`（自由行动的两种步长，均**必然推进世界时间** `:913/918`）、`:1051`（事件结算轮）、`:1124`（战斗结束结算轮）。后两处只加 `timeCost`，**缺省 0**（`:1053`）⇒ **结算轮可以推进 `turnIndex` 而世界时间不动**。

### 3. 不变量清单（分两栏，禁止混写）

#### A. 结构保证（类型 / 字段 / 单一入口层面，写错会编译不过或构不出状态）
| # | 表述 | 位置 |
|---|---|---|
| S1 | 待触发队列全序稳定：`start → hasEnd（false 视为 +∞）→ end → enqueueSeq`，且 `enqueueSeq` 全局唯一 | `scheduler.ts:71-82`、`:115-129` |
| S2 | 触发事实只经 `recordFire` 一处写（`firedEvents` / `lastFiredIndex` / `eventFires` 三者一次写齐） | `scheduler.ts:190-196`；唯一调用 `turn.ts:487` |
| S3 | 待触发实例的唯一入队入口是 `enqueueScheduled`（连 `enqueueCandidate` 也经它） | `scheduler.ts:110`、`:171-179` |
| S4 | 引擎无 `Date` / `Math.random`；随机唯一来源 `deriveTurnSeed`（可注入） | `packages/game-core/src/rng.ts:19-24`；`turn.ts:903` |
| S5 | 前提复核只有一处求值函数，且 `missWhen` 先于 `conditions`、每个条件数组恰好求值一次 | `scheduler.ts:249-258` |
| S6 | 隐藏可见性只经 `isPlayerVisible` 单点判定 | `packages/shared/src/v2.ts:270-272` |

#### B. 运行期约定（靠代码路径维持，可被旁路破——**不得**当成结构保证）
| # | 现状表述 | 靠什么维持 | 能怎么破 |
|---|---|---|---|
| R1 | `pendingEvents.length ≤ 1` | 仅 `triggerEventV2` 顶部守卫（`turn.ts:471`，且只管 `normal`） | **`opening.ts:241` 按模板 `handoff.pendingEvents` 批量 push**；**`ending.ts:379` 死亡结局事件追加**。⇒ 该不变量只在「守卫覆盖的触发路径」上成立 |
| R2 | `random` / `combat` 结算后不留在 `pendingEvents` | 各走自己分支（`turn.ts:501-533`、`:534-536`） | 无结构性拦阻：任何新 kind 也能不入队 |
| R3 | 战斗进行中不会再开一场 | `turn.ts:453` 的显式跳过 | 只挡 `combat`；同刻 `pendingEvents` 可非空 |
| R4 | 「本轮呈现集」与轮次对齐 | 三个清空点手写（`:899` / `:1042` / `:1126`），`useItemV2` 刻意不清（`:1209`） | 新增入口忘记清空即漂移（历史上已改过三次口径） |
| R5 | 「一回合只有一个呈现物」 | **前端派生**（`main.tsx:1299-1315`） | 引擎不参与 ⇒ 引擎可造出前端无法同时呈现的状态 |

#### C. 明确**不成立**（写下来防止再被当成前提）
| # | 不成立的命题 | 反例位置 |
|---|---|---|
| N1 | 「同一时刻只有一个呈现占位者」 | 引擎无呈现槽对象；`battle` 进行中 `pendingEvents` 可非空（`turn.ts:453` 只挡 `combat`） |
| N2 | 「`scheduledEvents` 会随终态收缩」 | 只改 `status`，无 GC（`scheduler.ts:330-357`） |
| N3 | 「同 seed 跨代码版本稳定」 | ADR-0026 决策 6 已正式放弃 |
| N4 | 「`source: chain` 的事件都在 `chains[]` 里」 | 模板 78 条 `source: chain`，真链只有 `chain-creation` 一条（`events.yaml:3881-3899`） |

### 4. 三条口径（**默认采用，用户可否决**）

**P1 · 待决期间的旁支操作**
> 当**存在未确认的呈现物**（`pendingEvents` 非空 ∨ 战斗进行中 ∨ 存在未确认的呈现物，含转盘类）时，引擎**拒绝一切会改变世界状态的输入**——包括 `items/use`、`equipment/equip`、`equipment/unequip`、`events/choose`（除确认当前呈现物本身）、`turns`、`battle`；**只放行纯读**（快照 / 历史 / 列表 / records）。
> 与既有「用物品不消耗回合」的裁定**不冲突**：*不消耗回合 ≠ 可以改因果*。旁支写入会让「玩家看到的世界」与「引擎记账的世界」分叉，这正是本轮三个现象的公共根因。
> 错误码：与 `pending_event_required`（`turn.ts:893`）**同族**，不新增语义重复码（三种占用情况分别复用/扩展既有码，见 §5 Q1 的落地位置）。

**P2 · 「主线暂歇」可见标记（投影层）**
> 呈现槽被日常事件占用时，玩家**必须能分辨**这是「插进来的外人」还是「主线真的告一段落」。投影必须同时给出两件事：
> ① **当前呈现物的来源类别**——建议直接用既有的 `EventV2.trigger.source`（`chain` / `pool` / `schedule` / `action-hook`）映射为 `origin`，**零协议新增**（该枚举早已存在，只是没进投影）；
> ② **主线是否处于暂歇**——一个派生布尔（当前无主线呈现物，但主线尚未收束）。
> **红线**：该标记**不得**因派生而暴露玩家从未见过的剧情线存在（例：「还有一条隐藏线在等你」属 hidden 泄露）。只允许表达「你正在看的这一格是什么」与「主线此刻是否暂停」，不得下发任何未公开事件的身份、数量或存在性。

**P3 · 未确认呈现物：硬卡 + 语义逃生**
> 未确认期间：可做**纯读**、可**离开页面**、回来仍是**同一个呈现物与同一个结果**（状态持久化，不重掷）；**不得推进回合**；**不提供「放弃」**——放弃等于「看见坏结果就不认」，直接抵消期待感，且会迫使引擎定义「未落账的因果」。
> **逃生口语义**（三条，都不是「跳过」）：① 离开/刷新（状态不变，回来接着看）；② **结束这一生**（终局语义，与「跳过这一格」不同：它终结整局，不是绕过它）；③ **系统级兜底**（呈现物对应的模板定义缺失/版本漂移时，由引擎判定该呈现物失效并写一条公开历史；**只能由系统触发，玩家不可主动调用**）。

### 5. 据本模型重设计时必须回答的问题（待解问题，不是方案）

| # | 问题 | 两种走向与各自代价 |
|---|---|---|
| Q1 | **呈现槽要不要成为引擎侧一等对象**（一个字段显式表达「这一格现在演谁」），还是继续由三类状态派生？ | ①**一等字段**：引擎与前端共享同一真源，互斥与呈现一致，可写出「槽位被谁占」的断言；代价是新增持久化字段（存档 + 迁移口径）、四类占用者都要维护它、与既有 `pendingEvents`/`battle` 双写风险。②**继续派生**：零协议变更；代价是「两套定义」永久存在（R5）、每条准入规则都要重复实现一次优先级、无法对「槽位唯一」写结构断言 |
| Q2 | **`scheduledEvents` 一队列四语义要不要拆**（定时 / 被退回的暂存 / 续步 / effect 入队）？ | ①**拆**：`evaluateChain` 不再被「暂存」污染，GC 可按语义分别定策；代价是新增队列（违反「不新增调度结构」的历史约束）+ 存档结构变更 + drain 要跑多队列。②**不拆，只加标记**：把「为什么在这条队列里」显式化（`origin` 已是雏形）；代价是语义仍混，但迁移成本近零 |
| Q3 | 「这条剧情线是否进行中」在**只有 1 条真链 + 78 条伪链**的现实下用什么判据？ | ①**只认真链**：判据干净（`chains[]` + 待触发实例），但覆盖 0 例（ADR-0030 已证）。②**把伪链升格为真链**：判据统一，但要把 78 条 `nextEventId` 反解成 `chains:` 声明（模板改造 + 指纹变化 + 旧档拒载）。③**引入「线上标记」**（如续步血缘）：两侧都能表达，但要定义血缘的生命周期与终止条件 |
| Q4 | **`turnIndex` 四种用途要不要拆**（轮次 / RNG 键 / 历史 id 前缀 / 冷却索引）？ | ①**拆**：轮次语义可自由演进（如「结算不推进轮次」），RNG 与历史 id 独立；代价是存档字段增加 + 历史 id 形态变更（旧回放/断言全废）。②**不拆**：零成本；代价是任何轮次语义改动都要连带接受 RNG 与历史 id 漂移（ADR-0031 只能把 rng 钉在 `seq` 上就是这个代价的体现） |
| Q5 | 「**改状态但不推进轮次**」的路径（现状 9 类：`useItemV2`、`equipV2`、`unequipV2`、各入口内 `drainDue`（`:946/1075/1141/1224/848`）、`triggerChainStarts`、`runTurnTail` 的 NPC 自主行动（`:841`）、`revalidatePendingV2` 的丢弃（`:409`）、`applyEndingBoundary` 终止判定（`:850`）、`archive`）哪些应被禁止、哪些应改为推进轮次？ | 按「是否产生新的玩家可见结果」判：产生新呈现物的一律归入呈现槽并纳入轮次语义；只是记账的（如 `archive` 置位）保留在轮次外。代价是每条都要单独裁决，且会牵动 §3 R4 的清空点收敛 |

### 6. 与既有 ADR 的关系（均 append-only 回指，原正文未改）

| ADR | 关系 |
|---|---|
| ADR-0026（单槽守卫转正） | **被本条收窄**：其「槽 = `pendingEvents ≤ 1`」的等式作废；`pendingEvents` 现只是「`event` 占用者的载体」（T2）。守卫本身作为**运行期约定**（§3 R1）保留其既有事实地位，但不再被称作「槽模型」 |
| ADR-0030（呈现槽准入统一） | **已被打回；其术语与分层被本条取代**。L1/L2/L3 与 `slotTakenFor` 不再作为口径；其中「问题」节与量化基线（normal 6→0 / combat 2 次）作为 §5 Q1/Q3 的输入保留 |
| ADR-0031（随机事件延迟结算） | **已被打回；其术语与分层被本条取代**。`pendingWheels` 等字段设计不进入口径；其中「效果落账早于演出」「`engine.ts` 效果零 RNG」两条事实保留，供 §5 Q5 使用 |

### 7. 明确不做（本条的边界）

- **不做机制设计**：不含准入算法、字段增删、路由、错误码实现、调度结构改造（§5 只列问题与代价）。
- **不动代码**、不动 `specs/**`、不改任何 ADR 正文（只 append-only 回指）。
- **不裁定 P1–P3 的最终效力**：三条默认采用，用户可否决；否决后只改 §4，不影响 §1–§3。
- **不给 Q1–Q5 的答案**：那是重设计阶段的事，且必须逐条走 ADR。

> **〔Q1/Q3/Q5 已由 ADR-0033 裁定，2026-11-13〕** 本 ADR §5 的五个待解问题进度：**Q1（呈现槽形态）+ Q3（伪链判据）→ ADR-0033 决策 1–3**（结论：`occupantOf` 一等**判据**但不持久化；伪链不升格、不动模板，靠「同栈续步优先 + 非占用者不得入槽」保证连续性，即 Q3-A）；**Q5（九类路径归类）→ ADR-0033 决策 6–7**（九行表 + 新不变量候选「产生新呈现物的代码只允许在推进轮次的入口里运行」）；**Q4 → 维持本 ADR 的「不拆」并加约束**（ADR-0033「明确不做」第 1 条）。**Q2 只做了一半**：ADR-0033 不拆 `scheduledEvents`，把「被退回的暂存」独立容器留作批次 4。§4 的 P1 已由 ADR-0033 决策 5 落地（P1-A）；**P2（主线暂歇可见标记）与 P3（未确认呈现物）尚未落地**，P3 属批次 3（待立 ADR-0034）。

> **〔部分被 ADR-0034 取代，2026-11-13〕** 本 ADR 的**术语表 T2（`pendingEvents`）与 T3（`scheduledEvents`）作废**：前者被删除、后者改名 `delayQueue`；T1（呈现槽）由**状态字段 `slot`** 落地，不再是"引擎侧无对应物的派生量"；T6/T7 保留但按 ADR-0034 §2 重述（`turnIndex` 推进点后移到"内容落地之后"）。**§4 P3（未确认呈现物）不再需要**——`slot` 天然就是"未确认"，其"硬卡 + 语义逃生"三条逃生口语义仍有效。**§4 P1/P2 亦作废**：用户已明确"穿脱装备/战斗过程/查看信息不占槽、独立于轮次结算"（P1 的反向结论），P2 的"主线暂歇标记"无对应物（不再有"主线被日常占位"这回事）。**§3 不变量两栏的方法论继续有效**，并已被 ADR-0034 §4 沿用。

## ADR-0033 呈现槽单一判据 + 续步优先 + 待决期写入门禁（批次 1+2）

> **本条覆盖**：按 ADR-0032 的口径落地**批次 1（槽的单一判据）+ 批次 2（续步优先 + P1 门禁 + `useItemV2` 去队列副作用）**。它是 ADR-0032 §5 Q1/Q3/Q5 的**实施裁定**，不含批次 3（未确认呈现物 / 转盘点击才落账，另立 ADR-0034）。
> **本条零存档代价**：`WorldStateV2` **零字段改动**、`schemaVersion` **不动**、旧档全部照常载入；只新增一个**派生投影字段**与若干**调用次序/门禁**调整。

- **状态**：**已接受（2026-11-13；Q3-A 与 P1-A 待用户最终确认，用户可否决）**。
- **起草人**：系统架构师（高见远）。依据：ADR-0032 概念模型 + 本轮三方梳理 + 评审稿（`Q1–Q5 设计评审稿`）。
- **关联**：ADR-0032（口径来源，**本条是它的实施**）、ADR-0026（单槽守卫，**其守卫条件被本条替换**）、ADR-0030/0031（已被打回，其分层不复活）、ADR-0024（前提复核，未触及）、ADR-0017 决策 4（`lastWheels`，未触及）、BACKLOG B-27（combat 反向对称洞，本条不做）。
- **Q3-A（用户可否决）**：伪链**不升格为真链、不加血缘字段、不动模板**（理由：升格需改 `chains:` ⇒ 语义指纹变化 ⇒ 现有存档全部拒载，本周已因指纹变化丢过两次档；且选项级 `nextEventId` 装不进线性 `ChainStep[]`）。
- **P1-A（用户可否决）**：待决/战斗/未确认期间**连用物品、换装备都禁，只放行纯读**（理由：玩家看到的与引擎记账的必须永远一致）。

### 现状核实（以代码为准）

| 事项 | 事实 | 证据 |
|---|---|---|
| 槽的判定只在前端 | 四类占用者 + 优先级 `wheel > battle > event > action` | `apps/web/src/main.tsx:203-204`、`:1299-1315` |
| 引擎只有 1/4 | 守卫只判 `kind === "normal" && pendingEvents.length > 0` | `turn.ts:471` |
| 战斗期间可吸纳 normal | 战斗互斥只挡 combat（`:453`），尾管线照常 pool+drain | `advanceTurnV2` `:940-972`（`:946` drain、`:968` tail） |
| 续步被 drain 抢先 | 三处结算路径 `drainDue` 均在续步链接之前 | `chooseOptionV2:1075` vs `:1078`；`battleActionV2:1141` vs `:1148`；`useItemV2:1224` vs `:1226` |
| 轮外入口能产生呈现物 | `useItemV2` 里有 `drainDue` + `triggerChainStarts` | `:1224`、`:1226` |
| 换装备无任何门禁 | `equipV2`/`unequipV2` 只 `assertActive` | `equipment-turn.ts:45-78`、`:80-105` |

### 决策 1：`occupantOf` —— 呈现槽的**唯一**判据

1. **签名与纯函数性**（严格按此实现，不得加参数）：

```ts
// packages/shared/src/slot.ts（新文件），由 packages/shared/src/index.ts 再导出
export type SlotOccupant = "wheel" | "battle" | "event" | "action";
export function occupantOf(state: WorldStateV2): SlotOccupant;
```

2. **判定次序**（固定，不得重排；全部为纯读，**零副作用、零 RNG、不读 `Date`**）：

| 序 | 条件 | 结果 |
|---|---|---|
| 1 | `(state.lastWheels ?? []).length > 0` | `"wheel"` |
| 2 | `state.battle !== null && !state.battle.over` | `"battle"` |
| 3 | `state.pendingEvents.length > 0` | `"event"` |
| 4 | 其余 | `"action"` |

3. **放置与唯一性**：`packages/shared/src/slot.ts`，理由——它是引擎与前端**共用**的判定，放 `game-core` 会让前端重复实现（正是本次事故根因），放 `v2.ts`（671 行、以类型为主）会让它不易被找到。**硬约束：全仓只允许这一份实现**；`apps/web` 不得再写优先级判断，`game-core` 不得写第二份。`SlotOccupant` 类型即 `shared` 的既有同名类型（`main.tsx:203-204` 迁出入口），前端改为 `import type { SlotOccupant }`。
4. **旧档兼容**：`lastWheels` 是可选字段 ⇒ 用 `?? []`（同类先例 `lastFiredIndex` / `spawnRules`）。

### 决策 2：投影字段 `V2Snapshot.occupant`

1. **形态**：`V2Snapshot.occupant: SlotOccupant`（**必填**，每次投影由 `occupantOf(state)` 现算，**不缓存**）。
2. **不进存档、不升 `schemaVersion`**：`V2Snapshot` 是**派生量**（服务端每请求重算，`worldStore` 只存 `WorldStateV2`）⇒ 存档结构零变化。
3. **三件必须同批**（缺一即复刻事故根因）：① `shared` 落 `occupantOf` + 类型；② 投影写入 `occupant`（`projection.ts`）；③ **前端删除 `main.tsx:1299-1315` 的本地优先级实现，改读 `snapshot.occupant`**。前端不得保留任何 `wheelItems.length > 0 ? ... : battle ? ...` 形式的回退分支（`prefers-reduced-motion`/空态判断可留，占用者判定不可留）。

### 决策 3：准入改造 —— 只改 `normal` 一处

1. **`triggerEventV2` 顶部**：条件从 `event.kind === "normal" && state.pendingEvents.length > 0` 改为 **`event.kind === "normal" && occupantOf(state) !== "action"`**（`turn.ts:471`）。命中动作不变（`enqueueScheduled(ZERO_SPEC)` + `return`，仍在 `recordFire` 之前）。
2. **直接效果**：战斗期间不再吸纳 normal（`L2` 语义由同一条判据自然得到，**不需要**新增 battle 特判）；转盘发生于本轮时（`lastWheels` 非空）normal 也被延后到下一轮 ⇒ 「一轮只演一件事」。
3. **`random` 与 `combat` 本轮走不走同一判据 —— 结论：都不走**（依 ADR-0032 §3 R2：二者结算后本就不入 `pendingEvents`）：
   - `combat` 保持 `turn.ts:453` 的「同一时刻至多一场」互斥，**不加** occupant 准入。理由：「战斗被 `pendingEvents` 挡」是**反向对称洞**（BACKLOG B-27），无观察事例，且会动既有战斗用例 ⇒ 另案。
   - `random` 保持现状（触发即结算、不入 `pendingEvents`），**不加** occupant 准入。理由：一旦被挡就需要「未确认呈现物」这个概念 ⇒ 那是批次 3（ADR-0034）。
4. 因此本条**不改变** `random` 与 `combat` 的任何准入行为；唯一变化的输入面是「normal 事件在什么条件下可入槽」。

### 决策 4：续步优先（F2 顺序规则）——只调次序，不动队列语义

**硬约束**：只调整下列三处的**调用次序**；**不得**修改 `drainDue` / `drainScheduledEvents` / `sortScheduled` 的内部语义（那是 ADR-0011/0026 的既有结论）。

| 入口 | 改前次序 | 改后次序 |
|---|---|---|
| `chooseOptionV2`（`:1073-1080`） | `applyEffectsV2` → **(条件)** `drainDue` → `triggerChainStarts` → `advanceChainOnSettle(nextEventId)` | `applyEffectsV2` → `triggerChainStarts` → `advanceChainOnSettle(nextEventId)` → **(条件)** `drainDue` |
| `battleActionV2`（`:1139-1155`） | `finishBattle` → `applyEffectsV2(outcome)` → **(条件)** `drainDue` → `triggerChainStarts` → `state.battle = null` → `nextEventId` 触发 | `finishBattle` → `applyEffectsV2(outcome)` → `triggerChainStarts` → `state.battle = null` → `nextEventId` 触发 → **(条件)** `drainDue` |
| `useItemV2`（`:1222-1226`） | `applyEffectsV2` → **(条件)** `drainDue` → `triggerChainStarts` | `applyEffectsV2` → `triggerChainStarts` → **删除 `drainDue`**（见决策 6） |

**两条不得违反的约束**：
- `battleActionV2` 中 `state.battle = null` **必须仍先于 `nextEventId` 触发**（否则 `next` 若是 combat 事件会被 `:453` 跳过）；同时也**必须**先于 `drainDue`（否则 drain 出来的 combat 也会被跳过）——后者是本条顺带修掉的实质缺陷。
- `drainDue` 的触发条件（`timeAdvanced || enqueued?.length > 0`）**原样保留**，只是位置后移。

### 决策 5：P1 门禁 —— 三个轮外写入口复用同一判据

1. **门禁函数**（新增 `packages/game-core/src/v2/slot-gate.ts`，避免 `turn.ts` ↔ `equipment-turn.ts` 循环依赖）：

```ts
export function assertSlotFree(state: WorldStateV2): void  // 占位时按 occupant 抛既有码
```
2. **判据复用**：`occupantOf(state) === "action"` 才放行；否则按 occupant 抛**既有**错误码，不新增语义重复码：

| occupant | 抛出 | HTTP（服务端映射） |
|---|---|---|
| `event` | `pending_event_required`（既有） | 409 |
| `battle` | `battle_in_progress`（既有） | 409 |
| `wheel` | 本条内**不可达**（无未确认转盘概念）；批次 3 落地时由 ADR-0034 定义 `pending_wheel_required` | — |
| `action` | 不抛 | — |

   ⇒ **服务端零改动**：两个码都已在 `apps/server/src/index.ts:744-752` 的 `interactionErrors` 集合里（409）。
3. **接入点**：`useItemV2`（`:1191`，替换现有 `battle_in_progress` 单判为 `assertSlotFree`）、`equipV2`（`equipment-turn.ts:45`，`assertActive` 之后）、`unequipV2`（`:71`，同）。
4. **不挡**：`settle`-类呈现物确认入口（批次 3）、`archive`（终局 + P3 逃生口）、**所有 `GET`**（快照 `/ 历史 / 列表 / records`）。
5. **与既有裁定的关系**：「用物品不消耗回合」（ADR-0011 决策 5 / OQ-#34）**不变**——`useItemV2` 仍不推进 `turnIndex`、不清 `lastWheels`；本条只是**在未确认期间禁用它**。口径：*不消耗回合 ≠ 可以改因果*。

### 决策 6：删除 `useItemV2` 内的 `drainDue` + 保留 `triggerChainStarts`

1. 删除 `turn.ts:1223-1225` 的 `if (itemCtx.timeAdvanced || enqueued) drainDue(...)`。
2. `triggerChainStarts`（`:1226`）**保留**但在新次序下位于效果之后（见决策 4 表）。
3. **语义理由**：`useItemV2` 是唯一「不推进轮次却能产生新呈现物」的活路径（见决策 7 表第 4 行）。删掉 drain 后，物品效果 `enqueueEvent` 产生的事件**滞留到下一次 drain**（下一轮入口）⇒ 「用物品不消耗回合」的语义更纯：物品只改数值，不推进世界演出。
4. **可观测行为变化**（必须写进交付说明）：凡「物品效果带 `enqueueEvent` / `advanceTo`」的用例，事件出现时机会晚一轮。现有模板需在实施时核对 `items.yaml` 是否有此类物品；若有，其测试期望需相应更新。

### 决策 7：Q5 九行归类表（口径，原样保留）

| # | 路径 | 归类 | 判据与理由 |
|---|---|---|---|
| 1 | 各入口内 `drainDue`（`:946/1075/1141/1224/848`） | **归入轮次** | 最主要的新呈现物来源；只允许出现在「推进轮次」的三个入口里（`useItemV2` 的已按决策 6 删除） |
| 2 | `triggerChainStarts`（`:940/1077/1143/1226/843`） | **归入轮次** | 起点事件是呈现物 |
| 3 | `runTurnTail` 的 NPC 自主行动（`:841`） | **归入轮次** | 写关系/状态且能 `startedChains`；只随 `advanceTurnV2`/`chooseOptionV2` 尾管线跑 |
| 4 | `useItemV2` 内的 `drainDue` + `triggerChainStarts`（`:1224/1226`） | **禁**（drain 已删；chainStarts 保留但后移） | 唯一「不推进轮次却能产生新呈现物」的活路径 |
| 5 | `equipV2` / `unequipV2`（`equipment-turn.ts:45/71`） | **留在轮次外** | 纯背包/属性移动，不碰两个队列 |
| 6 | `revalidatePendingV2` 的丢弃（`:409`） | **留在轮次外** | 防御性清理；可诊断事实仍只有非持久化 `droppedPending`（持久化另案，BACKLOG B-14） |
| 7 | `applyEndingBoundary`（`:850`） | **留在轮次外** | 终止判定，随 tail 内联，无独立入口 |
| 8 | `archive` | **留在轮次外** | 终局置位；P3 逃生口 |
| 9 | 待决期间的一切改状态输入（P1-A） | **禁** | 与上述 8 条正交的「状态维度」：未确认期间整体禁止 |

**新不变量候选（可断言）**：**「产生新呈现物的代码只允许在推进轮次的入口里运行」**。
断言方式（优先行为断言，`drainDue` 未导出、不必 spy）：构造「使用后 `enqueueEvent` 的物品」→ 调 `useItemV2` → 断言被入队的事件实例 `status === "waiting"` 且 `pendingEvents` 未变；再调 `advanceTurnV2` → 断言该事件此时才 `fired`。

### 必跑测试清单与预期漂移

| 测试 | 预期影响 |
|---|---|
| `packages/game-core/src/v2.test.ts`（单槽 ≤1 / 串行化回放，`:725-800`） | 守卫条件改为 `occupantOf` 后，**被挡的面变大**（战斗期间、转盘轮也会挡）；串行化用例的期望可能需按新条件重算 |
| `packages/game-core/src/v2/r25-acceptance.test.ts`（T1-07 结算占槽，`:71+`） | 不应变；若战斗结算序调整导致断言次序变化，按新序修正 |
| `packages/game-core/src/v2/scheduler.test.ts`（队列长度，`:308-433`） | 不应变（未动队列语义） |
| `packages/game-core/src/v2/playthrough.test.ts`（6 种子 × 2 开局） | **F2 改次序会动 RNG 消耗顺序** ⇒ 逐事件时序与个别种子 `day` 会变（预期非回归）；**必须仍绿**：章节 ≥8、`chapterFires` 无重复、五维区间不变 |
| `packages/game-core/src/v2/combat-refs.test.ts`（`:227-228` `pendingEvents === []`） | 战斗期间行为变化（normal 不再入槽）可能影响该断言的前置构造 |
| `packages/game-core/src/v2/equipment*.test.ts` / `time.test.ts` | 新增门禁后，凡在「有待决事件/战斗」状态下调 `equip/unequip/useItem` 的用例会开始抛 409 ⇒ 需在该类用例前置清空占位 |
| `apps/web` | **必须删除本地优先级实现**（决策 2.3）；否则 `occupant` 双真相 |
| 存档/投影往返（`persistence.test.ts`） | 不应变（`State` 零字段改动；`occupant` 是投影派生量） |

### 明确不做

- **不重构 `turnIndex`**（ADR-0032 Q4 裁定「不拆」）：保持四个自增点，且**不再给它加新用途**。
- **不升格伪链**（Q3-A）：不改 `chains:` 段、不加血缘字段、**不动任何模板**（指纹与旧档零影响）。
- **不拆 `scheduledEvents` 的其余三类语义**（Q2 只拆「被退回的暂存」，留批次 4）。
- **不动 `pendingEvents` 的两条旁路写入**（`opening.ts:241`、`ending.ts:379`，BACKLOG B-33 另案）。
- **不给 `combat` / `random` 加准入**（决策 3.3，分别对应 BACKLOG B-27 与批次 3）。
- **不做批次 3**（未确认呈现物 / 转盘点击才落账）——另立 ADR-0034，且必须在 `occupantOf` 落地后。
- **不动 `specs/**`**、不动模板。

### 实施顺序（本 ADR 内部）

1. `shared/slot.ts` 的 `occupantOf` + `SlotOccupant` 导出（**先立判据**）。
2. 投影 `V2Snapshot.occupant` + 前端改读 `snapshot.occupant` 并删本地判据（**与第 1 步同批**）。
3. `triggerEventV2` 的 normal 准入换判据（**与第 1 步同批**）。
4. F2 三处次序调整 + `slot-gate.ts` + 三处门禁接入 + 删 `useItemV2` 的 drain（**与第 1 步同批**，否则出现「门禁放宽而准入没跟上」的中间态）。
5. 跑必跑清单 → 重录 `playthrough` 基线（只允许逐事件时序细节变化）。

**一句话界定本条**：把「谁在演这一格」从**前端 5 行**变成**引擎与前端共用的一份纯函数判据**，并让「同一叙事序列的下一环」在**同一次结算调用栈内**先于「恰好到期的延时事件」——**零存档代价、不动模板、不复活已被打回的分层**。

### 补充（2026-11-13 落档后核查）：P1-A 与 ADR-0024 决策 2.3 #3 的交界

落档后核对既有测试时发现一处必须写清的交互，**不改变本 ADR 的任何决策**，但改变实施者的测试清单：

1. **ADR-0024 决策 2.3 #3 把 `useItemV2` 定义为「最容易在呈现之后、结算之前改变世界状态的入口」**，并据此在它入口处先跑 `revalidatePendingV2`；`pending-premise.test.ts:180`、`:190` 两条契约用例正是**用 `useItemV2` 来排空一个前提已失效的队首**。**P1-A 之后这两条路径不可达**（待决期间 `useItemV2` 直接 409）⇒ 这两条用例必须改写成用 `advanceTurnV2` 排空。
2. **不会产生硬死锁**（这是 ADR-0024 决策 2.5 的原始担忧）：`advanceTurnV2` 的 `revalidatePendingV2` **排在 `pending_event_required` 门禁之前**（`turn.ts:884-887`）⇒ 即使队首前提已失效且玩家不能用药，玩家仍可提交自由行动，入口会先丢弃失效队首再判门禁。**P1 只收走了「用物品」这条旁路，没有收走唯一的排空通道。**
3. **ADR-0024 的机制不回退**：`checkEventPremise` / `revalidatePendingV2` / `event_premise_invalidated` / `droppedPending` 全部保留（其触发面从「五个入口」收窄为「四个推进轮次的入口 + 提交自由行动时的入口复核」），仍属纵深防御。
4. **受影响的测试补进必跑清单**：`packages/game-core/src/v2/pending-premise.test.ts`（上述两条，必改）、`packages/game-core/src/v2/ending-v2.test.ts`（含 `useItemV2` 调用，需核对是否在待决/战斗状态下调用）。
5. **`items.yaml` 已核对（零暴露）**：`jjk-2006/1.0.0/items.yaml` 共 11 件物品，`use` 效果全部是 `adjustResource` / `cureStatus` / `adjustMood` 之类**纯数值效果**，**零处 `enqueueEvent` / `advanceTo` / `advanceBy`** ⇒ 决策 6 删除 `useItemV2` 内 `drainDue` 造成的「事件晚一轮」在**当前模板下无可观测影响**；该决策是为**未来模板**立规矩。

> **〔被 ADR-0034 取代，2026-11-13〕** 本 ADR 的全部决策（`occupantOf` 作为准入判据、`V2Snapshot.occupant`、续步优先 F2、P1 门禁 `assertSlotFree`、删 `useItemV2` 的 drain、Q5 九行归类表）**作废**。逐条理由：①`occupantOf` 的准入用途随 `pendingEvents` 删除而失去对象（"谁占位"由 `slot` 直接回答）；②F2（续步优先于 drain）被 `slot` 的"后继直接占用"取代——不再有两件事竞争同一格；③P1 的 `equip/unequip` 禁用与用户原话**正面冲突**（用户明确"穿脱装备不占槽、独立于轮次结算"），以用户原话为准；④Q5 的"九类路径"分类保留**方法论**价值，但归类随模型变了（ADR-0034 §2 的六步链是新的唯一权威）。**仍有效的只有事实核查**：`items.yaml` 11 件物品零 `enqueueEvent`/`advanceTo`；`pending-premise.test.ts` 的排空断言位置。

## ADR-0034 单槽 + 单队列 事件模型（用户口述模型的形式化）

> **本条是形式化，不是设计**：模型由用户 2026-11-13 口述给定（原文见下），本条只把他的话落成可断言的状态机、不变量与破坏面。**凡与用户原话冲突处一律不改**，记为「需裁决」；凡他未说而实现必需的，记为「补定义」。
> **唯一需求源（逐字）**：「槽 同一轮次只能发生，处理，结算一个事件 / 占槽 当前事件决定了下一回合要立即发生哪个事件 / 不占槽 不是事件 独立于轮次结算 如穿脱装备 战斗过程 查看信息 / 队列 仅有一个 就是延时事件队列 / nextTurn 时 1. 槽被占了嘛 if 是 then 处理这个事件 else 延时队列里有事件嘛 - if 是 then 尝试从延时队列拿出第一个满足触发条件的事件 处理这个事件 - else 自由行动 / 说明 满足条件的第一个事件：队头开始扫描 判断 when 和时间窗口 扫到开始事件 > 当前时间就可以不扫了 / 行动后 先处理 effect 然后 1. 要占槽吗 if 是 then 将下一个事件占上槽 2. 其他判定 如 miss 掉永久错过的事件 npc 行动 pool 要不要摇一个事件加入队列（pool 摇的事件不能占槽 想要尽快发生也是 delay 0） 然后 nextTurn / pool 可以设计成 槽被占了 或者池子里事件很多 就跳过 不要让事件积压很多 它的存在是来填充游戏内容的」。

- **状态**：**已接受（2026-11-13；按用户口述模型形式化）**。
- **起草人**：系统架构师（高见远）。**关系**：本条**取代** ADR-0026 / ADR-0030 / ADR-0031 / ADR-0033 的全部结论，并**部分取代** ADR-0032 的术语与状态层（见 §6）；ADR-0024 的前提复核机制、ADR-0011 的队列全序与 `TimeSpec` 口径**继续有效**。

### 1. 状态模型

```ts
// WorldStateV2（schemaVersion 2 → 3）
slot: SlotScene | null;                  // 占槽：下一次 nextTurn 必须立即处理的事件
delayQueue: DelayedInstance[];           // 唯一队列（既有 ScheduledEventInstance 的形状，改名）

interface SlotScene { eventId: string; from: "successor" | "opening" | "death" | "hook" | "queueTake"; fromEventId?: string; }
```

| 概念 | 用户定义 | 状态落点 | 进存档 |
|---|---|---|---|
| **槽** | 「同一轮次只能发生/处理/结算一个事件」 | `state.slot`（**只存"下一个要处理的事件"这一件事**，不存进度、不存玩家输入） | **是**（否则刷新即丢；这是 `pendingEvents` 曾被误用的原因） |
| **队列** | 「仅有一个，就是延时事件队列」 | `state.delayQueue` | 是 |
| **不占槽的东西** | 「不是事件、独立于轮次结算：穿脱装备、战斗过程、查看信息」 | **不进状态层**：装备写 `player.equipment/inventory`；战斗写 `state.battle`（`slot` 的**内部过程**）；查看信息是纯读 | 按各自既有字段 |

**存废结论**：`pendingEvents` **删除**（被 `slot` 取代）；`scheduledEvents` **改名 `delayQueue`**（语义不变，仍是唯一队列）；`chains[]` **删除**（`advanceWhen: nextTurn` 实测 0 使用，`stepIndex` 无消费者；"链"退化为图上的边，不再有运行时状态）；`lastWheel(s)` **保留**为"本轮呈现记录"（不是队列，`wheel` 是当前 `slot` 的内部过程）。

### 2. 状态机（`nextTurn` 判定链）

```
nextTurn(state):
  if state.slot:  return present(state.slot)                 // ① 槽有 ⇒ 只处理它，不接受自由行动
  inst = scanQueue(state)                                    // ② 槽空 ⇒ 扫队列（§3）
  if inst: state.slot = take(inst); return present(inst)      //    取出即占槽 ⇒ 统一走 ①
  return freeAction(state)                                   // ③ 都没有 ⇒ 自由行动
```

**「处理」的原子边界**（两份入口共用同一条链）：

| 步 | 动作 | 关键约束 |
|---|---|---|
| 1 | **呈现** —— 投影下发 `slot` 的场景 | **效果未应用**；此时 `turnIndex` 不变 |
| 2 | **输入** —— 选选项 / 战斗命令 / 转盘确认 | 战斗整场属于本步的内部过程，**不额外占轮次** |
| 3 | **结算** —— `applyEffects` → `recordFire` → `pushHistory` → **`turnIndex += 1`** | 一轮恰好 +1，**且在内容落地之后**（既有实现是"行动开始就 +1"，本条把它后移，见 §4 S2） |
| 4 | **占槽判定** —— 本次结算若声明了**无时间账的 `nextEventId`** ⇒ `slot = successor`；否则 `slot = null` | 这是**唯一**能写 `slot` 的两条路径之一（另一条是 §2 ②的 `queueTake`） |
| 5 | **其他判定** —— ① `missWhen` 永久错过并记一次错失 ② NPC 自主行动 ③ pool 摇一个（受阈值约束，**只入队不占槽**） | 顺序固定；`pool` 在"占槽判定"之后，故槽被占时天然跳过 |
| 6 | → 回 `nextTurn` | |

**自由行动同构**：动作 → 时间推进 → 效果 → `turnIndex += 1` → 占槽判定（行动钩子可产生 `hook` 槽） → 其他判定 → `nextTurn`。

### 3. 扫描语义（全部给死结论）

1. **排序键**：`window.start asc → hasEnd（false 视为 +∞）→ window.end asc → enqueueSeq asc`（沿用既有全序实现：`scheduler.ts:71-82`）。`enqueueSeq` 全局唯一 ⇒ 比较函数不可能返回 0。
2. **「扫到 `start > now` 就停」为何成立**：三条前提缺一不可 —— ①入队即按上述键排序（`enqueueScheduled` 唯一入口）；②`window.start` 在入队时**固化为绝对分钟**、运行期只读；③**世界时间单调不减**。⇒ 前提 ③ 在 **R3 时间穿越**下会破（回拨后 `start > now` 的项前面可能存在应被取出的项）；届时该 `break` 必须降级为 `continue` + 重排。**当前不做，作为 seam 注记**。
3. **条件不满足的处置（死结论）**：**留在队列、不占位、继续扫下一个**。只有两种情况出队：`missWhen` 命中（移除 + 记 `miss_when`）或 `worldTime > window.end`（移除 + 记 `window_expired`）。**不得丢弃、不得卡住队头**。
4. **求值时点**：队列实例在**被取出的那一刻**求值 `conditions`/`missWhen`；槽内事件在**每次呈现前**再求值一次（复用既有 `checkEventPremise`）。⇒ 「判定发生在真正上桌时」而不是入队时。
5. **RNG（补定义）**：扫描求值会对同一实例**每轮重复求值**，若条件含 `random` 则反复消耗主轮 RNG。裁定：扫描/呈现前求值使用**独立派生流**（沿用 `deriveTurnSeed(seed + 37, …)` 先例），不进主轮流。
6. **池阈值（补定义）**：判据 = `slot !== null || delayQueue.length >= N` ⇒ 本轮**不摇**。`N` 放模板配置（现状 `eventPools` 只存在于 `opening.yaml`，主循环 pool 由 `source: pool` 事件构成、**无容器**）⇒ 新增 `world.yaml` 的 `eventFlow.poolDraw: { skipWhenSlotOccupied: true, maxQueueLength: 3 }`。
   > **〔2026-11-13 修正（A2'）〕** 上式左边的 `delayQueue.length` 应读作「**当前可上桌的 `waiting` 实例数**」：终态 `fired`/`expired`/`cancelled` 不计数，**且 `window.start > now` 的、以及 `checkEventPremise()` 不成立的也不计数**（两条判据见 §13.5）。**阈值只对"活着等上桌的实例"有意义**——见 §13。**修法是 A2'（§13.5，唯一必做）**；入队侧前提校验已由 `scheduler.ts:162` 承担（原 A2 不实施），`waiting >= N` 这条判据本身**不改**，只改 `count` 的含义。

### 4. 不变量（两栏，禁止混写）

**A. 结构保证（由数据形状/单一写入口保证，写错构不出状态）**

| # | 不变量 | 由什么保证 |
|---|---|---|
| S1 | **一轮最多结算一个事件**（**2026-11-13 拆分：结构保证 + 实现顺序约定**） | ①**结构保证**：`slot` 是标量（`SlotScene \| null`）⇒ **装不下第二个同时存在的事件**（类型层，构不出该状态）；②**实现顺序约定**（**不是类型保证**）：`nextTurn` 对 `normal` / `random` **只呈现不结算**（`random` 还须等 `advanceTurnV2` 确认才结算），"呈现与结算不在同一次调用里"靠代码顺序维持 ⇒ 加固见 §12-4 |
| S2 | **槽内事件未结算前轮次不前进** | `turnIndex += 1` 位于 §2 步 3（结算之后）。**实现实测（`a9826aa`）为 3 处**：`settleSlotEvent`（事件结算）/ `advanceTurnV2`（自由行动）/ `battleActionV2` 的"战斗定义缺失"兜底分支（**2026-11-13 按实况修正**：原写"收敛为一处"，实测是"每个入口的终结处各一处"）。可断言形式改为：**任何入口返回后净 `turnIndex` 增量 ∈ {0, 1}**（战斗回合 0、其余 1），不得出现 2 |
| S3 | **延时队列唯一** | 状态层只有 `delayQueue` 一个队列字段；`pendingEvents` 删除后不存在第二个 |
| S4 | **占槽由 5 个具名来源之一产生 + 1 处克隆回写（不计来源），且无外部输入直达** | **2026-11-13 按实况修正（口径：按来源计，不按赋值语句计）**：实测非 null `slot` 赋值**语句 6 条**，其中 **5 条是具名来源**、与 §1 `SlotScene.from` 一一对应 —— `successor`（`turn.ts:352`）/ `queueTake`（`turn.ts:727`）/ `hook`（`turn.ts:644`）/ `opening`（`opening.ts:243`）/ `death`（`ending.ts:380`）；**第 6 条是克隆回写** `turn.ts:830`（`applyDeathRouteInPlace` 的 `state.slot = res.state.slot`），它只可能写入 `death` 来源的值或原值，**产生不了第 6 个 `from`** ⇒ 不计来源。**成立的性质**：①全部是**引擎内部事件路由**的产物，**没有任何玩家输入能直达 `slot`**；②`from` 字段使每条来源可审计。**它是「白名单纪律」，不是类型层保证**（TS 拦不住直接赋值）⇒ 加固见 **§12-1 `assignSlot()`**。清槽点不受此约束 |
| S5 | 队列全序稳定 | 入队即排序 + `enqueueSeq` 唯一（`scheduler.ts:115-129`） |

**B. 运行期约定（靠代码路径维持，可被旁路破）**

| # | 约定 | 靠什么维持 | 能怎么破 |
|---|---|---|---|
| R1 | `nextTurn` 入口只有 §2 三条分支，不得跳过判定链 | 单一入口函数 | 若有第二个入口（如今日的 `useItemV2` 自带 drain），即可绕开 |
| R2 | 队列取出后立刻占槽（不允许"取出但不处理"） | 实现顺序（同一函数内） | 中途抛异常则实例已从队列摘除而未占槽 ⇒ 需事务性（先占槽再摘除，或失败回滚） |
| R3 | **池抽取动作不写 `slot`**（**不是**"pool 血统的事件链不占槽"） | `resolvePool` 只写队列；事件**被取出后与普通事件完全无异** | 若有人在抽取路径里直接写 `slot` 即破坏本约定（无结构拦阻）。用户 2026-11-13 已裁决此口径，见 §10 |
| R4 | **G2（在场）由模板 `conditions`/`missWhen` 表达** | **模板** | 模板没写就没保障（见 §7 诚实结论） |

### 5. 破坏面

| 项 | 处置 |
|---|---|
| `pendingEvents` | **删除**（`slot` 取代）；`PendingEvent` 类型删除 |
| `scheduledEvents` | **改名 `delayQueue`**，形状沿用（`ScheduledEventInstance`） |
| `chains[]` / `ChainStateV2` | **删除**；`chain` 概念退化为模板边（`nextEventId`）；`evaluateChain` / `alignChainStep` 删除 |
| `lastWheel(s)` | 保留（本轮呈现记录，非队列） |
| `schemaVersion` | **2 → 3**；旧档**拒载**（用户已接受） |
| 投影 | `V2Snapshot.pendingEvent` → **`slotEvent`**（场景 + 选项/转盘/战斗视图）；**不投影队列内容，也不投影队列长度**（反作弊：见 §8-⑥） |
| 前端 | 呈现位判定**收敛为"读 `slotEvent`"**：非空即按 `slot.kind` 呈现，空则自由行动。**删除一切优先级三元式**（`apps/web/src/main.tsx:1299-1315`） |
| 服务端 409 | `pending_event_required` **保留但语义重述**为「槽被占，须先处理槽内事件」；`battle_in_progress` 保留（战斗是槽内过程）；**不新增码** |
| `items/use` / `equip|unequip` | 按用户原话「不占槽、独立于轮次结算」⇒ **不受槽占用限制**（**此处与 ADR-0033 P1-A 冲突，以用户原话为准**，见 §8-①） |
| 既有测试 | `chains`/`evaluateChain`/`pendingEvents` 相关用例**整体重写**；`playthrough` 6 种子基线重录 |

### 6. 与被作废 ADR 的关系（append-only 注记，原正文一字未改）

| ADR | 被本条取代的部分 |
|---|---|
| ADR-0026 | 「槽 = `pendingEvents ≤ 1`」与"入队互斥式守卫"整体作废；`slot` 是**状态字段**而非运行时约束 |
| ADR-0030 | L0–L3 分层准入、`slotTakenFor`、F1–F5、`slotDeferred` 全部作废（`slot` 标量使"准入"问题消失） |
| ADR-0031 | `pendingWheels`/`wheelSeqCounter`/`settleWheelV2`/`pending_wheel_required`/L0 全部作废；但「效果落账早于演出」这一**事实**与「转盘确认属于槽内过程」的口径保留 |
| ADR-0032 | 术语表 T2/T3/T6/T7 与 §2/§3 的**状态层**被取代（`pendingEvents` 不再存在）；其 §4 P3（未确认呈现物）**不再需要**——`slot` 天然就是"未确认" |
| ADR-0033 | `occupantOf`（作为准入判据）、续步优先 F2、P1 门禁、`slot-gate`、删 `useItemV2` drain 全部作废；`occupantOf` 至多保留为**投影派生**（读 `slot`） |

### 7. 测试与验收（G1 / G2 的可断言用例 + 诚实结论）

| # | 现象 | 可断言用例 | 本模型靠什么保证 |
|---|---|---|---|
| **G1-1** | 后继被日常插队 | 事件 A 结算产生无 delay 的后继 B、同时队列里有到期的日常 C ⇒ 断言 `slot.eventId === B` 且 `C` 仍在 `delayQueue` | **结构保证（S4）**：C 没有写 `slot` 的入口 |
| **G1-2** | 战斗期间上桌日常 | `slot` 为 combat 场景 ⇒ 断言 `nextTurn` 只接受战斗命令；任何 normal 事件无法进入 `slot` | **结构保证（S1/S4）** |
| **G1-3** | 一轮结算多个事件 | 任意一轮结束后断言净 `turnIndex` 增量 = 1 | **结构保证（S2）** |
| **G1-4** | 摇出的随机支线被后续事件打断 | pool 事件 P 被摇出 → 进队列（`delay 0`）→ 被取出占槽 → 结算产生无 delay 的后继 S ⇒ 断言 `slot.eventId === S`（**连续支线成立**）；再断言"摇出动作本身"没有写 `slot`（摇出后 `slot` 仍为 `null`，见 §10） | **结构保证（S4）**：占槽与来源无关，只由"是否已在槽中结算"决定 |
| **G2-1** | 角色已死仍呈现其事件 | 队列中某事件的条件含「甲在世」，令甲退场后 `nextTurn` ⇒ 断言该实例**仍在 `delayQueue`**（条件不满足，跳过），后续 `missWhen` 补齐时才移除并记错失 | **运行期约定（R4）**：仍由模板条件表达 |
| **G2-2** | 上桌那一刻才判定 | 同一实例在"条件成立时入队、条件失效后才到期"⇒ 断言取出时求值为不可触发 | **结构保证**（求值时点固定在取出/呈现前，非入队时）— 这是本模型对 G2 的**唯一**结构贡献（**注：§13 修正后，此例仅在"入队时合法"的路径上成立；pool 路径由 A2 在入队前拦掉**） |
| **G2-3** | **队列积压 3 条永久 hold 后主线仍能推进**（§13 的回归锁，**挂在 A2' 上**） | **直接用 `playthrough` seed 5 场景**：`era` 已到 3、队列里 `ev-d-canteen`(`era==1`)/`ev-d2-kouhai`/`ev-d2-train`(`era==2`) 恒不成立 ⇒ 断言 **`ev-ch4-gate`（以及 ch5/ch6/ch7 gate）仍会 fire**，且 `eventFires` 里四个 gate 各恰好 1 次、章节推进 ≥ 8。**不标 `todo` / 不 `skip`** | **运行期约定（A2'，§13.5）**：阈值只数**当前可上桌**的 `waiting`（`window.start <= now` 且 `checkEventPremise().ok`），死实例不计入 ⇒ 不再挡池抽取（**但仍在队列里，不负责出清**） |

**实话（不夸大）**：本模型**结构保证 G1**（因果不断裂、不被插队），因为"上桌的写入口只有一个"。**G2 不被结构保证**：内核不知道"这场戏该有谁"，它只保证「条件在真正上桌时求值 + 条件失效不静默丢弃而是留痕」。用户说的「miss 条件写好就没问题了」正是此意——**本模型把 G2 的时点做对了，但没把 G2 的负担从模板移走**。要移走需要"参与者集合"这类新概念，用户本次未采纳，**不在本条范围内**。

### 8. 需裁决 / 补定义（单列，供主理人转达）

| # | 类型 | 内容 |
|---|---|---|
| ① | **已由用户原话裁决**（`equip/unequip` 部分） | 用户把「穿脱装备」列为「不占槽、独立于轮次结算」⇒ **ADR-0033 P1-A 的 equip/unequip 禁用作废**，以用户原话为准（已写进 §5 表）。**`items/use` 用户仍未明说**：本条按同一原则处理为**不受槽限制**（与既有"用物品不消耗回合"一致），如要改为禁用需用户另说——不阻塞实施 |
| ② | **已由用户裁决（2026-11-13）** | 见 §10：**"pool 不占槽"只约束"摇出事件这个判断"**；pool 事件一旦被取出占槽，其 `nextEventId` 后继**照常占槽**（观感=可摇出连续随机支线）。原"占槽由后继产生、与来源无关"**保留**，并补限定：**来源只影响"能否直接占槽"的入口**（摇出不能），**不影响"已在槽中的事件能否把后继占上槽"** |
| ③ | 补定义 | **取出即占槽**：用户只写"尝试从队列拿出…处理这个事件"，未说是否经过槽。本条统一为"先写 `slot` 再处理"，这样才能保证"槽是唯一事件入口"与 S1/S4 |
| ④ | 补定义 | **`turnIndex` 推进点后移**：从"行动入口"移到"内容落地之后"（§2 步 3）。用户未提轮次计数，但这是 S2 成立的前提 |
| ⑤ | 补定义 | **扫描求值用独立 RNG 流**（`seed + 37`），否则含 `random` 条件的事件每轮扫描都会扰动主轮流 |
| ⑥ | 补定义（反作弊） | 投影**不下发队列内容与长度**：只给"当前在演什么"。否则"队列里有一条关于某人的事件"会泄露该人未死/将出现 |
| ⑦ | 补定义 | **战斗**整场属 `slot` 内部过程、不推进轮次；战斗结束即该事件"结算完成"，此后才执行占槽判定与其他判定 |
| ⑧ | seam 注记 | R3 时间穿越下"扫到 `start > now` 即停"不成立，需降级为 `continue` + 重排；当前不做 |
| ⑨ | 补定义 | **池阈值配置位置**：主循环 pool 无容器（`eventPools` 只存在于 `opening.yaml`）⇒ 新增 `world.yaml` 的 `eventFlow.poolDraw.{skipWhenSlotOccupied,maxQueueLength}`，默认 `true / 3` |
| ⑩ | 补定义（**「转盘确认」走哪条输入**，2026-11-13 裁决） | 不新增路由、不新增错误码。淘汰 (a)「呈现即结算」——一次调用会连结算「上一事件 + 转盘」两个事件，直接违反 S1 与 G1-3；淘汰 (c)「新开 `/wheels/settle` + 新码」——ADR-0031 已打回，且违反 §5「不新增码」。**采用 (b)**：`nextTurn` 在 `random` 槽上**只掷骰、不结算**（用扫描派生流 `scanStream`，可重复调用而结果不变；结果写 `lastWheel(s)`）；**`advanceTurnV2` 在 `random` 槽上即"确认"**——不消耗行动、不推世界时间、不跑模拟域，只把已呈现的那一格结算掉（净 `turnIndex` +1）。**三条实施约束**：① 投影必须能区分 `slotEvent.kind === "random"`，前端据此把「继续」解释为确认；② `random` 槽上收到 `action` 一律**忽略**（不校验、不报错），否则会演变成隐式协议；③ **幂等**：同一 `random` 槽重复提交只结算一次（结算后 `slot` 已空，第二次走「槽空」分支）。**另两条必须同时写死**：(a) **结算前不得清空呈现记录**——`lastWheels` 的清空必须排在确认分支**之后**（或结算改读 `lastWheel` 单槽兜底），否则 `settleRandomSlot` 取不到玩家看到的那一格，会退化为「恒取 `segments[0]`」；(b) **误双击的后果**——第二次提交会变成**一次自由行动**（推时间、+1 轮），引擎无状态可区分「确认」与「行动」⇒ **必须由前端在请求期间禁用按钮**保证，不得靠引擎兜底 |

| ⑪ | 补定义（**槽路径的失效也要留痕**，2026-11-13） | 现状缺口：`MissedEventRecord` 需要 `instanceId`，而 `SlotScene` 只有 `eventId` ⇒ **槽内前提失效只进非持久化 `droppedPending`，进不了 `missedEvents`**，与 §3-3 / §7-G2「前提失效必须留痕」的承诺有缝。**裁定**：`SlotScene` 增**可选** `instanceId?: string`，`queueTake` 时从被取出的实例带上（`successor`/`hook`/`opening`/`death` 来源没有实例）。槽内失效时**若 `instanceId` 存在** ⇒ 记一条 `missedEvents`（`reason` 沿用既有封闭枚举 `miss_when` / `window_expired`，**不扩枚举**）；**若缺失** ⇒ 退化进 `droppedPending`，属**预期行为**，不算缺陷。**反作弊约束（与 §8-⑥ 同源）**：`instanceId` 是**队列身份**，**投影与玩家端一律不得下发**（含 `slotEvent`、历史、错误详情）——它只用于内部审计与 `missedEvents` 回指。本项**不改任何玩家可见行为**（`missedEvents` 本就不投影），故不由用户裁决 |

### 9. 明确不做

- **不引入参与者集合 / 自动判活**：用户模型不含此概念；G2 仍由模板 `conditions`/`missWhen` 表达（§7 已说实话）。
- **不做"随机事件链/按规则生成事件"**：用户后续想法，本轮只记 BACKLOG（B-34），不设计。
- **不保留 `chains[]` 运行时状态**、不做 R3 时间穿越适配、不改模板（`nextEventId` 边零改动即可跑）。

### 10. 用户裁决补正（2026-11-13）：pool 与槽的确切关系

> **用户原话（逐字）**：「问题2 这个很关键 pool后继事件 是这样的 pool触发的事件处理时 说明已经占上槽了 拿他就可以占下一个槽 观感就是可以摇出一个随机连续的支线任务 需要澄清的是 pool不占槽 指的是 pool摇出事件这个判断 而不是 pool已经在槽中等待结算的判断」。

本节的四条按此写死，**取代** §4 R3 的旧表述与 §8-② 的待裁标注（其余段落不变）。

1. **"pool 不占槽" 的适用面收窄为「摇出事件这个判断」**：`poolDraw` 的判定**既不占槽、也不因槽空而强占**；被摇出的事件**只进 `delayQueue`**（最急 `delay 0`）。这是 §3-6（池阈值）与 R3 的唯一含义。
2. **pool 事件被取出占槽后，与普通当前事件完全等价**：它自己结算后的 `nextEventId` 后继**照常可以占槽**（无时间账 ⇒ 占槽）。观感即"摇出一段连续的随机支线任务"，这是**预期行为**，不是插队。
3. **"占槽由后继产生、与来源无关"保留，但补一句限定**：**来源只影响"能否直接占槽"的入口**（`pool` 摇出不能直接占槽），**不影响"已经在槽中的事件能否把后继占上槽"**。下轮若要复述此规则，必须带上这句限定，否则会被读成"pool 血统的事件链永远不占槽"。
4. **pool 后继若带 `delay`/时间窗**：仍按既有默认进队列、不占槽（占槽的判据始终是"有无时间账"，不是"父事件来源"）。

**实施约束（供派活）**：`resolvePool` 与"取队列实例→写 `slot`"必须是**两个不同函数**，且前者**没有** `slot` 写权限（结构上只允许后者写）。G1-4 用例（§7）同时断言这两件事。

### 11. 用户裁决（2026-11-13）：B 方案否决、静默、`log` 疑点、随机方向

> **用户原话（逐字，四条对应上一轮四个问题）**：「1. b不做了 交给模板做判活 / 2. 保持现状 以后再说 / 3. log是什么？ / 4. 参数化文本+ai润色+随机数值」。

本节只记录裁决，**不改 §1–§10 的任何结论**；与本节冲突处以本节为准。

#### 11.1 B 方案（叙事文本占位符 + 内核 cast 判活）**不做**

- **决定**：不引入 `{npc-x}` / `{@npc-x}` 占位符文法，不引入 `cast` 字段，**内核不做 cast 判活**。
- **诈尸（G2）的防线回到模板侧**：由作者在 `conditions` / `missWhen` 里显式表达"这场戏要求谁在场、处于什么状态"。内核仍只负责两件（与 §3-3、§3-4、§7 一致）：**求值固定在真正上桌那一刻**；**前提失效必须留痕、不静默丢弃**。
- **协议面零变更**：因 B 未采纳，`packages/shared` **不因 B 发生任何变更**（无新字段、无新语法、无新枚举）；上一轮评估里拟新增的 `MissReason = "cast_invalid"` **随之作废**。
- **后果（不美化）**：**内核不保证 G2**。作者仍须为"可能失效的剧情"手写条件；实测现状 —— **`missWhen` 0 处 / `npcState` 9 处（覆盖 8% 事件）** —— **不因本模型改变**。本模型对 G2 的贡献只有"时点正确 + 失效留痕"，**没有**把写作负担从模板移走。
- **已知欠账**：记入 BACKLOG **B-35**，标注为**用户已裁决的取舍**，不在本轮重新提案。

#### 11.2 事件被挡掉时给玩家看什么：**已裁决 = 静默**

- 事件因前提不成立 / 窗口过期 / 其他原因**未能上桌**时，**对玩家不产生任何可见痕迹**（不新增中性承接文案，不提示"你错过了什么"）。
- 内部仍按 §3-3 留痕：`missedEvents` 一条（`miss_when` / `window_expired`），该表**不进投影**（实测今天即如此，保持）。
- 关联口径：§8-⑥（投影不下发队列内容与长度）与本条同源——**"某事件存在过"这件事本身不能出现在玩家端**。

#### 11.3 `log` 效果是什么（事实记录，不是裁决）

用户问「log 是什么」。已核对代码与模板，事实如下：

| 项 | 事实 |
|---|---|
| 定义 | effect 的一种：`{ type: log, text, visibility }`（`packages/shared/src/schema/common.ts:289`），本意是「**选项结算后的结果旁白**」 |
| 模板里的样子 | 例：「天内理子在同化中消失。」「你带走了星浆体。天元被迫独自进化。」「2006 年夏 · 怀玉篇结束。」 |
| 实现 | `engine.ts:573-575` 只做 `ctx.logs?.push(effect.text)`（且**仅** `visibility === "public"`），**不写 history** |
| 消费者 | `turn.ts` 有 **4 处**建 `logs: []` 却**从不读**：`:525`（random）、`:930`（自由行动）、`:1071`（选项结算）、`:1137`（战斗结果）；**唯一**读它的是 `useItemV2`（`:1213/1220/1230`，拼进「使用了××」摘要） |
| 模板用量 | `events.yaml` **29 处 `type: log`，全部 `visibility: public`，0 处 hidden**；`items.yaml` 等其它模板文件 **0 处** |
| **结论** | ⇒ **这 29 句旁白 100% 从未展示给玩家**（物品路径根本没有 log 效果可读）。**定性：疑似 bug（接线缺失）**，非设计取舍 |

修不修由用户裁决，已记 BACKLOG **B-36**（含修法选项）。

#### 11.4 随机事件方向（用户定形态，仅登记）

形态 = **参数化文本 + AI 润色 + 随机数值**。与既有能力的关系：
- **参数化文本** ≈ 占位符化（**但只用于随机生成，不用于判活** —— 与 §11.1 否决 B **不矛盾**：否决的是"用占位符做判活"，不是"文本可参数化"）；
- **AI 润色** ≈ ADR-0027 的 LLM flavor（结构校验 + 模板回退，AI 不写权威状态）；
- **随机数值** ≈ `deriveTurnSeed` 派生（确定性、不用 `Math.random`）。

**本轮不设计、不实施**；形态已更新进 BACKLOG **B-34**。

#### 11.5 取舍前提：**模板迁移成本不再是设计取舍因素**（用户 2026-11-13 追加）

> **用户原话**：「另外不用特别重视模板改动多少的问题 当前这个模板就不是很好 以后肯定要重做的」。

1. **适用于后续所有设计**：`jjk-2006/1.0.0` 是**过渡模板**、后续会重做 ⇒ **「要改多少处 yaml」不得作为否决结构性更优方案的依据**。凡涉及"要不要引入需要模板配合的结构"的取舍（Q1 呈现槽形态、Q3 伪链是否升格 这类问题），**必须给出结构与语义层面的优劣判断**；"迁移量大"只能作为**工作量提示**，**不得**作为**否决理由**。
2. **存档拒载仍必须声明**（不因本条豁免）：改模板 ⇒ 语义指纹变化 ⇒ **`data/worlds/` 下旧档全部拒载**（ADR-0007/0029 既定策略）。这是**玩家可感知**的代价 ⇒ **每次涉及模板改动的交付说明都必须写这一句**，不得以"模板要重做"为由省略。
3. **不得据此重开 B**：本节**不改变 §11.1 的裁决**（不做结构化人物引用、判活交模板）。它是**取舍前提**，不是**新证据**；重新讨论 B 需用户另开口径，不得以"模板反正要重做"为由再次提案。

### 12. 后续加固（**不在本轮范围**，2026-11-13 记）

本节记录"现在成立但不够硬"的两处，供下一批排期；**本轮不要求实现**。

1. **把占槽写成单一入口 `assignSlot()`**：现状是 **5 处可枚举写点 + `from` 审计字段**（§4 S4 已按实况修正），**这是白名单纪律，不是类型层保证**（TS 拦不住直接给 `state.slot` 赋值）。加固方案：把 5 处写点收敛到 `assignSlot(state, scene)` 一个函数，并加一条**「写点枚举」测试**——用 grep/AST 断言全仓只有 `assignSlot` 内允许出现 `state.slot = <非 null>`，且**清槽点**同样枚举（当前 6 处 + 初始化 1 处，§4 S4 已列）。目标：把"结构性保证"这句话变成真的。
2. **`SlotScene.instanceId` 的可诊断性补全**（§8-⑪ 一并落地）：`successor` / `hook` / `opening` / `death` 来源没有队列实例，其槽内失效只能进 `droppedPending`；若将来要求"任何来源的失效都可回指"，需要为这四类来源各定义一个稳定的实例身份（**属协议变更，需单独 ADR**），当前按 §8-⑪ 的退化策略处理即可。

3. **把「ctx 的收集字段必须被消费」做成静态检查**（2026-11-13 主理人批准，同日扩为**两条消费要求**）——理由：这类缺陷的形态是"**编译通过、运行无报错、功能静默消失**"，人工 review 只能靠"记得有这么回事"；一旦 effect 语义再变（以后的 `startQuest` / `openShop` 若也改成"收集 + 路由"），**同样的漏点会以新面孔再出现一次**。
   - **查两个字段**：`startedChains` **与** `logs`。**两者是同一漏点模式的两个实例**——"effect 里收集、路由层（或 history 写入点）必须消费"——所以一次检查覆盖两个；以后出现第三类（例如 `openedShops`）只需往判定里**加一个字段名**，不必新写一条检查。
   - **检查目标**：`applyEffectsV2(...)` 的**每个调用点**的 ctx（含**内联对象字面量**，如 `opening.ts:128/179` —— 漏点恰恰都在内联形态上）。
   - **判定**（对每个字段分别判）：ctx **之后 5 行内**出现该字段的消费，**或**显式 `void ctx.<field>` ＋ 注释声明"本路径不用（原因）"。二者皆无 ⇒ 报错。
     - `startedChains` 的"消费"= 读该数组 / 传给 `enqueueChainStarts` / **累积到局部变量并在函数返回处交给调用方路由**（**间接消费也算通过**）。
     - `logs` 的"消费"= 读该数组并写进玩家可见文本（`pushHistory` 摘要等）。
   - **间接消费必须显式承认（否则下一个写检查的人会误判）**：`npc.ts:59` 属于**间接消费**——它把 `startedChains` 传进内联 ctx（局部数组 `:30`），由函数返回 `:74`，再由 `turn.ts:663` 统一路由。**这是通过，不是违规**；检查器必须支持"return 出去也算消费"这种形态。
   - **清点结果（2026-11-13 已数过，勿重复 grep）**：全仓 `applyEffectsV2` 共 **8 个消费点**（不含定义 `engine.ts:326`）：
     - ✅ **已正确消费 6 处**：`turn.ts:507`（random 段，`:508` 路由）/ `turn.ts:904`（自由行动，`:908`）/ `turn.ts:1033`（选项结算，`:1047`）/ `turn.ts:1113`（战斗结果，`:1117`）/ `turn.ts:1187`（用物品，`:1193`）/ `npc.ts:59`（NPC 自主行动：局部累积 `:30` → 返回 `:74` → `turn.ts:663` 路由，**间接消费**）。
     - ❌ **`startedChains` 漏 2 处**：`opening.ts:128`（`applySetup`，覆盖 `characterSetup`/`worldSetup`/`objectives`/`choices`）、`opening.ts:179`（opening 事件池抽中事件的效果）——即 **B-38**。
     - ⚠️ **`logs` 仍不消费 3 处**：自由行动 `actionCtx`（`:904`）、random 段 `segCtx`（`:507`）、战斗结果 `outcomeCtx`（`:1113`）。**当前零实露**（29 处 `type: log` 全在选项层，见 B-36），但将来在这三处写 `log` 会静默丢失。
   - **落地形态**：做成一条**测试用例**（读源码做正则/简易 AST）或脚本级 lint，二选一即可；**不要**为它写自定义 TypeScript transformer（成本远超收益）。
4. **把「呈现与结算分离」的调用顺序钉成断言**（对应 §4 **S1 的第二段**，2026-11-13 加）：S1 里"`nextTurn` 对 `normal` / `random` 只呈现不结算（`random` 还要等 `advanceTurnV2` 确认）"目前**靠代码顺序维持，不是类型保证**——有人把呈现与结算写进同一次调用，S1 就只剩第一段。加固方式（择一即可）：① **行为断言**：`nextTurn` 返回后 `turnIndex` **不变**、且 `slot` 仍非空（`normal` / `random` 两种 kind 各一条）；`random` 槽上再断言 `advanceTurnV2` 之后才 `turnIndex + 1`；② 若将来引入 `assignSlot()`（§12-1），把"呈现一步不得调用结算函数"写成同一条写点枚举测试的邻居用例。
5. **投影重复求值（不影响正确性，只浪费）**：`pendingEventView()`（`turn.ts:1274`）内部又调了一次 `slotEventView()`（`:1275`），而 `projection.ts` 自己也会调 `slotEventView`（`:249`）⇒ **每次投影把槽视图算两遍**（`visibleWhen` 的 `+7` 流会因此多走一遍，输出确定、无害）。**处置（不实施）**：删 `pendingEventView` 这个兼容字段时一并处理——把已算好的 `slotEvent` 结果传进去，或让 `pendingEventView` 只做 `kind === "normal"` 的窄化而不重新求值。

### 13. 交互缺陷与修正（2026-11-13）：§3-3 × §3-6 导致主线永久停摆（A2）

#### 13.1 缺陷实况（已复现）

`playthrough` **seed 5**：`end-secret-two` @day4755 / **t544**，章节只到 **7**（断言要求 ≥8）；`eventFires` 里 **`ch4` / `ch5` / `ch6` / `ch7` 四个 gate 一次都没触发**。

根因是两条**各自都正确**的死结论交互：

| 环节 | 依据 | 行为 |
|---|---|---|
| 日常事件条件永假 | 模板：`ev-d-canteen` 要 `era == 1`、`ev-d2-kouhai` / `ev-d2-train` 要 `era == 2` | 进入 `era = 3` 后**永远不成立** |
| 条件不成立必须留队 | **§3-3 死结论** | 三条日常**永久 hold**，不丢弃、不占位 |
| 阈值按等待数封顶 | **§3-6**（`waiting >= 3` ⇒ 不摇） | 队列恒 ≥3 ⇒ **池抽取永久停摆** |
| 章节门全是池事件 | 模板：`source: pool` + `priority: 100` + `once: true` | **永远摇不出来** ⇒ 主线卡死到 `timeReached` |

其余种子侥幸躲过，只因没在 era 切换时同时积到 3 条——**这是"样本没覆盖"而不是"设计正确"**。

#### 13.2 教训（必须写下来）

1. **§7 的「实话」节没有覆盖这一条**：它只讨论了"G2 不被结构保证、需模板写条件"，**没有讨论"模板条件写得对，仍然会导致主线停摆"**——即 **G2 的实现方式（永久 hold）与 G1 的推进通道（池阈值）之间存在耦合**。这是原模型的盲区。
2. **"留队不丢弃"与"阈值封顶"是两条局部正确、组合致命的规则**：前者保证不误杀，后者保证不积压，但两者都没有人负责回答"队列里的东西会不会永远出不去"。
3. 结论：**"入队"这个动作必须自己承担"现在能演"的语义**，不能把"能不能演"推给将来的出队判定。
4. **〔同源教训（2026-11-13 追加，来自另一处缺陷）〕** ADR-0034 把 `startChain` 从「**直接写状态**」改成「**收集 + 路由**」（`engine.ts:585-592` 现在只是纯谓词，真正的"起点事件入队"由路由层 `enqueueChainStarts` 完成）之后，**每一个 `applyEffectsV2` 的消费点都必须显式消费 `startedChains`**——漏一个就是**静默零效果**。目前 `opening.applySetup`（`opening.ts:128`，被 `characterSetup`/`worldSetup`/`objectives`/`choices` 四个 setup 共用）与 opening 事件池效果（`:179`）就是漏的那两处，记 **BACKLOG B-38**。
   > **一般化**：改 effect 的语义（从"写状态"变成"收集动作"）时，必须**清点所有消费点**，而不是只改产生方；这类改动的最坏形态就是"编译通过、运行无报错、功能静默消失"。

#### 13.3 修正 A2：池抽取时**先判前提，不成立就不入队**（**已裁：由既有代码满足，不实施**）

> **〔更正（2026-11-13，主理人裁定）〕** A2 **撤销/降级为"已由既有代码满足"**：入队侧前提校验**本就由 `enqueueCandidate` 对 `origin.kind === "pool"` 承担**（`scheduler.ts:162`；`resolvePoolV2` 的候选过滤也有 `checkAllConditions`）⇒ **本轮不改**。下面几条保留为"已被既有实现满足"的结论，**不作为改动项**；真正的修法是 **§13.5 的 A2'**。

- **语义**：*"摇出来"本身就意味着"现在能演"*。把一个此刻不可能发生的候选摇进队列、再让它永久 hold 到队列爆掉，本质是**抽错了东西**。
- **判定点**：池抽取（`resolvePool` / `enqueueCandidate` 的门控位）在**入队之前**求值 `conditions`（`missWhen` 同理），不成立则**跳过该候选**。**（已由 `scheduler.ts:162` + `resolvePoolV2` 的 `checkAllConditions` 满足）**
- **RNG**：判定用**独立派生流**（`deriveTurnSeed(seed + 37, …)`，与 §3-5 同一条），**不扰动主轮 RNG**。
- **不消耗**：跳过**不消耗** `once` / 冷却 / 概率——它们本就在 `recordFire` 之后消费。
- **阈值判据**：~~`waiting >= N` 保持；死事件不再进队后它自然生效~~ **〔更正（2026-11-13）〕需配合阈值口径（A2'，§13.5）才生效**——裸 `waiting` 计数会把"入队时合法、之后变死"的实例算进去，见 §13.4。
- **边界**：A2 只覆盖「**入队那一刻就不成立**」的候选。**不覆盖**「入队时合法、之后才长期不成立」的候选（例如条件依赖玩家行为/关系值）——那类仍会永久 hold 并可能重演本缺陷，需要「时间戳 / 休眠字段」（协议变更，**另立 ADR**）。已记 **BACKLOG B-37**。
- **回归锁**：§7 新增 **G2-3**（seed 5 场景直接断言 `ev-ch4-gate` 会 fire，四个 gate 各恰好 1 次、章节 ≥ 8）。**〔更正（2026-11-13）〕G2-3 挂在 A2'（§13.5）上，不标 todo / 不 skip。**

#### 13.4 实测修正（2026-11-13，落档后核对）：**A2 单独不足以修复 seed 5**（**已裁：A2' 为唯一必做，A2 不实施**）

核对现行代码后发现 13.3 的因果链不完整，据实记录（**已裁：A2' 为唯一必做，A2 不实施**）：

1. **"入队即死"在今天本来就不会发生**：池抽取在**入队前**已经校验过 `conditions` —— `resolvePoolV2` 的候选过滤里有 `checkAllConditions(e.trigger.conditions, ctx)`，`enqueueCandidate` 在 `preGated !== true` 时也校验（`scheduler.ts:162`）。⇒ 一个"此刻条件为假"的候选**今天就已经摇不进来**。
2. **seed 5 的三条日常不是"入队即死"，而是"入队时合法、era 翻转后变死"**：`ev-d-canteen`(`era==1`)、`ev-d2-kouhai`/`ev-d2-train`(`era==2`) 在 era 1/2 期间都是**合法候选**，被摇进队列；`era` 升到 3 之后它们才永久不成立 ⇒ 按 §3-3 永久 hold。**A2（入队前判前提）对这类序列无效**——它们入队时是合法的。
3. **真正能让 seed 5 恢复的是"阈值口径"**，即 13.3 引用的那句「阈值数的是**当前可上桌的** `waiting` 实例数」：计数时对每个 `waiting` 实例**现求值一次 premise**，不可上桌的不计入 `queued`。它是**纯读改动、零协议变更**，且与 A2 正交（A2 是入队侧卫生，口径是出队侧计数）。
4. **`scheduler.ts` 侧的 `hold` 仍会把死实例永久留在队列里**：所以还需要「长期不成立」的处置（时间戳 / 休眠字段，属协议变更），已记 **BACKLOG B-37**；口径修正只能让它们"不挡路"，不能让它们"消失"。
5. **对 13.2 教训的补充**：教训 3 那句话应读作"**入队动作与计数动作都必须自己承担'现在能演'的语义**"——只顾入队侧，seed 5 依然停摆。
6. **已裁（2026-11-13，主理人）**：**A2' 为唯一必做，A2 不实施**。理由：A2 要防的"入队即死"已由 `scheduler.ts:162` + `resolvePoolV2` 的候选过滤满足，实施它只会白漂基线；而 seed 5 属"入队时合法、之后变死"，A2 对此无效。裁定细节见 **§13.5**。

#### 13.5 修正 A2'（**唯一必做**）：阈值只数「当前可上桌」的 `waiting`

**裁定（2026-11-13，主理人）**：`resolvePoolV2` 的阈值判据从「裸 `waiting` 计数」改为「**当前可上桌**的 `waiting` 计数」。这是 seed 5 停摆的**必要且唯一**修法。

**可上桌判据（两条同时成立）**：
1. `inst.window.start <= state.worldTime`（未到期的不计）；
2. `checkEventPremise(def, ctx).ok`（`missWhen` 或 `conditions` 不成立的不计）。

**必须写死的实现约束**：
- **纯读**：只计数，不改 `status`、不写 `missedEvents`、不推 `turnIndex`、不动 `slot`（判据与 §3-4 的"求值"共用同一函数 `checkEventPremise`，但**此处不做任何处置**）。
- **RNG 必须走独立派生流**（`seed + 37`，与 §3-5 同一条 `scanStream`），**绝不可用主轮 `ctx.rng`** —— 否则六种子全漂，且"确定性"断言会以最难查的方式红（同 seed 两次跑出不同结果）。每一轮要对**每个** `waiting` 求值一次，用量与队列长度线性相关，必须由独立流承担。
- **定义缺失不计入**（`lookup.event` 找不到 ⇒ 视为不可上桌，也不计数；其清理归加载期完整性校验）。
- **阈值判据本身不改**：仍是 `count >= maxQueueLength(3)` ⇒ 不摇；只是 `count` 的含义变了。
- **不得顺手清理**：死实例仍留在队列（A2' 只让它们**不挡路**，不负责让它们消失）——出清需要时间戳/休眠字段（**协议变更，另立 ADR**，见 BACKLOG B-37）。

**回归锁**：§7 **G2-3 直接挂在 A2' 上**（playthrough seed 5：队列积压 3 条永久 hold 时 `ev-ch4-gate` 仍须 fire、四个 gate 各恰好 1 次、章节 ≥ 8）——**不标 `todo`、不 `skip`**。另建议补两条（主理人已要求内核）：① 未来实例（`window.start > now`）不挡路；② 同 seed 两次跑结果逐字段相同（确定性）。

---

## ADR-0035 LLM 结构写入必须与创作轮同一事务（禁止异步入队）

- **状态**：已裁（2026-11-16，主理人口述反例 + 采纳）
- **触发**：LLM 接入后 `runSettlementHooks` 以 `void pipeline.gateway.invoke(inv)` 发起 invocation（fire-and-forget，不 await）。判定「不阻塞回合结算」是**性能**取舍，但它顺带把**正确性**一起让掉了。
- **相关**：ADR-0032（呈现槽/队列概念模型）、ADR-0034（单槽 + 单队列）、F3（正文只在 trace）、R-LLM-05（回合不阻塞）。

### 1. 问题：结构写入与它依赖的状态快照之间存在时间差

LLM 的产出分两类，性质完全不同：

| 类别 | 工具 | 性质 |
|---|---|---|
| **正文** | `content.writeNarrative` / `writeOption` / `referenceAsset` | 只写 sink + trace，**不改世界状态**，晚到只是"补上" |
| **结构** | `fact.enqueueEvent` / `fact.advanceDag` / `fact.setKnowledge` | **改世界状态**，且写入内容**基于创作那一刻的状态快照** |

异步只对第一类无害。第二类一旦晚到，写入就落在了一个**已经不是它被设想时那个状态**的世界里。

### 2. 两个反例（主理人给出，均可在现行代码上构造）

**反例 A —— 诈尸**

```
A    轮：npc1 活着。玩家行动 → 结算 → LLM 产出「npc1 系列事件」（异步，未落）
A+1  轮：npc1 在这一轮死了
A+2  轮：LLM 的 enqueueEvent 才落账，事件入队
A+n  轮：事件触发 —— npc1 已经死了几百轮，却作为"活着"登场
```

**反例 B —— 加 `missWhen` 之后变成"错误错过"**

```
A    轮：npc1 活着，LLM 产出 npc1 事件（异步，未落），其中一条时间上很快该触发
A+1  轮：没有事件，自由行动；LLM 仍在生成
A+2  轮：没有事件，自由行动；LLM 仍在生成
…几个月后（世界时间）
A+n  轮：npc1 死了；LLM 的写入"刚好"在这一轮才落
A+n+1 轮：触发时刻前提不成立 → miss_when → 永久错过
```

本该在 A+1 发生的事件，因为入队太晚，被判定成"过期"。

### 3. 为什么 `missWhen` 不是答案（这是本 ADR 的核心论证）

`missWhen` 判的是「**触发时刻**前提不成立」。而两个反例里的"该 miss"与"不该 miss"，**在触发时刻的状态上完全一样**——都是「npc1 已死」。

没有任何基于「触发时刻状态」的判据能把二者分开，因为二者的区别只存在于**历史**（这个事件在 A+1 时是否本该能演），而不存在于**当下**。

> **结论**：`missWhen` 只能把 bug 从"诈尸"翻译成"错误错过"，不能消除 bug。它是症状级的，不是根因级的。加它甚至更坏——因为"诈尸"是可见的、会被报出来，"错误错过"是静默的。

同一个根因还解释了两条既有结论为什么不够用：
- ADR-0034 §13.2 教训 3「入队动作必须自己承担『现在能演』的语义」——**异步入队时，"现在"指的是落账那一刻，不是创作那一刻**，这句话被异步悄悄改写了主语。
- ADR-0034 §13.5 A2'（阈值只数"当前可上桌"）——它治的是队列积压，治不了时间错位。

### 4. 决策

**结构写入必须与创作它的那一回合处于同一事务边界。晚到的结构写入一律不许落账。**

具体三条：

**D1 · 时间锚取创作轮，不取落账轮。**
`DispatchContext.worldTime` / `turnIndex` 在 agent loop 起始处固定（`loop.ts` 的 `dispatchCtx`，早于任何 `await`），这就是"创作轮"的权威时钟。所有结构写入的时间/轮次必须取自它，**不得读 `state.worldTime` / `state.turnIndex`**——后者在晚到场景下已经是别的轮了。

> 已实施（`api/engine-api.ts` `fact.enqueueEvent`）：`absoluteStart: ctx.worldTime`。这是**必要条件**，单独不足以解决问题。

**D2 · 结构写入不得跨回合。**
世界在「A 轮结算完成」到「A 轮的结构写入落账」之间**不得推进**。即：事件入队必须发生在下一轮开始之前。

**D3 · 真正的"错过"必须留痕。**
在 D2 成立后，反例 B 里那种"来不及"不再可能发生；剩余的 miss 都是**真·前提失效**（npc 在同一轮内先死、事件后到），应当正常记 `missedEvents` / `droppedPending`。`missWhen` 保留，但它回到本职：判"这一刻该不该演"，不再兼职兜异步竞态。

### 5. 实现：core 只提案，编排层持事务

**内核保持同步纯函数**（这是硬不变量，不能为了 await 把它改成 async——会污染 `advanceTurnV2` / `chooseOptionV2` / `battleActionV2` 及全部确定性测试）。分工改为：

| 层 | 职责 |
|---|---|
| `game-core` | 结算 tail **只产出** `pendingInvocation`，**不执行** `gateway.invoke` |
| `apps/server` | 持 **per-world 串行锁**；锁内完成 [结算 → await invocation → 投影 → save] 全流程 |

事务形状（server 侧）：

```
lock(worldId)
  res = advanceTurnV2(...)            // 同步；写入 pendingInvocation
  if (res.state.pendingInvocation) {
      outcome = await gateway.invoke(inv)   // 结构写入在锁内落账
  }
  snapshot = project(...)             // 必须重新投影：结构写入已改变世界
  worldStore.save(...)
unlock
```

要点：
- **重新投影**：结算尾算出的 snapshot 早于结构写入，必须丢弃重算，否则响应里的事件/队列是旧的。
- **锁的作用域包含 await**：这正是"同步岛"。并发的 `/turns` 请求排队，不会两个回合同时推进。
- **超时/失败 ⇒ 不落任何结构写入**：`await` 拿到的 `fallback` outcome 意味着结构阶段没有提交成功；此时**丢弃**该 invocation 的结构意图（宁可不发生，也不许晚到）。正文仍可回退模板。
- **`pendingInvocation` 的语义随之变化**：它从"在飞的调用"变成"**本事务尚未提交的结构意图**"。`llmPending` 因此是精确的（锁内才有值），不再是会滞留的脏标记。

### 6. 代价（必须写在明面上）

**回合延迟 = LLM 延迟。** 有真 key 时是秒级，mock 时约为 0。这是为正确性付的价，不可回避——除非把"结构"与"正文"拆成两次调用（见 §8）。

因此**必须有加载态**。两条合法形态：
- **同步完整**：等全部产出后一次性返回，前端显示"加载中"（`llmPending` 此时可靠）；
- **流式**：正文边流边渲染（`onDelta`），结构仍在事务收尾处一次落账。流式**不改变事务边界**。

### 7. 不变量与回归锁

1. **IO-1**：`fact.enqueueEvent` / `fact.advanceDag` / `fact.setKnowledge` 落账时，`state.turnIndex` 必须等于 `ctx.turnIndex`。不等 ⇒ 拒绝（新诊断码或复用既有，实施时定），**不得静默落账**。
2. **IO-2**：同一 world 同时只有一回合处于事务中（锁是结构保证，不是约定）。
3. **IO-3**：事务内发生结构写入时，返回给玩家的 snapshot 必须是**写入之后**的投影。
4. **回归锁**：构造反例 A（A 轮触发、A+1 杀 npc1、A+2 落账）⇒ 断言**落账被拒**、`delayQueue` 无该实例、`droppedPending` 或诊断里有记录。构造反例 B ⇒ 断言事件在 A+1（或紧随的合法轮次）触发，**不出现几个月后的 miss_when**。

### 8. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 给 LLM 事件加 `missWhen` | §3：把 bug 从可见的"诈尸"降级为静默的"错误错过"，症状级 |
| 只把时间锚改成 `ctx.worldTime`（D1） | 必要不充分：反例 A 的诈尸仍然成立（事件照样在 npc 死后触发） |
| 让 core 变 async 并 await | 污染整条同步管线与全部确定性测试；事务归属应在编排层，不在内核 |
| 事务外允许结构写入、靠事后一致性修复 | 修复需要"历史重算"，等于引入第二套真值，直接违反「唯一事实源」 |
| 干脆不接 LLM 写结构 | 等于放弃 DAG 分支，与设计目标冲突 |

### 9. 后续

- 结构/正文拆成两次调用（结构短、正文长）可把秒级延迟搬回异步 —— **DEFERRED**，需先有 D2 的锁作为安全网。
- 本 ADR 不涉及 DAG 分支的**契约形状**（`DagNodeView` 是否暴露完整节点、`fact.advanceDag` 是否改增量语义）——那是独立议题，见 BACKLOG。

---

## ADR-0036 触发器求值改为边沿语义（level-triggered ⇒ edge-triggered）

- **状态**：已裁（2026-11-16，主理人质疑「每轮都走 agentGateway？那明显不对吧」后自查发现）
- **触发**：`evaluateTriggers`（`packages/game-core/src/v2/condition-evaluator.ts:212`）对每条 `llmTriggers[].when` 只做**当轮真值求值**，不记历史。而条件原语里 `flagSet` / `nodeCompleted` 这类是**单调持久**的：一旦为真就不再变回假。
- **相关**：ADR-0035（LLM 结构写入同事务）、`specs/.../demo-agentic/rules.yaml` 的 `flagSet took-right` 触发器、R-LLM-05。

### 1. 问题：设计口径是「LLM 稀疏参与」，实际是「一触发永远触发」

设计口径（`turn.ts:825-828` 注释、T-05a）明确写：`rules.llmTriggers[].when` 一条都不命中 ⇒ `invocations` 为空 ⇒ **本轮零网关调用**，"不是每轮跑"。

现行实现对 `random` 类条件成立（`derivedTriggerRng(seed, turnIndex)` 每轮独立），但对**持久条件**完全不成立：

```
turn N   ：玩家选 opt-right ⇒ setFlag took-right = true ⇒ 命中 task.completed ⇒ 调 LLM
turn N+1 ：took-right 仍是 true ⇒ 再次命中 ⇒ 再调 LLM
turn N+2 ：同上 …… worldState 直到结局都带着这个 flag
```

⇒ demo 模板一旦过了 `evt:trial`，**之后每一轮都调一次 LLM**，永不停。这和「稀疏参与」正好相反，且成本随轮数线性增长。`flagSet` 是模板作者最自然会用的一类条件，所以这不是 demo 特例，是**契约级**问题。

### 2. 为什么不能靠模板绕开

| 绕法 | 结果 |
|---|---|
| 模板里把 flag 删掉 | 触发器永远不命中，等于放弃"玩家做了某事 ⇒ AI 写后续"这个核心能力 |
| 给 flag 加 `missWhen` / 反向重置 | flag 是**世界事实**（"玩家确实走过右边"），为了一次 LLM 调用把它改成脉冲信号，等于污染语义 |
| 在 `runSettlementHooks` 里查 `pendingInvocation` 是否已有 | 只挡同一轮重复，跨轮照样每轮命中 |
| 让 LLM 自己写 flag 清掉 | 违反「AI 不得写权威状态」，且幂等无法保证 |

⇒ 必须由**求值层**区分"条件为真"与"条件刚刚变真"。

### 3. 决策

**D1 —— 默认边沿语义。** `llmTriggers[]` 新增可选 `fireMode: "edge" | "level"`，缺省 `edge`。
- `edge`：仅当**上一轮求值为假、本轮为真**时发 invocation。
- `level`：命中即发（旧行为），供作者显式选择（例如"每轮都要有 AI 旁白"的模板）。

**D2 —— 历史落在 state 里，不从 replay 反推。** 新增可选字段：

```ts
triggerFireLedger?: Record<string, { turnIndex: number; hit: boolean }>
```

key = `` `${reason}#${index}` ``（`reason` 是语义身份，`index` 防同 reason 重复）。

- **为什么进 state**：边沿判据是**跨轮的**，必须和它判定的世界同生共死 —— 读档后重新求值必须得到同样的结果（确定性硬约束）。放内存 = 重启后重复触发。
- **为什么 optional + 无默认值**：旧档缺该字段 ⇒ 视作"无历史" ⇒ 首轮把当前真值当"刚刚变真"，最多多发一次，不会永久抑制。**不升 `schemaVersion`**（与 `spawnRules` / `lastWheels` 同一兼容策略）。
- **为什么 key 含 index**：模板改规则后 index 位移 ⇒ key 变 ⇒ 被当作新触发器（多发一次）。这个失败方向安全：宁可多写一次，不可永久闭嘴。

**D3 —— 每轮最多执行一条 invocation。** 现行 `runSettlementHooks` 的 `for (const inv of invocations) assignPendingInvocation(state, inv)` 是**后写覆盖前写**：三条触发器同轮命中 ⇒ 只有最后一条真的被执行，前两条静默消失。ADR-0035 引入 `deferInvocation` 后这个洞更明显（原来 fire-and-forget 三条都会发出去）。
- 决策：取**声明序第一条**执行，其余本轮不执行；
- **但所有求值为真的 key 都必须写进 ledger**（`hit: true`），否则它们会在下一轮被当成"刚刚变真"而延迟触发 —— 那正是 ADR-0035 §3 否掉的那类"错误错过"。
- 被挤掉的触发器记入诊断（不静默）。

**D4 —— `random` 条件在 edge 下退化为 ~9%。** `p=0.1` 独立抛硬币，边沿语义要求"上次假"⇒ 0.1×0.9。这是**期望行为**（避免连续两轮 flavor 轰炸），但要在 `rules.yaml` 注释里写明，别让作者按 10% 排预算。

### 4. 实施拆分

| 项 | 文件 | 内容 |
|---|---|---|
| T1 | `packages/shared/src/v2-state.ts` | 加 `triggerFireLedger`（optional，`.strict()` 子对象） |
| T2 | `packages/shared/src/contract/rules.ts` | 加 `fireMode?: "edge" \| "level"`（default `edge`） |
| T3 | `condition-evaluator.ts` | 保留 `evaluateTriggers`（无历史 ⇒ 纯 level，测试零回归）；新增 `evaluateTriggersEdge(…, previous)` 返回 `{ invocations, fireLedger, suppressed }` |
| T4 | `turn.ts` `runSettlementHooks` | 改用 edge 版本；经 `assignTriggerFireLedger` 落账；只执行第一条 |
| T5 | `api/engine-api.ts` | `assignTriggerFireLedger`（权威写入集中在本文件，与 `assignPendingInvocation` 同约束） |
| T6 | 回归锁 | 见 §5 |

### 5. 不变量与回归锁

- **IO-4**：`flagSet` 类条件在 `fireMode: edge` 下，**连续 N 轮只发 1 次** invocation。
- **IO-5**：条件由真转假再转真 ⇒ **再发一次**（不是"一辈子一次"）。
- **IO-6**：同一轮多条命中 ⇒ 只执行声明序第一条，其余 key 的 ledger 仍写 `hit: true`。
- **IO-7**：无 `triggerFireLedger` 的旧档加载后首次求值 ⇒ 至多多发一次，不得抛错、不得抑制。
- 回归锁：`(a)` flag 置真后跑 5 轮只 1 次网关调用；`(b)` flag 清掉再置真 ⇒ 第 2 次；`(c)` 三轮条件同轮命中 ⇒ 1 次执行 + 3 条 ledger 记录；`(d)` 旧档（无字段）加载不抛；`(e)` `fireMode: level` 保持旧行为。

### 6. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 用 replay / `eventFires` 反推上一轮 | 反推要重跑管线，把"读"变成"算"，且和 trace 保留策略耦合 |
| ledger 只放内存 | 读档后丢历史 ⇒ 重复触发，违反确定性 |
| 条件原语层面加"变化"语义（`flagJustSet`） | 要么给每个原语都造一个 `*JustSet`（组合爆炸），要么原语变成有状态（污染纯函数） |
| 默认 `level`、模板逐个开 `edge` | 默认值必须站在"省钱且符合设计口径"一侧；漏开 = 每轮烧钱且无人察觉 |
| 把 `flagSet` 从条件原语里删掉 | 见 §2 |

### 7. 后续（不在本 ADR）

- 每轮执行多条的**预算内并发**（需要 `pendingInvocation` 变数组或队列）—— **DEFERRED**，D3 只保证"不静默丢失"。
- `fireMode: "cooldown"`（N 轮内最多一次）—— **DEFERRED**，等有真实模板需要。
- DAG 分支契约形状（`DagNodeView` 拆分 / `fact.upsertDagBranch`）—— 独立议题。

---

## ADR-0037 DAG 真正开工：种子 / 推进 / 增量写三处断链

- **状态**：已裁（2026-11-16，主理人「DAG得开工」+ 自查发现三处独立断链）
- **触发**：主理人要求「LLM 写事件是用 dag 直接一套完整的事件分支」。核查后发现 DAG 在**生产路径上根本没有运转**，不是"还没接完"，而是三处各自独立地断掉。
- **相关**：ADR-0032/0034（槽 + 队列）、ADR-0035（结构写入同事务）、ADR-0036（触发器边沿）、F4（视角窗口）。

### 1. 三处断链（均为静态可证，不依赖运行）

**P1 —— 种子从未落进 state。**
`createWorldV2`（`packages/game-core/src/v2/turn.ts:230`）把 `taskDag` 初始化成 `{ dagId: "initial", version: 0, issuedBy: "template", nodes: [], edges: [] }`。而 `rules.fallbackDag` 在全仓**只有一处读取**：`condition-evaluator.ts:290` 的诊断扫描。没有任何代码把 `fallbackDag` 写进 `state.taskDag`。
⇒ 生产环境任何世界的 `taskDag.nodes` 恒为 `[]`。

**P2 —— 引擎从不推进节点状态。**
`guards` / `completion` 在非测试代码里**没有任何求值点**（`grep` 仅命中 `condition-evaluator.ts:290` 的诊断收集）。`taskDag.nodes[].status` 的唯一写入者是 `fact.advanceDag`（`engine-api.ts:226`，LLM 工具）。
⇒ 节点状态只能靠 LLM 写，而 `nodeCompleted` 条件读的正是 `status === "completed"`（`condition-evaluator.ts:62`）⇒ `nodeCompleted` 恒假。

**P3 —— LLM 也没法把 DAG 写进去。**
`fact.advanceDag` 是**整份覆盖** `state.taskDag = parsed.data`，要求调用方给出完整 `TaskDag`。但 `world` 窗口的 `DagNodeView` 只暴露 `{ nodeId, status }`（`perspective.ts:78`），拿不到 `title` / `kind` / `guards` / `completion` / `templateRefs` / `visibility` / `edges`。LLM 若照此重建全量 DAG，只能丢掉这些字段（`TaskDagSchema` 是 `.strict()` + 必填 ⇒ 直接 `invalid_arguments`），或者编造（`templateRefs` 必吃 `unknown_reference`）。

**合起来的后果**：`rules.yaml` 的第一条触发器 `nodeCompleted n1.awaken`（`reason: chapter.advance`，也就是挂 `branch:evt:trial` 的那条）**永久不命中**。demo 模板里真正能命中的只有 `random.flavor`（10%）与 `flagSet took-right`（试炼之后）。DAG 分支轮**在当前代码上不可达** —— 这解释了为什么分支链路"看起来接好了"却演示不出来。

### 2. 决策

**D1 种子：`fallbackDag` 在建世界时落进 `state.taskDag`。**
- `createWorldV2` 增加可选 `rules`（沿用 `TurnPipelineConfig.rules` 来源），`rules.fallbackDag.nodes.length > 0` 时种入。
- 无 `rules`（如 jjk-2006）⇒ 保持现状空 DAG，**零回归**（IO-10）。
- 写入经 `assignTaskDagSeed(state, dag)`，权威写入仍在 `api/engine-api.ts`。
- 种子幂等：同一 `fallbackDag` 重复种入结果字段一致（IO-8）。
- `issuedBy` 保持 `fallbackDag.issuedBy`（`"template"`），`version` 用 `fallbackDag.version`。

**D2 推进：结算 tail 新增第一段 `advanceDagProgress`，引擎权威，位于知识授予**之前**。**
顺序固定为 **DAG 推进 → 知识授予 → 触发器求值**。理由：本轮刚刚 `completed` 的节点必须能被同轮的 `nodeCompleted` 看见，否则触发器永远晚一轮。

迁移规则（确定性、单调、有界）：
| 当前 status | 条件 | 迁移到 |
|---|---|---|
| `draft` | `guards` **全真** | `ready` |
| `ready` / `active` / `in_progress` | `completion` **非空且全真** | `completed` |
| `completed` / `expired` / `cancelled` | — | 不动（终态） |

- **每轮每个节点至多前进一格**（一次扫描只做一次迁移），否则 `completion: [always]` 会让整条链在一轮内级联到底，故事节奏被吞掉。
- **`completion` 为空数组 ⇒ 不可自动完成**。`[].every(...) === true`，不特判会让所有占位节点（如 `n3.hiddenSeed`）瞬间 `completed`。
- 迁移为单调前进，**永不回退**（IO-9）。写入经 `assignDagNodeStatus`（`api/engine-api.ts`）。
- 无 `rules` ⇒ 整段 no-op（IO-10）。

**D3 视图分形：`DagNodeView` 按窗口两形。**
- `world` 窗口：`{ nodeId, title, kind, status, visibility, templateRefs }`，另附 `edges`（顶层的 DAG 边集）。
- `player` / `npc:<id>` 窗口：**保持 `{ nodeId, status }` 不变**，且 `PerspectiveFactViewSchema.superRefine` 新增护栏：非 world 窗口出现 world-only 字段 ⇒ `addIssue`（与既有 `ledger` 护栏同形）。
- 为什么必须分形：不分形就只能在"LLM 盲写"与"玩家看见隐藏任务"之间二选一。F4 的既有投影已按 `visibility === "public"` 过滤玩家侧，本决策只是把 `world` 侧补全。

**D4 增量写：新增 `fact.upsertDagBranch`。**
入参 `{ nodes?: TaskNode[], edges?: TaskEdge[], version?: number }`，语义：
1. `nodes` 按 `id` 合并：已存在的节点**只允许改** `status` / `guards` / `completion` / `due` / `visibility`；改 `kind` / `title` ⇒ `state_conflict`（防止语义被静默重定义）。新节点必须是完整 `TaskNode` 并通过 `TaskNodeSchema`。
2. `edges` 追加，按 `(from, to, kind)` 三元组去重 ⇒ 幂等（IO-11）。
3. 合并结果跑 `validateDag`（既有函数，`v2/task-dag.ts:51`：id 唯一 / 端点 / 自环 / 重复边 / 无环）⇒ 不过则**整体拒绝、不落账**（IO-12）。
4. `version = max(state.taskDag.version + 1, 入参 version ?? 0)`。
5. **永不删除节点**：删除只能由模板 / fallback 做。LLM 只能加与改。
6. 新节点的 `templateRefs` 必须是 `env.lookupRefs` 子集（不许发明事件）；`visibility: "hidden"` 允许（F4 投影会挡住玩家侧）。

**D5 `fact.advanceDag` 从 `toolProfile.narrative` 移除。**
工具仍注册（template / fallback 用），但**任何 LLM 画像都不得包含它** —— 整份覆盖会静默丢掉 LLM 没看见的 `guards` / `completion` / `edges`，属于 P3 同类事故。`toolProfile.narrative` 改为包含 `fact.upsertDagBranch`。

### 3. 不变量

- **IO-8** 种子幂等：同 `fallbackDag` 重复种入，`state.taskDag` 逐字段一致。
- **IO-9** 推进单调：`status` 只能沿 `draft → ready → completed` 前进，永不回退；一轮一节点至多一格。
- **IO-10** 无 `rules` ⇒ 种子 / 推进 / 触发器全链 no-op，行为与改前逐字段一致（jjk-2006 零回归）。
- **IO-11** `upsertDagBranch` 幂等：同一 `branch` 调两次，`nodes` 不翻倍、`edges` 不重复、`version` 只 +1。
- **IO-12** `upsertDagBranch` 后 `validateDag` 必过，失败则 `state.taskDag` 逐字段不变。

### 4. 回归锁

- demo 模板建世界 ⇒ `state.taskDag.nodes` 含 `n1.awaken` / `n2.trial` / `n3.hiddenSeed`。
- 建世界后跑一轮 ⇒ `n1.awaken` 变 `completed`（`ready` + `completion: [always]`）⇒ `nodeCompleted n1.awaken` 为真 ⇒ `chapter.advance` **恰好触发 1 次**，且 `contextHints` 含 `branch:evt:trial`。
- `upsertDagBranch` 加 2 节点 1 边 ⇒ 再次相同调用后 `nodes.length` 不变、`edges.length` 不变、`version` 只 +1。
- `upsertDagBranch` 造环 ⇒ `state_conflict` 拒绝，`state.taskDag` 逐字段不变。
- `upsertDagBranch` 改已存在节点的 `title` ⇒ `state_conflict`。
- jjk-2006（无 `rules.yaml`）⇒ `taskDag.nodes` 仍为 `[]`，全量测试零变化。
- 玩家窗口投影 ⇒ 不含 `n3.hiddenSeed`，且不含任何 world-only 字段。

### 5. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 把 `fallbackDag` 直接塞进 `createWorldV2` 的默认 state（不经 `rules`） | 无 `rules` 的模板也会拿到 DAG，语义漂移，且破坏 IO-10 |
| 让 LLM 求值 `guards` / `completion` 决定 status | 直接违反「AI 不写权威状态」；且评分/进度会随模型波动 |
| 保留整份覆盖给 LLM，只补全 world 窗口视图 | 全量下发随节点数线性涨 token，且"漏抄一个字段就静默丢数据"的风险不可消除 |
| 节点状态由 `eventResolved` 反推（事件跑完就打勾） | 一个节点可对应多个事件，反推会给出错误的 `completed` 时机 |
| 一轮内迭代到不动点（级联到底） | `completion: [always]` 会让整条链一轮走完，故事失去节奏 |

### 6. 后续（不在本 ADR）

- 大 DAG 的 token 预算（全量下发 vs 增量 diff / 分页）—— **DEFERRED**。
- DAG `edges` 是否进玩家窗口（当前只进 world）—— **DEFERRED**。
- 节点 `due` 的到期语义（`expired` 迁移）—— **DEFERRED**，需与 R3 时间适配器一起裁。

---

## ADR-0038 `invoke.branchEventIds`：把「允许摆上桌的事件」做成结构化白名单

- **状态**：已裁（2026-11-16，接 ADR-0037；三代方案均失败后的收敛）
- **触发**：`contextHints` 里的裸 `evt:xxx` 被 runtime 当成"本轮要上桌"的指令，导致 `evt:chance` 被反复入队、与 `evt:closing` 无限交替、最终 409（真实服务可复现）。修法经历了三代，前两代都被否。
- **相关**：ADR-0035（结构写入同事务）、ADR-0036（边沿触发）、ADR-0037（DAG 开工）。

### 1. 三代方案与被否原因

| 代 | 方案 | 结局 |
|---|---|---|
| 一 | runtime 扫描 `contextHints` 里的裸 `evt:` 前缀 ⇒ 发 `fact.enqueueEvent` | **事故源**：把"模板提到过某个事件"解释成"每次 invocation 都重新入队"，`closing↔chance` 无限交替 |
| 二 | 改用显式 `branch:evt:xxx` 前缀，裸 `evt:` 不再触发 | **方向错**：runtime 的私有语法被写进模板数据。`contextHints` 是协议的通用标签通道，往里塞带语义的前缀，等于用字符串形状冒充契约 —— 和第一代是同一类病，只是方向相反 |
| 三（本 ADR） | `invoke.branchEventIds: string[]` 结构化白名单 | 采纳 |

### 2. 决策

**D1 新增可选字段 `invoke.branchEventIds?: string[]`**（`packages/shared/src/contract/rules.ts` 的 trigger `invoke` 内）。
语义：**本次 invocation 允许把其中任一事件实例化进 `delayQueue`**。不在列表内 ⇒ 越权拒绝。

**D2 `contextHints` 内容零解释。** 引擎与 runtime **都不得**消费其字符串语义。它只是透传给模型的文本标签。任何"看字符串长什么样就推断意图"的代码都视为缺陷（源码守卫可加：`agent-runtime` 不得出现 `startsWith("evt:")` 类分支）。

**D3 越权拒绝复用 `unknown_reference`。** `fact.enqueueEvent` 校验顺序：
1. `eventId` ∉ `env.lookupRefs`（模板 ref 全集）⇒ `unknown_reference`（既有行为）
2. 本次 invocation 声明了 `branchEventIds` 且 `eventId` ∉ 该列表 ⇒ `unknown_reference`，`allowedRefs` 填 `branchEventIds`
3. 本次 invocation **未声明** `branchEventIds` ⇒ 不允许任何 enqueue（`unknown_reference`，`allowedRefs: []`）

> 第 3 条是刻意的：**沉默 = 没有分支能力**。宁可让分支轮什么都不摆（玩家看到纯叙事），也不要让它摆出一个作者没打算摆的事件。

**D4 runtime 侧读取顺序**：`invoke.branchEventIds`（首选）→ 兼容旧 `branch:evt:x` 前缀（**DEPRECATED**，只保留一个版本周期，新模板不得使用）。

**D5 与 ADR-0037 的分工**：`branchEventIds` 表达"这次允许摆哪些**模板已有**事件"；`fact.upsertDagBranch` 表达"LLM 新写一段**分支结构**"。两者正交：前者管已被作者定义的事件上桌时机，后者管 LLM 新增节点/边。**不得**用后者绕过前者（`upsertDagBranch` 不触发任何入队）。

### 3. 不变量

- **IO-13**：`fact.enqueueEvent` 的 `eventId` 必须 ∈ 本次 invocation 的 `branchEventIds`；未声明 ⇒ 一律拒绝。
- **IO-14**：`branchEventIds` 的每一项必须是 `env.lookupRefs` 成员（模板加载期即校验，不允许悬空引用）。
- **IO-15**：`contextHints` 的内容变化不得改变任何 `dispatch` 行为（可测：把 hints 换成任意字符串，世界状态逐字段不变）。

### 4. 回归锁

- `branchEventIds: ["evt:trial"]` ⇒ 恰好 1 次 `fact.enqueueEvent`，`eventId === "evt:trial"`。
- 未声明 `branchEventIds`，但 `contextHints` 含 `evt:trial` ⇒ **0 次** enqueue（IO-15 / D2）。
- `branchEventIds: ["evt:trial"]` 却 enqueue `evt:ambush` ⇒ `unknown_reference`，`delayQueue` 不变（IO-13）。
- `branchEventIds: ["evt:nonexistent"]` ⇒ 模板加载期报错（IO-14）。

### 5. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 裸 `evt:` 前缀（第一代） | 事故源，见 §1 |
| `branch:evt:` 前缀（第二代） | 私有语法进协议；形状推断语义 |
| 从 `taskDag.nodes[].templateRefs` 自动实例化事件 | 会和事件自身的 `chain` / `pool` 调度**双写**（`evt:trial` 已经由 `evt:awaken.nextEventId` 摆上桌，自动实例化会再摆一次）。**DEFERRED**，若将来要做，必须先统一"谁负责摆放"这唯一权威 |
| 让 LLM 自由 enqueue（不设白名单） | 模板作者失去节奏控制权；且 `unknown_reference` 只能挡住不存在的事件，挡不住"存在但此时不该出现"的事件 |

### 6. 后续

- 统一「事件摆放权威」（DAG 驱动 vs 事件 `nextEventId` 驱动）—— **DEFERRED**，见 §5。
- 兼容用的 `branch:` 前缀解析在一个版本周期后移除 —— 需要一次清理任务。

### 7. 补充裁定（2026-11-16，落地前 review 提出）

**D6 白名单经 `LlmInvocation` → `DispatchContext` 传递，不进 `env`。**
- `env` 是模板级**静态**环境（`lookupRefs` / `registry` 与具体哪次 invocation 无关）。把 invocation 级白名单塞进 `env`，会让同一次 dispatch 的语义随调用方拼 env 的方式分裂。
- 链路：`rules.llmTriggers[].invoke.branchEventIds` → `evaluateTriggers` 拷进 `LlmInvocation.branchEventIds` → `agent-runtime` 的 loop 透传为 `DispatchContext.branchEventIds` → `enqueueEvent.run` 校验。
- **权威性**：白名单只能来自 core 生成的 `LlmInvocation`（即规则求值结果），**不得**由模型输出、loop 拼接或 HTTP 请求体提供。`LlmInvocation` 是这次 invocation 的唯一权威描述，规则在 invocation 存续期间变化不影响它。

**D7 mock 侧确定性取值：`branchEventIds[0]`，一次 invocation 最多一条 enqueue。**
- mock 看不到 `lookupRefs`，结构上无法"先验证再上桌"，因此它只负责"从白名单第一条取"，越界由 loop / engine 侧拒绝。
- 推论：**「白名单外 enqueue ⇒ `unknown_reference`」这条回归锁不能用 mock 构造**（mock 天然发不出越界调用）。必须用 `ScriptedProvider` 硬发一个白名单外 `eventId` 来锁。
- 不做"按 `invocationId` 轮转"：多分支演示靠模板给多条触发器，不靠 mock 内部状态机——那会把不确定性塞进本该确定的地方。

**D8 中间态声明**：`rules.yaml` 未声明 `branchEventIds` 期间，demo 的 DAG 分支轮**静默不触发**（不 409、不上桌）。这是 D3 第 3 条的期望行为，不是缺陷。

### 7. 补充裁定（2026-11-16，落地前 review 提出）

**D6 `advanceDagProgress` 必须拿到本轮 `resolvedEventIds`。**
节点 `completion` 的自然写法是「这个任务对应的事件结算了」⇒ `[{ op: "eventResolved", args: { eventId: "evt:trial" } }]`。而 `eventResolved` 的判据是 `ConditionEvalContext.resolvedEventIds`（ADR 前置：`condition-evaluator.ts` 的 `eventResolved` 实现 `ctx.resolvedEventIds?.has(...)`）。若推进钩子不传这个集合，所有 `eventResolved` 型 `completion` **恒假**，节点永不完结 —— 这会把 P2 从"节点不动"变成"节点看起来能动但走到一半卡死"，比原缺陷更难查。
⇒ `advanceDagProgress(state, rules, registry, opts.resolvedEventIds)`，与触发器求值**同一份**集合（`turn.ts` 的 `runSettlementHooks` 已经有这个入参，直接透传）。

**D7 `completion: []` 的语义写进类型层注释，不只是实现层特判。**
`[].every(...) === true` 会让所有占位节点瞬间 `completed`。实现上要特判，但这属于**容易被下一次重构"顺手简化掉"的陷阱**，所以 `TaskNodeSchema.completion` 的注释必须写明「空数组 ⇒ 不可自动完成」。

**D8 顺序再确认**：`advanceDagProgress` → 知识授予 → 触发器求值。三条都在 `runSettlementHooks` 内，且都用**同一份** `resolvedEventIds`。DAG 推进放在最前，是为了让本轮刚 `completed` 的节点能被同轮 `nodeCompleted` 看见。

**D9 template 侧连带义务**：demo 的 `fallbackDag` 现在的 `completion` 全是 `[{ op: "always" }]`，那表示"一被解锁就算完成"，与故事语义不符（`n2.trial` 应该在 `evt:trial` 结算后才完成）。DAG 种子落地后必须一并改成 `eventResolved` 型条件，否则 `nodeCompleted` 会在错误的时点变真。

### 8. 修订（2026-11-16，落地前 review 提出，**supersede D6**）

**D6′ `branchEventIds` 落在 `LlmContext` 内，不在 `LlmInvocation` 顶层。**

原 D6 把字段放 invocation 顶层，只解决了「怎么传到 engine」。两个问题被漏掉：

1. **`contextHash` 覆盖不到**。`loop.ts:126` 的 `contextHash = sha256(stableStringify(inv.context))`。字段若在 `inv.context` 之外，两次只有白名单不同的 invocation 会得到**同一个 hash**，却在 engine 侧一个放行、一个 `allowedRefs: []` 全拒 —— trace 的唯一身份就是 `contextHash + callsHash`，回放归因立刻失效。
2. **模型看不见自己的权限**。`contextHints` 清空事件 id 之后（D2），真实 LLM **没有任何信号**知道"本轮可以摆 `evt:trial`"。白名单若只做 engine 闸门、不进 prompt，等于把能力锁起来又不给钥匙 —— 分支轮对真实模型永久不可用，只有 mock 能演。

两者指向同一结论：`branchEventIds` **既是能力也是提示内容**，因此属于 `LlmContext`。

链路（取代 D6 的五段式）：
```
rules.llmTriggers[].invoke.branchEventIds        // shared/contract/rules.ts
  → LlmContext.branchEventIds                     // shared/contract/llm-invocation.ts（进 prompt、进 contextHash）
  → evaluateTriggers 拷贝                          // game-core/v2/condition-evaluator.ts
  → buildInitialMessages 渲染进 prompt             // agent-runtime（必须显式挑这个字段，见下）
  → DispatchContext.branchEventIds = inv.context.branchEventIds   // loop.ts 唯一构造点
  → enqueueEvent.run 校验                          // game-core/api/engine-api.ts
```
- `LlmInvocation` **不再**新增顶层字段，避免两处真值。
- `contextHash` 自动覆盖，无需改哈希算法。
- **`buildInitialMessages` 必须显式渲染该字段**（它只挑固定几个字段，漏了就是"engine 有闸门、模型没钥匙"）。提示文案要说清楚是**白名单**：「本轮你最多可以把下列事件之一摆上桌：…；不在列表内的一律会被拒绝」。

**D9 白名单是「能力」，不是「一次性」。**
声明 `branchEventIds` **不等于**只摆一次。频率由三处共同保证，缺一不可：
1. ADR-0036 边沿语义（触发器不再每轮命中）；
2. `fact.enqueueEvent` 的 `waiting` 幂等（同一事件已有 waiting 实例时不重复入队）+ ADR-0035 IO-1 跨回合守卫；
3. 模板 `missWhen`（内容层：该事件不该再出现时清场）。

⇒ `rules.ts` 的字段注释必须写明「声明 ≠ 只摆一次」。否则下一位模板作者会把「允许清单」理解成「允许了就摆」，把 409 那个坑原样复制到新模板。

**D10 D2 的源码守卫需要豁免区间。**
D2「runtime 不得消费 `contextHints` 的字符串语义」与 D4「legacy `branch:` 保留一个版本周期」直接冲突：现存 `mock.ts` 有三处形状判断（`startsWith("evt:")` / `startsWith("{")` / 前缀循环）。若守卫按字面写，落地即撞线。
⇒ 裁决：legacy 解析**收敛到单点 `@deprecated` 函数**（`parseLegacyBranchHint`），源码守卫对该函数体**豁免**，并在守卫里同时登记「清理该函数时必须同步删除豁免规则」。
这样"临时兼容"有了到期机制：删不掉函数就删不掉豁免，守卫会一直提醒。

### 9. 实现细则裁定（2026-11-16，动工前 review 收敛）

以下五条在实现时才发现，但都会改变"改对不对"的判定，故入 ADR 而非只留在提交信息里。

**R1 `LlmContext` 有第二个构造点：`packages/agent-runtime/src/context.ts:110`。**
它逐字段重建 context（不 spread）。只改 `loop.ts:146` ⇒ gateway 算的 `contextHash` 仍是旧形状，与 loop 自己算的不一致 —— **同一个缺陷的第二个出口**。两处必须同步，且这一条本身值得一条锁（两处 hash 相等）。

**R2 legacy shim 单独成文件：`packages/agent-runtime/src/providers/legacy-hint.ts`。**
D10 的守卫用「文件路径白名单」而不是行号区间 —— 行号会随手改漂移，文件边界稳定。守卫规则写成：「除 `legacy-hint.ts` 外，`agent-runtime/src/**` 不得出现 `startsWith` 后接 `"evt:"` 的字面量」。

**R3 D10 的禁用清单**只针对 `evt:` 形状推断。`normalizeBranchTarget` 的 `startsWith("evt:")` 是**校验 id 形状**、`hint.startsWith("asset:")`（`mock.ts:465`）是**另一条未替换的 shape 推断**，两者都不在禁用清单内。后者已登记为 `docs/BACKLOG.md` **B-40**（协议变更类，需 ADR）。

**R4 `[]` 与 `undefined` 在回执上不可区分 —— 「三态」应改述为「两拒一放」。**
`unknown_reference` 的回执 shape 对所有分支一致（同一码 `allowedRefs` 变量），所以"显式空数组"与"未声明"**无法**用回执区分，锁 4 只能断言统一行为（都拒 + `allowedRefs: []`），不能断言"能区分二者"。措辞随之收紧：**不存在"三态严格区分"，只有三个拒绝分支共享同一码、一条放行分支**；唯一必须防的退化是 `[]` 被当成"不限制"。
⇒ 措辞统一为「**两拒一放**」，避免后来者以为回执里能看出是哪种拒绝而写出依赖它的测试。

**R5 prompt 渲染（6b）的锁必须锚定具体措辞。**
不能断言「messages 不含任何 `evt:`」—— `facts` 段本身就承载 `evt:` 形态的 ref。锁应为：给了 `branchEventIds` ⇒ messages 含白名单那段的**固定引导语**且含 `evt:trial`；未声明 ⇒ messages **不含**该引导语。

### 10. 落地顺序是硬约束（2026-11-16，实测发现）

**ADR-0037 的 D1（种 fallbackDag）+ D2（推进节点）不得先于 ADR-0036（边沿触发）单独上线。**

道理在两条修复的交叉点上：现在 `nodeCompleted n1.awaken` 恒假（`taskDag.nodes` 为空），所以第 1 条触发器**从不命中** —— 这是个"死链"，但也因此**不产生任何副作用**。一旦按 D1/D2 种入并推进 DAG，`n1.awaken` 会在第一轮变 `completed` ⇒ 那条触发器**每轮命中**（`status === "completed"` 是持久条件）⇒ 每个回合都发一次 invocation、都摆一次 `evt:trial`。而 `evt:trial` 的 `missWhen: trialDone` 已为真 ⇒ 每次都被 `miss_when` 清场，且 `missedEvents.push` 是 **append-only、无上限、进存档**（`v2-state.ts:247`）。

实测（agent-impl-2，fixture + 真引擎，`trialDone=true` 后连续 3 次 enqueue）：`missedEvents` 逐回合 0→1→2→3，`reason` 全为 `miss_when`。
⇒ 只上 DAG、不上边沿，等于把"死链"换成"每回合烧一次 LLM + 存档线性膨胀 + 玩家看到『错过了 N 次初次试炼』"。**比现状更糟。**

故：**ADR-0036 必须先落或同时落**。这条写在这里是因为两个 ADR 由不同 worker 实现，顺序不属于任何一方的实现细节，属于集成约束。

（`missedEvents` 无上限本身另立 `docs/BACKLOG.md` **B-41**；本 ADR 不改变其语义，只要求不制造触发它增长的条件。）

**R6 修订 R1：不锁「两处 hash 相等」，改锁「两处各自对字段敏感」。**
R1 原话「两处算出的 hash 相等」是错的：`buildLlmContext(...)` 的 `contextHash` 算在**重建后**的 context 上（`stablePrefix` 由 `buildStablePrefix` 重生成、`facts` 由 `engineApi.buildFacts` 重投影），而 loop 的 `sha256(stableStringify(inv.context))` 算在 core 交来的原样 context 上。二者只在"重建恰好逐字段不变"时碰巧相等 —— 本仓库不是这个前提（fixture 里 core 给的 `stablePrefix` 通常是空串）。照原话写，锁一落地就红，且红得像 bug。
⇒ 改为两条**同构**断言，各自锁自己那条路径的覆盖性：
- 路径 A（`context.ts`）：同一 invocation，仅 `context.branchEventIds` 不同 ⇒ 两次 `buildLlmContext().contextHash` **不相等**；
- 路径 B（`loop`）：同上 ⇒ 两次写入 trace 的 `contextHash` **不相等**。
R1 真正要防的是「第二个构造点漏字段」，这个写法才钉得住。

**R7 `legacy` 的「保留一个周期」= 保留解析形态，**不接发射路径**。**
D2（hints 零解释）+ D3 第 3 条（未声明白名单一律拒）合起来只有一个自洽解，否则自相矛盾：
老模板 hints 里仍写着 `branch:evt:x`、但没声明 `branchEventIds` ⇒ engine 必拒。mock 若照旧按 hints 发射，每轮产出一条 `unknown_reference` 回执 ⇒ 分支轮既没上桌，又平白添噪音。
⇒ `parseLegacyBranchHint` 独立成文件、`@deprecated`、**导出但无调用方**，import 处注明「不要把这里的解析接回发射路径，接了必然被 D3 全拒」，一个版本周期后整文件删除。
**并把它变成锁而不只是注释**：源码守卫增加一条 —— `parseLegacyBranchHint` 除自身文件外**不得有引用**。这样"临时兼容"无法悄悄复活。
（另一条路是 D3 对 legacy 提示开例外，即 `ctx.branchEventIds === undefined` 时回落 hints —— 与 D2 正面冲突，**否决**。）

**R8 `buildInitialMessages` 用 spread `LlmContext`，但显式挖掉 `stablePrefix`。**
spread 让以后加字段自动进 prompt（避免"加了字段没进 prompt"这类静默失能）；`stablePrefix` 已作为 system 消息单独发送，spread 进去会重复一大段骨架、白烧 token。

**R9 修订 IO-15 的观测面：必须锁 trace，不能锁 state。**
原 IO-15 写「把 `contextHints` 换成任意字符串，**世界状态**逐字段不变」。实测（gateway 真跑，其余条件全同）这条会**假绿**：

| hints | receipts | contentBlocks | delayQueue |
|---|---|---|---|
| 无 | `[accepted × 5]` | 4 | 0 |
| `["asset:whatever"]` | `[accepted, rejected:visibility_violation, …]` | 5（**同 blockId 重复**） | 0 |
| `["evt:trial"]` | `[accepted × 5]` | 4 | 0 |

原因：`content.*` 在 refs 越窗时**先 reject、不写 sink**，所以 `state` 逐字段确实没变 —— 但 dispatch 行为变了（多一条拒绝、多一块重复正文）。"hints 是惰性的"这个命题必须用**行为**证明，而不是用"没崩"证明。
⇒ IO-15 改为：同一 invocation，仅 `contextHints` 换成任意字符串 ⇒ ① `receipts` 的 `(code, 顺序)` 序列逐项相同；② `contentBlocks` 的 `blockId` 序列相同且无重复；③ `state` 逐字段相同。三条同时成立才算通过。
（`["evt:trial"]` 一栏已与"无 hints"完全一致 ⇒ D2 在 `evt:` 这条上是真落住了，不是靠断言放宽。）

**R10 `mock` 重试分支的作用域缺陷（本轮修，不再挂账）。**
`mock.ts` 的重试分支是 `else if (available.has("content.writeNarrative"))` —— 它兜住了**所有**非 `writeOption` 的拒绝。于是 `content.referenceAsset` / `writeFlavor` / `writeMemory` 被打回时，也会重发一段 narrative（**同一 blockId**），而 trait 仍是 `outcome: committed`。
后果：玩家看到同一段话出现两次，**没有任何错误提示**；真模型接入后（窗口越界、写错 ref 远比 mock 频繁）会显著放大。
⇒ 决策：重发**只对 `content.writeNarrative` 自身的拒绝**生效（此时收窄 refs 再发是对的）；其余 content 工具被拒 ⇒ 跳过该调用、继续推进，与 `isFactRejection` 同一处置逻辑。
回归锁：让 `referenceAsset` 被拒 ⇒ `outcome` 仍 `committed`、`contentBlocks` 中该 narrative 的 `blockId` **只出现一次**、`receipts` 有那条 `visibility_violation`（不吞掉诊断，只是不复制正文）。

**D2-a 「形状推断」的可复用判据（D2 的子规则，适用于任何"能不能从字符串里读点东西"的分歧）。**

> 形状推断若**改变世界节奏**（入队 / 推进 DAG / 授知识 / 任何结构写入）⇒ **禁止**，必须走结构化字段。
> 形状推断若只**选取内容参数**（这张图用哪个 `assetId`、用什么文案键）⇒ **允许**，但必须由**命名空间约定**支撑，且不得反过来影响节奏。

两栏对照：
| 形态 | 判据 | 结论 |
|---|---|---|
| `contextHints` 里的 `evt:` / `asset:` | hints 是自由文本标签通道，无命名空间约束 | 禁止（已删） |
| `facts[].factRef` 的 `asset:` | `factRef` 是 ref 命名空间，`asset:<id>` 与 `fact:` / `secret:` 同级，只选内容参数 | 保留 |
| `facts[].factRef` 的 `evt:` | 曾被当成入队指令 | 禁止（已删，见 ADR-0038 §1） |

为什么必须写成**判据**而不只是删代码：删掉 `hints` 那支、留下 `factRef` 那支，后来者看到的是"标准不一致"，然后按最省事的方式加回来。有了判据，他会先问"这改的是节奏还是内容"，再决定。
代码侧对应：`assetIdFrom()` 的 factRef 分支上方标注 `// 判据（ADR-0038 D2-a）：factRef 是 ref 命名空间，解引用只选内容参数，不改节奏`。

**R11 IO-15 再补一条（比"无 rejected 回执"更硬）：hints 任意取值下，trace 里不得**存在**`content.referenceAsset` 调用。**
不是"发了被拒"，而是"根本没发过"。它同时锁两件事：B-40 不复活、以及将来有人想加回"从 hints 猜资源"会被立刻挡下。比断言回执形态稳 —— 不依赖 engine 的越窗判定逻辑是否正确。
⇒ IO-15 最终四条：① `receipts` 的 `(code, 顺序)` 序列相同；② `contentBlocks` 的 `blockId` 序列相同且无重复；③ `state` 逐字段相同；④ trace 中**不存在** `content.referenceAsset` 调用。
