/**
 * Data layer. One interface, two drivers:
 *
 *  - SupabaseDb: the real thing — Postgres (dedicated "xor" schema) +
 *    Storage, always through the service-role key, server-side only.
 *  - MemoryDb: an in-process stand-in used when SUPABASE_URL /
 *    SUPABASE_SERVICE_ROLE_KEY are absent, so mock-mode demos and the test
 *    suite run with zero external services. Signed upload URLs point at the
 *    local /api/mock-upload route to keep the browser flow identical.
 *
 * The browser NEVER talks to Supabase directly except to PUT files via the
 * signed upload URLs issued here.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

import { DB_SCHEMA, bucket, cfg } from "./config";
import { istDateCompact } from "./util";
import {
  blankSessionData,
  type Msg,
  type SessionData,
  type SessionState,
  type Track,
} from "./widgets";

// ── row shapes ────────────────────────────────────────────────────────────
export interface SessionRow {
  id: string;
  state: SessionState;
  track: Track | null;
  data: SessionData;
}

export interface NewLead {
  lead_ref: string;
  session_id: string;
  track: string;
  company: string;
  contact_name: string;
  email: string;
  phone: string;
  summary: string;
  quantity: string;
  timeline: string;
  client_id: string | null;
  deal_id: string | null;
}

export interface LeadRow extends NewLead {
  id: string;
  drive_folder_id: string | null;
  drive_folder_url: string | null;
  drive_committed: boolean;
  sheet_appended: boolean;
  created_at?: string;
}

export interface ClientRow {
  id: string;
  client_code: string; // EB-C-YY-nnnn (issued by the Eb-Master Register)
  company: string;
  sector: string | null;
  org_size: string | null;
  contact_name: string | null;
  email: string | null; // stored lowercased
  phone: string | null;
  auth_user_id: string | null;
  drive_folder_id: string | null;
  drive_folder_url: string | null;
}

export interface LeadFileRow {
  session_id: string;
  lead_id: string | null;
  item_key: string;
  filename: string;
  storage_path: string;
  bytes: number | null;
  drive_file_id: string | null;
}

export type HandoffKind = "drive" | "sheet";

export interface HandoffRetryRow {
  id: number;
  lead_id: string;
  kind: HandoffKind;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  created_at: string;
  resolved_at: string | null;
}

export type TaskStatus = "running" | "completed" | "failed";

/**
 * One row of the visitor-visible "Background tasks" activity column on the
 * chat page: a pipeline step (ID issuance, register row, Drive workspace,
 * an upload) recorded as it runs, polled read-only per session.
 */
export interface TaskRow {
  id: string;
  session_id: string;
  label: string;
  detail: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface KbDocRow {
  id: string;
  drive_file_id: string;
  name: string;
  mime_type: string | null;
  source_folder: string | null;
  modified_at: string | null;
  synced_at: string | null;
  status: "active" | "removed";
}

export interface KbChunkInput {
  chunk_no: number;
  content: string;
  embedding: number[];
}

export interface KbMatch {
  content: string;
  document_name: string;
  similarity: number;
}

// ── the interface every caller codes against ──────────────────────────────
export interface Db {
  createSession(): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  saveSession(row: SessionRow): Promise<void>;
  /**
   * Atomic compare-and-swap on sessions.state. Returns false when the row is
   * no longer in fromState — the caller lost the race and must not proceed.
   */
  claimSession(id: string, fromState: SessionState, toState: SessionState): Promise<boolean>;

  addMessage(sessionId: string, role: Msg["role"], content: string): Promise<void>;
  recentMessages(sessionId: string, limit: number): Promise<Msg[]>;

  nextLeadRef(): Promise<string>;
  insertLead(lead: NewLead): Promise<LeadRow>;
  updateLead(id: string, patch: Partial<Omit<LeadRow, "id">>): Promise<void>;
  getLead(id: string): Promise<LeadRow | null>;

  // Clients (the PMS-consistent ClientID system)
  findClientByEmail(email: string): Promise<ClientRow | null>;
  findClientByAuthUserId(authUserId: string): Promise<ClientRow | null>;
  insertClient(client: Omit<ClientRow, "id">): Promise<ClientRow>;
  updateClient(id: string, patch: Partial<Omit<ClientRow, "id">>): Promise<void>;
  leadsForClient(clientId: string): Promise<LeadRow[]>;
  /** Atomic named sequence (client numbering, per-client deal numbering). */
  nextSeq(name: string): Promise<number>;

  insertLeadFile(file: LeadFileRow): Promise<void>;
  leadFiles(sessionId: string): Promise<LeadFileRow[]>;
  linkLeadFiles(sessionId: string, leadId: string): Promise<void>;

  insertHandoffRetry(
    leadId: string,
    kind: HandoffKind,
    payload: Record<string, unknown>,
    lastError: string | null,
    resolved?: boolean,
  ): Promise<void>;
  unresolvedHandoffRetries(): Promise<HandoffRetryRow[]>;
  recordHandoffAttempt(id: number, ok: boolean, error?: string): Promise<void>;

  // Settings — small key/value store (e.g. cached Google bindings)
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  // Background tasks (the activity column on the chat page)
  insertTask(
    sessionId: string,
    label: string,
    status?: TaskStatus,
    detail?: string | null,
  ): Promise<TaskRow>;
  updateTask(id: string, patch: Partial<Pick<TaskRow, "status" | "detail">>): Promise<void>;
  tasksForSession(sessionId: string): Promise<TaskRow[]>;

  // Storage (private bucket; paths "{session_id}/{item_key}--{filename}"
  // and "{session_id}/generated/{filename}")
  signedUploadUrl(path: string): Promise<{ url: string; token: string }>;
  statObject(path: string): Promise<{ bytes: number } | null>;
  putObject(path: string, data: Uint8Array, contentType: string): Promise<void>;
  getObject(path: string): Promise<Uint8Array | null>;

  // Knowledge base
  kbListDocuments(): Promise<KbDocRow[]>;
  kbUpsertDocument(doc: {
    drive_file_id: string;
    name: string;
    mime_type: string | null;
    source_folder: string | null;
    modified_at: string | null;
  }): Promise<KbDocRow>;
  kbSetStatus(driveFileIds: string[], status: "active" | "removed"): Promise<void>;
  /**
   * Marks a document successfully synced AND advances its modified_at in the
   * same update — bookkeeping must only move after chunks are replaced, so a
   * failed extraction stays eligible for retry on the next run.
   */
  kbSetSynced(documentId: string, modifiedAt: string | null): Promise<void>;
  kbReplaceChunks(documentId: string, chunks: KbChunkInput[]): Promise<void>;
  kbMatchChunks(embedding: number[], count: number, minSimilarity: number): Promise<KbMatch[]>;
}

// ── Supabase driver ───────────────────────────────────────────────────────
class SupabaseDb implements Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: SupabaseClient<any, any, any, any, any>;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      db: { schema: DB_SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private static check<T>(res: { data: T | null; error: { message: string } | null }): T {
    if (res.error) throw new Error(`supabase: ${res.error.message}`);
    return res.data as T;
  }

  async createSession(): Promise<SessionRow> {
    const data = blankSessionData();
    const row = SupabaseDb.check(
      await this.client
        .from("sessions")
        .insert({ state: "DISCOVER", track: null, data })
        .select("id, state, track, data")
        .single(),
    );
    return row as unknown as SessionRow;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("id, state, track, data")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`supabase: ${error.message}`);
    return data ? (data as unknown as SessionRow) : null;
  }

  async saveSession(row: SessionRow): Promise<void> {
    SupabaseDb.check(
      await this.client
        .from("sessions")
        .update({
          state: row.state,
          track: row.track,
          data: row.data,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .select("id"),
    );
  }

  async claimSession(
    id: string,
    fromState: SessionState,
    toState: SessionState,
  ): Promise<boolean> {
    const rows = SupabaseDb.check(
      await this.client
        .from("sessions")
        .update({ state: toState, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("state", fromState)
        .select("id"),
    ) as { id: string }[];
    return rows.length > 0;
  }

  async addMessage(sessionId: string, role: Msg["role"], content: string): Promise<void> {
    SupabaseDb.check(
      await this.client.from("messages").insert({ session_id: sessionId, role, content }),
    );
  }

  async recentMessages(sessionId: string, limit: number): Promise<Msg[]> {
    const rows = SupabaseDb.check(
      await this.client
        .from("messages")
        .select("role, content")
        .eq("session_id", sessionId)
        .order("id", { ascending: false })
        .limit(limit),
    ) as Msg[];
    return rows.reverse();
  }

  async nextLeadRef(): Promise<string> {
    const { data, error } = await this.client.rpc("next_lead_ref");
    if (error) throw new Error(`supabase rpc next_lead_ref: ${error.message}`);
    return data as string;
  }

  async insertLead(lead: NewLead): Promise<LeadRow> {
    return SupabaseDb.check(
      await this.client.from("leads").insert(lead).select("*").single(),
    ) as LeadRow;
  }

  async updateLead(id: string, patch: Partial<Omit<LeadRow, "id">>): Promise<void> {
    SupabaseDb.check(await this.client.from("leads").update(patch).eq("id", id).select("id"));
  }

  async getLead(id: string): Promise<LeadRow | null> {
    const { data, error } = await this.client.from("leads").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`supabase: ${error.message}`);
    return (data as LeadRow) ?? null;
  }

  async findClientByEmail(email: string): Promise<ClientRow | null> {
    const { data, error } = await this.client
      .from("clients")
      .select("*")
      .eq("email", email.trim().toLowerCase())
      .maybeSingle();
    if (error) throw new Error(`supabase: ${error.message}`);
    return data ? (data as unknown as ClientRow) : null;
  }

  async findClientByAuthUserId(authUserId: string): Promise<ClientRow | null> {
    const { data, error } = await this.client
      .from("clients")
      .select("*")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (error) throw new Error(`supabase: ${error.message}`);
    return data ? (data as unknown as ClientRow) : null;
  }

  async insertClient(client: Omit<ClientRow, "id">): Promise<ClientRow> {
    return SupabaseDb.check(
      await this.client
        .from("clients")
        .insert({ ...client, email: client.email?.trim().toLowerCase() ?? null })
        .select("*")
        .single(),
    ) as unknown as ClientRow;
  }

  async updateClient(id: string, patch: Partial<Omit<ClientRow, "id">>): Promise<void> {
    SupabaseDb.check(await this.client.from("clients").update(patch).eq("id", id).select("id"));
  }

  async leadsForClient(clientId: string): Promise<LeadRow[]> {
    return SupabaseDb.check(
      await this.client
        .from("leads")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
    ) as unknown as LeadRow[];
  }

  async nextSeq(name: string): Promise<number> {
    const { data, error } = await this.client.rpc("next_seq", { p_name: name });
    if (error) throw new Error(`supabase rpc next_seq: ${error.message}`);
    return data as number;
  }

  async insertLeadFile(file: LeadFileRow): Promise<void> {
    SupabaseDb.check(await this.client.from("lead_files").insert(file));
  }

  async leadFiles(sessionId: string): Promise<LeadFileRow[]> {
    return SupabaseDb.check(
      await this.client
        .from("lead_files")
        .select("session_id, lead_id, item_key, filename, storage_path, bytes, drive_file_id")
        .eq("session_id", sessionId)
        .order("id", { ascending: true }),
    ) as LeadFileRow[];
  }

  async linkLeadFiles(sessionId: string, leadId: string): Promise<void> {
    SupabaseDb.check(
      await this.client
        .from("lead_files")
        .update({ lead_id: leadId })
        .eq("session_id", sessionId)
        .is("lead_id", null),
    );
  }

  async insertHandoffRetry(
    leadId: string,
    kind: HandoffKind,
    payload: Record<string, unknown>,
    lastError: string | null,
    resolved = false,
  ): Promise<void> {
    SupabaseDb.check(
      await this.client.from("handoff_retries").insert({
        lead_id: leadId,
        kind,
        payload,
        last_error: lastError,
        resolved_at: resolved ? new Date().toISOString() : null,
      }),
    );
  }

  async unresolvedHandoffRetries(): Promise<HandoffRetryRow[]> {
    return SupabaseDb.check(
      await this.client
        .from("handoff_retries")
        .select("id, lead_id, kind, payload, attempts, last_error, created_at, resolved_at")
        .is("resolved_at", null)
        .order("id", { ascending: true }),
    ) as HandoffRetryRow[];
  }

  async recordHandoffAttempt(id: number, ok: boolean, error?: string): Promise<void> {
    const row = SupabaseDb.check(
      await this.client.from("handoff_retries").select("attempts").eq("id", id).single(),
    ) as { attempts: number };
    SupabaseDb.check(
      await this.client
        .from("handoff_retries")
        .update({
          attempts: row.attempts + 1,
          last_error: error ?? null,
          resolved_at: ok ? new Date().toISOString() : null,
        })
        .eq("id", id),
    );
  }

  async getSetting(key: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error(`supabase: ${error.message}`);
    return (data as { value: string } | null)?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    SupabaseDb.check(
      await this.client
        .from("settings")
        .upsert({ key, value, updated_at: new Date().toISOString() })
        .select("key"),
    );
  }

  async insertTask(
    sessionId: string,
    label: string,
    status: TaskStatus = "running",
    detail: string | null = null,
  ): Promise<TaskRow> {
    return SupabaseDb.check(
      await this.client
        .from("tasks")
        .insert({ session_id: sessionId, label, status, detail })
        .select("*")
        .single(),
    ) as unknown as TaskRow;
  }

  async updateTask(id: string, patch: Partial<Pick<TaskRow, "status" | "detail">>): Promise<void> {
    SupabaseDb.check(
      await this.client
        .from("tasks")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("id"),
    );
  }

  async tasksForSession(sessionId: string): Promise<TaskRow[]> {
    return SupabaseDb.check(
      await this.client
        .from("tasks")
        .select("*")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .limit(80),
    ) as unknown as TaskRow[];
  }

  async signedUploadUrl(path: string): Promise<{ url: string; token: string }> {
    // upsert so a retried upload (e.g. after a failed upload-complete) does
    // not 409 on the already-written object.
    const { data, error } = await this.client.storage
      .from(bucket())
      .createSignedUploadUrl(path, { upsert: true });
    if (error || !data) throw new Error(`storage signed url: ${error?.message}`);
    return { url: data.signedUrl, token: data.token };
  }

  async statObject(path: string): Promise<{ bytes: number } | null> {
    const dir = path.split("/").slice(0, -1).join("/");
    const name = path.split("/").pop()!;
    const { data, error } = await this.client.storage
      .from(bucket())
      .list(dir, { search: name });
    if (error) throw new Error(`storage list: ${error.message}`);
    const hit = (data ?? []).find((o) => o.name === name);
    if (!hit) return null;
    return { bytes: (hit.metadata as { size?: number } | null)?.size ?? 0 };
  }

  async putObject(path: string, data: Uint8Array, contentType: string): Promise<void> {
    const { error } = await this.client.storage
      .from(bucket())
      .upload(path, data, { contentType, upsert: true });
    if (error) throw new Error(`storage upload: ${error.message}`);
  }

  async getObject(path: string): Promise<Uint8Array | null> {
    const { data, error } = await this.client.storage.from(bucket()).download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }

  async kbListDocuments(): Promise<KbDocRow[]> {
    return SupabaseDb.check(
      await this.client.from("kb_documents").select("*").order("name"),
    ) as KbDocRow[];
  }

  async kbUpsertDocument(doc: {
    drive_file_id: string;
    name: string;
    mime_type: string | null;
    source_folder: string | null;
    modified_at: string | null;
  }): Promise<KbDocRow> {
    return SupabaseDb.check(
      await this.client
        .from("kb_documents")
        .upsert({ ...doc, status: "active" }, { onConflict: "drive_file_id" })
        .select("*")
        .single(),
    ) as KbDocRow;
  }

  async kbSetStatus(driveFileIds: string[], status: "active" | "removed"): Promise<void> {
    if (!driveFileIds.length) return;
    SupabaseDb.check(
      await this.client.from("kb_documents").update({ status }).in("drive_file_id", driveFileIds),
    );
  }

  async kbSetSynced(documentId: string, modifiedAt: string | null): Promise<void> {
    SupabaseDb.check(
      await this.client
        .from("kb_documents")
        .update({ synced_at: new Date().toISOString(), modified_at: modifiedAt })
        .eq("id", documentId),
    );
  }

  async kbReplaceChunks(documentId: string, chunks: KbChunkInput[]): Promise<void> {
    // Delete + insert must be atomic (a failure or a concurrent retrieval
    // between them would see a chunkless document) — done in one transaction
    // via the replace_kb_chunks SQL function.
    const { error } = await this.client.rpc("replace_kb_chunks", {
      p_document_id: documentId,
      p_chunks: chunks,
    });
    if (error) throw new Error(`supabase rpc replace_kb_chunks: ${error.message}`);
  }

  async kbMatchChunks(
    embedding: number[],
    count: number,
    minSimilarity: number,
  ): Promise<KbMatch[]> {
    const { data, error } = await this.client.rpc("match_kb_chunks", {
      query_embedding: embedding,
      match_count: count,
      min_similarity: minSimilarity,
    });
    if (error) throw new Error(`supabase rpc match_kb_chunks: ${error.message}`);
    return (data ?? []) as KbMatch[];
  }
}

// ── In-memory driver (mock/tests) ─────────────────────────────────────────
interface MemState {
  sessions: Map<string, SessionRow>;
  messages: Map<string, Msg[]>;
  leads: Map<string, LeadRow>;
  clients: Map<string, ClientRow>;
  leadFiles: LeadFileRow[];
  retries: HandoffRetryRow[];
  retrySeq: number;
  tasks: TaskRow[];
  settings: Map<string, string>;
  counters: Map<string, number>;
  objects: Map<string, { data: Uint8Array; contentType: string }>;
  uploadTokens: Map<string, string>; // token -> path
  kbDocs: Map<string, KbDocRow>; // by drive_file_id
  kbChunks: Map<string, KbChunkInput[]>; // by document id
}

function memState(): MemState {
  const g = globalThis as { __xorMemDb?: MemState };
  if (!g.__xorMemDb) {
    g.__xorMemDb = {
      sessions: new Map(),
      messages: new Map(),
      leads: new Map(),
      clients: new Map(),
      leadFiles: [],
      retries: [],
      retrySeq: 0,
      tasks: [],
      settings: new Map(),
      counters: new Map(),
      objects: new Map(),
      uploadTokens: new Map(),
      kbDocs: new Map(),
      kbChunks: new Map(),
    };
  }
  return g.__xorMemDb;
}

/** Test/demo hook: wipe all in-memory state. No-op for the Supabase driver. */
export function resetMemoryDb(): void {
  delete (globalThis as { __xorMemDb?: MemState }).__xorMemDb;
}

class MemoryDb implements Db {
  private get s(): MemState {
    return memState();
  }

  async createSession(): Promise<SessionRow> {
    const row: SessionRow = {
      id: randomUUID(),
      state: "DISCOVER",
      track: null,
      data: blankSessionData(),
    };
    this.s.sessions.set(row.id, row);
    return structuredClone(row);
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const row = this.s.sessions.get(id);
    return row ? structuredClone(row) : null;
  }

  async saveSession(row: SessionRow): Promise<void> {
    this.s.sessions.set(row.id, structuredClone(row));
  }

  async claimSession(
    id: string,
    fromState: SessionState,
    toState: SessionState,
  ): Promise<boolean> {
    const row = this.s.sessions.get(id);
    if (!row || row.state !== fromState) return false;
    row.state = toState;
    return true;
  }

  async addMessage(sessionId: string, role: Msg["role"], content: string): Promise<void> {
    const list = this.s.messages.get(sessionId) ?? [];
    list.push({ role, content });
    this.s.messages.set(sessionId, list);
  }

  async recentMessages(sessionId: string, limit: number): Promise<Msg[]> {
    return (this.s.messages.get(sessionId) ?? []).slice(-limit);
  }

  async nextLeadRef(): Promise<string> {
    const day = istDateCompact();
    const n = (this.s.counters.get(day) ?? 0) + 1;
    this.s.counters.set(day, n);
    return `XOR-${day}-${String(n).padStart(3, "0")}`;
  }

  async insertLead(lead: NewLead): Promise<LeadRow> {
    const row: LeadRow = {
      ...lead,
      id: randomUUID(),
      drive_folder_id: null,
      drive_folder_url: null,
      drive_committed: false,
      sheet_appended: false,
      created_at: new Date().toISOString(),
    };
    this.s.leads.set(row.id, row);
    return structuredClone(row);
  }

  async findClientByEmail(email: string): Promise<ClientRow | null> {
    const needle = email.trim().toLowerCase();
    for (const c of this.s.clients.values()) {
      if (c.email === needle) return structuredClone(c);
    }
    return null;
  }

  async findClientByAuthUserId(authUserId: string): Promise<ClientRow | null> {
    for (const c of this.s.clients.values()) {
      if (c.auth_user_id === authUserId) return structuredClone(c);
    }
    return null;
  }

  async insertClient(client: Omit<ClientRow, "id">): Promise<ClientRow> {
    const row: ClientRow = {
      ...client,
      id: randomUUID(),
      email: client.email?.trim().toLowerCase() ?? null,
    };
    this.s.clients.set(row.id, row);
    return structuredClone(row);
  }

  async updateClient(id: string, patch: Partial<Omit<ClientRow, "id">>): Promise<void> {
    const row = this.s.clients.get(id);
    if (!row) throw new Error(`memory db: no client ${id}`);
    Object.assign(row, patch);
  }

  async leadsForClient(clientId: string): Promise<LeadRow[]> {
    return structuredClone(
      [...this.s.leads.values()]
        .filter((l) => l.client_id === clientId)
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")),
    );
  }

  async nextSeq(name: string): Promise<number> {
    const n = (this.s.counters.get(`seq:${name}`) ?? 0) + 1;
    this.s.counters.set(`seq:${name}`, n);
    return n;
  }

  async updateLead(id: string, patch: Partial<Omit<LeadRow, "id">>): Promise<void> {
    const row = this.s.leads.get(id);
    if (!row) throw new Error(`memory db: no lead ${id}`);
    Object.assign(row, patch);
  }

  async getLead(id: string): Promise<LeadRow | null> {
    const row = this.s.leads.get(id);
    return row ? structuredClone(row) : null;
  }

  async insertLeadFile(file: LeadFileRow): Promise<void> {
    this.s.leadFiles.push(structuredClone(file));
  }

  async leadFiles(sessionId: string): Promise<LeadFileRow[]> {
    return structuredClone(this.s.leadFiles.filter((f) => f.session_id === sessionId));
  }

  async linkLeadFiles(sessionId: string, leadId: string): Promise<void> {
    for (const f of this.s.leadFiles) {
      if (f.session_id === sessionId && f.lead_id === null) f.lead_id = leadId;
    }
  }

  async insertHandoffRetry(
    leadId: string,
    kind: HandoffKind,
    payload: Record<string, unknown>,
    lastError: string | null,
    resolved = false,
  ): Promise<void> {
    this.s.retries.push({
      id: ++this.s.retrySeq,
      lead_id: leadId,
      kind,
      payload: structuredClone(payload),
      attempts: 0,
      last_error: lastError,
      created_at: new Date().toISOString(),
      resolved_at: resolved ? new Date().toISOString() : null,
    });
  }

  async unresolvedHandoffRetries(): Promise<HandoffRetryRow[]> {
    return structuredClone(this.s.retries.filter((r) => r.resolved_at === null));
  }

  async recordHandoffAttempt(id: number, ok: boolean, error?: string): Promise<void> {
    const row = this.s.retries.find((r) => r.id === id);
    if (!row) return;
    row.attempts += 1;
    row.last_error = error ?? null;
    row.resolved_at = ok ? new Date().toISOString() : null;
  }

  async getSetting(key: string): Promise<string | null> {
    return this.s.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.s.settings.set(key, value);
  }

  async insertTask(
    sessionId: string,
    label: string,
    status: TaskStatus = "running",
    detail: string | null = null,
  ): Promise<TaskRow> {
    const now = new Date().toISOString();
    const row: TaskRow = {
      id: randomUUID(),
      session_id: sessionId,
      label,
      detail,
      status,
      created_at: now,
      updated_at: now,
    };
    this.s.tasks.push(row);
    return structuredClone(row);
  }

  async updateTask(id: string, patch: Partial<Pick<TaskRow, "status" | "detail">>): Promise<void> {
    const t = this.s.tasks.find((x) => x.id === id);
    if (t) Object.assign(t, patch, { updated_at: new Date().toISOString() });
  }

  async tasksForSession(sessionId: string): Promise<TaskRow[]> {
    return structuredClone(this.s.tasks.filter((t) => t.session_id === sessionId).slice(-80));
  }

  async signedUploadUrl(path: string): Promise<{ url: string; token: string }> {
    const token = randomUUID();
    this.s.uploadTokens.set(token, path);
    return {
      url: `/api/mock-upload?token=${token}`,
      token,
    };
  }

  /** mock-upload route helper: resolve a token to its storage path. */
  consumeUploadToken(token: string): string | null {
    const path = this.s.uploadTokens.get(token) ?? null;
    if (path) this.s.uploadTokens.delete(token);
    return path;
  }

  async statObject(path: string): Promise<{ bytes: number } | null> {
    const obj = this.s.objects.get(path);
    return obj ? { bytes: obj.data.byteLength } : null;
  }

  async putObject(path: string, data: Uint8Array, contentType: string): Promise<void> {
    this.s.objects.set(path, { data: new Uint8Array(data), contentType });
  }

  async getObject(path: string): Promise<Uint8Array | null> {
    return this.s.objects.get(path)?.data ?? null;
  }

  async kbListDocuments(): Promise<KbDocRow[]> {
    return structuredClone([...this.s.kbDocs.values()]);
  }

  async kbUpsertDocument(doc: {
    drive_file_id: string;
    name: string;
    mime_type: string | null;
    source_folder: string | null;
    modified_at: string | null;
  }): Promise<KbDocRow> {
    const existing = this.s.kbDocs.get(doc.drive_file_id);
    const row: KbDocRow = {
      id: existing?.id ?? randomUUID(),
      synced_at: existing?.synced_at ?? null,
      status: "active",
      ...doc,
    };
    this.s.kbDocs.set(doc.drive_file_id, row);
    return structuredClone(row);
  }

  async kbSetStatus(driveFileIds: string[], status: "active" | "removed"): Promise<void> {
    for (const id of driveFileIds) {
      const row = this.s.kbDocs.get(id);
      if (row) row.status = status;
    }
  }

  async kbSetSynced(documentId: string, modifiedAt: string | null): Promise<void> {
    for (const row of this.s.kbDocs.values()) {
      if (row.id === documentId) {
        row.synced_at = new Date().toISOString();
        row.modified_at = modifiedAt;
      }
    }
  }

  async kbReplaceChunks(documentId: string, chunks: KbChunkInput[]): Promise<void> {
    this.s.kbChunks.set(documentId, structuredClone(chunks));
  }

  async kbMatchChunks(
    embedding: number[],
    count: number,
    minSimilarity: number,
  ): Promise<KbMatch[]> {
    const docsById = new Map([...this.s.kbDocs.values()].map((d) => [d.id, d]));
    const scored: KbMatch[] = [];
    for (const [docId, chunks] of this.s.kbChunks) {
      const doc = docsById.get(docId);
      if (!doc || doc.status !== "active") continue;
      for (const c of chunks) {
        const sim = cosine(embedding, c.embedding);
        if (sim > minSimilarity) {
          scored.push({ content: c.content, document_name: doc.name, similarity: sim });
        }
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, count);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── driver selection ──────────────────────────────────────────────────────
let supabaseDb: SupabaseDb | null = null;
const memoryDb = new MemoryDb();

export function usingMemoryDb(): boolean {
  return !(cfg.supabaseUrl && cfg.supabaseServiceRoleKey);
}

export function getDb(): Db {
  if (usingMemoryDb()) return memoryDb;
  if (!supabaseDb) supabaseDb = new SupabaseDb(cfg.supabaseUrl, cfg.supabaseServiceRoleKey);
  return supabaseDb;
}

/** Only meaningful for the memory driver (mock-upload route). */
export function getMemoryDb(): MemoryDb {
  return memoryDb;
}
