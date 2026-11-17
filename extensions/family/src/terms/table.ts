import {
  isChildOf,
  isSpouseOf,
  sharedParentOf,
  type InternalAtom,
  type KinshipFacts,
  type Seniority,
  type Sex,
} from "./signature.js";

/**
 * 关系签名 → 中文称谓。
 *
 * 三张彼此独立的表：
 * 1. **血亲表**（无配偶步，且不是继亲）：只产出谱系范畴词（父/祖/孙/伯叔/姑舅姨/堂表/侄甥）。
 *    这里**永远不出现** `嫂子` / `小姑` / `大舅子` / `婆婆` 这类社会称谓 ——
 *    它们在结构上就进不来，不需要白名单拦。
 * 2. **姻亲表**（含配偶步，或继亲）：按「配偶步落在首/尾/中间」分三段合成。
 * 3. **兜底**：签名超出覆盖范围 ⇒ `远亲` / `继亲` / `姻亲`，不编词。
 *
 * 长幼（伯/叔、大舅子/小舅子、嫂子/弟媳）一律读签名里的 `seniority`，
 * 该字段来自边 kind（`elder-*` / `younger-*`），不来自字典序。
 */

export interface NameOptions {
  /**
   * 是否给同胞称谓加「同父异母的 / 同母异父的」前缀。
   *
   * `kinshipReadings` 打开（一个读法就是一条路径，前缀是这条路径的事实）；
   * `kinshipTerm` 关闭（一次只回一个主称谓，半血亲读法仍会作为附加身份出现）。
   */
  readonly halfPrefix?: boolean;
}

/** 血缘关系缺表时的粗称谓（不猜代数）。 */
export const COARSE_BLOOD_TERM = "远亲";
/** 姻亲关系缺表时的粗称谓。 */
export const COARSE_AFFINAL_TERM = "姻亲";
/** 继亲关系缺表时的粗称谓。 */
export const COARSE_STEP_TERM = "继亲";

// ---------------- 小表 ----------------

const PARENT_TERM: Record<Sex, string> = { male: "爸爸", female: "妈妈" };
const SPOUSE_TERM: Record<Sex, string> = { male: "老公", female: "老婆" };
const CHILD_TERM: Record<Sex, string> = { male: "儿子", female: "女儿" };

/** 父母的父母：按「父/母 → 父/母」两跳取词。 */
const GRANDPARENT_TERM: Record<Sex, Record<Sex, string>> = {
  male: { male: "爷爷", female: "奶奶" },
  female: { male: "外公", female: "外婆" },
};

/** 子女的配偶。 */
const CHILD_SPOUSE: Record<Sex, string> = { male: "儿媳", female: "女婿" };
/** 孙辈的配偶。 */
const GRANDCHILD_SPOUSE: Record<Sex, string> = { male: "孙媳", female: "孙女婿" };

/** 我的同胞的配偶：长幼来自同胞边。 */
function siblingSpouseTerm(sex: Sex, seniority: Seniority | null): string | null {
  if (sex === "male") {
    if (seniority === "elder") return "嫂子";
    if (seniority === "younger") return "弟媳";
    return null;
  }
  if (seniority === "elder") return "姐夫";
  if (seniority === "younger") return "妹夫";
  return null;
}

/** 我的配偶的同胞（大伯子 / 小舅子 …）。长幼不明则缺表。 */
function inLawSiblingTerm(
  spouseSex: Sex,
  siblingSex: Sex,
  seniority: Seniority | null,
): string | null {
  if (spouseSex === "male") {
    if (siblingSex === "male") {
      if (seniority === "elder") return "大伯子";
      if (seniority === "younger") return "小叔子";
      return null;
    }
    if (seniority === "elder") return "大姑子";
    if (seniority === "younger") return "小姑子";
    return null;
  }
  if (siblingSex === "male") {
    if (seniority === "elder") return "大舅子";
    if (seniority === "younger") return "小舅子";
    return null;
  }
  if (seniority === "elder") return "大姨子";
  if (seniority === "younger") return "小姨子";
  return null;
}

/** 我的配偶的父/母。 */
function inLawParentTerm(spouseSex: Sex, targetSex: Sex): string {
  if (spouseSex === "male") return targetSex === "male" ? "公公" : "婆婆";
  return targetSex === "male" ? "岳父" : "岳母";
}

/** 伯父/叔叔/姑姑/舅舅/姨妈的配偶。 */
const UNCLE_SPOUSE: Readonly<Record<string, string>> = {
  伯父: "伯母",
  叔叔: "婶婶",
  姑姑: "姑父",
  大姑: "大姑父",
  小姑: "小姑父",
  舅舅: "舅妈",
  大舅: "大舅妈",
  小舅: "小舅妈",
  姨妈: "姨父",
  大姨: "大姨父",
  小姨: "小姨父",
};

/** 继祖辈：母系加「外」，与直系祖辈的「外」同一套口径。 */
function stepGrandparentTerm(parentSex: Sex, targetSex: Sex): string {
  const outer = parentSex === "female" ? "外" : "";
  return `继${outer}${targetSex === "male" ? "祖父" : "祖母"}`;
}

/** 配偶的孙辈（不是我自己的孙辈）：继孙 / 继孙女 / 继外孙 / 继外孙女。 */
function stepGrandchildTerm(sexes: readonly Sex[]): string {
  if (sexes.length !== 2) return COARSE_AFFINAL_TERM;
  const outer = sexes[0] === "female" ? "外" : "";
  return `继${outer}孙${sexes[1] === "female" ? "女" : ""}`;
}

/** 是否是粗称谓（表外兜底），调用方据此决定 `exact`。 */
export function isCoarseTerm(term: string): boolean {
  return term === COARSE_BLOOD_TERM || term === COARSE_AFFINAL_TERM || term === COARSE_STEP_TERM;
}

// ---------------- 血亲表 ----------------

/**
 * 直系祖先：从「我」往上每一跳的性别序列。
 *
 * 曾/高 一代加在「祖父/祖母」前；「外」出现在两个位置 ——
 * 母系入口（`sexes[0] === female`）在**最前**，中间夹着的女性（`sexes[k-2]`）
 * 紧贴「祖父/祖母」前。于是 FMF = 曾外祖父、MFF = 外曾祖父、MMF = 外曾外祖父，
 * 与通行的读法一致。
 */
export function ancestorTerm(sexes: readonly Sex[]): string | null {
  const k = sexes.length;
  if (k === 1) return PARENT_TERM[sexes[0]!];
  if (k === 2) return GRANDPARENT_TERM[sexes[0]!][sexes[1]!];
  if (k > 4) return null;
  const outer = sexes[0] === "female" ? "外" : "";
  const inner = sexes[k - 2] === "female" ? "外" : "";
  const generation = k === 3 ? "曾" : "高";
  const base = sexes[k - 1] === "male" ? "祖父" : "祖母";
  return `${outer}${generation}${inner}${base}`;
}

/**
 * 直系后代：从「我」往下每一跳的性别序列。
 *
 * 「外」同样出现在两个位置：第一跳是女儿 ⇒ 最前的「外」；倒数第二跳是女性 ⇒
 * 「孙」前的「外」。于是 儿子的女儿的儿子 = 曾外孙、女儿的女儿的儿子 = 外曾外孙。
 */
export function descendantTerm(sexes: readonly Sex[]): string | null {
  const d = sexes.length;
  if (d === 1) return CHILD_TERM[sexes[0]!];
  if (d > 4) return null;
  const outer = sexes[0] === "female" ? "外" : "";
  const inner = d >= 3 && sexes[d - 2] === "female" ? "外" : "";
  const generation = d === 2 ? "" : d === 3 ? "曾" : "玄";
  // 儿子的儿子 = 孙子；女儿的儿子 = 外孙（男丁的「子」只在无「外」时加）。
  const tail = sexes[d - 1] === "female" ? "女" : d === 2 && outer === "" ? "子" : "";
  return `${outer}${generation}${inner}孙${tail}`;
}

/** 同胞：长幼已知才有哥哥/弟弟，未知用「兄弟 / 姐妹」。 */
export function siblingTerm(sex: Sex, seniority: Seniority | null): string {
  if (sex === "male") {
    if (seniority === "elder") return "哥哥";
    if (seniority === "younger") return "弟弟";
    return "兄弟";
  }
  if (seniority === "elder") return "姐姐";
  if (seniority === "younger") return "妹妹";
  return "姐妹";
}

/**
 * 同胞的子女：`侄` 走兄弟，`甥` 走姐妹。
 *
 * 第二代（侄孙/甥孙）还要看中间那一位的性别：中间是女儿就加「外」。
 */
function nephewTerm(
  siblingSex: Sex,
  intermediateSex: Sex,
  finalSex: Sex,
  depth: number,
): string | null {
  const stem = siblingSex === "male" ? "侄" : "甥";
  if (depth === 1) {
    if (siblingSex === "male") return finalSex === "male" ? "侄子" : "侄女";
    return finalSex === "male" ? "外甥" : "外甥女";
  }
  if (depth === 2) {
    const inner = intermediateSex === "female" ? "外" : "";
    return `${stem}${inner}孙${finalSex === "female" ? "女" : ""}`;
  }
  return null;
}

/**
 * 父/母的同胞。`subjectSex` = 我的父/母的性别。
 *
 * 长幼**能拿到就必须用**：边 kind 写了 `elder-*` / `younger-*` 就是事实，
 * 塌成「姑姑/舅舅/姨妈」等于把已知信息扔掉。只有长幼未知才用中性词。
 * 与姻亲的「大舅子 / 小姑子」不冲突：后者带「子」。
 */
function parentSiblingTerm(
  subjectSex: Sex,
  siblingSex: Sex,
  seniority: Seniority | null,
): string | null {
  if (subjectSex === "male") {
    if (siblingSex === "male") {
      if (seniority === "elder") return "伯父";
      if (seniority === "younger") return "叔叔";
      return "叔伯";
    }
    if (seniority === "elder") return "大姑";
    if (seniority === "younger") return "小姑";
    return "姑姑";
  }
  if (siblingSex === "male") {
    if (seniority === "elder") return "大舅";
    if (seniority === "younger") return "小舅";
    return "舅舅";
  }
  if (seniority === "elder") return "大姨";
  if (seniority === "younger") return "小姨";
  return "姨妈";
}

/**
 * 祖辈的同胞（伯公 / 叔公 / 姑婆 / 舅公 / 姨婆）。
 *
 * 「外」按我的父/母性别插在「公/婆」之前：妈妈的爸爸的哥哥 = 伯外公，
 * 爸爸的爸爸的哥哥 = 伯公。
 */
function grandparentSiblingTerm(
  parentSex: Sex,
  grandparentSex: Sex | null,
  siblingSex: Sex,
  seniority: Seniority | null,
): string | null {
  if (grandparentSex === null) return null;
  const outer = parentSex === "female" ? "外" : "";
  // 长幼能拿到就用：伯公/叔公 已经分了，姑婆/舅公/姨婆 用 大/小 前缀。
  const aged = seniority === "elder" ? "大" : seniority === "younger" ? "小" : "";
  if (grandparentSex === "male") {
    if (siblingSex === "male") {
      if (seniority === "elder") return `伯${outer}公`;
      if (seniority === "younger") return `叔${outer}公`;
      return null;
    }
    return `${aged}姑${outer}婆`;
  }
  return siblingSex === "male" ? `${aged}舅${outer}公` : `${aged}姨${outer}婆`;
}

/**
 * 堂/表：伯父（父之兄/弟）的孩子才是「堂」，其余都是「表」。
 *
 * **有意的简化**：旧库还会分「姑表 / 舅表 / 姨表」。签名里信息够
 * （`parentSex` + `siblingSex` + `siblingSubjectSex` 都在），要恢复只是加一层前缀；
 * 现状停在「堂 vs 表」，因为再往下分属于书面/方言用法，产品上不划算。
 */
function cousinPrefix(parentSex: Sex, uncleSex: Sex): "堂" | "表" {
  return parentSex === "male" && uncleSex === "male" ? "堂" : "表";
}

// ---------------- 入口 ----------------

/**
 * 签名 → 称谓。返回 `null` = 这条读法不可命名，调用方丢弃。
 *
 * 形态判定完全基于 `pattern`（归约后的原子串）与结构事实，不看词。
 */
export function nameAtoms(
  atoms: readonly InternalAtom[],
  facts: KinshipFacts,
  from: string,
  opts: NameOptions = {},
): string | null {
  if (atoms.length === 0) return null;
  const hasSpouse = atoms.some((a) => a.role === "spouse");
  return hasSpouse ? nameAffinal(atoms, facts, from, opts) : nameBlood(atoms, facts, from, opts);
}

function nameBlood(
  atoms: readonly InternalAtom[],
  facts: KinshipFacts,
  from: string,
  opts: NameOptions,
): string | null {
  const siblingIndex = atoms.findIndex((a) => a.role === "sibling");

  if (siblingIndex < 0) {
    if (atoms.every((a) => a.role === "parent")) return ancestorTerm(atoms.map((a) => a.sex));
    if (atoms.every((a) => a.role === "child")) return descendantTerm(atoms.map((a) => a.sex));
    return null;
  }

  const prefix = atoms.slice(0, siblingIndex);
  const suffix = atoms.slice(siblingIndex + 1);
  const sibling = atoms[siblingIndex]!;
  if (!prefix.every((a) => a.role === "parent")) return null;

  // 同胞之后接「另一位亲代」：不是直系长辈，就是继亲。
  if (suffix.length >= 1 && suffix[0]!.role === "parent") {
    return nameBranchParent(prefix, sibling, suffix, facts);
  }
  if (!suffix.every((a) => a.role === "child")) return null;

  const k = prefix.length;
  const j = suffix.length;

  if (k === 0) {
    if (j === 0) {
      const base = siblingTerm(sibling.sex, sibling.seniority);
      const half = opts.halfPrefix === false ? "" : halfLabel(sibling.shared);
      return `${half}${base}`;
    }
    if (j === 1) return nephewTerm(sibling.sex, sibling.sex, suffix[0]!.sex, 1);
    if (j === 2) return nephewTerm(sibling.sex, suffix[0]!.sex, suffix[1]!.sex, 2);
    return null;
  }

  if (k === 1) {
    const parentSex = prefix[0]!.sex;
    if (j === 0) return parentSiblingTerm(parentSex, sibling.sex, sibling.seniority);
    if (j === 1) {
      const prefixWord = cousinPrefix(parentSex, sibling.sex);
      return `${prefixWord}${suffix[0]!.sex === "male" ? "兄弟" : "姐妹"}`;
    }
    if (j === 2) {
      const prefixWord = cousinPrefix(parentSex, sibling.sex);
      const cousinSex = suffix[0]!.sex;
      const childSex = suffix[1]!.sex;
      if (cousinSex === "male") {
        return `${prefixWord}${childSex === "male" ? "侄" : "侄女"}`;
      }
      return `${prefixWord}${childSex === "male" ? "外甥" : "外甥女"}`;
    }
    return null;
  }

  if (k === 2) {
    if (j !== 0) return null;
    return grandparentSiblingTerm(prefix[0]!.sex, prefix[1]!.sex, sibling.sex, sibling.seniority);
  }

  return null;
}

/**
 * 「同胞 → 另一位亲代」这一段的命名。
 *
 * 两种完全不同的结构，靠节点关系分开：
 * 1. 这位亲代是我父/母的父/母 ⇒ 我的直系长辈（`奶奶`、`曾祖父` …）；
 * 2. 否则它是同胞的另一位亲代 ⇒ 我父/母的继任配偶 ⇒ 继父/继母（或继祖辈）。
 *    只有确实与我的亲代婚配时才算继亲，否则这条路径不可命名。
 */
function nameBranchParent(
  prefix: readonly InternalAtom[],
  sibling: InternalAtom,
  suffix: readonly InternalAtom[],
  facts: KinshipFacts,
): string | null {
  const k = prefix.length;
  const parent = suffix[0]!;

  if (suffix.length === 1 && isChildOf(facts, parent.target, sibling.subject)) {
    return ancestorTerm([...prefix.map((a) => a.sex), parent.sex]);
  }

  const shared = sibling.via ?? sharedParentOf(facts, sibling.subject, sibling.target);
  if (shared === null || !isSpouseOf(facts, shared, parent.target)) return null;

  if (suffix.length === 1) {
    if (k === 0) return parent.sex === "male" ? "继父" : "继母";
    if (k === 1) return stepGrandparentTerm(prefix[0]!.sex, parent.sex);
    return null;
  }

  // 继亲的子女：与我的共享亲代有孩子 ⇒ 其实是我的同胞；否则是继兄弟姐妹。
  if (k === 0 && suffix.length === 2 && suffix[1]!.role === "child") {
    const child = suffix[1]!;
    if (isChildOf(facts, shared, child.target)) return siblingTerm(child.sex, null);
    return child.sex === "male" ? "继兄弟" : "继姐妹";
  }
  return null;
}

function halfLabel(shared: InternalAtom["shared"]): string {
  if (shared === "father") return "同父异母的";
  if (shared === "mother") return "同母异父的";
  return "";
}

function nameAffinal(
  atoms: readonly InternalAtom[],
  facts: KinshipFacts,
  from: string,
  opts: NameOptions,
): string | null {
  let si = -1;
  for (let i = 0; i < atoms.length; i++) if (atoms[i]!.role === "spouse") si = i;
  const spouse = atoms[si]!;
  const head = atoms.slice(0, si);
  const tail = atoms.slice(si + 1);

  // 情形一：配偶步属于「我」（事实婚配，或共亲推断）。
  if (spouse.subject === from) {
    if (tail.length === 0) return SPOUSE_TERM[spouse.sex];
    if (tail.length === 1) {
      const t = tail[0]!;
      if (t.role === "parent") return inLawParentTerm(spouse.sex, t.sex);
      if (t.role === "sibling") {
        return inLawSiblingTerm(spouse.sex, t.sex, t.seniority) ?? COARSE_AFFINAL_TERM;
      }
      if (t.role === "child") {
        if (isChildOf(facts, from, t.target)) return CHILD_TERM[t.sex];
        return t.sex === "male" ? "继子" : "继女";
      }
    }
    // 配偶的孙辈：是我自己的孩子所出就是我的孙辈，否则是继孙辈。
    if (tail.length === 2 && tail[0]!.role === "child" && tail[1]!.role === "child") {
      const first = tail[0]!;
      if (isChildOf(facts, from, first.target)) {
        return descendantTerm([first.sex, tail[1]!.sex]);
      }
      return stepGrandchildTerm([first.sex, tail[1]!.sex]);
    }
    return COARSE_AFFINAL_TERM;
  }

  // 情形二：配偶步在末位（「某人的配偶」）。
  if (tail.length === 0) {
    const h = head[head.length - 1];
    if (h === undefined) return SPOUSE_TERM[spouse.sex];

    if (h.role === "parent") {
      // 我父之妻 / 我母之夫
      if (head.length === 1) {
        if (isChildOf(facts, spouse.target, from)) return PARENT_TERM[spouse.sex];
        return spouse.sex === "male" ? "继父" : "继母";
      }
      // 我父/母的父/母之配偶
      if (head.length === 2 && head[0]!.role === "parent" && h.role === "parent") {
        const parent = head[0]!;
        if (isChildOf(facts, spouse.target, parent.target)) {
          return GRANDPARENT_TERM[parent.sex][spouse.sex];
        }
        return stepGrandparentTerm(parent.sex, spouse.sex);
      }
      // 我配偶的父/母的配偶：若配偶是我配偶的亲代，那它就是公公/婆婆/岳父/岳母
      if (head.length === 2 && head[0]!.role === "spouse" && head[0]!.subject === from) {
        if (isChildOf(facts, spouse.target, head[0]!.target)) {
          return inLawParentTerm(head[0]!.sex, spouse.sex);
        }
        return COARSE_AFFINAL_TERM;
      }
      return COARSE_AFFINAL_TERM;
    }

    if (h.role === "sibling") {
      // 我同胞的配偶：长幼已知才出 嫂子/弟媳/姐夫/妹夫，未知退「姻亲」——
      // 不许把整条读法丢掉（「什么都不说」比「说姻亲」更差）。
      if (head.length === 1) {
        return siblingSpouseTerm(h.sex, h.seniority) ?? COARSE_AFFINAL_TERM;
      }
      // 我父/母的同胞的配偶（伯母/婶婶/姑父/舅妈/姨父）
      const uncle = nameBlood(head, facts, from, opts);
      if (uncle !== null && UNCLE_SPOUSE[uncle] !== undefined) return UNCLE_SPOUSE[uncle]!;
      return COARSE_AFFINAL_TERM;
    }

    if (h.role === "child") {
      if (head.length === 1) return CHILD_SPOUSE[h.sex];
      if (head.length === 2 && head[0]!.role === "child") return GRANDCHILD_SPOUSE[h.sex];
      // 配偶的子女的配偶（继女之夫 / 继子之妻）：社会称谓与亲生同形。
      if (head.length === 2 && head[0]!.role === "spouse" && head[0]!.subject === from) {
        return CHILD_SPOUSE[h.sex];
      }
      return COARSE_AFFINAL_TERM;
    }

    return COARSE_AFFINAL_TERM;
  }

  // 情形三：配偶步在中间 —— 父/母的配偶的孩子（继兄弟姐妹）。
  if (head.length === 1 && head[0]!.role === "parent" && tail.length === 1 && tail[0]!.role === "child") {
    const child = tail[0]!;
    // 两条路径都说明这孩子是我父/母的孩子：配偶本身是我的父/母，或这孩子也是我父/母所出。
    if (isChildOf(facts, spouse.target, from) || isChildOf(facts, head[0]!.target, child.target)) {
      return siblingTerm(child.sex, null);
    }
    return child.sex === "male" ? "继兄弟" : "继姐妹";
  }

  return COARSE_AFFINAL_TERM;
}
