import type { WorldTemplateV2 } from "@life-sim/shared";

/**
 * 给模型看的「世界骨架」（stablePrefix 的第一段）。
 *
 * 以前服务端这里缺省成一个内部模板 id。模型拿它当世界名，
 * 写出来的东西自然带代号。现在用模板自己的名字 + 年代 + 一句话设定（自然语言），
 * 这段仍然**每轮字节相同**（prompt cache 的前缀不受影响）。
 *
 * 放在 agent-runtime 而不是服务端：浏览器里的 gateway 要拼同一段前缀，
 * 两边各写一份迟早漂成两套世界观。
 */
export function worldSkeletonOf(template: WorldTemplateV2): string {
  const meta = template.meta;
  return [`${meta.name}（${meta.startYear} 年）`, meta.description]
    .filter((line) => line.trim() !== "")
    .join("\n");
}
