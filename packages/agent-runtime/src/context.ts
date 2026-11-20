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

/** 叙事体裁：逐拍旁白 / 回顾（章节小结等）。 */
export type NarrativeMode = "narration" | "recap";

/** 篇幅规格（字符数 + 段数）。 */
export interface NarrativeLength {
  minChars: number;
  maxChars: number;
  minParagraphs: number;
  maxParagraphs: number;
}

/** 缺省篇幅：逐拍旁白口径（与旧契约字节一致）。 */
export const DEFAULT_NARRATIVE_LENGTH: NarrativeLength = {
  minChars: 80,
  maxChars: 220,
  minParagraphs: 1,
  maxParagraphs: 3,
};

/** 逐拍 vs 回顾：两条会被替换的约束（其余段落两者共用）。 */
const NARRATION_ONE_SHOT =
  "**只写这一回合内、主角亲身经历的一小段**：不要罗列世界动态、其他角色的行动清单、属性 / 关系 / 线索等数值，也不要把已知事实改写成流水账；除正在交谈的对象外，不要用「某某做了什么」的清单句式。";
const NARRATION_CONTINUE =
  "**必须紧接 `recentTurns` 的最后一条往下写**：那是刚刚发生的事，你写它之后的下一拍。不要重写已经演过的场面，不要跳回更早的场景，也不要预告下一幕。";
const RECAP_SCOPE =
  "**这是在收束一段已经发生的经历**：把 `recentTurns` 里演过的事按时间顺序拢成完整的一段，写清主角做了什么、付出什么代价、心里落下什么。可以跨回合回看，但只写已经发生的，不要预告，也不要替玩家做新的决定。";
const RECAP_SHAPE =
  "**不要写成事件清单**：禁止「先……然后……接着……最后」的流程说明，禁止逐条复述事实或数值；用场景、动作、对话和感受推进，让读者自己看出发生了什么。";

function lengthLine(length: NarrativeLength): string {
  const paragraphs =
    length.minParagraphs === length.maxParagraphs
      ? `${length.minParagraphs} 段`
      : `${length.minParagraphs}–${length.maxParagraphs} 段`;
  return `一次 invocation 正文 ${length.minChars}–${length.maxChars} 个汉字，${paragraphs}。`;
}

/**
 * 输出契约（固定文本，属于 stablePrefix，因此必须字节稳定）。
 *
 * `mode` / `length` 由模板 `rules.yaml` 的 `invoke` 给：不传时与旧版**逐字节相同**，
 * 保证既有模板的 prompt cache 前缀不变。
 */
export function buildOutputContract(
  mode: NarrativeMode = "narration",
  rawLength?: Partial<NarrativeLength>,
): string {
  const length: NarrativeLength = { ...DEFAULT_NARRATIVE_LENGTH, ...rawLength } as NarrativeLength;
  return [
    "你是这场人生模拟的叙事者。所有玩家可见正文必须包在 <narrative-content>…</narrative-content> 里；",
    "标签外只允许工具调用与内部推理，标签外的文字会被丢弃。一次 invocation 可以有多个块，按出现顺序拼接。",
    "**只写正文时不要调用任何工具**：输出 `<narrative-content>` 就完成了，不调工具同样算完成。",
    "**只有要新增一条支线时**才调用 `story.submitBranch`；调用它就必须给全参数，空参数会整条被拒。",
    "只写简体中文散文。禁止任何 markdown / 格式符号（# * - ` >、列表、编号、代码块、英文引号）；除对话外不用括号，不写“（此处……）”式旁注，不写标题。",
    "禁止只转述现状：不要复述状态数字、线索数量、属性值、轮次。必须写这一刻具体的感官、动作、环境或对话片段，至少包含一个可被摄像机拍到的细节。",
    mode === "recap" ? RECAP_SCOPE : NARRATION_ONE_SHOT,
    mode === "recap" ? RECAP_SHAPE : NARRATION_CONTINUE,
    "**不要替玩家说话或做决定**：不写「你说……」「你决定……」这类替玩家表的态；只写他看到、听到、闻到、感到的，以及别人说的话、做的动作。",
    "**用第二人称「你」指主角**，不要用名字当主语（别人喊他名字时除外），也不要写成第三人称旁白。写法示例：正确——你把外套的领子立了起来；错误——<角色名>把外套的领子立了起来。",
    "不得违背 [设定]：其中写明的能力与限制是硬约束（设定说某种攻击打不中，就绝不让它打中；设定说某招要先满足条件，就绝不跳过条件）。不确定就避开，不要编。",
    lengthLine(length),
    "所有事实变更只能通过工具调用提交，禁止在正文里宣称状态已改变；refs 只能引用 facts 段里出现的事实引用 id。",
  ].join("\n");
}

/** 缺省契约（逐拍旁白）。保留具名导出：既有引用点与断言零回归。 */
export const OUTPUT_CONTRACT = buildOutputContract();

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
  // 体裁与篇幅来自模板（`rules.yaml` 的 `invoke.mode` / `invoke.length`）；缺省时逐字节等同旧契约。
  const contract = buildOutputContract(
    inv.context.narrativeMode ?? "narration",
    inv.context.narrativeLength,
  );
  return [
    "# 世界骨架",
    deps.worldSkeleton ?? "(未提供世界骨架)",
    "",
    "# 能力画像",
    `profile: ${profileName}`,
    `tools: ${profileTools.join(", ")}`,
    "",
    "# 输出契约",
    contract,
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
    /** 模板的本幕要求：逐字透传，不改写（它是作者写给模型的话）。 */
    ...(inv.context.instruction !== undefined ? { instruction: inv.context.instruction } : {}),
    // 体裁 / 篇幅：与 branchEventIds 同一条纪律 —— 本函数逐字段重建，漏一个就会让
    // `contextHash` 与 `stableStringify(inv.context)` 分叉（契约也就会按缺省值渲染）。
    ...(inv.context.narrativeMode !== undefined
      ? { narrativeMode: inv.context.narrativeMode }
      : {}),
    ...(inv.context.narrativeLength !== undefined
      ? { narrativeLength: inv.context.narrativeLength }
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
