/**
 * R2.7 · 服务端冒烟脚本（T-S4 按用户裁决收窄为冒烟级，禁止全流程测试）。
 * 运行：`pnpm --filter @life-sim/server exec tsx smoke/narrative.smoke.ts`
 * 只用 `node:assert` + `tsx` 可直接运行，不引入 vitest（server 无该依赖）。
 */
import assert from "node:assert/strict";
import {
  buildEvaluationSummaryRequest,
  finalizeEvaluationSummary,
  type NarrativeRequest,
} from "@life-sim/game-core";
import {
  EndingNarrativeOutputSchema,
  EvaluationSummaryOutputSchema,
  type EndingView,
  type EvaluationRecord,
  type V2Snapshot,
} from "@life-sim/shared";
import { createLLMProvider, readLLMConfig, type LLMProvider } from "../src/llm/provider.js";
import { LLMUnavailableError } from "../src/llm/errors.js";
import {
  adapterFromOutcome,
  decorateEndingView,
  generateNarrative,
  type NarrativeOutcome,
} from "../src/narrative/generate.js";
import {
  clearFlavorCache,
  flavorKey,
  getFlavors,
  getFlavorsForEvents,
  scheduleEventFlavors,
  type TriggeredEventLike,
} from "../src/narrative/flavorCache.js";

const results: string[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const request: NarrativeRequest = {
  templateTitle: "模板标题",
  templateSummary: "模板文本",
  allowedEvidenceIds: ["h1", "h2"],
  facts: { dimensionSummaries: [] },
};

function stubProvider(fn: () => unknown): LLMProvider {
  return { id: "openai-compatible", complete: async () => fn() };
}

/** 永不 resolve 的 provider：用于验证 generateNarrative 的超时守卫。 */
const hangingProvider: LLMProvider = {
  id: "openai-compatible",
  complete: () => new Promise<unknown>(() => undefined),
};

async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor: 条件在预期节拍内未满足");
}

function makeEnding(visibility: "public" | "hidden"): EndingView {
  return {
    endingId: "end-1",
    title: "模板结局标题",
    summary: "模板结局总结",
    endingType: "neutral",
    visibility,
    source: "condition",
    reason: "终止条件命中",
    worldTime: 1440,
    turnIndex: 3,
    narrativeSource: "template",
    evidenceIds: ["h1"],
  };
}

/** 完整的 V2Snapshot 夹具（不用 any / 类型断言），用于验证响应层装饰是纯函数。 */
function makeSnapshot(ending: EndingView | null): V2Snapshot {
  return {
    worldId: "w1",
    templateId: "t1",
    worldName: "冒烟世界",
    turnIndex: 3,
    worldTime: 1440,
    formattedTime: "第 2 天",
    lifeStage: "youth",
    lifeStageLabel: "青年",
    startYear: 2000,
    labels: { resources: {}, attributes: {}, mood: "心情" },
    player: {
      id: "p1",
      name: "主角",
      age: 18,
      gender: "male",
      genderLabel: "男",
      hp: 100,
      maxHp: 100,
      mp: 50,
      maxMp: 50,
      mood: 0,
      moodBandLabel: "平静",
      attributes: {},
      statuses: [],
      skills: [],
      inventory: [],
    },
    npcs: [],
    pendingEvent: null,
    battle: null,
    lastWheel: null,
    lastWheels: [],
    activeChains: [],
    availableActions: [],
    evaluation: { summary: "模板总结", canonDeviation: 0 },
    status: "terminated",
    ending,
  };
}

async function main(): Promise<void> {
  await check("① createLLMProvider 三层路由 / API_KEY 缺失自动 Mock 不抛", () => {
    assert.equal(createLLMProvider({}).id, "mock");
    assert.equal(
      createLLMProvider({ baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "k" }).id,
      "openai-compatible",
    );
    const missingKey = createLLMProvider(
      readLLMConfig({ LIFE_SIM_LLM_BASE_URL: "http://127.0.0.1:9", LIFE_SIM_LLM_MODEL: "m" }),
    );
    assert.equal(missingKey.id, "mock");
    assert.doesNotThrow(() => readLLMConfig({}));
    assert.equal(
      createLLMProvider(
        readLLMConfig({ LIFE_SIM_WORKBUDDY_SESSION: "s", LIFE_SIM_WORKBUDDY_CLOUD_URL: "http://x" }),
      ).id,
      "workbuddy-cloud",
    );
  });

  await check("② generateNarrative 三类反例(非法 schema / 虚构证据 / 超时)回退且 diagnostic 可区分", async () => {
    const invalid = await generateNarrative(
      request,
      EndingNarrativeOutputSchema,
      stubProvider(() => ({ title: "x", summary: "y", evidenceIds: ["h1"], state: { hacked: true } })),
    );
    assert.equal(invalid.source, "fallback");
    assert.match(invalid.diagnostic ?? "", /invalid_schema/);

    const fabricated = await generateNarrative(
      request,
      EndingNarrativeOutputSchema,
      stubProvider(() => ({ title: "x", summary: "y", evidenceIds: ["ghost"] })),
    );
    assert.equal(fabricated.source, "fallback");
    assert.match(fabricated.diagnostic ?? "", /fabricated_evidence/);

    const timeout = await generateNarrative(request, EndingNarrativeOutputSchema, hangingProvider, {
      timeoutMs: 20,
    });
    assert.equal(timeout.source, "fallback");
    assert.match(timeout.diagnostic ?? "", /\[超时\]/);

    const unavailable = await generateNarrative(
      request,
      EndingNarrativeOutputSchema,
      stubProvider(() => {
        throw new LLMUnavailableError("endpoint down");
      }),
    );
    assert.equal(unavailable.source, "fallback");
    assert.match(unavailable.diagnostic ?? "", /\[不可用\]/);

    assert.notEqual(invalid.diagnostic, fabricated.diagnostic);
    assert.notEqual(timeout.diagnostic, unavailable.diagnostic);
    assert.equal(invalid.data, null);
  });

  await check("③ 合法候选 ⇒ llm；mock ⇒ template 且不调用 complete", async () => {
    const ok = await generateNarrative(
      request,
      EndingNarrativeOutputSchema,
      stubProvider(() => ({ title: "LLM 标题", summary: "LLM 总结", evidenceIds: ["h1"] })),
    );
    assert.equal(ok.source, "llm");
    assert.equal(ok.diagnostic, null);
    assert.deepEqual(ok.data, { title: "LLM 标题", summary: "LLM 总结", evidenceIds: ["h1"] });

    let calls = 0;
    const countingMock: LLMProvider = {
      id: "mock",
      complete: async () => {
        calls += 1;
        return {};
      },
    };
    const mocked: NarrativeOutcome = await generateNarrative(request, EndingNarrativeOutputSchema, countingMock);
    assert.equal(mocked.source, "template");
    assert.equal(mocked.data, null);
    assert.equal(mocked.diagnostic, null);
    assert.equal(calls, 0);
  });

  await check("④ finalizeEvaluationSummary 注入 LLM 前后 dimensions/evidenceIds/overall 逐字段相等", async () => {
    const record: EvaluationRecord = {
      dimensions: [
        { id: "growth", label: "成长", score: 72, level: "良好", explanation: "经历丰富", evidenceIds: ["h1", "h3"] },
        { id: "bond", label: "羁绊", score: 40, level: "平平", explanation: "少有交集", evidenceIds: ["h2"] },
      ],
      summary: "模板人生总结",
      summarySource: "template",
      overall: 56,
    };
    const before = structuredClone(record);
    const outcome = await generateNarrative(
      buildEvaluationSummaryRequest(record),
      EvaluationSummaryOutputSchema,
      stubProvider(() => ({ summary: "LLM 精炼的人生总结" })),
    );
    assert.equal(outcome.source, "llm");
    const finalized = finalizeEvaluationSummary(record, adapterFromOutcome(outcome));
    assert.equal(finalized.summary, "LLM 精炼的人生总结");
    assert.equal(finalized.summarySource, "llm");
    assert.deepEqual(finalized.dimensions, before.dimensions);
    assert.deepEqual(
      finalized.dimensions.map((d) => d.evidenceIds),
      before.dimensions.map((d) => d.evidenceIds),
    );
    assert.equal(finalized.overall, before.overall);
    assert.deepEqual(record, before); // 纯函数不改入参

    const bad = await generateNarrative(
      buildEvaluationSummaryRequest(record),
      EvaluationSummaryOutputSchema,
      stubProvider(() => ({ summary: "篡改", score: 999 })),
    );
    assert.equal(bad.source, "fallback");
    const fallbackFinalized = finalizeEvaluationSummary(record, adapterFromOutcome(bad));
    assert.equal(fallbackFinalized.summarySource, "fallback");
    assert.deepEqual(fallbackFinalized.dimensions, before.dimensions);
    assert.equal(fallbackFinalized.summary, before.summary);
  });

  await check("⑤ decorateEndingView 对 hidden 结局原样返回；public 才装饰", () => {
    const hidden = makeSnapshot(makeEnding("hidden"));
    const llmOutcome: NarrativeOutcome = {
      source: "llm",
      data: { title: "不该外泄的标题", summary: "不该外泄的总结" },
      diagnostic: null,
    };
    assert.equal(decorateEndingView(hidden, llmOutcome), hidden); // 同一对象引用 ⇒ 完全原样

    const noEnding = makeSnapshot(null);
    assert.equal(decorateEndingView(noEnding, llmOutcome), noEnding);

    const publicSnapshot = makeSnapshot(makeEnding("public"));
    const decorated = decorateEndingView(publicSnapshot, llmOutcome);
    assert.notEqual(decorated, publicSnapshot);
    assert.equal(decorated.ending?.narrativeSource, "llm");
    assert.equal(decorated.ending?.title, "不该外泄的标题");
    assert.equal(decorated.ending?.summary, "不该外泄的总结");
    assert.equal(publicSnapshot.ending?.title, "模板结局标题"); // 不改入参

    const fallbackOutcome: NarrativeOutcome = { source: "fallback", data: null, diagnostic: "不可用" };
    const fallbackDecorated = decorateEndingView(publicSnapshot, fallbackOutcome);
    assert.equal(fallbackDecorated.ending?.narrativeSource, "fallback");
    assert.equal(fallbackDecorated.ending?.title, "模板结局标题");
    assert.equal(fallbackDecorated.ending?.summary, "模板结局总结");

    const templateOutcome: NarrativeOutcome = { source: "template", data: null, diagnostic: null };
    assert.equal(decorateEndingView(publicSnapshot, templateOutcome), publicSnapshot);
  });

  await check("⑥ flavorCache 键确定性 + 缓存不进状态", async () => {
    clearFlavorCache();
    assert.equal(flavorKey("w1", 3, 1440, "e1", 0), "w1|3|1440|e1|0");
    assert.equal(flavorKey("w1", 3, 1440, "e1", 0), flavorKey("w1", 3, 1440, "e1", 0));
    assert.notEqual(flavorKey("w1", 3, 1440, "e1", 0), flavorKey("w1", 3, 1440, "e1", 1));

    const events: TriggeredEventLike[] = [{ id: "e1", title: "雨夜", narrative: "模板事件文案" }];
    const eventsBefore = JSON.stringify(events);
    const state = { id: "w1", turnIndex: 3, worldTime: 1440, history: [{ id: "h1" }] };
    const stateBefore = JSON.stringify(state);

    // fire-and-forget：调用不阻塞、不抛；状态序列化逐字节不受影响
    assert.doesNotThrow(() =>
      scheduleEventFlavors({
        worldId: "w1",
        turnIndex: 3,
        worldTime: 1440,
        events,
        provider: stubProvider(() => ({ flavor: "LLM 事件文案" })),
        timeoutMs: 1000,
      }),
    );
    assert.equal(JSON.stringify(state), stateBefore);
    assert.equal(JSON.stringify(events), eventsBefore);

    await waitFor(() => getFlavorsForEvents("w1", 3, 1440, events).e1 !== undefined);
    assert.equal(getFlavorsForEvents("w1", 3, 1440, events).e1, "LLM 事件文案");
    assert.deepEqual(getFlavors("w1"), { e1: "LLM 事件文案" });
    assert.equal(JSON.stringify(state), stateBefore); // 后台写缓存后状态仍逐字节一致

    // 超时 ⇒ 不写缓存、静默回退模板
    clearFlavorCache();
    scheduleEventFlavors({
      worldId: "w1",
      turnIndex: 3,
      worldTime: 1440,
      events,
      provider: hangingProvider,
      timeoutMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(getFlavors("w1"), {});
    assert.equal(JSON.stringify(state), stateBefore);
    clearFlavorCache();
  });
}

await main();
for (const line of results) console.log(line);
if (process.exitCode === undefined || process.exitCode === 0) {
  console.log("SMOKE OK");
} else {
  console.log("SMOKE FAILED");
}
