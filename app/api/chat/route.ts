import { NextRequest, NextResponse } from "next/server";

import * as orchestrator from "@/lib/orchestrator";
import { clientKey, rateLimitOk } from "@/lib/ratelimit";
import type { ChatIn } from "@/lib/widgets";

// Finalize (Drive folder + file transfers + Sheets) runs inside this route.
export const maxDuration = 60;

const KINDS = new Set(["open", "text", "chip", "form"]);

export async function POST(req: NextRequest) {
  if (!rateLimitOk(clientKey(req))) {
    return NextResponse.json({ detail: "too many requests — slow down a little" }, { status: 429 });
  }

  let body: ChatIn;
  try {
    body = (await req.json()) as ChatIn;
  } catch {
    return NextResponse.json({ detail: "invalid JSON" }, { status: 400 });
  }
  if (!body || !KINDS.has(body.kind)) {
    return NextResponse.json({ detail: "invalid kind" }, { status: 400 });
  }
  if (body.text !== undefined && typeof body.text !== "string") {
    return NextResponse.json({ detail: "invalid text" }, { status: 400 });
  }
  if (typeof body.text === "string" && body.text.length > 4000) {
    body.text = body.text.slice(0, 4000);
  }

  const res = await orchestrator.handle(body);
  return NextResponse.json(res);
}
