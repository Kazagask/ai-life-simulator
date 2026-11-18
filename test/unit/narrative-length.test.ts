import { describe, expect, it } from "vitest";
import type { AgentCompletion, LlmInvocation } from "@life-sim/shared";
import { runAgentLoop } from "../../packages/agent-runtime/src/loop.ts";

/**
 * 正文长度上限要跟着体裁走（2026-11-19）。
 *
 * 用户反馈「一章 3-5 句太少」时，真正卡住长度的不只是输出契约里的 80–220 字，
 * 还有后处理 `normalizeNarrative` 的 420 字截断：契约改成 320–760 字之后，
 * 模型写 700 字会被**静默砍回 420**，看起来就像"它还是只写了几句"。
 */

// 每段必须**互不相同**：`normalizeNarrative` 会按首现去重（真实翻车：模型整段复读）。
const PARAGRAPHS = [
  "走廊尽头的灯管闪了一下，你听见自己吞咽的声音，指节把门框攥出一层白印，咒力沿着手背爬上来，像有一层薄壳在皮肤下慢慢收紧。",
  "窗外的雨打在铁皮上，声音密得像有人在数数，你把眼罩往下拉了半寸，视线里那团咒力的轮廓反而更清楚了。",
  "对方先动的手，鞋底在地上蹭出一声短促的摩擦，你侧身的瞬间，肩膀还是被削开一道口子，血是热的，风是冷的。",
  "你退到墙边，后背撞上砖，肺里的空气被挤出一半，喉咙深处泛起铁锈味，手指却先一步掐出了那个熟悉的印。",
  "灯彻底灭了，黑暗里只剩呼吸和心跳，你数到第三下的时候，才发觉那第二组呼吸不是自己的。",
  "他说了句什么，声音很轻，被雨声吃掉了一半，你没有听清，只看见他抬手的动作停顿了一瞬——那一瞬比任何话都清楚。",
  "你把手放下，掌心的汗混着血，黏得难受，远处有救护车的声音由远及近，又慢慢拐去了别的街区。",
  "走到楼梯口的时候，你回头看了一眼，门缝里的光还在，像什么都没发生过，只有膝盖在提醒你刚才不是做梦。",
  "第二天的教室里没有人提昨晚的事，黑板右上角还留着上一节的算式，粉笔灰在斜射进来的光里浮着，像一层没散的帐。",
  "你把通知单折成四折塞进外套内袋，纸角顶着肋骨，走路的时候一下一下地提醒你，这件事还没有结束。",
  "训练场的木地板被踩得发亮，你站在最后一排，听着前面的人报数，报到你的时候，喉咙干得只发出了半个音。",
  "傍晚的便利店亮着惨白的灯，你买了两个饭团和一罐热咖啡，坐在门口的台阶上，看街上的人一个一个走过去。",
];

function textOf(paragraphs: number): string {
  return PARAGRAPHS.slice(0, paragraphs).join("\n\n");
}

function invocation(patch: Record<string, unknown> = {}): LlmInvocation {
  return {
    invocationId: "inv-length",
    reason: "test",
    context: {
      stablePrefix: "",
      facts: {},
      recentTurns: [],
      invocationReason: "test",
      ...patch,
    },
    tools: [],
    replyTo: "dispatch",
    perspective: "player",
    targetPerspective: "player",
    budget: { recentTurns: 6 },
  } as unknown as LlmInvocation;
}

function providerOf(raw: string) {
  return {
    id: "openai-compatible" as const,
    chat: async (): Promise<AgentCompletion> => ({
      toolCalls: [],
      text: `<narrative-content>${raw}</narrative-content>`,
      inputTokens: 0,
      outputTokens: 0,
      finishReason: "stop" as const,
    }),
  };
}

async function narrativeLengthOf(inv: LlmInvocation, raw: string): Promise<number> {
  const { trace } = await runAgentLoop(inv, {
    provider: providerOf(raw),
    // sink 缺省时 loop 自己建一个；这里只关心 trace 里的正文块。
    engineApi: {} as never,
    budget: inv.budget,
  });
  const block = (trace.contentBlocks ?? []).find((b) => b.kind === "narrative");
  return (block?.text ?? "").length;
}

describe("正文字数上限跟着 invoke.length 走", () => {
  it("缺省（逐拍）：仍按 420 字截断，行为不变", async () => {
    const raw = textOf(12);
    expect(raw.length).toBeGreaterThan(420);
    const kept = await narrativeLengthOf(invocation(), raw);
    expect(kept).toBeLessThanOrEqual(420);
    expect(kept).toBeGreaterThan(300);
  });

  it("recap 声明 760 字：长正文不被 420 砍掉", async () => {
    const raw = textOf(12);
    const kept = await narrativeLengthOf(
      invocation({
        narrativeMode: "recap",
        narrativeLength: { minChars: 320, maxChars: 760, minParagraphs: 3, maxParagraphs: 6 },
      }),
      raw,
    );
    expect(kept).toBeGreaterThan(420);
    expect(kept).toBeLessThanOrEqual(760);
  });
});
