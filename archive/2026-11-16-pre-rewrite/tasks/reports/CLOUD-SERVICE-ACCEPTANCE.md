# 云服务接入（WorkBuddy 登录 + 人生档案）· 验收报告（ADR-0025）

- **验收人**：严过关（测试验收工程师）
- **验收对象**：commit `2991eb2 feat(web): 前端接入云服务（WorkBuddy 登录 + 人生档案）`
- **父提交**：`988f7ef docs: 新增 ADR-0025 云服务接入（账号登录 + 人生档案）`
- **HEAD**：`2991eb29182865c36dafcf4be10b20866f87b53c`；验收开始时 `git status --short` 为空，结束时仍为空
- **验收时间**：2026-11-12
- **环境**：Windows / Node v22.22.2 / pnpm 9.15.0 / Chrome（headless，`puppeteer-core` 25.17.0）/ 视口 430×932；本地服务端 `PORT=3199`（`pnpm --filter @life-sim/server start`）
- **纪律**：本轮只测量与登记。**未改动任何产品代码、测试断言、云端数据**；仓库内唯一新增文件是本报告。探针脚本全部放在仓库外（`%TEMP%`）。
- **裁决摘要**：**退回**（1 项 P1 必修），引擎与失败面全绿，红线与 RLS 站得住。

---

## 一、验收裁决

| 项目 | 结论 |
|---|---|
| 任务 | 云服务接入（ADR-0025）：WorkBuddy 账号登录 + 人生档案上云 |
| 需求 | ADR-0025 决策 1–9 + 验收口径 1–7 |
| 裁决 | **退回（不可验收）** |
| 一句话理由 | 单例/endpoint 字面量、OAuth 回调顺序与 query 保留、hidden 零外泄、未登录零请求、七类失败面、构建与类型、RLS 四条策略均实测通过；但**「结局产生即写」被实现成「已终止快照存在即写」**，导致 `ADR-0025 决策 8` 明令禁止的「登录回跳后自动补写」在代码上必然发生（P1，D-01），必须修。 |

> 退回不是「整体不可用」：游戏主链路、未登录路径、失败降级都实测正常。退回的唯一原因是**一条已被接受的决策没有落地**，且它恰好落在「未登录完成一局的玩家回来登录」这条最常见路径上。

---

## 二、范围与四条口径（本人重跑，不采信转述）

### 2.1 改动范围（`git diff --name-only 988f7ef 2991eb2`）

```
apps/web/package.json
apps/web/src/auth.ts        (新增 182 行)
apps/web/src/cloud.ts       (新增  44 行)
apps/web/src/main.tsx       (+319 −3)
apps/web/src/records.ts     (新增 238 行)
pnpm-lock.yaml              (+9)
```

**协议/引擎/服务端零改动已核实**：`git diff --name-only` 内不含 `packages/**`、`apps/server/**`；与 ADR-0025 首句「零协议改动」一致。

### 2.2 命令结果

| 命令 | 退出码 | 结果 | 覆盖口径 |
|---|---|---|---|
| `pnpm typecheck` | **0** | 0 错（`tsconfig.json` 的 `include` 含 `apps/**/*.tsx`，本轮新文件全在覆盖面内） | 类型 |
| `pnpm --filter @life-sim/web build` | **0** | `vite v6.4.6`；`dist/index.html 0.96 kB`、`index-JUhOMFES.css 24.01 kB`、`index-D_SZsDX8.js 355.30 kB (gzip 108.40)` | 构建 |
| `pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism` | **0** | **32 files / 465 tests passed**，66.59s —— 与基线 465 完全一致，本轮未动引擎，数字未变 | 正常/边界/无效输入 + 确定性回归 |

服务端冒烟（`PORT=3199`）：`GET /health` → `{"ok":true,"service":"life-sim-server","protocol":"v2"}`；`GET /api/templates` → 唯一模板 `jjk-2006`；启动日志 `worlds_loaded {loaded:5, skipped:57}`（旧档指纹不符拒载，属 ADR-0007 既定行为）。

**口径结论：3 / 3 PASS。**

---

## 三、DoD 核验表

> ADR-0025 为「已接受」且**本轮没有 `tasks.md`**（与 `JJK-V2-ACCEPTANCE.md` 同形），因此没有 `T-*` 级完成定义。下表以 **ADR-0025「验收口径 1–7」+ 主理人下发的 9 条必查项** 作为 DoD 口径逐条裁定。

| 完成定义条目 | 结果 | 证据 |
|---|---|---|
| **ADR 口径 1** 建表与 RLS：`list_tables` 见 `life_records`（RLS on）、`list_rls` 见 4 条策略均 `owner_id = auth.uid()` | **PASS** | `db_list_tables` → `[{"Name":"life_records","RLSOn":true}]`；`db_list_rls` → 4 条（select/insert/update/delete）；`pg_policies` 补充查询 → `roles={anon,authenticated}`，`qual`/`with_check` 全为 `(owner_id = auth.uid())`；第三条独立证据见 §五-1 |
| **ADR 口径 2** 已登录往返：写一次读回同一行；同 `world_id` 再写仍 1 行且字段被更新 | **N/A（证据缺口 G-4）** | 需要真实 WorkBuddy 会话，localhost 被 Relay 拒；表当前 `rows_total=0, owners=0`（`SELECT count(*)`），**恰好证明未用特权通道造行**。可验的静态部分全部成立：唯一索引存在、`onConflict` 与索引列一致（§四-4） |
| **ADR 口径 3** 未登录：只给登录入口，**不发**数据库请求 | **PASS** | headless Chrome 实测：结算态与「档案」页签各 **0 次**云端请求（§四-5） |
| **ADR 口径 4** 越权：`.delete()` 返回 `[]` ⇒ UI 报错，不得静默当成功 | **PASS（运行时）** | 探针⑨：`delete` 返回 0 行 → `{status:"error", message:"未删除：档案不存在或无权删除。"}`；UI 侧 `main.tsx:2567` 走 `setError`，不当成功。真实「另一账号的行 id」需第二账号（缺口 G-2） |
| **ADR 口径 5** 失败面完备：断网 / 401 / 42501 / 23505 / 超配额各有明确文案 | **PASS** | 探针注入错误码跑真实分支，5 类文案**互不相同**；另两类（未登录、42P10）见 §四-6 的说明 |
| **ADR 口径 6** 红线抽查：库里任一行都不含 hidden NPC 名 / `missedEvents` / dimension `explanation` / 邮箱手机号 token | **PASS（替代证据）** | 表内 0 行 ⇒ 无真实行可抽查；替代证据 = 对**真实快照**与**引擎产出的 hidden 结局快照**跑真实映射器，18 个禁止串**全部 0 命中**（§四-3）。缺口 G-5 |
| **ADR 口径 7** 证据缺口声明 | **PASS** | 见 §七（本报告显式列出 7 条缺口，含「跨用户隔离只有两个真实账号能证明」「`exec_sql` 是特权通道，不作为 RLS 证据」） |
| **必查 1** 单例 + `endpoint` 字面量 | **PASS** | §四-1 |
| **必查 2** OAuth 回调顺序与 query 保留 | **PASS** | §四-2（真实浏览器 + 真代码路径探针） |
| **必查 3** hidden 信息零外泄 | **PASS** | §四-3（行键集合 + 红线扫描 + masked 结局探针） |
| **必查 4** 幂等（唯一索引 + 归档后二次写同 `worldId`） | **PASS**（真实往返缺口 G-4） | §四-4 |
| **必查 5** 未登录零请求 | **PASS** | §四-5 |
| **必查 6** 失败路径七类 + 云调用不影响 `/api/**` | **PASS** | §四-6（含真实浏览器里 SDK 真实失败的一次实证） |
| **必查 7** 构建与类型 | **PASS** | §二（3/3） |
| **必查 8** RLS 现状核对（`describe_table` 矛盾裁定） | **PASS** | §四-8 / §五-1：**`describe_table` 的 `RLSOn` 不可信，`pg_class.relrowsecurity=true` 为准** |
| **必查 9** dependency 卫生 | **PASS** | §四-9 |
| **额外** 决策 8：写是玩家可见动作；未登录不写；**登录回跳后不自动补写** | **FAIL（P1 / D-01）** | `main.tsx:212-223` 的自动写 effect 以 `[session, snapshot]` 为触发，`savedWorldsRef` 每次挂载重置 ⇒ 登录回跳（整页重载）后 `session` 非空 + 已终止快照 ⇒ **必然写一次**。详见 §六 D-01 |

---

## 四、逐条证据

### 4.1 单例与 endpoint 字面量（必查 1）— PASS

```
$ grep -rn "createWorkBuddyCloud" apps/web/src
apps/web/src/cloud.ts:1   import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
apps/web/src/cloud.ts:24  * 造第二个实例就会…**不要在别处再调 `createWorkBuddyCloud`**。   ← 注释
apps/web/src/cloud.ts:26  export const cloud = createWorkBuddyCloud({                    ← 唯一调用
apps/web/src/records.ts:58 * `createWorkBuddyCloud` 全仓只调一次）。                      ← 注释
```
全仓（排除 `node_modules`/`dist`）亦只有这一处调用。

- `endpoint` 只取字面量：`cloud.ts:15 endpoint: "https://cursed-wheel-life.app.workbuddy.host"`，构造处 `cloud.ts:27 endpoint: publicConfig.endpoint`。
- 反面证据（必须为空）：`grep -rn "location\.origin|import\.meta\.env|127\.0\.0\.1|localhost" apps/web/src` → 命中**只有 `cloud.ts:10` 的一行注释**（说明「不从 `location.origin` 推断」）与 `cloud.ts:15` 的域名本身。
- 产物层面：`apps/web/dist/assets/index-*.js` 里 `https://…` 主机名只有两个 —— `cursed-wheel-life.app.workbuddy.host`（本应用）与 `https://www.workbuddy.cn`（Relay 基址）。`location.origin` 在产物里出现 1 次，上下文是 **SDK 自己的兜底分支**（`"endpoint is required outside browsers (no location.origin to fall back to)"`），本应用始终传字面量 ⇒ 该兜底不可达。
- 字面量与真实发布域一致（佐证）：

```
$ grep -rn "cursed-wheel-life" . --include="*.ts" --include="*.md" | grep -v node_modules
./.workbuddy/memory/2026-11-12.md:173: **云端已上线**：`https://cursed-wheel-life.app.workbuddy.host/?sharecode=AWEIS4D6KT`（http-service，verified）
./apps/web/src/cloud.ts:15:  endpoint: "https://cursed-wheel-life.app.workbuddy.host",
```
（该 memory 文件被 gitignore，属本地运维记录，权威性中等 —— 见缺口 G-3。）

### 4.2 OAuth 回调顺序与 query 保留（必查 2）— PASS

**顺序（静态，可执行位置）**：`main.tsx:2670 const authBootstrap = bootstrapAuth();` → `main.tsx:2672 createRoot(...).render(<App/>)`。

- 调用点在**模块顶层**：不在任何组件体内、不在 `useEffect` 里（`App` 只在 `main.tsx:189` 消费它的 Promise）。
- 在**恢复 localStorage 世界之前**：`worldId` 的初值来自 `main.tsx:157 useState(loadWorldId())`，它是 render 期执行的；模块顶层的 `bootstrapAuth()` 先于 `render` 发生 ⇒ 先兑换一次性 code，再用存档恢复。
- 不 `await`：云不可用不阻断渲染（决策 5），失败经 `App` 的 `authNotice` 呈现为可关闭横幅。

**回调清理只删 `code`/`state`/`provider`（`auth.ts:52-55`）**

```ts
function clearCallbackParams(url: URL): void {
  for (const key of ["code", "state", "provider"]) url.searchParams.delete(key);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
```

**真代码路径探针**（`%TEMP%\probe-auth.mts`：只替身 `location`/`history` 与 SDK 的 `handleWorkBuddyCallback`/`getSession`，分支判断与清理全部走仓库代码）：

| 场景 | 处理后 URL | 剩余 query | `handleWorkBuddyCallback` 调用 | 返回 |
|---|---|---|---|---|
| ①`?sharecode=KEEP&code=x&state=y&provider=workbuddy` | `/?sharecode=KEEP` | `sharecode` | **true** | `{session, error:null}` |
| ②`provider=wechat` | `/?sharecode=KEEP` | `sharecode` | **false** | `授权回调缺少有效的登录方式，请重新登录。` |
| ③有 `code` 缺 `provider` | `/?sharecode=KEEP` | `sharecode` | **false** | 同上 |
| ④普通启动（无 `code`/`error`） | 未改动（`replaceState` 未调用） | `sharecode` | false | `{session:null, error:null}` |
| ⑤`&error=access_denied` | 未清理 `error` | `error,sharecode` | false | `授权回调缺少有效的登录方式，请重新登录。` |

断言：handler 按 provider 分派正确且 `sharecode` 每次保留 → **PASS**；清理后残留 `code/state/provider` 的场景 = **0**。⑤ 的副作用登记为 D-03。

**真实浏览器复核**（headless Chrome，430×932）：
- `④/?sharecode=KEEP&code=x&state=y&provider=wechat` → 地址栏 `http://127.0.0.1:3199/?sharecode=KEEP`，页面照常进入游戏，`/api/worlds/...` 正常返回，控制台仅一条 `[WorkBuddy Cloud] request failed {"stage":"auth:callback-provider"...}`。
- `provider=workbuddy`（**不 stub 任何东西**，真实 SDK 真实失败）→ 地址栏同样只剩 `?sharecode=KEEP`；横幅 1 个（「登录未完成，请重试。」）；六页签齐全；点击选项后主链路继续推进。

> 说明：该次真实回调**未真正发出网络兑换**（本地无 PKCE verifier，SDK 在本地即失败），因此它证明的是**失败收口 + URL 清理 + 不阻塞游戏**，**不**证明真实往返（缺口 G-1）。

### 4.3 hidden 信息零外泄（必查 3）— PASS

**字段映射审计（`records.ts:84-118` 逐字段对照 ADR-0025 决策 2/3）**

| 上云字段 | 来源 | ADR-0025 | 判定 |
|---|---|---|---|
| `world_id` / `template_id` / `world_name` | `snapshot.worldId/templateId/worldName` | 决策 2 列入 | OK |
| `player_name` / `player_age` | `snapshot.player.name/age` | 决策 2 列入 | OK |
| `ending_label` | **`ending.title`（投影后，已掩码）** `records.ts:97` | 决策 3「绝不回 `endings.yaml` 取原文」 | OK |
| `ending_id` / `route` | `ending.endingId` / `ending.endingType` | 决策 2 列入 | OK |
| `final_day` | `Math.max(0, Math.floor(worldTime/1440))` `:102` | 决策 2「与 QA 基线 `day` 同口径」 | OK（口径核对见下） |
| `final_time` / `story_chapter` / `overall` | 投影原值 | 决策 2 列入 | OK |
| `dimensions` | `.map(({id,label,score,level}) => …)` `:107-112` | 决策 2 只 `{id,label,score,level}`；决策 3 排除 `explanation` | OK |
| `npc_count` | `snapshot.npcs.length` | 决策 2 列入（**只计数不落名**） | OK |
| `status` | `terminated`/`archived` | 决策 2「runStatus」 | OK |
| `updated_at` | `new Date().toISOString()` | 表列 | OK |
| `owner_name` | `session.user.name`（昵称） | **决策 2 未登记** | **D-02（P2）** |
| `owner_id` | — | 决策 6「前端不发送」 | 类型上 `Omit`（`records.ts:54`），运行时行内不存在 |

`final_day` 口径核对：`packages/game-core/src/v2/time.ts:23 day: 1440`；探针 A 的 `worldTime=133920 → day=93`，与 `Math.floor(133920/1440)=93` 一致；探针 5 的 `4755*1440 → 4755`，与既有报告里的 `复活@day4755` 同口径（0 = 开局当天）。

**探针（`%TEMP%\probe.mts`，仓库外，跑真实快照）**

- **A. 真实终止快照**（本地服务端一路打到 `terminated`，`ending.visibility="public"`，`endingId=end-ordinary`）
  - 行键集合（17 个，= `Omit<LifeRecordRow,"id"|"created_at"|"owner_id">`）：
    `dimensions, ending_id, ending_label, final_day, final_time, npc_count, overall, owner_name, player_age, player_name, route, status, story_chapter, template_id, updated_at, world_id, world_name`
  - `ending_label === snapshot.ending.title` → **true**；`dimensions[0]` 键 = `id,label,score,level`（**无 `explanation`**）；`final_day=93`、`npc_count=10` 与快照一致。
  - 红线扫描（18 个禁止串：`天内理子`/`四度逆行`/`两次逆行`/`星浆体`/`同化`/`missedEvents`/`history`/`explanation`/`email`/`phone`/`token`/`openid`/`owner_id`/`publishableKey`/`wbpk_` 等）→ **0 命中**。
- **B. running 快照** → `buildLifeRecordRow` 返回 **null**（未终止不上云）。
- **C. hidden 结局（真实模板 + 引擎决胜 + 真实投影）**：把四个「改写历史」flag 置真后走 `advanceTurnV2(endLife)` → `endingId=end-secret-thrice`、`visibility=hidden`、投影 `title=未公开的结局`；模板原文 `title/name=四度逆行`。
  - `row.ending_label = 未公开的结局`，`=== 投影 title` → **true**；行内**不含** `四度逆行`（红线扫描 0 命中）⇒ 「绝不回模板取原文」在运行时成立。

补充观察（非本轮缺陷）：快照 `npcs` 里出现模板声明 `visibility: hidden` 的 `天内理子`（`characters.yaml:181`）——这是 `BACKLOG B-22` 已登记的存量偏差（`visibility` 未参与上屏过滤），与本轮无关；且记录的 `npc_count` 只是数字，**不落任何 NPC 名**。

### 4.4 幂等（必查 4）— PASS（真实往返见缺口 G-4）

云端唯一索引（本人独立查询）：

```sql
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='life_records'
→ life_records_pkey            UNIQUE (id)
→ life_records_owner_world_uidx UNIQUE (owner_id, world_id)      ← 与 onConflict 完全一致
→ life_records_owner_created_idx (owner_id, created_at DESC)     ← listLifeRecords 的 order 列
```

- `records.ts:155 .upsert(row, { onConflict: "owner_id,world_id" })` ↔ 唯一索引 `(owner_id, world_id)`：**列与顺序均一致**。
- `owner_id` 由 `DEFAULT auth.uid()` 填（`describe_table` 显示 `Default: auth.uid()`），前端不发 `owner_id`（类型 `Omit` + 运行时行内无该键）⇒ INSERT 走默认值，冲突判定能命中。
- 归档后二次写同一 `worldId`：`main.tsx:368-392`（`archive`）用 `res.archive.snapshot`（同一 `worldId`，`status=archived`）再调 `saveLifeRecord`，且**刻意不查** `savedWorldsRef`（注释 `:380-382` 明写「正是要靠这次 upsert 撞唯一索引」）⇒ 「terminated → archived 只留一行」的代码路径成立。
- 退化路径（`42P10`）运行时验证：`records.ts:160-163` → `saveByLookup` 先 `select * eq(world_id) maybeSingle()`，有行则 `update eq(id)`；探针⑦实测调用链 `from → upsert → select → from → select → eq(world_id) → maybeSingle → from → update → eq(id) → select`，结果 `saved`；写操作 0 行则判失败（`records.ts:195-197`）。

### 4.5 未登录零请求（必查 5）— PASS

**守卫位置（独立复核）**：`main.tsx:2487-2509` 的 effect **第一句**就是 `if (!session) { setRows(null); setError(null); return; }`，`listLifeRecords()` 在 return 之后；组件内其余云调用（`saveCurrent`/`remove`）也都以 `if (!session) return` 前置（`:2530`）。自动写 effect 同样以 `if (!session || !snapshot) return` 前置（`:213`）。

**运行时不采信代码、直接数请求**（headless Chrome，`page.on("request")` 匹配 `workbuddy.host|workbuddy.cn|/rest/v1|/auth/v1|.cloud/`）：

| 场景 | 云端请求数 | `/api` 请求 |
|---|---|---|
| ① 未登录进入已终止的一局（结算态） | **0** | `GET /api/worlds/<id>` |
| ② 未登录点「档案」页签（等 2.5s） | **0** | `GET /api/worlds/<id>` |
| ③ 未登录点选项推进一轮 | **0** | `GET /api/worlds/<id>`、`POST …/events/choose` |
| ④ 带回调参数加载页面 | **0**（provider 不符，不触达 SDK） | `GET /api/worlds/<id>` |

② 页面文本 = 登录引导（「使用 WorkBuddy 登录」1 个按钮 + 「不登录也能照常玩」），**无**任何行渲染 ⇒ 无上一账号残留；① 结算面板可见且只有一行中性提示「登录后可把这局存进人生档案。」，未弹窗、未打断结算。

### 4.6 失败路径七类 + 主链路隔离（必查 6）— PASS

**文案覆盖（`records.ts:121-132`，运行时逐类驱动）**

| 失败面 | 输入（注入到 SDK 边界） | 实际文案 | 结果 |
|---|---|---|---|
| 正常 | `{data:[{id:1}]}` | — | `saved` |
| 未登录 | `kind="unauthenticated", status 401` | 登录状态已失效，请重新登录。 | error |
| 断网 | `kind="network", status 0` | 网络异常，档案未保存，可重试。 | error |
| 401（域名不匹配） | `{}, status 401` | 当前域名与云服务不匹配，请联系管理员。 | error |
| 42501 | `code="42501", status 401` | 登录状态已失效，请重新登录。 | error（**按码归因，未被 401 误判成域名问题**） |
| 23505 | `code="23505", status 409` | 该局档案已存在。 | error |
| 42P10 | `code="42P10", status 400` | —（退化为先查后写，成功则**不给玩家错误**） | `saved` |
| 超配额 | `kind="credits-exhausted", status 402` | 云服务额度不足，档案暂不可用。 | error |
| 越权删除 | `{data:[]}` | 未删除：档案不存在或无权删除。 | error |
| 删除成功 | `{data:[{id:99}]}` | — | `deleted` |
| running 局 | 无网络调用 | 这一局还没有结局，暂时不能存进档案。 | `skipped` |

**裁定**：ADR-0025 口径 5 逐条点名的 5 类（断网/401/42501/23505/超配额）**文案互不相同**，PASS。附注两条，均不构成缺陷：① 「未登录」与「42501」共用同一句（处置确实相同：重新登录；RLS 拒写最常见原因就是无会话）；② 「42P10」在退化成功时不对玩家报错（设计如此），仅在退化也失败时才出「档案表缺少唯一索引，请联系管理员。」

**不影响 `/api/**` 主链路（三项证据）**
1. 代码：`records.ts` 四个导出函数（`saveLifeRecord`/`listLifeRecords`/`deleteLifeRecord`/`saveByLookup`）与 `auth.ts` 全部入口都有 `try/catch`，任何失败都返回 `{status:"error",message}` 而非抛出；调用点一律 `void …()`（`main.tsx:219`、`:383-385`）或 `.then()` 内只回滚去重键，**从不 `await` 进动作/推进路径**。
2. 真实浏览器：`provider=workbuddy` 真实回调失败（SDK 报 `stage:"auth:callback-exchange"`）时，页面**六页签齐全、快照正常渲染、点选项仍能推进**，只多出 1 个可关闭横幅。
3. 探针：任一失败面都返回结构化结果，无一例抛异常（上表 11 行全部正常返回）。

### 4.7 构建与类型（必查 7）— PASS

见 §二。附带：`apps/web/vite.config.ts` 无外链/CDN 配置；`apps/web/dist/index.html` 只有 `<script type="module" crossorigin src="/assets/index-*.js">` 一条，无第三方 CDN。

### 4.8 RLS 现状核对 + 三方矛盾裁定（必查 8）— PASS

| 证据源 | 结论 | 说明 |
|---|---|---|
| `db_list_tables` | `life_records` → **`RLSOn: true`** | |
| `db_list_rls` | 4 条策略，`Using`/`WithCheck` 全为 `(owner_id = auth.uid())` | `Roles` 字段返回空串（工具未填） |
| `pg_policies`（本人补查） | 4 条；`roles={anon,authenticated}`；`qual`/`with_check` 全为 `(owner_id = auth.uid())` | 这是对 `Roles:""` 的补充确认 |
| **`pg_class`（第三证据，权威）** | `relname=life_records, relrowsecurity=true, relforcerowsecurity=false, owner=cloudbase_postgres_postgres_oadrn87a` | 直读系统目录 |
| `db_describe_table` | `RLSOn: false` | **与前四者矛盾** |

**裁定：`describe_table` 的 `RLSOn` 不可信，`relrowsecurity=true` 为准。** 三条独立理由：
1. `pg_class.relrowsecurity` 是 PostgreSQL 判定 RLS 是否启用的**唯一权威位**，`pg_policies` 里 4 条策略也确实存在于该表上；
2. `describe_table` 同一响应里连表注释都丢了（`Comment: ""`，而 `list_tables` 有注释）⇒ 它的元数据来源与 `list_tables`/`list_rls` 不是同一处，属于工具侧读取缺陷，不是数据库状态；
3. 如果 RLS 真的关闭，`list_rls` 仍会列出策略（策略存在≠生效），但 `pg_class` 会给出 `false` —— 现在它是 `true`，两个独立查询（`db_list_tables`、`pg_class`）一致指向「开启」。

补充观察：`anon` 在 `information_schema.role_table_grants` 里持有 `SELECT/INSERT/UPDATE/DELETE` 表级权限。这不是漏洞：四条策略的判据都是 `auth.uid()`，anon 的 `auth.uid()` 为 NULL ⇒ `owner_id = NULL` 不为真 ⇒ 无行可达。记录在案，避免下次被当成「策略形同虚设」误判。

### 4.9 dependency 卫生（必查 9）— PASS

| 检查 | 结果 |
|---|---|
| 通道 | `apps/web/package.json:12 "@tencent-ai/workbuddy-cloud-sdk": "dev"` —— **dev 通道** |
| 未锁死版本 | specifier 是 dist-tag `dev`，不是 `0.1.4-dev.ca27990.202610161713` 这类精确版本 |
| 锁文件一致 | `pnpm-lock.yaml:60-62` `specifier: dev` → `version: 0.1.4-dev.ca27990.202610161713`；`pnpm ls -r` 解析结果同值；本轮 lock 只 +9 行（一个 importer 条目 + 一个 package 条目） |
| 无 CDN 形态 | `index.html` 仅 `<script type="module" src="/src/main.tsx">`；产物 SDK 已打进 bundle（`dist/assets/index-*.js` 内 `workbuddy` 命中 2 处） |
| 只有 web 依赖它 | `pnpm ls -r` 仅 `@life-sim/web` 一处；`apps/server` 零新增依赖 |

---

## 五、专项检查

| 检查项 | 结果 | 证据 |
|---|---|---|
| 确定性可重现 | **N/A（本轮不改引擎）** | 本轮 diff 不含 `packages/**`；`465/465` 与基线一致。顺带点检：同一 seed `424242` 连续建 3 个世界，签名（`formattedTime/worldTime/pendingEvent/turnIndex/attributes/mood/hp/npcs`）**3/3 完全一致**（`{"t":"2006年1月1日 00:00","wi":0,"pe":"ev-opening-wheel","turn":0,...}`），未发现引擎侧漂移 |
| DEFERRED/RETIRED 未混入范围 | **PASS** | `git diff 988f7ef..2991eb2 --name-only` 不含 `packages/**`/`apps/server/**`；`grep -rn "R-TT-\|R-LC-" apps/web/src` 空 ⇒ `R-TT-01..07`（DEFERRED）与 `R-LC-01..06`（RETIRED）既未实现也未测试 |
| V1 残留符号 | **PASS** | `grep -rn "evaluateLife\|advanceTurn(\|lifecycle\|PhaseTransitionLog" apps/web/src` 只命中 `api.advanceTurn(`（V2 客户端方法）与 `npc.lifecycle.state`（V2 NPC 生命周期字段，ADR-0012/0020，非 V1 状态机）；全仓 `PhaseTransitionLog` 只出现在 `packages/game-core/src/v2/boundary.test.ts` 的**禁止性断言**里；无 `lifecycle.ts`（`packages/game-core/src/v2/` 只有 `lifecycle.test.ts`/`lifecycle-switch.test.ts`，测的是 NPC 生命周期字段） |
| 未引入 Lifecycle 状态机 | **PASS** | 同上；本轮新增 790 行全在 `apps/web`，无 `Phase`、无 `transition(state, to)`、无阶段日志 |
| hidden 未进入玩家端 API / 未进云端行 | **PASS** | §四-3；另：hidden 结局在玩家端显示为掩码标题（`projection.ts:329-338`），云端行沿用该掩码标题 |
| 云调用未成为状态裁判 | **PASS** | 云端行永不回读：全仓无「从 `life_records` 读入引擎」的调用（`records.ts` 只有 list/delete 供 UI 展示）；`/api/**` 的推进不依赖任何云结果 |
| 未造假会话 / 未造假数据行 | **PASS** | 表内 `rows_total=0, owners=0`；本轮未做任何 `write`/`migrate` SQL；浏览器探针未写入任何 localStorage 会话（只放 `life-sim:worldId`，这是游戏自身的存档指针） |

---

## 六、缺陷清单

### D-01【P1 · 必修 · 判 FAIL】登录回跳 / 刷新后自动补写档案，违反 ADR-0025 决策 8

- **位置**：`apps/web/src/main.tsx:212-223`
- **现象**：自动写档案的 effect 触发条件是 `[session, snapshot]` 变化 + `savedWorldsRef` 未命中 + `status ∈ {terminated, archived}` + 有 `ending`。而 `savedWorldsRef`（`:175`）是 `useRef(new Set())`，**每次页面挂载重置**。于是：
  1. 未登录打到结局 → `session=null` ⇒ 不写（这一条是对的）；
  2. 玩家在「档案」页签点登录 → `location.assign(Relay)` → 回跳是**整页重载**（`auth.ts:135` 同 tab 跳转，PKCE verifier 在 sessionStorage）；
  3. 重载后：`bootstrapAuth` 给出非空 `session`，`GET /api/worlds/:id` 给出**已终止**且带 `ending` 的快照；`savedWorldsRef` 为空 ⇒ effect 命中 ⇒ **自动写一次**。
- **与决策的定义差异**：ADR-0025 决策 8 原文「未登录不写、不弹窗、不打断结算，**登录回跳后不自动补写（隐私最小化），由玩家在档案页显式点「把这局存进档案」**」。实现把「结局产生时写」写成了「已终止快照存在即写」，而这两者在「恢复」场景（登录回跳、刷新已终止局、换设备打开旧局）无法区分。
- **同一根因的次要表现**：已登录玩家刷新一个早已终止的旧局，也会再 upsert 一次（数据相同、幂等，但属「恢复即写」而非「产生才写」）。
- **影响面**：不泄漏 hidden 信息（写入内容就是玩家已见的投影，且只进玩家自己的行）；不阻断主链路。但它**在玩家未表达意图时上传数据**，且这条路径恰好是「未登录打完一局的人回来登录」这一最主流的场景 —— 而「把这局存进档案」按钮（`main.tsx:2529-2554`）存在的意义正是承接这个场景。
- **证据等级**：**代码级**（触发条件完全由这两个 state 决定，无隐藏分支）。运行时复现需真实会话（缺口 G-6），不得用假会话代替。
- **建议修法（不改口径）**：把写动作挂到「本次会话内状态跃迁」上，而不是挂到「快照存在」上。任一即可：
  - 在 `wrap()`（`main.tsx:276-318`）拿到 `res.snapshot` 的分支里判断 `status` 由非终止 → 终止时才写（这是「结局产生」的真实时刻）；
  - 或用 `prevStatusRef` 记住上一次 `snapshot.status`，仅在跃迁时写；
  - `archive()`（`:368-392`）里的第二次写保持不变（那是玩家显式动作）。
- **复验方式**：改完后跑 `pnpm typecheck` + 本报告 §四-5 的浏览器探针（结论应为「未登录 0 次、且登录回跳后仍 0 次，直到点『把这局存进档案』才 1 次」），登录回跳的运行时确认仍需公开域（G-1）。

### D-02【P2 · 非阻断 → `docs/BACKLOG.md`】`owner_name` 是 ADR-0025 决策 2 未登记的字段，且从未展示

- **位置**：`records.ts:115 owner_name: ownerName`；调用处 `main.tsx:219`、`:384`、`:2540` 传 `session.user.name ?? null`。
- **事实**：决策 2 的字段清单里没有 `owner_name`；`grep -n "owner_name" docs/DECISIONS.md docs/BACKLOG.md` **零命中**；`RecordCard`（`main.tsx:2428-2468`）也**不渲染**它（注释 `:2426` 明写「不显示 owner_id、不显示邮箱/手机号/token」）。
- **性质**：不是 hidden 泄漏（只是本行归属者的 WorkBuddy 昵称，且 `name` 缺省时写 `null` 而非邮箱）。属**口径偏差 + 无用字段**：要么补进 ADR-0025 决策 2，要么删掉这一列/这一行写入。
- **建议**：登记为新 BACKLOG 条目（P2），二选一裁决；本轮不阻断。

### D-03【P2 · 非阻断 → `docs/BACKLOG.md`】授权被拒时 `error=` 参数不清、且文案误导

- **位置**：`auth.ts:70`（`hasCallback` 认 `error`）、`auth.ts:74-80`（provider 不符分支只清 `code/state/provider`）。
- **现象**（探针场景⑤实测）：URL 为 `?sharecode=KEEP&error=access_denied` 时，`error` 留在地址栏，提示写「授权回调缺少有效的登录方式，请重新登录。」——把「玩家点了拒绝」说成「缺少登录方式」；由于 `error` 未被清理，**每次刷新都会重走该分支并再次弹出同一条提示**。
- **性质**：符合「只清 `code/state/provider`」的字面要求，但落在「授权页拒绝/取消」这条真实路径上时体验与文案都不对；不阻断游戏。
- **建议**：`error`/`error_description` 一并清理（`sharecode` 仍保留），并按 `error` 值给出「授权已取消」类文案。

### D-04【P3 · 非阻断 → `docs/BACKLOG.md`】映射函数在 `try` 之外调用

- **位置**：`records.ts:149 const row = buildLifeRecordRow(...)` 在 `:152 try {` **之前**。
- **性质**：若快照结构异常（`evaluation`/`player` 缺失），会同步抛出；而 `main.tsx:219` 的调用点没有 `try` 包裹（`RecordsTab.saveCurrent` 有）。当前不可达（`V2Snapshot` 类型保证 + 投影始终下发这两个字段，探针 A/C 实测正常），属纵深防御缺口。

### D-05【P3 · 工具侧 · 记入本报告避免复判】`db_describe_table` 的 `RLSOn` 不可信

- 与 `list_tables`/`list_rls`/`pg_class` 三源矛盾，且同响应缺失表注释。**裁定：以 `pg_class.relrowsecurity` 为准（=true）**。建议后续一律用 `list_tables` + `pg_class` 双证据，不再引用 `describe_table.RLSOn`。

### D-06【观察 · 无需处置】库内 `world_name` 可空，前端读取类型为非空 `string`

`describe_table` 显示 `world_name text NULL`，`records.ts:22 world_name: string`。只影响读取侧类型（渲染 `undefined` 会显示空白），无运行时风险。

---

## 七、证据缺口清单（显式声明，不折算成 PASS）

| # | 缺口 | 为什么本地补不上 | 补上需要什么 |
|---|---|---|---|
| G-1 | **真实 WorkBuddy 登录往返**（点击 → Relay → 回跳 → 兑换 → 有会话） | localhost 被 Relay 拒（「当前地址暂不支持此登录方式」）；且本地无 PKCE verifier。**发布已发生**（主理人转述：`2991eb2` 已上线 `https://cursed-wheel-life.app.workbuddy.host/?sharecode=AWEIS4D6KT`，线上 bundle 为 `index-D_SZsDX8.js`）——我本地同一提交的构建产物同名，`sha256(index-D_SZsDX8.js)=57245baf85cb4280fef777ada6e60fcde7f85bc145a3e669c38ebd0b908eac5b`（同名只说明是同一版的**必要条件**，是否逐字节相同需主理人比对） | 由**用户本人**在发布域用真实账号完整走一遍登录往返（我无凭据可用） |
| G-2 | **跨账号 RLS 隔离**（A 账号拿 B 的行 id 删除/更新 ⇒ `[]`） | 需**第二个真实账号**；`exec_sql` 是特权通道，按 ADR-0025 口径 7 **不得**作为 RLS 证据 | 两个真实账号 + 发布域 |
| G-3 | **发布域 Origin 匹配 / endpoint 与实际发布域一致** | 只有发布后才由服务端 Origin 强匹配裁决；本地只能核对字面量与运维记录（`.workbuddy/memory/2026-11-12.md`）一致 | 发布后在浏览器实际请求一次 |
| G-4 | **已登录写读往返 / 同 `world_id` 二次写仍 1 行 / terminated→archived 命中唯一索引** | 需真实会话；表内当前 0 行 | 同 G-1，一次「存 + 刷新 + 归档」即覆盖 |
| G-5 | **表内真实行的红线抽查**（ADR 口径 6 的「任一行」） | 没有真实行（这本身是「未造假行」的好证据） | 同 G-1 后，对真实行跑 §四-3 的 18 串扫描 |
| G-6 | **D-01 的运行时复现** | 需真实会话才能让 `session` 非空；按要求**不造假会话** | 同 G-1；本报告的 D-01 为代码级证明 |
| G-7 | **断网 / 超配额的真实环境表现** | 本地无法自然触发；探针用 SDK 边界注入 | 断网可发布后手动验；配额需触发额度上限（不建议） |

> 声明：以上 7 条**不是**本轮的通过理由，也不是退回复验可以跳过的部分 —— 它们是「本轮无法给出结论」的部分。第 3 条之后的所有 PASS 都不依赖它们（每条 PASS 都有本地可执行的证据）。

---

## 八、探针清单（仓库外临时脚本，可复现）

| 脚本 | 作用 | 关键结论 |
|---|---|---|
| `%TEMP%\drive.mjs` | 驱动本地服务端把一局打到 `terminated`（只在服务端 API 上操作） | 得到真实终止快照（`end-ordinary`，`worldTime=133920`） |
| `%TEMP%\probe.mts` | 对真实终止快照 / running 快照 / **引擎产出的 hidden 结局快照**跑真实 `buildLifeRecordRow` | 17 键行、无 `owner_id`、无 `explanation`、`ending_label="未公开的结局"`（≠模板原文「四度逆行」）、18 串红线 **0 命中** |
| `%TEMP%\probe-auth.mts` | `bootstrapAuth` 真实分支 + 5 个 URL 场景（只替身 `location`/`history`/SDK 兑换） | provider 分派正确、`sharecode` 每次保留、`code/state/provider` 残留 = 0 |
| `%TEMP%\probe-failure.mts` | 在 SDK 边界注入错误码，跑 `records.ts` 的 12 条真实分支 | 七类失败面文案矩阵、42P10 退化、0 行删除判失败、running 不上云 |
| `%TEMP%\probe-browser.mjs` | headless Chrome × 本地服务端（`puppeteer-core` + 本机 Chrome） | ①未登录结算 0 云请求 ②档案页 0 云请求 ③主链路推进正常 ④地址栏只留 `sharecode` |
| `%TEMP%\probe-browser2.mjs` | 同上，`provider=workbuddy` **不做任何 stub** 的真实回调 | 云端失败只出一条可关闭横幅；六页签齐全；点击后主链路继续推进 |

复现前置：`PORT=3199 pnpm --filter @life-sim/server start`（服务端同时托管 `apps/web/dist`，需先 `pnpm --filter @life-sim/web build`）；curl 需 `--noproxy '*'`（本机装有 HTTP 代理）。

---

## 九、结论与下一步

1. **退回**：修 **D-01**（P1）。修法是「把写动作从『快照存在』移到『状态跃迁』」，属一处局部改动，不涉及协议、引擎、服务端。
2. 修完复验范围：`pnpm typecheck`、`pnpm --filter @life-sim/web build`、`465` 全量回归、§四-5 的浏览器零请求探针（须新增「登录回跳后仍 0 次，点按钮才 1 次」）。
3. **D-02 / D-03 / D-04** 请在裁决 `docs/BACKLOG.md` 时登记（P2/P2/P3），本轮不阻断。
4. **G-1 / G-2 / G-3 / G-4 / G-5** 只能在发布域 + 两个真实账号下补齐 —— 这一条**不随 D-01 修完而消失**。发布虽已完成（转述），但「真实登录往返 + 跨账号隔离」必须由**用户本人在发布域**操作后单独补一轮验收，且不得用 `exec_sql` 造证据。
