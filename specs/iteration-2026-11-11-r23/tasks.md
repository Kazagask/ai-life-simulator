# 迭代 R2.3 任务清单（Tasks）

**版本：2026-11-11（R2.3 立项）｜状态：草案（待用户确认后从阶段 0 开始）｜上游：`requirements.md`、`design.md`**

> 本清单是 Spec Coding 的第三阶段产物。**阶段 0 与阶段 1 完成前不得进入编码实现。**
> 一次只做一个任务；勾选 `[x]` 表示该任务通过「完成定义」。

------------------------------------------------------------------------

## 0. 约定

- 任务编号 `T<阶段>-<序号>`；每条必须标注：依赖、追溯需求、产出文件、完成定义。
- 提交信息注明任务 ID 与需求编号，例如 `feat(T2-01): 历史记录携带可见性 (R-VS-01, R-VS-03)`。
- 汇报按 `AGENTS.md` §4 五段式；**Spec 只允许改**：本文件勾选、`docs/DECISIONS.md` 新增 ADR、`docs/OPEN_QUESTIONS.md` 登记、本包四文件勘误。
- 遇到不确定产品规则 → 写 `docs/OPEN_QUESTIONS.md`，不自行伪造共识。
- **同一时刻只允许一个 Agent 写 `packages/`**；开工前确认另一 Agent 已停或已提交。
- 任务计数：**18 个 ACTIVE**（阶段 0–3、5–6）+ 附录 A 的 4 个与附录 B 的 5 个 `DEFERRED`，DEFERRED **不执行、不验收、不计入 DoD**。

### 施工顺序（与需求优先级一致）

```
阶段 2（可见性，小、独立、立刻消除硬约束违反）
  → 阶段 3（持久化，大，需先有 ADR-0007）
  → 阶段 5（装备穿脱，与 3 无强耦合，可并行但不得同写 packages/）
```

（原阶段 4「时间跨度」已 DEFERRED——2026-11-11 用户裁决「不改引擎」，见附录 B；阶段编号保留不重排。）

阶段 2 放最前面不是因为它最大，而是因为它是**唯一一条在线违反硬约束**的问题，且改动面最小（7 个写入点 + 3 个出口）。

------------------------------------------------------------------------

## 1. 阶段 0 — 审查（只读）

- [x] **T0-01** 依赖：无｜需求：全部 16 条（审查输入）｜产出：`tasks/reports/R23-GAP-ANALYSIS.md`（2026-11-11 15:47 完成：语义零漂移、行号已回写 design §1；用户确认施工）
  逐条标注 16 条 ACTIVE 的现状（已实现 / 部分实现 / 缺失 / 需重构），并复核 `design.md §1` 的 `file:line` 是否仍与 HEAD 一致；对 §1 已列出的既知事实不必重复论证，只标"确认/已漂移+新位置"。
  完成定义：报告落盘；盘点逐条有结论；漂移项单列一节；**用户确认后方可进入阶段 1**。

## 2. 阶段 1 — ADR 与协议（仍不改实现）

- [x] **T1-01** 依赖：T0-01｜需求：`R-PS-01..07`｜产出：`docs/DECISIONS.md` **ADR-0007**
  按 `design.md §3.1` 落盘存档选型：为什么 JSON 文件而非 DB/新依赖；信封结构与 `schemaVersion`；模板指纹的作用与代价；加载失败策略；`WorldStateV2Schema` 双维护的缓解；与 `R-AR-03` 的关系；**数据目录裁决（2026-11-11 用户决定）：不得在 `apps/server` 下，默认仓库根 `data/worlds/`（按模块位置解析，不依赖 cwd），`LIFE_SIM_DATA_DIR` 环境变量可覆盖以支持挂载**。必须写明被否决的备选（`node:sqlite`、`better-sqlite3`、纯命令日志回放）与否决理由。
  完成定义：状态「已接受」；不触碰 ADR-0003；编号不占用 ADR-0005。

- [x] **T1-03** 依赖：T1-01｜需求：`R-VS-01/03`、`R-PS-02`｜产出：`specs/data/TEMPLATE_PROTOCOL_V2.md` 修订
  新增/扩展两处：① 新增「存档契约」章节（信封字段、`schemaVersion`、模板指纹算法、加载拒绝条件、数据目录环境变量）；② 新增「历史可见性」约定（三类可见性、缺省语义、三个玩家端出口；**事件无隐藏语义，OPEN_QUESTIONS #33 已裁决，不新增事件可见性条款**）。（原计划的时间跨度章节随 TS 组 DEFERRED 取消。）
  完成定义：每条新增约定都能映射到 Zod schema；不出现与 ADR-0001/0002 冲突的语义；不修改 R2.2 已验收章节的既有措辞。

## 3. 阶段 2 — 可见性收口

- [ ] **T2-01** 依赖：T1-03｜需求：`R-VS-01`、`R-VS-03`｜产出：`packages/shared/src/v2.ts`、`packages/game-core/src/v2/turn.ts`、`battle.ts`、`npc.ts`、`ending.ts`
  加 `HistoryVisibility` 与 `HistoryEntryV2.visibility?`；`isPlayerVisible()` 唯一判定；`pushHistory()` 的 `visibility` 改必填并补齐 7 个写入点（`npc.ts:63` 那处不走 `pushHistory`，需单独赋值）；事件来源写入点一律传 `"public"`（OPEN_QUESTIONS #33：事件无隐藏语义，`EventV2Schema` 不加字段），仅 `ending.ts:368` 按结局叙事掩码（`narrativeConfig.masked`，ADR-0006）继承。
  完成定义：typecheck 0；缺失可见性的调用点应报类型错误（用一次临时删除自证后还原）；既有测试全绿（老数据缺字段视为 public）。

- [ ] **T2-02** 依赖：T2-01｜需求：`R-VS-02`、`R-VS-04`｜产出：`packages/game-core/src/v2/history.ts`（新）、`projection.ts`、`archive.ts`、`apps/server/src/index.ts`
  新增 `playerVisibleEntries()` / `playerVisibleHistory()` 两个纯函数；三个出口统一走它：`V2TurnResult.playerVisibleHistory`（**先过滤再 `slice(-20)`**）、`GET /history`、归档响应；新增 `projectArchiveForPlayer()` 返回过滤后记录 + `hiddenHistoryCount`。
  完成定义：三出口行为一致；`assembleArchive()` 产出的 `ArchiveRecord` 仍保留全量（存档事实不受影响）。

- [ ] **T2-03** 依赖：T2-02｜需求：`R-VS-05`｜产出：`packages/game-core/src/v2/history-visibility.test.ts`
  构造含 `hidden` 事件 + `hidden` 结局的世界，对 `snapshot` / `turnResult` / `/history` / `/archive` 四个出口做递归扫描（命中 hidden 条目的 id 或 summary 片段即失败）；另测"全是 hidden 时玩家端为空列表"与"先过滤再截断"。
  完成定义：≥6 项用例；去掉过滤实现时该测试必须失败（反向自证）。

## 4. 阶段 3 — 存档持久化

- [ ] **T3-01** 依赖：T1-01｜需求：`R-PS-02`、`R-PS-03`｜产出：`packages/shared/src/v2-state.ts`（新）
  `WorldStateV2Schema`（`.strict()`，覆盖全字段含 `player.equipment` / `statuses` / `skills` / `inventory` / `npcs` / `flags` / `history` / `chains` / `pendingEvents` / `battle` / `termination` / `archived`）；双向类型断言把 schema 与 TS 接口的漂移变成编译错误。
  完成定义：`z.infer` 与 `WorldStateV2` 双向可赋值；一份真实快照通过校验；故意改坏任一字段被拒并给出字段路径。

- [ ] **T3-02** 依赖：T3-01、T1-01｜需求：`R-PS-01/02/03/05/06`｜产出：`apps/server/src/store.ts`、`apps/server/src/templates.ts`
  模板指纹（YAML 排序拼接 → sha256）；`persist()` 原子写（`.tmp` + `rename`，失败清 tmp 并抛错）；`save()` / `seal()` 内落盘；启动时扫目录逐个校验（parser → `schemaVersion` → 指纹 → `WorldStateV2Schema`），失败 `log.error` 跳过不阻断；归档世界加载后仍走既有 409 门禁。
  完成定义：强杀重启后状态不变；三类坏档（截断 / 版本不符 / 指纹不符）各 1 条 error 且不影响其它局；写失败时旧文件完好。

- [ ] **T3-03** 依赖：T3-02｜需求：`R-PS-04`｜产出：`apps/server/src/index.ts`
  `GET /api/worlds`（id / templateId / 玩家名 / turnIndex / 世界时间 + 格式化 / status / endingTitle?，按 `savedAt` 倒序）；`DELETE /api/worlds/:id`（删文件 + 删 Map 条目）。
  完成定义：三局不同状态分类正确；空目录返回空数组；删除后列表与磁盘一致。

- [ ] **T3-04** 依赖：T3-03｜需求：`R-PS-04`｜产出：`apps/web/src/api.ts`、`main.tsx`、`style.css`
  首屏「新建 + 我的世界」两段；列表项显示模板名 / 玩家名 / 轮次 / 状态徽标，点击进入；`localStorage` 的 `worldId` 失效时改为提示「这一局已不存在」并回列表（不再直接抛错）；归档世界只读展示结局。
  完成定义：刷新页面能回到上一次的世界；删除后刷新不再报错。

- [ ] **T3-05** 依赖：T3-02｜需求：`R-PS-07`｜产出：`packages/game-core/src/v2/store-replay.test.ts`
  同 seed 两局，一局每轮落盘并重新加载、一局常驻内存，各推进 10 轮后逐字段比对；另测 `JSON.stringify` 严格等价。
  完成定义：≥3 项用例；字段丢失（尤其 `flags` / `chains` / `firedEvents`）必须被这条测试抓到。

## 5. 阶段 4 — 时间跨度（⛔ 整阶段 DEFERRED，见附录 B）

> 2026-11-11 用户裁决：寿终不可达不是引擎能力缺失，是模板质量问题，**不改引擎**。原 T4-01..04 原文保留在附录 B；本轮不执行、不测试、不验收。

## 6. 阶段 5 — 装备穿脱

- [ ] **T5-01** 依赖：T1-03｜需求：`R-EQ-07`、`R-EQ-08`｜产出：`packages/game-core/src/v2/equipment-turn.ts`（新）、`turn.ts`、`apps/server/src/index.ts`
  `equipV2` / `unequipV2` 编排（`assertActive` → 纯函数穿脱 → 写回 → public 历史 → 投影，**不推进时间**）；`pushHistory` 从 `turn.ts` 提取为可复用工具；两个端点 + 错误码映射（409：`slot_full` / `slot_category_mismatch`；400：其余五种）。
  完成定义：七种错误码各有对应用例且状态不变；成功时 `worldTime` 不变、新增 1 条 public 历史；已终止/已归档世界返回 409。

- [ ] **T5-02** 依赖：T5-01｜需求：`R-EQ-09`｜产出：`packages/shared/src/v2.ts`、`packages/game-core/src/v2/projection.ts`
  背包投影补 `type` / `slot?` / `category?`（来自 `lookup.item()`，不含补正结果）。
  完成定义：装备与消耗品两类字段正确；键集合断言确保无补正字段泄漏。

- [ ] **T5-03** 依赖：T5-02｜需求：`R-EQ-07`｜产出：`apps/web/src/api.ts`、`main.tsx`、`style.css`
  背包里装备类显示「装备」、装备栏各条显示「卸下」；失败时展示错误码对应文案（如「槽位已满」）；成功后用返回快照替换。
  完成定义：界面上能完成一次完整的「装上 → 卸下 → 换上另一件」。

- [ ] **T5-04** 依赖：T5-01、T5-02｜需求：`R-EQ-10`｜产出：`packages/game-core/src/v2/equipment.test.ts`（扩充）
  属性断言：穿脱前后 `player.attributes` 逐字段相等；`effectiveAttributes()` 差值等于补正值；实例键集合不含补正字段。
  完成定义：≥4 项新增用例；不修改 R2.2 既有 25 项断言。

## 7. 阶段 6 — 验收与收尾

- [ ] **T6-01** 依赖：阶段 2–3、5｜需求：全部｜产出：命令输出与数字
  `pnpm typecheck` / `pnpm test` / `pnpm --filter @life-sim/shared test` / `pnpm --filter @life-sim/web build` 四命令；外加本轮 DoD 的三条端到端证据（重启续玩 / 历史无 hidden / 界面穿脱）。
  完成定义：四命令全绿；三条证据逐条有可复现步骤与输出片段。

- [ ] **T6-02** 依赖：T6-01｜需求：全部 16 条｜产出：`tasks/reports/R23-COMPLETION.md`
  逐条标注「通过 / 部分 / 延期」及证据（测试名或命令）；列出未完成项与风险；附「本轮新增/修改的文件清单」。
  完成定义：16 条全覆盖、无「未检查」项；风险章节诚实列出（含 `npc_action` 不分级、单机存档）。

- [ ] **T6-03** 依赖：T6-02｜需求：—｜产出：`PROJECT.md`
  更新迭代状态表：R2.3 完成、下一轮候选（阶段 8 / LLM / NPC 生命周期）、待决问题指向 `OPEN_QUESTIONS` #32/#33。
  完成定义：只改状态表，不另建第二份状态。

------------------------------------------------------------------------

## 8. 全局完成门槛（Definition of Done）

1. **16 条 ACTIVE** 需求均有测试或明确标注的延期理由。
2. `pnpm typecheck` 0 错误；`pnpm test` 全绿；`pnpm --filter @life-sim/shared test` 全绿；`pnpm --filter @life-sim/web build` 通过。
3. 三条端到端证据成立：① 强杀重启后同一 `worldId` 可继续推进；② 任意状态下三个出口均不含 `visibility !== "public"` 条目；③ 界面上可穿可卸且基础属性逐字段不变。
4. 无新增 npm 依赖；`game-core` 无世界观专名；无 `lifecycle.ts` / `Phase` / 阶段日志；时间推进路径零改动（TS 组 DEFERRED）。
5. ADR-0007 状态为「已接受」（ADR-0006 已于立项期落盘；ADR-0008 取消），ADR-0003 与 ADR-0005 未被占用或改动。
6. `DEFERRED` 的阶段 8 四项与附录 B 的 TS 五任务 / T4 四任务：**不执行、不测试、不计入本门槛**。

------------------------------------------------------------------------

## 附录 A：阶段 8 延期任务（⛔ DEFERRED，本轮不执行、不验收）

> 用户 2026-11-11 决定「阶段 8 延期」。以下四条从 `specs/iteration-2026-11-11/tasks.md` §9 **原文保留、编号不重排**，供下一轮直接恢复；本轮不派任务、不写测试、不计入 DoD。
>
> 延期带来一个已知缺口：`R-NFR-06`（跨模板验证）在本轮仍无证据，跨世界观只有 `jjk-2006` 一套。

- **T8-01（DEFERRED）** 依赖：阶段 3–6｜需求：R-NFR-05、R-NFR-06｜产出：三世界观模板补齐（JJK / Steins;Gate / 现代人生）
  完成定义：模板差异只通过配置/适配器表达，`game-core` 无世界观专名常量；Steins;Gate 本轮**不写穿越配置**（R3）。

- **T8-02（DEFERRED）** 依赖：T8-01｜需求：R-NFR-01、R-NFR-06、`design.md` §11｜产出：P1–P3、P5–P9 正确性属性回归套件（P4 随 A3 延期）
  完成定义：`pnpm typecheck` 0 错误、`pnpm test` 全绿，属性测试可追溯到需求编号。

- **T8-03（DEFERRED）** 依赖：T8-02｜需求：R-NFR-03、R-NFR-04｜产出：LLM 失败注入与可见性渗透测试
  完成定义：LLM 全链路不可用时仍能到 `ARCHIVED`；投影中永不出现 hidden/unknown 条目。
  > 注：其中「可见性渗透测试」已由本轮 `T2-03` **提前完成**；恢复 T8-03 时只需补 LLM 失败注入部分，不要重复实现。

- **T8-04（DEFERRED）** 依赖：T8-01..03｜需求：全部｜产出：`tasks/reports/R2-COMPLETION.md`
  完成定义：R2.2 口径的 45 条 ACTIVE 逐条标注「通过 / 部分 / 延期」及原因；另列 7 条 DEFERRED 为「延期（R3）」、6 条 RETIRED 为「本轮不做」。

## 附录 B：时间跨度延期任务（⛔ DEFERRED，2026-11-11 用户裁决「不改引擎」，本轮不执行、不验收）

> **裁决理由**：寿终不可达不是引擎能力缺失，是模板质量问题（jjk-2006 事件密度不足）。恢复前置：先完成模板内容密度治理（内容侧工作，另行立项），再重新评估是否需要跨度引擎。
> 原 `T1-02`（产出 ADR-0008）随之取消；ADR-0008 编号释放。

- **T1-02（DEFERRED / 取消）** 原：产出 `docs/DECISIONS.md` **ADR-0008**（双层时间分辨率）。恢复时按 `design.md` §4 留档分析重新起草。

- **T4-01（DEFERRED）** 依赖：T1-02、T1-03｜需求：`R-TS-01`、`R-TS-03`｜产出：`packages/shared/src/schema/world.ts`、`packages/game-core/src/v2/turn.ts`
  `time.spanSteps` 配置段与加载期校验；`advanceTurnV2` 识别 `mode: "fast"` + `span`（违规抛 `span_not_supported` / `span_exceeds_max`）；分片推进骨架；跨度结束统一做回复、年龄重算、终止边界。
  完成定义：1 个月跨度后 `worldTime` 前进 30 天、`turnIndex` 增加 30；跨寿限的那次跨度结束后 `status === "terminated"` 且 `ending` 非空；单步路径 `turnIndex + 1` 不变（既有断言不改）。

- **T4-02（DEFERRED）** 依赖：T4-01｜需求：`R-TS-02`｜产出：`packages/game-core/src/v2/turn.ts`、`span.ts`（如拆出）
  事件限流；NPC 行动抽样；逐片状态衰减改为跨度末一次结算；跨度内不触发 combat 事件。
  完成定义：30 天跨度内事件数 ≤ 上限、NPC 行动数 ≤ 抽样数、无孤立战斗；状态衰减结果与设计口径一致。

- **T4-03（DEFERRED）** 依赖：T4-02｜需求：`R-TS-04`、`R-TS-05`｜产出：`packages/game-core/src/v2/span-replay.test.ts`
  同 seed 同命令序列（含跨度）逐字段相等；脚本式用例跑到 `terminated` 并记录基线轮次。
  完成定义：确定性用例 ≥3 项；寿终路径真实走通，基线轮次记录在测试文件注释里。

- **T4-04（DEFERRED）** 依赖：T4-01｜需求：`R-TS-01`｜产出：`apps/web/src/api.ts`、`main.tsx`、`style.css`
  「投入一段时间」入口与结果摘要展示。
  完成定义：模板未启用跨度时该入口不出现；一次跨度后页面状态、日志、结局面板均正常。
