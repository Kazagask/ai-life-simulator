# 设计：本地世界生命周期

## D1 · 运行时包放哪里

`TemplateBundle` 与 `loadTemplateBundle` 落在 **`packages/template-loader`**（纯层，零 `node:`）。
理由：服务端与浏览器必须算出同一份运行时包，而今天这段组装逻辑只在
`apps/server/src/templates.ts`（牵着 fs / mtime / 注册表）。抽出来之后：

- 服务端 `scanVersion` 只保留「目录发现 → 资产扫描 → mtime → 指纹 → 注册表」；
- 客户端拿到模板包字节后，用内存源调同一个函数，得到同一份包。

```ts
interface TemplateBundle {
  template: WorldTemplateV2;
  openings: OpeningTemplate[];
  openingDag?: OpeningBranchDag;
  endingConfig?: EndingConfig;
  evaluationConfig?: EvaluationConfig;
  rules?: Rules;
  lore?: readonly LoreRule[];
  assetManifest?: AssetManifest;
  ui?: UiConfig;
}

function loadTemplateBundle(
  source: TemplateSource,
  options?: { files?: ReadonlySet<string>; expectedId?: string },
): TemplateBundle;   // 失败即 throw，错误文本与今日拒载一致
```

**不放进 bundle 的**：`ref` / `mtime` / `assetFingerprint` / `assetCount` / `semanticFingerprint`
—— 它们是注册表与资产扫描的产物，客户端由包封面对齐。

## D2 · `loadTemplatePackage` 只解析一次

今天客户端 `loadTemplatePackage` 解析一次 YAML 得到 `template`，若要 bundle 会再解析一次
（实测 YAML 解析 98ms/次）。改为：包校验内部直接 `loadTemplateBundle`，返回值新增 `bundle`，
`template` 保留为 `bundle.template` 的别名（旧调用点零改动）。

## D3 · 客户端世界仓库：另起异步接口，不动 `WorldStore`

`packages/shared/src/world-store.ts` 的 `WorldStore` 是**同步**接口（fs 语义），IndexedDB 异步。
服务端 10 处调用点不该为客户端多出 `await`。因此：

```ts
// apps/web/src/local/worldRepo.ts
interface LocalWorldRecord {
  id: string;
  formatVersion: 1;
  savedAt: string;            // ISO
  ref: { id: string; version: string };
  fingerprint: string;
  state: WorldStateV2;
}
interface LocalWorldRepo {
  list(): Promise<LocalWorldRecord[]>;
  read(id: string): Promise<LocalWorldRecord | undefined>;
  write(record: LocalWorldRecord): Promise<void>;
  remove(id: string): Promise<void>;
}
```

- IDB 实现：复用 `apps/web/src/idb.ts` 的懒连接与降级；不可用时**自动落到内存实现**。
- `drifted` 不是仓库状态，是**读取时的判据**：`repo.read()` 只搬字节，调用方比指纹
  （与 ADR-070「判定留在 store 之上」同一条纪律）。

## D4 · 客户端引擎会话

```ts
// apps/web/src/local/session.ts
createLocalSession({ bundle, fingerprint, worldId, state | opening })
  .snapshot(): V2Snapshot
  .act(input): V2Snapshot          // turn / choose / battle / item / equip / allocate / rename
  .save(): Promise<void>           // → repo.write + 同步队列
```

- 与 `apps/server/src/index.ts` 的 `runWorldTransaction` 对齐**语义**，不复制实现：
  core 入口（`advanceTurnV2` / `chooseOptionV2` / `applyBattleCommand` …）是唯一规则来源。
- 投影：`projectSnapshotV2(state, template, lookup.withGenerated(...), evaluateLifeV2(...),
  endingConfig?.endings, ui)` —— 与服务端 `projectWorld` 同一串参数。
- 本轮不接 LLM：`pipeline` 不传（模板侧 `trigger.invoke` 会走 fallback 分支，正文用模板段），
  保证「无 LLM 也能完整玩一轮」。T6 再接 gateway。

## D5 · 传输适配层与开关

`apps/web/src/api.ts` 的 `api` 对象是 UI 的唯一出口。新增
`apps/web/src/local/transport.ts` 导出同形状对象；`main.tsx` 在拿到 bundle 后选择本地实现，
**组件不改**（`api.advanceTurn(...)` 的返回形状保持一致）。

本地实现覆盖：`createOpening/stepOpening/commitOpening/getWorld/advanceTurn/confirmWheel/
chooseOption/battleAction/useItem/equipItem/unequipItem/submitAllocation/renameWorld/listWorlds/
deleteWorld`。`listTemplates` / 模板包 / 叙事 / 记录 / 认证仍走服务端。

## D6 · 存档同步（服务端只剩字节）

- `PUT /api/sync/worlds/:id`：body = `{ envelope, savedAt, fingerprint, ref }`，服务端**不解释**
  `state`，按既有 `WorldStore` 原子写落盘（`worlds/*.json`），保留信封字段。
- `GET /api/sync/worlds/:id`：返回原样信封；`GET /api/sync/worlds`：列表（id + savedAt + 指纹）。
- 冲突：`savedAt` 较新者胜；指纹不同 → `409 fingerprint_mismatch`，客户端提示「模板已变」。
- 拒载判定仍在服务端 store 之上（信封/schema/指纹），与今天一致。

## 正确性属性

1. 同一模板包 → 服务端 bundle 与客户端 bundle `deepEqual`（除 `undefined` 键）。
2. 同一世界 + 同一输入 + 同一 seed → 本地与服务端 `snapshot` 逐字段相等（T3 的守卫）。
3. 本地推进会改变 `turnIndex/worldTime/history`，不会改变 `templateId/seed`。
4. 任何同步失败都不改变本地状态（只有 `savedAt` 不变）。

## 需要 ADR 的点

- 更新 `docs/adr/70-本地化与离线.md`：第三期切分（T1–T6）、D3 的"双接口"决定、
  D6 的同步端点语义。
