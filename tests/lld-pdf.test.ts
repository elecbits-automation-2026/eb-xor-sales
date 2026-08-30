/**
 * brandedPdf — the branded markdown → PDF renderer. Feeds a representative
 * Product Definition & Benchmark Report (title, sections, a table-heavy
 * body with ₹ prices and long URLs, lists, a fenced block) through the
 * renderer and checks the result is a real PDF with the DejaVu faces
 * embedded (FontFile2), that a ~120-row table paginates without corrupting
 * the file, and that a missing logo, unreadable brand fonts or garbage
 * markdown degrade gracefully instead of rejecting. No network, no disk
 * writes beyond reading the repo's own assets.
 */
import { describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({ breakLogo: false, breakFonts: false }));

// Passthrough fs, except reads of the XoR mark and/or the DejaVu faces fail
// on demand — exercises the "logo missing → skip" and "fonts missing →
// Helvetica fallback" paths without touching disk.
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const target = String(args[0]);
    if (fsState.breakLogo && target.includes("xor-mark")) {
      throw Object.assign(new Error("ENOENT (test): xor-mark.png unreadable"), { code: "ENOENT" });
    }
    if (fsState.breakFonts && target.includes("DejaVuSans")) {
      throw Object.assign(new Error("ENOENT (test): DejaVu fonts unreadable"), { code: "ENOENT" });
    }
    return real.readFileSync(...args);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

import { brandedPdf } from "@/lib/lld-pdf";

const pdfMagic = (buf: Buffer) => buf.subarray(0, 4).toString("latin1");
const pageCount = (buf: Buffer) => (buf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

// A representative bot-generated benchmark report: title, sections, a
// 6-column × 5-row table with ₹ prices and long URLs, nested bullets, a
// numbered list, a fenced block and bold/italic inline.
const BENCH_MD = `# Product Definition & Benchmark Report — 3-Phase Smart Energy Meter

Prepared by **Elecbits XoR** for the kick-off review. Pricing below is
indicative *street pricing* in ₹, collected on 28 Aug 2026.

## 1. Product Definition
The customer wants a **Class 1.0**, 3-phase smart energy meter with LTE
backhaul and Modbus RTU downstream, targeting **5,000 units**.

- Metering AFE with better than 0.5% energy accuracy
- LTE Cat-1 bis backhaul with **eSIM** provisioning
  - Fallback to RS-485 when the network is down
- IS 16444 / IS 13779 compliance out of the gate

## 2. Competitive Benchmark

| Product | Vendor | Street Price | Accuracy | Comms | Listing |
|---------|--------|--------------|----------|-------|---------|
| EM6400NG+ | Schneider Electric | ₹18,450 | Class 0.5S | RS-485 Modbus RTU | https://www.se.com/in/en/product/METSEEM6400NGCL05/em6400ng-power-meter/ |
| WL4400 | L&T Electrical | ₹9,999 | Class 1.0 | RS-485 | https://example-distributor.example.com/catalog/lnt-wl4400-three-phase-lcd-meter?variant=panel-mount&ref=xor |
| Elite 440 | Secure Meters | ₹12,700 | Class 0.5 | Optical + RS-232 | https://www.securemeters.com/elite-440/ |
| SPM33 | Selec Controls | **₹7,850** | Class 1.0 | RS-485 Modbus | https://www.selec.com/product-details/spm33 |
| EM368-kit | Genus Power | ₹6,499 | Class 1.0 | IrDA + LTE (kit) | https://www.genuspower.com/products/em368 |

1. Schneider anchors the premium tier; we should not chase it on price.
2. The Selec **SPM33** is the value benchmark to beat at ₹7,850.
3. Nobody bundles LTE + eSIM below ₹15,000 — that is the wedge.

### 2.1 Test method

\`\`\`
probe: 3-phase reference source @ 240 V / 5 A, PF 0.5L..1.0
log:   1 Hz, 24 h soak, kWh register delta vs reference
temps: -10 C / +25 C / +55 C chambers
\`\`\`

---

## 3. Recommendation
Position at **₹11,499** (MRP ₹13,999) with LTE + eSIM standard.
`;

const META = {
  docLabel: "Product Definition & Benchmark Report v0.1",
  leadRef: "EB-L-26-0142",
  dealId: "EbZ-PL03-07",
  company: "Acme Devices Pvt Ltd",
  date: "30 Aug 2026",
};

describe("brandedPdf", () => {
  it("renders a branded, valid PDF from a representative benchmark report", async () => {
    const buf = await brandedPdf(BENCH_MD, META);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(pdfMagic(buf)).toBe("%PDF");
    expect(buf.length).toBeGreaterThan(20000);
    // The DejaVu faces really embedded — TrueType programs live in FontFile2
    // streams, and the key sits uncompressed in the font descriptor dict.
    expect(buf.includes("FontFile2")).toBe(true);
  });

  it("paginates a ~120-row table across pages and still closes the file", async () => {
    const bigMd = [
      "# Benchmark Sweep — Distribution SKUs",
      "",
      "## Full price sweep",
      "",
      "| SKU | Vendor | Price | Accuracy | Cert | Link |",
      "|-----|--------|-------|----------|------|------|",
      ...Array.from(
        { length: 120 },
        (_, i) =>
          `| SKU-${String(i + 1).padStart(3, "0")} | Vendor ${(i % 7) + 1} | ₹${6499 + i * 53} | Class 1.0 | BIS / CE | https://vendor${(i % 7) + 1}.example.com/catalog/sku-${i + 1} |`,
      ),
    ].join("\n");

    const small = await brandedPdf(BENCH_MD, META);
    const big = await brandedPdf(bigMd, { docLabel: "LLD Draft v0.1", leadRef: "EB-L-26-0201" });

    expect(pdfMagic(big)).toBe("%PDF");
    expect(big.length).toBeGreaterThan(small.length);
    expect(pageCount(big)).toBeGreaterThan(2); // the sweep cannot fit one page
    expect(big.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("still resolves when the logo file cannot be read (image skipped)", async () => {
    fsState.breakLogo = true;
    try {
      const buf = await brandedPdf(BENCH_MD, META);
      expect(pdfMagic(buf)).toBe("%PDF");
      expect(buf.length).toBeGreaterThan(1000);
    } finally {
      fsState.breakLogo = false;
    }
  });

  it("falls back to Helvetica when the brand fonts cannot be read", async () => {
    // WinAnsi has no ₹, so the fallback fixture stays ASCII-only.
    const asciiMd = [
      "# LLD Draft — Fallback Fonts",
      "",
      "## Overview",
      "Body text with **bold** and *italic* runs.",
      "",
      "| Col A | Col B |",
      "|-------|-------|",
      "| 1     | two   |",
    ].join("\n");
    fsState.breakFonts = true;
    try {
      const buf = await brandedPdf(asciiMd, { docLabel: "LLD Draft v0.1", leadRef: "EB-L-26-0007" });
      expect(pdfMagic(buf)).toBe("%PDF");
      expect(buf.includes("FontFile2")).toBe(false); // built-in faces embed nothing
    } finally {
      fsState.breakFonts = false;
    }
  });

  it("never throws on garbage markdown — unknown lines become paragraphs", async () => {
    const odd = [
      "####### not a heading",
      "**unclosed bold",
      "| lone | pipe | row |",
      "and a paragraph right after it",
      "| h1 | h2 |",
      "|----|----|",
      "| a | row | with | too | many | cells |",
      "| short |",
      "*",
      "- ",
      "1)no-space numbered",
      "> stray quote",
      "\`\`\`",
      "unclosed fence with | pipes | inside",
    ].join("\n");
    const buf = await brandedPdf(odd, { docLabel: "LLD Draft v0.1", leadRef: "EB-L-26-0007", dealId: null, company: null });
    expect(pdfMagic(buf)).toBe("%PDF");
    expect(buf.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
