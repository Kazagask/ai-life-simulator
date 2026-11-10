# 迭代任务简报模板

> 复制本模板填写，作为发起一轮迭代 / 召唤「人生模拟器研发团」时的任务描述。
> 四要素齐全可以显著减少来回确认：目标、输入、输出、约束。

```
目标：
  <一句话说明要达成什么，例如：完成 R2 阶段 0 差距复核 / 实施 T2-03 / 起草 R3 迭代包>

输入材料：
  - AGENTS.md
  - PROJECT.md（状态快照）
  - specs/iteration-<日期>/ 四件套：README.md、requirements.md、design.md、tasks.md
  - docs/DECISIONS.md（ADR）、docs/OPEN_QUESTIONS.md（待决项）
  - tasks/reports/<报告>.md（已有差距报告 / 验收证据）
  - 当前工作区实际代码（以代码为准，不以旧 spec 为准）

输出格式：
  - <具体文件与路径>
  - 汇报按 AGENTS.md §4：改动摘要 / 关键设计决策 / 执行过的命令及结果 / 未完成项与风险 / 是否修改 Spec
  - 是否需要更新 PROJECT.md 状态表：是 / 否

约束：
  - 范围：本轮 ACTIVE 需求 = <条数>；DEFERRED / RETIRED 只登记，不实现、不测试、不验收
  - 阶段 0/1 完成前不得修改实现代码
  - 涉及核心数据模型 / 技术栈 / 目录结构 / 游戏规则变更，先写 ADR
  - 一次只做一个 T<阶段>-<序号> 任务，小步提交
  - 同一时刻只允许一个 Agent 写 packages/
  - 不确定的产品规则写 docs/OPEN_QUESTIONS.md，不要自行伪造共识
  - 语言：中文
```

## 常用简报示例

### 1. 复核差距报告（只读，不动代码）
```
目标：复核 R2.2 阶段 0 差距报告。
输入：specs/iteration-2026-11-11/ 四件套、AGENTS.md、当前 packages/ 与 apps/ 代码。
输出：更新 tasks/reports/R2-GAP-ANALYSIS.md，45 条 ACTIVE 需求逐条标注五态。
约束：不改任何实现代码；7 条 DEFERRED、6 条 RETIRED 只登记；另核查 design.md §8 末三个时间穿越接口预留点现状。
```

### 2. 实施单个任务
```
目标：实施 T2-03（<任务名>），并按其完成定义自验。
输入：tasks.md 中该任务的依赖、追溯需求、产出文件、完成定义；design.md §4 文件归属。
输出：改动文件 + 测试 + 按 AGENTS.md §4 的汇报。
约束：只做这一个任务；先确认依赖已完成；不改 Spec；类型检查与相关测试必须通过。
```

### 3. 起草下一轮迭代包
```
目标：起草 R3 迭代包，把 R2 延期的 7 条 R-TT-* 时间穿越需求转为可执行规格。
输入：specs/iteration-2026-11-11/ 附录 A 的 R3 任务原文、design.md §8 语义草案、ADR-0002。
输出：specs/iteration-<日期>/ 四件套（新增文件，不改代码）。
约束：编号不重排；ADR-0005 留待实施阶段；先审查对齐再谈实现。
```
