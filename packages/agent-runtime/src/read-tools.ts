import type { V2Snapshot, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { KinshipKindSchema, SocialKindSchema } from "@life-sim/shared";

/**
 * GM 的**只读**工具（AGENTIC-GM 重构 · 设计 §3）。
 *
 * 一条查询一个工具，**不做上帝函数**：每个入参都对应一个独立语义，不存在"把整个世界给我"的口子。
 *
 * 视角：这些工具**不接受 perspective 参数**。视角在 invocation 时固定，
 * 数据来源是 `projectSnapshotV2` 已经裁好的 `V2Snapshot`（player 窗口）——
 * 也就是说"看不到的东西"在数据源上就不存在，不是靠过滤。
 *
 * 返回值一律是**给模型看的 JSON**，不带任何只对引擎有意义的字段（不泄露隐藏节点/敌人意图）。
 */
export const READ_TOOL_NAMES = [
  "world.now",
  "world.history",
  "world.present",
  "world.self",
  /**
   * 词表（2026-11-21）：**渐进披露**的入口。
   *
   * 为什么不在 invocation 里直接塞一份词表：它有几 KB（8 种效果形状 + 属性/资源/关系 kind +
   * 几十件物品 + 几十条状态），每轮都塞进 prompt 既贵又挤掉叙事素材。做成按需查询后，
   * 模型只在「要写效果」的那一步取一次，而且可以只看需要的一节。
   */
  "rule.lexicon",
] as const;

export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

export function isReadTool(name: string): name is ReadToolName {
  return (READ_TOOL_NAMES as readonly string[]).includes(name);
}

/** 历史默认条上限：防止一次查询把上下文撑爆。 */
const HISTORY_HARD_CAP = 50;

export interface ReadToolDeps {
  /** 已按 invocation 视角裁好的快照（player 窗口）。 */
  snapshot: V2Snapshot;
  /** 权威状态：只用于 history / world 窗口的全量读取。 */
  state: WorldStateV2;
  /**
   * 模板（只读）。`rule.lexicon` 需要它回答「有哪些属性 / 资源 / 物品 / 状态 / 关系 kind」。
   * 缺省 ⇒ 该工具只返回效果形状，不返回可引用清单（不臆造）。
   */
  template?: WorldTemplateV2;
  /**
   * 本次 invocation 的视角（由模板 `invoke.perspective` 声明，**不是工具参数**）。
   *
   * - `player` ⇒ 只读投影后的快照（看不到 hidden）；
   * - `world`  ⇒ 直读权威状态（GM 全知：含 NPC 隐秘与 hidden 章节节点）。
   *
   * 关键：模型**无法**通过传参改视角 —— 它连这个字段都看不见。
   */
  perspective: "world" | "player" | `npc:${string}`;
}

const isOmniscient = (perspective: ReadToolDeps["perspective"]): boolean =>
  perspective === "world";

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// ---------- rule.lexicon：词表（渐进披露） ----------

type LexiconSection = "index" | "effects" | "items" | "statuses";

const LEXICON_SECTIONS: LexiconSection[] = ["index", "effects", "items", "statuses"];

/** 关系 kind 的取值（与 `relationEdge.kind` 同一份枚举，不从模板猜）。 */
const RELATION_KINDS = [...KinshipKindSchema.options, ...SocialKindSchema.options];

/** 效果形状的词表：**与 `BranchEffectSchema` 一一对应**，多一种少一种都是 bug。 */
const EFFECT_SHAPES = [
  {
    name: "flag",
    shape: { flag: "<旗标名>", value: "true | 数字 | 字符串" },
    when: "要让之后的条件 / 分支记住「这件事发生过」",
    caveat: "模板不读的旗标对玩家零效果（它是作者记号，不是分数）",
  },
  {
    name: "mood",
    shape: { mood: -3 },
    when: "这件事让主角心里舒服 / 不舒服",
    caveat: "建议 ±1..10；心情是 0..100 的条",
  },
  {
    name: "hp",
    shape: { hp: -5 },
    when: "受伤 / 被治好了",
    caveat: "负数是伤害；别用它直接判死（死亡只走战斗或模板旗标）",
  },
  {
    name: "mp",
    shape: { mp: -5 },
    when: "消耗 / 恢复咒力",
  },
  {
    name: "spawn",
    shape: { spawn: "<alias | 角色id | 刷新规则id>" },
    when: "这一幕要把某个人拉上场（本次提交新造的人用 alias）",
  },
  {
    name: "relation",
    shape: { relation: { with: "<角色id>", to: 12 } },
    when: "他对你的态度变了",
    caveat: "改的是「他→你」的标量，建议 ±1..10",
  },
  {
    name: "relationEdge",
    shape: {
      relationEdge: { from: "<角色id|player>", to: "<角色id|player>", kind: "<关系 kind>", scope: "public | limited | private" },
    },
    when: "建立一条有向关系（拜师 / 结仇 / 亲缘）；scope=limited 必须给 knownBy",
  },
  {
    name: "secret",
    shape: { secret: { npc: "<角色id>", text: "<秘密内容>" } },
    when: "有人多了一个把柄 / 隐秘",
  },
  {
    name: "lifecycle",
    shape: { lifecycle: { npc: "<角色id>", state: "alive | inactive | unspawned" } },
    when: "让某人登场 / 离场（不用于死亡）",
  },
] as const;

/** 词表的一节。`section` 缺省 = 目录（渐进披露的第一跳）。 */
function lexiconOf(section: LexiconSection, deps: ReadToolDeps): unknown {
  const { snapshot, state } = deps;
  const template = deps.template;

  if (section === "index") {
    return {
      sections: [
        {
          id: "effects",
          what: "写选项效果前必看：9 种扁平形状 + 可引用的属性 / 资源 / 关系 kind / 在场角色",
        },
        { id: "items", what: "物品词表（id / 名字 / 类型 / 槽位），写「他递给你 X」时对齐名字" },
        { id: "statuses", what: "状态词表（id / 名字 / 三类生命周期），叙述里提到状态时对齐名字" },
      ],
      hint: "先用 section 取需要的那一节；写 story.submitBranch 的 effects 之前至少要取 effects。",
    };
  }

  if (template === undefined) {
    return { error: "该世界没有可查询的模板词表（模板未注入）" };
  }

  if (section === "effects") {
    const attrs = template.attributes;
    const player = snapshot.player;
    return {
      section: "effects",
      rule: "每个选项至少一条效果，且至少一条改数值（mood / hp / mp）；只写 flag 对玩家零效果。",
      shapes: EFFECT_SHAPES,
      attributes: attrs.order.map((id) => ({
        id,
        label: attrs.labels?.[id] ?? id,
        kind: attrs.defs?.[id]?.kind ?? "number",
        value: player.attributes?.[id] ?? attrs.defaults?.[id] ?? null,
        ...(attrs.caps?.[id] !== undefined ? { cap: attrs.caps[id] } : {}),
      })),
      resources: Object.entries(template.resources).map(([id, def]) => {
        // 快照里资源是 `ResourceView[]`（带 label / value / max），按 key 取当前值；
        // 模板只提供「有哪些资源」与兜底 label，不在这里重算上限。
        const view = player.resources.find((resource) => resource.key === id);
        return {
          id,
          label: view?.label ?? def.label ?? id,
          value: view?.value ?? null,
          max: view?.max ?? null,
        };
      }),
      relationKinds: RELATION_KINDS,
      npcs: state.npcs
        .filter((npc) => npc.lifecycle.state === "alive")
        .slice(0, 24)
        .map((npc) => ({ id: npc.id, name: npc.name, relationship: npc.relationship })),
    };
  }

  if (section === "items") {
    const rawLimit = asRecord(deps as unknown)?.limit;
    void rawLimit;
    return {
      section: "items",
      items: template.items.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        ...(item.slot !== undefined ? { slot: item.slot } : {}),
        ...(item.category !== undefined ? { category: item.category } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
      })),
    };
  }

  return {
    section: "statuses",
    statuses: template.statuses.map((status) => ({
      id: status.id,
      name: status.name,
      kind: status.kind,
      polarity: status.polarity,
      ...(status.description !== undefined ? { description: status.description } : {}),
    })),
  };
}

/**
 * 执行一次只读查询。未知工具名返回 `{ error }` 而不是抛——模型读错了不该炸整轮。
 */
export function runReadTool(name: string, rawArgs: unknown, deps: ReadToolDeps): unknown {
  const args = asRecord(rawArgs) ?? {};
  const { snapshot, state } = deps;

  switch (name) {
    case "world.now": {
      const slot = snapshot.slotEvent;
      return {
        turnIndex: snapshot.turnIndex,
        worldTime: snapshot.worldTime,
        time: snapshot.formattedTime,
        chapter: snapshot.storyChapter ?? null,
        slot:
          slot === null
            ? null
            : {
                eventId: slot.eventId,
                title: slot.title,
                kind: slot.kind,
                from: slot.from,
                // 玩家此刻能点的选项（与事件面板一致，不含隐藏选项）
                options: (slot.options ?? []).map((option) => ({ id: option.id, text: option.text })),
              },
        status: snapshot.status,
        lifeStage: snapshot.lifeStageLabel,
      };
    }

    case "world.history": {
      const all = state.history ?? [];
      const rawLimit = args.limit;
      const limit =
        typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), HISTORY_HARD_CAP)
          : HISTORY_HARD_CAP;
      // 取最近 limit 条（数组是 append 序，尾部最新）。
      const entries = all.slice(Math.max(0, all.length - limit)).map((entry) => ({
        turnIndex: entry.turnIndex,
        time: entry.formattedTime,
        type: entry.type,
        summary: entry.summary,
      }));
      return {
        entries,
        returned: entries.length,
        total: all.length,
        truncated: entries.length < all.length,
      };
    }

    case "world.present": {
      if (isOmniscient(deps.perspective)) {
        // GM 全知窗口：含未登场的、离场的、以及隐秘 refs（只给 id，不给展开内容）。
        return {
          npcs: state.npcs.map((npc) => ({
            id: npc.id,
            name: npc.name,
            lifecycle: npc.lifecycle.state,
            secrets: [...npc.secrets],
            goals: npc.goals !== undefined ? [...npc.goals] : [],
          })),
        };
      }
      return {
        npcs: snapshot.npcs.map((npc) => ({
          id: npc.id,
          name: npc.name,
          alive: npc.lifecycle?.state === "alive",
          relationship: npc.relationship,
          knownGoals: npc.knownGoals,
          statuses: npc.statuses.map((status) => status.name),
        })),
      };
    }

    case "world.self": {
      const player = snapshot.player;
      return {
        name: player.name,
        age: player.age,
        hp: player.hp,
        maxHp: player.maxHp,
        mp: player.mp,
        maxMp: player.maxMp,
        mood: player.mood,
        attributes: player.attributes,
        statuses: player.statuses.map((status) => status.name),
        skills: player.skills.map((skill) => skill.name),
        inventory: player.inventory.map((item) => ({ name: item.name, count: item.count })),
        equipment: (player.equipment ?? []).map((item) => ({ name: item.name, slot: item.slotLabel })),
      };
    }

    case "rule.lexicon": {
      // 未知 section 退回目录：模型写错参数不该炸整轮，也不该拿到一份"什么都没有"。
      const raw = typeof args.section === "string" ? args.section : "index";
      const section = (LEXICON_SECTIONS as readonly string[]).includes(raw)
        ? (raw as LexiconSection)
        : "index";
      return lexiconOf(section, deps);
    }

    default:
      return { error: `未知的只读工具：${name}` };
  }
}
