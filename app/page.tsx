import Image from "next/image";
import Link from "next/link";

import Chat from "@/components/Chat";
import ThemeToggle from "@/components/ThemeToggle";

export default function Home() {
  return (
    <main className="shell">
      <ThemeToggle />
      <section className="hero">
        <div className="mark">
          <Image
            src="/xor-mark.png"
            alt=""
            aria-hidden
            width={56}
            height={34}
            priority
            className="xor-mark"
          />
          <span className="xor">
            X<b>o</b>R
          </span>
          <span className="by">by</span>
          <span className="by-logo">
            <Image src="/elecbits-logo.png" alt="Elecbits" width={118} height={22} priority />
          </span>
          <Link className="acct-link" href="/account">
            My projects →
          </Link>
        </div>
        <h1>
          From brief to board.
          <br />
          <span className="dim">Start here.</span>
        </h1>
        <p className="lede">
          Tell XOR Assist what you&apos;re building — it routes you to the right Elecbits team and
          captures everything they need, so your first call is a working session, not a
          questionnaire.
        </p>
        <div className="tracks">
          <div className="track">
            <span className="dot" style={{ background: "var(--acc)" }} />
            <div>
              <div className="t-top">
                <b>Design a new product</b>
                <span className="tag">ODM</span>
              </div>
              <p>Brief → architecture → LLD draft, generated as you chat.</p>
            </div>
          </div>
          <div className="track">
            <span className="dot" style={{ background: "var(--purple)" }} />
            <div>
              <div className="t-top">
                <b>I have a design — manufacture it</b>
                <span className="tag">EMS</span>
              </div>
              <p>Upload BoM, Gerbers &amp; build files; get a complete RFQ in one pass.</p>
            </div>
          </div>
          <div className="track">
            <span className="dot" style={{ background: "var(--coral)" }} />
            <div>
              <div className="t-top">
                <b>Ready products</b>
              </div>
              <p>IoT, IT hardware, power electronics — off-the-shelf or white-label.</p>
            </div>
          </div>
        </div>
        <p className="trust">
          R&amp;D + rapid prototyping + SMT manufacturing, one roof · BIS-certified power range
        </p>
      </section>

      <section className="chatwrap" aria-label="XOR Assist chat">
        <Chat />
      </section>
    </main>
  );
}
