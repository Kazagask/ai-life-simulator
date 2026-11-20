import { z } from "zod";
import {
  buildOpeningPrologueRequest,
  type OpeningPrologueRequestInput,
} from "@life-sim/game-core";
import type { LoreRule, WorldStateV2, WorldTemplateV2 } from "@life-sim/shared";
import { generateNarrative } from "./generate.js";
import type { LLMProvider } from "../llm/provider.js";

/**
 * 开局序章（2026-11-19）。
 *
 * 位置：`/api/openings/:id/commit` —— 开局档案刚落地、世界刚建成、第一幕还没开始。
 * 纪律与 R2.7 一致：LLM 只写**装饰文本**，绝不写权威状态、绝不触发事件、绝不参与评分。
 *
 * 输出落两处：
 * - `state.history` 一条 `milestone`（展示层，进存档 ⇒ 刷新后仍在「故事」里）；
 * - HTTP 响应里的 `prologue`（开局结果页直接显示，不必等进入世界）。
 *
 * 失败 / 超时 / mock provider ⇒ 模板拼的兜底文案（`fallbackPrologue`），
 * 与 flavor 同一条口径：少一句润色，不是错误。
 */

export const OpeningPrologueOutputSchema = z.object({ text: z.string().min(1) }).strict();

const DEFAULT_TIMEOUT_MS = 10_000;

/** 模板兜底文案：只拼开局已经落定的事实，不编任何新东西。 */
export function fallbackPrologue(input: OpeningPrologueRequestInput, formattedTime: string): string {
  const who =
    input.player.name.length > 0 && input.player.name !== "无名氏"
      ? input.player.name
      : "你";
  const traits = input.traits.length > 0 ? `身上带着「${input.traits.join("」「")}」` : "身上什么也没有";
  const chosen = input.choices.map((c) => c.choice).filter((t) => t.length > 0);
  const tail = chosen.length > 0 ? `——${chosen.join("；")}——这些是你自己选的。` : "";
  return [
    `${formattedTime}。`,
    `${who}，${input.player.age} 岁，${traits}。`,
    tail,
    "从这里开始，日子会自己往前走；你能决定的，是每一个路口往哪边拐。",
  ]
    .filter((s) => s.length > 0)
    .join("");
}

/** 组装请求：模板只给事实，措辞交给模型。 */
export function prologueFactsOf(
  state: WorldStateV2,
  template: WorldTemplateV2,
  choices: ReadonlyArray<{ step: string; choice: string }>,
  lore: readonly LoreRule[] | undefined,
): OpeningPrologueRequestInput {
  const labels = template.attributes.labels ?? {};
  const attributes = template.attributes.order
    // 只写「看得见的三项」：全表灌进去会把开场白写成角色卡。
    .filter((id) => ["cursedEnergy", "physique", "agility", "intellect", "luck"].includes(id))
    .map((id) => {
      const raw = state.player.attributes[id];
      // enum / ladder 属性也可能是字符串（如生得术式的等级）——原样交给模型，不做换算。
      const value = typeof raw === "number" || typeof raw === "string" ? raw : 0;
      return { name: labels[id] ?? id, value };
    })
    .filter((a) => Number.isFinite(Number(a.value)));
  const traits = state.player.statuses
    .map((inst) => template.statuses.find((s) => s.id === inst.statusId)?.name)
    .filter((name): name is string => name !== undefined);
  return {
    worldTitle: template.meta.name,
    worldSummary: template.meta.description,
    player: { name: state.player.name, gender: state.player.gender, age: state.player.age },
    attributes,
    traits,
    choices,
    // 只取 `always` 段（舞台 + 玩家位置 + 禁写），关键词条目留给回合内的 invocation。
    setting: (lore ?? []).filter((e) => e.always).map((e) => `${e.title}：${e.text}`),
  };
}

export interface PrologueOutcome {
  text: string;
  source: "llm" | "template";
  diagnostic: string | null;
}

export async function openingPrologue(
  facts: OpeningPrologueRequestInput,
  formattedTime: string,
  provider: LLMProvider,
): Promise<PrologueOutcome> {
  const fallback = fallbackPrologue(facts, formattedTime);
  const outcome = await generateNarrative(
    buildOpeningPrologueRequest(facts),
    OpeningPrologueOutputSchema,
    provider,
    { timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  if (outcome.source !== "llm") {
    return { text: fallback, source: "template", diagnostic: outcome.diagnostic };
  }
  const parsed = OpeningPrologueOutputSchema.safeParse(outcome.data);
  if (!parsed.success) return { text: fallback, source: "template", diagnostic: "序章输出未通过结构校验" };
  return { text: parsed.data.text.trim(), source: "llm", diagnostic: null };
}
