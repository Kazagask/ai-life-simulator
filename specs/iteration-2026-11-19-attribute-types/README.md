# 迭代：属性类型与自定义资源（2026-11-19）

## 一句话

把「属性 = 一个整数」「资源 = HP/MP」两套写死的假设拆掉：属性支持**带样式的文本**、
**阶梯进度**、**由多条数值轴派生的复合称号**；资源支持**模板自定义池子**与**刻度展示**，
让「攒 3 个豆才能放技能」这类机制能只用 yaml 表达。

## 本轮范围

- **做**：
  1. 属性四种类型：`number`（缺省）/ `enum`（文本+样式）/ `ladder`（阶梯+进度）/ `composite`（派生称号）。
  2. 隐藏属性：参与规则、不进面板（名誉的两个轴用它）。
  3. 效果 `setAttribute`；条件支持字符串 `eq/ne` 与 `tier`；数值面加载期拒绝文本属性。
  4. 自定义资源：`resources` 追加任意 id；上限公式 / 初始值 / cap / 刻度显示。
  5. 技能消耗自定义资源；战斗镜像与回写；敌人/友军同样携带（引擎对称）。
  6. 资源条按 `statusBar` 声明展示，`display: pips` 画刻度。
  7. 投影 `AttributeView` / `ResourceView`；个人页与 NPC 详情按类型渲染。
  8. JJK 模板：等级 / 生得术式（带样式）/ 名誉（恶名+善名派生）。
  9. 瓦勒蒙模板：决斗事件 + 决意（能量豆）刻度 + 武艺阶梯，验证资源与战斗链路。
- **不做**（DEFERRED，见 requirements §3）：
  - 属性/资源编辑器 UI；
  - 一人多术式（文本属性多值）；
  - 复合属性参与条件/效果；
  - 属性详情浮层；
  - 非战斗事件里的「消耗式选项」；
  - NPC 属性被效果动态修改。

## 与现行规格的关系

- 权威：`AGENTS.md` + `specs/SPEC.md`。
- 协议级改动按 G2 **先写 ADR**：`docs/adr/40-属性资源与状态.md`（状态：提议）。
- **schemaVersion 保持 5**：属性值放宽、资源追加、玩家资源默认 `{}` 都是向后兼容的放宽；
  旧档可直载。模板语义变化由模板指纹承担。

## 现状事实（读代码得到，不是猜测）

- `attributes` 在模板、存档、效果、条件、公式、投影、UI 全链路都是 `Record<string, number>`；
  `WorldStateV2Schema` 的 `CombatantBaseSchema.attributes` 直接是 `z.record(string, number)`。
- 效果只有 `adjustAttribute { attribute, value: number }`；`AttributeConditionSchema`
  只有数值比较；没有「设为某个词」的写法。
- `resources` 是 `z.object({ hp, mp })`；`adjustResource.resource` 是 `"hp"|"mp"` 枚举；
  `regen` 硬编码 hp/mp；技能 `cost` 硬编码 `{ mp }`；`BattleState.player` 只有 hp/mp。
- `statusBar` 的 `source: resource` 段**从未被 UI 消费**：`adapter.ts#deriveStatusBar`
  硬编码两条 hp/mp。
- 开局 `commitOpening` 的 `attribute` 参数只接受 `value: number`（`typeof value === "number"`）。
- `TurnGain` 的 `amount` 是 number；文本属性的变化目前无处承载。

## 给 Agent 的读法

1. 先读 `AGENTS.md`、`specs/SPEC.md`，再读本目录 requirements → design → tasks。
2. 一次只做一个 `T<编号>`，按 tasks.md 依赖顺序；**T0 未获用户裁决前不写实现代码**。
3. 不确定的产品规则先问，不自行伪造共识。
4. 前端改动必须同时跑 `pnpm --filter @life-sim/web build`；涉及存档形状的改动必须补
   「旧档 → 重新解析」类回归。
