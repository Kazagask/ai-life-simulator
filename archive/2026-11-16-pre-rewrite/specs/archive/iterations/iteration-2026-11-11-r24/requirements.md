# R2.4 · 需求（EARS）

状态：全部 **已验收**（2026-11-11）。追溯：R-EQ-11..14 → ADR-0008。

## R-EQ-11 背包与装备栏互斥（用户裁决 ①②）

**WHEN** 玩家装备一件背包内的装备，**THE SYSTEM SHALL** 将该物品从 `inventory` 计数中扣减（归零删键），并生成对应装备实例。
**WHEN** 玩家卸下任一装备实例，**THE SYSTEM SHALL** 将该实例的 itemId 在背包计数 +1（含 `initialEquipment` 授予、背包原本没有的物品）。

验收：
- [x] 穿上后 `state.player.inventory[itemId]` 不再保留同名条目（纯函数与编排两层断言）。
- [x] 卸下初始装备（背包计数为 0）后背包出现 `{itemId: 1}`；再装备可成功（闭环回归用例）。
- [x] 投影层：穿戴中的 itemId 不出现在 `player.inventory`；卸下后出现。

## R-EQ-12 槽位定义投影

**WHEN** 模板声明 `equipment.slots`，**THE SYSTEM SHALL** 在快照下发 `equipmentSlots[]`（id / label / maxCount / allowedCategories）；未声明时为空数组。

验收：
- [x] 投影测试断言与 jjk 模板两个槽位逐字段相等。
- [x] 前端按 `maxCount` 渲染固定格数（饰品 maxCount=2 → 两格），空槽可选中。

## R-EQ-13 装备/物品展示字段补齐

**THE SYSTEM SHALL** 在装备实例与背包条目投影中下发 `description / category / quality / slotLabel` 展示字段，且不包含任何补正结果（P8 持续有效）。

验收：
- [x] 装备实例键集合测试更新为 8 个展示字段。
- [x] 详情区仅展示定义字段与实例状态（层数/耐久），无补正数值。

## R-EQ-14 方格 UI 与详情区（用户裁决 ③）

**THE SYSTEM SHALL** 将装备栏与物品栏渲染为方格；**WHEN** 玩家选中任一格子，**THE SYSTEM SHALL** 在下方详情区展示名称、标签、说明与操作（已装备 → 卸下；空槽 → 可装备物品就地装备；背包物品 → 使用/装备）。

验收：
- [x] 无头浏览器截图：装备栏三格、物品栏两格、详情提示正常渲染。
- [x] 选中项失效（卸下/用完）后自动按"未选中"处理，不报错。
- [x] 装备/卸下操作入口在装备页详情区；物品页背包装备件详情也提供「装备」便捷入口。

## R-EQ-15 人物面板与摆位模板化（ADR-0009，用户二次裁决）

**WHEN** 模板槽位声明 `panelSide`，**THE SYSTEM SHALL** 按声明把槽位格摆到人物面板左列 / 右列；未声明时落在底部方块区（老模板行为不变）。
**THE SYSTEM SHALL** 保证装备容量完全由模板决定（slots 条数 / maxCount / allowedCategories），引擎与前端不写死。

验收：
- [x] jjk 模板：weapon=left、accessory=right；截图确认武器在左列、饰品两格在右列、中央为人物信息。
- [x] 投影恒带 panelSide（缺省 bottom）；`panelSide: top` 等非法取值加载期拒绝。
- [x] 个人页三页签「角色 / 背包 / 技能」：角色页=人物面板+属性网格+详情区，面板页签并入角色页。

## R-EQ-16 背包分区（用户二次裁决）

**THE SYSTEM SHALL** 将背包按物品类型分为装备 / 消耗品 / 材料 / 其他四个分区页签（带数量徽标），每区独立方格，切分区清空选中。

验收：
- [x] 截图/交互验证：分区页签显示 `装备 1 消耗品 1 材料 0 其他 0`；消耗品区选中急救包 → 详情区「使用」。
- [x] 穿戴中的装备不出现在任何分区（ADR-0008 维持）。
