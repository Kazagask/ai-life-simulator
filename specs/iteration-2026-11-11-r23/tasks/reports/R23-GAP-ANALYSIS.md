# R2.3 差距分析（T0-01，只读复核）

**时间：2026-11-11 15:47 HEAD ｜ 结论：语义零漂移，行号小幅漂移（已回写 design.md §1），16 条 ACTIVE 均为「缺失」或「部分实现」，无一条已被实现，可进入阶段 1。**

## 一、design.md §1 file:line 复核（漂移项单列）

| design.md 引用（修订前） | HEAD 实际 | 判定 |
|---|---|---|
| `turn.ts:584` slice(-20) | `turn.ts:584` | 确认，无漂移 |
| `index.ts:257-262` 全量 history | `index.ts:261` | 漂移（行号），语义一致 |
| `main.tsx:1122-1141` 日志 Tab | `main.tsx:1117-1131` | 漂移（行号），语义一致 |
| 7 写入点 `battle.ts:616 / ending.ts:368 / npc.ts:63 / turn.ts:220,532,653,785` | `battle.ts:611 / ending.ts:363 / npc.ts:59 / turn.ts:218,530,651,783`（pushHistory 函数体 `turn.ts:613`） | 漂移（-2~-5 行），语义一致 |
| `turn.ts:519` 行动时长 | `turn.ts:517` | 漂移（行号） |
| `turn.ts:492` mode 死参数 | `turn.ts:492` | 确认（现还带 `endLife?`） |
| `store.ts:13` 内存 Map | `store.ts:15-16` | 漂移（行号） |
| `v2.ts:303` 背包投影 | `v2.ts:304` | 漂移（行号） |
| `equipment.ts:92,122` 穿脱纯函数、`:73` 输入 | `equipment.ts:92,122,73` | 确认，无漂移 |
| `main.tsx:1146 起` localStorage 续玩 | `main.tsx:1149-1169` | 漂移（行号） |

ADR-0006 重构（13b49c0）后两处行号相关事实已同步改写进 design.md：`EndingTemplateSchema` 无 `visibility`、隐藏结局 = `narrativeConfig.masked`；`EventV2Schema` 不加字段（#33 裁决）。

## 二、16 条 ACTIVE 现状标注

### VS 组（5 条）——全部缺失
| 需求 | 现状 | 依据 |
|---|---|---|
| R-VS-01 历史条目携带可见性 | 缺失 | `HistoryEntryV2`（`shared/v2.ts:146-155`）无 `visibility` |
| R-VS-02 三出口过滤 | 缺失 | `playerVisibleHistory` 仅 `slice(-20)`（turn.ts:584）；`/history` 全量（index.ts:261）；日志 Tab 原样渲染（main.tsx:1117） |
| R-VS-03 写入侧来源决定可见性 | 缺失 | `pushHistory` 无 visibility 参数；仅结局掩码继承一处待建（ending.ts:363） |
| R-VS-04 归档响应 public + 计数 | 缺失 | `assembleArchive` 全量返回（archive.ts） |
| R-VS-05 渗透测试 | 缺失 | 无对应测试文件 |

### PS 组（7 条）——全部缺失（前端侧已就绪是既有事实）
| 需求 | 现状 | 依据 |
|---|---|---|
| R-PS-01 存档选型 ADR | 缺失 | ADR-0007 未落盘（已含数据目录裁决：仓库根 `data/worlds/`，`LIFE_SIM_DATA_DIR` 可覆盖） |
| R-PS-02 状态 Zod schema | 缺失 | 全仓无 `WorldStateV2Schema` |
| R-PS-03 原子落盘 | 缺失 | `store.ts` 纯内存 Map |
| R-PS-04 世界列表/删除 | 缺失 | server 无 `/api/worlds` 列表与 DELETE 路由 |
| R-PS-05 启动加载校验 | 缺失 | 同上（无落盘即无加载） |
| R-PS-06 归档门禁 | **部分实现** | `save()` 归档拒绝 + `seal()` 唯一例外已存在（store.ts），差"落盘后仍保持门禁" |
| R-PS-07 往返一致性 | 缺失 | 无测试 |

### EQ 组（4 条）——引擎齐备，编排缺失（部分实现）
| 需求 | 现状 | 依据 |
|---|---|---|
| R-EQ-07 编排 equipV2/unequipV2 | 缺失 | 无 `equipment-turn.ts` |
| R-EQ-08 服务端端点 | 缺失 | index.ts 无 equipment 路由 |
| R-EQ-09 前端穿脱交互 | 缺失 | 装备栏只读 |
| R-EQ-10 属性逐字段不变断言 | 缺失 | 无对应测试 |

## 三、结论与放行

- 无一条需求已完成或被绕过；无漂移需要改设计（仅行号回写）。
- 遗留口径按规格默认执行：归档响应 = public + `hiddenHistoryCount`；模板指纹不匹配 = 拒绝加载。
- **T0-01 完成，用户已确认施工（2026-11-11），进入阶段 1（T1-01 ADR-0007 → T1-03 协议修订）。**
