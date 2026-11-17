import type { KinshipKind, RelationEdge } from "@life-sim/shared";
import {
  kinshipFacts,
  moveRole,
  type KinMove,
  type KinshipFacts,
  type Sex,
} from "./signature.js";

/**
 * 亲缘图（`KinGraph`）——称谓推导的**唯一输入**。
 *
 * 两种合规数据源（`docs/FAMILY-GRAPH.md` §1）都归一到这一个形状：
 * - 模式一（不装拓展）：模板自己写 `father` / `wife` / `son` … 边 ⇒ `fromEdges`；
 * - 模式二（装拓展）：角色只写 `fatherId` / `motherId` 指针，婚配/收养在扩展 state
 *   ⇒ `fromPointers`。
 *
 * 图里只有三种东西：**父母指针**（血亲第一层）、**婚配**（第二层）、**收养**（第三层）。
 * 长幼靠 `birthTime`，不靠边 kind —— 边 kind 只在模式一里作为 birthTime 缺失时的兜底。
 *
 * 纯数据结构，无 IO、无随机、无 `Date`。
 */

export interface KinPerson {
  readonly id: string;
  readonly sex?: Sex | null;
  readonly birthTime?: number | null;
  /** **大众认知的生父**。缺省 = 不详。一切推导按这个算。 */
  readonly fatherId?: string | null;
  readonly motherId?: string | null;
  /**
   * **血缘上的生父**（CK3 式，私生子系统专用）。
   * 与 `fatherId` 的区别是**认知 vs 事实**，不是「名分 vs 血统」。
   *
   * 本轮**即使写了也不参与任何推导** —— 保留字段只为让调用方不必剥掉它。
   */
  readonly realFatherId?: string | null;
}

export interface KinSpouse {
  readonly a: string;
  readonly b: string;
}

/** `parent` 是养父母，`child` 是被收养者。 */
export interface KinAdoption {
  readonly parent: string;
  readonly child: string;
}

export interface KinParent {
  readonly parent: string;
  readonly role: "father" | "mother";
}

export interface KinChild {
  readonly child: string;
  /** 亲代角色；模式一只有 `son`/`daughter` 边时无法判断父还是母 ⇒ null。 */
  readonly role: "father" | "mother" | null;
}

export interface KinGraph {
  readonly nodes: ReadonlySet<string>;
  readonly facts: KinshipFacts;
  readonly moves: ReadonlyMap<string, readonly KinMove[]>;
  parentsOf(id: string): readonly KinParent[];
  childrenOf(id: string): readonly KinChild[];
  spousesOf(id: string): readonly string[];
  adoptionsOf(id: string): readonly KinAdoption[];
}

/** 某一跳是否属于亲缘图（`relative` 也进来：它只是不可命名，不是社会边）。 */
export function isMoveKind(kind: string): boolean {
  return kind === "relative" || moveRole(kind as KinMove["kind"]) !== null;
}

/** 节点当前可走的全部移动（保持输入顺序，保证确定性）。 */
export function movesOf(graph: KinGraph, id: string): readonly KinMove[] {
  return graph.moves.get(id) ?? [];
}

function pushMove(map: Map<string, KinMove[]>, move: KinMove): void {
  const key = `${move.from}\u0000${move.to}\u0000${move.kind}`;
  const list = map.get(move.from);
  if (list !== undefined) {
    if (list.some((m) => `${m.from}\u0000${m.to}\u0000${m.kind}` === key)) return;
    list.push(move);
  } else {
    map.set(move.from, [move]);
  }
}

function freeze(moves: Map<string, KinMove[]>): ReadonlyMap<string, readonly KinMove[]> {
  return moves;
}

/** 模式一：模板自己写的亲属边 → 图。 */
export function kinGraphFromEdges(edges: readonly RelationEdge[]): KinGraph {
  const facts = kinshipFacts(edges);
  const moves = new Map<string, KinMove[]>();
  for (const e of edges) {
    if (!isMoveKind(e.kind)) continue;
    pushMove(moves, {
      kind: e.kind as KinshipKind,
      from: e.from,
      to: e.to,
      visibility: e.visibility,
      gapped: e.gap === true,
    });
  }
  const frozen = freeze(moves);
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
  }

  return {
    nodes,
    facts,
    moves: frozen,
    parentsOf(id) {
      const out: KinParent[] = [];
      for (const f of facts.fathers.get(id) ?? []) out.push({ parent: f, role: "father" });
      for (const m of facts.mothers.get(id) ?? []) out.push({ parent: m, role: "mother" });
      return out;
    },
    childrenOf(id) {
      const out: KinChild[] = [];
      for (const c of facts.children.get(id) ?? []) {
        if (facts.fathers.get(c)?.has(id) === true) out.push({ child: c, role: "father" });
        else if (facts.mothers.get(c)?.has(id) === true) out.push({ child: c, role: "mother" });
        else out.push({ child: c, role: null });
      }
      return out;
    },
    spousesOf(id) {
      return [...(facts.spouses.get(id) ?? [])];
    },
    adoptionsOf(id) {
      const out: KinAdoption[] = [];
      for (const p of facts.adoptiveParents.get(id) ?? []) out.push({ parent: p, child: id });
      for (const c of facts.adoptees.get(id) ?? []) out.push({ parent: id, child: c });
      return out;
    },
  };
}

/**
 * 模式二：`fatherId` / `motherId` 指针 + 婚配表 + 收养表 → 图。
 *
 * 指针是唯一真源：子女、同胞、祖孙、叔伯、堂表全部派生，不写第二份。
 * `fatherId` 是**大众认知的生父**；`realFatherId` 本轮不参与推导。
 */
export function kinGraphFromPointers(
  people: readonly KinPerson[],
  spouses: readonly KinSpouse[] = [],
  adoptions: readonly KinAdoption[] = [],
): KinGraph {
  const fathers = new Map<string, Set<string>>();
  const mothers = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const spouseMap = new Map<string, Set<string>>();
  const adoptiveParents = new Map<string, Set<string>>();
  const adoptees = new Map<string, Set<string>>();
  const sexes = new Map<string, Sex>();
  const births = new Map<string, number>();
  const byId = new Map<string, KinPerson>();

  const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
    const set = map.get(key);
    if (set) set.add(value);
    else map.set(key, new Set([value]));
  };

  for (const p of people) {
    byId.set(p.id, p);
    if (p.sex !== undefined && p.sex !== null) sexes.set(p.id, p.sex);
    if (p.birthTime !== undefined && p.birthTime !== null) births.set(p.id, p.birthTime);
  }
  for (const p of people) {
    if (p.fatherId !== undefined && p.fatherId !== null) {
      add(fathers, p.id, p.fatherId);
      add(children, p.fatherId, p.id);
    }
    if (p.motherId !== undefined && p.motherId !== null) {
      add(mothers, p.id, p.motherId);
      add(children, p.motherId, p.id);
    }
  }
  for (const s of spouses) {
    add(spouseMap, s.a, s.b);
    add(spouseMap, s.b, s.a);
  }
  for (const a of adoptions) {
    add(adoptiveParents, a.child, a.parent);
    add(adoptees, a.parent, a.child);
  }

  const facts: KinshipFacts = {
    fathers,
    mothers,
    children,
    spouses: spouseMap,
    adoptiveParents,
    adoptees,
    sexes,
    births,
  };

  const moves = new Map<string, KinMove[]>();
  const sexOf = (id: string): Sex | null => sexes.get(id) ?? null;

  for (const p of people) {
    if (p.fatherId !== undefined && p.fatherId !== null) {
      pushMove(moves, { kind: "father", from: p.id, to: p.fatherId, visibility: "known" });
    }
    if (p.motherId !== undefined && p.motherId !== null) {
      pushMove(moves, { kind: "mother", from: p.id, to: p.motherId, visibility: "known" });
    }
  }
  // 父/母 → 子/女：用孩子性别定 kind；性别未知就不建这条（叫不出儿子/女儿）。
  for (const [parent, kids] of children) {
    for (const kid of kids) {
      const sex = sexOf(kid);
      if (sex === null) continue;
      pushMove(moves, {
        kind: sex === "male" ? "son" : "daughter",
        from: parent,
        to: kid,
        visibility: "known",
      });
    }
  }
  for (const s of spouses) {
    const sa = sexOf(s.a);
    const sb = sexOf(s.b);
    if (sa !== null) {
      pushMove(moves, {
        kind: sa === "male" ? "husband" : "wife",
        from: s.b,
        to: s.a,
        visibility: "known",
      });
    }
    if (sb !== null) {
      pushMove(moves, {
        kind: sb === "male" ? "husband" : "wife",
        from: s.a,
        to: s.b,
        visibility: "known",
      });
    }
  }
  for (const a of adoptions) {
    const parentSex = sexOf(a.parent);
    const childSex = sexOf(a.child);
    if (parentSex !== null) {
      pushMove(moves, {
        kind: parentSex === "male" ? "adoptive-father" : "adoptive-mother",
        from: a.child,
        to: a.parent,
        visibility: "known",
      });
    }
    if (childSex !== null) {
      pushMove(moves, {
        kind: childSex === "male" ? "adoptive-son" : "adoptive-daughter",
        from: a.parent,
        to: a.child,
        visibility: "known",
      });
    }
  }

  const frozen = freeze(moves);
  return {
    nodes: new Set(people.map((p) => p.id)),
    facts,
    moves: frozen,
    parentsOf(id) {
      const out: KinParent[] = [];
      for (const f of fathers.get(id) ?? []) out.push({ parent: f, role: "father" });
      for (const m of mothers.get(id) ?? []) out.push({ parent: m, role: "mother" });
      return out;
    },
    childrenOf(id) {
      const out: KinChild[] = [];
      for (const c of children.get(id) ?? []) {
        if (fathers.get(c)?.has(id) === true) out.push({ child: c, role: "father" });
        else if (mothers.get(c)?.has(id) === true) out.push({ child: c, role: "mother" });
      }
      return out;
    },
    spousesOf(id) {
      return [...(spouseMap.get(id) ?? [])];
    },
    adoptionsOf(id) {
      const out: KinAdoption[] = [];
      for (const p of adoptiveParents.get(id) ?? []) out.push({ parent: p, child: id });
      for (const c of adoptees.get(id) ?? []) out.push({ parent: id, child: c });
      return out;
    },
  };
}
