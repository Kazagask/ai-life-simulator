import { z } from "zod";
import { TaskConditionSchema, TemplateEffectSchema, TimeAmountSchema } from "./common.js";
import { EventInstanceSchema } from "./event-instance.js";
import { RelationKindSchema } from "./relation.js";

/**
 * 开局分域 Schema（协议 V2.1 §16）。全部 strict；类型经 z.infer 派生。
 * 条件 / 效果只引用既有声明式 DSL（§12），不接受任何自由表达式。
 */

const CountRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([lo, hi]) => lo <= hi, { message: "countRange 下界不得大于上界" });

/** steps[].kind 白名单：必经 / 可选 / 分支。 */
export const OpeningStepSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["required", "optional", "branch"]),
    ref: z.string().min(1).optional(),
  })
  .strict();

/**
 * 事件池内单个事件。抽取字段（§16）：
 * tags / weight / conditions / required / countRange / exclusiveGroup /
 * sequence / seed / effects / nextEvents，全部声明式。
 */
export const OpeningPoolEventSchema = z
  .object({
    id: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    weight: z.number().nonnegative().optional(),
    conditions: z.array(TaskConditionSchema).optional(),
    required: z.boolean().optional(),
    countRange: CountRangeSchema.optional(),
    exclusiveGroup: z.string().min(1).optional(),
    sequence: z.number().int().nonnegative().optional(),
    seed: z.number().int().optional(),
    effects: z.array(TemplateEffectSchema).optional(),
    nextEvents: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const OpeningEventPoolSchema = z
  .object({
    id: z.string().min(1),
    /** 本次抽取启用的标签；事件 tags 与之匹配（或事件无 tags 视为通用）才入选 */
    tags: z.array(z.string().min(1)).optional(),
    countRange: CountRangeSchema.optional(),
    exclusiveGroup: z.string().min(1).optional(),
    sequence: z.number().int().nonnegative().optional(),
    seed: z.number().int().optional(),
    events: z.array(OpeningPoolEventSchema).min(1),
  })
  .strict();

/** 通用初始化块：用既有声明式效果 DSL 与世界 flag 表达，不硬编码世界观内容。 */
export const OpeningSetupSchema = z
  .object({
    effects: z.array(TemplateEffectSchema).optional(),
    flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

/** 初始关系必须带 source（R-OP-05）；未声明关系的 NPC 由引擎置 unknown 且不建关系条目。 */
export const OpeningRelationSchema = z
  .object({
    npcId: z.string().min(1),
    value: z.number().min(-100).max(100),
    source: z.string().min(1),
  })
  .strict();

export const OpeningNpcSetupSchema = z
  .object({
    relations: z.array(OpeningRelationSchema).optional(),
    /**
     * @deprecated 已移除（ADR-017 D3）。
     *
     * 「玩家对某人的知情程度」在 V2 由三件真事实表达：`npc.visibility`（人物列表里有没有他）、
     * 关系边 `scope`（这条关系几个人知道）、`secrets`（永不投影）。旧字段写的是
     * `flags[infoVisibility:<id>]` —— 没有任何读者，只有写者。
     *
     * 保留在类型里是为了给**旧模板**一句能读懂的错误，而不是一句 "Unrecognized key"。
     */
    visibility: z.record(z.string(), z.enum(["known", "inferred", "unknown", "hidden"])).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.visibility === undefined) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["visibility"],
      message:
        "npcSetup.visibility 已废弃（ADR-017 D3）：知情程度改用 characters[].visibility / 关系边 scope / secrets 表达",
    });
  });

/** 未来/条件事件去向：引用 events.yaml 中既有 source: schedule 定义。 */
export const OpeningScheduledEventSchema = z
  .object({
    eventId: z.string().min(1),
    at: TimeAmountSchema.optional(),
    conditions: z.array(TaskConditionSchema).optional(),
  })
  .strict();

export const OpeningHandoffSchema = z
  .object({
    /** 未完成即时事件 eventId（→ 现有 pendingEvents / chains） */
    pendingEvents: z.array(z.string().min(1)),
    /** 未来/条件事件（→ 现有 schedule） */
    schedule: z.array(OpeningScheduledEventSchema),
  })
  .strict();

export const OpeningTemplateSchema = z
  .object({
    openingId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    entryConditions: z.array(TaskConditionSchema),
    steps: z.array(OpeningStepSchema),
    characterSetup: OpeningSetupSchema,
    worldSetup: OpeningSetupSchema,
    npcSetup: OpeningNpcSetupSchema,
    eventPools: z.array(OpeningEventPoolSchema),
    objectives: OpeningSetupSchema,
    choices: OpeningSetupSchema,
    completionConditions: z.array(TaskConditionSchema).min(1),
    handoff: OpeningHandoffSchema,
  })
  .strict()
  .superRefine((tpl, ctx) => {
    // 同一模板内 steps / eventPools 的 id 不得重复；openingId 全库唯一由加载器校验。
    const stepIds = new Set<string>();
    tpl.steps.forEach((s, i) => {
      if (stepIds.has(s.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, "id"], message: `重复步骤 id：${s.id}` });
      }
      stepIds.add(s.id);
    });
    const poolIds = new Set<string>();
    tpl.eventPools.forEach((p, i) => {
      if (poolIds.has(p.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["eventPools", i, "id"], message: `重复事件池 id：${p.id}` });
      }
      poolIds.add(p.id);
    });
  });

/**
 * 开局运行记录（design §5）。handoff 据此把事件分流到现有队列。
 * 运行时由引擎构造（非 YAML 加载），但仍给出 strict schema 以约束交接数据。
 */
export const OpeningRunSchema = z
  .object({
    openingId: z.string().min(1),
    executedSteps: z.array(z.string().min(1)),
    choiceRecords: z.array(
      z.object({ stepId: z.string().min(1), choiceId: z.string().min(1) }).strict(),
    ),
    seed: z.number().int(),
    startedAt: z.number(),
    completedAt: z.number(),
    /** completionConditions 是否满足；handoff 仅在此为 true 时交接 */
    completed: z.boolean(),
    /** 抽取 / 声明的开局事件实例（含 origin 元数据） */
    instances: z.array(EventInstanceSchema),
    /** 未完成即时事件：eventId + 可选归属链 */
    pendingEvents: z.array(
      z.object({ eventId: z.string().min(1), chainId: z.string().min(1).optional() }).strict(),
    ),
    /** 未来/条件事件：引用既有 schedule 定义 */
    scheduledEvents: z.array(OpeningScheduledEventSchema),
  })
  .strict();

// ---------- 前实例化开局（ADR-001 / R-OP-01..07） ----------
//
// 新语法与上面的旧 opening.yaml 分域**并存**：旧分域继续服务 1.0.0 模板（旧档拒载由
// schemaVersion=5 统一处理），新分域由 2.0.0 的 `opening.yaml` 声明，加载期择一解释。
// 参数落点由引擎注册（模板只给 kind/约束/展示提示），这里只约束"声明的形状"。

/** 参数闭集（R-OP-05）：新参数类型需改 core + ADR，不在模板里自造落点。 */
export const OpeningParamKindSchema = z.enum([
  "self",
  "name",
  "gender",
  "age",
  "attribute",
  "status",
  "skill",
  "item",
  "relation",
  "flag",
  "time",
  "points",
  /**
   * ADR-004：开局期标量。只活在参数表里，commit **不落任何世界字段**。
   * 存在的理由是承载「点数预算」「一次性加成的数值」这类量，
   * 避免模板为了存一个数去污染 flags / attributes。
   */
  "number",
  "extensions",
]);
export type OpeningParamKind = z.infer<typeof OpeningParamKindSchema>;

/** 展示组件提示（渲染层消费；v1 内联，ui.yaml 定案后迁出）。 */
export const OpeningParamUiSchema = z
  .object({
    label: z.string().min(1),
    component: z.enum(["text", "enum", "wheel", "points"]).optional(),
    order: z.number().int().nonnegative().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

/** 单个开局参数声明：id 是模板侧别名，kind 决定引擎落点（不写 target）。 */
export const OpeningParamDeclSchema = z
  .object({
    id: z.string().min(1),
    kind: OpeningParamKindSchema,
    /** 枚举可选值（kind=gender/self 等）；引擎不解释语义，只透传展示与校验。 */
    values: z.array(z.string().min(1)).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** 点数分配规格（kind=points）：预算 + 各属性上下界。 */
    budget: z.number().int().positive().optional(),
    /**
     * ADR-004 D2：预算来源参数 id（kind 必须是 `number`）。
     * 有它 ⇒ 预算 = 该参数在本会话的落定值（可由 roll 决定「抽到几点」）；
     * 没有 ⇒ 用字面 `budget`。引擎只解析、不猜。
     */
    budgetFrom: z.string().min(1).optional(),
    targets: z
      .array(
        z
          .object({
            attribute: z.string().min(1),
            min: z.number().optional(),
            max: z.number().optional(),
            /** 展示名覆盖（缺省取 world.yaml 的 attributes.labels）。 */
            label: z.string().min(1).optional(),
            /** 属性名着色（样式 id，加载期由 validateOpeningDag 校验）。 */
            style: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    ui: OpeningParamUiSchema.optional(),
  })
  .strict()
  .superRefine((decl, ctx) => {
    if (decl.kind !== "points") {
      if (decl.budgetFrom !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["budgetFrom"],
          message: "budgetFrom 只对 kind=points 有意义",
        });
      }
      return;
    }
    if (decl.budget === undefined && decl.budgetFrom === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget"],
        message: "points 参数必须声明 budget 或 budgetFrom（ADR-004 D2）",
      });
    }
    if (decl.budgetFrom !== undefined && decl.budgetFrom === decl.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budgetFrom"],
        message: "budgetFrom 不能指向自身",
      });
    }
    if ((decl.targets ?? []).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "points 参数必须声明至少一个 target",
      });
    }
    decl.targets?.forEach((t, i) => {
      if (t.min !== undefined && t.min < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targets", i, "min"], message: "min 不得为负" });
      }
      if (t.min !== undefined && t.max !== undefined && t.min > t.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targets", i, "max"], message: "min 不得大于 max" });
      }
    });
  });

/** 一步"抽到/选到就 set 哪些参数"。set 的键必须是本模板声明过的 param id。 */
export const OpeningBranchSetSchema = z.record(z.string().min(1), z.unknown());

/**
 * 转盘权重：静态 `weight` + 按**本会话已落定开局参数**调制的 `weightByParam`（ADR-001 D7）。
 *
 * ADR-001 D-4 反对的是读**世界属性**（开局期未实例化，状态面板算不出来），不反对读
 * param map 里已经 roll 定的值；因此 `weightBy` 继续拒载，`weightByParam` 放行。
 */
export const OpeningBranchOptionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    weight: z.number().nonnegative().optional(),
    /** 加载期拒载任何 weightBy —— 开局期未实例化，世界属性加权复用不了。 */
    weightBy: z.unknown().optional(),
    /**
     * 按开局参数调制权重（ADR-001 D7）：
     * - 数值参数 ⇒ 系数（`final += 参数值 × 系数`）；
     * - 枚举参数 ⇒ 查表（`final += 表[落定值] ?? 0`）。
     * 与事件侧 `WheelSegmentSchema.weightBy` 同一套算法，取值源换成 param map。
     */
    weightByParam: z
      .record(z.string().min(1), z.union([z.number(), z.record(z.string(), z.number())]))
      .optional(),
    set: OpeningBranchSetSchema,
    goto: z.string().min(1).optional(),
  })
  .strict()
  .refine((o) => o.weightBy === undefined, { message: "开局 roll 不支持 weightBy（ADR-001 D-4）" });

/**
 * 节点前置（ADR-072 D3）：**只看本会话已落定的开局参数**，不看世界状态。
 *
 * 为什么需要它：DAG 的选项没有 `conditions`，`goto` 又是编译期分流 ——
 * 「御三家才转传承那一格、其他人直接进通用术式池」在旧契约里写不出来（要么给所有人看，
 * 要么复制三条 lane 把性别/年龄/天赋整段抄三遍）。节点级前置把「这一格给谁看」
 * 从结构里拆出来：不成立的节点**静默跳过**（跟着它自己的 `goto ?? 下一个` 走），
 * 不占步数、不写结果、不上屏。
 *
 * 判据刻意做成**白名单小语法**而不是通用条件 DSL：开局期没有 WorldStateV2，
 * 复用事件条件会诱导模板作者写 `flag`/`status` 这些此刻还不存在的东西。
 */
export const OpeningNodeWhenSchema = z
  .object({
    /** 参数 id（必须是本 DAG 声明过的 flag 参数）。 */
    param: z.string().min(1),
    /** 取值白名单：落定值命中任意一项即算通过。 */
    in: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * 输入节点的预填候选（ADR-072 D7）。
 *
 * 一组候选按声明序求值，**第一个命中的胜出**：
 * - `when`：与节点前置同一套 `{ param, in }`（AND）；
 * - `require`：这些参数必须落定为**非空字符串**（例如「玩家在向导里填过名字」）；
 * - `text`：`{paramId}` 插值 + `{pick}`（从 `suggestions` 里按本节点 seed 取一个）。
 *   `{paramId}` 未落定 ⇒ 空串，所以「姓 + 名」这种拼接不需要额外语法。
 */
export const OpeningInputPrefillSchema = z
  .object({
    when: z.array(OpeningNodeWhenSchema).optional(),
    require: z.array(z.string().min(1)).optional(),
    text: z.string(),
  })
  .strict();

/**
 * 输入节点（ADR-072 D7）：**唯一一个让玩家写字符串的格子**。
 *
 * 落点由参数声明的 `kind` 决定，引擎不认识「名字」这个业务：
 * - `kind: name` ⇒ 写世界里的玩家名（`player.name`）；
 * - `kind: flag` ⇒ 写字符串旗标（必须同时声明 `flag: <旗标 id>`，因为 flag 参数是 `{id,value}`）。
 *
 * `attribute` 参数**刻意不支持**：枚举属性只接受声明过的选项 id、数值属性不接受字符串，
 * 让自由文本落进属性等于把一个坏值写进存档。要「按选项填」应该用 choose 节点。
 *
 * 校验顺序（运行期 `resolveStep`）：trim → 空值兜底（`defaultValue` → 预填）→
 * `minLength` / `maxLength` / `pattern`。长度按**码点数**（中文一个字算一）。
 */
export const OpeningInputSchema = z
  .object({
    /** 写哪个参数（必填）。 */
    param: z.string().min(1),
    /** `param` 是 flag 时必须给：写到哪个旗标 id 上。 */
    flag: z.string().min(1).optional(),
    /** 预填：字符串 = 单一候选；数组 = 按序取第一个命中的候选。 */
    prefill: z.union([z.string(), z.array(OpeningInputPrefillSchema).min(1)]).optional(),
    /** `{pick}` 的取值池（用到 `{pick}` 就必须给）。 */
    suggestions: z.array(z.string().min(1)).max(64).optional(),
    placeholder: z.string().min(1).optional(),
    /** 填写说明：输入框下方的一行小字（模板自己写，引擎不解释）。 */
    hint: z.string().min(1).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    /** 正则**源码**（加载期编译校验，运行期整串匹配）。 */
    pattern: z.string().min(1).optional(),
    /** 提交空串时的兜底值；也没给 ⇒ 用预填；预填也空 ⇒ 拒（`opening_input_required`）。 */
    defaultValue: z.string().min(1).optional(),
  })
  .strict();

/** branch DAG 节点：roll 自动掷、choose 玩家点、allocate 加点、input 玩家填字；可任意交错（R-OP-02）。 */
export const OpeningBranchNodeSchema = z
  .object({
    node: z.string().min(1),
    title: z.string().min(1),
    text: z.string().min(1).optional(),
    mode: z.enum(["roll", "choose", "allocate", "input"]),
    /** allocate 节点指向的 points 参数 id；roll/choose 可省略。 */
    param: z.string().min(1).optional(),
    /** input 节点的输入规格（写哪个参数 / 预填 / 校验）。 */
    input: OpeningInputSchema.optional(),
    options: z.array(OpeningBranchOptionSchema).optional(),
    goto: z.string().min(1).optional(),
    /** 前置（AND）：任一不成立 ⇒ 本节点整格跳过。见 `OpeningNodeWhenSchema`。 */
    when: z.array(OpeningNodeWhenSchema).optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    // ADR-004：allocate 没有 param 就无从知道「加哪一套点」，必须加载期拒载。
    if (node.mode === "allocate" && node.param === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["param"],
        message: "allocate 节点必须声明 param（points 参数 id）",
      });
    }
    if (node.mode !== "allocate" && node.param !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["param"],
        message: "param 只对 allocate 节点有意义",
      });
    }
    // ADR-072 D7：input 节点必须带 input 规格，且其它节点不能带 —— 否则模板作者
    // 写错一个 mode 就会得到一个「点了没反应」的格子。
    if (node.mode === "input" && node.input === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input"],
        message: "input 节点必须声明 input（写哪个参数 / 预填 / 校验）",
      });
    }
    if (node.mode !== "input" && node.input !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input"],
        message: "input 只对 mode: input 的节点有意义",
      });
    }
    if (node.mode === "input" && (node.options?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "input 节点不接受 options（玩家写的是字符串，不是选项）",
      });
    }
  });

/** 前实例化开局声明（新 opening.yaml 的顶层形状，可选分域）。 */
export const OpeningBranchDagSchema = z
  .object({
    openingId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    params: z.array(OpeningParamDeclSchema),
    entry: z.string().min(1),
    nodes: z.array(OpeningBranchNodeSchema).min(1),
  })
  .strict()
  .superRefine((dag, ctx) => {
    const ids = new Set(dag.params.map((p) => p.id));
    const kindById = new Map(dag.params.map((p) => [p.id, p.kind]));
    if (ids.size !== dag.params.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["params"], message: "重复 param id" });
    }
    const nodes = new Set<string>();
    dag.nodes.forEach((n, i) => {
      if (nodes.has(n.node)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", i, "node"], message: `重复节点 id：${n.node}` });
      }
      nodes.add(n.node);
      for (const [optionIndex, option] of (n.options ?? []).entries()) {
        for (const [key, value] of Object.entries(option.set)) {
          const path = ["nodes", i, "options", optionIndex, "set", key] as const;
          if (!ids.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path],
              message: `set 引用未声明参数：${key}`,
            });
            continue;
          }
          // set 值按 param kind 透传（引擎推断落点），但 relation 的 kind 是闭集枚举：
          // 此处放行非法值会写进 state.relations，存档将永久载不回来（开局提交后即坏档）。
          if (kindById.get(key) === "relation") {
            const rel = value as { with?: unknown; value?: unknown; kind?: unknown } | null;
            if (typeof rel !== "object" || rel === null) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "relation 参数值必须是对象" });
              continue;
            }
            if (typeof rel.with !== "string") {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "relation 缺少 with（目标角色 id）" });
            }
            if (typeof rel.value !== "number") {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "relation 缺少数值 value" });
            }
            if (rel.kind !== undefined && !RelationKindSchema.safeParse(rel.kind).success) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path],
                message: `relation kind 不在闭集内：${String(rel.kind)}`,
              });
            }
          }
        }
      }
    });
    if (!nodes.has(dag.entry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entry"], message: `entry 指向不存在的节点：${dag.entry}` });
    }
  });

/** 会话一步的结果（只记结果，不记 Draft / 中间世界）。 */
export const OpeningStepResultSchema = z
  .object({
    nodeId: z.string().min(1),
    optionId: z.string().min(1).optional(),
    rollIndex: z.number().int().nonnegative().optional(),
    /** allocate 节点的最终分配结果：paramId -> attribute -> value */
    allocation: z.record(z.string(), z.record(z.string(), z.number())).optional(),
    /** input 节点玩家填的原文（已 trim；落点由节点声明的 `input.param` 决定）。 */
    input: z.string().optional(),
  })
  .strict();

/** 会话契约（服务端资源，不进 WorldStateV2）。 */
export const OpeningSessionSchema = z
  .object({
    id: z.string().min(1),
    templateId: z.string().min(1),
    templateVersion: z.string().min(1),
    openingId: z.string().min(1),
    seed: z.number().int(),
    nodeId: z.string().min(1),
    results: z.array(OpeningStepResultSchema),
    done: z.boolean(),
  })
  .strict();

export type OpeningTemplate = z.infer<typeof OpeningTemplateSchema>;
export type OpeningBranchDag = z.infer<typeof OpeningBranchDagSchema>;
export type OpeningBranchNode = z.infer<typeof OpeningBranchNodeSchema>;
export type OpeningBranchOption = z.infer<typeof OpeningBranchOptionSchema>;
export type OpeningParamDecl = z.infer<typeof OpeningParamDeclSchema>;
export type OpeningSession = z.infer<typeof OpeningSessionSchema>;
export type OpeningStepResult = z.infer<typeof OpeningStepResultSchema>;
export type OpeningRun = z.infer<typeof OpeningRunSchema>;
export type OpeningStep = z.infer<typeof OpeningStepSchema>;
export type OpeningEventPool = z.infer<typeof OpeningEventPoolSchema>;
export type OpeningPoolEvent = z.infer<typeof OpeningPoolEventSchema>;
export type OpeningSetup = z.infer<typeof OpeningSetupSchema>;
export type OpeningNpcSetup = z.infer<typeof OpeningNpcSetupSchema>;
export type OpeningRelation = z.infer<typeof OpeningRelationSchema>;
export type OpeningScheduledEvent = z.infer<typeof OpeningScheduledEventSchema>;
export type OpeningHandoff = z.infer<typeof OpeningHandoffSchema>;
