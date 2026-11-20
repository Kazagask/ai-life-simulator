import { describe, expect, it } from "vitest";
import type { WorldTemplateV2 } from "@life-sim/shared";
import { assertKinshipCompliance } from "../../apps/server/src/templates.ts";

/**
 * `kinship_conflict` 判据（`extensions/family/doc/FAMILY-GRAPH.md` §1/§2）：亲缘两种合规写法互斥。
 *
 * 判据：`extensions.family` 存在 **且** `characters[].relations[]` 里任一条 `kind` 属于
 * `KinshipKind`（`father` / `mother` / `wife` / `son` / `daughter` / `elder-sister` /
 * `relative` …）⇒ 抛 `kinship_conflict`，reason 点名角色与 kind。
 *
 * 这里直接测纯函数 `assertKinshipCompliance`，**不经 `loadTemplate`**：闸门已在
 * `scanVersion` 接入（三个内置模板均已按各自模式合规），但纯函数层不需要真模板目录，
 * 只喂它真正读的两个字段，才能把判据本身钉死。
 *
 * 四条锁定：
 * 1. family + `wife` 边 ⇒ 抛 `kinship_conflict`，reason 点名角色与 kind；
 * 2. family + 只有 `friend` 边 ⇒ 放行（社会边两种模式都合法）；
 * 3. 不装 family + `father` 边 ⇒ 放行（模式一合法）；
 * 4. family + 无任何 relations ⇒ 放行（模式二合法）。
 */

type Relation = { to: string; kind: string };

/**
 * 只构造闸门真正读的字段（`extensions` + `characters[].id/relations`）。
 *
 * 强转而非拼整份模板：本函数是纯函数，喂整份 yaml 只会让用例被无关 schema 字段绑架
 * （某次加必填字段就红一片，却测不出闸门本身对不对）。
 */
function templateOf(options: { family: boolean; relations?: Relation[] }): WorldTemplateV2 {
  return {
    extensions: options.family ? { family: true } : undefined,
    characters: [
      {
        id: "npc-kin",
        relations: options.relations?.map((relation) => ({
          to: relation.to,
          kind: relation.kind,
          scope: "public" as const,
          value: 50,
        })),
      },
    ],
  } as unknown as WorldTemplateV2;
}

/** 断言抛 `TemplateLoadError`，返回它的 `reasonCode` 与 message（类未导出，按形状取）。 */
function conflictOf(template: WorldTemplateV2): { reasonCode?: string; message: string } {
  try {
    assertKinshipCompliance(template);
  } catch (error) {
    const typed = error as { name?: string; reasonCode?: string; message: string };
    expect(typed.name).toBe("TemplateLoadError");
    return { reasonCode: typed.reasonCode, message: typed.message };
  }
  throw new Error("expected kinship_conflict, but assertKinshipCompliance passed");
}

describe("kinship_conflict：装了 family 又写亲属边 ⇒ 冲突", () => {
  it("family + wife 边 ⇒ kinship_conflict，reason 点名角色与 kind", () => {
    const conflict = conflictOf(
      templateOf({ family: true, relations: [{ to: "npc-wife", kind: "wife" }] }),
    );
    expect(conflict.reasonCode).toBe("kinship_conflict");
    expect(conflict.message).toContain("npc-kin");
    expect(conflict.message).toContain("npc-wife");
    expect(conflict.message).toContain("wife");
    expect(conflict.message).toContain("fatherId/motherId");
    expect(conflict.message).toContain("extensions.family");
  });

  it("family + 只有 friend 边 ⇒ 放行（社会边不属于亲缘）", () => {
    expect(() =>
      assertKinshipCompliance(
        templateOf({ family: true, relations: [{ to: "npc-pal", kind: "friend" }] }),
      ),
    ).not.toThrow();
  });

  it("不装 family + father 边 ⇒ 放行（模式一：模板自己维护亲缘）", () => {
    expect(() =>
      assertKinshipCompliance(
        templateOf({ family: false, relations: [{ to: "npc-pa", kind: "father" }] }),
      ),
    ).not.toThrow();
  });

  it("装 family + 无任何 relations ⇒ 放行（模式二）", () => {
    expect(() => assertKinshipCompliance(templateOf({ family: true }))).not.toThrow();
  });
});
