# R2.4 · 设计

## 1. 语义变更（ADR-0008）

`inventory` 从「总持有量」改为「背包 = 未穿戴物品」。这是游戏规则/数据模型语义变更，已先落 ADR-0008（G2）。

- `packages/game-core/src/v2/equipment.ts`：`EquipResult.ok` 扩展为 `{ equipment, inventory }`；新增 `adjustInventory()`（±1，归零删键）。`equipItem` 成功路径扣背包，`unequipItem` 成功路径按实例 itemId 回流背包。错误码与失败不动状态语义不变。
- `packages/game-core/src/v2/equipment-turn.ts`：`equipV2` / `unequipV2` 写回 `next.player.inventory = result.inventory`；历史条目、时间不推进、assertActive 门禁均不变。
- `packages/game-core/src/v2/turn.ts`：`createWorldV2` 的 `initialEquipment` 注释明确「独立授予，不扣背包」。与 `playerTemplate.items` 同 id 时 = 1 穿戴 + 1 备用。

## 2. 投影扩展（`projection.ts` + `shared/v2.ts`）

- `V2Snapshot.equipmentSlots?`：模板 `equipment.slots` 直投（含 allowedCategories），空数组表示无装备分域。
- `player.equipment[]` 增加 `description / category / quality`；`player.inventory[]` 增加 `quality / slotLabel`。全部展示字段，无补正结果。

## 3. 前端（`apps/web/src/main.tsx` + `style.css`）

- `buildSlotCells()`：槽位定义 × maxCount → 固定格数；槽内实例按投影顺序落格。不再使用"从实例反推槽位"的 `groupEquipmentBySlot`。
- `PersonalSelection`：`slot(含空槽) / item` 二类；投影刷新后选中项失效自动按未选中处理。
- `EquipGridView` / `BagGridView` / `AssetDetail`：方格 + 统一详情区；空槽详情按 allowedCategories 过滤背包装备就地「装备」。
- 类型标签与字形映射（◈/✚/❖/▣）为纯文字符号，不引入图标库。
- 战斗物品列表、行动面板可用物品逻辑不变（装备 `usableOutsideBattle=false`，天然不进可用列表）。

## 4. 兼容性

- 全部新增字段可选/追加，旧调用方不受影响；旧存档计数语义差异由 ADR-0008「后果」节说明，不做自动迁移（模板指纹未变时照载）。
- 模板条件 `{ inventory, gte }` 语义变为背包内数量，协议 §12 已注记；当前 jjk 模板无此用法，无回归。
