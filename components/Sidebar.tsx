"use client";

/**
 * App-shell sidebar, shared by "/" and /account — brand, "+ New enquiry",
 * the PROJECTS list, and the account footer.
 *
 * Two modes:
 *  - page="home": self-contained. Resolves auth itself, fetches
 *    /api/me/enquiries once, and renders rows as links to /account?deal=…;
 *    signed-out it shows a quiet sign-in card instead. Hidden on mobile
 *    (the page keeps its own compact header).
 *  - page="account": fully controlled by AccountPanel (which already owns
 *    the data + selection); rows select in-pane via onSelect.
 */

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { currentUser, getAccessToken, signOut } from "@/lib/client-auth";

export interface SidebarEnquiry {
  deal_id: string | null;
  lead_ref: string;
  summary: string | null;
}

/** Stable row identity: deal id once assigned, lead ref before that. */
export function enquiryKey(q: SidebarEnquiry): string {
  return q.deal_id || q.lead_ref;
}

type Props =
  | { page: "home" }
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

type HomeState =
  | { st: "loading" }
  | { st: "out" }
  | { st: "in"; email: string; code: string | null; enqs: SidebarEnquiry[] | null };

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
  const [home, setHome] = useState<HomeState>({ st: "loading" });

  useEffect(() => {
    if (!isHome) return;
    let alive = true;
    void (async () => {
      const u = await currentUser();
      if (!alive) return;
      if (!u) {
        setHome({ st: "out" });
        return;
      }
      const token = await getAccessToken();
      if (!alive) return;
      if (!token) {
        setHome({ st: "out" });
        return;
      }
      try {
        const r = await fetch("/api/me/enquiries", {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!alive) return;
        if (r.status === 401) {
          setHome({ st: "out" });
          return;
        }
        if (!r.ok) throw new Error(`bad status ${r.status}`);
        const data = (await r.json()) as {
          client: { client_code: string | null } | null;
          enquiries: SidebarEnquiry[];
        };
        setHome({
          st: "in",
          email: u.email,
          code: data.client?.client_code ?? null,
          enqs: data.enquiries ?? [],
        });
      } catch {
        // reachable-but-failed: stay signed in, just say the list didn't load
        if (alive) setHome({ st: "in", email: u.email, code: null, enqs: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, [isHome]);

  const homeSignOut = async () => {
    try {
      await signOut();
    } catch {
      // local state clears regardless
    }
    setHome({ st: "out" });
  };

  // ── view model ──────────────────────────────────────────────────────────
  let list: ReactNode;
  let foot: ReactNode = null;

  if (props.page === "account") {
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
              <span className="app-row-id">{key}</span>
              <span className="app-row-sum">{q.summary || "New enquiry"}</span>
            </button>
          );
        })
      );
    foot = (
      <div className="app-foot">
        {props.clientCode ? <span className="app-code">{props.clientCode}</span> : null}
        <div className="app-foot-row">
          <span className="app-foot-mail" title={props.email}>
            {props.email}
          </span>
          <button type="button" className="app-ghost" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    );
  } else if (home.st === "loading") {
    list = (
      <div className="app-quiet" role="status">
        Loading…
      </div>
    );
  } else if (home.st === "out") {
    list = (
      <div className="app-signin">
        <p>Sign in to track your enquiries</p>
        <Link className="app-signin-btn" href="/account">
          Sign in
        </Link>
      </div>
    );
    foot = (
      <div className="app-foot">
        <Link className="app-ghost app-ghost-wide" href="/account">
          Sign in / Create account
        </Link>
      </div>
    );
  } else {
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
              <span className="app-row-id">{key}</span>
              <span className="app-row-sum">{q.summary || "New enquiry"}</span>
            </Link>
          );
        })
      );
    foot = (
      <div className="app-foot">
        {home.code ? <span className="app-code">{home.code}</span> : null}
        <div className="app-foot-row">
          <span className="app-foot-mail" title={home.email}>
            {home.email}
          </span>
          <button type="button" className="app-ghost" onClick={homeSignOut}>
            Sign out
          </button>
        </div>
      </div>
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
      {foot}
    </aside>
  );
}
