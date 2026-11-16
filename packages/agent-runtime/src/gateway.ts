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
import { buildToolDescriptors, type AgentProvider, type AgentStreamDelta } from "./tool-registry.js";

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
  /**
   * 可选：正文增量透传（提供 ⇒ provider 走流式；缺省 ⇒ 完整响应，零行为变化）。
   * 纯展示通道：不写 trace、不写 sink、不写 state；trace 仍在收尾一次性 emit。
   */
  onDelta?: (chunk: AgentStreamDelta) => void;
  /** 可选：外部取消信号（客户端断开），原样透传给 `provider.chat`。 */
  signal?: AbortSignal;
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
      const profile = this.deps.toolProfile ?? inv.toolProfile;
      /**
       * 工具表必须由**本包**用画像重建，不能信 `inv.tools`。
       *
       * core 只给工具名（`{ name }`，没有 parameters）；描述符里的参数 schema 只有
       * `buildToolDescriptors` 知道。曾经的写法是 `inv.tools.length > 0 ? inv.tools : ...`，
       * 而 core 永远会填 `inv.tools` ⇒ 描述符分支永远走不到 ⇒ 模型收到一堆
       * `parameters: {}` 的工具，只能瞎猜参数（实测 glm-5.3 发空对象、整轮作废）。
       */
      const described = buildToolDescriptors(this.deps.rules, profile);
      const tools = described.length > 0 ? described : inv.tools;

      const { context, contextHash } = buildLlmContext(
        { ...inv, tools, budget },
        {
          engineApi: this.deps.engineApi,
          ...(this.deps.rules !== undefined ? { rules: this.deps.rules } : {}),
          ...(profile !== undefined ? { toolProfile: profile } : {}),
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
        ...(profile !== undefined ? { toolProfile: profile } : {}),
        contextHash,
        ...(this.deps.onDelta !== undefined ? { onDelta: this.deps.onDelta } : {}),
        ...(this.deps.signal !== undefined ? { signal: this.deps.signal } : {}),
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
    } finally {
      /**
       * 「在飞」标记的兜底清除（正常路径已由 `agent.submit` 清）。
       *
       * 没有这一步，重试耗尽 / 超时 / provider 报错这类**不走 submit**的收场会让
       * 投影的 `llmPending` 永久为真 —— 前端「AI 书写中…」再也不熄。
       * 只清自己这一次：实现按 `invocationId` 比对，玩家已推进到下一轮时不会误清。
       */
      this.deps.engineApi.clearPending?.(inv.invocationId);
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
