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
| T5-01 | ADR-0009 + 协议 §19 摆位字段；jjk/examples 模板声明 panelSide | R-EQ-15 | ✅ |
| T5-02 | Schema：EquipmentSlotSchema.panelSide（strict 枚举）+ 投影下发 + 2 条测试 | R-EQ-15 | ✅ |
| T5-03 | 个人页重排：角色（人物面板+属性网格）/背包（四分区页签）/技能；puppeteer 交互验证穿脱与分区 | R-EQ-15/16 | ✅ |

## 执行记录

- 提交前验证：`pnpm typecheck` 0 错误；game-core 245 tests 全绿；web build 257.97 kB。
- 端到端（puppeteer-core 驱动本机 Chrome，390×900 视口）：空槽详情列出候选并就地装备 → 面板三格状态正确；卸下 → 回到空；背包分区页签 `装备 1 消耗品 1 材料 0 其他 0`；消耗品详情「使用」入口正常。无横向溢出（scrollWidth = clientWidth = 390）。
- 临时补丁（URL ?w= 直开世界 / 默认页签）验证后已撤销，探针脚本与截图已删除。
- 注意：模板指纹随 equipment.yaml 变化，旧测试档被拒载（既定设计）。
