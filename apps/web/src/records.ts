import type { WorkBuddyDatabaseModule } from "@tencent-ai/workbuddy-cloud-sdk";
import type { V2Snapshot } from "./api";
import { cloud, logCloudFailure } from "./cloud";

/**
 * 人生档案 = **玩家已经看到的那份投影**上云（ADR-0025）。
 *
 * 红线（落库即违规）：只取 `V2Snapshot` 里玩家已可见的字段。**不写** hidden 结局原文、
 * `visibility: hidden` 的 NPC、未登场角色、`missedEvents`、`history` 的 hidden 条目、
 * 五维 `explanation` 长文案、模板原文，以及任何 token / 邮箱 / 手机号。
 *
 * 云端行只是展示副本：**永不回读进引擎**，也不进评分或任何权威路径。
 */

/** `public.life_records` 的读取形状（RLS 已限本人，前端不再按 owner_id 过滤）。 */
export interface LifeRecordRow {
  id: number;
  /** 只用于 UI 判断归属，**不是**安全边界（安全边界是 RLS） */
  owner_id: string;
  world_id: string;
  world_name: string;
  template_id: string;
  player_name: string;
  player_age: number | null;
  ending_label: string | null;
  ending_id: string | null;
  route: string | null;
  final_day: number | null;
  final_time: string | null;
  story_chapter: number | null;
  overall: number | null;
  dimensions: LifeRecordDimension[] | null;
  npc_count: number | null;
  status: "terminated" | "archived";
  created_at: string;
  updated_at: string | null;
}

/** 维度只留展示四件套：`explanation` 属于隐藏侧信道，**不入库**。 */
export interface LifeRecordDimension {
  id: string;
  label?: string;
  score: number;
  level: string;
}

/**
 * 上云行 —— **`owner_id` 被类型排除**。
 *
 * `owner_id TEXT NOT NULL DEFAULT auth.uid()` 由数据库填；显式发 `null` 会覆盖默认值
 * 并被 RLS 拒绝，显式发别人 id 更不可能成功。前端只负责「这一行是什么」。
 */
type LifeRecordWrite = Omit<LifeRecordRow, "id" | "created_at" | "owner_id">;

/**
 * 只给 PostgREST 构造器补上表形状的类型视图（**不新建客户端**：单例仍在 `cloud.ts`，
 * `createWorkBuddyCloud` 全仓只调一次）。有这层类型，「不发送 owner_id」就是编译期约束，
 * 而不是靠自觉。
 */
interface LifeRecordsSchema {
  public: {
    Tables: {
      life_records: {
        Row: LifeRecordRow;
        Insert: LifeRecordWrite;
        Update: Partial<LifeRecordWrite>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

const db = cloud.database as unknown as WorkBuddyDatabaseModule<LifeRecordsSchema>;


/**
 * 快照 → 云端行（字段映射是唯一取数口径，不得自行扩展）。
 *
 * 返回 `null` 表示**这一局不该上云**：只有 `terminated` / `archived` 且带结局的局才有档案。
 *
 * **不写 `owner_name`**：ADR-0025 决策 2 的字段表里没有它，UI 也从不渲染（云端列保留不用）。
 * 昵称属身份字段，能不落就不落（隐私最小化）。
 */
export function buildLifeRecordRow(snapshot: V2Snapshot): LifeRecordWrite | null {
  const status = snapshot.status;
  if (status !== "terminated" && status !== "archived") return null;
  const ending = snapshot.ending;
  if (!ending) return null;

  return {
    world_id: snapshot.worldId,
    template_id: snapshot.templateId,
    world_name: snapshot.worldName,
    player_name: snapshot.player.name,
    player_age: snapshot.player.age,
    // 投影后标题：hidden 结局已被服务端掩码，绝不回模板取原文。
    ending_label: ending.title,
    ending_id: ending.endingId,
    // 结局类型是模板自由字符串，不枚举。
    route: ending.endingType,
    // `worldTime` 单位是分钟、0 = 开局当天，与 QA 基线的 `day` 同口径。
    final_day: Math.max(0, Math.floor(snapshot.worldTime / 1440)),
    final_time: snapshot.formattedTime,
    // 缺省不猜：模板没用章节机时该字段不存在。
    story_chapter: snapshot.storyChapter ?? null,
    overall: snapshot.evaluation.overall ?? null,
    dimensions: (snapshot.evaluation.dimensions ?? []).map(({ id, label, score, level }) => ({
      id,
      label,
      score,
      level,
    })),
    npc_count: snapshot.npcs.length,
    status,
    updated_at: new Date().toISOString(),
  };
}

/** 失败文案（ADR-0025 验收口径 5）：每条失败面都要有一句能读的话。 */
function failureText(error: { code?: string; kind?: string } | null, status: number): string {
  const code = error?.code ?? "";
  // PostgREST / PostgreSQL 码优先：42501 常常伴随 HTTP 401 出现，先按码归因才不会被误判成域名不匹配。
  if (code === "42501") return "登录状态已失效，请重新登录。";
  if (code === "23505") return "该局档案已存在。";
  if (code === "42P10") return "档案表缺少唯一索引，请联系管理员。";
  if (error?.kind === "unauthenticated") return "登录状态已失效，请重新登录。";
  if (error?.kind === "credits-exhausted") return "云服务额度不足，档案暂不可用。";
  if (error?.kind === "network" || status === 0) return "网络异常，档案未保存，可重试。";
  if (status === 401) return "当前域名与云服务不匹配，请联系管理员。";
  return "档案操作失败，可稍后重试。";
}

export type SaveOutcome =
  | { status: "saved" }
  /** 这一局还没有结局（或未登录调用方误用），不算失败，不需要提示错误 */
  | { status: "skipped"; message: string }
  | { status: "error"; message: string };

export type DeleteOutcome = { status: "deleted" } | { status: "error"; message: string };

/**
 * 自动写档案的**触发判据**（纯函数，唯一真源）。
 *
 * 只有「本次挂载期内亲眼看到 `running → terminated|archived` 这一次跃迁」才写。
 * 三种「不是结局产生」的场景一律 false：
 *   ① 首次挂载就已是终态（含未登录打完一局后点登录、回跳整页重载）；
 *   ② 已登录刷新一个已终止的旧局；
 *   ③ 已登录从列表打开一个早已终止的旧局。
 * 这三种都是**补写**，ADR-0025 决策 8 要求改由玩家在档案页显式点「把这局存进档案」。
 *
 * `prev === undefined` 表示「这个 worldId 第一次见」⇒ 只记基线不落库。
 */
export function shouldAutoArchive(params: {
  /** 同一挂载期内上一次见到的 status；undefined = 首次见到这个 worldId */
  prev: string | undefined;
  /** 本次见到的 status（已按协议把缺省归一为 running） */
  status: string;
  hasEnding: boolean;
  signedIn: boolean;
}): boolean {
  if (!params.signedIn || !params.hasEnding) return false;
  if (params.status !== "terminated" && params.status !== "archived") return false;
  return params.prev === "running";
}

/**
 * 写档案（幂等）：唯一索引 `(owner_id, world_id)` + `upsert(onConflict)`。
 *
 * 刷新、重复调用、「已终止 → 已归档」都只留一行。**不加 `.eq('owner_id', …)`**：
 * RLS 已经限本人，前端过滤不是安全边界。
 *
 * 行构造也放在 `try` 内：快照结构异常（脏档、旧投影缺字段）会在这里同步抛出，
 * 必须落成一句「档案未保存」而不是冒出去打断游戏主链路。
 */
export async function saveLifeRecord(snapshot: V2Snapshot): Promise<SaveOutcome> {
  try {
    const row = buildLifeRecordRow(snapshot);
    if (!row) return { status: "skipped", message: "这一局还没有结局，暂时不能存进档案。" };

    const res = await db
      .from("life_records")
      .upsert(row, { onConflict: "owner_id,world_id" })
      .select();
    if (!res.error) return { status: "saved" };

    // 42P10 = ON CONFLICT 找不到匹配的唯一索引：退化为「先查后写」，幂等仍由唯一索引兜底。
    if (res.error.code === "42P10") {
      logCloudFailure("records:upsert-no-unique-index", { code: res.error.code, status: res.status });
      return await saveByLookup(row, res.status);
    }

    logCloudFailure("records:upsert", { code: res.error.code, status: res.status });
    return { status: "error", message: failureText(res.error, res.status) };
  } catch {
    logCloudFailure("records:upsert-throw", null);
    return { status: "error", message: "网络异常，档案未保存，可重试。" };
  }
}

/** upsert 不可用时的退化路径：有则 update、无则 insert（都在 RLS 之下）。 */
async function saveByLookup(row: LifeRecordWrite, upsertStatus: number): Promise<SaveOutcome> {
  try {
    const found = await db
      .from("life_records")
      .select("*")
      .eq("world_id", row.world_id)
      .maybeSingle();
    if (found.error) {
      logCloudFailure("records:lookup", { code: found.error.code, status: found.status });
      return { status: "error", message: failureText(found.error, found.status || upsertStatus) };
    }

    const existing = found.data as { id: number } | null;
    const written = existing
      ? await db.from("life_records").update(row).eq("id", existing.id).select()
      : await db.from("life_records").insert(row).select();

    if (written.error) {
      logCloudFailure("records:lookup-write", { code: written.error.code, status: written.status });
      return { status: "error", message: failureText(written.error, written.status) };
    }
    // 写操作的空结果 = RLS 挡下或行已不在，**不能当成功**。
    const rows = Array.isArray(written.data) ? written.data : [];
    if (rows.length === 0) return { status: "error", message: "未保存：档案不存在或无权修改。" };
    return { status: "saved" };
  } catch {
    logCloudFailure("records:lookup-throw", null);
    return { status: "error", message: "网络异常，档案未保存，可重试。" };
  }
}

/** 读档案列表：不加 `.eq('owner_id', …)`，RLS 已限本人。 */
export async function listLifeRecords(): Promise<{ rows: LifeRecordRow[] | null; error: string | null }> {
  try {
    const res = await db
      .from("life_records")
      .select("*")
      .order("created_at", { ascending: false });
    if (res.error) {
      logCloudFailure("records:list", { code: res.error.code, status: res.status });
      return { rows: null, error: failureText(res.error, res.status) };
    }
    return { rows: (res.data as LifeRecordRow[] | null) ?? [], error: null };
  } catch {
    logCloudFailure("records:list-throw", null);
    return { rows: null, error: "网络异常，档案读取失败，可重试。" };
  }
}

/** 删档案：`.select()` 报回真正被删掉的行，空结果必须提示，不得当成功。 */
export async function deleteLifeRecord(id: number): Promise<DeleteOutcome> {
  try {
    const res = await db.from("life_records").delete().eq("id", id).select();
    if (res.error) {
      logCloudFailure("records:delete", { code: res.error.code, status: res.status });
      return { status: "error", message: failureText(res.error, res.status) };
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) return { status: "error", message: "未删除：档案不存在或无权删除。" };
    return { status: "deleted" };
  } catch {
    logCloudFailure("records:delete-throw", null);
    return { status: "error", message: "网络异常，档案未删除，可重试。" };
  }
}
