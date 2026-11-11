import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { api } from "./api";
import type { BattleCommand, EndingView, TemplateSummary, V2Snapshot, WheelResultView, WorldSummary } from "./api";

// ---------- 工具 ----------

const UNIT_NAMES: Record<string, string> = {
  minute: "分钟",
  hour: "小时",
  day: "天",
  week: "周",
  month: "月",
  year: "年",
};

// 显示名一律由模板下发（snapshot.labels），前端不维护世界观词表。

function elapsedText(elapsed: { value: number; unit: string }): string {
  return `${elapsed.value} ${UNIT_NAMES[elapsed.unit] ?? elapsed.unit}`;
}

// ---------- 装备 ----------

/**
 * 装备投影已落地（协议 §19 / ADR-0008）：V2Snapshot.player.equipment 为可选字段
 * （旧存档 / 未配置装备的模板缺省），元素类型直接从 shared 视图类型派生，
 * 前端不再本地重复声明字段。展示层只读展示字段，补正结果属内核现算状态，不接触。
 */
type EquipmentView = NonNullable<V2Snapshot["player"]["equipment"]>[number];
type EquipmentSlotView = NonNullable<V2Snapshot["equipmentSlots"]>[number];
type InventoryView = V2Snapshot["player"]["inventory"][number];

function equipmentOf(player: V2Snapshot["player"]): EquipmentView[] {
  return player.equipment ?? [];
}

interface SlotCell {
  key: string;
  slotId: string;
  slotLabel: string;
  index: number;
  capacity: number;
  /** 人物面板摆位（ADR-0009）：left / right 左右两列，bottom 底部方块区 */
  side: "left" | "right" | "bottom";
  instance: EquipmentView | null;
}

/**
 * 槽位定义 → 格子：**槽位全集、格数与摆位全部由模板投影下发**（R-EQ-11 / R-EQ-15），
 * 前端不猜槽位名、不猜件数、也不从「已装备实例」反推槽位（否则空槽会消失）。
 * 同一槽位内按投影顺序落格，多余实例（理论上不会出现）舍弃不渲染。
 */
function buildSlotCells(slots: EquipmentSlotView[], equipment: EquipmentView[]): SlotCell[] {
  return slots.flatMap((slot) => {
    const worn = equipment.filter((e) => e.slot === slot.id);
    return Array.from({ length: slot.maxCount }, (_, i) => ({
      key: `${slot.id}-${i}`,
      slotId: slot.id,
      slotLabel: slot.label,
      index: i,
      capacity: slot.maxCount,
      side: slot.panelSide,
      instance: worn[i] ?? null,
    }));
  });
}

const ITEM_TYPE_LABEL: Record<InventoryView["type"], string> = {
  equipment: "装备",
  consumable: "消耗品",
  material: "材料",
  key: "关键物品",
};

/** 方格内的类别字形（纯文字符号，不引入图标库）。 */
function itemGlyph(type: InventoryView["type"]): string {
  switch (type) {
    case "equipment":
      return "◈";
    case "consumable":
      return "✚";
    case "material":
      return "❖";
    default:
      return "▣";
  }
}

// ---------- 组件 ----------

type Tab = "life" | "people" | "personal" | "world" | "log";

interface LastResult {
  elapsed: string;
  events: Array<{ id: string; title: string; narrative: string }>;
  wheel: WheelResultView | null;
}

function App() {
  const [worldId, setWorldId] = useState<string | null>(loadWorldId());
  const [snapshot, setSnapshot] = useState<V2Snapshot | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [tab, setTab] = useState<Tab>("life");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  // 竞态锁：React state 同帧不生效，双击会双发请求（第二个撞 409）——用 ref 同步判断
  const busyRef = React.useRef(false);
  const worldIdRef = React.useRef<string | null>(worldId);
  worldIdRef.current = worldId;

  useEffect(() => {
    if (!worldId) return;
    api
      .getWorld(worldId)
      .then((res) => setSnapshot(res.snapshot))
      .catch(() => {
        // localStorage 里的 worldId 已失效（存档被删 / 坏档被跳过）：
        // 回到列表并提示，而不是静默吞掉（R-PS-04 / design §3.8）
        clearWorldId();
        setWorldId(null);
        setNotice("这一局已不存在（可能已被删除），已回到列表。");
      });
  }, [worldId]);

  useEffect(() => {
    if (worldId) return;
    api.listTemplates().then((res) => setTemplates(res.templates)).catch((e) => setError(String(e)));
    api.listWorlds().then((res) => setWorlds(res.worlds)).catch((e) => setError(String(e)));
  }, [worldId]);

  const refreshWorlds = useCallback(() => {
    api.listWorlds().then((res) => setWorlds(res.worlds)).catch(() => {/* 列表刷新失败不阻断 */});
  }, []);

  const openWorld = useCallback((id: string) => {
    setNotice(null);
    saveWorldId(id);
    setWorldId(id);
  }, []);

  const deleteWorld = useCallback(
    (id: string) => {
      if (!window.confirm("删除这一局？存档文件将被移除，无法恢复。")) return;
      api
        .deleteWorld(id)
        .then(() => refreshWorlds())
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [refreshWorlds],
  );

  const handleCreated = useCallback((id: string, snap: V2Snapshot) => {
    saveWorldId(id);
    setWorldId(id);
    setSnapshot(snap);
    setTab("life");
    setNotice(null);
    setLastResult(null);
  }, []);

  const wrap = useCallback(
    async (
      fn: () => Promise<{ snapshot: V2Snapshot; triggeredEvents?: LastResult["events"]; wheelResult?: WheelResultView | null; elapsed?: { value: number; unit: string } }>,
      translateError?: (e: unknown) => string,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await fn();
        setSnapshot(res.snapshot);
        setLastResult({
          elapsed: res.elapsed ? elapsedText(res.elapsed) : "",
          events: res.triggeredEvents ?? [],
          wheel: res.wheelResult ?? null,
        });
      } catch (e) {
        const status = (e as Error & { status?: number }).status;
        if (status === 409) {
          // 409 = 交互顺序冲突（事件待决/战斗中）：服务器状态是权威，静默刷新而非报错
          const wid = worldIdRef.current;
          if (wid) {
            try {
              const fresh = await api.getWorld(wid);
              setSnapshot(fresh.snapshot);
            } catch {
              /* 刷新失败则忽略，保留当前画面 */
            }
          }
          // 穿脱的 409（槽位冲突）给可读文案而不是静默
          if (translateError) setError(translateError(e));
        } else {
          setError(translateError ? translateError(e) : e instanceof Error ? e.message : String(e));
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [],
  );

  const advance = useCallback(
    (action: { type: string; description: string }) =>
      worldId ? wrap(() => api.advanceTurn(worldId, action)) : undefined,
    [worldId, wrap],
  );

  const choose = useCallback(
    (optionId: string) => (worldId ? wrap(() => api.chooseOption(worldId, optionId)) : undefined),
    [worldId, wrap],
  );

  const battle = useCallback(
    (command: BattleCommand) => (worldId ? wrap(() => api.battleAction(worldId, command)) : undefined),
    [worldId, wrap],
  );

  const useItem = useCallback(
    (itemId: string) => (worldId ? wrap(() => api.useItem(worldId, itemId)) : undefined),
    [worldId, wrap],
  );

  // 装备穿脱（T5-03 / R-EQ-09）：失败时把错误码翻成可读文案
  const EQUIP_ERROR_TEXT: Record<string, string> = {
    slot_full: "槽位已满，请先卸下同类装备再试",
    slot_category_mismatch: "品类与槽位不符，换一件合适的装备吧",
    slot_not_found: "该槽位未在世界模板中声明",
    item_not_equipment: "这件物品不是装备",
    not_owned: "背包中没有这件装备",
    instance_not_found: "这件装备已不在装备栏（可能已被卸下）",
    item_not_found: "物品不存在",
  };
  const equipErrorText = useCallback((e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const code = /请求失败：(\w+)/.exec(raw)?.[1];
    return (code && EQUIP_ERROR_TEXT[code]) || raw;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const equip = useCallback(
    (itemId: string) => (worldId ? wrap(() => api.equipItem(worldId, itemId), equipErrorText) : undefined),
    [worldId, wrap, equipErrorText],
  );

  const unequip = useCallback(
    (instanceId: string) => (worldId ? wrap(() => api.unequipItem(worldId, instanceId), equipErrorText) : undefined),
    [worldId, wrap, equipErrorText],
  );

  const archive = useCallback(async () => {
    const wid = worldIdRef.current;
    if (!wid || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.archiveWorld(wid);
      const fresh = await api.getWorld(wid);
      setSnapshot(fresh.snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const endLife = useCallback(() => {
    const wid = worldIdRef.current;
    if (!wid) return;
    if (!window.confirm("结束这一生？本局会立即收束为结局，之后只能封存或重开。")) return;
    void wrap(() => api.advanceTurn(wid, { type: "free", description: "" }, true));
  }, [wrap]);

  const reset = useCallback(() => {
    clearWorldId();
    setWorldId(null);
    setSnapshot(null);
    setNotice(null);
    setLastResult(null);
  }, []);

  if (!worldId || !snapshot) {
    return (
      <>
        {notice && (
          <div className="banner info" onClick={() => setNotice(null)}>
            {notice}
          </div>
        )}
        <SetupScreen
          templates={templates}
          worlds={worlds}
          error={error}
          onCreated={handleCreated}
          onOpen={openWorld}
          onDelete={deleteWorld}
        />
      </>
    );
  }

  const battleActive = snapshot.battle !== null && snapshot.battle.over === null;
  const interacting = battleActive || snapshot.pendingEvent !== null;

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{snapshot.worldName}</p>
          <h1 className="clock">{snapshot.formattedTime}</h1>
        </div>
        <div className="topbar-right">
          <span className="chip">第 {snapshot.turnIndex} 轮</span>
          <button className="ghost" onClick={reset}>重开</button>
        </div>
      </header>

      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}

      <main className="content">
        {tab === "life" && (
          <LifeTab
            snapshot={snapshot}
            busy={busy}
            lastResult={lastResult}
            onAdvance={advance}
            onChoose={choose}
            onBattle={battle}
            onUseItem={useItem}
            onArchive={archive}
            onEndLife={endLife}
          />
        )}
        {tab === "people" && <PeopleTab snapshot={snapshot} />}
        {tab === "personal" && (
          <PersonalTab snapshot={snapshot} busy={busy} onUseItem={useItem} onEquip={equip} onUnequip={unequip} />
        )}
        {tab === "world" && <WorldTab snapshot={snapshot} />}
        {tab === "log" && <LogTab snapshot={snapshot} />}
      </main>

      <nav className="tabbar">
        {(
          [
            ["life", "人生", "◈"],
            ["people", "人物", "☺"],
            ["personal", "个人", "▣"],
            ["world", "世界", "◍"],
            ["log", "记录", "≡"],
          ] as const
        ).map(([key, label, icon]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            <span className="icon">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
      {interacting && <div className="interact-hint">{battleActive ? "⚔ 战斗进行中" : "⚡ 事件待决"}</div>}
    </div>
  );
}

// ---------- 创建世界 ----------

const STATUS_LABELS: Record<WorldSummary["status"], { label: string; cls: string }> = {
  running: { label: "进行中", cls: "st-running" },
  terminated: { label: "已收束", cls: "st-terminated" },
  archived: { label: "已封存", cls: "st-archived" },
};

function WorldList({
  worlds,
  onOpen,
  onDelete,
}: {
  worlds: WorldSummary[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (worlds.length === 0) {
    return <p className="muted">还没有存档。在下方新建你的第一局。</p>;
  }
  return (
    <section className="card">
      <span className="tag">我的世界</span>
      <ul className="world-list">
        {worlds.map((w) => {
          const st = STATUS_LABELS[w.status];
          return (
            <li key={w.id} className="world-item">
              <button className="world-open" onClick={() => onOpen(w.id)}>
                <div className="world-line">
                  <strong>{w.playerName}</strong>
                  <span className={`badge ${st.cls}`}>{st.label}</span>
                </div>
                <div className="world-line muted">
                  <span>{w.templateName}</span>
                  <span>第 {w.turnIndex} 轮 · {w.formattedTime}</span>
                </div>
                {w.endingTitle && <div className="world-line muted">结局：{w.endingTitle}</div>}
              </button>
              <button className="ghost world-delete" onClick={() => onDelete(w.id)}>
                删除
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SetupScreen({
  templates,
  worlds,
  error,
  onCreated,
  onOpen,
  onDelete,
}: {
  templates: TemplateSummary[];
  worlds: WorldSummary[];
  error: string | null;
  onCreated: (id: string, snapshot: V2Snapshot) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [seed, setSeed] = useState("");
  const [openingId, setOpeningId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const openings = templates[0]?.openings ?? [];

  const start = async () => {
    if (!name.trim()) {
      setLocalError("请先给角色起一个名字");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      const template = templates[0];
      const parsedSeed = seed.trim() === "" ? undefined : Number.parseInt(seed.trim(), 10);
      const res = await api.createWorld(
        template?.id ?? "jjk-2006",
        name.trim(),
        Number.isFinite(parsedSeed) ? parsedSeed : undefined,
        openingId === "" ? undefined : openingId,
      );
      onCreated(res.worldId, res.snapshot);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell setup">
      <header>
        <p className="eyebrow">AI LIFE SIMULATOR · DEMO</p>
        <h1>人生模拟器</h1>
        <p className="muted">世界不会因你停下。你的故事，从这里开始。</p>
      </header>

      {templates.map((t) => (
        <section key={t.id} className="card">
          <span className="tag">{t.startYear} · 世界模板</span>
          <h2>{t.name}</h2>
          <p className="muted">{t.description}</p>
        </section>
      ))}

      <WorldList worlds={worlds} onOpen={onOpen} onDelete={onDelete} />

      <section className="card form">
        <label>
          <span>角色姓名</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：乙羽遥" maxLength={20} />
        </label>
        {openings.length > 1 && (
          <label>
            <span>开局（起始关系与首个事件不同）</span>
            <select value={openingId} onChange={(e) => setOpeningId(e.target.value)}>
              <option value="">默认（{openings[0]?.name}）</option>
              {openings.slice(1).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>世界种子（可选，相同种子可复现）</span>
          <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="留空随机" inputMode="numeric" />
        </label>
        {(localError || error) && <p className="error-text">{localError ?? error}</p>}
        <button className="primary" disabled={busy} onClick={start}>
          {busy ? "正在构建世界…" : "进入这个世界"}
        </button>
      </section>
    </main>
  );
}

// ---------- 玩家状态卡 ----------

function PlayerCard({ snapshot }: { snapshot: V2Snapshot }) {
  const p = snapshot.player;
  const labels = snapshot.labels;
  const labelOrder = Object.keys(labels.attributes);
  const rankOf = (key: string) => {
    const idx = labelOrder.indexOf(key);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  const attrEntries = Object.entries(p.attributes)
    .filter(([key]) => !key.startsWith("proficiency"))
    .sort(([a], [b]) => rankOf(a) - rankOf(b));
  return (
    <section className="card player-card">
      <div className="row">
        <h2>{p.name}</h2>
        <span className="tag">{p.age} 岁 · {p.genderLabel}</span>
      </div>
      <div className="attrs">
        <ResourceBar label={labels.resources.hp ?? "hp"} value={p.hp} max={p.maxHp} cls="hp" />
        <ResourceBar label={labels.resources.mp ?? "mp"} value={p.mp} max={p.maxMp} cls="mp" />
        <ResourceBar label={`${labels.mood} · ${p.moodBandLabel}`} value={p.mood} max={100} cls="mood" />
      </div>
      <div className="attrs">
        {attrEntries.map(([key, value]) => (
          <div key={key} className="attr">
            <span className="attr-name">{labels.attributes[key] ?? key}</span>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${Math.min(100, Math.max(4, Number(value)))}%` }} />
            </div>
            <span className="attr-value">{String(value)}</span>
          </div>
        ))}
      </div>
      {p.statuses.length > 0 && (
        <div className="status-chips">
          {p.statuses.map((s) => (
            <span key={s.id} className="chip status-chip">
              {s.name}{s.stacks > 1 ? `×${s.stacks}` : ""}
            </span>
          ))}
        </div>
      )}
      <p className="eval-line">{snapshot.evaluation.summary}</p>
    </section>
  );
}

function ResourceBar({ label, value, max, cls }: { label: string; value: number; max: number; cls: string }) {
  const pct = Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
  return (
    <div className="attr">
      <span className="attr-name">{label}</span>
      <div className="bar">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="attr-value">{value}/{max}</span>
    </div>
  );
}

// ---------- 人生 Tab ----------

function LifeTab({
  snapshot,
  busy,
  lastResult,
  onAdvance,
  onChoose,
  onBattle,
  onUseItem,
  onArchive,
  onEndLife,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  lastResult: LastResult | null;
  onAdvance: (action: { type: string; description: string }) => void;
  onChoose: (optionId: string) => void;
  onBattle: (command: BattleCommand) => void;
  onUseItem: (itemId: string) => void;
  onArchive: () => void;
  onEndLife: () => void;
}) {
  // 已终止 / 已归档：世界不再接受动作，只呈现结局（服务端同时清空 availableActions）
  const ended = snapshot.status === "terminated" || snapshot.status === "archived";
  return (
    <div className="stack">
      <PlayerCard snapshot={snapshot} />

      {ended && snapshot.ending && (
        <EndingPanel
          ending={snapshot.ending}
          archived={snapshot.status === "archived"}
          busy={busy}
          onArchive={onArchive}
        />
      )}

      {!ended && snapshot.battle && (
        <BattlePanel
          snapshot={snapshot}
          busy={busy}
          onBattle={onBattle}
          onContinue={() => onAdvance({ type: "free", description: "" })}
        />
      )}

      {!ended && snapshot.pendingEvent && (
        <EventPanel snapshot={snapshot} busy={busy} onChoose={onChoose} />
      )}

      {!ended && !snapshot.battle && !snapshot.pendingEvent && (
        <ActionPanel
          snapshot={snapshot}
          busy={busy}
          onAdvance={onAdvance}
          onUseItem={onUseItem}
          onEndLife={onEndLife}
        />
      )}

      {lastResult && (
        <section className="card result">
          {lastResult.elapsed && <h3>过去{lastResult.elapsed}</h3>}
          {lastResult.wheel && <WheelCard wheel={lastResult.wheel} />}
          {lastResult.events.length > 0 && (
            <div className="stack-sm">
              {lastResult.events.map((event) => (
                <div key={event.id} className="event-card">
                  <strong>⚡ {event.title}</strong>
                  <p>{event.narrative}</p>
                </div>
              ))}
            </div>
          )}
          {lastResult.events.length === 0 && !lastResult.wheel && (
            <p className="muted">世界平静地流转着。</p>
          )}
        </section>
      )}
    </div>
  );
}

// ---------- 结局面板 ----------

const SOURCE_LABELS: Record<string, string> = {
  condition: "条件达成",
  player: "主动收束",
  battleDefeat: "战败",
  event: "事件触发",
};

function EndingPanel({
  ending,
  archived,
  busy,
  onArchive,
}: {
  ending: EndingView;
  archived: boolean;
  busy: boolean;
  onArchive: () => void;
}) {
  return (
    <section className={`card ending-card ${ending.visibility === "hidden" ? "ending-hidden" : ""}`}>
      <span className="tag">{archived ? "本局已封存" : "本局已结束"}</span>
      <h2 className="ending-title">{ending.title}</h2>
      <p className="ending-summary">{ending.summary}</p>
      <p className="muted ending-meta">
        第 {ending.turnIndex} 轮 · {SOURCE_LABELS[ending.source] ?? ending.source}
        {ending.visibility === "hidden" ? " · 隐藏结局" : ""}
      </p>
      {!archived && (
        <button className="ghost" disabled={busy} onClick={onArchive}>
          {busy ? "封存中…" : "封存这一生"}
        </button>
      )}
      {archived && <p className="muted">已归档，只读。点击顶部「重开」开始新的一生。</p>}
    </section>
  );
}

// ---------- 转盘揭示（带滚动动画：高亮指针先快后慢，停在命中扇区） ----------

function WheelCard({ wheel }: { wheel: WheelResultView }) {
  const hitIndex = Math.max(0, wheel.segments.findIndex((s) => s.label === wheel.label));
  const [active, setActive] = useState(hitIndex);
  const [spinning, setSpinning] = useState(true);

  useEffect(() => {
    // 指针扫描：间隔从 70ms 阶梯放大到 420ms，总时长约 2.6s 后停在命中扇区
    const steps: number[] = [];
    let gap = 70;
    let t = 0;
    while (gap < 420) {
      steps.push(gap);
      t += gap;
      gap = Math.round(gap * 1.18);
    }
    // 收尾步：保证最后一步恰好落在命中扇区
    let idx = 0;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let acc = 0;
    steps.forEach((g, i) => {
      acc += g;
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          idx = i + 1;
          setActive((idx + hitIndex) % Math.max(1, wheel.segments.length));
        }, acc),
      );
    });
    timers.push(
      setTimeout(() => {
        if (!cancelled) {
          setActive(hitIndex);
          setSpinning(false);
        }
      }, acc + 60),
    );
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [hitIndex, wheel.segments.length]);

  return (
    <div className={`wheel-card ${spinning ? "wheel-spinning" : ""}`}>
      {spinning ? <strong>🎡 命运转动中…</strong> : <strong>🎡 {wheel.label}</strong>}
      <div className="wheel-segments">
        {wheel.segments.map((seg, i) => (
          <span
            key={seg.label}
            className={`wheel-seg ${spinning && i === active ? "pointer" : ""} ${!spinning && seg.label === wheel.label ? "hit" : ""}`}
          >
            {seg.label}
          </span>
        ))}
      </div>
      {!spinning && <p className="wheel-result">{wheel.label}！</p>}
    </div>
  );
}

// ---------- 事件面板（选项） ----------

function EventPanel({
  snapshot,
  busy,
  onChoose,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  onChoose: (optionId: string) => void;
}) {
  const ev = snapshot.pendingEvent!;
  return (
    <section className="card event-active">
      <span className="tag">事件 · 需要你的决定</span>
      <h2>{ev.title}</h2>
      <p>{ev.narrative}</p>
      <div className="option-list">
        {ev.options.map((opt) => (
          <button key={opt.id} className="option" disabled={busy} onClick={() => onChoose(opt.id)}>
            {opt.text}
          </button>
        ))}
      </div>
      {ev.options.length === 0 && <p className="muted">（没有可选项……）</p>}
    </section>
  );
}

// ---------- 战斗面板 ----------

function BattlePanel({
  snapshot,
  busy,
  onBattle,
  onContinue,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  onBattle: (command: BattleCommand) => void;
  onContinue: () => void;
}) {
  const b = snapshot.battle!;
  const labels = snapshot.labels;
  const [target, setTarget] = useState<string>("");
  const aliveEnemies = b.enemies.filter((e) => e.alive);
  const effectiveTarget = target && aliveEnemies.some((e) => e.instanceId === target) ? target : aliveEnemies[0]?.instanceId;

  return (
    <section className={`card battle ${b.over ? "battle-over" : ""}`}>
      <div className="row">
        <h3>⚔ 战斗 · 第 {b.round} 回合</h3>
        {b.over && (
          <span className={`tag ${b.over}`}>
            {b.over === "victory" ? "胜利" : b.over === "defeat" ? "败北" : "撤离"}
          </span>
        )}
      </div>

      {/* 我方资源：战斗内以战斗镜像为准，消耗实时可见 */}
      <div className="battle-self">
        <div className="attr">
          <span className="attr-name">{labels.resources.hp ?? "hp"}</span>
          <div className="bar">
            <div className="bar-fill hp" style={{ width: `${(b.player.hp / Math.max(1, b.player.maxHp)) * 100}%` }} />
          </div>
          <span className="attr-value">{b.player.hp}/{b.player.maxHp}</span>
        </div>
        <div className="attr">
          <span className="attr-name">{labels.resources.mp ?? "mp"}</span>
          <div className="bar">
            <div className="bar-fill mp" style={{ width: `${(b.player.mp / Math.max(1, b.player.maxMp)) * 100}%` }} />
          </div>
          <span className="attr-value">{b.player.mp}/{b.player.maxMp}</span>
        </div>
      </div>

      {b.allies.length > 0 && (
        <div className="ally-list">
          <span className="muted">友军</span>
          {b.allies.map((a) => (
            <div key={a.instanceId} className={`ally ${!a.alive ? "dead" : ""}`}>
              <strong>{a.name}</strong>
              <div className="bar">
                <div className="bar-fill ally-hp" style={{ width: `${(a.hp / Math.max(1, a.maxHp)) * 100}%` }} />
              </div>
              <span className="attr-value">{a.hp}/{a.maxHp}</span>
              {a.statuses.length > 0 && (
                <span className="enemy-status">{a.statuses.map((s) => `${s.name}${s.stacks > 1 ? `×${s.stacks}` : ""}`).join("、")}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="enemy-list">
        {b.enemies.map((e) => (
          <button
            key={e.instanceId}
            className={`enemy ${!e.alive ? "dead" : ""} ${effectiveTarget === e.instanceId && e.alive ? "targeting" : ""}`}
            disabled={!e.alive}
            onClick={() => setTarget(e.instanceId)}
          >
            <strong>{e.name}</strong>
            <div className="bar">
              <div className="bar-fill enemy-hp" style={{ width: `${(e.hp / Math.max(1, e.maxHp)) * 100}%` }} />
            </div>
            <span className="attr-value">{e.hp}/{e.maxHp}</span>
            {e.statuses.length > 0 && (
              <span className="enemy-status">{e.statuses.map((s) => `${s.name}${s.stacks > 1 ? `×${s.stacks}` : ""}`).join("、")}</span>
            )}
          </button>
        ))}
      </div>

      {!b.over && (
        <>
          <div className="battle-actions">
            {b.player.skills.map((skill) => (
              <button
                key={skill.id}
                className="action"
                disabled={busy || skill.cooldownLeft > 0 || b.player.mp < skill.costMp}
                onClick={() => onBattle({ type: "skill", skillId: skill.id, targetInstanceId: effectiveTarget })}
              >
                <strong>{skill.name}</strong>
                <span>
                  {skill.costMp > 0 ? `${labels.resources.mp ?? "mp"} ${skill.costMp}` : "无消耗"}
                  {skill.cooldownLeft > 0 ? ` · 冷却 ${skill.cooldownLeft}` : ""}
                </span>
              </button>
            ))}
            {b.player.items.map((item) => (
              <button
                key={item.itemId}
                className="action"
                disabled={busy}
                onClick={() => onBattle({ type: "item", itemId: item.itemId })}
              >
                <strong>{item.name} ×{item.count}</strong>
                <span>使用道具</span>
              </button>
            ))}
            {b.player.canFlee && (
              <button className="action flee" disabled={busy} onClick={() => onBattle({ type: "flee" })}>
                <strong>逃跑</strong>
                <span>尝试脱离战斗</span>
              </button>
            )}
          </div>
          <p className="muted target-hint">点击敌人选择目标（默认最前者）</p>
        </>
      )}

      {b.over && (
        <button className="primary" disabled={busy} onClick={onContinue}>
          离开战场，继续前行
        </button>
      )}

      <div className="battle-log">
        {b.log.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    </section>
  );
}

// ---------- 行动面板 ----------

function ActionPanel({
  snapshot,
  busy,
  onAdvance,
  onUseItem,
  onEndLife,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  onAdvance: (action: { type: string; description: string }) => void;
  onUseItem: (itemId: string) => void;
  onEndLife: () => void;
}) {
  const [freeText, setFreeText] = useState("");
  const usableItems = snapshot.player.inventory.filter((i) => i.usableOutsideBattle);

  return (
    <section className="card">
      <h3>行动</h3>
      <div className="action-grid">
        {snapshot.availableActions.map((action) => (
          <button
            key={action.id}
            className="action"
            disabled={busy}
            onClick={() => onAdvance({ type: action.id, description: "" })}
          >
            <strong>{action.label}</strong>
            <span>{action.duration ? `${action.duration.value}${UNIT_NAMES[action.duration.unit] ?? action.duration.unit}` : "默认时长"}</span>
          </button>
        ))}
      </div>
      <div className="free-input">
        <input
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="或自由描述你的行动…"
          maxLength={100}
        />
        <button
          className="primary"
          disabled={busy || !freeText.trim()}
          onClick={() => {
            onAdvance({ type: "free", description: freeText.trim() });
            setFreeText("");
          }}
        >
          执行
        </button>
      </div>
      {usableItems.length > 0 && (
        <div className="inventory">
          <h4>物品</h4>
          <div className="action-grid">
            {usableItems.map((item) => (
              <button key={item.itemId} className="action" disabled={busy} onClick={() => onUseItem(item.itemId)}>
                <strong>{item.name} ×{item.count}</strong>
                <span>使用</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="end-life" disabled={busy} onClick={onEndLife}>
        结束这一生
      </button>
    </section>
  );
}

// ---------- 个人 Tab（人物面板 / 背包分区 / 技能） ----------

type PersonalSubTab = "character" | "bag" | "skills";

const PERSONAL_SUBTABS: Array<{ key: PersonalSubTab; label: string }> = [
  { key: "character", label: "角色" },
  { key: "bag", label: "背包" },
  { key: "skills", label: "技能" },
];

/** 背包分区（用户裁决：装备与物品在背包里分区，DNF 式）。按物品类型分栏，不混排。 */
type BagPartition = "equipment" | "consumable" | "material" | "key";

const BAG_PARTITIONS: Array<{ key: BagPartition; label: string; types: InventoryView["type"][] }> = [
  { key: "equipment", label: "装备", types: ["equipment"] },
  { key: "consumable", label: "消耗品", types: ["consumable"] },
  { key: "material", label: "材料", types: ["material"] },
  { key: "key", label: "其他", types: ["key"] },
];

/**
 * 选中项：装备槽（含空槽）/ 背包物品。详情区是唯一的操作入口——
 * 装备在「角色」页穿脱，物品在「背包」页使用（ADR-0008 / ADR-0009）。
 */
type PersonalSelection =
  | { kind: "slot"; instanceId: string | null; slotId: string; slotLabel: string; capacity: number }
  | { kind: "item"; itemId: string }
  | null;

function PersonalTab({
  snapshot,
  busy,
  onUseItem,
  onEquip,
  onUnequip,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  onUseItem: (itemId: string) => void;
  onEquip: (itemId: string) => void;
  onUnequip: (instanceId: string) => void;
}) {
  // 子页签 / 背包分区 / 选中项都是纯展示状态：切换即时、不触发任何请求。
  const [sub, setSub] = useState<PersonalSubTab>("character");
  const [partition, setPartition] = useState<BagPartition>("equipment");
  const [selection, setSelection] = useState<PersonalSelection>(null);

  const equipment = equipmentOf(snapshot.player);
  const bag = snapshot.player.inventory;

  // 投影刷新后选中项可能已失效（刚卸下 / 刚用完），此时按「未选中」处理而不是报错
  const active: PersonalSelection =
    selection?.kind === "slot"
      ? selection.instanceId && !equipment.some((e) => e.instanceId === selection.instanceId)
        ? {
            kind: "slot",
            instanceId: null,
            slotId: selection.slotId,
            slotLabel: selection.slotLabel,
            capacity: selection.capacity,
          }
        : selection
      : selection?.kind === "item" && !bag.some((i) => i.itemId === selection.itemId)
        ? null
        : selection;

  return (
    <div className="stack">
      <div className="subtabbar" role="tablist" aria-label="个人子页签">
        {PERSONAL_SUBTABS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={sub === entry.key}
            className={`subtab ${sub === entry.key ? "active" : ""}`}
            onClick={() => {
              setSub(entry.key);
              setSelection(null);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {sub === "character" && (
        <>
          <CharacterPanel snapshot={snapshot} equipment={equipment} selection={active} onSelect={setSelection} />
          <StatsPanel snapshot={snapshot} />
          <AssetDetail
            snapshot={snapshot}
            selection={active}
            busy={busy}
            onEquip={onEquip}
            onUnequip={onUnequip}
            onUseItem={onUseItem}
          />
        </>
      )}

      {sub === "bag" && (
        <>
          <BagPanel
            snapshot={snapshot}
            partition={partition}
            onPartition={(key) => {
              setPartition(key);
              setSelection(null);
            }}
            selection={active}
            onSelect={setSelection}
          />
          <AssetDetail
            snapshot={snapshot}
            selection={active}
            busy={busy}
            onEquip={onEquip}
            onUnequip={onUnequip}
            onUseItem={onUseItem}
          />
        </>
      )}

      {sub === "skills" && <SkillList snapshot={snapshot} />}
    </div>
  );
}

function isSlotSelected(selection: PersonalSelection, cell: SlotCell): boolean {
  if (selection?.kind !== "slot") return false;
  return cell.instance
    ? selection.instanceId === cell.instance.instanceId
    : selection.instanceId === null && selection.slotId === cell.slotId;
}

/** 装备格子（左右两列共用）。空槽也可选中——详情区会列出可装备物品。 */
function SlotTile({
  cell,
  selected,
  onSelect,
}: {
  cell: SlotCell;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`cell slot-tile ${selected ? "selected" : ""} ${cell.instance ? "" : "empty"}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="cell-slot">
        {cell.slotLabel}
        {cell.capacity > 1 ? ` ${cell.index + 1}` : ""}
      </span>
      <span className="cell-glyph">{cell.instance ? "◈" : "＋"}</span>
      <span className={`cell-name ${cell.instance ? "" : "muted"}`}>{cell.instance?.name ?? "空"}</span>
    </button>
  );
}

/**
 * 人物面板（DNF M 面板思路）：左列 / 中央人物 / 右列，槽位由模板 `panelSide` 决定摆位，
 * 底部锚定的槽位（缺省 bottom）排在面板下方。**格子数 = 槽位 maxCount，全部来自模板**，
 * 前端不猜槽位、不猜件数（R-EQ-15）。
 */
function CharacterPanel({
  snapshot,
  equipment,
  selection,
  onSelect,
}: {
  snapshot: V2Snapshot;
  equipment: EquipmentView[];
  selection: PersonalSelection;
  onSelect: (next: PersonalSelection) => void;
}) {
  const slots = snapshot.equipmentSlots ?? [];
  const cells = buildSlotCells(slots, equipment);
  const sideOf = (side: SlotCell["side"]) => cells.filter((c) => c.side === side);
  const left = sideOf("left");
  const right = sideOf("right");
  const bottom = sideOf("bottom");
  const p = snapshot.player;

  const selectCell = (cell: SlotCell) =>
    onSelect({
      kind: "slot",
      instanceId: cell.instance?.instanceId ?? null,
      slotId: cell.slotId,
      slotLabel: cell.slotLabel,
      capacity: cell.capacity,
    });

  return (
    <section className="card">
      <div className="row">
        <h3 className="panel-title">角色</h3>
        <span className="muted equip-count">{equipment.length} 件在身</span>
      </div>

      {cells.length === 0 ? (
        <p className="muted">这个世界没有配置装备槽位。</p>
      ) : (
        <>
          <div className="paperdoll">
            <div className="paperdoll-col">
              {left.map((cell) => (
                <SlotTile
                  key={cell.key}
                  cell={cell}
                  selected={isSlotSelected(selection, cell)}
                  onSelect={() => selectCell(cell)}
                />
              ))}
            </div>

            <div className="paperdoll-figure">
              <div className="figure-avatar" aria-hidden="true">◈</div>
              <strong className="figure-name">{p.name}</strong>
              <span className="figure-sub">
                {p.age} 岁 · {p.genderLabel}
              </span>
              <div className="figure-bars">
                <MiniBar
                  label={snapshot.labels.resources.hp ?? "hp"}
                  value={p.hp}
                  max={p.maxHp}
                  cls="hp"
                />
                <MiniBar
                  label={snapshot.labels.resources.mp ?? "mp"}
                  value={p.mp}
                  max={p.maxMp}
                  cls="mp"
                />
              </div>
              <span className="figure-sub">{snapshot.lifeStageLabel}</span>
            </div>

            <div className="paperdoll-col right">
              {right.map((cell) => (
                <SlotTile
                  key={cell.key}
                  cell={cell}
                  selected={isSlotSelected(selection, cell)}
                  onSelect={() => selectCell(cell)}
                />
              ))}
            </div>
          </div>

          {bottom.length > 0 && (
            <div className="cell-grid paperdoll-bottom">
              {bottom.map((cell) => (
                <SlotTile
                  key={cell.key}
                  cell={cell}
                  selected={isSlotSelected(selection, cell)}
                  onSelect={() => selectCell(cell)}
                />
              ))}
            </div>
          )}
        </>
      )}
      <p className="muted cell-hint">点格子查看详情；装备 / 卸下都在下方详情区完成。</p>
    </section>
  );
}

function MiniBar({ label, value, max, cls }: { label: string; value: number; max: number; cls: string }) {
  const pct = Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
  return (
    <div className="mini-bar">
      <div className="mini-top">
        <span>{label}</span>
        <span>
          {value}/{max}
        </span>
      </div>
      <div className="bar">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** 属性面板：只复述投影已有字段，不做任何前端推算（与 DNF 的 M 面板信息区对应）。 */
function StatsPanel({ snapshot }: { snapshot: V2Snapshot }) {
  const p = snapshot.player;
  const labels = snapshot.labels.attributes;
  const order = Object.keys(labels);
  const rankOf = (key: string) => {
    const idx = order.indexOf(key);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  const entries = Object.entries(p.attributes)
    .filter(([key]) => !key.startsWith("proficiency"))
    .sort(([a], [b]) => rankOf(a) - rankOf(b));

  return (
    <section className="card">
      <div className="row">
        <h3 className="panel-title">属性</h3>
        <span className="muted equip-count">第 {snapshot.turnIndex} 轮</span>
      </div>
      <div className="stat-grid">
        {entries.map(([key, value]) => (
          <div key={key} className="stat">
            <span>{labels[key] ?? key}</span>
            <strong>{String(value)}</strong>
          </div>
        ))}
        <div className="stat">
          <span>{snapshot.labels.mood}</span>
          <strong>{p.moodBandLabel}</strong>
        </div>
      </div>
      {p.statuses.length > 0 && (
        <div className="status-chips">
          {p.statuses.map((s) => (
            <span key={s.id} className="chip status-chip">
              {s.name}
              {s.stacks > 1 ? `×${s.stacks}` : ""}
            </span>
          ))}
        </div>
      )}
      <div className="meta-row">
        <span className="chip">命运偏离度 {snapshot.evaluation.canonDeviation}</span>
        <span className="chip">{snapshot.formattedTime}</span>
      </div>
      <p className="eval-line">{snapshot.evaluation.summary}</p>
    </section>
  );
}

/** 背包：按类型分区（装备 / 消耗品 / 材料 / 其他），每区独立方格 + 数量角标。 */
function BagPanel({
  snapshot,
  partition,
  onPartition,
  selection,
  onSelect,
}: {
  snapshot: V2Snapshot;
  partition: BagPartition;
  onPartition: (next: BagPartition) => void;
  selection: PersonalSelection;
  onSelect: (next: PersonalSelection) => void;
}) {
  const bag = snapshot.player.inventory;
  const current = BAG_PARTITIONS.find((p) => p.key === partition) ?? BAG_PARTITIONS[0];
  const items = bag.filter((item) => current.types.includes(item.type));
  const countOf = (types: InventoryView["type"][]) => bag.filter((i) => types.includes(i.type)).length;

  return (
    <section className="card">
      <div className="row">
        <h3 className="panel-title">背包</h3>
        <span className="muted equip-count">{bag.length} 种</span>
      </div>

      <div className="partitionbar" role="tablist" aria-label="背包分区">
        {BAG_PARTITIONS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={partition === entry.key}
            className={`partition ${partition === entry.key ? "active" : ""}`}
            onClick={() => onPartition(entry.key)}
          >
            {entry.label}
            <em>{countOf(entry.types)}</em>
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="muted">这一格还没有东西。</p>
      ) : (
        <div className="cell-grid">
          {items.map((item) => {
            const selected = selection?.kind === "item" && selection.itemId === item.itemId;
            return (
              <button
                key={item.itemId}
                className={`cell bag-cell ${selected ? "selected" : ""}`}
                aria-pressed={selected}
                onClick={() => onSelect({ kind: "item", itemId: item.itemId })}
              >
                <span className="cell-glyph">{itemGlyph(item.type)}</span>
                <span className="cell-name">{item.name}</span>
                {item.count > 1 && <span className="cell-count">×{item.count}</span>}
              </button>
            );
          })}
        </div>
      )}
      <p className="muted cell-hint">穿在身上的装备不在背包里，去「角色」页卸下。</p>
    </section>
  );
}

/** 层数 / 耐久只在投影确实下发时展示，缺失即不渲染（不推算默认值）。 */
function EquipMeta({ equipment }: { equipment: EquipmentView }) {
  const stacks = equipment.stacks;
  const durability = equipment.durability;
  const hasStacks = typeof stacks === "number" && stacks > 1;
  const hasDurability = typeof durability === "number";
  if (!hasStacks && !hasDurability) return null;
  return (
    <div className="tag-row equip-meta">
      {hasStacks && <span className="tag">×{stacks}</span>}
      {hasDurability && <span className="tag">耐久 {durability}</span>}
    </div>
  );
}

/**
 * 详情区：唯一操作入口。
 * - 已装备：展示说明 + 卸下；
 * - 空槽：展示槽位允许类别 + 背包内可装备物品（就地装备）；
 * - 背包物品：展示说明 + 使用 / 装备（装备件按定义槽位落位）。
 */
function AssetDetail({
  snapshot,
  selection,
  busy,
  onEquip,
  onUnequip,
  onUseItem,
}: {
  snapshot: V2Snapshot;
  selection: PersonalSelection;
  busy: boolean;
  onEquip: (itemId: string) => void;
  onUnequip: (instanceId: string) => void;
  onUseItem: (itemId: string) => void;
}) {
  const equipment = equipmentOf(snapshot.player);
  const bag = snapshot.player.inventory;

  if (!selection) {
    return (
      <section className="card detail-card">
        <p className="muted">选中上方任意格子查看详情。</p>
      </section>
    );
  }

  if (selection.kind === "slot") {
    const slot = (snapshot.equipmentSlots ?? []).find((s) => s.id === selection.slotId);
    const worn = selection.instanceId
      ? equipment.find((e) => e.instanceId === selection.instanceId)
      : undefined;
    if (worn) {
      return (
        <section className="card detail-card">
          <div className="row">
            <h3>{worn.name ?? worn.itemId}</h3>
            <span className="tag">{worn.slotLabel ?? worn.slot}</span>
          </div>
          <div className="tag-row">
            <span className="tag">已装备</span>
            {worn.category && <span className="tag">类别 {worn.category}</span>}
            {worn.quality && <span className="tag">品质 {worn.quality}</span>}
          </div>
          {worn.description && <p className="item-desc">{worn.description}</p>}
          <EquipMeta equipment={worn} />
          <div className="detail-actions">
            <button className="ghost" disabled={busy} onClick={() => onUnequip(worn.instanceId)}>
              卸下
            </button>
          </div>
        </section>
      );
    }
    const allowed = slot?.allowedCategories ?? [];
    const candidates = bag.filter(
      (i) => i.type === "equipment" && allowed.includes(i.category ?? ""),
    );
    return (
      <section className="card detail-card">
        <div className="row">
          <h3>{selection.slotLabel} · 空</h3>
          <span className="tag">可装备 {candidates.length}</span>
        </div>
        <p className="muted">
          {allowed.length > 0 ? `此槽位接受类别：${allowed.join(" / ")}` : "槽位未声明允许类别。"}
        </p>
        {candidates.length === 0 ? (
          <p className="muted">背包里没有可放进这个槽位的装备。</p>
        ) : (
          <div className="stack-sm">
            {candidates.map((item) => (
              <div key={item.itemId} className="detail-row">
                <div>
                  <strong>{item.name}</strong>
                  <p className="muted">
                    {item.quality ? `${item.quality} · ` : ""}
                    {item.category ?? "无类别"}
                    {item.count > 1 ? ` · 备用 ${item.count}` : ""}
                  </p>
                </div>
                <button className="primary" disabled={busy} onClick={() => onEquip(item.itemId)}>
                  装备
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  const item = bag.find((i) => i.itemId === selection.itemId);
  if (!item) {
    return (
      <section className="card detail-card">
        <p className="muted">选中上方任意格子查看详情。</p>
      </section>
    );
  }
  const isEquipment = item.type === "equipment";
  return (
    <section className="card detail-card">
      <div className="row">
        <h3>
          {item.name}
          {item.count > 1 ? ` ×${item.count}` : ""}
        </h3>
        <span className="tag">{ITEM_TYPE_LABEL[item.type]}</span>
      </div>
      <div className="tag-row">
        {item.slotLabel && <span className="tag">槽位 {item.slotLabel}</span>}
        {item.category && <span className="tag">类别 {item.category}</span>}
        {item.quality && <span className="tag">品质 {item.quality}</span>}
        {item.usableInBattle && <span className="tag">战斗可用</span>}
      </div>
      {item.description && <p className="item-desc">{item.description}</p>}
      <div className="detail-actions">
        {isEquipment && (
          <button className="primary" disabled={busy} onClick={() => onEquip(item.itemId)}>
            装备
          </button>
        )}
        {item.usableOutsideBattle && (
          <button className="primary" disabled={busy} onClick={() => onUseItem(item.itemId)}>
            使用
          </button>
        )}
        {!isEquipment && !item.usableOutsideBattle && !item.usableInBattle && (
          <p className="muted">这件物品无法直接使用，会在剧情里派上用场。</p>
        )}
      </div>
    </section>
  );
}

function SkillList({ snapshot }: { snapshot: V2Snapshot }) {
  const skills = snapshot.player.skills;
  if (skills.length === 0) {
    return (
      <section className="card">
        <p className="muted">尚未习得技能。</p>
      </section>
    );
  }
  return (
    <section className="card">
      <div className="stack-sm">
        {skills.map((skill) => (
          <div key={skill.id} className="event-card">
            <strong>{skill.name}</strong>
            <p className="muted">{skill.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- 人物 Tab ----------

function PeopleTab({ snapshot }: { snapshot: V2Snapshot }) {
  return (
    <div className="stack">
      {snapshot.npcs.map((npc) => (
        <section key={npc.id} className="card">
          <div className="row">
            <h2>{npc.name}</h2>
            <span className="tag">{npc.age} 岁 · {npc.genderLabel}</span>
          </div>
          <p className="muted">{npc.personality}</p>
          <div className="attr">
            <span className="attr-name">关系</span>
            <div className="bar">
              <div
                className="bar-fill relation"
                style={{ width: `${((npc.relationship + 100) / 200) * 100}%` }}
              />
            </div>
            <span className="attr-value">{npc.relationship}</span>
          </div>
          {npc.knownGoals.length > 0 && (
            <p className="known-goals">已知目标：{npc.knownGoals.join("；")}</p>
          )}
        </section>
      ))}
    </div>
  );
}

// ---------- 世界 Tab ----------

function WorldTab({ snapshot }: { snapshot: V2Snapshot }) {
  return (
    <div className="stack">
      <section className="card">
        <h2>{snapshot.worldName}</h2>
        <p className="muted">
          纪元 {snapshot.startYear} · 平行世界模拟。你的每个选择都在改写这条时间线。
        </p>
        <div className="row">
          <span className="chip">命运偏离度：{snapshot.evaluation.canonDeviation}</span>
          <span className="chip">进行中事件链：{snapshot.activeChains.length}</span>
        </div>
      </section>

      {snapshot.activeChains.length > 0 && (
        <section className="card">
          <h3>正在发生的事件链</h3>
          {snapshot.activeChains.map((chain) => (
            <div key={chain.id} className="event-card">
              <strong>{chain.id}</strong>
              <p className="muted">状态：{chain.status} · 后续将自动演化</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// ---------- 记录 Tab ----------

const TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  player_action: { label: "你", cls: "t-player" },
  npc_action: { label: "人", cls: "t-npc" },
  event: { label: "事", cls: "t-event" },
  battle: { label: "战", cls: "t-battle" },
  milestone: { label: "碑", cls: "t-milestone" },
};

function LogTab({ snapshot }: { snapshot: V2Snapshot }) {
  const [history, setHistory] = useState<Array<{ id: string; turnIndex: number; worldTime: number; formattedTime: string; type: string; summary: string; detail?: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .history(snapshot.worldId)
      .then((res) => setHistory([...res.history].reverse()))
      .catch((e) => setError(String(e)));
  }, [snapshot.worldId, snapshot.turnIndex]);

  return (
    <div className="stack">
      {error && <div className="banner error">{error}</div>}
      {history.length === 0 && <p className="muted">还没有任何记录。</p>}
      {history.map((entry) => {
        const meta = TYPE_LABEL[entry.type] ?? { label: "记", cls: "t-event" };
        return (
          <div key={entry.id} className={`log-entry ${meta.cls}`}>
            <span className="log-badge">{meta.label}</span>
            <div>
              <p>{entry.summary}</p>
              <span className="log-time">
                第 {entry.turnIndex} 轮 · {entry.formattedTime}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- 本地存续（worldId 存 localStorage） ----------

function loadWorldId(): string | null {
  try {
    return localStorage.getItem("life-sim:worldId");
  } catch {
    return null;
  }
}

function saveWorldId(id: string): void {
  try {
    localStorage.setItem("life-sim:worldId", id);
  } catch {
    /* 隐私模式忽略 */
  }
}

function clearWorldId(): void {
  try {
    localStorage.removeItem("life-sim:worldId");
  } catch {
    /* 忽略 */
  }
}

createRoot(document.getElementById("root")!).render(<App />);
