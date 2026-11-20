import { useMemo, useState } from "react";
import type { NpcRelationVM } from "@life-sim/shared";

export interface RelationGraphProps {
  /** 中心节点名（玩家自己）。 */
  selfName: string;
  /**
   * 当前观察者的关系（**两个方向都下发**，`direction` 区分；投影已按观察者收敛过可见性）。
   * 组件只画出边 —— 入边在 NPC 卡那边写着。
   */
  relations: readonly NpcRelationVM[];
  /**
   * 点节点 → 跳过去（打开那个人的档案）。
   * 缺省 ⇒ 节点不可点（只读，例如在别处嵌一份只看的图）。
   */
  onSelectActor?: (actorId: string) => void;
}

/**
 * 关系图（2026-11-20）：以玩家为圆心，对端按环形排布，边按关系类型上色。
 *
 * 为什么是**放射状**而不是力导图：竖屏手机上一屏只有 340×330，力导图的节点会
 * 互相推挤、每次刷新位置都变（同一份数据两次打开长不一样，玩家会以为关系变了）。
 * 环形布局是确定性的：同一个 ID 永远落在同一个角度，视觉记忆才成立。
 *
 * **只画他这一侧的出边**（2026-11-20 用户裁决）：一张图回答「我视谁为什么」。
 * 入边（「他视你为什么」）是同一段亲缘的另一半，画进来会让每条亲缘变成两条反向的线；
 * 它在 NPC 卡的「关系」里已经写着，图谱不重复。
 *
 * 颜色只用来区分**边类型**（父亲 / 妻子 / 主君…），不代表亲密程度：亲密度在档位文案里
 * （`valueLabel`），用颜色再编码一次会让两条不同含义的轴互相污染。
 */
export function RelationGraph({ selfName, relations, onSelectActor }: RelationGraphProps) {
  /** 被关掉的边类型（缺省全开：进页面先看到全景，再按需筛）。 */
  const [mutedKinds, setMutedKinds] = useState<ReadonlySet<string>>(new Set());

  /** 边类型清单：按出现次数降序，同次数按 id 排（确定性，不随数据顺序抖动）。 */
  const kinds = useMemo(() => {
    const count = new Map<string, { kind: string; label: string; count: number }>();
    for (const rel of relations) {
      // 入边不进图，也不该出现在筛选条的计数里（点不掉的东西不该出现）。
      if (rel.direction === "in") continue;
      const hit = count.get(rel.kind);
      if (hit === undefined) {
        // 标签用**类型名**（`relative` → 「亲戚」），不用行称谓：推导行里那是个人的叫法
        // （爷爷 / 舅舅 / 叔公），拿它当类型名会出现「爷爷 7」。
        count.set(rel.kind, { kind: rel.kind, label: rel.typeLabel ?? rel.kindLabel, count: 1 });
      }
      else hit.count += 1;
    }
    return [...count.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  }, [relations]);

  /**
   * 只保留出边：图谱回答「我视谁为什么」，一条边一段话。
   * 入边留给 NPC 卡（那边写的是「他视你为 X」），两边各说一半，不互相抄。
   */
  const visibleEdges = useMemo(
    () => relations.filter((rel) => rel.direction !== "in" && !mutedKinds.has(rel.kind)),
    [relations, mutedKinds],
  );

  const layout = useMemo(() => {
    /** 一个对端一个节点；同一对端的多条边挂在同一个节点上（只画边，不复制节点）。 */
    const byActor = new Map<string, { id: string; name: string; edges: NpcRelationVM[] }>();
    for (const rel of visibleEdges) {
      const hit = byActor.get(rel.withId);
      if (hit === undefined) {
        byActor.set(rel.withId, {
          id: rel.withId,
          name: rel.withName ?? rel.withId,
          edges: [rel],
        });
      } else hit.edges.push(rel);
    }
    const nodes = [...byActor.values()];

    /*
     * 环容量：12 / 8 / 6。三档之内够放 26 个对端，超出就不画了 ——
     * 与其把 30 个名字挤成一团，不如承认这一屏只画得下前 26 个（模板里没有这种量级）。
     */
    const CAPS = [12, 8, 6];
    const RADII = [96, 68, 46];
    const placed: Array<{
      id: string;
      name: string;
      edges: NpcRelationVM[];
      x: number;
      y: number;
      angle: number;
      visible: boolean;
      stateLabel?: string;
    }> = [];
    let cursor = 0;
    for (let ring = 0; ring < CAPS.length && cursor < nodes.length; ring += 1) {
      const take = Math.min(CAPS[ring]!, nodes.length - cursor);
      const slice = nodes.slice(cursor, cursor + take);
      slice.forEach((node, i) => {
        // 从正上方开始顺时针，确定性（同一份数据两次打开落在同一处）。
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / take;
        placed.push({
          ...node,
          angle,
          x: CX + RADII[ring]! * Math.cos(angle),
          y: CY + RADII[ring]! * Math.sin(angle),
          visible: node.edges[0]?.counterpartVisible !== false,
          ...(node.edges[0]?.counterpartStateLabel !== undefined
            ? { stateLabel: node.edges[0].counterpartStateLabel }
            : {}),
        });
      });
      cursor += take;
    }
    return { placed, overflow: Math.max(0, nodes.length - placed.length) };
  }, [visibleEdges]);

  if (relations.length === 0) {
    return <p className="muted">尚无已知的人际关系。</p>;
  }

  const toggle = (kind: string) => {
    setMutedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  return (
    <div className="relgraph">
      <div className="relgraph-filters" role="group" aria-label="按关系类型筛选">
        {kinds.map((entry, i) => {
          const active = !mutedKinds.has(entry.kind);
          return (
            <button
              key={entry.kind}
              type="button"
              className={`relgraph-chip${active ? " is-on" : ""}`}
              aria-pressed={active}
              onClick={() => toggle(entry.kind)}
              // 颜色与图上的边同源（同一个调色板、同一个下标）。
              style={{ color: active ? KIND_COLORS[i % KIND_COLORS.length] : undefined }}
            >
              <span
                className="relgraph-chip__dot"
                style={{ background: KIND_COLORS[i % KIND_COLORS.length] }}
                aria-hidden="true"
              />
              {entry.label}
              {entry.count > 1 && <span className="relgraph-chip__count">{entry.count}</span>}
            </button>
          );
        })}
      </div>

      <svg
        className="relgraph-canvas"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="group"
        aria-label={`${selfName}的关系图，共 ${visibleEdges.length} 条关系`}
      >
        <defs>
          {KIND_COLORS.map((color, i) => (
            <marker
              key={color}
              id={`relgraph-arrow-${i}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="5"
              markerHeight="5"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill={color} />
            </marker>
          ))}
        </defs>

        {/* 边先画，节点压在上面 */}
        {layout.placed.map((node) =>
          node.edges.map((edge, i) => {
            const colorIndex = kinds.findIndex((k) => k.kind === edge.kind);
            const color = KIND_COLORS[Math.max(0, colorIndex) % KIND_COLORS.length]!;
            const dx = node.x - CX;
            const dy = node.y - CY;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            // 同一对端的多条边错开一点弧度，否则会重合成一条线。
            const bend = (i - (node.edges.length - 1) / 2) * 16;
            const px = -uy * bend;
            const py = ux * bend;
            const start = { x: CX + ux * CENTER_R, y: CY + uy * CENTER_R };
            const end = { x: node.x - ux * (NODE_R + 4), y: node.y - uy * (NODE_R + 4) };
            const mid = { x: (start.x + end.x) / 2 + px, y: (start.y + end.y) / 2 + py };
            /*
             * 入边的路径**反向画**（对端 → 我）：这样箭头永远在 `marker-end`，
             * 不必依赖 `orient="auto-start-reverse"`（部分 WebView 还不认）。
             */
            const d = `M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`;
            return (
              <path
                key={`${node.id}-${edge.kind}-${i}`}
                d={d}
                className="relgraph-edge"
                stroke={color}
                markerEnd={`url(#relgraph-arrow-${Math.max(0, colorIndex) % KIND_COLORS.length})`}
              />
            );
          }),
        )}

        {/* 圆心：玩家自己 */}
        <g className="relgraph-self">
          <circle cx={CX} cy={CY} r={CENTER_R} />
          <text x={CX} y={CY + 4} textAnchor="middle" className="relgraph-self__text">
            {selfName.length <= 4 ? selfName : `${selfName.slice(0, 3)}…`}
          </text>
        </g>

        {layout.placed.map((node) => {
          const outward = 18;
          const lx = node.x + Math.cos(node.angle) * outward;
          const ly = node.y + Math.sin(node.angle) * outward + 4;
          const anchor = Math.cos(node.angle) > 0.35 ? "start" : Math.cos(node.angle) < -0.35 ? "end" : "middle";
          const clickable = node.visible && onSelectActor !== undefined;
          const stateLabel = node.stateLabel ?? (node.visible ? undefined : "尚未登场");
          return (
            <g
              key={node.id}
              className={`relgraph-node${clickable ? " is-clickable" : " is-blocked"}`}
              {...(clickable
                ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: () => onSelectActor?.(node.id),
                    onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectActor?.(node.id);
                      }
                    },
                  }
                : {})}
            >
              <circle cx={node.x} cy={node.y} r={NODE_R} />
              <text x={lx} y={ly} textAnchor={anchor} className="relgraph-node__name">
                {node.name}
              </text>
              {stateLabel !== undefined && (
                <text x={lx} y={ly + 11} textAnchor={anchor} className="relgraph-node__state">
                  {stateLabel}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {layout.overflow > 0 && (
        <p className="relgraph-legend muted" role="note">
          还有 {layout.overflow} 段关系没有画进这张图（收窄类型筛选可以腾出位置）。
        </p>
      )}

      <p className="relgraph-legend muted">
        箭头从{selfName}指向对方：那是{selfName}视他为某种关系。点节点可看档案。
      </p>
    </div>
  );
}

/** 画布尺寸与半径集中在这里：布局是确定性的，同一份数据每次落在同一处。 */
const WIDTH = 340;
const HEIGHT = 330;
const CX = WIDTH / 2;
const CY = 168;
const CENTER_R = 26;
const NODE_R = 9;

/**
 * 边类型调色板：只区分类型，不代表亲疏。
 * 选的是在深色底与浅色底上都能读的一档饱和度（宿主两套主题都会用到）。
 */
const KIND_COLORS = [
  "#c9a227",
  "#7fa8ff",
  "#6fbf9b",
  "#d97b8a",
  "#b38bff",
  "#e0894a",
  "#8fb8b8",
  "#c2c2a0",
] as const;
