import { cloud, publicConfig } from "./cloud";

/**
 * 前端「平台免密 LLM」回调（R-LLM-09 / ADR-0028 决策 2 的前端路径）。
 *
 * 平台免密钥 LLM（`cloud.llm`）只以**客户端 SDK**形态提供：`publishableKey` + 同源 Origin
 * 精确匹配。服务端无法合法直连（平台明令禁止「BFF / Node 代理」与「手拼 `/.cloud/llm/*`」），
 * 所以平台免密只能落在浏览器侧。交互约定（用户裁决）：
 *
 *  - **后端出得了 LLM 叙事**（用户自带 key / 服务端 session）⇒ 后端出，前端不重复；
 *  - **后端没出**（回退模板）⇒ 由前端调用本回调补一次；
 *  - **前端也用不了**（未部署在云环境 / 无可用模型 / 流中断 / 超时）⇒ 返回 `null`，
 *    调用方自然回退模板文案（mock），**绝不假装成功**。
 *
 * 纯展示层：不写世界状态、不进回放、不落库、不进人生档案。任何失败一律 `null`。
 */
const DEFAULT_TIMEOUT_MS = 12000;

/**
 * 平台 endpoint（**单一真源**：直接取 `cloud.ts` 的字面量，绝不复制第二份）。
 *
 * SDK 的 LLM 模块把请求拼成 `${endpoint}/.cloud/llm/...`（不是相对路径），所以只要页面
 * origin 与该 endpoint 不一致，浏览器就会按跨域处理：自定义头 `x-wb-webapp-access-key`
 * 会让每次调用先发 `OPTIONS`，而平台契约是「同源 Origin 精确匹配」，非发布域名拿不到
 * `Access-Control-Allow-Origin` ⇒ preflight `net::ERR_FAILED`，控制台只剩一条 CORS 报错。
 * 这不是可修复的工程 bug，而是「平台免密只在它自己的域名下成立」这一事实。
 */
const PLATFORM_ENDPOINT = publicConfig.endpoint;

export interface PlatformLlmAvailability {
  available: boolean;
  origin: string | null;
  endpoint: string;
}

/**
 * 平台免密路径是否**在当前页面**可用。
 *
 * 判据只有一条：页面 origin 与平台 endpoint 相同。**不要**把它与「用户已自带 key」合并——
 * 那是两个独立原因（域名不对 / 已有服务端会话），合并后部署域名一旦改对就再也拆不开。
 */
export function platformLlmAvailability(): PlatformLlmAvailability {
  const origin = typeof window === "undefined" ? null : window.location.origin;
  return { available: origin !== null && origin === PLATFORM_ENDPOINT, origin, endpoint: PLATFORM_ENDPOINT };
}

/** 不可用只提示一次（每次渲染都 warn 会刷屏，且这属于预期配置而非故障）。 */
let availabilityWarned = false;

export function isPlatformLlmAvailable(): boolean {
  const { available, origin } = platformLlmAvailability();
  if (!available && !availabilityWarned && origin !== null) {
    availabilityWarned = true;
    console.warn(
      `[platformLlm] 平台免密 LLM 已关闭：当前 origin ${origin} 与平台 endpoint ${PLATFORM_ENDPOINT} 不一致；` +
        "叙事回退模板文案（这是预期行为，不是故障）。",
    );
  }
  return available;
}

let modelIdPromise: Promise<string | null> | null = null;

/**
 * 选一个可用模型（未禁用）；空列表 / 全禁用 / 不可达 ⇒ null。
 *
 * 缓存的是 **promise** 而不是结果：结局叙事与人生总结会在首屏并发调用，
 * 只缓存结果的话两个调用会同时穿透去打两次 `GET /models`。失败 / 无模型
 * 一律不缓存，后续调用可以重试（避免一次抖动把整局钉死在模板上）。
 */
function pickModelId(): Promise<string | null> {
  if (modelIdPromise !== null) return modelIdPromise;
  const task = cloud.llm.models
    .list()
    .then((models) => models.find((m) => m.disabled !== true)?.id ?? null)
    .catch(() => null);
  modelIdPromise = task;
  void task.then((id) => {
    if (id === null) modelIdPromise = null;
  });
  return task;
}

/**
 * 通用回调：用平台免密 LLM 生成纯文本。`system` 必须是消息首条（SDK 要求）。
 * 任何失败返回 `null`（调用方据此回退模板）。
 */
export async function platformGenerateText(
  system: string,
  user: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  // 第一行就挡在**任何**网络之前：下面 `pickModelId()` 与 `chat.completions.create()`
  // 都是绝对地址请求，非同源时两次都会被 CORS 拒掉（且只会留下扰人的控制台红字）。
  if (!isPlatformLlmAvailable()) return null;
  try {
    const model = await pickModelId();
    if (model === null) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      let text = "";
      // 平台仅支持 streaming（stream:true 必填，非流式会被拒）。
      for await (const chunk of cloud.llm.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: true,
        signal: controller.signal,
      })) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) text += delta;
      }
      const trimmed = text.trim();
      return trimmed === "" ? null : trimmed;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 未配置 / 无模型 / 超时 / 流中断 / 配额 / Origin 不符 ⇒ 自然降级 mock（模板）
    return null;
  }
}

/**
 * 事件 flavor 回调：把模板事件改写为 1-2 句沉浸式旁白（纯文本，非 JSON）。
 * 失败返回 `null`，调用方保持模板文案。
 */
export async function platformEventFlavor(title: string, narrative: string): Promise<string | null> {
  const system =
    "你是一名中文叙事润色器。把给定事件改写成 1 到 2 句沉浸式、第三人称的旁白，保留全部事实，不新增设定、不评价、不输出标题或解释，只输出正文。";
  const user = `事件标题：${title}\n事件原文：${narrative}`;
  return platformGenerateText(system, user);
}

// ---------- 结局叙事 / 人生总结（一次性，成功即缓存，避免重复烧 token） ----------

export interface EndingNarrative {
  title: string;
  summary: string;
}

const endingCache = new Map<string, EndingNarrative>();
const summaryCache = new Map<string, string>();
/** 同一输入的并发请求合并（多个组件同时挂载时只烧一次 token）。 */
const endingInFlight = new Map<string, Promise<EndingNarrative | null>>();
const summaryInFlight = new Map<string, Promise<string | null>>();

/** 去掉 ```json 代码块围栏后再解析。 */
function stripFences(s: string): string {
  const t = s.trim();
  if (!t.startsWith("```")) return t;
  return t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
}

/**
 * 结局叙事回调：基于服务端模板结局，生成更沉浸的 `{title, summary}`（严格 JSON）。
 * 失败 / 解析失败 / 字段缺失 ⇒ `null`（调用方保持模板结局）。成功结果按输入缓存。
 */
export async function platformEndingNarrative(input: {
  title: string;
  summary: string;
  source: string;
}): Promise<EndingNarrative | null> {
  const key = `${input.title}\u0000${input.summary}\u0000${input.source}`;
  const cached = endingCache.get(key);
  if (cached) return cached;
  const running = endingInFlight.get(key);
  if (running) return running;
  const task = (async (): Promise<EndingNarrative | null> => {
    const system =
      '你是一名中文结局旁白润色器。基于给定结局，输出严格 JSON：{"title": string, "summary": string}。只输出 JSON，不要代码块、不要任何其它文字。title 不超过 20 字，summary 2-3 句；保留全部事实与结局基调，不新增设定。';
    const user = `结局标题：${input.title}\n结局原文：${input.summary}\n触发方式：${input.source}`;
    const raw = await platformGenerateText(system, user);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(stripFences(raw)) as { title?: unknown; summary?: unknown };
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (!title || !summary) return null;
      const result = { title, summary };
      endingCache.set(key, result);
      return result;
    } catch {
      return null;
    }
  })().finally(() => {
    endingInFlight.delete(key);
  });
  endingInFlight.set(key, task);
  return task;
}

/**
 * 人生总结回调：基于服务端评价总结，生成 2-3 句更有文学感的第三人称总结。
 * 失败 ⇒ `null`（调用方保持模板总结）。不改分数、不新增事实；成功结果按输入缓存。
 */
export async function platformEvaluationSummary(summary: string): Promise<string | null> {
  const cached = summaryCache.get(summary);
  if (cached) return cached;
  const running = summaryInFlight.get(summary);
  if (running) return running;
  const task = (async (): Promise<string | null> => {
    const system =
      "你是一名中文人生总结润色器。基于给定评价总结，写 2-3 句更有文学感的第三人称总结；保留全部事实与评价语义，不新增设定、不改分数、不输出解释，只输出正文。";
    const user = `人生总结：${summary}`;
    const text = await platformGenerateText(system, user);
    if (text) summaryCache.set(summary, text);
    return text;
  })().finally(() => {
    summaryInFlight.delete(summary);
  });
  summaryInFlight.set(summary, task);
  return task;
}
