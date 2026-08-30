"use client";

/**
 * Widget renderers for the chat client — React port of the widget() family in
 * reference/web/index.html. Each maps one member of the Widget union to DOM;
 * <Chat/> owns transport, freezing, and the upload flow.
 */

import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { ChecklistItemDef, Widget } from "@/lib/widgets";

type ChipsWidget = Extract<Widget, { type: "chips" }>;
type FormWidget = Extract<Widget, { type: "form" }>;
type UploadWidget = Extract<Widget, { type: "upload" }>;
type ChecklistWidget = Extract<Widget, { type: "checklist" }>;
type CardWidget = Extract<Widget, { type: "card" }>;

export interface WidgetHandlers {
  busy: boolean;
  onChip: (chipId: string) => void;
  onForm: (formId: string, values: Record<string, string>, summary: string) => void;
  onSkip: (itemKey: string) => void;
  onFile: (item: ChecklistItemDef, file: File) => Promise<void>;
}

export function WidgetView({ w, h }: { w: Widget; h: WidgetHandlers }) {
  switch (w.type) {
    case "chips":
      return <ChipsW w={w} busy={h.busy} onPick={h.onChip} />;
    case "form":
      return <FormW w={w} busy={h.busy} onSubmit={h.onForm} />;
    case "upload":
      return <UploadW w={w} busy={h.busy} onFile={h.onFile} onSkip={h.onSkip} />;
    case "checklist":
      return <ChecklistW w={w} />;
    case "card":
      return <CardW w={w} />;
    default:
      return null;
  }
}

// ── chips ─────────────────────────────────────────────────────────────────
export function ChipsW({
  w,
  busy,
  onPick,
}: {
  w: ChipsWidget;
  busy: boolean;
  onPick: (chipId: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="chips">
      {w.options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`chip${picked === o.id ? " picked" : ""}`}
          onClick={() => {
            if (busy || picked !== null) return;
            setPicked(o.id);
            onPick(o.id);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── form ──────────────────────────────────────────────────────────────────
export function FormW({
  w,
  busy,
  onSubmit,
}: {
  w: FormWidget;
  busy: boolean;
  onSubmit: (formId: string, values: Record<string, string>, summary: string) => void;
}) {
  const uid = useId();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of w.fields) if (f.value) seed[f.key] = f.value;
    return seed;
  });

  const set = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  const submit = () => {
    if (busy) return;
    const out: Record<string, string> = {};
    for (const f of w.fields) out[f.key] = values[f.key] ?? "";
    const summary =
      w.fields
        .map((f) => out[f.key])
        .filter(Boolean)
        .join(" · ") || "(submitted)";
    onSubmit(w.form_id, out, summary);
  };

  return (
    <div className="wform">
      <h4>{w.title}</h4>
      {w.fields.map((f) => {
        const id = `${uid}-${f.key}`;
        return (
          <div className="field" key={f.key}>
            <label htmlFor={id}>
              {f.label}
              {f.required ? " *" : ""}
            </label>
            {f.input === "textarea" ? (
              <textarea
                id={id}
                placeholder={f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
              />
            ) : (
              <input
                id={id}
                type={f.input}
                placeholder={f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
      <button type="button" className="btn" onClick={submit}>
        {w.submit_label || "Continue"}
      </button>
    </div>
  );
}

// ── upload dropzone ───────────────────────────────────────────────────────
export function UploadW({
  w,
  busy,
  onFile,
  onSkip,
}: {
  w: UploadWidget;
  busy: boolean;
  onFile: (item: ChecklistItemDef, file: File) => Promise<void>;
  onSkip: (itemKey: string) => void;
}) {
  const item = w.item;
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (busy || uploading) return;
    setUploading(file.name);
    try {
      await onFile(item, file);
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const browse = () => {
    if (!busy && !uploading) fileRef.current?.click();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // let the skip button handle its own keys
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      browse();
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const skip = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (busy || uploading) return;
    onSkip(item.key);
  };

  return (
    <div
      className={`drop${over ? " over" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Upload ${item.label} — press Enter to browse`}
      onClick={browse}
      onKeyDown={onKey}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <b>Upload: {item.label}</b>
      <div className="hint">{item.accept !== "*" ? `Accepted: ${item.accept}` : "Any file type"}</div>
      {item.desc && <div className="hint">{item.desc}</div>}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept={item.accept !== "*" ? item.accept : undefined}
        onChange={onChange}
        tabIndex={-1}
        aria-hidden="true"
      />
      {uploading && <div className="busy">Uploading {uploading}…</div>}
      {w.allow_skip && !uploading && (
        <div className="skip">
          <button type="button" onClick={skip}>
            skip this — I don&apos;t have it yet
          </button>
        </div>
      )}
    </div>
  );
}

// ── checklist ─────────────────────────────────────────────────────────────
export function ChecklistW({ w }: { w: ChecklistWidget }) {
  return (
    <div className="check">
      <h4>{w.title || "Checklist"}</h4>
      {w.items.map((it) => {
        const icon = it.status === "uploaded" ? "✓" : it.status === "skipped" ? "–" : "○";
        const cls = it.status === "uploaded" ? "up" : it.status === "skipped" ? "sk" : "pd";
        return (
          <div className="row" key={it.key}>
            <span className={`st ${cls}`} aria-hidden="true">
              {icon}
            </span>
            <span>{it.label}</span>
            {it.required && it.status !== "uploaded" && <span className="req">needed for quote</span>}
          </div>
        );
      })}
    </div>
  );
}

// ── card ──────────────────────────────────────────────────────────────────
/** Minimal markdown: **bold** only, rest as text (\n via white-space:pre-wrap). */
function cardBody(body: string) {
  return body.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function CardW({ w }: { w: CardWidget }) {
  return (
    <div className="card">
      <h4>{w.title}</h4>
      {w.body && <div className="body">{cardBody(w.body)}</div>}
      {w.links.length > 0 && (
        <div className="links">
          {w.links.map((l, i) => {
            const url = l.url || "";
            const dead = !url || url === "#";
            const isDownload = url.startsWith("/api/download");
            return (
              <a
                key={i}
                href={dead ? "#" : url}
                className={dead ? "dead" : undefined}
                title={dead ? "Available in live mode" : undefined}
                onClick={dead ? (e) => e.preventDefault() : undefined}
                {...(isDownload
                  ? { download: "" }
                  : dead
                    ? {}
                    : { target: "_blank", rel: "noreferrer" })}
              >
                {l.label}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
