import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  OpeningTemplateSchema,
  WorldTemplateV2Schema,
  type OpeningTemplate,
  type WorldTemplateV2,
} from "@life-sim/shared";

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

/** 开局是可选分域（协议 §3）：按文件存在性加载，不并入 WorldTemplateV2，不改 API 契约形状。 */
const openingTemplates = new Map<string, OpeningTemplate[]>();

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

/** 读取可选 opening.yaml；校验失败（含缺字段路径）直接抛错，由启动期 fail-fast 拦截。 */
function loadOpenings(dir: string): OpeningTemplate[] {
  const file = path.join(dir, "opening.yaml");
  if (!existsSync(file)) return [];
  const doc: unknown = parse(readFileSync(file, "utf8"));
  const list = z.array(OpeningTemplateSchema).parse(doc);
  const ids = new Set<string>();
  for (const t of list) {
    if (ids.has(t.openingId)) throw new Error(`openingId 重复：${t.openingId}（${file}）`);
    ids.add(t.openingId);
  }
  return list;
}

export function loadTemplates(): Map<string, WorldTemplateV2> {
  const dir = templatesDir();
  if (!existsSync(dir)) throw new Error(`templates_dir_missing: ${dir}`);
  const templates = new Map<string, WorldTemplateV2>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const template = loadTemplate(path.join(dir, entry.name));
    templates.set(template.meta.id, template);
    const openings = loadOpenings(path.join(dir, entry.name));
    if (openings.length > 0) openingTemplates.set(template.meta.id, openings);
  }
  if (templates.size === 0) throw new Error(`no_templates_found_in: ${dir}`);
  return templates;
}

/** 供 store.create 接线开局；未提供 opening.yaml 的世界返回空数组（走最小默认开局）。 */
export function getOpeningTemplates(templateId: string): OpeningTemplate[] {
  return openingTemplates.get(templateId) ?? [];
}
