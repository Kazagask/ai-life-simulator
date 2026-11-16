# R2.8 任务 · 轻量模板治理（只读 + 热加载）

> 取用规则：按依赖顺序，一次一个任务（G3）；`packages/**` 同一时刻单写者（G4）。
> **批次约束**：`T-TG-01 + 02 + 03` 必须同批提交——注册表换 key 后，`index.ts` 调用点不改就编译不过。
> **本轮基线（R1–R4）**：目录即元数据（无 `_meta.json`）；id = 目录名、version = 版本子目录名；请求驱动热加载 + 内存快照隔离；运行时丢模板可容忍。

| 编号 | 任务 | 写者 | 前置 | 验证方式 | 状态 |
|---|---|---|---|---|---|
| **T-TG-10**（批 0） | 目录迁移：`specs/data/templates/jjk-2006/*.yaml` 移入 `jjk-2006/1.0.0/`；`.wheel.json` 留在 `<id>` 层（已是扫描盲区，可选清理到 `specs/data/references/`）；同步 `AGENTS.md §0.1` 第 13 行「specs/data 禁止移动改名」一句 | 内核/服务端 | 无 | 迁移前后 `semanticFingerprint` 逐字节相同（`sha256:9a945ac3…`）；6 份可载档仍可载；`git status` 只显示文件移动 | 完成 `391578a` |
| **T-TG-01** | 注册表骨架：`templates.ts` 扫 `templates/<id>/<version>/`（id/version 取目录名，version 校验 `^\d+(\.\d+){0,2}$`）；**双指纹**（`semanticFingerprint` 口径与现状逐字节一致 / `assetFingerprint` 含空集常量）；**文件角色识别**（`declarative` 进校验、`asset` 只进资产指纹、其余 warn + 忽略）；`resolve` / `listTemplates`（两级 + `assetCount`）；**`meta.id ≡ <id> 目录名` 断言（启动期 throw / 运行期跳过 + warn）**；Entry 带 `status: "ready" \| "invalid"`；**不引入 `newTemplateId`、不读写 `_meta.json`** | 内核/服务端 | T-TG-10 | 两版本目录共存不再互相覆盖；`meta.id` 不匹配 ⇒ 启动失败；`Entry.key === entry.template.meta.id`；空 `assets/` ⇒ 资产指纹为确定常量；目录内 `.js` ⇒ warn 且模板仍可用 | 完成 `d75abf9` |
| **T-TG-02** | 信封与 store：`templateVersion?`；**`refs` 与「世界内存快照 record」合并成一条**（`{ state, template, lookup, entry }`，不开两个 Map）；只在 `create` / `loadPersistedWorlds` 写入；**删除 `persist` 的全局指纹查表**；启动期唯一性回填；`UnloadableReason` 封闭枚举（含 `template_invalid`）；不可载条目收集 | 内核/服务端 | T-TG-01 | `persist` 不再引用 `getTemplateFingerprint`（grep 断言）；回填前后 `state` 深比较相等且 `archived` 不变；缺 ref ⇒ `template_ref_missing`（500）；只改 `assets/` ⇒ 旧档仍可载 | 完成 `d75abf9` |
| **T-TG-03** | `index.ts` 调用点收敛（18 处）；`getWorld` 返 record；`pipelineOf` 改读 `entry.pipeline`；`POST /api/worlds` 收 `templateVersion`（单版本隐式 / 多版本缺失 ⇒ 400 + `versions[]`）；`GET /api/templates` 改两级结构 | 内核/服务端 | T-TG-01/02 | 单版本建局路径零改动可用；多版本缺版本号 ⇒ 400；列表 `templateName`/`formattedTime` 与改前逐字段相同 | 完成 `d75abf9`（含 T-TG-06 内容） |
| ~~T-TG-04~~ | ~~导入端点（L1–L6 + `LIFE_SIM_ENV` + bodyLimit + 幂等/冲突）~~ **作废（R-TG-02/03/05/06/07 RETIRED）** | — | — | 编号保留不复用 | ~~作废~~ |
| ~~T-TG-05~~ | ~~下架 / 删除端点 + 引用守卫 + `affectedWorldCount`~~ **作废（R-TG-11 RETIRED）** | — | — | 编号保留不复用 | ~~作废~~ |
| **T-TG-06** | 世界列表 E-03：`loadable` / `reason`；详情 409 `world_unloadable`；允许删除不可载世界 | 内核/服务端 | T-TG-02 | 造坏档 ⇒ 列表可见 + 带 code + 可删；`GET /:id` 返 409 而非 404 | 完成（并入 T-TG-03 `d75abf9`） |
| **T-TG-11**（新增） | **运行时热加载**：`ensureFresh()` 在 `resolve` / `listTemplates` 前比对每个 `<id>/<version>` **目录内所有文件的 mtime 最大值**（顶层 yaml + `assets/**` 递归），**不得用目录 mtime**（就地编辑不改父目录 mtime）；变化才重扫；Entry 换入注册表；**单目录隔离失败**（保留旧 Entry 或标 `invalid`）；**内存快照隔离**（已载入世界不被替换）；**不得**引入 `setInterval` / `fs.watch` | 内核/服务端 | T-TG-01/02 | 见 R-TG-16 八条 AC：改 `meta.name` 无需重启即反映、在跑世界逐字段不变、坏 yaml 只影响该版本、删目录不崩、重启后 `template_content_drift`、mtime 未变时重扫计数为 0、**只改文件内容不增删文件仍能检测到**、`setInterval`/`fs.watch` grep 零命中 | 完成 `ab213ed` |
| **T-TG-07** | 前端：模板 → 版本两级选择器；`openings` 归属修正（`main.tsx:680`）；按所选版本提交 `openingId`。**不实现任何导入/上传 UI** | 前端 | T-TG-03 | 跨模板/跨版本选开局不再 404；切模板或切版本后下拉项随之变化 | 完成 `ff0378d` |
| **T-TG-08** | 测试与验收：R-TG-01/04/08/10/14/15/16 全量 AC；`template_version_ambiguous` **必须作为用例**（手放两版本 + 无版本信封）；`meta.id` 任意书写不影响 `world.templateId`；旧档回归用**固化夹具四格矩阵**（正 1 有版本号 / 正 2 无版本号验回填 / 负 1 指纹不符 / 负 2 版本目录缺失，**其基线列 = N/A**），**不得写死份数、不得读 `data/worlds` 实时内容**；热加载失败口径见下「口径澄清」 | QA | T-TG-01..07、T-TG-11 | `pnpm typecheck` + `shared test` + game-core 全量 + 四格矩阵 | **完成 PASS** `b1cb37a` 测试 / `f894ece` 首轮退回 / `7639d7a` 修复 P1+P2 / `6269e10` 复验通过 / `e2f6525` 报告计数校正；44 例（13+15+16），全量 522/522 |
| **T-TG-12**（新增） | **只读边界负向回归**（R-TG-17）：`POST /api/templates/imports`、`PUT`/`PATCH`/`DELETE /api/templates*` 全部 404/405；grep 断言无 multipart 依赖、无导入 `bodyLimit`、无 `LIFE_SIM_ENV`/`TEMPLATE_IMPORT_TOKEN`/base64 载荷；前端无上传控件 | QA | T-TG-08 | 四个写方法各一条；三条 grep 断言；UI 快照无 `<input type="file">` | **完成 PASS**（10 条写方法探针全 404）`b1cb37a` |
| **T-TG-09** | 文档收口：`DECISIONS.md` 落 ADR-0029；`AGENTS §0.3` 补一句（新增 `<id>/<version>/` 目录 ≠ 改 yaml）；`AGENTS §0.1` 第 13 行按迁移修订；`ARCHITECTURE.md` 运行时目录；`OPEN_QUESTIONS #6/#15` 关闭措辞；`PROJECT.md` 状态行 | 主理人 | 用户确认 | 文档 diff 评审 | **完成** `c32273e`（ADR-0029 + 四件套 + AGENTS/OQ/ARCHITECTURE/PROJECT/BACKLOG） |

## 口径澄清（实施期裁定，QA 按此写用例）

1. **热加载失败的分支语义**（T-TG-11 已按 design I-3 实现，本裁定确认）：**已成功加载过**的版本被改坏 ⇒ **保留旧 Entry 继续服务**（内容停在最后一次成功加载的快照）+ `log.error`；只有**从未成功加载过**的新版本才标 `invalid`。
   ⚠️ 我此前给实施方的验收里写「改坏 ⇒ 从列表消失或标 invalid」，**那是错的**——转 `invalid` 会让玩家连旧内容都开不了局，与 design I-3 直接冲突。以本条为准。
2. **`statCount` 不得写死 43**：AC⑧ 的 43 是「11 yaml + 32 assets」的**上界估算**；`jjk-2006/1.0.0` 当前无 `assets/`，实测 = 11。断言必须写「= 该版本目录文件数之和」，不得写常量。
3. **`data/worlds` 份数不得作为断言**：该目录会被冒烟与手工测试改变（本轮实测 65 → 67，因有同事对着真实目录起了两局）。一切旧档断言走**固化夹具**。

## 批次建议

0. **批 0**：`T-TG-10` 目录迁移（纯移动、指纹不变）——先落地，后续代码直接按新布局写
1. **批 A**：`T-TG-01 + 02 + 03`（契约骨架，拆开编译不过）
2. **批 B**：`T-TG-11`（热加载）+ `T-TG-06`（列表可诊断）
3. **批 C**：`T-TG-07`（前端独占）
4. **批 D**：`T-TG-08` + `T-TG-12`（验收 + 负向回归）
5. **批 E**：`T-TG-09` 文档收口

## 明确不做（本轮）

模板市场 / 搜索 / 评分 / 导出；**任何导入端点与导入 UI**；删除 / 下架 / 引用守卫；模板副本 GC；zip；`fs.watch`/定时器式热加载；资源下发（`assets/` 存得进用不上）；自定义函数执行；字节快照；存档上云；`schemaVersion` 升 3；抗 YAML 别名炸弹。

## 提交纪律（每批）

- 提交信息写清「改了什么契约面」与「存档代价」：本迭代**不拒载**现存可载档（6 份），但**新增** `templateVersion` 字段。
- 最小验证集：`pnpm typecheck` + `shared test` + `game-core` 三个 v2 测试文件 + 一条手工冒烟；不跑全量 UI e2e。
- 任何为迁就模板而在内核加兜底的写法一律退回（D-17 教训）。
