# 专家团队分析：通用游戏引擎设计 + AI 集成（含丢失版本化代码收编）

> 召集人：程有章（life-sim-dev-team-lead）｜参与：许清源(需求) / 高见远(架构) / 寇定一(内核) / 严过关(QA) / 叶顺屏(前端)
> 性质：**设计分析，未修改任何代码**。依据 `docs/GENERAL_ENGINE_AND_AI_INTEGRATION.md` 草稿 + 现有代码核对 + 恢复文档契约证据。
> 红线：AI 永不写权威状态 · 确定性内核不可破 · hidden 不进玩家端 API · 找回旧机源码前禁止重新部署覆盖线上。

---

## 0. 团长裁定（摘要）

团队一致认为"四层栈 + AI Director"方向正确，但**对草稿做了三处硬修正**：

1. **内核已通用，别重写**：`game-core` 零专名、只认通用原语，所谓"抽象成 WorldModel"已达标。真正缺的是**显式 ContentPack 版本外壳**。
2. **AI 集成已做一半**：`apps/server/src/{llm,narrative}` 已是 L3 生成层（非权威、fire-and-forget、strict 回退）。缺的是 ① function-calling GM、② NPC 记忆-反思-**投影**、③ L4 一致性治理门禁。
3. **不要 ECS / 不要组件系统新抽象**：文字人生模拟用 EAR（实体-属性-关系）+ 事件解释器 + 事实图足够，ECS 是过度工程。

**最该立刻做的一件事**：P0 出 ADR 把"版本化 ContentPack（`formatVersion`/`version`/`assetFingerprint`/`loadable`/`extensions`）"定下来——这既是补回丢失的 A/B 段，也是通用引擎的 mod 生态根基。**但必须先找回旧机源码核对契约**，且期间不得重新部署。

---

## 1. 各成员核心论断

### 1.1 高见远（架构）—— 对草稿的冷水 + 四层栈精确定位
- L1 确定性内核（`game-core/src/v2/{engine,turn,scheduler,relations,battle}` + `rng.ts` + `time.ts`）= content-agnostic，**已完成**，只认 `WorldTemplateV2` 通用 schema，三国只是数据值。
- L2 语义场景图 = `projection.ts` + `index.ts:decorateSnapshot`，**已落地**（含 hidden 过滤、称谓推导、masked 结局红线），输出 `V2Snapshot` 即 L3 唯一合法输入。
- L3 = `apps/server/src/{llm,narrative}`（**半落地**）+ 待建 `director/`。NPC 记忆-反思-规划**只在投影层**，权威决策仍留 L1 效用引擎（`runNpcActionsV2`）。
- L4 一致性治理层 = **当前缺失**，须新建 = ① strict 输出契约 ② 超时/失败回退模板 ③ "AI 永不写 state" 门禁。
- **AI 决不能是裁判的清单**：权威状态写入、评分、hidden 可见性、结局/终止、骰子/转盘、存档/指纹——全归内核。

### 1.2 寇定一（内核）—— 文件级落地
- 重构 = 新建 `v2/model.ts`（显式命名 Entity/Component 访问器）+ `v2/rules/*.ts`（把 `applyEffectsV2` 250 行 switch 按 `effect.type` 拆成纯函数，**行为不变、测试直接复用**）。**不重写 `WorldStateV2`**。
- AI Director 住 `apps/server/src/ai/`，绝不可进 `game-core`（内核禁 LLM SDK/网络）；只发既有结构化命令（`advanceTurnV2`/`chooseOptionV2`/`battleActionV2`/`useItemV2`），白名单 + Zod 双校验，非法→保守默认。
- NPC 记忆：**事实层纯函数进 `WorldStateV2`（可选 `npcMemory?`）+ 叙事记忆落服务端缓存**（非权威、fire-and-forget），LLM 文本永不回写权威状态。
- 丢失 A/B 的文件落点：`templates.ts` 加 `LoadedTemplate` 包装（不动 yaml、不动已测 schema）、`store.ts` 信封加 `templateVersion`+最小元数据快照、`index.ts` 的 `/api/templates` 与 `POST /api/worlds` 加 `version`。

### 1.3 许清源（需求）—— 内容模型与可验收性
- ContentPack 通用规格：把"目录=模板"升级为"目录=版本"，`pack.yaml` manifest 带 `formatVersion/version/startVersion/assetFingerprint/assetCount/loadable/extensions/modules`。
- 通用内容模块：`coreloop / openings / endings+evaluation / events / npcs(+aiProfile) / enums / skills·items·statuses`，信息分层**提升为全事实必填字段 + 投影强制过滤 + 治理层断言**。
- 8 条 AI 行为 EARS 需求（`R-AI-01..08`）：叙事投影一致性、自由输入→tool-call、NPC 离线自主、治理拒幻觉、SLM 兜底、GM 动态合成、记忆反思触发、客户端零 hidden。
- 生命周期双层：`loadable`(包级闸门) + `ACTIVE/DEFERRED/RETIRED`(元素级)；**ID 不可变、原文不删（RETIRED 留原文+注解）**，指纹覆盖整包含 RETIRED 原文→旧档可重放。
- 追溯矩阵 R→T→测试 已建（`R-VER-*/R-GE-*/R-AI-*/R-SEC-*`），明确 `R-TT-*`(DEFERRED) 与 `R-LC-*`(RETIRED) 不纳入本轮验收。

### 1.4 严过关（QA）—— 验收口径与冲突曝光
- 确定性回归分层：L1 状态层硬红线（mock provider 为 CI 默认基线，零回归）；AI 散文**不进确定性断言**，改用录制/回放 fixture 比结构化输出（title/summary/evidenceIds）。
- **hidden 侧信道是真实缺口**：现有只校验 `evidenceIds` 白名单，**不约束自由散文"说漏嘴"**。须补 H1-H3 词汇黑名单（`containsHiddenToken` 在 `validateNarrativeOutput` 之后加闸门）。
- **暴露关键冲突（必须裁决）**：草稿 §5 主张"extensions 袋吸收新字段，避免改模板→旧档因指纹变被拒载"，与现行 **ADR-0007 / `store.ts:119` 指纹 mismatch 一律拒载** 直接矛盾。两套不可并存，P0 版本化实现无法验收。
- V1 残留扫描脚本需修正：`evaluateLife\|advanceTurn(\|lifecycle` 会误伤 `evaluateLifeV2`/`advanceTurnV2`/`npc.lifecycle`（合法），须改为排除 `.V2` 后缀的精确扫描。
- 新增 AI 层禁用模式 CI 卡点：LLM 直接写 `WorldStateV2`、绕 `validateNarrativeOutput`、hidden 进 request、`Math.random()`/`Date.now()` 进 L1 状态路径。

### 1.5 叶顺屏（前端）—— 投影层改造
- 好消息：`V2Snapshot` 已是内容无关投影（`labels` 下发显示名、`availableActions`/`equipmentSlots` 通用），组件无写死"三国"字段，**基础对**。
- 残留硬点：`BattlePanel` 写死 `s.id==="stun"`、`proficiency` 前缀过滤、`SetupScreen` 写死 `templates[0]` 与 `"jjk-2006"` 兜底——须清除。
- 模板/版本选择器：`GET /api/templates` 扩 `startVersion`+`versions[]`，`POST /api/worlds` 加 `version`；Setup 改模板卡 + 版本下拉 + 开局下拉，`loadable:false` 置灰。
- AI 散文"不像聊天框"：事件卡内嵌 AI 旁白（氛围段）+ NPC 对话气泡流（`snapshot.dialogue`，仅 `inferred/known`），全量瞬态、不进 localStorage、不进人生档案。
- 贯穿红线：`BASE=""` 相对路径、hidden 不渲染/缓存/打日志。

---

## 2. 跨角色共识

| 共识 | 依据 |
|---|---|
| 内核已通用，加版本外壳而非重写 | 高见远 / 寇定一 独立核验 `game-core` 零专名 |
| 不引入 ECS / 组件系统新抽象 | 高见远（过度工程）/ 寇定一（只做命名显式化+拆函数） |
| AI 只发 proposal → 走既有 L1 入口 → L4 裁决 | 高见远 / 寇定一 / 严过关 一致 |
| 丢失 A/B = ContentPack 版本生态根基，须按旧机契约重建 | 许清源 / 寇定一 / 严过关 引用 RECOVERY 契约证据 |
| hidden 在 AI 散文侧未闭环，是上线前硬阻塞 | 严过关 / 叶顺屏 双侧印证 |
| 版本化与现行"指纹全拒"策略冲突必须先裁决 | 严过关 曝光，团长裁定为 P0 卡点 |

---

## 3. 必须裁决 / 清盘的冲突（P0 阻塞项）

1. **【版本迁移策略】** 草稿 §5（宽容迁移：extensions 吸收新字段、指纹变不拒旧档）VS 现行 ADR-0007（`store.ts:119` 指纹 mismatch 一律拒载）。
   → **团长裁定**：此冲突不解决，P0 版本化实现无法验收。方向倾向"**版本 pin 优先于指纹 pin**"：存档 pin `templateVersion`，同 version 即放行（即便同版本 typo 修复致指纹变），version 不一致才拒 `template_version_mismatch`。但这**必须以旧机源码为权威核对**（旧机是版本 pin 还是指纹 pin 决定 `store.ts` reject 逻辑改法）。
2. **【旧机契约真相】** `resolveTemplate` 签名、版本是"多目录"还是"目录内多版本"、openings 是每版本还是模板级、`assetFingerprint` 同 semver 不同指纹的 reload 政策——5 项均须找回旧机源码前核对，不得擅自设计。
3. **【前端选择器阻塞】** 模板/版本选择器改造**阻塞于后端 ADR**（版本字段当前不存在）。

---

## 4. 落地路线（合并 P0/P1）

### P0（先行，契约 + 找回）
1. 🔴 找回旧机源码，核对 A/B 契约（5 项待裁决）与 ADR-0007 迁移策略。
2. 出 ADR G1（ContentPack 版本模型：formatVersion vs version）+ G2（世界绑定模板版本）+ G4（WorldModel 抽象边界，零代码改动）+ G3/G6（Director 契约 + 治理门禁）。编号须与待找回的 ADR-0028..0032 去重对齐。
3. 加 `formatVersion`（纯新增，零风险）；`loadTemplates` 包装为 `LoadedTemplate`；信封注入 `templateVersion`。
4. 补 QA 护栏：`hidden-guard.test.ts`、`versioned-template.test.ts`、`versioned-save-migration.test.ts`、精确 V1 残留扫描、AI 层禁用模式 CI 卡点。

### P1（AI 集成）
5. `apps/server/src/ai/director.ts` 最小 function-calling GM（白名单 + Zod 双校验 → 既有入口）。
6. `game-core/src/v2/npc-projection.ts` 试点 1 个高光 NPC 内心叙事投影（纯只读）。
7. 前端模板/版本选择器 + AI 散文嵌入（事件旁白 / NPC 对话气泡，全瞬态）。
8. （后续 P2）离线演进 `advanceWorldOffline` 复用 L1 管线，承接 R3 时间穿越 seam。

---

## 5. 对草稿 `GENERAL_ENGINE_AND_AI_INTEGRATION.md` 的修订建议
- 删去"把内核抽象成通用 WorldModel"作为待建项，改为"显式命名 + 拆 `applyEffectsV2`"。
- 把"四层栈从零搭"改为"L1/L2 已落地、L3 半落地、L4 缺失"。
- §5 的版本迁移策略必须与 ADR-0007 对齐（见 §3 冲突1），不得继续"宽容迁移"口径。
- 新增 §"hidden 在 AI 散文侧的侧信道防护"小节。

> 本报告为团队设计分析，**未改动任何源码与 Spec**。下一步建议：先派"找回旧机源码核对 A/B 契约"任务（红线内，仅读不覆盖），并起草 P0 的 ADR G1/G2/G4。
