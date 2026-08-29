import Image from "next/image";
import Link from "next/link";

import Chat from "@/components/Chat";
import Sidebar from "@/components/Sidebar";
import ThemeToggle from "@/components/ThemeToggle";

export default function Home() {
  return (
    <main className="home">
      <ThemeToggle />
      <Sidebar page="home" />
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
