/**
 * The stored chat behind one of the signed-in client's enquiries.
 * Identity is STRICTLY the verified login (same scoping as /api/me/
 * enquiries): the lead must belong to the login's client record — knowing
 * a deal id is never enough to read someone else's conversation.
 */
import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/auth-server";
import { getDb } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ detail: "sign in to see your projects" }, { status: 401 });
  }
  const ref = req.nextUrl.searchParams.get("deal") ?? "";
  if (!ref) {
    return NextResponse.json({ detail: "missing deal" }, { status: 400 });
  }

  const db = getDb();
  let client = await db.findClientByAuthUserId(user.id);
  if (!client) {
    const byEmail = await db.findClientByEmail(user.email);
    if (byEmail?.auth_user_id === user.id || (byEmail && !byEmail.auth_user_id)) client = byEmail;
  }
  if (!client) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  const leads = await db.leadsForClient(client.id);
  const lead = leads.find((l) => (l.deal_id || l.lead_ref) === ref);
  if (!lead?.session_id) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  const messages = await db.recentMessages(lead.session_id, 500);
  return NextResponse.json({ messages });
}
