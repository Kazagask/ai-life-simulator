# R2.8 验收报告 · 轻量模板治理（只读 + 热加载） · R28-ACCEPTANCE.md

> 对应迭代：`specs/iterations/2026-11-13-template-governance/`（ADR-**0029**）
> ⚠️ 与 `tasks/reports/R28-COMPLETION.md`（ADR-**0028**，登录页 LLM key）同轮不同 ADR，勿混看。
> 验收人：QA（life-sim-qa）｜执行日期：2026-11-13｜基线 HEAD `ff0378d` → 复验 HEAD `7639d7a`
> 覆盖任务：`T-TG-08`（测试与验收）+ `T-TG-12`（只读边界负向回归）
> 验收口径来源：`requirements.md` ACTIVE **8 条**（R-TG-01/04/08/10/14/15/16/17）+ `tasks.md` 的 T-TG-08/T-TG-12 完成定义 + `tasks.md`「口径澄清」三条实施期裁定。
> 本文只记录**实跑命令、退出码与真实输出**；未跑项在 §4 单独登记并说明原因，未把任何未跑项写成 PASS。

---

## 0. 结论（复验后）

**裁决：通过**

首轮验收（HEAD `ff0378d`）判「退回」，唯一必修项 P1-1 + 已登记 P2-2；实施方在 `7639d7a` 修复后，本轮**独立复验**两个分支均为绿，ACTIVE 8 条全数满足：

| 轮次 | 裁决 | 依据 |
|---|---|---|
| 首轮 `ff0378d` | 退回（P1-1 必修） | 非法版本目录名 ⇒ `warn + 跳过`，与 R-TG-04 正文 / R-TG-01 AC③ / design B-4 #1 相反 |
| **复验 `7639d7a`** | **通过** | 非法版本目录名 ⇒ **exit=1**（错误含 `<id>`、目录名、期望正则、完整路径四件）；空版本目录仍 warn 忽略；三版本排序 `["1.0.0","2","10"]` 两处一致 |

| 项 | 首轮 | 复验 |
|---|---|---|
| P1-1 非法版本目录名不 fail-fast | FAIL | **已修复**（`7639d7a`）→ PASS |
| P2-2 `versions[]` 字符串序 | 已登记 | **已修复**（`7639d7a`）→ PASS |
| P2-1 `template_invalid` 真实载入路径不可达 | 已登记 | **保持判断**：需求侧正在 R-TG-10 AC① 补「防御性分支、不作为验收用例」的说明；本报告不改用例，只保留 stub 级证明 |
| P2-3 回填 `savedAt` 无兜底 | 已登记 | 未处理（仅手改档可触发，不在 ACTIVE AC 内，备查） |

**没有残留的「必须修复项」**。全量：`pnpm typecheck` 0 错 / `shared` 67 passed / `game-core` **522 passed（36 文件）**。

### ACTIVE 8 条逐条裁定（复验后）

| 需求 | 裁定 | 依据（详见 §2） |
|---|---|---|
| **R-TG-01** 身份=`(目录名, 版本目录名)` + 两级选择 | **PASS** | AC①④⑤：`renamed-tpl/1.0.0` 建局 ⇒ `world.templateId=renamed-tpl`；`startVersion=2.0.0`/`10`（补 0 全序，非 `versions[0]`）；**AC③ 复验通过**：非法版本目录名 ⇒ 启动期报错（exit=1） |
| **R-TG-04** 启动期 fail-fast（**六形态**） | **PASS** | 逐个构造：yaml 语法错 / Zod 校验失败 / `meta.id`≠目录名 / 零模板 / 非法版本目录名 ⇒ 子进程 **exit=1**；空版本目录 ⇒ 启动成功 + `template_version_empty`（B-4 #3 豁免，**仅限名字合法的版本目录**） |
| **R-TG-08** 模板引用固化进信封、`persist` 不查全局表 | **PASS** | AC① 换掉磁盘模板后 `save` ⇒ 三元组逐字节不变（前置断言确认注册表指纹已变，排除空转）；② 无 `getTemplateFingerprint`/`sha256:unknown`；③ 缺 record ⇒ `template_ref_missing`；④ 唯一性推断 + 回填（正 2 格 + 真实数据副本 8 份旧档全部回填 `1.0.0`） |
| **R-TG-10** 封闭原因码 + 列表可见不可载 + 409 | **PASS（AC① 第 3 形态证据形式降级，需求侧已认领）** | 四格矩阵 + `template_missing` / `template_version_ambiguous`（含「两版本都不匹配指纹仍判歧义」反例）/ 封闭枚举扫描 / 真 HTTP 409 `world_unloadable` + 可删；`template_invalid` 只能以 stub 注册表证映射（见 §3 P2-1） |
| **R-TG-14** 两级选择 + `openingId` 归属 | **PASS（服务端契约实测；AC①/④ 交互未实测）** | 同模板两版本 openings 不同 ⇒ 提交另一版本 `openingId` ⇒ 400 + `allowed:["op-2006-kyoto"]`；多版本缺版本号 ⇒ 400 + `versions:["1.0.0","2","10"]`（补 0 全序）；`main.tsx:773-817` 代码核对：openings 取自 `version?.openings`、切模板/切版本均清空 `openingId`、默认版本取 `startVersion` |
| **R-TG-15** 文件角色 + 分层指纹 | **PASS** | AC① assets 改动不改语义指纹、旧档仍可载；② 改白名单 yaml ⇒ 指纹变 ⇒ 旧档 `template_content_drift`；③ 游离 `notes.yaml` ⇒ 指纹不变 + warn + 旧档可载；④⑤ 空 assets ⇒ `sha256:e3b0c442…b855` 且 `assetCount` 暴露；⑥⑦ `.js/.svg/.md/.png/.wheel.json` ⇒ warn + 忽略 + 模板仍 ready；⑧ 服务端无 `eval`/`new Function`/`vm`；⑨ 实测语义指纹 = `sha256:9a945ac31fd9fb10716714bd608127ac87c9b24212721dd44015a16b7aec27e0`（与需求记录一致，**未写进 CI 断言**——模板一改就该变） |
| **R-TG-16** 运行时热加载 8 条 AC | **PASS** | ①就地改 `meta.name` 不重启即生效，**同时断言「目录 mtime 未变、文件 mtime 变」**；②旧世界快照逐字段不变且仍能推进一轮、落盘仍用旧三元组；③坏版本隔离（未载过 ⇒ `invalid`+reason；已载过 ⇒ **保留旧 Entry**，按口径澄清 #1）；④删版本目录 ⇒ 不再列出、已载入世界可推进可落盘；⑤重启后旧档 `template_content_drift`、改后新建档可载；⑥mtime 未变时两次 `listTemplates` 重扫增量 0（反向对照：改一次文件恰好 +1）；⑦`setInterval`/`fs.watch`/`watchFile` 零命中；⑧`statCount` 增量 = 版本目录文件数（**11，动态算，未写死 43**） |
| **R-TG-17** 只读边界 | **PASS** | 10 条写方法探针全 404（POST `/api/templates/imports`、PUT/PATCH/DELETE `/api/templates` 及 `/:id`、`/:id/:version`），`GET /api/templates` 仍 200（不是整组 404 的假绿）；无 multipart 依赖 / 无 `bodyLimit` / 无 `LIFE_SIM_ENV` / `TEMPLATE_IMPORT_TOKEN` / `base64` / `encoding` 载荷；前端无 `type="file"`、无 `FormData`、无 multipart |

---

## 1. 环境与基线

| 项 | 值 |
|---|---|
| 仓库 | `D:\code\ai-life-simulator` |
| 首轮基线 | HEAD `ff0378d` |
| 复验基线 | HEAD `7639d7a`（`fix(server/R2.8 T-TG-11): P1 非法版本目录名启动期 throw + P2 版本排序复用 compareVersions`） |
| 工作树 | `M docs/BACKLOG.md`、`M docs/DECISIONS.md`（**非 QA 改动**，T-TG-09 文档收口在途）；QA 侧为 3 个测试文件 + 本报告 |
| 数据隔离 | 全部测试用 `os.tmpdir()` 下的临时 `TEMPLATES_DIR` / `LIFE_SIM_DATA_DIR`；仓库 `data/worlds` 验收前后均 **65 份**、`specs/data/templates` **11 个文件**，未被增删改 |
| Node / pnpm | v22.22.2 / 9.15.0（Windows，Git Bash） |

---

## 2. 命令与实测结果（复验）

| 命令 | 退出码 | 结果 | 覆盖口径 |
|---|---|---|---|
| `pnpm typecheck` | **0** | 0 错 | 类型检查（含 3 个测试文件） |
| `pnpm --filter @life-sim/shared test -- --no-file-parallelism` | **0** | 5 文件 / **67 passed** | 正常 + 边界 + 无效输入 |
| `pnpm --filter @life-sim/game-core test` | **0** | 36 文件 / **522 passed** | 全量回归（含 QA 新增 44 例） |
| 其中 `src/v2/r28-save-migration.test.ts` | 0 | **13 passed** | 四格矩阵 + 原因码 + R-TG-08 + R-TG-01 AC④ |
| 其中 `src/v2/r28-hot-reload.test.ts` | 0 | **15 passed** | R-TG-16 八条 AC + R-TG-15 角色/指纹 |
| 其中 `src/v2/r28-readonly-boundary.test.ts` | 0 | **16 passed** | R-TG-17 + 静态红线 + R-TG-04 六形态退出码 + R-TG-01/10/14 真 HTTP + P2 排序 |

> 首轮为 519 passed / 13 例边界文件；复验把那条「断言旧 warn 现状」的用例拆成三条（空版本目录 / 非法名非空 / 非法名空目录）+ 新增 P2 排序用例 ⇒ 522。

### 2.1 四格矩阵 —— 实际运行输出（原样粘贴，非描述）

```
[四格矩阵实际运行结果]
格 | 夹具 | 结果 | reason
正 1 | 有 templateVersion | 载入成功 | -
正 2 | 无 templateVersion | 载入成功（已回填） | -
负 1 | 指纹不符 | 拒载 | template_content_drift
负 2 | 版本目录缺失 | 拒载 | template_version_missing
--- 实际 ---
loaded = ["w-pos-1","w-pos-2"]
w-neg-1 → template_content_drift (version=1.0.0)
w-neg-2 → template_version_missing (version=9.9.9)
```

夹具口径（写进用例注释）：

- 夹具**当场生成**（`create` + 开局结算，seed `20261113`），落在 `os.tmpdir()` 的临时 `LIFE_SIM_DATA_DIR`，**不读 `data/worlds`**、不写仓库（口径澄清第 3 条）。
- 正样本 `templateFingerprint` **setup 时按当前模板实时计算**（白名单 11 个 yaml 按名排序 + `name + "\0" + content` 的 sha256，测试内**独立实现**，不 import 服务端 `hashPairs`）；仅负 1 用故意不匹配常量 `sha256:deadbeef…`。
- 负 2 的「迁移前基线 = **N/A**」写进了用例注释与标题：旧 loader 不读 `templateVersion`，会载入成功，属预期差异，**未写成前后一致**。
- 回归判据四类（①被拒变被接受 ②正样本载不进 ③差异无法归入「新增拒绝/原因细分」④无基线格未满足绝对期望）写在文件头注释。
- 正 1 额外断言**信封逐字节不变**（无回填）；正 2 断言回填只加 `templateVersion` 一个字段、`state` 深比较不变、`archived` 不变。

### 2.2 「这位测试会红吗」—— 变异验证（每条 AC 的红法都被实证，不只看绿灯）

对生产代码做**临时**变异（每次跑完立即 `git checkout --` 还原，复验结束 `git status` 无残留）：

| 变异 | 位置 | 预期红 | 实测 |
|---|---|---|---|
| 删掉指纹比对（`if (false)`） | `store.ts:273` | 负 1 | **3 failed**（负 1 / 四格向量 / 封闭枚举） |
| 变更检测改用目录 mtime | `templates.ts:370-386` | AC① | **5 failed**（AC① 就地改名 / AC⑥ / assets / AC②⑤ / 口径澄清#1） |
| 去掉 `mtime` 相等跳过 | `templates.ts:678` | AC⑥ | **2 failed**（重扫增量 0 / 反向对照） |
| 已载过的坏版本改标 `invalid` | `templates.ts:617` | 口径澄清 #1 | **1 failed** |
| 跳过信封回填 | `store.ts:294` | 正 2 | **2 failed**（正 2 / 四格向量） |
| **排序退回字符串序** | `index.ts:361-364` | **P2 排序** | **1 failed**：`expected [ '1.0.0', '10', '2' ] to deeply equal [ '1.0.0', '2', '10' ]`（复现了修复前的真实输出） |
| **去掉非法版本名 throw** | `templates.ts:528-537` | **P1** | 首轮已实证：该用例在修复前本身就是红（`exit=1` 才通过，旧实现服务照常起来） |

> 结论：这些用例不是「跑绿就行」的形态——它们对实现的行为差异敏感；连修复方向反过来也会立刻红。

### 2.3 R-TG-17 写方法探针（真端口真 HTTP，原文）

```
POST    /api/templates/imports         → 404
POST    /api/templates                 → 404
PUT     /api/templates                 → 404
PATCH   /api/templates                 → 404
DELETE  /api/templates                 → 404
PUT     /api/templates/jjk-2006        → 404
PATCH   /api/templates/jjk-2006        → 404
DELETE  /api/templates/jjk-2006        → 404
PUT     /api/templates/jjk-2006/1.0.0  → 404
DELETE  /api/templates/jjk-2006/1.0.0  → 404
GET     /api/templates                 → 200
```

### 2.4 R-TG-04 启动期实测（子进程退出码，复验后）

| 形态 | 期望 | 实测 |
|---|---|---|
| yaml 语法坏（`events.yaml`） | 非 0 退出 | **exit=1**，输出含 `events.yaml` |
| Zod 校验失败（结构坏） | 非 0 退出 | **exit=1**（与上同为 `template_invalid:` 前缀，含文件与首个 issue 路径） |
| `meta.id` ≠ 目录名 | 非 0 退出 | **exit=1**，`template_invalid: jjk-2006@1.0.0: world.yaml: meta.id (wrong-id) 与模板目录名 (jjk-2006) 不一致` |
| templates 目录零模板 | 非 0 退出 | **exit=1**，`no_templates_found_in: …` |
| **非法版本目录名（`v2/` 内 11 个合法 yaml）** | 非 0 退出 | **exit=1**（复验）：`template_version_dir_invalid: <id>=jjk-2006 下存在目录 "v2"，但版本目录名必须是 ^\d+(\.\d+){0,2}$（例如 1.0.0、2、1.2.3）；路径：…\templates\jjk-2006\v2` |
| 空版本目录（`1.1.0/` 零 yaml，名字合法） | 启动成功 + warn | **启动成功**（health 200），列表只有 `1.0.0`，日志 `template_version_empty` |
| 空的非法名目录（`beta/`） | 当前实现：非 0 退出 | **exit=1** + `template_version_dir_invalid`（已钉成用例，见 §3 说明） |

> 「空版本目录豁免」与「非法名拒绝」的边界被显式钉住：`1.1.0/` 空 ⇒ 启动；`beta/` 空 ⇒ 拒绝。修的是「版本号写错」，没有顺手把「mkdir 还没 cp 完」也判死。

### 2.5 P2 排序复验（`7639d7a`）

造 `1.0.0` / `2` / `10` 三个版本目录（内容同一份），实测两个出口：

```
GET /api/templates  versions = ["1.0.0","2","10"]   startVersion=10
POST /api/worlds（无版本号）→ 400 {"error":"template_version_required","templateId":"jjk-2006","versions":["1.0.0","2","10"]}
```

- 两处**完全一致**，且是 A-3 的补 0 全序（`2` 在 `10` 之前）。
- 反向验证见 §2.2 最后两行：把排序退回字符串序，用例立刻给出 `["1.0.0","10","2"]`（修复前的真实输出）。
- `startVersion` = `10`（补 0 后最高可载版本），不是 `versions[0]`（`1.0.0`）也不是字符串最大（`2`）。

### 2.6 真实存档旁证（一次性审计，**只读副本**，不进 CI）

把 `data/worlds`（65 份）**复制**到临时目录后跑真实启动载入链：

```
saveFiles: 65, loaded: 8, unloadable: 57
byReason: { template_content_drift: 49, envelope_schema_version_unsupported: 8 }
loadedVersions: ["1.0.0"]
semanticFingerprint: sha256:9a945ac31fd9fb10716714bd608127ac87c9b24212721dd44015a16b7aec27e0
回填后含 templateVersion 的文件数: 8（= 可载的 8 份）
```

- 8 份可载档的信封指纹 = `sha256:9a945ac3…`，即**迁移未改变任何载入判定**（R-TG-10 AC④ 的迁移不变量在真实数据上成立）；这 8 份原始信封**都没有 `templateVersion`**，载入后被唯一性推断并回填到 `1.0.0`（R-TG-08 AC④ 的真实世界证据）。
- 49 份 `template_content_drift` 的信封值统一为 `sha256:790d0c5f…`（2026-11-12 写下的档），属 ADR-0007 既定「改 yaml ⇒ 旧档拒载」，**不是本轮迁移引入**。8 份 `schemaVersion=1`（R2.5 之前）同理。
- 该审计只在临时副本上发生回填；仓库 `data/worlds` 65 份未变（`ls | wc -l` 复核）。

---

## 3. 缺陷清单（复验后）

### P0 —— 无

### P1-1 · 版本目录名不合 A-3 正则时不 fail-fast —— **已修复（`7639d7a`）**

- **复核**：启动期（`scanAll`，`failFast=true`）改为 `throw`，错误含 `<id>` / 目录名 / 期望正则 / 完整路径四件；运行期 `ensureFresh` 保持「每 `(id,目录名)` 只 warn 一次 + 忽略」（I-3，不因手滑打挂在跑服务）。
- **复验证据**：`jjk-2006/v2/`（11 个合法 yaml）⇒ **exit=1**，日志原文见 §2.4 该行；空 `1.1.0/` ⇒ 启动成功（未连坐）。
- **用例**：`r28-readonly-boundary.test.ts` 中拆成两条独立用例 + 一条边界用例（见 §5）。
- **残留观察（不需要修）**：`beta/`（**空的**非法名目录）现在也会拒绝启动。这与 B-4 #3 的「空目录豁免」不冲突（豁免只针对**名字合法**的版本目录），也与需求正文一致（非法目录名本身就是一种失败形态）；已钉成用例，若产品将来要放宽会先红一次，逼一次显式决策。

### P2-1 · `template_invalid` 拒载分支在真实启动链上不可达（保持判断，需求侧认领）

- **位置**：`apps/server/src/store.ts:267-270`（分支）+ `templates.ts` 启动期 `throw`。
- **现象**：`loadPersistedWorlds` 只在 `index.ts:111` 启动期调用一次；启动期 `scanAll(failFast=true)` 遇坏模板直接 `throw`，因此注册表里**永远不存在** `status:"invalid"` 的条目 ⇒ `template_invalid` 这条拒载码在生产路径上不可达；运行期热加载又会「保留旧 Entry」（口径澄清 #1）。
- **现状**：QA 以**手工 stub 注册表**证明「`entry.status==='invalid'` ⇒ `reason='template_invalid'` + `detail` 带首个 issue」的映射正确（用例已注明该限制）；需求侧正在 R-TG-10 AC① 补「防御性分支、不作为验收用例」的说明。**本报告不改该用例。**
- **性质**：R-TG-10 AC①（四形态各一例）与 R-TG-04（启动 fail-fast）之间的规格固有张力，不是实现 bug。

### P2-2 · 多版本 400 响应里的 `versions[]` 用字符串序 —— **已修复（`7639d7a`）**

- `index.ts:361-364` 改为复用注册表导出的 `compareVersions`（版本排序单点实现）。复验：两处出口同序 `["1.0.0","2","10"]`（§2.5），退回旧实现立即可见 `["1.0.0","10","2"]`（§2.2）。
- 首轮判断得到实证：`/api/templates` 与 `startVersion` 本来就走 `compareVersions`（不受影响），**只有 400 的 `versions[]` 是错的**。

### P2-3 · 回填信封时 `savedAt` 未做类型兜底（未处理，备查）

- **位置**：`apps/server/src/store.ts:294-303`。
- **现象**：若手改档删掉 `savedAt`，回填后的信封会丢掉该字段，随后 `savedAtById.set(id, undefined)` 往 `Map<string,string>` 塞 `undefined`。
- **影响**：只影响人手改过的档；正常档 `savedAt` 恒存在。不在 ACTIVE AC 范围内。

---

## 4. 未覆盖项与证据缺口

| # | 项 | 为什么没覆盖 | 现有替代证据 |
|---|---|---|---|
| 1 | R-TG-14 AC①/④ 的**交互**验证（真点击切换模板/版本后下拉项变化、页面不再出现跨模板开局） | 仓库无浏览器测试基建（无 e2e 脚手架、无 headless 浏览器依赖）；为验收临时搭浏览器栈属「新增测试基建」，超出 QA「不改基建」的授权 | 服务端契约实测（两版本 openings 不同、跨版本 `openingId` ⇒ 400 + `allowed[]`）+ `apps/web/src/main.tsx:773-817` 代码核对：`openings = version?.openings`、`changeTemplate`/`changeVersion` 都清空 `openingId`、默认版本取 `startVersion`；`useEffect` 兜底清空失效 `openingId` |
| 2 | R-TG-16 AC⑧ 的「**不重解析 yaml**」直接证据（解析次数） | 代码未暴露解析计数器，无法在测试里直接观测 | `rescanCount` 在 mtime 未变时恒为 0 ⇒ 未进 `reloadVersion` ⇒ 未调 `loadTemplate`（yaml 解析唯一入口），属结构性间接证明；`statCount` 增量已精确断言 |
| 3 | R-TG-15 AC⑨ 的「与迁移前逐字节相同」 | 「迁移前」状态已不存在（`391578a` 已落地），无法在当前工作树复现迁移前快照 | 实测当前指纹 = `sha256:9a945ac3…`（与需求记录值一致）+ 真实存档旁证（8 份该指纹的旧档全部可载）⇒ 迁移不变量成立 |
| 4 | 多版本并存时的**世界详情**全链路（每局 `templateVersion` 回显） | 需要在两个版本上都建局并对比详情字段，本轮只验了「建局 + 409/404 语义 + 列表排序」 | 世界列表 `templateVersion: entry.ref.version`（`index.ts:628`）代码路径唯一，且单版本建局路径已实测 201 |
| 5 | 模板 `assets/` 真实图片/音频的展示效果 | H-7 明确本轮 DEFERRED（无下发端点、无 schema 引用字段），**无对象可测** | 静态断言：`assetCount`/`assetFingerprint` 存在且不参与拒载（已实测） |
| 6 | `template_version_ambiguous` 在「已有存档 + 运行期新增坏版本」组合下的表现 | 该组合需要 `loadPersistedWorlds` 在运行期再跑一次，而它只在启动期调用（见 P2-1） | 已用「启动期两版本 + 无版本号信封」覆盖该码本体 |
| 7 | 运行期 `ensureFresh` 对非法版本名目录「只 warn 一次」的去重行为 | 属于日志噪声治理，非 ACTIVE AC；本轮未单独立用例 | 代码核对（`warnedVersionDirs` 集合）；启动期该场景已改为 throw，运行期仅在手滑 mkdir 时出现 |

---

## 5. 本次修改的文件

| 文件 | 性质 | 内容 |
|---|---|---|
| `packages/game-core/src/v2/r28-save-migration.test.ts` | 新增（`b1cb37a`，复验未改） | 四格矩阵（正1/正2/负1/负2 + 同批向量）+ 其余封闭原因码（`template_missing` / `template_version_ambiguous` 含反例 / `template_invalid` stub / 封闭枚举扫描）+ R-TG-08 AC①②③④ + R-TG-01 AC④ |
| `packages/game-core/src/v2/r28-hot-reload.test.ts` | 新增（`b1cb37a`，复验未改） | R-TG-16 AC①~⑧（含「目录 mtime 未变」的行为断言、`rescanCount`/`statCount` 增量、口径澄清 #1 的保留旧 Entry）+ R-TG-15 角色/分层指纹 |
| `packages/game-core/src/v2/r28-readonly-boundary.test.ts` | 新增 + **复验修改** | R-TG-17 静态断言 + 10 条写方法探针（子进程真 HTTP）+ R-TG-16 AC⑦/⑨ 与 R-TG-15 AC⑧ 静态红线 + **R-TG-04 六形态（含拆出的「空版本目录启动成功」「非法名非空 ⇒ exit=1」「空的非法名目录 ⇒ exit=1」三条）** + R-TG-01 AC②/`startVersion` + **P2 三版本排序（两出口一致）** + R-TG-14 两个 400 + R-TG-10 409/可删全链路 |
| `tasks/reports/R28-ACCEPTANCE.md` | 新增 + **复验更新** | 本报告 |

**未改任何生产代码**（`apps/**`、`packages/**` 源码零改动；复验期间的变异均为临时，已 `git checkout --` 还原并复核 `git status`）。
测试引入的唯一「基建」是 `r28-readonly-boundary.test.ts` 内的**子进程 + 真端口**辅助（约 80 行）：因为 `index.ts` 在模块顶层 `listen()` 且不导出 app 工厂，进程退出码与 HTTP 状态码无法在进程内取得。该辅助强制要求显式传入 `TEMPLATES_DIR` / `LIFE_SIM_DATA_DIR` 并在缺失时抛错，从机制上防止碰真实目录；`vi.setConfig({testTimeout:120_000})` 只作用于本文件。

---

## 6. 已执行的命令清单（可复跑）

```bash
pnpm typecheck                                                    # exit 0
pnpm --filter @life-sim/shared test -- --no-file-parallelism      # 67 passed
pnpm --filter @life-sim/game-core test                            # 522 passed / 36 files

# 只跑本轮三件套
pnpm --filter @life-sim/game-core exec vitest run \
  src/v2/r28-save-migration.test.ts src/v2/r28-hot-reload.test.ts src/v2/r28-readonly-boundary.test.ts

# P1 / P2 的手工复现（临时目录，不碰仓库）
# 1) 非法版本名：cp 一份模板到 jjk-2006/v2/ 后起服务 ⇒ 期望 exit=1
# 2) 排序：造 1.0.0 / 2 / 10 三个版本目录 ⇒ GET /api/templates 与 400 的 versions[] 均 ["1.0.0","2","10"]
```
