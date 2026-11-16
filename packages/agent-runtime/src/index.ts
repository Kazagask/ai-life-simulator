/**
 * @life-sim/agent-runtime：LLM 编排层（T-03 / T-04 / T-05b）。
 *
 * 本包只做「上下文组装 → 工具调用循环 → dispatch 回执」；权威状态与可见性窗口都在
 * @life-sim/game-core，叙事正文只进 LlmTrace。禁止 import apps/server（源码守卫断言）。
 */
export const AGENT_RUNTIME_VERSION = "0.2.0" as const;

export {
  buildLlmContext,
  buildStablePrefix,
  sha256,
  stableStringify,
  OUTPUT_CONTRACT,
} from "./context.js";
export type { BuiltLlmContext, LlmContextDeps } from "./context.js";

export {
  ALL_TOOL_NAMES,
  CONTENT_TOOL_NAMES_ALL,
  CONTROL_TOOL_NAMES,
  buildToolDescriptors,
  resolveToolNames,
  toApiCall,
  unknownProfileTools,
  validateToolCall,
} from "./tool-registry.js";
export type {
  AgentChatRequest,
  AgentCompletion,
  AgentMessage,
  AgentProvider,
  AgentStreamDelta,
  ArgValidation,
  ToolCallRequest,
} from "./tool-registry.js";

export { runAgentLoop, traceRefFor } from "./loop.js";
export type { AgentLoopDeps, LoopEndReason } from "./loop.js";

export { AgentGateway } from "./gateway.js";
export type { AgentGatewayDeps } from "./gateway.js";

export {
  AgentProviderError,
  MockAgentProvider,
  OpenAiCompatibleProvider,
  createAgentProvider,
} from "./providers/index.js";
export type { CreateAgentProviderOptions, OpenAiCompatibleOptions } from "./providers/index.js";

export type {
  ApiCall,
  FactCall,
  ContentCall,
  CallReceipt,
  DiagnosticCode,
  DispatchContext,
  DispatchResult,
  EngineApiHandle,
  LlmInvocation,
  LlmOutcome,
  LlmBudget,
  LlmGateway,
  ToolDescriptor,
  Perspective,
  ObserverId,
  PerspectiveFactView,
  KnowledgeEntry,
  ObservationLedger,
  LlmTrace,
  ContentBlock,
  AssetManifest,
  RulesTemplate,
  ViewModel,
} from "@life-sim/shared";
