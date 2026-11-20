import { describe, expect, it } from "vitest";
import type { OpeningBranchDag } from "@life-sim/shared";
import { openingParamOverwrites } from "../../apps/server/src/admin-data.ts";

/**
 * B-04：开局参数「后写覆盖先写」的体检。
 *
 * `resolveParamMap` 是 `Object.assign` —— 同一个 param id 被两处写，前一处静默消失。
 * 这条规则的难点不在发现「同 id 出现两次」，而在**排除互斥分支**：
 * `n-self` 的「自建」与 `n-canon` 的「借名」都写 `who`，但玩家只能走一边。
 * 所以下面三个用例分别锁住：真覆盖 / 互斥不报 / 同节点不报。
 */

/** 一条真覆盖：`a` 的选项与 `b` 的选项在同一路径上都写 `weapon`。 */
const overlap: OpeningBranchDag = {
  openingId: "op-test-overlap",
  name: "覆盖",
  params: [
    { id: "weapon", kind: "flag" },
    { id: "other", kind: "flag" },
  ],
  entry: "a",
  nodes: [
    {
      node: "a",
      title: "选武器",
      mode: "choose",
      options: [
        { id: "o-spear", text: "拿矛", set: { weapon: { id: "weapon", value: "spear" } }, goto: "b" },
        { id: "o-kit", text: "拿急救包", set: { weapon: { id: "weapon", value: "kit" } }, goto: "c" },
      ],
    },
    {
      node: "b",
      title: "入学式",
      mode: "roll",
      // 与 a/o-spear 写同一个 id —— 玩家自己挑的矛会被这一格悄悄换成木刀。
      options: [{ id: "o-default", text: "统一发放", set: { weapon: { id: "weapon", value: "bokken" } } }],
    },
    {
      node: "c",
      title: "旁听",
      mode: "roll",
      options: [{ id: "o-wait", text: "等通知", set: { other: { id: "other", value: "wait" } } }],
    },
  ],
};

/** 互斥分支：`who` 在「自建」那一支与「借名」那一支各写一次，两条路走不到对方。 */
const exclusive: OpeningBranchDag = {
  openingId: "op-test-exclusive",
  name: "互斥",
  params: [
    { id: "who", kind: "self" },
    { id: "line", kind: "flag" },
    { id: "nick", kind: "name" },
  ],
  entry: "a",
  nodes: [
    {
      node: "a",
      title: "自建还是借名",
      mode: "choose",
      options: [
        { id: "o-create", text: "自建", set: { who: { kind: "new", id: "player" } }, goto: "b" },
        { id: "o-canon", text: "借名", set: { line: { id: "line", value: "canon-fixed" } }, goto: "d" },
      ],
    },
    {
      node: "b",
      title: "自建后续（写名字，不碰 who）",
      mode: "roll",
      options: [{ id: "o-next", text: "继续", set: { nick: { kind: "text", value: "无名氏" } }, goto: "z" }],
    },
    {
      node: "d",
      title: "借名后续（这里才定 who）",
      mode: "roll",
      options: [{ id: "o-next", text: "继续", set: { who: { kind: "reuse", characterId: "npc-geto" } }, goto: "z" }],
    },
    { node: "z", title: "入场", mode: "roll", options: [{ id: "o-end", text: "完", set: {} }] },
  ],
};

/** 同一个节点的两个选项写同一个 id —— 一次只落一个，天然不可能覆盖。 */
const sameNode: OpeningBranchDag = {
  openingId: "op-test-same-node",
  name: "同节点",
  params: [{ id: "who", kind: "self" }],
  entry: "a",
  nodes: [
    {
      node: "a",
      title: "二选一",
      mode: "choose",
      options: [
        { id: "o-1", text: "一", set: { who: { kind: "new", id: "player" } }, goto: "b" },
        { id: "o-2", text: "二", set: { who: { kind: "reuse", characterId: "npc-gojo" } }, goto: "b" },
      ],
    },
    { node: "b", title: "结束", mode: "roll", options: [{ id: "o-end", text: "完", set: {} }] },
  ],
};

describe("B-04 · 开局参数后写覆盖", () => {
  it("同一条路径上两处写同一个 id ⇒ 报出来，并点名两处", () => {
    const rows = openingParamOverwrites(overlap);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.param).toBe("weapon");
    // 只有 `a/o-spear` 与 `b/o-default` 会同时发生；`a/o-kit` 走的是另一条支路
    expect(rows[0]?.writers.map((w) => `${w.node}/${w.option}`)).toEqual(["a/o-spear", "b/o-default"]);
  });

  it("分叉互斥的两处写同一个 id ⇒ 不报（玩家走不到两边）", () => {
    expect(openingParamOverwrites(exclusive)).toEqual([]);
  });

  it("同一个节点的两个选项写同一个 id ⇒ 不报（一次只落一个）", () => {
    expect(openingParamOverwrites(sameNode)).toEqual([]);
  });

  it("没有开局 DAG 的模板（legacy opening）⇒ 空清单，不炸", () => {
    expect(openingParamOverwrites(undefined)).toEqual([]);
  });
});
