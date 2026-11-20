import { describe, expect, it } from "vitest";
import {
  buildEndingNarrativeRequest,
  buildEvaluationSummaryRequest,
  historyDigestOf,
  type EvaluationRecord,
} from "@life-sim/game-core";
import type { V2Snapshot } from "@life-sim/shared";
import { decorateEvaluationView } from "../../apps/server/src/narrative/generate.ts";

/**
 * 结局收尾 / 人生评价的接线（2026-11-21）。
 *
 * 用户反馈「结局没有 LLM 收尾和评价」。核对后的两个真实缺口都在这条链上：
 * ① 请求里只有模板文案 + 维度名，模型没有本局的任何事实可写 ⇒ 只能复述模板；
 * ② 评价总结只在 `POST /archive` 生成，终止那一刻永远是引擎拼的
 *    「本局共记录 N 条经历」—— 结局卡上看起来像没接线。
 *
 * 这里守的是纯函数层：请求必须带上可引用经历与写作指令；评价装饰只许改
 * summary / summarySource，分项与分数逐字段不变。
 */

const EVALUATION: EvaluationRecord = {
  dimensions: [
    {
      id: "growth",
      label: "成长",
      score: 72,
      level: "成熟",
      explanation: "你在一年里学会了自己判断。",
      evidenceIds: ["h-1", "h-2"],
    },
  ],
  summary: "本局共记录 2 条经历，1 项维度已评分。",
  summarySource: "template",
  overall: 72,
};

function snapshotWith(evaluation: Partial<EvaluationRecord>, hiddenEnding = false): V2Snapshot {
  return {
    evaluation: {
      summary: evaluation.summary ?? EVALUATION.summary,
      canonDeviation: 0,
      dimensions: [
        { id: "growth", label: "成长", score: 72, level: "成熟", explanation: "说明" },
      ],
      overall: 72,
    },
    ending: {
      endingId: "end-ordinary",
      title: "一年生",
      summary: "模板结局",
      endingType: "neutral",
      visibility: hiddenEnding ? "hidden" : "public",
      narrativeSource: "template",
      evidenceIds: [],
      source: "condition",
      reason: "time",
      worldTime: 275 * 1440,
      turnIndex: 40,
    },
  } as unknown as V2Snapshot;
}

describe("结局 / 总结请求带上本局事实", () => {
  it("历史摘要只取玩家可见条目，且单条截断", () => {
    const state = {
      history: [
        { id: "h-0", summary: "hidden 的事", visibility: "hidden" },
        { id: "h-1", summary: "a".repeat(300), visibility: "public" },
        { id: "h-2", summary: "救下了她", visibility: "public" },
      ],
    } as unknown as Parameters<typeof historyDigestOf>[0];

    const digest = historyDigestOf(state, 80, 10);
    expect(digest.map((d) => d.id)).toEqual(["h-1", "h-2"]);
    expect(digest[0]!.text).toHaveLength(11); // 10 字 + 省略号
    expect(digest[1]!.text).toBe("救下了她");
  });

  it("结局请求带写作指令与经历素材，证据白名单不变，且不改入参", () => {
    const history = [{ id: "h-1", text: "你挡在她前面" }];
    const input = {
      templateTitle: "早夭",
      templateSummary: "模板结局",
      allowedEvidenceIds: ["h-1"],
      history,
    };
    const request = buildEndingNarrativeRequest(input);

    expect(request.allowedEvidenceIds).toEqual(["h-1"]);
    expect(request.facts.history).toEqual(history);
    expect(request.instruction).toContain("250–450 字");
    // 入参没有被写入（纯函数）：history 仍是调用方那一份，没有被塞进 allowedEvidenceIds
    expect(input.allowedEvidenceIds).toEqual(["h-1"]);
  });

  it("总结请求的指令只要求写 summary，并明确「不要重述分数」", () => {
    const request = buildEvaluationSummaryRequest(EVALUATION, [{ id: "h-1", text: "你救了她" }]);
    expect(request.instruction).toContain("不要重述分数");
    expect(request.facts.history).toHaveLength(1);
    // 证据白名单来自维度证据去重（不是看分数）
    expect(request.allowedEvidenceIds).toEqual(["h-1", "h-2"]);
  });
});

describe("评价的响应层装饰", () => {
  it("llm 只换 summary 与来源，分项 / 总分 / 偏离度逐字段不变", () => {
    const snapshot = snapshotWith({});
    const decorated = decorateEvaluationView(snapshot, {
      source: "llm",
      data: { summary: "这一年你学会了替自己决定。" },
      diagnostic: null,
    });
    expect(decorated.evaluation.summary).toBe("这一年你学会了替自己决定。");
    expect(decorated.evaluation.summarySource).toBe("llm");
    expect(decorated.evaluation.dimensions).toEqual(snapshot.evaluation.dimensions);
    expect(decorated.evaluation.overall).toBe(72);
    expect(decorated.evaluation.canonDeviation).toBe(0);
  });

  it("fallback 保留模板总结，只把来源标成 fallback", () => {
    const decorated = decorateEvaluationView(snapshotWith({}), {
      source: "fallback",
      data: null,
      diagnostic: "超时",
    });
    expect(decorated.evaluation.summary).toBe(EVALUATION.summary);
    expect(decorated.evaluation.summarySource).toBe("fallback");
  });

  it("隐藏结局不装饰（连评价也不碰）", () => {
    const snapshot = snapshotWith({}, true);
    const decorated = decorateEvaluationView(snapshot, {
      source: "llm",
      data: { summary: "不该出现的总结" },
      diagnostic: null,
    });
    expect(decorated).toBe(snapshot);
  });
});
