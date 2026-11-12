import { describe, expect, it } from "vitest";
import { EventFlavorOutputSchema } from "./schema/event.js";

/** R2.7 / R-NAR-03：事件 flavor 输出只许一段文本，strict 拒绝任何状态/字段写入。 */
describe("R2.7 · EventFlavorOutputSchema（strict，仅文本）", () => {
  it("正常路径：非空 flavor 通过并原样返回", () => {
    const parsed = EventFlavorOutputSchema.safeParse({ flavor: "雨落在涩谷的街头" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.flavor).toBe("雨落在涩谷的街头");
  });

  it("边界：空 flavor 被拒（min(1)）", () => {
    expect(EventFlavorOutputSchema.safeParse({ flavor: "" }).success).toBe(false);
    expect(EventFlavorOutputSchema.safeParse({}).success).toBe(false);
  });

  it("无效输入：strict 拒绝任何额外字段（防写状态 / 分数 / 维度）", () => {
    const cases: unknown[] = [
      { flavor: "文本", state: { hacked: true } },
      { flavor: "文本", score: 999 },
      { flavor: "文本", dimensions: [] },
      { flavor: "文本", evidenceIds: ["h1"] },
      { flavor: "文本", extra: 1 },
    ];
    for (const candidate of cases) {
      expect(EventFlavorOutputSchema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false);
    }
  });

  it("无效输入：flavor 非字符串 / 数组 / null 被拒", () => {
    for (const candidate of [{ flavor: 1 }, { flavor: null }, [], null, "文本"]) {
      expect(EventFlavorOutputSchema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false);
    }
  });

  it("类型：z.infer 派生类型可用于静态标注", () => {
    const out: import("./schema/event.js").EventFlavorOutput = { flavor: "ok" };
    expect(EventFlavorOutputSchema.safeParse(out).success).toBe(true);
  });
});
