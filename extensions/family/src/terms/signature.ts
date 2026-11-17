import type { KinshipKind, RelationEdge } from "@life-sim/shared";

/**
 * 路径 → 关系签名。**纯函数、无 IO、无随机、无 `Date`**。
 *
 * 为什么需要这一层：`relationship.js` 的输入是**记号链**（`"爸爸的妹妹"`），
 * 输出是**社会称谓**；我们的输入是**关系图**。图 → 链这一步会丢掉
 * 「半血缘 / 谁嫁进来 / 哪一段是姻亲」等信息，只能靠链外的常量表补。
 * 本项目改为先把一条路径归约成结构签名（谁上、谁下、哪一步是配偶、
 * 共同亲代几条、连接人性别、长幼），再由 `table.ts` 查中文表。
 *
 * 归约规则（每一跳按「当前人 → 目标」记一个原子）：
 * - `父/母` → `parent`
 * - `子/女` → `child`；紧跟在 `parent` 后面时，二者合成 `sibling`
 *   （「我父亲的儿子」= 我的兄弟），并顺带算出共同亲代是一条还是两条。
 * - `子/女` 后接 `父/母` → **共亲**：孩子的另一位亲代，结构上等同于配偶
 *   （`inferred: true`）。这是「儿子的妈妈 ⇒ 妻子」这类链唯一的合法来源。
 * - `夫/妻` → `spouse`
 * - `兄/弟/姐/妹` → `sibling`（长幼来自边 kind，不靠字典序）
 * - `亲戚` → 无性别、无代数，签名不可用（调用方退回粗称谓）
 *
 * 归约是**局部重写**：原子记住 `subject`（这条关系由谁持有）、`target`
 * （指向谁）与 `via`（同胞共享的那位亲代），后续结构判据（是不是我的孩子、
 * 是不是我父之妻）都基于节点 id，而不是基于称谓词表反向猜测。
 */

export type Sex = "male" | "female";
export type Seniority = "elder" | "younger";
/** 共同亲代：`father` = 同父异母，`mother` = 同母异父，`both` = 同胞。 */
export type SharedParent = "father" | "mother" | "both";
/** `none` = 明确没有共同亲代；`null` = 父/母信息不足以判断。 */
export type SharedParentBreadth = SharedParent | "none" | null;

export type StepKind = "step-parent" | "step-child" | "step-sibling";

export type AtomRole = "parent" | "child" | "spouse" | "sibling";

/** 由边集提取的结构事实（父/母映射、子女、配偶、节点性别）。 */
export interface KinshipFacts {
  /** 只认 `子 → 父` 方向的边：反方向 `父 → 子` 不带亲代性别。 */
  readonly fathers: ReadonlyMap<string, ReadonlySet<string>>;
  readonly mothers: ReadonlyMap<string, ReadonlySet<string>>;
  /** 双向可推：`父 → 子` 的 son/daughter 边同样说明「子」是哪一位的孩子。 */
  readonly children: ReadonlyMap<string, ReadonlySet<string>>;
  readonly spouses: ReadonlyMap<string, ReadonlySet<string>>;
  /** 节点性别：由指向该节点的亲属边 kind 得出（father/son/husband/…）。 */
  readonly sexes: ReadonlyMap<string, Sex>;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

const MALE_KINDS: ReadonlySet<string> = new Set([
  "father",
  "son",
  "husband",
  "elder-brother",
  "younger-brother",
]);
const FEMALE_KINDS: ReadonlySet<string> = new Set([
  "mother",
  "daughter",
  "wife",
  "elder-sister",
  "younger-sister",
]);
const PARENT_KINDS: ReadonlySet<string> = new Set(["father", "mother"]);
const CHILD_KINDS: ReadonlySet<string> = new Set(["son", "daughter"]);
const SPOUSE_KINDS: ReadonlySet<string> = new Set(["husband", "wife"]);
const SIBLING_KINDS: ReadonlySet<string> = new Set([
  "elder-brother",
  "younger-brother",
  "elder-sister",
  "younger-sister",
]);

/** 某一跳的 kind → 目标性别；`relative` 无性别信息。 */
export function sexOfKind(kind: KinshipKind): Sex | null {
  if (MALE_KINDS.has(kind)) return "male";
  if (FEMALE_KINDS.has(kind)) return "female";
  return null;
}

/** 某一跳的 kind → 归约角色；`relative` 不可归约。 */
export function roleOfKind(kind: KinshipKind): AtomRole | null {
  if (PARENT_KINDS.has(kind)) return "parent";
  if (CHILD_KINDS.has(kind)) return "child";
  if (SPOUSE_KINDS.has(kind)) return "spouse";
  if (SIBLING_KINDS.has(kind)) return "sibling";
  return null;
}

/** 只对 `elder-*` / `younger-*` 有值。 */
export function seniorityOfKind(kind: KinshipKind): Seniority | null {
  if (kind === "elder-brother" || kind === "elder-sister") return "elder";
  if (kind === "younger-brother" || kind === "younger-sister") return "younger";
  return null;
}

/** 从边集提取结构事实。确定性与输入顺序无关（只建集合）。 */
export function kinshipFacts(edges: readonly RelationEdge[]): KinshipFacts {
  const fathers = new Map<string, Set<string>>();
  const mothers = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const spouses = new Map<string, Set<string>>();
  const sexes = new Map<string, Sex>();

  for (const e of edges) {
    const sex = sexOfKind(e.kind as KinshipKind);
    if (sex !== null && !sexes.has(e.to)) sexes.set(e.to, sex);
    if (e.kind === "father") {
      addTo(fathers, e.from, e.to);
      addTo(children, e.to, e.from);
    } else if (e.kind === "mother") {
      addTo(mothers, e.from, e.to);
      addTo(children, e.to, e.from);
    } else if (e.kind === "son" || e.kind === "daughter") {
      addTo(children, e.from, e.to);
    } else if (e.kind === "husband" || e.kind === "wife") {
      addTo(spouses, e.from, e.to);
      addTo(spouses, e.to, e.from);
    }
  }

  return { fathers, mothers, children, spouses, sexes };
}

/** `parent` 是否确实是 `child` 的父亲或母亲。 */
export function isChildOf(facts: KinshipFacts, parent: string, child: string): boolean {
  return facts.children.get(parent)?.has(child) === true;
}

/** 两人之间是否存在配偶边（双向任一方向）。 */
export function isSpouseOf(facts: KinshipFacts, a: string, b: string): boolean {
  return facts.spouses.get(a)?.has(b) === true;
}

/**
 * 两人共同亲代的宽度。
 *
 * - `both`：同父同母；
 * - `father`：同父异母；
 * - `mother`：同母异父；
 * - `none`：明确无共同亲代；
 * - `null`：任一方父/母不全 ⇒ 不猜（不加「同父异母」前缀）。
 */
export function sharedParentBreadth(
  facts: KinshipFacts,
  a: string,
  b: string,
): SharedParentBreadth {
  const af = facts.fathers.get(a);
  const am = facts.mothers.get(a);
  const bf = facts.fathers.get(b);
  const bm = facts.mothers.get(b);
  if (!af || af.size === 0 || !am || am.size === 0 || !bf || bf.size === 0 || !bm || bm.size === 0) {
    return null;
  }
  let father = false;
  for (const id of af) if (bf.has(id)) father = true;
  let mother = false;
  for (const id of am) if (bm.has(id)) mother = true;
  if (father && mother) return "both";
  if (father) return "father";
  if (mother) return "mother";
  return "none";
}

/** 两人共享的**那一位**亲代节点（用于「继亲」判定）；没有则 null。 */
export function sharedParentOf(facts: KinshipFacts, a: string, b: string): string | null {
  const af = facts.fathers.get(a);
  const bf = facts.fathers.get(b);
  if (af) for (const id of af) if (bf?.has(id) === true) return id;
  const am = facts.mothers.get(a);
  const bm = facts.mothers.get(b);
  if (am) for (const id of am) if (bm?.has(id) === true) return id;
  return null;
}

/**
 * 归约后的一个原子（内部形态）。
 *
 * `subject` 是**这条关系的持有者**，`target` 是指向的人。二者都是图里的节点 id，
 * 因此「我父之妻是不是我妈」「我儿子之母是不是我妻」这类判断可以直接查结构事实，
 * 不需要靠称谓词表反推。
 */
export interface InternalAtom {
  readonly role: AtomRole;
  readonly sex: Sex;
  readonly seniority: Seniority | null;
  readonly subject: string;
  readonly target: string;
  /** 同胞共享的那位亲代（只有由 `父/母 → 子/女` 合成的同胞才有值）。 */
  readonly via: string | null;
  readonly shared: SharedParentBreadth;
  /** true = 共亲推断出来的配偶（路径本身没有 spouse 边）。 */
  readonly inferred: boolean;
}

/** 对外暴露的原子：丢掉节点 id，只留称谓表需要的结构。 */
export interface SignatureAtom {
  readonly role: AtomRole;
  /** 目标性别。 */
  readonly sex: Sex;
  /** 长幼（仅 sibling 有值）。 */
  readonly seniority: Seniority | null;
  /** 关系持有者的性别（用于伯/叔、堂/表、舅/姨等分叉判定）。 */
  readonly subjectSex: Sex | null;
  /** 该同胞关系的共同亲代宽度（仅 sibling 有值）。 */
  readonly shared: SharedParentBreadth;
  readonly inferred: boolean;
}

/** 一条路径的结构签名。字段名与团队的约定一致。 */
export interface RelationSignature {
  /** 朝父母方向的**原始步数**（归约前）。 */
  readonly up: number;
  /** 朝子女方向的**原始步数**。 */
  readonly down: number;
  /** 配偶步数（含共亲推断）。 */
  readonly spouseSteps: number;
  /** 净代数变化：parent +1 / child -1 / 其余 0（归约后）。 */
  readonly generation: number;
  readonly stepKind: StepKind | null;
  /** 路径上最后一个同胞链接的共同亲代宽度；无同胞步则为 null。 */
  readonly sameBloodVia: SharedParentBreadth;
  /** 归约后每一步目标的性别，按路径顺序。 */
  readonly linkSexes: readonly Sex[];
  /** 归约后每一步的长幼，按路径顺序。 */
  readonly seniority: readonly (Seniority | null)[];
  /** 归约后的原子串 —— 称谓表按它取词。 */
  readonly pattern: readonly SignatureAtom[];
  readonly targetSex: Sex;
  /** 路径含配偶步，或是继亲关系（结构事实，不靠词表猜）。 */
  readonly affinal: boolean;
  readonly gapped: boolean;
}

/**
 * 归约结果。
 *
 * - `signed`：可交给称谓表；
 * - `coarse`：路径含 `relative`（无性别/无代数）⇒ 只能给粗称谓；
 * - `invalid`：路径在结构上不成立（如「我女儿的同胞」并不是我的孩子）⇒ **整条丢弃**。
 */
export type SignatureResult =
  | { readonly kind: "signed"; readonly signature: RelationSignature; readonly atoms: readonly InternalAtom[] }
  | { readonly kind: "coarse" }
  | { readonly kind: "invalid" };

/**
 * 路径 → 签名。`kinds[i]` 是 `nodes[i] → nodes[i+1]` 这一跳。
 */
export function signatureOfPath(
  kinds: readonly KinshipKind[],
  nodes: readonly string[],
  facts: KinshipFacts,
  from: string,
  gapped = false,
): SignatureResult {
  if (kinds.length === 0 || nodes.length !== kinds.length + 1) return { kind: "invalid" };

  const atoms: InternalAtom[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]!;
    const role = roleOfKind(kind);
    const sex = sexOfKind(kind);
    if (role === null || sex === null) return { kind: "coarse" };

    const subject = nodes[i]!;
    const target = nodes[i + 1]!;
    const last = atoms[atoms.length - 1];

    if (role === "parent") {
      if (last !== undefined && last.role === "child") {
        // 子 → 另一位亲代：共亲。结构上等同于「该孩子的另一位亲代是我的配偶」。
        atoms.pop();
        atoms.push({
          role: "spouse",
          sex,
          seniority: null,
          subject: last.subject,
          target,
          via: null,
          shared: null,
          inferred: true,
        });
      } else {
        atoms.push({
          role: "parent",
          sex,
          seniority: null,
          subject,
          target,
          via: null,
          shared: null,
          inferred: false,
        });
      }
      continue;
    }

    if (role === "child") {
      if (last !== undefined && last.role === "parent") {
        // 父/母 → 子/女：除我之外的另一个孩子 ⇒ 我的同胞。
        atoms.pop();
        const prev = atoms[atoms.length - 1];
        if (prev !== undefined && prev.role === "sibling") {
          // 同胞的同胞：只有两条同胞链接在**同一侧**（同一位共同亲代）才仍是同胞，
          // 否则是另一半血缘上的陌生人（如「我同父异母弟弟的同母姐姐」）。
          const firstShared = prev.via ?? sharedParentOf(facts, prev.subject, prev.target);
          const sameSide = firstShared !== null && firstShared === last.target;
          if (!sameSide && sharedParentBreadth(facts, prev.subject, target) !== "both") {
            return { kind: "invalid" };
          }
          atoms.pop();
          atoms.push({
            role: "sibling",
            sex,
            // 长幼是相对于「上一个同胞」的，不是相对于我 —— 不猜。
            seniority: null,
            subject: prev.subject,
            target,
            via: prev.via,
            shared: sharedParentBreadth(facts, prev.subject, target),
            inferred: false,
          });
          continue;
        }
        atoms.push({
          role: "sibling",
          sex,
          seniority: null,
          subject: last.subject,
          target,
          via: last.target,
          shared: sharedParentBreadth(facts, last.subject, target),
          inferred: false,
        });
        continue;
      }
      atoms.push({
        role: "child",
        sex,
        seniority: null,
        subject,
        target,
        via: null,
        shared: null,
        inferred: false,
      });
      continue;
    }

    if (role === "sibling") {
      if (last !== undefined && last.role === "child") {
        // 我的孩子 → 孩子的同胞：只有确实也是我的孩子，才仍是我的孩子。
        if (!isChildOf(facts, last.subject, target)) return { kind: "invalid" };
        atoms.pop();
        atoms.push({
          role: "child",
          sex,
          seniority: null,
          subject: last.subject,
          target,
          via: null,
          shared: null,
          inferred: false,
        });
        continue;
      }
      if (last !== undefined && last.role === "sibling") {
        // 同胞的同胞：必须仍是同一持有者的同胞，否则是另一半血缘上的陌生人。
        const firstShared = last.via ?? sharedParentOf(facts, last.subject, last.target);
        const secondShared = sharedParentOf(facts, last.target, target);
        const sameSide = firstShared !== null && secondShared !== null && firstShared === secondShared;
        if (!sameSide && sharedParentBreadth(facts, last.subject, target) !== "both") {
          return { kind: "invalid" };
        }
        atoms.pop();
        atoms.push({
          role: "sibling",
          sex,
          // 这条边的长幼是相对于「上一个同胞」的，不是相对于我 —— 不猜。
          seniority: null,
          subject: last.subject,
          target,
          via: last.via,
          shared: sharedParentBreadth(facts, last.subject, target),
          inferred: false,
        });
        continue;
      }
      atoms.push({
        role: "sibling",
        sex,
        seniority: seniorityOfKind(kind),
        subject,
        target,
        via: null,
        shared: sharedParentBreadth(facts, subject, target),
        inferred: false,
      });
      continue;
    }

    // spouse
    atoms.push({
      role: "spouse",
      sex,
      seniority: null,
      subject,
      target,
      via: null,
      shared: null,
      inferred: false,
    });
  }

  const pattern: SignatureAtom[] = atoms.map((a) => ({
    role: a.role,
    sex: a.sex,
    seniority: a.seniority,
    subjectSex: facts.sexes.get(a.subject) ?? null,
    shared: a.shared,
    inferred: a.inferred,
  }));

  const stepKind = classifyStep(atoms, facts, from);
  const lastSibling = [...atoms].reverse().find((a) => a.role === "sibling");
  const spouseSteps = atoms.filter((a) => a.role === "spouse").length;

  const signature: RelationSignature = {
    up: kinds.filter((k) => roleOfKind(k) === "parent").length,
    down: kinds.filter((k) => roleOfKind(k) === "child").length,
    spouseSteps,
    generation: atoms.reduce(
      (sum, a) => sum + (a.role === "parent" ? 1 : a.role === "child" ? -1 : 0),
      0,
    ),
    stepKind,
    sameBloodVia: lastSibling?.shared ?? null,
    linkSexes: pattern.map((p) => p.sex),
    seniority: pattern.map((p) => p.seniority),
    pattern,
    targetSex: atoms[atoms.length - 1]!.sex,
    affinal: spouseSteps > 0 || stepKind !== null,
    gapped,
  };

  return { kind: "signed", signature, atoms };
}

/**
 * 继亲分类（结构判据，不看词）。
 *
 * 只覆盖「目标本身就是继亲」的三种形状；更长的链就算经过继亲也不标 ——
 * 排序只需要知道这一条读法是不是继亲读法。
 */
function classifyStep(
  atoms: readonly InternalAtom[],
  facts: KinshipFacts,
  from: string,
): StepKind | null {
  const roles = atoms.map((a) => a.role);
  if (roles.length === 2 && roles[0] === "parent" && roles[1] === "spouse") {
    // 父/母的配偶：若配偶就是我的另一位亲代，那就不是「继」。
    return isChildOf(facts, atoms[1]!.target, from) ? null : "step-parent";
  }
  if (roles.length === 2 && roles[0] === "sibling" && roles[1] === "parent") {
    // 同父异母/同母异父的同胞的**另一位**亲代：只有确实与我的亲代婚配才是继亲。
    const sibling = atoms[0]!;
    const shared = sibling.via ?? sharedParentOf(facts, sibling.subject, sibling.target);
    if (shared === null) return null;
    return isSpouseOf(facts, shared, atoms[1]!.target) ? "step-parent" : null;
  }
  if (roles.length === 2 && roles[0] === "spouse" && roles[1] === "child") {
    return isChildOf(facts, from, atoms[1]!.target) ? null : "step-child";
  }
  if (roles.length === 3 && roles[0] === "sibling" && roles[1] === "parent" && roles[2] === "child") {
    // 同胞的另一位亲代的孩子：若这孩子也是共享亲代所出，那就是我的同胞，不是继。
    const sibling = atoms[0]!;
    const shared = sibling.via ?? sharedParentOf(facts, sibling.subject, sibling.target);
    if (shared !== null && isChildOf(facts, shared, atoms[2]!.target)) return null;
    return "step-sibling";
  }
  if (roles.length === 3 && roles[0] === "parent" && roles[1] === "spouse" && roles[2] === "child") {
    // 父/母的配偶的孩子：两种情况都是我的同胞 ——
    // 配偶本身就是我的父/母，或这孩子也是我父/母所出。否则才是继兄弟姐妹。
    const viaParent = isChildOf(facts, atoms[1]!.target, from);
    const sharedChild = isChildOf(facts, atoms[0]!.target, atoms[2]!.target);
    return viaParent || sharedChild ? null : "step-sibling";
  }
  return null;
}
