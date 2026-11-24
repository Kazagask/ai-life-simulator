import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, fetchNarrative, setLocalEngine } from "../../apps/web/src/api.ts";
import type { LocalEngine } from "../../apps/web/src/local/transport.ts";

/**
 * 本地桥的**机械守卫**（ADR-070 第三期）。
 *
 * 这段代码以前靠人肉审计，漏过两次（`history` 让记录页每点一次就 `world_not_found`）。
 * 这里把「世界级接口在本地局一律不出网」变成可执行的断言：只要某个方法忘了接线，
 * 假 fetch 就会抛错，用例直接红。
 */

const WORLD = "local-probe";

/** 只实现被调用的那几个；其余方法统一记名并返回空快照。 */
function stubEngine(): { engine: LocalEngine; calls: string[] } {
  const calls: string[] = [];
  const target = {
    owns: (id: string) => id === WORLD,
    hasTemplate: () => true,
    listWorlds: () => [],
    narrative: () => ({ blocks: [] }),
    history: () => ({ history: [] }),
    archiveWorld: async () => ({ worldId: WORLD, archive: { snapshot: {} } }),
    getWorld: () => ({ worldId: WORLD, snapshot: {} }),
    createOpening: () => ({ sessionId: "local-open-1", seed: 1, node: null }),
    stepOpening: () => ({ node: null, done: false, results: [], gains: [] }),
    commitOpening: async () => ({ worldId: WORLD, snapshot: {}, gains: [] }),
  };
  const engine = new Proxy(target as unknown as LocalEngine, {
    get(obj, prop: string) {
      if (prop in obj) return (obj as unknown as Record<string, unknown>)[prop];
      return (..._args: unknown[]) => {
        calls.push(prop);
        return Promise.resolve({ worldId: WORLD, snapshot: { turnIndex: 1 }, gains: [] });
      };
    },
  });
  return { engine, calls };
}

let calls: string[] = [];

beforeEach(() => {
  const stub = stubEngine();
  calls = stub.calls;
  setLocalEngine(stub.engine);
  // 任何真实网络调用都算失败：本地局不该出网。
  globalThis.fetch = (() => {
    throw new Error("local world must not fetch");
  }) as typeof fetch;
});

afterEach(() => {
  setLocalEngine(null);
});

describe("本地局：世界级接口一律不出网", () => {
  it("读快照 / 历史 / 叙事 / 归档走本地引擎", async () => {
    await api.getWorld(WORLD);
    await api.history(WORLD);
    await fetchNarrative(WORLD);
    await api.archiveWorld(WORLD);
    expect(calls).toEqual([]);
  });

  it("推回合 / 选项 / 战斗 / 物品 / 穿脱 / 加点 / 改名 / 转盘 / 删除 全部本地", async () => {
    await api.advanceTurn(WORLD, { type: "rest", description: "" });
    await api.chooseOption(WORLD, "opt-1");
    await api.battleAction(WORLD, { type: "attack", skillId: "sk-1", targetId: "npc-1" } as never);
    await api.useItem(WORLD, "item-1");
    await api.equipItem(WORLD, "item-1");
    await api.unequipItem(WORLD, "inst-1");
    await api.submitAllocation(WORLD, "alloc-1", { grade: 1 });
    await api.renameWorld(WORLD, "新名字");
    await api.confirmWheel(WORLD);
    await api.deleteWorld(WORLD);
    expect(calls.sort()).toEqual(
      [
        "advanceTurn",
        "chooseOption",
        "battleAction",
        "useItem",
        "equipItem",
        "unequipItem",
        "submitAllocation",
        "renameWorld",
        "confirmWheel",
        "deleteWorld",
      ].sort(),
    );
  });

  it("远端世界（未持有）仍然走 HTTP —— 老档不受影响", async () => {
    let touched = false;
    globalThis.fetch = (async () => {
      touched = true;
      return new Response(JSON.stringify({ worldId: "remote", snapshot: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await api.getWorld("remote-world");
    expect(touched).toBe(true);
  });
});
