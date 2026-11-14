# 引擎能力盘点与设计缺陷归档（2026-11-14）

> 来源：七轮 `sanguo-2010` 模板施工后的复盘对话。**分类由用户裁定**，不是助手推断。
> 纪律：**口述事实**与**已核验事实**分列（沿用 `docs/RECOVERY_MERGE.md` 的口径）；本文件只归档，不代表已排期、已授权改造。
> 边界：本轮零产品代码改动 —— 仅新增本文件、`docs/BACKLOG.md` 的 B-25、当日工作日志；未 push、未部署、未下线，未动引擎 / schema / ADR / Spec / 前端。

## 0. 结论

七轮里绝大多数想要的机制引擎早就有（见 §5），模板层纯 yaml 即可接线。真正的问题只有三类：**能力缺失**（§1）、**设计缺陷**（§2）、**有意设计或旧机已重做未提交**（§3）。另有一个独立的 UI 交互 bug（§4）。

## 1. 能力缺失（用户裁定：原清单 1 / 2 / 3 **都是能力缺失**）

| # | 缺失的能力 | 现状 / 已核验代码证据 | 七轮里的绕法 | 要补什么 |
|---|---|---|---|---|
| G-01 | **年号运行期可变 / 按地区切换** | `CalendarConfigSchema.era` 存在，但 `eraBase` 与 `era.name` 在 `createTimeAdapter` 构造期闭包固化（`game-core/v2/time.ts:315`、`337-339`）——是**模板常量，不是世界状态** | 剧情层用 `eraName` flag 表达改元；建安五年只写进叙事，明说「天意改了人、没顾上改历书那一格」；初平元年折到建安五年靠 `chain` 而非 `advanceTo` | 历法读世界状态；牵动 TimeAdapter / 存档 / 投影契约面（T-2）。是否立项由主理人裁决 |
| G-02 | **改写玩家显示名** | `setIdentity` 只有 `gender` / `age`（`shared/schema/common.ts:208-214`），无 `name` | 摇到刘备 / 曹操 / 袁绍时保持第二人称叙事 + 年龄变化，人物面板仍显示创建时填的名字 | effect 补字段 + 身份显示契约 |
| G-03 | **模板选择器** | `templates[0]` 写死（`apps/web/src/main.tsx:680/707`）；开局下拉只在 `openings.length > 1` 出现（`:758-763`），所以第七轮新开局白捡了下拉，模板本身却不可选 | `TEMPLATES_DIR` 隔离根只挂一套模板，让手机默认进三国 | 模板列表 UI + `templateId` 选择贯通创建流程 |

> 这三条此前被助手表述为「契约面 / 需授权」，实质归属是**能力缺失**；授权与否只影响何时动，不改变分类。

## 2. 设计缺陷（用户裁定：原清单 8 / 9 **是设计缺陷**，不是边界或取舍）

### 2.1 根因：把 `hidden` 语义和生命周期混成了一个维度

用户口径原话：**「可见」和「是否活跃」是两个维度**。当前实现用一个 `hidden` 概念同时承载了三种性质不同的事实：

- `unspawned`（生命周期态：尚未登场）→ 塞进 `hiddenNodeIds`；
- `isEnemy`（角色类别：战斗对手、不实例化）→ 同样塞进 `hiddenNodeIds`；
- `inactive`（生命周期态：已故）→ 反而**保留**关系边与称谓（「逝去的祖父依旧是祖父」）。

代码证据：`game-core/v2/projection.ts:43-54` 的注释自称「判据是『确知未对玩家可见』」，却把两条与可见性无关的判据写进同一个集合；三个语义重叠的字段并存于 `shared/schema/character.ts:30`（`isEnemy`）、`:32`（`visibility: public|hidden`）、`:37`（`lifecycle`）。结果就是「可见性」被当成了生命周期与角色类别的投影副产品，而不是独立维度。

### 2.2 `isEnemy` 是最初的历史债务

最初用一个布尔同时表达「战斗对手 + 不上屏」是够用的；后来引入 `visibility`、`lifecycle`、`npcSpawnRules`、关系图谱之后，这个布尔没有退场，仍留在三条判定链里：

- `game-core/v2/npc.ts:36` —— `isEnemy` 不建 NPC 实例；
- `game-core/v2/turn.ts:149` —— 建实例时 `.filter(c => !c.isEnemy)`；
- `game-core/v2/projection.ts:53` —— 敌人 id 归入隐藏节点。

直接后果：**不存在「可上屏、可登记死亡的敌人」这一形态**。第六轮只能把华雄改成 `isEnemy: false`（他本就不是任何战斗 ref），再另造一个「旗后面的人」当沙盘阵亡对象；对 `enemy-*` 写 `setNpcLifecycle` 会抛「指向未知 NPC」。

### 2.3 初始态与迁移态走了两条路径（原清单第 9 条）

开局 `inactive` 的角色不带 `frozen` 关系边标记，因为 `freezeOnDeath` 只在**运行期状态变更**时调用，模板声明的初始态没有走同一条归一化路径。判活已挡住所有针对死者的关系写入，行为等价，但存档里无痕（实测每局 4 条 `frozen` 全是运行期死者）。这不是缺字段，是**同一状态的两条记账路径不一致**，与 §2.1 同源。

### 2.4 与既有立案的关系

`docs/BACKLOG.md` 里已有同一根因的多个面，本文件不重复立案、只做归并：

- **B-21** `flags["infoVisibility:<npcId>"]` 只写不读，并已明令禁止拿它当投影红线（「会与 `lifecycle` 形成两套真相」）；
- **B-22** `characters[].visibility: "hidden"` 完全没参与上屏过滤，与 ADR-0020 记载不符；
- **B-23** 判据反例未做成 table-driven，只有 enemy 一条真正卡住错判据。

## 3. 其余条目：有意设计，或「那块已经重做了没提交」

### 3.1 可核验为有意设计

| 条目 | 依据 |
|---|---|
| `once` 只在入队门控消费、pending 期间不复核 | `scheduler.ts:246-247, 271` 明写「ADR 决策 1」；`BACKLOG.md` B-13 已立案并诊断过章节软锁 |
| 窗口跨过即 `window_expired` 静默丢弃、不补发 | `scheduler.ts:329-339`，注释称「#36 唯一的因时间出队路径」 |
| 链推进只靠 `nextEventId`，无内建超时 / 章节门控原语 | 模板自写定时兜底事件（第七轮 `ev-war-timeout`） |
| 终止判据禁用 HP 数值 | R-EN-07；战死只能做成「立军令状 flag + 战败」双门槛 |
| 模板按整目录算指纹、启动期一次性加载 | `server/src/templates.ts:114-126`、`store.ts:120` |

### 3.2 用户口述·未经核验

> 用户指出：其余条目中有一部分是**崩溃机上已经重做、但没提交**的实现，因此当前 clone 里看到的旧样子不能据此判定为缺失。

- 当前工作区的基线是崩前 `main@8e4b4f7` 起的恢复分支，**不等于旧机现状**（见 `docs/RECOVERY_MERGE.md`）。
- 具体指向哪一块**未获确认，本文件不做断言**；从用户此前的口述「ADR26 中彻底落地了槽模型 `pendingEvents` 退役、底层重构」看，疑似调度 / 槽模型一线，仅为线索。
- 处置：待旧机源码找回后逐条复核，按「口述事实 → 已核验事实」升级；在此之前不把它们当作待补能力，也不写 ADR。

## 4. 新发现（待修，本轮只记录）：战斗中无法使用的物品没有被隐藏

**现象**：战斗进行中，行动 / 个人面板的「物品」区仍列出可日常使用的物品，按钮可点；点击后前端报错。用户 2026-11-14 点屏发现，要求「记录一下」。

**已核验的链路（当前 clone）**：

1. `apps/web/src/main.tsx:1607` —— 物品区只按 `i.usableOutsideBattle` 过滤；
2. `:1642-1653` —— 按钮仅 `disabled={busy}`，**未读 `battleActive` / `interacting`**；
3. `:412-413` `onUseItem` → `api.useItem` → 服务端 → `game-core/v2/turn.ts:1202`：`if (state.battle && !state.battle.over) throw new Error("battle_in_progress")`。

**战斗面板本身是干净的**：投影层 `game-core/v2/projection.ts:402-404` 已按 `usableInBattle` 过滤 `battle.player.items`；`battle.ts:589` 对非法 itemId 另有 `item_not_usable_in_battle` 防护。所以问题在**「战斗态下其它 tab 未收敛交互」**，不是引擎缺判定。`interacting` 其实已存在（`main.tsx:521`），但只喂了浮标提示（`:596`），没用于禁用物品区。

**建议修法（本轮不动手）**：给行动 / 个人面板接 `battleActive`（或 `interacting`），战斗与待决时隐藏或禁用该物品区；或由投影统一下发「此刻能否轮外使用物品」控制位，沿用 D-08「与引擎同源判定」的思路。

**判定**：延后，本轮只记录；已登记 `docs/BACKLOG.md` **B-25**。影响所有带 `usableOutsideBattle` 物品的世界（`jjk-2006`、`sanguo-2010` 的馒头等），不破坏存档，属 UI 交互瑕疵 + 用户可见错误提示。

**证据缺口**：本轮未跑真机点屏（对应 `BACKLOG.md` U-02）。若实际点屏位置是战斗面板**内部**而非行动面板，需真机复核后再修正链路描述。

## 5. 明确不算问题：引擎已有、纯 yaml 即可接线

三态 `lifecycle` / `setNpcLifecycle` / `npcState` 条件 / 关系边死亡冻结 / 参战判活 / `deathRoute` / 前端 NPC 灰化标 `reasonCode`；多 `opening` + 前端自动下拉；`visibleWhen`、`action-hook`、`kind: combat`、`onVictory` / `onDefeat` / `onFlee`、`advanceTo`、`spawnNpc` + `npcSpawnRules`、`addRelationEdge`、schedule 的 `chapter` 条件隔离。第六轮死亡实装与第七轮新开局基本都是白捡这些能力。

## 6. 待办

1. 旧机源码找回后复核 §3.2，把「已重做未提交」的条目逐条销账或改写为已核验事实。
2. §1 三项能力缺失是否立项、何时动契约面，由主理人裁决（此前建议等旧机源码找回）。
3. §2 的根因归并（可见性 / 活跃度拆成两个维度 + `isEnemy` 历史债务清理）属架构级改造，关联 B-21 / B-22 / B-23，需单独立项与 ADR。
4. B-25 修复时机随下一轮前端迭代决定。
