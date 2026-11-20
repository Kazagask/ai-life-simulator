# 任务：属性类型与自定义资源（2026-11-19）

> 一次只做一个任务，按依赖顺序；每完成一项在文末「实施记录」追加事实（改了什么、验证命令与结果）。
> **T0 未获用户裁决前不写实现代码。**

## T0 协议裁决（G2 前置门禁）

- [x] `docs/adr/40-属性资源与状态.md` 的 D-1..D-4 获用户确认
- [x] `design.md` §9 四个待裁决点逐条回填结论
- 验收：用户明确回复；ADR 状态从「提议」改为「已裁决」

## T1 shared：属性类型 schema 与值 union

依赖：T0

- [x] 新建 `packages/shared/src/schema/attribute.ts`（AttributeDef / 校验辅助）
- [x] `world.ts`：`attributes` 增 `defs`、`defaults` 值放宽；接入 `attribute-validate.ts`
- [x] `character.ts` / `world.ts`（PlayerTemplate）/ `v2-state.ts` / `v2.ts`：attributes 值 union
- [x] `common.ts`：`setAttribute` 效果；`AttributeConditionSchema` 增字符串 / tier
- [x] `adjustResource.resource` 放宽为 string
- 验收：`pnpm typecheck`；旧模板（无 defs）加载通过

## T2 shared：资源定义与技能消耗

依赖：T1（可与 T1 合并提交）

- [x] `world.ts`：`resources` catchall；`ResourceDef` 新字段；`regen` catchall
- [x] `skill.ts`：`cost` catchall
- [x] `statusBar` / 效果 / 技能 / regen 的 id 交叉校验
- [x] 样式校验接入 `validateStyleRefs`
- 验收：`pnpm --filter @life-sim/shared test`；unknown resource ⇒ 拒载用例

## T3 game-core：求值与效果

依赖：T1、T2

- [x] `computeMax` / `effectiveAttributes` / `adjustAttribute` 数值窄化
- [x] `setAttribute` 实现；`adjustResource` 支持自定义
- [x] 条件求值共享函数（`engine.ts` + `condition-evaluator.ts`）
- [x] 新建 `v2/resources.ts`（max / value / adjust / init）
- [x] 建世界初始化自定义资源；regen 写自定义资源
- 验收：`pnpm test` 定向通过

## T4 game-core：投影与收获

依赖：T3

- [x] 新建 `presentation/attributes.ts`（resolveAttributeViews）
- [x] `V2Snapshot.player.attributeViews` / `npcs[].attributeViews`
- [x] `player.resources: ResourceView[]`（statusBar 顺序）
- [x] `gains.ts` / `TurnGain` 支持文本与复合
- 验收：投影回归（旧模板字段不变）

## T5 game-core：战斗资源

依赖：T3

- [x] `BattleState.player.resources` / `BattleEnemy.resources`
- [x] 技能 cost 全量检查与扣除；`not_enough_resource`
- [x] AI 可用技能过滤
- [x] 战斗视图 resources / costs；finishBattle 回写
- 验收：`test/unit/combat.test.ts` + 新用例

## T6 开局与收获

依赖：T3、T4

- [x] `commitOpening` `mode:set` 接受字符串
- [x] `collectOpeningGains` 文本 / 复合条目
- 验收：开局 enum 用例

## T7 rpg-ui / web

依赖：T4、T5

- [x] `view-model.ts`：PlayerAttributeVM 扩写、StatusBarVM.display、BattleSkillVM.costs
- [x] `adapter.ts`：attributes / resources / battle 搬运
- [x] `AttributeList.tsx`（网格 + 阶梯）；`StatsPanel` / `NpcDetails` 接入
- [x] `StatusBars` pips；`BattleBoard` 资源与技能消耗
- [x] `styles.css`
- 验收：`pnpm --filter @life-sim/web build`；截图核对

## T8 模板：jjk-2006

依赖：T1..T6（可先写 yaml，加载器就绪后验证）

- [x] `world.yaml`：grade / innateTechnique / infamy / virtue / fame
- [x] `opening.yaml`：n03 / n04 写文本属性
- [x] `characters.yaml`：五条悟 / 夏油 / 伏惠
- [x] `events.yaml`：恶名 / 善名调整点
- 验收：模板加载；开局 commit 后属性面板出现「生得术式 无下限术式」「等级 特级」「名誉 恶贯满盈」

## T9 模板：valmont 决斗

依赖：T2、T5、T7

- [x] `world.yaml`：prowess ladder + beans resource + statusBar
- [x] `characters.yaml`：enemy
- [x] `skills.yaml`：player / enemy
- [x] `events.yaml`：决斗事件 + onVictory
- 验收：从开局走进决斗，豆 5/5 → 技能耗 3 → 2/5；胜利后武艺阶位变化

## T10 文档与验证

- [x] `specs/SPEC.md` 增补「属性类型 / 自定义资源」章节（只写已实现）
- [x] `docs/BACKLOG.md` 记录 DEFERRED 项（若要）
- [x] `pnpm typecheck`、`pnpm test`、`pnpm build`、定向冒烟
- [x] 部署（复用 appId）并如实告知旧档拒载

## 实施记录

### 2026-11-19 实施完成

- **T0**：用户裁决 D-1 隐藏双轴派生、D-2 玩家/敌人对称、D-3 按 statusBar 声明、
  D-4 两种阶梯模式都要；ADR-003 状态改为「已裁决」。
- **T1/T2 shared**：
  - 新增 `schema/attribute.ts`（四类 def + `AttributeValue` + `numericAttr`）；
  - `world.ts`：`defs`、`defaults` 值放宽、`resources` catchall、`regen` catchall、
    `setAttribute`、属性/资源/样式/条件的加载期交叉校验（错误信息带字段路径）；
  - `character.ts` / `v2-state.ts` / `v2.ts`：属性值 union、`attributeTiers`（reset 档位）、
    `player.resources` / battle 镜像 resources（默认 `{}`）；
  - `skill.ts`：`cost` catchall；`ui.ts`：`resources.display/dangerAt`。
- **T3 game-core**：
  - 新增 `attribute-rules.ts`：kind 查找、ladder 档位派生（cumulative / reset）、
    `evaluateAttributeCondition`（引擎与触发器共用）、reset 升档扣减；
  - 新增 `resources.ts`：`computeMax`（迁入）、`resourceMax`、`resourceValue`、
    `initPlayerResources`、`adjustResourceValue`；
  - `engine.ts`：`adjustAttribute` / `setAttribute` / `adjustResource` / 条件求值；
  - `turn.ts`：建世界初始化自定义资源、regen 遍历全部资源、触发器上下文带 template。
- **T4 投影**：新增 `presentation/attributes.ts`；`player/npc.attributeViews`；
  `player.resources: ResourceView[]`；`gains` 支持 enum / composite / reset 档位。
- **T5 战斗**：镜像 resources、`missingCost/payCost`、AI 过滤、投影 `costs`、
  `finishBattle` 回写。
- **T6 开局**：`attribute` 参数 `mode:set` 接受字符串；`collectOpeningGains` 文本条目。
- **T7 前端**：`view-model.ts` 扩写（PlayerAttributeVM / ResourceVM / StatusBarVM.display /
  BattleSkillVM.costs）；`adapter.ts`；`AttributeList`（网格 + 阶梯）；`StatsPanel` /
  `NpcDetails`；`CharacterSheet` 资源改由模板声明；`StatusBars` / `BattleBoard` 刻度；
  `styles.css` + `style.css`。
- **T8/T9 模板**：
  - `jjk-2006 2.0.0`：grade / innateTechnique / infamy / virtue / fame；开局写 grade/technique；
    五条悟 / 夏油 / 伏黑 / 宿傩补文本属性；夏油线与涩谷选项调整恶名/善名；
  - `valmont 1.0.0`：prowess ladder、beans 资源、ui 刻度、敌人 `npc-duelist`、3 条技能、
    `evt:merge` 可选分支 → `evt:duel`（胜利 +40 武艺）。
- **T10 验证**：
  - `pnpm typecheck` 0 错；
  - `pnpm test` **53 文件 / 352 例全绿**（新增 `attribute-types.test.ts` 12 例、
    `custom-resources.test.ts` 6 例）；
  - `pnpm --filter @life-sim/web build` 通过；
  - CDP 实测：JJK 开局 → 个人页显示「等级 四级 / 生得术式 十种影法术 / 名誉 默默无闻（恶名 — · 善名 —）」；
    瓦勒蒙 HUD 显示「决意 5/5」刻度、个人页「武艺 生手 10/30」进度条；
    决斗中施放「决意一击」→ 决意 5→2、按钮禁用；胜利后武艺 10→50（熟手 20/50）。
