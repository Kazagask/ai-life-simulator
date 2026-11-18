import type { SnapshotActor, SnapshotDerivationContext } from "@life-sim/game-core";
import type { RelationEdge } from "@life-sim/shared";
import { sexFromGenderId } from "./config.js";
import {
  kinGraphFromEdges,
  kinGraphFromPointers,
  type KinAdoption,
  type KinGraph,
  type KinPerson,
  type KinSpouse,
} from "./terms/index.js";

/**
 * 亲属图的**数据源选择**（`extensions/family/doc/FAMILY-GRAPH.md` §1 的两种合规写法）。
 *
 * · 模式二（指针）：角色只写 `fatherId` / `motherId`，婚配/收养在扩展 state；
 * · 模式一（边）：模板自己写 `father` / `wife` / `son` … 边。
 *
 * **两种模式互斥，绝不混用**：混起来必然出现双真源（同一条父子关系同时来自边和指针，
 * 一边改了另一边没改）。判据只看这一次快照的演员目录有没有指针：
 * 至少一人带 `fatherId` / `motherId` ⇒ 指针模式；否则回落边模式（存量模板的行为）。
 *
 * 这里只做「选源 + 归一成 `KinGraph`」，不解释称谓；称谓仍由 `terms/` 纯函数推导。
 */

export type KinSourceMode = "pointers" | "edges";

export interface FamilyKinSource {
  readonly mode: KinSourceMode;
  readonly graph: KinGraph;
}

/** 选源只需要这三样；刻意不接收整个 `SnapshotDerivationContext`（少依赖少串味）。 */
type KinSourceInput = Pick<SnapshotDerivationContext, "actors" | "visibleEdges" | "extensionState">;

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 读 `state.extensions.family.spouses`（`extensions/family/doc/FAMILY-GRAPH.md` §3.2）。
 *
 * **防御式读取，不抛错**：切片可能缺省（旧档 / 模板没写婚配），坏条目逐条跳过。
 * 投影期抛错会让一局崩在渲染上；结构校验是读档 schema 的职责，不是派生期的。
 */
function readSpouses(raw: unknown): KinSpouse[] {
  const list = asRecord(raw)?.spouses;
  if (!Array.isArray(list)) return [];
  const out: KinSpouse[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    const a = asNonEmptyString(rec?.a);
    const b = asNonEmptyString(rec?.b);
    if (a === null || b === null || a === b) continue;
    out.push({ a, b });
  }
  return out;
}

/** 读 `state.extensions.family.adoptions`；口径同 `readSpouses`。 */
function readAdoptions(raw: unknown): KinAdoption[] {
  const list = asRecord(raw)?.adoptions;
  if (!Array.isArray(list)) return [];
  const out: KinAdoption[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    const parent = asNonEmptyString(rec?.parent);
    const child = asNonEmptyString(rec?.child);
    if (parent === null || child === null || parent === child) continue;
    out.push({ parent, child });
  }
  return out;
}

/** 演员 → 指针模型的「人」。性别只按 `config.ts` 的约定映射，未知就是 `null`。 */
function actorsToPeople(actors: ReadonlyMap<string, SnapshotActor>): KinPerson[] {
  const people: KinPerson[] = [];
  for (const actor of actors.values()) {
    people.push({
      id: actor.id,
      sex: sexFromGenderId(actor.genderId),
      ...(actor.birthTime !== undefined ? { birthTime: actor.birthTime } : {}),
      ...(actor.fatherId !== undefined ? { fatherId: actor.fatherId } : {}),
      ...(actor.motherId !== undefined ? { motherId: actor.motherId } : {}),
    });
  }
  return people;
}

/** 判据：该次快照的演员里至少一人带父/母指针。 */
function hasKinPointers(actors: ReadonlyMap<string, SnapshotActor>): boolean {
  for (const actor of actors.values()) {
    if (actor.fatherId !== undefined || actor.motherId !== undefined) return true;
  }
  return false;
}

/**
 * 选源并建图。**只建一张图**，下游（称谓 / 族谱）都吃同一个 `KinGraph`。
 *
 * 指针模式下婚配/收养来自 `ctx.extensionState`（= `state.extensions.family`）；
 * 边模式下仍只看 `ctx.visibleEdges`，不读扩展 state —— 保持 `47cda45` 的零行为变化。
 */
export function familyKinGraph(ctx: KinSourceInput): FamilyKinSource {
  if (hasKinPointers(ctx.actors)) {
    return {
      mode: "pointers",
      graph: kinGraphFromPointers(
        actorsToPeople(ctx.actors),
        readSpouses(ctx.extensionState),
        readAdoptions(ctx.extensionState),
      ),
    };
  }
  return { mode: "edges", graph: kinGraphFromEdges(ctx.visibleEdges) };
}

/**
 * 指针图 → 关系边（**只供族谱消费**）。
 *
 * 族谱（`pedigree.ts`）的输入契约是 `RelationEdge[]`，而指针模式没有边。
 * 与其让族谱再长一条「图 → 世代」的实现（两套算法必然漂移），不如把**同一张图**
 * 投影成边：父母来自 `facts`、婚配来自婚配表。收养不进族谱（边模式也表达不了收养，
 * 族谱本来就不画养亲），兄弟姐妹由共同父母边自然派生，不另写同胞边。
 *
 * 这不是「混用两种模式」：边与指针没有同时读，边是从已经选定的**唯一**图上导出的。
 * 输出按 id 排序，保证与输入 Map 的迭代序无关。
 */
export function kinGraphToRelationEdges(graph: KinGraph): RelationEdge[] {
  const ids = [...graph.nodes].sort();
  const edges: RelationEdge[] = [];

  for (const id of ids) {
    for (const father of graph.facts.fathers.get(id) ?? []) {
      edges.push({ from: id, to: father, kind: "father", source: "template", visibility: "known" });
    }
    for (const mother of graph.facts.mothers.get(id) ?? []) {
      edges.push({ from: id, to: mother, kind: "mother", source: "template", visibility: "known" });
    }
  }

  for (const id of ids) {
    for (const partner of graph.spousesOf(id)) {
      // 无序对只出一次：小 id 端发起。kind 在族谱里只用作「这是一条配偶边」，
      // 建对时取按双方性别能说通的一侧；性别不详也照样出边（婚姻事实与性别无关）。
      if (id >= partner) continue;
      const partnerSex = graph.facts.sexes.get(partner);
      edges.push({
        from: id,
        to: partner,
        kind: partnerSex === "male" ? "husband" : "wife",
        source: "template",
        visibility: "known",
      });
    }
  }

  return edges;
}
