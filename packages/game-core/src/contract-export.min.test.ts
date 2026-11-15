import { describe, expect, it } from "vitest";
import {
  // value exports (schemas / constants / helper)
  FactCallSchema,
  ContentCallSchema,
  ApiCallSchema,
  DiagnosticCodeSchema,
  CallReceiptSchema,
  DispatchContextSchema,
  DIAGNOSTIC_CODES,
  ObserverIdSchema,
  PerspectiveSchema,
  KnowledgeEntrySchema,
  ObservationLedgerSchema,
  PerspectiveFactViewSchema,
  SetKnowledgeArgsSchema,
  TaskConditionSchema,
  TaskNodeSchema,
  TaskDagSchema,
  LlmBudgetSchema,
  ToolDescriptorSchema,
  LlmInvocationSchema,
  LlmOutcomeSchema,
  LlmTraceSchema,
  CallLogEntrySchema,
  ContentBlockSchema,
  AssetDescriptorSchema,
  AssetManifestSchema,
  RulesSchema,
  RulesTemplateSchema,
  ViewModelSchema,
  PlayerVMSchema,
  SlotSceneVMSchema,
  EvaluationVMSchema,
  MediaVMSchema,
  ContentBlockVMSchema,
  NpcVMSchema,
  eventNarrativeOrTitle,
  // type exports
  type ApiCall,
  type FactCall,
  type ContentCall,
  type CallReceipt,
  type DiagnosticCode,
  type DispatchContext,
  type DispatchResult,
  type EngineApiHandle,
  type Perspective,
  type ObserverId,
  type PerspectiveFactView,
  type KnowledgeEntry,
  type ObservationLedger,
  type TaskDag,
  type TaskNode,
  type LlmInvocation,
  type LlmOutcome,
  type LlmBudget,
  type LlmGateway,
  type LlmTrace,
  type ContentBlock,
  type AssetManifest,
  type RulesTemplate,
  type ViewModel,
} from "@life-sim/shared";

/** 把所有新契约类型收进一个联合，编译期即验证「可从 @life-sim/shared import」。 */
type AllContractTypes =
  | ApiCall
  | FactCall
  | ContentCall
  | CallReceipt
  | DiagnosticCode
  | DispatchContext
  | DispatchResult
  | EngineApiHandle
  | Perspective
  | ObserverId
  | PerspectiveFactView
  | KnowledgeEntry
  | ObservationLedger
  | TaskDag
  | TaskNode
  | LlmInvocation
  | LlmOutcome
  | LlmBudget
  | LlmGateway
  | LlmTrace
  | ContentBlock
  | AssetManifest
  | RulesTemplate
  | ViewModel;

describe("new contracts importable from @life-sim/shared", () => {
  it("value exports are defined", () => {
    const values = [
      FactCallSchema,
      ContentCallSchema,
      ApiCallSchema,
      DiagnosticCodeSchema,
      CallReceiptSchema,
      DispatchContextSchema,
      DIAGNOSTIC_CODES,
      ObserverIdSchema,
      PerspectiveSchema,
      KnowledgeEntrySchema,
      ObservationLedgerSchema,
      PerspectiveFactViewSchema,
      SetKnowledgeArgsSchema,
      TaskConditionSchema,
      TaskNodeSchema,
      TaskDagSchema,
      LlmBudgetSchema,
      ToolDescriptorSchema,
      LlmInvocationSchema,
      LlmOutcomeSchema,
      LlmTraceSchema,
      CallLogEntrySchema,
      ContentBlockSchema,
      AssetDescriptorSchema,
      AssetManifestSchema,
      RulesSchema,
      RulesTemplateSchema,
      ViewModelSchema,
      PlayerVMSchema,
      SlotSceneVMSchema,
      EvaluationVMSchema,
      MediaVMSchema,
      ContentBlockVMSchema,
      NpcVMSchema,
    ];
    for (const v of values) expect(v).toBeDefined();
    expect(DIAGNOSTIC_CODES).toHaveLength(13);
  });

  it("type exports compile", () => {
    const probe: AllContractTypes | null = null;
    void probe;
    expect(probe).toBeNull();
  });

  it("eventNarrativeOrTitle falls back to title (not empty string)", () => {
    expect(eventNarrativeOrTitle({ title: "标题" })).toBe("标题");
    expect(eventNarrativeOrTitle({ title: "标题", narrative: "正文" })).toBe("正文");
  });
});
