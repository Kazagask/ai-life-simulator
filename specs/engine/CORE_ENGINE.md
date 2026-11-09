# 核心流程引擎规格 V0.1

## 1. 目标

实现可测试、可复现、与世界模板解耦的模拟内核。逻辑轮次不等于固定世界时间；每轮时间步长由配置和上下文动态决定。

## 2. 时间模型

### 2.1 时间概念
- `WorldTime`：世界内绝对时间（建议以分钟或统一整数 tick 表示）。
- `TurnIndex`：逻辑轮次序号。
- `LifeStage`：人生阶段，例如 childhood、youth、adulthood、elderhood；具体阶段由模板定义。
- `CalendarAdapter`：将内部时间映射为模板显示日期（年/月/日/时代纪年）。

### 2.2 动态步长
时间步长由 `TimePacingPolicy` 决定，输入至少包括：
- 当前人生阶段
- 当前年龄/角色状态
- 世界模板默认步长
- 玩家行动类型及其预计耗时
- 当前事件是否需要精细时间
- 是否存在临近的关键事件或截止时间

输出：
- `delta`
- `unit`
- `reason`
- 可选 `nextBoundary`（例如下一个生日、事件截止时间）

规则：
- 日常生活可按天/周/月推进。
- 长期训练、等待、旅行可按周/月推进。
- 重大事件、战斗、对话可缩小到小时/分钟。
- 不允许越过必须处理的事件边界；若会越过，应切分推进。
- 时间单位和人生阶段均由模板配置，不得硬编码在通用引擎中。

## 3. 轮次流程

```text
load state
  -> determine time delta
  -> validate player action
  -> resolve player action
  -> advance world clock
  -> schedule NPC autonomous actions
  -> resolve NPC actions
  -> evaluate event pool
  -> advance active event chains
  -> apply validated system effects
  -> update relationships / visibility / history
  -> calculate life evaluation when required
  -> produce player-visible snapshot and narrative request
```

顺序可因具体实现调整，但必须保证：
- 玩家行动、NPC 行动、事件结算有明确阶段。
- 事件链有稳定 ID 和阶段状态。
- AI 叙事失败不能导致重复结算。
- 同一输入和 seed 下，规则层结果可复现。

## 4. NPC 自主行动

NPC 至少具备：
- `goals`
- `traits`
- `relationships`
- `knowledge`
- `secrets`
- `availableActions`
- `lastActedAt`

P0 可采用规则/权重选择行动，不要求完整 GOAP。NPC 只能基于自身可见信息决策，不得使用全局隐藏信息。

## 5. 事件池

事件定义至少支持：
- `id`, `type`, `priority`
- `conditions`
- `weight` 或 `probability`
- `cooldown`
- `once`
- `effects`
- `chain` / `nextEventIds`
- `visibility`
- `source`（template/system/AI-proposed）

事件触发采用可解释的规则：满足条件后，根据优先级、权重、概率和冷却筛选。事件效果由规则层结算。

## 6. 动态事件链

事件链是可持久化的状态机，不是一次性生成的长文本。
- 支持 pending / active / paused / completed / cancelled。
- 每个节点有触发条件、期限、分支和效果。
- 玩家行动和 NPC 行动都可能改变后续条件。
- 事件链允许被打断、延迟、失败或偏离原定剧情。
- AI 可以提出事件链草案，但需经过 schema 和规则校验。

## 7. AI 边界

AI 允许：
- 把自然语言行动解析为结构化候选行动。
- 提出动态事件/事件链候选。
- 生成叙事、摘要、人物对话。
- 根据可见事实生成推测性内容，并明确标注推测。

AI 不允许：
- 直接修改权威世界状态。
- 创建违反模板规则的能力/物品/人物。
- 读取或泄露当前观察者无权获知的秘密。
- 决定未经过规则层验证的战斗/行动结果。

## 8. 人生评价

评价不是单一分数。P0 至少生成：
- 关键选择摘要
- 重要关系变化
- 目标完成/放弃
- 成就与遗憾
- 对他人/世界造成的影响
- 阶段性评价文本

评分权重应配置化；P0 可以先采用可解释的规则评分，AI 仅润色评价文本。

## 9. 必须覆盖的测试

- 不同人生阶段产生不同默认步长。
- 特殊行动可覆盖默认步长。
- 时间推进不能越过强制事件边界。
- NPC 只基于自身知识行动。
- 冷却中的事件不会重复触发。
- once 事件只触发一次。
- 动态事件链能分支、暂停和结束。
- AI 失败不会重复执行玩家行动或 NPC 行动。
- 相同 seed 和输入可复现规则层结果。
