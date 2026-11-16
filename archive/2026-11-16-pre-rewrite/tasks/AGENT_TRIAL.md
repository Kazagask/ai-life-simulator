# WorkBuddy / CodeBuddy 同题试做任务

请在同一个仓库、同一分支起点、同一份规格下完成本任务。不要先改写架构或技术栈。

## 任务：实现 game-core 的 P0 轮次推进最小闭环

### 输入
- 一个 `WorldState`
- 一个 `TurnCommand`（玩家行动、推进模式、可选目标时间）
- 一个 `WorldTemplate`
- 一个固定 `seed`

### 输出
- 新的 `WorldState`
- `TurnResult`（时间变化、玩家行动结果、NPC 行动、触发事件、人生记录、可见叙事事实）
- 可供 UI 使用的 player-visible projection

### 必须实现
1. 动态时间步长：按人生阶段默认步长；行动可指定耗时；关键时间边界不能被跨越。
2. NPC 自主行动：至少实现一个可解释的规则/权重选择器；NPC 只能使用自己的 knowledge。
3. 事件池：条件、权重/概率、冷却、once。
4. 动态事件链最小状态机：pending、active、completed、cancelled；至少支持一个条件分支。
5. 信息可见性：hidden secret 不得出现在 player-visible projection。
6. 可复现：相同初始状态、命令、模板和 seed，规则层结果一致。
7. AI 边界：本任务可以使用 Mock；AI 输出不得直接写状态。
8. 测试：至少覆盖上述 1–7 的关键路径和边界。

### 约束
- 只修改 `packages/game-core` 和必要的 `packages/shared`。
- 不引入新运行时服务。
- 不增加 Redis、队列或微服务。
- 不把模板专属规则写进通用引擎。
- 不为 P1/P2 需求提前实现复杂系统。
- 每个关键随机过程必须可注入 seed。
- 不允许用 `any` 绕过类型系统。

### 交付
- 可运行代码
- Vitest 测试
- 更新必要的文档
- 最终报告：实现摘要、文件变更、测试命令及结果、已知限制

### 评测记录（由项目负责人填写）
| 指标 | 权重 | WorkBuddy | CodeBuddy |
|---|---:|---:|---:|
| 功能正确性 | 30 | | |
| Spec 遵循 | 25 | | |
| 测试覆盖与通过率 | 20 | | |
| 自主排错能力 | 15 | | |
| 改动范围控制 | 5 | | |
| 时间/Token/费用 | 5 | | |
