import type { ExtensionUiRuntime, ExtensionView } from "@life-sim/rpg-ui";
import { familyUiData } from "./adapter.js";
import { ClanPanel } from "./ClanPanel.js";
import { PedigreePanel } from "./PedigreePanel.js";

/**
 * 家族扩展的前端视图（`docs/EXTENSIONS.md` §7.2）。
 *
 * 两个视图都挂在宿主唯一的槽 `world.subview` 里；`visible` **只看自己那一格**
 * （`vm.extensions.family`）—— 声明了 family 就出两个页签，不窥探别的扩展的切片。
 * 「空宗族」由面板自己的空态文案表达，不再用 `clans.length > 0` 把页签整个藏掉
 * （藏掉会让玩家以为这块能力不存在）。页签名由扩展自己给，选中态归宿主。
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
  // 声明了 family 就出页签；没有宗族时面板显示空态（ClanPanel 自带文案），
  // 不因为数据暂时为空就把整个能力藏起来。
  visible: (vm) => familyUiData(vm) !== undefined,
  Component: ({ vm, host }) => {
    const data = familyUiData(vm);
    if (data === undefined) return null;
    return (
      <ClanPanel
        clans={data.clans}
        onSelectNpc={(id) => host?.openNpc(id)}
      />
    );
  },
};

/** `apps/web/src/extensions.ts` 静态注册的那一份。 */
export const familyUi: ExtensionUiRuntime = {
  id: "family",
  views: [pedigreeView, clanView],
};
