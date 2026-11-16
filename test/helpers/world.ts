import path from "node:path";
import { createWorldV2, type WorldStateV2 } from "@life-sim/game-core";
import {
  loadTemplates,
  type ReadyTemplateEntry,
  type TemplateRegistry,
} from "../../apps/server/src/templates.ts";

const FIXTURE_TEMPLATES = path.resolve("test/fixtures/templates");

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

/** 测试只读 fixture 模板；默认的 specs/data/templates 会被写者改动，不能当稳定夹具。 */
export function loadFixtureRegistry(): TemplateRegistry {
  const previous = process.env.TEMPLATES_DIR;
  process.env.TEMPLATES_DIR = FIXTURE_TEMPLATES;
  try {
    return loadTemplates(silentLogger);
  } finally {
    if (previous === undefined) delete process.env.TEMPLATES_DIR;
    else process.env.TEMPLATES_DIR = previous;
  }
}

export function fixtureEntry(id = "p0"): ReadyTemplateEntry {
  const entry = loadFixtureRegistry().resolve({ id, version: "1.0.0" });
  if (entry === undefined) throw new Error(`fixture_template_not_ready: ${id}@1.0.0`);
  return entry;
}

/** 建一个未跑 opening 的世界；单测只关心投影/调度/战斗，不需要激活。 */
export function makeWorld(seed = 7): { state: WorldStateV2; entry: ReadyTemplateEntry } {
  const entry = fixtureEntry();
  const state = createWorldV2(
    { templateId: "p0", playerName: "测试玩家", seed },
    entry.template,
    `w-test-${seed}`,
  );
  return { state, entry };
}
