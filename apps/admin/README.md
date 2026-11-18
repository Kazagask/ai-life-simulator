# 后台工具（本地开发用）

`http://localhost:3000/admin` —— 两个视图，只读，无构建步骤（纯静态 HTML/CSS/JS，由 server 直接托管）。

| 视图 | 看什么 |
| --- | --- |
| **Trace** | `data/worlds/<worldId>.trace.jsonl` 的 invocation 时间线：每轮模型调了什么工具、收/拒了什么、正文、延迟与 token、诊断与回执。 |
| **事件编排** | 模板 `events.yaml` 派生的事件图：`nextEventId` 边、触发条件、选项/转盘/战斗分支，以及 **flag 的写入方 / 读取方**（点旗标高亮读写双方），可叠加结局节点看可达性。 |

## 启用

trace 里是完整叙事正文（含本该被玩家窗口挡住的原文），所以**默认关闭**，必须显式开门：

```bash
LIFE_SIM_ADMIN=1 pnpm dev          # 然后访问 http://localhost:5173 是游戏，http://localhost:3000/admin 是后台
```

未开启时 `/admin` 返回 `403 admin_disabled`（不会被前端兜底误当成游戏页面）。

## 数据来源

- `GET /api/admin/worlds` —— 扫 `data/worlds`（`LIFE_SIM_DATA_DIR` 可覆盖），含不可载档。
- `GET /api/admin/worlds/:id/trace` —— 解析 jsonl（坏行跳过并计数），附聚合统计。
- `GET /api/admin/templates` / `GET /api/admin/templates/:id/:version/orchestration` —— 走 `TemplateRegistry`，与游戏同一份解析结果（不可载版本会带出拒载原因）。

只读：没有任何写接口；不会修改存档、模板或 trace。

## 已知限制

- 图布局是按 `nextEventId` 分层的简化布局（列内按 flag 写入重心排序），长链会横向铺开，需要拖动/滚轮缩放。
- `enqueueEvent` 效果画成虚线边；`chains` 目前只在接口里返回、未画。
- 事件图的 flag 统计只看平层条件（`trigger.conditions` / `option.visibleWhen` / `missWhen` / 结局条件）。
