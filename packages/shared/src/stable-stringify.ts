/**
 * 键排序的稳定序列化：同一对象（键序不同）⇒ 同一字符串。
 *
 * 用途：`contextHash`、客户端与服务端的**状态摘要**对比。JSON.stringify 的键序取决于
 * 插入顺序，跨进程 / 跨版本重建同一份状态时并不保证一致 —— 摘要会「看起来变了」。
 *
 * 放在 shared 而不是 agent-runtime：web 侧做本地引擎自检也要它（不许为了一个纯函数
 * 把 LLM 编排层拉进前端包）。
 */
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
