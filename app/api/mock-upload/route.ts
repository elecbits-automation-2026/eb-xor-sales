/**
 * Signed-upload target for the in-memory driver ONLY. When Supabase is
 * configured, signed URLs point at Supabase Storage and this route refuses.
 * Mirrors the browser flow: PUT the raw file body to the signed URL.
 */
import { NextRequest, NextResponse } from "next/server";

import { getMemoryDb, usingMemoryDb } from "@/lib/supabase";

export async function PUT(req: NextRequest) {
  if (!usingMemoryDb()) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const path = getMemoryDb().consumeUploadToken(token);
  if (!path) {
    return NextResponse.json({ detail: "invalid or expired upload token" }, { status: 403 });
  }
  const body = new Uint8Array(await req.arrayBuffer());
  await getMemoryDb().putObject(
    path,
    body,
    req.headers.get("content-type") ?? "application/octet-stream",
  );
  return NextResponse.json({ ok: true, path });
}
