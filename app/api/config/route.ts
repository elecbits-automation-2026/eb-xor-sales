/**
 * Public runtime config for the browser — exactly two values, both public by
 * design: the Supabase project URL and the anon key (auth-only; every data
 * table is deny-all RLS, so the anon key cannot read a single row). This is
 * what lets the deployment use plain env names (SUPABASE_URL /
 * SUPABASE_ANON_KEY) with no NEXT_PUBLIC_ build-time vars.
 *
 * NEVER add anything else here — in particular not the service-role key.
 */
import { NextResponse } from "next/server";

import { cfg } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    supabase_url: cfg.supabaseUrl || null,
    supabase_anon_key: cfg.supabaseAnonKey || null,
  });
}
