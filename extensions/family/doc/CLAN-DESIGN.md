# 族谱 + 宗族设计（2026-11-17，按用户澄清重写）

> 上游：`docs/EXTENSIONS.md`（接缝）、`specs/SPEC.md` §1.6（扩展层）。
> **用户 2026-11-17 澄清**：「族谱和宗族其实是两个事。族谱只是关系的发散和视图，
> 宗族是一个新的数据模型，比如这个家族的历史、声望、在世成员等（参考 ck）」。
>
> 初版设计把两者合成一件、并要求"宗族成员必须从关系推"，**那是错的**，本文作废重写。

---

## 0. 两件事，先分清

| | **族谱**（pedigree） | **宗族**（clan / house） |
|---|---|---|
| 本质 | 关系图的**发散视图** | **新实体**，有自己的生命周期 |
| 数据 | **零新数据模型**，全部从 `state.relations` 现算 | `state.extensions.family` 里的权威数据 |
| 回答 | "谁跟谁有血缘/婚姻，隔几代" | "这一族是谁、多显赫、谁当家、经过什么事" |
| 会不会变 | 关系边一变它就变（纯派生） | 只被显式 effect 改（声望/家主/入族/除籍/大事记） |
| 存不存档 | **不存** | **存** |
| 类比 | 家谱图 | CK 的 House / Dynasty |

**判据**：删掉整个宗族数据，族谱照样画得出来；删掉关系图，宗族只剩下一个名字和一堆数字。
两者不互相依赖。

---

# 第一部分：族谱（纯派生，零 state）

## 1.1 数据源

只有 `state.relations`（经 `projectVisibleRelations` 收敛到 known/inferred）+ actor 目录。
**不许读宗族成员表**——那会把"归族"和"血缘"搅在一起（见 §3）。

## 1.2 世代 / 配偶 / 环：四条决定

1. **世代号只按血缘**：`father/mother` 归一成 parent→child。**绝不按婚姻**。
   父女婚这种，当事人按血缘在 g3、按婚姻在 g1 —— 取血缘，婚配表现为**跨行弧线**。
   这是该被看见的东西，藏起来等于篡改事实。
2. **配偶边无向**，按 `(from,to)` 无序对去重（模板里常同时写 `wife` 和 `husband`）。
   `spouseOrdinal` 用 `state.relations` 出现序，不用年龄（年龄随时间漂）。
3. **子女挂父母，不挂"夫妻"**：多妻/私生子/前妻之子全靠 parent 边定位。按"夫+妻=一对"推孩子，
   会把前妻之女错挂到继母名下（`valmont` 就是这么写的）。
4. **`relative`（`gap: true`）不进树**，单独放 `looseEnds`（"据称的远亲"），否则凭空造一个世代。

## 1.3 环处理（近亲婚配必踩）

- 归一化：`father/mother` → parent→child；`son/daughter` 原样；`husband/wife` 合成无向；
  `elder/younger-brother/sister` 只在**没有共同父边**时作为 `sibling` 边保留。
- **回边检测**：parent 子图上跑 DFS 三色（现有 `detectCycles` 把配偶也当亲缘边，
  族谱必须另跑一份**只含 parent 边**的）。命中 ⇒ `back: true` + `cyclic: true`，**不参与世代计算**。
- **世代 = 缩点后的最长路**，拓扑序 O(V+E)。**禁止 `while(changed)` fixpoint**——在环上不终止。
- 纯姻亲节点（外来配偶，图里没父母）继承配偶世代，`generationBasis: "marriage"`，否则全挤 g0。

## 1.4 规模上限

`pedigree.maxGenerations`（缺省 4）、`pedigree.maxNodes`（缺省 80）。
截断必须确定性：从 self BFS，按"世代距离 → id 升序"取前 N，**禁按 Map 迭代序截断**（跨引擎不稳）。

## 1.5 投影形状

```ts
export interface PedigreeView {
  rootIds: string[];
  nodes: PedigreeNodeView[];
  edges: PedigreeEdgeView[];
  generationRange: { min: number; max: number };
  incomplete?: boolean;   // 可见节点的父/母被判 hidden ⇒ UI 画 "?"，不编一个根
  truncated?: boolean;
  looseEnds?: Array<{ id: string; name: string; gap: true }>;  // 有边但说不清代数的远亲
}

export interface PedigreeNodeView {
  id; name; isSelf; hasCard;          // hasCard = !hiddenNodeIds.has(id)
  genderLabel; age; lifeStageLabel;
  generation: number;                 // 0 = 始祖；只按血缘
  lifecycle: { state; reasonCode? };
  spouseOrdinal?: number;
  cyclic?: boolean;
}

export interface PedigreeEdgeView {
  from; to;                           // 归一化 parent→child
  kind: "parent" | "spouse" | "sibling";
  parentRole?: "father" | "mother";
  affinal?: boolean; step?: boolean; derived?: boolean; back?: boolean;
}
```

**投影纪律**：裸 id 只作 React key / 跳转键；隐藏/未登场**节点与连带边都不出现**（否则等于告诉
玩家"有这么个人"）；死者照常上屏（ADR-0020 先例）但年龄按 `sinceWorldTime` 冻结。

## 1.6 族谱 UI 契约

| 操作 | 行为 |
|---|---|
| 点 `hasCard` | 打开该 NPC 卡；`isSelf` ⇒ 玩家面板 |
| 点 `!hasCard` | 非模态提示"名字 · 无档案"，不跳转（与 `RelationList` 的 `rel-nocard` 一致） |
| 点宗族抬头 | 切到该族视图（宗族那半，§2） |
| hover 边 | 用适配器翻好的中文，投影只给枚举 |
| 点回边/弧线 | 无操作 |

**为什么必须服务端算**：`adapter.ts:240` 只保留出边，父母对子女是入边、整行被丢
⇒ 前端拿不到"我的孩子是谁"，更别说世代号和环。

---

### 1.7 继亲边（`step`）：暂不给开关（`未决`）

`valmont` 上有 **29 条 step 边**（父/母的其他配偶、且不是自己的父/母），比 spouse 边还多。
但那是**模板本身的属性**——它就是"八类婚配"的压力夹具，多妻剧本下 step 边必然多；
普通剧本里这类边接近 0。

裁决（2026-11-17）：**本轮不加开关**。先按现状上屏，看真实剧本的观感。
理由：新增一个配置面是有成本的（模板要理解、指纹会变、要写用例），不能拿压力夹具的观感当理由。

如果以后确实吵，形状是 `extensions.family.pedigree.showStepParents?: boolean`（缺省 `true`），
改动是"一行 config 读取 + 一个过滤点 + 一条用例（关掉后 step 边为 0、其它边不变）"。

---

# 第二部分：宗族（新实体，进 state）

## 2.1 形状

```ts
// state.extensions.family —— 权威，进存档
export interface ClanFact {
  id: string;                 // 稳定 key（模板声明里必须存在）
  name: string;               // 族名/氏号 —— 从模板初始化，之后可被改（改姓）
  seat?: string;              // 郡望/祖宅
  prestige: number;           // 累计声望（可增可减，钳在模板配置域）
  renown?: number;            // （可选，CK 味）可支配声名，花在族学上
  headId: string | null;      // 家主；null = 空缺/族老摄政
  status: "active" | "extinct" | "exiled";   // 兴衰
  foundedAt: number;          // 世界时间（分钟）
  legacies: string[];         // 已解锁族学/家训（模板声明候选，运行时解锁）
  history: ClanHistoryEntry[];  // append-only 大事记
}

export interface ClanHistoryEntry {
  at: number;                 // 世界时间
  turn: number;
  kind: "founded" | "head_changed" | "prestige" | "member_joined" | "member_left" | "extinct" | "legacy" | "custom";
  text: string;               // 人话（模板文案或 AI 生成，但**只追加，不改史**）
  refs?: string[];            // 涉及的人（actor id）/ 事件 id
}

// 成员：权威表，不是派生
export interface ClanMember {
  actorId: string;            // 玩家或 NPC，一视同仁
  clanId: string;
  since: number;              // 入族的世界时间
  role?: string;              // "家主" / "族老" / "嫡长" …（模板自定义词）
  via: "birth" | "marriage" | "adoption" | "override";  // 怎么进的族
  leftAt?: number;            // 出族时间；null/缺省 = 在族
  leftReason?: string;        // "出继" / "嫁出" / "除籍" / "身故"
}
```

**声望按 CK 的口径分两层**（可选，v1 只做前者）：
- `prestige`：族自己的累计值，只被 `adjustClanPrestige` 改。
- 成员个人声望汇总成族声望的**加成**——这是派生，不进 state（`renown` 若要可消费才进 state）。

## 2.2 成员表为什么是权威的（推翻初版）

初版要求"成员必须从关系推"，理由是防双真相。**这个理由站不住**：

- **有血缘但不在族**：嫁出去的女儿、出继的儿子、被除籍的人。关系图上仍是亲属，族里已经没有他。
- **在族但没有血缘**：义子、家臣、陪房、入赘后随妻族。
- **改姓/入赘后图上完全看不出**归了哪一族。

CK 也是这么做的：`dynasty` 是角色身上的一个事实，不是从家族树反推的。

**所以要防的不是"两个真相"，而是"没有记录的漂移"**：

- 进族/出族**只能**通过 effect（`joinClan` / `leaveClan` / `setClanMembership`），**必须带 reason**，
  并追加一条 `history`。
- 禁止任何"隐式自动入族"（比如"父亲的族就是我的族"由引擎自动补）。族的延续靠事件显式推动，
  不然声望/家主/历史全都会有一半人算不进去。
- 诊断（不进玩家投影，只在开发期/模板校验跑）：列出"在族但无任何亲缘路径"的人（合法，需 `via`
  说明）、"有直系血亲在族但自己不在族"的人（合法，多半是嫁出/出继）。
  **只报告，不纠正**。

## 2.3 从 CK 借什么、不借什么

| 借 | 不借（v1 明确不做） |
|---|---|
| 家族实体 + 累计声望 | 领地/地图/战争 |
| 家主（可空缺，可外姓） | 封建契约、封臣层级 |
| append-only 大事记（婚丧嫁娶、家主更替、兴衰） | 族学科技树的多级前置（只做扁平 legacies 列表） |
| 兴衰三态（active / extinct / exiled） | 联姻外交的博弈算法 |
| 在世成员数作为实力指标 | 名人堂/成就 |

## 2.4 投影形状

```ts
export interface FamilyView {
  selfClanIds: string[];           // 空数组合法：不属于任何宗族
  clans: ClanView[];
  pedigree?: PedigreeView;         // 第一部分；与 clans **互不依赖**
}

export interface ClanView {
  id: string; name: string; seat?: string;
  status: "active" | "extinct" | "exiled";
  prestige: number;
  head?: { id; name; hasCard; isSelf; alive };
  livingCount: number;             // **玩家视角数得出来的**，不是真实总数
  memberCount: number;
  selfRelation: "head" | "member" | "affine" | "outsider";
  selfStanding?: string;           // "第三代 · 二房"（走族谱派生，不是族表）
  legacies?: Array<{ id: string; name: string; unlocked: boolean }>;
  history: Array<{ at: number; formattedAt: string; kind: string; text: string }>;
}
```

- `livingCount` / `memberCount` **只数可见成员**——数真实总数等于告诉玩家"族里还有 3 个你不认识的"。
- 历史文本直接来自 `history[].text`，**不实时调 LLM 复述**（史是事实，不是叙事）。

## 2.5 effect / 条件

```ts
{ type: "foundClan",          clanId, name, seat?, headId? }        // 仅模板/特权事件，**不给 LLM**
{ type: "joinClan",           actorId | "__self__", clanId, via, reason, role? }
{ type: "leaveClan",          actorId | "__self__", reason }        // "出继"/"嫁出"/"除籍"
{ type: "setClanHead",        clanId, actorId | null }
{ type: "adjustClanPrestige", clanId, value }                       // 增量，钳域
{ type: "unlockLegacy",       clanId, legacyId }
{ type: "clanHistory",        clanId, kind, text, refs? }           // 只追加
```

```ts
{ op: "inClan",       args: { clanId, actorId? } }
{ op: "isClanHead",   args: { clanId, actorId? } }
{ op: "clanPrestige", args: { clanId, gte?, lte? } }
{ op: "clanSize",     args: { clanId, gte?, lte? } }
{ op: "clanStatus",   args: { clanId, is: "active" | "extinct" | "exiled" } }
```

**`foundClan` 不给 LLM**：族名是 `lore.md` 级设定锚，LLM 现编会撞设定；且 `generatedCharacters`
没有 `birthTime`，全落 g0 会污染族谱。LLM 只能 `joinClan` / `leaveClan` / `adjustClanPrestige`，
且必须经白名单分支事件（ADR-0038）。

## 2.6 双口径警告（族谱与宗族通用）

同一个派生函数，**条件求值用全图**（藏起来的三叔照样影响家族实力），**投影用可见子图**。
把投影口径喂给条件 = 逻辑错误；把全图口径喂给投影 = 泄露。

---

## 3. 两者冲突时怎么办（这是最重要的一条）

族谱说"他是我弟"，宗族说"他不是本族的人"——**这不是 bug，是事实**。

- **族谱永远不从族表推**，**族表也永远不从族谱推**。各自取各自的数。
- UI 同时显示两个标记：血缘（族谱算）+ 归族（族表算）。冲突时**显示冲突**，不要消解。
  例：某人在族谱上、但标签写"已出族"；某人在族表上、但族谱上没有血缘连线。
- 唯一强制的一致性：**在族但无任何亲缘路径** 必须在 `ClanMember.via` 里有解释
  （`adoption` / `override`），否则视为数据错误（开发期诊断报出，不阻断）。

---

## 4. 风险

1. **隐式自动入族**（新头号风险）：实施时很容易"顺手"让子女自动继承父族。必须挡——
   族里每多一个没记录的人，声望和家主继承就错一次。
2. **玩家不属于任何宗族**：`selfClanIds: []` + `outsider` 是合法态。族谱根退化为最近的可见血亲祖先，
   都没有就单节点树。UI 不画空面板。
3. **成员爆炸/性能**：宗族派生（在世人数、声望加成）必须**一次 BFS 出全部**，禁止逐人调
   `kinshipReadings`，禁止每卡重算。
4. **已死成员**：留在历史与族谱里，不计 `livingCount`；`leaveClan` 的 `reason: "身故"` 与死亡事件
   必须同一个写点，否则两处记两个死法。
5. **DAG/环**：多妻 + 私生子 + 近亲婚配，见 §1.3。
6. **AI 建族/改史**：`foundClan` 与 `clanHistory` 都不给 LLM 自由发挥；历史文本只能由模板事件或
   引擎追加，AI 顶多润色展示。
7. **族名与 lore 冲突**：单一真源 = 模板声明 + `clanHistory`。`buildFacts` 要把 clan 事实下发给 LLM，
   fact ref 用独立前缀 `clan:<id>:*`，别挤已占用的 `flag:`。
8. **声望通胀**：`adjustClanPrestige` 没有钳域就会一步登天。必须有模板配置的上下界与单次上限。

---

## 5. 验收

1. **互不依赖**：删掉 `state.extensions.family` 后，族谱投影**照样完整**（不崩、不缺节点）。
2. **不隐式入族**：一局跑到结局，族表里每一条成员都有对应的 `joinClan` 记录（grep 事件即可验）。
3. **零回归**：模板不声明 `extensions.family` ⇒ `snapshot.family === undefined`，
   jjk-2006 / jjk-shinjuku 逐字段不变。
4. **环不崩**：`valmont`（父女婚 + 兄妹婚 + 隔代婚）投影不崩、不丢边、世代有限且稳定。
5. **冲突可见**：构造一个"在族但无亲缘"的人，族谱与族表同时正确显示，不互相污染。
6. `state` 里 grep `pedigree|generationRange` 零命中（族谱派生不进 state）。

---

## 6. 实施顺序（两段，可独立验收）

| 段 | 内容 | 依赖 |
|---|---|---|
| **A. 族谱** | `snapshotDerivation` 出 `PedigreeView` + `V2Snapshot.family.pedigree` + `PedigreePanel` | 接缝（已派）+ 无 state 改动 |
| **B. 宗族** | `state.extensions.family` 命名空间 + `ClanFact`/`ClanMember`/`clanHistory` + 7 个 effect + 5 个条件 + `ClanView` + 宗族面板 | 段 A 或并行 |

**A 段可以先落**，因为它零 state 改动、零 effect、零条件——只吃关系图。
B 段才需要 `state.extensions` 泛型命名空间与 effect 注册表。

### 1.8 已知局限：血亲记号拼出姻亲词（`未决`，判据已定）

`relationship.js` 是按**记号链**查表的，链里不出现「妻子」时它不会知道中间隐含了一条配偶边。实测：

```
妻子的哥哥          => ["大舅子"]
儿子的妈妈          => ["老婆", "自己"]
儿子的妈妈的哥哥     => ["大舅子", "哥哥"]      ← 取了后者，混进血亲 extras
爸爸的儿子的哥哥     => ["哥哥", "弟弟", "自己"]  ← 纯血亲，不该误判
```

`kinshipReadings` 产出 `儿子的妈妈的哥哥 => 哥哥`，本质是姻亲（妻兄），但路径里没有配偶记号，
现有 `affinal` 判定识别不到，于是它以血亲身份进了 `extras`。
（`valmont` 上表现为 `休 father→奥德里克` 的 extras 里有个 `哥哥`。）

**结构判据（已设计，未实现）**：对路径里每一对相邻记号做二次解析
`relationshipCached(`${a}的${b}`)`；若结果含配偶词（老婆/老公/妻子/丈夫），而这两个记号又不是
声明的配偶边，就说明这一段经过了**共同亲代**、隐含一条配偶边 ⇒ 整条读法按 `affinal` 处理，
交给 `affinalTerm()` 收成正确称谓（上例应收成 `大舅子`）。

为什么它不算启发式：
- 只用「路径形状 + 库自己的组合语义」，确定性、可复现；
- `kinshipReadings` 走简单路径（`used` 禁止回到起点），`儿子的妈妈 ⇒ 老婆` 成立，不会误判成"回到自己"；
- 缓存键是两段记号的字符串，现成的 `RELATION_CACHE` 直接吃，开销可忽略；
- `爸爸的儿子` 解析为 `哥哥/弟弟/自己`，不含配偶词 ⇒ 不误伤真血亲；`外孙女`/`甥外孙女` 的路径里
  没有这种段，也不会被误杀。

**局限**：只覆盖 `child → parent`（下行再上行）这一族形状。其它「血亲记号拼出姻亲词」的形状需要各自判据，
**不能**用"跳数远大于主称谓"通杀——那会把 `外孙女`、`甥外孙女` 一起误杀。

**落地时要同时锁**：`哥哥` 消失 **且** `外孙女`/`甥外孙女` 仍在（`valmont` 用例）。
