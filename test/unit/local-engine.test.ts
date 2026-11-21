import { describe, expect, it } from "vitest";
import { localStateDigest, runLocalEngineSelfCheck } from "../../apps/web/src/localEngine.ts";
import { advanceTurnV2, createLookup, createWorldV2 } from "@life-sim/game-core";
import { registerServerExtensions } from "../../apps/server/src/extensions.ts";
import { loadTemplates } from "../../apps/server/src/templates.ts";

/**
 * 本地引擎自检（ADR-070 第二期）：同一段代码要在浏览器里跑起来。
 *
 * Node 里没有 IndexedDB，所以 `persisted` 必然是 false —— 这里测的是
 * **引擎能被 web 侧模块调用且结果确定**；真正的落盘往返由浏览器实测覆盖
 * （`[local-engine] 自检通过 … 持久化=是`）。
 */

registerServerExtensions();

const silent = { warn: () => {}, error: () => {}, info: () => {} };

function templateOf() {
  const entry = loadTemplates(silent).resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready") throw new Error("jjk-2006@3.0.0 未就绪");
  return entry;
}

describe("本地引擎自检", () => {
  it("同模板 + 同 seed ⇒ 同一份摘要（可重复）", async () => {
    const entry = templateOf();
    const first = await runLocalEngineSelfCheck(entry.template, entry.semanticFingerprint, "3.0.0");
    const second = await runLocalEngineSelfCheck(entry.template, entry.semanticFingerprint, "3.0.0");
    expect(first.ok, first.ok ? "" : first.message).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.digest).toBe(second.digest);
    expect(first.turnIndex).toBe(1);
  });

  it("摘要对状态敏感：推进一步就变", () => {
    const entry = templateOf();
    const state = createWorldV2(
      { templateId: entry.ref.id, playerName: "摘要", seed: 7 },
      entry.template,
      "w-digest",
    );
    state.openingCompleted = true;
    const before = localStateDigest(state);
    advanceTurnV2(state, { action: { type: "rest", description: "" } }, entry.template, createLookup(entry.template));
    expect(localStateDigest(state)).not.toBe(before);
  });

  it("Node 环境没有 IndexedDB：不抛错，只是 persisted=false（浏览器里为 true）", async () => {
    const entry = templateOf();
    const result = await runLocalEngineSelfCheck(entry.template, entry.semanticFingerprint, "3.0.0");
    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(false);
  });
});
