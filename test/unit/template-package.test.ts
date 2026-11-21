import { describe, expect, it } from "vitest";
import { loadTemplatePackage, type TemplatePackageLoadResult } from "@life-sim/template-loader";
import { registerServerExtensions } from "../../apps/server/src/extensions.ts";
import { loadTemplates, readDeclarativeFiles } from "../../apps/server/src/templates.ts";

/**
 * 模板包（ADR-070 第二期）：客户端拿到服务端下发的文件正文后，自己重跑一遍加载与校验。
 *
 * 这里守的是「同一份字节，两边算出同一个世界」——如果加载器、指纹或扩展版本任一处
 * 在客户端与服务端不一致，玩家会看到「下载成功但永远打不开」。
 */

const silent = { warn: () => {}, error: () => {}, info: () => {} };

registerServerExtensions();

function packageOf(id = "jjk-2006", version = "3.0.0") {
  const entry = loadTemplates(silent).resolve({ id, version });
  if (entry?.status !== "ready") throw new Error(`${id}@${version} 未就绪`);
  return {
    entry,
    pkg: {
      templateId: id,
      version,
      fingerprint: entry.semanticFingerprint,
      files: readDeclarativeFiles(entry.ref),
    },
  };
}

const reasonOf = (result: TemplatePackageLoadResult) => (result.ok ? "ok" : result.code);

describe("模板包：下载 → 校验（客户端视角）", () => {
  it("真实模板：文件齐全，客户端加载成功且指纹一致", () => {
    const { entry, pkg } = packageOf();
    expect(Object.keys(pkg.files)).toEqual(expect.arrayContaining(["world.yaml", "events.yaml", "lore.md"]));
    const result = loadTemplatePackage(pkg);
    expect(reasonOf(result)).toBe("ok");
    if (result.ok) {
      expect(result.fingerprint).toBe(entry.semanticFingerprint);
      expect(result.template.meta.id).toBe("jjk-2006");
    }
  });

  it("改一个字节 ⇒ 指纹对不上（拒绝「下载成功但内容被动过」）", () => {
    const { pkg } = packageOf();
    const tampered = { ...pkg, files: { ...pkg.files, "world.yaml": `${pkg.files["world.yaml"]}\n# tampered\n` } };
    expect(reasonOf(loadTemplatePackage(tampered))).toBe("fingerprint_mismatch");
  });

  it("缺必需文件 ⇒ template_invalid（不是「半个世界」）", () => {
    const { pkg } = packageOf();
    const files = { ...pkg.files };
    delete (files as Record<string, string>)["world.yaml"];
    expect(reasonOf(loadTemplatePackage({ ...pkg, files }))).toBe("template_invalid");
  });

  it("包封面与内容不一致 ⇒ package_invalid（A 的文件装进 B 的封套）", () => {
    const { pkg } = packageOf();
    expect(reasonOf(loadTemplatePackage({ ...pkg, templateId: "another-world" }))).toBe("package_invalid");
  });

  it("形状不对 ⇒ package_invalid（网络层拿到 HTML 也不炸客户端）", () => {
    expect(reasonOf(loadTemplatePackage({ nope: true }))).toBe("package_invalid");
    expect(reasonOf(loadTemplatePackage("<html>404</html>"))).toBe("package_invalid");
  });
});
