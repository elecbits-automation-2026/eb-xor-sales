/**
 * Streams the generated LLD draft from Storage — only the file that belongs
 * to that session, by its recorded filename.
 */
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/supabase";
import { sanitizeFilename } from "@/lib/util";

export const maxDuration = 60;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ session: string; file: string }> },
) {
  const { session, file } = await ctx.params;
  const db = getDb();
  const s = await db.getSession(session);
  if (!s) return NextResponse.json({ detail: "not found" }, { status: 404 });

  // Compare SANITIZED to SANITIZED: the stored display name may carry
  // characters the sanitizer folds ("&" in "Definition & Benchmark"), so a
  // raw equality check would 404 the session's own file.
  const safe = sanitizeFilename(decodeURIComponent(file));
  const matches = (stored: string | null | undefined): boolean =>
    Boolean(stored && sanitizeFilename(stored) === safe);
  // Only the session's own recorded deliverables — LLD or benchmark report.
  const [name, path] = matches(s.data.lld_file)
    ? [s.data.lld_file!, s.data.lld_path]
    : matches(s.data.bench_file)
      ? [s.data.bench_file!, s.data.bench_path]
      : [null, null];
  if (!name || !path) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  const bytes = await db.getObject(path);
  if (!bytes) return NextResponse.json({ detail: "not found" }, { status: 404 });

  const type = name.endsWith(".pdf")
    ? "application/pdf"
    : name.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "text/markdown; charset=utf-8";
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="${name.replace(/"/g, "'")}"`,
    },
  });
}
