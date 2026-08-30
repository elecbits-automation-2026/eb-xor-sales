/**
 * Read feed for the "Background tasks" column on the chat page: the pipeline
 * steps recorded for one session, oldest first. Access model is the same as
 * /api/chat — knowing the (unguessable) session id IS the capability; the
 * feed contains nothing the chat itself doesn't already tell the visitor.
 */
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session") ?? "";
  if (!/^[0-9a-f][0-9a-f-]{14,62}[0-9a-f]$/i.test(session)) {
    return NextResponse.json({ tasks: [] });
  }
  try {
    const tasks = await getDb().tasksForSession(session);
    return NextResponse.json({ tasks });
  } catch {
    // a bad/unknown id (e.g. non-uuid against Postgres) is just an empty feed
    return NextResponse.json({ tasks: [] });
  }
}
