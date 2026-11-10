import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { WorldTemplateV2Schema, type WorldTemplateV2 } from "@life-sim/shared";

/**
 * YAML 模板加载器（协议 V2 的模板唯一事实源）：
 * 每个子目录一个模板，world.yaml + characters.yaml + skills.yaml + items.yaml +
 * statuses.yaml + events.yaml 六文件合并，经 WorldTemplateV2Schema 严格校验后注册。
 * 启动期一次加载；校验失败直接抛错拒绝启动（fail-fast）。
 */

const TEMPLATE_FILES = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
] as const;

function templatesDir(): string {
  if (process.env.TEMPLATES_DIR) return path.resolve(process.env.TEMPLATES_DIR);
  // apps/server/src → 仓库根/specs/data/templates
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../specs/data/templates");
}

function loadTemplate(dir: string): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of TEMPLATE_FILES) {
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) continue;
    const doc = parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(doc)) {
      if (key === "meta") {
        merged.meta = value;
      } else if (merged[key] === undefined) {
        merged[key] = value;
      } else if (Array.isArray(merged[key]) && Array.isArray(value)) {
        merged[key] = [...(merged[key] as unknown[]), ...value];
      }
    }
  }
  const template = WorldTemplateV2Schema.parse(merged);
  return template;
}

export function loadTemplates(): Map<string, WorldTemplateV2> {
  const dir = templatesDir();
  if (!existsSync(dir)) throw new Error(`templates_dir_missing: ${dir}`);
  const templates = new Map<string, WorldTemplateV2>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const template = loadTemplate(path.join(dir, entry.name));
    templates.set(template.meta.id, template);
  }
  if (templates.size === 0) throw new Error(`no_templates_found_in: ${dir}`);
  return templates;
}
