import { cloud } from "./cloud";

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

let cachedModelId: string | null = null;

/** 选一个可用模型（未禁用）；空列表 / 全禁用 / 不可达 ⇒ null。 */
async function pickModelId(): Promise<string | null> {
  if (cachedModelId !== null) return cachedModelId;
  const models = await cloud.llm.models.list();
  const usable = models.find((m) => m.disabled !== true);
  if (!usable) return null;
  cachedModelId = usable.id;
  return usable.id;
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
