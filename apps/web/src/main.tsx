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
 * 装备投影已落地（协议 §19）：V2Snapshot.player.equipment 为可选字段
 * （旧存档 / 未配置装备的模板缺省），元素类型直接从 shared 视图类型派生，
 * 前端不再本地重复声明字段。展示层只读这 7 个展示字段，补正结果属内核现算状态，不接触。
 */
type EquipmentView = NonNullable<V2Snapshot["player"]["equipment"]>[number];

function equipmentOf(player: V2Snapshot["player"]): EquipmentView[] {
  return player.equipment ?? [];
}

interface EquipmentGroup {
  slot: string;
  label: string;
  items: EquipmentView[];
}

/** 按 slot 分组；保持投影下发顺序（槽位顺序由模板驱动，前端不自行排序）。 */
function groupEquipmentBySlot(items: EquipmentView[]): EquipmentGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, EquipmentView[]>();
  for (const item of items) {
    const bucket = buckets.get(item.slot);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(item.slot, [item]);
      order.push(item.slot);
    }
  }
  return order.map((slot) => {
    const bucket = buckets.get(slot) ?? [];
    return { slot, label: bucket[0]?.slotLabel ?? slot, items: bucket };
  });
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
    async (fn: () => Promise<{ snapshot: V2Snapshot; triggeredEvents?: LastResult["events"]; wheelResult?: WheelResultView | null; elapsed?: { value: number; unit: string } }>) => {
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
        } else {
          setError(e instanceof Error ? e.message : String(e));
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
        {tab === "personal" && <PersonalTab snapshot={snapshot} busy={busy} onUseItem={useItem} />}
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

// ---------- 个人 Tab（装备栏 + 装备 / 物品 / 技能 / 面板） ----------

type PersonalSubTab = "equipment" | "items" | "skills" | "panel";

const PERSONAL_SUBTABS: Array<{ key: PersonalSubTab; label: string }> = [
  { key: "equipment", label: "装备" },
  { key: "items", label: "物品" },
  { key: "skills", label: "技能" },
  { key: "panel", label: "面板" },
];

/**
 * 无装备时的中性空槽占位数量。
 * 槽位全集需由模板 equipment.yaml 的 slots 经投影下发才能恒定可见；
 * 当前投影只下发「已装备实例」，拿不到空槽定义，故按数量占位且不猜槽位名。
 */
const EMPTY_SLOT_PLACEHOLDERS = 2;

function PersonalTab({
  snapshot,
  busy,
  onUseItem,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  onUseItem: (itemId: string) => void;
}) {
  // 子页签为纯展示状态：切换即时、不触发任何请求。
  const [sub, setSub] = useState<PersonalSubTab>("equipment");
  const equipment = equipmentOf(snapshot.player);
  const groups = groupEquipmentBySlot(equipment);

  return (
    <div className="stack">
      <section className="card">
        <div className="row">
          <h3 className="panel-title">装备</h3>
          <span className="muted equip-count">{equipment.length} 件</span>
        </div>
        <div className="equip-slots">
          {groups.length === 0
            ? Array.from({ length: EMPTY_SLOT_PLACEHOLDERS }, (_, i) => (
                <div key={`empty-slot-${i}`} className="equip-slot empty">
                  空
                </div>
              ))
            : groups.map((group) => (
                <div key={group.slot} className="equip-slot">
                  <span className="slot-label">{group.label}</span>
                  {group.items.map((eq) => (
                    <div key={eq.instanceId} className="equip-item">
                      <strong>{eq.name ?? eq.itemId}</strong>
                      <EquipMeta equipment={eq} />
                    </div>
                  ))}
                </div>
              ))}
        </div>
        {groups.length === 0 && <p className="muted">暂无装备</p>}
      </section>

      <div className="subtabbar" role="tablist" aria-label="个人子页签">
        {PERSONAL_SUBTABS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={sub === entry.key}
            className={`subtab ${sub === entry.key ? "active" : ""}`}
            onClick={() => setSub(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="stack">
        {sub === "equipment" && <EquipmentDetail equipment={equipment} />}
        {sub === "items" && <ItemList snapshot={snapshot} busy={busy} onUseItem={onUseItem} />}
        {sub === "skills" && <SkillList snapshot={snapshot} />}
        {sub === "panel" && <PanelView snapshot={snapshot} />}
      </div>
    </div>
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

function EquipmentDetail({ equipment }: { equipment: EquipmentView[] }) {
  if (equipment.length === 0) {
    return (
      <section className="card">
        <p className="muted">尚未装备任何物品。</p>
      </section>
    );
  }
  return (
    <>
      {equipment.map((eq) => (
        <section key={eq.instanceId} className="card item-card">
          <div className="row">
            <h2>{eq.name ?? eq.itemId}</h2>
            <span className="tag">{eq.slotLabel ?? eq.slot}</span>
          </div>
          <EquipMeta equipment={eq} />
        </section>
      ))}
    </>
  );
}

function ItemList({
  snapshot,
  busy,
  onUseItem,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  onUseItem: (itemId: string) => void;
}) {
  const items = snapshot.player.inventory;
  if (items.length === 0) {
    return (
      <section className="card">
        <p className="muted">空空如也。物品可通过事件、商店与战斗掉落获得。</p>
      </section>
    );
  }
  return (
    <>
      {items.map((item) => (
        <section key={item.itemId} className="card item-card">
          <div className="row">
            <h2>{item.name} ×{item.count}</h2>
            <div className="tag-row">
              {item.usableOutsideBattle && <span className="tag">可用</span>}
              {item.usableInBattle && <span className="tag">战斗可用</span>}
              {!item.usableOutsideBattle && !item.usableInBattle && <span className="tag">被动</span>}
            </div>
          </div>
          {item.description && <p className="item-desc">{item.description}</p>}
          {item.usableOutsideBattle && (
            <button className="primary" disabled={busy} onClick={() => onUseItem(item.itemId)}>
              使用
            </button>
          )}
        </section>
      ))}
    </>
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

/** 面板页签只复述投影已有字段，不做任何前端推算。 */
function PanelView({ snapshot }: { snapshot: V2Snapshot }) {
  return (
    <>
      <PlayerCard snapshot={snapshot} />
      <section className="card">
        <h3>状态摘要</h3>
        <div className="meta-row">
          <span className="chip">人生阶段：{snapshot.lifeStageLabel}</span>
          <span className="chip">命运偏离度：{snapshot.evaluation.canonDeviation}</span>
          <span className="chip">第 {snapshot.turnIndex} 轮</span>
        </div>
      </section>
    </>
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
