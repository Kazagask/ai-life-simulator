import {
  LlmBudgetSchema,
  type EngineApiHandle,
  type LlmBudget,
  type LlmGateway,
  type LlmInvocation,
  type LlmOutcome,
  type LlmTrace,
  type RulesTemplate,
} from "@life-sim/shared";
import { buildLlmContext } from "./context.js";
import { runAgentLoop, traceRefFor } from "./loop.js";
import { buildToolDescriptors, type AgentProvider } from "./tool-registry.js";

/**
 * `LlmGateway` 实现：上下文组装 → agentic 循环 → trace 回调。
 *
 * 职责边界（硬约束）：
 * - **不写权威状态**：唯一写入路径在 loop 内的 `engineApi.dispatch`。
 * - **不落盘**：trace 由 `apps/server` 注入的 `onTrace` 同步追加；本类只负责调用。
 * - **绝不抛异常**：任何内部失败都折算成 `fallback` + `traceRef`。
 * - `traceRef` 由 `traceRefFor`（loop.ts）唯一生成，本文件不拼字符串。
 */

export interface AgentGatewayDeps {
  provider: AgentProvider;
  engineApi: EngineApiHandle;
  budget?: LlmBudget;
  templateRef?: string;
  /** 由 apps/server 提供：同步追加 trace 到 *.trace.jsonl。 */
  onTrace?: (trace: LlmTrace) => void;
  /** 滚动历史（上次调用方维护）；本类只取末尾 `budget.recentTurns` 条。 */
  history?: unknown[];
  /** 可选：能力画像来源；缺省用全量工具表面。 */
  rules?: RulesTemplate;
  toolProfile?: string;
  worldSkeleton?: string;
  secrets?: string[];
  /** 仅延迟测量可注入（测试确定性）。 */
  now?: () => number;
}

export class AgentGateway implements LlmGateway {
  private readonly deps: AgentGatewayDeps;
  /** 同一 invocationId 只允许进入一次（重入保护）。 */
  private readonly seen = new Set<string>();

  constructor(deps: AgentGatewayDeps) {
    this.deps = deps;
  }

  async invoke(inv: LlmInvocation): Promise<LlmOutcome> {
    if (this.seen.has(inv.invocationId)) {
      return {
        outcome: "fallback",
        invocationId: inv.invocationId,
        code: "duplicate_invocation",
        reason: "同一 invocationId 重复进入",
        traceRef: traceRefFor(inv.invocationId),
      };
    }
    this.seen.add(inv.invocationId);

    try {
      const budget = LlmBudgetSchema.parse(this.deps.budget ?? inv.budget);
      const tools =
        inv.tools.length > 0
          ? inv.tools
          : buildToolDescriptors(this.deps.rules, this.deps.toolProfile);

      const { context, contextHash } = buildLlmContext(
        { ...inv, tools, budget },
        {
          engineApi: this.deps.engineApi,
          ...(this.deps.rules !== undefined ? { rules: this.deps.rules } : {}),
          ...(this.deps.toolProfile !== undefined ? { toolProfile: this.deps.toolProfile } : {}),
          ...(this.deps.worldSkeleton !== undefined
            ? { worldSkeleton: this.deps.worldSkeleton }
            : this.deps.templateRef !== undefined
              ? { worldSkeleton: `模板：${this.deps.templateRef}` }
              : {}),
          ...(this.deps.history !== undefined ? { history: this.deps.history } : {}),
          ...(this.deps.secrets !== undefined ? { secrets: this.deps.secrets } : {}),
        },
      );

      const enriched: LlmInvocation = { ...inv, tools, budget, context };
      const { outcome, trace } = await runAgentLoop(enriched, {
        provider: this.deps.provider,
        engineApi: this.deps.engineApi,
        budget,
        ...(this.deps.templateRef !== undefined ? { templateRef: this.deps.templateRef } : {}),
        ...(this.deps.toolProfile !== undefined ? { toolProfile: this.deps.toolProfile } : {}),
        contextHash,
        ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
      });

      this.emitTrace(trace);
      return outcome;
    } catch (err) {
      // 兜底：任何未被 loop 吸收的异常都折算成 fallback，绝不外抛。
      return {
        outcome: "fallback",
        invocationId: inv.invocationId,
        code: "provider_unavailable",
        reason: err instanceof Error ? err.message : String(err),
        traceRef: traceRefFor(inv.invocationId),
      };
    }
  }

  /** trace 回调必须在返回前完成；回调自身失败只记诊断，不外抛。 */
  private emitTrace(trace: LlmTrace): void {
    if (this.deps.onTrace === undefined) return;
    try {
      this.deps.onTrace(trace);
    } catch {
      if (!trace.diagnostics.includes("provider_unavailable")) {
        trace.diagnostics.push("provider_unavailable");
      }
    }
  }
}
