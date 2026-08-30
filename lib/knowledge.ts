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

Engagement flow: share your requirement → Elecbits' engineering team
reviews it → a scoping call is set up → proposal/quote. This assistant's job
is to capture the requirement completely so that first call is productive.

The assistant must NEVER quote prices, commercial terms or firm timelines —
those come from the engineering team.
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
