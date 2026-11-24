# 迭代：本地世界生命周期（2026-11-21）

## 一句话

把「起局 / 推进 / 结算 / 投影」整体搬进浏览器：**服务端最后只剩两件事 —— 读模板、同步存档**。

## 本轮范围

- **做**：
  1. 纯加载器产出**完整运行时包** `TemplateBundle`：除 `WorldTemplateV2` 外，`opening` /
     `endings` / `evaluation` / `rules` / `lore` / `ui` / `assets/manifest` 也在同一处解析、
     同一套交叉校验；服务端 `scanVersion` 与客户端下载包**共用这一个函数**。
  2. 客户端世界仓库：IndexedDB 存 `{ id, ref, fingerprint, savedAt, state }`，异步 CRUD。
  3. 客户端引擎会话：`create / turn / choose / battle / item / equip / allocate / rename` →
     纯 `game-core` 调用 → 投影；不经过任何 HTTP。
  4. 客户端 API 适配层：与 `apps/web/src/api.ts` 同签名，本地优先、服务端回退；UI 组件零改动。
  5. 存档同步端点：服务端只搬字节（`PUT /api/sync/worlds/:id` 等），冲突按 `savedAt` + 指纹裁决。
- **不做**（本轮外）：
  - 老档迁移：已有服务端世界继续在服务端跑，客户端只读不接管。
  - 资产二进制：仍由服务端按 assetId 下发。
  - Service Worker / 离线安装：等引擎本地跑通再谈。
  - LLM invocation 客户端化（T6 单列，先保证「无 LLM 也能完整玩一轮」）。

## 与现行规格的关系

- 权威：`AGENTS.md` + `specs/SPEC.md`；本地化口径见 `docs/adr/70-本地化与离线.md`（第三期）。
- **不改协议**：`schemaVersion` 保持 5，模板文件集合与指纹算法不动。
- 第三期第一次落地会更新 ADR-070 的「三期」表与落地记录（G2）。

## 现状事实（读代码得到）

- `packages/template-loader` 已含全部**文件级** loader（`loadOpenings` / `loadOptionalConfig` /
  `loadRules` / `loadUi` / `loadLore` / `loadAssetManifest`），但**没有**把它们组装成运行时包的入口；
  组装逻辑（含 `assertOpenVocabularyDeclared` / `validateStyleRefs` / `validateOpeningDag` /
  `ui.resources` / `ui.playerCard` 五道交叉校验）目前只存在于 `apps/server/src/templates.ts:513-601`。
- `loadTemplatePackage` 只返回 `{ template, fingerprint }`，客户端拿不到开局 DAG / 结局 / 评价 / UI 配置。
- `apps/web/src/localEngine.ts` 只做自检；`localWorldStore.ts` 存 IDB 但没接任何 UI 路径。
- `WorldStore`（shared）是**同步**接口，IndexedDB 是异步 —— 客户端不接这个接口，另起异步仓库；
  服务端保持同步，不为客户端改签名。
