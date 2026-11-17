import type { RelationEdge } from "@life-sim/shared";

/**
 * 亲缘系数（Wright 路径法）。
 *
 * 它存在的意义不是给玩家看数字，而是**给称谓推导当判据**：
 * 一条声称「血亲」的读法，若两人 r = 0，那条读法一定是把姻亲折叠成了血亲
 * （`儿子的爸爸的儿子 ⇒ 儿子`——库假定一夫一妻，继子因此被认成亲子）。
 */

export interface Pedigree {
  readonly fathers: ReadonlyMap<string, string>;
  readonly mothers: ReadonlyMap<string, string>;
}

interface CoefficientCalc {
  readonly r: (a: string, b: string) => number;
  readonly F: (a: string) => number;
}

/**
 * 按边集缓存计算器。
 *
 * 投影会对同一个 `visibleEdges` 数组反复调用（每张卡 × 每对人），
 * 而系数只依赖父代映射 —— 所以按数组身份缓存一次，后续都是查表。
 * 边的父代映射只认 `子 → 父/母` 方向：反方向 `父 → 子` 不带性别，
 * 拿它猜「父亲还是母亲」会把半血亲判反。
 */
const COEFF_CACHE = new WeakMap<readonly RelationEdge[], CoefficientCalc>();

export function pedigreeOf(edges: readonly RelationEdge[]): Pedigree {
  const fathers = new Map<string, string>();
  const mothers = new Map<string, string>();
  for (const e of edges) {
    if (e.kind === "father") fathers.set(e.from, e.to);
    else if (e.kind === "mother") mothers.set(e.from, e.to);
  }
  return { fathers, mothers };
}

function makeCoefficientCalc(ped: Pedigree): CoefficientCalc {
  const fMemo = new Map<string, number>();
  const phiMemo = new Map<string, number>();
  const ancMemo = new Map<string, boolean>();

  function isAnc(x: string, y: string): boolean {
    if (x === y) return false;
    const key = `${x}>${y}`;
    const hit = ancMemo.get(key);
    if (hit !== undefined) return hit;
    ancMemo.set(key, false);
    const f = ped.fathers.get(y);
    const m = ped.mothers.get(y);
    const r =
      f === x || m === x || (f !== undefined && isAnc(x, f)) || (m !== undefined && isAnc(x, m));
    ancMemo.set(key, r);
    return r;
  }

  function getF(x: string): number {
    const hit = fMemo.get(x);
    if (hit !== undefined) return hit;
    const f = ped.fathers.get(x);
    const m = ped.mothers.get(x);
    // 缺父或缺母时无法判断近交，按 0 处理（只有两侧亲代都已知才计入）。
    const v = f !== undefined && m !== undefined ? getPhi(f, m) : 0;
    fMemo.set(x, v);
    return v;
  }

  function getPhi(x: string, y: string): number {
    if (x === y) return 0.5 * (1 + getF(x));
    const key = x < y ? `${x}|${y}` : `${y}|${x}`;
    const hit = phiMemo.get(key);
    if (hit !== undefined) return hit;
    const xf = ped.fathers.get(x);
    const xm = ped.mothers.get(x);
    const yf = ped.fathers.get(y);
    const ym = ped.mothers.get(y);
    const upX = (xf !== undefined || xm !== undefined) && !isAnc(x, y);
    const upY = (yf !== undefined || ym !== undefined) && !isAnc(y, x);
    // 未知的一方视为无关个体，只计已知一侧。
    let v: number;
    if (upX) {
      v = 0.5 * ((xf !== undefined ? getPhi(xf, y) : 0) + (xm !== undefined ? getPhi(xm, y) : 0));
    } else if (upY) {
      v = 0.5 * ((yf !== undefined ? getPhi(x, yf) : 0) + (ym !== undefined ? getPhi(x, ym) : 0));
    } else v = 0;
    phiMemo.set(key, v);
    return v;
  }

  return { r: (a, b) => 2 * getPhi(a, b), F: getF };
}

function calcFor(edges: readonly RelationEdge[]): CoefficientCalc {
  let calc = COEFF_CACHE.get(edges);
  if (calc === undefined) {
    calc = makeCoefficientCalc(pedigreeOf(edges));
    COEFF_CACHE.set(edges, calc);
  }
  return calc;
}

/**
 * 亲缘系数 r：0 = 两人没有共同血亲（姻亲、拟制、纯同住）。
 *
 * 注意这是**边集上的纯函数**，不读任何模板配置 —— 系数本身不是展示项。
 */
export function kinshipCoefficient(
  edges: readonly RelationEdge[],
  a: string,
  b: string,
): number {
  if (a === b) return 1;
  return calcFor(edges).r(a, b);
}

/** 近交系数 F（Wright）：父母亲缘系数的一半。 */
export function inbreedingCoefficient(edges: readonly RelationEdge[], nodeId: string): number {
  return calcFor(edges).F(nodeId);
}
