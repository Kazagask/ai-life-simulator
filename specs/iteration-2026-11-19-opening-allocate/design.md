# 设计 · 开局加点

## 1. 现状（实施前）

| 层 | 已有 | 缺 |
|---|---|---|
| `shared/schema/opening.ts` | `points` 参数、`budget`、`targets`、`mode: allocate` | `budgetFrom`、`number` kind、points 参数的必填校验 |
| `game-core/opening-dag.ts` | allocate 分支、`points` 落点、`budget` 校验 | 白名单外的键、整数/负数、动态预算、label/style、gains |
| `apps/server` | `/api/openings/:id/step` 已收 `allocate` | 校验错误码细化 |
| `apps/web` | 一排裸 number input | 组件化、样式、上限提示、重置 |
| 模板 | 无 | 没有任何模板声明 allocate 节点 |

## 2. 数据模型

```ts
// OpeningParamKindSchema
z.enum([... , "number"])            // 新增：开局期标量，不落世界字段

// OpeningParamDeclSchema
budget?: number                     // 既有
budgetFrom?: string                 // 新增：指向另一个 param id（kind 必须是 number）
targets?: Array<{
  attribute: string;
  min?: number;
  max?: number;
  label?: string;                   // 新增：覆盖 attributes.labels
  style?: string;                   // 新增：样式 id（STYLE_PRESET_IDS），用于属性名着色
}>
```

schema 层只做「形状 + 自身一致性」：`kind === "points"` 必须至少有 `budget` 或 `budgetFrom`；
`budgetFrom !== id`；`min ≤ max`、`min ≥ 0`。跨文件引用（属性是否存在、kind 是否数值）放在加载期。

## 3. 校验分层

| 时机 | 位置 | 内容 | 失败表现 |
|---|---|---|---|
| 模板加载 | `validateOpeningDag(dag, template)`（game-core 新增，`templates.ts` 调用） | entry/goto 存在、param id 唯一、target 属性存在且数值类、`budgetFrom` 指向 `number` 参数、allocate 节点 `param` 指向 `points` 参数 | `template_invalid: opening.yaml: <path>: <msg>` |
| 推进会话 | `resolveStep` | 四项（键/整数/范围/合计） | 400 `opening_step_invalid` + 错误码 |
| commit | `commitOpening` | 只写数值属性（加载期已保证） | 抛错即 500（不应发生） |

`validateOpeningDag` 与 `validateStyleRefs` 并列，由 `templates.ts` 在拿到 `template` + `ui` 后统一调用。

## 4. 内核接口

```ts
// 预算解析（会话态，不依赖模板）
function resolveBudget(dag, session, decl): number

// 描述节点：新增可选 ctx 以便解析 label/style
export function describeNode(
  dag: OpeningBranchDag,
  session: OpeningSessionCore,
  ctx?: { template: WorldTemplateV2; ui?: UiConfig },
): OpeningNodeView | null

interface OpeningNodeView {
  ...
  allocation?: {
    param: string;
    budget: number;
    targets: Array<{
      attribute: string;
      label: string;
      min?: number;
      max?: number;
      style?: ResolvedStyle;
    }>;
  };
}
```

`describeNode` 不带 `ctx` 时（既有调用/测试）`label` 回退属性 id、`style` 省略 —— 保持向后兼容。

`resolveStep` 的 allocate 分支：

```ts
const budget = resolveBudget(dag, session, decl);
const keys = Object.keys(allocation);
for (const k of keys) if (!targets.has(k)) throw new Error(`opening_allocation_unknown_target: ${k}`);
for (const [k, v] of Object.entries(allocation)) {
  if (!Number.isInteger(v) || v < 0) throw new Error(`opening_allocation_invalid_value: ${k}=${v}`);
  ...min/max
}
// ADR-004 D4 修订（2026-11-19）：允许放弃余额，只拒绝超支。
if (sum > budget) throw new Error(`opening_allocation_over_budget: ${sum}/${budget}`);
```

## 5. 投影与组件

`packages/rpg-ui/src/PointsAllocator.tsx`：

```tsx
export interface PointsTargetVM {
  attribute: string; label: string; min?: number; max?: number; style?: ResolvedStyle;
}
export interface PointsAllocatorProps {
  budget: number;
  targets: readonly PointsTargetVM[];
  value: Record<string, number>;
  onChange(next: Record<string, number>): void;
  disabled?: boolean;
}
```

- 纯受控组件：不持有点数状态（父级持有，便于「返回上一步再回来」保留已分配值）；
- `+` 可用条件：`remaining > 0 && v < (max ?? ∞)`；`-` 可用条件：`v > (min ?? 0)`；
- `MAX` 每行一键填到上限（无 `max` 则吃掉全部余额）；`随机` 在**前端**把余额洗牌撒进剩余空间
  （不消耗世界 RNG）；`重置` 回到各 target 的 `min`；
- 剩余点数用 `budget - Σ`；到界按钮 `disabled` + `aria-disabled`；
- 顶部注释：**游戏内加点（升级 / 训练 / 奇遇）复用此组件**，数据契约不变。

`apps/web/main.tsx` 只保留状态与提交：

```tsx
<PointsAllocator budget={budget} targets={node.allocation?.targets ?? []}
  value={allocation} onChange={setAllocation} disabled={busy}
  onConfirm={() => advance({ kind: "allocate", allocation }, "分配完成", node.title, node.text)} />
```

（`onConfirm` 作为可选 prop 传入，组件本身不关心提交语义。）
余额未分完时点确定 ⇒ 组件内弹二次确认（`role="dialog"`，文案「剩下的点数会直接作废」），
确认后才调用 `onConfirm`；内核允许 `sum ≤ budget`。

## 6. 模板改法（jjk-2006 2.0.0）

```yaml
params:
  - { id: talentRoll, kind: number, ui: { label: 天赋点, hidden: true } }
  - id: talentPoints
    kind: points
    budgetFrom: talentRoll
    targets:
      - { attribute: cursedEnergy, min: 0, max: 3, label: 咒力, style: purple }
      - { attribute: intellect,    min: 0, max: 2 }
      - { attribute: physique,     min: 0, max: 2 }
      - { attribute: agility,      min: 0, max: 2 }

nodes:
  - node: n12b-talent          # 插在 n12-fate 与 n13-entrance 之间（靠数组顺序 fall-through）
    mode: roll
    options: [3 / 4 / 5 / 6 点，权重 4/4/2/1]
  - node: n12c-allocate
    mode: allocate
    param: talentPoints
```

`n-self` 的两条 `goto: n00-path` 不受影响；其余节点全部顺序落位。

## 7. 正确性属性

1. 同 seed + 同选择序列 ⇒ 同样的预算与同样的分配合法性（预算来自参数表，参数表来自确定性 roll）。
2. 分配只影响被点名的属性，其余属性逐键不变。
3. 非法输入不会写进 `session.results`（抛错发生在构造下一会话之前）。
4. `describeNode` 的 `budget` 与 `resolveStep` 的预算**同源**（同一个 `resolveBudget`），不会出现
   「界面显示 5 点、提交说预算 4」。
