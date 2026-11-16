# R2.8 需求清单 · 登录页用户 key + 平台免密 + 前端收敛（Phase 1 需求侧产出，EARS 草案）

> 唯一新增文件：`tasks/R28-REQUIREMENTS.md`。由「人生模拟器研发团」需求策划师许清源起草，**只定义系统要做什么与验收，不写实现代码**。
> **用途**：给架构师 `ADR-0028` 与后续实现 / QA 消费的需求输入。
> **核对基准**：HEAD `8e4b4f7`（R2.7 全量回归已闭合，「补齐全量回归并产出 `R27-FULL-REGRESSION.md` (CT-01/CT-02)」）。
> **规划声明**：本清单是规划产物，不代表已实现；需求编号、状态、验收条目均为草案，须随 `ADR-0028`（G2 评审）定稿后由架构师并入 `specs/`。
> **边界**：不修改代码；不修改 `specs/iterations/2026-11-13-ai-narrative/requirements.md`（仅列为「待更新」）；不修改 `AGENTS.md` / `docs/**` / `PROJECT.md` / `README.md`；不伪造共识（不确定项写 `OPEN_QUESTIONS` 或显式标 `DEFERRED`）。
> **硬边界（贯穿本清单）**：用户 key / token **不落盘、不进日志、不进玩家端 API 投影、不写仓库**（沿用 `AGENTS §5` 底线与 `docs/CLOUD_DEV.md §7`）；服务端对用户自配 key **不做合法性兜底之外的保护**，风险用户自担。

---

## 1. 需求（EARS 句式：When / The system shall / 验收 / 追溯）

### R-LLM-07 登录页可配置自定义 `apiKey` + `model`（可选 `baseUrl`）

- **The system shall** 允许用户在登录页 / 设置界面配置自定义 LLM 凭证：`apiKey`（必填）、`model`（必填）、`baseUrl`（可选，缺省为 OpenAI 兼容默认端点）；服务端在**进程内存**中持有该凭证，仅用于当前会话 / 进程生命周期，**不写入磁盘、不落持久化存储、不进入日志、不进入玩家端 API 投影、不提交进仓库**。
- **When** 用户提交自定义凭证，**The system shall** 经服务端基础校验（非空、URL 格式合法、字段齐全）后载入内存 provider；校验失败或无凭证时回退到 platform-keyless 或 mock，不崩溃。
- **验收**：
  - **正常路径**：用户在登录页填入合法 `apiKey` + `model`（OpenAI 兼容），可选 `baseUrl`；服务端以进程内存态持有；当次世界叙事经该 OpenAI 兼容 provider 生成，`narrativeSource === "llm"`；`baseUrl` 缺省走 OpenAI 默认端点、覆盖时走用户指定端点。
  - **边界**：进程重启 / 服务端重新加载 ⇒ 内存凭证清空，叙事恢复 platform-keyless → mock（验证「不持久化」）；并发多用户 ⇒ 各自会话绑定各自内存凭证，互不串号（不污染全局 provider）。
  - **无效输入**：`apiKey` 为空 / 仅 `model` 缺 `apiKey` / `baseUrl` 非合法 URL ⇒ 服务端拒绝载入、回退下一优先路由、不崩溃；合法 key 但真实调用返回 401 / 403 / 超时 ⇒ 触发 `R-LLM-04` 回退模板 + 非空 `diagnostic`，不阻塞玩法、不自动穿透到 platform-keyless。
  - **用户自担风险（硬验收）**：服务端**不**做 key 合法性兜底之外的保护（不校验是否足额、是否本人）；key 不落盘（`data/` 与任意持久化存储均不含）、不进日志（error / warn 不含 key 字面量与明文 token）、不进玩家端 API 投影（响应体不含 key）、不写仓库（密钥扫描护栏沿用 R2.7 `boundary.test.ts` 同类，不含 key 字面量）。
- **追溯**：`ADR-0028`（推翻 `AGENTS §5` 第 102 行、新增路由优先级、key 内存记录 + 不落盘 + 风险自担）、`AGENTS §5`、`R2.7` `R-LLM-02` / `R-LLM-06`、`OPEN_QUESTIONS #49`（用户自担风险裁决）。
- **状态**：`ACTIVE`（待 `ADR-0028` 落定细节）。

### R-LLM-08 LLM 路由优先级 `user-key` ＞ `platform-keyless` ＞ `mock`

- **The system shall** 在每次叙事生成时按以下**确定性优先级**选择 provider：① 服务端内存中用户配置的自定义 `apiKey` + `model`（OpenAI 兼容）⇒ ② 平台免密 LLM（platform-keyless，复用 `R2.7` `workbuddyCloud` provider 的 env 注入降级形态）⇒ ③ Mock（模板 / 确定性文本）。
- **When** 用户未配置自定义凭证，**The system shall** 自动回退到 ②；若 ② 亦不可用则回退到 ③。
- **验收**：
  - **正常路径**：配置 user-key ⇒ 优先走 ①；未配置 ⇒ 走 ②；② 不可用 ⇒ ③。三路切换不依赖前端把 key 带入每个请求体（前端只把用户在登录页填的凭证交给服务端内存，凭证不入 `yaml`、不入 `shared` schema）。
  - **边界**：user-key 配置但本次调用失败 ⇒ 仅本次回退模板（`R-LLM-04`），**不自动降级到 ②**（避免凭证错误静默穿透）；下次仍按 ① 优先。
  - **无效输入**：三路全不可用 ⇒ 恒 mock 模板，叙事恒 `template`、不调任何 `complete()`（延续 `R2.7` mock 短路语义）。
  - **硬边界**：路由切换不改变 `R-LLM-03` 确定性边界（LLM 不写状态 / 评分、叙事排除在回放契约外）与 `R-LLM-06` 客户端零凭证硬编码（user-key 仅经内存 / 会话传递，不进 schema 契约、不改 `WorldStateV2` / 不改 `schemaVersion`）。
- **追溯**：`ADR-0028`（路由优先级）、`ADR-0027` 决策 2（三层路由演进）、`R2.7` `R-LLM-02` / `R-LLM-06`、`R2.7` `workbuddyCloud` provider、`AGENTS §1`（服务端边界）。
- **状态**：`ACTIVE`（保持 ACTIVE；路由顺序规则随 user-key 落地即可实现，platform-keyless 退化为 mock 时规则仍成立，不依赖 `#49` 卡点）。

### R-LLM-09 服务端接入平台免密 LLM（platform-keyless 一路）— **`DEFERRED`**

> **状态：`DEFERRED`（依据架构师对齐结论，2026-11-13）**：`R2.7` 的 `workbuddyCloud` 是**降级形态**——依赖运维**手动 env 注入** `LIFE_SIM_WORKBUDDY_SESSION` + `LIFE_SIM_WORKBUDDY_CLOUD_URL`，不属「免密」。主理人裁决要的「平台免密 LLM（cloud-service 的 cloud.llm）」在服务端**无已证实自动链路**：`cloud.llm` 仅以前端 `publishableKey` 客户端形态提供；服务端无 cloud SDK、拿不到浏览器登录态；云端沙箱是否自动注入 server identity 启用该 endpoint 未证实（即 `OPEN_QUESTIONS #49` 卡点，`ADR-0028` 决策 2 ⚠️ 已载明）。**卡点 = 服务端真实免密链路待平台确认（#49 / ADR-0028 决策 2）**。`R2.7` `workbuddyCloud` 降级形态仅作为「需运维 session」的可用路径保留、不声称免密。**本需求不派实现、不计入 DoD；解锁条件 = `ADR-0028` 评审通过 且 平台确认服务端免密链路可行（#49 选 A/B 形态）**。

- **设计意图（不派实现）**：服务端保留并启用平台免密 LLM 一路（在 `R2.7` `workbuddyCloud` 降级形态基础上演进），作为路由优先级 ②，在 ① user-key 未配置时启用。
- **验收（解锁后）**：
  - **正常路径**：未注入 user-key、平台免密链路可用 ⇒ 叙事走 platform-keyless（SSE 聚合 + Zod 校验）；未注入 session ⇒ 抛 `LLMUnavailableError` ⇒ 回退 ③ mock，**绝不假装成功**。
  - **边界**：① ② 并存时严格 ① ＞ ②；② 不可达 / 超时 ⇒ 回退 ③，不阻塞玩法（`R-LLM-04`）。
- **追溯**：`ADR-0028`（决策 2 ⚠️ 载明平台链路未证实）、`ADR-0027` 决策 2 / 6（`workbuddyCloud` 降级形态）、`ADR-0025`（服务端零凭据）、`OPEN_QUESTIONS #49`（真实链路待裁决）。

### FE-01 前端按钮收敛

- **The system shall** 将散落的 AI / LLM 相关前端按钮（如叙事标记、设置开关等）收拢到统一入口（登录页 / 设置页区块），减少分散 UI；不引入新后端契约。
- **验收**：
  - **正常路径**：登录页 / 设置页含统一的 `apiKey` + `model`（+ 可选 `baseUrl`）配置入口，散落的相关按钮收拢至此。
  - **边界**：无配置时 UI 不暴露多余 LLM 开关（除 key 输入外）。
  - **无效输入**：`apiKey` / `model` 留空时保存按钮禁用或显式提示，不向后端发空凭证。
  - **硬边界**：前端**零凭证硬编码**（不把任何 key 写入源码 / 构建产物）；仅把用户在登录页填的凭证经安全通道交给服务端内存，默认不持久化到 `localStorage`（是否允许浏览器记忆由 `ADR-0028` 裁定）。
- **追溯**：`ADR-0028`（前端收敛）、`R2.7` 前端（`AiNarrativeTag` 等）、`AGENTS §5`。
- **状态**：`ACTIVE`。

### FE-02 NPC 记录归并到「世界」视图（分 tab / 可展开）

- **The system shall** 将 NPC 相关记录（面板、关系、生命周期等）归并到「世界」视图，采用分 tab / 可展开结构呈现，替代此前分散或并列的展示；**纯前端布局重组，不向 `V2Snapshot` / `WorldStateV2` / archive 新增任何投影字段**（NPC 历史条目本就 public，见 `OPEN_QUESTIONS #33` 已裁决）。
- **验收**：
  - **正常路径**：世界视图内含 NPC tab，展开可见 npc 列表、关系、生命周期；可展开 / 折叠。
  - **边界**：NPC 数量多时折叠 / 分页 / 虚拟列表不卡顿；关系边数量大时不阻塞首屏。
  - **无效输入**：无 NPC 时 tab 为空态，不报错不崩溃。
  - **硬边界（架构师对齐结论 → 免 ADR / 非 T-2）**：① 任何 `key` / `token` / `session`（含用户 `llmApiKey`）**绝不**进玩家端投影（`AGENTS §5` 第 101 行保留）；② NPC 数据保持既有 `public` 可见性语义，不借机泄露 `hidden`。若后续「分 tab」需新增服务端投影字段（聚合字段 / 新查询参数），那才触发 `T-2` + ADR。
- **追溯**：`ADR-0028`（前端收敛）、`ADR-0019`（关系图前端面板）、`ADR-0022`（NPC 刷新 / 投影）、`OPEN_QUESTIONS #33`（NPC 历史条目 public）。
- **状态**：`ACTIVE`（**免 ADR、非 T-2**；纯前端布局重组，不新增投影契约）。

---

## 2. 追溯矩阵（需求 → ADR-0028 / AGENTS §5 变更 / R2.7 关联 / OPEN_QUESTIONS）

| 需求 | EARS 类 | ADR | AGENTS §5 变更 | R2.7 关联 | OPEN_QUESTIONS | 状态 |
|---|---|---|---|---|---|---|
| `R-LLM-07` | Ubiquitous + Event-driven | `ADR-0028`（推翻 §5 第 102 行、key 内存记录） | 推翻「不得加入外部账号依赖或云端模型强绑定」 | `R-LLM-02` / `R-LLM-06` | `#49`（自担风险） | ACTIVE |
| `R-LLM-08` | State-driven + Event-driven | `ADR-0028`（路由优先级） | 复用 §5 底线 | `R-LLM-02`（三层路由演进） | — | ACTIVE |
| `R-LLM-09` | Ubiquitous | `ADR-0028`（平台免密保留；决策 2 ⚠️ 载明服务端链路未证实） | §5 例外 | `R2.7` `workbuddyCloud` 降级形态 | `#49`（真实链路待平台确认） | **`DEFERRED`**（卡点 #49 / ADR-0028 决策 2） |
| `FE-01` | Ubiquitous | `ADR-0028`（前端收敛） | 前端零凭证硬编码 | `R2.7` `AiNarrativeTag` | — | ACTIVE |
| `FE-02` | State-driven | `ADR-0028`（前端收敛） | — | `ADR-0019` / `ADR-0022` / `OPEN_QUESTIONS #33` | — | ACTIVE（**免 ADR / 非 T-2**） |

---

## 3. 状态口径表

| 项 | 状态 | 说明 |
|---|---|---|
| 本轮新增 `R-LLM-07` / `R-LLM-08` | `ACTIVE` | 用户裁决已定方向；细节（路由优先级、key 内存记录、风险自担措辞）依赖 `ADR-0028` 定稿 |
| 本轮新增 `FE-01` / `FE-02` | `ACTIVE` | 前端收敛；`FE-02` 经架构师确认**免 ADR、非 T-2**（纯前端布局重组，不新增投影字段，两条硬约束见 §1） |
| 本轮新增 `R-LLM-09` | **`DEFERRED`** | 服务端真实免密链路待平台确认 = `#49` 卡点 / `ADR-0028` 决策 2 ⚠️；`R2.7` `workbuddyCloud` 是需运维 session 的降级形态、不属「免密」；卡点解除前不派实现、不计入 DoD |
| `R2.7` 九条 `ACTIVE`（`R-LLM-01..06` / `R-NAR-01..03`） | `ACTIVE` | 实现 = 是；**全量回归已由 CT-01 / CT-02 补齐**（HEAD `8e4b4f7`，`tasks/reports/R27-FULL-REGRESSION.md` 已落地），三列状态「已实现 / 已冒烟验证 / 已全量回归」全部闭合；`requirements.md` 状态说明段仍写「报告不存在」，由架构师 `#3` 更正 |
| 被推翻约束 `AGENTS §5` 第 102 行 | **已裁决推翻** | 原文「不得在未获授权时加入付费服务、外部账号依赖或云端模型强绑定」，及其衍生的「客户端不得直连 LLM / 客户端零 LLM 凭证」边界；本轮允许登录页配置自定义 `apiKey` + `model`（风险自担），新边界由 `ADR-0028` 定稿 |
| `OPEN_QUESTIONS #49` | **维持待决（本轮不落地）** | 用户裁决 #2 的 platform-keyless 复用 `R2.7` env 注入降级形态（C 形态），**不等于解决 #49 真实登录态注入链路**；`#49` 选 A / B 才生产可用，否则维持 C；本轮不移出待决 |
| `DEFERRED` `#26` / `#3` / 事件 flavor 流式 / `R-LLM-09` | `DEFERRED` | `#26`/`#3`/flavor 流式延续上一轮只登记不实现；`R-LLM-09` 为本轮新增（平台免密服务端卡点 `#49` / `ADR-0028` 决策 2），编号与卡点保留、不派实现、不计入 DoD |

---

## 4. 待更新文件清单（本清单是输入，以下由架构师 / 后续执行）

| # | 文件 | 待更新内容 | 负责 |
|---|---|---|---|
| 1 | `specs/iterations/2026-11-13-ai-narrative/requirements.md` | 追加 `R-LLM-07` / `R-LLM-08` 与 `FE-01` / `FE-02`（ACTIVE，建议随 `ADR-0028` 一并入库）；`R-LLM-09` 已标 `DEFERRED`（卡点 `#49` / `ADR-0028` 决策 2），其落地随平台链路确认后另起；更正〔状态说明〕段（全量回归已闭合、`R27-FULL-REGRESSION.md` 已落地） | 架构师 `#3` |
| 2 | `docs/DECISIONS.md` | 已新增 `ADR-0028`（状态「草案 / G2 门禁产物，待评审」）：推翻 `AGENTS §5` 第 102 行、路由优先级 `user-key > platform-keyless > mock`、user-key 内存记录 + 不落盘 + 风险自担；须 G2 评审通过 | 架构师（已落盘，待 G2） |
| 3 | `AGENTS.md` §5 | 将第 102 行改为允许登录页配置（风险自担）或加注例外，措辞由 `ADR-0028` 裁定 | 架构师 / 主理人 |
| 4 | `docs/OPEN_QUESTIONS.md` `#49` | 本轮不落地；若后续用户在 A / B / C 中选 A / B，则移出待决并落裁决；否则维持 | 用户 / 主理人 |
| 5 | `PROJECT.md` 状态表 | 新增本轮迭代状态（R2.8 起草 / 待 `ADR-0028`） | 主理人 |

---

## 5. 与架构侧对齐说明（协作，已收敛）

- **ADR-0028 已落盘**（`docs/DECISIONS.md`，追加于 ADR-0027 之后）：状态「草案 / G2 门禁产物，待评审」，尚未经 G2 评审；本清单追溯统一指向它正确。
- **R-LLM-09 已按架构判定降 `DEFERRED`**：`R2.7` `workbuddyCloud` 是需运维 session 的降级形态、不属「免密」；服务端真实免密链路（cloud.llm）待平台确认 = `#49` 卡点 / `ADR-0028` 决策 2 ⚠️。卡点解除前不派实现、不计入 DoD。
- **R-LLM-08 保持 `ACTIVE`**（路由顺序规则随 user-key 落地即可实现，platform-keyless 退化为 mock 时规则仍成立，不依赖 `#49` 卡点）。
- **FE-02 确认免 ADR、非 T-2**（纯前端布局重组，不新增投影字段）；已补两条硬约束到 §1 验收：key / token / session 绝不进玩家端投影、NPC 保持 public 不泄露 hidden。
- `#49` 维持「待决」更保守（与 ADR 不冲突），以主理人最终裁决为准；本清单不伪造裁决。
- 不修改任何现有规格 / 文档 / 代码；`tasks/R28-REQUIREMENTS.md` 为唯一新增文件，未 git add / commit。
