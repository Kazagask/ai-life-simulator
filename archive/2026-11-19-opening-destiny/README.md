# 旧开局归档 · op-2006-destiny

`opening.yaml`（643 行，`openingId: op-2006-destiny`「命数十二年」）于 **2026-11-19** 被
`specs/iteration-2026-11-19-jjk-story-lines/draft/opening-v3.yaml` 取代（22 节点 / 64 参数）。

**为什么换**：v3 把「你是谁 / 从哪儿来」做成第一格转盘，六种出身 = 六条站位的入口，
并且把术式、领域、天赋、体质、高阶技巧全部改成抽（旧开局是 13 步里几格固定选项）。
设计口径见 `design.md`，落地记录见 `draft/opening-v3.md` §8。

**旧开局里仍被沿用的东西**（v3 已逐条接住，别再当成"丢了"）：

| 旧局写法 | v3 对应 |
| --- | --- |
| 入学式一次性落 `creationDone` / `openingDone` / `chapter` / `ready1` | 入场节点落 `creationDone` / `openingDone` + 20 个章节基线旗标；`chapter` / `ready` 改由出身选项写 |
| 92 天时间锚（2006-04-03） | 2006 组出身与五条/夏油/理子路径写 `clock: 92d`；晚起点写 11–12 年 |
| `openingPath: tokyo` / `kyoto` | 没有人读，随旧局一起下线 |
| 第六格「咒具」转盘（`eq-ten-spear` 等） | 咒具改成 `items.yaml` 里的实体；开局不再白送，靠剧情与战利品 |

**存档影响**：模板指纹随 world/items/skills/statuses/opening 一起变了，
`data/worlds/` 下的旧世界会被拒载。要复现旧局只能把这份文件拷回
`specs/data/templates/jjk-2006/2.0.0/opening.yaml`（同时要回滚同批模板改动）。
