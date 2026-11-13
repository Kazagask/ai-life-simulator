# 专家包入库说明

本目录把「人生模拟器研发团」从本机个人配置搬进仓库，让任何环境 clone 后都能还原同一套协作流程。
权威定义在 `life-sim-dev-team/.codebuddy-plugin/plugin.json`，说明见 `life-sim-dev-team/README.md`。

## 1. 这里有什么

```
.workbuddy/experts/life-sim-dev-team/
├── .codebuddy-plugin/plugin.json   # 包清单：expertType=team、成员、头像、分类、快捷提示
├── agents/                         # 6 个角色（团长 + 需求/架构/内核/前端/QA）
├── skills/lifesim-spec-coding/     # 内置 Spec Coding 方法卡与六道门禁
├── avatars/                        # 团队 + 6 角色头像（PNG，512×512）
└── README.md                       # 成员分工与使用方式
```

与仓库内既有资产的分工：

| 资产 | 作用 | 位置 |
|---|---|---|
| `AGENTS.md` | 硬约束与工程规范（权威） | 仓库根 |
| 专家包 | 多角色协作编排（谁干什么、按什么顺序） | `.workbuddy/experts/life-sim-dev-team/` |
| 项目技能 `/life-sim-iteration` | 单会话迭代流程与任务简报模板 | `.workbuddy/skills/life-sim-iteration/` |
| 项目记忆快照 | 跨会话事实与已裁决决定 | `docs/PROJECT_MEMORY.md` |

## 2. 换机 / 换环境后怎么装回去

WorkBuddy 只认个人配置目录下的 marketplace，**不会自动扫描仓库**，所以需要一步手动复制：

```bash
# 1. 复制到个人 marketplace（路径由 WORKBUDDY_CONFIG_DIR 决定，默认 ~/.workbuddy）
mkdir -p ~/.workbuddy/plugins/marketplaces/my-experts/plugins
cp -r .workbuddy/experts/life-sim-dev-team ~/.workbuddy/plugins/marketplaces/my-experts/plugins/

# 2. 注册到 marketplace，否则专家中心看不到
#    用 WorkBuddy 的 expert-manager 技能，或手动在 marketplace.json 里追加该条目
python3 <expert-manager>/scripts/validate_expert.py \
  ~/.workbuddy/plugins/marketplaces/my-experts/plugins/life-sim-dev-team
python3 <expert-manager>/scripts/register_expert.py \
  ~/.workbuddy/plugins/marketplaces/my-experts/plugins/life-sim-dev-team
```

安装后在「专家 → 我的专家」里应能看到「人生模拟器研发团」。
`plugin.json` 里的 `name` 必须保持 `life-sim-dev-team`，改了会导致注册冲突。

## 3. 修改约定

- 改角色提示词 / 分工 / 快捷提示 ⇒ 改本目录，**并同步到本机 marketplace 的那份**（两份不自动联动）。
- 只改 `plugin.json` 的展示字段（`displayName`、`description`、`tags`）不影响运行逻辑。
- 新增角色需要同时改三处：`agents/` 下新增 md、`plugin.json` 的 `agents[]` 与 `teamInfo.memberAgents[]`、
  以及 `README.md` 的分工表。漏任一处会导致专家中心加载失败或成员不可召唤。
- 头像替换保持文件名不变，PNG/JPG、512×512、单张 ≤500KB。
