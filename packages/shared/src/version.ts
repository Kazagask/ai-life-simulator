/**
 * 主包（引擎实现）版本号。
 *
 * 这是**协议外的实现版本**：`meta.engineProtocol: "v2"` 说的是协议族，本常量说的是
 * 这一版实现。扩展通过 `ExtensionRuntime.requiresCore` 声明它兼容哪个主包版本区间，
 * 模板通过 `world.yaml#requires.core` 声明这个世界是按哪个主包版本写的。
 *
 * 维护约定：本常量必须与 `packages/game-core/package.json` 的 `version` 一致；
 * 有 `test/unit/version-requires.test.ts` 钉住这一点，改版本时一起改。
 */
export const ENGINE_VERSION = "0.1.0";

/**
 * 极简版本匹配（够用即可，不引 semver 依赖）：
 * - `"*"` / 缺省 ⇒ 任意版本
 * - `"0.1.0"` ⇒ 精确相等
 * - `"^0.1.0"` ⇒ 同 major 且 >= 给定版本
 * - `">=0.1.0"` ⇒ >= 给定版本（跨 major 也接受，给扩展作者留一条逃生口）
 *
 * 解析不了的字符串返回 false（宁可拒载，不要静默放过）。
 */
export function satisfiesVersion(actual: string, range: string | undefined): boolean {
  if (range === undefined || range === "*") return true;
  const parse = (value: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (m === null) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const actualParts = parse(actual);
  if (actualParts === null) return false;
  if (range.startsWith("^")) {
    const wanted = parse(range.slice(1));
    if (wanted === null) return false;
    if (actualParts[0] !== wanted[0]) return false;
    // 0.x 的 caret 锁 minor（semver 惯例）：^0.1.0 不接受 0.2.0。
    if (wanted[0] === 0 && actualParts[1] !== wanted[1]) return false;
    return (
      actualParts[1] > wanted[1] ||
      (actualParts[1] === wanted[1] && actualParts[2] >= wanted[2])
    );
  }
  if (range.startsWith(">=")) {
    const wanted = parse(range.slice(2));
    if (wanted === null) return false;
    return (
      actualParts[0] > wanted[0] ||
      (actualParts[0] === wanted[0] &&
        (actualParts[1] > wanted[1] ||
          (actualParts[1] === wanted[1] && actualParts[2] >= wanted[2])))
    );
  }
  return actual === range;
}
