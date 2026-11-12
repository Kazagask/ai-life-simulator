import type { NarrativeInput, NarrativeOutputSchemaLike } from "@life-sim/game-core";
import type { LLMProvider } from "./provider.js";

/**
 * R2.7 · 确定性 Mock（R-LLM-02 / R-LLM-06）：零随机、零网络、零延迟。
 *
 * 生产默认路由在 `generateNarrative` 见 `provider.id === "mock"` 时**直接短路为 template**、
 * 根本不调用 `complete`（零回归、零延迟）。本实现保留给单测 / 显式注入使用：
 * 以 schema 探针判形，返回满足对应 strict 契约的确定性合法候选。
 */
export class MockProvider implements LLMProvider {
  readonly id = "mock" as const;

  async complete(request: NarrativeInput, schema: NarrativeOutputSchemaLike): Promise<unknown> {
    const shape = detectOutputShape(schema);
    if (shape === "flavor") {
      const narrative = "narrative" in request ? request.narrative : "";
      const title = "title" in request ? request.title : "";
      return { flavor: narrative.length > 0 ? narrative : title.length > 0 ? title : "事件" };
    }
    if (shape === "ending") {
      const title = "templateTitle" in request ? request.templateTitle : "";
      const summary = "templateSummary" in request ? request.templateSummary : "";
      return {
        title: title.length > 0 ? title : "旅程收束",
        summary: summary.length > 0 ? summary : "本局到此结束。",
        evidenceIds: [],
      };
    }
    const summary = "templateSummary" in request ? request.templateSummary : "";
    return { summary: summary.length > 0 ? summary : "本局到此结束。" };
  }
}

type OutputShape = "flavor" | "ending" | "summary";

/**
 * 只用 `NarrativeOutputSchemaLike.safeParse` 探针判形，不 import zod、不做类型强转：
 * strict schema 只接受自身形状，故探针结果互不相同、完全确定性。
 */
function detectOutputShape(schema: NarrativeOutputSchemaLike): OutputShape {
  if (schema.safeParse({ flavor: "__probe__" }).success) return "flavor";
  if (schema.safeParse({ title: "__probe__", summary: "__probe__", evidenceIds: [] }).success) return "ending";
  return "summary";
}
