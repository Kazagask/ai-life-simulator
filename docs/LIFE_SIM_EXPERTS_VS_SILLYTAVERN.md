# 人生模拟器研发团 × SillyTavern：游戏内容与架构设计对比借鉴

> 目的：把项目内专家团「人生模拟器研发团（`D:/code/ai-life-simulator/.workbuddy/experts/life-sim-dev-team/`）」
> 三位成员——程有章（团长）、许清源（游戏内容/需求）、高见远（架构设计）——所编码的实践，
> 与 SillyTavern 的成熟范式对照，找出**可借鉴、能补上之前丢失的两段代码**的改进点。
>
> 来源文件：
> - `experts/life-sim-dev-team/agents/life-sim-dev-team-lead.md`（程有章）
> - `experts/life-sim-dev-team/agents/life-sim-requirements.md`（许清源）
> - `experts/life-sim-dev-team/agents/life-sim-architect.md`（高见远）
> - `experts/life-sim-dev-team/skills/lifesim-spec-coding/SKILL.md`（六道门禁）
> - `skills/life-sim-iteration/SKILL.md`（迭代 SOP）
> - SillyTavern：`spec_version` 显式版本字段、`character_book`/World Info、`extensions` 扩展袋、`TavernCardValidator` 按版本校验。

---

## 1. 三位专家各自覆盖的维度

| 角色 | 游戏内容贡献 | 架构设计贡献 |
|---|---|---|
| **程有章（团长）** | 把一句话诉求拆成「需求→设计→实现→验收」四件套；门禁 G1–G6 统一把关 | 建立团队、调度成员、消息中转；强制"成员结论为准、不得代写"；W1–W4 预设工作流 |
| **许清源（需求/游戏内容）** | **EARS 五类句式**表述规则；`ACTIVE/DEFERRED/RETIRED` 状态口径；**核心循环、开局/结局/评价、事件链、NPC 目标、信息分层**作为产品规格；追溯矩阵 R→T→测试 | 识别"已定规则 vs 待决项"，把猜测与事实分开；越界问题只登记不碰代码 |
| **高见远（架构）** | 终止标记落点、事件实例标识、可见性投影、协议修订范围（内容相关的数据结构） | **三层边界** `game-core`/`server`/`web`；**ADR 先行**；确定性内核（纯函数、seed 可重现、时间/随机/ID 可注入）；`hidden` 不入玩家端；R3 时间穿越三个 seam 不写死时间单调 |

---

## 2. 游戏内容方面

### 2.1 团队已有的游戏内容纪律（许清源）
- **规则即可测需求**：用 EARS（Ubiquitous / Event-driven / Unwanted / State-driven / Optional）把"事件触发、条件分支、结局解锁"写成可验收句，而非散落在 YAML 的注释。
- **内容版本状态机**：`ACTIVE`（实现中）/ `DEFERRED`（整组延期、保留原文与编号）/ `RETIRED`（已废弃、编号不重排）。这让"游戏内容迭代"可审计、可回滚。
- **内容结构规格化**：核心循环、开局/结局/评价、事件链、NPC 目标、信息分层（`known / inferred / unknown / hidden`）都被要求写成产品规格，而不是凭感觉堆事件。
- **追溯矩阵**：每条需求 → 任务 `T*` → 测试证据，保证"加了一段剧情就有一处验收"。

### 2.2 与 SillyTavern 的游戏内容对比
| 维度 | 本团队（许清源口径） | SillyTavern | 借鉴点 |
|---|---|---|---|
| 内容载体 | 模板 YAML（事件/角色/结局） | 角色卡 JSON + `character_book`（lorebook） | ST 把"世界设定"独立成可复用、可条件激活的 lorebook，比单文件 YAML 更易分模块维护 |
| 内容激活 | 事件由 `source`/`kind`/条件/权重/概率触发 | lorebook 按关键词/递归/深度激活注入上下文 | ST 的"条件激活 + 递归"可直接增强本项目的事件链/NPC 信息分层 |
| 内容版本 | `DEFERRED/RETIRED` 状态 + 编号不重排 | `spec_version`（v1→v3）格式版本 | ST 用**文件格式版本**做向前/向后兼容，本团队只在"需求状态"层做版本，缺"内容格式版本" |

### 2.3 可借鉴的改进
1. **事件/NPC 信息分层用"lorebook 式条件激活"表达**：把 `known/inferred/unknown/hidden` 做成可递归、可按关键词/进度激活的注入规则，而不是写死在事件 `visibleWhen` 里。
2. **给模板内容加 `formatVersion`**：许清源的"需求状态版本"管的是"做没做"，缺"内容格式版本"管"怎么解析"。这正好补上之前丢失的**版本化模板加载**那段代码（见 §4）。

---

## 3. 架构设计方面

### 3.1 团队已有的架构纪律（高见远）
- **三层边界**：`packages/game-core`（纯函数、不依赖 React/Fastify/DB/LLM）/ `apps/server`（Fastify 编排+持久化+投影）/ `apps/web`（竖屏 PWA）。世界观规则只进模板，通用引擎世界观无关。
- **ADR 先行（G2）**：核心数据模型 / 技术栈 / 目录结构 / **协议面**（schema 字段与枚举、effect 类型、`source`/`kind` 语义、投影契约、存档结构）变更必须先落 ADR。例外：仅改 `specs/data/templates/**/*.yaml` 的模板变更免 ADR（demo 期）。
- **确定性内核**：同初始状态+同输入+同 seed ⇒ 同结果；时间/随机/ID 可注入；LLM 只叙事与候选生成，**不得写入权威状态或决定评分**。
- **信息分层与投影**：`hidden` 不得进入玩家端 API；可见性投影在 server 层做。
- **前向兼容 seam**：R3 时间穿越的三个接口预留点（事件实例标识、`TimeAdapter`、可见性投影）**不得写死时间单调假设**。

### 3.2 与 SillyTavern 的架构对比
| 维度 | 本团队（高见远口径） | SillyTavern | 借鉴点 |
|---|---|---|---|
| 协议/格式版本 | ADR 管"是否变更"，模板变更免 ADR | `spec_version` 在文件里显式声明，加载器按版本分派解析器 | ST 把"版本"下沉到**数据文件自身**，加载器自动路由；本团队版本在文档层，加载器无感知 |
| 世界数据引用 | `hidden` 不入 API；规则只进模板 | `character_book` 被世界实例**按引用绑定**（角色卡/会话各自挂一份 lorebook） | ST 的世界实例持有"指向模板世界数据的引用+元数据"，而非仅一串哈希——补上丢失的**世界实例化引用模板版本信息**那段 |
| 向前兼容 | `DEFERRED/RETIRED` 状态 + ADR | `extensions` 任意 JSON 字段存附加数据 | ST 用 `extensions` 袋吸收新增字段，避免"加字段就升 schema、旧档全拒载" |
| 校验 | Zod 边界校验、残留符号扫描 | `TavernCardValidator` 按 V1/V2/V3 顺序校验、精确报缺字段 | ST 的"按版本报缺字段"对找回旧档/灰度很有用 |

### 3.3 可借鉴的改进
1. **加载器按 `formatVersion` 分派解析器**（学 ST `spec_version`）：`loadTemplate` 读取 meta 里的 `formatVersion`，路由到对应 parser；旧模板不升级也能加载。
2. **世界存档信封存"模板版本 + 最小元数据快照"**（学 ST world info 引用）：在现有 `templateFingerprint` 之外，再存 `templateVersion`（semver，如 `"1.0.0"`）+ `name/startYear/openings` 快照，一局自描述、模板目录被改/删也能还原出处。
3. **`meta` 留 `extensions?: Record<string, unknown>` 袋**（学 ST）：新增字段走 extensions，不升 schema，缓解"改模板→旧档因指纹变化拒载"。
4. **按版本报缺字段的 validator**（学 ST `TavernCardValidator`）：报错带"该字段自哪版起要求"，对灰度与旧档找回直接有用。

---

## 4. 落到"之前丢失的两段代码"

之前在 `docs/RECOVERY_OLD_MACHINE.md §4.1` 记录、本地（R2.7）已确认**不存在**的两段旧机代码：

- **A. 模板按版本加载**：`/api/templates` 应返回带 `startVersion` / `versions[]` / `assetFingerprint` / `loadable` 的结构。
- **B. 世界实例化引用模板版本信息**：存档信封除 `templateId`+`fingerprint` 外，应存可读的模板版本号。

对照上面的借鉴点，重建路线清晰：

| 丢失代码 | 对应借鉴 | 落地动作 |
|---|---|---|
| A 模板按版本加载 | ST `spec_version` + 高见远"加载器无感知版本"痛点 | 给 `meta` 加 `formatVersion`；`loadTemplates()` 据其分派 parser；`GET /api/templates` 返回 `versions[]` |
| B 世界引用模板信息 | ST world info 引用 + 高见远"可见性投影/自描述" | 存档信封加 `templateVersion` + 最小元数据快照；`CreateWorldInputV2` 接受 `version` |

> ⚠️ **红线（来自 `docs/RECOVERY_MERGE.md`）**：这两段属"约两个大版本"丢失成果，重建前**必须先找回旧机源码核对契约形态**，不能照本地 R2.7 想当然；**不能重新发布/部署**覆盖线上可能残留的旧沙箱源码。

---

## 5. 结论：本团队实践已高度对齐 ST 范式，缺口只在"数据文件自我声明版本"

- 游戏内容：许清源的 EARS + 状态口径 + 追溯矩阵，比 ST 的"角色卡+world book"在**可测性与可追溯**上更强；弱在"内容格式版本"与"条件激活式 lorebook"。
- 架构设计：高见远的三层边界/ADR/确定性/信息分层/穿越 seam，与 ST 的"格式版本化 + 世界引用 + extensions 袋"思路一致；弱在"版本声明下沉到数据文件本身"。
- **最值得马上借鉴的三件事**：① `formatVersion` 让加载器按版本路由；② 世界实例存 `templateVersion`+元数据快照；③ `extensions` 袋吸收新增字段避免旧档拒载。三者合力，正好把丢失的 A/B 两段补回，且不破坏现有门禁（G2/G5）。

---

*生成于 2026-11-15，作为「人生模拟器研发团」三位成员实践与 SillyTavern 的对比借鉴笔记；纯分析文档，未改动 `packages/` `apps/` `specs/`。*
