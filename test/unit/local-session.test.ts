import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MemoryTemplateSource, sha256Hex, stableStringify } from "@life-sim/shared";
import { loadTemplateBundle, type TemplateBundle } from "@life-sim/template-loader";
import {
  LocalSession,
  commitLocalWorld,
  startOpening,
  stepOpening,
  type OpeningCore,
} from "../../apps/web/src/local/session.ts";
import { EngineError } from "../../apps/web/src/local/errors.ts";
import { createLocalEngine } from "../../apps/web/src/local/transport.ts";
import { createMemoryWorldRepo } from "../../apps/web/src/local/worldRepo.ts";

/**
 * T3：本地引擎会话（ADR-070 第三期）。
 *
 * 守三件事：
 * 1. 开局 DAG 在纯层能走完并落成世界（含第一幕上桌）；
 * 2. 同一模板 + 同一 seed + 同一串输入 ⇒ 同一份状态摘要（确定性，不是"看起来能跑"）；
 * 3. core 的裸错误被收敛成带状态码的人话错误（UI 的 409 分支靠它）。
 */

const VERSION_DIR = path.join("specs", "data", "templates", "jjk-2006", "3.0.0");
const DECLARATIVE = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
  "opening.yaml",
  "endings.yaml",
  "evaluation.yaml",
  "rules.yaml",
  "lore.md",
  "assets/manifest.yaml",
  "ui.yaml",
] as const;

function bundleOf(): TemplateBundle {
  const files: Record<string, string> = {};
  for (const rel of DECLARATIVE) {
    try {
      files[rel] = readFileSync(path.join(VERSION_DIR, rel), "utf8");
    } catch {
      /* 可选分域 */
    }
  }
  return loadTemplateBundle(new MemoryTemplateSource(files));
}

/** 把开局走完：roll 直接掷，choose 取第一项，allocate 按预算铺满。 */
function playOpening(bundle: TemplateBundle, seed: number, name = "测试名字"): { core: OpeningCore; steps: number } {
  const started = startOpening(bundle, seed);
  let cursor = started.node;
  let walker = started.core;
  while (cursor !== null && !walker.done) {
    const step = (() => {
      if (cursor!.mode === "roll") return { kind: "roll" as const };
      if (cursor!.mode === "choose") {
        const optionId = cursor!.options[0]?.id;
        if (optionId === undefined) throw new Error(`choose 节点没有选项：${cursor!.nodeId}`);
        return { kind: "choose" as const, optionId };
      }
      // 姓名格（ADR-072 D7）：走开局流程时给一个合法值即可。
      if (cursor!.mode === "input") return { kind: "input" as const, value: name };
      const spec = cursor!.allocation;
      if (spec === undefined) throw new Error("allocate 节点缺少点数规格");
      let left = spec.budget;
      const allocation: Record<string, number> = {};
      for (const target of spec.targets) {
        const give = Math.max(target.min ?? 0, Math.min(target.max ?? left, left));
        allocation[target.attribute] = give;
        left -= give;
        if (left <= 0) break;
      }
      return { kind: "allocate" as const, allocation };
    })();
    const result = stepOpening(bundle, walker, step);
    walker = result.core;
    cursor = result.node;
  }
  return { core: walker, steps: walker.results.length };
}

describe("本地引擎会话", () => {
  it("开局 DAG 走完 → 建世界 → 第一幕上桌", async () => {
    const bundle = bundleOf();
    // 名字现在由开局里的「姓名」格决定（ADR-072 D7），不再靠 commit 的兜底参数。
    const { core } = playOpening(bundle, 20261122, "本地探针");
    const state = commitLocalWorld(bundle, core, "local-w1", "本地探针");

    expect(state.id).toBe("local-w1");
    expect(state.turnIndex).toBe(0);
    expect(state.player.name).toBe("本地探针");
    expect(state.slot).not.toBeNull();
  });

  it("同一 seed + 同一串输入 ⇒ 同一摘要（确定性）", async () => {
    const bundle = bundleOf();
    const a = commitLocalWorld(bundle, playOpening(bundle, 4242).core, "local-a");
    const b = commitLocalWorld(bundle, playOpening(bundle, 4242).core, "local-b");
    // id 不同是调用方给的，摘要前先对齐（其余字段必须逐字相等）。
    b.id = a.id;
    expect(sha256Hex(stableStringify(b))).toBe(sha256Hex(stableStringify(a)));
  });

  it("自建角色的 selfId 按出身区分（player-<origin>）", () => {
    const bundle = bundleOf();
    const state = commitLocalWorld(bundle, playOpening(bundle, 4242).core, "origin-id");
    expect(state.selfId).toMatch(/^player-(civilian|clan-branch|curse-family)$/);
  });

  it("推进一回合：先结掉第一幕，再自由行动；turnIndex 前进、收获是数组", async () => {
    const bundle = bundleOf();
    const session = new LocalSession(bundle, "sha256:test", commitLocalWorld(bundle, playOpening(bundle, 7).core, "local-turn"));

    // 建局后第一幕就在桌上：先把它选掉（这一步不推 turnIndex）。
    const optionId = session.snapshot().slotEvent?.options?.[0]?.id;
    expect(optionId).toBeDefined();
    const resolved = await session.choose(optionId!);
    expect(Array.isArray(resolved.gains)).toBe(true);
    expect(session.state.slot).toBeNull();

    const before = session.state.turnIndex;
    const res = await session.advance({ type: "rest", description: "" });

    expect(session.state.turnIndex).toBe(before + 1);
    expect(res.worldId).toBe("local-turn");
    expect(res.snapshot.turnIndex).toBe(before + 1);
    expect(Array.isArray(res.gains)).toBe(true);
    expect(res.snapshot.player.name.length).toBeGreaterThan(0);
    // 没有 LLM 也要有正文：模板兜底叙事块（2026-11-22「人生页空白」的回归点）。
    expect(session.narrativeBlocks.length).toBeGreaterThan(0);
    expect(session.narrativeBlocks.at(-1)?.kind).toBe("narrative");
  });

  it("core 的错误被收敛成带状态码的人话错误", async () => {
    const bundle = bundleOf();
    const session = new LocalSession(bundle, "sha256:test", commitLocalWorld(bundle, playOpening(bundle, 11).core, "local-err"));

    // 槽里有事件时自由行动 ⇒ pending_event_required（409）
    let caught: unknown;
    try {
      await session.advance({ type: "rest", description: "" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).status).toBe(409);
    expect((caught as EngineError).message).toContain("请求失败：");
  });

  it("改名只写 self 名字，不推进时间", async () => {
    const bundle = bundleOf();
    const session = new LocalSession(bundle, "sha256:test", commitLocalWorld(bundle, playOpening(bundle, 13).core, "local-rename"));
    const turnBefore = session.state.turnIndex;
    const timeBefore = session.state.worldTime;
    const res = session.rename("新名字");
    expect(res.snapshot.player.name).toBe("新名字");
    expect(session.state.turnIndex).toBe(turnBefore);
    expect(session.state.worldTime).toBe(timeBefore);
  });
});

describe("本地仓库 · 云端恢复", () => {
  const bundle = bundleOf();
  const state = commitLocalWorld(bundle, playOpening(bundle, 21).core, "cloud-1");
  const record = {
    id: state.id,
    formatVersion: 1 as const,
    savedAt: "2026-11-22T10:00:00.000Z",
    ref: { id: "jjk-2006", version: "3.0.0" },
    fingerprint: "sha256:test",
    state,
  };

  const engineWith = () => {
    const engine = createLocalEngine({
      repo: createMemoryWorldRepo(),
      now: () => "2026-11-22T12:00:00.000Z",
    });
    engine.registerTemplate({
      ref: { id: "jjk-2006", version: "3.0.0" },
      fingerprint: "sha256:test",
      bundle,
    });
    return engine;
  };

  it("importRecord 写库 + 建会话；listWorlds 用真实 savedAt（不是 now）", async () => {
    const engine = engineWith();
    await engine.importRecord(record);
    expect(engine.owns("cloud-1")).toBe(true);
    expect((await engine.readRecord("cloud-1"))?.savedAt).toBe(record.savedAt);
    expect(engine.listWorlds()[0]?.savedAt).toBe(record.savedAt);
  });

  it("指纹不同 ⇒ 409 拒载（绝不静默按新模板解释旧档）", async () => {
    const engine = engineWith();
    await expect(engine.importRecord({ ...record, fingerprint: "sha256:other" })).rejects.toMatchObject({
      status: 409,
    });
    expect(engine.owns("cloud-1")).toBe(false);
  });

  it("trace 按轮取出：不会把上一轮的锚到下一版存档", () => {
    const session = new LocalSession(bundle, "sha256:test", state, "3.0.0");
    session.recordTrace({ turnIndex: 3, invocationId: "inv-3" });
    session.recordTrace({ turnIndex: 4, invocationId: "inv-4" });
    expect(session.drainTracesForTurn(3)).toEqual([{ turnIndex: 3, invocationId: "inv-3" }]);
    expect(session.drainTracesForTurn(3)).toHaveLength(0);
    expect(session.drainTraces()).toHaveLength(1);
  });
});
