/**
 * 模板加载器（**纯层**）：吃一个 `TemplateSource`，产出 `WorldTemplateV2` 与可选分域。
 *
 * 为什么单开一个包：同一段代码要在服务端（fs 源）与浏览器（fetch / IndexedDB 源）跑，
 * 而 `apps/server/src/templates.ts` 牵着 `node:fs` / `node:crypto` / 目录发现与 mtime，
 * 浏览器进不去。这里只做「合并分域 → schema → 跨文件引用 → 扩展版本核对」，
 * **不碰文件系统、不碰进程环境**（ADR-070 D1）。
 *
 * 指纹用 `sha256Hex`（shared 的纯 TS 实现）而不是 `node:crypto`：客户端要自己算指纹。
 */

import { parse } from "yaml";
import { z } from "zod";
import {
  AssetManifestSchema,
  BUILTIN_UI_CAPABILITIES,
  EffectSchema,
  EndingConfigSchema,
  EvaluationConfigSchema,
  ENGINE_VERSION,
  EventTriggerSchema,
  OpeningBranchDagSchema,
  OpeningTemplateSchema,
  RulesSchema,
  TemplateEffectSchema,
  TimeSpecSchema,
  UiConfigSchema,
  WorldTemplateV2Schema,
  satisfiesVersion,
  sha256Hex,
  type AssetManifest,
  type EndingConfig,
  type EvaluationConfig,
  type LoreRule,
  type OpeningBranchDag,
  type OpeningTemplate,
  type Rules,
  type TemplateSource,
  type TimeSpec,
  type UiConfig,
  type WorldTemplateV2,
} from "@life-sim/shared";
import {
  BUILTIN_CONDITION_OPS,
  collectExtensionConditions,
  getExtensionRuntime,
  hasExtensionRuntime,
  installedExtensionIds,
  isKinshipKind,
  registeredUiCapabilities,
  resolveExtensionRuntimes,
} from "@life-sim/game-core";

export const DECLARATIVE_FILES = [
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
  "opening.yaml",
  "endings.yaml",
  "evaluation.yaml",
  "rules.yaml",
  "lore.md",
  "assets/manifest.yaml",
  "ui.yaml",
] as const;

export const DECLARATIVE_SET: ReadonlySet<string> = new Set(DECLARATIVE_FILES);

/** 白名单中带 `/` 的嵌套相对路径条目（顶层 Dirent 不可见）。从数组派生，单一事实来源。 */
export const NESTED_DECLARATIVE: readonly string[] = DECLARATIVE_FILES.filter((f) => f.includes("/"));

/**
 * 合并进 `WorldTemplateV2` 的文件（前 6 个必需 + 装备 / 战斗 AI 两个分域）。
 * `opening/endings/evaluation` **不并入**模板对象——它们是可选分域，各有自己的 schema
 * 与消费方（开局 / 结局决胜 / 评价），并入会撞 `WorldTemplateV2Schema` 的 strict 校验。
 * T-06：保持前 8 项不变，`rules.yaml` / `assets/manifest.yaml` 绝不并入（独立 loader 消费）。
 */
export const TEMPLATE_MERGE_FILES: ReadonlySet<string> = new Set([
  "world.yaml",
  "characters.yaml",
  "skills.yaml",
  "items.yaml",
  "statuses.yaml",
  "events.yaml",
  "equipment.yaml",
  "combat-ai.yaml",
]);

export type TemplateLoadReasonCode =
  | "unknown_extension"
  | "unknown_effect_type"
  | "unknown_condition_op"
  | "kinship_conflict"
  | "core_version_mismatch"
  | "extension_version_mismatch";

/** 带封闭码的加载失败：`scanVersion` 的 catch 靠它把码一路带到 Entry 与 API 响应。 */
export class TemplateLoadError extends Error {
  readonly reasonCode: TemplateLoadReasonCode;

  constructor(reasonCode: TemplateLoadReasonCode, message: string) {
    super(message);
    this.name = "TemplateLoadError";
    this.reasonCode = reasonCode;
  }
}

/**
 * 启动期也**只标该版本 invalid、不拒进程**的封闭码集合（「能力缺失」类）。
 *
 * 共同点：都不是「yaml 语法 / 取值非法」（那是 `template_invalid`，启动期仍 fail-fast），
 * 而是「服务端装的东西 / 模板声明的能力 / 模板内部自洽性」这一层的问题，
 * 且只影响这一个版本（其它模板照样能玩）。
 *
 * `kinship_conflict` 是「模板自相矛盾」（声明了 family 又自己写亲属边），错误在模板内容，
 * 但同样只废一个版本、不需要整台服务陪葬，故与 `unknown_extension` 同一处置方式。
 */

export function assertExtensionsInstalled(template: WorldTemplateV2): void {
  const declared = template.extensions;
  if (declared === undefined) return;
  const missing = Object.keys(declared).filter((extensionId) => !hasExtensionRuntime(extensionId));
  if (missing.length === 0) return;
  const installed = installedExtensionIds();
  throw new TemplateLoadError(
    "unknown_extension",
    `模板声明了未注册的扩展 ${missing.map((extensionId) => `"${extensionId}"`).join(", ")}；` +
      `已注册的扩展 id：${installed.length > 0 ? installed.join(", ") : "（无）"}` +
      `（扩展包需在 apps/server 启动期注册，见 apps/server/src/extensions.ts）`,
  );
}

/**
 * 加载期版本核对（`docs/EXTENSIONS.md` §3.1）。三向检查，任一不符 ⇒ 该版本 invalid：
 * 1. `requires.core` vs 当前主包 `ENGINE_VERSION`；
 * 2. `requires.extensions[id]` vs 已装 runtime 的 `version`；
 * 3. 已装 runtime 的 `requiresCore` vs 当前主包（扩展自己声明的兼容区间）。
 *
 * 没写 `requires` 的模板跳过 1/2；扩展没声明版本的视为 "*"，老扩展零回归。
 * 第 3 条只要世界声明了该扩展就查——它保护的是"主包升级后扩展没跟上"这一类静默不兼容。
 */
export function assertVersionRequirements(template: WorldTemplateV2): void {
  const requires = template.requires;
  if (requires?.core !== undefined && !satisfiesVersion(ENGINE_VERSION, requires.core)) {
    throw new TemplateLoadError(
      "core_version_mismatch",
      `requires.core: 世界要求主包 ${requires.core}，当前主包版本是 ${ENGINE_VERSION}`,
    );
  }
  const declared = template.extensions ?? {};
  for (const [id, range] of Object.entries(requires?.extensions ?? {})) {
    if (declared[id] === undefined) {
      throw new TemplateLoadError(
        "extension_version_mismatch",
        `requires.extensions["${id}"] 声明了版本，但 extensions: 里没有声明这个扩展`,
      );
    }
    const runtime = getExtensionRuntime(id);
    if (runtime === undefined) continue; // 已由 assertExtensionsInstalled 拦截
    if (!satisfiesVersion(runtime.version ?? "*", range)) {
      throw new TemplateLoadError(
        "extension_version_mismatch",
        `requires.extensions["${id}"]: 世界要求 ${range}，已装扩展版本是 ${runtime.version ?? "(未声明)"}`,
      );
    }
  }
  for (const id of Object.keys(declared)) {
    const runtime = getExtensionRuntime(id);
    if (runtime === undefined) continue;
    if (!satisfiesVersion(ENGINE_VERSION, runtime.requiresCore)) {
      throw new TemplateLoadError(
        "core_version_mismatch",
        `扩展 "${id}" 要求主包 ${runtime.requiresCore ?? "*"}，当前主包版本是 ${ENGINE_VERSION}`,
      );
    }
  }
}

/**
 * 加载期校验：亲缘的两种合规写法互斥（`extensions/family/doc/FAMILY-GRAPH.md` §1/§2）。
 *
 * - 模式一（不装 `extensions.family`）：模板自己写 `father` / `mother` / `wife` … 亲属边；
 * - 模式二（装 `extensions.family`）：**只写 `fatherId` / `motherId` 指针**，亲缘由扩展建图推导。
 *
 * 同时占两样 ⇒ `kinship_conflict`。这不是「扩展覆盖模板」的问题：投影时模板那条边先进
 * `factCounterpartIds`，扩展从指针推出的行发现该对手已存在便**静默丢弃**，全程无报错 ——
 * 模板作者以为在用扩展，实际扩展被架空，比直接崩更难查。所以冲突必须在加载期炸。
 *
 * 判据用 game-core 的 `isKinshipKind`（由 shared 的 `KinshipKindSchema` 派生），
 * 不手抄枚举：`relative` / `husband` 这类将来增删时两处口径不可能漂移。
 *
 * **覆盖面**：只查 `characters[].relations[]`，即模板的**静态声明**。
 * 事件效果里运行期建的边（`addRelationEdge` / 效果建边）不在本闸门范围 —— 那是运行期
 * 数据，加载期看不到；运行期边与扩展推导如何共存是另一件事，别把这里的通过当成
 * 「全链路已查过亲属边」。
 *
 * 非亲属 kind（`friend` / `enemy` / `mentor` / `colleague` …）不受影响：两种模式下都能写。
 *
 * 已在 `scanVersion` 接入：三个内置模板（valmont / jjk-2006 / jjk-shinjuku）均已按各自模式
 * 合规，装了 family 的 valmont 只写指针，jjk-2006 撤掉了 family 声明走边模式。
 */
export function assertKinshipCompliance(template: WorldTemplateV2): void {
  if (template.extensions?.family === undefined) return;

  const conflicts: string[] = [];
  for (const character of template.characters) {
    for (const relation of character.relations ?? []) {
      if (!isKinshipKind(relation.kind)) continue;
      conflicts.push(`${character.id} → ${relation.to}, ${relation.kind}`);
    }
  }
  if (conflicts.length === 0) return;

  // 大模板（valmont 12 人）能写出几十条：全量塞进 reason 会淹没重点，只点名前 5 条 + 总数。
  const shown = conflicts.slice(0, 5).join("；");
  const suffix = conflicts.length > 5 ? `；…共 ${conflicts.length} 条` : "";
  throw new TemplateLoadError(
    "kinship_conflict",
    `模板声明了 family 扩展，但 characters 里仍写了亲属边（${shown}${suffix}）。` +
      `装了扩展时亲缘应由 fatherId/motherId 指针提供；` +
      `要么删掉这些边，要么撤掉 extensions.family。`,
  );
}

/**
 * 内核效果 type 集合：从 `EffectSchema` 派生（与 `engine.ts` 的 `KNOWN_EFFECT_TYPES`
 * 同源 —— 手抄第二份名单必然在某次加效果时漂移）。
 */
const KERNEL_EFFECT_TYPES: ReadonlySet<string> = new Set(
  EffectSchema.options.map((option) => option.shape.type.value),
);

/**
 * 模板里**装着效果数组**的键名。
 *
 * 不全量按 `type` 字段识别效果：`items[].type` / `statuses[].id` / 结局条件的
 * `type: worldState` 也叫 `type`，一把抓会把它们误判成效果。效果只出现在这两个键下
 * （`effects`：事件选项 / 转盘段 / 战斗结算 / actions / NPC 行动 / 开局 / 分支；
 * `use`：物品使用），与 schema 的 `TemplateEffectSchema` 使用点一一对应。
 */
const EFFECT_ARRAY_KEYS: ReadonlySet<string> = new Set(["effects", "use"]);

interface OpenUsage {
  /** 效果 type 或条件 op。 */
  readonly name: string;
  /** 可诊断路径（`events[0].settle.normal.options[0].effects[0]`）。 */
  readonly path: string;
}

/**
 * 递归收集模板里所有**开放形**效果与条件。
 *
 * 开放形判据：
 * - 效果 = 位于 `effects` / `use` 数组里、且 `type` 是字符串的对象（闭合形已由
 *   `TemplateEffectSchema` 校验过，走到这里说明是开放形）；
 * - 条件 = 带字符串 `op` 的对象（`OpenConditionSchema` 是 strict 的 `{ op, args }`，
 *   与扁平条件不可能混淆）。
 */
function collectOpenUsages(
  node: unknown,
  path: string,
  key: string | undefined,
  out: { effects: OpenUsage[]; conditions: OpenUsage[] },
): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectOpenUsages(item, `${path}[${index}]`, key, out));
    return;
  }
  const record = asRecord(node);
  if (record === null) return;
  if (key !== undefined && EFFECT_ARRAY_KEYS.has(key) && typeof record.type === "string") {
    out.effects.push({ name: record.type, path });
  }
  if (typeof record.op === "string") {
    out.conditions.push({ name: record.op, path });
  }
  for (const [childKey, child] of Object.entries(record)) {
    collectOpenUsages(child, path === "" ? childKey : `${path}.${childKey}`, childKey, out);
  }
}

/**
 * 开放形词表的加载期裁定（fail-fast 的关键一步）。
 *
 * 开放形（`{ type }` / `{ op, args }`）让模板能写扩展定义的效果与条件，代价是
 * **schema 不再知道某个 type / op 是否真的有人实现**。这里把它补回去：
 *
 * - 效果：内核 27 种 ⇒ 通过；否则必须在模板**已声明**扩展注册的 `effects[].type` 里；
 * - 条件：内核内置 op（`always` / `random` / `flagSet` / `eventResolved`，与
 *   `rules.yaml` 触发器同一张注册表）⇒ 通过；否则必须在已声明扩展的 `conditions` 里；
 * - 都不满足 ⇒ `unknown_effect_type` / `unknown_condition_op`。
 *
 * 「已声明」是硬条件（`docs/EXTENSIONS.md` 保证 4）：未在 `world.yaml` 的 `extensions:`
 * 里写过的扩展，即使包装着也不跑 —— 所以它的 type / op 在模板里同样不合法。
 *
 * 覆盖面：主域（事件 / 转盘 / 战斗结算 / actions / NPC 行动 / NPC 刷新规则 / 物品）、
 * `opening.yaml`、`endings.yaml`。`rules.yaml` 不在扫描范围：它的开放形 op 本来就走
 * 注册表 + `unknown_reference` 运行期诊断（R11 老口径），另立加载期规则会造第二套判据。
 */
export function assertOpenVocabularyDeclared(
  template: WorldTemplateV2,
  openings: readonly OpeningTemplate[],
  endingConfig: EndingConfig | undefined,
): void {
  const used: { effects: OpenUsage[]; conditions: OpenUsage[] } = { effects: [], conditions: [] };
  collectOpenUsages(template, "", undefined, used);
  collectOpenUsages(openings, "opening.yaml", undefined, used);
  if (endingConfig !== undefined) collectOpenUsages(endingConfig, "endings.yaml", undefined, used);
  if (used.effects.length === 0 && used.conditions.length === 0) return;

  const declared = Object.keys(template.extensions ?? {});
  const declaredLabel = declared.length > 0 ? declared.join(", ") : "（未声明任何扩展）";

  const declaredEffectTypes = new Set<string>();
  for (const extension of resolveExtensionRuntimes(template)) {
    for (const handler of extension.runtime.effects ?? []) declaredEffectTypes.add(handler.type);
  }
  const unknownEffect = used.effects.find(
    (usage) => !KERNEL_EFFECT_TYPES.has(usage.name) && !declaredEffectTypes.has(usage.name),
  );
  if (unknownEffect !== undefined) {
    throw new TemplateLoadError(
      "unknown_effect_type",
      `${unknownEffect.path}: 效果类型 "${unknownEffect.name}" 不在内核 ${KERNEL_EFFECT_TYPES.size} 种效果里，` +
        `也没有任何模板已声明的扩展注册它；模板 extensions: ${declaredLabel}` +
        `（想在模板里写扩展效果，先在 world.yaml 的 extensions: 声明提供它的扩展）`,
    );
  }

  const knownOps = new Set<string>([...BUILTIN_CONDITION_OPS, ...Object.keys(collectExtensionConditions(template))]);
  const unknownOp = used.conditions.find((usage) => !knownOps.has(usage.name));
  if (unknownOp !== undefined) {
    throw new TemplateLoadError(
      "unknown_condition_op",
      `${unknownOp.path}: 条件 op "${unknownOp.name}" 既不是内核内置 op` +
        `（${BUILTIN_CONDITION_OPS.join(", ")}），也没有任何模板已声明的扩展注册它；` +
        `模板 extensions: ${declaredLabel}` +
        `（想在模板里写扩展条件，先在 world.yaml 的 extensions: 声明提供它的扩展）`,
    );
  }
}

/**
 * 语义指纹：每个文件「名 + \u0000 + 内容」按序拼成字节流后的 sha256。
 *
 * 与旧实现（`createHash` 逐段 update）**逐字节一致**；换成纯 TS 是为了让浏览器
 * 也能算（客户端自己校验模板），见 `packages/shared/src/sha256.ts`。
 */
export function fingerprintOfPairs(
  pairs: ReadonlyArray<{ name: string; content: string }>,
): string {
  return `sha256:${sha256Hex(pairs.map((pair) => `${pair.name}\u0000${pair.content}`).join(""))}`;
}

export function firstIssue(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue) return `${issue.path.join(".") || "<root>"}: ${issue.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}


const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const TemplateBranchGotoSchema = z.union([
  z.string().min(1),
  z
    .object({
      node: z.string().min(1),
      after: TimeSpecSchema.optional(),
    })
    .strict(),
]);

/**
 * 模板分支节点：与 `story.submitBranch` 的 node 同形；`title` 可省略（缺省继承父事件 title /
 * node 别名），`effects` 用**模板原生的规范 Effect**（不是 LLM 那三种扁平形状）。
 */
const TemplateBranchNodeSchema = z
  .object({
    node: z.string().min(1).max(40),
    /**
     * **角色分派（YAML 专用）**：同一 `node` 别名可写多份，每份带不同 `as` —— 表示这一幕
     * 只有当前 self 是该演员时呈现。self 恒单值 ⇒ 同别名的多个变体天然互斥。
     * **首节点同样可写 `as`**：多个首节点变体共用父 trigger，靠一等条件 `selfIs` /
     * `selfIsNot` 在出队终判互斥（"共用触发器、首节点不一样"）。无 as 的兜底变体沿用父 id。
     * 变体节点在加载期展开成独立事件；入口处 `goto` 与外部 `nextEventId` 自动翻译成
     * 按 self 门控的同形选项（玩家仍只看到一条、不额外占轮次）。
     * LLM 的 `submitBranch` node 没有这个字段（它参与时角色已确定）。
     */
    as: z.string().min(1).optional(),
    title: z.string().min(1).max(40).optional(),
    text: z.string().min(1).max(600),
    actors: z.array(z.string().min(1)).max(6).optional(),
    mentions: z.array(z.string().min(1)).max(6).optional(),
    npcs: z.array(z.string().min(1)).max(6).optional(),
    options: z
      .array(
        z
          .object({
            text: z.string().min(1).max(120),
            /**
             * 模板侧效果用**规范 Effect**，一次选项常常要同时做「置结局旗标 + 改生命周期 +
             * 调关系 + 调资源」——上限 4 是从 LLM 那套扁平 DSL 抄来的，对模板太紧。
             * 提到 8：够写完整的一幕，又不至于让一个选项变成脚本。
             */
            effects: z.array(TemplateEffectSchema).max(8).optional(),
            /** 分支内跳转：只能指本 branch 的节点。 */
            goto: TemplateBranchGotoSchema.optional(),
            /**
             * **跳出分支**、回到模板主线：直接写目标事件 id（可以是任何模板事件）。
             * 存在性由展开后的 `WorldTemplateV2Schema` superRefine 校验（展开在前、parse 在后）。
             *
             * 与 `goto` 互斥：一个选项要么在分支内继续走，要么离开分支 ——
             * 两个都写等于没说清"这一幕结束后去哪"，直接拒载。
             */
            nextEventId: z.string().min(1).optional(),
          })
          .strict()
          .superRefine((option, ctx) => {
            if (option.goto !== undefined && option.nextEventId !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["nextEventId"],
                message: "goto（分支内跳转）与 nextEventId（跳出分支）互斥，只能写一个",
              });
            }
          }),
      )
      .min(1)
      .max(4),
  })
  .strict();

const TemplateBranchEventSchema = z
  .object({
    id: z.string().min(1),
    /** 可选父级标题：节点没写 title 时继承。 */
    title: z.string().min(1).max(40).optional(),
    trigger: EventTriggerSchema,
    branch: z.array(TemplateBranchNodeSchema).min(1).max(12),
  })
  .strict();

/**
 * 把 `events[].branch`（模板侧分支）展开成普通 `EventV2[]`：
 * - **首节点沿用父事件 id**（`<eventId>`，外部 `nextEventId` / `eventResolved` 零改动），
 *   其余节点 `<eventId>#<node>`；`goto` → `nextEventId`；`goto.after` → 后继 `trigger.window.start`；
 * - 第一个节点继承父事件的 `trigger`，其余节点为 `chain`（只靠 nextEventId 到达）；
 * - 展开后引擎完全不知道"分支"这个概念，复用的仍是普通事件调度。
 *
 * 撞车护栏：首节点复用父 id 属于**自我替换**（先从占位集合摘掉自己的 id）；
 * 其余展开 id 与任何手写事件 / 另一条分支的展开 id 重复 ⇒ 加载期拒载。
 *
 * 真样例见 `specs/data/templates/jjk-shinjuku/1.0.0/events.yaml` 的 `evt:north-counter`。
 */
function expandTemplateEvents(
  rawEvents: readonly unknown[],
  actorIds?: ReadonlySet<string>,
): unknown[] {
  // 第一遍：所有声明的事件 id 先占位（**含 branch 父 id**）；手写 id 自身重复即拒载。
  const ids = new Set<string>();
  for (const raw of rawEvents) {
    const rec = asRecord(raw);
    if (rec === null) continue;
    if (typeof rec.id === "string") {
      if (ids.has(rec.id)) throw new Error(`events: id 重复：${rec.id}`);
      ids.add(rec.id);
    }
  }

  const out: unknown[] = [];
  /** 多变体首节点的父 id → 各变体（含 id / as）；供第二遍把"指向父 id 的入边"改写成 self 门控。 */
  const firstVariantsByParent = new Map<string, { id: string; as?: string }[]>();
  for (const raw of rawEvents) {
    const rec = asRecord(raw);
    if (rec === null || rec.branch === undefined) {
      out.push(raw);
      continue;
    }
    if (rec.settle !== undefined) {
      throw new Error(
        `events: ${String(rec.id ?? "?")} 的 branch 与 settle 互斥（一个事件只能选一种形态）`,
      );
    }
    const parsed = TemplateBranchEventSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `events: branch 事件校验失败（${issue?.path.join(".") || "<root>"}: ${issue?.message ?? ""}）`,
      );
    }
    const event = parsed.data;
    const prefix = `${event.id}#`;
    const firstAlias = event.branch[0]?.node;
    /**
     * 同一 node 别名可写多份 `as` 变体 ⇒ 同一幕、不同 self 看到不同剧情，天然互斥。
     * 必须留一个无 as 的兜底变体，否则未覆盖的角色走到这里会软锁。
     * 首节点同样适用：兜底变体沿用父 id 作稳定入口，as 变体展开成 `<id>#<node>@<as>`。
     */
    const variantsByNode = new Map<string, typeof event.branch>();
    for (const node of event.branch) {
      const list = variantsByNode.get(node.node) ?? [];
      list.push(node);
      variantsByNode.set(node.node, list);
    }
    for (const [alias, variants] of variantsByNode) {
      const seen = new Set<string>();
      for (const variant of variants) {
        const key = variant.as ?? "*";
        if (seen.has(key)) {
          throw new Error(`events: ${event.id} 的节点 ${alias} 的 as 重复：${key}`);
        }
        seen.add(key);
        if (variant.as !== undefined && actorIds !== undefined && !actorIds.has(variant.as)) {
          throw new Error(`events: ${event.id} 的节点 ${alias} 的 as 指向未知演员：${variant.as}`);
        }
      }
      if (variants.length > 1 && !variants.some((v) => v.as === undefined)) {
        throw new Error(`events: ${event.id} 的节点 ${alias} 缺少无 as 的兜底变体`);
      }
    }
    const aliases = new Set(variantsByNode.keys());
    /**
     * 某节点所有 as 变体的演员 id（用于给**兜底变体**装配 selfIsNot 门控）。
     * 没有它，兜底会与 as 变体同时通过 trigger.conditions（chain 在出队终判、pool 在候选门控），
     * 造成"两个首节点都触发"的串戏；self 恒单值 ⇒ selfIsNot 列表天然与 selfIs 互斥。
     */
    const otherAsOf = (alias: string, selfAs: string | undefined): string[] =>
      (variantsByNode.get(alias) ?? [])
        .map((v) => v.as)
        .filter((a): a is string => a !== undefined && a !== selfAs);
    // goto 闭合 + 同一目标 after 一致（与 submitBranch 同一口径）。
    const afterByTarget = new Map<string, { canonical: string; spec?: TimeSpec }>();
    for (const node of event.branch) {
      for (const option of node.options) {
        if (option.goto === undefined) continue;
        const target = typeof option.goto === "string" ? { node: option.goto } : option.goto;
        if (!aliases.has(target.node)) {
          throw new Error(`events: ${event.id} 的 goto 指向 branch 之外的节点：${target.node}`);
        }
        const canonical = target.after === undefined ? "null" : JSON.stringify(target.after);
        const prev = afterByTarget.get(target.node);
        if (prev !== undefined && prev.canonical !== canonical) {
          throw new Error(
            `events: ${event.id} 的节点 ${target.node} 收到不一致的 goto.after（同一幕只能有一个延迟）`,
          );
        }
        afterByTarget.set(
          target.node,
          target.after === undefined ? { canonical } : { canonical, spec: target.after },
        );
      }
    }

    // 首节点的**兜底变体**（无 as）沿用父 id：外部 nextEventId / eventResolved 零改动。
    // 若首节点只有 as 变体（无兜底），它们已在上方的多变体校验中被拒，故这里必能找到兜底。
    // 先摘掉自己的占位，再逐节点 add（否则会把自己判成撞车）。
    ids.delete(event.id);
    const expandedId = (alias: string, as?: string): string =>
      alias === firstAlias && as === undefined
        ? event.id
        : `${prefix}${alias}${as !== undefined ? `@${as}` : ""}`;

    // 记录多变体首节点：入边（上游 nextEventId）也要按 self 门控，否则 as 变体永远进不来。
    const firstVariants = variantsByNode.get(firstAlias ?? "") ?? [];
    if (firstVariants.length > 1) {
      firstVariantsByParent.set(
        event.id,
        firstVariants.map((v) => ({
          id: expandedId(firstAlias!, v.as),
          ...(v.as !== undefined ? { as: v.as } : {}),
        })),
      );
    }

    for (const node of event.branch) {
      const id = expandedId(node.node, node.as);
      if (ids.has(id)) {
        throw new Error(
          `events: branch 展开后的事件 id 撞车：${id}（与手写事件或另一条分支重复）`,
        );
      }
      ids.add(id);
      const isFirst = node.node === firstAlias;
      // 首节点是入口、没有上游 goto ⇒ 永不挂 after（与变体书写顺序无关）。
      const afterSpec = !isFirst ? afterByTarget.get(node.node)?.spec : undefined;
      /**
       * 一等 self 门控：
       * - as 变体 ⇒ `{ selfIs: <as> }`（只有该 self 命中）；
       * - 兜底变体且同节点有 as 变体 ⇒ 一条 `{ selfIsNot }` 排除每一个 as（都不命中才走兜底）；
       * - 无 as 变体的普通节点 ⇒ 不装配，零回归。
       * chain 来源在出队终判求值（scheduler.checkEventPremise），pool 来源在候选门控求值，
       * 两条路径都能保证同一时刻只有一个变体成立。
       */
      const selfGate =
        node.as !== undefined
          ? [{ selfIs: node.as }]
          : otherAsOf(node.node, undefined).map((a) => ({ selfIsNot: a }));
      const inherited = event.trigger.conditions ?? [];
      out.push({
        id,
        title: node.title ?? event.title ?? node.node,
        narrative: node.text,
        kind: "normal",
        ...(node.actors !== undefined ? { actors: [...node.actors] } : {}),
        ...(node.mentions !== undefined ? { mentions: [...node.mentions] } : {}),
        ...(node.npcs !== undefined ? { npcs: [...node.npcs] } : {}),
        trigger: isFirst
          ? // 首节点（兜底 + 各 as 变体）**共用父 trigger**：source / window / once / 权重等
            // 全部继承，只把 self 门控并进 conditions —— 这就是"共用触发器、首节点不一样"。
            selfGate.length > 0
            ? { ...event.trigger, conditions: [...inherited, ...selfGate] }
            : event.trigger
          : {
              source: "chain",
              ...(afterSpec !== undefined ? { window: { start: afterSpec } } : {}),
              // 变体事件再用一等条件 selfIs/selfIsNot 兜一层：直接按 id 入队也不会串戏。
              ...(selfGate.length > 0 ? { conditions: [...inherited, ...selfGate] } : {}),
            },
        settle: {
          normal: {
            // goto 到有 as 变体的节点 ⇒ 展开成多条 selfIs 门控的「同一条选项」；
            // self 单值 ⇒ 玩家仍只看到一条，不额外耗一轮、也不做角色选择题。
            options: node.options.flatMap((option, optionIndex) => {
              const base = {
                text: option.text,
                ...(option.effects !== undefined ? { effects: option.effects } : {}),
              };
              if (option.goto !== undefined) {
                const target = typeof option.goto === "string" ? { node: option.goto } : option.goto;
                const targets = variantsByNode.get(target.node) ?? [];
                return targets.map((t, targetIndex) => ({
                  ...base,
                  id: `${id}.opt.${optionIndex + 1}${targets.length > 1 ? `.${targetIndex + 1}` : ""}`,
                  ...(t.as !== undefined ? { visibleWhen: [{ selfIs: t.as }] } : {}),
                  nextEventId: expandedId(target.node, t.as),
                }));
              }
              if (option.nextEventId !== undefined) {
                // 跳出分支：目标在模板主线里，原样透传（存在性由 parse 的 superRefine 校验）。
                return [{ ...base, id: `${id}.opt.${optionIndex + 1}`, nextEventId: option.nextEventId }];
              }
              return [{ ...base, id: `${id}.opt.${optionIndex + 1}` }];
            }),
          },
        },
      });
    }
  }

  /**
   * 第二遍：**入边分派**。首节点 as 变体共用父 trigger，但 chain 来源靠 `nextEventId`
   * 直接入队（applySuccessor 不看 conditions）—— 若所有上游都指向父 id（兜底变体），
   * as 变体永远进不来。这里把"指向多变体首节点父 id"的入边改写成按 self 门控的同形项：
   * - normal option：一条拆成 N 条同文同 effects、各带 visibleWhen 的选项（玩家只见一条）；
   * - random wheel / combat outcome：没有 visibleWhen 可挂 ⇒ 加载期拒载，避免静默串戏。
   *
   * 门控语义（self 恒单值 ⇒ 恒互斥，且必有兜底）：
   * - as 变体 ⇒ `visibleWhen: [{ selfIs: <as> }]`；
   * - 兜底变体 ⇒ `visibleWhen: [ ...每个 as 各一条 { selfIsNot } ]`（数组内 AND，逐条展开）。
   */
  if (firstVariantsByParent.size > 0) {
    const rejectUnsupported = (kind: string, target: string, where: string): never => {
      throw new Error(
        `events: ${kind} 的 ${where} 指向有多角色首节点的事件 ${target}；该入边无法按角色分派，请改用 normal 选项进入`,
      );
    };
    /** 把一条带 nextEventId 的项拆成 self 门控的多条；返回 null 表示无需改写。 */
    const gatedEntries = (item: Record<string, unknown>): Record<string, unknown>[] | null => {
      const target = item.nextEventId;
      if (typeof target !== "string") return null;
      const list = firstVariantsByParent.get(target);
      if (list === undefined) return null;
      const allAs = list.map((v) => v.as).filter((a): a is string => a !== undefined);
      return list.map((v, i) => ({
        ...item,
        id: `${String(item.id)}.entry.${i + 1}`,
        visibleWhen:
          v.as !== undefined
            ? [{ selfIs: v.as }]
            : allAs.map((a) => ({ selfIsNot: a })),
        nextEventId: v.id,
      }));
    };

    for (const raw of out) {
      const rec = asRecord(raw);
      if (rec === null) continue;
      const settle = asRecord(rec.settle);
      if (settle === null) continue;
      const kind = String(rec.kind ?? "");
      if (kind === "normal") {
        const normal = asRecord(settle.normal);
        if (normal === null || !Array.isArray(normal.options)) continue;
        normal.options = normal.options.flatMap((o) => {
          const item = asRecord(o);
          if (item === null) return [o];
          return gatedEntries(item) ?? [o];
        });
      } else if (kind === "random") {
        const random = asRecord(settle.random);
        const wheel = random === null ? null : asRecord(random.wheel);
        for (const seg of (wheel?.segments ?? []) as unknown[]) {
          const item = asRecord(seg);
          if (item !== null && typeof item.nextEventId === "string" && firstVariantsByParent.has(item.nextEventId)) {
            rejectUnsupported("random.wheel", item.nextEventId, "segment");
          }
        }
      } else if (kind === "combat") {
        const combat = asRecord(settle.combat);
        for (const key of ["onVictory", "onDefeat", "onFlee"]) {
          const item = combat === null ? null : asRecord(combat[key]);
          if (item !== null && typeof item.nextEventId === "string" && firstVariantsByParent.has(item.nextEventId)) {
            rejectUnsupported("combat", item.nextEventId, key);
          }
        }
      }
    }
  }
  return out;
}

/**
 * **纯加载入口**（本地化迁移第一步，2026-11-21）。
 *
 * 只吃 `TemplateSource` + 文件清单，不碰 fs —— 判定的全部内容（合并分域、schema、跨文件
 * 引用、扩展版本）都在这里。服务端用 `FsTemplateSource`，测试 / 将来的客户端用
 * `MemoryTemplateSource`，两边跑的是同一段逻辑。
 *
 * 与 `scanVersion` 的分工：这里不负责目录发现、mtime、资产扫描与注册表策略，
 * 那些属于**适配器**。调用方拿到的要么是模板，要么是一条带文件名的错误。
 */
export function loadTemplateFromSource(
  source: TemplateSource,
  files?: ReadonlySet<string>,
): WorldTemplateV2 {
  // 缺省按「源里实际存在」求 present 集：内存源常常只有几个文件，
  // 传全量白名单会让它去读不存在的 combat-ai.yaml，报错指向错的文件。
  const present = files ?? new Set([...DECLARATIVE_SET].filter((rel) => source.exists(rel)));
  return loadTemplate(source, present);
}

/** 合并模板主域为一份 `WorldTemplateV2`（只读存在的文件，缺文件由 schema 校验报错）。 */
export function loadTemplate(source: TemplateSource, files: ReadonlySet<string>): WorldTemplateV2 {
  const merged: Record<string, unknown> = {};
  for (const file of [...files].filter((f) => TEMPLATE_MERGE_FILES.has(f)).sort()) {
    // 解析失败必须能定位到**文件**（只报行号不足以判断是哪个分域文件坏了）。
    let doc: Record<string, unknown> | null;
    try {
      doc = parse(source.read(file)) as Record<string, unknown> | null;
    } catch (error) {
      throw new Error(`${file}: ${firstIssue(error)}`);
    }
    if (doc === null || typeof doc !== "object") {
      throw new Error(`${file}: yaml 根节点必须是映射`);
    }
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
  // P1：模板侧 `events[].branch` 在加载期展开成普通事件；非数组原样交给 schema 报类型错。
  // 角色分派 `as` 只认模板角色 id（或默认 self "player"），未知 id 在加载期拒载。
  if (Array.isArray(merged.events)) {
    const actorIds = new Set<string>(["player"]);
    if (Array.isArray(merged.characters)) {
      for (const c of merged.characters) {
        if (c !== null && typeof c === "object" && typeof c.id === "string") actorIds.add(c.id);
      }
    }
    merged.events = expandTemplateEvents(merged.events, actorIds);
  }
  return WorldTemplateV2Schema.parse(merged);
}

/** 读取可选 opening.yaml；openingId 重复属模板缺陷，加载期即失败。 */
export function loadOpenings(
  source: TemplateSource,
  files: ReadonlySet<string>,
): { legacy: OpeningTemplate[]; branchDag?: OpeningBranchDag } {
  if (!files.has("opening.yaml")) return { legacy: [] };
  const raw = parse(source.read("opening.yaml"));
  // ADR-001：新语法是**单个 branch DAG 对象**（有 `params`/`entry`/`nodes`），
  // 旧语法是 OpeningTemplate 数组。两者择一，按形状判别，加载期都走严格 schema。
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "nodes" in raw) {
    try {
      return { legacy: [], branchDag: OpeningBranchDagSchema.parse(raw) };
    } catch (error) {
      throw new Error(`opening.yaml: ${firstIssue(error)}`);
    }
  }
  let list: OpeningTemplate[];
  try {
    list = z.array(OpeningTemplateSchema).parse(raw);
  } catch (error) {
    throw new Error(`opening.yaml: ${firstIssue(error)}`);
  }
  const ids = new Set<string>();
  for (const t of list) {
    if (ids.has(t.openingId)) throw new Error(`opening.yaml: openingId 重复：${t.openingId}`);
    ids.add(t.openingId);
  }
  return { legacy: list };
}

/** 按文件存在性加载单个可选分域；校验失败由调用方决定 fail-fast 还是标 invalid。 */
export function loadOptionalConfig<T>(
  source: TemplateSource,
  file: string,
  files: ReadonlySet<string>,
  schema: { parse: (input: unknown) => T },
): T | undefined {
  if (!files.has(file)) return undefined;
  try {
    return schema.parse(parse(source.read(file)));
  } catch (error) {
    throw new Error(`${file}: ${firstIssue(error)}`);
  }
}

// ---------- T-06：两个独立声明式文件的 loader（Group B：绑定 schema + 加载期 fail-fast） ----------

/**
 * `rules.yaml` 独立加载器（**不并入** `TEMPLATE_MERGE_FILES`）。
 *
 * 契约 = `RulesSchema`（4 个顶层键、`.strict()`）。校验失败**直接抛错**，由 `scanVersion`
 * 的 catch 收敛成 `{ ok: false, reason }`：启动期 ⇒ `template_invalid` 拒绝启动；
 * 运行期 ⇒ 该版本标 `invalid`（有旧 Entry 则保留旧的）。绝不再「warn + 静默丢文件」。
 */
export function loadRules(source: TemplateSource): Rules {
  try {
    return RulesSchema.parse(parse(source.read("rules.yaml")));
  } catch (error) {
    throw new Error(`rules.yaml: ${firstIssue(error)}`);
  }
}

/**
 * `ui.yaml` 独立加载器（第 15 个白名单文件，**不进** `TEMPLATE_MERGE_FILES`，也**不进语义指纹**）。
 *
 * 契约 = `UiConfigSchema`（形状 B：`place:` 闭合能力 id → tab/overlay/off/slot:<host>，`.strict()`）。
 * 键名写错一律加载期拒载，不静默忽略。能力 id 的合法集合 = 宿主内建集 ∪ 已注册扩展声明的
 * `uiCapabilities`；这样扩展新增视图不需要改主包 schema。
 */
export function loadUi(source: TemplateSource): UiConfig {
  let config: UiConfig;
  try {
    config = UiConfigSchema.parse(parse(source.read("ui.yaml")));
  } catch (error) {
    throw new Error(`ui.yaml: ${firstIssue(error)}`);
  }
  const allowed = new Set<string>([
    ...BUILTIN_UI_CAPABILITIES,
    ...registeredUiCapabilities(),
  ]);
  const unknown = Object.keys(config.place ?? {}).filter((capability) => !allowed.has(capability));
  if (unknown.length > 0) {
    throw new Error(
      `ui.yaml: 未知能力 id ${unknown.map((id) => `"${id}"`).join(", ")}；` +
        `合法 id = 宿主内建 ${BUILTIN_UI_CAPABILITIES.join("/")}` +
        ` + 已装扩展声明的能力（${[...registeredUiCapabilities()].join("/") || "无"}）`,
    );
  }
  return config;
}

/**
 * `lore.md` 独立加载器（第 14 个白名单文件，不进 `TEMPLATE_MERGE_FILES`，但进语义指纹）。
 *
 * 解析规则（与模板作者约定）：
 * - `## 标题` 切条目；标题即 `id`（重名拒载）。
 * - 标题后**第一个非空行**若以 `>` 开头是元信息：`|` 分段，支持
 *   `keys: a, b`（逗号分隔）、`always`、`p:N`（0..100）。
 * - 缺省 `always = true`；写了 `keys` 但没写 `always` ⇒ 视为关键词触发（false）。
 * - 正文到下一个 `## ` 为止，`trim`；空正文拒载。
 * - 未知元信息 / keys 为空 / p 越界 / 重名 ⇒ 拒载，错误里带条目标题。
 */
export function parseLoreMarkdown(text: string): LoreRule[] {
  const lines = text.split(/\r?\n/);
  const entries: LoreRule[] = [];
  const seen = new Set<string>();
  let title: string | null = null;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (title === null) return;
    const entryTitle = title;
    let cursor = 0;
    while (cursor < bodyLines.length && bodyLines[cursor]!.trim() === "") cursor += 1;
    let meta: string | undefined;
    const first = bodyLines[cursor]?.trim() ?? "";
    if (first.startsWith(">")) {
      meta = first.slice(1).trim();
      cursor += 1;
    }
    const body = bodyLines.slice(cursor).join("\n").trim();
    if (body === "") {
      throw new Error(`条目「${entryTitle}」没有正文`);
    }

    let keys: string[] = [];
    let always: boolean | undefined;
    let priority = 0;
    if (meta !== undefined) {
      for (const raw of meta.split("|").map((part) => part.trim()).filter((part) => part !== "")) {
        if (raw === "always") {
          always = true;
        } else if (raw.startsWith("keys:")) {
          keys = raw
            .slice("keys:".length)
            .split(/[,，]/)
            .map((key) => key.trim())
            .filter((key) => key !== "");
          if (keys.length === 0) throw new Error(`条目「${entryTitle}」的 keys 为空`);
        } else if (/^p:\s*\d+$/.test(raw)) {
          priority = Number.parseInt(raw.replace(/^p:\s*/, ""), 10);
          if (priority < 0 || priority > 100) {
            throw new Error(`条目「${entryTitle}」的 p 越界：${priority}（允许 0..100）`);
          }
        } else {
          throw new Error(`条目「${entryTitle}」有未知元信息：${raw}`);
        }
      }
    }
    if (seen.has(entryTitle)) throw new Error(`条目「${entryTitle}」重名`);
    seen.add(entryTitle);
    entries.push({
      id: entryTitle,
      title: entryTitle,
      text: body,
      keys,
      always: always ?? keys.length === 0,
      priority,
    });
    title = null;
    bodyLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      title = line.slice(3).trim();
      if (title === "") throw new Error("存在空标题的 ## 条目");
      continue;
    }
    if (title !== null) bodyLines.push(line);
  }
  flush();
  return entries;
}

export function loadLore(source: TemplateSource): LoreRule[] {
  try {
    return parseLoreMarkdown(source.read("lore.md"));
  } catch (error) {
    throw new Error(`lore.md: ${firstIssue(error)}`);
  }
}

/** `assets/manifest.yaml` 独立加载器：契约 = `AssetManifestSchema`，失败同样加载期即抛。 */
export function loadAssetManifest(source: TemplateSource): AssetManifest {
  try {
    return AssetManifestSchema.parse(parse(source.read("assets/manifest.yaml")));
  } catch (error) {
    throw new Error(`assets/manifest.yaml: ${firstIssue(error)}`);
  }
}

/** manifest 内部条目：含 path 供资产端点按 id 定位；path 绝不下发给客户端。 */
export interface AssetTableEntry {
  assetId: string;
  path: string;
  kind: string;
  characterRef?: string;
}

/**
 * 从已校验的 `AssetManifest` 派生资产表，供摘要投影与资产端点共用。
 * 入参类型即 `AssetManifestSchema` 的产物，无需再做防御式形状判断。
 */
export function readAssetEntries(assetManifest: AssetManifest | undefined): AssetTableEntry[] {
  if (assetManifest === undefined) return [];
  return assetManifest.assets.map((asset) => ({
    assetId: asset.assetId,
    path: asset.path,
    kind: asset.kind,
    ...(asset.characterRef !== undefined ? { characterRef: asset.characterRef } : {}),
  }));
}
