/**
 * 可注入的确定性随机源（mulberry32）。
 * 相同 seed 产生相同序列，保证同 seed 可复现。
 */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由世界 seed 与轮次派生出每轮独立的子 seed。 */
export function deriveTurnSeed(worldSeed: number, turnIndex: number): number {
  let h = (worldSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (turnIndex + 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

/** 按权重在候选中做确定性选择。 */
export function pickWeighted<T>(items: T[], weightOf: (item: T) => number, rng: Rng): T | undefined {
  if (items.length === 0) return undefined;
  const total = items.reduce((sum, item) => sum + Math.max(0, weightOf(item)), 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let roll = rng() * total;
  for (const item of items) {
    roll -= Math.max(0, weightOf(item));
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}
