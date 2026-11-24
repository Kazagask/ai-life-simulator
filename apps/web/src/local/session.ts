import {
  advanceTurnV2,
  battleActionV2,
  captureGainBaseline,
  chooseOptionV2,
  composeTurnNarrative,
  collectOpeningGains,
  commitOpening,
  createLookup,
  createOpeningSession,
  describeNode,
  diffGains,
  equipErrorCodeOf,
  equipV2,
  evaluateLifeV2,
  normalizeAllocation,
  presentNewlyGeneratedV2,
  presentQueuedEventV2,
  projectSnapshotV2,
  resolveStep,
  unequipV2,
  useItemV2,
  type ResolveInput,
  type TurnPipelineConfig,
} from "@life-sim/game-core";
import type { TemplateBundle } from "@life-sim/template-loader";
import type {
  BattleCommand,
  ContentBlockVM,
  TimeAmount,
  TurnGainVM,
  V2Snapshot,
  V2TurnResult,
  WheelResultView,
  WorldStateV2,
} from "@life-sim/shared";
import type { AgentGateway } from "@life-sim/agent-runtime";
import { EngineError, engineErrorOf } from "./errors";

/**
 * 结构保存点（ADR-0035 §5）：只快照 LLM 能写的三个字段。
 * 与服务端 `world-lock.ts` 同一组字段、同一条纪律 —— 半截写入必须能整体撤销。
 */
function captureStructuralSavepoint(state: WorldStateV2) {
  return structuredClone({
    delayQueue: state.delayQueue,
    enqueueSeqCounter: state.enqueueSeqCounter,
    observationLedger: state.observationLedger,
  });
}

function restoreStructuralSavepoint(
  state: WorldStateV2,
  savepoint: ReturnType<typeof captureStructuralSavepoint>,
): void {
  state.delayQueue = savepoint.delayQueue;
  state.enqueueSeqCounter = savepoint.enqueueSeqCounter;
  state.observationLedger = savepoint.observationLedger;
}

/**
 * 本地引擎会话（ADR-070 第三期 · T3）。
 *
 * 职责只有三件：**调 core、投影、落库**。规则一律不在这一层：
 * - 推进 = `advanceTurnV2` / `chooseOptionV2` / `battleActionV2` / `useItemV2` …
 * - 投影 = `projectSnapshotV2(state, template, lookup, evaluateLifeV2(...), endings, ui)`
 *   —— 与服务端 `projectWorld` 同一条参数串，少一个就会在界面上少一块；
 * - 落库 = 交给调用方（`LocalWorldRepo`），本层不碰存储。
 *
 * 本轮**不接 LLM**：`pipeline` 只带结局 / 评价 / 设定，不带 gateway ⇒ 触发点走模板兜底，
 * 保证「没有模型也能完整玩一轮」。T6 再把 gateway 接进来，行为与今日服务端一致。
 */

export type OpeningCore = ReturnType<typeof createOpeningSession>;
export type OpeningNode = ReturnType<typeof describeNode>;

export interface LocalTurnResponse {
  worldId: string;
  snapshot: V2Snapshot;
  triggeredEvents: V2TurnResult["triggeredEvents"];
  wheelResult: WheelResultView | null;
  elapsed?: TimeAmount;
  gains: TurnGainVM[];
}

/** 与服务端 `entry.pipeline` 同形，只差 gateway / rules（本地暂不接）。 */
export function pipelineOf(bundle: TemplateBundle): TurnPipelineConfig {
  return {
    ...(bundle.endingConfig !== undefined ? { endingConfig: bundle.endingConfig } : {}),
    ...(bundle.evaluationConfig !== undefined ? { evaluationConfig: bundle.evaluationConfig } : {}),
    ...(bundle.lore !== undefined ? { lore: bundle.lore } : {}),
  };
}

// ---------- 开局（DAG 在浏览器里跑） ----------

export function startOpening(
  bundle: TemplateBundle,
  seed: number,
  initial?: Record<string, unknown>,
): { core: OpeningCore; node: OpeningNode } {
  const dag = bundle.openingDag;
  if (dag === undefined) throw new EngineError(400, "opening_dag_not_found");
  const core = createOpeningSession(dag, seed, initial);
  return { core, node: describeNode(dag, core, { template: bundle.template, ui: bundle.ui }) };
}

export function stepOpening(
  bundle: TemplateBundle,
  core: OpeningCore,
  input: ResolveInput,
): {
  core: OpeningCore;
  node: OpeningNode;
  done: boolean;
  results: OpeningCore["results"];
  gains: TurnGainVM[];
  resolved?: { nodeId: string; optionId: string; text: string; set: Record<string, unknown> };
} {
  const dag = bundle.openingDag;
  if (dag === undefined) throw new EngineError(400, "opening_dag_not_found");
  try {
    const outcome = resolveStep(dag, core, input);
    return {
      core: outcome.session,
      node: describeNode(dag, outcome.session, { template: bundle.template, ui: bundle.ui }),
      done: outcome.session.done,
      results: outcome.session.results,
      gains: collectOpeningGains(dag, outcome.session, bundle.template, bundle.ui) as TurnGainVM[],
      ...(outcome.resolved !== undefined ? { resolved: outcome.resolved } : {}),
    };
  } catch (error) {
    throw engineErrorOf(error);
  }
}

/**
 * 开局落定：建世界 + 把第一幕请上桌。
 *
 * 与服务端 `POST /api/opening/:id/commit` 的差异**只有一处**：序章（prologue）暂不生成 ——
 * 它要调模型，而本轮的目标是「无 LLM 也能玩」。历史第一条留空，T6 接回 LLM 时补。
 */
export function commitLocalWorld(
  bundle: TemplateBundle,
  core: OpeningCore,
  worldId: string,
  playerName?: string,
): WorldStateV2 {
  const dag = bundle.openingDag;
  if (dag === undefined) throw new EngineError(400, "opening_dag_not_found");
  try {
    const state = commitOpening(dag, core, bundle.template, worldId, core.seed);
    if (playerName !== undefined && playerName !== "" && state.player.name === "无名氏") {
      state.player.name = playerName;
    }
    presentQueuedEventV2(state, bundle.template, createLookup(bundle.template));
    return state;
  } catch (error) {
    throw engineErrorOf(error);
  }
}

// ---------- 会话 ----------

export class LocalSession {
  /**
   * 本地叙事块（等价于服务端的 trace 正文）：**模板兜底**，有网关时由模型正文另走一路。
   * 只活在内存里 —— 刷新后重放没有意义（它是当轮的阅读材料，不是权威状态）。
   */
  readonly narrativeBlocks: ContentBlockVM[] = [];

  /** 本局收到的 invocation trace（云端上报用；不参与任何判定）。 */
  private traces: Array<{ trace: unknown; turnIndex: number }> = [];

  /** gateway 回调：记一条 trace（只留最近 100 条，防止长局吃内存）。 */
  recordTrace(trace: unknown): void {
    const turnIndex = (trace as { turnIndex?: unknown }).turnIndex;
    this.traces.push({
      trace,
      // trace 自带轮次就用它；没有则用当前状态（服务端 trace 同口径）。
      turnIndex: typeof turnIndex === "number" ? turnIndex : this.state.turnIndex,
    });
    if (this.traces.length > 100) this.traces.splice(0, this.traces.length - 100);
  }

  /**
   * 取出**某一轮**的 trace（其余留在缓冲里）。
   *
   * 为什么按轮取：存档是「每世界一行、按轮覆盖」，一次连点可能只上传最后一版；
   * 若把积压的 trace 全锚到最新存档，轮次就错位了。按轮取 ⇒ 每条 trace 锚到它自己那一版。
   */
  drainTracesForTurn(turnIndex: number): unknown[] {
    const matched = this.traces.filter((entry) => entry.turnIndex === turnIndex).map((entry) => entry.trace);
    this.traces = this.traces.filter((entry) => entry.turnIndex !== turnIndex);
    return matched;
  }

  /** 全部取出（手动兜底；正常上报走 `drainTracesForTurn`）。 */
  drainTraces(): unknown[] {
    const all = this.traces.map((entry) => entry.trace);
    this.traces = [];
    return all;
  }

  /** LLM 网关（T6）：装了才调模型；没装就纯模板兜底（无 key 可跑）。 */
  private gateway: AgentGateway | null = null;

  constructor(
    readonly bundle: TemplateBundle,
    readonly fingerprint: string,
    readonly state: WorldStateV2,
    /** 模板版本（`meta` 里没有版本，它属于 ref）；列表与同步信封要用。 */
    readonly templateVersion = "",
  ) {}

  /** 接线：浏览器直连 provider 的网关；传 null 拆线。 */
  setGateway(gateway: AgentGateway | null): void {
    this.gateway = gateway;
  }

  get hasGateway(): boolean {
    return this.gateway !== null;
  }

  get id(): string {
    return this.state.id;
  }

  /** 带生成事件 overlay 的 lookup：漏了它，存档里已有的分支事件会"看不见"。 */
  private lookup() {
    return createLookup(this.bundle.template).withGenerated(this.state.generatedEvents);
  }

  /** 当前快照（读路径 / 每次写操作之后都用它）。 */
  snapshot(): V2Snapshot {
    return projectSnapshotV2(
      this.state,
      this.bundle.template,
      this.lookup(),
      evaluateLifeV2(this.state, this.bundle.evaluationConfig),
      this.bundle.endingConfig?.endings,
      this.bundle.ui,
    );
  }

  /** 观察者视角（NPC 卡详情用；只影响关系可见性，不换人）。 */
  snapshotAs(viewerId: string): V2Snapshot {
    return projectSnapshotV2(
      this.state,
      this.bundle.template,
      this.lookup(),
      evaluateLifeV2(this.state, this.bundle.evaluationConfig),
      this.bundle.endingConfig?.endings,
      this.bundle.ui,
      viewerId,
    );
  }

  /** 所有写操作的唯一外壳：抓收获基线 → 跑 core → （有网关时）落账 invocation → 投影。 */
  private async settle(
    mutate: () => {
      snapshot: V2Snapshot;
      triggeredEvents?: V2TurnResult["triggeredEvents"];
      wheelResult?: WheelResultView | null;
      elapsed?: TimeAmount;
    },
  ): Promise<LocalTurnResponse> {
    const baseline = captureGainBaseline(this.state);
    let result: ReturnType<typeof mutate>;
    try {
      result = mutate();
    } catch (error) {
      throw engineErrorOf(error);
    }
    /**
     * 结构写入（ADR-0035 §5）与 ADR-070 第三期 T6：模型这一轮写进生成事件的东西，
     * 必须在世界继续推进之前落账；非 committed ⇒ 整体撤销（宁可不发生，也不许晚到）。
     * 浏览器里没有 "晚到" 的第二个写入者，但语义保持一致 —— 服务端与本地不能有两套规则。
     */
    const inv = this.state.pendingInvocation;
    if (inv !== undefined && this.gateway !== null) {
      const savepoint = captureStructuralSavepoint(this.state);
      let committed = false;
      try {
        const outcome = await this.gateway.invoke(inv);
        committed = outcome.outcome === "committed";
      } catch {
        committed = false;
      }
      if (!committed) {
        restoreStructuralSavepoint(this.state, savepoint);
      } else {
        const presented = presentNewlyGeneratedV2(this.state, this.bundle.template, this.lookup());
        result.triggeredEvents = [...(result.triggeredEvents ?? []), ...presented.triggered];
      }
      result.snapshot = this.snapshot();
    }
    // 模板兜底叙事：这一轮没有任何正文（本地局未接 LLM）时，至少给玩家一段可读的记述。
    const narrativeText = composeTurnNarrative(this.state, this.state.turnIndex, result.wheelResult ?? null);
    if (narrativeText !== "") {
      const blockId = `turn-${this.state.turnIndex}-template`;
      if (!this.narrativeBlocks.some((block) => block.blockId === blockId)) {
        this.narrativeBlocks.push({ blockId, kind: "narrative", text: narrativeText });
      }
    }
    const gains = diffGains(baseline, this.state, this.lookup(), this.bundle.ui) as TurnGainVM[];
    return {
      worldId: this.state.id,
      snapshot: result.snapshot,
      triggeredEvents: result.triggeredEvents ?? [],
      wheelResult: result.wheelResult ?? null,
      ...(result.elapsed !== undefined ? { elapsed: result.elapsed } : {}),
      gains,
    };
  }

  async advance(action: { type: string; description: string }, endLife = false): Promise<LocalTurnResponse> {
    return this.settle(() =>
      advanceTurnV2(
        this.state,
        { action, mode: "single", ...(endLife ? { endLife: true } : {}) },
        this.bundle.template,
        this.lookup(),
        undefined,
        pipelineOf(this.bundle),
      ),
    );
  }

  /** 转盘确认：不耗行动、不推时间，只结算已呈现的扇区（ADR-0034 §8-⑩）。 */
  async confirmWheel(): Promise<LocalTurnResponse> {
    return this.settle(() =>
      advanceTurnV2(
        this.state,
        { action: { type: "wheel-confirm", description: "" }, mode: "single" },
        this.bundle.template,
        this.lookup(),
        undefined,
        pipelineOf(this.bundle),
      ),
    );
  }

  async choose(optionId: string): Promise<LocalTurnResponse> {
    return this.settle(() =>
      chooseOptionV2(
        this.state,
        { optionId },
        this.bundle.template,
        this.lookup(),
        pipelineOf(this.bundle),
      ),
    );
  }

  async battle(command: BattleCommand): Promise<LocalTurnResponse> {
    return this.settle(() =>
      battleActionV2(this.state, command, this.bundle.template, this.lookup(), pipelineOf(this.bundle)),
    );
  }

  async useItem(itemId: string): Promise<LocalTurnResponse> {
    return this.settle(() =>
      useItemV2(this.state, { itemId }, this.bundle.template, this.lookup(), pipelineOf(this.bundle)),
    );
  }

  async equip(itemId: string): Promise<LocalTurnResponse> {
    try {
      return await this.settle(() => equipV2(this.state, { itemId }, this.bundle.template, this.lookup()));
    } catch (error) {
      throw equipErrorOf(error);
    }
  }

  async unequip(instanceId: string): Promise<LocalTurnResponse> {
    try {
      return await this.settle(() => unequipV2(this.state, { instanceId }, this.bundle.template, this.lookup()));
    } catch (error) {
      throw equipErrorOf(error);
    }
  }

  /** 轮外加点：与 `POST /api/worlds/:id/allocation` 同一套判定（含战斗中 409）。 */
  allocate(allocationId: string, points: Record<string, number>): { snapshot: V2Snapshot; spent: number } {
    if (this.state.battle !== null) throw new EngineError(409, "allocation_in_battle");
    const pending = this.state.pendingAllocation;
    if (pending === undefined) throw new EngineError(409, "no_pending_allocation");
    if (pending.id !== allocationId) throw new EngineError(409, "allocation_mismatch");
    const checked = normalizeAllocation(points, { budget: pending.budget, targets: pending.targets });
    if (!checked.ok) throw new EngineError(400, `allocation_${checked.code}`, checked.detail);
    const caps = this.bundle.template.attributes.caps;
    for (const [attribute, amount] of Object.entries(checked.points)) {
      if (amount <= 0) continue;
      const current = this.state.player.attributes[attribute];
      if (typeof current !== "number") continue;
      const cap = caps?.[attribute];
      this.state.player.attributes[attribute] = cap !== undefined ? Math.min(cap, current + amount) : current + amount;
    }
    delete this.state.pendingAllocation;
    return { snapshot: this.snapshot(), spent: checked.spent };
  }

  /** 改名：只写 self 实体的名字，不推进时间（R-NAME-02）。 */
  rename(name: string): { snapshot: V2Snapshot } {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 20) throw new EngineError(400, "invalid_body");
    this.state.player.name = trimmed;
    return { snapshot: this.snapshot() };
  }
}

/** 装备错误码 → 状态码（与服务端 `handleEquipError` 同一张表）。 */
function equipErrorOf(error: unknown): EngineError {
  const code = equipErrorCodeOf(error);
  if (code === null) return engineErrorOf(error);
  const status = code === "slot_full" || code === "slot_category_mismatch" ? 409 : 400;
  return new EngineError(status, code);
}
