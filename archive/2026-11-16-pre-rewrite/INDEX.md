# 归档：2026-11-16 推倒重来之前

> 本文件是归档说明（**索引**），归档内容本身在下面各目录里。
> 注意 `README.md` 是**被归档的旧仓库说明原文**，不是本索引。

**这里的任何内容都不构成现行约束。** 保留目的是排查「当初为什么这么写」，不是拿来当规格。

## 为什么归档

2026-11-15 用户裁决本轮为重大重构「推倒重来」：旧 ADR、`AGENTS.md`、`PROJECT.md`、
`specs/core/GAME_RULES.md` 里的硬约束只作为代码排查记录，不作实施阻碍。
到 2026-11-16，重构后的代码已经和这批文档大面积脱节（旧 478 例测试整体进了
`packages/game-core/legacy-tests/`、调度模型改成 `slot` + `delayQueue` + `taskDag`、
新增了 `agent-runtime` / `rpg-ui` 两个包），继续留在原位只会误导。

用户裁决：**spec 与 doc 完全归档，然后重写新规格。**

## 内容

| 路径 | 原位置 | 是什么 |
|---|---|---|
| `AGENTS.md` | 仓库根 | 旧工程规范（G1–G6 门禁、§0.3 模板/ADR 边界） |
| `README.md` | 仓库根 | 旧工程起点说明（含 PostgreSQL + Drizzle 等**从未落地**的栈描述） |
| `PROJECT.md` | 仓库根 | 旧迭代面板（最后快照 2026-11-13，R2.7） |
| `docs/` | `docs/` | ADR-0001..0038、BACKLOG、OPEN_QUESTIONS、`REFACTOR-DESIGN.md`、CLOUD_DEV、PROJECT_MEMORY |
| `specs/core/` | `specs/core/` | 一页纸规则、模板协议 V2、移动端 UX、demo 规格 |
| `specs/iterations/` | `specs/iterations/` | 历史迭代四件套（R2.7 / R2.8） |
| `specs/archive/` | `specs/archive/` | 更早的迭代与设计稿 |
| `specs/README.md` | `specs/` | 规格读取纪律 |
| `specs/data-examples/` | `specs/data/examples` | 模板片段样例 yaml |
| `specs/data-references/` | `specs/data/references` | 转盘内容素材（`.wheel.json`） |
| `tasks/` | `tasks/` | 实施计划、云端任务清单、验收报告 |

## 没有归档的

- `specs/data/templates/` —— **留在原地**。运行时资产，服务端按这个路径加载
  （`apps/server/src/templates.ts`，`TEMPLATES_DIR` 可覆盖）。挪走等于服务起不来。
- `packages/**`、`apps/**`、`packages/game-core/legacy-tests/**` —— 代码，不是文档。
  `legacy-tests/` 已被 vitest / tsc 排除，只是没有删。

## 如果要从这里拿东西

可以读，不要引用为「已裁决」。真要复活某条结论，先确认它在当前代码里还成不成立 ——
这批文档里大量行号、数据模型、测试计数（旧 game-core 478 例 / shared 67 例）都已失效。
