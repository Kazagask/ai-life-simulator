import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { UserCredentials } from "./credentials.js";

/**
 * R2.8 · R-LLM-07：用户在登录页配置的自定义 LLM 凭证（apiKey + model + 可选 baseUrl）。
 *
 * 🔴 硬约束（AGENTS §5 / R2.7 CLOUD_DEV §7）：
 * 服务端**仅内存持有**，绝不落盘、绝不写日志含字面量、绝不进玩家端 API 投影、绝不写仓库。
 * 进程退出 / clear 即清。风险用户自担（key 是否足额、是否本人服务端不做合法性兜底）。
 *
 * 凭证形状 / 默认端点常量已下沉到 `./credentials.js`（可随 provider 整体迁往 agent-runtime）；
 * 此处仅再导出以兼容既有导入点，本文件保留「会话内存存储」职责。
 */
export type { UserCredentials } from "./credentials.js";
export { DEFAULT_OPENAI_BASE_URL } from "./credentials.js";

// 先 trim 再校验：空白串（仅空格）视为空，按 R-LLM-07「非空」校验拒绝。
const nonEmptyTrimmed = z.string().trim().min(1, "必填且不可仅为空白");

const credentialsSchema = z.object({
  apiKey: nonEmptyTrimmed,
  model: nonEmptyTrimmed,
  baseUrl: z.string().trim().url("baseUrl 须为合法 URL").optional(),
});

// 内存存储：sessionId -> 凭证。绝不持久化、绝不进 replay、绝不进存档。
const store = new Map<string, UserCredentials>();

export const userCredentials = {
  /**
   * 校验并 mint 不透明 sessionId。输入非法抛 `Error("invalid_credentials")`（调用方转 400）。
   * 返回的 id 由 `randomUUID` 生成，不携带任何凭证信息，无法反推 key。
   */
  mint(input: unknown): string {
    const parsed = credentialsSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("invalid_credentials");
    }
    const id = randomUUID();
    const data: UserCredentials = {
      apiKey: parsed.data.apiKey,
      model: parsed.data.model,
      ...(parsed.data.baseUrl !== undefined ? { baseUrl: parsed.data.baseUrl } : {}),
    };
    store.set(id, data);
    return id;
  },
  /** 按 sessionId 查找凭证；空 / 未命中返回 undefined（调用方回退全局 provider）。 */
  lookup(id: string | undefined): UserCredentials | undefined {
    if (typeof id !== "string" || id.length === 0) return undefined;
    return store.get(id);
  },
  /** 显式清除某会话凭证（登出 / 世界删除时调用）。 */
  clear(id: string): void {
    store.delete(id);
  },
  /** 进程退出时清空全部（不落盘）。 */
  clearAll(): void {
    store.clear();
  },
};
