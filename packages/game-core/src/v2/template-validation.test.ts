import { describe, expect, it } from "vitest";
import { WorldTemplateV2Schema } from "@life-sim/shared";
import { makeTestTemplate } from "./test-utils.js";

/**
 * R2.6 加载期负向校验的回归护栏（QA `R26-ACCEPTANCE.md` D-03 / D-04）。
 *
 * 这两条校验**实现早已存在**（`packages/shared/src/schema/world.ts` 的
 * `time.calendar` superRefine 与 `characters[].relations[].to` 引用校验），
 * 但此前只有手工实测、无自动化用例 —— 回归时无法报警。
 *
 * 口径：都在**加载期**（`WorldTemplateV2Schema.parse`）fail-fast，
 * 错误信息须可诊断（能定位到字段）。
 */

/** 提取 ZodError 的 issue（格式统一，避免各断言写法漂移）。 */
function zodIssues(input: unknown): Array<{ path: (string | number)[]; message: string }> {
  const res = WorldTemplateV2Schema.safeParse(input);
  if (res.success) return [];
  return res.error.issues.map((i) => ({ path: [...i.path], message: i.message }));
}

/**
 * 合法基线：`makeTestTemplate` 是**引擎行为夹具**，其中一条事件的
 * `visibleWhen` 故意引用不存在的技能 `sk-none`（用于测选项过滤），
 * 因此整模板过不了加载期引用校验。这里剔掉事件列表，只保留
 * 历法/角色等本文件要验的配置面，避免夹具缺陷干扰负向用例。
 */
function validTemplate() {
  const template = makeTestTemplate();
  template.events = [];
  return template;
}

describe("R2.6 加载期校验 · 基线夹具本身合法", () => {
  it("makeTestTemplate 未经修改即可通过 WorldTemplateV2Schema", () => {
    const parsed = WorldTemplateV2Schema.safeParse(validTemplate());
    expect(parsed.success, JSON.stringify(zodIssues(validTemplate()))).toBe(true);
  });
});

describe("R2.6 加载期校验 · 历法配置（D-03 / R-CAL-02）", () => {
  it("preset: custom 未声明 months ⇒ 拒载，且错误定位到 time.calendar.months", () => {
    const template = validTemplate();
    template.time = { ...template.time, calendar: { preset: "custom" } };
    const issues = zodIssues(template);
    expect(issues.length).toBeGreaterThan(0);
    const hit = issues.find((i) => i.path.join(".") === "time.calendar.months");
    expect(hit, `未命中 months 路径，实际 issues：${JSON.stringify(issues)}`).toBeDefined();
    expect(hit!.message).toContain("months");
  });

  it("preset: custom 声明 months 但月天数非法（<=0）⇒ 拒载", () => {
    const template = validTemplate();
    template.time = {
      ...template.time,
      calendar: { preset: "custom", months: [{ name: "睦月", days: 0 }] },
    };
    const issues = zodIssues(template);
    expect(issues.some((i) => i.path.join(".").startsWith("time.calendar"))).toBe(true);
  });

  it("preset: gregorian 无需 months 即可加载（零配置）", () => {
    const template = validTemplate();
    template.time = { ...template.time, calendar: { preset: "gregorian" } };
    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success, JSON.stringify(zodIssues(template))).toBe(true);
  });

  it("缺省 calendar（不声明）仍合法 —— approx 零迁移", () => {
    const template = validTemplate();
    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success).toBe(true);
    expect((parsed as { data: { time: { calendar?: unknown } } }).data.time.calendar).toBeUndefined();
  });
});

describe("R2.6 加载期校验 · 关系边端点（D-04 / R-REL-01）", () => {
  it("relations[].to 引用未知角色 ⇒ 拒载，错误信息含「未知关系目标」", () => {
    const template = validTemplate();
    template.characters[0].relations = [{ to: "npc-ghost", kind: "friend" }];
    const issues = zodIssues(template);
    const hit = issues.find((i) => i.message.includes("未知关系目标"));
    expect(hit, `实际 issues：${JSON.stringify(issues)}`).toBeDefined();
    expect(hit!.message).toContain("npc-ghost");
    // 路径须定位到具体角色与条目，而非整模板
    expect(hit!.path.join(".")).toContain("relations");
  });

  it("relations[].to 指向已声明角色 ⇒ 通过", () => {
    const template = validTemplate();
    template.characters.push({
      ...template.characters[0],
      id: "npc-peer",
      isEnemy: false,
      identity: { ...template.characters[0].identity, name: "同僚" },
      relationship: 10,
    });
    template.characters[0].relations = [{ to: "npc-peer", kind: "friend" }];
    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success, JSON.stringify(zodIssues(template))).toBe(true);
  });

  it("relations[].to 指向玩家（'player'）⇒ 通过，不受角色表限制", () => {
    const template = validTemplate();
    template.characters[0].relations = [{ to: "player", kind: "mentor", visibility: "known" }];
    const parsed = WorldTemplateV2Schema.safeParse(template);
    expect(parsed.success, JSON.stringify(zodIssues(template))).toBe(true);
  });

  it("未知 kind ⇒ 拒载（枚举封闭）", () => {
    const template = validTemplate();
    template.characters[0].relations = [
      // 故意用非法 kind 验证枚举封闭性
      { to: "player", kind: "bestie" } as unknown as { to: string; kind: "friend" },
    ];
    const issues = zodIssues(template);
    expect(issues.length).toBeGreaterThan(0);
  });
});
