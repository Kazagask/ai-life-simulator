# R2.6 需求 · 关系图谱 + 时间适配器落地

> EARS 风格（When / The system shall / 验收 / 追溯）。编号：WS-A 日历 `R-CAL-*`，WS-B 关系图 `R-REL-*`。

## WS-A 时间适配器落地（#39 / #43 / #44 / #45）

### R-CAL-01 真实公历渲染
- **When** 模板 `time.calendar.preset` 为 `"gregorian"`，**The system shall** 用真实公历月长（28–31）与闰年规则渲染 `CalendarAdapter.format(minute)` 与 `elapsedYears(minute)`，并以 `meta.startYear` 为纪元起始年。
- **验收**：`worldTime` 跨 2 月/闰年时 `format` 与真实公历一致；年龄按**日历年边界**推进（跨年界 +1 岁，不精确到生日——生日精度见 `OQ #47`，ADR-0013 修订 R1）。
- **追溯**：#39（②③）、#43（候选 B）、ADR-0013 决策 2–3 / 修订 R1。

### R-CAL-02 自定义历/年号/纪元渲染
- **When** `preset` 为 `"custom"`，**The system shall** 按模板声明的 `months[]`/`leapRule`/`era` 渲染月份与年号（如「洪荒 3 亿年」「开元十二年」）。
- **验收**：`format` 输出含 `era.name`；年号年份由 `epochStartMinute` 起算；月长取自 `months[]`。
- **追溯**：#39（③）、#43（候选 C）、ADR-0013 决策 2/5。

### R-CAL-03 年龄按历法计算
- **When** 任意 `preset`，**The system shall** 经 `CalendarAdapter.elapsedYears(minute)` 计算经过年数（按**日历年边界**推进，不精确到生日），供 `player.age` 派生。
- **验收**：`createTimeAdapter(template).elapsedYears(worldTime)` 在 `gregorian`/`custom` 下按历法「年」字段差值计算（跨年界 +1），`approx` 下等同 `floor(minutes/525600)`；不要求生日精度（见 `OQ #47`）。
- **追溯**：ADR-0002、ADR-0012、ADR-0013 修订 R1、R-NP-04。

### R-CAL-04 字符串 TimeSpec 字面量解析
- **When** 输入为复合时长（`3d`/`2h30m`/`1y2m`）或历法日期字面量（`2006-12-24`、年号纪元串），**The system shall** 由 `CalendarAdapter.parseTimeSpec(spec, from)` 解析为内部分钟标量。
- **验收**：`parseTimeSpec("3d", 0) === 4320`；`parseTimeSpec("2h30m", 0) === 150`；非法字面量加载期/运行期抛可诊断错误。
- **追溯**：#44（方向 A）、ADR-0011 决策 2、ADR-0013 决策 3。

### R-CAL-05 引擎换算统一经适配器
- **When** 引擎内出现 `TimeSpec`→分钟换算（`enqueueScheduled`/`delay`/`timeCost`/`advanceBy`/`alignChainStep` 延时步），**The system shall** 全部经 `CalendarAdapter.toMinutes(amount, from)`，不得直接读 `UNIT_MINUTES`。
- **验收**：切换 `preset` 后同 `TimeSpec` 换算结果随历法变化；`approx` 下结果与现状一致（回归）。
- **追溯**：ADR-0013 决策 4。

### R-CAL-06 向后兼容（无 calendar 默认 approx）
- **When** 模板未声明 `time.calendar`，**The system shall** 默认 `preset: "approx"`（= 现状固定分钟近似），行为字节级兼容，旧模板零迁移。
- **验收**：删除 jjk-2006 的 `calendar` 声明后，全部时间与 R2.5 一致；schema 加载不报错。
- **追溯**：#45（保持现状）、ADR-0013 决策 4/5。

## WS-B 关系图谱（#25 / R-NP-08 / R-OP-05 / Q-R25-08）

### R-REL-01 关系边模型
- **The system shall** 以 `RelationEdge { from, to, kind, source, visibility, tier?, value? }` 统一表达 NPC↔NPC 与 NPC↔玩家关系，存于 `WorldStateV2.relations`（实例/事实层）。
- **验收**：初始化后 `state.relations` 含模板声明边；查询 API 按 `from`/`to` 返回边集合。
- **追溯**：#25、ADR-0014 决策 3。

### R-REL-02 默认不认识（R-OP-05）
- **When** 未显式建立关系，**The system shall** 将所有非声明关系视为 `visibility: "unknown"`，NPC 不默认认识玩家。
- **验收**：新建世界未声明边时，任意 NPC 对玩家的 `visibility` 为 `unknown`；投影层不暴露 `unknown` 边。
- **追溯**：R-OP-05、ADR-0014 决策 4。

### R-REL-03 多跳中文称谓（relationship.js 分层复用）
- **When** 存在已知亲属跳数路径，**The system shall** 将路径转为关系链记号交 `relationship.js` 求中文称谓；路径不唯一时取最短路径 + 确定性次序（字典序）。
- **验收**：五条↔夏油（假设为已知师兄弟路径）得确定性称谓；库无结果时回退粗称谓（不抛异常、不静默）。
- **追溯**：#40（已关闭）、R-NP-08、ADR-0014 决策 2/5。

### R-REL-04 图查询与断代
- **The system shall** 提供最短路径（BFS）、环检测、`ancestorGaps` 断代（显式 gap 标记 + 粗称谓，不猜代数）与师承称谓（走模板 `titleRules`）。
- **验收**：多代谱系查询返回最短路径称谓；断代处返回粗称谓而非臆造代数。
- **追溯**：ADR-0014 决策 2。

### R-REL-05 确定性
- **The system shall** 保证所有关系推导为纯函数，无 `Date`/随机数依赖，同输入 ⇒ 同输出。
- **验收**：固定种子/世界状态下同一关系查询两次结果完全一致。
- **追溯**：AGENTS.md §1、ADR-0014。

### R-REL-06 关系可见性投影
- **When** 投影给玩家，**The system shall** 仅暴露 `known`/`inferred` 关系边，隐藏 `unknown`/`hidden` 边（经 `projectNpc` 单一判定入口）。
- **验收**：API 返回的 `relations` 不含 `unknown` 边；`hidden` 来源不泄露。
- **追溯**：ADR-0012 决策 3（合并投影）、AGENTS.md §5。

## 追溯矩阵（需求 → ADR / OPEN_QUESTIONS）

| 需求 | ADR | OPEN_QUESTIONS | 备注 |
|---|---|---|---|
| R-CAL-01..06 | ADR-0013 | #39/#43/#44/#45 | WS-A |
| R-REL-01..06 | ADR-0014 | #25/#40/R-OP-05 | WS-B；#40 已关闭裁定分层复用 |

> 注：以上需求为 R2.6 本轮实施范围；R2.5 已关闭需求（如 R-NP-04 年龄派生）仅作能力复用，不重新验收。
