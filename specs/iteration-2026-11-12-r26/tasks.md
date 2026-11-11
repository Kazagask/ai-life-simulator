# R2.6 任务 · 关系图谱 + 时间适配器落地

> G3：一次只做一个 `T-*`，不擅自扩展范围。依赖列表明先后顺序；完成定义（DoD）逐条 PASS 方可标记 completed。
> 关联 ADR：ADR-0013（WS-A）、ADR-0014（WS-B）。深设计见 `design.md` 与 R2.5 `design.md` §3.5/§4.5/§644。

## WS-A 时间适配器落地

### T-A1 schema：日历配置
- **输入**：`packages/shared/src/schema/world.ts`。
- **产出**：`CalendarConfigSchema`（`preset`/`era`/`months`/`leapRule`），挂 `time.calendar`；`superRefine` 校验（`custom` 必声明 `months`、天数合法）。
- **依赖**：无（ADR-0013 已草案）。
- **DoD**：`z.infer` 类型正确；缺省 `approx`；`custom` 无 `months` 加载期报错；`pnpm typecheck` 0 错。

### T-A2 CalendarAdapter：gregorian 实现
- **输入**：`packages/game-core/src/v2/time.ts`。
- **产出**：`createTimeAdapter` 按 `preset` 分发；`format`/`ageAt`/`elapsedYears` 走自研公历（闰年/月长表，`Date`-free）；`toMinutes` gregorian 分支。
- **依赖**：T-A1。
- **DoD**：2006 起算闰年/月长正确；生日未到不加岁；`pnpm` 测试新增 gregorian 正常/边界用例通过。

### T-A3 CalendarAdapter：custom 年号/纪元
- **输入**：`time.ts`。
- **产出**：`custom` 走 `months[]`/`leapRule`；`format` 渲染 `era.name` + 年内偏移；`toMinutes`/`ageAt` 按自定义月长。
- **依赖**：T-A2。
- **DoD**：年号渲染正确；自定义月长累加无误；异常配置加载期拒载。

### T-A4 parseTimeSpec + 引擎换算路由
- **输入**：`time.ts`（`parseTimeSpec`）、`engine.ts`（所有 `TimeSpec→minutes` 改走 `toMinutes`）。
- **产出**：复合时长 `3d`/`2h30m`/历法日期字面量解析；引擎 `enqueueScheduled`/`delay`/`timeCost`/`advanceBy` 统一经适配器。
- **依赖**：T-A2/T-A3。
- **DoD**：`parseTimeSpec("3d",0)===4320`、`parseTimeSpec("2h30m",0)===150`；非法字面量抛可诊断错；`approx` 下结果与 R2.5 回归一致。

### T-A5 模板接入 + 验收
- **输入**：`specs/data/templates/jjk-2006/world.yaml`、`apps/web` 时间展示。
- **产出**：jjk-2006 声明 `time.calendar: { preset: gregorian, startYear: 2006 }`；web 走 `format` 零改动验证。
- **依赖**：T-A4。
- **DoD**：`pnpm dev` 下开局时间走真实公历；全量 game-core/shared 测试绿；`pnpm typecheck` 0 错。

## WS-B 关系图谱

### T-B1 schema：RelationEdge + 状态层
- **输入**：`packages/shared/src/schema/relation.ts`（新）、`state.ts`（`WorldStateV2.relations`）、`character.ts`（`relationship` 标量保留 + 可选 `relations` 初始声明）。
- **产出**：`RelationEdgeSchema`；状态层 `relations: RelationEdge[]`。
- **依赖**：无（ADR-0014 已草案）。
- **DoD**：schema 校验通过；`pnpm typecheck` 0 错；旧模板无 `relations` 不报错。

### T-B2 relations.ts：图内核
- **输入**：`packages/game-core/src/v2/relations.ts`（新）。
- **产出**：`addEdge`/`removeEdge`/`queryEdge`/`shortestPath`(BFS)/`detectCycle`/`ancestorGaps` 断代/`freezeOnDeath`（纯函数，确定性）。
- **依赖**：T-B1。
- **DoD**：最短路径/环检测/断代单元用例通过；纯函数无副作用；`pnpm` 测试绿。

### T-B3 relationship.js 适配：多跳中文称谓
- **输入**：`relations.ts`、`package.json`（锁版引入 `relationship.js`）。
- **产出**：已知亲属跳数路径 → 关系链记号 → `relationship.js` 出中文称谓；不唯一取最短+字典序；库无结果回退粗称谓（不抛、不静默）。
- **依赖**：T-B2（ADR-0014 通过后引依赖）。
- **DoD**：五条↔夏油（已知路径）得确定性称谓；罕见路径回退粗称谓；确定性（同输入同输出）。

### T-B4 效果 DSL：关系边操作
- **输入**：`engine.ts`（`EffectSchema` + `applyEffectsV2`）。
- **产出**：`adjustRelation` 扩 `fromId`/`toId` 双向；新增 `addRelationEdge`/`freezeRelationsOnDeath`。
- **依赖**：T-B1/T-B2。
- **DoD**：事件效果可建/改/冻结关系边；`unknown` 边不被误建为 known；`pnpm` 测试绿。

### T-B5 NPC 查询 + 投影
- **输入**：`npc.ts`（关系图查询接入效用/条件）、`projection.ts`（`projectNpc` 仅暴露 `known`/`inferred` 边）。
- **产出**：NPC 行动效用可基于关系边；默认 `unknown` 不进玩家投影（R-OP-05）。
- **依赖**：T-B3/T-B4。
- **DoD**：未声明关系默认 `unknown`；API 返回 `relations` 不含 `unknown`/`hidden`；`hidden` 来源不泄露。

### T-B6 模板接入 + 验收
- **输入**：`specs/data/templates/jjk-2006/characters.yaml`。
- **产出**：声明初识关系边（五条↔夏油↔硝子 互识等）；新建世界后 `state.relations` 含声明边并通过 `kinshipTerm` 查询。
- **依赖**：T-B5。
- **DoD**：初始化后关系图可达；端到端查询得确定性称谓；全量测试绿 + `pnpm typecheck` 0 错。

## 完成总览

| 流 | 任务 | 状态 |
|---|---|---|
| WS-A 日历 | T-A1 → T-A2 → T-A3 → T-A4 → T-A5 | pending |
| WS-B 关系图 | T-B1 → T-B2 → T-B3 → T-B4 → T-B5 → T-B6 | pending |

> 提交颗粒度：每个 `T-*` 一个 commit，信息注明任务 ID 与需求编号（R-CAL-*/R-REL-*）。
