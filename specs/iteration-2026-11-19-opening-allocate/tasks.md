# 任务 · 开局加点

依赖顺序：T1 → T2 → T3 → T4 → T5 → T6 → T7。每个任务完成即可运行、可测试。

## T1 shared：参数与节点 schema

- 产出：`packages/shared/src/schema/opening.ts`
- 内容：`OpeningParamKindSchema` 加 `number`；`OpeningParamDeclSchema` 加 `budgetFrom` / `targets[].label` / `targets[].style`；
  `points` 参数必须有 `budget` 或 `budgetFrom`；`allocate` 节点必须有 `param`。
- 完成定义：`pnpm typecheck` 通过；现有模板仍能加载（alloc 字段全可选）。

## T2 game-core：加载期校验

- 产出：`packages/game-core/src/v2/opening-validate.ts`（新）、`apps/server/src/templates.ts`
- 内容：`validateOpeningDag(dag, template)`：entry/goto 存在、param id 唯一、target 属性存在且数值类、
  `budgetFrom` 指向 `number` 参数、allocate 节点 `param` 指向 `points` 参数。
- 完成定义：`template_invalid` 带字段路径；正常模板不受影响。

## T3 game-core：预算解析 + 运行期校验

- 产出：`packages/game-core/src/v2/opening-dag.ts`
- 内容：`resolveBudget`；`describeNode` 支持 ctx（label/style）；allocate 分支四项校验 + 错误码。
- 完成定义：`opening-allocate.test.ts` 覆盖 R-AL-01/03。

## T4 game-core：开局所得

- 产出：`packages/game-core/src/v2/opening-dag.ts`（`collectOpeningGains`）
- 内容：`points` 每个非 0 项产出一条 attribute up 条目。
- 完成定义：测试断言条目 name/amount。

## T5 rpg-ui：PointsAllocator 组件

- 产出：`packages/rpg-ui/src/PointsAllocator.tsx`、`packages/rpg-ui/src/index.ts`、`styles.css`
- 内容：受控组件、步进/到界禁用/剩余点数/重置/可选 onConfirm；头部注释写明游戏内复用。
- 完成定义：typecheck + web build 通过。

## T6 web：开局向导接入

- 产出：`apps/web/src/main.tsx`、`apps/web/src/api.ts`（类型）
- 内容：删掉内联 number input，改用组件；节点切换时重置已分配值。
- 完成定义：CDP 实测可完成开局并看到「开局所得」。

## T7 模板 / 测试 / 文档

- 产出：`specs/data/templates/jjk-2006/2.0.0/opening.yaml`、`test/unit/opening-allocate.test.ts`、
  既有三个 DAG 测试 helper、`docs/DECISIONS.md` 索引、`specs/SPEC.md`
- 完成定义：全量 `pnpm test` 绿；jjk 开局能抽点、加点、提交。

## 实施记录（2026-11-19）

- **T1 shared**：`OpeningParamKindSchema` 增 `number`；`OpeningParamDeclSchema` 增 `budgetFrom` /
  `targets[].label` / `targets[].style`，并 superRefine：points 必须有 `budget|budgetFrom`、
  `budgetFrom != id`、targets 非空、`min >= 0`、`min <= max`；`OpeningBranchNodeSchema` 要求
  allocate 必须带 `param`（非 allocate 不得带）。
- **T2 加载期**：新增 `game-core/v2/opening-validate.ts`（纯函数，返回 issue 列表）；
  `templates.ts` 在 template+ui 就绪后调用，失败抛 `opening_invalid: <path>: <msg>`。
  校验：entry/goto 存在、node/param id 唯一、target 属性存在且 `number|ladder`、
  `max ≤ caps`、样式 id 合法、字面预算 ≤ 所有 max 之和、`budgetFrom` 指向 `number`、
  allocate 指向 `points`。
- **T3 内核**：`resolveAllocationBudget`（含 `budget_unavailable`）、`describeNode(dag, session, ctx?)`
  下发 label/style、allocate 分支四项校验 + 明确错误码；补齐 min 漏填的绕过（先展开成全量再校验）。
- **T4 开局所得**：`collectOpeningGains` 增 `points` 分支（非 0 才出条目，带 target 的 label/style）。
- **T5 组件**：`packages/rpg-ui/src/PointsAllocator.tsx`（受控、步进、到界禁用、剩余点数、
  重置、可选 onConfirm；头部注释写明游戏内复用）+ 导出 + `styles.css`；
  删掉 `apps/web/src/style.css` 的废弃 `.alloc-grid`。
- **T6 前端**：`main.tsx` 改用组件；`api.ts` 类型补 `label` / `style`；切到新的加点节点时清空已分配值。
- **T7 模板**：jjk-2006/2.0.0 增 `talentRoll`(number) / `talentPoints`(points, budgetFrom) 与
  `n12b-talent`(roll 3/4/5/6，权重 4/4/2/1) / `n12c-allocate` 两个节点（插在 n12-fate 与 n13-entrance 之间）。
- **测试**：新增 `test/unit/opening-allocate.test.ts` 9 例；`jjk2006-dag` / `attribute-types` /
  `presentation` 三个走查 helper 补 allocate 分支。
- **验证**：
  - `pnpm typecheck` 0 错；
  - `pnpm test` **54 文件 / 364 例全绿**（新增 9 例）；
  - `pnpm --filter @life-sim/web build` 通过；
  - API 实测（seed 42）：allocate 节点 `budget=3`、targets 带「咒力/智力/体术/敏捷」与
    `style.preset=purple`；提交 `{grade:1}` ⇒ 400 `opening_allocation_unknown_target: grade`；
    合法提交 ⇒ 201，commit 后 `cursedEnergy 13→16`，gains 出现「咒力 +3（紫）」；
  - CDP 实测：第 16 步进入加点面板 → 咒力 +3 后「+」禁用、`−` 可回退、重置归零、
    余额非 0 时确定按钮显示「还剩 N 点未分配」且禁用；分完 3 点后提交 → 最终面板「本轮收获」出现咒力 +3。

## 2026-11-19 追加修订（用户验收反馈）

1. **属性收获没吃样式**：`TurnGainsCard` 对 `category === "attribute"` 只渲染纯文本，
   行上虽然有 `ls-box--*` 边框，名字/值仍是默认色（「等级 特级」看起来是灰的）。
   改为 `StyledName` 渲染 name 与 value；CDP 实测「等级 一级」紫色、「生得术式」蓝色。
2. **加点支持不设上限**：`targets[].max` 缺省即无上限（内核对 `max === undefined` 跳过检查），
   新增测试「不设 max 的目标可以吃下全部预算」；UI 的提示文案为「无上限」。
3. **快捷操作**：每行新增 `MAX`（填到上限或用尽余额），头部新增「随机」（纯前端洗牌撒点）与「重置」。
4. **允许放弃余额**：内核 `sum !== budget` → `sum > budget`（错误码 `opening_allocation_over_budget`）；
   余额未分完时「确定分配」不再禁用，点击弹二次确认浮层（`role="dialog"`，文案提示余额作废）。
   ADR-004 D4、requirements R-AL-01/03、SPEC 1.9 同步修订。
5. **人生页透出属性**：`CharacterSheet` 增属性胶囊行（`ls-sheet-attrs`），吃投影下发的
   label / display / style；ladder 附本档进度。实测人生页显示「等级 特级 / 生得术式 无下限术式 /
   名誉 默默无闻」等 9 个胶囊，卡片高度 262px。
- **验证**：`pnpm test` **54 文件 / 365 例全绿**（+1 例）；typecheck 0 错；web build 通过；
  CDP 实测随机（1/0/2/0）、MAX（咒力 +3）、二次确认浮层、按钮等宽不折行。
