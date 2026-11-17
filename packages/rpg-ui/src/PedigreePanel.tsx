import { useState } from "react";
import type { PedigreeEdgeVM, PedigreeNodeVM, PedigreeVM } from "@life-sim/shared";

/**
 * 族谱面板（`docs/CLAN-DESIGN.md` §1.6）。
 *
 * 只吃 `PedigreeVM`：世代号、配偶序、有没有卡、生死态**全部是服务端口径**，
 * 组件不读快照、不按关系边自己算辈分（前端只有出边，根本算不出「我的孩子是谁」）。
 *
 * 交互只有一条：点 `hasCard` 的节点交给宿主导航，`isSelf` 交给宿主开玩家面板；
 * 选中态归宿主（`packages/rpg-ui` 的既有约定）。点无档案的节点只给一行非模态提示。
 */

/** 画布几何：竖屏优先，同代横排、世代自上而下（老在上）。 */
const NODE_W = 108;
const NODE_H = 60;
const COL_GAP = 14;
const ROW_GAP = 52;
const PAD = 10;

/** 文案常量表：组件不写死任何世界观专名，宿主可用 props 覆盖标题。 */
const LABELS = {
  title: "族谱",
  empty: "这段关系里还没有可画的亲缘。",
  noCard: "无档案",
  incomplete: "有些人的父母不在已知范围内，谱系不完整。",
  truncated: "谱系已按规模截断，只显示与你最近的那几代。",
  looseEnds: "据称的远亲",
  legend: {
    parent: "血缘",
    spouse: "姻亲",
    step: "继亲",
    back: "回边",
  },
  ordinal: (n: number): string => `第 ${n} 位配偶`,
  age: (n: number): string => `${n} 岁`,
  generation: (n: number): string => `第 ${n} 代`,
  lifeState: {
    alive: "",
    inactive: "已离场",
    unspawned: "尚未登场",
  } as Record<string, string>,
} as const;

export interface PedigreePanelProps {
  pedigree: PedigreeVM;
  /** 点一个有档案的 NPC：宿主负责打开那张卡（本组件不导航）。 */
  onSelectNpc?: (id: string) => void;
  /** 点「自己」：宿主负责切到玩家面板。 */
  onSelectSelf?: () => void;
  /** 面板标题（缺省「族谱」）。 */
  title?: string;
}

interface Placed {
  readonly node: PedigreeNodeVM;
  readonly x: number;
  readonly y: number;
  readonly row: number;
}

/** 同代内把配偶排到一起（其余按 id 升序），再按行分列。 */
function layout(pedigree: PedigreeVM): {
  placed: Placed[];
  width: number;
  height: number;
} {
  const spouseOf = new Map<string, string[]>();
  for (const e of pedigree.edges) {
    if (e.kind !== "spouse") continue;
    const a = spouseOf.get(e.from);
    if (a) a.push(e.to);
    else spouseOf.set(e.from, [e.to]);
    const b = spouseOf.get(e.to);
    if (b) b.push(e.from);
    else spouseOf.set(e.to, [e.from]);
  }

  const byGen = new Map<number, PedigreeNodeVM[]>();
  for (const node of pedigree.nodes) {
    const list = byGen.get(node.generation);
    if (list) list.push(node);
    else byGen.set(node.generation, [node]);
  }
  const generations = [...byGen.keys()].sort((a, b) => a - b);

  const placed: Placed[] = [];
  let maxCols = 0;
  generations.forEach((gen, row) => {
    const pool = [...byGen.get(gen)!].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const emitted = new Set<string>();
    const ordered: PedigreeNodeVM[] = [];
    for (const node of pool) {
      if (emitted.has(node.id)) continue;
      emitted.add(node.id);
      ordered.push(node);
      // 配偶相邻：只有同代的配偶才并到这一行。
      for (const partnerId of (spouseOf.get(node.id) ?? []).slice().sort()) {
        if (emitted.has(partnerId)) continue;
        const partner = pool.find((p) => p.id === partnerId);
        if (partner === undefined) continue;
        emitted.add(partnerId);
        ordered.push(partner);
      }
    }
    maxCols = Math.max(maxCols, ordered.length);
    ordered.forEach((node, col) => {
      placed.push({
        node,
        x: PAD + col * (NODE_W + COL_GAP),
        y: PAD + row * (NODE_H + ROW_GAP),
        row,
      });
    });
  });

  return {
    placed,
    width: PAD * 2 + Math.max(1, maxCols) * (NODE_W + COL_GAP) - COL_GAP,
    height: PAD * 2 + Math.max(1, generations.length) * (NODE_H + ROW_GAP) - ROW_GAP,
  };
}

function edgePath(
  edge: PedigreeEdgeVM,
  at: (id: string) => Placed | undefined,
): { d: string; cls: string } | null {
  const from = at(edge.from);
  const to = at(edge.to);
  if (from === undefined || to === undefined) return null;

  const fx = from.x + NODE_W / 2;
  const fy = from.y + NODE_H / 2;
  const tx = to.x + NODE_W / 2;
  const ty = to.y + NODE_H / 2;

  if (edge.kind === "spouse") {
    // 同一行且相邻 ⇒ 水平直线；否则从上方绕一道弧（不让线穿过别人的名字）。
    const sameRow = from.row === to.row;
    if (sameRow && Math.abs(from.x - to.x) <= NODE_W + COL_GAP + 1) {
      const x1 = from.x < to.x ? from.x + NODE_W : from.x;
      const x2 = from.x < to.x ? to.x : to.x + NODE_W;
      return { d: `M ${x1} ${fy} L ${x2} ${ty}`, cls: "ls-pedigree__edge--spouse" };
    }
    const lift = 26;
    const midY = Math.min(from.y, to.y) - lift;
    return {
      d: `M ${fx} ${from.y} C ${fx} ${midY}, ${tx} ${midY}, ${tx} ${to.y}`,
      cls: "ls-pedigree__edge--spouse",
    };
  }

  if (edge.kind === "sibling") {
    const midY = Math.min(from.y, to.y) - 18;
    return {
      d: `M ${fx} ${from.y} C ${fx} ${midY}, ${tx} ${midY}, ${tx} ${to.y}`,
      cls: "ls-pedigree__edge--sibling",
    };
  }

  // parent：从父/母下沿到子女上沿。回边（近亲婚配）画成侧向弧线，避免与正常父子线纠缠。
  const sx = from.x + NODE_W / 2;
  const sy = from.y + NODE_H;
  const ex = to.x + NODE_W / 2;
  const ey = to.y;
  if (edge.back === true) {
    const bow = Math.min(140, Math.abs(ex - sx) + 70);
    const dir = ex >= sx ? 1 : -1;
    return {
      d: `M ${sx} ${sy} C ${sx + dir * bow} ${sy + 30}, ${ex + dir * bow} ${ey - 30}, ${ex} ${ey}`,
      cls: "ls-pedigree__edge--back",
    };
  }
  if (edge.step === true) {
    const midY = (sy + ey) / 2;
    return {
      d: `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`,
      cls: "ls-pedigree__edge--step",
    };
  }
  const midY = (sy + ey) / 2;
  return {
    d: `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`,
    cls: "ls-pedigree__edge--parent",
  };
}

function lifeText(node: PedigreeNodeVM): string {
  const reason = node.lifecycle.reasonCode?.trim();
  if (reason !== undefined && reason !== "") return reason;
  return LABELS.lifeState[node.lifecycle.state] ?? "";
}

export function PedigreePanel({ pedigree, onSelectNpc, onSelectSelf, title }: PedigreePanelProps) {
  const [notice, setNotice] = useState<string | null>(null);

  if (pedigree.nodes.length === 0) {
    return (
      <section className="ls-pedigree">
        <header className="ls-pedigree__head">
          <h3 className="ls-pedigree__title">{title ?? LABELS.title}</h3>
        </header>
        <p className="ls-pedigree__empty">{LABELS.empty}</p>
      </section>
    );
  }

  const { placed, width, height } = layout(pedigree);
  const byId = new Map(placed.map((p) => [p.node.id, p]));

  const select = (node: PedigreeNodeVM): void => {
    if (node.isSelf) {
      onSelectSelf?.();
      return;
    }
    if (!node.hasCard) {
      setNotice(`${node.name} · ${LABELS.noCard}`);
      return;
    }
    onSelectNpc?.(node.id);
  };

  return (
    <section className="ls-pedigree">
      <header className="ls-pedigree__head">
        <h3 className="ls-pedigree__title">{title ?? LABELS.title}</h3>
        <span className="ls-pedigree__range">
          {LABELS.generation(pedigree.generationRange.min)} – {LABELS.generation(pedigree.generationRange.max)}
        </span>
      </header>

      <ul className="ls-pedigree__legend">
        <li className="ls-pedigree__legend-item ls-pedigree__legend-item--parent">{LABELS.legend.parent}</li>
        <li className="ls-pedigree__legend-item ls-pedigree__legend-item--spouse">{LABELS.legend.spouse}</li>
        <li className="ls-pedigree__legend-item ls-pedigree__legend-item--step">{LABELS.legend.step}</li>
        <li className="ls-pedigree__legend-item ls-pedigree__legend-item--back">{LABELS.legend.back}</li>
      </ul>

      {notice !== null && <p className="ls-pedigree__notice">{notice}</p>}

      <div className="ls-pedigree__scroll">
        <div className="ls-pedigree__canvas" style={{ width, height }}>
          <svg className="ls-pedigree__edges" width={width} height={height} aria-hidden="true">
            {pedigree.edges.map((edge, i) => {
              const path = edgePath(edge, (id) => byId.get(id));
              if (path === null) return null;
              return <path key={`${edge.kind}-${edge.from}-${edge.to}-${i}`} className={path.cls} d={path.d} />;
            })}
          </svg>

          {placed.map(({ node, x, y }) => {
            const dead = node.lifecycle.state !== "alive";
            const cls = [
              "ls-pedigree__node",
              node.isSelf ? "ls-pedigree__node--self" : "",
              node.hasCard ? "" : "ls-pedigree__node--nocard",
              dead ? "ls-pedigree__node--dead" : "",
              node.cyclic === true ? "ls-pedigree__node--cyclic" : "",
            ]
              .filter((s) => s !== "")
              .join(" ");
            return (
              <button
                key={node.id}
                type="button"
                className={cls}
                style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
                onClick={() => select(node)}
                title={`${node.name}${node.lifeStageLabel !== "" ? ` · ${node.lifeStageLabel}` : ""}`}
              >
                <span className="ls-pedigree__name">{node.name}</span>
                <span className="ls-pedigree__meta">
                  {LABELS.age(node.age)}
                  {node.genderLabel !== "" ? ` · ${node.genderLabel}` : ""}
                </span>
                <span className="ls-pedigree__meta">
                  {dead ? lifeText(node) : ""}
                  {node.spouseOrdinal !== undefined ? ` ${LABELS.ordinal(node.spouseOrdinal)}` : ""}
                </span>
                {!node.hasCard && <span className="ls-pedigree__nocard">{LABELS.noCard}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {pedigree.incomplete === true && <p className="ls-pedigree__hint">{LABELS.incomplete}</p>}
      {pedigree.truncated === true && <p className="ls-pedigree__hint">{LABELS.truncated}</p>}

      {pedigree.looseEnds !== undefined && pedigree.looseEnds.length > 0 && (
        <div className="ls-pedigree__loose">
          <h4 className="ls-pedigree__loose-title">{LABELS.looseEnds}</h4>
          <div className="ls-pedigree__loose-list">
            {pedigree.looseEnds.map((loose) => (
              <span key={loose.id} className="ls-pedigree__loose-item">
                {loose.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
