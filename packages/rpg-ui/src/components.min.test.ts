import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { V2Snapshot, ViewModel } from "@life-sim/shared";
import { ViewModelSchema } from "@life-sim/shared";
import { toViewModel } from "./adapter.js";
import { ActionBar } from "./ActionBar.js";
import { CgStage, isCgSlot } from "./CgStage.js";
import { EventStage } from "./EventStage.js";
import { NarrativeStream } from "./NarrativeStream.js";
import { Portrait } from "./Portrait.js";
import { StatusBars } from "./StatusBars.js";
import { WorldClock } from "./WorldClock.js";

const h = createElement;
const render = (node: ReactElement) => renderToStaticMarkup(node);

// ---------- 真实形状快照夹具（含可选字段缺省的一组） ----------

const BASE_SNAPSHOT: V2Snapshot = {
  worldId: "w1",
  templateId: "demo-agentic",
  worldName: "酒馆余生",
  turnIndex: 7,
  worldTime: 24,
  formattedTime: "第 2 年 · 春",
  lifeStage: "adult",
  lifeStageLabel: "成年",
  startYear: 1,
  labels: {
    resources: { hp: "气血", mp: "灵力" },
    attributes: { str: "力量" },
    mood: "心境",
  },
  player: {
    id: "p1",
    name: "林暮",
    age: 19,
    gender: "female",
    genderLabel: "女",
    hp: 42,
    maxHp: 60,
    mp: 5,
    maxMp: 20,
    mood: 66,
    moodBandLabel: "平和",
    attributes: { str: 12 },
    statuses: [],
    skills: [],
    inventory: [],
  },
  npcs: [{ id: "n1", name: "老酒保" } as V2Snapshot["npcs"][number]],
  // 稀疏参与：没有脚本场景 / 没有战斗 / 没有终局 / 没有媒体投影
  slotEvent: null,
  battle: null,
  lastWheel: null,
  lastWheels: [],
  availableActions: [{ id: "explore", label: "四处走走", description: "看看镇上有什么新鲜事", duration: { value: 1, unit: "day" } }],
  evaluation: { summary: "平凡的一天。", canonDeviation: 0 },
};

describe("toViewModel: 快照 → 视图模型", () => {
  it("映射核心字段，并容忍 slotEvent/battle/ending/media 全缺省", () => {
    const vm = toViewModel({ snapshot: BASE_SNAPSHOT });

    expect(vm.player).toEqual({ id: "p1", name: "林暮" });
    expect(vm.npcs).toEqual([{ id: "n1", name: "老酒保" }]);
    expect(vm.slot).toBeNull();
    expect(vm.battle).toBeNull();
    expect(vm.ending).toBeNull();
    expect(vm.media).toEqual([]);
    expect(vm.content).toEqual([]);
    expect(vm.turnIndex).toBe(7);
    expect(vm.formattedTime).toBe("第 2 年 · 春");
    expect(vm.lifeStage).toBe("adult");
    expect(vm.lifeStageLabel).toBe("成年");
    expect(vm.storyChapter).toBeUndefined();
    expect(vm.llmPending).toBeUndefined();
    // 动作只保留展示字段（duration 等规则字段不下发到视图层）
    expect(vm.availableActions).toEqual([
      { id: "explore", label: "四处走走", description: "看看镇上有什么新鲜事" },
    ]);
  });

  it("资源条标签取模板 labels.resources，max 归一为 ≥1", () => {
    const vm = toViewModel({ snapshot: BASE_SNAPSHOT });
    expect(vm.statusBar).toEqual([
      { key: "hp", label: "气血", value: 42, max: 60, tone: "normal" },
      { key: "mp", label: "灵力", value: 5, max: 20, tone: "danger" },
    ]);

    const broken = toViewModel({
      snapshot: { ...BASE_SNAPSHOT, player: { ...BASE_SNAPSHOT.player, maxHp: 0, maxMp: -3 } },
    });
    expect(broken.statusBar[0]?.max).toBe(1);
    expect(broken.statusBar[1]?.max).toBe(1);
  });

  it("tone 阈值在适配器里算：剩余 ≤25% 判 danger，展示层不写阈值规则", () => {
    const at = (hp: number, maxHp: number) =>
      toViewModel({ snapshot: { ...BASE_SNAPSHOT, player: { ...BASE_SNAPSHOT.player, hp, maxHp } } }).statusBar[0]?.tone;

    expect(at(60, 60)).toBe("normal");
    expect(at(16, 60)).toBe("normal"); // 26.7% → 未到阈值
    expect(at(15, 60)).toBe("danger"); // 25% → danger（含边界）
    expect(at(0, 60)).toBe("danger");
  });

  it("产出必须通过 ViewModelSchema（.strict() 契约）", () => {
    expect(ViewModelSchema.safeParse(toViewModel({ snapshot: BASE_SNAPSHOT })).success).toBe(true);
  });

  it("映射战斗 / 结局 / 章节 / llmPending / 媒体，并丢弃引擎战斗细节", () => {
    const snapshot: V2Snapshot = {
      ...BASE_SNAPSHOT,
      storyChapter: 3,
      llmPending: true,
      slotEvent: { eventId: "e9", from: "opening", kind: "normal", title: "雨夜来客", narrative: "门被推开。" },
      media: [{ slot: "portrait.mentor.neutral", assetId: "portrait.mentor.neutral", url: "/a.png", alt: "导师" }],
      battle: {
        eventId: "b1",
        round: 2,
        over: null,
        player: {
          hp: 30,
          maxHp: 60,
          mp: 4,
          maxMp: 20,
          statuses: [],
          skills: [{ id: "s1", name: "斩", description: "", costMp: 2, cooldownLeft: 0 }],
          items: [],
          canFlee: true,
          canUseItems: true,
          canAct: true,
        },
        enemies: [
          { instanceId: "m1", name: "醉汉", hp: 10, maxHp: 25, alive: true, statuses: [] },
          { instanceId: "m2", name: "打手", hp: 0, maxHp: 18, alive: false, statuses: [] },
        ],
        allies: [{ instanceId: "a1", name: "酒保", hp: 8, maxHp: 12, alive: true, statuses: [] }],
        log: ["你挥剑。", "醉汉后退。"],
      },
      ending: {
        endingId: "end1",
        title: "归于尘土",
        summary: "你安静地离开了。",
        endingType: "death",
        visibility: "public",
        source: "battleDefeat",
        reason: "",
        worldTime: 30,
        turnIndex: 9,
        narrativeSource: "template",
        evidenceIds: [],
      },
    };
    const vm = toViewModel({ snapshot });

    expect(vm.slot).toEqual({ eventId: "e9", title: "雨夜来客", narrative: "门被推开。" });
    expect(vm.storyChapter).toBe(3);
    expect(vm.llmPending).toBe(true);
    expect(vm.media).toHaveLength(1);
    expect(vm.battle).toEqual({
      round: 2,
      over: null,
      player: { hp: 30, maxHp: 60, mp: 4, maxMp: 20 },
      enemies: [
        { id: "m1", name: "醉汉", hp: 10, maxHp: 25, alive: true },
        { id: "m2", name: "打手", hp: 0, maxHp: 18, alive: false },
      ],
      allies: [{ id: "a1", name: "酒保", hp: 8, maxHp: 12, alive: true }],
      log: ["你挥剑。", "醉汉后退。"],
    });
    // 引擎战斗细节（技能 / 道具 / 控制判定）不得出现在视图模型里
    expect(JSON.stringify(vm.battle)).not.toContain("skills");
    expect(vm.ending).toEqual({ title: "归于尘土", summary: "你安静地离开了。" });
    expect(ViewModelSchema.safeParse(vm).success).toBe(true);
  });

  it("显式传入的 content / media 覆盖缺省值（叙事正文由 trace 读回时走这条路）", () => {
    const vm: ViewModel = toViewModel({
      snapshot: BASE_SNAPSHOT,
      content: [{ blockId: "c1", kind: "narrative", text: "你推开门。" }],
      media: [{ slot: "portrait.mentor.neutral", assetId: "x", url: "/x.png", alt: "导师" }],
    });
    expect(vm.content).toEqual([{ blockId: "c1", kind: "narrative", text: "你推开门。" }]);
    expect(vm.media[0]?.assetId).toBe("x");
  });
});

// ---------- 组件（renderToStaticMarkup，不引入 @testing-library） ----------

describe("EventStage", () => {
  it("空槽降级为「自由行动」，不渲染场景标题", () => {
    const html = render(h(EventStage, { slot: null }));
    expect(html).toContain("自由行动");
    expect(html).not.toContain("ls-stage__title");
  });

  it("有场景时渲染标题与正文，缺省正文用空串兜底", () => {
    const withText = render(h(EventStage, { slot: { eventId: "e1", title: "雨夜", narrative: "雨在下。" } }));
    expect(withText).toContain("雨夜");
    expect(withText).toContain("雨在下。");

    const noText = render(h(EventStage, { slot: { eventId: "e1", title: "雨夜" } }));
    expect(noText).toContain("雨夜");
    expect(noText).toContain('data-slot="scene"');
  });
});

describe("NarrativeStream", () => {
  it("按入参顺序渲染，并按 kind 分派渲染器", () => {
    const html = render(
      h(NarrativeStream, {
        content: [
          { blockId: "b1", kind: "narrative", text: "雨声渐密。" },
          { blockId: "b2", kind: "option", text: "敲门" },
          { blockId: "b3", kind: "flavor", text: "炉火噼啪。" },
          { blockId: "b4", kind: "memory", text: "你想起母亲。" },
        ],
      }),
    );
    const i1 = html.indexOf("雨声渐密。");
    const i2 = html.indexOf("敲门");
    const i3 = html.indexOf("炉火噼啪。");
    const i4 = html.indexOf("你想起母亲。");
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(i3).toBeLessThan(i4);
    expect(html).toContain("ls-choice");
    expect(html).toContain("ls-narrative__block--flavor");
    // 未注册的 kind 按正文渲染（服务端新增内容块类型不会让前端崩）
    expect(html).toContain('data-kind="memory"');
  });

  it("选项块是第二点击面：有 onAct 时渲染可点按钮，无 onAct 时只作展示", () => {
    const interactive = render(
      h(NarrativeStream, {
        content: [{ blockId: "o1", kind: "option", text: "先退半步" }],
        onAct: () => {},
      }),
    );
    expect(interactive).toMatch(/<button[^>]*class="ls-choice"/);
    expect(interactive).toContain("先退半步");

    const readOnly = render(
      h(NarrativeStream, { content: [{ blockId: "o1", kind: "option", text: "先退半步" }] }),
    );
    expect(readOnly).not.toContain("<button");
    expect(readOnly).toContain("ls-choice--static");
  });

  it("renderers 可覆盖单个 kind，未知 kind 仍回退正文", () => {
    const html = render(
      h(NarrativeStream, {
        content: [
          { blockId: "b1", kind: "narrative", text: "第一段" },
          { blockId: "b2", kind: "battle-hint", text: "提示" },
        ],
        renderers: {
          narrative: (block) => h("em", { className: "custom" }, block.text ?? ""),
        },
      }),
    );
    expect(html).toContain('<em class="custom">第一段</em>');
    expect(html).toContain("提示");
  });

  it("asset 块按 assetId 内联到流里，且每轮至多一张", () => {
    const media = [
      { slot: "scene", assetId: "cg1", url: "/cg1.png", alt: "雨夜" },
      { slot: "scene", assetId: "cg2", url: "/cg2.png", alt: "炉火" },
    ];
    const html = render(
      h(NarrativeStream, {
        media,
        content: [
          { blockId: "b1", kind: "narrative", text: "推门而入。" },
          { blockId: "b2", kind: "asset", assetId: "cg1" },
          { blockId: "b3", kind: "asset", assetId: "cg2" },
        ],
      }),
    );
    expect(html).toContain('src="/cg1.png"');
    expect(html).not.toContain('src="/cg2.png"');

    // 解析不到资源 ⇒ 不占位（不猜图、不留破图）
    const unresolved = render(
      h(NarrativeStream, { media, content: [{ blockId: "b1", kind: "asset", assetId: "nope" }] }),
    );
    expect(unresolved).not.toContain("<img");
  });

  it("空列表给空态文案而不是空容器", () => {
    const html = render(h(NarrativeStream, { content: [] }));
    expect(html).toContain("ls-narrative__empty");
    expect(html).not.toContain('role="log"');
  });
});

describe("ActionBar（主点击面）", () => {
  const actions = [
    { id: "explore", label: "四处走走", description: "看看镇上" },
    { id: "rest", label: "歇一会", description: "" },
  ];

  it("≤4 个动作用单列卡片，>4 个用两列网格", () => {
    const stack = render(h(ActionBar, { actions, onAct: () => {} }));
    expect(stack).toContain('data-layout="stack"');

    const many = render(
      h(ActionBar, {
        onAct: () => {},
        actions: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: `动作${i}`, description: "" })),
      }),
    );
    expect(many).toContain('data-layout="grid"');
  });

  it("战斗进行中整条禁用", () => {
    const html = render(
      h(ActionBar, {
        actions,
        onAct: () => {},
        battle: {
          round: 1,
          over: null,
          player: { hp: 1, maxHp: 1, mp: 0, maxMp: 1 },
          enemies: [],
          allies: [],
          log: [],
        },
      }),
    );
    expect(html.match(/<button[^>]*disabled/g)?.length).toBe(3); // 2 个动作 + 自由行动入口
    expect(html).toContain('aria-disabled="true"');
  });

  it("无动作时不渲染空容器，只留「自由行动…」入口", () => {
    const empty = render(h(ActionBar, { actions: [], onAct: () => {} }));
    expect(empty).not.toContain("ls-actionbar__list");
    expect(empty).toContain("自由行动…");
    expect(empty).toMatch(/<button[^>]*class="ls-actionbar__free"/);
  });

  it("无战斗时动作可点", () => {
    const html = render(h(ActionBar, { actions, onAct: () => {} }));
    expect(html).not.toMatch(/<button[^>]*\sdisabled/);
    expect(html).toContain("四处走走");
  });
});

describe("Portrait / CgStage", () => {
  it("渲染 img 的 url 与 alt", () => {
    const html = render(
      h(Portrait, { media: { slot: "portrait.mentor.neutral", assetId: "a1", url: "/p.png", alt: "导师立绘" } }),
    );
    expect(html).toContain('src="/p.png"');
    expect(html).toContain('alt="导师立绘"');
  });

  it("url 为空时回退成占位块（aria-label 保留 alt）", () => {
    const html = render(
      h(Portrait, { media: { slot: "portrait.mentor.neutral", assetId: "a1", url: "", alt: "导师立绘" } }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="导师立绘"');
  });

  it("CG 槽前缀识别 + 只有 CG 槽才全出血上屏", () => {
    expect(isCgSlot("cg")).toBe(true);
    expect(isCgSlot("cg.opening")).toBe(true);
    expect(isCgSlot("CG-battle")).toBe(true);
    expect(isCgSlot("portrait.mentor.neutral")).toBe(false);
    expect(isCgSlot("cgx")).toBe(false);

    const cg = render(
      h(CgStage, { media: [{ slot: "cg.opening", assetId: "cg1", url: "/cg.png", alt: "开场" }] }),
    );
    expect(cg).toContain('data-slot="cg.opening"');
    expect(cg).toContain('src="/cg.png"');

    const none = render(
      h(CgStage, { media: [{ slot: "portrait.mentor.neutral", assetId: "p", url: "/p.png", alt: "导师" }] }),
    );
    expect(none).toBe("");
  });

  it("inline 模式按显式引用上屏，不受 cg 槽名限制", () => {
    const html = render(
      h(CgStage, { media: [{ slot: "scene", assetId: "s1", url: "/s.png", alt: "场景" }], inline: true }),
    );
    expect(html).toContain('src="/s.png"');
    expect(html).toContain('data-slot="scene"');
  });
});

describe("WorldClock / StatusBars", () => {
  it("时钟渲染时间与阶段，章节缺省时不渲染", () => {
    const plain = render(h(WorldClock, { formattedTime: "第 2 年 · 春", lifeStageLabel: "成年" }));
    expect(plain).toContain("第 2 年 · 春");
    expect(plain).toContain("成年");
    expect(plain).not.toContain("章");

    const chapter = render(h(WorldClock, { formattedTime: "T", lifeStageLabel: "成年", storyChapter: 2 }));
    expect(chapter).toContain("第 2 章");
  });

  it("资源条把超界数值夹到 0-100%，且只按 tone 上色", () => {
    const html = render(
      h(StatusBars, {
        bars: [
          { key: "hp", label: "气血", value: 120, max: 60, tone: "normal" },
          { key: "mp", label: "灵力", value: -5, max: 20, tone: "danger" },
        ],
      }),
    );
    expect(html).toContain("width:100%");
    expect(html).toContain("width:0%");
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('data-tone="normal"');
  });

  it("空资源条渲染占位而不是静默消失", () => {
    const html = render(h(StatusBars, { bars: [] }));
    expect(html).toContain("ls-bars__empty");
    expect(html).toContain("暂无资源条");
  });
});

// ---------- 源码守卫：组件层不得接触引擎快照 ----------

type GuardOptions = { dir: string };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * 适配器是**唯一**允许 import `V2Snapshot` 的模块（自定义前端复用它做快照搬运）。
 * 组件与样式一律只吃 ViewModel；此守卫防止后续改动把引擎类型漏进展示层。
 */
function assertNoSnapshotLeak({ dir }: GuardOptions): string[] {
  const allowed = new Set(["adapter.ts"]);
  const offenders: string[] = [];
  for (const file of sourceFiles(dir)) {
    const name = path.basename(file);
    if (allowed.has(name) || name.includes(".test.")) continue;
    if (readFileSync(file, "utf8").includes("V2Snapshot")) offenders.push(name);
  }
  return offenders;
}

describe("source guard: 组件层零引擎类型", () => {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));

  it("除 adapter.ts 外，src 下没有任何 V2Snapshot 引用", () => {
    const files = sourceFiles(srcDir);
    // 防空跑：守卫必须真的扫到了组件源码
    expect(files.some((f) => f.endsWith("NarrativeStream.tsx"))).toBe(true);
    expect(assertNoSnapshotLeak({ dir: srcDir })).toEqual([]);
  });

  it("组件模块只依赖 react / @life-sim/shared", () => {
    const external = new Set<string>();
    for (const file of sourceFiles(srcDir)) {
      if (file.includes(".test.") || file.endsWith("adapter.ts")) continue;
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+"([^".][^"]*)"/g)) {
        external.add(m[1] ?? "");
      }
    }
    for (const spec of external) {
      expect(spec === "react" || spec.startsWith("@life-sim/shared")).toBe(true);
    }
  });
});
