import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  LlmBudgetSchema,
  LlmInvocationSchema,
  RulesSchema,
  WorldTemplateV2Schema,
  type ApiCall,
  type CallReceipt,
  type DispatchContext,
  type DispatchResult,
  type EngineApiHandle,
  type LlmBudget,
  type LlmInvocation,
  type PerspectiveFactView,
  type V2Snapshot,
  type Perspective,
  type RulesTemplate,
  type ToolDescriptor,
  type WorldStateV2,
  type WorldTemplateV2,
} from "@life-sim/shared";
import {
  RpgEngineAPI,
  createContentSink,
  createDefaultOpeningTemplate,
  createLookup,
  createRunnerContext,
  createWorldV2,
  handoff,
  runOpening,
} from "@life-sim/game-core";
import { buildToolDescriptors } from "../tool-registry.js";

/**
 * 测试夹具：从仓库内的最小骨架模板 demo-agentic 真实加载世界，而不是内联捏造状态。
 * 只被 `*.min.test.ts` 引用；生产路径不读磁盘 YAML（模板加载归 apps/server）。
 */

const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../specs/data/templates/demo-agentic/1.0.0",
);

const MERGE_FILES = ["world", "characters", "skills", "items", "statuses", "events"] as const;

const readYaml = (file: string): unknown => parse(readFileSync(path.join(TEMPLATE_DIR, file), "utf8"));

export interface DemoFixture {
  template: WorldTemplateV2;
  rules: RulesTemplate;
  state: WorldStateV2;
  engine: RpgEngineAPI;
}

/** 规则里的常驻知识授予（`always`）落地到统一台账，模拟核心已结算的开局状态。 */
function seedLedger(state: WorldStateV2, rules: RulesTemplate): void {
  for (const rule of rules.knowledgeGrants) {
    const always = rule.when.every(
      (condition) => "op" in condition && (condition as { op?: unknown }).op === "always",
    );
    if (!always) continue;
    for (const observer of rule.grant.observers) {
      const entries = state.observationLedger[observer] ?? [];
      for (const factRef of rule.grant.factRefs) {
        if (entries.some((entry) => entry.factRef === factRef)) continue;
        entries.push({
          factRef,
          level: rule.grant.level,
          source: rule.grant.source,
          sinceTurn: 0,
        });
      }
      state.observationLedger[observer] = entries;
    }
  }
}

export function loadDemoFixture(opts?: { seed?: number }): DemoFixture {
  const merged: Record<string, unknown> = {};
  for (const name of MERGE_FILES) {
    const part = readYaml(`${name}.yaml`);
    if (typeof part === "object" && part !== null) Object.assign(merged, part);
  }
  const template = WorldTemplateV2Schema.parse(merged);
  const rules = RulesSchema.parse(readYaml("rules.yaml"));

  const base = createWorldV2(
    { templateId: template.meta.id, playerName: "旅人", seed: opts?.seed ?? 20261116 },
    template,
    "world-demo-1",
  );
  const lookup = createLookup(template);
  const openingCtx = { ...createRunnerContext(base.seed), lookup };
  const { state: opened, run } = runOpening(base, createDefaultOpeningTemplate(), openingCtx);
  const state = handoff(opened, run, lookup);

  // 测试夹具：把模板 fallbackDag 作为已发布 DAG，并落常驻知识授予（真实结算由核心完成）。
  state.taskDag = rules.fallbackDag;
  seedLedger(state, rules);

  const engine = new RpgEngineAPI({ state });
  return { template, rules, state, engine };
}

export interface MakeInvocationOptions {
  invocationId?: string;
  reason?: string;
  perspective?: Perspective;
  targetPerspective?: Perspective;
  toolProfile?: string;
  budget?: Partial<LlmBudget>;
  tools?: ToolDescriptor[];
}

export function makeInvocation(
  fixture: DemoFixture,
  opts?: MakeInvocationOptions,
): LlmInvocation {
  const perspective = opts?.perspective ?? "player";
  const targetPerspective = opts?.targetPerspective ?? perspective;
  const reason = opts?.reason ?? "chapter.advance";
  const tools =
    opts?.tools ??
    buildToolDescriptors(fixture.rules, opts?.toolProfile ?? "narrative");
  const context = {
    stablePrefix: "",
    facts: fixture.engine.buildFacts(perspective),
    recentTurns: [],
    invocationReason: reason,
  };
  return LlmInvocationSchema.parse({
    invocationId: opts?.invocationId ?? "inv-demo-1",
    reason,
    context,
    tools,
    budget: LlmBudgetSchema.parse(opts?.budget ?? {}),
    replyTo: "dispatch",
    perspective,
    targetPerspective,
  });
}

/** 生成一个最小但 schema 合法的 invocation（不依赖模板，用于纯循环测试）。 */
export function makeBareInvocation(opts?: {
  invocationId?: string;
  reason?: string;
  perspective?: Perspective;
  targetPerspective?: Perspective;
  tools?: ToolDescriptor[];
  budget?: Partial<LlmBudget>;
  facts?: { factRef: string; value?: unknown }[];
}): LlmInvocation {
  const perspective = opts?.perspective ?? "player";
  const targetPerspective = opts?.targetPerspective ?? "player";
  const reason = opts?.reason ?? "test.reason";
  const tools =
    opts?.tools ??
    buildToolDescriptors(undefined, undefined);
  return LlmInvocationSchema.parse({
    invocationId: opts?.invocationId ?? "inv-bare-1",
    reason,
    context: {
      stablePrefix: "",
      facts: {
        perspective,
        facts: (opts?.facts ?? []).map((fact) => ({ ...fact, level: "known" as const })),
        dagNodes: [],
      },
      recentTurns: [],
      invocationReason: reason,
    },
    tools,
    budget: LlmBudgetSchema.parse(opts?.budget ?? {}),
    replyTo: "dispatch",
    perspective,
    targetPerspective,
  });
}

// ---------- 纯循环测试用的桩引擎（不碰真实状态） ----------

export type DispatchHandler = (
  calls: readonly ApiCall[],
  ctx: DispatchContext,
) => CallReceipt[];

export class StubEngine implements EngineApiHandle {
  readonly state: WorldStateV2;
  readonly sink = createContentSink();
  private readonly handler: DispatchHandler | undefined;

  constructor(handler?: DispatchHandler) {
    this.handler = handler;
    this.state = {
      id: "world-stub",
      templateId: "stub",
      seed: 1,
      turnIndex: 3,
      worldTime: 4320,
      player: { name: "旅人", age: 18, gender: "unknown", hp: 100, mp: 50, mood: 50, attributes: {} },
      media: [],
      observationLedger: { player: [] },
    } as unknown as WorldStateV2;
  }

  dispatch(calls: ApiCall[], ctx: DispatchContext): DispatchResult {
    const receipts =
      this.handler === undefined
        ? calls.map((call) => ({ callId: call.callId, outcome: "accepted" as const }))
        : this.handler(calls, ctx);
    return { receipts, state: this.state };
  }

  snapshot(): V2Snapshot {
    return { turnIndex: 3, worldTime: 4320 } as unknown as V2Snapshot;
  }

  buildFacts(perspective: Perspective): PerspectiveFactView {
    return { perspective, facts: [], dagNodes: [] };
  }
}
