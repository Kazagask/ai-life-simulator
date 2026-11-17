# 宗族系统 + 族谱 UI 设计（2026-11-17）

> 上游：`docs/EXTENSIONS.md`（接缝契约）、`specs/SPEC.md` §1.6（扩展层）。
> 本文是**实施规格**，不是承诺——未实现的部分以 `docs/EXTENSIONS.md` 的验收线为准。

---

## 0. 先修正 4 个被文档写错的既有事实

| 文档原话 | 代码实际（已核） |
|---|---|
| 21 种 effect | **27 种**（`packages/shared/src/schema/common.ts`，27 个 `z.literal`） |
| `applyEffectsV2` 有封闭 dispatch | **没有 `default` 分支**，switch 停在 `engine.ts:323` 起的 `case "log"` ⇒ **未知 effect 静默 no-op** |
| 开放形条件处处可用 | `ConditionSchema` 是**闭合 10 种**（`common.ts:181`）；只有 `TaskConditionSchema = union([ConditionSchema, OpenConditionSchema])` 含开放形。**事件的 `conditions` / `visibleWhen` / `missWhen` 用的是闭合那个**（`schema/event.ts`） ⇒ 扩展 `op` 今天只能在 `rules.yaml` 触发器里用 |
| 前端能自己拼族谱 | **不能**。`packages/rpg-ui/src/adapter.ts:240` 只保留 `direction === "out"`，父母对子女是**入边**，整行被丢 ⇒ 子女卡上看不到父母 |

前两条是**必须修的缺陷**，不是设计选择：schema 放行了却没注册 handler，效果会凭空消失。

---

## 1. 派生 vs 声明：整份设计的地基

> **图能回答"谁与谁有血缘/婚姻"；图不能回答"谁被算作这一族的人"——后者是礼法与权力的裁决。**

| 可派生（从 `RelationEdge` 推） | 必须声明（推不出来） |
|---|---|
| 本族成员身份（血亲下降） | **族名/氏号**（同姓≠同族；入赘改姓在图上看不出） |
| 姻亲身份，单列不并谱 | **始祖/入谱起点**（图里没有"谁先立族") |
| 世代号、父母、子女、同胞 | **家主**（权力事实，不是"最年长者") |
| 房/支（= 始祖的哪个儿子是你祖先，纯图论） | **门第初始值**及每次调整 |
| 在世人数、玩家辈分 | **郡望/族产**；**出继/入赘/除籍**（override） |
| 姻亲称谓（已有 `kinshipTerm`） | **联姻时配偶归哪一族**（policy + override） |

### 1.1 三个结构

```ts
// 声明域（模板不可变）
interface ClanDecl {
  id: string;                 // 稳定 key
  name: string;
  lineageRoots: string[];     // 始祖/入谱起点 —— 派生的种子，**不是成员表**
  descent?: "patrilineal" | "bilateral";               // 缺省 patrilineal
  spouseJoins?: "none" | "wifeJoinsHusband" | "any";   // 缺省 none
  seat?: string;
  branchLabels?: string[];
}

// 实例域（state，可变）
interface ClanFact { id: string; prestige: number; headId: string | null; }
```

**成员不在任何一张表里**，是一个纯函数 `clanMembership(state, actorId) → { clanId, via } | null`。
判定顺序（首命中即止，确定性）：`override` → `descent`（`lineageRoots` 向子代 BFS）→
`marriage`（`spouseJoins` 打开且本方无血亲族）。`bilateral` 下一个人可有两个族。

**overrides 不是第二份成员表，是例外记录**：只记与推导结果**不同**的人，`clanId: null` = 除籍。
硬门槛：**删光 overrides，成员集合必须能从 `relations` 完整重建**（快照比对）。

**禁止给 `V2Npc` 加 `clanId`** —— 那是变相成员表：父边后来补上时它不更新（双真相），
且玩家没有 NPC 实例就无处可写。

---

## 2. 数据放哪

原则：**state 只存"决策"与"可变事实"；派生内容一律不进 state**（否则读档与图不一致，回放会漂）。

| 项 | 放哪 | 进存档 |
|---|---|---|
| `ClanDecl`（name/roots/policy/seat） | `world.yaml` → `extensions.family.clans`（v1；不新开 `clans.yaml`） | 否 |
| `ClanFact`（prestige/headId） | `state.extensions.family.clans[]` | **要** |
| 成员例外 overrides | `state.extensions.family.overrides[]` | **要** |
| 成员集合 / 族谱节点边 / 世代号 | **纯派生（投影期）** | **否** |

### 2.1 state 用泛型命名空间（关键接缝决定）

```ts
// WorldStateV2 追加，可选 ⇒ 旧档直载，不升 schemaVersion
extensions?: Record<string, unknown>;   // 键 = 扩展 id；core 只做字节级 round-trip，不解释
```

core 若写 `clans?: ClanFact[]`，就等于 core 认识"宗族"，第二个扩展又要改一次 core —— 正是
SPEC §1.6 要拆掉的东西。代价：`z.unknown()` 不校验结构 ⇒ 每个扩展必须导出 `stateSchema`，
读档时校验 `state.extensions[id]`，失败即拒载（与模板 fail-fast 同级）。

**投影侧相反**：`V2Snapshot.family` 必须有类型（UI 要吃）。
一句话：**state 是输入，可以不透明；projection 是输出，必须契约化。**

不塞 `flags`：装不下数组、引擎内部记录不得写 flags、模板一句 `setFlag` 就能覆盖门第。

---

## 3. `ExtensionRuntime` 要补到 6 个成员

`docs/EXTENSIONS.md` §2 只给了 `relationDerivation`。宗族还需要三样它给不了的东西：
**每快照一次的派生**、**effect handler**、**建世界初始化**。

```ts
export interface ExtensionRuntime {
  readonly id: string;
  readonly version: string;              // 进语义指纹
  readonly relationDerivation?: RelationDerivation;   // ① 已有：逐行/逐卡加字段
  readonly snapshotDerivation?: SnapshotDerivation;   // ② 每快照一次（族谱只能走这里）
  readonly effects?: readonly { schema: ZodTypeAny; apply(state, raw, ctx): void }[];  // ③
  readonly conditions?: Record<string, ConditionEvalFn>;                              // ④
  readonly onWorldCreated?: (state, config, template) => void;                        // ⑤
  readonly stateSchema?: ZodTypeAny;                                                  // ⑥
}

export interface SnapshotDerivationContext {
  selfId: string;                          // 走 selfIdOf()，不许字面量 "player"
  visibleEdges: readonly RelationEdge[];   // 与内核同一份 known/inferred 口径
  hiddenNodeIds: ReadonlySet<string>;
  actors: ReadonlyMap<string, { id; name; visible; alive; age }>;
  worldTime: number; turnIndex: number;
  extensionState: unknown;                 // = state.extensions[id]
  config: unknown;                         // = world.yaml 的 extensions.family
  memo: Map<string, unknown>;              // 生命周期 = 一次快照
}
```

纪律：`snapshotDerivation` **每快照一次**，禁止每卡调用；返回值**只能加段**，撞内核键抛错；
扩展**拿不到原始 state**，只拿净化过的上下文。

---

## 4. 三个 effect + 四个条件

```ts
{ type: "setClanMembership", actorId: string /* "__self__" 可用 */, clanId: string | null, reason?: string }
{ type: "setClanHead",       clanId: string, actorId: string | null }   // null = 家主空缺/族老摄政
{ type: "adjustClanPrestige", clanId: string, value: number }           // 增量，钳在模板配置域
```

**不拆 `joinClan` / `leaveClan`**：要能表达出继/除籍，一个 `setClanMembership` 用 `null` 表达离开，
一个写入口胜过两个。语义：只 append override，**绝不改 relations**；未知 `clanId` 抛可诊断错误；
`setClanHead` 不校验是否成员（外姓家主是合法剧情，派生侧报 `headIsMember: false` 给模板作者，不 throw）。

```ts
{ op: "inClan",       args: { clanId, actorId? } }
{ op: "isClanHead",   args: { clanId, actorId? } }
{ op: "clanPrestige", args: { clanId, gte?, lte? } }
{ op: "clanSize",     args: { clanId, gte?, lte? } }   // 在世成员数，**全图口径**
```

**事件条件的阻塞已裁**：把 `EventV2.conditions / visibleWhen / missWhen` 放宽到
`TaskConditionSchema`，并由加载器扫全模板的 `op`，**未注册即拒载**（保住 fail-fast）。
不走 flag 桥——那是第三份真相。

**`applyEffectsV2` 必须补 `default`**：未知 type 若没有注册 handler ⇒ 抛 `unknown_effect`，
或启动期断言"每个并入 schema 的 type 都有 handler"。否则就是静默失效。

---

## 5. 投影形状

```ts
// V2Snapshot 追加，可选 ⇒ 未声明扩展时 undefined（零回归门槛）
export interface FamilyView {
  selfClanIds: string[];                    // 空数组合法：不属于任何宗族
  clans: ClanView[];
  pedigree?: PedigreeView;
}

export interface ClanView {
  id: string; name: string; seat?: string;
  head?: { id; name; hasCard: boolean; isSelf: boolean; alive: boolean };
  memberCount: number;                      // 玩家视角**数得出来**的，不是真实总数
  livingCount: number;
  prestige: number;
  selfRelation: "head" | "member" | "affine" | "outsider";
  selfStanding?: string;                    // "第三代 · 二房"
}

export interface PedigreeView {
  clanId?: string; rootIds: string[];
  nodes: PedigreeNodeView[]; edges: PedigreeEdgeView[];
  generationRange: { min: number; max: number };
  incomplete?: boolean;                     // 有可见节点的父母被判 hidden ⇒ UI 画 "?"
  truncated?: boolean;
}

export interface PedigreeNodeView {
  id; name; isSelf; hasCard;                // hasCard = !hiddenNodeIds.has(id)
  genderLabel; age; lifeStageLabel;
  generation: number;                       // 0 = 始祖；**只按血缘，不按婚姻**
  lifecycle: { state; reasonCode? };
  clanId?; role?: "head";
  spouseOrdinal?: number;                   // 多妻排序：按 state.relations 出现序，稳定不回跳
  cyclic?: boolean;                         // 落在回边上，UI 画虚线弧
}

export interface PedigreeEdgeView {
  from; to;                                 // 归一化为 parent→child
  kind: "parent" | "spouse" | "sibling";
  parentRole?: "father" | "mother";
  affinal?: boolean; step?: boolean; derived?: boolean; back?: boolean;
}
```

投影纪律自查：
- **裸 id 只作 React key / 跳转键**；所有"人话"来自 `actorName()` 或模板。
- 隐藏/未登场**节点不出现，连带边也不出现**（否则等于告诉玩家"有这么个人"）；父母隐藏则
  `pedigree.incomplete = true`。
- `memberCount` **只数可见成员**——数真实总数是侧信道。
- 死者照常上屏（ADR-0020 先例），但**不计入 `livingCount`**，年龄按 `sinceWorldTime` 冻结。

### 5.1 双口径警告（最容易犯的错）

同一个派生函数，**条件求值用全图**（藏起来的三叔照样影响家族实力），**投影用可见子图**。
把投影口径喂给条件 = 逻辑错误；把全图口径喂给投影 = 泄露。

---

## 6. 世代 / 配偶 / 环：三条决定

1. **世代号只按血缘**（`father/mother` 归一成 parent→child），**绝不按婚姻**。
   父女婚这种，当事人按血缘在 g3、按婚姻在 g1 —— 取血缘，于是婚配表现为**跨行弧线**。
   这正是该被看见的东西。
2. **配偶边无向**，按 `(from,to)` 无序对去重（模板里常同时写 `wife` 和 `husband` 两条）。
   `spouseOrdinal` 用 `state.relations` 出现序，不靠年龄（年龄会随时间漂）。
3. **子女挂父母，不挂"夫妻"**：多妻/私生子/前妻之子全靠 parent 边定位。按"夫+妻=一对"推孩子
   会把前妻之女错挂到继母名下。

**环处理**：`relative`（`gap: true`）不进树，单独放 `looseEnds`；parent 子图上跑 DFS 三色检测回边
（注意现有 `detectCycles` 把配偶也当亲缘边，族谱必须另跑一份**只含 parent 边**的）；
**世代 = 缩点后的最长路**，按拓扑序 O(V+E)，**不用 `while(changed)` fixpoint**（在环上不终止）。
纯姻亲节点继承配偶世代。

**规模上限**：`pedigree.maxGenerations`（缺省 4）、`pedigree.maxNodes`（缺省 80）。
截断必须确定性：从 self BFS，按"世代距离 → id 升序"取前 N，禁按 Map 迭代序截断。

---

## 7. 族谱 UI 契约（不设计像素）

| 操作 | 行为 |
|---|---|
| 点 `hasCard === true` | 打开该 NPC 卡；`isSelf` ⇒ 玩家面板 |
| 点 `hasCard === false` | 非模态提示"名字 · 无档案"，**不跳转** |
| 点已故节点 | 照常开卡（`lifeText` 已有） |
| 点宗族抬头 | 切到该族视图并高亮 self |
| hover 边 | 用适配器翻好的中文（`RELATION_KIND_LABEL` 先例），投影只给枚举 |
| 点回边/弧线 | 无操作 |

现有组件的缺口：`NpcCard` / `RelationList` 是**单卡视角**，没有世代号、没有宗族归属、
没有多妻排序、死亡只有翻译后的 `lifeText` 没有机器可读的 `lifecycle.state`。所以族谱必须是
服务端产物。

---

## 8. 风险清单（按翻车概率）

1. **双真相回归**（最大）：实施时极容易"顺手"给 `V2Npc` 加 `clanId` 或加 `clan.members[]`。
   守卫：删 overrides 能从 relations 重建；`extensions/family` 里 grep 不到 `members`。
2. **玩家不属于任何宗族**：派生绝不能以玩家为根。`selfClanIds: []` + `outsider` 是合法态；
   族谱根退化为最近的可见血亲祖先，都没有就单节点树。UI 不画空面板。
3. **成员爆炸/性能**：`kinshipReadings` 已是已知热点。宗族派生必须**一次 BFS 出全部信息**，
   禁止逐人调 `kinshipReadings`，禁止每卡重算（那是 `decorate` 的活）。
4. **已死成员**：留在树里、不计 `livingCount`、年龄冻结。踩坑表现：门第每回合漂、"人丁兴旺"永真。
5. **DAG/环**：多妻 + 私生子 + 近亲婚配。见 §6。
6. **AI 生成事件建宗族**：v1 **禁止** `createClan`。族名是 `lore.md` 级设定锚；且
   `generatedCharacters` 没有 `birthTime` ⇒ 全落 g0 污染整棵树。LLM 只能 `setClanMembership` /
   `adjustClanPrestige`，且必须经白名单分支事件（ADR-0038）。
7. **族名与 lore 冲突**：单一真源 = 模板声明。`buildFacts`（`api/perspective.ts`）要把 clan 事实
   下发给 LLM，否则它会自己编。fact ref 用独立前缀 `clan:<id>:name`，别挤已占用的 `flag:`。
8. **静默失效**：见 §0 第二条。

---

## 9. 验收（钉死）

1. 不声明 `extensions.family` ⇒ `snapshot.family === undefined`，jjk-2006 / jjk-shinjuku **逐字段零回归**。
2. 删光 overrides，成员集合与族谱节点可从 `state.relations` 完整重建。
3. `valmont`（父女婚 + 兄妹婚 + 隔代婚）投影不崩、不丢边、世代有限且稳定。
4. `state` 类型里 grep `pedigree|generation|memberCount` **零命中**（派生不进 state）。
