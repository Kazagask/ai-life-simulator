# 版本缺口恢复 · 合并概要与合并指示

> **性质**：交接文档，**不是规范、不是 ADR、不是验收结论**。权威约束依次是 `AGENTS.md` → `specs/core/` → `docs/DECISIONS.md`；与本文冲突时以它们为准。
> **建立**：2026-11-13 23:40，分支 `recovery/merge-2026-11-13`，基线 `main @ 8e4b4f7`。
> **触发**：主理人本机崩溃，一次编码中断。据其口述，仓库落后约**两个大版本**，ADR 推进到 ~0032，相关工作未进入 git。
> **配套**：旧机侧搬运守则见 `docs/RECOVERY_OLD_MACHINE.md` —— 若在旧机上合并本分支后续代码，先读那份，防止覆盖旧机那几轮迭代。

## 0. 一句话结论

当前仓库只到 **R2.7 / ADR-0027**；缺失版本目前**只存在于主理人口述中**，代码与 ADR 正文都未找回。本分支用于承接找回或重建，**禁止把口述写成已实现、已验证或已裁决共识**。

## 1. 已核验事实（本轮 git / spec 检查，2026-11-13 23:25–23:40）

| 项 | 事实 |
|---|---|
| 本地副本 | 23:23 全新 clone；`reflog` 只有 `clone` 一条；工作区干净、无 stash、无未跟踪文件；无 `node_modules` / `apps/web/dist` / `data/` |
| 远端 | `git ls-remote origin` 仅 `HEAD` + `refs/heads/main`，**无 tag、无其他分支**；`git fetch --prune` 后无新提交；`HEAD = origin/main = 8e4b4f7` |
| 提交 | 共 **167** commits。最后一条 `8e4b4f7`（11-13 12:43）`test(R2.7): 补齐全量回归并产出 R27-FULL-REGRESSION.md (CT-01/CT-02)`，改动 3 文件：`packages/game-core/package.json`（补 `yaml` devDependency）、`pnpm-lock.yaml`、`tasks/reports/R27-FULL-REGRESSION.md` |
| 全量回归 | `R27-FULL-REGRESSION.md` 已存在且 L0–L5 全绿（typecheck 0 错 / shared 67 / game-core 478 / playthrough 6 种子 / narrative 6 PASS / web build / cloud smoke 6 PASS+1 SKIP），CT-01 + CT-02 证据链补齐 |
| ADR | `docs/DECISIONS.md` **止于 ADR-0027**；现存 ADR-0026 标题为「槽模型转正：pendingEvents 串行化守卫」 |
| 活跃迭代 | 仅 `specs/iterations/2026-11-13-ai-narrative/`（R2.7 四件套），**未归档、未宣告按标准流程关闭**（G1 前置门禁本轮免除） |
| 本机记忆 | `.workbuddy/memory/` 不存在（gitignore 的本机私有记忆随崩溃丢失）；`docs/PROJECT_MEMORY.md` 已入库，可作跨会话口径备份 |

### 状态口径滞后（合并时一并更正，别误当成缺失版本的证据）

- `PROJECT.md §2 / §8`、`tasks/CLOUD_TASKS.md`、`specs/iterations/README.md` 仍写「`R27-FULL-REGRESSION.md` 不存在 / 全量回归未出结论 / CT-01、CT-02 为 `todo`」，但 `8e4b4f7` 已产出全绿报告。
- `docs/BACKLOG.md §0` 仍写「AI 叙事层（LLM 接入）**未实现**」，与 R2.7 实绩冲突。
- 以上属文档滞后，**不是代码故障**；合并后统一更正，不要据此推断版本进度。

## 2. 缺失版本概要（主理人口述，未经代码 / 文书核验）

> 来源：2026-11-13 23:39 口述。以下全部为**待找回 / 待核实**内容，不得据此改代码、不得写进验收报告、不得视为已裁决共识。

| # | 口述内容 | 影响面（推测，待核） |
|---|---|---|
| 1 | **否决「前端不填写密钥 / 不接 LLM」方案，因架构限制不得不否决** | 疑似关联 `OPEN_QUESTIONS #49` / ADR-0025（服务端零凭据、登录态只在浏览器 SDK）。需确认是否为正式裁决、落在 A/B/C 哪一条、架构限制原文依据 |
| 2 | **ADR-0026 中彻底落地槽模型、`pendingEvents` 退役、底层重构** | 与现存 ADR-0026「槽模型转正：pendingEvents 串行化守卫」口径不同 ⇒ 疑似 ADR 正文被改写 / 补记。属**契约面 T-2**，须有 ADR 正文，且可能影响 `schemaVersion` 与存档结构 |
| 3 | **转盘后端返回结果后，前端确认才生效** | 改轮次结算 / 投影 / 交互时序；需明确新增确认 API 还是改 `lastWheel` / `pendingEvents` 语义，以及旧存档兼容策略 |
| 4 | **LLM 与前端若干逻辑修复（崩溃前正在做，未完成）** | 范围未知、优先级最高但最不确定；需逐文件比对找回，或从遗留项反推后逐条立案 |

- **ADR 编号**：口述估计推进到 ~**0032**；当前仓库只到 0027 ⇒ 约缺 `ADR-0028..0032` 正文。
- **版本代号**：「两个大版本」的正式版本号 / 迭代目录名未提供。
- 口述与现存代码的**已知冲突**：ADR-0026 标题与「pendingEvents 退役」表述不一致，合并时以找回的代码与 ADR 正文为准，不以本文口述为准。

## 3. 合并指示（按顺序执行）

### 3.0 铁律

- 只在 `recovery/merge-2026-11-13` 分支操作；找回前**不推 main、不 force push、不对干净副本 `reset --hard`**。
- 未找回的代码一律记「缺失 / 待重建」，**绝不伪造实现、测试结论或 ADR**。
- 契约面（`packages/shared/src/schema/**`、effect 类型、`source`/`kind` 语义、投影契约、存档结构）变更必须先有 **ADR + G1/G2**；`ADR-0027` 的「免前置 ADR + 事后补记」是**一次性裁决，不延续**。
- 改 `specs/data/templates/**/*.yaml` ⇒ 模板指纹变化 ⇒ **旧存档全部拒载**，必须写进交付说明（ADR-0007 既定策略）。
- 以**代码**为准；`specs/archive/**` 不构成现行约束；不确定的产品规则写 `docs/OPEN_QUESTIONS.md`，不伪造共识。
- 不为迁就模板在内核加兜底（D-17 教训）；加载期该失败就失败。

### 3.1 找回源（按优先级）

1. **崩溃机原工作目录 / 拆下的磁盘**：查 `git status`、`git stash list`、`git reflog`、未跟踪文件；重点找 `.workbuddy/memory/`（gitignore 的本机私有迭代日志）、`data/worlds/` 存档、旧 working tree 里的 `docs/DECISIONS.md` 与 `specs/iterations/` 新目录。
2. **WorkBuddy 云端项目** `p_b65216f5322d464eb95088a64eaf38fa`：沙箱工作区 / 内置任务记录 / 会话产物（`PROJECT.md §8` 记载主理人无法直接访问内部，需导出或授权）。
3. **GitHub 侧**：本轮 `ls-remote` 只有 `main`、无 tag；再查 fork、PR、Actions artifacts、其他账号下的仓库副本。
4. **编辑器本地历史**（VS Code / JetBrains Local History）、云盘版本历史、系统还原点、回收站。
5. 全部找不到 ⇒ 走 §3.4「按概要重建」，把口述**当需求，不当代码**。

### 3.2 比对（先看，别覆盖）

- 源放到仓库**外**，例如 `D:\code\_recovery_src\`；当前干净副本已在 `main@8e4b4f7`，天然是安全点。
- 源是 git 仓库：`git -C <源> log --oneline -20`、`git -C <源> status`、`git -C <源> diff --stat 8e4b4f7..HEAD`，先拿到「ADR 0028..0032 + 改动文件清单」。
- 源只是文件快照：`git diff --no-index` / `diff -ruN` 逐文件比对，**禁止整目录覆盖**。
- 必须单独确认的清单：
  - `docs/DECISIONS.md`（ADR-0028..~0032 正文；ADR-0026 是否被改写）
  - `packages/shared/src/schema/**`、`packages/game-core/**`（`pendingEvents` 退役 / 槽模型底层重构）
  - `apps/server/**`（转盘结果确认、LLM 逻辑）、`apps/web/**`（前端确认、LLM 相关修复）
  - `specs/data/templates/**/*.yaml`（是否动过 ⇒ 存档代价）、`schemaVersion`
  - `PROJECT.md` / `docs/PROJECT_MEMORY.md` / `tasks/CLOUD_TASKS.md` / `specs/iterations/**` / `tasks/reports/`（状态口径与验收报告）
  - 是否新增迭代目录 `specs/iterations/<YYYY-MM-DD>-<短标签>/`

### 3.3 分轮合并与验证

顺序建议：**文档 / ADR → 契约面（shared schema）→ 实现（game-core / server / web）→ 状态口径**；每轮小步提交、可编译可测。提交信息写清「玩法结构变更」与「模板指纹 / 存档代价」。

新 clone 前置（本机什么都没装）：

```bash
pnpm install
pnpm build                     # 生成 apps/web/dist，否则 / 返回 503 web_dist_missing
```

最小验证集（`AGENTS.md §0.3`）：

```bash
pnpm --filter @life-sim/server start                 # 加载期 fail-fast
pnpm --filter @life-sim/shared test
pnpm --filter @life-sim/game-core exec vitest run --no-file-parallelism \
  src/v2.test.ts src/v2/opening.test.ts src/v2/playthrough.test.ts
```

回归加跑：

```bash
pnpm typecheck
pnpm test
pnpm --filter @life-sim/web build
node apps/server/smoke/cloud.smoke.mjs             # 需先起 server；6 PASS + 1 SKIP + SMOKE OK
```

CI（`.github/workflows/ci.yml`）L0 → L1 → L2 → L2b → L4 → L5 全绿才算门禁过；未跑项显式标注，**不得写成 PASS**。

### 3.4 找不回时的重建顺序（须主理人确认后启动）

1. 先补 `ADR-0028..0032` 的**准确标题与裁决**，尤其第 1 项（#49 是否被否决、架构限制否决的原文依据）；落文后才有实施依据。
2. 一次只做一个明确任务；契约面严格走 ADR → schema → 模板 → 测试 → QA。
3. 第 4 项「崩溃前正在做的 LLM / 前端逻辑修复」优先盘点：从 `OPEN_QUESTIONS #49`、`docs/BACKLOG.md`、R27 报告遗留项与前端现码反推具体缺陷，逐条立案，**不批量猜**。
4. 每轮结束更新 `PROJECT.md` 状态表与 `docs/PROJECT_MEMORY.md`，并同步 §1 列出的滞后口径。

### 3.5 合并回 main 的判定

- ADR 编号连续、无悬空引用；新迭代四件套与验收报告齐全；
- 契约面变更均有 ADR 且 G1/G2 常态门禁生效；
- 模板指纹变化已在交付说明声明旧档全拒载；
- L0–L5 全绿、CI 绿；`PROJECT.md` / `docs/PROJECT_MEMORY.md` / `tasks/CLOUD_TASKS.md` / `docs/BACKLOG.md` / `specs/iterations/` 状态与代码一致；
- 未验证项显式标注，绝不写 PASS。

## 4. 待主理人确认（阻塞项，未确认前不启动重建）

1. 「两个大版本」的正式版本号 / 迭代目录名。
2. `ADR-0028..0032` 各自标题；ADR-0026 是否被重写（现存口径为「槽模型转正：pendingEvents 串行化守卫」）。
3. 找回源位置：崩溃机磁盘是否可读 / 云端项目能否导出工作区。
4. 第 1 项是否构成 `OPEN_QUESTIONS #49` 的正式裁决（A / B / C 中的哪一条），以及架构限制否决的原文依据。
5. 「转盘后端返回结果后前端确认才生效」的契约形态：新增确认 API？改 `lastWheel` / `pendingEvents` 语义？存档是否兼容？
6. 缺失版本是否改过 `specs/data/templates/**/*.yaml`（决定旧存档是否全部拒载）。
7. 第 4 项「LLM 与前端逻辑修复」的具体清单 / 当时正在改的文件。

## 5. 本轮动作留痕

- 分支：`recovery/merge-2026-11-13`（从 `main @ 8e4b4f7` 开出）
- 新增：`docs/RECOVERY_MERGE.md`（本文件）
- 索引：`docs/PROJECT_MEMORY.md §3` 末追加一行指针
- 未改：任何 `packages/**`、`apps/**`、`specs/**` 源码或 yaml ⇒ **模板指纹不变、旧存档不受影响、无玩法结构变更**
