import {
  ContentBlockSchema,
  DIAGNOSTIC_CODES,
  CharacterSchema,
  EventV2Schema,
  SubmitBranchArgsSchema,
  type BranchEffect,
  type ApiCall,
  type CallReceipt,
  type ContentBlock,
  type DiagnosticCode,
  type DispatchContext,
  type DispatchResult,
  type Effect,
  type EngineApiHandle,
  type Character,
  type EventV2,
  type GeneratedNpc,
  type FactChange,
  type Perspective,
  type PerspectiveFactView,
  type SetKnowledgeArgs,
  type SlotScene,
  type TemplateLookup,
  type V2Snapshot,
  type WorldStateV2,
} from "@life-sim/shared";
import {
  allowedContentRefs,
  applyKnowledgeBatch,
  buildFacts as computeFacts,
} from "./perspective.js";
import { createContentSink, type ContentSink } from "../v2/narrative.js";

/**
 * T-01：唯一权威写入口 `RpgEngineAPI.dispatch`。
 *
 * 硬不变量：「无 API 调用即无事实变更」——`dispatch([], ctx)` 返回同一 state（逐字段相等），
 * 因为空调用不触发任何 handler、不克隆、不写任何字段。
 *
 * 设计要点：
 * - 工具注册表 **数据化**（Map 查表），引擎不 switch on 工具名；新增工具只需注册。
 * - 13 个 `DiagnosticCode` 全可判别（DIAGNOSTIC_META 覆盖），RETRYABLE 带 `factsHint` 回灌。
 * - 幂等：`idempotencyKey` 重复 ⇒ `idempotency_conflict`（FATAL）。
 * - `CallReceipt` 带 `changes` / `factsHint`。
 * - `state.slot` 的唯一写入收敛到本文件的 `assignSlot`（见 turn.ts 收敛）。
 * - F3：叙事正文只进 `ContentSink`（trace），绝不进 `WorldStateV2`；`content.*` 的 refs
 *   经 `allowedContentRefs` 做窗口校验，越窗 ⇒ `visibility_violation`（RETRYABLE）。
 * - F4：窗口计算（buildFacts）由 game-core 拥有，agent-runtime 不得自建判据。
 */

/** 13 码全覆盖：每个诊断码的 RETRYABLE / FATAL 分类（v2 §5.2 / §5.3）。 */
export const DIAGNOSTIC_META: Record<DiagnosticCode, { retryable: boolean }> = {
  unknown_tool: { retryable: false },
  invalid_arguments: { retryable: false },
  unknown_reference: { retryable: true },
  precondition_failed: { retryable: true },
  numeric_out_of_range: { retryable: true },
  state_conflict: { retryable: true },
  visibility_violation: { retryable: true },
  idempotency_conflict: { retryable: false },
  budget_exceeded: { retryable: true },
  timeout: { retryable: true },
  provider_unavailable: { retryable: true },
  retry_exhausted: { retryable: true },
  duplicate_invocation: { retryable: false },
};

export function isRetryable(code: DiagnosticCode): boolean {
  return DIAGNOSTIC_META[code].retryable;
}

/**
 * 不可重试码的选择（ADR-0035 IO-1）。
 *
 * 踩过的坑，记在这里：原本用 `state_conflict` + 在回执上覆盖 `retryable: false`，
 * 但 `CallReceiptSchema` **没有 `retryable` 字段**，而 `loop.ts` 判可重试读的是
 * `isRetryable(receipt.code)` —— 也就是**只看码表，不看回执**。所以那个覆盖是死代码：
 * `state_conflict` 在码表里 `retryable: true`，循环照样会重试，白烧 `retryLimit`。
 *
 * 因此跨回合只能选一个**码表里本就不可重试**的码。`idempotency_conflict`
 * （"这次写入不该再发生"）是 13 码里唯一语义贴合的：重试一万次，那一轮也已经过去了。
 */
export const CROSS_TURN_CODE = "idempotency_conflict" as const;

/**
 * ADR-0035 IO-1：结构写入不得跨回合。
 *
 * 判据是「写入时刻的世界轮次」与「创作这一轮的上下文轮次」是否相等。二者不等只有一种成因：
 * invocation 晚到（异步 LLM），于是它基于 A 轮状态算出来的事件/DAG 被写进了 A+n 轮的世界
 * —— 那就是"已死 npc 诈尸"，或（加 missWhen 后）静默的"错误错过"。两种都不可接受。
 *
 * `ctx.turnIndex` 在 agent loop 起始处固定（`loop.ts` 的 `dispatchCtx`），早于任何 await，
 * 所以它恒等于"创作轮"。编排层的事务边界（per-world 锁）保证这条守卫永远不该被触发；
 * 它被触发就说明有人绕过了事务 ⇒ 必须拒绝，不能降级放行。
 */
function crossTurnViolation(state: WorldStateV2, ctx: { turnIndex: number }): ToolRunResult | null {
  if (state.turnIndex === ctx.turnIndex) return null;
  return rejected(
    CROSS_TURN_CODE,
    `结构写入跨回合（ADR-0035 IO-1）：写入时 state.turnIndex=${state.turnIndex}，创作轮 ctx.turnIndex=${ctx.turnIndex}`,
    { stateTurnIndex: state.turnIndex, ctxTurnIndex: ctx.turnIndex },
  );
}

/**
 * 回灌信息结构化（v2 §2.3）：changes = { path, before?, after? }[]，
 * factsHint = Record<string, unknown>（当前正确事实片段）。均不再是 string[]。
 */
export type ToolRunResult =
  | { ok: true; changes: FactChange[]; factsHint?: Record<string, unknown> }
  | {
      ok: false;
      code: DiagnosticCode;
      detail?: string;
      factsHint?: Record<string, unknown>;
      retryable: boolean;
    };

export interface ToolRunEnv {
  sink: ContentSink;
  /**
   * 模板纯函数查表（可选）。`story.submitBranch` 的节点级 `npcs` 需要把
   * alias → 角色 id → 刷新规则 id 三选一解析并拒掉未知引用；缺省时退化为
   * 「只解析 alias，其余原样透传」，由占槽呈现期的 `materializeEventNpcs` 兜底解析。
   */
  lookup?: TemplateLookup;
}

export interface ToolHandler {
  run(
    state: WorldStateV2,
    args: unknown,
    ctx: DispatchContext,
    env: ToolRunEnv,
  ): ToolRunResult;
}

/** 数据化工具注册表：key = 工具名，value = 处理器；引擎按名查表，不 switch on 工具名。 */
export type ToolRegistry = ReadonlyMap<string, ToolHandler>;

const accepted = (
  changes: FactChange[],
  factsHint?: Record<string, unknown>,
): ToolRunResult => ({
  ok: true,
  changes,
  ...(factsHint !== undefined ? { factsHint } : {}),
});

const rejected = (
  code: DiagnosticCode,
  detail: string,
  factsHint?: Record<string, unknown>,
): ToolRunResult => ({
  ok: false,
  code,
  detail,
  ...(factsHint !== undefined ? { factsHint } : {}),
  retryable: isRetryable(code),
});

// ---------- 内置工具处理器（注册为数据，非分支） ----------

/**
 * `story.submitBranch`（AGENTIC-GM 重构 · 设计 §4/§5）：提交**一整条独立分支**。
 *
 * 边界（用户裁定，硬约束）：
 * - LLM **永远不入队、不占槽**：本 handler 只把定义写进 `state.generatedEvents`，
 *   排不排、什么时候排，由回合边界的引擎调度决定。
 * - **引擎上必须独立**：不引用、不修改任何既有事件；`goto` 只能指向本次提交内的 node。
 * - 全局 id / 选项 id 由引擎分配（`gen:<invocationId>:<node>`），模型只给局部别名，
 *   防止伪造引用。
 * - **原子性**：整条分支要么全落、要么全不落（任何一块不合 schema 即整体拒绝）。
 */
/**
 * 分支的**扁平效果** → 引擎规范 `Effect`。
 *
 * 对外协议故意只有三种形状（`{flag,value}` / `{mood}` / `{hp}|{mp}`）：
 * 真实模型记不住 24 变体的判别联合，会反复写错字段名。这里做一次映射，
 * 把"作者语言"翻译成"引擎语言"。
 */
function toCanonicalEffects(
  list: readonly BranchEffect[],
  /** 本次提交内的 NPC 别名 → 全局 id（引用解析用） */
  npcIdByAlias: ReadonlyMap<string, string>,
): Effect[] {
  return list.map((effect) => {
    if ("flag" in effect) return { type: "setFlag", id: effect.flag, value: effect.value };
    if ("mood" in effect) return { type: "adjustMood", value: effect.mood };
    if ("hp" in effect) return { type: "adjustResource", resource: "hp", value: effect.hp };
    if ("mp" in effect) return { type: "adjustResource", resource: "mp", value: effect.mp };
    if ("spawn" in effect) {
      /**
       * `spawn` 两种来源，**同一实例表**：
       * - 本次提交新造的人（别名命中）⇒ 激活生成角色（unspawned → alive）；
       * - 模板刷新规则 id（别名不命中）⇒ 走 `spawnNpc`，幂等、受 `npcSpawnRules` 管辖。
       * 引擎先查别名再查规则；两者都不是 ⇒ 后面 `spawnNpc` 会以未知规则报错。
       */
      const generated = npcIdByAlias.get(effect.spawn);
      return generated !== undefined
        ? { type: "setNpcLifecycle", npcId: generated, state: "alive" }
        : { type: "spawnNpc", ruleId: effect.spawn };
    }
    if ("relation" in effect) {
      const target = npcIdByAlias.get(effect.relation.with) ?? effect.relation.with;
      return { type: "adjustRelation", npcId: target, value: effect.relation.to };
    }
    if ("relationEdge" in effect) {
      // 端点解析：本次提交别名 → 其余原样（`player` / 模板角色 id 由引擎侧判活处理）。
      const from = npcIdByAlias.get(effect.relationEdge.from) ?? effect.relationEdge.from;
      const to = npcIdByAlias.get(effect.relationEdge.to) ?? effect.relationEdge.to;
      return {
        type: "addRelationEdge",
        fromId: from,
        toId: to,
        kind: effect.relationEdge.kind,
        visibility: effect.relationEdge.visibility,
      };
    }
    if ("secret" in effect) {
      const npc = npcIdByAlias.get(effect.secret.npc) ?? effect.secret.npc;
      return { type: "addSecret", npcId: npc, text: effect.secret.text };
    }
    const target = npcIdByAlias.get(effect.lifecycle.npc) ?? effect.lifecycle.npc;
    return { type: "setNpcLifecycle", npcId: target, state: effect.lifecycle.state };
  });
}

/**
 * 把「分支里新造的 NPC」编译成角色定义 + 实例。
 *
 * 硬约束（与模板角色共用同一套不变量）：
 * - **id 由引擎分配**（`gennpc:<invocationId>:<alias>`），模型只给本次提交的局部别名；
 * - 只采纳展示与基础规则需要的字段：`isEnemy` / `combatHints` / `knowledge` 这类
 *   **会影响规则判定**的东西一律引擎缺省，不接受模型指定；
 * - 属性值钳到 `[0, 20]`（与模板属性量级同阶），超出即钳，不信任入参；
 * - 实例以 `unspawned` 落表 —— "定义了" ≠ "登场了"，登场由选项效果 `{spawn}` 激活。
 */
function buildGeneratedNpc(
  npc: GeneratedNpc,
  invocationId: string,
): { character: Character; instance: WorldStateV2["npcs"][number] } | null {
  const id = `gennpc:${invocationId}:${npc.alias}`;
  const attributes: Record<string, number> = {};
  for (const [key, raw] of Object.entries(npc.attributes ?? {})) {
    attributes[key] = Math.max(0, Math.min(20, Math.round(raw)));
  }
  const character: Character = {
    id,
    isEnemy: false,
    identity: {
      name: npc.name,
      age: npc.age ?? 30,
      gender: npc.gender ?? "unknown",
    },
    visibility: "public",
    lifecycle: { state: "unspawned" },
    mood: { value: 50 },
    attributes,
    public: {
      ...(npc.personality !== undefined ? { personality: npc.personality } : {}),
      ...(npc.knownGoals !== undefined ? { knownGoals: [...npc.knownGoals] } : {}),
    },
    private: {
      ...(npc.goals !== undefined ? { goals: [...npc.goals] } : {}),
    },
    relationship: npc.relationship ?? 0,
  };
  const parsed = CharacterSchema.safeParse(character);
  if (!parsed.success) return null;
  const c = parsed.data;
  const instance: WorldStateV2["npcs"][number] = {
    id: c.id,
    name: c.identity.name,
    gender: c.identity.gender,
    age: c.identity.age,
    birthTime: 0,
    attributes: { ...c.attributes },
    hp: 1,
    mp: 1,
    mood: c.mood.value,
    statuses: [],
    skillCooldowns: {},
    inventory: {},
    skills: [],
    relationship: c.relationship,
    personality: c.public.personality ?? "",
    knownGoals: [...(c.public.knownGoals ?? [])],
    goals: [...(c.private.goals ?? [])],
    traits: [],
    knowledge: [],
    secrets: [],
    lastActedAtTurn: 0,
    isEnemy: false,
    // 生成角色一律进玩家列表：模型不能把人藏起来（`character.visibility` 已由引擎固定为 public）
    visibility: c.visibility,
    lifecycle: { state: "unspawned", sinceTurn: 0, sinceWorldTime: 0 },
  };
  return { character: c, instance };
}

const submitBranch: ToolHandler = {
  run(state, args, ctx, env) {
    // 结构写入必须与本回合同事务（与 fact.* 同一条守卫）。
    const violation = crossTurnViolation(state, ctx);
    if (violation !== null) return violation;

    const parsed = SubmitBranchArgsSchema.safeParse(args);
    if (!parsed.success) {
      return rejected(
        "invalid_arguments",
        `story.submitBranch 参数未通过 schema：${parsed.error.issues[0]?.path.join(".") ?? "?"} ${parsed.error.issues[0]?.message ?? ""}`.trim(),
      );
    }
    const { trigger, branch } = parsed.data;

    // 本次提交新造的 NPC：先全部编译（含 schema 校验），再在最后一步原子落表。
    const npcIdByAlias = new Map<string, string>();
    const newCharacters: Character[] = [];
    const newInstances: Array<WorldStateV2["npcs"][number]> = [];
    for (const npc of parsed.data.npcs ?? []) {
      if (npcIdByAlias.has(npc.alias)) {
        return rejected("invalid_arguments", `NPC 别名重复：${npc.alias}`);
      }
      const built = buildGeneratedNpc(npc, ctx.invocationId ?? "local");
      if (built === null) {
        return rejected("invalid_arguments", `NPC 定义未通过 CharacterSchema：${npc.alias}`);
      }
      npcIdByAlias.set(npc.alias, built.character.id);
      newCharacters.push(built.character);
      newInstances.push(built.instance);
    }

    // 局部别名唯一
    const aliases = new Set<string>();
    for (const node of branch) {
      if (aliases.has(node.node)) {
        return rejected("invalid_arguments", `节点别名重复：${node.node}（同一次提交内必须唯一）`);
      }
      aliases.add(node.node);
    }
    // goto 闭合：只能指向本次提交内的节点（跨提交一律拒）
    for (const node of branch) {
      for (const option of node.options) {
        if (option.goto !== undefined && !aliases.has(option.goto)) {
          return rejected(
            "unknown_reference",
            `goto 指向本次提交之外的节点：${option.goto}（分支必须自洽，不可接续既有剧情）`,
            { allowedRefs: [...aliases] },
          );
        }
      }
    }

    const prefix = `gen:${ctx.invocationId}:`;
    const compiled: EventV2[] = [];
    for (const [index, node] of branch.entries()) {
      /**
       * 节点级 `npcs` 解析（S1 的 LLM 源）：本次提交 alias → 模板角色 id → 刷新规则 id。
       * alias 命中生成角色（换成引擎分配的全局 id）；其余原样保留，由占槽呈现期的
       * `materializeEventNpcs` 统一判活/拉起。注入了 `lookup` 时，三者都不是 ⇒ 整条拒绝。
       */
      const resolvedNpcs: string[] = [];
      for (const ref of node.npcs ?? []) {
        const alias = npcIdByAlias.get(ref);
        if (alias !== undefined) {
          resolvedNpcs.push(alias);
          continue;
        }
        const isRule = state.spawnRules.some((r) => r.ruleId === ref);
        const isCharacter = env.lookup?.character(ref) !== undefined;
        if (env.lookup !== undefined && !isRule && !isCharacter) {
          return rejected(
            "unknown_reference",
            `节点 ${node.node} 的 npcs 引用未知角色/刷新规则：${ref}`,
          );
        }
        // 未注入 lookup 时原样透传（呈现期兜底解析），保证不误拒。
        resolvedNpcs.push(ref);
      }

      const event: EventV2 = {
        id: `${prefix}${node.node}`,
        title: node.title,
        narrative: node.text,
        kind: "normal",
        // 参与角色随定义编译进去：引擎在**呈现前**复核存活/在场（防诈尸）。
        ...(node.actors !== undefined ? { actors: [...node.actors] } : {}),
        // `mentions` 只指涉、不校验在场（纪念/缅怀逝者用）。
        ...(node.mentions !== undefined ? { mentions: [...node.mentions] } : {}),
        // 节点级 `npcs`（已解析）：占槽呈现时把人拉上场（alive 幂等）。
        ...(resolvedNpcs.length > 0 ? { npcs: resolvedNpcs } : {}),
        /**
         * **只有入口节点（`branch[0]`）参与调度**；下游节点一律 `chain`，
         * 只能由上一节的选项 `goto` 到达。
         *
         * 为什么必须这样（2026-11-16 实测事故）：起初整条分支的每个节点都编译成
         * `schedule`，于是回合边界那一次扫描把三节**同时入队**；而玩家选选项时
         * `goto` 又按链边再入队一次 ⇒ 同一幕被播放多次（存档里 n4c 出现 3 次：
         * 两次 fired + 一次仍在 waiting）。两套入口撞在一起。
         */
        trigger:
          index > 0
            ? { source: "chain" }
            : trigger.mode === "certain"
              ? {
                  source: "schedule",
                  /**
                   * 相对入队时刻换算 ⇒ 下一轮扫描即到期（不是"世界时间 0"）。
                   * `TimeAmountSchema` 要求 `value` 是**正整数**，`value: 0` 会被拒；
                   * 1 分钟已经小于任何一轮的默认步长（10 分钟），等价于"入队即到期"。
                   */
                  window: { start: { value: 1, unit: "minute" } },
                }
              : {
                  source: "pool",
                  weight: 1,
                },
        settle: {
          normal: {
            options: node.options.map((option, index) => ({
              id: `opt-gen-${index + 1}`,
              text: option.text,
              // 显式给 [] 而不是省略：省略的语义是"这个选项什么也不做"，
              // 而缺省语义将来一变就是静默改行为。
              effects: toCanonicalEffects(option.effects ?? [], npcIdByAlias),
              ...(option.goto !== undefined ? { nextEventId: `${prefix}${option.goto}` } : {}),
            })),
          },
        },
      } as EventV2;

      // 用与模板事件**同一个** schema 校验：生成事件必须与模板事件同形，
      // 否则调度器/投影/前端会各走一条特殊路径。
      const check = EventV2Schema.safeParse(event);
      if (!check.success) {
        return rejected(
          "invalid_arguments",
          `节点 ${node.node} 编译后未通过 EventV2Schema：${check.error.issues[0]?.message ?? "?"}`,
        );
      }
      compiled.push(check.data as EventV2);
    }

    // 追加式：注册后不再修改（与"不能在已有结构上打补丁"同一条纪律）。
    state.generatedEvents = [...(state.generatedEvents ?? []), ...compiled];
    // 新造的人：定义 + 实例（unspawned）一起落表，与模板角色共用同一实例表。
    if (newCharacters.length > 0) {
      state.generatedCharacters = [...(state.generatedCharacters ?? []), ...newCharacters];
      state.npcs = [...state.npcs, ...newInstances];
    }
    return accepted([{ path: "generatedEvents", after: compiled.map((e) => e.id).join(",") }]);
  },
};

/**
 * content.* 共用处理器（F4，追加2）：窗口校验 + 正文进 sink（不写 state）+ 媒体锚点。
 *
 * 硬不变量：**绝不采信 args 自带的窗口**。dispatch 第 2 层只以 ctx.targetPerspective
 * 为权威验收窗口；args 里若带 targetPerspective 且 !== ctx.targetPerspective，
 * 立即 visibility_violation（RETRYABLE，带 factsHint）。refs[] 也只比对该权威窗口。
 */
const writeContent: ToolHandler = {
  run(state, args, ctx, env) {
    const parsed = ContentBlockSchema.safeParse(args);
    if (!parsed.success) return rejected("invalid_arguments", "content 块未通过 ContentBlockSchema");
    const block: ContentBlock = parsed.data;
    const target: Perspective = ctx.targetPerspective;
    if (block.targetPerspective !== target) {
      return rejected(
        "visibility_violation",
        `args.targetPerspective (${block.targetPerspective}) 不等于权威窗口 ${target}（F4）`,
        { targetPerspective: target, received: block.targetPerspective },
      );
    }
    const allowed = allowedContentRefs(state, target);
    const violations = block.refs.filter((r) => !allowed.has(r));
    if (violations.length > 0) {
      return rejected(
        "visibility_violation",
        `refs 越出 ${target} 窗口：${violations.join(", ")}`,
        { allowedRefs: [...allowed], violations },
      );
    }
    env.sink.append(block);
    const changes: FactChange[] = [
      { path: `trace.contentBlocks.${block.blockId}`, after: block.blockId },
    ];
    if (block.assetId !== undefined && block.slot !== undefined) {
      state.media = [...(state.media ?? []), { slot: block.slot, assetId: block.assetId }];
      changes.push({ path: `media.${block.slot}`, after: block.assetId });
    }
    return accepted(changes);
  },
};

/**
 * `agent.submit`：invocation 正常落地的终止点。
 *
 * F3：traceRef 是 trace 的引用锚；正文仍只在 sink，不进 state。
 * 同时清掉本轮的在飞标记（只在 id 匹配时清 —— 见 `EngineApiHandle.clearPending`）。
 */
const submitContent: ToolHandler = {
  run(state, _args, ctx) {
    const traceRef = `trace:${ctx.invocationId ?? "local"}`;
    state.traceRef = traceRef;
    if (
      ctx.invocationId !== undefined &&
      state.pendingInvocation?.invocationId === ctx.invocationId
    ) {
      state.pendingInvocation = undefined;
    }
    return accepted([{ path: "traceRef", after: traceRef }]);
  },
};

function defaultToolRegistry(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set("story.submitBranch", submitBranch);
  /**
   * 叙事写入只留两个：`narrative.write`（正文）/ `narrative.flavor`（环境旁注）。
   *
   * 删除的三个，理由各不相同：
   * - `content.writeOption`：**"写一个选项"在语义上就是错的** —— 选项是事件块里的
   *   `options`，由引擎分配 id、由事件面板呈现；它不是叙事，不该有"写"的入口。
   * - `content.writeMemory`：记忆是**知识台账**，由模板 `knowledgeGrants` 授予。
   * - `content.referenceAsset`：媒体挂载不是叙事；将来接资产应作为 `narrative.write`
   *   的可选参数（`assetId`），而不是独立工具。
   */
  for (const name of ["narrative.write", "narrative.flavor"]) {
    map.set(name, writeContent);
  }
  map.set("agent.submit", submitContent);
  return map;
}

export interface EngineApiDeps {
  state: WorldStateV2;
  /** 追加 / 覆盖工具（数据化注册，不 switch）。 */
  toolRegistry?: ToolRegistry;
  /** 模板纯函数查表（供 submitBranch 节点级 npcs 解析；可选）。 */
  lookup?: TemplateLookup;
  sink?: ContentSink;
  /** 注入完整投影（Wave 2 server 注入 projectSnapshotV2）；缺省用 player 窗口最小投影。 */
  projectSnapshot?: (state: WorldStateV2) => V2Snapshot;
}

/**
 * 引擎 API 实现 `EngineApiHandle`。所有 `WorldStateV2` 权威字段写入都发生在本类的方法 /
 * `assignSlot` 内（源码守卫据此断言）。
 */
export class RpgEngineAPI implements EngineApiHandle {
  readonly state: WorldStateV2;
  readonly sink: ContentSink;
  private readonly tools: Map<string, ToolHandler>;
  private readonly env: ToolRunEnv;
  private readonly deps: EngineApiDeps;
  private readonly seenIdempotency = new Set<string>();

  constructor(deps: EngineApiDeps) {
    this.deps = deps;
    this.state = deps.state;
    this.sink = deps.sink ?? createContentSink();
    this.tools = defaultToolRegistry();
    if (deps.toolRegistry) {
      for (const [name, handler] of deps.toolRegistry) this.tools.set(name, handler);
    }
    this.env = {
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      sink: this.sink,
    };
  }

  /** 唯一权威写入口。空调用 ⇒ 零写入、返回同一 state（硬不变量）。 */
  dispatch(calls: ApiCall[], ctx: DispatchContext): DispatchResult {
    const receipts: CallReceipt[] = [];
    for (const call of calls) receipts.push(this.runOne(call, ctx));
    return { receipts, state: this.state };
  }

  private runOne(call: ApiCall, ctx: DispatchContext): CallReceipt {
    const callId = call.callId;
    const idem = "idempotencyKey" in call ? call.idempotencyKey : undefined;
    if (idem !== undefined && this.seenIdempotency.has(idem)) {
      return {
        callId,
        outcome: "rejected",
        code: "idempotency_conflict",
        detail: "重复 idempotencyKey",
      };
    }
    const handler = this.tools.get(call.tool);
    if (!handler) {
      return { callId, outcome: "rejected", code: "unknown_tool", detail: call.tool };
    }
    let result: ToolRunResult;
    try {
      result = handler.run(this.state, call.args, ctx, this.env);
    } catch (err) {
      return {
        callId,
        outcome: "rejected",
        code: "precondition_failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (result.ok) {
      if (idem !== undefined) this.seenIdempotency.add(idem);
      const receipt: CallReceipt = { callId, outcome: "accepted" };
      if (result.changes.length > 0) receipt.changes = result.changes;
      if (result.factsHint !== undefined) receipt.factsHint = result.factsHint;
      return receipt;
    }
    const receipt: CallReceipt = { callId, outcome: "rejected", code: result.code };
    if (result.detail !== undefined) receipt.detail = result.detail;
    if (result.factsHint !== undefined) receipt.factsHint = result.factsHint;
    return receipt;
  }

  /** snapshot ≡ player 窗口投影（永远不含 world 隐秘 / 叙事正文）。 */
  snapshot(): V2Snapshot {
    if (this.deps.projectSnapshot) return this.deps.projectSnapshot(this.state);
    const view = computeFacts(this.state, "player");
    const state = this.state;
    // P0 默认最小 player 窗口投影（Wave 2 注入 projectSnapshotV2 得到完整 V2Snapshot）。
    // 结构上只含 player 可见事实，不含任何 hidden 原文 / 叙事正文字段。
    return {
      worldId: state.id,
      templateId: state.templateId,
      worldName: state.id,
      turnIndex: state.turnIndex,
      worldTime: state.worldTime,
      formattedTime: "",
      lifeStage: "",
      lifeStageLabel: "",
      startYear: 0,
      labels: { resources: {}, attributes: {}, mood: "" },
      player: {
        id: "player",
        name: state.player.name,
        age: state.player.age,
        gender: state.player.gender,
        genderLabel: "",
        hp: state.player.hp,
        maxHp: state.player.hp,
        mp: state.player.mp,
        maxMp: state.player.mp,
        mood: state.player.mood,
        moodBandLabel: "",
        attributes: { ...state.player.attributes },
        statuses: [],
        skills: [],
        inventory: [],
      },
      npcs: [],
      slotEvent: null,
      battle: null,
      history: [],
      evaluation: { dimensions: [], summary: "", summarySource: "template", overall: 0 },
      media: (state.media ?? []).map((m) => ({ ...m, url: "", alt: "" })),
      llmPending: state.pendingInvocation !== undefined,
      playerFacts: view.facts,
    } as unknown as V2Snapshot;
  }

  buildFacts(perspective: Perspective): PerspectiveFactView {
    return computeFacts(this.state, perspective);
  }

  /**
   * 清「在飞 invocation」标记（见 `EngineApiHandle.clearPending`）。
   * 只在 id 匹配时清：玩家可能在 LLM 回来之前推进了回合，此 `pendingInvocation`
   * 已经是新一轮的，清空会让新一轮的 `llmPending` 凭空消失。
   */
  clearPending(invocationId: string): void {
    if (this.state.pendingInvocation?.invocationId !== invocationId) return;
    this.state.pendingInvocation = undefined;
  }

  /** 供回放 / 调用方取得当前权威状态（同一引用，dispatch 原地写）。 */
  getState(): WorldStateV2 {
    return this.state;
  }
}

/**
 * `state.slot` 的唯一写入点（ADR-0034 §12-1）。
 * turn.ts 的 6+ 处 `state.slot =` 全部收敛到本函数，源码守卫据此断言
 * 「权威字段写入只出现在 api/engine-api.ts」。
 */
export function assignSlot(state: WorldStateV2, slot: SlotScene | null): void {
  state.slot = slot;
}

/** 把 spec 里注入的 pendingInvocation 落账（回程一律走 dispatch 语义，此处仅封装写入）。 */
export function assignPendingInvocation(
  state: WorldStateV2,
  invocation: WorldStateV2["pendingInvocation"],
): void {
  state.pendingInvocation = invocation;
}

/**
 * ADR-0036：触发器边沿历史（`triggerFireLedger`）的唯一写入点。
 *
 * 与 `assignSlot` / `assignPendingInvocation` 同一条「权威字段写入集中在
 * api/engine-api.ts」约束 —— turn.ts 只能调用本函数，不得直接给 state 字段赋值。
 * 整份替换（而非 merge）：ledger 是「本轮全部触发器的求值快照」，merge 会把已删除 /
 * 改名的触发器残留成幽灵历史。
 */
export function assignTriggerFireLedger(
  state: WorldStateV2,
  ledger: WorldStateV2["triggerFireLedger"],
): void {
  state.triggerFireLedger = ledger;
}

/** 诊断码封闭集合（转出，便于源码守卫 / 测试断言 13 码）。 */
export const ENGINE_DIAGNOSTIC_CODES = DIAGNOSTIC_CODES;

/**
 * 结算 tail 的知识授予落账（T-02 / F4）。
 *
 * 计算委托纯函数 `computeKnowledgeGrants`（turn.ts 调用），**写入只在本文件发生** ——
 * 与 `assignSlot` / `assignPendingInvocation` 同一条「权威写入集中在 api/engine-api.ts」约束。
 * 冲突（同一 `(observer, factRef)` 互斥 level）按 rules 声明顺序先到先得、不抛错：
 * 授予是模板数据而非玩家意图，不该因为模板自身写重而中断整回合结算。
 */
export function assignKnowledgeGrants(
  state: WorldStateV2,
  grants: readonly SetKnowledgeArgs[],
): void {
  if (grants.length === 0) return;
  const result = applyKnowledgeBatch(state.observationLedger, grants);
  state.observationLedger = result.ledger;
}
