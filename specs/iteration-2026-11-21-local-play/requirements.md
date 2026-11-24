# 需求：本地世界生命周期（R-LP）

编号不复用、不重排。`DEFERRED` 只登记，不进验收。

## 1. 运行时包（R-LP-01 ~ 03）

- **R-LP-01** 当给定一个 `TemplateSource` 时，加载器应产出**完整运行时包**：模板本体 +
  `openings` / `openingDag` / `endingConfig` / `evaluationConfig` / `rules` / `lore` /
  `assetManifest` / `ui`。缺文件时对应字段缺省，不报错。
- **R-LP-02** 当同一批文件分别经磁盘源与内存源加载时，两个运行时包应**逐字段相等**
  （含缺省字段的"不存在"）。
- **R-LP-03** 当五道交叉校验（开放词表 / 样式引用 / 开局 DAG / ui.resources / ui.playerCard）
  任一不过时，加载应失败并给出可定位的错误信息；错误文本与今日服务端拒载文本一致。

## 2. 客户端世界仓库（R-LP-04 ~ 06）

- **R-LP-04** 当浏览器存在 IndexedDB 时，本地世界应按 id 读写；刷新后 `list()` 仍能列出。
- **R-LP-05** 当 IndexedDB 不可用（隐私模式 / 无实现）时，仓库应退化为内存实现，
  **不抛错**，并在读取时返回空。
- **R-LP-06** 当本地世界的模板指纹与当前模板不一致时，读取应把它标成 `drifted`，
  而不是静默按新模板解释旧状态。

## 3. 客户端引擎会话（R-LP-07 ~ 10）

- **R-LP-07** 当运行时包与开局 DAG 可用时，建局应在浏览器内完成（`createOpeningSession` →
  `resolveStep` → `commitOpening`），产出 `WorldStateV2`，不发任何 HTTP。
- **R-LP-08** 当玩家提交行动 / 选项 / 战斗指令 / 物品 / 穿脱 / 加点时，应调用与
  `advanceTurnV2` / `chooseOptionV2` / `applyBattleCommand` 相同的 core 入口，返回快照形状
  与服务端一致（`V2Snapshot`）。
- **R-LP-09** 同一初始状态 + 同一输入 + 同一 seed，本地与会话产出**同一摘要**
  （`sha256(stableStringify(state))`）。
- **R-LP-10** 当本地推进抛错时，UI 收到与 HTTP 错误同形的错误（`message` 可读、400/409 语义
  用 `status` 字段区分），不出现未捕获异常。

## 4. 服务端退场（R-LP-11 ~ 14）

- **R-LP-11** 当本地模式可用时，一次行动不应产生除「模板包」「存档同步」之外的请求。
- **R-LP-12** 当同步失败（离线 / 5xx）时，本地推进不得失败，界面只提示"未同步"。
- **R-LP-13** 当同一世界在两端都被改过时，同步以 `savedAt` 较新者为准；指纹不同则拒绝
  合并并提示，不做静默覆盖。
- **R-LP-14** 当服务端世界被打开时（老档），应仍走原来的服务端路径，行为零变化。

## 5. DEFERRED

- **R-LP-D1** LLM invocation 在浏览器直连 provider（T6）。
- **R-LP-D2** 资产二进制进本地缓存。
- **R-LP-D3** Service Worker 离线启动。

## 6. 追溯矩阵

| 需求 | 任务 | 验收证据 |
|---|---|---|
| R-LP-01/02/03 | T1 | `test/unit/template-bundle.test.ts` |
| R-LP-04/05/06 | T2 | `test/unit/local-world-repo.test.ts` |
| R-LP-07/08/09/10 | T3 | `test/unit/local-session.test.ts` |
| R-LP-11 | T4 | `test/unit/local-transport.test.ts` |
| R-LP-12/13/14 | T5 | `test/api/sync-worlds.test.ts` |
