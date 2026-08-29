"use client";

/**
 * The front door. Login-first: while the auth phase resolves, a minimal
 * splash; signed out, the shared Claude-style <LoginView/>; signed in, the
 * app shell — <Sidebar/> plus a calm main pane with the XOR Assist chat.
 * The gate is purely a UI decision: the API stays as it is, and Chat.tsx
 * already attaches the bearer token to every call.
 */

import Image from "next/image";
import Link from "next/link";

import Chat from "@/components/Chat";
import LoginView, { GateLoading, useAuthGate } from "@/components/LoginView";
import Sidebar from "@/components/Sidebar";
import ThemeToggle from "@/components/ThemeToggle";
import { signOut } from "@/lib/client-auth";

export default function Home() {
  const gate = useAuthGate();

  const doSignOut = async () => {
    try {
      await signOut();
    } catch {
      // local state clears regardless
    }
    try {
      sessionStorage.removeItem("xor_session_id");
    } catch {
      // nothing stored
    }
    gate.setNotice("");
    gate.signedOut();
  };

  if (gate.recovery || gate.phase.kind === "out") {
    return (
      <main>
        <ThemeToggle />
        <LoginView gate={gate} />
      </main>
    );
  }

  if (gate.phase.kind === "loading") {
    return (
      <main>
        <ThemeToggle />
        <GateLoading />
      </main>
    );
  }

  return (
    <main className="home">
      <ThemeToggle />
      <Sidebar
        page="home"
        email={gate.phase.user.email}
        onSignOut={doSignOut}
        onExpired={gate.signedOut}
      />
      <section className="home-main">
        <header className="home-head">
          <Link className="home-brand" href="/" aria-label="XoR — home">
            <Image src="/xor-mark.png" alt="" aria-hidden width={34} height={20} priority />
            <span className="home-wordmark">
              X<b>o</b>R
            </span>
          </Link>
          <div className="home-head-text">
            <h1>From brief to board.</h1>
            <p>
              Tell XOR Assist what you&apos;re building — your first call becomes a working
              session, not a questionnaire.
            </p>
          </div>
          <Link className="acct-link home-acct" href="/account">
            My projects →
          </Link>
          <span className="home-logo">
            <Image src="/elecbits-logo.png" alt="Elecbits" width={108} height={20} priority />
          </span>
        </header>

        <div className="home-chat" aria-label="XOR Assist chat">
          <Chat />
        </div>

        <p className="home-trust">
          R&amp;D + rapid prototyping + SMT manufacturing, one roof · BIS-certified power range
        </p>
      </section>
    </main>
  );
}
