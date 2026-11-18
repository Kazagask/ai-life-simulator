# 任务：表现层（叙事追加 / 本轮收获 / 样式体系）

> **状态：2026-11-18 全部实施完成**（T0–T9）。实测见文末「实施记录」。

> 一次只做一个任务（G3），按依赖顺序。每个任务都要能独立编译、独立测试、可回滚。
> 完成定义里写的是**可执行的验证**，不是「看起来好了」。

## 依赖图

```
T0 ──┬─> T1 ──┐
     ├─> T2 ──┼─> T5 ──┬─> T6 ──> T7 ──> T8 ──> T9
     ├─> T3 ──┤        │
     └─> T4 ──┘        └─> (T6/T7 依赖 T5 的组件)
```

## T0 · ADR + 契约扩展（DONE 前置）

- **依赖**：无。**产出**：`docs/ADR-002-表现层协议.md`、`packages/shared/src/schema/style.ts`、
  `contract/view-model.ts` 追加字段、`schema/{status-effect,skill,item,ui}.ts` 追加可选字段。
- **完成定义**：
  1. ADR 六条决策写清（只读投影 / 受控样式词汇 / 效果摘要派生 / 差分不落库 / 叙事分段 / schemaVersion 不变）。
  2. `pnpm typecheck` 0 错；`WorldStateV2Schema` 无结构变更（旧档仍可 `parse`）。
  3. 新增 schema 全部 `.strict()`，非法样式值有单测（`test/unit/style-schema.test.ts`）。

## T1 · 样式解析（引擎）

- **依赖**：T0。**产出**：`packages/game-core/src/v2/presentation/style.ts`、
  预设表常量、`projection.ts` 接入。
- **完成定义**：
  1. `resolveStyle()` 顺序：自身 `style` > `qualityStyles[quality]` > `undefined`。
  2. 颜色 token 解析为 CSS 变量字符串（`gold` → `var(--ls-gold)`）。
  3. 单测覆盖：自身优先 / 品质回退 / 未知 id 抛错 / token 映射。

## T2 · 效果摘要 + 固定效果文案（引擎）

- **依赖**：T0。**产出**：`presentation/effects.ts`、`presentation/fixed-effects.ts`。
- **完成定义**：
  1. `buildEffectSummaries()` 支持 status / skill / item / equipment 四类定义。
  2. 动态补正**只描述规则**（`随咒力成长：3 + 0.2×咒力`），不出现结算数值。
  3. `cannot_act` 等六种控制语义有统一中文文案，`kind: "control"`。
  4. 单测：四类定义各 ≥2 例；控制语义全覆盖。

## T3 · 回合增量（引擎 + 服务端）

- **依赖**：T0。**产出**：`presentation/gains.ts`、`index.ts` 五个写操作响应追加 `gains`。
- **完成定义**：
  1. `captureGainBaseline` / `diffGains` 纯函数，不 clone 整状态。
  2. 属性净变化 / 补正层数 / 技能 / 物品数量 / 装备实例五类，顺序稳定、可复现。
  3. 五个端点响应都带 `gains`（无变化为 `[]`）。
  4. 单测：构造 before/after 断言条目文本与 `action`；同输入两次结果一致。

## T4 · 叙事兜底写入（服务端）

- **依赖**：T0。**产出**：`apps/server/src/narrative/turn.ts`（合成器）、写操作收尾接入、
  `read.ts` 输出 `turnIndex`。
- **完成定义**：
  1. 模板回合写入恰好 1 条叙事块；同回合重复调用不重复写。
  2. 该回合已有 LLM 块 ⇒ 跳过（不覆盖 LLM 叙事）。
  3. 事件 / 转盘 / 自由行动 / 战斗 / 物品五条路径都有覆盖用例（服务端级）。
  4. hidden 引用不落 trace（沿用既有窗口校验，加一条负向用例）。
  5. `ContentBlockVM.turnIndex` 在 `GET /narrative` 中回传。

## T5 · 组件：样式渲染 / 效果列表 / 补正浮层（rpg-ui）

- **依赖**：T1、T2。**产出**：`StyledName.tsx`、`EffectList.tsx`、`ModifierSheet.tsx`、
  `styles.css` 预设样式与毛玻璃。
- **完成定义**：
  1. `StyledName` 在个人页、收获卡、事件区、战斗面板使用同一实现。
  2. `EffectList` 对 `kind:"control"` 渲染下划线 + `title`；数值条目带 `+/-` 分色。
  3. `ModifierSheet` 毛玻璃 + `@supports` 回退；Esc / 遮罩 / 按钮关闭；同时只开一个。
  4. `prefers-reduced-motion` 下动画停、颜色保留。
  5. 组件级快照/交互测试（已有测试基座内）。

## T6 · 本轮收获卡（rpg-ui）

- **依赖**：T3、T5。**产出**：`TurnGainsCard.tsx` + 接入 `LifeTab` 的结算位置。
- **完成定义**：
  1. 标题「本轮收获」，按 属性/补正/技能/物品/装备 分组；空分组不渲染。
  2. `gains` 为空时不渲染该卡（回退「世界平静地流转着」）。
  3. 可点条目回调到详情（技能/物品/装备/补正）。
  4. 组件测试：三类典型 gains 输入 → DOM 结构断言。

## T7 · 前端接线（apps/web）

- **依赖**：T5、T6。**产出**：叙事追加 + 假流式 + 收获卡数据 + 补正浮层状态。
- **完成定义**：
  1. `narrative` 只追加不替换；`turnIndex` ≤ 最新且非最新回合的块不播打字机。
  2. 无 SSE 草稿时最新回合逐字出现，且**不显示**「AI 书写中…」。
  3. 点击补正 chip / 收获条目打开 `ModifierSheet` / 对应详情。
  4. 走查：连续 3 回合（mock provider）叙事累积、最新段逐字、收获卡正确；刷新后收获卡消失但叙事仍在。
  5. `pnpm --filter @life-sim/web build` 通过。

## T8 · 模板：品质样式（jjk-2006/2.0.0）

- **依赖**：T7。**产出**：`ui.yaml` 的 `styles` / `qualityStyles`；`statuses.yaml` 的 `tech-six-eyes`
  等最高品质补正加 `quality: mythic`；`items.yaml` / `skills.yaml` 按需加 `style`。
- **完成定义**：
  1. 「六眼」在个人页、收获卡、事件区呈现同一套流动彩虹。
  2. 未加样式的实体零视觉回归。
  3. 模板加载期校验通过；`pnpm test` 全绿。

## T9 · 验收与回归

- **依赖**：T8。**产出**：`tasks/reports/R-PRESENTATION-COMPLETION.md`（放 `specs/iteration-.../report.md`）。
- **完成定义**：
  1. `pnpm typecheck` / `pnpm test` / `pnpm --filter @life-sim/web build` 全绿并记录实际输出。
  2. 旧档直载验证（schemaVersion 5）。
  3. 浏览器走查（有 LLM 与无 LLM 各一次）截图存档。
  4. 更新 `specs/SPEC.md` 对应章节与本目录 README 状态。

## 实施记录（2026-11-18）

- **T0–T2**：`schema/style.ts`、`schema/effects.ts`、`view-model.ts` 扩字段；
  `presentation/{style,effects,fixed-effects,gains}.ts` 四个纯函数模块。
- **T3**：`runWorldTransaction` 与 `items/use` 捕获基线 + 差分，五个写操作响应带 `gains`。
- **T4**：`narrative/turn.ts` 合成模板叙事；判据是 **provider === "mock"**
  （trace 落盘时机与事务收尾不保证先后，按「有没有块」判重会重复写）；
  `read.ts` 输出 `turnIndex`。
- **T5/T6**：`StyledName` / `EffectList` / `DetailSheet`(+`ModifierSheet`) / `TurnGainsCard`；
  预设样式与毛玻璃 CSS 在 `packages/rpg-ui/src/styles.css`。
- **T7**：`main.tsx` 接 `gains`、把「命运落定」换成「本轮收获」、补正芯片可点开浮层、
  `NarrativeStage` 只在真的有流时显示「AI 书写中…」。
- **T8**：六眼 `quality: mythic`；`ui.yaml` 增加 `styles` / `qualityStyles`。
- **额外修复**：复用原作人物时**没带上角色自带补正**（五条悟没有六眼）——已在
  `createWorldV2` 的 reuse 分支补 `baselineStatuses`。
- **验证**：`tsc` 0 错；`pnpm test` 46 文件 / **292 例**全绿；web build 通过；
  puppeteer 430×932 走查：六眼 chip 带 `ls-style--rainbow ls-anim--rainbow-flow`、
  修炼回合出现「本轮收获 / 属性 咒力 +1」、叙事累积 3 段且含 NPC 行动、补正浮层毛玻璃显示
  `咒力 +20 敏捷 +10 智力 +10 造成伤害 +30% 命中 +20%`。
- **未做**：固定效果的视觉走查（引擎侧 `kind:"control"` 与 CSS 已就位，但该局没拿到带
  控制语义的补正）；叙事折叠/分页（DEFERRED）。
