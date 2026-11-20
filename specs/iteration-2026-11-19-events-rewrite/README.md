# iteration-2026-11-19-events-rewrite

3.0.0 的事件分两件事：把「2.0.0 留下的语法债」清掉，把「开局」接上正文。
本轮只做清债 + 开局链路；L2–L6 的正文重写按波次（W2 起）逐章替换。

## 四条需求（用户 2026-11-19）

1. **3.0.0 得把 2.0.0 的事件删了重写**：原有很多事件是公共事件、还没判人；
   理子那条只为验语法写的短线还影响开局（活不过第二个事件）。
2. **主线别用 pool 触发，用 schedule 定时触发。**
3. **技能效果的状态一般只在战斗里用，不打品质标。**
4. **开局应该根据开局信息生成一段 LLM 文本，然后衔接一个开局事件。**

## 裁决与落地

| # | 裁决 | 落地 |
|---|---|---|
| 1a | 理子短线**整条删除**（含 2 个坏结局 + 2 条终止条件） | `events.yaml` / `endings.yaml`；`evt:amane-short` 在 3.0.0 与后续版本都不再出现 |
| 1b | 公共日常**保留 + 判人**：点名谁，就把谁写进 `actors`（出队前复核在场） | 12 个日常补 `actors`（夜蛾 / 五条 / 夏油 / 硝子 / 七海 / 灰原 / 虎杖 / 伏黑 / 钉崎 / 乙骨） |
| 1c | L2–L6（`ev-bs-*` / `ev-df-*` / `ev-np-*` / `ev-jv-*` / `ev-sh-*` / `ev-cg-*` / `ev-sj-*`）**逐波替换**（W2 起），不做大爆炸删除 | 见下方「为什么不一次性删干净」 |
| 2 | 七个章节门 `pool → schedule`，`window.start = 原 time 门槛` | `ev-ch1-gate … ev-ch7-gate` |
| 3 | 只在战斗内出现的技能状态去掉品质标签，只留 `buff` / `abnormal` | `domain-active` / `black-flash` / `disclosure` / `vow-boost` / `curse-sight` |
| 4 | 序章（LLM，可回退）+ 第一幕（模板声明的 `ev-open-01`），commit 当场呈现 | `docs/adr/20-事件与世界时间.md`（原 ADR-005） |

## 为什么不一次性删干净 L2–L6

`pnpm inspect check` 的 `ending-unreachable` 是 **error**：删掉一条链，它写的旗标就成了死旗标，
读这些旗标的结局立刻报错。今天一次删完 L2–L6 意味着同时删掉新宿 / 死灭 / 涩谷 / 0 卷的全部结局，
留下的不是「更干净的重写起点」，是一份跑不到结局的半成品。

所以删除与重写必须是**同一步**：W2 落地时删 L2，W3 落地时删 L3，依此类推。

## 另一个顺手修的 bug：结局面再多点一回合

`chooseOptionV2`（选项结算）此前**没有**调用 `applyEndingBoundary`：选项里 `setFlag` 写下的
结局旗标要等到下一次 `advanceTurnV2` 才被判定，于是玩家看到「已经到结局了，还要再点一轮才 end」。
现在选项结算当场走终止边界（与战斗 / 自由行动 / 转盘确认同口径，判据仍是落盘旗标）。

- 回归：`test/unit/ending-boundary.test.ts`（选项落地即 `termination`，无旗标不误判）。
- 连带：`test/helpers/p0-flow.ts` 不再「必须多推一回合」。

## 版本与档

- 只改 `specs/data/templates/jjk-2006/3.0.0/`；`2.0.0` 冻结不动。
- 模板指纹变化 ⇒ 3.0.0 的旧存档拒载（`schemaVersion` 不变）。

## 第二轮：施加目标 / 登场时点 / 关系行（用户 2026-11-19 后四条）

| # | 需求 | 落地 |
|---|---|---|
| 5 | 施加效果要写清施加给谁（无量空处 = 自己挂领域展开、全体敌人挂压制与眩晕） | `applyStatus.target`（`self` / `skill` / `all_enemies` / `all_allies`），引擎把 `self` 与全场阵营移出目标循环；详情写「（自身）/（全体敌人）」。**顺带修 bug**：旧 `onSelf` 在目标循环里跑，打三个敌人就给自己叠三层 |
| 6 | 开局去掉虎杖他们；所有 NPC 到章节时间点再生成，别靠事件生成 | `npcSpawnRules[].when` 定时（215 / 4370 / 4538 / 4680 / 4700 / 4736 天，与章节门同源）；删掉 `ev-np-01` 里的 `spawnNpc` |
| 7 | 甚尔 / 漏壶 / 羂索 / 宿傩（三形态）做成 NPC，按情况 hidden；`enemy` 只留野怪 | 六个 `enemy-*` → `npc-*`，`isEnemy: false` + `visibility: hidden` + 定时登场；参战事件补 `npcs:` 兜底（空敌人会被判即胜） |
| 8 | 关系只有推断/确知和一个裸数值；不实例化的写着「无档案」 | `counterpartState`（尚未登场 / 未现身 / 不在名册）替掉「无档案」；数值换档位（深厚/亲近/平常/疏远/敌视）；可见性词表补全四档 |

裁决记录：`docs/adr/40-属性资源与状态.md`（原 ADR-006 D1 施加目标）+ `docs/adr/20-事件与世界时间.md`（D2 登场时点）。

## 第三轮：世界时间表 / 关系知情人范围（用户 2026-11-19 后两条）

| # | 需求 | 落地 |
|---|---|---|
| 9 | 2006 年的五条卡上不该有伏黑惠；建立关系不该和剧情强相关，协议层要有通用事实调度（不占事件槽、无需确认但真实发生），NPC 生成 / 固定时间 / 效果叠加都走它 | `world.scheduledFacts`（`when` + 任意 `EffectSchema`），回合 tail 求值、`state.facts` 记 id、一事实一次、不吃主轮 RNG；`npcSpawnRules.when` 删除，`rule-*` 只剩「是谁、几岁」；`fact-gojo-takes-megumi` 在 4538 天建双向师承，`characters.yaml` 里两条初始关系删除 |
| 10 | 完全不知道的不上屏；可见性不该是"单向给玩家"，要能对等切换，改成公开 / 部分人知道 / 仅自己知道 | `RelationEdge.scope`（`public` / `limited`+`knownBy` / `private`），唯一读法 `relationScopeOf`（旧 `visibility` 折算）、唯一判定 `relationVisibleTo(edge, viewerId)`；投影一次只喂一个 `selfId`；展示只画非公开档 |

裁决记录：`docs/adr/20-事件与世界时间.md`（原 ADR-007 D1 世界时间表）+ `docs/adr/50-关系与演员.md`（D2 关系范围）。

## 验收

- `pnpm test`：**62 文件 / 414 例全绿**（新增 `scheduled-facts`；`relation-display` 按新口径重写）。
- `pnpm inspect check`：error 0 / warn 22（无新增告警）。
- `pnpm typecheck`、`pnpm build`（web）通过。

## 下一波（W2）

L2 苦夏（2007，8 幕）：灰原之死 / 夏油独白 / 村庄 / 杀村民 / 杀父母 / 新宿 / 高层处分 / 盘星教，
四个出口（`gone` / `stayed` / `dead` / `followed`）+ 五条 / 夏油 / 灰原三条关系线 + `debt.*`。
语法按本轮口径：`schedule` 开场、每幕至多一组选项 + 一个转盘、`actors` 判人。
