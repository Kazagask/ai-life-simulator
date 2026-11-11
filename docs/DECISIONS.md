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
