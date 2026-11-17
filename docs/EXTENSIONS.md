# 扩展层契约（extensions/*）

> 2026-11-17 定。上游裁决见 `specs/SPEC.md` §1.6、`docs/REFACTOR-NOTES.md` §12。
> 第一份实现：`extensions/family`（家族）。**关系系统留在内核**，家族只是对这张图的**解释**。

---

## 1. 一句话边界

| 谁 | 拥有什么 | 不许做什么 |
|---|---|---|
| **core** | 关系**事实**：`RelationEdge` / `state.relations[]` / 图算法 / 可见性收敛 / 投影装配 | 不认识"称谓""族谱""宗族"这些词 |
| **extension** | 对事实图的**解释**：称谓、血缘系数、族谱、宗族 | 不改事实、不改可见性、不给别人起名字 |

判据：**把扩展全部卸载，内核照样跑完整一局，只是少了几列展示字段。** 做不到这一点就是接缝漏了。

---

## 2. 运行时契约（`packages/game-core/src/v2/extensions.ts`，core 侧）

```ts
/** 宿主装进来的一份扩展实现。id 与模板 `extensions:` 的键对齐。 */
export interface ExtensionRuntime {
  readonly id: string;
  readonly relationDerivation?: RelationDerivation;
}

/** 给**一条事实行**加字段（逐行调用）。 */
export interface RelationRowContext {
  viewerId: string;                    // 这张卡是谁的（npc id / player id）
  edge: RelationEdge;                  // 这一行自己那条边——不是整张图的最短路
  outgoing: boolean;                   // 边是否从 viewer 出发
  visibleEdges: readonly RelationEdge[]; // 全部 known/inferred 边（与内核同一份口径）
  config: unknown;                     // 模板给本扩展的配置，扩展自己校验
  /** 内核为**这一张卡**新建的空 Map，`decorate` 与 `extendRows` 共用同一个。
   *  多跳路径枚举的记忆化放这里——不要放模块级缓存（会跨卡串味）。 */
  memo: Map<string, unknown>;
}

/** 给**一张卡**补推导行（每卡调用一次，不是每行）。 */
export interface RelationCardContext {
  viewerId: string;
  visibleEdges: readonly RelationEdge[];
  factCounterpartIds: ReadonlySet<string>; // 已有事实行覆盖到的对手，补行要跳过
  hiddenNodeIds: ReadonlySet<string>;      // 内核判定不可上屏的节点
  config: unknown;
  memo: Map<string, unknown>;              // 同上，与本次每行 decorate 共用一个
}

export interface RelationDerivation {
  /** 返回要并进这一行的额外字段；`null` = 不加。 */
  decorate?(ctx: RelationRowContext): Record<string, string | number | boolean | string[]> | null;
  /** 返回要追加的推导行（没有直接边、但推得出来的关系）。 */
  extendRows?(ctx: RelationCardContext): RelationRowDraft[];
}

/** 推导行草稿。**只有这几个字段扩展能定**，其余由内核填。 */
export interface RelationRowDraft {
  withId: string;
  kind?: string;                       // 缺省 "relative"
  visibility?: "known" | "inferred";   // 缺省 "known"
  fields?: Record<string, string | number | boolean | string[]>;
}

// 注册表（启动期装，运行期只读）
export function registerExtensionRuntime(rt: ExtensionRuntime): void;
export function resetExtensionRuntimes(): void;   // 仅供测试
```

### 内核必须守住的 5 条

1. **不改事实**：`decorate` 返回的键若与内核字段同名（`withId` / `kind` / `visibility` /
   `direction` / `counterpartVisible` / `withName` / `value`）⇒ **抛错**，不静默忽略。
   扩展只能**加列**，不能**改列**。
2. **不能起名字**：推导行的 `withName` / `counterpartVisible` 一律由内核从 actor 目录解析，
   扩展拿不到这个能力——否则隐藏角色可以被扩展"说出来"。
3. **不能越过可见性**：推导行的 `withId` 若落在 `factCounterpartIds` 或 `hiddenNodeIds` 里 ⇒ 内核丢弃。
   扩展只负责"谁跟谁有关系"，**能不能显示由内核说了算**。
4. **未声明即不跑**：模板没在 `extensions:` 里写这个 id，`projectSnapshotV2` **一次都不调用**它。
   ⇒ 卸载全部扩展时，投影与今天**逐字段一致**（零回归门槛）。
5. **只许启动期注册**：`registerExtensionRuntime` 在 `apps/server` bootstrap 调一次。
   运行期不再改——这是"放弃热加载"的落点，也让投影保持确定。
6. **不许静默吞掉未知 effect**：`applyEffectsV2` 的 `switch` 今天**没有 `default`**（`engine.ts:323`），
   未知 `type` 是 no-op。在允许扩展注册 effect 之前，必须先补 `unknown_effect` 抛错，
   或启动期断言"并入 schema 的每个 type 都有 handler"。否则"schema 放行了、handler 忘了注册"
   会表现为效果凭空消失——最难查的一类 bug。

### 一条性能约束（来自真实翻车）

`extendRows` **每卡一次**，`decorate` **每行一次**。多跳路径枚举必须由扩展自己按
`(viewerId, withId)` 记忆化——十二人家族下不缓存足以把请求拖死，旧实现就是这么踩的。

---

## 3. 模板声明

`world.yaml` 新增一个顶层键（`WorldTemplateV2Schema` 是 `.strict()`，不写进 schema 会被拒）：

```yaml
extensions:
  family:                     # 键 = 扩展 id；出现即启用
    showAllRoles: true        # 值由该扩展自己的 schema 校验
    maxHops: 3
  # urban: true             # 值写 true = 用默认配置
```

- **值**：`true`（默认配置）或一个对象（交给扩展的 schema）。
- **加载期**：任一 id 在已注册 runtime 里找不到 ⇒ **该版本不可载**，封闭码 `unknown_extension`，
  `/api/templates` 与建局 409 都带 `reasonCode`。这就是"模板写了 extension 但没包，直接拒载"。
  **按版本拒载、不拖垮进程**：只让声明它的那一个版本不可载，别的模板照玩——
  崩溃式 fail-fast 会让别人的存档一起陪葬。全部模板都不可载时才会命中既有的 `no_templates_found`。
- **版本**：`extensions` 只按 **id** 校验，**没有版本区间**。`ExtensionRuntime.version` 字段目前
  不被读取 —— 加版本约束是 `未决`（要它就得先定"版本不满足时是拒载还是降级"）。
- **语义指纹**：`extensions` 整段（含 `config`）进指纹 —— 因为它在 `world.yaml` 里、整文件参与哈希。
  `config` 确实会改投影内容（如 `maxHops`），所以"整段进"是对的，不用再区分。
- 模板不声明 ⇒ 扩展不生效，哪怕包就装在那儿。

---

## 4. 家族包（`extensions/family`）

```
extensions/family/
  package.json          依赖 relationship.js（从 game-core 挪过来）、@life-sim/game-core
  tsconfig.json
  src/index.ts          export const familyExtension: ExtensionRuntime
  src/terms.ts          称谓推导：KINSHIP_TOKEN / SPOUSE_OF / AFFINAL_TERMS / STEP_TERMS /
                        kinshipTerm / kinshipReadings / SELF_TITLE / composeVisibility
  src/coefficient.ts    血缘系数 kinshipCoefficient / inbreedingCoefficient / pedigreeOf
  src/graph.ts          reachableKinshipNodeIds / isKinshipReachable
  src/types/relationship-js.d.ts   （从 game-core 挪过来）
  test/                 原来那四个 *.min.test.ts 搬过来并改成新路径
```

### 从 core 搬走什么

| 搬 | 留 |
|---|---|
| `KINSHIP_TOKEN` / `SPOUSE_OF` / `AFFINAL_TERMS` / `STEP_TERMS` / `SIBLING_*` / `PARENT_TERMS` / `CHILD_TERMS` / `SPOUSE_TERMS` | `RelationEdge` 类型、`PLAYER_NODE_ID`、`isKinshipKind`（只是对 shared 枚举的集合判断） |
| `kinshipTerm` / `kinshipReadings` / `SELF_TITLE` / `COARSE_KINDSHIP_TITLE` / `composeVisibility` / `KinshipTerm` / `KinshipReading` | `buildRelationGraph` / `addEdge` / `removeEdge` / `queryEdge` / `relationsOf` / `shortestPath` / `ancestorGaps` / `detectCycles` / `freezeOnDeath` / `projectVisibleRelations` |
| `kinshipCoefficient` / `inbreedingCoefficient` / `pedigreeOf` / `parentSetOf` / `halfSibling*` / `affinalTerm` / `isDirectParent` | `packages/game-core` 对 `relationship.js` 的依赖（挪走即删） |
| `reachableKinshipNodeIds` / `isKinshipReachable` | |
| `projection.ts` 里那 90 行 kinship 块（含 `pickExtras` / 缓存） | 投影的装配骨架、隐藏节点集合、actor 目录 |

**`meta.kinship` 从 `world.yaml` 删除**，配置改由 `extensions.family` 承载。

---

## 5. 验收（缺一不可）

1. **零回归门槛**：`jjk-shinjuku` / `jjk-2006` 不声明 `extensions` 时，投影里没有 `kinshipTerm`；
   声明后与今天**逐字段一致**（拿今天的输出做基线快照比对）。
2. **拒载门槛**：`world.yaml` 写 `extensions: { nope: true }` ⇒ 模板不可载，错误码 `unknown_extension`。
3. **卸载门槛**：`resetExtensionRuntimes()` 后跑完整一局不崩。
4. **搬测试**：原四个 `*.min.test.ts`（亲缘系数 / 多读法 / 自环守卫 / valmont）在新位置全绿。
5. **守卫测试**：`packages/game-core/src` 里 grep 不到 `relationship.js`；`extensions/` 里没有
   反向 import 到 `apps/*`。

---

## 6. 开放形与校验分工（2026-11-17，实测补记）

模板能写扩展定义的 effect / condition，但**开放形只出现在解析模板的 8 个边界**：
事件选项 / 转盘段 / 战斗结算 / `actions` / `npcActions` / 物品 `use` / 开局两块 / 分支节点。
**`Effect` 这个类型保持闭合（27 种）**——`applyEffectsV2` 的 switch 靠它做类型收窄。

三层分工，缺一层就会出现"能载入但静默失效"：

| 层 | 负责 | 不认识时 |
|---|---|---|
| schema（`TemplateEffectSchema`） | 只保证「有 `type` 字段」，内核 type 仍走闭合校验 | 放行（当开放形） |
| 跨引用校验（`isCoreEffect` 守卫） | 只校验内核效果的字段引用（`spawnNpc.ref`、`adjustRelation.with`…） | **跳过**，不是静默通过 |
| 加载期词表扫描（`assertOpenVocabularyDeclared`） | `type` / `op` 必须有实现：内核白名单 ∪ 模板**已声明**扩展 | `unknown_effect_type` / `unknown_condition_op`（软码：只标该版本不可载） |

两条踩过的坑，都值得记住：

1. **开放形的 `catchall` 会吞掉任何带 `type` 的对象**，所以 `TemplateEffectSchema` 必须有一条
   superRefine 复核「内核 type 走闭合校验」；否则内核效果漏字段也能过。
2. **条件放宽 schema 还不够**：`checkAllConditions` 必须认得 `{op,args}` 并接到与 `rules.yaml`
   触发器**同一张注册表**。只放宽 schema 的后果是"载入成功、条件永远 false"——最难查的那类。

**未决**：

- 扩展效果的**字段级**校验（如 `joinClan.clanId` 必须指向已声明的 clan）需要扩展导出字段级钩子，
  现在只校验 type/op 有没有实现，不校验参数指向。
- 战斗内使用物品时，`use` 里的扩展效果会抛 `item_effect_unsupported_in_battle`（战斗域没有
  扩展效果结算通道，不静默跳过）。
- `rules.yaml` 的开放形 op **不进**加载期扫描：它本来就走注册表 + 运行期诊断，再立一套判据
  就是两个法官。
