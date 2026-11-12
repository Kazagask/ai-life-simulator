# R2.6 迭代 · 关系图谱 + 时间适配器落地

> 本文件是 R2.6 本轮的**范围、冲突对齐与读法**说明，不是产品规格，也不是代码。
> 权威内容始终在 `AGENTS.md`、`specs/`（含本迭代四件套）、`docs/DECISIONS.md` 与代码里。

## 0. 本轮缘起（用户指令）

2026-11-12 用户指示：「先做悬着没落地的 包括2.6关系图谱 时间适配器」。

所指「悬着没落地」即 R2.5 评审中明确裁定**顺延到下一期首批**的两块（见 `OPEN_QUESTIONS.md` #39/#43/#44/#45 与 `design.md` §0.3/#3、PROJET.md §2「下一步」）：

- **WS-A 时间适配器落地**：真实公历（②③）+ 字符串 `TimeSpec` 字面量 + 年号/纪元渲染。
- **WS-B 关系图谱**：NPC↔NPC 关系图 + 多跳中文称谓（`relationship.js` 分层复用）+ 关系来源/可见性。

## 1. 范围

| 包含 | 说明 |
|---|---|
| WS-A 时间适配器 | `CalendarAdapter` 三方法落地（`toMinutes`/`parseTimeSpec`/`format`/`ageAt` 按 `preset` 分支）；模板 `time.calendar.preset` 切换；②真实公历 + ③自定义历/年号；字符串 TimeSpec 字面量解析；引擎换算统一经适配器。 |
| WS-B 关系图谱 | `RelationEdge` 边模型（NPC↔NPC + NPC↔玩家）存实例层；默认不认识（R-OP-05）；`v2/relations.ts` 图内核（BFS 最短路径/环检测/断代）；`relationship.js` 出多跳中文称谓；关系可见性投影。 |

| 明确**不含**（DEFERRED / RETIRED，只登记不实现） | 依据 |
|---|---|
| NPC 生命周期状态机（六阶段） | ADR-0004 已 RETIRED，用户已定不引入 |
| 时间穿越 / 世界线 | ADR-0005 留 R3 |
| 次要角色清理/降级语义 | OPEN_QUESTIONS #23 未决，本轮不碰 |
| 运行时按 seed 生成配置层模板定义 | #46 用户明确「不做」 |
| `worldTime` 数值上界 / `{epochIndex,...}` | #45 保持现状，本轮不加 |

## 2. 阅读顺序（固定）

1. `AGENTS.md`（§0 工作方式 / §1 架构边界 / §4 交付 / §5 禁止事项）—— 硬约束。
2. 本 `README.md`（范围与读法）。
3. `requirements.md`（EARS + 验收 + 追溯）。
4. `design.md`（现状盘点 / 实施决策 / 数据模型 / 文件计划 / 测试计划）。
5. `tasks.md`（阶段 / 依赖 / 完成定义）。
6. `docs/DECISIONS.md` **ADR-0013 / ADR-0014**（本轮 G2 门禁产物，草案待审）。

## 3. 门禁状态（Spec Coding 六道）

| 门禁 | 状态 | 说明 |
|---|---|---|
| G1 差距报告 | **待用户确认** | 本 README + `design.md` §「现状盘点」即阶段 0 差距报告；确认前不写实现代码。 |
| G2 核心模型/依赖 ADR | **已写入草案** | ADR-0013（日历）、ADR-0014（关系图 + `relationship.js` 依赖）已落 `DECISIONS.md`，待 G1 评审通过转「已通过」。 |
| G3 单任务 | 将遵守 | 实施时一次只做一个 `T-*`；WS-A / WS-B 互不耦合，可先后或并行窗口。 |
| G4 单 Agent 写 packages/ | 将遵守 | 实施期同一时刻仅一个 Agent 改 `packages/`。 |
| G5 DEFERRED 只登记 | 遵守 | 上表「不含」项不实现、不测试、不派任务。 |
| G6 不确定写 OPEN_QUESTIONS | 遵守 | 实施中任何产品规则歧义写入 `docs/OPEN_QUESTIONS.md`，不伪造共识。 |

## 4. 复用说明（避免重排编号 / 重复设计）

R2.5 `specs/iteration-2026-11-11-r25/design.md` 已写好两块的可落地设计：

- 日历：§3.5（三种时间模型与 `CalendarAdapter` 接口定死）、§4.4（年号/纪元显示）、§7 Q-R25-05 标注「下期首办」。
- 关系图：§4.5（谱系分层复用 `relationship.js` + 自研图内核）、§644「R2.6：NPC 生命周期与关系」、§570 `relationLog`/§574 `V2Npc` 字段规划。

**本迭代 `design.md` 不再重述上述设计，只补「本次实施决策 + 文件级计划 + 测试计划」，并显式引用上述章节。** 编号不重排；R2.5 已关闭/延期需求保留原编号与原文。

## 5. 交付判定（完成定义总览）

- WS-A：jjk-2006 声明 `calendar.preset: gregorian` 后，`format` 走真实公历（含闰年/月长）、`parseTimeSpec("3d")` 解析、`toMinutes` 经适配器；无 `calendar` 模板零迁移。
- WS-B：世界初始化后存在 NPC↔NPC 关系边；查询「五条↔夏油」经 `relations.ts` + `relationship.js` 得确定性中文称谓；未显式建立的关系默认 `unknown` 不进玩家投影。
- 全量 `pnpm typecheck` 0 错；game-core / shared 测试全绿；新增正常/边界/无效输入用例。
