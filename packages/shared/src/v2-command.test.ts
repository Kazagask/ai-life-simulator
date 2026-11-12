import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BattleCommandSchema, type BattleCommand } from "./v2-command.js";

/**
 * D-15：战斗命令的**单一真源**契约。
 * 关键不是「schema 能解析」，而是「服务端没有第二份手写定义」——
 * 前者由 zod 保证，后者由源码守卫 + 类型派生共同保证。
 */

const SERVER_INDEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/server/src/index.ts",
);

describe("D-15 · BattleCommandSchema 覆盖全部合法命令", () => {
  it("skill（含/不含 targetInstanceId）、item、flee、pass 全部通过", () => {
    const cases: BattleCommand[] = [
      { type: "skill", skillId: "sk-basic-strike" },
      { type: "skill", skillId: "sk-cursed-strike", targetInstanceId: "enemy#1" },
      { type: "item", itemId: "item-first-aid" },
      { type: "flee" },
      { type: "pass" },
    ];
    for (const command of cases) {
      const parsed = BattleCommandSchema.safeParse(command);
      expect(parsed.success, `应通过：${JSON.stringify(command)}`).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(command);
    }
  });

  /**
   * 编译期守卫：`z.infer` 派生的类型必须能吃下 parse 结果。
   * 若有人把 v2.ts 的手写联合类型改回「另一份定义」，这行会立刻编译失败（结构性漂移检查）。
   */
  it("parse 结果可直接当 BattleCommand 用（类型与 schema 同源）", () => {
    const parsed: BattleCommand = BattleCommandSchema.parse({ type: "pass" });
    // 判别联合仍可收窄（引擎的命令分发依赖这一点）
    expect(parsed.type === "pass" ? "空过" : "其他").toBe("空过");
  });
});

describe("D-15 · 无效输入被可诊断地拒绝", () => {
  it("未知 type 被拒（服务端据此回 400 invalid_body）", () => {
    const parsed = BattleCommandSchema.safeParse({ type: "nope" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.length).toBeGreaterThan(0);
  });

  it("skill 缺 skillId / skillId 为空串 被拒", () => {
    expect(BattleCommandSchema.safeParse({ type: "skill" }).success).toBe(false);
    expect(BattleCommandSchema.safeParse({ type: "skill", skillId: "" }).success).toBe(false);
  });

  it("item 缺 itemId / itemId 为空串 被拒；非对象入参被拒", () => {
    expect(BattleCommandSchema.safeParse({ type: "item" }).success).toBe(false);
    expect(BattleCommandSchema.safeParse({ type: "item", itemId: "" }).success).toBe(false);
    expect(BattleCommandSchema.safeParse(null).success).toBe(false);
    expect(BattleCommandSchema.safeParse("pass").success).toBe(false);
  });

  it("多余字段被剥掉而非拒绝（与重构前的服务端行为逐字节一致）", () => {
    const parsed = BattleCommandSchema.safeParse({ type: "pass", extra: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ type: "pass" });
  });
});

describe("D-15 · 服务端只引用 shared，不存在第二份手写 schema", () => {
  const source = readFileSync(SERVER_INDEX, "utf-8");

  it("服务端从 @life-sim/shared 引入 BattleCommandSchema 并用于 /battle 入参", () => {
    expect(source).toMatch(/import\s*\{[^}]*BattleCommandSchema[^}]*\}\s*from\s*"@life-sim\/shared"/);
    expect(source).toContain("BattleCommandSchema.safeParse(request.body)");
  });

  it("服务端不再手写 discriminatedUnion（曾经的漂移源）", () => {
    // 只针对「战斗命令」这一处漂移点：index.ts 里不应再出现任何本地判别联合定义
    expect(source).not.toMatch(/discriminatedUnion\s*\(/);
  });
});
