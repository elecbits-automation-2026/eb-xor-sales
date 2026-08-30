"use client";

/**
 * App-shell sidebar, shared by "/" and /account — brand, "+ New enquiry",
 * the PROJECTS list, and the account footer. Both pages are login-gated, so
 * the sidebar always renders for a signed-in user.
 *
 * Two modes:
 *  - page="home": fetches /api/me/enquiries once itself and renders rows as
 *    links to /account?deal=…; a 401 means the token died mid-session, so it
 *    calls onExpired (the page gate drops to the login view). Hidden on
 *    mobile (the page keeps its own compact header).
 *  - page="account": fully controlled by AccountPanel (which already owns
 *    the data + selection); rows select in-pane via onSelect.
 */

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { getAccessToken } from "@/lib/client-auth";

export interface SidebarEnquiry {
  deal_id: string | null;
  lead_ref: string;
  summary: string | null;
  created_at?: string | null;
}

/** Stable row identity: deal id once assigned, lead ref before that. */
export function enquiryKey(q: SidebarEnquiry): string {
  return q.deal_id || q.lead_ref;
}

/** "30 Aug" — compact row date; empty when unknown/invalid. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

type Props =
  | { page: "home"; email: string; onSignOut: () => void; onExpired: () => void }
  | {
      page: "account";
      email: string;
      clientCode: string | null;
      /** null = still loading */
      enquiries: SidebarEnquiry[] | null;
      selected: string | null;
      onSelect: (key: string) => void;
      onSignOut: () => void;
    };

interface HomeData {
  code: string | null;
  /** null = fetch failed (stay signed in, just say so) */
  enqs: SidebarEnquiry[] | null;
}

function startNewEnquiry() {
  try {
    sessionStorage.removeItem("xor_session_id");
  } catch {
    // private mode — the chat opens fresh anyway when nothing is stored
  }
  // Full navigation on purpose: from "/" itself this reloads the page so the
  // chat re-opens with a fresh session (a client-side route push would not).
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional full reload
  window.location.href = "/";
}

export default function Sidebar(props: Props) {
  const isHome = props.page === "home";
  const onExpired = props.page === "home" ? props.onExpired : null;
  const [home, setHome] = useState<HomeData | "loading">("loading");
  // Bumped by the chat's turn-complete event so a deal filed MID-CHAT shows
  // up in Projects immediately, not on the next full page load.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!isHome) return;
    const onActivity = () => setTick((t) => t + 1);
    window.addEventListener("xor:activity", onActivity);
    return () => window.removeEventListener("xor:activity", onActivity);
  }, [isHome]);

  useEffect(() => {
    if (!isHome || !onExpired) return;
    let alive = true;
    void (async () => {
      const token = await getAccessToken();
      if (!alive) return;
      if (!token) {
        onExpired();
        return;
      }
      try {
        const r = await fetch("/api/me/enquiries", {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!alive) return;
        if (r.status === 401) {
          onExpired();
          return;
        }
        if (!r.ok) throw new Error(`bad status ${r.status}`);
        const data = (await r.json()) as {
          client: { client_code: string | null } | null;
          enquiries: SidebarEnquiry[];
        };
        setHome({ code: data.client?.client_code ?? null, enqs: data.enquiries ?? [] });
      } catch {
        // reachable-but-failed: stay signed in, just say the list didn't load
        if (alive) setHome({ code: null, enqs: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, [isHome, onExpired, tick]);

  // ── view model ──────────────────────────────────────────────────────────
  let list: ReactNode;
  let code: string | null;

  if (props.page === "account") {
    code = props.clientCode;
    list =
      props.enquiries === null ? (
        <div className="app-quiet" role="status">
          Loading…
        </div>
      ) : props.enquiries.length === 0 ? (
        <div className="app-quiet">No enquiries yet</div>
      ) : (
        props.enquiries.map((q) => {
          const key = enquiryKey(q);
          const sel = key === props.selected;
          return (
            <button
              key={key}
              type="button"
              className={`app-row${sel ? " sel" : ""}`}
              aria-current={sel ? "true" : undefined}
              onClick={() => props.onSelect(key)}
            >
              <span className="app-row-top">
                <span className="app-row-id">{key}</span>
                <span className="app-row-date">{shortDate(q.created_at)}</span>
              </span>
              <span className="app-row-sum">{q.summary || "New enquiry"}</span>
            </button>
          );
        })
      );
  } else if (home === "loading") {
    code = null;
    list = (
      <div className="app-quiet" role="status">
        Loading…
      </div>
    );
  } else {
    code = home.code;
    list =
      home.enqs === null ? (
        <div className="app-quiet">Couldn&apos;t load your enquiries.</div>
      ) : home.enqs.length === 0 ? (
        <div className="app-quiet">No enquiries yet</div>
      ) : (
        home.enqs.map((q) => {
          const key = enquiryKey(q);
          return (
            <Link
              key={key}
              className="app-row"
              href={`/account?deal=${encodeURIComponent(key)}`}
            >
              <span className="app-row-top">
                <span className="app-row-id">{key}</span>
                <span className="app-row-date">{shortDate(q.created_at)}</span>
              </span>
              <span className="app-row-sum">{q.summary || "New enquiry"}</span>
            </Link>
          );
        })
      );
  }

  return (
    <aside className={`app-side${isHome ? " side-home" : ""}`}>
      <Link className="app-brand" href="/" aria-label="XoR — home">
        <Image src="/xor-mark.png" alt="" aria-hidden width={30} height={18} priority />
        <span className="app-wordmark">
          X<b>o</b>R
        </span>
      </Link>
      <button type="button" className="app-new" onClick={startNewEnquiry}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 5v14M5 12h14"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
        New enquiry
      </button>
      <div className="app-label" aria-hidden="true">
        Projects
      </div>
      <nav className="app-list" aria-label="Projects">
        {list}
      </nav>
      <div className="app-foot">
        {code ? <span className="app-code">{code}</span> : null}
        <div className="app-foot-row">
          <span className="app-foot-mail" title={props.email}>
            {props.email}
          </span>
          <button type="button" className="app-ghost" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
