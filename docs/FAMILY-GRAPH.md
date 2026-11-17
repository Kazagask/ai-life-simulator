# 亲缘数据模型：两种合规写法（2026-11-18）

> 用户口径（2026-11-18）：
> 「亲属边本体也能写，但是装了拓展时候 拓展会直接覆盖掉（其实是不合规的）。
> 合规写法：1. 不装拓展 自己维护亲缘关系；2. 装拓展 写生父生母交给拓展计算亲缘关系。」
>
> 本文定的是**数据模型与合规判据**。族谱/宗族怎么显示见 `docs/CLAN-DESIGN.md`，
> 扩展与宿主的边界见 `docs/EXTENSIONS.md`。

---

## 1. 两种模式，互斥

| | **模式一：不装拓展** | **模式二：装拓展** |
|---|---|---|
| 模板怎么写亲缘 | 自己写 `father` / `mother` / `wife` / `son` … 边 | **只写 `fatherId` / `motherId` 指针** |
| 亲缘由谁维护 | 模板作者 | 扩展（建图、推导） |
| 亲属称谓 | **不推导**（引擎不产 `kinshipTerm`） | 扩展推导，投影下发 |
| 族谱 / 宗族视图 | 不出现 | 出现 |
| 典型用途 | 只需要"某人是某人的父亲"来跑条件/事件 | 要称谓、族谱、宗族、继承 |

**同一个模板不许两者都用。** 这就是 `kinship_conflict` 的判据。

---

## 2. 判据：装拓展又写亲属边 ⇒ 加载期拒载

```
world.yaml 声明了 extensions.family
  且 任一 characters.yaml 边 / 事件效果建的边，kind ∈ KinshipKind
⇒ 该版本不可载，封闭码 kinship_conflict
  reason 点名：哪个角色、哪条边（from → to, kind）
```

与 `unknown_extension` 同类：**按版本标不可载、带 reasonCode、不崩进程**。

### 为什么是拒载，而不是"扩展覆盖掉"

当前实现的实际行为不是"覆盖"，是**并存 + 被静默压掉**：

- 模板写了 `father` 边 ⇒ 投影里有一条事实行；
- 扩展又从指针推出一条"爸爸"⇒ `extendRows` 因为 `factCounterpartIds` 里已有这个对手而**丢弃**它；
- 结果：玩家看到的是模板那条，扩展那条无声消失，**没有任何报错**。

覆盖至少是"新赢旧输"，而静默压制是"谁先到谁赢，且没人知道打过架"。
模板作者以为自己在用扩展，实际扩展被架空——这比崩掉更难查。

所以：**冲突必须在加载期炸**，让人当场改。运行期择一是下策。

---

## 3. 数据结构

### 3.1 模式二：指针在 NPC 上

```ts
interface V2Npc / CharacterSchema {
  /** 生父。缺省 = 不详（不编）。 */
  fatherId?: string;
  /** 生母。 */
  motherId?: string;
  /**
   * 血统父（`未决`，CK3 式"真实父亲"）。
   * 与 `fatherId`（名分父）并存时，用来表达私生 / 认领 / 过继。
   * 本轮不实现，字段预留位置写在注释里。
   */
  realFatherId?: string;
}
```

- **指针是唯一真源**。兄弟姐妹、祖孙、叔伯、堂表全部**派生**，不写第二份。
- `fatherId` / `motherId` 指向角色 id，**必须存在**（加载期校验，缺失=`unknown_reference`）。
- 性别不校验（父=男性是常识，但不必强制；模板写错由称谓推导暴露）。
- 玩家也适用（玩家有 `fatherId`，不是特例）。

### 3.2 婚配：归扩展

```ts
// state.extensions.family
interface FamilyState {
  spouses: Array<{ a: string; b: string; since?: number; until?: number }>;
  clans: ClanFact[];      // 见 docs/CLAN-DESIGN.md
  members: ClanMember[];
}
```

- 婚配放扩展而**不留在 core 的边里**：多妻、继室、和离这些语义只有家族关心，
  core 今天没有任何消费者；留在 core 等于 core 又得认识"配偶"。
- `a`/`b` 无向，按 `(min,max)` 归一去重；`until` 表达和离/丧偶（历史要留，不删条目）。
- **多妻顺序 = 数组顺序**，不再需要 `spouseOrdinal`（那个字段已删，理由见 `CLAN-DESIGN §1.5`）。

### 3.3 core 的 `KinshipKind` **保留不动**

模式一需要它。它退出的是**家族扩展的数据源**，不是 core 的类型系统。
`isKinshipKind()` 仍然有用——`kinship_conflict` 的检测就靠它。

---

## 4. 建图与增量

| 时机 | 做什么 |
|---|---|
| **世界初始化** | 从 `characters.yaml` + `opening.yaml` 的指针建一次亲属图（父边 + 婚配边），挂到家族扩展的运行时 |
| **NPC 出生 / 生成** | 追加该节点的父指针与婚配边（`generatedCharacters`、spawn 效果、刷新规则都走同一入口） |
| **NPC 死亡** | **不改图**。死者仍是亲属（ADR-0020 先例：逝去的祖父依旧是祖父），只是称谓/族谱上标已故 |
| **认领 / 过继**（未决） | 改 `fatherId` 并留一条事记；不要悄悄改，否则族谱会"重写历史" |

- **建边策略复用现有上限**：称谓推导仍用 `FamilyConfig.maxHops`（默认 3）；族谱渲染用 `maxGenerations`（默认 4）。
- 图**建一次 + 增量维护**，不要每次投影重建——`valmont` 12 人已经跑过 2s 级耗时，人多会爆。

---

## 5. 长幼：按出生时间算，不再靠边 kind

模式二的边只有父/母，没有 `elder-brother` 这种 kind，所以：

- 兄弟谁大 ⇒ 比 `birthTime`；
- 伯父还是叔父 ⇒ 父亲的兄弟与父亲比 `birthTime`；
- **`birthTime` 缺失（生成角色常见）⇒ 不要编**，退中性词（兄弟 / 父辈），并在这条读法上标 `unknown`。

这比"库凭空给大/小"和"边里编码长幼"都干净：**信息在就在，不在就不猜**。
（`Npc.birthTime` 已有，年龄是由它 + 世界时间现算的。）

---

## 6. 与 `birthStatus`（名分）的关系

另一条在办的改动给 `V2Snapshot.npcs[]` 加了 `birthStatus: legitimate | out-of-wedlock | unacknowledged`，
语义是"父母都在册且有配偶边 / 都可见但无配偶边 / 缺可见父或母之一"。

**它和本模型是同一条线上的两层**，需要对齐：

| 层 | 字段 | 含义 |
|---|---|---|
| 名分 | `fatherId` | 谁认这个孩子（社会/法律上的父） |
| 血统 | `realFatherId`（未决） | 谁生物学上是父 |
| 名分状态 | `birthStatus` | 由前两者 + 婚配表推出 |

- 只有 `fatherId` 时，`birthStatus` 由「`fatherId` 与 `motherId` 之间有没有婚配」推出 —— 这正是现有实现的算法，**兼容**。
- 加了 `realFatherId` 之后，`birthStatus` 要改成「名分父 vs 血统父是否同一人 + 婚配表」，否则同一个词在两套模型下含义不同。

**这两个改动应该一起落**，否则会出现"名分从配偶边推、血统从指针读"的半套。

---

## 7. 迁移清单（三个模板现在都**不合规**）

| 模板 | 现状 | 迁移动作 |
|---|---|---|
| `valmont` | 12 个角色，亲缘全靠 `characters.yaml` 的 `father/mother/wife/husband/son/daughter/elder-sister/…` 边 | 全部改写成 `fatherId` / `motherId` + 一份 `spouses` 列表。**罗莎不写 `motherId`**（前妻之女，图上本就没有母边）——指针模型下这是自然的，不需要额外注释解释"为什么不写" |
| `jjk-2006` | 一条 `relative` + `gap: true` 的远亲边 | 要么迁成指针（远亲无法用指针表达 ⇒ 直接删掉），要么撤掉 `extensions.family` 声明 |
| `jjk-shinjuku` | 伏黑 → 甚尔（敌方、hidden）一条 `father` 边 | 同上。注意：**敌人不实例化**，指针指向一个不存在的实例会踩 `unknown_reference`，所以要么给甚尔建实例、要么撤掉 family 声明 |

迁移后每个模板的**语义指纹都会变**，旧存档拒载——这是预期的，和其他协议变更一样。

---

## 8. 对现有实现的处置

| 现有东西 | 怎么办 |
|---|---|
| `c1c4d91` 同一对父子只出一条边（去重） | **保留**。模式一里模板照样可能同时写 `son` 和 `father` |
| `6e22c35` 直系血亲只并列血亲读法 | **保留**（展示层策略，与数据源无关） |
| `terms.ts` 从 `RelationEdge` 取原子 | **改成从指针 + 婚配表建图**（`KinGraph` 抽象已在办） |
| `detectBackEdges` / 世代计算 | 保留。指针模型下**环仍可能出现**（模板写错父子互指），防御逻辑不能删 |
| `hasCard` 恒真 | 见 `CLAN-DESIGN §1.5`，不受影响 |

---

## 9. 未决

- `realFatherId`（血统 vs 名分）的完整语义：认领流程、`birthStatus` 重算、族谱上怎么画两条父线。
- 婚配的"仪式/法律"区分（CK3 有 concubine）：本轮只有一条 `spouses`，不分等级。
- 模式一是否需要"只写部分亲缘"的宽容（例如只写父边、不写母边）——现在是允许的（缺省=不详），但会让称谓推导出现断层，需在模板规范里写清代价。
- 冲突判据的**粒度**：是"任一亲属边都不许"还是"允许边 + 指针并存但以指针为准"。本稿选前者（全禁），因为并存就是双真相。
