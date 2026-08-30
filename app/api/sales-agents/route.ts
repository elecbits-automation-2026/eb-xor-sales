/**
 * Sales-designated people from core.people, for the signup dropdown.
 * Public and harmless (first names of the sales team); cached in-process
 * for 5 minutes so signup pages never hammer the shared table.
 */
import { NextResponse } from "next/server";

import { getDb } from "@/lib/supabase";

export const dynamic = "force-dynamic";

let cache: { agents: string[]; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

export async function GET() {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    cache = { agents: await getDb().salesAgents(), at: Date.now() };
  }
  return NextResponse.json({ agents: cache.agents });
}
