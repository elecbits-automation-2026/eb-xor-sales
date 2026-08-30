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

  const safe = sanitizeFilename(decodeURIComponent(file));
  // Only the session's own recorded deliverables — LLD or benchmark report.
  const path =
    s.data.lld_file === safe && s.data.lld_path
      ? s.data.lld_path
      : s.data.bench_file === safe && s.data.bench_path
        ? s.data.bench_path
        : null;
  if (!path) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  const bytes = await db.getObject(path);
  if (!bytes) return NextResponse.json({ detail: "not found" }, { status: 404 });

  const type = safe.endsWith(".pdf")
    ? "application/pdf"
    : safe.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "text/markdown; charset=utf-8";
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="${safe}"`,
    },
  });
}
