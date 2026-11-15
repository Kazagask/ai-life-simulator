# 通用游戏引擎 + AI 集成设计（从「三国人生模拟器」演化）

> 本文不是空想，是从业界真实实践里"学来的"设计，再映射到本项目的演化路径。
> 研究来源见文末 §8。核心纪律只有一句：**确定性内核是唯一事实源，AI 只是外围的投影与裁判，永远不持有真相。**

---

## 0. 一句话结论

把现在的「三国专属模拟器」演化成**内容无关的通用模拟引擎**：内核只跑一套通用的"事实图 + 规则解释器"，三国/咒术回战/任何世界都是一份**带版本的内容包（mod）**；AI 以**外围 Director（GM）**形态接入——用 function-calling 把玩家自然语言翻译回内核的合法操作、用生成层把状态投影成叙事、用一致性治理层兜住幻觉。**这正好也把"丢失的版本化代码"补成了"内容包版本生态"的根基。**

---

## 1. 从研究中学到了什么（事实层，无编造）

### 1.1 通用引擎架构的共识
- **四层栈（TTRPG/世界模型引擎的成熟范式）**：
  1. *Deterministic Kernel*（真值状态）
  2. *Semantic / Scene Graph*（给复制/渲染用的抽象实体与状态）
  3. *Generative / Rendering Layer*（产出音视频或叙事文本）
  4. *Coherence Layer*（一致性治理，监控前几层不发散）
  - 铁律：**"你可以 hallucinate 美，但不能 hallucinate 玩法"**——渲染/叙事层只是状态的投影函数，绝不可反向改写权威状态。
- **ECS（Entity-Component-System）**：实体=ID、组件=纯数据、系统=处理逻辑。数据导向、缓存友好、可大规模并行，是 Unity DOTS / Bevy / Unreal Mass 的底座。适合"大量异构实体"的模拟（RTS、城市、agent 社会）。
- **数据驱动管线**：生成速率、物理参数、动画混合树都从外部数据文件配置，策划改玩法不重编译——这正是我们 yaml 模板的方向，但要从"三国专属"升到"通用 schema"。
- **固定步长（fixed timestep）**：确定性模拟的跨领域刚需（物理、联机 lockstep、回放）。

### 1.2 AI 集成已经出现的成熟范式
- **Function-calling GM（"You Have Thirteen Hours" / Labyrinth 桌游 GM）**：把叙事生成与**机制**（骰子、状态追踪）分离。LLM 只能调用预定义的原生函数（`roll_dice` / `create_npc` / `add_item` / `use_item`），后端校验后改状态。
  - 关键坑：**"骰子死锁"**——没有独立骰子函数时，纯文本 GM 会和玩家互相等待，游戏卡死。
  - 关键坑：**只开状态函数反而更糟**——没有节奏机制，LLM 会频繁乱改状态；必须机制函数 + 状态函数搭配。
- **LLM Agent 六段式（稳健 AI 游戏 Agent）**：感知 → 结构化世界状态 → 记忆 → 推理 → 工具调用 → **校验**。语言生成是概率的，所以"让引擎权威、模型只检索事实并发出校验过的 tool call"才是正解，也让每个组件可独立测试。
- **Generative Agents（斯坦福 Smallville）**：25 个 agent 在小镇自发组织情人节派对。架构 = *记忆流（带重要性评分）* + *检索（Recency+Importance+Relevance）* + *层级反思（观察→洞见→人格）* + *规划（目标递归拆成日程）*。 emergent 行为（信息扩散）完全非脚本。
- **Voyager（Minecraft 终身学习中枢）**：GPT-4 不是"说话"而是"写代码"——*课程表*（分析状态提下一任务）+ *自我纠错*（报错喂回重写）+ *技能库*（成功程序存向量库，复杂任务检索组合）。**白盒、可零样本迁移**。
- **生产级 NPC 架构（Inworld / Convai / NVIDIA ACE）**：
  - *混合分层*：核心剧情 NPC 用云端大模型（大上下文），背景 NPC 用**设备端 SLM**（如 Nemotron-4B，消费级 GPU 50ms 推理）或脚本+LLM 兜底。
  - *安全栈*：角色级限制 + 运行时过滤 + "删除键"（擦除问题记忆）。
  - *异步 AI 线程*：NPC 的"大脑"脱离渲染循环，思考时播放 filler 对话/"thinking"动画。
  - *延迟/成本*是落地头号难题：云端一轮 300–800ms，10 分钟对话可能烧 $0.5–2。
- **MCP Game Gateway（Rust 引擎 + TS 网关 + LLM Agent）**：天然分层——Rust 引擎管确定性逻辑，网关管工具映射与传输，LLM 管自然语言。双输出（JSON 数据 + 人类可读文本）。

### 1.3 叙事引擎给内容设计的启发
- **Inform 7**：声明式世界模型（`The Foyer is a room.`），**Rulebook 流水线**（Before→Instead→Check→Carry out→After→Report）按特异性排序规则；**Skein** 把每次游玩记成可回归测试的分支树（改完源码重放，差异即回归）。
- **Ink**：分支叙事 + *External Functions*（ink 触发游戏侧函数）+ *Variable Observers*（变量变即回调 UI）+ 状态 JSON 存档。**打印文本是临时的，变量才是状态。**
- **AI Dungeon / Hidden Door / Livo / Voyage**：共同收敛到**有界世界 + World Engine**——追踪人物背景、关系、地点、物品、**长期后果**；玩家下线后世界状态仍可演进（Livo/Voyage）。

---

## 2. 我们的现状 vs 业界（对齐度）

| 维度 | 本项目现状 | 业界最佳实践 | 差距 |
|---|---|---|---|
| 确定性内核 | ✅ `game-core` 纯函数、seed 可注入、LLM 不写权威状态 | 四层栈第 1 层 | 已达标，但**内容专属**（三国概念硬编码在模板语义里） |
| 投影/分层 | ✅ `server` Fastify 投影、`web` PWA | 语义场景图 + 渲染投影 | 已达标 |
| 隐藏信息 | ✅ `known/inferred/unknown/hidden` 分层、不进玩家端 API | Coherence Layer | 已达标 |
| 数据驱动 | ✅ yaml 模板（world/events/...） | 外部数据配置、mod 生态 | **模板是"三国 schema"，不是通用 schema** |
| AI 集成 | ⚠️ 仅 `action-hook` 接自由输入，无 function-calling、无 GM | Function-calling GM + 六段式 + 记忆反思 | **完全缺失** |
| NPC 智能 | ⚠️ 关系边 + 脚本选项 | Generative Agents 记忆/反思/规划 | 缺失 |
| 内容版本 | ❌ 丢失的 A/B 两段（版本加载 + 世界引用模板版本） | 内容包/mod 版本生态 | **丢失，见 §5** |
| 回放/回归 | ⚠️ 有 smoke 脚本，无 Skein 式状态回放 | 确定性回放 + 分支回归测试 | 弱 |
| 离线演进 | ⚠️ R3 时间穿越 seam 预留 | 世界离线演进 | 预留但未实现 |

**结论：三层边界和确定性内核我们已经走对了，真正缺的是"通用化"和"AI 集成"两块。**

---

## 3. 大胆的设计：四层栈 + AI Director

把现有 `game-core` / `server` / `web` 显式重命名为四层，并补上 AI 层：

```
┌──────────────────────────────────────────────────────────────┐
│  L4  Coherence Governor（一致性治理层）                        │
│   · 校验 AI 产出不矛盾权威状态（"门没开就不能说门开了"）          │
│   · 红线性约束：AI 永不写 state，只发 proposal → 治理层裁决       │
├──────────────────────────────────────────────────────────────┤
│  L3  Generative / AI Director（生成层 = GM）                  │
│   · NL→tool-call 解析器（玩家自由输入 → 合法操作）              │
│   · 叙事投影（状态→散文，受 ton/字数/风格约束）                 │
│   · NPC 记忆-反思-规划（Generative Agents 式）                 │
│   · 设备端 SLM 兜底（离线/成本）                               │
├──────────────────────────────────────────────────────────────┤
│  L2  Semantic Scene Graph（语义场景图 / 投影）                │
│   · 把内核状态投影成"玩家可见视图"（含 hidden 过滤）            │
│   · 事件令牌（event tokens）+ 状态 delta 日志（供回放）        │
├──────────────────────────────────────────────────────────────┤
│  L1  Deterministic Kernel（确定性内核 · 唯一事实源）           │
│   · 通用 WorldModel：事实图/关系 + 资源 + 属性（content-agnostic）│
│   · Rule Interpreter：解释内容包里的规则/事件/结局（ECS 式系统） │
│   · 固定步长 tick；RNG/时间/ID 可注入；同 seed+输入→同结果     │
│   · 内容包（ContentPack）= 带版本的 yaml 集合（mod）            │
└──────────────────────────────────────────────────────────────┘
        ↑ 所有箭头：视图是状态的函数，永不反向 ↑
```

**关键转变**：`L1` 不再认识"三国"。它只认识"实体、组件、关系、规则、事件、结局"这些通用原语。三国/咒术回战是 `L1` 上加载的一份 `ContentPack`。

---

## 4. AI 到底怎么集成（六种具体模式，都是学来的）

1. **Function-calling GM（核心，来自 Labyrinth 论文）**
   玩家自由输入 → `L3` 的 LLM 分类器判断命中哪个"影响性动作"（我们的 `events.yaml` 选项 / `action-hook`）→ 发出校验过的 tool call → `L1` 执行 → 返回状态 delta。`L1` 必须有独立的"机制函数"（骰子/判定/状态变更），避免"骰子死锁"。**这把现在的 `action-hook` 从"裸接 LLM"升级成" grounded 裁判"。**

2. **记忆-反思-规划 NPC（来自 Generative Agents）**
   NPC 有记忆流（带重要性评分）、检索（近因+重要+相关）、层级反思、规划。`L1` 仍持有权威关系/属性，NPC 的"想法"是投影；玩家下线后 `L1` 可按 NPC 目标继续 tick（呼应 §5 的离线演进）。

3. **因果图 RAG（来自 CSDN 因果图架构）**
   把 `events.yaml` 的"前置条件→后果"抽成因果图（action_id / 后果 / 激活所需前置）。`L3` 检索当前可用动作喂给分类器，防止泄露未解锁内容。**我们的事件链天然就是 RAG 语料。**

4. **混合 AI 分层（来自 Inworld/ACE）**
   核心剧情/关键 NPC 用云端大模型；背景填充用设备端 SLM 或脚本+LLM 兜底。成本与体验分层。

5. **离线世界演进（来自 Livo/Voyage）**
   世界状态不依赖玩家在线。`L1` 用 seed + 时间推进 NPC 日程、关系漂移；玩家回来读到"你离开后发生了…"。**这正是 R3 时间穿越 seam 该承载的语义**，且必须在 `L1` 确定性内完成（可回放）。

6. **设备端 SLM 兜底（来自 NVIDIA ACE / Nemotron-4B）**
   断网/成本敏感时，本地小模型接管叙事与解析，沿用同一套 tool-call 契约——保证"无云依赖"红线（见 recovery 文档）。

---

## 5. 与"丢失的版本化代码"闭环（为什么它很重要）

之前确认丢失的 A/B 两段（模板按版本加载 + 世界实例化引用模板版本信息），在这个新架构里**不再是补丁，而是内容包生态的命脉**：

- `L1` 加载的是 `ContentPack`，一份 ContentPack = 一个 `version`（semver）+ `formatVersion` + `assetFingerprint` + `loadable`。
- 存档信封存 `templateVersion` + 最小元数据快照；即使内容包目录被改/删，一局也能自描述出处、可回放。
- `meta.extensions` 袋吸收新增字段，避免"改模板→旧档因指纹变化被拒载"。
- **所以补回 A/B 段 = 给通用引擎装上 mod/内容包版本系统**，方向完全一致。

---

## 6. 落地路线（先不急改代码，按 ADR 先行）

| 阶段 | 动作 | 产出 |
|---|---|---|
| P0 | 出 ADR：定 `formatVersion` / `templateVersion` / `extensions` 权威结构（补回 A/B 段） | `adr/00XX-versioned-content-pack.md` |
| P1 | 把 `game-core` 的"三国语义"抽象成通用 WorldModel 原语（实体/组件/关系/规则） | 内核重构，仍过现有单测 |
| P2 | `L3` 先做最小 Function-calling GM：自由输入→命中现有 `action-hook`/选项 | 可端到端试玩 |
| P3 | NPC 记忆-反思-规划（先 1 个高光 NPC 试点） | 验证 Generative Agents 式行为 |
| P4 | 一致性治理层 + Skein 式状态回放回归 | 防 AI 幻觉改状态 |
| P5 | 设备端 SLM 兜底 + 离线演进 | 红线：无云依赖 |

---

## 7. 红线（不可逾越）

- **AI 永不写权威状态**：`L3` 只能发 proposal/tool-call，`L1` 执行、`L4` 裁决。
- **确定性内核不可破**：同 seed+输入必同结果；R3 时间穿越 seam 不写死时间单调。
- **不重新部署/发布覆盖线上残留**：版本化属于约两个大版本的丢失成果，重建前先找回旧机源码核对契约（见 `docs/RECOVERY_MERGE.md`）。
- **hidden 不进玩家端 API**。

---

## 8. 研究来源（学自何处）

- Game Engine Architecture / ECS（id Tech、Bevy、Unity DOTS、ar5 ECS 形式化）
- TTRPG 通用数据模型与规则契约（四层栈 + 投影架构铁律）
- *You Have Thirteen Hours…*（Labyrinth，function-calling GM、骰子死锁）
- LLM Agent 六段式 / 混合 AI（IJSR EM 综述）
- Generative Agents（Stanford Smallville，记忆-反思-规划）
- Voyager（Minecraft 终身学习、技能库）
- Inworld / Convai / NVIDIA ACE（生产级 NPC、设备端 SLM、安全栈）
- MCP Game Gateway（Rust 引擎 + TS 网关 + LLM Agent 分层）
- Inform 7（声明式世界模型、Rulebook、Skein 回归）
- Ink（External Functions、Variable Observers、JSON 存档）
- AI Dungeon / Hidden Door / Livo / Voyage（有界世界 + World Engine、离线演进）
- CSDN 因果图架构（action_id/后果/前置 的 LLM 分类）
