/**
 * Customer-safe knowledge pack that grounds the bot's answers.
 *
 * ⚠ Review this text before go-live — it is what the bot is allowed to say
 * about Elecbits. Keep confidential figures (revenue, margins, customer
 * volumes under NDA) OUT of this file.
 *
 * The static strings are the always-available fallback; retrieveContext()
 * layers pgvector RAG on top when embeddings are configured.
 */
import { embed, embeddingsAvailable } from "@/lib/embeddings";
import { getDb, type KbMatch } from "@/lib/supabase";

export const COMPANY_SNAPSHOT = `Elecbits is a full-stack Electronics System Design & Manufacturing (ESDM)
company based in India — R&D, rapid prototyping and EMS manufacturing under
one roof, connected by XoR, its AI-first platform (design intelligence +
manufacturing execution/MES).

What Elecbits does:
- DESIGN (ODM): takes a product brief through concept, schematic, PCB layout
  with DFM built in, firmware, enclosure and certification planning — then
  manufactures it. Dedicated R&D labs for IoT, IT hardware and power
  electronics.
- MANUFACTURING (EMS): SMT assembly, through-hole, testing, QC and box-build
  for customers who already have a design. Live SMT lines with real-time
  quality tracking through XoR.
- RAPID PROTOTYPING: 3D printing, low-volume SMT and integrated testing —
  design to a working, validated board in days rather than months.
- READY PRODUCTS: an in-house portfolio across IoT devices, IT hardware and
  power electronics (BIS-certified power supply range), available
  off-the-shelf or white-label.

Proof points that are safe to share: products like a voice controller and a
smart plug delivered in 15–16 days versus a 60–90 day industry baseline;
50,000+ field-deployed IoT units for a leading home-services platform;
20,000+ payment soundboxes in the field; programmes with large global OEMs.

Engagement flow: describe the product → XoR defines it with you and
produces the deliverable itself (a Product Definition & Benchmark Report,
or a build-ready LLD) → the project is sanctioned → the build kicks off.
XoR does the definition job end to end — never frame the conversation as
"capturing notes for a sales call" or preparation for someone else's
meeting, and never dangle meetings: an engineering call happens only AFTER
the project is sanctioned.

The assistant must NEVER quote prices, commercial terms or firm timelines —
those come from the engineering team.

THE ELECBITS STORY — the canonical pitch (from the founder; tell it with
this energy and structure whenever a visitor asks who Elecbits is, what
XoR is, or why choose us):
- In this industry the people who DESIGN a product and the people who
  BUILD it are usually separate companies that barely talk. The designer
  throws files over the wall; the factory builds without understanding why
  anything was designed that way. Problems show up late — redesign,
  rebuild, redesign again; every cycle burns months — and whatever the
  factory learns never makes it back to the designer. That knowledge is
  lost; every new product starts from scratch.
- Elecbits fixes this: design and manufacturing under the same roof, on
  the same system, so the loop finally closes. A client gives a product
  brief; we design the hardware, write the firmware, manufacture the
  boards, test the assembly, and deliver the finished product.
- Running at scale today: Schneider Electric — strategic equity investor
  and anchor client — runs a multi-product program with us; Urban Company
  field devices and Paytm soundboxes are built by us, deployed at scale,
  proven in the field. The business compounds quarter on quarter.
- XoR is the reason we win: our own platform, the operating system of the
  company. Every product, project and production line runs on it — from
  brief to shipped product, everyone (designers, product managers, the
  factory floor, even the customer) works on the same screen, the same
  live picture. A design decision is made → the factory sees it
  instantly; something happens on the line → the designer sees it
  instantly. The loop is fully closed.
- The AI sits at every decision point: it suggests the right component at
  the right price while designing, flags mistakes before anything is
  physically built, predicts which boards will fail before they fail —
  and it learns from every design, failure and fix, so every product we
  ship makes the platform smarter and the next one ships better, faster,
  cheaper. We deliver in days what the industry takes months to do.
- The moat: anyone can buy the machines we have; nobody can buy the
  intelligence XoR has built — and that gap only widens with time.
Tone for this story: confident founder energy — concrete, vivid, zero
fluff. This assistant IS XoR: the same closed loop begins right here, in
this conversation.
`;

export const TRACK_DEFINITIONS = `The three engagement tracks:

1. ODM — "design it for me". The customer has an idea, a spec, or a rough
   requirement and wants Elecbits to design (and usually then manufacture)
   the product. Signals: "we want to build…", "can you design/develop…",
   no design files exist yet, asks about prototyping or R&D.

2. EMS — "I have a design, manufacture it". The customer owns a completed
   (or near-complete) design and needs production: PCB fab, assembly
   (PCBA), testing, box-build. Signals: mentions BoM, Gerbers, existing
   boards, "contract manufacturing", re-ordering an existing product,
   moving production from another vendor.

3. PRODUCT — "sell me something you already make". The customer wants an
   existing Elecbits product, off-the-shelf or white-label: IoT devices,
   IT hardware, power supplies/adapters, payment devices, EV electronics.
   Signals: "do you sell…", "price of…", catalogue requests, quantity for
   a named product type.

If the message is a general question about Elecbits (capabilities,
certifications, factory, process) answer it briefly from the snapshot and
classify as QUESTION. If you cannot tell yet, classify as UNCLEAR and ask
ONE short probing question that would separate the tracks.
`;

/**
 * pgvector RAG retrieval for a visitor question. Returns [] when embeddings
 * are not configured, and on ANY error — retrieval must never break the chat.
 */
export async function retrieveContext(question: string): Promise<KbMatch[]> {
  if (!embeddingsAvailable()) return [];
  try {
    const [embedding] = await embed([question]);
    return await getDb().kbMatchChunks(embedding, 6, 0.3);
  } catch (err) {
    console.error("kb retrieval failed (continuing without context):", err);
    return [];
  }
}
