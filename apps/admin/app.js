/* 命数后台 · 前端
 * 无构建、无依赖：只跟 apps/server/src/admin.ts 暴露的四个只读接口打交道。
 * 两块：trace（invocation 时间线） / orchestration（事件图 + flag 读写索引）。
 */
(() => {
  "use strict";

  /* ================================ 基础工具 ================================ */

  const $ = (sel, root = document) => root.querySelector(sel);

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "—");

  const shortTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const ms = (v) => (typeof v === "number" ? (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`) : "—");

  const truncate = (s, n) => {
    const str = String(s ?? "");
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
  };

  async function api(path, init = {}) {
    const headers = {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {}),
    };
    const res = await fetch(path, { ...init, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body.detail ?? body.error ?? `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return body;
  }

  const state = {
    tab: "trace",
    worlds: [],
    worldId: null,
    trace: null,
    entryIdx: -1,
    templates: [],
    orch: null,
    tplKey: null,
    selectedNode: null,
    flagId: null,
    npcId: null,
    npcLine: null,
    npcHits: null,
    search: "",
    sources: new Set(),
    kinds: new Set(),
    showEndings: false,
    onlyConnected: false,
    view: { x: 0, y: 0, k: 1 },
    layout: null,
  };

  /* ================================ 标签页 ================================ */

  function activateTab(tabName) {
    state.tab = tabName;
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === tabName);
    for (const v of document.querySelectorAll(".view")) v.classList.toggle("active", v.id === `view-${tabName}`);
    if (location.hash !== `#${tabName}`) history.replaceState(null, "", `#${tabName}`);
    if (tabName === "graph") {
      if (!state.orch && state.templates.length > 0) {
        const first = state.templates.find((t) => t.loadable);
        if (first) loadOrchestration(first.templateId, first.version);
      } else if (state.layout) {
        // 从隐藏状态恢复：绘制时 rect 是 0，这里只需要重新套用当前 transform。
        applyTransform();
      }
    }
    if (tabName === "sim") bootSim();
    if (tabName === "live") window.dispatchEvent(new CustomEvent("life-sim:live-visible"));
  }

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  }

  /* ================================ TRACE ================================ */

  async function bootHealth() {
    try {
      const health = await api("/api/admin/health");
      $("#dataDir").textContent = health.dataDir;
      $("#envInfo").textContent = `${health.dataDir}  ·  ${health.templateDir}`;
      $("#envInfo").title = `${health.dataDir}\n${health.templateDir}`;
    } catch (error) {
      $("#envInfo").textContent = `接口不可用：${error.message}`;
    }
  }

  async function loadWorlds() {
    const box = $("#worldList");
    box.innerHTML = `<div class="empty">扫描中…</div>`;
    try {
      const body = await api("/api/admin/worlds");
      state.worlds = body.worlds ?? [];
      renderWorldList();
      const prefer =
        state.worlds.find((w) => w.id === state.worldId) ??
        state.worlds.find((w) => w.trace.exists && w.loadable) ??
        state.worlds.find((w) => w.trace.exists) ??
        state.worlds[0];
      if (prefer) selectWorld(prefer.id);
      else box.innerHTML = `<div class="empty">data/worlds 里没有世界</div>`;
    } catch (error) {
      box.innerHTML = `<div class="empty">读取失败：${esc(error.message)}</div>`;
    }
  }

  const STATUS_LABEL = { running: "进行中", terminated: "已终止", archived: "已归档" };

  function renderWorldList() {
    const box = $("#worldList");
    if (state.worlds.length === 0) {
      box.innerHTML = `<div class="empty">data/worlds 里没有世界</div>`;
      return;
    }
    box.innerHTML = state.worlds
      .map((w) => {
        const active = w.id === state.worldId ? " active" : "";
        const statusPill = w.status
          ? `<span class="pill ${w.status === "running" ? "ok" : w.status === "archived" ? "" : "warn"}">${STATUS_LABEL[w.status] ?? w.status}</span>`
          : w.loadable
            ? ""
            : `<span class="pill bad">不可载</span>`;
        const tracePill = w.trace.exists
          ? `<span class="pill trace">trace ${w.trace.entries}</span>`
          : `<span class="pill">无 trace</span>`;
        return `<div class="world-row${active}" data-world="${esc(w.id)}">
          <div class="world-name">${esc(w.playerName ?? "(未知玩家)")} ${statusPill}</div>
          <div class="world-meta">${esc(w.templateId ?? "?")}@${esc(w.templateVersion ?? "?")} · T${num(w.turnIndex)} · ${esc(w.formattedTime ?? "—")}</div>
          <div class="world-meta">${tracePill} <span title="${esc(w.id)}">${esc(w.id.slice(0, 8))}</span></div>
        </div>`;
      })
      .join("");

    for (const row of box.querySelectorAll(".world-row")) {
      row.addEventListener("click", () => selectWorld(row.dataset.world));
    }
  }

  function selectWorld(id) {
    if (state.worldId === id && state.trace) return;
    state.worldId = id;
    state.entryIdx = -1;
    state.trace = null;
    renderWorldList();
    const world = state.worlds.find((w) => w.id === id);
    $("#runCount").textContent = "";
    $("#traceStats").innerHTML = "";
    $("#latencyChart").innerHTML = "";
    $("#runList").innerHTML = "";
    if (!world || !world.trace.exists) {
      $("#traceDetail").innerHTML = `<div class="empty">这个世界没有 trace 文件<br/><span class="hint">叙事还没跑过，或者世界刚建。</span></div>`;
      return;
    }
    loadTrace(id);
  }

  async function loadTrace(id) {
    $("#runList").innerHTML = `<div class="empty">读取 trace…</div>`;
    try {
      const body = await api(`/api/admin/worlds/${encodeURIComponent(id)}/trace`);
      if (state.worldId !== id) return;
      state.trace = body;
      renderTrace();
    } catch (error) {
      $("#runList").innerHTML = `<div class="empty">读取失败：${esc(error.message)}</div>`;
    }
  }

  function renderTrace() {
    const { entries, stats, world } = state.trace;
    $("#runCount").textContent = `${entries.length} 条${state.trace.skippedLines ? ` · 跳过坏行 ${state.trace.skippedLines}` : ""}`;
    renderTraceStats(stats, world, entries);
    renderLatencyChart(entries);
    renderRunList(entries);
    const idx = entries.length - 1;
    if (idx >= 0) selectEntry(idx);
    else $("#traceDetail").innerHTML = `<div class="empty">trace 文件是空的</div>`;
  }

  function renderTraceStats(stats, world, entries) {
    const total = stats.committed + stats.fallback + stats.deferred || 1;
    const rate = Math.round((stats.committed / total) * 100);
    const worldLine = world && world.loadable !== false
      ? `<div class="world-meta" style="margin:-4px 0 10px">${esc(world.templateName ?? "")} · ${esc(world.playerName ?? "")} · T${num(world.turnIndex)} · seed ${num(world.seed)}</div>`
      : "";
    $("#traceStats").innerHTML = `${worldLine}
      <div class="stat"><div class="stat-k">invocation</div><div class="stat-v">${num(entries.length)}</div></div>
      <div class="stat"><div class="stat-k">committed</div><div class="stat-v">${rate}<small>%</small></div></div>
      <div class="stat"><div class="stat-k">in / out tok</div><div class="stat-v">${num(stats.inputTokens)}<small>/${num(stats.outputTokens)}</small></div></div>
      <div class="stat"><div class="stat-k">p95 延迟</div><div class="stat-v">${ms(stats.p95LatencyMs)}</div></div>`;

    const extra = [];
    if (stats.fallback > 0) extra.push(`<span class="chip bad">fallback ${stats.fallback}</span>`);
    if (stats.deferred > 0) extra.push(`<span class="chip">deferred ${stats.deferred}</span>`);
    for (const d of stats.diagnostics.slice(0, 4)) extra.push(`<span class="chip">${esc(d.code)} ×${d.count}</span>`);
    for (const f of stats.fallbackCodes.slice(0, 3)) extra.push(`<span class="chip bad">${esc(f.code)} ×${f.count}</span>`);
    $("#traceStats").insertAdjacentHTML(
      "beforeend",
      extra.length ? `<div style="grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px">${extra.join("")}</div>` : "",
    );
  }

  function renderLatencyChart(entries) {
    const box = $("#latencyChart");
    if (entries.length === 0) {
      box.innerHTML = "";
      return;
    }
    const max = Math.max(...entries.map((e) => e.latencyMs || 0), 0);
    if (max <= 0) {
      box.innerHTML = `<div class="chart-empty">全部 0ms · 当前提供方没有产生真实延迟（模板 / Mock 直出）</div>`;
      return;
    }
    const n = entries.length;
    const w = 100 / n;
    const bars = entries
      .map((e, i) => {
        const h = Math.max(2, ((e.latencyMs || 0) / max) * 88);
        const cls = e.outcome === "committed" ? "#7c8cff" : e.outcome === "fallback" ? "#d8b177" : "#b98cff";
        return `<rect class="bar" data-idx="${i}" x="${i * w + w * 0.18}" y="${92 - h}" width="${w * 0.64}" height="${h}" rx="1" fill="${cls}">
          <title>T${e.turnIndex} · ${esc(e.reason)} · ${ms(e.latencyMs)} · ${e.outcome}</title>
        </rect>`;
      })
      .join("");
    box.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <line x1="0" y1="92" x2="100" y2="92" stroke="#26304a" stroke-width="0.6"/>
      ${bars}
    </svg>`;
    for (const bar of box.querySelectorAll(".bar")) {
      bar.addEventListener("click", () => selectEntry(Number(bar.dataset.idx)));
    }
  }

  function renderRunList(entries) {
    const box = $("#runList");
    box.innerHTML = entries
      .map((e, i) => {
        const active = i === state.entryIdx ? " active" : "";
        const blocks = (e.contentBlocks ?? []).length;
        return `<div class="run${active}" data-idx="${i}">
          <div class="run-turn">T${e.turnIndex}</div>
          <div class="run-reason">
            <div>${esc(e.reason)}</div>
            <div class="run-sub">${esc(e.invocationId)} · ${blocks} 块 · ${(e.calls ?? []).length} 次工具</div>
          </div>
          <div class="run-right">
            <span class="badge ${e.outcome}">${e.outcome}</span><br/>
            ${ms(e.latencyMs)} · ${num((e.inputTokens ?? 0) + (e.outputTokens ?? 0))}tok
          </div>
        </div>`;
      })
      .join("");
    for (const row of box.querySelectorAll(".run")) {
      row.addEventListener("click", () => selectEntry(Number(row.dataset.idx)));
    }
  }

  function selectEntry(idx) {
    state.entryIdx = idx;
    for (const row of document.querySelectorAll(".run")) {
      row.classList.toggle("active", Number(row.dataset.idx) === idx);
    }
    const entry = state.trace?.entries?.[idx];
    if (!entry) return;
    $("#detailHint").textContent = `#${idx + 1} / ${state.trace.entries.length}`;
    renderEntryDetail(entry);
  }

  function renderEntryDetail(entry) {
    const parts = [];
    parts.push(`<h3>${esc(entry.reason)}</h3>
      <div class="kv">
        <dt>invocation</dt><dd>${esc(entry.invocationId)}</dd>
        <dt>turn / 时间</dt><dd>T${entry.turnIndex} @ ${num(entry.worldTime)} 分</dd>
        <dt>结果</dt><dd><span class="badge ${entry.outcome}">${entry.outcome}</span>${entry.fallbackCode ? ` <span class="chip bad">${esc(entry.fallbackCode)}</span>` : ""}</dd>
        <dt>延迟</dt><dd>${ms(entry.latencyMs)}</dd>
        <dt>tokens</dt><dd>${num(entry.inputTokens)} in / ${num(entry.outputTokens)} out</dd>
        <dt>profile</dt><dd>${esc(entry.toolProfile)}</dd>
        <dt>template</dt><dd>${esc(entry.templateRef)}</dd>
      </div>`);

    const blocks = entry.contentBlocks ?? [];
    parts.push(`<h4>正文 / content blocks（${blocks.length}）</h4>`);
    if (blocks.length === 0) parts.push(`<div class="hint">本次没有产出正文块。</div>`);
    for (const block of blocks) {
      const refs = (block.refs ?? []).map((r) => `<span class="chip">${esc(r)}</span>`).join("");
      parts.push(`<div class="narrative">${esc(block.text ?? block.maskText ?? "(无文本)")}</div>
        <div style="margin:-4px 0 10px">
          <span class="chip">${esc(block.blockId)}</span>
          <span class="chip">${esc(block.kind)}</span>
          <span class="chip">${esc(block.visibility)} → ${esc(block.targetPerspective)}</span>
          ${refs}
        </div>`);
    }

    const calls = entry.calls ?? [];
    parts.push(`<h4>工具调用（${calls.length}）</h4>`);
    if (calls.length === 0) parts.push(`<div class="hint">模型没调工具。</div>`);
    else {
      parts.push(
        calls
          .map((call, i) => {
            const json = JSON.stringify(call.args ?? {}, null, 2);
            const inline = JSON.stringify(call.args ?? {});
            return `<div class="call-row"><span class="call-tool">${i + 1}. ${esc(call.tool)}</span><span class="call-args" title="${esc(inline)}">${esc(truncate(inline, 120))}</span></div>`;
          })
          .join(""),
      );
      parts.push(`<details><summary>展开全部参数 JSON</summary><pre class="code">${esc(JSON.stringify(calls, null, 2))}</pre></details>`);
    }

    const receipts = entry.receipts ?? [];
    parts.push(`<h4>回执（${receipts.length}）</h4>`);
    if (receipts.length === 0) parts.push(`<div class="hint">没有回执（本 profile 不写权威状态）。</div>`);
    for (const receipt of receipts) {
      const changes = (receipt.changes ?? [])
        .map((c) => `<span class="chip">${esc(c.fact ?? c.field ?? c.ref ?? JSON.stringify(c))}</span>`)
        .join("");
      parts.push(`<div class="opt">
        <div class="opt-text"><span class="badge ${receipt.outcome === "accepted" ? "committed" : receipt.outcome === "rejected" ? "fallback" : "deferred"}">${esc(receipt.outcome)}</span>
        <span class="call-tool" style="margin-left:6px">${esc(receipt.callId)}</span></div>
        ${receipt.code ? `<div class="diag">code: ${esc(receipt.code)}</div>` : ""}
        ${receipt.detail ? `<div class="hint">${esc(receipt.detail)}</div>` : ""}
        ${changes ? `<div style="margin-top:3px">${changes}</div>` : ""}
        ${receipt.factsHint ? `<details><summary>factsHint</summary><pre class="code">${esc(JSON.stringify(receipt.factsHint, null, 2))}</pre></details>` : ""}
      </div>`);
    }

    const diagnostics = entry.diagnostics ?? [];
    parts.push(`<h4>诊断（${diagnostics.length}）</h4>`);
    parts.push(
      diagnostics.length
        ? diagnostics.map((d) => `<span class="chip bad">${esc(d)}</span>`).join("")
        : `<div class="hint">无。</div>`,
    );

    parts.push(`<h4>哈希 / 取证</h4>
      <div class="kv">
        <dt>contextHash</dt><dd>${esc(entry.contextHash)}</dd>
        <dt>callsHash</dt><dd>${esc(entry.callsHash)}</dd>
      </div>`);

    const flags = state.trace?.world?.flags;
    if (flags && typeof flags === "object") {
      const rows = Object.entries(flags).map(([k, v]) => `<span class="chip flag">${esc(k)} = ${esc(JSON.stringify(v))}</span>`).join("");
      parts.push(`<h4>当前世界旗标</h4><details><summary>${Object.keys(flags).length} 个旗标</summary><div style="margin-top:6px">${rows}</div></details>`);
    }

    $("#traceDetail").innerHTML = parts.join("");
    $("#traceDetail").scrollTop = 0;
  }

  /* ================================ 编排图 ================================ */

  const KIND_LABEL = { normal: "普通", random: "转盘", combat: "战斗" };
  const SOURCE_LABEL = { pool: "池", chain: "链", schedule: "定时", "action-hook": "行动钩" };
  const SOURCE_LETTER = { pool: "P", chain: "C", schedule: "S", "action-hook": "A" };
  const SOURCE_COLOR = { pool: "#4fd1c5", chain: "#b98cff", schedule: "#d8b177", "action-hook": "#6ee7a8" };
  const UNIT_CN = { minute: "分", hour: "时", day: "天", week: "周", month: "月", year: "年" };

  async function loadTemplates() {
    try {
      const body = await api("/api/admin/templates");
      state.templates = [];
      for (const tpl of body.templates ?? []) {
        for (const v of tpl.versions) {
          state.templates.push({
            templateId: tpl.id,
            version: v.version,
            label: `${tpl.name} ${v.version}${v.loadable ? "" : "（不可载）"}`,
            loadable: v.loadable,
            reason: v.reason,
          });
        }
      }
      // 同模板内高版本优先（1.0.0 / 2.0.0 这种补 0 后的数值序），默认打开最新的可载版本。
      const vparts = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
      state.templates.sort((a, b) => {
        if (a.templateId !== b.templateId) return a.templateId.localeCompare(b.templateId);
        const pa = vparts(a.version);
        const pb = vparts(b.version);
        for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
          const d = (pb[i] ?? 0) - (pa[i] ?? 0);
          if (d !== 0) return d;
        }
        return 0;
      });
      const select = $("#tplSelect");
      select.innerHTML = state.templates
        .map(
          (t) =>
            `<option value="${esc(t.templateId)}@${esc(t.version)}"${t.loadable ? "" : " disabled"}>${esc(t.label)}</option>`,
        )
        .join("");
      const firstReady = state.templates.find((t) => t.loadable);
      if (firstReady) {
        select.value = `${firstReady.templateId}@${firstReady.version}`;
        if (state.tab === "graph") loadOrchestration(firstReady.templateId, firstReady.version);
      }
      select.addEventListener("change", () => {
        const [id, version] = select.value.split("@");
        loadOrchestration(id, version);
      });
    } catch (error) {
      $("#tplSelect").innerHTML = `<option>模板读取失败</option>`;
    }
  }

  async function loadOrchestration(templateId, version) {
    $("#canvasEmpty").textContent = "载入模板…";
    $("#canvasEmpty").classList.remove("hidden");
    try {
      const orch = await api(
        `/api/admin/templates/${encodeURIComponent(templateId)}/${encodeURIComponent(version)}/orchestration`,
      );
      state.orch = orch;
      state.tplKey = `${templateId}@${version}`;
      state.selectedNode = null;
      state.flagId = null;
      state.npcId = null;
      state.npcLine = null;
      state.npcHits = null;
      initFilters();
      buildIndex();
      computeLayout();
      renderFlagList();
      renderNpcList();
      renderTermination();
      // 默认选一个入口事件，右栏不至于空着：优先池/行动钩的 depth 0 节点。
      const entryNodes = state.layout.nodes.filter((n) => n.kind === "event" && n.depth === 0);
      const entry =
        entryNodes.find((n) => n.event.trigger.source !== "chain") ?? entryNodes[0] ?? state.layout.nodes[0];
      state.selectedNode = entry ? entry.id : null;
      renderGraph();
      renderInspector(state.selectedNode);
      $("#canvasEmpty").classList.add("hidden");
      const s = orch.stats;
      $("#graphStats").textContent = `${s.eventCount} 事件 · ${s.edgeCount} 边 · ${s.flagCount} 旗标`;
      $("#graphStats").title =
        `悬空边 ${s.danglingEdges.length} · 孤立链事件 ${s.orphanChainEvents.length}` +
        (s.danglingEdges.length ? `\n${s.danglingEdges.map((e) => `${e.from} → ${e.to}`).join("\n")}` : "");
    } catch (error) {
      state.orch = null;
      $("#canvasEmpty").textContent = `载入失败：${error.message}`;
      $("#canvasEmpty").classList.remove("hidden");
      $("#graph").innerHTML = "";
      $("#graphStats").textContent = "";
      $("#flagList").innerHTML = "";
      $("#npcList").innerHTML = "";
      $("#terminationList").innerHTML = "";
    }
  }

  function initFilters() {
    const sources = [...new Set(state.orch.events.map((e) => e.trigger.source))].sort();
    const kinds = [...new Set(state.orch.events.map((e) => e.kind))].sort();
    state.sources = new Set(sources);
    state.kinds = new Set(kinds);
    $("#sourceFilters").innerHTML = sources
      .map((s) => `<span class="filter-chip on" data-source="${esc(s)}">${SOURCE_LETTER[s] ?? "?"} ${esc(s)}</span>`)
      .join("");
    $("#kindFilters").innerHTML = kinds
      .map((k) => `<span class="filter-chip on" data-kind="${esc(k)}">${esc(KIND_LABEL[k] ?? k)}</span>`)
      .join("");
    for (const chip of document.querySelectorAll("#sourceFilters .filter-chip")) {
      chip.addEventListener("click", () => {
        const key = chip.dataset.source;
        if (state.sources.has(key)) state.sources.delete(key);
        else state.sources.add(key);
        chip.classList.toggle("on", state.sources.has(key));
        computeLayout();
        renderGraph();
      });
    }
    for (const chip of document.querySelectorAll("#kindFilters .filter-chip")) {
      chip.addEventListener("click", () => {
        const key = chip.dataset.kind;
        if (state.kinds.has(key)) state.kinds.delete(key);
        else state.kinds.add(key);
        chip.classList.toggle("on", state.kinds.has(key));
        computeLayout();
        renderGraph();
      });
    }
  }

  function buildIndex() {
    const orch = state.orch;
    orch._byId = new Map(orch.events.map((e, i) => [e.id, { event: e, index: i }]));
    orch._flagById = new Map(orch.flags.map((f) => [f.id, f]));
    orch._charName = new Map(orch.characters.map((c) => [c.id, c.name]));
    orch._itemName = new Map(orch.items.map((i) => [i.id, i.name]));
    orch._skillName = new Map(orch.skills.map((s) => [s.id, s.name]));
    orch._statusName = new Map(orch.statuses.map((s) => [s.id, s.name]));
  }

  /* ---------- 布局：按 nextEventId 分层 + 重心排序 ---------- */

  const NODE_W = 182;
  const NODE_H = 48;
  const COL_GAP = 108;
  const ROW_GAP = 16;

  function isVisible(event) {
    if (!state.sources.has(event.trigger.source)) return false;
    if (!state.kinds.has(event.kind)) return false;
    if (state.onlyConnected) {
      const hasEdge = state.orch.edges.some((e) => e.from === event.id || e.to === event.id);
      if (!hasEdge) return false;
    }
    return true;
  }

  function computeLayout() {
    const orch = state.orch;
    const visibleEvents = orch.events.filter(isVisible);
    const visibleIds = new Set(visibleEvents.map((e) => e.id));
    const edges = orch.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

    const preds = new Map(visibleEvents.map((e) => [e.id, []]));
    const depth = new Map(visibleEvents.map((e) => [e.id, 0]));
    for (const edge of edges) {
      preds.get(edge.to)?.push(edge.from);
    }
    // 最长路径松弛；有环时靠上限截断（图里 back edge 只会到更早的列）
    const MAX_DEPTH = 24;
    for (let pass = 0; pass < 40; pass += 1) {
      let changed = false;
      for (const edge of edges) {
        const dFrom = depth.get(edge.from) ?? 0;
        const dTo = depth.get(edge.to) ?? 0;
        if (dFrom < MAX_DEPTH && dTo < dFrom + 1) {
          depth.set(edge.to, dFrom + 1);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const columns = [];
    for (const event of visibleEvents) {
      const d = depth.get(event.id) ?? 0;
      (columns[d] ??= []).push(event);
    }

    const nodes = [];
    const nodeById = new Map();
    columns.forEach((col, d) => {
      if (!col) return;
      col.sort((a, b) => {
        const ia = orch._byId.get(a.id).index;
        const ib = orch._byId.get(b.id).index;
        return ia - ib;
      });
      for (const event of col) {
        const node = {
          id: event.id,
          kind: "event",
          event,
          depth: d,
          x: 40 + d * (NODE_W + COL_GAP),
          y: 0,
          w: NODE_W,
          h: NODE_H,
        };
        nodes.push(node);
        nodeById.set(node.id, node);
      }
    });

    const assignY = () => {
      for (const col of columns) {
        if (!col) continue;
        let y = 0;
        for (const event of col) {
          const node = nodeById.get(event.id);
          node.y = y;
          y += NODE_H + ROW_GAP;
        }
      }
    };
    assignY();

    // 重心排序：两轮 left→right，减少交叉
    for (let iter = 0; iter < 2; iter += 1) {
      for (let d = 1; d < columns.length; d += 1) {
        const col = columns[d];
        if (!col || col.length === 0) continue;
        for (const event of col) {
          const ps = preds.get(event.id) ?? [];
          const ys = ps.map((id) => nodeById.get(id)).filter(Boolean).map((n) => n.y);
          nodeById.get(event.id).bc = ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : 1e6;
        }
        col.sort((a, b) => nodeById.get(a.id).bc - nodeById.get(b.id).bc);
        assignY();
      }
    }

    // 列太长会把整张图压到看不清（首个池事件列能有 30+ 个），
    // 所以每列按 CHUNK 折成多条并排的子列；横向 slot 依次递增。
    const CHUNK = 12;
    const chunks = [];
    let slot = 0;
    for (const col of columns) {
      if (!col || col.length === 0) continue;
      for (let i = 0; i < col.length; i += CHUNK) {
        chunks.push({ events: col.slice(i, i + CHUNK), slot });
        slot += 1;
      }
    }
    const maxRows = Math.max(1, ...chunks.map((c) => c.events.length));
    const maxHeight = maxRows * (NODE_H + ROW_GAP);
    for (const chunk of chunks) {
      const h = chunk.events.length * (NODE_H + ROW_GAP);
      const dy = (maxHeight - h) / 2;
      chunk.events.forEach((event, i) => {
        const node = nodeById.get(event.id);
        node.x = 40 + chunk.slot * (NODE_W + COL_GAP);
        node.y = dy + i * (NODE_H + ROW_GAP);
      });
    }

    // 结局节点：单独一列，接在最后一个 slot 右边
    if (state.showEndings && orch.endings.length > 0) {
      const endDepth = slot;
      orch.endings.forEach((ending, i) => {
        const node = {
          id: `end:${ending.endingId}`,
          kind: "ending",
          ending,
          depth: endDepth,
          x: 40 + endDepth * (NODE_W + COL_GAP),
          y: i * (NODE_H + ROW_GAP),
          w: NODE_W,
          h: NODE_H,
        };
        nodes.push(node);
        nodeById.set(node.id, node);
      });
    }

    // 结局边：写这些 flag 的事件 → 结局
    const endEdges = [];
    if (state.showEndings) {
      for (const ending of orch.endings) {
        const flags = new Set([...(ending.triggerConditions ?? []), ...(ending.unlockConditions ?? [])].map((c) => c.flag).filter(Boolean));
        const writers = new Set();
        for (const flag of flags) {
          for (const w of orch._flagById.get(flag)?.writers ?? []) writers.add(w.eventId);
        }
        for (const writer of writers) {
          if (!visibleIds.has(writer)) continue;
          endEdges.push({ from: writer, to: `end:${ending.endingId}`, type: "ending", label: ending.name });
        }
      }
    }

    state.layout = { nodes, nodeById, edges, endEdges, columns, bbox: bounds(nodes) };
    fitView("height");
  }

  function bounds(nodes) {
    if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    return { minX, minY, maxX, maxY };
  }

  function fitView(mode = "height") {
    const svg = $("#graph");
    const rect = svg.getBoundingClientRect();
    const bbox = state.layout?.bbox;
    // 视图隐藏时 rect 为 0：此时算出来的 k=0 会把整张图缩没，直接跳过。
    if (!bbox || rect.width < 40 || rect.height < 40) return;
    const gw = Math.max(1, bbox.maxX - bbox.minX);
    const gh = Math.max(1, bbox.maxY - bbox.minY);
    if (mode === "overview") {
      // 全览：能看到全图，但 100 个事件下字会很小 —— 这是"适配"按钮的语义。
      const k = Math.min(rect.width / (gw + 90), rect.height / (gh + 90), 1.15);
      state.view = {
        k,
        x: (rect.width - (bbox.maxX + bbox.minX) * k) / 2,
        y: (rect.height - (bbox.maxY + bbox.minY) * k) / 2,
      };
    } else {
      // 默认：按高度适配（节点文字可读），横向从第一列开始，往右拖。
      const k = Math.min(1, Math.max(0.55, (rect.height - 70) / gh));
      state.view = {
        k,
        x: 36 - bbox.minX * k,
        y: (rect.height - (bbox.maxY + bbox.minY) * k) / 2,
      };
    }
    applyTransform();
  }

  function applyTransform() {
    const vp = $("#graph .viewport");
    if (vp) vp.setAttribute("transform", `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`);
    $("#graph").classList.toggle("zoom-far", state.view.k < 0.75);
  }

  /* ---------- 渲染 ---------- */

  function renderGraph() {
    const svg = $("#graph");
    if (!state.layout) {
      svg.innerHTML = "";
      return;
    }
    const { nodes, nodeById, edges, endEdges } = state.layout;
    const focus = focusSet();

    const parts = [];
    parts.push(`<defs>
      <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L8,4 L0,8 z" fill="#3a4767"/>
      </marker>
      <marker id="arrow-hl" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L8,4 L0,8 z" fill="#4fd1c5"/>
      </marker>
    </defs>`);
    parts.push(`<g class="viewport"></g>`);
    svg.innerHTML = parts.join("");
    const vp = svg.querySelector(".viewport");

    const edgeMarkup = [];
    const allEdges = [...edges, ...(endEdges ?? [])];
    for (const edge of allEdges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const x2 = to.x;
      const y2 = to.y + to.h / 2;
      const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
      const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      const isHl = focus && focus.nodes.has(edge.from) && focus.nodes.has(edge.to);
      const isDim = focus && !isHl;
      const classes = ["edge", edge.type === "enqueue" ? "enqueue" : "", edge.type === "defeat" ? "defeat" : "", isHl ? "hl" : "", isDim ? "dim" : ""]
        .filter(Boolean)
        .join(" ");
      const marker = isHl ? "arrow-hl" : "arrow";
      edgeMarkup.push(
        `<path class="${classes}" d="${d}" marker-end="url(#${marker})"${isHl ? ' data-hl="1"' : ""}></path>`,
      );
      if (edge.type !== "enqueue" && edge.type !== "ending") {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        edgeMarkup.push(
          `<text class="edge-label" x="${mx}" y="${my - 4}" text-anchor="middle">${esc(truncate(edge.label, 9))}</text>`,
        );
      }
    }
    vp.innerHTML = edgeMarkup.join("");

    const nodeMarkup = nodes.map((node) => {
      if (node.kind === "ending") {
        const dim = focus && !focus.nodes.has(node.id) ? " dim" : "";
        return `<g class="node k-ending${state.selectedNode === node.id ? " sel" : ""}${dim}" data-node="${esc(node.id)}" transform="translate(${node.x},${node.y})">
          <rect class="box" x="0" y="0" width="${node.w}" height="${node.h}" rx="8"></rect>
          <text class="node-ending-title" x="12" y="21">${esc(truncate(node.ending.name, 13))}</text>
          <text class="node-id" x="12" y="36">${esc(truncate(node.ending.endingId, 24))}</text>
          <text class="node-badge" x="${node.w - 12}" y="21" text-anchor="end">END</text>
        </g>`;
      }
      const event = node.event;
      const dim = focus && !focus.nodes.has(node.id) ? " dim" : "";
      const hl = focus && focus.nodes.has(node.id) ? " hl" : "";
      const sel = state.selectedNode === node.id ? " sel" : "";
      const writes = countWrites(event.id);
      const sourceColor = SOURCE_COLOR[event.trigger.source] ?? "#8b94ab";
      return `<g class="node k-${esc(event.kind)}${dim}${hl}${sel}" data-node="${esc(event.id)}" transform="translate(${node.x},${node.y})">
        <rect class="box" x="0" y="0" width="${node.w}" height="${node.h}" rx="8"></rect>
        <text class="node-source" x="10" y="14" fill="${sourceColor}">${esc(SOURCE_LETTER[event.trigger.source] ?? "?")}</text>
        <text class="node-title" x="24" y="15">${esc(truncate(event.title, 15))}</text>
        <text class="node-id" x="10" y="31">${esc(truncate(event.id, 25))}</text>
        ${writes > 0 ? `<text class="node-badge" x="${node.w - 10}" y="15" text-anchor="end">⚑${writes}</text>` : ""}
        <text class="node-id" x="${node.w - 10}" y="31" text-anchor="end" fill="#4f5b78">${esc(truncate(event.kind, 6))}${optionsCount(event)}</text>
      </g>`;
    });
    vp.insertAdjacentHTML("beforeend", nodeMarkup.join(""));
    applyTransform();
    bindGraphEvents();
  }

  function countWrites(eventId) {
    let count = 0;
    for (const flag of state.orch.flags) {
      if (flag.writers.some((w) => w.eventId === eventId)) count += 1;
    }
    return count;
  }

  function optionsCount(event) {
    if (event.kind === "normal") return ` · ${event.settle.normal.options.length}选项`;
    if (event.kind === "random") return ` · ${event.settle.random.wheel.segments.length}段`;
    if (event.kind === "combat") return ` · ${event.settle.combat.enemies.length}敌`;
    return "";
  }

  /** 当前高亮集合：搜索 / 旗标 / 悬停，三者取交集语义里最具体的一个。 */
  function focusSet() {
    const orch = state.orch;
    if (!orch) return null;
    if (state.npcId && state.npcHits) {
      const name = state.npcLine?.character?.name ?? state.npcId;
      return { nodes: state.npcHits, label: `角色 ${name}` };
    }
    if (state.flagId) {
      const flag = orch._flagById.get(state.flagId);
      if (flag) {
        const ids = new Set();
        for (const w of flag.writers) ids.add(w.eventId);
        for (const r of flag.readers) if (r.eventId) ids.add(r.eventId);
        return { nodes: ids, label: `flag ${state.flagId}` };
      }
    }
    const q = state.search.trim().toLowerCase();
    if (q) {
      const ids = new Set();
      for (const event of orch.events) {
        const hay = `${event.id} ${event.title} ${event.narrative ?? ""}`.toLowerCase();
        if (hay.includes(q)) ids.add(event.id);
      }
      for (const flag of orch.flags) {
        if (flag.id.toLowerCase().includes(q)) {
          for (const w of flag.writers) ids.add(w.eventId);
          for (const r of flag.readers) if (r.eventId) ids.add(r.eventId);
        }
      }
      return { nodes: ids, label: `搜索 ${state.search}` };
    }
    return null;
  }

  /* ---------- 交互：平移 / 缩放 / 悬停 / 点击 ---------- */

  function bindGraphEvents() {
    const svg = $("#graph");
    const vp = svg.querySelector(".viewport");
    if (!vp) return;

    let dragging = false;
    let moved = false;
    let last = null;
    // setPointerCapture 会把后续 pointerup 与派生的 click 重定向到 svg 本身，
    // 到 click 时 ev.target 已经指不到节点，只能在按下时先记住点的是谁。
    let pressedNode = null;

    svg.onpointerdown = (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      moved = false;
      pressedNode = ev.target.closest?.(".node")?.dataset.node ?? null;
      last = { x: ev.clientX, y: ev.clientY };
      svg.classList.add("panning");
      svg.setPointerCapture?.(ev.pointerId);
    };
    svg.onpointermove = (ev) => {
      if (!dragging || !last) return;
      const dx = ev.clientX - last.x;
      const dy = ev.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      state.view.x += dx;
      state.view.y += dy;
      last = { x: ev.clientX, y: ev.clientY };
      applyTransform();
    };
    svg.onpointerup = (ev) => {
      dragging = false;
      last = null;
      svg.classList.remove("panning");
      // 主动释放捕获，别把后续事件继续绑在 svg 上（拖拽结束就还回去）。
      if (ev && svg.hasPointerCapture?.(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
    };
    svg.onpointerleave = () => {
      dragging = false;
      last = null;
      pressedNode = null;
      svg.classList.remove("panning");
    };

    svg.onwheel = (ev) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextK = Math.min(2.6, Math.max(0.16, state.view.k * factor));
      const ratio = nextK / state.view.k;
      state.view.x = px - (px - state.view.x) * ratio;
      state.view.y = py - (py - state.view.y) * ratio;
      state.view.k = nextK;
      applyTransform();
    };

    svg.onclick = (ev) => {
      if (moved) {
        pressedNode = null;
        return;
      }
      const nodeEl = ev.target.closest?.(".node");
      const id = nodeEl?.dataset.node ?? pressedNode;
      pressedNode = null;
      // 点空白处取消选中；点节点则切过去（重复点同一节点不再取消，避免像点了没反应）。
      selectNode(id ?? null);
    };

    // 悬停：标签 + 邻边高亮
    const tooltip = $("#tooltip");
    svg.onpointerover = (ev) => {
      const nodeEl = ev.target.closest?.(".node");
      if (!nodeEl) return;
      const id = nodeEl.dataset.node;
      const node = state.layout.nodeById.get(id);
      if (!node) return;
      if (node.kind === "ending") {
        tooltip.innerHTML = `<b>结局 · ${esc(node.ending.name)}</b><div class="tt-id">${esc(node.ending.endingId)}</div><div>${esc(truncate(node.ending.description ?? "", 90))}</div>`;
      } else {
        const e = node.event;
        const incoming = state.layout.edges.filter((x) => x.to === id).length;
        const outgoing = state.layout.edges.filter((x) => x.from === id).length;
        tooltip.innerHTML = `<b>${esc(e.title)}</b><div class="tt-id">${esc(e.id)}</div>
          <div>${esc(KIND_LABEL[e.kind] ?? e.kind)} · ${esc(SOURCE_LABEL[e.trigger.source] ?? e.trigger.source)} · 入 ${incoming} / 出 ${outgoing}</div>`;
      }
      tooltip.classList.remove("hidden");
      const rect = svg.getBoundingClientRect();
      const x = Math.min(rect.width - 320, ev.clientX - rect.left + 14);
      const y = Math.min(rect.height - 90, ev.clientY - rect.top + 12);
      tooltip.style.left = `${Math.max(6, x)}px`;
      tooltip.style.top = `${Math.max(6, y)}px`;
    };
    svg.onpointerout = (ev) => {
      if (ev.target.closest?.(".node")) tooltip.classList.add("hidden");
    };
  }

  function selectNode(id) {
    state.selectedNode = id;
    if (state.flagId) {
      // 旗标高亮和节点选择是两种聚焦，切到节点时收起旗标，免得两套 dim 打架。
      state.flagId = null;
      renderFlagList();
    }
    if (state.npcId) {
      state.npcId = null;
      state.npcLine = null;
      state.npcHits = null;
      renderNpcList();
    }
    if (state.layout) renderGraph();
    renderInspector(state.selectedNode);
  }

  /* ---------- 旗标列表 ---------- */

  function renderFlagList() {
    const orch = state.orch;
    const box = $("#flagList");
    const rows = orch.flags
      .map(
        (flag) => `<div class="flag-row${state.flagId === flag.id ? " active" : ""}" data-flag="${esc(flag.id)}">
          <span title="${esc(flag.id)}">${esc(truncate(flag.id, 26))}</span>
          <span class="w" title="写入事件数">✎${flag.writers.length}</span>
          <span class="r" title="读取点数量">👁${flag.readers.length}</span>
        </div>`,
      )
      .join("");
    box.innerHTML = rows || `<div class="hint">没有旗标</div>`;
    for (const row of box.querySelectorAll(".flag-row")) {
      row.addEventListener("click", () => {
        state.flagId = state.flagId === row.dataset.flag ? null : row.dataset.flag;
        // 旗标与角色线互斥，同时只保留一套高亮。
        if (state.npcId) {
          state.npcId = null;
          state.npcLine = null;
          state.npcHits = null;
          renderNpcList();
        }
        renderFlagList();
        renderGraph();
        renderFlagInspector(state.flagId);
      });
    }
  }

  /* ---------- 角色线 ---------- */

  function renderNpcList() {
    const orch = state.orch;
    const box = $("#npcList");
    if (!orch) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = orch.characters
      .map(
        (c) => `<div class="flag-row${state.npcId === c.id ? " active" : ""}" data-npc="${esc(c.id)}" title="${esc(c.id)}">
          <span>${esc(truncate(c.name, 14))}</span>
          <span class="r">${c.isEnemy ? "⚔" : ""}</span>
        </div>`,
      )
      .join("");
    for (const row of box.querySelectorAll(".flag-row")) {
      row.addEventListener("click", () => selectNpc(row.dataset.npc));
    }
  }

  async function selectNpc(id) {
    if (!state.orch) return;
    if (state.npcId === id) {
      state.npcId = null;
      state.npcLine = null;
      state.npcHits = null;
      renderNpcList();
      renderGraph();
      renderInspector(state.selectedNode);
      return;
    }
    const orch = state.orch;
    const character = orch.characters.find((c) => c.id === id);
    state.npcId = id;
    state.npcLine = null;
    state.npcHits = null;
    // 角色线和旗标高亮是同一级别的聚焦，同时开两套 dim 会互相打架。
    state.flagId = null;
    renderFlagList();
    renderNpcList();
    $("#inspectorHint").textContent = id;
    $("#inspector").innerHTML = `<div class="empty">载入 ${esc(character?.name ?? id)} 的线…</div>`;
    try {
      const line = await api(
        `/api/admin/templates/${encodeURIComponent(orch.template.id)}/${encodeURIComponent(orch.template.version)}/npc/${encodeURIComponent(id)}`,
      );
      if (state.npcId !== id) return; // 用户已经点了别人
      state.npcLine = line;
      state.npcHits = new Set(line.scenes.map((s) => s.eventId));
      renderGraph();
      renderNpcInspector(line);
    } catch (error) {
      if (state.npcId !== id) return;
      $("#inspector").innerHTML = `<div class="empty">载入失败：${esc(error.message)}</div>`;
    }
  }

  function renderNpcInspector(line) {
    const c = line.character;
    $("#inspectorHint").textContent = c.id;
    const bits = [c.isEnemy ? "敌人" : "友方"];
    if (c.gender) bits.push(c.gender);
    if (c.age !== undefined) bits.push(`${c.age} 岁`);
    // visibility 只在 hidden 时值得说：那意味着玩家端投影看不到他。
    if (c.visibility === "hidden") bits.push("hidden（玩家不可见）");

    const parts = [
      `<h3>${esc(c.name)}</h3>
       <div class="sub">${esc(c.id)} · ${esc(bits.join(" · "))}</div>
       <div class="chips"><span class="chip">${line.scenes.length} 个场景</span>
       ${line.lifecycle.length > 0 ? `<span class="chip">${line.lifecycle.length} 次生死</span>` : ""}
       ${line.spawns.length > 0 ? `<span class="chip">${line.spawns.length} 次登场</span>` : ""}</div>`,
    ];
    if (c.description) parts.push(`<div class="narrative">${esc(c.description)}</div>`);
    if (c.relations.length > 0) {
      parts.push(
        `<h4>初始关系</h4>${c.relations
          .map(
            (r) =>
              `<div class="eff">${esc(r.to)} <span class="hint">${esc(r.kind)}${r.value !== undefined ? ` ${r.value}` : ""}${r.visibility ? ` · ${esc(r.visibility)}` : ""}</span></div>`,
          )
          .join("")}`,
      );
    }
    if (line.spawns.length > 0 || line.lifecycle.length > 0) {
      const rows = [
        ...line.spawns.map(
          (s) => `<div class="eff"><span class="k">登场</span> <span class="next-link" data-goto="${esc(s.eventId)}">${esc(s.eventId)}</span> <span class="hint">规则 ${esc(s.ruleId)}${s.age !== undefined ? ` · ${s.age} 岁` : ""}</span></div>`,
        ),
        ...line.lifecycle.map(
          (s) => `<div class="eff"><span class="k">生命</span> <span class="next-link" data-goto="${esc(s.eventId)}">${esc(s.eventId)}</span> <span class="hint">→ ${esc(s.state)}${s.reason ? ` · ${esc(s.reason)}` : ""}</span></div>`,
        ),
      ];
      parts.push(`<h4>登场与生死</h4>${rows.join("")}`);
    }
    parts.push(
      `<h4>场景（${line.scenes.length}）</h4>${line.scenes
        .map((s) => {
          const turn = (s.details ?? []).filter((d) => d.startsWith("⚑ ")).slice(0, 2);
          return `<div class="npc-scene">
            <div><span class="next-link" data-goto="${esc(s.eventId)}">${esc(s.eventId)}</span>
              <span class="hint">${esc(s.roles.join(" / "))}${s.era !== undefined ? ` · era ${s.era}` : ""}${s.chapter !== undefined ? ` · ch${s.chapter}` : ""}</span></div>
            <div>${esc(truncate(s.title, 34))}</div>
            ${turn.map((t) => `<div class="hint">${esc(t)}</div>`).join("")}
          </div>`;
        })
        .join("")}`,
    );
    const box = $("#inspector");
    box.innerHTML = parts.join("");
    for (const link of box.querySelectorAll("[data-goto]")) {
      link.addEventListener("click", () => jumpTo(link.dataset.goto));
    }
  }

  function renderTermination() {
    const orch = state.orch;
    const box = $("#terminationList");
    if (!orch.termination || orch.termination.length === 0) {
      box.innerHTML = `<div class="hint">没有终止条件</div>`;
      return;
    }
    box.innerHTML = orch.termination
      .map((t) => {
        const conds = (t.params?.conditions ?? []).map((c) => `<span class="cond">${esc(condText(c))}</span>`).join("");
        return `<div class="term-item"><div class="t-type">${esc(t.type)}</div>
          <div style="margin-top:1px">${conds || '<span class="hint">（无条件）</span>'}</div>
          <div class="hint">${esc(t.combinator ?? "AND")} · ${esc(t.terminationMode ?? "afterSettle")}</div>
        </div>`;
      })
      .join("");
  }

  /* ---------- 条件 / 效果 文案 ---------- */

  const cmpText = (c) => {
    const ops = [];
    if (c.eq !== undefined) ops.push(`= ${JSON.stringify(c.eq)}`);
    if (c.ne !== undefined) ops.push(`≠ ${JSON.stringify(c.ne)}`);
    if (c.gte !== undefined) ops.push(`≥ ${c.gte}`);
    if (c.lte !== undefined) ops.push(`≤ ${c.lte}`);
    if (c.gt !== undefined) ops.push(`> ${c.gt}`);
    if (c.lt !== undefined) ops.push(`< ${c.lt}`);
    return ops.join(" ");
  };

  const timeText = (t) => {
    if (typeof t === "string") return t;
    if (t && typeof t === "object" && "value" in t) return `${t.value}${UNIT_CN[t.unit] ?? t.unit}`;
    return JSON.stringify(t);
  };

  function attrLabel(id) {
    return state.orch?.labels?.[id] ?? id;
  }

  function npcName(id) {
    return state.orch?._charName?.get(id) ?? id;
  }

  function condText(c) {
    if (c === null || typeof c !== "object") return String(c);
    if (c.flag !== undefined) return `flag:${c.flag} ${cmpText(c)}`;
    if (c.attribute !== undefined) return `${attrLabel(c.attribute)} ${cmpText(c)}`;
    if (c.status !== undefined) {
      const bits = [c.present === false ? "不存在" : c.present === true ? "存在" : ""];
      if (c.stacksGte !== undefined) bits.push(`层 ≥ ${c.stacksGte}`);
      return `状态 ${state.orch?._statusName?.get(c.status) ?? c.status} ${bits.filter(Boolean).join(" ")}`;
    }
    if (c.inventory !== undefined) return `持有 ${state.orch?._itemName?.get(c.inventory) ?? c.inventory} ≥ ${c.gte}`;
    if (c.mood !== undefined) {
      const bits = [];
      if (c.mood.gte !== undefined) bits.push(`≥ ${c.mood.gte}`);
      if (c.mood.lte !== undefined) bits.push(`≤ ${c.mood.lte}`);
      return `心情 ${bits.join(" ")}`;
    }
    if (c.relation !== undefined) {
      const bits = [cmpText(c)];
      if (c.kind) bits.push(`(${c.kind})`);
      if (c.to) bits.push(`→ ${npcName(c.to)}`);
      return `关系 ${npcName(c.relation)} ${bits.filter(Boolean).join(" ")}`;
    }
    if (c.requiresSkill !== undefined) return `技能 ${state.orch?._skillName?.get(c.requiresSkill) ?? c.requiresSkill}`;
    if (c.selfIs !== undefined) return `self = ${npcName(c.selfIs)}`;
    if (c.selfIsNot !== undefined) return `self ≠ ${npcName(c.selfIsNot)}`;
    if (c.random !== undefined) return `随机 ≤ ${c.random}`;
    if (c.time !== undefined) {
      const bits = [];
      for (const key of ["gte", "lte", "gt", "lt"]) {
        if (c.time[key] !== undefined) bits.push(`${key === "gte" ? "≥" : key === "lte" ? "≤" : key === "gt" ? ">" : "<"} ${timeText(c.time[key])}`);
      }
      return `时间 ${bits.join(" ")}`;
    }
    if (c.npcState !== undefined) return `${npcName(c.npcState.npcId)} · ${c.npcState.state}`;
    if (c.op !== undefined) return `${c.op}(${JSON.stringify(c.args)})`;
    return JSON.stringify(c);
  }

  function effectText(e) {
    if (e === null || typeof e !== "object") return String(e);
    const sign = (v) => `<span class="${v >= 0 ? "pos" : "neg"}">${v >= 0 ? "+" : ""}${v}</span>`;
    switch (e.type) {
      case "setFlag":
        return `<span class="k">flag</span> ${esc(e.id)} = ${esc(JSON.stringify(e.value))}`;
      case "adjustFlag":
        return `<span class="k">flag</span> ${esc(e.id)} ${sign(e.value)}`;
      case "clearFlag":
        return `<span class="k">flag</span> ${esc(e.id)} 清除`;
      case "adjustAttribute":
        return `${esc(attrLabel(e.attribute))} ${sign(e.value)}`;
      case "adjustResource":
        // 资源名从编排数据的 `resources` 映射取（模板 statusBar 的 label）；
        // 缺省印协议键（hp / mp），不替某个世界叫它「生命 / 咒力」。
        return `${esc(state.orch?.resources?.[e.resource] ?? e.resource)} ${sign(e.value)}`;
      case "adjustMood":
        return `心情 ${sign(e.value)}`;
      case "grantItem":
        return `获得 ${esc(state.orch?._itemName?.get(e.itemId) ?? e.itemId)} ×${e.count ?? 1}`;
      case "removeItem":
        return `失去 ${esc(state.orch?._itemName?.get(e.itemId) ?? e.itemId)} ×${e.count ?? 1}`;
      case "adjustRelation":
        if (e.npcId !== undefined) return `关系 ${esc(npcName(e.npcId))} ${sign(e.value)}`;
        return `关系边 ${esc(npcName(e.fromId ?? "?"))}→${esc(npcName(e.toId ?? "player"))} ${sign(e.value)}`;
      case "addRelationEdge":
        return `建边 ${esc(npcName(e.fromId))}→${esc(npcName(e.toId))} (${esc(e.kind)})`;
      case "applyStatus":
        return `施加状态 ${esc(state.orch?._statusName?.get(e.status) ?? e.status)}`;
      case "cureStatus":
        return `解除状态 ${esc(state.orch?._statusName?.get(e.status) ?? e.status)}`;
      case "spawnNpc":
        return `拉上场 ${esc(e.ruleId)}`;
      case "enqueueEvent":
        return `入队事件 ${esc(e.eventId)}`;
      case "setNpcLifecycle":
        return `${esc(npcName(e.npcId))} → ${esc(e.state)}${e.reasonCode ? ` <span class="hint">${esc(e.reasonCode)}</span>` : ""}`;
      case "setNpcVisibility":
        return `${esc(npcName(e.npcId))} → ${e.visibility === "hidden" ? "隐藏" : "显示"}`;
      case "addSecret":
        return `秘闻 ${esc(npcName(e.npcId))}: ${esc(truncate(e.text, 24))}`;
      case "freezeRelationsOnDeath":
        return `死亡时冻结 ${esc(npcName(e.npcId))} 的关系边`;
      case "adjustGrowth":
        return `成长值 ${sign(e.value)}`;
      case "adjustProficiency":
        return `熟练度 ${esc(e.skillId ?? e.skill ?? "")} ${sign(e.value)}`;
      case "advanceBy":
        return `时间 +${esc(timeText(e.value))}`;
      case "startChain":
        return `开始链 ${esc(e.chainId)}`;
      case "advanceChain":
        return `推进链 ${esc(e.chainId)}`;
      case "cancelChain":
        return `取消链 ${esc(e.chainId)}`;
      case "unlockSkill":
        return `解锁技能 ${esc(state.orch?._skillName?.get(e.skillId ?? e.skill) ?? (e.skillId ?? e.skill))}`;
      case "log":
        return `日志（${esc(e.visibility ?? "public")}）${esc(truncate(e.text, 30))}`;
      case "setIdentity": {
        const bits = [];
        if (e.name) bits.push(`名 ${e.name}`);
        if (e.gender) bits.push(`性别 ${e.gender}`);
        if (e.age !== undefined) bits.push(`年龄 ${e.age}`);
        return `改写身份 ${esc(bits.join(" · "))}`;
      }
      case "advanceTo":
        return `推进到 ${esc(timeText(e.value ?? e.time ?? e))}`;
      default:
        return `<span class="k">${esc(e.type ?? "?")}</span> <span class="json">${esc(truncate(JSON.stringify(e), 72))}</span>`;
    }
  }

  const KNOWN_EFFECTS = new Set([
    "setFlag","adjustFlag","clearFlag","adjustAttribute","adjustResource","adjustMood",
    "grantItem","removeItem","adjustRelation","addRelationEdge","applyStatus","cureStatus",
    "spawnNpc","enqueueEvent","setIdentity","advanceTo","setNpcLifecycle","setNpcVisibility","addSecret",
    "freezeRelationsOnDeath","adjustGrowth","adjustProficiency","advanceBy","startChain",
    "advanceChain","cancelChain","unlockSkill","log",
  ]);

  function effectsHtml(effects) {
    if (!effects || effects.length === 0) return "";
    return effects
      .map((e) => {
        const known = e && typeof e === "object" && KNOWN_EFFECTS.has(e.type);
        return `<div class="eff${known ? "" : " fallback"}" title="${esc(JSON.stringify(e))}">· ${effectText(e)}</div>`;
      })
      .join("");
  }

  /* ---------- inspector ---------- */

  function renderInspector(nodeId) {
    const box = $("#inspector");
    if (!nodeId) {
      box.innerHTML = `<div class="empty">点一个节点看事件编排</div>`;
      $("#inspectorHint").textContent = "";
      return;
    }
    const node = state.layout?.nodeById.get(nodeId);
    if (!node) return;
    if (node.kind === "ending") {
      renderEndingInspector(node.ending);
      return;
    }
    const event = node.event;
    const trigger = event.trigger;

    $("#inspectorHint").textContent = event.id;
    const parts = [];
    parts.push(`<h3>${esc(event.title)}</h3>
      <div class="sub">${esc(event.id)}</div>
      <div class="chips">
        <span class="chip">${esc(KIND_LABEL[event.kind] ?? event.kind)}</span>
        <span class="chip">${esc(SOURCE_LABEL[trigger.source] ?? trigger.source)}</span>
        ${trigger.probability !== undefined ? `<span class="chip">p=${trigger.probability}</span>` : ""}
        ${trigger.weight !== undefined ? `<span class="chip">weight=${trigger.weight}</span>` : ""}
        ${trigger.once ? `<span class="chip">once</span>` : ""}
        ${trigger.priority !== undefined ? `<span class="chip">priority=${trigger.priority}</span>` : ""}
      </div>`);

    const timing = [];
    if (trigger.cooldown) timing.push(`冷却 ${timeText(trigger.cooldown)}`);
    if (trigger.delay) timing.push(`延迟 ${timeText(trigger.delay)}`);
    if (trigger.timeCost) timing.push(`耗时 ${timeText(trigger.timeCost)}`);
    if (trigger.window) timing.push(`窗口 ${timeText(trigger.window.start)}${trigger.window.end ? ` → ${timeText(trigger.window.end)}` : "+"}`);
    if (trigger.onActionId) timing.push(`行动 ${trigger.onActionId}`);
    if (timing.length) parts.push(`<h4>时间</h4>${timing.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}`);

    if (trigger.conditions?.length) {
      parts.push(`<h4>触发条件</h4>${trigger.conditions.map((c) => `<span class="cond">${esc(condText(c))}</span>`).join("")}`);
    }
    if (trigger.missWhen?.length) {
      parts.push(
        `<h4>错失条件${trigger.missLabel ? ` · ${esc(trigger.missLabel)}` : ""}</h4>${trigger.missWhen
          .map((c) => `<span class="cond">${esc(condText(c))}</span>`)
          .join("")}`,
      );
    }

    const cast = [];
    for (const id of event.actors ?? []) cast.push(`<span class="chip">在场 ${esc(npcName(id))}</span>`);
    for (const id of event.mentions ?? []) cast.push(`<span class="chip">提及 ${esc(npcName(id))}</span>`);
    for (const id of event.npcs ?? []) cast.push(`<span class="chip ok">上场 ${esc(npcName(id))}</span>`);
    if (cast.length) parts.push(`<h4>角色</h4>${cast.join("")}`);

    if (event.narrative) parts.push(`<h4>叙事模板</h4><div class="narrative" style="font-size:12px">${esc(event.narrative)}</div>`);

    if (event.kind === "normal") {
      parts.push(`<h4>选项（${event.settle.normal.options.length}）</h4>`);
      for (const option of event.settle.normal.options) {
        parts.push(`<div class="opt">
          <div class="opt-text">${esc(option.text)}</div>
          <div class="opt-id">${esc(option.id)}</div>
          ${option.visibleWhen?.length ? `<div style="margin-top:3px">${option.visibleWhen.map((c) => `<span class="cond">${esc(condText(c))}</span>`).join("")}</div>` : ""}
          ${effectsHtml(option.effects)}
          ${option.nextEventId ? `<div style="margin-top:3px">→ <span class="next-link" data-goto="${esc(option.nextEventId)}">${esc(option.nextEventId)}</span></div>` : ""}
        </div>`);
      }
    } else if (event.kind === "random") {
      parts.push(`<h4>转盘（${event.settle.random.wheel.segments.length} 段）</h4>`);
      for (const segment of event.settle.random.wheel.segments) {
        const by = segment.weightBy ? Object.entries(segment.weightBy).map(([k, v]) => `${attrLabel(k)}×${v}`).join(" ") : "";
        parts.push(`<div class="opt">
          <div class="opt-text">${esc(segment.label)} <span class="opt-id">w=${segment.weight}${by ? ` · ${esc(by)}` : ""}</span></div>
          ${effectsHtml(segment.effects)}
          ${segment.nextEventId ? `<div style="margin-top:3px">→ <span class="next-link" data-goto="${esc(segment.nextEventId)}">${esc(segment.nextEventId)}</span></div>` : ""}
        </div>`);
      }
    } else {
      const combat = event.settle.combat;
      const enemies = combat.enemies.map((e) => `${npcName(e.ref)}${e.levelScale ? `×${e.levelScale}` : ""}`).join("、");
      parts.push(`<h4>战斗</h4><div class="chip">敌人 ${esc(enemies)}</div>${combat.canFlee ? `<span class="chip">可逃</span>` : ""}`);
      for (const [label, outcome] of [
        ["胜利", combat.onVictory],
        ["战败", combat.onDefeat],
        ["逃跑", combat.onFlee],
      ]) {
        if (!outcome) continue;
        parts.push(`<div class="opt"><div class="opt-text">${label}</div>
          ${effectsHtml(outcome.effects)}
          ${outcome.nextEventId ? `<div style="margin-top:3px">→ <span class="next-link" data-goto="${esc(outcome.nextEventId)}">${esc(outcome.nextEventId)}</span></div>` : ""}
        </div>`);
      }
    }

    const writes = state.orch.flags.filter((f) => f.writers.some((w) => w.eventId === event.id));
    const reads = state.orch.flags.filter((f) => f.readers.some((r) => r.eventId === event.id));
    if (writes.length) {
      parts.push(`<h4>写入旗标（${writes.length}）</h4>`);
      parts.push(
        writes
          .map((f) => {
            const how = f.writers.filter((w) => w.eventId === event.id).map((w) => `${w.optionId ?? ""} ${w.how}`.trim());
            return `<div class="eff"><span class="k">${esc(f.id)}</span> <span class="hint">${esc(how.join(" / "))}</span></div>`;
          })
          .join(""),
      );
    }
    if (reads.length) {
      parts.push(`<h4>读取旗标（${reads.length}）</h4>`);
      parts.push(
        reads
          .map((f) => {
            const where = f.readers.filter((r) => r.eventId === event.id).map((r) => r.where).join(", ");
            return `<div class="eff"><span class="k">${esc(f.id)}</span> <span class="hint">${esc(where)}</span></div>`;
          })
          .join(""),
      );
    }

    const outgoing = state.orch.edges.filter((e) => e.from === event.id);
    const incoming = state.orch.edges.filter((e) => e.to === event.id);
    if (outgoing.length) {
      parts.push(`<h4>后继（${outgoing.length}）</h4>`);
      parts.push(outgoing.map((e) => `<span class="chip link" data-goto="${esc(e.to)}">${esc(e.type)}: ${esc(truncate(e.label, 12))} → ${esc(e.to)}</span>`).join(""));
    }
    if (incoming.length) {
      parts.push(`<h4>前驱（${incoming.length}）</h4>`);
      parts.push(incoming.map((e) => `<span class="chip link" data-goto="${esc(e.from)}">${esc(e.from)} → ${esc(e.type)}</span>`).join(""));
    }

    box.innerHTML = parts.join("");
    box.scrollTop = 0;
    for (const link of box.querySelectorAll("[data-goto]")) {
      link.addEventListener("click", () => jumpTo(link.dataset.goto));
    }
  }

  function renderEndingInspector(ending) {
    $("#inspectorHint").textContent = ending.endingId;
    const parts = [`<h3>${esc(ending.name)}</h3><div class="sub">${esc(ending.endingId)}</div>
      <div class="chips">
        <span class="chip">${esc(ending.endingType ?? "neutral")}</span>
        <span class="chip">priority ${ending.priority ?? 0}</span>
        ${ending.fallback ? `<span class="chip">兜底</span>` : ""}
        ${ending.narrativeConfig?.masked ? `<span class="chip bad">隐藏结局</span>` : ""}
        ${ending.exclusiveGroup ? `<span class="chip">互斥 ${esc(ending.exclusiveGroup)}</span>` : ""}
      </div>
      <div class="narrative" style="font-size:12px">${esc(ending.description ?? "")}</div>`];
    if (ending.triggerConditions?.length) {
      parts.push(`<h4>触发条件</h4>${ending.triggerConditions.map((c) => `<span class="cond">${esc(condText(c))}</span>`).join("")}`);
    }
    if (ending.unlockConditions?.length) {
      parts.push(`<h4>解锁条件</h4>${ending.unlockConditions.map((c) => `<span class="cond">${esc(condText(c))}</span>`).join("")}`);
    }
    $("#inspector").innerHTML = parts.join("");
  }

  function renderFlagInspector(flagId) {
    if (!flagId) {
      renderInspector(state.selectedNode);
      return;
    }
    const flag = state.orch._flagById.get(flagId);
    if (!flag) return;
    $("#inspectorHint").textContent = "flag";
    const writers = flag.writers
      .map((w) => {
        const how = `<span class="hint">${esc(w.optionId ?? "")} ${esc(w.how)}</span>`;
        // 开局写入没有图上的事件节点，渲染成纯文本，避免点不动的链接。
        return w.source === "opening"
          ? `<div class="eff"><span class="k">开局</span> ${esc(w.eventId)} ${how}</div>`
          : `<div class="eff"><span class="next-link" data-goto="${esc(w.eventId)}">${esc(w.eventId)}</span> ${how}</div>`;
      })
      .join("");
    const readers = flag.readers
      .map((r) => {
        const where = `<span class="hint">${esc(r.where)}${r.optionId ? ` · ${esc(r.optionId)}` : ""}</span>`;
        // 结局 / 终止条件读旗标没有单一事件，别渲染成可点但点不动的链接。
        return r.eventId
          ? `<div class="eff"><span class="next-link" data-goto="${esc(r.eventId)}">${esc(r.eventId)}</span> ${where}</div>`
          : `<div class="eff"><span class="k">${esc(r.ref ?? (r.where === "termination" ? "终止条件" : "结局条件"))}</span> ${where}</div>`;
      })
      .join("");
    $("#inspector").innerHTML = `<h3>${esc(flag.id)}</h3>
      <div class="sub">写入 ${flag.writers.length} · 读取 ${flag.readers.length}</div>
      <h4>写入</h4>${writers || '<div class="hint">没人写它</div>'}
      <h4>读取</h4>${readers || '<div class="hint">没人读它</div>'}`;
    for (const link of $("#inspector").querySelectorAll("[data-goto]")) {
      link.addEventListener("click", () => jumpTo(link.dataset.goto));
    }
  }

  function jumpTo(eventId) {
    const node = state.layout?.nodeById.get(eventId);
    if (!node) return;
    state.selectedNode = eventId;
    const svg = $("#graph");
    const rect = svg.getBoundingClientRect();
    state.view.x = rect.width / 2 - (node.x + node.w / 2) * state.view.k;
    state.view.y = rect.height / 2 - (node.y + node.h / 2) * state.view.k;
    applyTransform();
    for (const el of document.querySelectorAll("#graph .node")) {
      el.classList.toggle("sel", el.dataset.node === eventId);
    }
    renderInspector(eventId);
  }

  /* ---------- 工具条 ---------- */

  $("#zoomIn").addEventListener("click", () => {
    state.view.k = Math.min(2.6, state.view.k * 1.2);
    applyTransform();
  });
  $("#zoomOut").addEventListener("click", () => {
    state.view.k = Math.max(0.16, state.view.k / 1.2);
    applyTransform();
  });
  $("#fitView").addEventListener("click", () => fitView("overview"));

  let searchTimer = null;
  $("#graphSearch").addEventListener("input", (ev) => {
    state.search = ev.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.layout) renderGraph();
    }, 140);
  });

  $("#showEndings").addEventListener("change", (ev) => {
    state.showEndings = ev.target.checked;
    if (state.orch) {
      computeLayout();
      renderGraph();
    }
  });

  $("#onlyConnected").addEventListener("change", (ev) => {
    state.onlyConnected = ev.target.checked;
    if (state.orch) {
      computeLayout();
      renderGraph();
    }
  });

  $("#refreshWorlds").addEventListener("click", () => loadWorlds());

  window.addEventListener("resize", () => {
    if (state.tab === "graph") applyTransform();
  });

  /* ================================ 战斗木桩 ================================ */

  /**
   * 这一栏是 `simulateDuel`（`packages/game-core/src/v2/sim.ts`）的遥控器。
   *
   * 页面**不碰任何战斗规则**：建世界、摆对手、每回合挑技能、结算全在内核里跑，
   * 这里只做三件事 —— 把表单翻译成 `SimDuelSpec`、POST 出去、把报告画出来。
   * 所以量到的数字就是玩家真打出来的数字；表单改坏了（角色 id 打错）也只是 400，
   * 不会在浏览器里造出第二套伤害公式。
   */

  const SIM_DUMMY = "__dummy__";
  const OUTCOME_LABEL = { victory: "胜", defeat: "败", undecided: "未决" };
  const simState = { roster: null, key: null, running: false, booted: false };

  const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
  const fixed = (v, n = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(n) : "—");

  const simKey = () => $("#simTpl").value || "";

  /** `agility=8,hp=500` → `{ agility: 8, hp: 500 }`（与 CLI 的 `--dummy` 同一套写法）。 */
  function parseOverrides(text) {
    const out = {};
    for (const piece of String(text ?? "").split(/[,;]/)) {
      const item = piece.trim();
      if (item === "") continue;
      const eq = item.indexOf("=");
      if (eq <= 0) continue;
      const key = item.slice(0, eq).trim();
      const value = Number(item.slice(eq + 1));
      if (key !== "" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  }

  const parseIds = (text) =>
    String(text ?? "")
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s !== "");

  /** 模板列表是启动时异步拉的；这里等它落地，避免自己再 fetch 一次（会重复挂 select 监听）。 */
  async function waitTemplates() {
    for (let i = 0; i < 50 && state.templates.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function bootSim() {
    if (!simState.booted) {
      simState.booted = true;
      await waitTemplates();
      const select = $("#simTpl");
      if (select.options.length === 0) {
        select.innerHTML = state.templates
          .map(
            (t) =>
              `<option value="${esc(t.templateId)}@${esc(t.version)}"${t.loadable ? "" : " disabled"}>${esc(t.label)}</option>`,
          )
          .join("");
        const firstReady = state.templates.find((t) => t.loadable);
        if (firstReady) select.value = `${firstReady.templateId}@${firstReady.version}`;
      }
    }
    await loadSimRoster();
  }

  async function loadSimRoster(force = false) {
    const key = simKey();
    if (key === "") return;
    if (!force && simState.roster !== null && simState.key === key) return;
    const [templateId, version] = key.split("@");
    $("#simRosterHint").textContent = "读取角色…";
    try {
      const roster = await api(
        `/api/admin/templates/${encodeURIComponent(templateId)}/${encodeURIComponent(version)}/roster`,
      );
      simState.roster = roster;
      simState.key = key;
      fillSimActors(roster);
      $("#simRosterHint").textContent = `${roster.characters.length} 角色 · ${roster.statuses.length} 补正`;
    } catch (error) {
      simState.roster = null;
      $("#simRosterHint").textContent = `读取失败：${error.message}`;
    }
  }

  function fillSimActors(roster) {
    const keepLeft = $("#simLeft").value;
    const keepRight = $("#simRight").value;
    const options = roster.characters
      .map(
        (c) =>
          `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.id)}${c.isEnemy ? " · 敌" : ""}${c.visibility === "hidden" ? " · 隐" : ""}</option>`,
      )
      .join("");
    $("#simLeft").innerHTML = options;
    $("#simRight").innerHTML = `${options}<option value="${SIM_DUMMY}">木桩（不还手）</option>`;

    const left = roster.characters.find((c) => c.id === keepLeft) ? keepLeft : (roster.characters.find((c) => c.id === "npc-gojo")?.id ?? roster.characters[0]?.id ?? "");
    $("#simLeft").value = left;
    $("#simRight").value =
      keepRight === SIM_DUMMY || roster.characters.some((c) => c.id === keepRight) ? keepRight : SIM_DUMMY;
    syncSimDummy();
    renderSimPickers(roster);
  }

  /** 把模板词表渲染成可点选芯片；文本输入框保留为「高级手填」入口，两边互相同步。 */
  function renderSimPickers(roster) {
    const selected = () => simState.roster?.characters.find((c) => c.id === $("#simLeft").value);
    const attrBox = $("#simAttrPicker");
    attrBox.innerHTML = roster.attributeKeys
      .map((key) => {
        const label = roster.attributeLabels?.[key] ?? key;
        const hint = selected()?.attributes?.[key] ?? roster.attributeDefaults?.[key];
        return `<label class="pick" title="角色卡 ${esc(String(hint ?? "—"))}">
          <span>${esc(label)} <small>${esc(key)}</small></span>
          <input type="number" step="1" data-attr="${esc(key)}" placeholder="${esc(String(hint ?? ""))}" />
        </label>`;
      })
      .join("");

    const idPicker = (boxId, items, inputId) => {
      const box = $(boxId);
      const chosen = new Set(parseIds($(inputId).value));
      box.innerHTML = items
        .map(
          (item) => `<label class="pick${chosen.has(item.id) ? " on" : ""}">
            <input type="checkbox" data-id="${esc(item.id)}"${chosen.has(item.id) ? " checked" : ""} />
            <span>${esc(item.name)} <small>${esc(item.id)}</small></span>
          </label>`,
        )
        .join("");
      box.onchange = () => {
        $(inputId).value = [...box.querySelectorAll("input:checked")].map((el) => el.dataset.id).join(",");
        for (const label of box.querySelectorAll(".pick")) {
          label.classList.toggle("on", label.querySelector("input")?.checked === true);
        }
      };
      $(inputId).oninput = () => {
        const next = new Set(parseIds($(inputId).value));
        for (const label of box.querySelectorAll(".pick")) {
          const checked = next.has(label.querySelector("input")?.dataset.id ?? "");
          label.querySelector("input").checked = checked;
          label.classList.toggle("on", checked);
        }
      };
    };
    idPicker("#simStatusPicker", roster.statuses ?? [], "#simLeftStatuses");
    idPicker("#simEquipmentPicker", (roster.items ?? []).filter((i) => i.slot), "#simLeftEquipment");
    idPicker("#simSkillPicker", roster.skills ?? [], "#simLeftSkills");

    $("#simTraitPicker").innerHTML = (roster.traits ?? [])
      .map((trait) => {
        const own = (selected()?.traits ?? []).includes(trait);
        return `<span class="pick${own ? " on" : ""}">${esc(trait)}</span>`;
      })
      .join("");

    attrBox.oninput = () => {
      const parts = [];
      for (const input of attrBox.querySelectorAll("input[data-attr]")) {
        if (input.value.trim() !== "" && Number.isFinite(Number(input.value))) {
          parts.push(`${input.dataset.attr}=${Number(input.value)}`);
        }
      }
      $("#simLeftAttributes").value = parts.join(",");
    };
    $("#simLeftAttributes").oninput = () => {
      const next = parseOverrides($("#simLeftAttributes").value);
      for (const input of attrBox.querySelectorAll("input[data-attr]")) {
        const value = next[input.dataset.attr];
        input.value = value === undefined ? "" : String(value);
      }
    };
  }

  function applyLeftPreset() {
    const roster = simState.roster;
    const char = roster?.characters.find((c) => c.id === $("#simLeft").value);
    if (!char) return;
    const attrBox = $("#simAttrPicker");
    for (const input of attrBox.querySelectorAll("input[data-attr]")) {
      const value = char.attributes?.[input.dataset.attr];
      input.value = value === undefined ? "" : String(value);
    }
    attrBox.oninput?.();
    const setIds = (boxId, inputId, ids) => {
      const box = $(boxId);
      for (const label of box.querySelectorAll(".pick")) {
        const input = label.querySelector("input");
        if (!input) continue;
        input.checked = ids.includes(input.dataset.id);
        label.classList.toggle("on", input.checked);
      }
      $(inputId).value = ids.join(",");
    };
    setIds("#simStatusPicker", "#simLeftStatuses", char.statuses ?? []);
    setIds("#simEquipmentPicker", "#simLeftEquipment", char.equipment ?? []);
    $("#simLeftSkills").value = "";
    for (const label of $("#simSkillPicker").querySelectorAll(".pick")) {
      const input = label.querySelector("input");
      if (input) { input.checked = false; label.classList.remove("on"); }
    }
  }

  async function startLive() {
    await bootSim();
    const [templateId, version] = simKey().split("@");
    const detail = { templateId, version, spec: buildSimSpec(), seed: Number($("#simSeed").value) || 1 };
    activateTab("live");
    window.dispatchEvent(new CustomEvent("life-sim:live-start", { detail }));
  }

  function syncSimDummy() {
    $("#simDummyFields").hidden = $("#simRight").value !== SIM_DUMMY;
  }

  function buildSimSpec() {
    const left = { ref: $("#simLeft").value };
    const leftAttributes = parseOverrides($("#simLeftAttributes").value);
    const leftStatuses = parseIds($("#simLeftStatuses").value);
    const leftEquipment = parseIds($("#simLeftEquipment").value);
    const extraSkills = parseIds($("#simLeftSkills").value);
    const ownSkills = simState.roster?.characters.find((c) => c.id === left.ref)?.skills ?? [];
    const allSkills = [...new Set([...ownSkills, ...extraSkills])];
    if (Object.keys(leftAttributes).length > 0) left.attributes = leftAttributes;
    if (leftStatuses.length > 0) left.statuses = leftStatuses;
    if (leftEquipment.length > 0) left.equipment = leftEquipment;
    if (allSkills.length > 0) left.skills = allSkills;

    let right;
    if ($("#simRight").value === SIM_DUMMY) {
      const hp = Number($("#simDummyHp").value);
      const attributes = parseOverrides($("#simDummyAttrs").value);
      right = {
        dummy: {
          name: "木桩",
          ...(Number.isFinite(hp) && hp > 0 ? { hp } : {}),
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        },
      };
    } else {
      right = { ref: $("#simRight").value };
    }

    const repeat = Number($("#simRepeat").value);
    const maxRounds = Number($("#simMaxRounds").value);
    const seed = Number($("#simSeed").value);
    const stance = $("#simStance").value;
    return {
      left,
      right,
      ...(Number.isFinite(repeat) ? { repeat } : {}),
      ...(Number.isFinite(maxRounds) ? { maxRounds } : {}),
      ...(Number.isFinite(seed) ? { seed } : {}),
      ...(stance === "coverage" ? { stance } : {}),
    };
  }

  function showSimError(message) {
    const box = $("#simError");
    box.textContent = message;
    box.hidden = false;
  }

  async function runSim() {
    const key = simKey();
    if (key === "" || simState.running) return;
    const [templateId, version] = key.split("@");
    simState.running = true;
    const button = $("#simRun");
    button.disabled = true;
    button.textContent = "结算中…";
    $("#simError").hidden = true;
    try {
      const report = await api("/api/admin/sim", {
        method: "POST",
        body: JSON.stringify({ templateId, version, spec: buildSimSpec() }),
      });
      renderSimReport(report);
      $("#simMeta").textContent = `${simState.key} · ${report.duels} 局`;
    } catch (error) {
      showSimError(error.message);
      $("#simMeta").textContent = "";
    } finally {
      simState.running = false;
      button.disabled = false;
      button.textContent = "跑一场";
    }
  }

  function renderSimReport(report) {
    const uses = Object.entries(report.skillUse ?? {}).sort((a, b) => b[1] - a[1]);
    const top = uses.length > 0 ? uses[0][1] : 1;
    const bars = uses
      .map(
        ([id, total]) => `<div class="sim-bar-row">
          <span class="sim-bar-name" title="${esc(id)}">${esc(id)}</span>
          <span class="sim-bar-track"><span class="sim-bar-fill" style="width:${Math.max(2, (total / top) * 100).toFixed(1)}%"></span></span>
          <span class="sim-bar-val">${(total / report.duels).toFixed(2)} /局</span>
        </div>`,
      )
      .join("");

    const rows = (report.rows ?? [])
      .map(
        (row, index) => `<tr>
          <td>#${index + 1}</td>
          <td><span class="outcome ${esc(row.outcome)}">${esc(OUTCOME_LABEL[row.outcome] ?? row.outcome)}</span></td>
          <td>${num(row.rounds)}</td>
          <td>${num(row.damageDealt)}</td>
          <td>${num(row.damageTaken)}</td>
          <td>${row.attacks > 0 ? `${row.hits}/${row.attacks}` : "—"}</td>
          <td>${num(row.mpSpent)}</td>
          <td>${num(row.endHp)}<small>/${num(row.maxHp)}</small></td>
        </tr>`,
      )
      .join("");

    $("#simResult").innerHTML = `
      <div class="sim-head">
        ${esc(report.leftName)}
        <span class="vs">vs</span>
        ${esc(report.rightName)}
        <span class="hint">${num(report.duels)} 局 · 场均 ${fixed(report.avgRounds)} 回合</span>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-k">胜率</div><div class="stat-v">${pct(report.winRate)}</div></div>
        <div class="stat"><div class="stat-k">胜 / 负 / 未决</div><div class="stat-v">${num(report.wins)}<small>/${num(report.losses)}/${num(report.undecided)}</small></div></div>
        <div class="stat"><div class="stat-k">DPR（每回合输出）</div><div class="stat-v">${fixed(report.dpr)}</div></div>
        <div class="stat"><div class="stat-k">每回合承伤</div><div class="stat-v">${fixed(report.takenPerRound)}</div></div>
        <div class="stat"><div class="stat-k">命中率</div><div class="stat-v">${pct(report.hitRate)}</div></div>
        <div class="stat"><div class="stat-k">MP / 局</div><div class="stat-v">${fixed(report.mpSpentPerDuel)}</div></div>
        <div class="stat"><div class="stat-k">残血比</div><div class="stat-v">${pct(report.endHpRatio)}</div></div>
        ${
          report.summonsPerDuel > 0
            ? `<div class="stat"><div class="stat-k">召唤峰值</div><div class="stat-v">${fixed(report.summonsPerDuel)}</div></div>`
            : ""
        }
      </div>
      ${
        uses.length > 0
          ? `<div class="chart-title">技能使用 <span class="hint">均摊到每局</span></div><div class="sim-bars">${bars}</div>`
          : ""
      }
      <div class="sim-table-wrap">
        <table class="sim-table">
          <thead>
            <tr>
              <th>局</th><th>结果</th><th>回合</th><th>输出</th><th>承伤</th><th>命中</th><th>MP</th><th>残血</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  /* ================================ 启动 ================================ */

  const tabFromHash = () => {
    const hash = location.hash.replace("#", "");
    return hash === "graph" || hash === "sim" || hash === "live" ? hash : "trace";
  };

  $("#simTpl").addEventListener("change", () => loadSimRoster(true));
  $("#simRight").addEventListener("change", syncSimDummy);
  $("#simRun").addEventListener("click", runSim);
  $("#simLeft").addEventListener("change", () => {
    if (simState.roster) renderSimPickers(simState.roster);
  });
  $("#simUsePreset").addEventListener("click", applyLeftPreset);
  $("#simToLive").addEventListener("click", startLive);
  $("#liveStart").addEventListener("click", startLive);
  $("#liveAuto").addEventListener("click", () => window.dispatchEvent(new CustomEvent("life-sim:live-auto")));
  for (const input of document.querySelectorAll("#view-sim input")) {
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") runSim();
    });
  }

  bootHealth();
  loadWorlds();
  loadTemplates();
  if (location.hash !== "") activateTab(tabFromHash());
  window.addEventListener("hashchange", () => {
    const tab = tabFromHash();
    if (tab !== state.tab) activateTab(tab);
  });
})();
