import { registerExtensionUi } from "@life-sim/rpg-ui";
import { familyUi } from "@life-sim/ext-family/ui";

/**
 * 扩展前端的**编译期**注册表（`docs/EXTENSIONS.md` §7.1 第 3 条）。
 *
 * 和内核一样不做热加载：加扩展 = 加一行注册 + 重新构建。放在独立文件里而不是散在
 * `main.tsx` 中，是为了让「宿主认识哪些扩展」这件事只有一处可查。
 */
registerExtensionUi(familyUi);
