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

## 验收返工记录（2026-11-18 第二波）

- 动/静虹拆分：`rainbow`（动虹，播动画）/ `rainbow-static`（静虹，静止在最佳帧）；
  字与框用同一节奏（文字 9s 走 3 个周期 ⇒ 边框 3s 一个周期），不再各转各的。
- 补正芯片尺寸回归：`font: inherit` 会把 `font-size` 一起重置成父级，改用 `font-family: inherit`；
  `StyledName` 在**没有样式时不加 `ls-styled`**（那类带 font-weight，普通补正也被加粗放大）。
- 叙事取材：模板兜底不再拼 `npc_action`（世界动态不是玩家经历）；LLM 输出契约新增
  「只写这一回合内、主角亲身经历的一小段，不要罗列世界动态 / 数值 / 已知事实」。
- 稀有度与正负零：预设改为**描述性**命名（rainbow / rainbow-static / gold / orange / pink /
  purple / blue / white / green / red / gray），内核不出现品级词；补正与物品新增 `polarity`
  （positive / negative / neutral，技能不参与），`ui.polarityStyles` 可覆盖默认绿/红/灰。
- 浮层可叠加：`EffectSummary.refDetail` 自带被引用实体的详情快照（施加 X 指向定义，
  玩家身上未必有实例），任意浮层里都能继续点开，关掉回到上一层。
- 技能面板：一行两个卡片（名字 + 消耗/冷却），点开在**下方就地**展开详情（不用浮层）。
- 固定效果：`kind:"control"` 渲染下划线 + `note` 人话说明，持续时间在浮层 meta 行。

## 验收返工记录（2026-11-18 第三波）

1. **字与框同一条时间轴**：彩虹文字与 1px 描边改为读同一组 CSS 变量
   （`--ls-rainbow-gradient/size/duration/rest`），描边用「遮罩掏空中间」的伪元素画，
   动画名与时长都和文字一致。实测两者 `background-position` 完全相同（34.25%），
   不再各转各的。旧内核无 `mask-composite` ⇒ 退回静态紫色描边。
2. **底层效果去掉回合数**：`FIXED_EFFECT_COPY` 改为「战斗中无法行动」这类能力限制 +
   一句人话说明；「几回合」只属于补正的 `duration` / `combat.battleRounds`。
3. **转盘只叙述一次**：仅当 `state.slot.eventId !== wheelResult.eventId`（已结算）时
   才把 `⚄ …` 拼进正文。修复前一次「巡逻」会在掷出与确认两趟各写一遍。
   同时**取消**上一版「槽非空就不写」的粗暴判断——它把「选完立刻弹出下一个事件」的整条
   事件链（第 2–5 轮）全吞掉了。现在每个结算过的回合都有一条正文。
4. **个人页补正样式**：`StatsPanel` 之前直接写 `<span>{name}</span>`，是唯一漏掉样式的入口；
   现在与个人卡同一套（`StyledName` + 边框样式）且可点开浮层。
5. **标签（ADR-002 D2b）**：`ui.yaml: tags` 声明 `id → { name, style }`；补正 / 物品用
   `tags: [...]` 引用；投影出 `ResolvedTag[]`；未知 id 加载期拒载。
   `quality` 不再是展示字段（详情里不会再出现「RAINBOW」），名字颜色 = 第一个带样式的标签。
6. **数据铺标签**：30 条补正 + 5 件咒具全部标注品级与正负（神话 / 传说 / 史诗 / 神器 /
   稀有 / 高级 / 优良 / 普通 + 增益 / 减益），8 档品级在数据里都有实例。
7. **顺带修真 bug**：复用原作人物（`as: npc-gojo`）时，`characters.yaml` 的 `to: player`
   与开局的 `with: npc-gojo` 都会变成**自环关系**，写进存档后 `world_state_invalid`
   ⇒ 重启即坏档。两处都已跳过自环，并补了回归测试。

验证：`tsc` 0 错；`pnpm test` 46 文件 / **301 例**全绿（新增转盘叙事回归 1 例、自环 1 例、
标签 3 例）；web build 通过；CDP 走查：六眼芯片 12px / `ls-box--rainbow` / 字与框
`ls-rainbow-flow 6s` 且 `background-position` 完全一致；浮层标签「神话（动虹）+ 增益（绿）」、
无 `RAINBOW` 字样；个人页三枚补正芯片均带样式与边框。
**未走查**：背包里的装备标签（这一局没有装备），由投影单测覆盖。

## 验收返工记录（2026-11-18 第四波：品级阶梯与引擎预置标签）

用户定的品级阶梯（颜色 = 视觉，名称 = 展示）：

| 视觉 | 名称 | 预置 id | | 视觉 | 名称 | 预置 id |
|---|---|---|---|---|---|---|
| 动态彩 | 唯一·神话 | `mythic-unique` | | 青 | 六品·稀有 | `rare` |
| 彩 | 一品·神话 | `mythic` | | 蓝 | 七品·精良 | `fine` |
| 金 | 二品·传说 | `legend` | | 白 | 八品·寻常 | `common` |
| 橙 | 三品·史诗 | `epic` | | 灰 | 九品·粗劣 | `poor` |
| 粉 | 四品·珍宝 | `treasure` | | 红 | 异常 | `abnormal` |
| 紫 | 五品·卓越 | `excellent` | | 绿 | 增益 | `buff` |

- **引擎预置**（`DEFAULT_TAGS`，ADR-002 **D2c**）：模板一行不写即可用；`ui.tags` 写同名 id 覆盖单条，
  其余继续继承；未知 id 仍加载期拒载。
- 新增样式预设 **`cyan`**（青，六品·稀有）；`gray` 一色两用（九品·粗劣 / 中性）。
- jjk 模板的 `ui.yaml` 删掉整段 `tags`（作为「零配置」示范，只留对照表注释）；
  30 条补正 + 5 件咒具按新阶梯重标（旧 `debuff` → `abnormal`，旧 `artifact` → `epic` 等）。
- 视觉：`唯一·神话`（动虹）/ `一品·神话`（静虹）/ 金 / 橙 / 粉 / 紫 / 青 / 蓝 / 白 / 灰。

验证：`pnpm test` 46 文件 / **302 例**全绿；web build 通过；API 投影核对：六眼
`[mythic-unique 唯一·神话/rainbow+rainbow-flow, buff 增益/green]`、十种影法术
`[legend 二品·传说/gold, buff]`；CDP 走查浮层标签「唯一·神话 + 增益」、名字仍是动虹、
无 `RAINBOW` 字样、`持续：直到被移除`；包内 CSS 含 `.ls-style--cyan` / `.ls-box--cyan`。

## 验收返工记录（2026-11-19：章节小结的提示词与篇幅）

用户反馈：`instruction` 里「3-5 句」太少，且写出来像流水账。查下来**只改 instruction 是无效的**，
有三处硬约束在拦：

1. **输出契约**（`agent-runtime/src/context.ts`）里两条是给**逐拍旁白**写的：
   「只写这一回合内、主角亲身经历的一小段」「必须紧接 `recentTurns` 的最后一条往下写」。
   章节小结本质是回顾，被这两条按住就只能写成缩水版。
   → `invoke.mode: recap` 换掉这两条（换成「收束一段已经发生的经历」「不要写成事件清单」）。
2. **篇幅写在契约里**（缺省 80–220 字 / 1–3 段），且在 `instruction`（≤300 字）里喊「多写点」没用。
   → `invoke.length`（`minChars/maxChars/minParagraphs/maxParagraphs`）参数化契约；
   同时把后处理截断上限从写死的 420 抬到 `maxChars`（否则模型写 700 字会被**静默砍回 420**）。
3. **`recentTurns` 一直是空的**：core 硬编码 `[]`，`gateway.deps.history` 无人赋值 ⇒ 模型只看得到 facts。
   逐拍旁白还能硬撑，章节回顾必然写空话。
   → core 用 `state.history` 过滤 `isPlayerVisible` 填末尾 N 条（`turnIndex/time/kind/summary`）；
   `invoke.historyTurns` 覆盖窗口，并同时改 `budget.recentTurns`（否则编排层会按 6 条再切一次）。

模板侧（`jjk-2006/2.0.0/rules.yaml`）：14 条换章触发器统一 `mode: recap`、
`length: {320, 760, 3, 6}`、`historyTurns: 40`；`instruction` 改成「按时间顺序拢成一段完整经历」；
`prompt.style` 重写为日式都市怪谈的冷调子 + 明确的反流水账约束（禁时间词开头、禁「然后/接着」串场）。

⚠ `rules.yaml` **不参与语义指纹**（走独立加载通道），所以这次改动**不会废档**——与之前改 yaml 的两轮不同。

验证：`pnpm test` 49 文件 / **317 例**全绿（新增 8 例：契约按体裁渲染、buildLlmContext 不丢新字段、
滚动历史过滤 hidden / budget 同步、760 字不被 420 砍）；`tsc` 0 错；端到端打印实际 prompt 确认
契约与文风段按预期拼装、`recentTurns` 有内容。

## 验收返工记录（2026-11-19：叙事区与事件区合并成「故事」）

用户裁决：两块合成一张卡，叫**故事**；普通事件做**盒中盒**内联在叙事结尾；转盘 / 战斗**直接占**这一区。

- 新增 `apps/web/src/StoryStage.tsx`（取代 `NarrativeStage.tsx`），三种形态共用一张卡：
  - **普通事件** ⇒ 叙事 + 结尾 `.story-inset`（盒中盒，左侧强调条）；
  - **随机事件 / 战斗** ⇒ `.story-takeover` 占满整块，槽位清空后自动回到叙事；
  - **自由行动** ⇒ 只有叙事 + `.story-foot`（物品 / 结束这一生，安静一行）。
- **盒中盒的时机**：等「SSE 草稿结束」+「逐字揭示结束」再渲染。为此给 `NarrativeStream`
  加了 `onTypewriterDone` 与 `typewriterKey`（复位键，否则「本回合没新增正文」时永不回调）。
  本轮没有 LLM 参与时**关掉打字机**（`skipTypingForInset`）⇒ 事件即刻出现，不空等。
- **出现即滚到位**：按 `insetKey`（`slot.eventId`）判重，滚到盒中盒**顶端**而不是容器底
  （事件卡常比可视区高，滚到底会把标题推出去）；换一个事件要重新滚一次
  （「选完 A 立刻弹 B」是最常见的一种，只判「有没有 inset」会漏）。
- **回到底部**：`.story-jump` 浮在卡片右下角，只在**阅读形态**出现；占满形态不挂
  （战斗面板常比可视区高，按钮会常驻并压住右下角技能）。
- **单一滚动容器**：`.ls-narrative` 的内部滚动在 `.story-body` 里被关掉，避免双层滚动。
- 旧的 `.slot-area` / `.slot-head` / `.narrative-card` / `.stage-stack` 样式一并删除。

验证：`tsc` 0 错；`pnpm test` 49 文件 / 317 例全绿；web build 通过；CDP 走查三种形态实拍：
普通事件（故事 + 待你决定 + 盒中盒内联）、转盘（占满 + 继续）、战斗（占满、**滚到顶**露出血条，
且不挂「回到底部」）、压矮容器后「回到底部」出现并能滚到底。

## 验收返工记录（2026-11-19 第二轮：流式续写 + 占满形态回归独立卡）

1. **流式改成「正文续写」**：SSE 草稿原本是叙事块**外面**的一个独立 `<p>`（透明度 72%），
   收尾后整段消失、正式块再出现 —— 观感是「一块东西在长，然后换了一块」。
   现在草稿由 `NarrativeStream` 作为**最后一段正文**渲染（同一个
   `ls-narrative__block ls-narrative__block--prose` + `ls-narrative__draft` 只负责
   `pre-wrap` 与淡入），字体 / 行高 / 首行缩进与上一段完全一致。
   配套：`wrap()` 里「取正式块」与「清草稿」**合并成同一次提交**
   （先 set 会多出一帧「草稿 + 正式块」并存 = 同一段文字出现两遍）。
2. **转盘 / 战斗回到独立卡**：上一版塞进 `.story-body` 的 50vh 滚动容器 ⇒ 满屏滚动条、
   战斗区拥挤。现在 `takeover` 直接**换掉卡体**：`.story-takeover` 按自己高度铺开、
   由页面整体滚动，没有内层滚动条、也没有「回到底部」按钮；外层仍是 `.story-head`
   （「故事 / 过去 N 天 / 战斗」），与阅读形态严格对齐。边框随占位者着色。
3. **普通事件（盒中盒）保持不变**：仍然是叙事结尾的内联小卡 + 出现即滚到位。

验证：`tsc` 0 错；`pnpm test` 49 文件 / 317 例全绿；web build 通过。
流式用**本地假 provider**（`LIFE_SIM_LLM_*` 指向本地 SSE 服务，模板临时副本 2.0.1
带一个 `fireMode: level` 触发器）实拍：草稿作为第 8 段接在 7 段正文之后逐字增长
（18→50→78→110→138→170 字），`sameFont / sameIndent` 与上一段一致；收尾后草稿节点消失、
正文 8 段、无重复段落。战斗形态实拍：无内层滚动条、技能全部可见、标题行对齐。
（临时模板副本与假 provider 脚本验收后已删除，仓库内无残留。）

## 验收返工记录（2026-11-19：战斗面板补上自身补正）

用户反馈：战斗时**自己的补正**没有在战斗区域展示（盟友与敌人都有，玩家没有）。

- 数据一直存在：`BattleView.player.statuses` 在投影期就把「战斗内补正 + 世界层补正」合并去重
  （`battleView` 的 `allStatuses`），adapter 也原样透传；缺的只是 `BattleBoard` 的渲染 ——
  `.battle-self` 之前只画了生命 / 咒力两条。
- `BattleBoard` 新增内部 `<StatusChips>`（玩家 / 友军 / 敌人共用一份实现，之前是两段复制粘贴），
  玩家补正渲染在资源条下方。
- 同时接上点击看详情：`onSelectStatus`（不传则芯片只读），`LifeTab` 接到既有的浮层栈，
  所以在战斗里点「六眼」也能看到「唯一·神话 / 增益 / 咒力 +20 …」。
- **顺带修了一个 CSS 特异性 bug**：`.ls-battle-status` / `.ls-tag` 的 `border: 1px solid var(--ls-border)`
  写在 `.ls-box--*` 之后且特异性相同 ⇒ 把彩色边框盖回灰边（战斗芯片只剩文字有色、标签芯片一直是灰框）。
  默认边框色改为 `:where(.ls-tag, .ls-battle-status) { border-color: … }`（特异性 0）。

验证：CDP 实拍战斗（五条悟开局 → 巡逻进战斗）：`.battle-self` 出现三枚芯片
（六眼 / 术式·十种影法术 / 天与咒缚），战斗态一律语义绿（文字与边框都是 `rgb(79,209,165)`），
与角色卡上的身份色（彩虹 / 金）形成对比；点芯片弹出毛玻璃详情。
`tsc` 0 错；`pnpm test` 全绿；web build 通过。

## 验收返工记录（2026-11-19：战斗区只展示战斗补正）

用户：战斗区不展示**非战斗补正**（没有 `combat` 字段就不展示）。

- 过滤落在**投影层**（`battleView` 的 `statusViews`），不在前端做：
  「这条补正是否与战斗有关」是定义上的事实，前端拿不到定义，只能拿投影结果。
- 判据 `lookup.status(id).combat !== undefined`。`StatusEffectSchema` 的 refine 保证每条补正
  至少有 `simulation` 或 `combat` 之一，所以这条判据正好切出「纯模拟域」。
- 只影响战斗视图：个人页 / NPC 卡 / 收获卡仍展示全部补正。
- 玩家（战斗镜像 + 世界层合并）、友军、敌人共用同一个过滤。

实测（jjk 五条悟开局 → 巡逻进战斗）：世界层补正 `six-eyes, tech-ten-shadow,
heavenly-restriction`，战斗面板只剩 `six-eyes, tech-ten-shadow` —— 天与咒缚（纯体质）不再上战斗区。
新增单测 1 例（`blessed` 只有 simulation ⇒ 不进战斗；个人页仍可见）。`pnpm test` 全绿。
