import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerExtensionRuntime, resetExtensionRuntimes } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import { loadTemplates, type TemplateRegistry } from "../../apps/server/src/templates.ts";

/**
 * `kinship_conflict` 拒载（`docs/FAMILY-GRAPH.md` §1/§2）：亲缘两种合规写法互斥。
 *
 * 判据：`extensions.family` 存在 **且** `characters[].relations[]` 里任一条 `kind` 属于
 * `KinshipKind`（`father` / `mother` / `wife` / `son` / `daughter` / `elder-sister` /
 * `relative` …）⇒ 该版本不可载、封闭码 `kinship_conflict`、不崩进程。
 *
 * 四条锁定：
 * 1. family + `wife` 边 ⇒ 不可载，码 + reason 点名角色与 kind；
 * 2. family + 只有 `friend` 边 ⇒ 可载（社会边两种模式都合法）；
 * 3. 不装 family + `father` 边 ⇒ 可载（模式一合法）；
 * 4. family + 无任何 relations ⇒ 可载（模式二合法，本轮指针未接线也能载）。
 */
const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

const CLEAN_VERSION = path.resolve("test/fixtures/templates/p0/1.0.0");

/** 往 `characters.yaml` 末尾追加一个新角色；`relationsYaml` 是它 relations 段的正文（已缩进）。 */
function appendCharacter(charactersFile: string, relationsYaml: string): void {
  const block = [
    "  - id: npc-kin",
    "    isEnemy: false",
    "    visibility: public",
    "    identity:",
    "      name: 测试亲属",
    "      age: 20",
    "      gender: f",
    "    mood:",
    "      value: 50",
    "    attributes:",
    "      cursedEnergy: 3",
    "      agility: 3",
    "      luck: 0",
    "    skills: []",
    "    public:",
    "      personality: 测试用亲属",
    "    private: {}",
    "    relationship: 10",
    ...(relationsYaml === "" ? [] : ["    relations:", relationsYaml]),
    "",
  ].join("\n");
  writeFileSync(charactersFile, `${readFileSync(charactersFile, "utf8")}\n${block}`);
}

/**
 * 建两版本目录：干净 `1.0.0`（陪跑，保证 `loadTemplates` 有可载版本）+
 * 被改造的 `2.0.0`（要测的那份）。
 */
function templateVariant(options: {
  family: boolean;
  relationsYaml?: string;
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "life-sim-kinship-"));
  cpSync(CLEAN_VERSION, path.join(dir, "p0", "1.0.0"), { recursive: true });
  const versionDir = path.join(dir, "p0", "2.0.0");
  cpSync(CLEAN_VERSION, versionDir, { recursive: true });
  if (options.family) {
    const worldFile = path.join(versionDir, "world.yaml");
    writeFileSync(worldFile, `${readFileSync(worldFile, "utf8")}\nextensions:\n  family: true\n`);
  }
  if (options.relationsYaml !== undefined) {
    appendCharacter(path.join(versionDir, "characters.yaml"), options.relationsYaml);
  }
  return dir;
}

function loadFrom(dir: string): TemplateRegistry {
  const previous = process.env.TEMPLATES_DIR;
  process.env.TEMPLATES_DIR = dir;
  try {
    return loadTemplates(silentLogger);
  } finally {
    if (previous === undefined) delete process.env.TEMPLATES_DIR;
    else process.env.TEMPLATES_DIR = previous;
  }
}

function listedVersion(registry: TemplateRegistry, version: string) {
  return registry
    .listTemplates()
    .flatMap((template) => template.versions)
    .find((entry) => entry.version === version)!;
}

describe("kinship_conflict：装了 family 又写亲属边 ⇒ 该版本不可载", () => {
  beforeEach(() => registerExtensionRuntime(familyExtension));
  afterEach(() => resetExtensionRuntimes());

  it("family + wife 边 ⇒ loadable:false + kinship_conflict，reason 含角色与 kind", () => {
    const dir = templateVariant({
      family: true,
      relationsYaml: "      - to: npc-friend\n        kind: wife\n",
    });
    try {
      // 不 throw：一个自相矛盾的模板不该把整台服务打挂。
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })).toBeUndefined();
      // 干净版本照常可载。
      expect(registry.resolve({ id: "p0", version: "1.0.0" })).toBeDefined();

      const listed = listedVersion(registry, "2.0.0");
      expect(listed.loadable).toBe(false);
      if (listed.loadable) throw new Error("unreachable");
      expect(listed.reasonCode).toBe("kinship_conflict");
      expect(listed.reason).toContain("npc-kin");
      expect(listed.reason).toContain("npc-friend");
      expect(listed.reason).toContain("wife");
      expect(listed.reason).toContain("extensions.family");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("family + 只有 friend 边 ⇒ 可载（社会边不属于亲缘）", () => {
    const dir = templateVariant({
      family: true,
      relationsYaml: "      - to: npc-friend\n        kind: friend\n",
    });
    try {
      const registry = loadFrom(dir);
      const entry = registry.resolve({ id: "p0", version: "2.0.0" });
      expect(entry).toBeDefined();
      expect(entry?.template.characters.map((c) => c.id)).toContain("npc-kin");
      expect(listedVersion(registry, "2.0.0").loadable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不装 family + father 边 ⇒ 可载（模式一：模板自己维护亲缘）", () => {
    const dir = templateVariant({
      family: false,
      relationsYaml: "      - to: npc-friend\n        kind: father\n",
    });
    try {
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })).toBeDefined();
      expect(listedVersion(registry, "2.0.0").loadable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("装 family + 无任何 relations ⇒ 可载（模式二）", () => {
    const dir = templateVariant({ family: true });
    try {
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })).toBeDefined();
      expect(listedVersion(registry, "2.0.0").loadable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
