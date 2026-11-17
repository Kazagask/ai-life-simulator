import type { ViewModel } from "@life-sim/shared";
import {
  ClanVMSchema,
  FamilyUiSliceSchema,
  PedigreeVMSchema,
  type ClanVM,
  type PedigreeVM,
} from "./view-model.js";

/**
 * `vm.extensions.family` → 家族扩展自己的视图模型。
 *
 * 宿主只做原样搬运（`docs/EXTENSIONS.md` §7.1）：它不知道 `family` 里有什么，本文件才是
 * 解释方。数据来源是**扩展自己那一格**，因此可以放心读；但依然走 zod 校验 —— 服务端字段
 * 改名时要在这里红，而不是在组件里读到 `undefined` 画出一张空图。
 *
 * 不读引擎快照类型（源码守卫会拦）：入参只有 `ViewModel.extensions` 的 `unknown` 切片。
 */

/** 扩展 UI 需要的那两段。两者互不依赖（`docs/CLAN-DESIGN.md` §0/§3）。 */
export interface FamilyUiData {
  pedigree?: PedigreeVM;
  clans: ClanVM[];
}

/** 族谱切片 → 视图模型；形状不符返回 `undefined`（不抛、不画半张图）。 */
export function toPedigreeVM(raw: unknown): PedigreeVM | undefined {
  const parsed = PedigreeVMSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** 宗族切片 → 视图模型；形状不符返回 `undefined`。 */
export function toClanVM(raw: unknown): ClanVM | undefined {
  const parsed = ClanVMSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 每个 `ViewModel` 只解析一次：同一轮里 `visible` 与组件渲染会各问一遍，族谱可能上百节点，
 * 重复 parse 是纯浪费。`ViewModel` 每轮都是新对象 ⇒ WeakMap 天然按轮失效。
 */
const CACHE = new WeakMap<ViewModel, FamilyUiData | undefined>();

/** 读 `vm.extensions.family`；没装扩展 / 形状不符 ⇒ `undefined`。 */
export function familyUiData(vm: ViewModel): FamilyUiData | undefined {
  if (CACHE.has(vm)) return CACHE.get(vm);
  const raw = vm.extensions?.["family"];
  let data: FamilyUiData | undefined;
  if (raw !== undefined) {
    const parsed = FamilyUiSliceSchema.safeParse(raw);
    if (parsed.success) {
      const pedigree = parsed.data.pedigree;
      data = {
        ...(pedigree !== undefined ? { pedigree } : {}),
        clans: parsed.data.clans,
      };
    }
  }
  CACHE.set(vm, data);
  return data;
}
