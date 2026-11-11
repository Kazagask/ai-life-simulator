import { randomUUID } from "node:crypto";
import type { OpeningTemplate, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
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
import { getOpeningTemplates } from "./templates.js";

/** 内存仓储：P0 阶段不持久化，重启即清空。 */
const worlds = new Map<string, WorldStateV2>();

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
  },
  /**
   * 归档封存入口（#30 遗留补齐）：把已终止世界置 archived=true 并落库。
   * 这是 save() 的**唯一**例外通道——save() 拒绝 archived 写入，封存必须走这里，
   * 否则归档态永远写不进去。未终止世界拒绝封存（R-AR-01 需要终止记录）。
   */
  seal(state: WorldStateV2): WorldStateV2 {
    if (state.termination === null) {
      throw new Error("[archive_requires_termination] 尚未终止，拒绝归档");
    }
    const sealed: WorldStateV2 = state.archived === true ? state : { ...state, archived: true };
    worlds.set(sealed.id, sealed);
    return sealed;
  },
};

export type { WorldTemplateV2 };
