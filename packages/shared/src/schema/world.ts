import { z } from "zod";
import { EffectSchema, LifeStageSchema, TimeAmountSchema } from "./common.js";
import { CharacterSchema, GenderDefSchema } from "./character.js";
import { PLAYER_ID } from "./relation.js";
import { SkillSchema } from "./skill.js";
import { ItemSchema } from "./item.js";
import { StatusEffectSchema } from "./status-effect.js";
import { NpcActionSchema } from "./npc-action.js";
import { ChainSchema, EventV2Schema } from "./event.js";
import { EquipmentConfigSchema, checkDynamicModifierSpec, type EquipmentSlot } from "./equipment.js";
import { CombatAiConfigSchema } from "./combat-ai.js";

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

/**
 * R2.6 历法配置（ADR-0013）：三种时间模型切换。
 * - approx：固定分钟近似（1 月 = 30 天、1 年 = 365 天），= R2.5 现状，零迁移。
 * - gregorian：真实公历（月长 28–31、闰年）。
 * - custom：模板声明 months[]/leapRule/era（年号/纪元）。
 * 缺省视为 approx。
 */
export const CalendarConfigSchema = z
  .object({
    preset: z.enum(["approx", "gregorian", "custom"]),
    /** 自定义历/年号：显示用纪元名与纪元起点（世界分钟，可为负 = 世界开始前） */
    era: z.object({ name: z.string().min(1), epochStartMinute: z.number().int() }).optional(),
    /** 自定义历月定义（custom 必填） */
    months: z.array(z.object({ name: z.string().min(1), days: z.number().int().positive() })).optional(),
    leapRule: z.enum(["gregorian", "none"]).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.preset === "custom") {
      if (!c.months || c.months.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["months"], message: "custom 历法必须声明 months" });
      }
    }
    if (c.preset === "gregorian" && c.months && c.months.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["months"], message: "gregorian 不应声明 months（走真实公历）" });
    }
    if (c.months) {
      const total = c.months.reduce((s, m) => s + m.days, 0);
      if (total <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["months"], message: "月份天数合计必须为正" });
    }
  });

/**
 * NPC 刷新规则（ADR-0010 决策 4 / R-LM-04 / ADR-0022 落地）。
 *
 * 配置层只声明「将来会有这个角色」；世界创建时把每条规则**实例化**为
 * `SpawnRuleInstance`（实例层、进存档），事件效果 `spawnNpc(ruleId)` 才真正建出 NPC。
 * **不提供 `spawnAt`**：R-LM-04 明确「spawn 不得由已有某事实（含时间到达）自动触发」，
 * 触发权在模板的事件效果里，否则规则会变成一套隐式调度器。
 */
export const NpcSpawnRuleSchema = z
  .object({
    id: z.string().min(1),
    /** 目标角色 id（必须在 characters 中声明且非敌人） */
    characterRef: z.string().min(1),
    /** 出生/登场时的年龄；缺省沿用 `characterRef.identity.age`。0 = 新生儿 */
    age: z.number().int().nonnegative().optional(),
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
        /** R2.6 历法配置（ADR-0013）：缺省 approx（= 现状固定分钟近似），零迁移。 */
        calendar: CalendarConfigSchema.optional(),
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
        /**
         * 属性显示名（玩家可见，如 cursedEnergy → "咒力"）。
         * 引擎与前端一律经此取显示名，不得在代码里硬编码世界观专名；缺省回退属性 id。
         */
        labels: z.record(z.string(), z.string().min(1)).optional(),
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
    /** 装备分域（协议 V2.1 §19，可选；equipment.yaml，未提供时引擎行为不变） */
    equipment: EquipmentConfigSchema.optional(),
    /** 战斗 AI 分域（协议 V2.1 §20，可选；combat-ai.yaml，未映射的敌人保持既有简单权重路径） */
    combatAi: CombatAiConfigSchema.optional(),
    statuses: z.array(StatusEffectSchema),
    events: z.array(EventV2Schema),
    chains: z.array(ChainSchema).optional(),
    /** NPC 自主行动定义（A6：触发式 + 效用评分） */
    npcActions: z.array(NpcActionSchema).optional(),
    /** NPC 刷新规则（ADR-0022；世界创建时实例化为 SpawnRuleInstance，由 spawnNpc 效果触发） */
    npcSpawnRules: z.array(NpcSpawnRuleSchema).optional(),
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

    // 属性显示名引用（键必须是 attributes.order 中声明的属性）
    Object.keys(w.attributes.labels ?? {}).forEach((attr) => {
      if (!attributeIds.has(attr)) add(["attributes", "labels"], `未知属性：${attr}`);
    });

    // 属性键必须在 attributes.order 中声明（D-17）：补齐一处**不对称**。
    // 既有 superRefine 已强制 `attributes.labels` 的键 ⊆ order（见上），也已校验
    // `characters[].attributes`（见下方角色循环，L318 一带）—— 但 `attributes.defaults` 与
    // `playerTemplate.attributes` 两处漏了。引擎会把这两处直接写进 player.attributes，
    // 而 labels.attributes 又只可能含 order 内的键 ⇒ 玩家端那格属性名静默退回机器名
    // （如 `luck`）：不报错、不空白、只多出一行英文名，且与「声明了属性但忘了配 label」
    // 肉眼同形，极难归因。故在加载期 fail-fast（与其余 8 类交叉引用一致）。
    // 注意：characters 仍由既有那段校验，**不在此重复**，避免同一问题报两条 issue。
    const checkAttributeKeys = (value: Record<string, number> | undefined, path: (string | number)[]): void => {
      Object.keys(value ?? {}).forEach((attr) => {
        if (!attributeIds.has(attr)) add([...path, attr], `未知属性：${attr}（未在 attributes.order 中声明）`);
      });
    };
    checkAttributeKeys(w.attributes.defaults, ["attributes", "defaults"]);
    checkAttributeKeys(w.playerTemplate?.attributes, ["playerTemplate", "attributes"]);

    // 状态栏数据源引用（source=resource 的 key 只能是 hp/mp；source=attribute 的 keys 必须已声明）
    w.statusBar.forEach((section, i) => {
      if (section.source === "resource") {
        if (!section.key) add(["statusBar", i, "key"], "source 为 resource 时必须声明 key");
        else if (section.key !== "hp" && section.key !== "mp") add(["statusBar", i, "key"], `未知资源：${section.key}`);
      }
      if (section.source === "attribute") {
        const keys = section.keys ?? (section.key ? [section.key] : []);
        if (keys.length === 0) add(["statusBar", i, "keys"], "source 为 attribute 时必须声明 keys");
        keys.forEach((k) => {
          if (!attributeIds.has(k)) add(["statusBar", i, "keys"], `未知属性：${k}`);
        });
      }
    });

    // 性别引用
    w.characters.forEach((c, i) => {
      if (!genderIds.has(c.identity.gender)) add(["characters", i, "identity", "gender"], `未知性别：${c.identity.gender}`);
    });
    // R2.6 / ADR-0014：初始关系边声明 -> 角色引用（to 只能是已声明角色或 PLAYER_ID）
    w.characters.forEach((c, i) => {
      (c.relations ?? []).forEach((r, j) => {
        if (r.to !== PLAYER_ID && !characterIds.has(r.to)) {
          add(["characters", i, "relations", j, "to"], `未知关系目标：${r.to}`);
        }
      });
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

    // 属性引用（战斗技能 hitCheck / scaleBy / 角色属性 / mood 档位修正）
    w.skills.forEach((s, i) => {
      if (s.kind === "combat") {
        // 命中判定的攻防槽位同样是属性 id 引用；写错会静默取 0，必须在加载期拒绝
        if (s.hitCheck) {
          if (!attributeIds.has(s.hitCheck.attacker)) add(["skills", i, "hitCheck", "attacker"], `未知属性：${s.hitCheck.attacker}`);
          if (!attributeIds.has(s.hitCheck.defender)) add(["skills", i, "hitCheck", "defender"], `未知属性：${s.hitCheck.defender}`);
        }
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

    // R2.5 / R-EV-13：战斗事件不得作为 pool 来源入池（加载期拒绝，抽取期另有防御）。
    // 战斗会话占槽直至结束，与「抽中→入队→延时触发」叠一层会话状态会污染权重语义。
    w.events.forEach((e, i) => {
      if (e.trigger.source === "pool" && e.kind === "combat") {
        add(
          ["events", i, "trigger", "source"],
          "source: pool 不允许 kind: combat；请改用通常事件/转盘事件入池，再由该事件的 chain 立即步或 nextEventId 触发战斗",
        );
      }
    });

    // R2.5 / #35：同一 onActionId 至多一条「立即」action-hook。
    // 只统计未声明 window / delay 的 hook：延时 hook 不占同一轮槽位，显式豁免；
    // chain / schedule / pool 完全不受约束。
    const immediateHooks = new Map<string, number[]>();
    w.events.forEach((e, i) => {
      const t = e.trigger;
      if (t.source !== "action-hook" || t.onActionId === undefined) return;
      if (t.window !== undefined || t.delay !== undefined) return;
      const group = immediateHooks.get(t.onActionId) ?? [];
      group.push(i);
      immediateHooks.set(t.onActionId, group);
    });
    for (const [onActionId, indexes] of immediateHooks) {
      if (indexes.length < 2) continue;
      add(
        ["events", indexes[1], "trigger", "source"],
        `同一 onActionId「${onActionId}」存在 ${indexes.length} 条立即 action-hook，违反单轮槽位唯一（events[${indexes.join(",")}]）；可为后续 hook 声明 window/delay 转为延时`,
      );
    }

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
        if (c.fleeCheck) {
          if (!attributeIds.has(c.fleeCheck.attacker)) add(["events", i, "settle", "combat", "fleeCheck", "attacker"], `未知属性：${c.fleeCheck.attacker}`);
          if (!attributeIds.has(c.fleeCheck.defender)) add(["events", i, "settle", "combat", "fleeCheck", "defender"], `未知属性：${c.fleeCheck.defender}`);
        }
      }
      // 通用效果里的 chain / attribute 引用
      const walkEffects = (
        effects: { type: string; chainId?: string; attribute?: string; eventId?: string }[] | undefined,
        path: (string | number)[],
      ) => {
        (effects ?? []).forEach((eff, j) => {
          if ((eff.type === "startChain" || eff.type === "advanceChain" || eff.type === "cancelChain") && eff.chainId && !chainIds.has(eff.chainId)) {
            add([...path, j], `未知事件链：${eff.chainId}`);
          }
          if (eff.type === "adjustAttribute" && eff.attribute && !attributeIds.has(eff.attribute)) {
            add([...path, j], `未知属性：${eff.attribute}`);
          }
          // R2.5：enqueueEvent 是延时入队的唯一声明式通道，目标事件必须存在
          if (eff.type === "enqueueEvent" && eff.eventId && !eventIds.has(eff.eventId)) {
            add([...path, j], `未知事件：${eff.eventId}（enqueueEvent 目标）`);
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

    // 装备分域引用完整性（协议 V2.1 §19 / R-EQ-01..05）
    const eq = w.equipment;
    if (eq) {
      const slotById = new Map<string, EquipmentSlot>();
      (eq.slots ?? []).forEach((s, i) => {
        if (slotById.has(s.id)) add(["equipment", "slots", i, "id"], `重复槽位 id：${s.id}`);
        slotById.set(s.id, s);
      });
      const qualitySet = new Set(eq.qualities ?? []);
      w.items.forEach((item, i) => {
        if (item.type !== "equipment") return;
        if (!slotById.has(item.slot ?? "")) {
          add(["items", i, "slot"], `未知槽位：${item.slot ?? "(缺失)"}`);
          return;
        }
        const slot = slotById.get(item.slot ?? "")!;
        if (!slot.allowedCategories.includes(item.category ?? "")) {
          add(["items", i, "category"], `槽位 ${slot.id} 不允许类别：${item.category ?? "(缺失)"}（allowedCategories: ${slot.allowedCategories.join(", ")}）`);
        }
        if (qualitySet.size > 0 && !qualitySet.has(item.quality ?? "")) {
          add(["items", i, "quality"], `未知品质：${item.quality ?? "(缺失)"}（qualities 白名单：${[...qualitySet].join(", ")}）`);
        }
        if (item.dynamicModifier) {
          const msg = checkDynamicModifierSpec(item.dynamicModifier, { attributeIds, statusIds });
          if (msg) add(["items", i, "dynamicModifier"], msg);
        }
      });
      (eq.initialEquipment ?? []).forEach((init, i) => {
        const item = w.items.find((it) => it.id === init.itemId);
        if (!item) {
          add(["equipment", "initialEquipment", i, "itemId"], `未知物品：${init.itemId}`);
          return;
        }
        if (item.type !== "equipment") {
          add(["equipment", "initialEquipment", i, "itemId"], `初始装备必须引用 type: equipment 物品：${init.itemId}`);
          return;
        }
        if (item.slot && !slotById.has(item.slot)) {
          add(["equipment", "initialEquipment", i], `初始装备引用了未声明槽位的装备：${init.itemId}`);
        }
      });
    }

    // 战斗 AI 分域引用完整性（协议 V2.1 §20 / R-CA-01..06）
    const ai = w.combatAi;
    if (ai) {
      const styleIds = new Set<string>();
      ai.styles.forEach((s, i) => {
        if (styleIds.has(s.styleId)) add(["combatAi", "styles", i, "styleId"], `重复风格 id：${s.styleId}`);
        styleIds.add(s.styleId);
        Object.keys(s.scoreWeights).forEach((actionId, j) => {
          if (!skillIds.has(actionId)) add(["combatAi", "styles", i, "scoreWeights", j], `未知行动/技能：${actionId}`);
        });
        (s.conditions ?? []).forEach((c, j) => {
          c.prefer.forEach((actionId, k) => {
            if (!skillIds.has(actionId)) add(["combatAi", "styles", i, "conditions", j, "prefer", k], `未知行动/技能：${actionId}`);
          });
        });
      });
      Object.entries(ai.assignments).forEach(([characterId, styleId], i) => {
        if (!characterIds.has(characterId)) add(["combatAi", "assignments", i], `未知角色：${characterId}`);

    // ADR-0022：刷新规则引用完整性。规则指向的角色必须存在且不是敌人
    // （敌人由 combat settle 直接 ref 引，不属于「将来出生」语义）。
    const ruleIds = new Set<string>();
    (w.npcSpawnRules ?? []).forEach((rule, i) => {
      const path = ["npcSpawnRules", i];
      if (ruleIds.has(rule.id)) add(path, `重复的刷新规则 id：${rule.id}`);
      ruleIds.add(rule.id);
      const ch = w.characters.find((c) => c.id === rule.characterRef);
      if (!ch) {
        add([...path, "characterRef"], `未知角色：${rule.characterRef}`);
      } else if (ch.isEnemy) {
        add([...path, "characterRef"], `刷新规则不能指向敌人角色：${rule.characterRef}`);
      }
    });
        if (!styleIds.has(styleId)) add(["combatAi", "assignments", i], `未知风格：${styleId}`);
      });
    }

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
        if (eff.type === "adjustRelation") {
          if (eff.fromId === undefined && eff.toId === undefined) {
            // 标量形态：npcId 必填
            if (eff.npcId === undefined) {
              add(path, "adjustRelation 需要 npcId（标量形态）或 fromId+toId+kind（关系边形态）");
            } else if (eff.npcId !== "__self__" && !characterIds.has(eff.npcId)) {
              add(path, `未知角色：${eff.npcId}`);
            }
          } else {
            // 关系边形态（R2.6）：toId 与 kind 必填，端点须为已声明角色或玩家
            if (eff.toId === undefined || eff.kind === undefined) {
              add(path, "adjustRelation 关系边形态必须同时声明 toId 与 kind");
            }
            if (
              eff.fromId !== undefined &&
              eff.fromId !== "__self__" &&
              eff.fromId !== PLAYER_ID &&
              !characterIds.has(eff.fromId)
            ) {
              add(path, `未知角色：${eff.fromId}`);
            }
            if (eff.toId !== undefined && eff.toId !== PLAYER_ID && !characterIds.has(eff.toId)) {
              add(path, `未知关系目标：${eff.toId}`);
            }
          }
        }
        if (eff.type === "addRelationEdge") {
          if (eff.fromId !== "__self__" && eff.fromId !== PLAYER_ID && !characterIds.has(eff.fromId)) {
            add(path, `未知角色：${eff.fromId}`);
          }
          if (eff.toId !== PLAYER_ID && !characterIds.has(eff.toId)) {
            add(path, `未知关系目标：${eff.toId}`);
          }
        }
        if (eff.type === "freezeRelationsOnDeath" && eff.npcId !== "__self__" && !characterIds.has(eff.npcId)) {
          add(path, `未知角色：${eff.npcId}`);
        }
        if (eff.type === "enqueueEvent" && !eventIds.has(eff.eventId)) {
          add(path, `未知事件：${eff.eventId}（enqueueEvent 目标）`);
        }
      });
    });
  });

export type WorldTemplateV2 = z.infer<typeof WorldTemplateV2Schema>;
