# 活跃迭代

本目录当前仅保留一个迭代包：**R2.7 AI 叙事层接入**（`2026-11-13-ai-narrative/`）。〔云端工程适配状态，2026-11-13〕实施前标注「G1 待评审、零代码改动」已过时，现按实绩更正：

- **功能完成**：9 条 ACTIVE 需求 + 8 个 `T-*` 全部实现（10 个功能 / 规格 commit `42ffa17`..`ba889ba`）；契约面 `schemaVersion=2` / `WorldStateV2` 零改动 / 零 `*.yaml` 改动。
- **冒烟验证通过**：typecheck 0 错、定向 12+5 例、服务端 6 项、web build、加载期 200；按用户裁决**仅冒烟级**，全量 vitest / 6 种子 playthrough / UI e2e / 全流程 / 真实外部 LLM 联网**未跑**（仍待在云端补跑）。
- **ADR-0027 事后补记**（`0f42bd0`）：在全部功能与冒烟验证完成后补记，非前置门禁产物。
- 🔴 **G1 前置门禁本次免除、未走正式评审**，故**未宣告按标准流程关闭**；是否补做正式评审 / 何时关闭迭代待用户裁决。该「免前置 ADR + 事后补记」**仅适用本次任务、不延续**，后续任务一律恢复 `AGENTS.md §0.3` 的 **G1 / G2 正常门禁**。
- **四件套**（`README.md / requirements.md / design.md / tasks.md`）已可通过 GitHub 仓库 `git@github.com:Kazagask/ai-life-simulator.git` 同步到 WorkBuddy 云端项目，clone 后可直接被 Agent 消费；`design.md` 三处事实更正见「〔云端工程适配更正，2026-11-13〕」标注，实绩以 `docs/DECISIONS.md` ADR-0027〔事后补记〕为准。追溯：`tasks/reports/R27-COMPLETION.md`。

## 约定

- 新迭代建在这里：`specs/iterations/<YYYY-MM-DD>-<短标签>/`，四件套 `README.md / requirements.md / design.md / tasks.md`。
- 收尾后**整包移入** `specs/archive/iterations/`，并在 `specs/README.md` §3 映射表末尾补一行。
- 本目录同时最多保留**一个**迭代包。旧的不清理，`specs/` 就会重新膨胀成没人读的堆栈——这是上一轮整理的起因。

## 下一个迭代该做什么

看 `docs/BACKLOG.md` §0「主线缺口」。R2.7（AI 叙事层）**功能已闭合**（LLM Provider 全链路可运行、无配置时零回归），不再列为待做；其后排序建议：NPC 自主行动（含生死建模）→ 跨模板验证 → R3 穿越。
