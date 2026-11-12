# R2.6 设计 · 关系图谱 + 时间适配器落地

> 本文件只补「本次实施决策 + 文件级计划 + 测试计划」。**深设计见 R2.5 `specs/iteration-2026-11-11-r25/design.md`**：日历 §3.5/§4.4、关系图 §4.5/§570/§574/§644。编号不重排。

## 1. 现状盘点（阶段 0 差距报告）

| 能力 | 现状（R2.5 末） | R2.6 缺口 |
|---|---|---|
| 历法 | `CalendarAdapter` 接口已定死，`toMinutes`/`parseTimeSpec` 仅 seam；`createTimeAdapter` 只走 `UNIT_MINUTES` 近似（30d 月/365d 年）。`format` 固定 `startYear+years年…`（`time.ts:95-104`）。 | ②③ 真实公历/自定义历+年号未实现；字符串 TimeSpec 未解析；引擎换算部分仍直读 `UNIT_MINUTES`。 |
| 模板历法配置 | `WorldTemplateV2.time` 仅 `defaultStep`/`lifeStageSteps`/`lifeStages`，**无 `calendar` 字段**（`world.ts:101-122`）。 | 需加 `calendar.preset`/`era`/`months`/`leapRule` schema。 |
| 关系 | `CharacterSchema.relationship` 单值标量 `-100..100`（NPC→玩家）（`character.ts:56`）；`npc.ts` 只读该标量。无图、无来源/档位/可见性。 | 需 `RelationEdge` 图、NPC↔NPC、`relationship.js` 称谓、默认不认识。 |
| 关系依赖 | 无 `relationship.js` 依赖（`package.json` game-core 未引）。 | G2：引入前须 ADR（已写 ADR-0014 草案）。 |

## 2. 实施决策（与 ADR 对齐）

- **WS-A**：实现 `approx`/`gregorian`/`custom` 三 preset；`createTimeAdapter` 工厂按 `preset` 返回对应实现；`toMinutes`/`parseTimeSpec`/`format`/`ageAt` 全部经适配器；引擎内 `TimeSpec→minutes` 统一经 `toMinutes`（保留 `approx` 内部用 `UNIT_MINUTES`）。无 `calendar` ⇒ `approx`（零迁移）。
- **WS-B**：关系统一为 `RelationEdge` 边；图内核自研 `v2/relations.ts`（BFS 最短路径、环检测、`ancestorGaps` 断代、师承 `titleRules`）；`relationship.js` 仅用于「已知亲属跳数路径→中文称谓」纯算法；保留 `npc.relationship` 标量作 NPC→玩家便捷只读投影（初始化由种子边生成）。默认 `unknown`。

## 3. 数据模型

### 3.1 日历配置（`shared/src/schema/world.ts`）
```ts
const CalendarConfigSchema = z.object({
  preset: z.enum(["approx", "gregorian", "custom"]).default("approx"),
  era: z.object({ name: z.string(), epochStartMinute: z.number().int() }).optional(),
  months: z.array(z.object({ name: z.string(), days: z.number().int().positive() })).optional(),
  leapRule: z.enum(["gregorian", "none"]).optional(),
}).optional(); // 挂在 time 下；缺省 = approx
```
`superRefine`：`custom` 必须声明 `months`（≥1 项）；`months` 天数合法；`gregorian` 忽略 `months` 走真实历法。

### 3.2 关系边（`shared/src/schema/relation.ts` 新增）
```ts
const RelationEdgeSchema = z.object({
  from: z.string(), to: z.string(),
  kind: z.string(),                       // kinship|master|faction|rivalry|...
  source: z.string().optional(),           // 建立来源（模板/事件 id）
  visibility: z.enum(["known", "inferred", "unknown"]).default("unknown"),
  tier: z.number().int().optional(),       // 代数/亲疏档位
  value: z.number().min(-100).max(100).optional(), // 复用 -100..100 语义
});
```
`WorldStateV2` 增 `relations: RelationEdge[]`（实例/事实层）。`CharacterSchema.relationship` 标量保留（初始化便捷 + 向后兼容只读）。

## 4. 接口形状

### 4.1 `CalendarAdapter`（扩展 `time.ts`）
- `createTimeAdapter(template)` 按 `template.time.calendar?.preset` 分发。
- `format(minute)`：gregorian 走 `Date`-free 公历算法（自研闰年/月长表）；custom 走 `months[]`/`era`；approx 保持现状。
- `toMinutes(amount, from)`：`approx` ⇒ `UNIT_MINUTES`；gregorian/custom ⇒ 按历法累加（支持 `parseTimeSpec` 结果）。
- `parseTimeSpec(spec, from)`：正则解析 `(\d+)(y|mo|w|d|h|m)` 复合 + 历法日期字面量；非法抛错。
- `ageAt(minute)`/`elapsedYears(minute)`：按 preset 生日规则。

### 4.2 `relations.ts`（新增 `game-core/src/v2/relations.ts`）
```ts
addEdge(state, edge: RelationEdge): void
removeEdge(state, from, to, kind?): void
queryEdge(state, from, to): RelationEdge | undefined
shortestPath(state, from, to, kind?): string[]   // BFS，返回 id 序列
kinshipTerm(state, from, to): string              // 路径→relationship.js→中文称谓；不唯一取最短+字典序；库无结果回退粗称谓
detectCycle(state, from): boolean
freezeOnDeath(state, npcId): void                 // 失联/死亡冻结相关边（Q-R25-08）
```

## 5. 文件级计划

| 文件 | 改动 | 归属 |
|---|---|---|
| `packages/shared/src/schema/world.ts` | +`CalendarConfigSchema`，挂 `time.calendar`；`superRefine` 校验 | WS-A |
| `packages/shared/src/schema/relation.ts` | 新增 `RelationEdgeSchema` + 类型 | WS-B |
| `packages/shared/src/schema/state.ts`（`WorldStateV2`） | +`relations: RelationEdge[]` | WS-B |
| `packages/shared/src/schema/character.ts` | `relationship` 标量保留；`characters.yaml` 可声明 `relations` 初始边 | WS-B |
| `packages/game-core/src/v2/time.ts` | `createTimeAdapter` 三 preset 分支；`toMinutes`/`parseTimeSpec`/`format`/`ageAt` 实现 | WS-A |
| `packages/game-core/src/v2/relations.ts` | 新增图内核 + `relationship.js` 适配 | WS-B |
| `packages/game-core/src/v2/engine.ts` | `adjustRelation` 扩双向；+`addRelationEdge`/`freezeRelationsOnDeath`；`TimeSpec→minutes` 走 `toMinutes` | WS-A/WS-B |
| `packages/game-core/src/v2/npc.ts` | 关系图查询接入效用/条件；默认 `unknown` | WS-B |
| `packages/game-core/src/v2/projection.ts` | `projectNpc` 关系可见性投影（`known`/`inferred` 才暴露） | WS-B |
| `packages/game-core/package.json` | 锁版本引入 `relationship.js`（ADR 通过后） | WS-B |
| `specs/data/templates/jjk-2006/world.yaml` | 声明 `time.calendar: { preset: gregorian, startYear: 2006 }` | WS-A |
| `specs/data/templates/jjk-2006/characters.yaml` | 声明初识关系边（五条↔夏油↔硝子 互识等） | WS-B |
| `apps/web` | 时间展示走 `format`（零改动）；关系面板按需消费 `relations` | 收尾 |

> **指纹影响**：`world.ts`/`relation.ts`/`state.ts` 为 breaking 变更 → `schemaVersion=2` 旧档一致拒载（与 R2.5 策略一致）。jjk-2006 随实施迁移。

## 6. 测试计划（AGENTS.md §4）

| 类 | WS-A 用例 | WS-B 用例 |
|---|---|---|
| 正常 | gregorian 闰年 2 月 29 日 `format` 正确；`parseTimeSpec("3d")`=4320；`toMinutes` 经适配器 | 五条↔夏油已知路径得确定性中文称谓；最短路径 BFS 正确 |
| 边界 | `approx` 与现状字节一致（回归）；custom 月长自定义；`ageAt` 生日未到不加岁 | `ancestorGaps` 断代回退粗称谓；环检测正确；`freezeOnDeath` 冻结边 |
| 无效 | 非法 `parseTimeSpec` 抛可诊断错误；`custom` 未声明 `months` 加载期拒载 | `relationship.js` 无结果回退不抛；`unknown` 边不进投影 |
| 类型 | `pnpm typecheck` 0 错 | 同左 |

## 7. 风险与开放项（G6：写入 OPEN_QUESTIONS 不伪造）

- 自定义历 `months[]` 总天数与 `startYear` 语义若需「年内偏移」表达，下一期随 #45 决策。
- NPC 关系变化是否主动触发 NPC 行动（增量说明 §4.1）：本轮只建查询/投影，触发留接口。
- `relationship.js` 数据表覆盖度外的罕见路径：回退粗称谓，不静默、不抛异常。
