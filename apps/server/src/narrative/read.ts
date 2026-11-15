import { existsSync, readFileSync } from "node:fs";
import { LlmTraceSchema, type ContentBlockVM, type LlmTrace, type WorldStateV2 } from "@life-sim/shared";
import { allowedContentRefs } from "@life-sim/game-core";
import { traceFile } from "../store.js";

/**
 * T-07 读侧投影（F3 正文读回 + F4 玩家窗口），与 HTTP 层解耦以便单测。
 *
 * 分三步，缺一不可：
 * ① 逐行 `LlmTraceSchema.safeParse`：损坏行 / 旧格式行**跳过**（append-only 文件不能因一行坏而整份读不出）；
 * ② 取 `trace.contentBlocks ?? []`，按 `turnIndex >= fromTurn` 过滤；
 * ③ 块级玩家窗口：`targetPerspective !== "player"` / `visibility === "hidden"` / `refs[]` 越窗
 *    ⇒ **整块丢弃**。T-05a 裁决：hidden 块**不**替换成 `maskText`，`maskText` 永不下发。
 *
 * ③的 refs 判据用 game-core 的 `allowedContentRefs(state,"player")`——**与写侧
 * `content.writeNarrative` 完全同一集合**（窗口可见事实 ∪ `flag:*` ∪ 公开 DAG 节点；
 * npc 隐秘 / hidden DAG 节点只在 world 窗口出现）。读侧若用更窄的 `visibleFactRefs`，
 * 会把写侧已验收的块（例如引用 `flag:*` 的块）判成越窗 ⇒ 正文永久读不出来；
 * 防御纵深针对的是 world 窗口写入的隐秘引用，这一集合同样挡住。
 *
 * 输出只有 `ContentBlockVM`（blockId / kind / text）：receipts / diagnostics /
 * contextHash / callsHash / toolProfile / token 数一律不出服务端。
 */

/** 解析 jsonl 文本为合法 trace 列表；损坏行静默跳过（不抛错）。 */
export function parseTraceLines(raw: string): LlmTrace[] {
  const out: LlmTrace[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    const parsed = LlmTraceSchema.safeParse(parsedJson);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * 端点使用的完整读路径：文件不存在 ⇒ 空列表（不是错误、不是 404）；
 * 存在 ⇒ 解析 + 窗口投影。抽出来是为了让「无 trace 文件 ⇒ `blocks: []`」可被单测覆盖。
 */
export function readNarrativeBlocks(
  worldId: string,
  state: WorldStateV2,
  fromTurn?: number,
): ContentBlockVM[] {
  const file = traceFile(worldId);
  if (!existsSync(file)) return [];
  return projectNarrativeBlocks(state, parseTraceLines(readFileSync(file, "utf8")), fromTurn);
}

/**
 * 玩家窗口投影。`allowedContentRefs` 来自 game-core（窗口计算的唯一实现，且与写侧
 * `dispatch` 第 2 层用的是同一个函数），server 不复刻任何可见性判断。
 */
export function projectNarrativeBlocks(
  state: WorldStateV2,
  traces: readonly LlmTrace[],
  fromTurn?: number,
): ContentBlockVM[] {
  const allowed = allowedContentRefs(state, "player");
  // 同一 blockId 可能因「装饰 → 归档」被追加多次：后者覆盖前者（append-only 的读侧语义）。
  const byBlockId = new Map<string, ContentBlockVM>();
  for (const trace of traces) {
    if (fromTurn !== undefined && trace.turnIndex < fromTurn) continue;
    for (const block of trace.contentBlocks ?? []) {
      if (block.targetPerspective !== "player") continue;
      if (block.visibility === "hidden") continue;
      // 防御纵深：块本体是 player 的，但引用了 player 窗口不允许的事实（npc 隐秘 /
      // hidden DAG 节点）⇒ 整块丢。公开 flag / 公开 DAG 节点属允许集合（与写侧一致）。
      if (block.refs.some((ref) => !allowed.has(ref))) continue;
      const vm: ContentBlockVM = {
        blockId: block.blockId,
        kind: block.kind,
        ...(block.text !== undefined ? { text: block.text } : {}),
      };
      byBlockId.delete(block.blockId); // 重新插入以保持「最后写入排在最后」
      byBlockId.set(block.blockId, vm);
    }
  }
  return [...byBlockId.values()];
}
