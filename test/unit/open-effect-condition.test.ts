import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkAllConditions,
  createRng,
  registerExtensionRuntime,
  resetExtensionRuntimes,
  type TemplateLookup,
} from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";
import type { WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { loadTemplates, type TemplateRegistry } from "../../apps/server/src/templates.ts";

/**
 * 模板边界上的**开放形**效果与条件（`{ type }` / `{ op, args }`）。
 *
 * 锁四件事：
 * 1. 模板能写扩展定义的效果与条件 —— schema 不再是闭合的 27 种 / 10 种；
 * 2. **加载期 fail-fast 不因此丢掉**：开放形必须在模板**已声明**的扩展里有实现，
 *    否则该版本不可载（`unknown_effect_type` / `unknown_condition_op`），服务照常启动；
 * 3. 内核 27 种效果与既有扁平条件照旧通过（回归锁）；
 * 4. 开放形条件在运行期真的会被求值（不是「能载入、永远 false」的空壳）。
 *
 * 变异验证：把 `templates.ts` 的 `assertOpenVocabularyDeclared` 调用去掉 ⇒ 用例 2/3/5 必红。
 */
const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };
const FIXTURE = path.resolve("test/fixtures/templates/p0/1.0.0");

/**
 * 造一份「一个干净版本 + 一个被改过的版本」的模板目录（同 `unknown-extension.test.ts`）：
 * `p0/1.0.0` 原样复制保证 `loadTemplates` 至少有一个可载版本，改过的放 `p0/2.0.0`。
 */
function templatesWith(patch: { world?: string; events?: string }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "life-sim-open-"));
  cpSync(FIXTURE, path.join(dir, "p0", "1.0.0"), { recursive: true });
  const versionDir = path.join(dir, "p0", "2.0.0");
  cpSync(FIXTURE, versionDir, { recursive: true });
  const append = (file: string, text: string): void => {
    const target = path.join(versionDir, file);
    writeFileSync(target, `${readFileSync(target, "utf8")}\n${text}`);
  };
  if (patch.world !== undefined) append("world.yaml", patch.world);
  if (patch.events !== undefined) append("events.yaml", patch.events);
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

/** `p0/2.0.0` 的注册结果（invalid 时带 reason / reasonCode）。 */
function versionEntry(registry: TemplateRegistry): {
  loadable: boolean;
  reason?: string;
  reasonCode?: string;
} {
  const listed = registry
    .listTemplates()
    .flatMap((template) => template.versions)
    .find((version) => version.id === "p0" && version.version === "2.0.0");
  if (listed === undefined) throw new Error("p0@2.0.0 未注册");
  return listed.loadable
    ? { loadable: true }
    : { loadable: false, reason: listed.reason, reasonCode: listed.reasonCode };
}

/** 事件里带一条开放形效果（`joinClan` 是 family 扩展注册的效果）。 */
const OPEN_EFFECT_EVENT = `  - id: ev:ext-effect
    title: 扩展效果
    narrative: 走扩展定义的效果。
    trigger:
      source: chain
    kind: normal
    settle:
      normal:
        options:
          - id: opt-ext
            text: 加入宗族
            effects:
              - type: joinClan
                clanId: clan-x
`;

/** 事件里带开放形条件（触发条件 + 选项可见条件各一处）。 */
const OPEN_CONDITION_EVENT = `  - id: ev:ext-condition
    title: 扩展条件
    narrative: 走扩展定义的条件。
    trigger:
      source: chain
      conditions:
        - op: inClan
          args:
            clanId: clan-x
    kind: normal
    settle:
      normal:
        options:
          - id: opt-ext
            text: 只有族人才看得到
            visibleWhen:
              - op: inClan
                args:
                  clanId: clan-x
`;

/** 一条内核效果 + 一个扁平条件：开放形放宽后这些必须逐字照旧。 */
const KERNEL_VOCAB_EVENT = `  - id: ev:kernel-vocab
    title: 内核词表
    narrative: 内核效果与扁平条件。
    trigger:
      source: chain
      conditions:
        - flag: openingDone
          eq: true
    kind: normal
    settle:
      normal:
        options:
          - id: opt-kernel
            text: 置旗标
            effects:
              - type: setFlag
                id: extKernel
                value: 1
`;

describe("开放形效果：模板能写扩展效果，且加载期仍 fail-fast", () => {
  afterEach(() => resetExtensionRuntimes());

  it("声明了 family ⇒ 模板里的 joinClan 可载", () => {
    const dir = templatesWith({ world: "extensions:\n  family: true", events: OPEN_EFFECT_EVENT });
    try {
      registerExtensionRuntime(familyExtension);
      const registry = loadFrom(dir);
      const entry = registry.resolve({ id: "p0", version: "2.0.0" });
      expect(entry?.template.extensions).toEqual({ family: true });
      // 开放形效果原样留在模板里（没被 normalize 掉，运行时靠它分发到扩展）
      const [event] = entry!.template.events.filter((e) => e.id === "ev:ext-effect");
      expect(event?.kind).toBe("normal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一份效果但不声明 extensions ⇒ invalid + unknown_effect_type（不崩服务）", () => {
    const dir = templatesWith({ events: OPEN_EFFECT_EVENT });
    try {
      registerExtensionRuntime(familyExtension);
      // 关键：loadTemplates 不 throw —— 缺能力只打掉这一个版本。
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })).toBeUndefined();
      expect(registry.resolve({ id: "p0", version: "1.0.0" })).toBeDefined();
      const entry = versionEntry(registry);
      expect(entry.loadable).toBe(false);
      expect(entry.reasonCode).toBe("unknown_effect_type");
      expect(entry.reason).toContain('"joinClan"');
      expect(entry.reason).toContain("（未声明任何扩展）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("声明了 family 也救不了谁都没注册的 { type: nope } ⇒ unknown_effect_type", () => {
    const dir = templatesWith({
      world: "extensions:\n  family: true",
      events: OPEN_EFFECT_EVENT.replace("type: joinClan", "type: nope"),
    });
    try {
      registerExtensionRuntime(familyExtension);
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })).toBeUndefined();
      const entry = versionEntry(registry);
      expect(entry.reasonCode).toBe("unknown_effect_type");
      expect(entry.reason).toContain('"nope"');
      expect(entry.reason).toContain("family");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("内核效果漏字段不会被当成扩展效果吞掉（仍然是 template_invalid）", () => {
    // `{ type: setFlag, id }` 少了 value：开放形 catchall 会收下它，
    // 所以 schema 必须按内核 type 复核 —— 否则运行期会把 undefined 写进 flags。
    const dir = templatesWith({
      world: "extensions:\n  family: true",
      events: KERNEL_VOCAB_EVENT.replace("              - type: setFlag\n                id: extKernel\n                value: 1", "              - type: setFlag\n                id: extKernel"),
    });
    try {
      registerExtensionRuntime(familyExtension);
      expect(() => loadFrom(dir)).toThrow(/template_invalid/);
      expect(() => loadFrom(dir)).toThrow(/value/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("开放形条件：事件里能写扩展 op，同样保住加载期裁定", () => {
  afterEach(() => resetExtensionRuntimes());

  it("声明了 family ⇒ 事件的 conditions / visibleWhen 写 { op: inClan } 可载", () => {
    const dir = templatesWith({
      world: "extensions:\n  family: true",
      events: OPEN_CONDITION_EVENT,
    });
    try {
      registerExtensionRuntime(familyExtension);
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })?.ref).toEqual({
        id: "p0",
        version: "2.0.0",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不声明 family ⇒ invalid + unknown_condition_op", () => {
    const dir = templatesWith({ events: OPEN_CONDITION_EVENT });
    try {
      registerExtensionRuntime(familyExtension);
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })).toBeUndefined();
      expect(registry.resolve({ id: "p0", version: "1.0.0" })).toBeDefined();
      const entry = versionEntry(registry);
      expect(entry.loadable).toBe(false);
      expect(entry.reasonCode).toBe("unknown_condition_op");
      expect(entry.reason).toContain('"inClan"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("回归锁：内核词表照旧通过", () => {
  afterEach(() => resetExtensionRuntimes());

  it("内核效果 + 扁平条件不需要任何扩展声明", () => {
    const dir = templatesWith({ events: KERNEL_VOCAB_EVENT });
    try {
      const registry = loadFrom(dir);
      expect(registry.resolve({ id: "p0", version: "2.0.0" })).toBeDefined();
      // 基线 fixture 也照旧可载（零回归）
      expect(registry.resolve({ id: "p0", version: "1.0.0" })).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rules.yaml 的开放形 op（eventResolved / always / flagSet）不受影响", () => {
    const dir = templatesWith({});
    try {
      const registry = loadFrom(dir);
      expect(registry.get({ id: "p0", version: "2.0.0" })?.status).toBe("ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("开放形条件在运行期真的会求值（不是永远 false）", () => {
  afterEach(() => resetExtensionRuntimes());

  it("已声明扩展的 op ⇒ 按实现求值；未注册 op ⇒ false", () => {
    registerExtensionRuntime({
      id: "probe",
      conditions: { probeOp: (args) => args.hit === true },
    });
    const template = { extensions: { probe: true } } as unknown as WorldTemplateV2;
    const state = { turnIndex: 0, flags: {} } as unknown as WorldStateV2;
    const ctx = {
      state,
      lookup: { template } as unknown as TemplateLookup,
      rng: createRng(1),
    };
    expect(checkAllConditions([{ op: "probeOp", args: { hit: true } }], ctx)).toBe(true);
    expect(checkAllConditions([{ op: "probeOp", args: { hit: false } }], ctx)).toBe(false);
    expect(checkAllConditions([{ op: "notRegistered", args: {} }], ctx)).toBe(false);
    // 扁平条件与开放形混写：数组内 AND
    expect(
      checkAllConditions([{ op: "probeOp", args: { hit: true } }, { random: 1 }], ctx),
    ).toBe(true);
  });
});
