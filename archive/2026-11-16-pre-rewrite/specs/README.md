# specs/ 索引与阅读纪律

> **本节最重要，先读这一段。** 这个目录曾累积到 6700+ 行、其中大部分是已关闭迭代的过程文档。
> 2026-11-12 用户裁决：**只保留影响游戏核心流程的决策；细节问题统一拆出；后续迭代默认只看重要规格。**

## 0. 阅读纪律（硬规则）

| 场景 | 允许读的范围 |
|---|---|
| **默认**：任何迭代、修 bug、加功能 | **只读 `specs/core/`**（4 个文件 + 1 个 demo 定位）。首选 `core/GAME_RULES.md`，一页纸够了就先别看别的 |
| **重大改动**：改核心数据模型 / 技术栈 / 目录结构 / 游戏规则 / 协议 | 可加读对应 `docs/DECISIONS.md` 的 ADR 正文；必要时才翻 `specs/archive/` 里**指定那一个**迭代包 |
| **查全部 spec** | **必须先通知用户并得到确认**，说明为什么要全量查、查什么。不得自行递归扫描 `specs/` |

- 禁止「先全量读一遍再动手」。历史过程文档只解释「为什么当初那样做」，不构成现行约束；**现行约束只看 `core/` 与 ADR**。
- 规格与代码冲突时：以 `core/` + ADR 为准；`archive/` 与代码冲突时以**代码**为准（历史文档已作废）。
- 发现 `core/` 与实现不一致 → 记 `docs/BACKLOG.md` 或 `docs/OPEN_QUESTIONS.md`，不要擅自回改历史文档。
- **改模板 `specs/data/templates/` 里的 yaml 不算改规格**：demo 期模板频繁变更，**仅 yaml 改动免 ADR**；只有动到 schema / 枚举 / effect 类型 / 投影契约这类**协议面**才走 ADR。判据与最小验证集见 `AGENTS.md` §0.3。

## 1. 目录结构

```
specs/
├── README.md              ← 本文件（索引 + 阅读纪律）
├── core/                  ← 【默认必读】影响游戏核心流程的决策
│   ├── GAME_RULES.md            一页纸核心决策速查（新入口，从 ADR/迭代提炼）
│   ├── CORE_ENGINE.md           引擎核心流程（时间/轮次/技能/关系/NPC 行为）
│   ├── TEMPLATE_PROTOCOL_V2.md  模板与运行时协议（最核心，900 行，按需查章节）
│   ├── MOBILE_UX.md             竖屏移动端交互约束
│   └── JJK_DEMO.md              demo 世界定位与模板必须提供的配置
├── iterations/            ← 【活跃迭代】当前在做的迭代包放这里（四件套）
├── archive/               ← 【默认不读】已关闭、有结论、不影响核心流程
│   ├── iterations/              已关闭的 5 个迭代包（2026-11-11 起至 r26）
│   ├── design-increments/       两份历史设计增量稿（其结论已并入 ADR）
│   └── data/WORLD_TEMPLATE.md   模板契约 V0.1 草案（已被 TEMPLATE_PROTOCOL_V2 取代）
└── data/                  ← 【运行时资产，禁止移动/改名】
    ├── templates/jjk-2006/      服务端按此路径加载模板（`specs/data/templates`）
    └── examples/
```

> ⚠️ `specs/data/` 是**代码依赖**，不是文档：`apps/server/src/templates.ts` 按 `../../../specs/data/templates` 解析。
> 移动或改名会让线上服务找不到模板。整理文档时**一律不要碰这个目录**。

## 2. 什么时候读哪一份

| 你要做的事 | 读这个 |
|---|---|
| 不知道该看什么 / 第一次进项目 | `core/GAME_RULES.md` |
| 改事件触发、时间推进、轮次结算 | `core/GAME_RULES.md` §2 §3 + `core/TEMPLATE_PROTOCOL_V2.md` §22 |
| 改模板 yaml 字段、加效果类型 | `core/TEMPLATE_PROTOCOL_V2.md` + `packages/shared/src/schema/` |
| 改战斗、道具、装备 | `core/GAME_RULES.md` §6 + ADR-0003 / 0008 / 0009 / 0017 |
| 改 NPC、关系、称谓 | `core/GAME_RULES.md` §6 + ADR-0012 / 0014 |
| 改投影、加 API 字段 | `core/GAME_RULES.md` §7（两条投影铁律）+ ADR-0017 决策 1 |
| 改前端布局与交互 | `core/MOBILE_UX.md` |
| 加新世界模板 | `core/JJK_DEMO.md` 的「模板必须提供的配置」+ `core/TEMPLATE_PROTOCOL_V2.md` |
| 问「当初为什么这么定」 | `docs/DECISIONS.md`（ADR），**不要翻 archive/** |
| 找「还没做完的小事」 | `docs/BACKLOG.md`；产品规则待决看 `docs/OPEN_QUESTIONS.md` |

## 3. 旧路径映射（供历史报告与提交信息对照）

`archive/` 是 2026-11-12 重排后的位置。历史文档里出现的旧路径按此表换算：

| 旧路径 | 新路径 |
|---|---|
| `specs/engine/CORE_ENGINE.md` | `specs/core/CORE_ENGINE.md` |
| `specs/data/TEMPLATE_PROTOCOL_V2.md` | `specs/core/TEMPLATE_PROTOCOL_V2.md` |
| `specs/ui/MOBILE_UX.md` | `specs/core/MOBILE_UX.md` |
| `specs/demo/JJK_DEMO.md` | `specs/core/JJK_DEMO.md` |
| `specs/data/WORLD_TEMPLATE.md` | `specs/archive/data/WORLD_TEMPLATE.md` |
| `specs/DESIGN_INCREMENT_2026-11-10.md` | `specs/archive/design-increments/DESIGN_INCREMENT_2026-11-10.md` |
| `specs/DESIGN_INCREMENT_LIFECYCLE_2026-11-11.md` | `specs/archive/design-increments/DESIGN_INCREMENT_LIFECYCLE_2026-11-11.md` |
| `specs/iteration-2026-11-11*/` | `specs/archive/iterations/iteration-2026-11-11*/` |
| `specs/iteration-2026-11-12-r26/` | `specs/archive/iterations/iteration-2026-11-12-r26/` |

**新迭代的目录约定**：`specs/iterations/<YYYY-MM-DD>-<短标签>/`（四件套 `README / requirements / design / tasks`）。
收尾时整包移入 `specs/archive/iterations/`，并在本文 §3 表末追加一行映射。

## 4. 归档判据（决定一个文件进 core 还是 archive）

进 `core/` 必须同时满足：

1. 描述的是**现行**行为，不是历史过程；
2. 违反它会让游戏玩法或数据契约出错；
3. 后续每个迭代都会被用到。

否则进 `archive/`。判不准时**进 archive**——需要时能翻回来，而 `core/` 一旦膨胀就再没人读了。

## 5. 待解决的细节去哪了

原 `specs/` 里散落的未解决项已统一拆出，**不在本目录追踪**：

| 类型 | 去处 |
|---|---|
| 小问题、优化点、已裁决不修、环境坑、证据缺口 | `docs/BACKLOG.md` |
| 产品规则待决（不得伪造共识） | `docs/OPEN_QUESTIONS.md` |
| 架构/规则裁决记录 | `docs/DECISIONS.md`（ADR） |
| 验收证据与结论 | `tasks/reports/` |
