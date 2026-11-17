import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { ExtensionView, ViewModel } from "@life-sim/rpg-ui";
import { clanView, pedigreeView } from "../src/ui/views.js";

/**
 * 槽组件的**宿主能力透传**锁。
 *
 * `ExtensionViewHost` 是可选的：`Component({ vm })` 不传 host 也合法，所以「组件忘把
 * `host.openNpc` 接到面板上」这类 bug **类型检查看不见**，UI 上表现为「点了没反应」
 * （宗族家主那次就是这么漏的）。这里直接调组件函数、检查返回元素的 props ——
 * 不需要 DOM，也不依赖 React 渲染器。
 */

function vmWithFamily(family: unknown): ViewModel {
  return { extensions: { family } } as unknown as ViewModel;
}

const CLAN = {
  id: "c1",
  name: "测试族",
  status: "active",
  prestige: 10,
  livingCount: 1,
  memberCount: 1,
  selfRelation: "outsider",
  history: [],
};

const PEDIGREE = {
  rootIds: ["a"],
  generationRange: { min: 0, max: 0 },
  nodes: [
    {
      id: "a",
      name: "甲",
      isSelf: true,
      hasCard: true,
      genderLabel: "男",
      age: 30,
      lifeStageLabel: "成年",
      generation: 0,
      lifecycle: { state: "alive" },
    },
  ],
  edges: [],
};

type PanelProps = {
  onSelectNpc?: (id: string) => void;
  onSelectSelf?: () => void;
};

function render(
  view: ExtensionView,
  family: unknown,
  host?: { openNpc: (id: string) => void; openSelf: () => void },
): PanelProps {
  // `ComponentType` 允许 class 组件，直接调用前收窄成函数形态（这两个视图都是函数）。
  const Component = view.Component as unknown as (props: {
    vm: ViewModel;
    host?: { openNpc: (id: string) => void; openSelf: () => void };
  }) => ReactNode;
  const element = Component({ vm: vmWithFamily(family), ...(host !== undefined ? { host } : {}) });
  expect(element).not.toBeNull();
  return (element as ReactElement<PanelProps>).props;
}

describe("family UI：槽组件把 host 导航透传给面板", () => {
  it("宗族面板拿到 onSelectNpc，并转发到 host.openNpc", () => {
    const calls: string[] = [];
    const props = render(clanView, { selfClanIds: [], clans: [CLAN] }, {
      openNpc: (id) => calls.push(id),
      openSelf: () => calls.push("self"),
    });

    expect(typeof props.onSelectNpc).toBe("function");
    props.onSelectNpc!("npc-x");
    expect(calls).toEqual(["npc-x"]);
  });

  it("族谱面板拿到 onSelectNpc / onSelectSelf，分别转发", () => {
    const calls: string[] = [];
    const props = render(pedigreeView, { clans: [], pedigree: PEDIGREE }, {
      openNpc: (id) => calls.push(`npc:${id}`),
      openSelf: () => calls.push("self"),
    });

    props.onSelectNpc!("npc-y");
    props.onSelectSelf!();
    expect(calls).toEqual(["npc:npc-y", "self"]);
  });

  it("没有 host 时不崩（host 是可选能力，点了只是不导航）", () => {
    const clanProps = render(clanView, { selfClanIds: [], clans: [CLAN] });
    expect(() => clanProps.onSelectNpc!("npc-z")).not.toThrow();

    const pedigreeProps = render(pedigreeView, { clans: [], pedigree: PEDIGREE });
    expect(() => pedigreeProps.onSelectNpc!("npc-z")).not.toThrow();
    expect(() => pedigreeProps.onSelectSelf!()).not.toThrow();
  });

  it("切片不符合契约 ⇒ 两个视图都不出（组件返回 null）", () => {
    const vm = vmWithFamily({ clans: [{ id: 1 }] });
    for (const view of [clanView, pedigreeView]) {
      const Component = view.Component as unknown as (props: { vm: ViewModel }) => ReactNode;
      expect(Component({ vm })).toBeNull();
    }
  });
});
