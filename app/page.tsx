import Chat from "@/components/Chat";

export default function Home() {
  return (
    <main className="shell">
      <section className="hero">
        <div className="mark">
          <span className="xor">
            X<b>o</b>R
          </span>
          <span className="by">by Elecbits</span>
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
            <span className="dot" style={{ background: "var(--accent)" }} />
            <div>
              <div className="t-top">
                <b>Design a new product</b>
                <span className="tag">ODM</span>
              </div>
              <p>Brief → architecture → LLD draft, generated as you chat.</p>
            </div>
          </div>
          <div className="track">
            <span className="dot" style={{ background: "var(--secondary)" }} />
            <div>
              <div className="t-top">
                <b>I have a design — manufacture it</b>
                <span className="tag">EMS</span>
              </div>
              <p>Upload BoM, Gerbers &amp; build files; get a complete RFQ in one pass.</p>
            </div>
          </div>
          <div className="track">
            <span className="dot" style={{ background: "var(--amber)" }} />
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
