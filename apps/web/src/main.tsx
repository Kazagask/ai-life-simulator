import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { CloudSession } from "@tencent-ai/workbuddy-cloud-sdk";
import "./style.css";
// 扩展前端的静态注册（`docs/EXTENSIONS.md` §7.1）：必须在首次渲染前跑一次。
import "./extensions";
import {
  ApiError,
  api,
  clearCachedLlmCredentials,
  clearLlmSession,
  getCachedLlmCredentials,
  defaultVersionOf,
  fetchNarrative,
  getLlmSession,
  isLoadableVersion,
  loadableVersionOf,
  mergeEventFlavors,
  resolveEventNarrative,
  streamNarrative,
  submitLlmCredentials,
  testLlmCredentials,
} from "./api";
import { checkVisibleTemplates, type TemplateCheckFailure } from "./templateClient";
import type { EffectSummaryVM, TurnGainVM, DetailSheetData } from "@life-sim/rpg-ui";
import type {
  BattleCommand,
  EndingView,
  EventFlavorMap,
  NarrativeSource,
  OpeningNodeView,
  OpeningStepInput,
  OpeningStepResponse,
  SlotEventView,
  TemplateSummary,
  V2Snapshot,
  WheelResultView,
  WorldSnapshot,
  WorldSummary,
} from "./api";
import { hasSubtabEntry, hasTabEntry, requiresMinimalForm, resolvePlacement } from "./ui-layout";
import { isCredentialEncryptionAvailable } from "./llmCrypto";
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
import {
  BattleBoard,
  AssetDetail,
  BagPanel,
  CharacterPanel,
  CharacterSheet,
  EventPanel,
  GmWorkingStrip,
  HOST_UI_SLOTS,
  NpcCard,
  NpcDetails,
  PointsAllocator,
  RelationGraph,
  SkillList,
  StatsPanel,
  AiNarrativeTag,
  DetailSheet,
  TurnGainsCard,
  EvaluationPanel,
  statusToDetail,
  WheelPanel,
  interactionMode,
  extensionViewsFor,
  resolveUiOverride,
  toActPayload,
  toViewModel,
  toWheelVM,
} from "@life-sim/rpg-ui";
import type {
  ActHandler,
  BagPartition,
  ContentBlockVM,
  ExtensionViewHost,
  NpcCardProps,
  NpcDetailsProps,
  NpcVM,
  PersonalSelection,
  ViewModel,
} from "@life-sim/rpg-ui";
import { ActionDock } from "./ActionDock";
import { StoryStage } from "./StoryStage";

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

/**
 * 「AI 叙事」中性小标记（R2.7 / T-S1 / T-S2）：仅在服务端明确回传 `llm` 来源时渲染。
 * `template` / `fallback` / 字段缺失 ⇒ 不渲染任何额外节点，DOM 与改前逐字一致（零回归底线）。
 * 隐藏结局由服务端保证「不做 LLM 装饰」（narrativeSource 恒非 llm），故不会带此标记，
 * 前端也绝不据此补全或反推 hidden 原文。
 */

// ---------- 装备 ----------

/**
 * 装备投影已落地（协议 §19 / ADR-0008）：V2Snapshot.player.equipment 为可选字段
 * （旧存档 / 未配置装备的模板缺省），元素类型直接从 shared 视图类型派生，
 * 前端不再本地重复声明字段。展示层只读展示字段，状态结果属内核现算状态，不接触。
 */

// ---------- 组件 ----------

type Tab = "life" | "personal" | "world" | "log" | "records";

/** 前实例化开局的启动参数（从建局表单带来，不含世界状态）。 */
interface OpeningLaunch {
  templateId: string;
  templateVersion: string;
  name: string;
  playerName?: string;
  seed?: number;
}

interface LastResult {
  /** 该响应对应的轮次：用于判断「这批结果是刚结算的」还是「从存档恢复的」（D-09） */
  turnIndex: number;
  elapsed: string;
  events: Array<{ id: string; title: string; narrative: string }>;
  wheel: WheelResultView | null;
  /**
   * 本轮收获（ADR-002 D4）：服务端按「基线差分」下发，**不落库**，刷新即消失。
   * 缺省表示这一轮没有任何可列出的增量。
   */
  gains?: TurnGainVM[];
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
  const [openingLaunch, setOpeningLaunch] = useState<OpeningLaunch | null>(null);
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [tab, setTab] = useState<Tab>("life");
  /**
   * 跨页签的「跳到某个人」请求（2026-11-20）：关系图在**个人页**，卡片在**世界页**。
   *
   * 用一个带自增序号的对象而不是裸 id：连着点同一个人两次也要重新滚动定位，
   * 裸 id 相等时 `useEffect` 不会再跑。
   */
  const [npcJump, setNpcJump] = useState<{ id: string; seq: number } | null>(null);
  /**
   * 个人页子页签提到宿主（2026-11-21）：底部「有可用加点」浮标要能一键跳到加点页，
   * 状态留在 `PersonalTab` 内部就没有这条通道。
   */
  const [personalSub, setPersonalSub] = useState<PersonalSubTab>("character");
  /**
   * 客户端模板预检（ADR-070 第二期）：下载模板包 → 用同一套加载器校验 → 比指纹。
   *
   * 失败**不拦操作**（世界仍由服务端提供），只在顶上挂一条可重试的提示；
   * 它是「客户端自己载入世界」这条路径的体检，不是玩家的错误。
   */
  const [templateIssues, setTemplateIssues] = useState<TemplateCheckFailure[]>([]);
  const [templateChecking, setTemplateChecking] = useState(false);
  const openNpc = useCallback((npcId: string) => {
    setNpcJump((prev) => ({ id: npcId, seq: (prev?.seq ?? 0) + 1 }));
    setTab("world");
  }, []);

  const runTemplateCheck = useCallback(async () => {
    setTemplateChecking(true);
    try {
      const issues = await checkVisibleTemplates();
      setTemplateIssues(issues);
      if (issues.length === 0) console.info("[template] 客户端模板校验通过");
      else console.warn("[template] 客户端模板校验未通过", issues);
    } catch (error) {
      setTemplateIssues([
        {
          ok: false,
          ref: { id: "?", version: "?" },
          code: "network",
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setTemplateChecking(false);
    }
  }, []);

  useEffect(() => {
    void runTemplateCheck();
  }, [runTemplateCheck]);
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
   * 流式草稿：SSE 增量（**服务端已剥标签**，只含玩家可见正文）。
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
   * `ui.yaml` 关掉当前页签时把选中态挪到仍可见的第一个页签。
   * 不做这件事会出现"内容区空、导航也没有高亮"的黑洞（与嵌不进槽降级 tab 同一原则）。
   */
  useEffect(() => {
    if (snapshot === null) return;
    const visible: Tab[] = ["life", "personal", "world", "log", "records"].filter((key) =>
      hasTabEntry(snapshot.ui, key),
    ) as Tab[];
    if (visible.length > 0 && !visible.includes(tab)) setTab(visible[0]);
  }, [snapshot?.ui, tab]);

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
    // 必须先摘掉开局向导：App 顶层判定是 `openingLaunch !== null` 就渲染向导，
    // 只设 worldId/snapshot 的话点击「进入这个世界」看起来毫无反应（向导盖在上面不动）。
    setOpeningLaunch(null);
    saveWorldId(id);
    setWorldId(id);
    setSnapshot(snap);
    setTab("life");
    setNotice(null);
    setLastResult(null);
  }, []);

  const wrap = useCallback(
    async (
      fn: () => Promise<{
        snapshot: V2Snapshot;
        triggeredEvents?: LastResult["events"];
        wheelResult?: WheelResultView | null;
        elapsed?: { value: number; unit: string };
        eventFlavors?: EventFlavorMap;
        gains?: TurnGainVM[];
      }>,
      translateError?: (e: unknown) => string,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);

      // 先开 SSE 再发 turn：服务端在锁内 await LLM，订阅必须与 turn 并发才能看到增量。
      // 服务端路由会给「刚发出的 turn」留 3s 的 pendingInvocation 等待窗口。
      const wid = worldIdRef.current;
      const streamAbort = wid ? new AbortController() : null;
      const streamDone = wid
        ? streamNarrative(
            wid,
            {
              // 服务端 SSE 已剥掉叙事标签，这里直接追加即可。
              onDelta: (text) => setNarrativeDraft((prev) => prev + text),
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
          gains: res.gains ?? [],
          eventFlavors: res.eventFlavors,
        });
        // 对齐正式块：turn 响应在 LLM 收尾之后，通常流已 done；给 200ms 宽限后主动收掉，
        // 再用 trace 读回替换草稿（正式块是唯一真相，草稿不留在屏上）。
        await Promise.race([streamDone, new Promise((resolve) => setTimeout(resolve, 200))]);
        streamAbort?.abort();
        /**
         * 正式块与「清草稿」必须**同一次提交**。
         *
         * 先 setNarrative、再 setNarrativeDraft 会多出一帧「草稿 + 正式块」并存 ——
         * 同一段文字在屏幕上出现两遍，然后闪掉一份（2026-11-19 用户反馈「过渡很生硬」）。
         * 先把块取回来，再连着清草稿一起 set：React 18 在 promise 里也会批处理成一次渲染。
         */
        const nextBlocks = wid ? await fetchNarrative(wid) : null;
        if (nextBlocks !== null) setNarrative(nextBlocks);
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

  /**
   * 世界内加点（ADR-019）：走轮外端点，**不推进回合** —— 提交完只是属性变了，
   * 世界时间、事件队列、转盘都不动。失败文案按服务端错误码翻人话。
   */
  const ALLOCATION_ERROR_TEXT: Record<string, string> = {
    no_pending_allocation: "这笔加点已经提交过了",
    allocation_in_battle: "战斗结束之后再分配点数",
    allocation_mismatch: "待办的加点换了，请刷新后再分",
    allocation_over_budget: "分超了预算",
    allocation_above_max: "某一项超过了这次的上限",
    allocation_below_min: "某一项没到这次的下限",
    allocation_unknown_target: "有一项不在这笔加点的范围里",
    allocation_invalid_value: "点数必须是非负整数",
  };
  const allocationErrorText = useCallback((e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const code = /请求失败：(\w+)/.exec(raw)?.[1];
    return (code !== undefined ? ALLOCATION_ERROR_TEXT[code] : undefined) ?? raw;
  }, []);
  const submitAllocation = useCallback(
    (allocationId: string, points: Record<string, number>) =>
      worldId
        ? wrap(() => api.submitAllocation(worldId, allocationId, points), allocationErrorText)
        : undefined,
    [worldId, wrap, allocationErrorText],
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

  /** 开局后改名（R-NAME-02）：只写权威 self 实体，不推进时间；列表读 player.name 自然同步。 */
  const rename = useCallback(async () => {
    const wid = worldIdRef.current;
    if (wid === null) return;
    const next = window.prompt("给角色改名", snapshot?.player.name ?? "");
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === "") {
      setError("名字不能为空");
      return;
    }
    setError(null);
    try {
      const res = await api.renameWorld(wid, trimmed);
      setSnapshot(res.snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [snapshot?.player.name]);

  const reset = useCallback(() => {
    clearWorldId();
    setWorldId(null);
    setSnapshot(null);
    setNotice(null);
    setLastResult(null);
  }, []);

  // ADR-001：版本声明了 openingDag 时先跑前实例化向导；这里不建世界、不实例化 NPC。
  if (openingLaunch !== null) {
    return (
      <>
        <TemplateCheckBanner
          issues={templateIssues}
          checking={templateChecking}
          onRetry={() => void runTemplateCheck()}
        />
        <OpeningWizard
          launch={openingLaunch}
          onCreated={handleCreated}
          onCancel={() => setOpeningLaunch(null)}
        />
      </>
    );
  }

  if (!worldId || !snapshot) {
    return (
      <>
        <TemplateCheckBanner
          issues={templateIssues}
          checking={templateChecking}
          onRetry={() => void runTemplateCheck()}
        />
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
          onOpening={setOpeningLaunch}
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
  const view: ViewModel = toViewModel({ snapshot, content: narrative, ui: snapshot.ui });
  /**
   * 有可用加点（ADR-019）：**不阻塞**，不与事件浮标抢位置 ——
   * 事件在等时先提示事件；没有事件时才亮加点，且可点（跳个人页 · 加点）。
   */
  const hasAllocation = view.player.pendingAllocation !== undefined;

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{snapshot.worldName}</p>
          <h1 className="clock">{snapshot.formattedTime}</h1>
        </div>
        <div className="topbar-right">
          <span className="chip">第 {snapshot.turnIndex} 轮</span>
          <button className="ghost" onClick={() => void rename()}>改名</button>
          <button className="ghost" onClick={reset}>重开</button>
        </div>
      </header>

      {/*
        观察者视角（`observeActor`）必须一直看得见：不占顶栏（顶栏在 390px 上已经被
        「第 N 轮 / 改名 / 重开」占满，再塞一个名字会把按钮挤成竖排），改成一条通栏细带。
        没有这一条，「借父亲的眼睛」在界面上等于什么都没发生。
      */}
      {snapshot.viewerId !== undefined && (
        <div className="viewer-banner">
          以 <strong>{snapshot.viewerName ?? snapshot.viewerId}</strong> 的目光看世界 ——
          关系与可见性按他算，你自己的人和数值没变
        </div>
      )}
      <TemplateCheckBanner
        issues={templateIssues}
        checking={templateChecking}
        onRetry={() => void runTemplateCheck()}
      />
      {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
      {authNotice && <div className="banner info" onClick={() => setAuthNotice(null)}>{authNotice}</div>}

      <main className={docked && tab === "life" ? "content content--dock" : "content"}>
        {tab === "life" && (
          <LifeTab
            snapshot={snapshot}
            ui={snapshot.ui}
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
          <PersonalTab
            snapshot={snapshot}
            ui={snapshot.ui}
            view={view}
            busy={busy}
            summarySource={summarySource}
            sub={personalSub}
            onSubChange={setPersonalSub}
            onUseItem={useItem}
            onEquip={equip}
            onUnequip={unequip}
            onOpenNpc={openNpc}
            onSubmitAllocation={submitAllocation}
          />
        )}
        {tab === "world" && (
          <WorldTab
            snapshot={snapshot}
            ui={snapshot.ui}
            npcs={view.npcs}
            vm={view}
            jump={npcJump}
            onSelectSelf={() => setTab("personal")}
          />
        )}
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
        )
          .filter(([key]) => hasTabEntry(snapshot?.ui, key))
          .map(([key, label, icon]) => (
            <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
              <span className="icon">{icon}</span>
              {label}
            </button>
          ))}
      </nav>
      {/*
        底部的「有东西待处理」浮标（2026-11-21 用户裁决：两件事**可以同时**提示）。
        - 事件浮标：阻塞流程，`life` 页不挂（事件区就在这一页最前面，浮标会压住战斗面板
          底部的技能按钮）；
        - 加点浮标：不阻塞，可点，直接切到个人页「角色」页顶部；战斗中不挂（不能加）。
        两条挤在同一个 fixed 位置上会互相盖住，所以由 `.hint-stack` 统一收口成竖排。
      */}
      {((interacting && tab !== "life") ||
        (hasAllocation && slot?.kind !== "combat" && !(tab === "personal" && personalSub === "character"))) && (
        <div className="hint-stack">
          {interacting && tab !== "life" && (
            <div className="interact-hint">
              {slot?.kind === "combat" ? "⚔ 战斗进行中" : slot?.kind === "random" ? "⚄ 命运待确认" : "⚡ 事件待决"}
            </div>
          )}
          {hasAllocation && slot?.kind !== "combat" && !(tab === "personal" && personalSub === "character") && (
            <button
              type="button"
              className="interact-hint interact-hint--action"
              onClick={() => {
                setTab("personal");
                setPersonalSub("character");
              }}
            >
              ＋ 有可用加点
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 客户端模板预检的提示条（ADR-070 第二期）。
 *
 * 三个早期 return（落地页 / 开局向导 / 主界面）都要挂同一个组件：预检结果是 App 级状态，
 * 换屏不该重新下载一遍模板包。只在失败时渲染，成功时保持安静（控制台留一条 info）。
 */
function TemplateCheckBanner({
  issues,
  checking,
  onRetry,
}: {
  issues: TemplateCheckFailure[];
  checking: boolean;
  onRetry: () => void;
}) {
  if (issues.length === 0) return null;
  return (
    <div className="banner template-check" role="alert">
      <div className="template-check__head">
        <strong>客户端模板校验未通过</strong>
        <button className="ghost" disabled={checking} onClick={onRetry}>
          {checking ? "校验中…" : "重试"}
        </button>
      </div>
      <ul>
        {issues.map((issue) => (
          <li key={`${issue.ref.id}@${issue.ref.version}`}>
            {issue.ref.id}@{issue.ref.version}：{issue.message}
          </li>
        ))}
      </ul>
      <span className="muted">世界仍由服务端提供；这是「客户端自己载入模板」的预检（ADR-070 第二期）。</span>
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

/**
 * 效果条目 → 详情浮层。
 *
 * 优先用条目**自带**的 `refDetail`：`施加 力竭` 指向的是定义，玩家身上未必有这条实例，
 * 去快照里查会查空（「点了没反应」的根因）。查表只是旧数据 / 缺字段时的兜底。
 */
function detailOfEffect(snapshot: V2Snapshot, effect: EffectSummaryVM): DetailSheetData | null {
  if (effect.refDetail !== undefined) {
    return {
      title: effect.refDetail.title,
      ...(effect.refDetail.tags !== undefined && effect.refDetail.tags.length > 0
        ? { tags: effect.refDetail.tags }
        : {}),
      ...(effect.refDetail.description !== undefined ? { description: effect.refDetail.description } : {}),
      ...(effect.refDetail.effects !== undefined ? { effects: effect.refDetail.effects } : {}),
      ...(effect.refDetail.durationLabel !== undefined ? { meta: `持续：${effect.refDetail.durationLabel}` } : {}),
      ...(effect.refDetail.style !== undefined ? { style: effect.refDetail.style } : {}),
    };
  }
  if (effect.ref?.kind === "status") return resolveStatusDetail(snapshot, effect.ref.id);
  return null;
}

/**
 * 按状态 id 找详情（玩家优先，其次 NPC）。
 *
 * 浮层里「施加 力竭」这类引用可能指向 NPC 身上的状态，只查玩家会点不开。
 */
function resolveStatusDetail(snapshot: V2Snapshot, statusId: string): DetailSheetData | null {
  const own = snapshot.player.statuses.find((s) => s.id === statusId);
  if (own !== undefined) return statusToDetail(own);
  for (const npc of snapshot.npcs) {
    const found = npc.statuses.find((s) => s.id === statusId);
    if (found !== undefined) return statusToDetail(found);
  }
  return null;
}

/**
 * 收获条目 → 详情浮层（ADR-002）。
 *
 * 条目自带 description / effects / style / durationLabel，所以**不依赖任何快照查表**：
 * 开局面板（此时还没有世界）和刷新后的列表都能点开详情，不会再出现「点了没反应」。
 */
function detailOfGain(gain: TurnGainVM): DetailSheetData {
  // 品质是引擎里的选择器，玩家看的是标签（神话 / 增益）；副标题只留层数这类中性信息。
  const subtitle =
    gain.category === "status" && gain.stacks !== undefined && gain.stacks > 1 ? `×${gain.stacks}` : undefined;
  return {
    title: gain.name,
    ...(gain.tags !== undefined && gain.tags.length > 0 ? { tags: gain.tags } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(gain.description !== undefined ? { description: gain.description } : {}),
    ...(gain.effects !== undefined ? { effects: gain.effects } : {}),
    ...(gain.durationLabel !== undefined ? { meta: `持续：${gain.durationLabel}` } : {}),
    ...(gain.style !== undefined ? { style: gain.style } : {}),
  };
}

/**
 * 连通性探测的失败原因 → 人话（服务端 `reason` 是闭集：timeout / network / unauthorized / bad_response）。
 * 原始 `detail` 仍附在后面：它已由服务端脱敏截断，且是唯一能定位「端点写错」还是「模型名写错」的线索。
 */
const PROBE_REASON_LABEL: Record<string, string> = {
  network: "连不上这个地址（检查 Base URL 与网络）",
  timeout: "请求超时",
  unauthorized: "鉴权失败（apiKey 不对，或没有该模型的权限）",
  bad_response: "端点返回了非预期结果（检查模型名 / 是否为 OpenAI 兼容接口）",
};

/**
 * 前实例化开局向导（ADR-001）。
 *
 * 纪律：这里**只消费**服务端已决定的节点与结果——roll 在服务端按 seed+node 派生，客户端
 * 的转盘动画只是呈现；commit 之前页面上没有世界、没有 NPC、没有第 1 轮。
 * 最终面板只展示玩家关心的三样：**特质 / 技能 / 物品**，不展开基本/附加属性细节。
 */
function OpeningWizard({
  launch,
  onCreated,
  onCancel,
}: {
  launch: OpeningLaunch;
  onCreated: (id: string, snapshot: V2Snapshot) => void;
  onCancel: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [node, setNode] = useState<OpeningNodeView | null>(null);
  const [steps, setSteps] = useState<Array<{ title: string; text?: string; result: string }>>([]);
  /**
   * 已落定但还没被玩家「继续」的转盘。开局 roll 由服务端定结果，客户端只负责呈现：
   * 拿到 `resolved` 之后先播这一格，玩家点确认才真正进下一步。
   */
  const [reveal, setReveal] = useState<{
    node: OpeningNodeView;
    text: string;
    next: OpeningStepResponse;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allocation, setAllocation] = useState<Record<string, number>>({});
  /**
   * 进入一个新的加点节点时清空已分配值（ADR-004）。
   * 不清的话，模板若有第二个 allocate 节点，玩家会带着上一套分配进去，
   * 而服务端按新节点的预算校验 ⇒ 直接「预算不匹配」，看起来像提交坏了。
   */
  const allocNodeRef = useRef<string | null>(null);
  useEffect(() => {
    const id = node?.nodeId ?? null;
    if (id === allocNodeRef.current) return;
    allocNodeRef.current = id;
    if (node?.mode === "allocate") setAllocation({});
  }, [node]);
  const [finalWorld, setFinalWorld] = useState<{
    id: string;
    snapshot: WorldSnapshot;
    prologue?: string;
  } | null>(null);
  /**
   * 开局所得（ADR-002 D4 的开局版本）：服务端每步回传「到目前为止拿到了什么」，
   * 与 commit 后的最终面板同一份实现。用户 2026-11-18：原来那块只列「选了哪个选项」，
   * 看不出实际拿到了什么。
   */
  const [gains, setGains] = useState<TurnGainVM[]>([]);
  /** 开局期间的详情浮层栈（与游戏内一致：浮层里的引用可继续点开）。 */
  const [details, setDetails] = useState<DetailSheetData[]>([]);
  const pushDetail = useCallback((next: DetailSheetData) => setDetails((prev) => [...prev, next]), []);
  const closeTop = useCallback(() => setDetails((prev) => prev.slice(0, -1)), []);
  const started = useRef(false);
  const stepping = useRef(false);
  /** 同一个 roll 节点只提交一次（重渲染 / 状态回填都不得重复消耗一次掷骰）。 */
  const rolled = useRef<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    api
      .createOpening({
        templateId: launch.templateId,
        templateVersion: launch.templateVersion,
        ...(launch.playerName !== undefined ? { playerName: launch.playerName } : {}),
        ...(launch.seed !== undefined ? { seed: launch.seed } : {}),
      })
      .then((res) => {
        setSessionId(res.sessionId);
        setNode(res.node);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [launch]);

  const advance = useCallback(
    async (input: OpeningStepInput, result: string, title: string, text?: string) => {
      if (sessionId === null || stepping.current) return;
      stepping.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await api.stepOpening(sessionId, input);
        setSteps((prev) => [...prev, { title, ...(text !== undefined ? { text } : {}), result }]);
        if (res.gains !== undefined) setGains(res.gains);
        setNode(res.node);
        setAllocation({});
        if (res.done) {
          const committed = await api.commitOpening(sessionId);
          setFinalWorld({
            id: committed.worldId,
            snapshot: committed.snapshot,
            ...(committed.prologue !== undefined ? { prologue: committed.prologue } : {}),
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        stepping.current = false;
        setBusy(false);
      }
    },
    [sessionId],
  );

  /**
   * roll 节点：**先问服务端拿落定结果**（seed+node 派生，客户端不参与），再交给
   * `WheelPanel` 播动画——开局命定转盘与世界内随机事件从此是同一份转盘组件，
   * 不再另画一套「扇区列表」。
   */
  useEffect(() => {
    if (sessionId === null || node === null || node.mode !== "roll") return;
    if (finalWorld !== null || reveal !== null) return;
    if (rolled.current === node.nodeId) return;
    rolled.current = node.nodeId;
    setBusy(true);
    setError(null);
    api
      .stepOpening(sessionId, { kind: "roll" })
      .then((res) => {
        if (res.gains !== undefined) setGains(res.gains);
        setReveal({ node, text: res.resolved?.text ?? "命数已落定", next: res });
      })
      .catch((e) => {
        rolled.current = null; // 失败允许重试同一节点
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  }, [sessionId, node, finalWorld, reveal]);

  /** 转盘落定后的唯一出口：把这一格记进历史，再进下一步（是最后一步就 commit）。 */
  const finishReveal = useCallback(() => {
    if (reveal === null) return;
    const { node: from, text, next } = reveal;
    setReveal(null);
    setSteps((prev) => [
      ...prev,
      { title: from.title, ...(from.text !== undefined ? { text: from.text } : {}), result: text },
    ]);
    setAllocation({});
    setNode(next.node);
    if (!next.done || sessionId === null) return;
    setBusy(true);
    api
      .commitOpening(sessionId)
      .then((committed) => setFinalWorld({ id: committed.worldId, snapshot: committed.snapshot }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [reveal, sessionId]);

  if (reveal !== null) {
    // 命定转盘：与世界内随机事件同一个组件（扇区 / 指针 / 减速停住 / 继续）。
    return (
      <main className="shell setup">
        <header>
          <p className="eyebrow">OPENING · 前实例化</p>
          <h1>{launch.name}</h1>
          <p className="muted">
            {launch.playerName ?? "无名氏"} · 第 {steps.length + 1} 步 · 命数转盘
          </p>
        </header>
        {error && <p className="error-text">{error}</p>}
        <section className="card opening-step">
          <span className="tag">命数转盘</span>
          <h2>{reveal.node.title}</h2>
          {reveal.node.text && <p>{reveal.node.text}</p>}
          <WheelPanel
            items={[
              {
                wheel: {
                  eventId: reveal.node.nodeId,
                  label: reveal.text,
                  segments: reveal.node.options.map((o) => ({
                    label: o.text,
                    weight: o.weight ?? 1,
                  })),
                },
                title: reveal.node.title,
              },
            ]}
            animate
            busy={busy}
            onContinue={finishReveal}
          />
        </section>
      </main>
    );
  }

  if (finalWorld !== null) {
    const player = finalWorld.snapshot.player;
    return (
      <main className="shell setup">
        <header>
          <p className="eyebrow">OPENING COMPLETE · 第 0 轮</p>
          <h1>{player.name}</h1>
          <p className="muted">{finalWorld.snapshot.formattedTime} · 世界已建立</p>
        </header>
        {finalWorld.prologue !== undefined && finalWorld.prologue.length > 0 && (
          <section className="card prologue-card">
            <span className="tag">序章</span>
            <p className="prologue-text">{finalWorld.prologue}</p>
          </section>
        )}
        <TurnGainsCard gains={gains} onSelect={(gain) => pushDetail(detailOfGain(gain))} />
        <section className="card final-panel">
          <span className="tag">开局所得</span>
          <p className="muted">点条目看效果；进入世界后这些都会出现在你的个人页。</p>
          {error && <p className="error-text">{error}</p>}
          <button
            className="primary"
            onClick={() => onCreated(finalWorld.id, finalWorld.snapshot)}
          >
            进入这个世界
          </button>
        </section>
        {/* 最终面板自己也要有浮层：这里 return 得早，走不到步骤分支里的那个。 */}
        <DetailSheet detail={details[details.length - 1] ?? null} onClose={closeTop} />
      </main>
    );
  }

  const budget = node?.allocation?.budget ?? 0;

  return (
    <main className="shell setup">
      <header>
        <p className="eyebrow">OPENING · 前实例化</p>
        <h1>{launch.name}</h1>
        <p className="muted">
          {launch.playerName ?? "无名氏"} · 第 {steps.length + 1} 步 · 进入世界前定下此身
        </p>
      </header>
      {error && <p className="error-text">{error}</p>}
      {node === null && <section className="card"><p className="muted">正在展开开局…</p></section>}
      {node !== null && (
        <section className="card opening-step">
          <span className="tag">
            {node.mode === "roll" ? "命数转盘" : node.mode === "choose" ? "你的选择" : "分配点数"}
          </span>
          <h2>{node.title}</h2>
          {node.text && <p>{node.text}</p>}

          {node.mode === "roll" && (
            <p className="muted">命数转盘正在落定…</p>
          )}

          {node.mode === "choose" && (
            <div className="ls-option-deck opening-options">
              {node.options.map((opt) => (
                <button
                  key={opt.id}
                  className="ls-choice"
                  disabled={busy}
                  onClick={() =>
                    void advance({ kind: "choose", optionId: opt.id }, opt.text, node.title, node.text)
                  }
                >
                  {opt.text}
                </button>
              ))}
            </div>
          )}

          {/* 加点面板（ADR-004 D6）：组件在 rpg-ui，游戏内加点复用同一实现。 */}
          {node.mode === "allocate" && (
            <PointsAllocator
              budget={budget}
              targets={node.allocation?.targets ?? []}
              value={allocation}
              onChange={setAllocation}
              disabled={busy}
              onConfirm={() =>
                void advance(
                  { kind: "allocate", allocation },
                  "分配完成",
                  node.title,
                  node.text,
                )
              }
            />
          )}
        </section>
      )}
      {gains.length > 0 && (
        <TurnGainsCard gains={gains} onSelect={(gain) => pushDetail(detailOfGain(gain))} />
      )}
      <DetailSheet detail={details[details.length - 1] ?? null} onClose={closeTop} />
      <button className="ghost" onClick={onCancel}>
        放弃开局，返回
      </button>
    </main>
  );
}

function SetupScreen({
  templates,
  worlds,
  error,
  authReady,
  session,
  onCreated,
  onOpening,
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
  onOpening: (launch: OpeningLaunch) => void;
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

  // R2.8 / FE-01 / BACKLOG B-01：「自定义 LLM 凭证」可折叠配置。
  // 配置**缓存在本机**（localStorage），刷新 / 重开自动填好；提交时用公钥加密成信封。
  // 服务端只内存持有解密结果，回一个不透明 sessionId。
  const [apiKey, setApiKey] = useState(() => getCachedLlmCredentials()?.apiKey ?? "");
  const [model, setModel] = useState(() => getCachedLlmCredentials()?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(() => getCachedLlmCredentials()?.baseUrl ?? "");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
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
      const playerName = name.trim() === "" ? undefined : name.trim();
      // ADR-001：版本声明 openingDag 时，**先跑前实例化向导**，这里绝不 createWorld。
      if (version.openingDag !== undefined) {
        onOpening({
          templateId: template.id,
          templateVersion: version.version,
          name: version.openingDag.name,
          ...(playerName !== undefined ? { playerName } : {}),
          ...(validSeed !== undefined ? { seed: validSeed } : {}),
        });
        return;
      }
      const res = await api.createWorld({
        templateId: template.id,
        // 恒带版本：多版本时服务端强制要求；单版本时显式传更可诊断（服务端同样接受）。
        templateVersion: version.version,
        ...(playerName !== undefined ? { playerName } : {}),
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

  /**
   * 保存凭证：先探一次连通性（只作诊断，失败不阻断），再加密上报换不透明 sessionId。
   *
   * 输入框**不再清空**：配置本来就缓存在本机，清空只会让用户下次重填。
   */
  const saveLlm = async () => {
    if (!apiKey.trim() || !model.trim()) return;
    setSaveBusy(true);
    setSaveError(null);
    setSaveWarning(null);
    const payload = {
      apiKey: apiKey.trim(),
      model: model.trim(),
      ...(baseUrl.trim() === "" ? {} : { baseUrl: baseUrl.trim() }),
    };
    try {
      // 探测失败只提示：有些自建网关会拒绝这种最小请求，但正式调用正常。
      // 单独 try：探测本身报错（网络 / 400）也**不能**把保存一起挡掉。
      try {
        const probe = await testLlmCredentials(payload);
        if (!probe.ok) {
          const label = PROBE_REASON_LABEL[probe.reason ?? ""] ?? "未知原因";
          setSaveWarning(
            `已保存，但连通性测试未通过：${label}${probe.detail !== undefined ? `（${probe.detail}）` : ""}`,
          );
        }
      } catch {
        setSaveWarning("连通性测试未能完成（不影响保存，进入游戏后若调用失败会回退模板叙事）");
      }
      await submitLlmCredentials(payload);
      setSaved(true);
      setHasSession(true);
      /**
       * 局域网 HTTP（拿不到 WebCrypto）会走明文信封。这件事必须说出来 ——
       * 静默降级会让「已经加密了」变成一句假话，而用户有权知道钥匙经过了谁的线路。
       */
      if (!isCredentialEncryptionAvailable()) {
        setSaveWarning(
          (prev) =>
            `${prev === null ? "" : `${prev}｜`}本机没有 HTTPS：凭证以明文提交，只应在你信任的局域网里使用`,
        );
      }
    } catch (e) {
      setSaved(false);
      setSaveError(
        e instanceof Error && e.message ? e.message : "凭证无效，请检查 apiKey / model / baseUrl",
      );
    } finally {
      setSaveBusy(false);
    }
  };

  // 清除本机缓存 + 不透明 id；服务端内存凭证由超时 / 重启自然清退。
  const clearLlm = () => {
    clearLlmSession();
    clearCachedLlmCredentials();
    setHasSession(false);
    setSaved(false);
    setSaveError(null);
    setSaveWarning(null);
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
            {/* 版本号常显：只有一个版本时不出选择器，但玩家仍要看得到自己在哪一版（3.0.0 起旧版已归档）。 */}
            {version !== undefined
              ? `${version.startYear} · 世界模板 · v${version.version}`
              : "版本不可用"}
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
          <span>角色姓名（可留空 → 无名氏）</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="留空则由开局决定 / 无名氏" maxLength={20} />
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
          {busy
            ? "正在展开开局…"
            : version?.openingDag !== undefined
              ? "开始开局"
              : "进入这个世界"}
        </button>
      </section>

      <details className="card llm-config">
        <summary>自定义 LLM（可选）</summary>
        <p className="muted">
          填入你自己的 API Key，本会话的叙事将走你提供的模型。配置保存在本机（下次自动填好），
          提交时会先加密再发出；服务端只在内存中持有，不写日志、不进存档。
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
        {saveWarning && <p className="error-text">{saveWarning}</p>}
        {saved && (
          <p className="muted llm-saved">已配置：本会话将使用你提供的模型（配置已留在本机，下次自动填好）</p>
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

/**
 * 条形宽度只是**展示近似**：模板可给每个维度声明各自的得分区间（如 `[-50, 100]`），
 * 而快照投影只下发 `score` 不下发区间，所以这里统一按 0–100 截断归一（负分条长为 0）。
 * 数值文本与 `level` 一律原样展示，条长不参与任何判定，也不回写状态。
 */
function scoreWidth(score: number): number {
  return Math.min(100, Math.max(0, score));
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


/**
 * `place: <能力>: off` 时的最小推进形态（`specs/SPEC.md` §1.5 共同语义第 2 条）。
 *
 * 只关常驻入口、不关推进路径：引擎的 `pending_event_required` 不看 ui.yaml，
 * 槽里有事件就必须能提交。这里给出恰好够推进的一块，不渲染富面板。
 */
function MinimalSlotForm({
  slot,
  busy,
  onConfirmWheel,
  onChoose,
  onBattle,
}: {
  slot: SlotEventView;
  busy: boolean;
  onConfirmWheel: () => void;
  onChoose: (optionId: string) => void;
  onBattle: (command: BattleCommand) => void;
}) {
  return (
    <div className="event-body minimal-slot-form">
      <h2>{slot.title}</h2>
      <p>{slot.narrative}</p>
      {slot.kind === "random" && (
        <button className="primary wheel-continue" disabled={busy} onClick={onConfirmWheel}>
          继续
        </button>
      )}
      {slot.kind === "combat" && (
        <button className="primary" disabled={busy} onClick={() => onBattle({ type: "pass" })}>
          坚持
        </button>
      )}
      {slot.kind === "normal" &&
        (slot.options ?? []).map((opt) => (
          <button key={opt.id} className="option" disabled={busy} onClick={() => onChoose(opt.id)}>
            {opt.text}
          </button>
        ))}
    </div>
  );
}

// ---------- 人生 Tab ----------

function LifeTab({
  snapshot,
  ui,
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
  /** `ui.yaml` 的落位声明（可选；缺省 = 现有内建布局）。 */
  ui?: WorldSnapshot["ui"];
  /** 展示层视图模型（叙事 / 立绘只从这里取数据，不从快照现读）。 */
  view: ViewModel;
  busy: boolean;
  lastResult: LastResult | null;
  /** 槽内这枚转盘是刚掷出的（true，播动画）还是从存档恢复的（false，直接落定） */
  wheelsFresh: boolean;
  /** SSE 草稿（服务端已剥标签，只含玩家可见正文）；收尾后由正式块替换。 */
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

  /**
   * 详情浮层（ADR-002 / R-DETAIL-05）：状态 / 技能 / 物品 / 装备共用一套毛玻璃排版。
   * 状态放在 LifeTab 本地：只有这一屏会打开它，提到 App 层反而要多传四个 prop。
   */
  /**
   * 浮层栈（用户 2026-11-18：浮窗里的状态也要能点开，叠在最上层即可）。
   * 数组末尾 = 最上层；关闭弹最上面那一层。
   */
  const [details, setDetails] = useState<DetailSheetData[]>([]);
  const pushDetail = useCallback((next: DetailSheetData | null) => {
    if (next !== null) setDetails((prev) => [...prev, next]);
  }, []);
  const closeTop = useCallback(() => setDetails((prev) => prev.slice(0, -1)), []);
  const openStatus = useCallback(
    (statusId: string) => pushDetail(resolveStatusDetail(snapshot, statusId)),
    [pushDetail, snapshot],
  );
  // 条目自带详情快照 ⇒ 不需要再在快照里查实体（查不到就会「点了没反应」）。
  const openGain = useCallback((gain: TurnGainVM) => pushDetail(detailOfGain(gain)), [pushDetail]);
  // 人生总结的平台补写（后端没出 LLM 且用户没配 key 时才触发；失败保持模板总结）。
  const platformSummary = usePlatformSummary(snapshot, summarySource);

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

  /**
   * 「故事」区的三种形态（用户 2026-11-19）：
   * - takeover：转盘 / 战斗占满整块，结算后槽位清空 ⇒ 自动回到叙事；
   * - inset：普通事件作为盒中盒内联到叙事结尾（等流式 + 逐字结束）；
   * - footer：自由行动时的次要入口（物品 / 结束这一生），别的形态没有它。
   */
  const noteText = !ended && lastResult?.elapsed ? `过去${lastResult.elapsed}` : "";
  const storyBadge =
    !ended && slot !== null && occupant !== "action"
      ? {
          label: SLOT_BADGE[occupant],
          tone: (occupant === "wheel" ? "wheel" : occupant === "battle" ? "battle" : "event") as
            | "wheel"
            | "battle"
            | "event",
        }
      : undefined;
  const takeover: ReactNode =
    ended || slot === null
      ? undefined
      : requiresMinimalForm(ui, "wheel", slot.kind)
        ? (
            <MinimalSlotForm
              slot={slot}
              busy={busy}
              onConfirmWheel={onConfirmWheel}
              onChoose={onChoose}
              onBattle={onBattle}
            />
          )
        : slot.kind === "random"
          ? slot.wheel !== undefined
            ? (
                <WheelPanel
                  key={`${slot.eventId}:${slot.wheel.label}`}
                  items={[{ wheel: toWheelVM(slot.wheel), title: slot.title }]}
                  animate={wheelsFresh}
                  busy={busy}
                  onContinue={onConfirmWheel}
                />
              )
            : (
                /* 投影缺 `wheel` 时的逃生口：仍然给一个可点的「继续」，不让玩家卡在空槽前 */
                <div className="event-body">
                  <h2>{slot.title}</h2>
                  <p>{slot.narrative}</p>
                  <button className="primary wheel-continue" disabled={busy} onClick={onConfirmWheel}>
                    继续
                  </button>
                </div>
              )
          : slot.kind === "combat" && view.battle !== null && !requiresMinimalForm(ui, "battle", slot.kind)
            ? (
                <BattleBoard
                  battle={view.battle}
                  labels={snapshot.labels.resources}
                  busy={busy}
                  onCommand={onBattle}
                  onContinue={onConfirmWheel}
                  onSelectStatus={(status) => pushDetail(statusToDetail(status))}
                />
              )
            : undefined;

  const inset: ReactNode =
    !ended &&
    slot !== null &&
    slot.kind === "normal" &&
    view.slot !== null &&
    !requiresMinimalForm(ui, "event", slot.kind)
      ? (
          <EventPanel
            title={view.slot.title}
            narrative={view.slot.narrative}
            options={view.slot.options ?? []}
            busy={busy}
            onChoose={onChoose}
          />
        )
      : undefined;

  /** 自由行动的次要入口；**不渲染 AI 写的文本选项**（见上方注释）。 */
  const footer: ReactNode =
    !ended && slot === null ? (
      <ActionPanel snapshot={snapshot} busy={busy} onUseItem={onUseItem} onEndLife={onEndLife} />
    ) : undefined;
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
        <CharacterSheet
          player={view.player}
          /* 评价不在卡面重复：结局卡（同屏下方）统一展示五维与总评。 */
          onSelectStatus={(status) => openStatus(status.id)}
        />

        {/*
          「故事」区（用户 2026-11-19）：叙事与事件合并成一张卡，是默认前端的主文本面。
          正文来自服务端 trace 读回（刷新后仍在），立绘 / CG 来自快照媒体投影。
            - 普通事件 ⇒ 叙事结尾的**盒中盒**（流式 + 逐字都结束后才出现）；
            - 随机事件（转盘）/ 战斗 ⇒ **占满**这一区，结算（槽位清空）后自动回到叙事；
            - 自由行动 ⇒ 只有叙事 + 安静入口，输入归底部行动坞。 */}
        <StoryStage
          view={view}
          busy={busy}
          draft={draft}
          {...(noteText !== "" ? { note: noteText } : {})}
          {...(storyBadge !== undefined ? { badge: storyBadge } : {})}
          {...(takeover !== undefined ? { takeover } : {})}
          {...(inset !== undefined
            ? { inset, ...(slot !== null ? { insetKey: slot.eventId } : {}) }
            : {})}
          {...(footer !== undefined ? { footer } : {})}
        />

        {ended && snapshot.ending && (
          <EndingPanel
            ending={snapshot.ending}
            evaluation={view.evaluation}
            /* 后端没出 LLM 时，平台免密通道补写的总结（失败为 null，保持模板总结）。 */
            evaluationSummary={platformSummary ?? undefined}
            archived={snapshot.status === "archived"}
            busy={busy}
            signedIn={signedIn}
            onArchive={onArchive}
          />
        )}

        <GmWorkingStrip busy={busy} />

        {/* 本轮收获（ADR-002 D4 / R-GAIN-01）：原「命运落定」的位置，列本回合真实增量。 */}
        <TurnGainsCard
          gains={lastResult?.gains ?? []}
          wheel={
            settledWheel === null
              ? null
              : {
                  ...(settledWheel.title !== undefined ? { title: settledWheel.title } : {}),
                  label: settledWheel.label,
                }
          }
          onSelect={openGain}
        />

        {lastResult && !ended && settledWheel === null && (lastResult.gains?.length ?? 0) === 0 && slot === null && (
          <p className="muted result-quiet">世界平静地流转着。</p>
        )}

        <DetailSheet
          detail={details[details.length - 1] ?? null}
          onClose={closeTop}
          onOpenRef={(effect) => {
          const next = detailOfEffect(snapshot, effect);
          if (next !== null) pushDetail(next);
        }}
        />
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
// ---------- 结局面板 ----------

const SOURCE_LABELS: Record<string, string> = {
  condition: "条件达成",
  player: "主动收束",
  battleDefeat: "战败",
  event: "事件触发",
};

function EndingPanel({
  ending,
  evaluation,
  evaluationSummary,
  archived,
  busy,
  signedIn,
  onArchive,
}: {
  ending: EndingView;
  /** 五维评价（同一次投影）：跑动中不渲染，收束后与结局同屏给出。 */
  evaluation: ViewModel["evaluation"];
  /** 平台免密通道补写的总结（后端未出 LLM 时才有值）。 */
  evaluationSummary?: string;
  archived: boolean;
  busy: boolean;
  signedIn: boolean;
  onArchive: () => void;
}) {
  // 后端已出 LLM 结局 / 隐藏结局 / 已配自带 key ⇒ 不触发；否则补一次，失败保持模板结局。
  const platformEnding = usePlatformEnding(ending);
  const dims = evaluation.dimensions ?? [];
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

      {/*
        评价（ADR-0016）：只复述服务端投影的分数与总结，不重算、不排序、不补维度。
        `summarySource === "llm"` 才打 AI 标（模板 / 回退不标，避免把引擎文案说成模型写的）。
      */}
      {dims.length > 0 && (
        <div className="ending-eval">
          <div className="row">
            <h3 className="panel-title">这一生的评价</h3>
            {typeof evaluation.overall === "number" && (
              <span className="chip">总评 {evaluation.overall}</span>
            )}
          </div>
          <p className="ending-eval-summary">
            {evaluationSummary ?? evaluation.summary}
            {(evaluation.summarySource === "llm" || evaluationSummary !== undefined) && <AiNarrativeTag />}
          </p>
          <EvaluationPanel evaluation={evaluation} />
        </div>
      )}

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

// ---------- 事件面板（选项） ----------

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

type PersonalSubTab = "character" | "bag" | "skills" | "relations";

/**
 * 个人页子页签 = 宿主内建能力位（`ui.yaml` 可以把任意一个 `off` 掉）。
 *
 * `relations` 与世界的 `npcList` 上的 `relations` **不是一个能力**：前者是
 * 「我的人际关系图」（`playerRelations`），后者是 NPC 卡上的关系行。
 *
 * 加点**不是页签**（2026-11-21 用户裁决）：页签已经够多了，而加点是一件
 * 「等着你处理」的事，藏进页签反而看不见。它固定挂在「角色」页顶部
 * （`pendingAllocation` 存在时才出现），不在个人页时由底部浮标提示。
 */
const PERSONAL_SUBTABS: Array<{ key: PersonalSubTab; label: string; capability: string }> = [
  { key: "character", label: "角色", capability: "character" },
  { key: "bag", label: "背包", capability: "inventory" },
  { key: "skills", label: "技能", capability: "skills" },
  { key: "relations", label: "关系", capability: "playerRelations" },
];

function PersonalTab({
  snapshot,
  ui,
  view,
  busy,
  summarySource,
  sub,
  onSubChange,
  onUseItem,
  onEquip,
  onUnequip,
  onOpenNpc,
  onSubmitAllocation,
}: {
  snapshot: V2Snapshot;
  ui?: WorldSnapshot["ui"];
  view: ViewModel;
  busy: boolean;
  /** R2.7 / T-S2：归档响应的人生总结来源；缺省 / 非 llm 时展示与改前逐字一致 */
  summarySource?: NarrativeSource;
  /**
   * 子页签由**宿主**持有：底部「有可用加点」浮标要能直接跳过来，
   * 状态留在组件内部就得再开一条跨层通道（2026-11-21）。
   */
  sub: PersonalSubTab;
  onSubChange: (next: PersonalSubTab) => void;
  onUseItem: (itemId: string) => void;
  onEquip: (itemId: string) => void;
  onUnequip: (instanceId: string) => void;
  /** 关系图上点节点 → 跳到「世界 · 人物」里那张卡。 */
  onOpenNpc: (npcId: string) => void;
  /** 世界内加点（ADR-019）：轮外提交，不推进回合。 */
  onSubmitAllocation?: (allocationId: string, points: Record<string, number>) => Promise<void> | undefined;
}) {
  // 背包分区 / 选中项是纯展示状态，但**选中项跨组件协调**（选中格 → 详情区显示什么），
  // 还会和「刷新后选中失效」这类业务判断绑在一起，所以状态留在宿主：
  // rpg-ui 的组件只接受受控的 `selection` + `onSelect`（不传则视为未选中）。
  const [partition, setPartition] = useState<BagPartition>("equipment");
  const [selection, setSelection] = useState<PersonalSelection>(null);
  /** 技能详情里点「施加 X」时打开的状态浮层（栈）。 */
  const [details, setDetails] = useState<DetailSheetData[]>([]);

  const player = view.player;
  const pending = player.pendingAllocation;
  /**
   * 战斗中（2026-11-21）：加点是「战后的事」——战斗单位在开打那一刻就快照了属性，
   * 这时分配对当前这一场没有任何作用。服务端也会 409（`allocation_in_battle`），
   * 这里只负责别给出一组按得动却没效果的控件。
   */
  const inBattle = snapshot.slotEvent?.kind === "combat";
  /**
   * 加点草稿（ADR-019）：**不落任何地方**，提交前只在内存里。
   * 换了一笔请求就清空 —— 上一笔剩下的分配带进来会让「剩余 N 点」直接算错。
   */
  const [allocDraft, setAllocDraft] = useState<Record<string, number>>({});
  useEffect(() => {
    setAllocDraft({});
  }, [pending?.id]);

  const slots = view.equipmentSlots ?? [];
  // 人生总结的平台补写仍归宿主（它要读快照状态 + 发请求），组件只接收结果。
  const platformSummary = usePlatformSummary(snapshot, summarySource);
  const summary = platformSummary ?? undefined;
  const summaryFromAi = summarySource === "llm" || platformSummary !== null;

  // 投影刷新后选中项可能已失效（刚卸下 / 刚用完），此时按「未选中」处理而不是报错
  const active: PersonalSelection =
    selection?.kind === "slot"
      ? selection.instanceId && !player.equipment.some((e) => e.instanceId === selection.instanceId)
        ? {
            kind: "slot",
            instanceId: null,
            slotId: selection.slotId,
            slotLabel: selection.slotLabel,
            capacity: selection.capacity,
          }
        : selection
      : selection?.kind === "item" && !player.inventory.some((i) => i.itemId === selection.itemId)
        ? null
        : selection;

  return (
    <div className="stack">
      <div className="subtabbar" role="tablist" aria-label="个人子页签">
        {PERSONAL_SUBTABS.filter((entry) => hasSubtabEntry(ui, entry.capability)).map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={sub === entry.key}
            className={`subtab ${sub === entry.key ? "active" : ""}`}
            onClick={() => {
              onSubChange(entry.key);
              setSelection(null);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/*
        加点（ADR-019）：**角色页最上面**，不是页签（2026-11-21 用户裁决）。
        它是一件「等着你处理」的事 —— 放在角色页顶部，一进个人页就看得见；
        不在个人页时由底部浮标提示；事件待决时两条提示并存，互不挤占。

        战斗中只显示一句说明、不渲染分配器：战斗单位在开打那一刻就把属性快照走了，
        这时加点对**这一场**没有任何作用（HP 条不会动，伤害也不会变）。给一组
        按得动却没效果的控件，比直接说「打完再分」更糟。
      */}
      {sub === "character" && (
        <>
          {pending !== undefined && (
            <section className="card allocation-card">
              <div className="row">
                <h3 className="panel-title">加点</h3>
                <span className="chip">可分配 {pending.budget}</span>
              </div>
              {pending.reason !== undefined && <p className="muted allocation-reason">{pending.reason}</p>}
              {inBattle ? (
                <p className="muted allocation-locked">
                  战斗结束后再分配 —— 这一场开打时，你的数值就已经定下来了。
                </p>
              ) : (
                <PointsAllocator
                  key={pending.id}
                  budget={pending.budget}
                  targets={pending.targets}
                  value={allocDraft}
                  onChange={setAllocDraft}
                  onConfirm={() => {
                    void onSubmitAllocation?.(pending.id, allocDraft);
                  }}
                  confirmLabel="就这样"
                  disabled={busy}
                />
              )}
            </section>
          )}
          <CharacterPanel player={player} slots={slots} selection={active} onSelect={setSelection} />
          <StatsPanel
            player={player}
            evaluation={view.evaluation}
            formattedTime={view.formattedTime}
            storyChapter={view.storyChapter}
            turnIndex={view.turnIndex}
            summary={summary}
            summaryFromAi={summaryFromAi}
            onSelectStatus={(status) => setDetails((prev) => [...prev, statusToDetail(status)])}
          />
          <AssetDetail
            selection={active}
            equipment={player.equipment}
            inventory={player.inventory}
            slots={slots}
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
            inventory={player.inventory}
            partition={partition}
            onPartition={(key) => {
              setPartition(key);
              setSelection(null);
            }}
            selection={active}
            onSelect={setSelection}
          />
          <AssetDetail
            selection={active}
            equipment={player.equipment}
            inventory={player.inventory}
            slots={slots}
            busy={busy}
            onEquip={onEquip}
            onUnequip={onUnequip}
            onUseItem={onUseItem}
          />
        </>
      )}

      {sub === "relations" && (
        <section className="card">
          <div className="row">
            <h3 className="panel-title">
              {player.relationsOwner === undefined ? "关系" : `${player.relationsOwner.name}的关系`}
            </h3>
            <span className="muted equip-count">
              {new Set(player.relations.filter((rel) => rel.direction !== "in").map((rel) => rel.withId)).size} 人
            </span>
          </div>
          {/*
            `observeActor` 生效时这里换的是**主语**，不是你的关系变了 —— 必须写出来，
            否则玩家会以为自己的亲人才是眼前这些人。
          */}
          {player.relationsOwner !== undefined && (
            <p className="muted rel-owner-note">
              你借了他的眼睛：这张图是{player.relationsOwner.name}视谁为什么，不是你的。
            </p>
          )}
          {/*
            关系图只画**关系**，不画「他对你多少分」：亲疏在档位文案里（`valueLabel`），
            再拿颜色编码一次会让两条不同含义的轴互相污染。
          */}
          <RelationGraph
            selfName={player.relationsOwner?.name ?? player.name}
            relations={player.relations}
            onSelectActor={onOpenNpc}
          />
        </section>
      )}

      {sub === "skills" && (
        <SkillList
          skills={player.skills}
          onOpenStatus={(effect) => {
            const next = detailOfEffect(snapshot, effect);
            if (next !== null) setDetails((prev) => [...prev, next]);
          }}
          // 召唤物的常驻状态（如魔虚罗的法轮）：与个人页芯片同一个去处 —— 叠一层状态浮层。
          onOpenModifier={(status) => setDetails((prev) => [...prev, statusToDetail(status)])}
        />
      )}

      <DetailSheet
        detail={details[details.length - 1] ?? null}
        onClose={() => setDetails((prev) => prev.slice(0, -1))}
        onOpenRef={(effect) => {
          const next = detailOfEffect(snapshot, effect);
          if (next !== null) setDetails((prev) => [...prev, next]);
        }}
      />
    </div>
  );
}

// ---------- 世界 Tab（R2.8 / FE-02：NPC 记录收敛进「世界」视图，分子页签展开） ----------

type WorldSubTab = string;

const WORLD_SUBTABS: Array<{ key: WorldSubTab; label: string }> = [
  { key: "overview", label: "概览" },
  { key: "npc", label: "人物/NPC" },
];

/**
 * 世界页。
 *
 * 子页签 = 宿主自带的两个 + **扩展挂到 `world.subview` 槽里的视图**
 * （`docs/EXTENSIONS.md` §7）：宿主不认识族谱 / 宗族这类具体扩展，只按
 * `extensionViewsFor(slot, vm)` 的结果渲染页签与组件。槽为空 ⇒ 不画空页签。
 *
 * 点族谱节点复用「人物/NPC」这一页的卡片：扩展通过槽的可选 `host.openNpc` 回宿主，
 * 宿主切到该子页签并把对应卡片滚进视野。选中态归宿主（`packages/rpg-ui` 的既有约定）。
 */
function WorldTab({
  snapshot,
  ui,
  npcs,
  vm,
  jump,
  onSelectSelf,
}: {
  snapshot: V2Snapshot;
  ui?: WorldSnapshot["ui"];
  npcs: NpcVM[];
  vm: ViewModel;
  /** 外部请求「跳到某个人」（个人页关系图 → 这里那张卡）；带自增序号。 */
  jump?: { id: string; seq: number } | null;
  onSelectSelf: () => void;
}) {
  const [sub, setSub] = useState<WorldSubTab>("overview");
  /** 从族谱 / 关系图跳过来时要定位的那张卡（null = 没有待定位目标）。 */
  const [focusNpcId, setFocusNpcId] = useState<string | null>(null);

  /**
   * 外部跳人：先切到人物子页签，再交给下面的滚动副作用。
   * 依赖 `seq` 而不是 `id` —— 连着点同一个人两次也要重新滚一次。
   */
  useEffect(() => {
    if (jump === null || jump === undefined) return;
    setFocusNpcId(jump.id);
    setSub("npc");
  }, [jump?.seq]);
  /** 状态详情浮层（栈）：NPC 身上的状态也要能点开，浮层里的引用还能继续点。 */
  const [details, setDetails] = useState<DetailSheetData[]>([]);
  const pushDetail = useCallback((next: DetailSheetData) => setDetails((prev) => [...prev, next]), []);

  useEffect(() => {
    if (sub !== "npc" || focusNpcId === null) return;
    const el = document.getElementById(`npc-${focusNpcId}`);
    if (el === null) return;
    /*
     * 不能直接 `scrollIntoView({ block: "start" })`：顶部栏是 `position: sticky`
     * （约 66px），它会把目标卡片的标题行正好压在栏下面 —— 玩家只看到卡片中段，
     * 认不出自己点的是谁。这里按顶栏实际高度留出偏移量再滚。
     */
    const topbar = document.querySelector<HTMLElement>(".topbar");
    const offset = (topbar?.offsetHeight ?? 0) + 8;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [sub, focusNpcId]);

  /**
   * 宿主默认实现 → 扩展覆盖（`docs/EXTENSIONS.md` §7.5）。两个槽独立解析：
   * 只覆盖详情区时卡片仍是宿主默认，覆盖整张卡时扩展自己决定要不要用 `Details`。
   * 没有扩展注册时原样用默认组件，零回归。
   */
  const NpcCardImpl = resolveUiOverride<NpcCardProps>(HOST_UI_SLOTS.npcCard, vm, NpcCard);
  const NpcDetailsImpl = resolveUiOverride<NpcDetailsProps>(HOST_UI_SLOTS.npcDetails, vm, NpcDetails);

  const extensionViews = extensionViewsFor("world.subview", vm);
  // `ui.yaml` 决定每个 world 子视图上不上屏：内建 overview/npc 与扩展视图走同一条过滤。
  // 扩展视图的能力 id 就是它的 view.id（family 声明为 pedigree/clan）。
  const subtabs: Array<{ key: WorldSubTab; label: string }> = [
    ...WORLD_SUBTABS.filter((entry) =>
      hasSubtabEntry(ui, entry.key === "npc" ? "npcList" : "world"),
    ),
    ...extensionViews
      .filter((view) => hasSubtabEntry(ui, view.id))
      .map((view) => ({ key: view.id, label: view.label })),
  ];
  /** 声明里关掉的页签被选中时回落到第一个可见项，不留空面板。 */
  useEffect(() => {
    if (subtabs.length > 0 && !subtabs.some((entry) => entry.key === sub)) setSub(subtabs[0].key);
  }, [ui, subtabs.length]);
  const activeExtension = extensionViews.find((view) => view.id === sub);
  const ActiveComponent = activeExtension?.Component;
  /** 宿主给扩展的导航能力（可选）；扩展不读也不影响渲染。 */
  const host: ExtensionViewHost = {
    openNpc: (id) => {
      setFocusNpcId(id);
      setSub("npc");
    },
    openSelf: onSelectSelf,
  };

  return (
    <div className="stack">
      <div className="subtabbar" role="tablist" aria-label="世界子页签">
        {subtabs.map((entry) => (
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
          {npcs.length === 0 && <p className="muted">这个世界还没有出现在你身边的人。</p>}
          {npcs.map((npc) => (
            <div key={npc.id} id={`npc-${npc.id}`}>
              <NpcCardImpl
                npc={npc}
                Details={NpcDetailsImpl}
                onSelectStatus={(status) => pushDetail(statusToDetail(status))}
              />
            </div>
          ))}
        </>
      )}

      {ActiveComponent !== undefined && <ActiveComponent vm={vm} host={host} />}

      {/* NPC 身上的状态同样能点开（ADR-002 / R-DETAIL-05）：浮层状态留在本 Tab 内。 */}
      <DetailSheet
        detail={details[details.length - 1] ?? null}
        onClose={() => setDetails((prev) => prev.slice(0, -1))}
        onOpenRef={(effect) => {
          const next = detailOfEffect(snapshot, effect);
          if (next !== null) pushDetail(next);
        }}
      />
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
  // 世界自己发生的事（`world.scheduledFacts` 到点）：玩家不在场，但它发生了。
  // 复用「碑」的样式——这条不是玩家做的一笔，视觉上也该和「你」分开。
  world: { label: "世", cls: "t-milestone" },
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
