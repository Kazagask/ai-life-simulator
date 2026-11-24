import { describe, expect, it } from "vitest";
import { presentQueuedEventV2 } from "@life-sim/game-core";
import { loadTemplates } from "../../apps/server/src/templates.ts";
import {
  commitOpening,
  createOpeningSession,
  describeNode,
  optionWeights,
  resolveStep,
} from "../../packages/game-core/src/v2/opening-dag.ts";
import type { OpeningBranchDag } from "@life-sim/shared";
import { RelationKindSchema, WorldStateV2Schema, WorldTemplateV2Schema } from "@life-sim/shared";
import { projectSnapshotV2 } from "../../packages/game-core/src/v2/projection.ts";

const silent = { warn: () => {}, error: () => {}, info: () => {} };

/** 「借原作人物的名字」= 两跳：先在 n-self 选 o-canon，再在 n-canon 选具体的人。 */
const canon = (characterId: string) => ({ "n-self": "o-canon", "n-canon": characterId });

function loadV2() {
  const registry = loadTemplates(silent);
  const entry = registry.resolve({ id: "jjk-2006", version: "3.0.0" });
  if (entry?.status !== "ready" || entry.openingDag === undefined) {
    throw new Error("jjk-2006/3.0.0 未就绪");
  }
  return entry;
}

/**
 * 跑完开局：`picks` 按节点 id 指定选项（未指定取首项），roll 自动落定、allocate 按上限填。
 * 「借原作人物」是两跳：`n-self` 选 o-canon，`n-canon` 再选具体的人。
 */
function runOpening(
  dag: OpeningBranchDag,
  template: ReturnType<typeof loadV2>["template"],
  picks: Record<string, string> = {},
  seed = 12345,
  /** 宿主初始参数（ADR-072 D7）：目前只有 `playerName`（向导里填的名字）。 */
  initial?: Record<string, unknown>,
) {
  let session = createOpeningSession(dag, seed, initial);
  for (let guard = 0; !session.done && guard < 40; guard += 1) {
    const node = dag.nodes.find((n) => n.node === session.nodeId);
    if (node === undefined) break;
    const optionId = picks[node.node] ?? node.options?.[0]?.id;
    if (node.mode === "roll") session = resolveStep(dag, session, { kind: "roll" }).session;
    else if (node.mode === "choose" && optionId !== undefined) {
      session = resolveStep(dag, session, { kind: "choose", optionId }).session;
    } else if (node.mode === "input") {
      // 姓名格（ADR-072 D7）：交空串 = 「直接用预填」，正是玩家点「就这个」的那条路径；
      // 想断言玩家改过名字的用例，自己带 `initial.playerName`。
      session = resolveStep(dag, session, { kind: "input", value: "" }).session;
    } else if (node.mode === "allocate") {
      const view = describeNode(dag, session, { template });
      let left = view?.allocation?.budget ?? 0;
      const allocation: Record<string, number> = {};
      for (const target of view?.allocation?.targets ?? []) {
        const take = Math.min(left, target.max ?? left);
        allocation[target.attribute] = take;
        left -= take;
      }
      session = resolveStep(dag, session, { kind: "allocate", allocation }).session;
    } else throw new Error(`无法推进节点：${node.node}`);
  }
  expect(session.done).toBe(true);
  return { session, state: commitOpening(dag, session, template, "w-jjk-opening-test") };
}

describe("jjk-2006 3.0.0 · 前实例化开局（v3 出身转盘）", () => {
  it("转盘一次建世界：turnIndex=0、主线门全部排队、2006 春 92 天时间锚、无 mood", () => {
    const entry = loadV2();
    const { state } = runOpening(entry.openingDag, entry.template);
    expect(state.turnIndex).toBe(0);
    expect(state.worldTime).toBe(92 * 1440);
    // 2026-11-24：两章。定时队列里是「开局第一幕 + 第一章门 + 年末收束 + 第二章开头」——
    // 第二章其余八幕走 `source: chain`，不占队列（否则 8 条排队会把 pool 抽干）。
    expect(state.delayQueue.map((i) => i.definitionId).sort()).toEqual([
      "ev-2006-end",
      "ev-ch1-gate",
      "ev-open-01",
      "ev-yz-00",
    ]);
    expect(state.delayQueue.every((i) => i.origin.kind === "schedule-init" && i.status === "waiting")).toBe(true);
    expect(state.flags.creationDone).toBe(true);
    expect(state.flags.chapter).toBe(1);
    expect(state.flags.era).toBe(1);
    // commit 即交接：否则进世界第一次行动会被 NOT_ACTIVE 拒（刷新后尤其明显）。
    expect(state.openingCompleted).toBe(true);
    // 特质在 commit 时统一获得（而非进世界后的事件）；抽到「无术式」时挂的是天与咒缚。
    const hasTechnique = state.player.statuses.some(
      (s) => s.statusId.startsWith("tech-") || s.statusId === "heavenly-restriction",
    );
    expect(hasTechnique).toBe(true);
    expect(state.player.skills.length).toBeGreaterThan(0);
    // 旧开场事件链彻底移除。
    expect(entry.template.events.some((e) => e.id === "ev-w01" || e.id === "ev-opening-wheel")).toBe(false);
    // 2026-11-19：只用来验语法、却会抢在第一章之前把玩家杀掉的理子短线已删除。
    expect(entry.template.events.some((e) => e.id.startsWith("evt:amane-short"))).toBe(false);
  });

  it("复用原作人物：基本属性取角色、self 即该角色，不重复进 npcs", () => {
    const entry = loadV2();
    const { state } = runOpening(entry.openingDag, entry.template, canon("c-riko"));
    expect(state.player.id).toBe("npc-riko");
    expect(state.player.name).toBe("天内理子");
    expect(state.npcs.some((n) => n.id === "npc-riko")).toBe(false);
  });

  it("commit 后的世界状态必须能被 state schema 重新解析（否则存档一启动就坏档）", () => {
    const entry = loadV2();
    for (const picks of [{}, canon("c-riko")]) {
      const { state } = runOpening(entry.openingDag, entry.template, picks);
      const parsed = WorldStateV2Schema.safeParse(state);
      if (!parsed.success) {
        throw new Error(
          `commit 状态解析失败：${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`,
        );
      }
      for (const edge of parsed.data.relations) {
        expect(RelationKindSchema.safeParse(edge.kind).success).toBe(true);
      }
    }
  });

  it("借原作人物的名字跳过整付转盘（两跳入场），空白开始才走出身", () => {
    const entry = loadV2();
    const dag = entry.openingDag;
    const self = dag.nodes.find((n) => n.node === "n-self");
    expect(self?.options?.find((o) => o.id === "o-new")?.goto).toBe("n-origin");
    expect(self?.options?.find((o) => o.id === "o-canon")?.goto).toBe("n-canon");

    const reuse = runOpening(dag, entry.template, canon("c-gojo"));
    expect(reuse.session.results.map((r) => r.nodeId)).toEqual(["n-self", "n-canon", "n-entrance"]);
    // reuse 路径下技能与领域来自 characters.yaml，转盘不给白送加成。
    expect(reuse.state.player.skills.some((s) => s.startsWith("sk-tech-"))).toBe(false);

    const fresh = runOpening(dag, entry.template);
    const visited = fresh.session.results.map((r) => r.nodeId);
    expect(visited).toContain("n-origin");
    expect(visited).toContain("n-gender");
    // 术式池按出身分流（2026-11-23）：普通出身进通用池，御三家「传承没断」才进家传池。
    expect(visited.includes("n-tech-generic") || visited.includes("n-tech-clan")).toBe(true);
    // 22 个节点里只有**一个**领域节点该被走到（其余九个是编译期分流的落点）。
    expect(visited.filter((n) => n.startsWith("n-dom-"))).toHaveLength(1);
  });

  it("出身=起点年份：era 与时间锚必须一致，ready1 / ready3 互斥", () => {
    const entry = loadV2();
    for (let seed = 1; seed <= 24; seed += 1) {
      const { state } = runOpening(entry.openingDag, entry.template, {}, seed);
      if (state.flags.era === 1) {
        expect(state.worldTime).toBe(92 * 1440);
        expect(state.flags.ready1).toBe(true);
        expect(state.flags.ready3).toBeUndefined();
      } else {
        expect(state.flags.era).toBe(2);
        // 2017/2018 起点：至少十一年，与「跳过九个章节」的说法一致。
        expect(state.worldTime).toBeGreaterThan(11 * 365 * 1440);
        expect(state.flags.ready3).toBe(true);
        expect(state.flags.ready1).toBeUndefined();
      }
    }
  });

  it("开局写入的技能 / 状态 / 关系端点全部存在（悬空 id 会让面板显示空白）", () => {
    const entry = loadV2();
    const skillIds = new Set(entry.template.skills.map((s) => s.id));
    const statusIds = new Set(entry.template.statuses.map((s) => s.id));
    const npcIds = new Set(entry.template.characters.map((c) => c.id));
    const flagIds = new Set<string>([
      "creationDone",
      "openingDone",
      "chapter",
      "era",
      "ready1",
      "ready3",
      "spDone",
      "bsDone",
      "npDone",
      "jvDone",
      "shDone",
      "cgDone",
      "sjDone",
      "getoGone",
      "haibaraDead",
      "gojoGone",
      "nanamiGone",
      "yutaGone",
      "yujiJoined",
      "getoStayed",
      "savedRiko",
      "savedGojo",
      "gojoSealed",
      "shibuyaSurvived",
      "defected",
      "moleClue",
    ]);

    for (let seed = 1; seed <= 12; seed += 1) {
      const { session } = runOpening(entry.openingDag, entry.template, {}, seed);
      for (const result of session.results) {
        const node = entry.openingDag.nodes.find((n) => n.node === result.nodeId);
        const option = node?.options?.find((o) => o.id === result.optionId);
        for (const [param, value] of Object.entries(option?.set ?? {})) {
          const values = Array.isArray(value) ? value : [value];
          for (const item of values) {
            if (typeof item === "string" && item.startsWith("sk-")) {
              expect(skillIds.has(item), `悬空技能：${item}`).toBe(true);
            }
          }
          if (param.toLowerCase().includes("status")) {
            for (const item of values) if (typeof item === "string") {
              expect(statusIds.has(item), `悬空状态：${item}`).toBe(true);
            }
          }
          if (param.startsWith("rel")) {
            const rel = value as { with?: string };
            if (rel?.with !== undefined) expect(npcIds.has(rel.with), `悬空关系端点：${rel.with}`).toBe(true);
          }
          if (param.startsWith("g") && value !== null && typeof value === "object") {
            const flag = (value as { id?: string }).id;
            if (flag !== undefined) expect(flagIds.has(flag), `未登记的旗标：${flag}`).toBe(true);
          }
        }
      }
    }
  });

  it("复用五条悟：带上「六眼」并按品质解析出流动彩虹（ADR-002 D2/D3）", () => {
    const entry = loadV2();
    const { state } = runOpening(entry.openingDag, entry.template, canon("c-gojo"));
    const view = projectSnapshotV2(
      state,
      entry.template,
      entry.lookup,
      null,
      entry.endingConfig?.endings,
      entry.ui,
    );
    const six = view.player.statuses.find((s) => s.id === "six-eyes");
    expect(six).toBeDefined();
    /**
     * 品级是一等字段（2026-11-20 裁决）：模板只写 `quality: mythic-unique`，
     * 标签由引擎按品级阶梯**自动生成**，不再手写 `tags`。
     */
    expect(six?.quality).toBe("mythic-unique");
    expect(six?.tags?.map((t) => t.id)).toEqual(["mythic-unique"]);
    // 标签由**引擎预置**提供：唯一·神话（动态彩）
    expect(six?.tags?.map((t) => t.name)).toEqual(["唯一·神话"]);
    expect(six?.style?.preset).toBe("rainbow");
    expect(six?.style?.animation).toBe("rainbow-flow");
    // 效果摘要也随投影下发（状态详情浮层的数据源）
    expect(six?.effects?.some((e) => e.kind === "attr")).toBe(true);
  });

  it("复用五条悟：不写出自环关系（关系边不允许自环，否则存档载不回来）", () => {
    const entry = loadV2();
    const { state } = runOpening(entry.openingDag, entry.template, canon("c-gojo"));
    // characters.yaml 里五条悟声明了 `to: player`；当玩家**就是**五条悟时它会变成自环
    expect(state.relations.length).toBeGreaterThan(0);
    expect(state.relations.every((r) => r.from !== r.to)).toBe(true);
    // 存档必须能过 schema（这是当初 `world_state_invalid` 的入口）
    expect(WorldStateV2Schema.safeParse(state).success).toBe(true);
  });

  it("战斗面板展示三类状态，且战斗态排在最前（ADR-018）", () => {
    const entry = loadV2();
    const { state } = runOpening(entry.openingDag, entry.template, canon("c-gojo"));
    // `blessed`（大吉）只有 simulation；`stun`（眩晕）有 combat 面
    state.player.statuses = [
      { statusId: "blessed", stacks: 1, appliedTurn: 0 },
      { statusId: "stun", stacks: 1, appliedTurn: 0, turnsLeft: 1 },
    ] as never;
    state.battle = {
      eventId: "ev-fight",
      settle: { enemies: [] },
      round: 1,
      player: { hp: 100, mp: 40, statuses: [], skillCooldowns: {} },
      enemies: [],
      allies: [],
      log: [],
      over: null,
    } as never;

    const view = projectSnapshotV2(
      state,
      entry.template,
      entry.lookup,
      null,
      entry.endingConfig?.endings,
      entry.ui,
    );
    const battleIds = view.battle?.player.statuses.map((s) => s.id) ?? [];
    /**
     * 2026-11-20 用户裁决：以前「没有 combat 面就不进战斗区」，理由是纯模拟面
     * 在战斗里没有行为语义。属性状态上提到定义层之后这条前提没了 ——
     * 一件只有属性效果的「大吉」会实打实改战斗数值，再藏起来就是数字变了没有原因。
     */
    expect(battleIds).toContain("stun");
    expect(battleIds).toContain("blessed");
    // 排序：战斗态在前，修正其次（天赋最后）
    expect(battleIds[0]).toBe("stun");
    // 非战斗视图不受影响：个人页仍然展示全部状态
    const worldIds = view.player.statuses.map((s) => s.id);
    expect(worldIds).toContain("blessed");
    expect(worldIds).toContain("stun");
  });

  it("品级校验：阶梯 id 免声明，自定义词仍需模板白名单", () => {
    const entry = loadV2();
    const clone = () => structuredClone(entry.template);

    // 阶梯 id：即使模板没声明 qualities 也合法（jjk 已删掉白名单）
    const ok = clone();
    expect(WorldTemplateV2Schema.safeParse(ok).success).toBe(true);

    // 模板自己的一等词汇：声明白名单后合法
    const custom = clone();
    custom.equipment = { ...custom.equipment, qualities: ["cursed"] };
    const spear = custom.items.find((i) => i.id === "eq-ten-spear");
    expect(spear).toBeDefined();
    spear!.quality = "cursed";
    expect(WorldTemplateV2Schema.safeParse(custom).success).toBe(true);

    // 既不是阶梯、也不在白名单 ⇒ 拒
    const bad = clone();
    bad.equipment = { ...bad.equipment, qualities: ["cursed"] };
    bad.items.find((i) => i.id === "eq-bancho")!.quality = "unicorn";
    const parsed = WorldTemplateV2Schema.safeParse(bad);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues ?? [])).toContain("未知品质：unicorn");
  });

  it("装备只写 quality 就拿到品级标签与名字颜色（品级 ↔ 标签联动）", () => {
    const entry = loadV2();
    const { state } = runOpening(entry.openingDag, entry.template, canon("c-gojo"));
    // 背包是 itemId → 数量的表（不是数组）
    state.player.inventory = { ...state.player.inventory, "eq-ten-spear": 1 };
    const view = projectSnapshotV2(
      state,
      entry.template,
      entry.lookup,
      null,
      entry.endingConfig?.endings,
      entry.ui,
    );
    const spear = view.player.inventory.find((i) => i.itemId === "eq-ten-spear");
    // 装备**不再写 tags**：`quality: mythic` 直接生成「一品·神话」标签（ADR-002 D2c 联动）
    expect(spear?.tags?.map((t) => t.name)).toEqual(["一品·神话"]);
    // 名字颜色来自这条标签（一品·神话 = 静态彩）
    expect(spear?.style?.preset).toBe("rainbow-static");
    expect(spear?.effects?.length ?? 0).toBeGreaterThan(0);
  });

  it("开局第一幕：冷启动把 ev-open-01 请上桌，不推轮次、不耗行动", () => {
    const entry = loadV2();
    const { state } = runOpening(entry.openingDag, entry.template);
    expect(state.slot).toBeNull();
    const before = state.turnIndex;
    presentQueuedEventV2(state, entry.template, entry.lookup);
    expect(state.slot).toEqual({ eventId: "ev-open-01", from: "queueTake", instanceId: expect.any(String) });
    expect(state.turnIndex).toBe(before);
    // 只是「呈现」：没有推进世界时间，也没有触发任何结算。
    expect(state.worldTime).toBe(92 * 1440);
  });

  it("主线定时：章节门不是 pool，开局第一幕是 window≈0 的定时事件", () => {
    const entry = loadV2();
    const gate = entry.template.events.find((e) => e.id === "ev-ch1-gate");
    if (gate === undefined) throw new Error("ev-ch1-gate 缺失");
    // 主线不许用池子：门的出现时间由时间表决定，不由随机抽取决定（pool 只留日常）。
    expect(gate.trigger.source).toBe("schedule");
    expect(gate.trigger.probability).toBeUndefined();
    expect(gate.trigger.window?.start).toEqual({ value: 215, unit: "day" });

    const open = entry.template.events.find((e) => e.id === "ev-open-01");
    if (open === undefined) throw new Error("ev-open-01 缺失");
    expect(open.trigger.source).toBe("schedule");
    expect(open.trigger.once).toBe(true);
    if (open.kind !== "normal") throw new Error("ev-open-01 必须是 normal");
    // 三个出口只决定态度（openPath），不改任何结局旗标。
    expect(open.settle.normal.options.map((o) => o.id)).toEqual([
      "opt-open-report",
      "opt-open-walk",
      "opt-open-probe",
    ]);

    const endings = entry.endingConfig?.endings.map((e) => e.endingId) ?? [];
    // 理子短线的两个 badend 随短线一起删除 —— 不再有「开局就被枪杀」的路径。
    expect(endings).not.toContain("end-riko-shot");
    expect(endings).not.toContain("end-riko-assimilated");
    // timeReached / playerRequested（早夭已改走 world.deathRoutes，ADR-075）
    expect(entry.endingConfig?.terminationConditions.length).toBeGreaterThanOrEqual(2);
  });

  it("天赋先抽：天与咒缚只有天赋一个入口，抽到它就没有术式", () => {
    const entry = loadV2();
    const dag = entry.openingDag;
    const nodes = dag.nodes;
    // 2026-11-21：顺序必须是 天赋 → 术式（后面几格的 weightByParam 要读天赋）。
    // 2026-11-23：术式拆成 传承 → 家传池 → 通用池，三格都在天赋之后。
    const talentAt = nodes.findIndex((n) => n.node === "n-talent");
    for (const id of ["n-heritage", "n-tech-clan", "n-tech-generic"]) {
      expect(talentAt, `${id} 必须在天赋之后`).toBeLessThan(nodes.findIndex((n) => n.node === id));
    }
    const talent = nodes.find((n) => n.node === "n-talent");
    const body = nodes.find((n) => n.node === "n-body");
    expect(talent?.options?.some((o) => o.id === "t-heavenly")).toBe(true);
    // 池子里只能有一个天与：三个术式池与体质池都不许再给第二次。
    for (const nodeId of ["n-tech-clan", "n-tech-generic"]) {
      const pool = nodes.find((n) => n.node === nodeId);
      expect(pool?.options?.some((o) => o.id === "t-heavenly"), nodeId).toBe(false);
    }
    expect(body?.options?.some((o) => o.id === "b-restricted")).toBe(false);

    let seen = 0;
    for (let seed = 1; seed <= 80; seed += 1) {
      const { state } = runOpening(dag, entry.template, {}, seed);
      if (state.flags.talent !== "heavenly") continue;
      seen += 1;
      // 抽到天与：术式与领域整段跳过，只留天与的肉体技能。
      // （基础咒力可能被出身/加点写高，但有效属性被 -30 压到 0 —— 见 statuses.yaml。
      //   资源上限读基础属性，所以 MP 池不保证为 0，这是已知残留。）
      expect(state.flags.tech).toBe("none");
      expect(state.player.statuses.some((s: { statusId: string }) => s.statusId === "heavenly-restriction")).toBe(true);
      expect(state.player.skills).toContain("sk-heavenly-body");
      expect(state.player.skills).not.toContain("sk-tech-space-shift");
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("御三家先转传承：断了进通用池，没断才进家传池；别的出身看不到这一格", () => {
    const entry = loadV2();
    const dag = entry.openingDag;
    const CLAN_TECHS = new Set(["ten-shadows", "red-blood", "limitless"]);
    let clanInherited = 0;
    let clanBroken = 0;
    let others = 0;
    for (let seed = 1; seed <= 160; seed += 1) {
      const { state, session } = runOpening(dag, entry.template, {}, seed);
      // 天与咒缚整段跳过术式与领域，不在本用例的判据里。
      if (state.flags.talent === "heavenly") continue;
      const visited = session.results.map((r) => r.nodeId);
      const tech = String(state.player.attributes.innateTechnique ?? "");
      if (state.flags.origin === "clan-branch") {
        expect(visited).toContain("n-heritage");
        if (state.flags.heritage === "inherited") {
          clanInherited += 1;
          expect(visited).toContain("n-tech-clan");
          expect(visited).not.toContain("n-tech-generic");
          expect(CLAN_TECHS.has(tech)).toBe(true);
        } else {
          clanBroken += 1;
          expect(visited).toContain("n-tech-generic");
          expect(visited).not.toContain("n-tech-clan");
          expect(CLAN_TECHS.has(tech)).toBe(false);
        }
      } else {
        others += 1;
        // 节点前置不成立 ⇒ 整格不上屏、也不写结果。
        expect(visited).not.toContain("n-heritage");
        expect(visited).not.toContain("n-tech-clan");
        expect(CLAN_TECHS.has(tech)).toBe(false);
      }
    }
    // 三个分支都要真的被走到，否则这条用例只是「断言恒真」。
    expect(clanInherited).toBeGreaterThan(0);
    expect(clanBroken).toBeGreaterThan(0);
    expect(others).toBeGreaterThan(0);
  });

  it("六眼（伪）：只有旁支接得住，抽到无下限再抬一档权重", () => {
    const entry = loadV2();
    const dag = entry.openingDag;
    const body = dag.nodes.find((n) => n.node === "n-body");
    const pseudo = (body?.options ?? []).findIndex((o) => o.id === "b-six-eyes-pseudo");
    expect(pseudo).toBeGreaterThanOrEqual(0);

    // 手搭会话：resolveParamMap 只认「节点 id + 选项 id」，所以可以直接指定前置落点。
    const weightFor = (originOption: string, techNode: string, techOption: string): number => {
      const session = {
        openingId: dag.openingId,
        seed: 1,
        nodeId: "n-body",
        done: false,
        results: [
          { nodeId: "n-origin", optionId: originOption },
          { nodeId: techNode, optionId: techOption },
        ],
      };
      return optionWeights(dag, session, body!)[pseudo] ?? 0;
    };

    const clanLimitless = weightFor("o-clan", "n-tech-clan", "t-limitless");
    const clanTenShadows = weightFor("o-clan", "n-tech-clan", "t-ten-shadows");
    const civilian = weightFor("o-civilian", "n-tech-generic", "t-space");

    expect(clanTenShadows).toBeGreaterThan(0);
    expect(clanLimitless).toBeGreaterThan(clanTenShadows);
    // 非旁支 base 0 ⇒ 永远不会出货（不会凭空多出一双六眼）。
    expect(civilian).toBe(0);
  });

  it("姓名格：御三家 = 姓 + 你写的名字，其它出身 = 原样；没写就转一个", () => {
    const entry = loadV2();
    const dag = entry.openingDag;
    const nameNode = dag.nodes.find((n) => n.node === "n-name");
    expect(nameNode?.mode).toBe("input");
    expect(nameNode?.input?.param).toBe("nick");
    // 姓名格在加点之前（用户裁决：先定「你是谁」，再定「你往哪儿长」）。
    expect(dag.nodes.findIndex((n) => n.node === "n-name")).toBeLessThan(
      dag.nodes.findIndex((n) => n.node === "n-allocate"),
    );

    let clan = 0;
    let others = 0;
    let generated = 0;
    for (let seed = 1; seed <= 48; seed += 1) {
      const { state } = runOpening(dag, entry.template, {}, seed, { playerName: "三郎" });
      if (state.flags.origin === "clan-branch") {
        // 姓由「家传术式」或「姓氏转盘」给，名字接在后面。
        expect(state.player.name.endsWith("三郎"), `seed ${seed}`).toBe(true);
        expect(state.player.name.length).toBeGreaterThan("三郎".length);
        clan += 1;
      } else {
        // 其它出身：写了就原样用，不强行加姓。
        expect(state.player.name, `seed ${seed}`).toBe("三郎");
        others += 1;
      }
    }
    expect(clan).toBeGreaterThan(0);
    expect(others).toBeGreaterThan(0);

    // 没写名字：所有人都会有一个「转出来的名」，不会是空串或「无名氏」。
    // 例外只有天与咒缚：他们整段跳过姓氏与术式（`goto: n-body`），所以只有名没有姓 ——
    // 设定上说得通（族谱上没有这个人），也只在 4% 的开局里出现。
    for (let seed = 1; seed <= 24; seed += 1) {
      const { state } = runOpening(dag, entry.template, {}, seed);
      expect(state.player.name).not.toBe("无名氏");
      expect(state.player.name.length).toBeGreaterThanOrEqual(1);
      if (state.flags.talent !== "heavenly") expect(state.player.name.length).toBeGreaterThan(1);
      generated += 1;
    }
    expect(generated).toBeGreaterThan(0);
  });

  it("无下限的越界：赫/茈 要「无下限术式 + 反转术式」，六眼（伪）另开一条给天赋无下限", () => {
    type Effect = { type: string; skillId?: string; status?: string };
    type PoolEvent = {
      id: string;
      trigger: { conditions?: unknown[] };
      settle?: { normal?: { options?: Array<{ effects?: Effect[] }> } };
    };
    const events = loadV2().template.events as unknown as PoolEvent[];
    const red = events.find((e) => e.id === "ev-pool-limitless-red");
    const voided = events.find((e) => e.id === "ev-pool-limitless-void");
    expect(red).toBeDefined();
    expect(voided).toBeDefined();

    const conditions = (e: PoolEvent): string => JSON.stringify(e.trigger.conditions ?? []);
    // 门票：无下限术式 + 已学会反转术式。
    for (const e of [red!, voided!]) {
      expect(conditions(e)).toContain("limitless");
      expect(conditions(e)).toContain("sk-reverse-heal");
    }
    // 两条事件靠六眼（伪）互斥：有它走「观空」那条，没有走普通那条。
    expect(conditions(red!)).toContain("six-eyes-pseudo");
    expect(conditions(red!)).toContain("false");
    expect(conditions(voided!)).toContain("true");

    const effectsOf = (e: PoolEvent): Effect[] =>
      (e.settle?.normal?.options ?? []).flatMap((o) => o.effects ?? []);
    for (const option of red!.settle?.normal?.options ?? []) {
      expect(option.effects?.some((f) => f.type === "unlockSkill" && f.skillId === "sk-gojo-red")).toBe(true);
      expect(option.effects?.some((f) => f.type === "unlockSkill" && f.skillId === "sk-gojo-hollow-purple")).toBe(true);
    }
    // 天赋无下限只在「观空」那条里给。
    expect(effectsOf(red!).some((f) => f.status === "infinity")).toBe(false);
    expect(effectsOf(voided!).some((f) => f.type === "applyStatus" && f.status === "infinity")).toBe(true);
  });
});
