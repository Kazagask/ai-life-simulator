# 任务：随机开局 / 前实例化

> 一次只做一个任务（G3）。**裁决已 closed（2026-11-18）**，实施顺序按用户裁决调整：
> T0 ✓ → **T2（self，第一步）** → T1 → T3 → T4 → T5 → T6。**全部完成（2026-11-18）**。

## T0 · YAML branch 角色分派（已完成）

- **状态**：DONE（2026-11-18）。
- **产出**：`selfIs` / `selfIsNot` 一等条件 + branch **node 级** `as` 变体 + 展开翻译（goto / 外部入边同形选项 self 门控，不额外占轮次）；SPEC §2.5 / REFACTOR-NOTES §5。
- **返工 1（2026-11-18）**：初版误做成 option 级 `as`（"某些角色才有的选项"），用户纠正为同一节点不同剧情；已改为 node 级变体、互斥整套正文/选项。
- **返工 2（2026-11-18）**：用户要求首节点也支持 `as`（共用触发器、首节点不一样，彻底 close）——放开首节点 as；多变体首节点共用父 trigger、兜底沿用父 id；新增 `selfIsNot` 给兜底变体；外部 `nextEventId` 指向多变体首节点时展开为 self 门控入边（random/combat 入边拒载）。
- **完成定义**：typecheck 0 错；LLM 侧未开放该字段；branch-expand 5 例 + self-gate 3 例通过。
- **备注**：运行时效果依赖 T2 self 切换（D-1）。

## T2 · self 完整切换（第一步 · 已裁决 D-1/D-3）

- **依赖**：无前置（用户裁决：self 重写是第一步）。
- **产出**：`createWorldV2(selfId)` 把玩家实例写入 `state.npcs[selfId]`；`state.player` 退化为别名；
  `projection.ts` / `battle.ts` 改读 `actorOf(selfId)`；关系边端点沿用 `selfId`；
  `store.ts` `SCHEMA_VERSION = 5`（旧档拒载）。
- **完成定义**：默认 `selfId = "player"` 时行为逐字段不变；self 指向 npc-gojo 时属性/战斗/投影一致；
  typecheck 0 错；定向探针覆盖。
- **需求**：R-SELF-01/02/03、R-OP-04、R-CMP-01。

## T1 · shared 契约 schema（在 T2 之后）

- **依赖**：T2。
- **产出**：`shared` 侧 OpeningParam / AllocationSpec / 会话契约 schema；
  `setIdentity.name` / `playerName` 可选 / 无名氏占位（R-NAME-01）。
- **完成定义**：typecheck 0 错；旧调用方签名零回归。
- **需求**：R-OP-03/04/05、R-NAME-01、R-CMP-02。

## T3 · 前实例化会话内核（game-core 纯函数）

- **依赖**：T1、T2（R-OP-04 的基本属性推理依赖 self 已可移动）；D-4 已裁决（无 weightBy）。
- **产出**：`resolveStep`（roll/choose/allocate）、`deriveOpeningRoll`、commit 写状态纯函数；
  开局记录落可选 state 切片。
- **完成定义**：commit 前无世界/npc/delayQueue；同 seed + 同序列结果一致；
  插步不改后续骰子；`turnIndex === 0`；typecheck 0 错 + 定向用例。
- **需求**：R-OP-01/02/06/07、R-RNG-01/02。

## T4 · server 会话端点（DONE 2026-11-18）

- **依赖**：T3。
- **产出**：`POST /openings`、`/openings/:id/step`、`/openings/:id/commit`、改名端点；
  会话持久化；建局表单 `playerName` 改可选。
- **完成定义**：端到端 curl 跑通 建会话→roll→choose→commit→世界；隐藏字段不进投影；
  typecheck 0 错 + 冒烟。
- **需求**：R-OP-01、R-NAME-01/02、R-CMP-02。

## T5 · web 开局向导（DONE 2026-11-18）

- **依赖**：T4。
- **产出**：开局向导（转盘动画 + 选项按钮 + 加点组件）；姓名框非必填；世界内改名入口；
  参数槽位"未决留空、已确定渲染"。
- **完成定义**：浏览器实测 建局向导全程 + 改名后列表同步；空名显示占位；web build 通过。
- **需求**：R-NAME-01/02、R-OP-02。

## T6 · jjk-2006 模板重写 + 天内理子短线（DONE 2026-11-18）

- **依赖**：T3、T5；D-2/D-5 已裁决。
- **产出**：`jjk-2006/2.0.0/` 新版本目录；开局 13 步迁入 opening branch DAG（主线 chain 保留）；
  新增天内理子短线：`as` 分派两个 badend（十二年前必死）；1.0.0 保留。
- **完成定义**：新版本加载期 fail-fast 通过；开局 turnIndex=0、无 delayQueue；
  13 步效果逐项等价；两个 badend 可达且 `as` 分派命中唯一分支；typecheck + web build + 冒烟。
- **需求**：R-TPL-01/02/03、R-CMP-01。

### T4–T6 实测收口（2026-11-18）

- `POST /api/openings` → 15 步（roll 自动 / choose 首项）→ `/commit`：世界 `turnIndex=0`、
  `worldTime=92d`、空种子名显示「无名氏」；`/rename` 200 且快照名同步。
- 前端：版本带 `openingDag` 时走向导；最终面板只列特质 / 技能 / 物品；姓名框可留空；
  顶栏新增改名入口。`pnpm --filter @life-sim/web build` 通过。
- 2.0.0 模板：旧 13 步事件链与 `chain-creation` 删除；新增 `evt:amane-short`，首节点 `as`
  变体与兜底按 `selfIs` / `selfIsNot` 互斥；两个 badend 有独立 ending + termination。
- 验证：`pnpm test` 45 文件 / 275 例全绿；`tsc --noEmit` 0 错；浏览器端 curl 级 e2e 见上。

## 交付门禁（每任务）

- 改动前给简短实施计划；严格限定在任务产出文件内。
- typecheck 全仓 0 错（关沙箱 + `node --stack-size=8000` 或禁用沙箱）。
- 本轮无测试框架（已全删），以定向探针 / curl / 浏览器实测替代，不重建 vitest。
- 不改权威 spec 语义，除非任务产出要求且已在 design 记录。

## 完成定义（整轮）

- T0..T6 全绿；五项汇报（改动 / 关键决策 / 命令与结果 / 风险 / spec 变更）齐全。
- 未决项写入 `docs/OPEN_QUESTIONS.md`；PROJECT 面板（若恢复）状态更新。
