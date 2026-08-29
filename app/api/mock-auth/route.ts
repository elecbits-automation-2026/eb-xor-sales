/**
 * Demo-mode auth endpoint — active ONLY when Supabase is absent (memory
 * driver). Real deployments use Supabase Auth from the browser; this route
 * then refuses, so it can never shadow the real thing.
 */
import { NextRequest, NextResponse } from "next/server";

import { memorySignIn, memorySignUp } from "@/lib/auth-server";
import { clientKey, rateLimitOk } from "@/lib/ratelimit";
import { usingMemoryDb } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  if (!usingMemoryDb()) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }
  if (!rateLimitOk(clientKey(req))) {
    return NextResponse.json({ detail: "too many requests — slow down a little" }, { status: 429 });
  }
  let body: { action?: string; email?: string; password?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid JSON" }, { status: 400 });
  }

  const email = String(body.email ?? "");
  const password = String(body.password ?? "");
  if (body.action === "signup") {
    const res = memorySignUp(email, password, String(body.name ?? ""));
    if ("error" in res) return NextResponse.json({ detail: res.error }, { status: res.status });
    return NextResponse.json(res);
  }
  if (body.action === "signin") {
    const res = memorySignIn(email, password);
    if ("error" in res) return NextResponse.json({ detail: res.error }, { status: res.status });
    return NextResponse.json(res);
  }
  return NextResponse.json({ detail: "unknown action" }, { status: 400 });
}
