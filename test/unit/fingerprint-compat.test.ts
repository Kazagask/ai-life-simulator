import { describe, expect, it } from "vitest";
import type { WorldTemplateV2 } from "@life-sim/shared";
import {
  semanticFingerprintOf,
  semanticLegacyFingerprintOf,
} from "@life-sim/template-loader";
import { FINGERPRINT_VERSION, fingerprintVerdict, upgradeRecord } from "../../apps/web/src/local/worldRepo.ts";

/**
 * 指纹兼容（2026-11-24 · 迭代 character-media · P0 / T-03）。
 *
 * 两件事必须成立：
 * 1. **只改媒体配置，语义指纹不变** —— 否则加一张立绘就把所有旧档判成漂移；
 * 2. **换算法本身不能打死旧档** —— 旧值走一次 legacy 通道，命中就放行并升级。
 *
 * 安全性依据是「存档值 == 当前模板用**同一套旧算法**算出的值」，不是「legacy 与 v2 相等」。
 */

const untyped = (extensions: unknown[] = []): WorldTemplateV2 => ({ extensions }) as unknown as WorldTemplateV2;

const files = (over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    "world.yaml": "world: 1",
    "skills.yaml": "skills: 1",
    "events.yaml": "events: 1",
    "ui.yaml": "ui: 1",
  };
  return Object.entries({ ...base, ...over }).map(([rel, content]) => ({ rel, content }));
};

describe("语义指纹与资源指纹", () => {
  it("加/改 assets/manifest.yaml 不动语义指纹，只动 legacy", () => {
    const before = semanticFingerprintOf(files(), untyped());
    const withManifest = semanticFingerprintOf(files({ "assets/manifest.yaml": "assets: 1" }), untyped());
    expect(withManifest).toBe(before);

    const legacyBefore = semanticLegacyFingerprintOf(files(), untyped());
    const legacyWithManifest = semanticLegacyFingerprintOf(files({ "assets/manifest.yaml": "assets: 1" }), untyped());
    expect(legacyWithManifest).not.toBe(legacyBefore);
  });

  it("只改 ui.yaml：语义指纹与 legacy 都不动", () => {
    const a = files();
    const b = files({ "ui.yaml": "ui: 2" });
    expect(semanticFingerprintOf(b, untyped())).toBe(semanticFingerprintOf(a, untyped()));
    expect(semanticLegacyFingerprintOf(b, untyped())).toBe(semanticLegacyFingerprintOf(a, untyped()));
  });

  it("改机制文件（skills.yaml）：两个指纹都变", () => {
    const a = files();
    const b = files({ "skills.yaml": "skills: 2" });
    expect(semanticFingerprintOf(b, untyped())).not.toBe(semanticFingerprintOf(a, untyped()));
    expect(semanticLegacyFingerprintOf(b, untyped())).not.toBe(semanticLegacyFingerprintOf(a, untyped()));
  });
});

describe("旧档兼容判据", () => {
  const current = { v2: "sha256:v2", legacy: "sha256:legacy" };
  const record = (fingerprint: string, fingerprintVersion?: number) =>
    ({ id: "w", formatVersion: 1, savedAt: "", ref: { id: "t", version: "1" }, fingerprint, state: {}, ...(fingerprintVersion !== undefined ? { fingerprintVersion } : {}) }) as never;

  it("已标记版本的档命中新值 ⇒ ok", () => {
    expect(fingerprintVerdict(record("sha256:v2", FINGERPRINT_VERSION), current)).toBe("ok");
  });

  it("命中新值但**还没标记版本** ⇒ 仍然 upgrade（补写版本号）", () => {
    expect(fingerprintVerdict(record("sha256:v2"), current)).toBe("upgrade");
  });

  it("未知版本号 ⇒ drift（不猜、不降级）", () => {
    expect(fingerprintVerdict(record("sha256:v2", 99), current)).toBe("drift");
  });

  it("旧值命中 legacy ⇒ upgrade（一次性通道）", () => {
    expect(fingerprintVerdict(record("sha256:legacy"), current)).toBe("upgrade");
  });

  it("带新版本号的档不再回落 legacy", () => {
    expect(fingerprintVerdict(record("sha256:legacy", FINGERPRINT_VERSION), current)).toBe("drift");
  });

  it("两个都不命中 ⇒ drift（真正的机制漂移）", () => {
    expect(fingerprintVerdict(record("sha256:other"), current)).toBe("drift");
  });

  it("升级只改指纹字段，并写下版本号", () => {
    const upgraded = upgradeRecord(record("sha256:legacy"), "sha256:v2");
    expect(upgraded.fingerprint).toBe("sha256:v2");
    expect(upgraded.fingerprintVersion).toBe(FINGERPRINT_VERSION);
    expect(upgraded.id).toBe("w");
  });
});
