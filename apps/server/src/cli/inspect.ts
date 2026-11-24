#!/usr/bin/env node
/**
 * 模板 / trace 体检命令（2026-11-19）。
 *
 * 给 agent（和懒得开浏览器的人）用的只读入口。数据推导与 `/admin` 网页完全同源：
 * 两边都走 `admin-data.ts`，所以命令行说「有断链」时网页一定也标红。
 *
 *   pnpm inspect                          # 概览：所有模板版本 + 体检摘要 + 世界列表
 *   pnpm inspect check                    # 只跑体检；有 error 时 exit 1（可挂 CI）
 *   pnpm inspect tpl                      # 模板概览（默认取当前存档用的版本）
 *   pnpm inspect tpl --flag savedRiko     # 某旗标谁写谁读
 *   pnpm inspect tpl --event ev-d-canteen # 某事件的触发 / 选项 / 效果
 *   pnpm inspect tpl --line ev-hv-06      # 一条支线走到底（分支 + 条件 + 旗标）
 *   pnpm inspect tpl --line hv            # 只给线名：按前缀列出整条线
 *   pnpm inspect tpl --npc 夏油            # 角色线：身份 + 登场/生死 + 所有场景
 *   pnpm inspect tpl --grep 理子           # 搜事件
 *   pnpm inspect tpl --endings            # 结局与终止条件
 *   pnpm inspect trace                    # trace 时间线（默认最新存档）
 *   pnpm inspect trace --limit 5 --full   # 只看最近 5 条并展开正文
 *   pnpm inspect sim --as npc-gojo --vs npc-toji          # 打一场真人对局 ×100
 *   pnpm inspect sim --as npc-xxx --dummy hp=500,agility=8  # 打木桩量输出
 *   pnpm inspect sim --as npc-geto --dummy hp=900 --stance coverage  # 走完召唤→召回环
 *
 * 通用开关：`--json` 输出机器可读结构；`--tpl jjk-2006@2.0.0` 指定模板；`--all` 不过滤 info。
 */
import { existsSync } from "node:fs";
import {
  buildOrchestration,
  diagnoseOrchestration,
  listWorlds,
  readTraceFile,
  type AdminIssue,
  type AdminOrchestration,
  type AdminWorldRow,
  type TraceFileSummary,
} from "../admin-data.js";
import {
  buildIdentityLine,
  buildLine,
  findCharacter,
  searchOrchestration,
  type LineNode,
  type NpcLine,
} from "../admin-lines.js";
import { loadPersistedWorlds } from "../store.js";
import { registerServerExtensions } from "../extensions.js";
import { loadTemplates, type ReadyTemplateEntry, type TemplateRegistry, type TemplateScanLogger } from "../templates.js";
import { simulateDuel, type SimActorSpec } from "../admin/sim.js";

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

interface Args {
  command: string;
  positional: string[];
  json: boolean;
  full: boolean;
  all: boolean;
  verbose: boolean;
  endings: boolean;
  limit: number;
  depth: number;
  flag?: string;
  event?: string;
  tpl?: string;
  world?: string;
  grep?: string;
  npc?: string;
  line?: string;
  as?: string;
  vs?: string;
  dummy?: string;
  skills?: string;
  repeat: number;
  maxRounds: number;
  seed: number;
  stance?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "overview",
    positional: [],
    json: false,
    full: false,
    all: false,
    verbose: false,
    endings: false,
    limit: 12,
    depth: 12,
    repeat: 100,
    maxRounds: 30,
    seed: 1,
  };
  let commandSet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.command = "help";
      commandSet = true;
    } else if (token === "--json") args.json = true;
    else if (token === "--full") args.full = true;
    else if (token === "--all") args.all = true;
    else if (token === "--endings") args.endings = true;
    else if (token === "--verbose" || token === "-v") args.verbose = true;
    else if (token === "--limit") args.limit = Number.parseInt(argv[++i] ?? "12", 10) || 12;
    else if (token === "--depth") args.depth = Number.parseInt(argv[++i] ?? "12", 10) || 12;
    else if (token === "--flag") args.flag = argv[++i];
    else if (token === "--event") args.event = argv[++i];
    else if (token === "--grep") args.grep = argv[++i];
    else if (token === "--npc") args.npc = argv[++i];
    else if (token === "--line") args.line = argv[++i];
    else if (token === "--tpl") args.tpl = argv[++i];
    else if (token === "--world") args.world = argv[++i];
    else if (token === "--as") args.as = argv[++i];
    else if (token === "--vs") args.vs = argv[++i];
    else if (token === "--dummy") args.dummy = argv[++i];
    else if (token === "--skills") args.skills = argv[++i];
    else if (token === "--repeat") args.repeat = Number.parseInt(argv[++i] ?? "100", 10) || 100;
    else if (token === "--max-rounds") args.maxRounds = Number.parseInt(argv[++i] ?? "30", 10) || 30;
    else if (token === "--seed") args.seed = Number.parseInt(argv[++i] ?? "1", 10) || 1;
    else if (token === "--stance") args.stance = argv[++i];
    else if (token.startsWith("-")) {
      fail(`未知参数：${token}`);
    } else if (!commandSet) {
      args.command = token;
      commandSet = true;
    } else {
      args.positional.push(token);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 初始化（模板注册表 + 世界）
 * ------------------------------------------------------------------ */

const logger: TemplateScanLogger = {
  warn: (obj, msg) => {
    if (quiet) return;
    console.error(`[templates:warn] ${msg} ${compact(obj)}`);
  },
  error: (obj, msg) => console.error(`[templates:error] ${msg} ${compact(obj)}`),
  info: () => undefined,
};

let quiet = false;

function compact(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

interface Ctx {
  registry: TemplateRegistry;
  worlds: AdminWorldRow[];
}

function bootstrap(needWorlds: boolean): Ctx {
  // 必须早于任何模板扫描：拒载校验读的是扩展运行时注册表，
  // 不注册会把 valmont / jjk-shinjuku 这类声明了 family 的模板误判成 unknown_extension。
  registerServerExtensions();
  const registry = loadTemplates(logger);
  let worlds: AdminWorldRow[] = [];
  if (needWorlds) {
    // 只载入不 hydrate：hydrate 会规范化并回写存档，这个工具必须只读。
    const { loaded, unloadable } = loadPersistedWorlds(registry);
    worlds = listWorlds({ loaded, unloadable });
  }
  return { registry, worlds };
}

/** 版本按数值比较：`2.0.1 > 2.0.0 > 1.0.0`。 */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 选模板：显式 `--tpl` > 当前存档引用的版本 > 最高可载版本。
 * 「当前存档用的版本」优先，是因为排查问题十次有九次是问「我这局为什么触发不了 X」。
 */
function pickTemplate(ctx: Ctx, args: Args): ReadyTemplateEntry {
  const spec = args.tpl ?? args.positional[0];
  if (spec) {
    const [id, version] = spec.includes("@") ? spec.split("@") : [spec, undefined];
    if (!id) fail(`模板标识不合法：${spec}`);
    const versions = ctx.registry.versionsOf(id);
    if (versions.length === 0) fail(`模板不存在：${id}（可用 --tpl 指定 id@version）`);
    const chosen = version
      ? versions.find((v) => v.ref.version === version)
      : [...versions]
          .filter((v) => v.status === "ready")
          .sort((a, b) => cmpVersion(a.ref.version, b.ref.version))[0];
    if (!chosen) fail(`${id}@${version ?? "latest"} 不存在`);
    if (chosen.status !== "ready") {
      fail(`${id}@${chosen.ref.version} 不可载入：${chosen.reason}`);
    }
    return chosen;
  }

  const current = ctx.worlds.find((w) => w.loadable && w.templateId && w.templateVersion);
  if (current?.templateId && current.templateVersion) {
    const entry = ctx.registry.resolve({ id: current.templateId, version: current.templateVersion });
    if (entry) return entry;
  }
  const ids = [...new Set(ctx.registry.listTemplates().map((t) => t.id))];
  for (const id of ids) {
    const ready = ctx.registry
      .versionsOf(id)
      .filter((v) => v.status === "ready")
      .sort((a, b) => cmpVersion(a.ref.version, b.ref.version));
    if (ready[0]) return ready[0];
  }
  return fail("没有任何可载入的模板版本");
}

function pickWorld(ctx: Ctx, args: Args): AdminWorldRow {
  const id = args.world ?? args.positional[0];
  if (id) {
    const row = ctx.worlds.find((w) => w.id === id || w.id.startsWith(id));
    if (!row) fail(`找不到世界：${id}`);
    return row;
  }
  const withTrace = ctx.worlds.filter((w) => w.trace.exists && w.trace.entries > 0);
  const best = withTrace.sort(
    (a, b) => (b.turnIndex ?? -1) - (a.turnIndex ?? -1) || b.trace.entries - a.trace.entries,
  )[0];
  if (!best) fail("data/worlds 里没有任何 trace，先玩一局");
  return best;
}

/* ------------------------------------------------------------------ *
 * 输出工具
 * ------------------------------------------------------------------ */

const ICON = { error: "ERR ", warn: "WARN", info: "INFO" } as const;

function issueLine(issue: AdminIssue): string {
  const subject = issue.subject ? ` [${issue.subject}]` : "";
  return `  ${ICON[issue.level]}  ${issue.rule}${subject}  ${issue.message}`;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function header(title: string): void {
  console.log(`\n${title}`);
  console.log("─".repeat(Math.min(72, Math.max(12, title.length))));
}

/* ------------------------------------------------------------------ *
 * 命令：overview
 * ------------------------------------------------------------------ */

function renderOverview(ctx: Ctx, args: Args): void {
  const summary = ctx.registry.listTemplates();
  const versions = summary.flatMap((t) => t.versions);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          templateDir: ctx.registry.dir,
          templates: summary,
          worlds: ctx.worlds,
        },
        null,
        2,
      ),
    );
    return;
  }

  header(`模板 · ${ctx.registry.dir}`);
  for (const t of summary) {
    console.log(`  ${t.id}  ${t.name}${t.startVersion ? `  (默认 ${t.startVersion})` : ""}`);
    for (const v of t.versions) {
      if (v.loadable) {
        const entry = ctx.registry.resolve({ id: t.id, version: v.version })!;
        const orch = buildOrchestration(entry);
        const issues = diagnoseOrchestration(orch);
        const errs = issues.filter((i) => i.level === "error").length;
        const warns = issues.filter((i) => i.level === "warn").length;
        console.log(
          `    ${v.version.padEnd(8)} ready    ${String(orch.stats.eventCount).padStart(4)} events  ` +
            `${String(orch.stats.edgeCount).padStart(4)} edges  ${String(orch.stats.flagCount).padStart(3)} flags  ` +
            `${String((orch.endings as unknown[]).length).padStart(2)} endings  ` +
            `err ${errs} / warn ${warns}`,
        );
      } else {
        console.log(`    ${v.version.padEnd(8)} INVALID  ${truncate(v.reason ?? "", 90)}`);
      }
    }
  }

  const totalIssues = versions
    .filter((v) => v.loadable)
    .flatMap((v) => {
      const entry = ctx.registry.resolve({ id: v.id, version: v.version });
      return entry ? diagnoseOrchestration(buildOrchestration(entry)) : [];
    });
  const errors = totalIssues.filter((i) => i.level === "error");
  header(`体检 · error ${errors.length} · warn ${totalIssues.filter((i) => i.level === "warn").length}`);
  if (errors.length === 0) console.log("  没有 error 级问题");
  for (const issue of errors.slice(0, 20)) console.log(issueLine(issue));
  if (errors.length > 20) console.log(`  … 另有 ${errors.length - 20} 条 error，用 \`inspect check\` 看全量`);

  header(`世界 · ${ctx.worlds.length}`);
  if (ctx.worlds.length === 0) console.log("  (空)");
  for (const w of ctx.worlds) {
    const name = w.playerName ?? "(不可载)";
    const tpl = w.templateId ? `${w.templateId}@${w.templateVersion}` : "-";
    const turn = w.turnIndex !== undefined ? `T${w.turnIndex}` : "-";
    const when = w.formattedTime ?? "-";
    const trace = w.trace.exists ? `trace ${w.trace.entries}` : "no trace";
    const bad = w.loadable ? "" : `  ! ${truncate(w.unloadableDetail ?? w.unloadableReason ?? "unloadable", 80)}`;
    console.log(`  ${w.id.slice(0, 8)}  ${name.padEnd(10)} ${tpl.padEnd(20)} ${turn.padEnd(6)} ${when}  ${trace}${bad}`);
  }
  console.log("\n下一步：inspect tpl --flag <id> / inspect tpl --event <id> / inspect trace");
}

/* ------------------------------------------------------------------ *
 * 命令：check
 * ------------------------------------------------------------------ */

function renderCheck(ctx: Ctx, args: Args): void {
  const all: Array<{ tpl: string; issue: AdminIssue }> = [];
  for (const t of ctx.registry.listTemplates()) {
    for (const v of t.versions) {
      if (!v.loadable) {
        all.push({
          tpl: `${t.id}@${v.version}`,
          issue: { level: "error", rule: "dangling-edge", message: `版本不可载入：${v.reason ?? ""}` },
        });
        continue;
      }
      const entry = ctx.registry.resolve({ id: t.id, version: v.version });
      if (!entry) continue;
      const orch = buildOrchestration(entry);
      for (const issue of diagnoseOrchestration(orch)) all.push({ tpl: `${t.id}@${v.version}`, issue });
    }
  }

  // trace 侧：坏行是唯一硬错误，其余只是观察
  const traceIssues: Array<{ world: string; level: AdminIssue["level"]; message: string }> = [];
  for (const w of ctx.worlds) {
    if (!w.trace.exists) continue;
    const summary = readTraceFile(w.id);
    if (summary.skippedLines > 0) {
      traceIssues.push({ world: w.id.slice(0, 8), level: "error", message: `${summary.skippedLines} 行无法解析` });
    }
    if (summary.stats.fallback > 0) {
      traceIssues.push({
        world: w.id.slice(0, 8),
        level: "warn",
        message: `fallback ${summary.stats.fallback} 次（${summary.stats.fallbackCodes.map((c) => c.code).join(", ")}）`,
      });
    }
  }

  const visible = args.all ? all : all.filter((a) => a.issue.level !== "info");
  const errors = visible.filter((a) => a.issue.level === "error");
  const warns = visible.filter((a) => a.issue.level === "warn");

  if (args.json) {
    console.log(JSON.stringify({ templates: all, trace: traceIssues }, null, 2));
  } else {
    header(`模板体检 · error ${errors.length} · warn ${warns.length} · info ${all.length - errors.length - warns.length}`);
    let lastTpl = "";
    for (const row of visible) {
      if (row.tpl !== lastTpl) {
        console.log(`\n  ${row.tpl}`);
        lastTpl = row.tpl;
      }
      console.log(issueLine(row.issue));
    }
    if (visible.length === 0) console.log("  没有 error / warn");
    if (traceIssues.length > 0) {
      header(`trace 体检 · ${traceIssues.length}`);
      for (const t of traceIssues) console.log(`  ${t.world}  [${t.level.toUpperCase()}] ${t.message}`);
    }
  }

  if (errors.length > 0 || traceIssues.some((t) => t.level === "error")) process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 命令：tpl
 * ------------------------------------------------------------------ */

const TIME_UNIT: Record<string, string> = { day: "天", hour: "小时", minute: "分钟", month: "月", year: "年" };

function describeCondition(cond: unknown): string {
  if (cond === null || typeof cond !== "object") return String(cond);
  const c = cond as Record<string, unknown>;
  const ops = ["eq", "ne", "gte", "lte", "gt", "lt"]
    .filter((k) => c[k] !== undefined)
    .map((k) => `${k} ${JSON.stringify(c[k])}`)
    .join(" ");
  if (typeof c.flag === "string") return `flag:${c.flag} ${ops}`.trim();
  if (typeof c.attribute === "string") return `attr:${c.attribute} ${ops}`.trim();
  // `{ status: x, present: false }` 是「身上没有这个状态」，别渲染成「需要这个状态」。
  if (typeof c.status === "string") return c.present === false ? `无状态 ${c.status}` : `状态 ${c.status}`;
  if (typeof c.inventory === "string") return `item:${c.inventory} gte ${String(c.gte)}`;
  if (typeof c.requiresSkill === "string") return `skill:${c.requiresSkill}`;
  if (typeof c.relation === "string") return `relation:${c.relation} ${ops}`.trim();
  if (typeof c.selfIs === "string") return `selfIs:${c.selfIs}`;
  if (typeof c.selfIsNot === "string") return `selfIsNot:${c.selfIsNot}`;
  if (typeof c.random === "number") return `random<${c.random}`;
  if (c.time) {
    const time = c.time as Record<string, { value?: number; unit?: string }>;
    const parts = ["gte", "lte", "gt", "lt"]
      .filter((k) => time[k] !== undefined)
      .map((k) => `${k === "gte" ? "≥" : k === "lte" ? "≤" : k === "gt" ? ">" : "<"}${String(time[k]!.value)}${TIME_UNIT[String(time[k]!.unit)] ?? String(time[k]!.unit)}`);
    return `世界时间 ${parts.join(" ")}`;
  }
  if (c.npcState) {
    const s = c.npcState as Record<string, unknown>;
    return `npcState ${String(s.npcId)}=${String(s.state)}`;
  }
  if (typeof c.type === "string") return `ext:${c.type} ${compact(c)}`;
  return compact(c);
}

function effectLine(effect: unknown, labels: Record<string, string> = {}): string {
  if (effect === null || typeof effect !== "object") return String(effect);
  const e = effect as Record<string, unknown>;
  const type = String(e.type ?? "?");
  const signed = (v: unknown) => (typeof v === "number" && v > 0 ? `+${v}` : String(v));
  switch (type) {
    case "setFlag":
      return `setFlag ${String(e.id)} = ${JSON.stringify(e.value)}`;
    case "adjustFlag":
      return `adjustFlag ${String(e.id)} ${signed(e.value)}`;
    case "clearFlag":
      return `clearFlag ${String(e.id)}`;
    case "adjustAttribute":
      return `attr ${labels[String(e.attribute)] ?? String(e.attribute)} ${signed(e.value)}`;
    case "adjustResource":
      return `${String(e.resource)} ${signed(e.value)}`;
    case "adjustMood":
      return `mood ${signed(e.value)}`;
    case "grantItem":
      return `grantItem ${String(e.itemId)} × ${String(e.count ?? 1)}`;
    case "removeItem":
      return `removeItem ${String(e.itemId)} × ${String(e.count ?? 1)}`;
    case "enqueueEvent":
      return `enqueueEvent ${String(e.eventId)}${e.delay ? ` after ${JSON.stringify(e.delay)}` : ""}`;
    case "adjustRelation": {
      if (typeof e.fromId === "string") {
        return `relation ${String(e.fromId)} → ${String(e.toId ?? "player")} (${String(e.kind ?? "?")}) ${signed(e.value)}`;
      }
      return `relation ${String(e.npcId ?? "?")} ${signed(e.value)}`;
    }
    case "addRelationEdge":
      return `edge ${String(e.fromId)} → ${String(e.toId)} (${String(e.kind)})`;
    case "applyStatus":
      return `applyStatus ${String(e.status)}${e.stacks ? ` ×${String(e.stacks)}` : ""}`;
    case "cureStatus":
      return `cureStatus ${String(e.status)}`;
    case "unlockSkill":
      return `unlockSkill ${String(e.skillId)}`;
    case "adjustProficiency":
      return `proficiency ${String(e.skillId)} ${signed(e.value)}`;
    case "adjustGrowth":
      return `growth ${signed(e.value)}`;
    case "setNpcLifecycle":
      return `lifecycle ${String(e.npcId)} → ${String(e.state)}${e.reasonCode ? ` (${String(e.reasonCode)})` : ""}`;
    case "setNpcVisibility":
      return `visibility ${String(e.npcId)} → ${String(e.visibility)}`;
    case "spawnNpc":
      return `spawnNpc rule ${String(e.ruleId)}`;
    case "addSecret":
      return `secret ${String(e.npcId)}: ${truncate(String(e.text ?? ""), 40)}`;
    case "advanceTo":
    case "advanceBy":
      return `${type} ${JSON.stringify(e.value)}`;
    case "startChain":
    case "advanceChain":
    case "cancelChain":
      return `${type} ${String(e.chainId)}`;
    case "setIdentity":
      return `setIdentity ${compact(e).replace(/^\{"type":"setIdentity",?/, "").replace(/\}$/, "")}`;
    case "log":
      return `log(${String(e.visibility ?? "public")}) ${truncate(String(e.text ?? ""), 40)}`;
    default:
      return `${type} ${truncate(compact(e), 100)}`;
  }
}

function renderTpl(ctx: Ctx, args: Args): void {
  const entry = pickTemplate(ctx, args);
  const orch = buildOrchestration(entry);
  const issues = diagnoseOrchestration(orch);

  if (args.json) {
    if (args.flag) {
      const flag = orch.flags.find((f) => f.id === args.flag);
      if (!flag) fail(`旗标不存在：${args.flag}`);
      console.log(JSON.stringify(flag, null, 2));
      return;
    }
    if (args.event) {
      const event = (orch.events as Array<{ id: string }>).find((e) => e.id === args.event);
      if (!event) fail(`事件不存在：${args.event}`);
      console.log(JSON.stringify(event, null, 2));
      return;
    }
    if (args.line) {
      const tree = buildLine(orch, args.line, { maxDepth: args.depth });
      if (!tree) fail(`事件不存在：${args.line}`);
      console.log(JSON.stringify(tree, null, 2));
      return;
    }
    if (args.npc) {
      const character = findCharacter(orch, args.npc);
      if (!character) fail(`角色不存在：${args.npc}（可用 --grep 搜名字）`);
      console.log(JSON.stringify(buildIdentityLine(orch, character.id), null, 2));
      return;
    }
    if (args.grep) {
      console.log(JSON.stringify(searchOrchestration(orch, args.grep, { limit: args.all ? 200 : 40 }), null, 2));
      return;
    }
    console.log(JSON.stringify({ ...orch, issues }, null, 2));
    return;
  }

  header(`${orch.template.id}@${orch.template.version} · ${orch.template.name}`);
  console.log(
    `  events ${orch.stats.eventCount}  edges ${orch.stats.edgeCount}  flags ${orch.stats.flagCount}  ` +
      `endings ${(orch.endings as unknown[]).length}  chains ${(orch.chains as unknown[]).length}  ` +
      `characters ${orch.characters.length}`,
  );

  if (args.flag) return renderFlag(orch, args.flag);
  if (args.event) return renderEvent(orch, args.event);
  if (args.line) return renderLine(orch, args.line, args);
  if (args.npc) return renderNpc(orch, args.npc, args);
  if (args.grep) return renderGrep(orch, args.grep, args);
  if (args.endings) return renderEndings(orch);

  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  const infos = issues.filter((i) => i.level === "info");
  header(`体检 · error ${errs.length} · warn ${warns.length} · info ${infos.length}`);
  const shown = args.all ? issues : [...errs, ...warns];
  for (const issue of shown.slice(0, 60)) console.log(issueLine(issue));
  if (shown.length > 60) console.log(`  … 另有 ${shown.length - 60} 条，加 --all 或 --json 看全量`);

  header("旗标读写 Top（按读取方数量）");
  const top = [...orch.flags]
    .sort((a, b) => b.readers.length - a.readers.length || b.writers.length - a.writers.length)
    .slice(0, 15);
  for (const f of top) {
    console.log(`  ${f.id.padEnd(24)} 写 ${String(f.writers.length).padStart(3)}  读 ${String(f.readers.length).padStart(3)}`);
  }
  console.log("\n查单个：--flag <id> / --event <id> / --line <eventId> / --npc <名|id> / --grep <词> / --endings");
}

function renderFlag(orch: AdminOrchestration, id: string): void {
  const flag = orch.flags.find((f) => f.id === id);
  if (!flag) {
    const near = orch.flags
      .filter((f) => f.id.toLowerCase().includes(id.toLowerCase()))
      .slice(0, 8)
      .map((f) => f.id);
    fail(`旗标不存在：${id}${near.length ? `\n相近：${near.join(", ")}` : ""}`);
  }
  header(`旗标 ${id}  · 写 ${flag.writers.length} / 读 ${flag.readers.length}`);
  if (flag.writers.length === 0) console.log("  ! 没有任何写入点 —— 依赖它的条件永远不会成立");
  for (const w of flag.writers) {
    const where = w.source === "opening" ? `${w.eventId}${w.optionId ? `.${w.optionId}` : ""}` : `${w.eventId}${w.optionId ? `.${w.optionId}` : ""}`;
    console.log(`  写  ${where}  ${w.how}`);
  }
  for (const r of flag.readers) {
    const where = r.eventId
      ? `${r.eventId}${r.optionId ? `.${r.optionId}` : ""}`
      : `${r.where}:${r.ref ?? "?"}`;
    console.log(`  读  ${where}  ${r.where}`);
  }
}

function renderEvent(orch: AdminOrchestration, id: string): void {
  const event = (orch.events as Array<Record<string, unknown>>).find((e) => e.id === id);
  if (!event) {
    const near = (orch.events as Array<Record<string, unknown>>)
      .filter((e) => String(e.id).toLowerCase().includes(id.toLowerCase()))
      .slice(0, 8)
      .map((e) => String(e.id));
    fail(`事件不存在：${id}${near.length ? `\n相近：${near.join(", ")}` : ""}`);
  }
  const trigger = (event.trigger ?? {}) as Record<string, unknown>;
  header(`事件 ${id} · ${String(event.kind)} · source ${String(trigger.source ?? "?")}`);
  console.log(`  ${truncate(String(event.title ?? ""), 100)}`);
  const conds = (trigger.conditions as unknown[]) ?? [];
  if (conds.length > 0) console.log(`  触发条件  ${conds.map(describeCondition).join(" AND ")}`);
  const miss = (trigger.missWhen as unknown[]) ?? [];
  if (miss.length > 0) console.log(`  失约条件  ${miss.map(describeCondition).join(" AND ")}`);
  const timing = ["cooldown", "delay", "window", "once", "probability", "weight", "timeCost"]
    .filter((k) => trigger[k] !== undefined)
    .map((k) => `${k}=${JSON.stringify(trigger[k])}`);
  if (timing.length > 0) console.log(`  时间      ${timing.join("  ")}`);

  const settle = (event.settle ?? {}) as Record<string, unknown>;
  const normal = settle.normal as Record<string, unknown> | undefined;
  const options = (normal?.options as Array<Record<string, unknown>>) ?? [];
  for (const option of options) {
    const visible = (option.visibleWhen as unknown[]) ?? [];
    console.log(
      `\n  选项 ${String(option.id)}  ${truncate(String(option.text ?? ""), 60)}` +
        `${option.nextEventId ? `  → ${String(option.nextEventId)}` : ""}`,
    );
    if (visible.length > 0) console.log(`    可见  ${visible.map(describeCondition).join(" AND ")}`);
    const effects = (option.effects as unknown[]) ?? [];
    for (const effect of effects) console.log(`    效果  ${effectLine(effect, orch.labels)}`);
  }

  const random = settle.random as Record<string, unknown> | undefined;
  const wheel = random?.wheel as Record<string, unknown> | undefined;
  if (wheel) {
    const segments = (wheel.segments as Array<Record<string, unknown>>) ?? [];
    for (const seg of segments) {
      console.log(`\n  转盘 ${truncate(String(seg.label ?? ""), 40)}${seg.nextEventId ? `  → ${String(seg.nextEventId)}` : ""}`);
      for (const effect of (seg.effects as unknown[]) ?? []) console.log(`    效果  ${effectLine(effect, orch.labels)}`);
    }
  }

  const combat = settle.combat as Record<string, unknown> | undefined;
  if (combat) {
    for (const key of ["onVictory", "onDefeat", "onFlee"]) {
      const outcome = combat[key] as Record<string, unknown> | undefined;
      if (!outcome) continue;
      console.log(`\n  ${key}${outcome.nextEventId ? `  → ${String(outcome.nextEventId)}` : ""}`);
      for (const effect of (outcome.effects as unknown[]) ?? []) console.log(`    效果  ${effectLine(effect, orch.labels)}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 命令：支线 / 角色线 / 搜索
 * ------------------------------------------------------------------ */

const NOTE_LABEL: Record<string, string> = {
  terminal: "线尾",
  cycle: "成环",
  missing: "断链",
  "depth-limit": "深度截断",
  repeat: "同上",
};

const SOURCE_TAG: Record<string, string> = {
  pool: "池",
  chain: "链",
  random: "随机",
  action: "行动",
  step: "剧本",
};

function renderLineNode(node: LineNode, prefix: string, isLast: boolean, isRoot: boolean): void {
  const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const tags: string[] = [];
  if (node.source && SOURCE_TAG[node.source]) tags.push(SOURCE_TAG[node.source]!);
  if (node.era !== undefined) tags.push(`era ${node.era}`);
  if (node.chapter !== undefined) tags.push(`ch ${node.chapter}`);
  if (node.note) tags.push(NOTE_LABEL[node.note] ?? node.note);
  console.log(
    `${prefix}${branch}${node.id}  ${truncate(node.title, 38)}${tags.length > 0 ? `  · ${tags.join(" · ")}` : ""}`,
  );

  const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");
  const detail = (text: string): void => console.log(`${childPrefix}· ${text}`);
  if (node.via) {
    const kind =
      node.via.kind === "option"
        ? "（选项）"
        : node.via.kind === "combat"
          ? "（战斗结果）"
          : node.via.kind === "wheel"
            ? "（转盘）"
            : "（入队）";
    detail(`线「${truncate(node.via.label, 46)}」${kind}`);
  }
  if (node.viaConditions && node.viaConditions.length > 0) {
    detail(`可见 ${node.viaConditions.map(describeCondition).join(" AND ")}`);
  }
  if (isRoot && node.conditions.length > 0) detail(`触发 ${node.conditions.map(describeCondition).join(" AND ")}`);
  if (node.flags.length > 0) detail(`⚑ 可写 ${node.flags.map((f) => f.flag).join(", ")}`);
  if (node.endings.length > 0) detail(`⇒ 这些旗标被结局读取：${node.endings.join(", ")}`);

  node.children.forEach((child, i) => renderLineNode(child, childPrefix, i === node.children.length - 1, false));
}

function renderLine(orch: AdminOrchestration, startId: string, args: Args): void {
  const tree = buildLine(orch, startId, { maxDepth: args.depth });
  if (!tree) {
    // 前缀即「线」：本仓库用 eventId 前缀表示一条剧情线（`ev-hv-*` 怀玉 / `ev-bs-*` 玉折…），
    // 设计稿 §8.5 的验收要求能「按前缀列出整条线并按 eventId 排序」。
    // 两种写法都认：`--line ev-hv`（带命名空间）与 `--line hv`（只给线名）。
    const bare = startId.replace(/^ev-/, "");
    const linePrefix = `ev-${bare}-`;
    const byPrefix = (orch.events as Array<Record<string, unknown>>)
      .filter((e) => {
        const id = String(e.id);
        return id.startsWith(linePrefix) || id.startsWith(startId);
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (byPrefix.length > 0) {
      header(`线 · ${startId}* · ${byPrefix.length} 个事件`);
      for (const raw of byPrefix) {
        const trigger = (raw.trigger ?? {}) as Record<string, unknown>;
        const source = String(trigger.source ?? raw.source ?? "-");
        console.log(`  ${String(raw.id).padEnd(16)} ${truncate(String(raw.title ?? ""), 34)}  · ${source}`);
      }
      console.log(`\n  展开某一幕的分支：inspect tpl --line <完整 eventId>（例：--line ${String(byPrefix[0]!.id)}）`);
      return;
    }

    const flag = orch.flags.find((f) => f.id === startId);
    const near = (orch.events as Array<Record<string, unknown>>)
      .filter((e) => String(e.id).toLowerCase().includes(startId.toLowerCase()))
      .slice(0, 6)
      .map((e) => String(e.id));
    // 开局的写入点不是事件，别把它当支线起点推荐给用户。
    const writerEvents = flag?.writers.map((w) => w.eventId).filter((id) => !id.startsWith("opening:")) ?? [];
    const hint = flag
      ? `\n「${startId}」是旗标，不是事件。写入它的事件：${writerEvents.join(", ") || "（只有开局写入）"}`
      : near.length > 0
        ? `\n相近事件：${near.join(", ")}`
        : "";
    fail(`事件不存在：${startId}${hint}`);
  }

  header(
    `支线 · ${startId} · ${tree.nodeCount} 个节点` +
      `${tree.truncated ? "（已截断，--depth / --all 放宽）" : ""}`,
  );
  renderLineNode(tree.root, "", true, true);
  if (tree.missing.length > 0) console.log(`\n  ! 断链：${[...new Set(tree.missing)].join(", ")} 不存在`);
  if (tree.notExpanded.length > 0) {
    console.log(`  … 另有 ${tree.notExpanded.length} 个后继未展开：${tree.notExpanded.slice(0, 8).join(", ")}`);
  }
  console.log(`\n  单看某节点：inspect tpl --event <id>    看同名前缀：inspect tpl --grep <词>`);
}

function renderNpc(orch: AdminOrchestration, query: string, args: Args): void {
  const character = findCharacter(orch, query);
  if (!character) {
    const near = orch.characters
      .filter((c) => c.name.includes(query) || c.id.includes(query))
      .slice(0, 8)
      .map((c) => `${c.id}=${c.name}`);
    const all = orch.characters.slice(0, 14).map((c) => c.name).join(" / ");
    fail(
      `角色不存在：${query}${near.length > 0 ? `\n相近：${near.join("  ")}` : `\n本模板角色：${all}${orch.characters.length > 14 ? " …" : ""}`}`,
    );
  }
  const line = buildIdentityLine(orch, character.id) as NpcLine;
  header(`角色线 · ${character.name} · ${character.id} · ${line.scenes.length} 个场景`);

  const bits = [character.isEnemy ? "敌人" : "友方"];
  if (character.gender) bits.push(character.gender);
  if (character.age !== undefined) bits.push(`${character.age} 岁`);
  if (character.visibility) bits.push(`visibility ${character.visibility}`);
  console.log(`  ${bits.join(" · ")}`);
  if (character.description) console.log(`  身份  ${truncate(character.description, 96)}`);
  if (character.relations.length > 0) {
    const rel = character.relations
      .map((r) => `${r.to} (${r.kind}${r.value !== undefined ? ` ${r.value}` : ""}${r.visibility ? `/${r.visibility}` : ""})`)
      .join("  ");
    console.log(`  初始关系  ${truncate(rel, 100)}`);
  }
  for (const spawn of line.spawns) {
    console.log(`  登场  ${spawn.eventId}  规则 ${spawn.ruleId}${spawn.age !== undefined ? ` · ${spawn.age} 岁登场` : ""}`);
  }
  for (const step of line.lifecycle) {
    console.log(`  生命  ${step.eventId}  → ${step.state}${step.reason ? `  (${step.reason})` : ""}`);
  }
  if (line.scenes.length === 0) {
    console.log("\n  这个角色在模板里没有任何戏份（也没被正文提到）。");
    return;
  }

  const groups = new Map<string, typeof line.scenes>();
  for (const scene of line.scenes) {
    // 只按事件自己声明的锚分组；链内事件几乎不写 era/chapter，硬推断会骗人。
    const key =
      scene.chapter !== undefined
        ? `第 ${scene.chapter} 章`
        : scene.era !== undefined
          ? `era ${scene.era}`
          : "链内 · 按模板顺序";
    const list = groups.get(key) ?? [];
    list.push(scene);
    groups.set(key, list);
  }
  for (const [key, scenes] of groups) {
    header(`${key} · ${scenes.length} 个场景`);
    for (const scene of scenes) {
      const ch = scene.chapter !== undefined ? ` ch${scene.chapter}` : "";
      console.log(`  ${scene.eventId}${ch}  ${truncate(scene.title, 32)}  [${scene.roles.join(" / ")}]`);
      // 转折旗标优先展示：它比「关系 +2」更能说明这场戏在整条线里的位置。
      const turn = scene.details.filter((d) => d.startsWith("⚑ "));
      const rest = scene.details.filter((d) => !d.startsWith("⚑ "));
      const shown = args.full ? rest : rest.slice(0, 2);
      for (const detail of shown) console.log(`      ${truncate(detail, 92)}`);
      if (!args.full && rest.length > shown.length) {
        console.log(`      … 另有 ${rest.length - shown.length} 条，加 --full`);
      }
      for (const detail of args.full ? turn : turn.slice(0, 2)) console.log(`      ${detail}`);
    }
  }
  console.log(`\n  看这一场的分支：inspect tpl --line <eventId>`);
}

function renderGrep(orch: AdminOrchestration, query: string, args: Args): void {
  const hits = searchOrchestration(orch, query, { limit: args.all ? 300 : 40 });
  header(`搜索「${query}」· ${hits.length} 个事件${hits.length >= 40 && !args.all ? "（已截断，--all 看更多）" : ""}`);
  if (hits.length === 0) {
    console.log("  没有命中。换个词，或先 inspect tpl 看旗标 Top。");
    return;
  }
  for (const hit of hits) {
    const era = hit.era !== undefined ? ` era ${hit.era}` : "";
    console.log(`  ${hit.eventId}${era}  ${truncate(hit.title, 34)}  [${hit.where.join(" · ")}]`);
    if (hit.snippet) console.log(`      ${truncate(hit.snippet, 96)}`);
  }
  console.log(`\n  展开一条：inspect tpl --line <eventId>`);
}

function renderEndings(orch: AdminOrchestration): void {
  header(`结局 · ${(orch.endings as unknown[]).length}`);
  for (const raw of orch.endings) {
    const e = raw as Record<string, unknown>;
    const id = String(e.endingId ?? e.id ?? "?");
    const conds = (e.triggerConditions as unknown[]) ?? [];
    const unlock = (e.unlockConditions as unknown[]) ?? [];
    console.log(
      `\n  ${id}  ${truncate(String(e.name ?? e.title ?? ""), 60)}` +
        `${e.endingType ? `  [${String(e.endingType)}]` : ""}${e.priority !== undefined ? `  priority ${String(e.priority)}` : ""}`,
    );
    console.log(`    触发  ${conds.length ? conds.map(describeCondition).join(" AND ") : "(无，恒可触发)"}`);
    if (unlock.length > 0) console.log(`    解锁  ${unlock.map(describeCondition).join(" AND ")}`);
  }
  const termination = orch.termination as Array<Record<string, unknown>>;
  if (termination.length > 0) {
    header(`终止条件 · ${termination.length}`);
    for (const raw of termination) {
      const t = raw as Record<string, unknown>;
      const params = (t.params ?? {}) as Record<string, unknown>;
      const conds = (params.conditions as unknown[]) ?? [];
      console.log(`  ${String(t.type ?? t.id ?? "?")}  ${conds.map(describeCondition).join(" AND ")}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 命令：trace
 * ------------------------------------------------------------------ */

function renderTrace(ctx: Ctx, args: Args): void {
  const world = pickWorld(ctx, args);
  if (!world.trace.exists) fail(`世界 ${world.id.slice(0, 8)} 没有 trace 文件`);
  const summary: TraceFileSummary = readTraceFile(world.id);

  if (args.json) {
    console.log(JSON.stringify({ world, ...summary }, null, 2));
    return;
  }

  header(`trace · ${world.id.slice(0, 8)} · ${world.playerName ?? "?"}`);
  if (!world.loadable) {
    console.log(`  ! 存档不可载：${truncate(world.unloadableDetail ?? world.unloadableReason ?? "原因未知", 110)}`);
    console.log(`    trace 仍然可读（它独立于存档，只按 turnIndex 追加）`);
  }
  console.log(
    `  ${world.templateId ?? "?"}@${world.templateVersion ?? "?"}  T${world.turnIndex ?? "?"}  ` +
      `${world.formattedTime ?? "-"}  ${world.status ?? "-"}`,
  );
  console.log(
    `  ${summary.entries.length} 条 / ${(summary.bytes / 1024).toFixed(1)} KB` +
      `${summary.skippedLines > 0 ? ` / ${summary.skippedLines} 行坏行` : ""}`,
  );
  const s = summary.stats;
  console.log(
    `  outcome  committed ${s.committed} (${pct(s.committed, summary.entries.length)}) · ` +
      `fallback ${s.fallback} · deferred ${s.deferred}`,
  );
  console.log(
    `  tokens   ${s.inputTokens} in / ${s.outputTokens} out   latency  avg ${s.avgLatencyMs}ms  p95 ${s.p95LatencyMs}ms  max ${s.maxLatencyMs}ms`,
  );
  if (s.tools.length > 0) console.log(`  tools    ${s.tools.map((t) => `${t.tool}×${t.count}`).join("  ")}`);
  if (s.diagnostics.length > 0) {
    console.log(`  诊断     ${s.diagnostics.map((d) => `${d.code}×${d.count}`).join("  ")}`);
  }
  if (s.fallbackCodes.length > 0) {
    console.log(`  回退码   ${s.fallbackCodes.map((d) => `${d.code}×${d.count}`).join("  ")}`);
  }

  if (summary.entries.length === 0) return;
  const latest = summary.entries.slice(-args.limit).reverse();
  header(`最近 ${latest.length} 条（新 → 旧）`);
  for (const entry of latest) {
    const blocks = entry.contentBlocks ?? [];
    const receipts = entry.receipts ?? [];
    const accepted = receipts.filter((r) => r.outcome === "accepted").length;
    console.log(
      `\n  T${String(entry.turnIndex).padEnd(5)} ${String(entry.reason ?? "?").padEnd(18)} ` +
        `${String(entry.outcome).padEnd(10)} ${String(entry.latencyMs ?? 0).padStart(5)}ms  ` +
        `calls ${(entry.calls ?? []).length}  receipts ${receipts.length} (accepted ${accepted})`,
    );
    console.log(`        ${entry.invocationId}`);
    if (entry.diagnostics && entry.diagnostics.length > 0) {
      console.log(`        诊断: ${entry.diagnostics.join(", ")}`);
    }
    for (const block of blocks.slice(0, args.full ? 99 : 2)) {
      const raw = block.text ?? "";
      const text = args.full ? raw : truncate(raw, 110);
      console.log(`        [${block.kind}/${block.visibility}] ${text.split("\n").join("\n        ")}`);
    }
    if (blocks.length > 2 && !args.full) console.log(`        … 共 ${blocks.length} 个正文块（--full 展开）`);
  }
  console.log(`\n完整 JSON：inspect trace ${world.id.slice(0, 8)} --json`);
}

/* ------------------------------------------------------------------ *
 * sim：战斗数值木桩
 * ------------------------------------------------------------------ */

/** `--dummy hp=500,power=10,speed=5` —— 逗号分隔的 `键=数值`，`hp` 直接定血条。 */
function parseDummy(spec: string): NonNullable<SimActorSpec["dummy"]> {
  const attributes: Record<string, number> = {};
  let hp: number | undefined;
  for (const part of spec.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim();
    if (!key || rawValue === undefined) fail(`--dummy 需要 键=数值：${part}`);
    const value = Number(rawValue);
    if (!Number.isFinite(value)) fail(`--dummy 的 ${key} 不是数字：${rawValue}`);
    if (key === "hp") hp = value;
    else attributes[key] = value;
  }
  return { hp, attributes };
}

function ratioPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * 战斗数值模拟：跑 N 局、打印均值。数字全部来自真实的 `performBattleAction`，
 * 不是另一套「模拟公式」——所以它能证明的正是玩家会遇到的。
 */
function renderSim(ctx: Ctx, args: Args): void {
  const entry = pickTemplate(ctx, args);
  const leftRef = args.as ?? args.positional[0];
  if (!leftRef) fail("sim 需要 --as <角色 id>（出战方，如 npc-gojo）");
  const dummy = args.dummy !== undefined ? parseDummy(args.dummy) : undefined;
  // 量哪套就带哪套（十影的英雄位只有一个，不指定的话量到的是「id 排第一的那只」）。
  const skills = args.skills !== undefined ? args.skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const rightRef = args.vs ?? args.positional[1];
  if (dummy === undefined && rightRef === undefined) {
    fail("sim 需要 --vs <角色 id> 或 --dummy hp=500,power=10,speed=5");
  }
  if (args.stance !== undefined && args.stance !== "damage" && args.stance !== "coverage") {
    fail(`--stance 只接受 damage | coverage：${args.stance}`);
  }

  const report = simulateDuel(entry.template, {
    left: { ref: leftRef, ...(skills !== undefined ? { skills } : {}) },
    right: dummy !== undefined ? { dummy } : { ref: rightRef! },
    repeat: args.repeat,
    seed: args.seed,
    maxRounds: args.maxRounds,
    stance: args.stance === "coverage" ? "coverage" : "damage",
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `\n${report.leftName}  vs  ${report.rightName}   ` +
      `（${entry.ref.id}@${entry.ref.version}，${report.duels} 局，seed ${args.seed}）\n`,
  );
  console.log(
    `胜负   胜 ${report.wins} / 负 ${report.losses} / 未决 ${report.undecided}` +
      `   胜率 ${ratioPct(report.winRate)}`,
  );
  console.log(`回合   平均 ${report.avgRounds.toFixed(1)}（上限 ${args.maxRounds}）`);
  console.log(`输出   每回合 ${report.dpr.toFixed(1)}   承伤 ${report.takenPerRound.toFixed(1)}`);
  console.log(`命中   ${ratioPct(report.hitRate)}（攻击性施放里有伤害落地）`);
  // 资源名归模板（`statusBar[].label`）：同一个仪表换一个世界，mp 可能叫「能量」。
  const mpLabel =
    entry.template.statusBar.find((s) => s.source === "resource" && s.key === "mp")?.label ?? "MP";
  console.log(`${mpLabel}   每局 ${report.mpSpentPerDuel.toFixed(0)}   收场血线 ${ratioPct(report.endHpRatio)}`);
  if (report.summonsPerDuel > 0) {
    console.log(`召唤   每局峰值 ${report.summonsPerDuel.toFixed(1)} 个在场`);
  }
  const uses = Object.entries(report.skillUse).sort((a, b) => b[1] - a[1]);
  if (uses.length > 0) {
    console.log(
      `技能   ${uses.map(([id, n]) => `${id} ${(n / report.duels).toFixed(1)}`).join(" · ")}`,
    );
  }
  // 木桩被打死 ⇒ 最后一击的溢出伤害没算进来，DPR 会偏低。量纯输出请把血条调大。
  if (dummy !== undefined && report.wins > 0) {
    console.log(`\n提示：木桩被打死了（${report.wins}/${report.duels} 局），DPR 只算到死为止；量纯输出请加大 hp。`);
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  quiet = args.verbose !== true;

  switch (args.command) {
    case "overview": {
      renderOverview(bootstrap(true), args);
      return;
    }
    case "check": {
      renderCheck(bootstrap(true), args);
      return;
    }
    case "tpl":
    case "template": {
      renderTpl(bootstrap(true), args);
      return;
    }
    case "trace": {
      renderTrace(bootstrap(true), args);
      return;
    }
    case "worlds": {
      const ctx = bootstrap(true);
      for (const w of ctx.worlds) {
        console.log(
          `${w.id}  ${w.playerName ?? "(不可载)"}  ${w.templateId ?? "-"}@${w.templateVersion ?? "-"}  ` +
            `T${w.turnIndex ?? "-"}  ${w.formattedTime ?? "-"}  trace ${w.trace.exists ? w.trace.entries : 0}` +
            `${w.loadable ? "" : `  ! ${w.unloadableDetail ?? w.unloadableReason ?? "unloadable"}`}`,
        );
      }
      return;
    }
    case "sim": {
      // 不需要世界：模拟只读模板（`--tpl` 显式给，或退到最高 ready 版本）。
      renderSim(bootstrap(false), args);
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      console.log(
        [
          "用法：inspect <command> [options]",
          "",
          "  (无)              概览：模板版本 + 体检 + 世界列表",
          "  check             只跑体检，有 error 时 exit 1",
          "  tpl               模板详情（默认当前存档版本）",
          "    --flag <id>     该旗标的写入 / 读取清单",
          "    --event <id>    该事件的触发 / 选项 / 效果",
          "    --line <id>     支线树（沿 nextEventId / 入队一路走到底）",
          "    --npc <名|id>   角色线：身份卡 + 登场/生死 + 参与的每一场",
          "    --grep <词>     搜事件（id / 标题 / 叙事 / 选项 / 角色名）",
          "    --endings       结局与终止条件",
          "  trace [worldId]   trace 时间线（默认最新存档）",
          "  sim               战斗数值模拟（打木桩 / 对打，打印均值）",
          "    --as <id>       出战方角色 id",
          "    --vs <id>       对手角色 id（与 --dummy 二选一）",
          "    --dummy hp=500,power=10,speed=5",
          "    --repeat N      局数（默认 100）  --max-rounds N（默认 30）  --seed N",
          "    --skills a,b,c   只带这几招（默认取角色卡上的整套）",
          "    --stance damage|coverage  挑招姿态：堆伤害（默认）/ 先走完召唤环",
          "  worlds            世界列表（原始 id，方便复制）",
          "",
          "通用：--json  --tpl id@version  --world id  --limit N  --depth N  --full  --all  --verbose",
        ].join("\n"),
      );
      return;
    }
    default:
      fail(`未知命令：${args.command}（try: inspect help）`);
  }
}

main();
