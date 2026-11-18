import { describe, expect, it } from "vitest";
import type { UiConfig } from "@life-sim/shared";
import { hasSubtabEntry, hasTabEntry, requiresMinimalForm, resolvePlacement } from "../../apps/web/src/ui-layout";

const ui = (place: NonNullable<UiConfig["place"]>): UiConfig => ({ place });

describe("ui.yaml 前端落位解析", () => {
  it("缺省等于现状：不写声明时各能力保持内建落位", () => {
    expect(resolvePlacement(undefined, "world")).toBe("tab");
    expect(resolvePlacement(undefined, "equipment")).toBe("embedded");
    expect(resolvePlacement(undefined, "wheel")).toBe("overlay");
    expect(resolvePlacement(undefined, "clan")).toBe("tab"); // 扩展视图无内建落位 ⇒ 页签
  });

  it("四种落位原样透传；认识的槽转 embedded，未知槽退化为 tab", () => {
    const config = ui({
      world: "off",
      log: "tab",
      wheel: "overlay",
      equipment: "slot:personal",
      pedigree: "slot:world.subview",
      relations: "slot:no-such-host",
    });
    expect(resolvePlacement(config, "world")).toBe("off");
    expect(resolvePlacement(config, "log")).toBe("tab");
    expect(resolvePlacement(config, "wheel")).toBe("overlay");
    expect(resolvePlacement(config, "equipment")).toBe("embedded");
    expect(resolvePlacement(config, "pedigree")).toBe("embedded");
    expect(resolvePlacement(config, "relations")).toBe("tab");
  });

  it("off / overlay 都不占常驻页签入口", () => {
    const config = ui({ log: "off", wheel: "overlay", world: "tab" });
    expect(hasTabEntry(config, "log")).toBe(false);
    expect(hasTabEntry(config, "wheel")).toBe(false);
    expect(hasTabEntry(config, "world")).toBe(true);
  });

  it("嵌入槽在自己的宿主里是子页签，不能按顶层规则过滤掉", () => {
    const config = ui({
      character: "slot:personal",
      equipment: "slot:personal",
      pedigree: "slot:world.subview",
      relations: "slot:npcList",
      log: "off",
      wheel: "overlay",
    });
    expect(hasSubtabEntry(config, "character")).toBe(true);
    expect(hasSubtabEntry(config, "equipment")).toBe(true);
    expect(hasSubtabEntry(config, "pedigree")).toBe(true);
    expect(hasSubtabEntry(config, "relations")).toBe(true);
    expect(hasSubtabEntry(config, "log")).toBe(false);
    expect(hasSubtabEntry(config, "wheel")).toBe(false);
  });

  it("被 off 的能力成为唯一推进路径时必须保留最小形态", () => {
    const config = ui({ wheel: "off", battle: "off", event: "off", log: "off" });
    expect(requiresMinimalForm(config, "wheel", "random")).toBe(true);
    expect(requiresMinimalForm(config, "battle", "combat")).toBe(true);
    expect(requiresMinimalForm(config, "event", "normal")).toBe(true);
    expect(requiresMinimalForm(config, "wheel", "combat")).toBe(false); // 不是它的路径
    expect(requiresMinimalForm(config, "wheel", null)).toBe(false);
    expect(requiresMinimalForm(config, "log", "normal" as never)).toBe(false);
  });
});
