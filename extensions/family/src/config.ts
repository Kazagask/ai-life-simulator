/**
 * 模板 `extensions.family` 的配置（`true` = 全默认）。
 *
 * 解析口径：**不抛错**。投影期抛错会让一局直接崩在渲染上，而配置错误应该在模板加载期
 * 被拒（那是加载器的职责）。越界值就地夹紧，缺省值在这里补全 —— 下游（称谓 / 族谱）
 * 拿到的永远是一份完整配置，不必各自 `??`。
 */
export interface FamilyConfig {
  /** 是否并排展示第二种及以后的读法（默认 false：只显示主称谓）。 */
  readonly showAllRoles: boolean;
  /** 多跳推导的最多跳数（默认 3，夹在 1..8）。 */
  readonly maxHops: number;
  /**
   * 族谱最多展示几代（默认 4，夹在 1..12）。以玩家为中轴，上下各 `maxGenerations - 1` 代。
   * 模板可写顶层 `maxGenerations`，也可按 `extensions/family/doc/CLAN-DESIGN.md` §1.4 写 `pedigree.maxGenerations`
   * ——两种写法都认，嵌套优先（文档路径）。
   */
  readonly maxGenerations: number;
  /** 族谱最多展示几个节点（默认 80，夹在 2..500）。截断规则见 `pedigree.ts`。 */
  readonly maxNodes: number;
}

const DEFAULT_CONFIG: FamilyConfig = {
  showAllRoles: false,
  maxHops: 3,
  maxGenerations: 4,
  maxNodes: 80,
};

function intInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function parseFamilyConfig(raw: unknown): FamilyConfig {
  if (raw === undefined || raw === null || raw === true) return DEFAULT_CONFIG;
  if (typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_CONFIG;
  const obj = raw as Record<string, unknown>;
  /** `extensions/family/doc/CLAN-DESIGN.md` §1.4 写的是 `pedigree.maxGenerations`；顶层写法一并兼容。 */
  const pedigree = (
    typeof obj.pedigree === "object" && obj.pedigree !== null && !Array.isArray(obj.pedigree)
      ? obj.pedigree
      : {}
  ) as Record<string, unknown>;
  return {
    showAllRoles: obj.showAllRoles === true,
    maxHops: intInRange(obj.maxHops, DEFAULT_CONFIG.maxHops, 1, 8),
    maxGenerations: intInRange(
      pedigree.maxGenerations ?? obj.maxGenerations,
      DEFAULT_CONFIG.maxGenerations,
      1,
      12,
    ),
    maxNodes: intInRange(pedigree.maxNodes ?? obj.maxNodes, DEFAULT_CONFIG.maxNodes, 2, 500),
  };
}

/**
 * 模板 gender id → 推导用的性别（`Sex`）。
 *
 * **这是扩展与模板的约定，不是协议**：缺省只认 `male` / `female` 两个 id，
 * 其它一律 `null`（= 性别不详，称谓层退中性词，**绝不猜男女**）。
 * 内核只透传原始 id（`SnapshotActor.genderId`），不做这层翻译 —— 语义归扩展
 * （`docs/EXTENSIONS.md` §7 宿主零知识）。
 *
 * 需要别的 id（如 `m` / `f`、`男` / `女`）时再给 `FamilyConfig` 加配置项；
 * 在那之前不要在称谓层散落 `=== "male"` 的判断。
 */
export function sexFromGenderId(genderId: string | null | undefined): "male" | "female" | null {
  if (genderId === "male") return "male";
  if (genderId === "female") return "female";
  return null;
}
