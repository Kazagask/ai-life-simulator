# 人生模拟器研发团（AI Life Simulator Dev Team）

按 `AGENTS.md` 与 Spec Coding 规范推进 `D:\code\ai-life-simulator` 迭代的 Team 型专家团：先审查对齐，再按 `requirements → design → tasks → 实现 → 验收` 逐阶段交付。

## 类型与分类

- `expertType: team`（团长 + 5 名成员）
- `categoryId: 02-Engineering`（技术工程）——团队主要产出是需求规格、架构设计/ADR、代码与测试验收报告，属工程交付；游戏玩法只是业务领域，不是本团的主要输出物。

## 成员分工

| Agent ID | 名字 | 职业 | 职责 |
|---|---|---|---|
| `life-sim-dev-team-lead` | 程有章 | 迭代交付总监 | 建立团队、拆解派发、门禁把关、中转汇编 |
| `life-sim-requirements` | 许清源 | 需求策划师 | EARS 需求、验收标准、追溯矩阵、状态口径 |
| `life-sim-architect` | 高见远 | 系统架构师 | 边界、数据模型、ADR、接口预留点 |
| `life-sim-core-engineer` | 寇定一 | 内核与服务端工程师 | `packages/game-core`、`apps/server` 实现 |
| `life-sim-frontend` | 叶顺屏 | 前端与交互工程师 | `apps/web` 竖屏 PWA 与 API 契约 |
| `life-sim-qa` | 严过关 | 测试验收工程师 | 测试、类型检查、DoD 核验与裁决 |

内置技能：`skills/lifesim-spec-coding/SKILL.md`（Spec Coding 方法卡与六道门禁）。

## 使用方式

1. WorkBuddy 左侧边栏 → 专家 → 我的专家 → 「人生模拟器研发团」→ 召唤。
2. 新建任务时把工作空间选为 `D:\code\ai-life-simulator`。
3. 描述任务写清四要素：**目标 / 输入材料 / 输出格式 / 约束**（模板见仓库 `.workbuddy/skills/life-sim-iteration/templates/iteration-brief.md`）。

示例：

- 「按 R2 迭代包推进阶段 0 差距复核，输出 45 条 ACTIVE 需求的五态标注报告，不改实现代码。」
- 「为下一轮迭代起草 requirements、design、tasks 四件套，保留 DEFERRED 需求编号与原文。」
- 「实施 tasks.md 里指定的一个任务，按完成定义自验，并用 AGENTS.md 第 4 节格式汇报。」

> 专家团会调用多位成员、多轮推理，积分消耗高于单个专家；单点问题建议直接问单个专家或用项目技能 `/life-sim-iteration`。

## 配套项目文件

| 路径 | 作用 |
|---|---|
| `D:\code\ai-life-simulator\PROJECT.md` | 工作空间迭代面板与状态快照 |
| `D:\code\ai-life-simulator\.workbuddy\memory\MEMORY.md` | 项目长期记忆（规范速查、迭代状态、联调方式） |
| `D:\code\ai-life-simulator\.workbuddy\skills\life-sim-iteration\` | 项目级迭代技能与任务简报模板 |

## 头像

`avatars/` 下为团队整体 + 6 个角色共 7 张统一风格头像。可手动替换：PNG/JPG、512×512、单张 ≤500KB，文件名保持与 `.codebuddy-plugin/plugin.json` 中的声明一致。

## 安装与注册

专家包目录（由 `WORKBUDDY_CONFIG_DIR` 决定）：

```
C:\Users\kazag\.workbuddy\plugins\marketplaces\my-experts\plugins\life-sim-dev-team\
```

注册（写入 `marketplace.json` 后才会在专家中心可见）：

```bash
python3 scripts/validate_expert.py <expert-dir>
python3 scripts/register_expert.py <expert-dir>
```

打包分享：

```bash
python3 scripts/package_expert.py <expert-dir>
```
