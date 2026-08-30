/**
 * Shared API contract types — the ChatIn/ChatOut envelope and the widget
 * union rendered by the chat client. Keep in sync with components/Chat.tsx.
 */

export type Track = "ODM" | "EMS" | "PRODUCT";
export type TriageTrack = Track | "QUESTION" | "UNCLEAR";

export type SessionState =
  | "DISCOVER"
  | "TRACK_CONFIRM"
  | "CONTACT"
  | "CLIENT_INDUSTRY"
  | "CLIENT_ORGSIZE"
  | "ODM_SLOTS"
  | "ODM_REVIEW"
  | "ODM_LLD_REVIEW"
  | "EMS_CHECKLIST"
  | "EMS_DETAILS"
  | "PRODUCT_CATEGORY"
  | "PRODUCT_DETAILS"
  | "DONE";

export interface ChatIn {
  session_id?: string;
  kind: "open" | "text" | "chip" | "form";
  text?: string;
  chip_id?: string;
  form?: { form_id: string; values: Record<string, string> };
}

export interface ChatOut {
  session_id: string;
  messages: string[];
  widgets: Widget[];
  /**
   * Stored transcript, sent ONLY on an "open" of an existing session so a
   * reload re-renders the whole conversation instead of just the
   * re-presented prompt. Precedes `messages` chronologically.
   */
  history?: Msg[];
  meta: {
    state: SessionState;
    track: Track | null;
    progress: { done: number; total: number; label: string } | null;
  };
}

export interface FormField {
  key: string;
  label: string;
  input: "text" | "email" | "tel" | "textarea";
  required: boolean;
  placeholder: string;
  /** Prefilled value (e.g. the signed-in user's name/email) — editable. */
  value?: string;
}

export interface ChecklistItemDef {
  key: string;
  label: string;
  accept: string; // ".xlsx,.xls,.csv" or "*"
  required: boolean;
  desc: string;
}

export type ChecklistStatus = "uploaded" | "skipped" | "pending";

export type Widget =
  | { type: "chips"; options: { id: string; label: string }[] }
  | {
      type: "form";
      form_id: string;
      title: string;
      fields: FormField[];
      submit_label: string;
    }
  | { type: "upload"; item: ChecklistItemDef; allow_skip: true }
  | {
      type: "checklist";
      title: string;
      items: { key: string; label: string; status: ChecklistStatus; required: boolean }[];
    }
  | { type: "card"; title: string; body: string; links: { label: string; url: string }[] };

/** Conversation message used as LLM context. */
export interface Msg {
  role: "user" | "assistant";
  content: string;
}

/** Everything mutable the orchestrator keeps on a session (sessions.data jsonb). */
export interface SessionData {
  proposed_track: TriageTrack | null;
  probe_turns: number;
  entities: Record<string, string>;
  contact: Record<string, string>;
  slots: Record<string, string>;
  expected_slot: string | null;
  checklist: Record<string, { status: "uploaded" | "skipped"; filename?: string }>;
  ems_details: Record<string, string>;
  product: Record<string, string>;
  lead_ref: string | null; // XOR-YYYYMMDD-NNN (internal funnel key)
  lead_id: string | null; // leads.id uuid
  deal_id: string | null; // EB-D-YY-nnnn-ss — the client-facing ref
  client_id: string | null; // xor.clients.id once resolved
  client_code: string | null; // EB-C-YY-nnnn — reused for returning clients
  sector: string | null; // register Lists sector (new clients)
  org_size: string | null; // register Lists org size (new clients)
  auth_user_id: string | null; // verified login attached to this session
  auth_email: string | null; // verified email of that login
  auth_name?: string | null; // display name of that login
  sales_agent?: string | null; // Elecbits contact chosen at signup
  lld_file: string | null; // filename served for download
  lld_path: string | null; // storage path of the generated LLD
  drive: { folder_id?: string; folder_url?: string };
  finalized: boolean;
}

export function blankSessionData(): SessionData {
  return {
    proposed_track: null,
    probe_turns: 0,
    entities: {},
    contact: {},
    slots: {},
    expected_slot: null,
    checklist: {},
    ems_details: {},
    product: {},
    lead_ref: null,
    lead_id: null,
    deal_id: null,
    client_id: null,
    client_code: null,
    sector: null,
    org_size: null,
    auth_user_id: null,
    auth_email: null,
    lld_file: null,
    lld_path: null,
    drive: {},
    finalized: false,
  };
}
