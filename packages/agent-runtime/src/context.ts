import { createHash } from "node:crypto";
import type {
  EngineApiHandle,
  LlmContext,
  LlmInvocation,
  RulesTemplate,
  ToolDescriptor,
} from "@life-sim/shared";
import { resolveToolNames } from "./tool-registry.js";

/**
 * T-05b：分层上下文组装（v2 §6.1）。
 *
 * - `stablePrefix` 对同一「世界骨架 + 能力画像 + 工具 schema + 输出契约」**字节稳定**
 *   （不随轮次 / 时间 / 随机变化），可直接当 prompt cache 的前缀。
 * - `facts` **逐条透传** `engineApi.buildFacts(inv.perspective)` 的结果：不裁剪、不补齐、
 *   不过滤 —— 可见性判据只归 game-core（F4）。
 * - `recentTurns` 只取滚动历史末尾 `budget.recentTurns` 条。
 * - `contextHash` = sha256(稳定序列化后的 LlmContext)。
 */

export interface LlmContextDeps {
  /** 只读窗口投影；必须是 game-core 的引擎 API（或其子集）。 */
  engineApi: Pick<EngineApiHandle, "buildFacts">;
  rules?: RulesTemplate;
  toolProfile?: string;
  /** 世界骨架文本（世界观 / 模板摘要）；由调用方从模板派生，本包不读文件。 */
  worldSkeleton?: string;
  history?: readonly unknown[];
  secrets?: readonly string[];
  contextHints?: readonly string[];
}

export interface BuiltLlmContext {
  context: LlmContext;
  contextHash: string;
}

/** 输出契约（固定文本，属于 stablePrefix，因此必须字节稳定）。 */
export const OUTPUT_CONTRACT = [
  "你是这场人生模拟的叙事者。所有玩家可见正文必须包在 <narrative-content>…</narrative-content> 里；",
  "标签外只允许工具调用与内部推理，标签外的文字会被丢弃。一次 invocation 可以有多个块，按出现顺序拼接。",
  "只写简体中文散文。禁止任何 markdown / 格式符号（# * - ` >、列表、编号、代码块、英文引号）；除对话外不用括号，不写“（此处……）”式旁注，不写标题。",
  "禁止只转述现状：不要复述状态数字、线索数量、属性值、轮次。必须写这一刻具体的感官、动作、环境或对话片段，至少包含一个可被摄像机拍到的细节。",
  "不得违背 [设定]：其中写明的能力与限制是硬约束（例：无下限让普通斩击无法命中；斩击需要咏唱 / 接触或特定条件）。不确定就避开，不要编。",
  "一次 invocation 正文 80–220 个汉字，1–3 段。",
  "所有事实变更只能通过工具调用提交，禁止在正文里宣称状态已改变；refs 只能引用 facts 段里出现的事实引用 id。",
].join("\n");

/** 递归键排序的稳定序列化（同一对象 ⇒ 同一字符串）。 */
export function stableStringify(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) out[key] = walk(record[key]);
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

const sortTools = (tools: readonly ToolDescriptor[]): ToolDescriptor[] =>
  [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * 组装 stablePrefix：世界骨架 → 能力画像（画像名 + 工具名列表）→ 输出契约 → 工具 JSON schema。
 * 所有可变部分（工具表）按键排序，保证同一画像两次调用字节一致。
 */
export function buildStablePrefix(inv: LlmInvocation, deps: LlmContextDeps): string {
  const profileName = deps.toolProfile ?? "unprofiled";
  // 画像缺省时以 core 传来的实际工具表面为准，保证前缀里的清单与实际可调用集合一致。
  const profileTools =
    deps.toolProfile !== undefined
      ? resolveToolNames(deps.rules, deps.toolProfile)
      : [...new Set(inv.tools.map((tool) => tool.name))].sort();
  const toolSchema = sortTools(inv.tools).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  }));
  const alwaysLore = (inv.lore ?? []).filter((entry) => entry.always === true);
  const loreSection =
    alwaysLore.length > 0
      ? ["", "# 设定（常驻）", ...alwaysLore.flatMap((entry) => [`## ${entry.title}`, entry.text])]
      : [];
  return [
    "# 世界骨架",
    deps.worldSkeleton ?? "(未提供世界骨架)",
    "",
    "# 能力画像",
    `profile: ${profileName}`,
    `tools: ${profileTools.join(", ")}`,
    "",
    "# 输出契约",
    OUTPUT_CONTRACT,
    ...(inv.promptStyle !== undefined ? ["", "# 文风约束", inv.promptStyle] : []),
    ...loreSection,
    "",
    "# 工具与参数",
    stableStringify(toolSchema),
  ].join("\n");
}

/**
 * T-05b 主入口：`inv` 的 context 由调用方传入时会被整体重建（保证 facts 来自引擎窗口）。
 * 返回 `contextHash` 供 `LlmTrace.contextHash` 使用。
 */
export function buildLlmContext(inv: LlmInvocation, deps: LlmContextDeps): BuiltLlmContext {
  const stablePrefix = buildStablePrefix(inv, deps);
  // F4：facts 段逐条透传，禁止在本层过滤 / 截断 / 补默认值。
  const facts = deps.engineApi.buildFacts(inv.perspective);
  // 调用方没给滚动历史时沿用 core 放进 context 的历史，不静默清空。
  const recentTurns = (deps.history ?? inv.context.recentTurns).slice(-inv.budget.recentTurns);
  const context: LlmContext = {
    stablePrefix,
    facts,
    recentTurns: [...recentTurns],
    invocationReason: inv.reason,
    ...(deps.secrets !== undefined
      ? { secrets: [...deps.secrets] }
      : inv.context.secrets !== undefined
        ? { secrets: [...inv.context.secrets] }
        : {}),
    ...(deps.contextHints !== undefined
      ? { contextHints: [...deps.contextHints] }
      : inv.context.contextHints !== undefined
        ? { contextHints: [...inv.context.contextHints] }
        : {}),
    ...(inv.lore?.some((entry) => entry.always !== true)
      ? { lore: inv.lore.filter((entry) => entry.always !== true) }
      : {}),
    // ADR-0038：第二个构造点（本函数逐字段重建、不 spread）。漏了它会让本函数的
    // `contextHash` 与 `loop` 的 `sha256(stableStringify(inv.context))` 分叉 ——
    // 只有「白名单不同、其余全同」的两次调用才暴露，单测各自过、合起来才红。
    ...(inv.context.branchEventIds !== undefined
      ? { branchEventIds: [...inv.context.branchEventIds] }
      : {}),
  };
  return { context, contextHash: sha256(stableStringify(context)) };
}
