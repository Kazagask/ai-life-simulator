import { registerExtensionRuntime, type ExtensionRuntime } from "@life-sim/game-core";
import { familyExtension } from "@life-sim/ext-family";

/**
 * 服务端装配的全部扩展实现（`docs/EXTENSIONS.md`）。
 *
 * 这里是**唯一**的装配点：`apps/server` 引哪些扩展包，就加进这个数组。
 * 模板 `extensions:` 里声明了但没装包的 id ⇒ 模板加载期拒载（`unknown_extension`，
 * 判据在 `templates.ts`，用的是 game-core 的同一张注册表）。
 *
 * 注册必须在**任何模板扫描之前**（`index.ts` 里 `registerServerExtensions()` 先于
 * `loadTemplates`）—— 拒载校验读的就是这张表，晚一步就会把合法模板判成未注册。
 */
const SERVER_EXTENSIONS: readonly ExtensionRuntime[] = [familyExtension];

/** 启动期调用一次；运行期不再改（放弃热加载，投影保持确定）。 */
export function registerServerExtensions(): void {
  for (const runtime of SERVER_EXTENSIONS) registerExtensionRuntime(runtime);
}

/**
 * 本服务已装配的扩展 id（排序后）。仅用于把「可选集合」写进拒载原因，
 * 判定本身走 game-core 的 `hasExtensionRuntime`，不读这个数组。
 */
export function installedExtensionIds(): string[] {
  return SERVER_EXTENSIONS.map((runtime) => runtime.id).sort();
}
