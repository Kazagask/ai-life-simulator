import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type { BattleCommand, V2Snapshot } from "@life-sim/shared";
import { BattleBoard, toBattleVM } from "@life-sim/rpg-ui";

type BattleView = NonNullable<V2Snapshot["battle"]>;

interface LivePayload {
  token: string;
  battle: BattleView;
  template: { id: string; version: string };
  resourceLabels: { hp: string; mp: string };
  applied?: string[];
  command?: BattleCommand;
}

interface Roster {
  attributeKeys: string[];
  attributeLabels: Record<string, string>;
  statuses: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string }>;
  items: Array<{ id: string; name: string; slot?: string }>;
  characters: Array<{ id: string; name: string; skills: string[]; statuses: string[]; equipment: string[] }>;
}

interface StartDetail {
  templateId: string;
  version: string;
  spec: unknown;
  seed?: number;
}

type PatchKind = "attribute" | "status" | "equipment" | "skill" | "hp" | "mp";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(payload.detail ?? payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function App() {
  const [live, setLive] = useState<LivePayload | null>(null);
  const [config, setConfig] = useState<StartDetail | null>(null);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<"player" | "enemy">("player");
  const [kind, setKind] = useState<PatchKind>("status");
  const [choice, setChoice] = useState("");
  const [value, setValue] = useState("");

  useEffect(() => {
    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<StartDetail>).detail;
      void start(detail);
    };
    const onAuto = () => void auto();
    window.addEventListener("life-sim:live-start", onStart);
    window.addEventListener("life-sim:live-auto", onAuto);
    return () => {
      window.removeEventListener("life-sim:live-start", onStart);
      window.removeEventListener("life-sim:live-auto", onAuto);
    };
    // 事件回调必须拿到最新的 live/busy；空依赖数组会把第一次渲染时的 null  closures 钉死。
  }, [live, busy]);

  useEffect(() => {
    const hint = document.getElementById("liveHint");
    const meta = document.getElementById("liveMeta");
    if (hint !== null) hint.textContent = live === null ? "先在木桩页配好参数" : "演练中 · 改动不落盘";
    if (meta !== null) {
      meta.textContent = live === null ? "" : `${live.template.id}@${live.template.version} · 第 ${live.battle.round} 回合`;
    }
  }, [live]);

  async function start(detail: StartDetail) {
    setBusy(true);
    setError(null);
    try {
      const payload = await post<LivePayload>("/api/admin/battle/start", {
        templateId: detail.templateId,
        version: detail.version,
        seed: detail.seed,
        spec: detail.spec,
      });
      setLive(payload);
      setConfig(detail);
      const next = await fetch(
        `/api/admin/templates/${encodeURIComponent(detail.templateId)}/${encodeURIComponent(detail.version)}/roster`,
      );
      if (next.ok) setRoster((await next.json()) as Roster);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** 响应万一漏了 token，也别把当前会话号丢掉（否则下一回合就是 session_not_found）。 */
  function mergeLive(next: LivePayload) {
    setLive((prev) => ({ ...next, token: next.token || prev?.token || "" }));
  }

  async function command(cmd: BattleCommand) {
    if (live === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      mergeLive(await post<LivePayload>(`/api/admin/battle/${live.token}/command`, cmd));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function auto() {
    if (live === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      mergeLive(await post<LivePayload>(`/api/admin/battle/${live.token}/auto`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** 用模板里的 NPC 角色卡重开一场；只换指定一侧，另一侧沿用当前配置。 */
  function applyPreset(characterId: string, role: "player" | "enemy") {
    if (config === null) {
      setError("先用木桩配置开一场，才能用预设替换其中一侧");
      return;
    }
    const spec = (config.spec !== null && typeof config.spec === "object" ? config.spec : {}) as Record<string, unknown>;
    const nextSpec =
      role === "player"
        ? { ...spec, left: { ref: characterId } }
        : characterId === "__dummy__"
          ? { ...spec, right: { dummy: { name: "木桩", hp: 5000 } } }
          : { ...spec, right: { ref: characterId } };
    void start({ ...config, spec: nextSpec });
  }

  async function patch() {
    if (live === null || busy) return;
    const body: Record<string, unknown> = { target };
    if (kind === "attribute") {
      const n = Number(value);
      if (choice === "" || !Number.isFinite(n)) {
        setError("先选属性并填数值");
        return;
      }
      body.attributes = { [choice]: n };
    } else if (kind === "hp" || kind === "mp") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        setError("先填数值");
        return;
      }
      body[kind] = n;
    } else if (choice === "") {
      setError("先选一项");
      return;
    } else if (kind === "status") body.addStatuses = [choice];
    else if (kind === "skill") body.addSkills = [choice];
    else if (kind === "equipment") body.addEquipment = [choice];
    setBusy(true);
    setError(null);
    try {
      mergeLive(await post<LivePayload>(`/api/admin/battle/${live.token}/patch`, body));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const options: Array<{ id: string; name: string }> =
    kind === "status"
      ? (roster?.statuses ?? [])
      : kind === "skill"
        ? (roster?.skills ?? [])
        : kind === "equipment"
          ? (roster?.items ?? []).filter((i) => i.slot !== undefined)
          : kind === "attribute"
            ? (roster?.attributeKeys ?? []).map((id) => ({ id, name: roster?.attributeLabels[id] ?? id }))
            : [];

  const controls = (
    <>
      {error !== null ? <div className="sim-error">{error}</div> : null}
      {live?.applied !== undefined && live.applied.length > 0 ? (
        <div className="live-patch applied">已加入：{live.applied.join(" · ")}</div>
      ) : null}
      <div className="live-patch">
        <div className="row">
          <span className="hint">目标</span>
          <select value={target} onChange={(ev) => setTarget(ev.target.value as "player" | "enemy")}>
            <option value="player">玩家</option>
            <option value="enemy">敌人</option>
          </select>
        </div>
        <div className="row">
          <span className="hint">加什么</span>
          <select
            value={kind}
            onChange={(ev) => {
              setKind(ev.target.value as PatchKind);
              setChoice("");
            }}
          >
            <option value="status">战斗状态</option>
            <option value="skill">技能</option>
            <option value="equipment">装备（仅玩家）</option>
            <option value="attribute">属性</option>
            <option value="hp">HP</option>
            <option value="mp">MP</option>
          </select>
        </div>
        {options.length > 0 ? (
          <div className="row">
            <span className="hint">选择</span>
            <select value={choice} onChange={(ev) => setChoice(ev.target.value)}>
              <option value="">—</option>
              {options.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.id}</option>
              ))}
            </select>
          </div>
        ) : null}
        {(kind === "attribute" || kind === "hp" || kind === "mp") ? (
          <div className="row">
            <span className="hint">数值</span>
            <input type="number" value={value} onChange={(ev) => setValue(ev.target.value)} placeholder="0" />
          </div>
        ) : null}
        <div className="row">
          <span />
          <span />
          <button className="run-btn" type="button" onClick={() => void patch()} disabled={live === null || busy}>
            加入战斗
          </button>
        </div>
      </div>
    </>
  );

  const presets = (
    <>
      <p className="preset-title">NPC 预设 · 点一下重开一场</p>
      <div className="preset-row">
        <span className="preset-name">木桩 <small>不还手 · 5000 HP</small></span>
        <span />
        <button type="button" onClick={() => applyPreset("__dummy__", "enemy")}>对手</button>
      </div>
      {(roster?.characters ?? []).map((char) => (
        <div className="preset-row" key={char.id}>
          <span className="preset-name" title={char.id}>
            {char.name} <small>{char.id}</small>
          </span>
          <button type="button" onClick={() => applyPreset(char.id, "player")}>主角</button>
          <button type="button" onClick={() => applyPreset(char.id, "enemy")}>对手</button>
        </div>
      ))}
    </>
  );

  return (
    <>
      {live === null ? (
        <div className="empty">点「用木桩配置开打」</div>
      ) : (
        <BattleBoard
          battle={toBattleVM(live.battle)}
          labels={live.resourceLabels}
          busy={busy}
          onCommand={(cmd) => void command(cmd)}
          onContinue={() => undefined}
        />
      )}
      {createPortal(presets, document.getElementById("livePresets") ?? document.body)}
      {createPortal(controls, document.getElementById("livePatch") ?? document.body)}
    </>
  );
}

const root = document.getElementById("liveRoot");
if (root !== null) createRoot(root).render(<App />);
