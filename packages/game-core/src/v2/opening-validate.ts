import type { OpeningBranchDag, UiConfig, WorldTemplateV2 } from "@life-sim/shared";
import { attributeKindOf } from "./attribute-rules.js";
import { styleSpecFor } from "./presentation/style.js";

/**
 * 开局 DAG 的**跨文件**校验（ADR-004）。
 *
 * 为什么不在 zod 里做：targets 引用的是 `world.yaml` 的属性 id、`budgetFrom` 引用的是同一
 * DAG 里的参数 —— 两者都不在 `opening.yaml` 的解析上下文里。放在这里由 `templates.ts`
 * 在拿到 `template` + `ui` 之后调用，与 `validateStyleRefs` 同一层、同一失败通道
 * （`template_invalid` + 字段路径），模板写错能在启动时看到确切位置。
 *
 * 纯函数、不读文件、不抛错：只返回 issue 列表，由调用方决定 fail-fast 还是标 invalid。
 */
export interface OpeningIssue {
  path: string;
  message: string;
}

/** 加点只允许数值类属性（ADR-004 D1）：文本 / 派生属性没有「加一点」的语义。 */
const NUMERIC_KINDS = new Set(["number", "ladder"]);

export function validateOpeningDag(
  dag: OpeningBranchDag,
  template: WorldTemplateV2,
  ui?: UiConfig,
): OpeningIssue[] {
  const issues: OpeningIssue[] = [];
  const add = (path: string, message: string): void => {
    issues.push({ path, message });
  };

  const nodeIds = new Set<string>();
  dag.nodes.forEach((node, i) => {
    if (nodeIds.has(node.node)) add(`nodes[${i}].node`, `重复节点 id：${node.node}`);
    nodeIds.add(node.node);
  });
  if (!nodeIds.has(dag.entry)) add("entry", `entry 指向不存在的节点：${dag.entry}`);

  dag.nodes.forEach((node, i) => {
    if (node.goto !== undefined && !nodeIds.has(node.goto)) {
      add(`nodes[${i}].goto`, `未知节点：${node.goto}`);
    }
    (node.options ?? []).forEach((option, j) => {
      if (option.goto !== undefined && !nodeIds.has(option.goto)) {
        add(`nodes[${i}].options[${j}].goto`, `未知节点：${option.goto}`);
      }
    });
  });

  const paramsById = new Map<string, { index: number; kind: string }>();
  dag.params.forEach((param, i) => {
    if (paramsById.has(param.id)) add(`params[${i}].id`, `重复参数 id：${param.id}`);
    paramsById.set(param.id, { index: i, kind: param.kind });
  });

  const attributeIds = new Set(template.attributes.order);
  const styleKnown = (id: string): boolean => styleSpecFor(id, ui) !== undefined;

  dag.params.forEach((param, i) => {
    const path = `params[${i}]`;
    // budgetFrom 必须指向一个 number 参数（它只是「钱从哪来」，不是世界字段）。
    if (param.budgetFrom !== undefined) {
      const ref = paramsById.get(param.budgetFrom);
      if (ref === undefined) {
        add(`${path}.budgetFrom`, `未知参数：${param.budgetFrom}`);
      } else if (ref.kind !== "number") {
        add(`${path}.budgetFrom`, `预算来源必须是 kind=number，实际是 ${ref.kind}：${param.budgetFrom}`);
      }
    }
    if (param.kind !== "points") return;

    let maxSum = 0;
    (param.targets ?? []).forEach((target, j) => {
      const tpath = `${path}.targets[${j}]`;
      if (!attributeIds.has(target.attribute)) {
        add(tpath, `未知属性：${target.attribute}（未在 world.yaml attributes.order 中声明）`);
      } else {
        const kind = attributeKindOf(template, target.attribute);
        if (!NUMERIC_KINDS.has(kind)) {
          add(tpath, `加点目标必须是数值类属性（number/ladder），${target.attribute} 是 ${kind}（ADR-004 D1）`);
        }
        const cap = template.attributes.caps?.[target.attribute];
        if (cap !== undefined && target.max !== undefined && target.max > cap) {
          add(tpath, `max=${target.max} 超过属性上限 ${cap}：${target.attribute}`);
        }
      }
      if (target.style !== undefined && !styleKnown(target.style)) {
        add(`${tpath}.style`, `未知样式 id：${target.style}`);
      }
      maxSum += target.max ?? Number.POSITIVE_INFINITY;
    });

    // 字面预算下可判：所有上限之和 < 预算 ⇒ 这点数永远加不完，属于模板缺陷。
    if (param.budget !== undefined && maxSum < param.budget) {
      add(`${path}.budget`, `预算 ${param.budget} 超过所有 target 上限之和 ${maxSum}`);
    }
  });

  dag.nodes.forEach((node, i) => {
    if (node.mode !== "allocate") return;
    const param = node.param === undefined ? undefined : dag.params.find((p) => p.id === node.param);
    if (node.param !== undefined && param === undefined) {
      add(`nodes[${i}].param`, `未知参数：${node.param}`);
    } else if (param !== undefined && param.kind !== "points") {
      add(`nodes[${i}].param`, `allocate 只能指向 kind=points 参数，实际是 ${param.kind}：${param.id}`);
    }
  });

  validateWeightByParam(dag, paramsById, add);

  return issues;
}

/**
 * ADR-001 D7：`weightByParam` 的加载期校验。
 *
 * 两类拒绝：
 * - `opening_weight_non_roll`：choose / allocate 不是随机抽取，调制权重没有意义；
 * - `opening_weight_param_unresolved`：引用的参数必须**在本节点之前的所有路径上**已落定。
 *
 * 「所有路径」用支配（dominator）判定：写 P 的节点支配当前节点 ⇔ 每条从 entry 到当前的
 * 路径都经过它。图里有环（回跳）时支配关系不再可靠，按约定跳过该检查。
 */
function validateWeightByParam(
  dag: OpeningBranchDag,
  paramsById: Map<string, { index: number; kind: string }>,
  add: (path: string, message: string) => void,
): void {
  const known = new Set(dag.nodes.map((n) => n.node));
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const node of dag.nodes) {
    succ.set(node.node, []);
    pred.set(node.node, []);
  }
  dag.nodes.forEach((node, i) => {
    const fallback = i + 1 < dag.nodes.length ? dag.nodes[i + 1].node : undefined;
    const options = node.options ?? [];
    const targets =
      options.length === 0
        ? [node.goto ?? fallback]
        : options.map((o) => o.goto ?? node.goto ?? fallback);
    for (const target of targets) {
      if (target === undefined || !known.has(target)) continue;
      succ.get(node.node)?.push(target);
      pred.get(target)?.push(node.node);
    }
  });

  // 从 entry 出发的可达子图：不可达节点不参与判定（否则会把「永远走不到」当成隐患）。
  const reachable = new Set<string>();
  const stack = [dag.entry];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (reachable.has(cur) || !known.has(cur)) continue;
    reachable.add(cur);
    for (const nx of succ.get(cur) ?? []) if (!reachable.has(nx)) stack.push(nx);
  }

  // 环检测（仅可达子图）：有回跳 ⇒ 跳过 dominator 检查，避免迭代不收敛。
  const color = new Map<string, 0 | 1 | 2>();
  const hasCycle = ((): boolean => {
    const visit = (n: string): boolean => {
      color.set(n, 1);
      for (const nx of succ.get(n) ?? []) {
        if (!reachable.has(nx)) continue;
        const c = color.get(nx) ?? 0;
        if (c === 1) return true;
        if (c === 0 && visit(nx)) return true;
      }
      color.set(n, 2);
      return false;
    };
    for (const n of reachable) if ((color.get(n) ?? 0) === 0 && visit(n)) return true;
    return false;
  })();

  // 支配集：dom(entry) = {entry}；其余 = 前驱 dom 交集 ∪ {自身}。
  const dom = new Map<string, Set<string>>();
  if (!hasCycle) {
    for (const n of reachable) {
      dom.set(n, n === dag.entry ? new Set([n]) : new Set(reachable));
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of reachable) {
        if (n === dag.entry) continue;
        const ps = (pred.get(n) ?? []).filter((p) => reachable.has(p));
        let next: Set<string>;
        if (ps.length === 0) {
          next = new Set([n]);
        } else {
          next = new Set(dom.get(ps[0]));
          for (const p of ps.slice(1)) {
            const dp = dom.get(p) ?? new Set<string>();
            for (const d of [...next]) if (!dp.has(d)) next.delete(d);
          }
          next.add(n);
        }
        const old = dom.get(n) ?? new Set<string>();
        if (old.size !== next.size || [...next].some((d) => !old.has(d))) {
          dom.set(n, next);
          changed = true;
        }
      }
    }
  }

  // 每个 param 的写者节点（option.set 的键；allocate 节点写自己的 param）。
  const writers = new Map<string, Set<string>>();
  const markWriter = (paramId: string, nodeId: string): void => {
    const set = writers.get(paramId) ?? new Set<string>();
    set.add(nodeId);
    writers.set(paramId, set);
  };
  for (const node of dag.nodes) {
    for (const option of node.options ?? []) {
      for (const paramId of Object.keys(option.set)) markWriter(paramId, node.node);
    }
    if (node.mode === "allocate" && node.param !== undefined) markWriter(node.param, node.node);
  }

  /** P 在 nodeId 处可读 ⇔ 有写者支配 nodeId（且不是自己，roll 时还没写）。 */
  const readableAt = (paramId: string, nodeId: string): boolean => {
    const d = dom.get(nodeId);
    if (d === undefined) return false;
    for (const w of writers.get(paramId) ?? []) {
      if (w !== nodeId && d.has(w)) return true;
    }
    return false;
  };

  dag.nodes.forEach((node, i) => {
    (node.options ?? []).forEach((option, j) => {
      if (option.weightByParam === undefined) return;
      const path = `nodes[${i}].options[${j}].weightByParam`;
      if (node.mode !== "roll") {
        add(path, "opening_weight_non_roll: weightByParam 只对 roll 节点有意义");
        return;
      }
      for (const paramId of Object.keys(option.weightByParam)) {
        if (!paramsById.has(paramId)) {
          add(`${path}.${paramId}`, `opening_weight_param_unresolved: 引用了未声明的参数 ${paramId}`);
          continue;
        }
        if (hasCycle || !reachable.has(node.node)) continue;
        if (!readableAt(paramId, node.node)) {
          add(
            `${path}.${paramId}`,
            `opening_weight_param_unresolved: 参数 ${paramId} 在本节点之前的所有路径上未落定`,
          );
        }
      }
    });
  });
}
