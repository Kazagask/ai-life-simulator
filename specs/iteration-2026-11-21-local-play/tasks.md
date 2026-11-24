# 任务：本地世界生命周期

依赖顺序执行；一次一个任务（G3）。每个任务的"完成定义"都要跑通才算完。

| 编号 | 任务 | 依赖 | 产出 | 完成定义 |
|---|---|---|---|---|
| **T1** | 运行时包下沉 | — | `packages/template-loader` 新增 `TemplateBundle` / `loadTemplateBundle`；`templates.ts` 改用它；`loadTemplatePackage` 返回 `bundle` | `template-bundle.test.ts` 绿（磁盘 vs 内存逐字段相等、五道校验各一例）；`pnpm test` 全绿；服务端现有 API 用例零改动通过 |
| **T2** | 本地世界仓库 | T1 | `apps/web/src/local/worldRepo.ts`（IDB + 内存降级） | `local-world-repo.test.ts` 绿（写入/读回/列表/删除/降级/指纹漂移判据） |
| **T3** | 本地引擎会话 | T1 | `apps/web/src/local/session.ts`（建局 + 行动 + 投影） | `local-session.test.ts` 绿：本地 vs 服务端同输入摘要相等；错误形态与 HTTP 同形 |
| **T4** | 传输适配层 | T2,T3 | `apps/web/src/local/transport.ts` + `main.tsx` 选择本地实现 | `local-transport.test.ts` 绿；浏览器手测：断网（拦 API）仍能推一轮 |
| **T5** | 存档同步 | T2 | `PUT/GET /api/sync/worlds...` + 客户端同步队列 | `sync-worlds.test.ts` 绿（往返、冲突、指纹不一致 409） |
| **T6** | LLM 客户端化 | T4 | 浏览器内 gateway（agent-runtime 直连 provider） | 与今日服务端 invocation 的 `story.submitBranch` 写入结果一致；失败回退模板 |

## T1 实施要点（本轮开工）

1. `TemplateBundle` + `loadTemplateBundle(source, { files, expectedId })` 放
   `packages/template-loader/src/index.ts`（与现有 loader 同文件，避免循环导入）。
2. 把 `apps/server/src/templates.ts:513-601` 的五道校验整段搬进去，错误文本保持原样
   （`style_ref_invalid:` / `opening_invalid:` / `ui.yaml: 未知资源…`）。
3. `scanVersion` 改调 `loadTemplateBundle`，只保留 `present` 计算、`mtime`、`scanAssets`、
   指纹与注册表字段。
4. `loadTemplatePackage` 内部改用 `loadTemplateBundle`（只解析一次），返回 `bundle`。
5. 新增 `test/unit/template-bundle.test.ts`：
   - 磁盘源 vs 内存源 → `deepEqual`（`JSON.parse(JSON.stringify())` 归一 `undefined`）；
   - 指纹与既有实现一致（复用 `semanticFingerprintOf`）；
   - 坏 `opening.yaml` → `opening_invalid:` 前缀；坏 `ui.yaml` 样式引用 → `style_ref_invalid:`；
   - 非法 `meta.id`（expectedId 不符）→ 指定文本。

## 风险

- **YAML 解析翻倍**：包校验与运行时包若各解析一次，客户端多花 ~100ms。T1 用「包校验内部
  直接产 bundle」规避。
- **服务端拒载文案漂移**：错误文本是对外契约（`reason` 字段），搬迁时必须逐字保留，
  T1 的用例覆盖前缀而不是全文。
- **T3 的等价性**：本地与服务端都必须走同一 core 入口；一旦出现"本地补一段服务端才有的
  收尾逻辑"，摘要就会分叉 —— 因此 T3 只允许投影/落库差异，不允许规则差异。
