# 后台工具（本地开发用）

`http://localhost:3000/admin` —— 三个视图，只读，无构建步骤（纯静态 HTML/CSS/JS，由 server 直接托管）。

| 视图 | 看什么 |
| --- | --- |
| **Trace** | `data/worlds/<worldId>.trace.jsonl` 的 invocation 时间线：每轮模型调了什么工具、收/拒了什么、正文、延迟与 token、诊断与回执。 |
| **事件编排** | 模板 `events.yaml` 派生的事件图：`nextEventId` 边、触发条件、选项/转盘/战斗分支，以及 **flag 的写入方 / 读取方**（点旗标高亮读写双方）、**角色线**（点左栏角色，高亮他出场的每一场，右栏给出身份卡 + 生死迁移 + 场景清单），可叠加结局节点看可达性。 |
| **战斗木桩** | 左边选模板版本 / 受测角色 / 对手（角色或木桩），右边出胜率、场均回合、DPR、承伤、命中率、每局 MP、技能使用与逐局明细。 |

## 战斗木桩（第三视图）

页面只是 `simulateDuel`（`packages/game-core/src/v2/sim.ts`）的遥控器：**它不重算任何伤害公式**，建世界 → 摆对手 → 每回合挑技能 → 交给真实的 `performBattleAction`，所以量到的数字就是玩家真打出来的数字。等价命令行：

```bash
pnpm inspect sim --tpl jjk-2006@3.0.0 --as npc-gojo --dummy hp=5000,agility=8 --repeat 20
```

- 接口：`GET /api/admin/templates/:id/:version/roster`（角色 / 状态 / 物品下拉）、`POST /api/admin/sim`（请求体 `{ templateId, version, spec }`，`spec` 即 `SimDuelSpec`）。
- 表单的自由文本走白名单收窄：`agility=8,physique=10` 解析成属性覆盖，`six-eyes,infinity` 解析成状态覆盖；`repeat ≤ 200`、`maxRounds ≤ 100`，防止一局木桩把服务端拖死。
- 左侧只能是角色（玩家位从角色卡打底），右侧可以是角色或「木桩」（合成角色：无技能、不还手，`hp` 直接写在战斗单位上，不受 `75 + 5×咒力` 约束）。
- 抓不到的失败会原样回显内核文本（如 `sim_actor_not_found: npc-nobody`），不会返回 500。

## 启用

trace 里是完整叙事正文（含本该被玩家窗口挡住的原文），所以**默认关闭**，必须显式开门：

```bash
LIFE_SIM_ADMIN=1 pnpm dev          # 然后访问 http://localhost:5173 是游戏，http://localhost:3000/admin 是后台
```

未开启时 `/admin` 返回 `403 admin_disabled`（不会被前端兜底误当成游戏页面）。

## 命令行（agent 用）

网页是给人看的，命令行是给 agent 看的。两者**共用 `apps/server/src/admin-data.ts`** 的同一份推导：

```bash
pnpm inspect                          # 概览：模板版本 + 体检 + 世界列表
pnpm inspect check                    # 只跑体检；有 error 时 exit 1（可挂 CI）
pnpm inspect tpl                      # 模板详情（默认取当前存档用的版本）
pnpm inspect tpl --grep 理子           # 搜事件（id / 标题 / 叙事 / 选项 / 角色名）
pnpm inspect tpl --line ev-hv-06      # 一条支线走到底：分支 + 可见条件 + 写入旗标 + 涉及结局
pnpm inspect tpl --line hv            # 只给线名：按前缀列出整条线（按 eventId 排序）
pnpm inspect tpl --npc 夏油            # 角色线：身份卡 + 登场/生死 + 参与的每一场 + 转折旗标
pnpm inspect tpl --flag savedRiko     # 该旗标谁写谁读（含开局写入）
pnpm inspect tpl --event ev-d-canteen # 该事件的触发 / 选项 / 效果
pnpm inspect tpl --endings            # 结局与终止条件
pnpm inspect trace                    # trace 时间线（默认回合数最多的存档）
pnpm inspect trace --limit 5 --full   # 最近 5 条并展开正文
```

通用开关：`--json`（机器可读）、`--tpl id@version`、`--world id`、`--depth N`（支线树深度，默认 12）、`--all`（连 info 一起显示）、`--verbose`（打印模板扫描警告）。

三个「线」的推导在 `apps/server/src/admin-lines.ts`，网页（`/api/admin/templates/:id/:version/npc/:npcId`）和命令行共用——**不要在两侧各写一套**，否则迟早对不上。

### 角色线怎么判"他出场了"

模板里的角色引用分四种，全部要抓，否则会漏戏：

| 形态 | 例子 | 标注 |
| --- | --- | --- |
| 显式阵容 | `actors` / `mentions` / `npcs`（jjk-2006 没写） | 在场 / 提及 / 登场 |
| 效果引用 | `adjustRelation.npcId` / `setNpcLifecycle` / `addSecret` / `spawnNpc.ruleId`→`characterRef` | 关系 / 生命周期 / 秘闻 / 登场 |
| 条件引用 | `relation: npc-x` / `npcState.npcId` | 触发条件 / 选项条件 |
| 战斗与文本 | `combat.enemies/allies.ref`、正文或选项里出现名字 | 战斗 / 正文提及 / 选项提及 |

`⚑ x（读 N）` 是**转折旗标**：这场戏写入的、被 ≥2 处读取的旗标。角色线靠它才看得出哪一步是分叉点（夏油线的 `getoStayed` / `getoGone`）。

### 体检规则

命令行的价值不在"再描一遍网页"，而在**把写错了却不会报错的形态找出来**：

| 规则 | 级别 | 含义 |
| --- | --- | --- |
| `dangling-edge` | error | `nextEventId` / `enqueueEvent` 指向不存在的事件 |
| `orphan-chain-event` | error | `source: chain` 但没人排队它（已排除开局 `handoff` 直接塞的那些） |
| `sink-event` | warn | 链上事件没有出边（`nextEventId` / 转盘 / 战斗结果 / `goto` / `enqueueEvent`），也没写结局或终止条件读取的旗标（`setFlag` 与 `adjustFlag` 都算「写」） |
| `flag-never-written` | error / warn | 有条件在读、全模板没人写；被结局/终止读时算 error（结局永远打不开） |
| `ending-unreachable` | error | 结局的触发或解锁条件里有死旗标 |
| `unknown-condition-ref` | warn | 条件里引用的属性 / 状态 / 物品 / 技能 / 角色不存在 |
| `flag-never-read` | info | 只写不读，多半是留作伏笔，不算错 |

两个容易误报的地方已经处理：**开局写的旗标算写入方**（legacy `characterSetup.flags` / dag 的 `set`），**开局 `handoff` 排队的事件不算孤立**。

## 数据来源

- `GET /api/admin/worlds` —— 扫 `data/worlds`（`LIFE_SIM_DATA_DIR` 可覆盖），含不可载档。
- `GET /api/admin/worlds/:id/trace` —— 解析 jsonl（坏行跳过并计数），附聚合统计。
- `GET /api/admin/templates` / `GET /api/admin/templates/:id/:version/orchestration` —— 走 `TemplateRegistry`，与游戏同一份解析结果（不可载版本会带出拒载原因）。
- `GET /api/admin/templates/:id/:version/npc/:npcId` —— 角色线（身份卡 + 生死迁移 + 场景清单），网页点左栏角色时调用。

只读：没有任何写接口；不会修改存档、模板或 trace。

## 已知限制

- 图布局是按 `nextEventId` 分层的简化布局（列内按 flag 写入重心排序），长链会横向铺开，需要拖动/滚轮缩放。
- `enqueueEvent` 效果画成虚线边；`chains` 目前只在接口里返回、未画。
- 事件图的 flag 统计只看平层条件（`trigger.conditions` / `option.visibleWhen` / `missWhen` / 结局条件）。
