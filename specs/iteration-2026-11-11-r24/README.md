# R2.4 · 装备归属修复 + 背包/装备栏方格 UI

R2.3 验收后用户实测反馈三项问题（2026-11-11），本迭代是小步修复轮，不新增分域。

## 用户原始裁决

1. 装备卸下后直接遗失，无法在物品栏找到。
2. 装备不应该在物品栏，仅在装备栏装备/卸下。
3. 装备/物品栏应做成方格，选中后下方展示详细信息区域和操作选项。

## 裁决落点

- ①② → **ADR-0008**（背包与装备栏物理分离）：`inventory` 只存未穿戴物品，穿脱在两栏之间移动；`initialEquipment` 独立授予，卸下必回流背包。
- ③ → 前端重排：装备栏按投影 `equipmentSlots[]` 渲染固定格数，物品栏渲染背包方格，统一详情区承载操作。

## 文档

- `requirements.md` — R-EQ-11..14（EARS + 验收）
- `design.md` — 语义变更与接口
- `tasks.md` — T1-01..T4-02（已完成，留档追溯）

## 验收命令

```bash
pnpm typecheck
pnpm --filter @life-sim/game-core test     # 243 passed（含 5 条新背包语义用例）
pnpm --filter @life-sim/web build          # 254.99 kB
```

端到端证据（curl，seed=20261111 世界）：卸下初始装备 `eq-cursed-blade` → 背包出现 `{eq-cursed-blade: 1}`；装备 `eq-watcher-charm` → 背包失去该条目、装备栏出现实例；无头 Chrome 截图确认装备栏三格（武器空 / 饰品 1 观察者护符 / 饰品 2 空）与物品栏方格（急救包 ×3、咒具·游云）。
