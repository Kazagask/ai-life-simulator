import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OpeningTemplate, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { WorldStateV2Schema } from "@life-sim/shared";
import {
  createDefaultOpeningTemplate,
  createLookup,
  createRunnerContext,
  createWorldV2,
  handoff,
  runOpening,
  selectOpeningTemplate,
  type OpeningRunnerContext,
} from "@life-sim/game-core";
import { getOpeningTemplates, getTemplateFingerprint } from "./templates.js";

/**
 * 世界仓储（R-PS-01..06 / ADR-0007）：
 * - 内存 Map 为主存取层，落盘为持久层（save / seal / create 内同步写）；
 * - 单局一文件 `<worldId>.json`，信封 { schemaVersion, savedAt, templateId, templateFingerprint, state }；
 * - 原子写：`.tmp` + rename，失败删 tmp 并抛错（不吞异常）；
 * - 数据目录：默认仓库根 `data/worlds/`（按模块位置解析，不依赖 cwd），
 *   `LIFE_SIM_DATA_DIR` 环境变量可覆盖为任意绝对路径以支持挂载（2026-11-11 用户裁决）。
 */

/**
 * R2.5（ADR-0007）：信封 1 → 2。世界状态新增实例层延时队列与事实层记录，
 * 旧档无法机械推导，一律拒载；加载器对 schemaVersion !== 2 记 error 跳过。
 */
const SCHEMA_VERSION = 2;

/** 内存保存时间（savedAt），列表接口按其倒序。 */
const savedAtById = new Map<string, string>();

interface StoreEnvelope {
  schemaVersion: number;
  savedAt: string;
  templateId: string;
  templateFingerprint: string;
  state: WorldStateV2;
}

export function dataDir(): string {
  const override = process.env.LIFE_SIM_DATA_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  // apps/server/src → 仓库根/data/worlds（与 templates.ts 的仓库根解析一致，不依赖 cwd）
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/worlds");
}

function worldFile(id: string): string {
  // id 为 randomUUID，无路径分隔符风险；防御性校验兜底
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid_world_id: ${id}`);
  }
  return path.join(dataDir(), `${id}.json`);
}

/** 原子落盘（R-PS-03）：tmp → rename；失败删 tmp 并把错误抛给调用方。 */
function persist(state: WorldStateV2, templateId: string): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const fingerprint = getTemplateFingerprint(templateId) ?? "sha256:unknown";
  const savedAt = new Date().toISOString();
  const envelope: StoreEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    templateId,
    templateFingerprint: fingerprint,
    state,
  };
  const target = worldFile(state.id);
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(envelope, null, 2), "utf-8");
    renameSync(tmp, target); // 同分区原子替换
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理失败不掩盖原错误
    }
    throw error;
  }
  savedAtById.set(state.id, savedAt);
}

/**
 * 启动加载（R-PS-05）：扫目录逐个校验，四道关任一不过 log.error 跳过（不阻断启动）：
 * JSON.parse → schemaVersion → 模板指纹 → WorldStateV2Schema。
 * 返回 { loaded, errors } 供启动日志汇总。
 */
export function loadPersistedWorlds(currentFingerprints: Map<string, string>): {
  loaded: WorldStateV2[];
  errors: Array<{ file: string; reason: string }>;
} {
  const dir = dataDir();
  const loaded: WorldStateV2[] = [];
  const errors: Array<{ file: string; reason: string }> = [];
  if (!existsSync(dir)) return { loaded, errors };
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const file = path.join(dir, entry);
    let envelope: StoreEnvelope;
    try {
      envelope = JSON.parse(readFileSync(file, "utf-8")) as StoreEnvelope;
    } catch {
      errors.push({ file, reason: "json_parse_failed" });
      continue;
    }
    if (envelope.schemaVersion !== SCHEMA_VERSION) {
      errors.push({ file, reason: `schema_version_mismatch: ${String(envelope.schemaVersion)}` });
      continue;
    }
    const current = currentFingerprints.get(envelope.templateId);
    if (current === undefined || envelope.templateFingerprint !== current) {
      errors.push({ file, reason: "template_fingerprint_mismatch" });
      continue;
    }
    const parsed = WorldStateV2Schema.safeParse(envelope.state);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({ file, reason: `state_schema_invalid: ${issue?.path.join(".") || "unknown"}` });
      continue;
    }
    loaded.push(parsed.data as WorldStateV2);
    savedAtById.set(parsed.data.id, envelope.savedAt);
  }
  return { loaded, errors };
}

const worlds = new Map<string, WorldStateV2>();

/** 启动时把校验通过的存档装入内存（loadTemplates 之后、listen 之前调用一次）。 */
export function hydrate(loaded: WorldStateV2[]): void {
  for (const state of loaded) worlds.set(state.id, state);
}

export interface CreateWorldInputV2 {
  templateId: string;
  playerName: string;
  seed?: number;
  /** R-OP-01：多开局模板时按 openingId 选择；省略则取加载顺序首个。 */
  openingId?: string;
}

export const worldStore = {
  create(input: CreateWorldInputV2, template: WorldTemplateV2): WorldStateV2 {
    const base = createWorldV2(input, template, randomUUID());
    // 开局为可选分域：提供 opening.yaml 时跑自定义开局，否则用最小默认开局；
    // 两条路径都执行 runOpening + handoff，使新世界 openingCompleted === true。
    // 本轮按 openingId 选择（R-OP-01）；未指定时取加载顺序首个。
    const openings = getOpeningTemplates(template.meta.id);
    const selected = selectOpeningTemplate(openings, input.openingId);
    if (input.openingId !== undefined && !selected) {
      // 路由层已返回 404；store 层再做一次防御性拒绝，避免静默回退到默认开局。
      throw new Error(`opening_not_found: ${input.openingId}`);
    }
    const tpl: OpeningTemplate = selected ?? createDefaultOpeningTemplate();
    const ctx: OpeningRunnerContext = {
      ...createRunnerContext(base.seed),
      lookup: createLookup(template),
    };
    const { state: opened, run } = runOpening(base, tpl, ctx);
    const world = handoff(opened, run);
    worlds.set(world.id, world);
    persist(world, world.templateId);
    return world;
  },
  get(id: string): WorldStateV2 | undefined {
    return worlds.get(id);
  },
  save(state: WorldStateV2): void {
    // R-AR-02 / R-EV-06 / P3：归档只读。已归档世界（store 内或传入状态）拒绝任何写入。
    const existing = worlds.get(state.id);
    if (state.archived === true || existing?.archived === true) {
      throw new Error("[ARCHIVED] 本局已归档，只读，拒绝写入世界状态");
    }
    worlds.set(state.id, state);
    persist(state, state.templateId);
  },
  /**
   * 归档封存入口（#30 遗留补齐）：把已终止世界置 archived=true 并落库+落盘。
   * 这是 save() 的**唯一**例外通道——save() 拒绝 archived 写入，封存必须走这里。
   * 未终止世界拒绝封存（R-AR-01 需要终止记录）。
   */
  seal(state: WorldStateV2): WorldStateV2 {
    if (state.termination === null) {
      throw new Error("[archive_requires_termination] 尚未终止，拒绝归档");
    }
    const sealed: WorldStateV2 = state.archived === true ? state : { ...state, archived: true };
    worlds.set(sealed.id, sealed);
    persist(sealed, sealed.templateId);
    return sealed;
  },
  /** savedAt（最近保存时间），世界不存在时返回 undefined。 */
  savedAt(id: string): string | undefined {
    return savedAtById.get(id);
  },
  /** 全部世界（供列表接口；排序由调用方决定）。 */
  all(): WorldStateV2[] {
    return [...worlds.values()];
  },
  /**
   * 删除世界（R-PS-04）：删文件 + 删内存条目。不存在时报错由路由层映射 404。
   * 归档世界也可删除——删除是管理操作，不受只读门禁约束（否则目录只增不减）。
   */
  delete(id: string): void {
    if (!worlds.has(id)) throw new Error("world_not_found");
    worlds.delete(id);
    savedAtById.delete(id);
    const file = worldFile(id);
    if (existsSync(file)) unlinkSync(file);
  },
};

export type { WorldTemplateV2 };
