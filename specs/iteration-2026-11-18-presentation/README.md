# 迭代：表现层（叙事追加 / 本轮收获 / 样式体系）（2026-11-18）

## 一句话

把「一回合发生了什么」从**只有事件卡上的几行字**，变成**可累积的叙事 + 可交互的收获清单**；
同时给模板一套**受控的样式词汇**（颜色 / 加粗 / 背景 / 预设动画），让「六眼」这类高品质补正
在全部出现面上自动是同一身彩虹，而不是每个前端各画一遍。

## 本轮范围

- **做**：
  1. 叙事区**按回合追加**：每回合产出一条叙事段（LLM 修饰过就用 LLM 的），旧回合不再被替换。
  2. 流式呈现**统一**：没有 LLM 的回合也要有同样的逐字呈现，不再「一下子全出来」。
  3. 转盘落定那张卡改为**本轮收获**：列出本回合真实发生的效果（属性增减、补正得失、技能、
     物品 / 装备），条目可点开详情。
  4. 装备 / 消耗品 / 技能 / 补正**详情里显示效果**（不只是一句 description）。
  5. **样式体系**：模板写 `style`，引擎给预设（`rainbow` / `gold` / …），也允许 `color` /
     `background` / `bold` / 动画枚举；品质 → 样式的映射由模板声明。
  6. 补正点击 → **毛玻璃**详情浮层。
  7. 固定效果（`cannot_act` 等控制语义）在效果列表里**下划线**呈现。
- **不做**（本轮明确排除）：
  - 叙事文本内联着色（技能名 / 人名逐字染色）——需要叙事标记语言，下一轮再谈；
  - 任意 CSS 字符串（模板只能填白名单里的颜色 / 枚举动画）；
  - 装备动态补正的「实时数值」展示（动态补正按结算上下文求值，详情里只描述其规则）；
  - 战斗内表现层的重做（沿用现状，只接样式）；
  - LLM 侧新工具 / 新提示词（叙事分段沿用现有 trace 通道）。
- **DEFERRED**：叙事区全文检索 / 折叠分页、跨回合战报、样式编辑器 UI。

## 与现行规格的关系

- 权威：`AGENTS.md` + `specs/SPEC.md` + `docs/REFACTOR-NOTES.md`。上一轮
  `specs/iteration-2026-11-18-random-opening/` 已收口（T0–T6 全部完成）。
- 协议级改动（样式词汇、效果摘要、回合增量、叙事分段）按 G2 **先写 ADR**：
  见 `docs/adr/60-表现层与仪器.md`（状态：提议）。
- **schemaVersion 保持 5**：本轮只加「可选投影字段 + 展示域声明」，不改 `WorldStateV2`
  的必填结构；旧档可直载（模板指纹变化照旧由模板版本承担）。

## 现状事实（读代码得到，不是猜测）

- 叙事区读的是 `GET /api/worlds/:id/narrative?fromTurn=0`（`apps/web/src/api.ts:550`），
  服务端按 `state.traceRef` 之外**全量 trace** 读回；但**模板 / mock 回合根本不写 trace**
  （`apps/server/src/narrative/generate.ts` 里 `source === "template"` 直接短路），
  所以「没有 LLM 就没有叙事」，实测某局跑完开局 + 1 回合，`blocks` 数为 0。
- 「命运落定」是 `apps/web/src/main.tsx:1885` 的结算卡，只在**转盘**回合出现，
  内容只有「事件标题 + 落定标签」，不含任何效果。
- `StatusVM` / `SkillVM` 只有 `id/name/stacks` 与 `id/name/description/kind`
  （`packages/shared/src/contract/view-model.ts`），**没有效果字段，也没有 quality/style**。
- 装备/物品有 `quality`（自由字符串 + 模板白名单 `equipment.qualities`），但没有样式；
  补正/技能连 `quality` 都没有。
- 补正是「单定义双面」（simulation / combat），控制语义是 `control: [cannot_act, ...]`
  （`packages/shared/src/schema/status-effect.ts:16`）——这就是「固定效果」的来源。

## 给 Agent 的读法

1. 先读 `AGENTS.md`、`specs/SPEC.md`，再读本目录 requirements → design → tasks。
2. 一次只做一个 `T<阶段>-<序号>`，按 tasks.md 依赖顺序；**T0 的 ADR 未裁决前不写实现代码**。
3. 不确定的产品规则写 `docs/OPEN_QUESTIONS.md`；本轮待裁决点见 design §7。
4. 前端改动必须同时跑 `pnpm --filter @life-sim/web build`；涉及投影的改动必须补
   「存档 → 重新解析」类回归（上一轮的坏档教训）。

## 状态（2026-11-18）

**已实施完成**（T0–T9）。ADR-002 六条决策全部落地，`pnpm test` 46 文件 / 292 例全绿，
typecheck 与 web build 通过，浏览器走查通过（详见 `tasks.md` 末尾「实施记录」）。
