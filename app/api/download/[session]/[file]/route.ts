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
  if (!s.data.lld_file || !s.data.lld_path || s.data.lld_file !== safe) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  const bytes = await db.getObject(s.data.lld_path);
  if (!bytes) return NextResponse.json({ detail: "not found" }, { status: 404 });

  const type = safe.endsWith(".docx")
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "text/markdown; charset=utf-8";
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="${safe}"`,
    },
  });
}
