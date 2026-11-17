import type { ExtensionUiRuntime, ExtensionView } from "@life-sim/rpg-ui";
import { familyUiData } from "./adapter.js";
import { ClanPanel } from "./ClanPanel.js";
import { PedigreePanel } from "./PedigreePanel.js";

/**
 * 家族扩展的前端视图（`docs/EXTENSIONS.md` §7.2）。
 *
 * 两个视图都挂在宿主唯一的槽 `world.subview` 里；`visible` **只看自己那一格**
 * （`vm.extensions.family`）—— 族谱有就出、宗族非空才出，不窥探别的扩展的切片。
 * 页签名由扩展自己给（宿主不翻译），选中态归宿主。
 */

export const WORLD_SUBVIEW_SLOT = "world.subview";

export const pedigreeView: ExtensionView = {
  id: "pedigree",
  slot: WORLD_SUBVIEW_SLOT,
  label: "族谱",
  order: 10,
  visible: (vm) => familyUiData(vm)?.pedigree !== undefined,
  Component: ({ vm, host }) => {
    const data = familyUiData(vm);
    if (data?.pedigree === undefined) return null;
    return (
      <PedigreePanel
        pedigree={data.pedigree}
        onSelectNpc={(id) => host?.openNpc(id)}
        onSelectSelf={() => host?.openSelf()}
      />
    );
  },
};

export const clanView: ExtensionView = {
  id: "clan",
  slot: WORLD_SUBVIEW_SLOT,
  label: "宗族",
  order: 20,
  // 空数组 = 这个世界没有可展示的宗族 ⇒ 不出空页签。
  visible: (vm) => (familyUiData(vm)?.clans.length ?? 0) > 0,
  Component: ({ vm }) => {
    const data = familyUiData(vm);
    if (data === undefined || data.clans.length === 0) return null;
    return <ClanPanel clans={data.clans} />;
  },
};

/** `apps/web/src/extensions.ts` 静态注册的那一份。 */
export const familyUi: ExtensionUiRuntime = {
  id: "family",
  views: [pedigreeView, clanView],
};
