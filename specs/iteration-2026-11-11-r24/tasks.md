# R2.4 · 任务（全部完成）

| 任务 | 内容 | 需求 | 状态 |
|---|---|---|---|
| T1-01 | ADR-0008 落盘 + 协议 §8/§12/§19 修订 | 全部 | ✅ |
| T2-01 | `equipment.ts` 穿脱移动背包计数（纯函数 + adjustInventory） | R-EQ-11 | ✅ |
| T2-02 | `equipment-turn.ts` 写回 inventory + 注释更新 | R-EQ-11 | ✅ |
| T2-03 | `turn.ts` initialEquipment 独立授予注释明确 | R-EQ-11 | ✅ |
| T3-01 | 投影：equipmentSlots + 展示字段；`shared/v2.ts` 类型 | R-EQ-12/13 | ✅ |
| T3-02 | 测试：背包移动/回流/闭环/投影槽位/互斥 5 条新用例 + 既有断言更新 | R-EQ-11/12/13 | ✅ |
| T4-01 | 前端方格 UI：buildSlotCells + EquipGridView/BagGridView + AssetDetail 详情区 | R-EQ-14 | ✅ |
| T4-02 | 样式：cell-grid/detail-card 样式组替换旧 equip-slots；无头浏览器截图验证 | R-EQ-14 | ✅ |

## 执行记录

- 提交前验证：`pnpm typecheck` 0 错误；game-core 243 tests 全绿；web build 254.99 kB（R2.3 为 251.20 kB，增量来自方格 UI）。
- 端到端：curl 全链路（创建 → 卸下初始装备 → 背包回流 → 装备饰品 → 背包扣减）；无头 Chrome 截图装备页与物品页。
- 截图用临时补丁（默认 tab / URL ?w=）已撤销，`__seed.html` / `__check.html` 辅助页已删除；工作区无残留。
