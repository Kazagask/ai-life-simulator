import { FINGERPRINT_VERSION, fingerprintVerdict, upgradeRecord } from "./worldRepo";
import { createTimeAdapter } from "@life-sim/game-core";
import type { TemplateBundle } from "@life-sim/template-loader";
import type { BattleCommand, ContentBlockVM, WorldStateV2 } from "@life-sim/shared";
import { EngineError } from "./errors";
import { createClientGateway, type ClientAgentConfig } from "./agent";
import { LocalSession, commitLocalWorld, startOpening, stepOpening, type OpeningCore, type OpeningNode } from "./session";
import type { LocalWorldRecord, LocalWorldRepo } from "./worldRepo";

/**
 * 本地传输层（ADR-070 第三期 · T4）。
 *
 * 与 `apps/web/src/api.ts` 的 `api` 对象**同形状**：UI 组件一行不改，由 `api` 在调用前
 * 问一句「这个世界归本地还是远端」。归属判据只有一条：**这个 worldId 有没有本地会话**
 * —— 老档（服务端世界）永远返回 false，继续走原来的 API。
 *
 * 本层不实现规则：所有写操作都转发给 `LocalSession`，它再转发给 core。
 */

export interface OpeningSessionRecord {
  core: OpeningCore;
  bundle: TemplateBundle;
  fingerprint: string;
  templateVersion: string;
  seed: number;
  playerName?: string;
}

export interface LocalTemplate {
  ref: { id: string; version: string };
  /** 新算法的语义指纹（不含 manifest）——存档写的就是它。 */
  fingerprint: string;
  /** 旧算法的值：只给旧存档的一次性升级通道用（见 `worldRepo.fingerprintVerdict`）。 */
  legacyFingerprint?: string;
  bundle: TemplateBundle;
}

export interface WorldSummaryLike {
  id: string;
  templateId: string;
  templateVersion: string;
  templateName: string;
  playerName: string;
  turnIndex: number;
  worldTime: number;
  formattedTime: string;
  status: "running" | "terminated" | "archived";
  loadable: boolean;
  savedAt: string;
}

/** 本地引擎对 UI 暴露的最小面（`api.ts` 只依赖这个接口，不依赖实现）。 */
export interface LocalEngine {
  owns(worldId: string): boolean;
  /** 这个模板版本本地有没有包：没有就回退远端（服务端仍能起局）。 */
  hasTemplate(templateId: string, version?: string): boolean;
  /** 开局三步：建会话 / 步进 / 落定。 */
  createOpening(input: { templateId: string; templateVersion?: string; playerName?: string; seed?: number }): {
    sessionId: string;
    seed: number;
    node: OpeningNode | null;
  };
  stepOpening(sessionId: string, step: { kind: "roll" } | { kind: "choose"; optionId: string } | { kind: "allocate"; allocation: Record<string, number> } | { kind: "input"; value: string }): {
    node: OpeningNode | null;
    done: boolean;
    results: OpeningCore["results"];
    gains: unknown[];
    resolved?: unknown;
  };
  commitOpening(sessionId: string): Promise<{
    worldId: string;
    snapshot: ReturnType<LocalSession["snapshot"]>;
    gains: unknown[];
    prologue?: string;
    prologueSource?: "llm" | "template";
  }>;
  getWorld(worldId: string): { worldId: string; snapshot: ReturnType<LocalSession["snapshot"]> };
  advanceTurn(worldId: string, action: { type: string; description: string }, endLife?: boolean): Promise<unknown>;
  confirmWheel(worldId: string): Promise<unknown>;
  chooseOption(worldId: string, optionId: string): Promise<unknown>;
  battleAction(worldId: string, command: BattleCommand): Promise<unknown>;
  useItem(worldId: string, itemId: string): Promise<unknown>;
  equipItem(worldId: string, itemId: string): Promise<unknown>;
  unequipItem(worldId: string, instanceId: string): Promise<unknown>;
  submitAllocation(worldId: string, allocationId: string, points: Record<string, number>): Promise<unknown>;
  renameWorld(worldId: string, name: string): Promise<unknown>;
  archiveWorld(worldId: string): Promise<{ worldId: string; archive: { snapshot: unknown } }>;
  listWorlds(): WorldSummaryLike[];
  /** 世界日志：本地存档里的历史（投影同口径：只给 public）。 */
  history(worldId: string): { history: WorldStateV2["history"] };
  /** 本地叙事块（模板兜底 / 网关正文），等价于服务端 trace 的玩家可见部分。 */
  narrative(worldId: string): { blocks: ContentBlockVM[] };
  deleteWorld(worldId: string): Promise<void>;
  /** 本地存档仓库（档案页列存档、上传前取正文）。 */
  listRecords(): Promise<LocalWorldRecord[]>;
  readRecord(worldId: string): Promise<LocalWorldRecord | undefined>;
  /** 从云端恢复：写库 + 建会话（模板未注册会抛 `template_not_found`）。 */
  importRecord(record: LocalWorldRecord): Promise<void>;
}

/**
 * 本地世界引擎。`persist` 可选：不给就是"内存会话"（单测 / 隐私模式），
 * 给了就在每次写操作后落库（IndexedDB），刷新后可续。
 */
export function createLocalEngine(options: {
  repo?: LocalWorldRepo;
  now?: () => string;
  /** 玩家自己的模型配置（没有 ⇒ 不接线，走模板兜底）。 */
  agent?: () => ClientAgentConfig | null;
  /** 本地写档之后（已落 IndexedDB）：交给云端同步，失败不影响本地。 */
  onPersist?: (record: LocalWorldRecord, session: LocalSession) => void;
}): LocalEngine & {
  registerTemplate(template: LocalTemplate): void;
  /** 从仓库预热：打开页面时把本地世界恢复成会话。 */
  warmUp(): Promise<void>;
  sessions(): LocalSession[];
} {
  const now = options.now ?? (() => new Date().toISOString());
  const templates = new Map<string, LocalTemplate>();
  const openings = new Map<string, OpeningSessionRecord>();
  const sessions = new Map<string, LocalSession>();
  /** 每局最后一次落库时间：`listWorlds()` 要如实显示，不能拿 `now()` 冒充（冲突提示靠它）。 */
  const savedAtById = new Map<string, string>();
  let ordinal = 0;

  const bundleFor = (templateId: string, version?: string): LocalTemplate => {
    const direct = version !== undefined ? templates.get(`${templateId}@${version}`) : undefined;
    if (direct !== undefined) return direct;
    const any = [...templates.values()].find((t) => t.ref.id === templateId);
    if (any === undefined) throw new EngineError(404, "template_not_found");
    return any;
  };

  const sessionOf = (worldId: string): LocalSession => {
    const session = sessions.get(worldId);
    if (session === undefined) throw new EngineError(404, "world_not_found");
    return session;
  };

  const persist = async (session: LocalSession): Promise<void> => {
    if (options.repo === undefined) return;
    const record = {
      id: session.id,
      formatVersion: 1 as const,
      savedAt: now(),
      ref: { id: session.bundle.template.meta.id, version: session.templateVersion },
      fingerprint: session.fingerprint,
      fingerprintVersion: FINGERPRINT_VERSION,
      state: session.state,
    };
    await options.repo.write(record);
    savedAtById.set(record.id, record.savedAt);
    options.onPersist?.(record, session);
  };

  const engine: LocalEngine & {
    registerTemplate(template: LocalTemplate): void;
    warmUp(): Promise<void>;
    sessions(): LocalSession[];
  } = {
    owns: (worldId) => sessions.has(worldId),

    hasTemplate: (templateId, version) =>
      version !== undefined
        ? templates.has(`${templateId}@${version}`)
        : [...templates.values()].some((t) => t.ref.id === templateId),

    registerTemplate(template) {
      templates.set(`${template.ref.id}@${template.ref.version}`, template);
    },

    async warmUp() {
      if (options.repo === undefined) return;
      const records = await options.repo.list();
      for (const record of records) {
        const template = [...templates.values()].find((t) => t.ref.id === record.ref.id);
        // 模板没下过 / 指纹漂移 ⇒ 不预热：这条档要按「模板已变」拒载，不能静默按新模板解释。
        // 旧算法命中的档走 `upgrade`（一次性通道），升级后按新指纹继续用。
        const verdict =
          template === undefined
            ? "drift"
            : fingerprintVerdict(record, { v2: template.fingerprint, legacy: template.legacyFingerprint });
        if (template === undefined || verdict === "drift") continue;
        const upgraded = verdict === "upgrade" ? upgradeRecord(record, template.fingerprint) : record;
        if (verdict === "upgrade" && options.repo !== undefined) await options.repo.write(upgraded);
        const restored = new LocalSession(template.bundle, upgraded.fingerprint, upgraded.state, record.ref.version);
        restored.setGateway(
          createClientGateway(template.bundle, record.state, options.agent?.() ?? null, {
            onTrace: (trace) => restored.recordTrace(trace),
          }),
        );
        sessions.set(record.id, restored);
        savedAtById.set(record.id, record.savedAt);
      }
    },

    sessions: () => [...sessions.values()],

    createOpening(input) {
      const template = bundleFor(input.templateId, input.templateVersion);
      const seed = input.seed ?? Math.floor(Math.random() * 0xffffffff);
      // 向导里填的名字作为宿主初始参数（ADR-072 D7）：输入节点的预填靠它区分
      // 「玩家写过了」和「没写，用转盘给的」。
      const { core, node } = startOpening(
        template.bundle,
        seed,
        input.playerName !== undefined && input.playerName.trim() !== ""
          ? { playerName: input.playerName.trim() }
          : undefined,
      );
      ordinal += 1;
      const sessionId = `local-open-${ordinal}`;
      openings.set(sessionId, {
        core,
        bundle: template.bundle,
        fingerprint: template.fingerprint,
        templateVersion: template.ref.version,
        seed,
        ...(input.playerName !== undefined ? { playerName: input.playerName } : {}),
      });
      return { sessionId, seed, node };
    },

    stepOpening(sessionId, step) {
      const record = openings.get(sessionId);
      if (record === undefined) throw new EngineError(404, "opening_session_not_found");
      const result = stepOpening(record.bundle, record.core, step);
      openings.set(sessionId, { ...record, core: result.core });
      return {
        node: result.node,
        done: result.done,
        results: result.results,
        gains: result.gains,
        ...(result.resolved !== undefined ? { resolved: result.resolved } : {}),
      };
    },

    async commitOpening(sessionId) {
      const record = openings.get(sessionId);
      if (record === undefined) throw new EngineError(404, "opening_session_not_found");
      const worldId = `local-${Date.now().toString(36)}-${(ordinal += 1).toString(36)}`;
      const state: WorldStateV2 = commitLocalWorld(record.bundle, record.core, worldId, record.playerName);
      const session = new LocalSession(record.bundle, record.fingerprint, state, record.templateVersion);
      session.setGateway(createClientGateway(record.bundle, state, options.agent?.() ?? null, { onTrace: (trace) => session.recordTrace(trace) }));
      sessions.set(worldId, session);
      openings.delete(sessionId);
      await persist(session);
      return { worldId, snapshot: session.snapshot(), gains: [] };
    },

    getWorld(worldId) {
      const session = sessionOf(worldId);
      return { worldId, snapshot: session.snapshot() };
    },

    async advanceTurn(worldId, action, endLife = false) {
      const session = sessionOf(worldId);
      const result = await session.advance(action, endLife);
      await persist(session);
      return result;
    },

    async confirmWheel(worldId) {
      const session = sessionOf(worldId);
      const result = await session.confirmWheel();
      await persist(session);
      return result;
    },

    async chooseOption(worldId, optionId) {
      const session = sessionOf(worldId);
      const result = await session.choose(optionId);
      await persist(session);
      return result;
    },

    async battleAction(worldId, command) {
      const session = sessionOf(worldId);
      const result = await session.battle(command);
      await persist(session);
      return result;
    },

    async useItem(worldId, itemId) {
      const session = sessionOf(worldId);
      const result = await session.useItem(itemId);
      await persist(session);
      return result;
    },

    async equipItem(worldId, itemId) {
      const session = sessionOf(worldId);
      const result = await session.equip(itemId);
      await persist(session);
      return result;
    },

    async unequipItem(worldId, instanceId) {
      const session = sessionOf(worldId);
      const result = await session.unequip(instanceId);
      await persist(session);
      return result;
    },

    async submitAllocation(worldId, allocationId, points) {
      const session = sessionOf(worldId);
      const { snapshot, spent } = session.allocate(allocationId, points);
      await persist(session);
      return { worldId, snapshot, spent };
    },

    async renameWorld(worldId, name) {
      const session = sessionOf(worldId);
      const { snapshot } = session.rename(name);
      await persist(session);
      return { worldId, snapshot };
    },

    narrative(worldId) {
      // 返回副本：`narrativeBlocks` 是就地 push 的，直接把同一个数组交给 React
      // 会让 `setState` 判定「引用没变」而跳过渲染（切页签重挂载才看见的经典成因）。
      return { blocks: [...sessionOf(worldId).narrativeBlocks] };
    },

    async archiveWorld(worldId) {
      const session = sessionOf(worldId);
      session.state.archived = true;
      const snapshot = session.snapshot();
      await persist(session);
      return { worldId, archive: { snapshot } };
    },

    history(worldId) {
      const session = sessionOf(worldId);
      return { history: session.state.history.filter((entry) => (entry.visibility ?? "public") === "public") };
    },

    async listRecords() {
      return options.repo?.list() ?? [];
    },

    async readRecord(worldId) {
      return options.repo?.read(worldId);
    },

    async importRecord(record) {
      // 与 warmUp 同一条纪律：模板没下过 ⇒ 404；指纹不相等 ⇒ 旧模板拒载，绝不静默解释。
      const any = [...templates.values()].find((t) => t.ref.id === record.ref.id);
      if (any === undefined) throw new EngineError(404, "template_not_found");
      const verdict = fingerprintVerdict(record, { v2: any.fingerprint, legacy: any.legacyFingerprint });
      if (verdict === "drift") throw new EngineError(409, "template_content_drift");
      if (verdict === "upgrade" && options.repo !== undefined) {
        await options.repo.write(upgradeRecord(record, any.fingerprint));
      }
      const session = new LocalSession(any.bundle, any.fingerprint, record.state, record.ref.version);
      session.setGateway(
        createClientGateway(any.bundle, record.state, options.agent?.() ?? null, {
          onTrace: (trace) => session.recordTrace(trace),
        }),
      );
      sessions.set(record.id, session);
      savedAtById.set(record.id, record.savedAt);
      await options.repo?.write(record);
    },

    listWorlds() {
      return [...sessions.values()].map((session) => {
        const state = session.state;
        const meta = session.bundle.template.meta;
        const status = state.archived === true ? "archived" : state.termination !== null ? "terminated" : "running";
        return {
          id: state.id,
          templateId: meta.id,
          templateVersion: session.templateVersion,
          templateName: meta.name ?? meta.id,
          playerName: state.player.name,
          turnIndex: state.turnIndex,
          worldTime: state.worldTime,
          formattedTime: createTimeAdapter(session.bundle.template).format(state.worldTime),
          status,
          loadable: true,
          // 如实显示最后一次落库时间；冲突提示与列表排序都依赖它。
          savedAt: savedAtById.get(state.id) ?? now(),
        } satisfies WorldSummaryLike;
      });
    },

    async deleteWorld(worldId) {
      sessions.delete(worldId);
      savedAtById.delete(worldId);
      await options.repo?.remove(worldId);
    },
  };

  return engine;
}
