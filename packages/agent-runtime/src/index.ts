/**
 * Wave 1A 占位：dispatch 执行体 / 窗口计算逻辑在 Wave 1B 实现。
 * 本波只回重新契约类型，供后续 agent-runtime 写者直接引用（窗口计算归 game-core 引擎 API 所有）。
 */
export const AGENT_RUNTIME_VERSION = "0.1.0" as const;

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
  TaskDag,
  TaskNode,
  LlmTrace,
  ContentBlock,
  AssetManifest,
  RulesTemplate,
  ViewModel,
} from "@life-sim/shared";
