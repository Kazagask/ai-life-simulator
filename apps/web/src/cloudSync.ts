import type { WorkBuddyDatabaseModule } from "@tencent-ai/workbuddy-cloud-sdk";
import { sha256Hex, stableStringify, WORLD_SCHEMA_VERSION, type WorldStateV2 } from "@life-sim/shared";
import { cloud, publicConfig } from "./cloud";
import type { SaveStatus, CloudSaveSummary } from "./local/saveList";
import type { LocalWorldRecord } from "./local/worldRepo";

/**
 * 本地优先 · 云端同步（ADR-071）。
 *
 * 分工（2026-11-22 用户裁决）：
 * - **模板** → Postgres `templates`（整包 jsonb；`publish_template` 做信封校验与原子 upsert）。
 * - **存档** → Postgres `world_saves.payload jsonb`（与索引同一行、同一事务；S3 只留给资源）。
 * - **trace** → Postgres `trace_events`（`save_id` + `save_sha256` 锚到具体那一版存档）。
 *
 * 三条硬约束：
 * 1. **本地永远先写、永远是权威**：这里全是后台尽力而为；失败只返回 null，绝不阻断玩。
 * 2. **用户没开「云端自动同步」就不发**（`syncPrefs.ts`）：手动上传是显式动作，另算。
 * 3. **未登录 / 非发布域不同步**：RLS 与数据面都要求会话。
 */

/** 数据面只在发布域可用（精确匹配 `endpoint`）。 */
export function isSyncOrigin(origin: string, endpoint: string = publicConfig.endpoint): boolean {
  try {
    return new URL(origin).origin === new URL(endpoint).origin;
  } catch {
    return false;
  }
}

// ---------- 表形状（只给 PostgREST 构造器补类型视图；不新建客户端） ----------

interface TemplateRow {
  id: number;
  owner_id: string;
  template_id: string;
  template_version: string;
  fingerprint: string;
  protocol_version: number;
  visibility: "public" | "private";
  payload: TemplatePackageLike | null;
  payload_key: string | null;
  payload_sha256: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

interface WorldSaveRow {
  id: number;
  owner_id: string;
  world_id: string;
  template_id: string;
  template_version: string;
  template_fingerprint: string;
  protocol_version: number;
  saved_at: string;
  turn_index: number;
  status: string;
  visibility: "public" | "private";
  world_name: string;
  player_name: string;
  payload: WorldStateV2;
  payload_sha256: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

interface TraceEventRow {
  id: number;
  owner_id: string;
  world_id: string;
  save_id: number | null;
  save_sha256: string | null;
  turn_index: number;
  invocation_id: string;
  visibility: "public" | "private";
  trace: unknown;
  trace_sha256: string | null;
  attempted_at: string;
}

/** Insert 明确不含 `owner_id`：列上有 `DEFAULT auth.uid()`，手传会被 RLS 拒。 */
type TemplateInsert = Omit<TemplateRow, "id" | "owner_id" | "created_at" | "updated_at">;
type SaveInsert = Omit<WorldSaveRow, "id" | "owner_id" | "created_at" | "updated_at"> & {
  updated_at?: string;
};
type TraceInsert = Omit<TraceEventRow, "id" | "owner_id" | "attempted_at">;

interface CloudSyncSchema {
  public: {
    Tables: {
      templates: {
        Row: TemplateRow;
        Insert: TemplateInsert;
        Update: Partial<TemplateRow>;
        Relationships: [];
      };
      world_saves: {
        Row: WorldSaveRow;
        Insert: SaveInsert;
        Update: Partial<WorldSaveRow>;
        Relationships: [];
      };
      trace_events: {
        Row: TraceEventRow;
        Insert: TraceInsert;
        Update: Partial<TraceEventRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      publish_template: {
        Args: {
          p_template_id: string;
          p_template_version: string;
          p_fingerprint: string;
          p_payload: Record<string, unknown>;
          p_payload_sha256: string;
          p_protocol_version?: number;
          p_visibility?: "public" | "private";
        };
        Returns: TemplateRow;
      };
    };
  };
}

const db = cloud.database as unknown as WorkBuddyDatabaseModule<CloudSyncSchema>;

// ---------- 行构造（纯函数，可单测） ----------

export interface SaveRowInput {
  worldId: string;
  templateId: string;
  templateVersion: string;
  fingerprint: string;
  protocolVersion: number;
  savedAt: string;
  turnIndex: number;
  status: SaveStatus;
  worldName: string;
  playerName: string;
  payload: WorldStateV2;
  payloadSha256: string;
  sizeBytes: number;
  updatedAt: string;
}

/** 存档行：**不含 owner_id**（数据库默认 `auth.uid()`）。 */
export function toSaveRow(input: SaveRowInput): SaveInsert {
  return {
    world_id: input.worldId,
    template_id: input.templateId,
    template_version: input.templateVersion,
    template_fingerprint: input.fingerprint,
    protocol_version: input.protocolVersion,
    saved_at: input.savedAt,
    turn_index: input.turnIndex,
    status: input.status,
    visibility: "private",
    world_name: input.worldName,
    player_name: input.playerName,
    payload: input.payload,
    payload_sha256: input.payloadSha256,
    size_bytes: input.sizeBytes,
    updated_at: input.updatedAt,
  };
}

export interface TemplatePackageLike {
  templateId: string;
  version: string;
  fingerprint: string;
  files: Record<string, string>;
}

/** 模板行：整包一格，`files` 不拆表；`payload_sha256` 是传输完整性，指纹是身份。 */
export function toTemplateRow(pkg: TemplatePackageLike): TemplateInsert {
  const body = stableStringify(pkg);
  return {
    template_id: pkg.templateId,
    template_version: pkg.version,
    fingerprint: pkg.fingerprint,
    protocol_version: WORLD_SCHEMA_VERSION,
    visibility: "private",
    payload: pkg,
    payload_key: null,
    payload_sha256: sha256Hex(body),
    size_bytes: new TextEncoder().encode(body).length,
  };
}

export function toTraceRow(input: {
  worldId: string;
  turnIndex: number;
  invocationId: string;
  trace: unknown;
  saveId?: number;
  saveSha256?: string;
}): TraceInsert {
  return {
    world_id: input.worldId,
    // 关联到"这条 trace 产出的那一版存档"。没有存档（LLM 失败 / 还没写档）就留 null。
    save_id: input.saveId ?? null,
    save_sha256: input.saveSha256 ?? null,
    turn_index: input.turnIndex,
    invocation_id: input.invocationId,
    visibility: "private",
    trace: input.trace,
    trace_sha256: sha256Hex(stableStringify(input.trace)),
  };
}

// ---------- 串行上行队列 ----------

/**
 * 同一个键（worldId / templateId）只保留**最后一条**：玩家连点几下时不必把每一帧都传上去，
 * 但也不能丢「最后一次」，否则云端会停在中途状态。
 */
export function createSyncQueue<Item>(
  send: (item: Item) => Promise<boolean>,
  keyOf: (item: Item) => string,
): { push(item: Item): void; idle(): Promise<void>; pending(): number } {
  const latest = new Map<string, Item>();
  let running = false;
  let scheduled = false;

  const drain = async (): Promise<void> => {
    scheduled = false;
    if (running) return;
    running = true;
    try {
      while (latest.size > 0) {
        const entry = latest.entries().next().value as [string, Item] | undefined;
        if (entry === undefined) break;
        latest.delete(entry[0]);
        try {
          await send(entry[1]);
        } catch {
          // 失败不重排：下一次写档会带更新状态再来。
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    push(item) {
      latest.set(keyOf(item), item);
      // 推迟到下一个 tick：同一帧里连推几条时，只发最后一条（玩家连点时不必逐帧上传）。
      if (scheduled || running) return;
      scheduled = true;
      setTimeout(() => void drain(), 0);
    },
    async idle() {
      while (running || latest.size > 0) await new Promise((resolve) => setTimeout(resolve, 20));
    },
    pending: () => latest.size,
  };
}

// ---------- 门面 ----------

async function currentUserId(): Promise<string | null> {
  const { data } = await cloud.auth.getSession();
  return data?.user?.id ?? null;
}

/** 当前是否具备同步条件（发布域 + 已登录）。 */
export async function syncAvailability(): Promise<"ok" | "origin" | "signed-out"> {
  if (!isSyncOrigin(window.location.origin)) return "origin";
  const { data } = await cloud.auth.getSession();
  return data === null ? "signed-out" : "ok";
}

export interface PushSaveResult {
  saveId: number;
  turnIndex: number;
  savedAt: string;
  sha256: string;
}

export const cloudSync = {
  /** 模板包上行：`publish_template` 做信封校验 + 原子 upsert（同版本覆盖）。 */
  async pushTemplate(pkg: TemplatePackageLike): Promise<boolean> {
    const { error } = await db.rpc("publish_template", {
      p_template_id: pkg.templateId,
      p_template_version: pkg.version,
      p_fingerprint: pkg.fingerprint,
      p_payload: pkg as unknown as Record<string, unknown>,
      p_payload_sha256: sha256Hex(stableStringify(pkg)),
    });
    return error === null;
  },

  /** 取回某个模板版本（换设备 / 本地缓存被清时用）。 */
  async pullTemplate(templateId: string, version?: string): Promise<TemplatePackageLike | null> {
    const base = db.from("templates").select("payload").eq("template_id", templateId);
    const query = version === undefined ? base : base.eq("template_version", version);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(1);
    if (error !== null || !Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as unknown as Pick<TemplateRow, "payload">;
    return row.payload;
  },

  /**
   * 存档上行：正文进 `payload`（与索引同一行、同一事务）。
   *
   * 返回 `saveId` 与 `sha256`：trace 上报要用它们锚到"这一版存档"。
   * 失败返回 null —— 本地已经落库，云端只是副本。
   */
  async pushSave(record: LocalWorldRecord, status: SaveStatus, worldName: string): Promise<PushSaveResult | null> {
    if ((await currentUserId()) === null) return null;
    // 哈希口径：**规范化 JSON**，不是 HTTP 字节（jsonb 会重排键、规范化数字）。
    const body = stableStringify(record.state);
    const payload = JSON.parse(body) as WorldStateV2;
    const digest = sha256Hex(body);
    const { data, error } = await db
      .from("world_saves")
      .upsert(
        toSaveRow({
          worldId: record.id,
          templateId: record.ref.id,
          templateVersion: record.ref.version,
          fingerprint: record.fingerprint,
          protocolVersion: WORLD_SCHEMA_VERSION,
          savedAt: record.savedAt,
          turnIndex: record.state.turnIndex,
          status,
          worldName,
          playerName: record.state.player.name,
          payload,
          payloadSha256: digest,
          sizeBytes: new TextEncoder().encode(body).length,
          updatedAt: new Date().toISOString(),
        }),
        { onConflict: "owner_id,world_id" },
      )
      .select("id")
      .single();
    if (error !== null || data === null) return null;
    return {
      saveId: (data as unknown as Pick<WorldSaveRow, "id">).id,
      turnIndex: record.state.turnIndex,
      savedAt: record.savedAt,
      sha256: digest,
    };
  },

  /** 云端存档索引（**不下载 payload**；列表只需要一等字段）。 */
  async listSaves(): Promise<CloudSaveSummary[]> {
    const userId = await currentUserId();
    if (userId === null) return [];
    const { data, error } = await db
      .from("world_saves")
      .select(
        "world_id, template_id, template_version, template_fingerprint, turn_index, saved_at, status, world_name, player_name, size_bytes, updated_at",
      )
      // 档案页是「我的存档」：public 行是分享用途，不能混进这里（否则别人的档会显示成你的）。
      .eq("owner_id", userId)
      .order("saved_at", { ascending: false });
    if (error !== null || !Array.isArray(data)) return [];
    return (
      data as unknown as Array<
        Pick<
          WorldSaveRow,
          | "world_id"
          | "template_id"
          | "template_version"
          | "template_fingerprint"
          | "turn_index"
          | "saved_at"
          | "status"
          | "world_name"
          | "player_name"
          | "size_bytes"
          | "updated_at"
        >
      >
    ).map((row) => ({
      worldId: row.world_id,
      templateId: row.template_id,
      templateVersion: row.template_version,
      fingerprint: row.template_fingerprint,
      turnIndex: row.turn_index,
      savedAt: row.saved_at,
      status: row.status as SaveStatus,
      worldName: row.world_name ?? "",
      playerName: row.player_name ?? "",
      sizeBytes: row.size_bytes,
      updatedAt: row.updated_at,
    }));
  },

  /** 取回某个世界的云存档正文（换设备时接续）。 */
  async pullSave(worldId: string): Promise<LocalWorldRecord | null> {
    const userId = await currentUserId();
    if (userId === null) return null;
    const { data, error } = await db
      .from("world_saves")
      .select("*")
      .eq("owner_id", userId)
      .eq("world_id", worldId)
      .maybeSingle();
    if (error !== null || data === null) return null;
    const row = data as unknown as WorldSaveRow;
    if (typeof row.payload !== "object" || row.payload === null) return null;
    return {
      id: row.world_id,
      formatVersion: 1,
      savedAt: row.saved_at,
      ref: { id: row.template_id, version: row.template_version },
      fingerprint: row.template_fingerprint,
      state: row.payload,
      syncedAt: row.updated_at,
    };
  },

  /** 删除云存档（只删云端副本，本地不动）。 */
  async deleteSave(worldId: string): Promise<boolean> {
    const { error } = await db.from("world_saves").delete().eq("world_id", worldId);
    return error === null;
  },

  /** trace 上报（invocation 级幂等：重复上报撞唯一键，忽略即可）。 */
  async pushTrace(input: {
    worldId: string;
    turnIndex: number;
    invocationId: string;
    trace: unknown;
    saveId?: number;
    saveSha256?: string;
  }): Promise<boolean> {
    const { error } = await db.from("trace_events").insert(toTraceRow(input));
    if (error === null) return true;
    return (error as { code?: string }).code === "23505";
  },
};
