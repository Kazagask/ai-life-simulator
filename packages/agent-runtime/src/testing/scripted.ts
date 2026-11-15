import type {
  AgentChatRequest,
  AgentCompletion,
  AgentProvider,
  ToolCallRequest,
} from "../tool-registry.js";

/** 纯测试用脚本 provider：按步回放（最后一步重复），并记录每次请求。 */
export type ScriptStep =
  | AgentCompletion
  | Error
  | ((req: AgentChatRequest) => AgentCompletion);

export class ScriptedProvider implements AgentProvider {
  readonly id = "mock" as const;
  readonly requests: AgentChatRequest[] = [];
  private readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.steps = steps;
  }

  get callCount(): number {
    return this.requests.length;
  }

  async chat(req: AgentChatRequest): Promise<AgentCompletion> {
    this.requests.push(req);
    const index = Math.min(this.requests.length - 1, this.steps.length - 1);
    const step = this.steps[index];
    if (step === undefined) throw new Error("ScriptedProvider 未配置任何步骤");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(req);
    return step;
  }
}

export const toolCall = (
  name: string,
  args: Record<string, unknown>,
  id?: string,
): ToolCallRequest => ({
  id: id ?? `call-${name}`,
  name,
  arguments: args,
});

export const completion = (
  toolCalls: ToolCallRequest[],
  extra?: Partial<AgentCompletion>,
): AgentCompletion => ({
  toolCalls,
  inputTokens: extra?.inputTokens ?? 10,
  outputTokens: extra?.outputTokens ?? 10,
  finishReason: extra?.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
  ...(extra?.text !== undefined ? { text: extra.text } : {}),
});

export const narrativeCall = (
  overrides?: { targetPerspective?: string; refs?: string[]; text?: string; blockId?: string },
): ToolCallRequest =>
  toolCall("content.writeNarrative", {
    blockId: overrides?.blockId ?? "blk-1",
    text: overrides?.text ?? "风穿过门廊，你听见远处的钟声。",
    refs: overrides?.refs ?? [],
    targetPerspective: overrides?.targetPerspective ?? "player",
  });

export const submitCall = (blockIds: string[] = ["blk-1"]): ToolCallRequest =>
  toolCall("content.submit", { blockIds });
