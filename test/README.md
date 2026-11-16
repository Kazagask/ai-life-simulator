# 测试目录（约定）

**当前没有任何测试。** 2026-11-17 用户裁决：

> `测试全删 现在测试写的乱七八糟的 好多都不用了 你先把代码写好 再谈测试`

旧的 42 个 `*.min.test.ts`、38 个 `legacy-tests/` 文件、6 个 vitest 配置已全部删除，
CI 里的三条测试门禁（L1 / L2 / L2b）也一并移除。

## 新测试要遵守的三条

1. **只放这里**，不要再塞回 `packages/*/src/**` 或 `apps/*/src/**`。
   源码目录里出现 `*.test.ts` 视为违规。
2. **不进 npm 包**。各包都是 `private: true`、`exports` 直连 `src/`，
   所以更要显式声明打包边界（`files` / `.npmignore`），别让测试代码被带上。
3. **不依赖源码目录里的测试专用 helper**。夹具、mock provider、内存 store 都放本目录，
   通过包入口 import 被测代码；需要"源码侧提供测试钩子"时先问，不要直接往 src 加。

## 还没定的事（等用户裁决）

- 测试框架：vitest 依赖仍在，但配置已删；是否沿用、要不要换 node:test。
- 分层：单元 / 契约 / 端到端（剧本级）分别跑什么，怎么进 CI。
- 验收基线：此前基线是 `*.min.test.ts`（338 例）+ `demo-agentic` 整局回归，两者都已不存在。

**2026-11-17 用户已定的两条硬要求**（写测试时必须遵守）：

1. **单侧的 LLM 层走 mock** —— 不真的联网打模型。
2. **mock 数据必须来自真实跑出来的一条 trace**（录制 → 回放），
   不允许手搓一份"看起来像"的 payload —— 手搓的 mock 只能证明代码自洽，证明不了模型真的这么说过。

在以上定下来之前，`pnpm test` 不是一个可用的命令。

> 全部裁决的集中记录见 `docs/REFACTOR-NOTES.md`（不是规格，是新规格落地前的唯一有效记录）。

## 下次设计测试时必须补的覆盖点（`fact.*` 下线后失去的）

2026-11-16 把 `fact.setKnowledge` / `fact.advanceDag` / `fact.upsertDagBranch` / `fact.enqueueEvent`
四个写工具从工具面下线（`d2c311f`）。原来断言这些行为的用例随全套测试一起删了，
**这些行为现在没有任何自动化保护**。重建测试时逐条认领：

| # | 失去的覆盖点 | 现在靠什么保证 | 该补的断言 |
|---|---|---|---|
| 1 | `dispatch("fact.*")` 返回 `unknown_tool` | 无（默认分支） | 四个名字各 dispatch 一次，断言 `unknown_tool` |
| 2 | `story.submitBranch` 节点级 `npcs` 的 alias → 角色 / 刷新规则解析 | 生产构造点已接 `lookup`（`pipeline.ts`） | 接 `lookup` 时能解析、不接时未知引用被拒（而不是静默透传） |
| 3 | 分支事件跨轮写护栏（ADR-0035 `crossTurnViolation`） | 引擎边界 | 上一轮提交的分支在这一轮才落账 ⇒ 必须拒 |
| 4 | 模板 `once` 事件不被 LLM 复活 | `scheduler` 侧 `hasFired` | 旧路径已不可达（LLM 无法指名模板事件），但调度侧守卫本身要单独验 |
| 5 | `validateDag` 对 `fallbackDag` 的加载期校验 | 模板加载 | 环 / 自环 / 悬空端点 / guard 不可解析 四类各一例 |
| 6 | 知识只由 `knowledgeGrants` / `inferenceRules` 授予 | `assignKnowledgeGrants` | 规则命中 ⇒ 台账有；未命中 ⇒ 台账无（不靠模型自述） |
| 7 | `upsertDagBranch` 的增量语义 | **能力已删除** | 不需要补；若将来重启"LLM 写 DAG"，先立协议再谈测试 |

另外两条与 `fact.*` 无关、但同样曾失去保护的：

- **`visibility: hidden` 只影响上屏、不影响实例存在与参与规则**（`866204a`）
- **关系投影与 NPC 卡片解耦**：指向未实例化/敌人/隐藏角色的边要上屏，`withName` 不得是裸 id（`35b7906`）


## 当前套件（2026-11-17 · P0）

```bash
pnpm test          # vitest run，根目录 vitest.config.ts
```

- `test/unit/`：game-core 纯函数 / 加载器（projection、relations、scheduler、branch 展开、battle、工具面、回放 provider）。
- `test/api/`：起真 `apps/server`（随机 32xx 端口、独立 `LIFE_SIM_DATA_DIR`、跑完自清），打 HTTP。
- `test/helpers/`：模板/状态夹具、服务启停、P0 流程、录制回放 OpenAI 假 provider。
- `test/fixtures/templates/p0/1.0.0/`：最小 P0 世界（双开局 → 转盘 → 战斗 → 选择 → 结局），
  由源码 `makeTestTemplate` 生成后固化；**tests 只读它**，不依赖会被改写的 `specs/data/templates`。
- `test/fixtures/llm/`：录制回放数据，一局一份，来源如下。

| fixture | 来源 |
|---|---|
| `p0-narrative.jsonl` | `p0@1.0.0` / `op-gojo` / 默认 seed；`patrol → opt-go`；mock provider 真跑一条 trace（`p0.start`，`calls: []`，1 个 narrative 块） |
| `p0-tool.jsonl` | `p0` 的录制副本（trigger 加 `branchEventIds:["ev:final"]`）；同一流程；mock 真跑一条 trace（`p0.start`，`calls:[story.submitBranch]`，1 个 narrative 块） |

两份 fixture 都只含 trace，不含 key / prompt / 原始请求；回放 provider 把 `contentBlocks` 包回
`<narrative-content>`、把 `calls[].args` 原样作为 tool_calls 返回。
