"use client";

/**
 * The front door. Login-first: while the auth phase resolves, a minimal
 * splash; signed out, the shared Claude-style <LoginView/>; signed in, the
 * app shell — <Sidebar/> plus the XOR Assist chat, which IS the main pane
 * (its own slim top bar, open message column, floating composer).
 * The gate is purely a UI decision: the API stays as it is, and Chat.tsx
 * already attaches the bearer token to every call.
 */

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
      <section className="home-main" aria-label="XOR Assist chat">
        <Chat />
      </section>
    </main>
  );
}
