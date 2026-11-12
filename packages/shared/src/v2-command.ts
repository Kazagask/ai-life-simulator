import { z } from "zod";

/**
 * 战斗命令的唯一真源（D-15）。
 *
 * 背景：`BattleCommand` 原来在 `v2.ts` 手写一份 TS 联合类型，`apps/server/src/index.ts`
 * 又手写一份 zod discriminated union 做入参校验 —— 同一契约两份真源。加 `pass` 时服务端
 * 那份静默拒收（400 invalid_body），只有当有人记得同步两边时才不出事。
 *
 * 现在以 zod 为唯一真源、类型由 `z.infer` 派生：
 * - 想加/改命令只能改这里，服务端直接引用同一个 schema，**结构上不可能漂移**；
 * - `performBattleAction` 的分支收窄仍由 discriminated union 保证（`command.type` 收窄可用）。
 *
 * 为什么放在 runtime 层（`v2-command.ts`）而不是 `schema/`：
 * `schema/` 目录是**模板协议**（加载期校验模板文件）的归属，本文件是**运行时命令**（API 入参），
 * 与 `v2.ts` / `v2-state.ts` 同层更贴合语义；也因此与 `v2-state.ts` 的命名保持一致。
 *
 * 刻意**不加 `.strict()`**：服务端原实现对多余字段是「剥掉」而不是「拒绝」，本次是纯重构，
 * 行为必须与重构前逐字节一致（`pass` 200、未知 type 400、多余字段不报错）。
 */
export const BattleCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("skill"), skillId: z.string().min(1), targetInstanceId: z.string().optional() }),
  z.object({ type: z.literal("item"), itemId: z.string().min(1) }),
  z.object({ type: z.literal("flee") }),
  /**
   * 空过一回合（D-14）：**本回合不做任何事，但仍消耗一个战斗回合**
   * （友军/敌人照常行动、`roundEnd` 照常推进、补正寿命与冷却照常递减）。
   * 不消耗 MP / 道具 / 技能冷却，也不触发逃跑判定。
   *
   * 存在的理由：`cannot_act`（眩晕）时引擎会忽略命令但**仍要求玩家提交一次命令**
   * 才能结束回合；此前 UI 只能借 `flee` 顶上（唯一无资源代价的命令），
   * 一旦命令分发顺序被调整，「硬撑」就会真的执行逃跑。`pass` 把这个语义补进模型本身。
   */
  z.object({ type: z.literal("pass") }),
]);

/** 战斗命令（由 `BattleCommandSchema` 派生，勿另行手写联合类型）。 */
export type BattleCommand = z.infer<typeof BattleCommandSchema>;
