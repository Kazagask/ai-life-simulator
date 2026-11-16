import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CloudSession } from "@tencent-ai/workbuddy-cloud-sdk";
import "./style.css";
import {
  ApiError,
  api,
  clearLlmSession,
  defaultVersionOf,
  fetchNarrative,
  getLlmSession,
  isLoadableVersion,
  loadableVersionOf,
  mergeEventFlavors,
  resolveEventNarrative,
  streamNarrative,
  submitLlmCredentials,
} from "./api";
import type {
  BattleCommand,
  EndingView,
  EventFlavorMap,
  NarrativeSource,
  SlotEventView,
  TemplateSummary,
  V2Snapshot,
  WheelResultView,
  WorldSummary,
} from "./api";
import { bootstrapAuth, signOutOfWorkBuddy, signInWithWorkBuddy, userDisplayName } from "./auth";
import { cloud } from "./cloud";
import {
  isPlatformLlmAvailable,
  platformEndingNarrative,
  platformEventFlavor,
  platformEvaluationSummary,
} from "./platformLlm";
import { deleteLifeRecord, listLifeRecords, saveLifeRecord, shouldAutoArchive } from "./records";
import type { LifeRecordRow } from "./records";
import { interactionMode, toActPayload, toViewModel } from "@life-sim/rpg-ui";
import type { ActHandler, ContentBlockVM, ViewModel } from "@life-sim/rpg-ui";
import { ActionDock } from "./ActionDock";
import { NarrativeStage } from "./NarrativeStage";

// ---------- 工具 ----------

/**
 * 从 SSE 原始草稿里**只取** `<narrative-content>` 内的文字。
 *
 * 用户裁决：标签外的流（思维链 / 工具调用报错）一律不渲染。未闭合时显示最后一个开标签
 * 之后的内容（正在流），并剥掉可能半截的闭标签。
 */
function narrativeDraftText(raw: string): string {
  const re = /<narrative-content>([\s\S]*?)<\/narrative-content>/g;
  const blocks: string[] = [];
  for (let match = re.exec(raw); match !== null; match = re.exec(raw)) {
    const text = match[1]?.trim() ?? "";
    if (text.length > 0) blocks.push(text);
  }
  if (blocks.length > 0) return blocks.join("\n\n");
  const open = raw.lastIndexOf("<narrative-content>");
  if (open < 0) return "";
  return raw
    .slice(open + "<narrative-content>".length)
    .replace(/<\/?narrative-content>?$/, "")
    .trim();
}

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

/**
 * 「AI 叙事」中性小标记（R2.7 / T-S1 / T-S2）：仅在服务端明确回传 `llm` 来源时渲染。
 * `template` / `fallback` / 字段缺失 ⇒ 不渲染任何额外节点，DOM 与改前逐字一致（零回归底线）。
 * 隐藏结局由服务端保证「不做 LLM 装饰」（narrativeSource 恒非 llm），故不会带此标记，
 * 前端也绝不据此补全或反推 hidden 原文。
 */
function AiNarrativeTag() {
  return <span className="tag ai-narrative-tag">AI 叙事</span>;
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

type Tab = "life" | "personal" | "world" | "log" | "records";

interface LastResult {
  /** 该响应对应的轮次：用于判断「这批结果是刚结算的」还是「从存档恢复的」（D-09） */
  turnIndex: number;
  elapsed: string;
  events: Array<{ id: string; title: string; narrative: string }>;
  wheel: WheelResultView | null;
  /**
   * R2.7 / R-NAR-03：本次响应可选附带的事件 flavor 展示文案。
   * 纯瞬态、只供当次渲染消费；不进 localStorage、不进 records.ts 人生档案、刷新即失。
   */
  eventFlavors?: EventFlavorMap;
}

/**
 * 把 `GET /api/worlds/:id`（含 409 冲突刷新）带回的 eventFlavors 合并进既有 lastResult
 * （R2.7 / T-S3 补齐）：flavor 是 fire-and-forget，常到下一轮 / 刷新才出现，这两条刷新
 * 路径此前只保留 `res.snapshot`，会把已生成的 LLM 展示文案丢掉。
 *
 * 三条护栏（零回归底线）：
 *  ① `prev === null` ⇒ 原样返回 null：页面刷新 / 新世界**绝不凭空造出** lastResult（保住 D-09）；
 *  ② `prev.turnIndex !== turnIndex` ⇒ 原样返回 prev：避免切换世界后把上一局事件与 flavor 错位拼接；
 *  ③ 合并无变化（`undefined` / `{}` / 全空串）⇒ 返回同一引用，React 跳过重渲染，
 *     字段缺失时 UI 与改前逐字一致。
 */
function withMergedFlavors(
  prev: LastResult | null,
  nextFlavors: EventFlavorMap | undefined,
  turnIndex: number,
): LastResult | null {
  if (prev === null || prev.turnIndex !== turnIndex) return prev;
  const merged = mergeEventFlavors(prev.eventFlavors, nextFlavors);
  return merged === prev.eventFlavors ? prev : { ...prev, eventFlavors: merged };
}

// ---------- 呈现槽（ADR-0034 §5） ----------

/**
 * 槽位占位者：事件区的呈现单位 ——「正常事件 / 随机事件 / 战斗 / 自由行动」四者共用一个区域。
 *
 * ADR-0034 之后这**不再是前端排出来的优先级**：占位者由服务端投影 `V2Snapshot.slotEvent`
 * （唯一真源）的 `kind` 一一映射而来，前端只负责按它选面板。
 */
type SlotOccupant = "wheel" | "battle" | "event" | "action";

/** `slotEvent.kind` → 事件区的呈现者。空槽即自由行动。 */
function occupantOf(slot: SlotEventView | null): SlotOccupant {
  if (slot === null) return "action";
  if (slot.kind === "random") return "wheel";
  if (slot.kind === "combat") return "battle";
  return "event";
}

const SLOT_BADGE: Record<SlotOccupant, string> = {
  wheel: "随机事件",
  battle: "战斗",
  event: "待你决定",
  action: "自由行动",
};

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
  /**
   * F3 / T-07：AI 叙事正文（从服务端 append-only trace 读回）。
   *
   * 正文**不进存档**，所以刷新后必须重新拉取；每轮结算（`snapshot.turnIndex` 变化）后再拉一次，
   * 让新写的叙事接在流末尾。只读展示数据：不参与任何游戏判定，失败时保持空数组。
   */
  const [narrative, setNarrative] = useState<ContentBlockVM[]>([]);
  /**
   * 流式草稿：SSE 增量里**只**显示 `<narrative-content>` 内的正文。
   * 收尾（turn 响应 + 正式块拉回）后清空，避免与正式块双份。
   */
  const [narrativeDraft, setNarrativeDraft] = useState("");
  /**
   * R2.7 / T-S2：归档响应里的人生总结来源（llm / template / fallback）。
   * 只在 `archiveWorld` 成功时写入，按 worldId 派生 —— 切到别的世界自动失效，无需额外重置。
   * 纯瞬态展示元数据：不写 localStorage、不进 records.ts 人生档案、不参与评分。
   */
  const [archiveSummarySource, setArchiveSummarySource] = useState<{
    worldId: string;
    summarySource: NarrativeSource | undefined;
  } | null>(null);
  // ---------- 账号登录（ADR-0025） ----------
  // 认证**不阻塞游戏**：这三个状态只影响「档案」页签与结算页的一行提示。
  const [session, setSession] = useState<CloudSession | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  // 自动写档案的**状态跃迁基线**：每个 worldId 上一次见到的 status（见下方 effect）。
  // 不是「去重表」——按快照存在与否去重会在「登录回跳整页重载」时必然补写一次，
  // 而 ADR-0025 决策 8 明文禁止登录回跳后自动补写。
  const lastStatusRef = React.useRef<Map<string, string>>(new Map());
  // 竞态锁：React state 同帧不生效，双击会双发请求（第二个撞 409）——用 ref 同步判断
  const busyRef = React.useRef(false);
  const worldIdRef = React.useRef<string | null>(worldId);
  worldIdRef.current = worldId;

  /**
   * 接上启动期的认证回执（回调已在模块顶层处理完，见文件末尾 `authBootstrap`）。
   * 订阅放在回执之后：`INITIAL_SESSION` 会立即回放一次，若与回调兑换并发，
   * 可能用「回调前的空会话」覆盖刚拿到的会话。
   */
  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    void authBootstrap.then((res) => {
      if (!alive) return;
      setSession(res.session);
      setAuthReady(true);
      if (res.error) setAuthNotice(res.error);
      unsubscribe = cloud.auth.onAuthStateChange((_event, next) => {
        if (alive) setSession(next);
      });
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  /**
   * 结局**产生的那一刻**写一次云端档案（ADR-0025 决策 8）。
   *
   * 判据是**状态跃迁** `running → terminated|archived`，不是「快照已经是终态」：
   * 后者在三种「不是结局产生」的场景里都会误写一次 ——
   *   ① 未登录打完一局 → 点登录 → 回跳整页重载（session 非空 + 快照已终止）；
   *   ② 已登录刷新一个已终止的旧局；
   *   ③ 已登录从列表打开一个早已终止的旧局。
   * 这三种都是**补写**，决策 8 明确要求改成由玩家在档案页显式点「把这局存进档案」。
   *
   * 实现：每个 `worldId` 记一条「上次见到的 status」基线。
   * - 首次挂载该 worldId（prev === undefined）⇒ 只写基线，**不落库**；
   * - 同一挂载期内从 `running` 走到终态 ⇒ 写 1 次；
   * - 已是终态再进 effect（登录、刷新、切页签、重渲染）⇒ 不写。
   *
   * `status` 缺省按协议视为 `running`（V2Snapshot.status 可选），否则旧存档 / 老服务端
   * 会把「running → 结局」这条唯一该写的跃迁判成 undefined → terminated 而漏写。
   *
   * 调用点全部在副作用里（不在 render 里写数据）；失败静默：`records.ts` 内只按
   * stage + code/status 记日志，绝不进 `error` 通道，也不影响 `/api/**` 主链路。
   */
  useEffect(() => {
    if (!snapshot) return;
    const status = snapshot.status ?? "running";
    const prev = lastStatusRef.current.get(snapshot.worldId);
    // 先更新基线：即使这次不写（未登录 / 无结局），也记住「我已经见过这个状态」，
    // 避免后续一次无关的 session 或快照变化把旧终态误判成刚发生的跃迁。
    lastStatusRef.current.set(snapshot.worldId, status);
    const write = shouldAutoArchive({ prev, status, hasEnding: snapshot.ending != null, signedIn: session !== null });
    if (!write) return;
    void saveLifeRecord(snapshot);
  }, [session, snapshot]);

  useEffect(() => {
    if (!worldId) return;
    api
      .getWorld(worldId)
      .then((res) => {
        setSnapshot(res.snapshot);
        // 刷新可能带回异步生成的 flavor：只在已有 lastResult 且轮次一致时补进 map；
        // prev === null（首次挂载 / 页面刷新）时原样返回 null，不制造瞬态结果。
        setLastResult((prev) => withMergedFlavors(prev, res.eventFlavors, res.snapshot.turnIndex));
      })
      .catch(() => {
        // localStorage 里的 worldId 已失效（存档被删 / 坏档被跳过）：
        // 回到列表并提示，而不是静默吞掉（R-PS-04 / design §3.8）
        clearWorldId();
        setWorldId(null);
        setNotice("这一局已不存在（可能已被删除），已回到列表。");
      });
  }, [worldId]);

  /**
   * F3 / T-07：拉取叙事正文。
   *
   * 依赖轮次 `turnIndex`：挂载（刷新 / 打开旧局）+ 每次回合结算后都重新读一次 trace，
   * 因此 AI 叙事在刷新后依然存在（正文存服务端，不进存档）。
   * 等首个快照到位再拉，避免挂载期发两次相同请求；切换世界 / 重开时清空，避免叙事串局。
   */
  const turnIndex = snapshot?.turnIndex;
  useEffect(() => {
    if (!worldId) {
      setNarrative([]);
      return;
    }
    if (turnIndex === undefined) return;
    let alive = true;
    void fetchNarrative(worldId).then((blocks) => {
      if (alive) setNarrative(blocks);
    });
    return () => {
      alive = false;
    };
  }, [worldId, turnIndex]);

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
      fn: () => Promise<{ snapshot: V2Snapshot; triggeredEvents?: LastResult["events"]; wheelResult?: WheelResultView | null; elapsed?: { value: number; unit: string }; eventFlavors?: EventFlavorMap }>,
      translateError?: (e: unknown) => string,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);

      // 先开 SSE 再发 turn：服务端在锁内 await LLM，订阅必须与 turn 并发才能看到增量。
      // 服务端路由会给「刚发出的 turn」留一个短暂的 pendingInvocation 等待窗口。
      const wid = worldIdRef.current;
      let rawDraft = "";
      const streamAbort = wid ? new AbortController() : null;
      const streamDone = wid
        ? streamNarrative(
            wid,
            {
              onDelta: (text) => {
                rawDraft += text;
                setNarrativeDraft(narrativeDraftText(rawDraft));
              },
              onDone: (info) => {
                if (info.outcome === "fallback") setNarrativeDraft("");
              },
            },
            streamAbort?.signal,
          ).catch(() => undefined)
        : Promise.resolve();

      try {
        const res = await fn();
        setSnapshot(res.snapshot);
        setLastResult({
          turnIndex: res.snapshot.turnIndex,
          elapsed: res.elapsed ? elapsedText(res.elapsed) : "",
          events: res.triggeredEvents ?? [],
          wheel: res.wheelResult ?? null,
          eventFlavors: res.eventFlavors,
        });
        // 对齐正式块：turn 响应在 LLM 收尾之后，通常流已 done；给 200ms 宽限后主动收掉，
        // 再用 trace 读回替换草稿（正式块是唯一真相，草稿不留在屏上）。
        await Promise.race([streamDone, new Promise((resolve) => setTimeout(resolve, 200))]);
        streamAbort?.abort();
        if (wid) setNarrative(await fetchNarrative(wid));
        setNarrativeDraft("");
      } catch (e) {
        streamAbort?.abort();
        setNarrativeDraft("");
        const status = (e as Error & { status?: number }).status;
        if (status === 409) {
          // 409 = 交互顺序冲突（事件待决/战斗中）：服务器状态是权威，静默刷新而非报错
          const wid = worldIdRef.current;
          if (wid) {
            try {
              const fresh = await api.getWorld(wid);
              setSnapshot(fresh.snapshot);
              // 409 静默刷新同样补 flavor：与 [worldId] 刷新路径共用一套护栏。
              setLastResult((prev) => withMergedFlavors(prev, fresh.eventFlavors, fresh.snapshot.turnIndex));
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
        streamAbort?.abort();
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

  /**
   * 点击面上的**唯一提交入口**（产品裁决：点击为主、打字为辅）。
   *
   * `ActionBar` 的动作、叙事流里的选项块、折叠后的自由输入三者都走这里；
   * 请求体一律由 `toActPayload` 生成（动作 id ≤40、文案 ≤200，与服务端 zod 同源），
   * 组件不各自定长，也不需要知道服务端上限。
   */
  const act = useCallback<ActHandler>(
    (choice) => {
      advance(toActPayload(choice));
    },
    [advance],
  );

  /**
   * 转盘「继续」= **确认**（ADR-0034 §8-⑩）。
   *
   * 走显式路由 `POST /api/worlds/:id/wheels/confirm`（无请求体）：从路径即可看出语义，
   * 不再依赖 `action.type` 魔法串。服务端只接受「槽内是 random」的确认，其余回 409。
   * 确认后的响应带 `wheelResult`，用它对账"这一格是什么"。
   */
  const confirmWheel = useCallback(
    () => (worldId ? wrap(() => api.confirmWheel(worldId)) : undefined),
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
      const res = await api.archiveWorld(wid);
      // R2.7 / T-S2：归档响应可选带人生总结来源，仅在来源为 llm 时给展示加中性小标记。
      // 与 eventFlavors 一样是当次渲染的瞬态展示元数据，不落库、不进人生档案。
      setArchiveSummarySource({
        worldId: wid,
        summarySource: res.archive?.evaluation?.summarySource,
      });
      // 归档响应自带最终快照（status=archived，含 ending 与 evaluation 五维分项），
      // 直接采用即可：不再多打一次 GET，也不会用非归档投影覆盖归档事实。
      const finalSnapshot = res.archive?.snapshot ?? (await api.getWorld(wid)).snapshot;
      setSnapshot(finalSnapshot);
      // 手动归档是**玩家显式动作**：用归档态再写一次（同一 worldId，status 变 archived）。
      // 这里刻意**不走**状态跃迁判据 —— 上一轮 terminated 已经写过一行，正是要靠这次
      // upsert 撞唯一索引把它更新成 archived（幂等验证点）。云失败不影响归档本身。
      if (session && finalSnapshot.ending) {
        void saveLifeRecord(finalSnapshot);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [session]);

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
        {/* 登录回调失败等提示：可关闭，且不拦着进入游戏（认证不阻塞） */}
        {authNotice && (
          <div className="banner info" onClick={() => setAuthNotice(null)}>
            {authNotice}
          </div>
        )}
        <SetupScreen
          templates={templates}
          worlds={worlds}
          error={error}
          authReady={authReady}
          session={session}
          onCreated={handleCreated}
          onOpen={openWorld}
          onDelete={deleteWorld}
        />
      </>
    );
  }

  // 呈现槽（ADR-0034 §5）：`slotEvent` 是**唯一**真源 —— 非空 = 有东西在等玩家（事件 / 转盘 / 战斗），
  // 空 = 可自由行动。前端不再自己排「转盘 > 战斗 > 待决事件」的优先级，也不再看队列。
  // 连底栏的「事件待决 / 战斗进行中」浮标也直接读它，`battle` 不再参与准入判断。
  const slot = snapshot.slotEvent;
  // 转盘槽不挂浮标：转盘自己的「命运之轮 / 继续」已经说明要做什么，而 `.interact-hint` 是
  // `position: fixed` 的贴底气泡，会正好压在事件区底部的「继续」上（D-05 同一处坑）。
  const interacting = slot !== null && slot.kind !== "random";
  // 终局 / 已归档不再接收动作（与 LifeTab 内的判定同口径，供底部行动坞与正文留白使用）。
  const ended = snapshot.status === "terminated" || snapshot.status === "archived";
  /**
   * 自由行动回合 ⇒ 底部行动坞常驻（点击为主：行动栏贴在拇指区，不随长叙事被推走）。
   * 事件 / 转盘 / 战斗回合各有自己的点击面，不再叠加行动坞。
   */
  const docked = !ended && slot === null;

  // 刚结算的这一轮才播转盘动画；从存档恢复（刷新后 lastResult 为空）直接呈现已落定结果，
  // 否则每次刷新都要白等 4s 才看到「继续」（D-09）。
  const wheelsFresh = lastResult !== null && lastResult.turnIndex === snapshot.turnIndex;
  // 只认「当前 worldId 的归档响应」：切换 / 重开世界后旧值自动失效（零回归，无额外重置）。
  const summarySource =
    archiveSummarySource?.worldId === worldId ? archiveSummarySource.summarySource : undefined;

  /**
   * 展示层唯一输入：引擎快照 + trace 叙事 → ViewModel（`@life-sim/rpg-ui` 的适配器）。
   * 页面组件从此只吃 ViewModel 派生的数据，不再把 V2Snapshot 传进叙事 / 立绘组件。
   */
  const view: ViewModel = toViewModel({ snapshot, content: narrative });

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
      {authNotice && <div className="banner info" onClick={() => setAuthNotice(null)}>{authNotice}</div>}

      <main className={docked && tab === "life" ? "content content--dock" : "content"}>
        {tab === "life" && (
          <LifeTab
            snapshot={snapshot}
            view={view}
            busy={busy}
            lastResult={lastResult}
            wheelsFresh={wheelsFresh}
            draft={narrativeDraft}
            signedIn={session !== null}
            summarySource={summarySource}
            onAct={act}
            onConfirmWheel={confirmWheel}
            onChoose={choose}
            onBattle={battle}
            onUseItem={useItem}
            onArchive={archive}
            onEndLife={endLife}
          />
        )}
        {tab === "personal" && (
          <PersonalTab snapshot={snapshot} busy={busy} summarySource={summarySource} onUseItem={useItem} onEquip={equip} onUnequip={unequip} />
        )}
        {tab === "world" && <WorldTab snapshot={snapshot} />}
        {tab === "log" && <LogTab snapshot={snapshot} />}
        {tab === "records" && <RecordsTab authReady={authReady} session={session} />}
      </main>

      <nav className="tabbar">
        {(
          [
            ["life", "人生", "◈"],
            ["personal", "个人", "▣"],
            ["world", "世界", "◍"],
            ["log", "记录", "≡"],
            ["records", "档案", "❖"],
          ] as const
        ).map(([key, label, icon]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            <span className="icon">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
      {interacting && (
        <div className="interact-hint">
          {slot?.kind === "combat" ? "⚔ 战斗进行中" : slot?.kind === "random" ? "⚄ 命运待确认" : "⚡ 事件待决"}
        </div>
      )}
    </div>
  );
}

// ---------- 创建世界 ----------

const STATUS_LABELS: Record<"running" | "terminated" | "archived", { label: string; cls: string }> = {
  running: { label: "进行中", cls: "st-running" },
  terminated: { label: "已收束", cls: "st-terminated" },
  archived: { label: "已封存", cls: "st-archived" },
};

/**
 * R2.8 / R-TG-10 C-5：不可载档的封闭 reason → 玩家可读的一句话。
 * 服务端的 `detail` 带内部路径与指纹，**不渲染**；未知 reason 只给中性文案，不写进 DOM。
 */
const UNLOADABLE_REASON_LABELS: Record<string, string> = {
  template_missing: "模板已被移除，这一局无法继续",
  template_version_missing: "该模板版本已被移除，这一局无法继续",
  template_content_drift: "模板内容已变更，这一局无法继续",
  template_invalid: "模板损坏，这一局无法继续",
  world_state_invalid: "存档损坏，无法载入",
  envelope_json_invalid: "存档损坏，无法载入",
  envelope_schema_version_unsupported: "存档格式过旧，无法载入",
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
          // 不可载的档没有 state 可投影：给一行「可见但不可打开」的条目，删除照旧可用。
          if (w.loadable === false) {
            return (
              <li key={w.id} className="world-item">
                <div className="world-open is-unloadable">
                  <div className="world-line">
                    <strong>{w.templateId}</strong>
                    <span className="badge st-archived">不可载入</span>
                  </div>
                  <div className="world-line muted">
                    <span>{UNLOADABLE_REASON_LABELS[w.reason] ?? "存档或模板已变更，无法载入"}</span>
                    <span>{w.savedAt.slice(0, 10)}</span>
                  </div>
                </div>
                <button className="ghost world-delete" onClick={() => onDelete(w.id)}>
                  删除
                </button>
              </li>
            );
          }
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

/**
 * R2.8 / T-TG-07：把建局失败翻译成玩家可读的一句话 + 服务端给出的候选。
 *
 * 两个枚举错误自带候选列表，必须展示出来（否则玩家只会看到「请求失败」而不知道该选什么）：
 *  - `template_version_required`(400) + `versions[]`：该模板多版本，必须显式选版本；
 *  - `opening_not_found`(400/404) + `allowed[]`：开局不属于所选版本。本批服务端把状态码从
 *    404 改成 400，这里两种都认（只按 `error` 码分支，不按状态码分支）。
 * 其余一律回退到 `ApiError.message`（含状态码与 Fastify 的 code），不静默吞掉。
 */
function describeCreateError(
  e: unknown,
  openingNameOf: (id: string) => string,
): { text: string; candidates: string[] } {
  if (!(e instanceof ApiError)) {
    return { text: e instanceof Error ? e.message : String(e), candidates: [] };
  }
  switch (e.code) {
    case "template_version_required":
      return {
        text: "这个世界模板有多个版本，请先选一个版本再进入。",
        candidates: e.body?.versions ?? [],
      };
    case "template_version_missing":
      return { text: "所选版本已不存在（模板可能刚被更新），请重新选择版本。", candidates: [] };
    case "template_invalid":
      return { text: "所选版本当前无法载入，请换一个版本。", candidates: [] };
    case "template_not_found":
      return { text: "这个世界模板已不存在，请刷新页面后重试。", candidates: [] };
    case "opening_not_found":
      return {
        text: "所选开局不属于当前版本，请重新选择开局。",
        candidates: (e.body?.allowed ?? []).map(openingNameOf),
      };
    default:
      return { text: e.message, candidates: [] };
  }
}

function SetupScreen({
  templates,
  worlds,
  error,
  authReady,
  session,
  onCreated,
  onOpen,
  onDelete,
}: {
  templates: TemplateSummary[];
  worlds: WorldSummary[];
  error: string | null;
  /** 启动期登录态是否已判定（未判定时不给按钮，避免点两下） */
  authReady: boolean;
  /** 当前会话；首屏只用来显示「已登录 / 未登录」，不参与任何游戏判定 */
  session: CloudSession | null;
  onCreated: (id: string, snapshot: V2Snapshot) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [seed, setSeed] = useState("");
  const [openingId, setOpeningId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  /** 建局失败时服务端给的候选（版本 / 开局名），纯展示，不参与任何本地校验。 */
  const [candidates, setCandidates] = useState<string[]>([]);
  // 登录/退出是云端动作：单独一套状态，失败只在这里出一句话，不影响建局表单的校验文案
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // ---------- R2.8 / T-TG-07：两级模板选择（模板 → 版本 → 开局） ----------
  // 只保存「玩家显式点过的值」，生效值每次渲染派生：模板列表异步到达、或版本被热更新移除时，
  // UI 会自动回落到服务端默认版本，不会卡在一个已失效的空选择上。
  const [pickedTemplateId, setPickedTemplateId] = useState<string | null>(null);
  /** 版本与模板 id 一起存：版本号在不同模板间可能同名，换模板后必须失效。 */
  const [pickedVersion, setPickedVersion] = useState<{ templateId: string; version: string } | null>(
    null,
  );

  const template: TemplateSummary | undefined =
    templates.find((t) => t.id === pickedTemplateId) ?? templates[0];
  const explicitVersion =
    pickedVersion !== null &&
    pickedVersion.templateId === template?.id &&
    template?.versions.some((v) => v.version === pickedVersion.version) === true
      ? pickedVersion.version
      : undefined;
  // 默认版本必须用服务端给的 `startVersion`，**不是** `versions[0]`（两者语义不同）。
  const versionId =
    explicitVersion ?? (template !== undefined ? defaultVersionOf(template) : undefined);
  // 只有可载版本才能建局；不可载时保留其版本号，让 UI 说明「为什么进不去」而不是静默换版本。
  const version = loadableVersionOf(template, versionId);
  /**
   * 开局**必须取自当前选中的版本**。旧实现写死 `templates[0]?.openings`（R-TG-14 缺陷），
   * 多模板时会把 A 模板的开局 id 提交给 B 模板 ⇒ 服务端 `opening_not_found`。
   */
  const openings = version?.openings ?? [];
  // 只有一个选项时不给玩家多余层级（内部仍走两级数据，提交时仍带 templateVersion）。
  const showTemplatePicker = templates.length > 1;
  const showVersionPicker = (template?.versions.length ?? 0) > 1;

  const openingNameOf = (id: string): string => openings.find((o) => o.id === id)?.name ?? id;

  /** 换模板：版本回到该模板的服务端默认，开局重置（开局属于版本）。 */
  const changeTemplate = (id: string) => {
    setPickedTemplateId(id);
    setPickedVersion(null);
    setOpeningId("");
    setCandidates([]);
  };

  /** 换版本：开局重置——否则会把上一个版本的 openingId 提交出去。 */
  const changeVersion = (v: string) => {
    setPickedVersion(template !== undefined ? { templateId: template.id, version: v } : null);
    setOpeningId("");
    setCandidates([]);
  };

  // 防线（R-TG-14）：openings 来源变了而 openingId 已不在其中 ⇒ 清空。
  // 覆盖「模板列表被服务端热更新」这类不经过上面两个 handler 的变化。
  useEffect(() => {
    if (openingId === "") return;
    if (!openings.some((o) => o.id === openingId)) setOpeningId("");
  }, [openings, openingId]);

  // R2.8 / FE-01：登录页「自定义 LLM 凭证」可折叠配置。仅持有不透明 sessionId，不存 key 字面量。
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hasSession, setHasSession] = useState(getLlmSession() !== null);

  const login = async () => {
    setAuthBusy(true);
    setAuthError(null);
    const failed = await signInWithWorkBuddy();
    setAuthBusy(false);
    // 成功时整页已经跳去授权页，走不到这里
    if (failed) setAuthError(failed);
  };

  const logout = async () => {
    setAuthBusy(true);
    setAuthError(null);
    const failed = await signOutOfWorkBuddy();
    setAuthBusy(false);
    if (failed) setAuthError(failed);
  };

  const start = async () => {
    if (!name.trim()) {
      setLocalError("请先给角色起一个名字");
      return;
    }
    if (template === undefined || version === undefined) {
      setLocalError("世界模板还没载入完成（或该版本不可载入），请稍候或换一个版本");
      return;
    }
    setBusy(true);
    setLocalError(null);
    setCandidates([]);
    try {
      const parsedSeed = seed.trim() === "" ? undefined : Number.parseInt(seed.trim(), 10);
      const validSeed = parsedSeed !== undefined && Number.isInteger(parsedSeed) ? parsedSeed : undefined;
      // 开局防御：只提交**属于当前版本**的 id，绝不把别的模板/版本的开局发出去（R-TG-14）。
      const openingForSubmit = openings.some((o) => o.id === openingId) ? openingId : undefined;
      const res = await api.createWorld({
        templateId: template.id,
        // 恒带版本：多版本时服务端强制要求；单版本时显式传更可诊断（服务端同样接受）。
        templateVersion: version.version,
        playerName: name.trim(),
        ...(validSeed !== undefined ? { seed: validSeed } : {}),
        ...(openingForSubmit !== undefined ? { openingId: openingForSubmit } : {}),
      });
      onCreated(res.worldId, res.snapshot);
    } catch (e) {
      const described = describeCreateError(e, openingNameOf);
      setLocalError(described.text);
      setCandidates(described.candidates);
    } finally {
      setBusy(false);
    }
  };

  // R2.8 / FE-01：把 key 发给服务端内存持有，仅拿回不透明 sessionId（已含在 submitLlmCredentials 内）。
  const saveLlm = async () => {
    if (!apiKey.trim() || !model.trim()) return;
    setSaveBusy(true);
    setSaveError(null);
    try {
      await submitLlmCredentials({
        apiKey: apiKey.trim(),
        model: model.trim(),
        baseUrl: baseUrl.trim() === "" ? undefined : baseUrl.trim(),
      });
      // 成功后清空输入框：key 不再留在 DOM / 内存里，仅由服务端持有 + 本地不透明 id 标记。
      setApiKey("");
      setModel("");
      setBaseUrl("");
      setSaved(true);
      setHasSession(true);
    } catch (e) {
      setSaved(false);
      setSaveError(
        e instanceof Error && e.message ? e.message : "凭证无效，请检查 apiKey / model / baseUrl",
      );
    } finally {
      setSaveBusy(false);
    }
  };

  // 仅清除本地不透明 id；服务端内存凭证由超时 / 重启自然清退。
  const clearLlm = () => {
    clearLlmSession();
    setHasSession(false);
    setSaved(false);
    setSaveError(null);
    setApiKey("");
    setModel("");
    setBaseUrl("");
  };

  return (
    <main className="shell setup">
      <header>
        <p className="eyebrow">AI LIFE SIMULATOR · DEMO</p>
        <h1>人生模拟器</h1>
        <p className="muted">世界不会因你停下。你的故事，从这里开始。</p>
        {/* 首屏就要能登录：新玩家还没建局也能先登录，不必先打一局才找得到入口（ADR-0025 决策 5） */}
        <div className="row">
          <span className="muted" style={{ margin: 0 }}>
            {!authReady ? "正在确认登录状态…" : session ? `已登录：${userDisplayName(session.user)}` : "未登录"}
          </span>
          {authReady && (
            <button className="ghost" disabled={authBusy} onClick={session ? logout : login}>
              {authBusy ? "请稍候…" : session ? "退出" : "用 WorkBuddy 登录"}
            </button>
          )}
        </div>
        {authError && <p className="error-text">{authError}</p>}
      </header>

      {/* 模板卡片：只描述**当前选中版本**，不再把所有模板平铺一堆（两级结构下会误导） */}
      {template === undefined ? (
        <section className="card">
          <h2>正在载入世界模板…</h2>
          <p className="muted">若一直停在这里，请确认服务端已启动（GET /api/templates）。</p>
        </section>
      ) : (
        <section className="card">
          <span className="tag">
            {version !== undefined ? `${version.startYear} · 世界模板` : "版本不可用"}
          </span>
          <h2>{version?.name ?? template.name}</h2>
          {version !== undefined ? (
            <p className="muted">{version.description}</p>
          ) : (
            <p className="error-text">该版本当前不可载入，请换一个版本。</p>
          )}
        </section>
      )}

      <WorldList worlds={worlds} onOpen={onOpen} onDelete={onDelete} />

      <section className="card form">
        {/* 只有一个模板 / 一个版本时不显示多余层级，玩家点一次就能进 */}
        {showTemplatePicker && (
          <label>
            <span>世界模板</span>
            <select value={template?.id ?? ""} onChange={(e) => changeTemplate(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {showVersionPicker && template !== undefined && (
          <label>
            <span>版本（内容与规则随版本不同）</span>
            <select value={versionId ?? ""} onChange={(e) => changeVersion(e.target.value)}>
              {template.versions.map((v) => (
                <option key={v.version} value={v.version} disabled={!isLoadableVersion(v)}>
                  {!isLoadableVersion(v)
                    ? `${v.version}（不可载入）`
                    : v.version === template.startVersion
                      ? `${v.version}（默认）`
                      : v.version}
                </option>
              ))}
            </select>
          </label>
        )}
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
        {/* 服务端在 400/404 里给了候选（版本 / 合法开局），原样展示，不静默失败 */}
        {candidates.length > 0 && <p className="muted">可选：{candidates.join(" / ")}</p>}
        <button className="primary" disabled={busy || version === undefined} onClick={start}>
          {busy ? "正在构建世界…" : "进入这个世界"}
        </button>
      </section>

      <details className="card llm-config">
        <summary>自定义 LLM（可选，风险自担）</summary>
        <p className="muted">
          填入你自己的 API Key，本会话的叙事将走你提供的模型。凭证仅发送至服务端内存持有，不写入代码或日志；
          本地只保存一个不透明的会话 id，风险自担。
        </p>
        <label>
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
          />
        </label>
        <label>
          <span>模型</span>
          <input
            value={model}
            autoComplete="off"
            onChange={(e) => setModel(e.target.value)}
            placeholder="例如：deepseek-chat"
          />
        </label>
        <label>
          <span>Base URL（可选）</span>
          <input
            value={baseUrl}
            autoComplete="off"
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com（留空走 OpenAI 默认端点）"
          />
        </label>
        {saveError && <p className="error-text">{saveError}</p>}
        {saved && (
          <p className="muted llm-saved">已配置：本会话将使用你提供的 LLM key（已本地保存，风险自担）</p>
        )}
        <div className="row llm-actions">
          <button
            className="primary llm-save"
            disabled={!apiKey.trim() || !model.trim() || saveBusy}
            onClick={saveLlm}
          >
            {saveBusy ? "保存中…" : "保存"}
          </button>
          {hasSession && (
            <button className="ghost" onClick={clearLlm}>
              清除
            </button>
          )}
        </div>
      </details>
    </main>
  );
}

// ---------- 人生评价：五维分项（ADR-0016 / D-02） ----------

type EvaluationView = V2Snapshot["evaluation"];
type EvaluationDimensionView = NonNullable<EvaluationView["dimensions"]>[number];

/**
 * 条形宽度只是**展示近似**：模板可给每个维度声明各自的得分区间（如 `[-50, 100]`），
 * 而快照投影只下发 `score` 不下发区间，所以这里统一按 0–100 截断归一（负分条长为 0）。
 * 数值文本与 `level` 一律原样展示，条长不参与任何判定，也不回写状态。
 */
function scoreWidth(score: number): number {
  return Math.min(100, Math.max(0, score));
}

/** 单维一行：名称 + 等级 + 数值（服务端原值），条为视觉辅助；解释默认收起避免撑高面板。 */
function EvaluationDimensionRow({ dim }: { dim: EvaluationDimensionView }) {
  return (
    <details className="eval-dim">
      <summary>
        <span className="eval-dim-name">{dim.label ?? dim.id}</span>
        <span className="eval-dim-level">{dim.level}</span>
        <span className="eval-dim-score">{String(dim.score)}</span>
        <span className="eval-dim-bar" aria-hidden="true">
          <span className="eval-dim-bar-fill" style={{ width: `${scoreWidth(dim.score)}%` }} />
        </span>
      </summary>
      {dim.explanation && <p className="eval-dim-expl">{dim.explanation}</p>}
    </details>
  );
}

/**
 * 五维人生评价（R2.6 / ADR-0016）。数据全部来自服务端投影 `snapshot.evaluation`：
 * 前端不重算分数、不推导等级、不自备 id→中文映射（`label` 缺失时回退 id）。
 *
 * **只在已结束 / 已归档时展示（D-10，用户 2026-11-12 裁决走 B）**：评价是「盖棺定论」，
 * 跑动中整块不渲染 —— 不是折叠、也不是隐藏高度，是 DOM 里不出现。理由是实测该块净高
 * 379px，挂在玩家卡下方会把本回合的动作区 / 转盘「继续」整块顶出首屏（docH 1594 vs 1190），
 * 而「这一回合要做什么」的信息优先级高于过程评述。
 *
 * `dimensions` / `overall` 在评价尚未生成时缺省 —— 此时也不渲染，不出现空白块或 `undefined`。
 */
function EvaluationBreakdown({
  evaluation,
  status,
}: {
  evaluation: EvaluationView;
  status: V2Snapshot["status"];
}) {
  // status 缺省视为 running（与协议 §17 一致），因此缺省时不展示
  const ended = status === "terminated" || status === "archived";
  const dims = evaluation.dimensions ?? [];
  if (!ended || dims.length === 0) return null;
  return (
    <div className="eval-dims">
      <p className="eval-dims-title">评价分项</p>
      {dims.map((dim) => (
        <EvaluationDimensionRow key={dim.id} dim={dim} />
      ))}
      {typeof evaluation.overall === "number" && (
        // 总分与分项同时给出，不取代分项（协议 V2.1 §18）
        <div className="eval-dim eval-dim-total">
          <span className="eval-dim-name">综合</span>
          <span className="eval-dim-level">总评</span>
          <span className="eval-dim-score">{String(evaluation.overall)}</span>
          <span className="eval-dim-bar" aria-hidden="true">
            <span className="eval-dim-bar-fill" style={{ width: `${scoreWidth(evaluation.overall)}%` }} />
          </span>
        </div>
      )}
      <p className="eval-dims-hint">点分项可展开该维度的评分说明</p>
    </div>
  );
}

// ---------- 平台免密 LLM（前端补叙事：后端没做 LLM 时才触发，失败保持模板） ----------

/** 人生总结：仅「生命结束 + 后端未出 LLM + 用户未配自带 key」时补一次（纯展示，失败保持模板总结）。 */
function usePlatformSummary(
  snapshot: V2Snapshot,
  summarySource: NarrativeSource | undefined,
): string | null {
  const [text, setText] = useState<string | null>(null);
  const requested = useRef(false);
  const base = snapshot.evaluation?.summary;
  const ended = snapshot.status === "terminated" || snapshot.status === "archived";
  useEffect(() => {
    if (requested.current) return;
    if (!ended || !base) return;
    if (summarySource === "llm") return;
    if (getLlmSession() !== null) return;
    // 独立原因之二：当前页面 origin 不是平台发布域名 ⇒ 平台免密路径不可用（不合并两个判据）。
    if (!isPlatformLlmAvailable()) return;
    requested.current = true;
    void platformEvaluationSummary(base).then((r) => {
      if (r) setText(r);
    });
  }, [base, summarySource, ended]);
  return text;
}

/** 结局叙事：仅「后端未出 LLM + 非隐藏结局 + 用户未配自带 key」时补一次（纯展示，失败保持模板结局）。 */
function usePlatformEnding(ending: EndingView): { title: string; summary: string } | null {
  const [text, setText] = useState<{ title: string; summary: string } | null>(null);
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    if (ending.narrativeSource === "llm") return;
    if (ending.visibility === "hidden") return;
    if (getLlmSession() !== null) return;
    // 独立原因之二：当前页面 origin 不是平台发布域名 ⇒ 平台免密路径不可用（不合并两个判据）。
    if (!isPlatformLlmAvailable()) return;
    requested.current = true;
    void platformEndingNarrative({
      title: ending.title,
      summary: ending.summary,
      source: ending.source,
    }).then((r) => {
      if (r) setText(r);
    });
  }, [ending]);
  return text;
}

// ---------- 玩家状态卡 ----------

function PlayerCard({ snapshot, summarySource }: { snapshot: V2Snapshot; summarySource?: NarrativeSource }) {
  const platformSummary = usePlatformSummary(snapshot, summarySource);
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
      <p className="eval-line">{platformSummary ?? snapshot.evaluation.summary}{(summarySource === "llm" || platformSummary !== null) && <AiNarrativeTag />}</p>
      <EvaluationBreakdown evaluation={snapshot.evaluation} status={snapshot.status} />
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
  view,
  busy,
  lastResult,
  wheelsFresh,
  draft,
  signedIn,
  summarySource,
  onAct,
  onChoose,
  onBattle,
  onUseItem,
  onArchive,
  onEndLife,
  onConfirmWheel,
}: {
  snapshot: V2Snapshot;
  /** 展示层视图模型（叙事 / 立绘只从这里取数据，不从快照现读）。 */
  view: ViewModel;
  busy: boolean;
  lastResult: LastResult | null;
  /** 槽内这枚转盘是刚掷出的（true，播动画）还是从存档恢复的（false，直接落定） */
  wheelsFresh: boolean;
  /** SSE 草稿（只含 `<narrative-content>` 内的文字）；收尾后由正式块替换。 */
  draft?: string;
  /** 已登录 WorkBuddy 账号：只影响结算页那行「存进人生档案」的提示 */
  signedIn: boolean;
  /** R2.7 / T-S2：归档响应的人生总结来源；缺省 / 非 llm 时展示与改前逐字一致 */
  summarySource?: NarrativeSource;
  /** 统一点击提交（行动栏按钮 / 叙事流选项块 / 自由输入共用一条路径）。 */
  onAct: ActHandler;
  /** 转盘「继续」= 确认已呈现的那一格（ADR-0034 §8-⑩，走 `/wheels/confirm`，不带行动语义） */
  onConfirmWheel: () => void;
  onChoose: (optionId: string) => void;
  onBattle: (command: BattleCommand) => void;
  onUseItem: (itemId: string) => void;
  onArchive: () => void;
  onEndLife: () => void;
}) {
  // 已终止 / 已归档：世界不再接受动作，只呈现结局（服务端同时清空 availableActions）
  const ended = snapshot.status === "terminated" || snapshot.status === "archived";

  // 呈现位（ADR-0034 §5）：唯一真源是 `snapshot.slotEvent`，前端只按 `kind` 选面板：
  // normal → 选项面板 / random → 转盘（已掷好的那一格）/ combat → 战斗面板 / 空槽 → 自由行动。
  // 转盘标题随结果一起下发并持久化（D-16 / QA P2-2）：读 `slot.title`（内核已回填 `wheel.title`），
  // 不再拿 `eventId` 去 `triggeredEvents` 反查——那条路只在「刚结算」时存在，刷新后必然查空。
  const slot = snapshot.slotEvent;
  const occupant = occupantOf(slot);

  // 「本轮还发生了什么」区块已删除（2026-11-16）。原来的做法是把 `triggeredEvents`
  // 过滤掉当前槽那一格后当卡片列出来——**骨架是引擎事实、肉是叙事文本**，两边都不纯：
  // 作为事实它该进「记录」tab（那里读 `/history`，带 turnIndex/type/summary）；
  // 作为叙事它与事件区重复（同一格的正文刚在事件区演过）。
  // 真正值得保留的语义是「玩家没注意到的事件」，但 `triggeredEvents` 只说明
  // 「本轮结算了哪些」，不说明「玩家看过没有」——要做需引擎侧标记 noticed，另开。

  /**
   * 转盘确认后（槽已让位）仍要让玩家看到「这一格是什么」：直接读**确认响应**带回的
   * `wheelResult`，不从本地状态猜。正在槽里演的那一格由事件区负责，不重复展示。
   */
  const settledWheel =
    lastResult !== null &&
    lastResult.wheel !== null &&
    lastResult.wheel.eventId !== slot?.wheel?.eventId
      ? lastResult.wheel
      : null;

  // 平台免密 LLM（R-LLM-09 前端路径，用户裁决：后端没做 LLM 就抛给前端）。
  // 触发条件：后端没出该事件的 LLM flavor（回退模板）+ 用户没配自带 key。
  // 由前端 `cloud.llm` 补一次；失败 / 未部署云环境 ⇒ platformEventFlavor 返回 null，
  // 保持模板文案（自然降级 mock）。纯展示瞬态：不写世界状态、不进回放、不落库。
  const [platformFlavors, setPlatformFlavors] = useState<Record<string, string>>({});
  const requestedFlavorIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!lastResult) {
      requestedFlavorIds.current = new Set();
      setPlatformFlavors({});
      return;
    }
    if (getLlmSession() !== null) return; // 用户自带 key：后端已出 LLM flavor，前端不重复生成
    // 独立原因之二：当前页面 origin 不是平台发布域名 ⇒ 平台免密路径不可用（不合并两个判据）。
    if (!isPlatformLlmAvailable()) return;
    for (const ev of lastResult.events) {
      const serverFlavor = lastResult.eventFlavors?.[ev.id];
      if (serverFlavor !== undefined && serverFlavor !== "") continue;
      if (requestedFlavorIds.current.has(ev.id)) continue;
      requestedFlavorIds.current.add(ev.id);
      void platformEventFlavor(ev.title, ev.narrative).then((text) => {
        if (text) setPlatformFlavors((prev) => ({ ...prev, [ev.id]: text }));
      });
    }
  }, [lastResult]);

  // 交互模式：同一时刻只有一个点击面（引擎在槽非空时拒绝一切 `/turns` 提交）。
  // 槽内有待决事件 ⇒ 只有事件面板的 optionId 合法；战斗中 ⇒ 只有战斗指令合法。
  const mode = interactionMode(view);
  const docked = !ended && mode === "free";
  // LLM 写的选项块（`kind === "option"`）：叙事区只放散文，这些块归事件区。
  /**
   * AI 写的 `content.writeOption` 块**不再渲染**（AGENTIC-GM 重构）。
   *
   * 选项现在只来自事件：`story.submitBranch` 提交的每个事件块带自己的 options，
   * 由引擎分配真 optionId、由事件面板呈现。曾经的 OptionDeck 把模型写的文本块渲染成
   * 黄色胶囊，点是能点，但只能按自由行动受理 —— 和事件面板里的真选项是两套东西。
   * 更糟的是那些块会**跨轮残留**：上一轮写的选项在这一轮的自由行动里继续显示，
   * 看起来像"这一轮又冒出两个选项"。
   */

  return (
    <>
      <div className="stack">
        <PlayerCard snapshot={snapshot} summarySource={summarySource} />

        {/*
          AI 叙事区（T-09a）：紧贴角色卡下方，是默认前端的**主文本面**。
          正文来自服务端 trace 读回（刷新后仍在），立绘 / CG 来自快照媒体投影。
          这里**没有点击面**：选项块由 `NarrativeStream` 过滤掉，统一的点击面是
          底部行动坞 + 事件区（引擎 optionId 选项 / AI 选项）。
        */}
        <NarrativeStage view={view} busy={busy} draft={draft} />

        {ended && snapshot.ending && (
          <EndingPanel
            ending={snapshot.ending}
            archived={snapshot.status === "archived"}
            busy={busy}
            signedIn={signedIn}
            onArchive={onArchive}
          />
        )}

        <GmWorkingStrip busy={busy} />

        {!ended && (
          <section className={`card slot-area slot-${occupant}`}>
            <header className="slot-head">
              <span className="slot-label">事件区</span>
              <span className={`slot-badge badge-${occupant}`}>{SLOT_BADGE[occupant]}</span>
            </header>
            {lastResult?.elapsed && <p className="slot-elapsed">过去{lastResult.elapsed}</p>}

            <div className="slot-body">
              {slot !== null && slot.kind === "random" && slot.wheel !== undefined && (
                <WheelDeck
                  key={`${slot.eventId}:${slot.wheel.label}`}
                  items={[{ wheel: slot.wheel, title: slot.title }]}
                  animate={wheelsFresh}
                  busy={busy}
                  onContinue={onConfirmWheel}
                />
              )}
              {/* 投影缺 `wheel` 时的逃生口：仍然给一个可点的「继续」，不让玩家卡在空槽前 */}
              {slot !== null && slot.kind === "random" && slot.wheel === undefined && (
                <div className="event-body">
                  <h2>{slot.title}</h2>
                  <p>{slot.narrative}</p>
                  <button className="primary wheel-continue" disabled={busy} onClick={onConfirmWheel}>
                    继续
                  </button>
                </div>
              )}
              {slot !== null && slot.kind === "combat" && (
                <BattlePanel
                  snapshot={snapshot}
                  busy={busy}
                  onBattle={onBattle}
                  onContinue={onConfirmWheel}
                />
              )}
              {slot !== null && slot.kind === "normal" && (
                <EventPanel slot={slot} busy={busy} onChoose={onChoose} />
              )}
              {/* 自由行动：只有模板动作 + 次要入口；**不渲染 AI 写的文本选项**（见上方注释）。 */}
              {slot === null && (
                <>
                  <ActionPanel snapshot={snapshot} busy={busy} onUseItem={onUseItem} onEndLife={onEndLife} />
                </>
              )}
            </div>
          </section>
        )}

        {settledWheel !== null && (
          <section className="card result">
            <h3 className="result-title">命运落定</h3>
            <div className="event-card">
              <strong>⚄ {settledWheel.title ?? "随机事件"}</strong>
              <p>{settledWheel.label}</p>
            </div>
          </section>
        )}

        {lastResult && !ended && settledWheel === null && slot === null && (
          <p className="muted result-quiet">世界平静地流转着。</p>
        )}
      </div>

      {/* 点击为主：行动坞固定贴在 tabbar 上方，长叙事也推不走 */}
      {docked && <ActionDock view={view} busy={busy} onAct={onAct} />}
    </>
  );
}


/**
 * GM 推演中提示（不剧透）。
 *
 * 一次 invocation 可能跑 30-60 秒（真模型 + 多轮工具调用）。原来只有叙事卡里一个
 * 小标签，而玩家此刻正盯着事件区 —— 那里毫无变化，看起来像卡死。
 *
 * 这里只显示**进度与耗时**，不显示任何内容：
 * - 不带模型输出（哪怕是片段）—— 那是剧透，且未校验的文本不该先上屏；
 * - 文案只说"在做什么阶段"，且阶段是**引擎已知的事实**（请求在飞 / 已过 N 秒），
 *   不是从模型里猜的。
 */
function GmWorkingStrip({ busy }: { busy: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy]);
  if (!busy) return null;
  const hint = elapsed < 6 ? "正在读取世界" : elapsed < 20 ? "正在编排这一幕" : "正在收尾";
  return (
    <div className="gm-working" role="status" aria-live="polite">
      <span className="gm-working__dot" aria-hidden="true" />
      <span className="gm-working__text">GM 推演中 · {hint}</span>
      <span className="gm-working__elapsed">{elapsed}s</span>
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
  signedIn,
  onArchive,
}: {
  ending: EndingView;
  archived: boolean;
  busy: boolean;
  signedIn: boolean;
  onArchive: () => void;
}) {
  // 后端已出 LLM 结局 / 隐藏结局 / 已配自带 key ⇒ 不触发；否则补一次，失败保持模板结局。
  const platformEnding = usePlatformEnding(ending);
  return (
    <section className={`card ending-card ${ending.visibility === "hidden" ? "ending-hidden" : ""}`}>
      <span className="tag">{archived ? "本局已封存" : "本局已结束"}</span>
      <h2 className="ending-title">{platformEnding?.title ?? ending.title}</h2>
      <p className="ending-summary">{platformEnding?.summary ?? ending.summary}</p>
      {/* R2.7 / T-S1：仅 llm 来源在 meta 行尾追加中性小标记；template / fallback / 缺字段
          ⇒ 行内无新增节点、无新增空白，与改前逐字相同。隐藏结局由服务端保证不做 LLM
          装饰（narrativeSource 恒非 llm），故不会带此标记，前端也不反推 hidden 原文。 */}
      <p className="muted ending-meta">
        第 {ending.turnIndex} 轮 · {SOURCE_LABELS[ending.source] ?? ending.source}
        {ending.visibility === "hidden" ? " · 隐藏结局" : ""}
        {(ending.narrativeSource === "llm" || platformEnding !== null) && <AiNarrativeTag />}
      </p>
      {!archived && (
        <button className="ghost" disabled={busy} onClick={onArchive}>
          {busy ? "封存中…" : "封存这一生"}
        </button>
      )}
      {archived && <p className="muted">已归档，只读。点击顶部「重开」开始新的一生。</p>}
      {/* 未登录只给一行中性提示：不弹窗、不打断结算、也不事后自动补写（ADR-0025 决策 8） */}
      {!signedIn && <p className="muted">登录后可把这局存进人生档案。</p>}
    </section>
  );
}

// ---------- 随机事件转盘（咒术式圆盘：扇区按权重切分，指针固定，转子先快后慢停住） ----------

/** 扇区几何：0° 在正上方、顺时针为正；极坐标换算与 SVG 的 y 轴向下对齐。 */
const WHEEL_SIZE = 232;
const WHEEL_C = WHEEL_SIZE / 2;
const WHEEL_R = WHEEL_C - 12;

function polar(r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: WHEEL_C + r * Math.cos(rad), y: WHEEL_C + r * Math.sin(rad) };
}

function sectorPath(a0: number, a1: number): string {
  const p0 = polar(WHEEL_R, a0);
  const p1 = polar(WHEEL_R, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${WHEEL_C} ${WHEEL_C} L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${WHEEL_R} ${WHEEL_R} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} Z`;
}

// ---------- 扇区标签排版（SVG `<text>` 不折行，只能自己切行 + 居中） ----------

/** 文本最多 20 字：超出截成「前 19 字 + …」，避免长标题塞爆扇区。 */
const WHEEL_LABEL_MAX = 20;
/** 基准字号（单/双行）；三行档降到 9.5px（见 style.css 的 `.wheel-label--dense`）。 */
const WHEEL_LABEL_FONT = 11;
/** 文本中心半径：沿用原布局（只改排版，不动扇区几何与落点角度）。 */
const WHEEL_LABEL_R = WHEEL_R * 0.64;
/** 行高 = 字号 × 该系数（紧凑但仍不叠字）。 */
const WHEEL_LABEL_LINE_GAP = 1.18;
/** 可用宽度再收 5%：让标签与扇区分界线之间留一条缝（几何上刚好贴边=视觉上算溢出）。 */
const WHEEL_LABEL_SAFE = 0.95;
/** 单字宽度估算（em）：全角/CJK 记 1em，其余（字母、数字、空格、·）记 0.55em。 */
function charEm(ch: string): number {
  return /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 1 : 0.55;
}

/** 贪心逐字切行：`budgetEm` 是每行可用的 em 预算（含 letter-spacing）。CJK 无词间空格，逐字切最稳。 */
function wrapByEm(chars: string[], budgetEm: number, letterSpacingEm: number): string[] {
  const lines: string[] = [];
  let cur: string[] = [];
  let curEm = 0;
  for (const ch of chars) {
    const w = charEm(ch) + letterSpacingEm;
    if (curEm + w > budgetEm && cur.length > 0) {
      lines.push(cur.join(""));
      cur = [];
      curEm = 0;
      if (ch === " ") continue; // 空格不带行的开头（「二级咒灵 · / 从排水口」而不是「 · /  从排水口」）
    }
    cur.push(ch);
    curEm += w;
  }
  if (cur.length > 0) lines.push(cur.join(""));
  return lines;
}

/** 行块的径向半高（px）：lineCount 行、每行 fontSize（含字形上下伸部）。 */
function blockHalfHeight(lineCount: number, fontSize: number): number {
  return ((lineCount - 1) / 2) * fontSize * WHEEL_LABEL_LINE_GAP + fontSize * 0.62;
}

/**
 * 标签折行：行数越少字号越大（1–2 行 11px、3 行 9.5px），三行仍放不下就截断补「…」。
 *
 * 每行可用宽度按**几何反解**得到，而不是直接拿弧长/弦长当宽度：
 * 行块是有厚度的矩形，最靠近圆心那一行在窄扇区里最先被挤出去，所以约束是
 *   halfWidth ≤ (标签半径 − 行块径向半高) × tan(扇区半角) × 0.95
 * 这样「标签不压到相邻扇区」是算出来的，不是估出来的。
 *
 * 扇区越窄能放的字越少——这是几何宿命，硬塞只会压到隔壁扇区上。截断只影响扇区里的视觉：
 * 落定后的 `.wheel-result` 与 `aria-label` 仍是完整标签。
 */
function layoutWheelLabel(label: string, sweep: number): { lines: string[]; fontSize: number } {
  const chars = [...label.replace(/\s+/g, " ").trim()];
  const capped =
    chars.length > WHEEL_LABEL_MAX
      ? [...chars.slice(0, WHEEL_LABEL_MAX - 1), "…"]
      : chars;
  const halfRad = (Math.min(Math.max(sweep, 1), 180) * Math.PI) / 360;
  const tanHalf = Math.tan(halfRad);

  // 候选：先用大字号少行数，放不下再逐档降到 3 行 9.5px
  const candidates = [
    { lineCount: 1, fontSize: WHEEL_LABEL_FONT },
    { lineCount: 2, fontSize: WHEEL_LABEL_FONT },
    { lineCount: 2, fontSize: 9.5 },
    { lineCount: 3, fontSize: 9.5 },
  ] as const;

  let fallback: { lines: string[]; fontSize: number } | null = null;
  for (const cand of candidates) {
    const letterSpacingEm = cand.fontSize <= 10 ? 0.02 : 0.04;
    const halfWidth = Math.max(
      cand.fontSize * 0.5, // 窄到连一个字都放不下时别再缩预算（再缩就切不出字了）
      (WHEEL_LABEL_R - blockHalfHeight(cand.lineCount, cand.fontSize)) * tanHalf * WHEEL_LABEL_SAFE,
    );
    const lines = wrapByEm(capped, (halfWidth * 2) / cand.fontSize, letterSpacingEm);
    fallback = { lines, fontSize: cand.fontSize };
    if (lines.length <= cand.lineCount) return fallback;
  }

  // 3 行 9.5px 仍放不下 ⇒ 几何上装不下：留前 3 行，末行末尾换成省略号
  const kept = (fallback?.lines ?? []).slice(0, 3);
  const lastLine = [...(kept[2] ?? "")];
  if (lastLine.length > 0) lastLine[lastLine.length - 1] = "…";
  kept[2] = lastLine.join("");
  return { lines: kept, fontSize: 9.5 };
}

// ---------- 落针动画：圈数 / 时长 / 缓动只影响手感，落点角度仍由服务端给定的 target 决定 ----------

/** 圈数：够多才看得出「越转越慢」（5–7 圈）。 */
const WHEEL_SPIN_TURNS = 6;
/** 旋转总时长（3.6–4.5s）。 */
const WHEEL_SPIN_MS = 4000;
/** 强衰减缓动：前 20% 时间走掉约 70% 行程，剩下 3s 是缓慢的落针。 */
const WHEEL_SPIN_EASING = "cubic-bezier(.16,.8,.12,1)";
/** 落点极小幅回弹（度）：只做「顿一下」的质感，绝不允许跨到别的扇区。 */
const WHEEL_REBOUND_DEG = 2;
const WHEEL_REBOUND_MS = 220;
const WHEEL_REBOUND_EASING = "cubic-bezier(.32,.78,.4,1)";
/** 兜底余量：动画/回调全部失效时，最多再等这么久就必须让「继续」可点（宁可少看动画，不能少出口）。 */
const WHEEL_SETTLE_SLACK_MS = 1200;
/** 起转兜底：rAF 迟迟不来（后台标签、被节流的渲染）时，直接起转，不再等那一帧。 */
const WHEEL_KICKOFF_SLACK_MS = 1500;

/**
 * 随机事件揭示：服务端已用 RNG 结算（`wheelResult` / `lastWheels`），前端只做视觉呈现，
 * 不参与抽取。扇区面积按权重等比——玩家看到的概率就是真实概率，不另做「假均匀」美化。
 * 旋转量 = 整圈数 + 把命中扇区中心转到指针（12 点）所需的补角；动画结束后回调 `onSettled`，
 * 「继续」按钮由外层 `WheelDeck` 统一提供（一轮可能有多枚转盘）。
 */
function WheelReveal({
  wheel,
  title,
  animate,
  onSettled,
}: {
  wheel: WheelResultView;
  title: string;
  /** true = 播放旋转动画；false = 直接落在命中扇区（刷新恢复时不重播） */
  animate: boolean;
  onSettled: () => void;
}) {
  const segs = wheel.segments;
  const total = segs.reduce((sum, s) => sum + Math.max(0, s.weight), 0) || segs.length;
  let cursor = 0;
  const sectors = segs.map((seg, i) => {
    const weight = Math.max(0, seg.weight);
    // 末扇区吸收浮点余量，保证 360° 闭合（否则指针可能落在缝隙上）
    const sweep = i === segs.length - 1 ? 360 - cursor : (weight / total) * 360;
    const start = cursor;
    cursor += sweep;
    return { label: seg.label, weight, start, sweep, center: start + sweep / 2 };
  });
  const hit = sectors.find((s) => s.label === wheel.label) ?? sectors[0];
  // 落点角度数学未变：整圈数 + 把命中扇区中心转到指针（12 点）所需的补角。
  // 圈数只加 360 的整数倍 ⇒ 最终角度 mod 360 与改前逐个相同（6 圈 vs 原 4 圈，落点不变）。
  const target = 360 * WHEEL_SPIN_TURNS + (360 - hit.center);
  // 回弹幅度再按命中扇区的圆心角夹一道：最窄的扇区里也不许跨出半个扇区。
  const overshoot = Math.min(WHEEL_REBOUND_DEG, Math.max(0, hit.sweep) * 0.1);

  type SpinPhase = "idle" | "spin" | "rebound" | "done";
  // 存档恢复（animate=false）时转盘直接就位：既没有起点动画，也没有「转动中」中间态。
  const [phase, setPhase] = useState<SpinPhase>(animate ? "idle" : "done");
  const settled = phase === "done";

  useEffect(() => {
    if (!animate) {
      setPhase("done");
      return;
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (reduce) {
      // 减动偏好：不加圈、不等时长，直接落在终点角度（角度本身与服务端给定的一致）
      setPhase("done");
      return;
    }
    // 先渲染 0° 再翻到目标角，浏览器才有过渡起点（同帧切换会被合并成瞬移）。
    // 只在仍是 idle 时推进：若兜底已经把状态推到后面，别把它拽回来重放一次。
    const raf = requestAnimationFrame(() => setPhase((p) => (p === "idle" ? "spin" : p)));
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  // 起转兜底（验收项「动画失败不能让人卡死」）：`requestAnimationFrame` 在后台标签里可能一直不来，
  // 那样转子会永远停在 0°、`settled` 永远 false、「继续」永远不可点。到点主动起转。
  useEffect(() => {
    if (phase !== "idle") return;
    const id = window.setTimeout(() => setPhase((p) => (p === "idle" ? "spin" : p)), WHEEL_KICKOFF_SLACK_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  // 兜底推进：transitionend 在某些环境（后台标签页、被浏览器合并）可能不来，
  // 那时转盘会永远停在「转动中」。用超时把状态机推下去，正常路径下是空转。
  useEffect(() => {
    if (phase !== "spin" && phase !== "rebound") return;
    const ms = phase === "spin" ? WHEEL_SPIN_MS + 600 : WHEEL_REBOUND_MS + 600;
    const id = window.setTimeout(() => setPhase(phase === "spin" ? "rebound" : "done"), ms);
    return () => window.clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    if (settled) onSettled();
  }, [settled, onSettled]);

  // 转子角度：0° → 超调一点点 → 精确落点。不播动画时直接停在命中角度：
  // 指针压住的就是服务端结算出的扇区。
  const rotorDeg =
    phase === "spin" ? target + overshoot : phase === "rebound" || phase === "done" ? target : 0;
  const rotorTransition =
    phase === "spin"
      ? `transform ${WHEEL_SPIN_MS}ms ${WHEEL_SPIN_EASING}`
      : phase === "rebound"
        ? `transform ${WHEEL_REBOUND_MS}ms ${WHEEL_REBOUND_EASING}`
        : "none";

  return (
    <div className="wheel">
      <div className="wheel-head">
        <span className="wheel-kicker">命运之轮</span>
        <strong className="wheel-title">{title}</strong>
      </div>

      <div className="wheel-stage">
        <div className="wheel-pointer" aria-hidden="true" />
        <svg
          className="wheel-dial"
          viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}
          role="img"
          aria-label={`转盘：${sectors.map((s) => s.label).join("、")}`}
        >
          <defs>
            <radialGradient id="wheel-hub" cx="50%" cy="42%" r="70%">
              <stop offset="0%" stopColor="#2b3550" />
              <stop offset="100%" stopColor="#121724" />
            </radialGradient>
          </defs>
          {/* 外圈：双环 + 刻度，咒术式朱金配色 */}
          <circle cx={WHEEL_C} cy={WHEEL_C} r={WHEEL_R + 6} className="wheel-ring-outer" />
          <circle cx={WHEEL_C} cy={WHEEL_C} r={WHEEL_R + 2} className="wheel-ring-inner" />
          <g
            className="wheel-rotor"
            style={{
              transform: `rotate(${rotorDeg}deg)`,
              transformOrigin: `${WHEEL_C}px ${WHEEL_C}px`,
              transition: rotorTransition,
            }}
            onTransitionEnd={() => {
              if (phase === "spin") setPhase("rebound");
              else if (phase === "rebound") setPhase("done");
            }}
          >
            {sectors.map((s, i) => {
              const isHit = s.label === wheel.label;
              const layout = layoutWheelLabel(s.label, s.sweep);
              const at = polar(WHEEL_LABEL_R, s.center);
              const lineHeight = layout.fontSize * WHEEL_LABEL_LINE_GAP;
              const flip = s.center > 90 && s.center < 270;
              return (
                <g key={`${s.label}-${i}`}>
                  <path
                    d={sectorPath(s.start, s.start + s.sweep)}
                    className={`wheel-sector ${i % 2 === 0 ? "even" : "odd"} ${settled && isHit ? "hit" : ""}`}
                  />
                  {/* 多行：首行用 y 定位，其余用 dy 续行；整块按行数垂直居中于标签半径上 */}
                  <text
                    className={`wheel-label ${layout.fontSize < WHEEL_LABEL_FONT ? "wheel-label--dense" : ""} ${settled && isHit ? "hit" : ""}`}
                    transform={`rotate(${s.center} ${at.x} ${at.y}) rotate(${flip ? 180 : 0} ${at.x} ${at.y})`}
                  >
                    {layout.lines.map((line, li) => (
                      <tspan
                        key={`${line}-${li}`}
                        x={at.x}
                        {...(li === 0
                          ? { y: at.y - ((layout.lines.length - 1) / 2) * lineHeight }
                          : { dy: lineHeight })}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              );
            })}
          </g>
          <circle cx={WHEEL_C} cy={WHEEL_C} r={26} fill="url(#wheel-hub)" className="wheel-hub-ring" />
          <text className="wheel-hub-text" x={WHEEL_C} y={WHEEL_C + 1}>
            命
          </text>
        </svg>
      </div>

      <div className="wheel-foot" aria-live="polite">
        {settled ? (
          <p className="wheel-result">{hit.label}</p>
        ) : (
          <p className="wheel-spinning-text">轮盘转动中…</p>
        )}
      </div>
    </div>
  );
}

/**
 * 转盘揭晓（槽内这一枚）。
 *
 * ADR-0034 之后槽是单槽：一次只有一个 `random` 事件在演，所以 deck 通常只有一枚。
 * `items > 1` 的紧凑卡片分支保留下来是为了兼容旧快照/回放，不再主动使用。
 *
 * **不变量（验收项）**：「继续」永远存在。它是这一格唯一的推进出口 —— 动画哪怕一格没转
 * （rAF 没跑、transitionend 没来、后台标签被节流），按钮也必须在那儿、并且到点变得可点，
 * 否则玩家会被永久卡在「轮盘转动中…」。所以：
 *  - 按钮**首帧就渲染**，动画期间只是 `disabled`；
 *  - 除动画完成回调外，另有一条与动画无关的**超时兜底**把按钮解锁。
 */
function WheelDeck({
  items,
  animate,
  busy,
  onContinue,
}: {
  items: Array<{ wheel: WheelResultView; title: string }>;
  /** 是否播放旋转动画（存档恢复的场景不播，见 D-09） */
  animate: boolean;
  /** 确认请求在途：按钮要一起禁用（引擎无状态区分「确认」和「行动」，双击会变成一次自由行动） */
  busy: boolean;
  onContinue: () => void;
}) {
  const [firstSettled, setFirstSettled] = useState(!animate);
  const handleFirstSettled = useCallback(() => setFirstSettled(true), []);
  const continueRef = React.useRef<HTMLButtonElement | null>(null);
  const first = items[0];
  const rest = items.slice(1);

  /**
   * 动画失败的兜底解锁：与 `onSettled` 回调完全独立。
   * 只要 `animate`（首帧就禁用）而动画到头来没跑起来，超时后照样把「继续」点亮 ——
   * 最坏情况是玩家少看一次动画，绝不会少一个出口。
   */
  useEffect(() => {
    if (firstSettled) return;
    const id = window.setTimeout(
      () => setFirstSettled(true),
      WHEEL_SPIN_MS + WHEEL_REBOUND_MS + WHEEL_SETTLE_SLACK_MS,
    );
    return () => window.clearTimeout(id);
  }, [firstSettled]);

  /**
   * D-05：转盘落定时「继续」会出现在事件区底部，430×932 竖屏下常被固定底栏（tabbar +
   * 交互浮标 `.interact-hint`）压住，玩家得先自己猜着往上滑。
   *
   * 取舍：选「内容出现时自动滚入视野」，而不是「容器底部按 --tabbar-h 留 padding」——
   * padding 只能保证「滚到底时不重叠」，按钮仍可能落在首屏之外，玩家还是要先滑一次；
   * 而这个按钮是本轮唯一的推进出口，落定即把它带进视野最省一次交互。
   *
   * 实现要点（首版踩过的坑）：
   * 1. 遮挡线取「tabbar 上沿」与「交互浮标上沿」的较小值——浮标本身也是 fixed 浮在内容上，
   *    只按 tabbar 算会把按钮留在浮标下面。
   * 2. 只滚动**最小必要距离**（不 `block:"center"`）：按钮靠近页面底部时居中目标会被
   *    maxScroll 截断，居中请求反而没把按钮带出来。
   * 3. 落定后 700ms 再校验一次（即时滚动兜底）：本轮多枚转盘的紧凑卡片是随后插入的，
   *    文档高度会在揭示过程中增长，首次滚动目标可能已过期。
   */
  useEffect(() => {
    if (!firstSettled) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

    const ensureVisible = (behavior: ScrollBehavior) => {
      const el = continueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const tabbarTop = document.querySelector(".tabbar")?.getBoundingClientRect().top ?? window.innerHeight;
      const hintTop = document.querySelector(".interact-hint")?.getBoundingClientRect().top ?? window.innerHeight;
      const limit = Math.min(tabbarTop, hintTop) - 12;
      const delta = rect.bottom - limit; // > 0：按钮底部在遮挡线以下
      if (rect.top >= 0 && delta <= 0) return; // 已经在可视且未被遮挡
      const doc = document.scrollingElement ?? document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, Math.min(max, window.scrollY + delta)), behavior });
    };

    ensureVisible(reduce ? "auto" : "smooth");
    const timer = window.setTimeout(() => ensureVisible("auto"), 700);
    return () => window.clearTimeout(timer);
  }, [firstSettled]);

  if (!first) return null;

  return (
    <div className="wheel-deck">
      <WheelReveal wheel={first.wheel} title={first.title} animate={animate} onSettled={handleFirstSettled} />

      {firstSettled && rest.length > 0 && (
        <div className="wheel-rest" aria-live="polite">
          <p className="wheel-rest-title">同一轮另有 {rest.length} 次命运抉择</p>
          {rest.map((item, i) => (
            <div
              key={`${item.wheel.eventId}-${i}`}
              className="wheel-rest-item"
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <span className="wheel-rest-name">{item.title}</span>
              <strong className="wheel-rest-hit">{item.wheel.label}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="wheel-foot">
        {/* 常驻：动画期间禁用而非缺席（缺了它就没有推进出口） */}
        <button
          ref={continueRef}
          className="primary wheel-continue"
          disabled={!firstSettled || busy}
          onClick={onContinue}
        >
          继续
        </button>
      </div>
    </div>
  );
}

// ---------- 事件面板（选项） ----------

function EventPanel({
  slot,
  busy,
  onChoose,
}: {
  /** `slotEvent.kind === "normal"` 的那一格（调用方已按 kind 收窄，这里不再传整份 snapshot） */
  slot: SlotEventView;
  busy: boolean;
  onChoose: (optionId: string) => void;
}) {
  // 走 `slotEvent.options`（服务端已按 `visibleWhen` 过滤）。缺省成空数组而不是非空断言：
  // 投影字段缺失时宁可显示「没有可选项」，也不要整页崩在 `undefined.map`。
  const options = slot.options ?? [];
  return (
    <div className="event-body">
      <h2>{slot.title}</h2>
      <p>{slot.narrative}</p>
      <div className="option-list">
        {options.map((opt) => (
          <button key={opt.id} className="option" disabled={busy} onClick={() => onChoose(opt.id)}>
            {opt.text}
          </button>
        ))}
      </div>
      {options.length === 0 && <p className="muted">（没有可选项……）</p>}
    </div>
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
  /**
   * 本回合能否行动（D-13）：`canAct === false` 表示被 `cannot_act` 类补正（眩晕等）压制。
   * 引擎此时**不报错**——只记一行「你无法行动。」并跳过玩家动作、照常推进回合，
   * 所以前端必须主动告知，否则玩家看到的是「点了技能、什么都没变、回合没了」。
   * 战斗结束（b.over）后不再提示。
   */
  const locked = !b.over && !b.player.canAct;
  // 原因只从投影里已有的 statuses 读，不自造文案、不改引擎：眩晕的名字就来自模板
  const stunName = b.player.statuses.find((s) => s.id === "stun")?.name;
  const [lockedTapped, setLockedTapped] = useState(false);
  useEffect(() => {
    if (!locked) setLockedTapped(false);
  }, [locked]);

  const aliveEnemies = b.enemies.filter((e) => e.alive);
  const effectiveTarget = target && aliveEnemies.some((e) => e.instanceId === target) ? target : aliveEnemies[0]?.instanceId;

  return (
    <div className={`battle-body ${b.over ? "battle-over" : ""}`}>
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
          <div className="battle-action-zone">
            <div className="battle-actions">
              {b.player.skills.map((skill) => (
                <button
                  key={skill.id}
                  className="action"
                  disabled={busy || locked || skill.cooldownLeft > 0 || b.player.mp < skill.costMp}
                  aria-disabled={busy || locked || skill.cooldownLeft > 0 || b.player.mp < skill.costMp}
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
                  // D-08：canUseItems 由投影层用与引擎**同一个**控制判定算出，
                  // 前端不自己查 status id；false ⇒ 引擎必然以 bound_items 拒绝，先禁用。
                  disabled={busy || locked || !b.player.canUseItems}
                  aria-disabled={busy || locked || !b.player.canUseItems}
                  onClick={() => onBattle({ type: "item", itemId: item.itemId })}
                >
                  <strong>{item.name} ×{item.count}</strong>
                  <span>{b.player.canUseItems ? "使用道具" : "受制于人，用不了道具"}</span>
                </button>
              ))}
              {/*
                D-12：逃跑按钮常显但按 canFlee 禁用。
                旧实现直接不渲染按钮，玩家会以为「没有逃跑这个选项」；现在给按钮 + 原因，
                原因用文字写在按钮上（不只靠置灰/颜色），并加 aria-disabled 供读屏器识别。
              */}
              <button
                className="action flee"
                disabled={busy || locked || !b.player.canFlee}
                aria-disabled={busy || locked || !b.player.canFlee}
                onClick={() => onBattle({ type: "flee" })}
              >
                <strong>逃跑</strong>
                <span>{b.player.canFlee ? "尝试脱离战斗" : "退路已被封死"}</span>
              </button>
            </div>

            {/*
              D-13：眩晕等 cannot_act 压制时，用一个覆盖层盖住整个行动区，而不是把技能/道具/逃跑
              逐个置灰——三者同时不可用，逐个禁用会让玩家以为是三个独立问题。
              覆盖层保留一个明确的推进出口：`cannot_act` 分支里引擎只记一行日志、跳过玩家动作、
              照常推进回合，必须有人提交一次命令回合才会前进（否则眩晕永远不会到期、战斗卡死）。
              该命令是 D-14 的 `{type:"pass"}`（空过一回合）：不消耗 MP/道具/冷却、不掷逃跑判定，
              眩晕下引擎忽略它并记「你无法行动。」，未眩晕下记「你按兵不动。」——两种都只消耗
              一个战斗回合，正是这个按钮要的语义。
            */}
            {locked && (
              <div
                className={`battle-locked ${lockedTapped ? "is-tapped" : ""}`}
                role="status"
                aria-live="polite"
                aria-disabled="true"
                onClick={() => setLockedTapped(true)}
              >
                <strong className="battle-locked-title">无法行动{stunName ? ` · ${stunName}` : ""}</strong>
                <p className="battle-locked-sub">
                  {lockedTapped
                    ? "已确认：本回合你没有任何可执行的动作。"
                    : "技能、道具、逃跑本回合全部不可用，只能硬撑过去。"}
                </p>
                <button
                  className="primary battle-locked-pass"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBattle({ type: "pass" });
                  }}
                >
                  硬撑过这一回合
                </button>
              </div>
            )}
          </div>
          {!locked && !b.player.canFlee && <p className="battle-limit-hint">此战无法逃离：局势不允许脱身。</p>}
          {!locked && !b.player.canUseItems && <p className="battle-limit-hint">你被束缚住了：本回合无法使用道具。</p>}
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
    </div>
  );
}

// ---------- 行动面板（次要入口） ----------

/**
 * 自由行动回合的**次要**内容。
 *
 * 产品裁决「点击为主，打字为辅」之后，主行动按钮与自由输入都搬到了常驻底部行动坞
 * （`ActionDock` + `@life-sim/rpg-ui` 的 `ActionBar`，贴在拇指区、不被长叙事推走）。
 * 这里只保留不推进时间的次要入口：可用物品、结束这一生。
 */
function ActionPanel({
  snapshot,
  busy,
  onUseItem,
  onEndLife,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  onUseItem: (itemId: string) => void;
  onEndLife: () => void;
}) {
  const usableItems = snapshot.player.inventory.filter((i) => i.usableOutsideBattle);

  return (
    <div className="action-body">
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
    </div>
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
  summarySource,
  onUseItem,
  onEquip,
  onUnequip,
}: {
  snapshot: V2Snapshot;
  busy: boolean;
  /** R2.7 / T-S2：归档响应的人生总结来源；缺省 / 非 llm 时展示与改前逐字一致 */
  summarySource?: NarrativeSource;
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
          <StatsPanel snapshot={snapshot} summarySource={summarySource} />
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

/**
 * 章节进度（D-07）。
 *
 * 只渲染服务端下发的数字：`storyChapter` 缺省 ⇒ 该世界没有章节机，整块**不渲染**
 * （不能出现「第 0 章」这种凭空造的进度）；引擎不编造章节名，这里也不自造，
 * 只写「第 N 章」。合法性判断（1..6）留在服务端，前端仅拒绝 0 / 负数这类非法值兜底。
 */
function StoryChapterChip({ chapter }: { chapter: number | undefined }) {
  if (typeof chapter !== "number" || !Number.isFinite(chapter) || chapter < 1) return null;
  return (
    <span className="chip chapter-chip" title="主线章节进度">
      第 {chapter} 章
    </span>
  );
}

/** 属性面板：只复述投影已有字段，不做任何前端推算（与 DNF 的 M 面板信息区对应）。 */
function StatsPanel({ snapshot, summarySource }: { snapshot: V2Snapshot; summarySource?: NarrativeSource }) {
  const platformSummary = usePlatformSummary(snapshot, summarySource);
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
        <StoryChapterChip chapter={snapshot.storyChapter} />
      </div>
      <p className="eval-line">{platformSummary ?? snapshot.evaluation.summary}{(summarySource === "llm" || platformSummary !== null) && <AiNarrativeTag />}</p>
      <EvaluationBreakdown evaluation={snapshot.evaluation} status={snapshot.status} />
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

/**
 * 关系 kind 的中文显示名。
 *
 * 语义来自 `packages/shared/src/schema/relation.ts`：`{from:A, to:B, kind}` 读作
 * **「B 是 A 的 <kind>」**。所以界面上不能只写「父亲」——必须标明**是谁视谁为**，
 * 否则同一条边在不同方向下会被读反。称谓（`kinshipTerm`）由投影给出，只有亲属边才有。
 */
const RELATION_KIND_LABEL: Record<string, string> = {
  father: "父亲",
  mother: "母亲",
  son: "儿子",
  daughter: "女儿",
  husband: "丈夫",
  wife: "妻子",
  "elder-brother": "兄长",
  "younger-brother": "弟弟",
  "elder-sister": "姐姐",
  "younger-sister": "妹妹",
  relative: "亲戚",
  mentor: "师父",
  disciple: "弟子",
  friend: "朋友",
  rival: "对手",
  enemy: "敌手",
  colleague: "同僚",
};

const RELATION_VISIBILITY_LABEL: Record<string, string> = {
  known: "确知",
  inferred: "推断",
};

/**
 * 生命周期三态（ADR-0012 / ADR-0020）。
 *
 * 这三条只是 `reasonCode` 缺失时的**兜底**文案。`inactive` 的兜底必须中性写「已离场」：
 * 「已故」「失联」都是在替模板猜具体死因，而模板可能表达的是叛逃、被封印、转学离开……
 * 真正的原因由 `lifecycle.reasonCode` 原样下发，前端不解释、不推断（引擎也不对它分支）。
 */
const NPC_LIFECYCLE_LABEL: Record<string, string> = {
  alive: "在世",
  inactive: "已离场",
  unspawned: "尚未登场",
};

/**
 * 生命周期文案（ADR-0021 / T3）。
 *
 * 规则：`reasonCode` **存在且 trim 后非空时只显示原因**（「阵亡」「失踪」「叛逃」「被封」），
 * 不再拼接状态词；只有缺失原因时才回退到状态兜底词。顶部 `npc-life-chip`
 * 与「生命周期」区块共用这一个函数，保证两处文案永远一致。
 *
 * 为什么必须 trim 判空：模板 schema 对 `reasonCode` 只约束 `min(1)`，所以 `" "`（单个空格）
 * 是**合法值**。若用真值判断，这种值会渲染出一个近乎空白的胶囊且不回退到状态词
 * （QA D-3）。显示时同样用 trim 后的值，避免前后带空格把胶囊撑宽。
 */
function lifecycleText(state: string, reasonCode?: string): string {
  const code = reasonCode?.trim();
  if (code) return code;
  return NPC_LIFECYCLE_LABEL[state] ?? state;
}

function NpcCard({
  npc,
  names,
  attrLabels,
}: {
  npc: V2Snapshot["npcs"][number];
  names: Record<string, string>;
  /** 属性 id → 中文名（`snapshot.labels.attributes`，与玩家面板同源，前端不另建映射） */
  attrLabels: Record<string, string>;
}) {
  const nameOf = (id: string) => (id === "player" ? "你" : names[id] ?? id);
  // 顺序即模板 `attributes.order`（projection 已按 order 构造）：不重排、不过滤，
  // 值为服务端 base 原值——前端不重算、不叠补正。0 是有效值，照常显示。
  const attrEntries = Object.entries(npc.attributes);
  /**
   * 关系只展示**出边**（`direction: "out"`，即「这个人怎么看别人」）。
   *
   * 2026-11-16 用户裁决：「单边即可…0 卷时五条悟视乙骨为远亲，但是乙骨这边完全可以不要这条边」。
   * 同一条边的两个方向本来就是同一件事实，两边都渲染等于把同一句话写两遍，
   * 而且「谁把谁当什么」的不对称语义会互相打架（A 视 B 为远亲 ≠ B 视 A 为远亲）。
   * 投影仍下发两个方向（契约不砍），将来要做「被谁看重」这类反向视图时，
   * 在这里改成 `.filter((r) => r.direction === "in")` 或两段分区即可，不用动引擎。
   */
  const relationRows = npc.relations.filter((r) => r.direction === "out");
  return (
    <section className={`card npc-card${npc.lifecycle.state === "alive" ? "" : " npc-card-inactive"}`}>
      <div className="row">
        <h2>{npc.name}</h2>
        <span className="tag">
          {npc.age} 岁 · {npc.genderLabel}
        </span>
      </div>
      <div className="chip-row npc-meta">
        <span className="chip">{npc.lifeStageLabel}</span>
        <span className="chip">关系 {npc.relationship}</span>
        {npc.lifecycle.state !== "alive" && (
          <span className="chip npc-life-chip">
            {lifecycleText(npc.lifecycle.state, npc.lifecycle.reasonCode)}
          </span>
        )}
      </div>
      <p className="muted">{npc.personality}</p>
      <div className="attr">
        <span className="attr-name">好感</span>
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
      <details className="npc-details">
        <summary>
          关系 {relationRows.length} · 状态 {npc.statuses.length} · 属性 {attrEntries.length}
        </summary>

        <div className="npc-block">
          <h3>关系</h3>
          {relationRows.length === 0 ? (
            <p className="muted">尚无已知的人际关系。</p>
          ) : (
            <ul className="rel-list">
              {relationRows.map((rel, i) => {
                const kindLabel = RELATION_KIND_LABEL[rel.kind] ?? rel.kind;
                // 关系是独立事实：对方可能没有 NPC 卡（敌人/未登场/隐藏），
                // 投影已给全名字，所以直接用它，不再从列表里反查。
                const other = rel.withName ?? nameOf(rel.withId);
                const sentence = `${npc.name}视${other}为${kindLabel}`;
                return (
                  <li key={`${rel.withId}-${rel.kind}-${i}`} className="rel-row">
                    <span className="rel-text">{sentence}</span>
                    {rel.kinshipTerm && <span className="rel-term">{rel.kinshipTerm}</span>}
                    {/* 关系是独立事实：对方可能没有人物卡（敌人 / 尚未登场）。
                        名字照给，但明确标出「没有档案」，不假装能点开一个人。 */}
                    {rel.counterpartVisible === false && <span className="rel-nocard">无档案</span>}
                    <span className={`rel-vis rel-vis-${rel.visibility}`}>
                      {RELATION_VISIBILITY_LABEL[rel.visibility] ?? rel.visibility}
                    </span>
                    {typeof rel.value === "number" && <span className="rel-value">{rel.value}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="npc-block">
          <h3>状态</h3>
          {npc.statuses.length === 0 ? (
            <p className="muted">无异常状态。</p>
          ) : (
            <div className="chip-row">
              {npc.statuses.map((s) => (
                <span key={s.id} className="chip">
                  {s.name}
                  {s.stacks > 1 ? ` ×${s.stacks}` : ""}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="npc-block">
          <h3>属性</h3>
          {attrEntries.length === 0 ? (
            <p className="muted">暂无属性数据</p>
          ) : (
            <div className="npc-attrs">
              {attrEntries.map(([key, value]) => (
                <div key={key} className="npc-attr">
                  <span className="npc-attr-name">{attrLabels[key] ?? key}</span>
                  <span className="npc-attr-value">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="npc-block">
          <h3>生命周期</h3>
          <p className="muted">
            <span className={`npc-life npc-life-${npc.lifecycle.state}`}>
              {lifecycleText(npc.lifecycle.state, npc.lifecycle.reasonCode)}
            </span>
            {" · "}
            {npc.lifeStageLabel} · {npc.age} 岁
          </p>
        </div>
      </details>
    </section>
  );
}

// ---------- 世界 Tab（R2.8 / FE-02：NPC 记录收敛进「世界」视图，分子页签展开） ----------

type WorldSubTab = "overview" | "npc";

const WORLD_SUBTABS: Array<{ key: WorldSubTab; label: string }> = [
  { key: "overview", label: "概览" },
  { key: "npc", label: "人物/NPC" },
];

function WorldTab({ snapshot }: { snapshot: V2Snapshot }) {
  const [sub, setSub] = useState<WorldSubTab>("overview");
  // 关系边只给 id，这里建一次 id→名 的索引，避免每行重复查找（沿用原 PeopleTab 逻辑）。
  const names = Object.fromEntries(snapshot.npcs.map((n) => [n.id, n.name]));

  return (
    <div className="stack">
      <div className="subtabbar" role="tablist" aria-label="世界子页签">
        {WORLD_SUBTABS.map((entry) => (
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

      {sub === "overview" && (
        <>
          <section className="card">
            <h2>{snapshot.worldName}</h2>
            <p className="muted">
              纪元 {snapshot.startYear} · 平行世界模拟。你的每个选择都在改写这条时间线。
            </p>
            <div className="row">
              <span className="chip">命运偏离度：{snapshot.evaluation.canonDeviation}</span>
            </div>
          </section>
        </>
      )}

      {sub === "npc" && (
        <>
          {snapshot.npcs.length === 0 && <p className="muted">这个世界还没有出现在你身边的人。</p>}
          {snapshot.npcs.map((npc) => (
            <NpcCard
              key={npc.id}
              npc={npc}
              names={names}
              attrLabels={snapshot.labels.attributes}
            />
          ))}
        </>
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

// ---------- 档案 Tab（云端人生档案 / ADR-0025） ----------

/** 存档时间：本地时区的可读串；坏值不渲染成 `Invalid Date`。 */
function formatSavedAt(iso: string | null | undefined): string {
  if (!iso) return "时间未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "时间未知";
  return d.toLocaleString("zh-CN", { hour12: false });
}

/**
 * 一条云端档案。**只渲染玩家已可见的投影字段**（`records.ts` 里映射、服务端已掩码），
 * 不显示 owner_id、不显示邮箱/手机号/token。
 */
function RecordCard({ row, onDelete }: { row: LifeRecordRow; onDelete: () => void }) {
  const dims = row.dimensions ?? [];
  return (
    <section className="card">
      <div className="row">
        <h2>{row.ending_label ?? "未记结局"}</h2>
        <span className={`badge ${row.status === "archived" ? "st-archived" : "st-terminated"}`}>
          {row.status === "archived" ? "已封存" : "已收束"}
        </span>
      </div>
      <p className="muted">
        {row.player_name} · {row.world_name}
        {typeof row.player_age === "number" ? ` · ${row.player_age} 岁` : ""}
      </p>
      <div className="row">
        <span className="chip">第 {row.final_day ?? 0} 天</span>
        {typeof row.story_chapter === "number" && <span className="chip">第 {row.story_chapter} 章</span>}
        {/* `overall` 是 numeric：PostgREST 可能给数字也可能给字符串，两者都照原样显示 */}
        {row.overall != null && <span className="chip">总评 {String(row.overall)}</span>}
      </div>
      {dims.length > 0 && (
        <div className="attrs">
          {dims.map((dim) => (
            <div key={dim.id} className="attr">
              <span className="attr-name">{dim.label ?? dim.id}</span>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${scoreWidth(dim.score)}%` }} />
              </div>
              <span className="attr-value">{String(dim.score)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="muted">
        {row.final_time ? `${row.final_time} · ` : ""}存档于 {formatSavedAt(row.created_at)}
      </p>
      <button className="ghost" onClick={onDelete}>
        删除档案
      </button>
    </section>
  );
}

/**
 * 「档案」页签 —— 唯一要求登录的功能（ADR-0025 决策 5：认证不阻塞游戏）。
 *
 * 未登录时**一个数据库请求都不发**，只渲染登录引导；登录回跳后**不自动补写**，
 * 由玩家在这里显式点「把这局存进档案」（`worldId` 从 localStorage 读，不从 URL 读）。
 */
function RecordsTab({ authReady, session }: { authReady: boolean; session: CloudSession | null }) {
  const [rows, setRows] = useState<LifeRecordRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentWorldId = loadWorldId();

  // 已登录才发请求；未登录把列表清空，保证不残留上一个账号的行。
  useEffect(() => {
    if (!session) {
      setRows(null);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void listLifeRecords().then((res) => {
      if (!alive) return;
      setLoading(false);
      if (res.error) {
        setError(res.error);
        setRows(null);
        return;
      }
      setRows(res.rows ?? []);
    });
    return () => {
      alive = false;
    };
  }, [session, reload]);

  const login = async () => {
    setBusy(true);
    setError(null);
    const failed = await signInWithWorkBuddy();
    setBusy(false);
    // 成功时页面已经跳去授权页，走不到这里。
    if (failed) setError(failed);
  };

  const logout = async () => {
    setBusy(true);
    setNotice(null);
    const failed = await signOutOfWorkBuddy();
    setBusy(false);
    if (failed) setError(failed);
  };

  /** 显式「把这局存进档案」：worldId 取自 localStorage，快照从服务端重取。 */
  const saveCurrent = async () => {
    if (!session) return;
    if (!currentWorldId) {
      setError("没有可保存的这一局。");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { snapshot } = await api.getWorld(currentWorldId);
      const result = await saveLifeRecord(snapshot);
      if (result.status === "saved") {
        setNotice("已把这局存进人生档案。");
        setReload((n) => n + 1);
      } else if (result.status === "skipped") {
        setNotice(result.message);
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: LifeRecordRow) => {
    if (!window.confirm(`删除档案「${row.ending_label ?? "未记结局"}」？只删云端副本，本地存档不受影响。`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await deleteLifeRecord(row.id);
    setBusy(false);
    if (result.status === "deleted") {
      setRows((prev) => (prev ?? []).filter((r) => r.id !== row.id));
      setNotice("档案已删除。");
    } else {
      // 空结果（不存在 / 无权）绝不能当成功
      setError(result.message);
    }
  };

  return (
    <div className="stack">
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {notice && (
        <div className="banner info" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {!authReady && <p className="muted">正在确认登录状态…</p>}

      {authReady && !session && (
        <section className="card">
          <span className="tag">人生档案</span>
          <h2>把这一生存到云端</h2>
          <p className="muted">
            用 WorkBuddy 登录后可跨设备保存结局档案：换设备、换次发布都还能翻回这一生。
            不登录也能照常玩，只是档案不会留存。
          </p>
          <button className="primary" disabled={busy} onClick={login}>
            {busy ? "正在前往登录…" : "使用 WorkBuddy 登录"}
          </button>
          <p className="muted">登录只用于归属你的档案，不读取其它数据。</p>
        </section>
      )}

      {session && (
        <>
          <section className="card">
            <div className="row">
              <span className="tag">人生档案</span>
              <button className="ghost" disabled={busy} onClick={logout}>
                退出登录
              </button>
            </div>
            <p className="muted">已登录：{userDisplayName(session.user)}</p>
            {currentWorldId ? (
              <button className="primary" disabled={busy || loading} onClick={saveCurrent}>
                {busy ? "处理中…" : "把这局存进档案"}
              </button>
            ) : (
              <p className="muted">当前没有打开中的这一局；结算时会自动存进档案。</p>
            )}
          </section>

          {loading && <p className="muted">正在读取档案…</p>}
          {!loading && rows !== null && rows.length === 0 && (
            <p className="muted">还没有云端档案。完成一局后会出现在这里。</p>
          )}
          {rows?.map((row) => (
            <RecordCard key={row.id} row={row} onDelete={() => void remove(row)} />
          ))}
        </>
      )}
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

/**
 * 启动期第一步：**先处理 OAuth 回调，再渲染 App**（顺序是硬要求，ADR-0025 决策 4）。
 *
 * 为什么调用点在 `render` 之前、但**不 await**：
 * - 回调必须在任何路由/鉴权判断之前跑完兑换 —— 用户拿回来的是**一次性** `code`，
 *   先被别的逻辑清掉 URL 就永久丢失；本应用的「入口」就是这次 render，所以先发起。
 * - 又不阻塞渲染：云服务不可用、网络挂住时页面必须照常进游戏（认证不阻塞游戏）。
 *   兑换结果回来后 `App` 通过 `authBootstrap.then` 补上会话，失败只出一条可关闭提示。
 * - `bootstrapAuth` 内部已收口所有异常，**不会**冒泡成白屏。
 */
const authBootstrap = bootstrapAuth();

createRoot(document.getElementById("root")!).render(<App />);
