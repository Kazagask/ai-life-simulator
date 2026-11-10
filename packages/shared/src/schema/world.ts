import { z } from "zod";
import { EffectSchema, LifeStageSchema, TimeAmountSchema } from "./common.js";
import { CharacterSchema, GenderDefSchema } from "./character.js";
import { SkillSchema } from "./skill.js";
import { ItemSchema } from "./item.js";
import { StatusEffectSchema } from "./status-effect.js";
import { NpcActionSchema } from "./npc-action.js";
import { ChainSchema, EventV2Schema } from "./event.js";

/**
 * WorldTemplateV2 顶层聚合 Schema。
 * 除结构校验外，附带跨实体引用完整性校验（genders/attributes/statuses/events/enemies/skills）。
 */

/**
 * 资源上限公式：base + perLevel × growthLevel + Σ perAttribute[attr] × 基础属性值。
 * perAttribute 引用 attributes.order 中声明的属性 id（引用完整性见顶层 superRefine）。
 */
const ResourceDefSchema = z
  .object({
    base: z.number().nonnegative(),
    perLevel: z.number().nonnegative().default(0),
    perAttribute: z.record(z.string(), z.number()).optional(),
  })
  .strict();

const MoodBandSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    min: z.number(),
    max: z.number(),
    attributeModifiers: z.record(z.string(), z.number()),
  })
  .strict();

const MoodConfigSchema = z
  .object({
    min: z.number(),
    max: z.number(),
    defaultValue: z.number(),
    bands: z.array(MoodBandSchema).min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    const sorted = [...m.bands].sort((a, b) => a.min - b.min);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].min >= sorted[i].max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bands", i], message: "档位区间 min 必须小于 max" });
      }
      if (i > 0 && sorted[i].min <= sorted[i - 1].max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bands", i], message: "档位区间重叠" });
      }
    }
    if (sorted[0].min !== m.min || sorted[sorted.length - 1].max !== m.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bands"], message: "档位区间未覆盖 min..max 全域" });
    }
  });

const StatusBarSectionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    source: z.enum(["identity", "attribute", "resource", "mood", "status", "custom"]),
    key: z.string().min(1).optional(),
    keys: z.array(z.string().min(1)).optional(),
    visibleWhen: z.array(z.unknown()).optional(),
  })
  .strict();

const PlayerTemplateSchema = z
  .object({
    identity: z
      .object({
        gender: z.string().min(1),
        age: z.number().int().nonnegative(),
      })
      .strict(),
    mood: z.number().optional(),
    attributes: z.record(z.string(), z.number()),
    skills: z.array(z.string().min(1)).optional(),
    items: z
      .array(z.object({ itemId: z.string().min(1), count: z.number().int().positive() }).strict())
      .optional(),
  })
  .strict();

export const WorldTemplateV2Schema = z
  .object({
    meta: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        startYear: z.number().int(),
        engineProtocol: z.literal("v2"),
      })
      .strict(),
    time: z
      .object({
        defaultStep: TimeAmountSchema,
        lifeStageSteps: z.record(z.string(), TimeAmountSchema).optional(),
        /** 人生阶段阈值（按 maxAge 升序；最后一档可省略 maxAge 表示无上界）。缺省时引擎回退到旧固定阈值。 */
        lifeStages: z.array(LifeStageSchema).optional(),
      })
      .strict()
      .superRefine((t, ctx) => {
        const stages = t.lifeStages ?? [];
        for (let i = 1; i < stages.length; i++) {
          const prev = stages[i - 1].maxAge;
          const cur = stages[i].maxAge;
          if (prev !== undefined && cur !== undefined && cur <= prev) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["lifeStages", i, "maxAge"],
              message: "人生阶段 maxAge 必须严格递增",
            });
          }
        }
      }),
    genders: z.array(GenderDefSchema).min(1),
    mood: MoodConfigSchema,
    statusBar: z.array(StatusBarSectionSchema).min(1),
    attributes: z
      .object({
        order: z.array(z.string().min(1)).min(1),
        defaults: z.record(z.string(), z.number()),
        caps: z.record(z.string(), z.number()).optional(),
      })
      .strict(),
    resources: z
      .object({ hp: ResourceDefSchema, mp: ResourceDefSchema })
      .strict(),
    regen: z
      .object({
        perTurn: z.object({ hp: z.number().nonnegative(), mp: z.number().nonnegative() }).strict(),
        actions: z.record(z.string(), z.object({ hp: z.number().nonnegative(), mp: z.number().nonnegative() }).strict()).optional(),
      })
      .strict(),
    checks: z
      .object({
        opposedDefault: z
          .object({ attacker: z.string().min(1), defender: z.string().min(1), baseChance: z.number().min(0).max(1) })
          .strict()
          .optional(),
        fixedDefault: z.object({ value: z.number() }).strict().optional(),
        scaledDefault: z.object({ multiplier: z.number() }).strict().optional(),
      })
      .strict(),
    characters: z.array(CharacterSchema),
    playerTemplate: PlayerTemplateSchema.optional(),
    /** 玩家行动定义（action-hook 事件的 onActionId 引用此处） */
    actions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            description: z.string().optional(),
            duration: TimeAmountSchema.optional(),
            /** 绝对推进目标（剧情节点）：相对世界起始的偏移量；存在时忽略 duration，将世界时间直接推进到该目标（不倒退）。 */
            advanceTo: TimeAmountSchema.optional(),
            effects: z.array(EffectSchema).optional(),
          })
          .strict(),
      )
      .optional(),
    skills: z.array(SkillSchema),
    items: z.array(ItemSchema),
    statuses: z.array(StatusEffectSchema),
    events: z.array(EventV2Schema),
    chains: z.array(ChainSchema).optional(),
    /** NPC 自主行动定义（A6：触发式 + 效用评分） */
    npcActions: z.array(NpcActionSchema).optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    // 全库 id 唯一（跨文件合并后仍成立）
    const idGroups: Array<[string, { id: string }[]]> = [
      ["characters", w.characters],
      ["skills", w.skills],
      ["items", w.items],
      ["statuses", w.statuses],
      ["events", w.events],
      ["chains", w.chains ?? []],
    ];
    for (const [group, list] of idGroups) {
      const seen = new Map<string, number>();
      list.forEach((entity, i) => {
        const first = seen.get(entity.id);
        if (first !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [group, i, "id"],
            message: `重复 id：${entity.id}（已用于 ${group}[${first}]）`,
          });
        } else {
          seen.set(entity.id, i);
        }
      });
    }

    const genderIds = new Set(w.genders.map((g) => g.id));
    const attributeIds = new Set(w.attributes.order);
    const statusIds = new Set(w.statuses.map((s) => s.id));
    const skillIds = new Set(w.skills.map((s) => s.id));
    const itemIds = new Set(w.items.map((i) => i.id));
    const characterIds = new Set(w.characters.map((c) => c.id));
    const eventIds = new Set(w.events.map((e) => e.id));
    const chainIds = new Set((w.chains ?? []).map((c) => c.id));

    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // 资源公式 perAttribute 引用
    (["hp", "mp"] as const).forEach((res) => {
      Object.keys(w.resources[res].perAttribute ?? {}).forEach((attr) => {
        if (!attributeIds.has(attr)) add(["resources", res, "perAttribute"], `未知属性：${attr}`);
      });
    });

    // 性别引用
    w.characters.forEach((c, i) => {
      if (!genderIds.has(c.identity.gender)) add(["characters", i, "identity", "gender"], `未知性别：${c.identity.gender}`);
    });
    if (w.playerTemplate && !genderIds.has(w.playerTemplate.identity.gender)) {
      add(["playerTemplate", "identity", "gender"], `未知性别：${w.playerTemplate.identity.gender}`);
    }
    if (w.playerTemplate) {
      (w.playerTemplate.skills ?? []).forEach((sk, j) => {
        if (!skillIds.has(sk)) add(["playerTemplate", "skills", j], `未知技能：${sk}`);
      });
      (w.playerTemplate.items ?? []).forEach((it, j) => {
        if (!itemIds.has(it.itemId)) add(["playerTemplate", "items", j], `未知物品：${it.itemId}`);
      });
    }

    // 属性引用（战斗技能 scaleBy / 角色属性 / mood 档位修正）
    w.skills.forEach((s, i) => {
      if (s.kind === "combat") {
        const formulas = [...(s.damage ?? []), ...(s.heal ?? [])];
        formulas.forEach((f, j) => {
          if (f.preset === "scaled" && !attributeIds.has(f.scaleBy)) {
            add(["skills", i, "damage", j], `未知属性：${f.scaleBy}`);
          }
        });
      }
    });
    w.characters.forEach((c, i) => {
      Object.keys(c.attributes).forEach((k) => {
        if (!attributeIds.has(k)) add(["characters", i, "attributes"], `未知属性：${k}`);
      });
    });

    // 技能 applyStatus/consumeStatus/stack-scaled -> statuses；通用技能 unlocksOptions -> 事件选项（事件侧校验）
    w.skills.forEach((s, i) => {
      if (s.kind === "combat") {
        (s.applyStatus ?? []).forEach((a, j) => {
          if (!statusIds.has(a.status)) add(["skills", i, "applyStatus", j], `未知补正：${a.status}`);
        });
        if (s.consumeStatus && !statusIds.has(s.consumeStatus.status)) {
          add(["skills", i, "consumeStatus"], `未知补正：${s.consumeStatus.status}`);
        }
        const formulas = [...(s.damage ?? []), ...(s.heal ?? [])];
        formulas.forEach((f, j) => {
          if (f.preset === "stack-scaled" && !statusIds.has(f.status)) {
            add(["skills", i, "damage", j], `未知补正：${f.status}`);
          }
        });
      }
    });

    // 角色初始技能 -> skills；combatHints.skillWeights 的 key 必须是该角色已持有的技能
    w.characters.forEach((c, i) => {
      const owned = new Set(c.skills ?? []);
      (c.skills ?? []).forEach((sk, j) => {
        if (!skillIds.has(sk)) add(["characters", i, "skills", j], `未知技能：${sk}`);
      });
      (c.statuses ?? []).forEach((st, j) => {
        if (!statusIds.has(st)) add(["characters", i, "statuses", j], `未知补正：${st}`);
      });
      const hints = c.private.combatHints as { skillWeights?: Record<string, unknown> } | undefined;
      Object.keys(hints?.skillWeights ?? {}).forEach((sk) => {
        if (!owned.has(sk)) {
          add(["characters", i, "private", "combatHints"], `skillWeights 引用未持有技能：${sk}`);
        }
      });
    });

    // 物品 use 效果引用
    w.items.forEach((item, i) => {
      (item.use ?? []).forEach((e, j) => {
        if (e.type === "cureStatus" && !statusIds.has(e.status)) add(["items", i, "use", j], `未知补正：${e.status}`);
        if (e.type === "grantItem" && !itemIds.has(e.itemId)) add(["items", i, "use", j], `未知物品：${e.itemId}`);
      });
    });

    // 战斗敌人/友军引用
    w.events.forEach((e, i) => {
      if (e.kind === "combat") {
        e.settle.combat.enemies.forEach((en, j) => {
          const id = characterIds.has(en.ref) ? undefined : `未知敌人角色：${en.ref}`;
          if (id) add(["events", i, "settle", "combat", "enemies", j], id);
        });
        (e.settle.combat.allies ?? []).forEach((al, j) => {
          const id = characterIds.has(al.ref) ? undefined : `未知友军角色：${al.ref}`;
          if (id) add(["events", i, "settle", "combat", "allies", j], id);
        });
      }
    });

    // 事件/链互引
    const optionIds = new Set<string>();
    w.events.forEach((e) => {
      if (e.kind === "normal") {
        e.settle.normal.options.forEach((o) => optionIds.add(o.id));
      }
    });
    w.events.forEach((e, i) => {
      const checkNext = (nextEventId: string | undefined, path: (string | number)[]) => {
        if (nextEventId && !eventIds.has(nextEventId)) add(path, `未知事件：${nextEventId}`);
      };
      if (e.kind === "normal") {
        e.settle.normal.options.forEach((o, j) => {
          checkNext(o.nextEventId, ["events", i, "settle", "normal", "options", j]);
          (o.visibleWhen ?? []).forEach((c, k) => {
            const rec = c as { requiresSkill?: string };
            if (rec.requiresSkill && !skillIds.has(rec.requiresSkill)) {
              add(["events", i, "settle", "normal", "options", j, "visibleWhen", k], `未知技能：${rec.requiresSkill}`);
            }
          });
        });
      }
      if (e.kind === "random") {
        e.settle.random.wheel.segments.forEach((seg, j) => {
          checkNext(seg.nextEventId, ["events", i, "settle", "random", "wheel", "segments", j]);
          Object.keys(seg.weightBy ?? {}).forEach((attr) => {
            if (!attributeIds.has(attr)) {
              add(["events", i, "settle", "random", "wheel", "segments", j, "weightBy"], `未知属性：${attr}`);
            }
          });
        });
      }
      if (e.kind === "combat") {
        const c = e.settle.combat;
        checkNext(c.onVictory?.nextEventId, ["events", i, "settle", "combat", "onVictory"]);
        checkNext(c.onDefeat?.nextEventId, ["events", i, "settle", "combat", "onDefeat"]);
        checkNext(c.onFlee?.nextEventId, ["events", i, "settle", "combat", "onFlee"]);
        if (c.canFlee && !c.fleeCheck) {
          add(["events", i, "settle", "combat"], "canFlee 为 true 时需要 fleeCheck");
        }
      }
      // 通用效果里的 chain / attribute 引用
      const walkEffects = (effects: { type: string; chainId?: string; attribute?: string }[] | undefined, path: (string | number)[]) => {
        (effects ?? []).forEach((eff, j) => {
          if ((eff.type === "startChain" || eff.type === "advanceChain" || eff.type === "cancelChain") && eff.chainId && !chainIds.has(eff.chainId)) {
            add([...path, j], `未知事件链：${eff.chainId}`);
          }
          if (eff.type === "adjustAttribute" && eff.attribute && !attributeIds.has(eff.attribute)) {
            add([...path, j], `未知属性：${eff.attribute}`);
          }
        });
      };
      if (e.kind === "normal") e.settle.normal.options.forEach((o, j) => walkEffects(o.effects, ["events", i, "settle", "normal", "options", j, "effects"]));
      if (e.kind === "random") e.settle.random.wheel.segments.forEach((seg, j) => walkEffects(seg.effects, ["events", i, "settle", "random", "wheel", "segments", j, "effects"]));
    });

    // 事件链引用与起点校验
    (w.chains ?? []).forEach((ch, i) => {
      if (!eventIds.has(ch.startEventId)) add(["chains", i, "startEventId"], `未知事件：${ch.startEventId}`);
      ch.steps.forEach((st, j) => {
        if (!eventIds.has(st.eventId)) add(["chains", i, "steps", j], `未知事件：${st.eventId}`);
      });
      const start = w.events.find((e) => e.id === ch.startEventId);
      if (start && start.trigger.source !== "chain") {
        add(["chains", i, "startEventId"], `链起点事件 ${ch.startEventId} 的 trigger.source 必须为 chain`);
      }
    });

    // NPC 行动效果引用完整性
    (w.npcActions ?? []).forEach((action, i) => {
      (action.effects ?? []).forEach((eff, j) => {
        const path = ["npcActions", i, "effects", j];
        if ((eff.type === "startChain" || eff.type === "advanceChain" || eff.type === "cancelChain") && !chainIds.has(eff.chainId)) {
          add(path, `未知事件链：${eff.chainId}`);
        }
        if (eff.type === "adjustAttribute" && !attributeIds.has(eff.attribute)) {
          add(path, `未知属性：${eff.attribute}`);
        }
        if ((eff.type === "grantItem" || eff.type === "removeItem") && !itemIds.has(eff.itemId)) {
          add(path, `未知物品：${eff.itemId}`);
        }
        if ((eff.type === "applyStatus" || eff.type === "cureStatus") && !statusIds.has(eff.status)) {
          add(path, `未知补正：${eff.status}`);
        }
        if ((eff.type === "unlockSkill" || eff.type === "adjustProficiency") && !skillIds.has(eff.skillId)) {
          add(path, `未知技能：${eff.skillId}`);
        }
        if (eff.type === "adjustRelation" && eff.npcId !== "__self__" && !characterIds.has(eff.npcId)) {
          add(path, `未知角色：${eff.npcId}`);
        }
      });
    });
  });

export type WorldTemplateV2 = z.infer<typeof WorldTemplateV2Schema>;
