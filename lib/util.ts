/** Small shared helpers: IST time, filename sanitization. */

const IST = "Asia/Kolkata";

/** "YYYYMMDD" for the current IST date. */
export function istDateCompact(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts.replaceAll("-", "");
}

/** "YYYY-MM-DD HH:MM" in IST — the funnel-sheet timestamp format. */
export function istTimestamp(d = new Date()): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${date} ${time}`;
}

/** "29 Aug 2026, 14:05 IST" — human-readable, for the intake summary. */
export function istHuman(d = new Date()): string {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${s} IST`;
}

/** Allow only [A-Za-z0-9._ -], cap 120 chars; never empty. */
export function sanitizeFilename(name: string): string {
  const base = (name || "").split(/[\\/]/).pop() || "";
  const safe = base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120).trim();
  return safe || "upload.bin";
}
