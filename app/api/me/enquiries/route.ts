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

/**
 * Delete one of the signed-in client's own enquiries: the lead, its files,
 * transcript, tasks and session. Ownership is enforced by looking the lead
 * up ONLY within the authed client's list — an id from another account
 * simply isn't found. Register rows and Drive folders stay (system of
 * record; clean those up in Drive/the register itself).
 */
export async function DELETE(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ detail: "sign in first" }, { status: 401 });
  }
  let body: { lead_ref?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid JSON" }, { status: 400 });
  }
  if (!body.lead_ref) {
    return NextResponse.json({ detail: "lead_ref required" }, { status: 400 });
  }

  const db = getDb();
  const client = await db.findClientByAuthUserId(user.id);
  if (!client) {
    return NextResponse.json({ detail: "no projects for this account" }, { status: 404 });
  }
  const lead = (await db.leadsForClient(client.id)).find((l) => l.lead_ref === body.lead_ref);
  if (!lead) {
    return NextResponse.json({ detail: "enquiry not found" }, { status: 404 });
  }
  await db.deleteEnquiry(lead.id, lead.session_id ?? null);
  console.info(`xor enquiry deleted lead=${lead.lead_ref} by=${user.id}`);
  return NextResponse.json({ ok: true });
}
