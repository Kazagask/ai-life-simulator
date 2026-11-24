import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryTemplateSource } from "@life-sim/shared";
import { loadTemplateBundle, type TemplateBundle } from "@life-sim/template-loader";
import { createClientGateway } from "../../apps/web/src/local/agent.ts";
import { LocalSession, commitLocalWorld, startOpening, stepOpening } from "../../apps/web/src/local/session.ts";

/**
 * T6：浏览器内 LLM 网关（ADR-070 第三期）。
 *
 * 守两条边界：
 * 1. **没有 key 就不接线** —— 回合走模板兜底，这是正式路径不是降级；
 * 2. 有 key 时网关建在**世界活状态**上（`story.submitBranch` 写的是同一份 state，
 *    不是快照副本）。
 */

const VERSION_DIR = path.join("specs", "data", "templates", "jjk-2006", "3.0.0");
const FILES = [
  "world.yaml", "characters.yaml", "skills.yaml", "items.yaml", "statuses.yaml", "events.yaml",
  "equipment.yaml", "combat-ai.yaml", "opening.yaml", "endings.yaml", "evaluation.yaml",
  "rules.yaml", "lore.md", "assets/manifest.yaml", "ui.yaml",
];

function bundleOf(): TemplateBundle {
  const files: Record<string, string> = {};
  for (const rel of FILES) {
    try {
      files[rel] = readFileSync(path.join(VERSION_DIR, rel), "utf8");
    } catch {
      /* 可选分域 */
    }
  }
  return loadTemplateBundle(new MemoryTemplateSource(files));
}

function worldOf(bundle: TemplateBundle) {
  const started = startOpening(bundle, 99);
  let cursor = started.node;
  let walker = started.core;
  while (cursor !== null && !walker.done) {
    const step =
      cursor.mode === "roll"
        ? ({ kind: "roll" } as const)
        : cursor.mode === "choose"
          ? ({ kind: "choose", optionId: cursor.options[0]!.id } as const)
          : cursor.mode === "input"
            ? // 姓名格（ADR-072 D7）：交空串 = 用预填，等价于点「就这个」。
              ({ kind: "input", value: "" } as const)
            : ({
                kind: "allocate",
                allocation: Object.fromEntries(
                  cursor.allocation!.targets.map((t, i) => [t.attribute, i === 0 ? cursor.allocation!.budget : 0]),
                ),
              } as const);
    const result = stepOpening(bundle, walker, step);
    walker = result.core;
    cursor = result.node;
  }
  return commitLocalWorld(bundle, walker, "local-agent");
}

describe("浏览器内 LLM 网关", () => {
  it("没有配置 ⇒ 不建网关（无 key 可跑是正式路径）", () => {
    const bundle = bundleOf();
    const state = worldOf(bundle);
    expect(createClientGateway(bundle, state, null)).toBeNull();
    expect(createClientGateway(bundle, state, { baseUrl: "https://x", model: "", apiKey: "k" })).toBeNull();
  });

  it("有配置 ⇒ 建得出网关；装到会话上才生效", () => {
    const bundle = bundleOf();
    const state = worldOf(bundle);
    const gateway = createClientGateway(bundle, state, {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "sk-test",
    });
    expect(gateway).not.toBeNull();

    const session = new LocalSession(bundle, "sha256:x", state);
    expect(session.hasGateway).toBe(false);
    session.setGateway(gateway);
    expect(session.hasGateway).toBe(true);
    session.setGateway(null);
    expect(session.hasGateway).toBe(false);
  });
});
