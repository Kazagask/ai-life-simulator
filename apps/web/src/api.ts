import { encryptCredentialPayload } from "./llmCrypto";
import type { LocalEngine } from "./local/transport";
import type {
  BattleCommand,
  ContentBlockVM,
  EndingView,
  HistoryEntryV2,
  ResolvedStyle,
  SlotEventView,
  TimeAmount,
  TurnGain,
  UiConfig,
  V2Snapshot,
  WheelResultView,
} from "@life-sim/shared";

const BASE = "";

/**
 * 服务端在响应出口挂上的模板展示声明（来自 `ui.yaml`）。
 * 它与权威状态无关：引擎不读、不进指纹、不进存档，只影响前端怎么摆面板。
 */
export type WorldSnapshot = V2Snapshot & { ui?: UiConfig };

/** R2.7 / R-NAR-03：叙事来源（与 shared 的 NarrativeSourceSchema 同值域，前端只做展示判定）。 */
export type NarrativeSource = "template" | "llm" | "fallback";

/**
 * R2.7 / R-NAR-03：事件 flavor 展示文案表。键为事件 id，值为服务端异步生成并已校验的
 * **展示**文案。fire-and-forget 结果，可能缺失、可能为空对象；非权威缓存、不进存档 / replay。
 * 前端不得依赖它存在，只用于当次渲染。
 */
export type EventFlavorMap = Record<string, string>;

// R2.8 · R-LLM-07 / BACKLOG B-01：用户配置的自定义 LLM 凭证。
// 两样东西分开存：
// - **不透明 sessionId**（`life-sim-llm-session`）：后续请求靠它带 `x-life-sim-llm-session` 头；
// - **配置本体**（`life-sim-llm-config`）：`apiKey/model/baseUrl`，存在本机，刷新 / 重开自动填好，
//   免去每次重填。提交时用公钥加密（`llmCrypto.ts`），wire 上没有明文。
const LLM_SESSION_KEY = "life-sim-llm-session";
const LLM_CONFIG_KEY = "life-sim-llm-config";

let llmSessionId: string | null = null;
try {
  llmSessionId = localStorage.getItem(LLM_SESSION_KEY);
} catch {
  /* localStorage 不可用时降级为内存态 */
}

export function getLlmSession(): string | null {
  return llmSessionId;
}

export function setLlmSession(id: string | null): void {
  llmSessionId = id;
  try {
    if (id === null) localStorage.removeItem(LLM_SESSION_KEY);
    else localStorage.setItem(LLM_SESSION_KEY, id);
  } catch {
    /* 忽略持久化失败 */
  }
}

/** 清除本地 LLM 会话（不透明 id；服务端内存凭证由超时/重启自然清退）。 */
export function clearLlmSession(): void {
  setLlmSession(null);
}

export interface LlmCredentialInput {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

/** 读取本机缓存的凭证（没有 / 读不出 / 形状不对都返回 null）。 */
export function getCachedLlmCredentials(): LlmCredentialInput | null {
  try {
    const raw = localStorage.getItem(LLM_CONFIG_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<LlmCredentialInput>;
    if (typeof parsed.apiKey !== "string" || typeof parsed.model !== "string") return null;
    return {
      apiKey: parsed.apiKey,
      model: parsed.model,
      ...(typeof parsed.baseUrl === "string" && parsed.baseUrl !== "" ? { baseUrl: parsed.baseUrl } : {}),
    };
  } catch {
    return null;
  }
}

function setCachedLlmCredentials(input: LlmCredentialInput): void {
  try {
    localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(input));
  } catch {
    /* 忽略持久化失败：会话 id 仍可用，只是下次要重填 */
  }
}

/** 清除本机缓存（连同不透明 sessionId）。 */
export function clearCachedLlmCredentials(): void {
  try {
    localStorage.removeItem(LLM_CONFIG_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 提交自定义 LLM 凭证（**加密信封**），拿到不透明 sessionId 并本地留存配置。 */
export async function submitLlmCredentials(input: LlmCredentialInput): Promise<string> {
  const envelope = await encryptCredentialPayload(input);
  const res = await request<{ sessionId: string }>("/api/llm-credentials", {
    method: "POST",
    body: JSON.stringify({ envelope }),
  });
  setLlmSession(res.sessionId);
  setCachedLlmCredentials(input);
  return res.sessionId;
}

/** 连通性探测结果（服务端语义见 `/api/llm-credentials/test` 的注释）。 */
export interface LlmProbeResult {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  reason?: string;
  detail?: string;
}

/**
 * 保存前先探一次连通性（同样走加密信封，载荷不落地、不入内存）。
 *
 * 探测失败**不阻断保存**：有些自建网关会拒绝这种最小的探测请求，但正式调用没问题。
 * 调用方把它当「诊断信息」展示，而不是门禁。
 */
export async function testLlmCredentials(input: LlmCredentialInput): Promise<LlmProbeResult> {
  const envelope = await encryptCredentialPayload(input);
  return request<LlmProbeResult>("/api/llm-credentials/test", {
    method: "POST",
    body: JSON.stringify({ envelope }),
  });
}

/**
 * 服务端错误体里前端真正用得到的字段（R2.8 / T-TG-07）。
 *
 * 建局的两个枚举错误会带**候选列表**，缺了它玩家只能看到一句「请求失败」而不知道该选什么：
 *  - 400 `template_version_required` + `versions[]`
 *  - 400/404 `opening_not_found` + `allowed[]`
 * 其余字段只用于拼一条可诊断的 message，不参与任何游戏判定。
 */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  code?: string;
  /**
   * 具体原因（服务端自己的那一句，例如 `opening_input_too_long: n-name (16 > 12)`）。
   * `error` 只是分类码，真正能定位问题的是它。
   */
  detail?: unknown;
  /** `opening_not_found` 时该版本合法的 openingId 列表（服务端下发，前端只做展示）。 */
  allowed?: string[];
  /** `template_version_required` 时该模板的可载版本列表。 */
  versions?: string[];
  templateId?: string;
  templateVersion?: string;
}

/**
 * 带状态码与服务端错误体的请求错误。
 * 继承 `Error`：既有的 `e instanceof Error ? e.message : ...` 调用点行为不变。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, message: string, body: ApiErrorBody | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** 服务端错误码：优先业务码 `error`，回退 Fastify 的 `code`（如 `FST_ERR_CTP_INVALID_MEDIA_TYPE`）。 */
  get code(): string | undefined {
    return this.body?.error ?? this.body?.code;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // 合并请求头：带 body 时声明 JSON；若已建立 LLM 会话，附带 session 头（不透明 id，不含 key 明文）。
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  if (llmSessionId !== null) headers["x-life-sim-llm-session"] = llmSessionId;
  const res = await fetch(`${BASE}${url}`, {
    ...init,
    ...(Object.keys(headers).length > 0
      ? { headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } }
      : {}),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    let body: ApiErrorBody | null = null;
    try {
      // Fastify 的错误体是 { statusCode, code, error, message }。
      // error 只是一句通用短语（如 "Unsupported Media Type"），真正能定位问题的是
      // message（带具体 Content-Type）与 code（FST_ERR_CTP_*），三者一起展示。
      body = (await res.json()) as ApiErrorBody;
      const parts = [body.error ?? `${res.status}`];
      // 开局 / 加点的失败原因在 `detail`（分类码 + 具体哪一格），不带出来玩家只会看到
      // 一句 "请求失败：opening_step_invalid"。
      if (typeof body.detail === "string" && body.detail !== "") parts.push(body.detail);
      if (body.message && body.message !== body.error) parts.push(body.message);
      if (body.code) parts.push(body.code);
      detail = parts.join(" ｜ ");
    } catch {
      /* 忽略解析失败 */
    }
    throw new ApiError(res.status, `请求失败：${detail}`, body);
  }
  return (await res.json()) as T;
}

export interface OpeningSummary {
  id: string;
  name: string;
  description: string;
}

/** 该版本使用前实例化开局向导（ADR-001）；`GET /api/templates` 只下发声明，不下发 DAG 正文。 */
export interface OpeningDagSummary {
  openingId: string;
  name: string;
  description?: string;
}

/** 开局节点视图：roll 的选项只用于转盘扇区；allocate 带点数规格。 */
export interface OpeningNodeView {
  nodeId: string;
  title: string;
  text?: string;
  mode: "roll" | "choose" | "allocate" | "input";
  options: Array<{ id: string; text: string; weight?: number }>;
  /** input 节点（ADR-072 D7）：预填已由引擎解析好，前端只负责塞进输入框。 */
  input?: {
    param: string;
    value: string;
    placeholder?: string;
    hint?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    defaultValue?: string;
  };
  allocation?: {
    param: string;
    budget: number;
    /** label/style 由服务端投影解析好（ADR-004 D6），前端不查模板。 */
    targets: Array<{
      attribute: string;
      label: string;
      min?: number;
      max?: number;
      style?: ResolvedStyle;
    }>;
  };
}

export interface OpeningStepResultView {
  nodeId: string;
  optionId?: string;
  rollIndex?: number;
  allocation?: Record<string, Record<string, number>>;
}

export type OpeningStepInput =
  | { kind: "roll" }
  | { kind: "choose"; optionId: string }
  | { kind: "allocate"; allocation: Record<string, number> }
  | { kind: "input"; value: string };

export interface OpeningStepResponse {
  node: OpeningNodeView | null;
  done: boolean;
  resolved?: { nodeId: string; optionId: string; text: string; set: Record<string, unknown> };
  results: OpeningStepResultView[];
  /** 到目前为止的开局所得（每步预览，与 commit 同一份实现）。 */
  gains?: TurnGain[];
}

/** 可载入版本（`loadable: true`）：带完整展示字段与**属于该版本**的开局列表。 */
export interface LoadableTemplateVersion {
  id: string;
  version: string;
  name: string;
  description: string;
  startYear: number;
  openings: OpeningSummary[];
  /** 存在即走前实例化开局向导；旧模板缺字段走原建局表单。 */
  openingDag?: OpeningDagSummary;
  assetCount: number;
  assetFingerprint: string;
  loadable: true;
}

/** 存在但不可载入的版本（`loadable: false`）：只有身份与原因，无展示字段、不可建局。 */
export interface UnloadableTemplateVersion {
  id: string;
  version: string;
  loadable: false;
  /** 服务端诊断串（可能含内部路径）。**不渲染**，仅供控制台排查。 */
  reason: string;
}

/** R2.8 / R-TG-01：`GET /api/templates` 的版本层（可载 / 不可载的判别联合）。 */
export type TemplateVersionSummary = LoadableTemplateVersion | UnloadableTemplateVersion;

/**
 * R2.8 / R-TG-01：`GET /api/templates` 的模板层（两级结构：先选模板、再选版本）。
 *
 * `startVersion` 是服务端定义的**默认选中版本**（唯一可载版本 ⇒ 它本身；多版本 ⇒ 补 0 后
 * 全序最高的**可载**版本）。它与 `versions[0]`（最低版本）语义不同，**必须用 `startVersion`**。
 */
export interface TemplateSummary {
  id: string;
  name: string;
  startVersion?: string;
  versions: TemplateVersionSummary[];
}

export function isLoadableVersion(v: TemplateVersionSummary): v is LoadableTemplateVersion {
  return v.loadable;
}

/**
 * 取模板的默认选中版本（R-TG-01 契约：用 `startVersion`，不要用 `versions[0]`）。
 *
 * 兜底顺序：`startVersion`（且确实可载）→ 最高可载版本 → `startVersion` 原值（该 id 下全不可载，
 * 让 UI 显示「版本不可用」而不是静默换一个）→ 首个版本。`versions` 服务端已按版本号升序给出。
 */
export function defaultVersionOf(template: TemplateSummary): string | undefined {
  const start =
    template.startVersion !== undefined
      ? template.versions.find((v) => v.version === template.startVersion)
      : undefined;
  if (start?.loadable === true) return start.version;
  const highestLoadable = template.versions.filter(isLoadableVersion).at(-1);
  if (highestLoadable !== undefined) return highestLoadable.version;
  return template.startVersion ?? template.versions[0]?.version;
}

/**
 * 取某模板下指定版本；版本号不存在或当前不可载时返回 `undefined`。
 * 建局前用它判定「能不能提交」，避免把不可载版本发出去换一个 409。
 */
export function loadableVersionOf(
  template: TemplateSummary | undefined,
  version: string | undefined,
): LoadableTemplateVersion | undefined {
  if (template === undefined || version === undefined) return undefined;
  const found = template.versions.find((v) => v.version === version);
  return found?.loadable === true ? found : undefined;
}

/** 可继续的世界行（R-PS-04）：`savedAt` 倒序由服务端保证。 */
export interface LoadableWorldSummary {
  id: string;
  templateId: string;
  /** R2.8 / R-TG-01：存档固化的模板版本引用。 */
  templateVersion?: string;
  loadable?: true;
  templateName: string;
  playerName: string;
  turnIndex: number;
  worldTime: number;
  formattedTime: string;
  status: "running" | "terminated" | "archived";
  endingTitle?: string;
  savedAt: string;
}

/**
 * R2.8 / R-TG-10 C-5：**存在但不可载**的档（坏档 / 模板内容变了 / 模板被删）。
 *
 * 服务端只下发诊断字段：`reason` 是封闭枚举、`detail` 是具体对象（**可能含内部路径，
 * 前端不渲染**）。这类行在列表里可见、可删，但**不可打开**（没有 state 可投影）。
 */
export interface UnloadableWorldSummary {
  id: string;
  templateId: string;
  templateVersion?: string;
  loadable: false;
  reason: string;
  detail?: string;
  savedAt: string;
}

export type WorldSummary = LoadableWorldSummary | UnloadableWorldSummary;

export interface InteractionResponse {
  worldId: string;
  snapshot: WorldSnapshot;
  /** 服务端目前只下发 `eventFlavors` map；`flavor` 为可选占位，缺省完全等同当前行为。 */
  triggeredEvents: Array<{ id: string; title: string; narrative: string; flavor?: string }>;
  wheelResult: WheelResultView | null;
  /** R2.7 / R-NAR-03：可选，异步生成、可能为空对象或整字段缺失。前端不得依赖它存在。 */
  eventFlavors?: EventFlavorMap;
}

/** `eventFlavors` 经 `InteractionResponse` 继承，此处不再重复声明。 */
export interface TurnResponse extends InteractionResponse {
  turnIndex: number;
  elapsed: TimeAmount;
  /** 本轮收获（ADR-002 D4）：服务端差分得出，刷新即消失。 */
  gains?: TurnGain[];
}

/**
 * 归档响应的玩家投影（R-VS-04）：public 历史 + hidden 计数（内容不下发）。
 * `archive.snapshot` 是归档时刻的**最终快照**（status=archived，带 ending 与 evaluation
 * 五维分项），与 `GET /api/worlds/:id` 的投影同源，所以调用方直接用它刷新即可。
 */
export interface ArchiveResponse {
  worldId: string;
  archive: {
    snapshot: WorldSnapshot;
    /** 归档中被过滤掉的 hidden 条目数（只公开计数，不公开内容） */
    hiddenHistoryCount?: number;
    /** R2.7：归档时刻固化的结局叙事来源与文案（可选；旧档 / 未装饰时缺失）。 */
    ending?: {
      narrativeSource?: NarrativeSource;
      title?: string;
      summary?: string;
    };
    /** R2.7：归档时刻固化的人生总结来源与文案（可选）。来源不改变评分。 */
    evaluation?: {
      summary?: string;
      summarySource?: NarrativeSource;
    };
  };
}

export interface CreateWorldInput {
  templateId: string;
  /** 可空：不填即“无名氏”（ADR-001 D-5）。 */
  playerName?: string;
  /**
   * R2.8 / R-TG-01：版本目录名。**始终带上**——多版本时服务端强制要求
   * （缺 ⇒ 400 `template_version_required`），单版本时显式传更可诊断（服务端亦接受）。
   */
  templateVersion?: string;
  seed?: number;
  /** R-OP-01：必须是**所选版本**的开局 id；省略则服务端取该版本的首个开局。 */
  openingId?: string;
}

/**
 * 本地引擎桥（ADR-070 第三期 · T4）。
 *
 * UI 只认 `api`：每个世界级方法先问一句「这个世界归本地吗」。归属判据只有一条 ——
 * 这个 `worldId` 有没有本地会话。老档（服务端世界）永远 false，继续走原来的 HTTP 路径；
 * 本地世界则完全不出网（模板与同步除外）。
 */
let localEngine: LocalEngine | null = null;

export function setLocalEngine(engine: LocalEngine | null): void {
  localEngine = engine;
}

/** 这个世界是不是本地会话：叙事 / trace 这类服务端产物要据此跳过。 */
export function isLocalWorldId(id: string): boolean {
  return localEngine?.owns(id) ?? false;
}

export const api = {
  listTemplates() {
    return request<{ templates: TemplateSummary[] }>("/api/templates");
  },
  /**
   * 世界列表（R-PS-04）：savedAt 倒序由服务端保证。
   *
   * **本地优先**（2026-11-24 报障「加载本地存档很慢」）：本地档立刻返回，服务端那一份
   * 有结果了再通过 `onRemote` 合并。以前是 `await` 远端再拼 —— 网络慢的时候，
   * 明明存档就在 IndexedDB 里，玩家还是要盯着转圈等一个他不需要的请求。
   */
  async listWorlds(onRemote?: (worlds: WorldSummary[]) => void) {
    const local = (localEngine?.listWorlds() ?? []) as unknown as WorldSummary[];
    void request<{ worlds: WorldSummary[] }>("/api/worlds")
      .then((remote) => onRemote?.([...local, ...remote.worlds]))
      .catch(() => {
        // 服务端不可用不影响本地档可见（本地优先的第一条体感）。
      });
    return { worlds: local };
  },
  deleteWorld(id: string) {
    if (localEngine?.owns(id)) return localEngine.deleteWorld(id).then(() => ({ deleted: id }));
    return request<{ deleted: string }>(`/api/worlds/${id}`, { method: "DELETE" });
  },
  /** 装备穿脱（R-EQ-08）：不推进时间，返回新快照。 */
  equipItem(id: string, itemId: string) {
    if (localEngine?.owns(id)) {
      return localEngine.equipItem(id, itemId) as ReturnType<typeof request<{ worldId: string; snapshot: WorldSnapshot }>>;
    }
    return request<{ worldId: string; snapshot: WorldSnapshot }>(`/api/worlds/${id}/equipment/equip`, {
      method: "POST",
      body: JSON.stringify({ itemId }),
    });
  },
  unequipItem(id: string, instanceId: string) {
    if (localEngine?.owns(id)) {
      return localEngine.unequipItem(id, instanceId) as ReturnType<typeof request<{ worldId: string; snapshot: WorldSnapshot }>>;
    }
    return request<{ worldId: string; snapshot: WorldSnapshot }>(`/api/worlds/${id}/equipment/unequip`, {
      method: "POST",
      body: JSON.stringify({ instanceId }),
    });
  },
  /** R-OP-01 / R-TG-01：两级模板建局；`templateVersion` 与 `openingId` 的归属约束见 `CreateWorldInput`。 */
  createWorld(input: CreateWorldInput) {
    return request<{ worldId: string; snapshot: WorldSnapshot }>("/api/worlds", {
      method: "POST",
      body: JSON.stringify({
        templateId: input.templateId,
        ...(input.playerName !== undefined ? { playerName: input.playerName } : {}),
        ...(input.templateVersion !== undefined ? { templateVersion: input.templateVersion } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.openingId !== undefined ? { openingId: input.openingId } : {}),
      }),
    });
  },
  /** ADR-001：前实例化开局——建会话，不建世界。 */
  createOpening(input: {
    templateId: string;
    templateVersion?: string;
    playerName?: string;
    seed?: number;
  }) {
    if (localEngine?.hasTemplate(input.templateId, input.templateVersion)) {
      const local = localEngine.createOpening(input);
      return Promise.resolve(local as Awaited<ReturnType<typeof request<{ sessionId: string; seed: number; node: OpeningNodeView | null }>>>);
    }
    return request<{ sessionId: string; seed: number; node: OpeningNodeView | null }>("/api/openings", {
      method: "POST",
      body: JSON.stringify({
        templateId: input.templateId,
        ...(input.templateVersion !== undefined ? { templateVersion: input.templateVersion } : {}),
        ...(input.playerName !== undefined ? { playerName: input.playerName } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      }),
    });
  },
  stepOpening(sessionId: string, step: OpeningStepInput) {
    if (localEngine !== null && sessionId.startsWith("local-open-")) {
      return Promise.resolve(localEngine.stepOpening(sessionId, step) as unknown as OpeningStepResponse);
    }
    return request<OpeningStepResponse>(`/api/openings/${sessionId}/step`, {
      method: "POST",
      body: JSON.stringify(step),
    });
  },
  /**
   * 开局完成才一次建世界；返回快照供最终面板展示。
   *
   * `prologue`（2026-11-19）：按开局档案写的开场白。服务端已把它同时写进历史第一条，
   * 这里只用于「开局结果页」当场显示——进入世界后故事区的第一条就是它。
   * `prologueSource === "template"` 表示模型没参与（没配 key / 超时 / 输出不合规）。
   */
  commitOpening(sessionId: string) {
    if (localEngine !== null && sessionId.startsWith("local-open-")) {
      return localEngine.commitOpening(sessionId) as Promise<{
        worldId: string;
        snapshot: WorldSnapshot;
        gains?: TurnGain[];
        prologue?: string;
        prologueSource?: "llm" | "template";
      }>;
    }
    return request<{
      worldId: string;
      snapshot: WorldSnapshot;
      gains?: TurnGain[];
      prologue?: string;
      prologueSource?: "llm" | "template";
    }>(`/api/openings/${sessionId}/commit`, { method: "POST" });
  },
  /** 开局后改名：只写权威 self 实体，不推进时间。 */
  renameWorld(id: string, name: string) {
    if (localEngine?.owns(id)) {
      return localEngine.renameWorld(id, name) as ReturnType<typeof request<{ worldId: string; snapshot: WorldSnapshot }>>;
    }
    return request<{ worldId: string; snapshot: WorldSnapshot }>(`/api/worlds/${id}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
  getWorld(id: string) {
    if (localEngine?.owns(id)) {
      return Promise.resolve(
        localEngine.getWorld(id) as unknown as Awaited<
          ReturnType<typeof request<{ worldId: string; snapshot: WorldSnapshot; eventFlavors?: EventFlavorMap }>>
        >,
      );
    }
    return request<{ worldId: string; snapshot: WorldSnapshot; eventFlavors?: EventFlavorMap }>(`/api/worlds/${id}`);
  },
  advanceTurn(id: string, action: { type: string; description: string }, endLife = false) {
    if (localEngine?.owns(id)) {
      return localEngine.advanceTurn(id, action, endLife) as Promise<TurnResponse>;
    }
    return request<TurnResponse>(`/api/worlds/${id}/turns`, {
      method: "POST",
      body: JSON.stringify({ action, mode: "single", ...(endLife ? { endLife: true } : {}) }),
    });
  },
  /**
   * 显式「确认转盘」：无请求体。语义从路由即可看出，不再依赖 `action.type` 魔法串。
   * 没有待确认的转盘时服务端回 409 `no_pending_wheel`。
   */
  confirmWheel(id: string) {
    if (localEngine?.owns(id)) return localEngine.confirmWheel(id) as Promise<TurnResponse>;
    return request<TurnResponse>(`/api/worlds/${id}/wheels/confirm`, { method: "POST" });
  },
  chooseOption(id: string, optionId: string) {
    if (localEngine?.owns(id)) return localEngine.chooseOption(id, optionId) as Promise<InteractionResponse>;
    return request<InteractionResponse>(`/api/worlds/${id}/events/choose`, {
      method: "POST",
      body: JSON.stringify({ optionId }),
    });
  },
  battleAction(id: string, command: BattleCommand) {
    if (localEngine?.owns(id)) return localEngine.battleAction(id, command) as Promise<InteractionResponse>;
    return request<InteractionResponse>(`/api/worlds/${id}/battle`, {
      method: "POST",
      body: JSON.stringify(command),
    });
  },
  /**
   * 世界内加点（ADR-019）：**轮外**提交，不推进回合。
   * `allocationId` 原样带回，防止旧页面把点数提交到另一笔请求上。
   */
  submitAllocation(id: string, allocationId: string, points: Record<string, number>) {
    if (localEngine?.owns(id)) {
      return localEngine.submitAllocation(id, allocationId, points) as Promise<{
        worldId: string;
        snapshot: WorldSnapshot;
        spent: number;
      }>;
    }
    return request<{ worldId: string; snapshot: WorldSnapshot; spent: number }>(
      `/api/worlds/${id}/allocation`,
      { method: "POST", body: JSON.stringify({ allocationId, points }) },
    );
  },
  useItem(id: string, itemId: string) {
    if (localEngine?.owns(id)) return localEngine.useItem(id, itemId) as Promise<InteractionResponse>;
    return request<InteractionResponse>(`/api/worlds/${id}/items/use`, {
      method: "POST",
      body: JSON.stringify({ itemId }),
    });
  },
  /**
   * 归档封存：仅已终止世界可封存，返回五类归档数据。
   * 响应里的 `archive.snapshot` 已带 evaluation（含五维分项），页面据此刷新即可。
   */
  archiveWorld(id: string) {
    // 本地局的归档 = 置 archived + 投影 + 落库；服务端根本不知道这局。
    if (localEngine?.owns(id)) return localEngine.archiveWorld(id) as Promise<ArchiveResponse>;
    return request<ArchiveResponse>(`/api/worlds/${id}/archive`, { method: "POST" });
  },
  history(id: string) {
    /**
     * 本地局的历史在存档里（`state.history`，只给 public）。
     *
     * 这是「服务端退场」最容易漏的一处：记录页每次切进来都拉一次，
     * 漏了就是每点一次「记录」一个 `world_not_found`（2026-11-22 用户实测）。
     */
    if (localEngine?.owns(id)) {
      return Promise.resolve(localEngine.history(id) as { history: HistoryEntryV2[] });
    }
    return request<{ history: HistoryEntryV2[] }>(
      `/api/worlds/${id}/history`,
    ).then((res) => ({
      // 前端防线：不依赖后端过滤正确性（R-VS-02 / design 文件清单「日志过滤」）。
      // 与 shared 的 isPlayerVisible 同语义（缺省视为 public）；本地实现避免把 shared
      // 的 zod schema 打进 bundle。判定口径变更时须同步协议 §21.1。
      history: res.history.filter((entry) => (entry.visibility ?? "public") === "public"),
    }));
  },
};

/**
 * 事件展示文案解析（R2.7 / T-S3 / R-NAR-03）。
 *
 * 优先取服务端异步生成并已校验的 flavor；`flavors` 为 `undefined` / `{}` / 无该 id /
 * 值为空串时，一律回退模板文案 `event.narrative` —— 即「字段缺失 = 与改前逐字相同」。
 * 纯函数、零副作用：flavors 只是当次渲染的非权威展示数据，不缓存、不落库、不进 localStorage。
 */
export function resolveEventNarrative(
  event: { id: string; narrative: string },
  flavors?: EventFlavorMap,
): string {
  const flavor = flavors?.[event.id];
  return flavor !== undefined && flavor !== "" ? flavor : event.narrative;
}

/**
 * 合并两次响应的事件 flavor（R2.7 / T-S3：GET / 409 刷新路径补齐）。
 *
 * flavor 是 fire-and-forget 产物，常到「下一轮 / 刷新」才出现，所以要把后续响应
 * 带回的键**补进**既有 map，而不是整体替换。规则：
 *  - `next` 为 `undefined` / `{}` / 只含空串 ⇒ 原样返回 `prev`（**同一引用**，
 *    调用方据此跳过 setState ⇒ 字段缺失时 UI 与改前逐字一致、且不多一次重渲染）；
 *  - 否则新值覆盖同键旧值、保留旧键；空串是无效值（与 `resolveEventNarrative`
 *    同语义），不写入、也不覆盖已有的有效文案，避免回退响应把 LLM 文案抹掉。
 * 纯函数：不修改入参。
 */
export function mergeEventFlavors(
  prev: EventFlavorMap | undefined,
  next: EventFlavorMap | undefined,
): EventFlavorMap | undefined {
  if (next === undefined) return prev;
  const valid = Object.entries(next).filter(([, text]) => text !== "");
  if (valid.length === 0) return prev;
  return { ...(prev ?? {}), ...Object.fromEntries(valid) };
}

/**
 * 叙事正文读回（T-07 / F3）：正文只存于服务端 append-only `<worldId>.trace.jsonl`，
 * **不进存档**，所以刷新页面后必须重新拉一次才能继续显示 AI 叙事。
 *
 * 端点：`GET /api/worlds/:id/narrative?fromTurn=<n>`。响应形状按 `{ blocks }` 收敛中，
 * 这里做三层防御，任何意外都退化成「没有叙事」而**不打断游戏主链路**：
 *  ① 裸数组也接受（过渡期的服务端实现）；
 *  ② 只保留 `narrative / option / flavor` 三类玩家可见块，hidden 块一律丢弃
 *    （服务端已按窗口过滤，前端再兜一层，绝不把隐藏文案上屏）；
 *  ③ 缺 `blockId` / `kind` 的脏行跳过，重复 blockId 去重（trace 可能被重复追加）。
 */
const NARRATIVE_KINDS: ReadonlySet<string> = new Set(["narrative", "option", "flavor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNarrativeBlock(item: unknown): ContentBlockVM | null {
  if (!isRecord(item)) return null;
  if (item.visibility === "hidden") return null;
  const blockId = item.blockId;
  const kind = item.kind;
  if (typeof blockId !== "string" || blockId === "") return null;
  if (typeof kind !== "string" || !NARRATIVE_KINDS.has(kind)) return null;
  const text = typeof item.text === "string" ? item.text : undefined;
  return text === undefined ? { blockId, kind } : { blockId, kind, text };
}

export async function fetchNarrative(worldId: string, fromTurn = 0): Promise<ContentBlockVM[]> {
  // 本地世界没有服务端 trace：正文由本地会话给（模板兜底 / 网关正文）。
  if (localEngine?.owns(worldId)) return localEngine.narrative(worldId).blocks;
  let res: unknown;
  try {
    res = await request<unknown>(`/api/worlds/${worldId}/narrative?fromTurn=${fromTurn}`);
  } catch {
    // 旧服务端没有该端点 / 网络抖动：叙事区空着即可，不影响回合推进与存档。
    return [];
  }
  const raw: unknown[] = Array.isArray(res)
    ? res
    : isRecord(res) && Array.isArray(res.blocks)
      ? res.blocks
      : [];
  const blocks: ContentBlockVM[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const block = toNarrativeBlock(item);
    if (block === null || seen.has(block.blockId)) continue;
    seen.add(block.blockId);
    blocks.push(block);
  }
  return blocks;
}

export interface NarrativeStreamDone {
  outcome: "committed" | "fallback";
  traceRef: string;
  diagnostics: string[];
}

/**
 * 订阅叙事实时增量（`POST /api/worlds/:id/narrative/stream`，SSE）。
 *
 * 只负责把 `delta` / `done` / `idle` 事件翻译成回调，不碰正式块；收尾后由调用方
 * 用 `fetchNarrative` 拉正式块替换草稿。客户端断开（AbortSignal）按静默结束处理。
 *
 * 注意：服务端 `turn` 路由在锁内 `await` LLM，所以本函数应在发起 turn 的同时（而不是
 * `await turn` 之后）调用；晚订阅仍能收到频道保留的整段正文（单帧 delta + done）。
 */
export async function streamNarrative(
  worldId: string,
  handlers: {
    onDelta: (text: string) => void;
    onDone: (done: NarrativeStreamDone) => void;
    onIdle?: () => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (llmSessionId !== null) headers["x-life-sim-llm-session"] = llmSessionId;
  // `?next=1`：告诉服务端「订阅的是马上要发的那一轮」，别把频道里上一轮的正文当成本轮补发。
  const res = await fetch(`${BASE}/api/worlds/${worldId}/narrative/stream?next=1`, {
    method: "POST",
    headers,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok || res.body === null) {
    handlers.onIdle?.();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue; // event: / id: / retry: / ": ping" 一律忽略
          const data = line.slice("data:".length).trim();
          if (data.length === 0 || data === "[DONE]") continue;
          let event: unknown;
          try {
            event = JSON.parse(data) as unknown;
          } catch {
            continue;
          }
          if (!isRecord(event)) continue;
          if (event.type === "delta" && typeof event.text === "string") {
            handlers.onDelta(event.text);
          } else if (event.type === "done") {
            handlers.onDone({
              outcome: event.outcome === "fallback" ? "fallback" : "committed",
              traceRef: typeof event.traceRef === "string" ? event.traceRef : "",
              diagnostics: Array.isArray(event.diagnostics)
                ? event.diagnostics.filter((d): d is string => typeof d === "string")
                : [],
            });
          } else if (event.type === "idle") {
            handlers.onIdle?.();
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") return;
    throw error;
  }
}

export type { V2Snapshot, BattleCommand, WheelResultView, SlotEventView, EndingView };
