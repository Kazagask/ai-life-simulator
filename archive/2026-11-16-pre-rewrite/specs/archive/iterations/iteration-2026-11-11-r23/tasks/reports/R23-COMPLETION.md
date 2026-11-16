# R2.3 完成报告（T6-02，2026-11-11 16:40）

**结论：16 条 ACTIVE 需求全部通过；阶段 8 四项与阶段 4（时间跨度）按裁决 DEFERRED，不计入本轮。**

## 一、验收命令（T6-01）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0（0 错误） |
| `pnpm test` | **238/238 通过**（17 文件；R2.2 结束时 210） |
| `pnpm --filter @life-sim/shared test` | 37/37 通过 |
| `pnpm --filter @life-sim/web build` | 通过（bundle 251.20 kB / gzip 77.97 kB） |

## 二、需求逐条状态

### VS 组（可见性收口）——5/5 通过
| 需求 | 状态 | 证据 |
|---|---|---|
| R-VS-01 历史条目可见性 | 通过 | `HistoryVisibility` + `visibility?` + `isPlayerVisible()` 唯一判定（`shared/v2.ts`） |
| R-VS-02 三出口过滤 | 通过 | `playerVisibleHistory`（先滤后截）/ `/history` / 归档投影统一走 `history.ts`；`history-visibility.test.ts` |
| R-VS-03 写入侧来源决定 | 通过 | `pushHistory` 签名必填（删 visibility → TS2345 自证）；7 写入点补齐；死亡事件按掩码回填 |
| R-VS-04 归档 public+计数 | 通过 | `projectArchiveForPlayer`；`hiddenHistoryCount=1` 用例；存档事实保留全量 |
| R-VS-05 渗透测试 | 通过 | 12 用例递归扫描四出口；反向自证（过滤器置 true → 6 用例失败） |

### PS 组（存档持久化）——7/7 通过
| 需求 | 状态 | 证据 |
|---|---|---|
| R-PS-01 选型 ADR | 通过 | **ADR-0007**（JSON 原子写；仓库根 `data/worlds/`，`LIFE_SIM_DATA_DIR` 可挂载；指纹拒绝加载） |
| R-PS-02 状态 schema | 通过 | `WorldStateV2Schema` strict + 双向断言；真实快照通过；坏字段给路径（含上线后补的 `npcs.inventory` 修复） |
| R-PS-03 原子落盘 | 通过 | tmp+rename；写失败（循环引用注入）旧文件完好、tmp 不残留 |
| R-PS-04 列表/删除 | 通过 | `GET /api/worlds`（savedAt 倒序）/ `DELETE`；前端两段式首屏 + 删除确认 + 失效提示 |
| R-PS-05 启动加载 | 通过 | 四道关（parse/version/指纹/Schema）坏档 error 跳过；`state_schema_invalid: npcs.0` 真实命中并修复 |
| R-PS-06 归档只读 | 通过 | 封存落盘 archived=true；save 拒写；加载后的 archived 世界仍走门禁 |
| R-PS-07 往返一致 | 通过 | 落盘→读回→schema→`toEqual` 逐字段相等（含 flags/chains/firedEvents/history） |

### EQ 组（装备穿脱）——4/4 通过
| 需求 | 状态 | 证据 |
|---|---|---|
| R-EQ-07 编排+端点 | 通过 | `equipV2/unequipV2`（不推进时间）；409/400 错误码映射；七错误码逐一用例 |
| R-EQ-08 时间不变 | 通过 | 成功穿脱 `worldTime/turnIndex` 不变 + 1 条 public 历史 |
| R-EQ-09 前端交互 | 通过 | 背包「装备」/装备栏「卸下」+ 七种错误码中文文案；端到端「装上→卸下→换上」冒烟通过 |
| R-EQ-10 属性不变 | 通过 | 穿脱前后 `player.attributes` 逐字段相等；effective 差值=补正值；实例键集合无补正字段 |

### 端到端证据（DoD 三条）
1. **重启续玩**：强杀 server 进程（taskkill /F /T）→ tsx watch 重新拉起 → 同一 `worldId` GET 成功，turnIndex/formattedTime/历史逐字段保留；世界列表 2 局正常。
2. **历史无 hidden**：渗透测试常驻（12 用例）；冒烟 `/history` 全部 `visibility: public`；掩码结局死亡事件条目在服务端存档为 hidden、玩家端不可见。
3. **界面穿脱**：jjk-2006 装观察者护符→卸下→not_owned(400) 文案→再装上，历史落「装备了/卸下了」3 条。

## 三、诚实登记（风险与取舍）

- `npc_action` 不分级（#32）：玩家不在场时的 NPC 行为仍可见，需在场/距离模型，超出本轮。
- 指纹不匹配 = 拒绝加载：模板 YAML 每次变更旧档作废（本轮 jjk 加初始饰品即作废了改动前存档）；模板稳定后可引入迁移。
- 归档响应按默认口径 public+计数（#32 待最终确认）；单机 JSON 存储，无并发写保护（Node 单进程同步写足够）。
- 跨模板验证只在 jjk-2006 上完成（阶段 8 延期）。
- 时间跨度 DEFERRED（用户裁决「不改引擎」，寿终不可达是模板内容密度问题，另行立项）。

## 四、提交清单（本轮）

`cd8d7d4`(docs T0/T1) → `7e81b77`(T2-01) → `e50ed6e`(T2-02/03) → `05123bc`(T3-01..03) → `8e4ecef`(T3-04) → `eb9f237`(T5-01/02/04) → `28b4d2b`(T5-03) → `44c4222`(schema 修复)
