/**
 * The signed-in client's enquiries/projects. Identity is STRICTLY the
 * verified login: the client record is matched by auth_user_id, or by the
 * login's confirmed email (which then binds auth_user_id for next time).
 * Contact emails typed into the chat are never enough to read data here.
 */
import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/auth-server";
import { TRACK_LABELS } from "@/lib/config";
import { getDb } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ detail: "sign in to see your projects" }, { status: 401 });
  }

  const db = getDb();
  let client = await db.findClientByAuthUserId(user.id);
  if (!client) {
    const byEmail = await db.findClientByEmail(user.email);
    if (byEmail && !byEmail.auth_user_id) {
      await db.updateClient(byEmail.id, { auth_user_id: user.id });
      client = { ...byEmail, auth_user_id: user.id };
    } else if (byEmail?.auth_user_id === user.id) {
      client = byEmail;
    }
  }

  if (!client) {
    return NextResponse.json({ client: null, enquiries: [] });
  }

  const leads = await db.leadsForClient(client.id);
  const enquiries = [];
  for (const l of leads) {
    let lld_url: string | null = null;
    if (l.session_id) {
      const s = await db.getSession(l.session_id);
      if (s?.data.lld_file) {
        lld_url = `/api/download/${l.session_id}/${encodeURIComponent(s.data.lld_file)}`;
      }
    }
    enquiries.push({
      session_id: l.session_id ?? null,
      deal_id: l.deal_id,
      lead_ref: l.lead_ref,
      track: l.track,
      track_label: TRACK_LABELS[l.track] ?? l.track,
      summary: l.summary,
      quantity: l.quantity,
      timeline: l.timeline,
      created_at: l.created_at ?? null,
      status: l.drive_committed || l.sheet_appended ? "Filed" : "Received",
      lld_url,
    });
  }

  return NextResponse.json({
    client: { client_code: client.client_code, company: client.company },
    enquiries,
  });
}
