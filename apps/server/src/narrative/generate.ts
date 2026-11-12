import {
  validateNarrativeOutput,
  type NarrativeAdapter,
  type NarrativeInput,
  type NarrativeOutputSchemaLike,
} from "@life-sim/game-core";
import type { V2Snapshot } from "@life-sim/shared";
import { isTimeoutLike, LLMTimeoutError } from "../llm/errors.js";
import type { LLMProvider } from "../llm/provider.js";

/**
 * R2.7 · 服务端叙事编排（R-LLM-04 / R-NAR-01 / R-NAR-02 / 主理人裁决 2、3、6）。
 *
 * 关键边界：LLM 只产出**待校验候选**；结构校验（strict Zod + 证据白名单）在 game-core 的
 * `validateNarrativeOutput` 单一事实来源完成。任何失败都转成 `fallback` + 可诊断 diagnostic，
 * 绝不抛到玩法管线、绝不写权威状态、绝不参与评分 / 事件触发 / 结局判定。
 */

export interface NarrativeOutcome {
  source: "template" | "llm" | "fallback";
  /** 已校验候选（仅 source="llm" 时有效）；template/fallback 恒为 null。 */
  data: unknown;
  /** 回退原因；正常路径为 null。绝不写进 WorldStateV2 / strict schema。 */
  diagnostic: string | null;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * ① `mock` 直接短路为 template（**不调 complete**：零回归、零延迟）——主理人裁决 2；
 * ② 其余 provider 调 `complete`，并额外用 `Promise.race` 兜底超时（provider 忽略 opts 也不会挂住管线）；
 * ③ `validateNarrativeOutput` 区分 `invalid_schema` / `fabricated_evidence` 两种 diagnostic；
 * ④ 抛错 / 超时区分「超时」与「不可用」两种文案，一律回退，异常绝不外泄。
 */
export async function generateNarrative(
  request: NarrativeInput,
  schema: NarrativeOutputSchemaLike,
  provider: LLMProvider,
  opts?: { timeoutMs?: number },
): Promise<NarrativeOutcome> {
  if (provider.id === "mock") {
    return { source: "template", data: null, diagnostic: null };
  }
  const timeoutMs = opts?.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LLMTimeoutError(`LLM 生成超过 ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const candidate = await Promise.race([
      provider.complete(request, schema, { timeoutMs }),
      guard,
    ]);
    const allowedEvidenceIds = "allowedEvidenceIds" in request ? request.allowedEvidenceIds : [];
    const checked = validateNarrativeOutput(schema, candidate, allowedEvidenceIds);
    if (!checked.ok) {
      const diagnostic =
        checked.reason === "invalid_schema"
          ? "叙事输出未通过结构校验（invalid_schema）"
          : "叙事引用了未在本局发生的证据（fabricated_evidence）";
      return { source: "fallback", data: null, diagnostic };
    }
    return { source: "llm", data: checked.data, diagnostic: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const diagnostic = isTimeoutLike(err)
      ? `LLM 生成超时或不可用[超时]：${message}`
      : `LLM 生成超时或不可用[不可用]：${message}`;
    return { source: "fallback", data: null, diagnostic };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 同步 / 异步桥：把异步 outcome 转成 game-core 既有的同步 `NarrativeAdapter`。
 * - template ⇒ `undefined`（`resolveEnding` / `finalizeEvaluationSummary` 无 adapter ⇒ 来源 template）；
 * - llm ⇒ 返回已校验候选，交由既有 strict Zod 二次确认；
 * - fallback ⇒ 抛错，借用既有 `resolveEndingNarrative` / `organizeEvaluationSummary` 的 catch 分支
 *   产出 `narrativeSource` / `summarySource === "fallback"` 并保留 diagnostic，**不改 game-core 同步签名**。
 */
export function adapterFromOutcome(outcome: NarrativeOutcome): NarrativeAdapter | undefined {
  if (outcome.source === "template") return undefined;
  if (outcome.source === "llm") return () => outcome.data;
  return () => {
    throw new Error(outcome.diagnostic ?? "llm_fallback");
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * **响应层装饰**（主理人裁决 3）：`narrativeSource:"llm"` 的玩家可见准绳。
 * 纯函数、不改 `V2Snapshot` 类型、不改 `projectSnapshotV2`、不写 state。
 *
 * 🔴 隐藏结局红线（裁决 6）：`snapshot.ending` 不存在或 `visibility === "hidden"` ⇒ **原样返回**，
 * 绝不把 hidden 原文交给 LLM 装饰；归档侧另有 `narrativeConfig.masked` 判定拦截 adapter 注入。
 * - template ⇒ 原样；
 * - llm ⇒ 覆盖 title / summary / narrativeSource（title/summary 做结构守卫，缺省保留模板值）；
 * - fallback ⇒ 只置 `narrativeSource:"fallback"`，**保留模板 title/summary**。
 */
export function decorateEndingView(snapshot: V2Snapshot, outcome: NarrativeOutcome): V2Snapshot {
  const ending = snapshot.ending;
  if (!ending || ending.visibility === "hidden") return snapshot;
  if (outcome.source === "template") return snapshot;
  if (outcome.source === "fallback") {
    return { ...snapshot, ending: { ...ending, narrativeSource: "fallback" } };
  }
  const data = asRecord(outcome.data);
  const rawTitle: unknown = data === null ? undefined : data.title;
  const rawSummary: unknown = data === null ? undefined : data.summary;
  const title = typeof rawTitle === "string" && rawTitle.length > 0 ? rawTitle : ending.title;
  const summary = typeof rawSummary === "string" && rawSummary.length > 0 ? rawSummary : ending.summary;
  return { ...snapshot, ending: { ...ending, title, summary, narrativeSource: "llm" } };
}
