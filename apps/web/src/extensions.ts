import { registerExtensionUi, type ExtensionUiRuntime } from "@life-sim/rpg-ui";
import { familyUi } from "@life-sim/ext-family/ui";

/**
 * 扩展前端的**编译期**注册表（`docs/EXTENSIONS.md` §7.1 第 3 条）。
 *
 * 和内核一样不做热加载：加扩展 = 加一行注册 + 重新构建。放在独立文件里而不是散在
 * `main.tsx` 中，是为了让「宿主认识哪些扩展」这件事只有一处可查。
 *
 * 2026-11-21（ADR-070 D2 裁决）：**扩展只以「编进 bundle」的形态存在**。
 * 模板包里不带代码；模板声明了没编进来的 id ⇒ 服务端加载期 `unknown_extension`。
 * 这条链路靠 `test/unit/extension-build.test.ts` 守住：本文件的 id 集合必须与服务端
 * 装配的 `installedExtensionIds()` 完全一致 —— 任何一边漏了都在 CI 挂，而不是等玩家
 * 打开页面才发现少一块。
 */
const WEB_EXTENSION_UI: readonly ExtensionUiRuntime[] = [familyUi];

for (const ui of WEB_EXTENSION_UI) registerExtensionUi(ui);

/** 本前端构建里编入的扩展 id（排序后）。只给构建期守卫用，运行期判定仍走 game-core 的注册表。 */
export const webExtensionIds: readonly string[] = WEB_EXTENSION_UI.map((ui) => ui.id).sort();
