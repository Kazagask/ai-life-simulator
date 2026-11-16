/**
 * @deprecated ADR-0038 D10 —— 过渡兼容窗口内**唯一**允许出现「从 `contextHints` 字符串
 * 推断语义」的地方。下一个版本周期整文件删除（连同 import 与守卫里的登记一起）。
 *
 * ⚠ **不要把这里的解析接回发射路径。**
 * 分支能力已改由结构化白名单 `invoke.branchEventIds`（→ `LlmContext.branchEventIds`
 * → `DispatchContext.branchEventIds`）表达。若仍按 hints 发射 `fact.enqueueEvent`：
 * - 模板没声明白名单 ⇒ engine 侧 D3 第 3 条一律拒绝（`allowedRefs: []`）；
 * - 于是每一轮都白产出一条 `unknown_reference` 拒绝回执 —— 分支既没上桌，又添噪音。
 *
 * 本文件存在的意义只有一个：**把形状判断收敛成单点**，让守卫可以断言
 * 「`agent-runtime/src/**` 里除本文件外不出现 `startsWith("evt:")` / `"branch:"`」。
 * 散在三处时守卫落地即撞线，收在这里之后就没有第二个漏点。
 *
 * 真实事故（ADR-0038 背景）：`task.completed` 的 hints 里带裸 `evt:chance`，
 * 旧实现把「标签」当「指令」，每次结算都重新入队 ⇒ chance → closing → chance
 * 无限交替 ⇒ 409 `pending_event_required`。
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const BRANCH_HINT_PREFIXES = ["hint:branch:", "branch:"] as const;

function normalizeBranchTarget(raw: string): string | null {
  const id = raw.trim();
  return id.startsWith("evt:") && id.length > "evt:".length ? id : null;
}

/**
 * 解析旧式分支提示：`branch:evt:xxx` / `hint:branch:evt:xxx` /
 * `{"kind":"enqueueEvent","eventId":"evt:xxx"}`。
 *
 * 裸 `evt:xxx` 与 `facts[].factRef` **一律不认**（那是「提到过」，不是「现在摆」）。
 * 返回值：合法事件 id 或 null。
 *
 * @deprecated 见文件头。当前**无调用方**，这是刻意的（守卫会断言零引用）。
 */
export function parseLegacyBranchHint(hint: string): string | null {
  const trimmed = hint.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && parsed.kind === "enqueueEvent" && typeof parsed.eventId === "string") {
        return normalizeBranchTarget(parsed.eventId);
      }
    } catch {
      // 不是 JSON，按普通提示忽略。
    }
    return null;
  }
  for (const prefix of BRANCH_HINT_PREFIXES) {
    if (trimmed.startsWith(prefix)) return normalizeBranchTarget(trimmed.slice(prefix.length));
  }
  return null;
}
