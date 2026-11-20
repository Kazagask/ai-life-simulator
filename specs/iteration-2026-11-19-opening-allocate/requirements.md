# 需求 · 开局加点

编号沿用 `R-<组>-<序号>`。全部 ACTIVE（无 DEFERRED）。

## R-AL-01 开局可抽点数并可分配（ACTIVE）

**当**模板声明了 `points` 参数与 `allocate` 节点，**系统应当**在开局向导里先让玩家抽（或选）
出本次可用点数，再进入加点界面，把点数分配到白名单属性上，全部用完后才能提交。

验收：

1. `budgetFrom` 指向的参数在本会话已落定为非负整数 ⇒ 加点界面显示的预算等于该值。
2. 该参数尚未落定（或不是非负整数）⇒ 推进/描述节点时报 `opening_allocate_budget_unavailable`，
   **不得**按 0 处理。
3. 未声明 `budgetFrom` ⇒ 预算取 `budget`。
4. 分配界面任何时候都可以提交；`remaining > 0` 时**先弹二次确认**（提示余额作废），确认后才推进（2026-11-19 修订）。

## R-AL-02 只有数值类属性可以加点（ACTIVE）

**系统应当**在模板加载期拒绝任何指向非数值属性（`enum` / `composite`）或未声明属性的加点目标。

验收：

1. `targets[].attribute` 不在 `attributes.order` ⇒ 拒载，路径 `opening.yaml: params[i].targets[j]`。
2. 目标是 `enum` 或 `composite` ⇒ 拒载，错误信息点名属性与 kind。
3. 目标是 `number`（含未声明 def 的缺省数值）或 `ladder` ⇒ 放行。
4. `min > max`、`min < 0` ⇒ 拒载。

## R-AL-03 分配结果必须合法（ACTIVE）

**当**玩家提交分配，**系统应当**校验四项：键在 `targets` 内、值为非负整数、落在 `[min,max]`、
合计不超过预算；任一不满足则以 400 拒绝并给出可诊断错误码。

验收：

1. 提交白名单之外的属性 ⇒ `opening_allocation_unknown_target`。
2. 提交小数或负数 ⇒ `opening_allocation_invalid_value`。
3. 低于 `min` ⇒ `opening_allocation_below_min`；高于 `max` ⇒ `opening_allocation_above_max`。
4. 合计 > 预算 ⇒ `opening_allocation_over_budget`；合计 < 预算**允许**（余额作废）。
5. 合法提交 ⇒ 会话前进到下一节点，`results` 里出现 `{ nodeId, allocation: { paramId: { attr: value } } }`（未点名的 target 补 0）。
6. target 不声明 `max` ⇒ 不设上限，可把全部预算加到同一项。

## R-AL-04 落点是增量，且可见（ACTIVE）

**当**开局 commit，**系统应当**把 `points` 按 `attribute += value` 写入玩家属性，并把每个非 0 项
计入「开局所得」。

验收：

1. 基础 5、分配 2 ⇒ 结果 7（不是 2）。
2. 复用角色路径（`self.kind = reuse`）同样在角色基础值上叠加。
3. 「开局所得」出现 `category: attribute`、`action: up`、`amount = 分配值` 的条目，`name` 是模板标签。
4. 分配 0 的属性不产生条目。

## R-AL-05 加点组件可复用（ACTIVE）

**系统应当**把加点 UI 做成独立组件，开局与未来的游戏内加点共用同一实现与数据契约。

验收：

1. 组件位于 `packages/rpg-ui`，从包入口导出，`apps/web` 通过包引用而非内联实现。
2. 组件 props 只含 `budget` / `targets` / `value` / `onChange` / `disabled`，不读全局状态、不发请求。
3. 组件头部注释写明「游戏内加点复用此组件」。
4. `targets[].label` 缺省回退属性 id；有 `style` 时属性名按样式渲染。

## R-AL-06 加点的快捷操作（ACTIVE）

**系统应当**在加点面板提供「MAX（单项填到上限）」与「随机（把余额撒进剩余空间）」两个快捷操作，
且随机只在前端发生。

验收：

1. 行内 `MAX` 把该项加到 `max` 或把余额用尽（先到者为准）；无 `max` 的目标直接吃掉全部余额。
2. `随机` 一次分配完余额，且每项都不超过 `max`、不低于 `min`。
3. `重置` 回到各目标的 `min`（缺省 0）。
4. 随机不消耗世界 RNG，不影响同 seed 回放（纯 UI）。

## R-AL-07 人生页透出属性（ACTIVE）

**当**玩家进入人生页，**系统应当**在顶部人物卡上展示属性胶囊（含 `enum` / `composite` 的展示文本与样式），
使「等级 / 生得术式 / 名誉」不必进个人页也能看见。

验收：

1. 人物卡出现 `ls-sheet-attrs` 容器，条目数 = 可见属性数（hidden 已由投影剔除）。
2. 文本属性显示 `display`（如「特级」「十种影法术」），并按样式着色。
3. `ladder` 属性附本档进度（「熟手 20/50」）。
4. 数值属性与文本属性同一行内可换行，不撑破竖屏。

## 追溯矩阵

| 需求 | 实现 | 测试 |
|---|---|---|
| R-AL-01 | `opening-dag.ts` `resolveBudget` / `describeNode` | `opening-allocate.test.ts` |
| R-AL-02 | `validateOpeningDag`（game-core） + `templates.ts` 调用 | `opening-allocate.test.ts` |
| R-AL-03 | `resolveStep` allocate 分支 | `opening-allocate.test.ts` |
| R-AL-04 | `commitOpening`（既有）+ `collectOpeningGains` | `opening-allocate.test.ts` |
| R-AL-05 | `PointsAllocator.tsx` + `main.tsx` | 类型检查 + CDP 实测 |
| R-AL-06 | `PointsAllocator.tsx`（MAX / 随机 / 重置） | CDP 实测 |
| R-AL-07 | `CharacterSheet.tsx`（属性胶囊） | CDP 实测 |
