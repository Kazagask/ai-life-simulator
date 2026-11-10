import { createRng, type Rng } from "../rng.js";

/**
 * 阶段 3–6 新模块统一使用的可注入运行时上下文。
 * AGENTS.md §2：时间、随机数、ID 必须可注入，测试中不得依赖真实时间或不可控随机数。
 * 全部字段均为函数/纯值，不持有模块级可变状态；每次 createRunnerContext
 * 返回全新独立实例，保证「同初始状态 + 同指令序列 + 同 seed」回放逐字段可复现。
 */
export interface RunnerContext {
  /** 确定性随机源；相同 seed 产生相同序列。 */
  rng: Rng;
  /** 可注入时钟（毫秒）。内核默认返回固定值，不读取真实时间。 */
  now: () => number;
  /** 可注入 ID 生成器；同 seed 的两个独立实例产生相同序列。 */
  idFactory: (prefix: string) => string;
}

/** 由 seed 构造确定性上下文；不读取真实时间、不使用不可控随机。 */
export function createRunnerContext(seed: number): RunnerContext {
  let seq = 0;
  return {
    rng: createRng(seed),
    now: () => 0,
    idFactory: (prefix: string) => `${prefix}-${seq++}`,
  };
}
