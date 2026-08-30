/**
 * lldDocx — the branded LLD .docx renderer. Feeds a representative generated
 * LLD draft through the renderer and checks the result is a real Word
 * package (ZIP magic, expected OPC parts, branded strings inside the
 * deflated XML), that lists use real Word numbering rather than literal
 * bullet glyphs, and that a missing logo file or odd markdown degrades
 * gracefully instead of rejecting. No network, no disk writes.
 */
import { describe, expect, it, vi } from "vitest";

import { inflateRawSync } from "zlib";

const fsState = vi.hoisted(() => ({ breakLogo: false }));

// Passthrough fs, except reads of the XoR mark fail on demand — exercises
// the renderer's "logo missing → skip the image" path without touching disk.
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    if (fsState.breakLogo && String(args[0]).includes("xor-mark")) {
      throw Object.assign(new Error("ENOENT (test): xor-mark.png unreadable"), { code: "ENOENT" });
    }
    return real.readFileSync(...args);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

import { lldDocx } from "@/lib/lld-docx";

/**
 * Walk the zip central directory and inflate every XML part (docx packs with
 * DEFLATE, so branded strings never appear in the raw bytes) — the
 * concatenated text lets us assert on document/header/footer/numbering XML
 * without a zip dependency. Binary parts (the PNG) are skipped so their
 * bytes cannot pollute substring assertions.
 */
function unzipText(buf: Buffer): string {
  const eocd = buf.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  expect(eocd).toBeGreaterThan(-1);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let out = "";
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(off)).toBe(0x02014b50); // central-directory magic
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (name.endsWith(".xml") || name.endsWith(".rels")) {
      const dataStart =
        localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(dataStart, dataStart + compressedSize);
      out += (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// A representative bot-generated draft: title, sections, subs, bullets
// (nested), numbered FRs, bold/italic inline, and a horizontal rule.
const LLD_MD = `# LLD — Smart Energy Meter (First Draft)

## 1. Overview
Elecbits **XoR** prepared this *first-draft* low-level design for a 3-phase
smart energy meter targeting **5,000 units** in the first production run.
The draft is meant to anchor the kick-off review, not to freeze the design.

---

## 2. Functional Requirements
1. Measure voltage, current and power factor on **three** phases.
2. Log energy (kWh) at 15-minute intervals to on-board flash.
3. Report over RS-485 (**Modbus RTU**) and push daily summaries via LTE.
4. Tamper detection: cover-open, magnet proximity and *reverse-current* events.
5. OTA firmware update with A/B slots and automatic rollback.
6. Survive 6 kV surge per IEC 61000-4-5 on mains inputs.
7. Class 1.0 accuracy per IS 13779 across the full temperature range.

## 3. Hardware Architecture
### 3.1 Major blocks
- MCU: STM32G474 (Cortex-M4F, 170 MHz)
- Metering AFE: **ADE7880** with isolated SPI
- Comms: RS-485 transceiver, *isolated*, plus Quectel EC200U LTE module
- Power: 85–305 V AC universal input, 3.3 V / 5 V flyback
  - Supervisor with brown-out at 2.9 V
  - Supercap ride-through for last-gasp reporting
- Protection: MOV + GDT front end, PTC on sense lines

### 3.2 Interfaces
- 2x RJ-45 service ports (RS-485 A/B)
- 1x USB-C behind the service flap for factory provisioning

## 4. Firmware Plan
1. Bare-metal bring-up with vendor HAL, then FreeRTOS.
2. Metering pipeline validated against a reference meter.
3. DLMS/COSEM stack integration and certification dry-run.

## 5. Open Questions
- Confirm the *neutral-missing* operating requirement.
- Is the LTE data plan **customer-provided** or bundled?
`;

const META = {
  leadRef: "EB-L-26-0142",
  dealId: "EbZ-PL03-07",
  company: "Acme Devices Pvt Ltd",
  date: "30 Aug 2026",
};

describe("lldDocx", () => {
  it("renders a branded, valid .docx from a representative draft", async () => {
    const buf = await lldDocx(LLD_MD, META);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK"); // zip magic
    expect(buf.length).toBeGreaterThan(5000);

    // Render sanity: OPC part names are stored uncompressed in the zip.
    expect(buf.includes("word/document.xml")).toBe(true);
    expect(buf.includes("word/numbering.xml")).toBe(true);
    expect(buf.includes("word/header")).toBe(true);
    expect(buf.includes("word/footer")).toBe(true);
    expect(buf.includes("media/")).toBe(true); // the embedded XoR mark

    const xml = unzipText(buf);
    // Letterhead + meta block.
    expect(xml).toContain("ELECBITS");
    expect(xml).toContain(META.leadRef);
    expect(xml).toContain(`Deal ${META.dealId}`);
    expect(xml).toContain("Acme Devices Pvt Ltd");
    expect(xml).toContain("30 Aug 2026");
    expect(xml).toContain("2563EB"); // accent rule / wordmark blue
    // Footer on every page: confidential line + a real page-number field.
    expect(xml).toContain("Elecbits · Confidential — first-draft LLD, generated by XoR");
    expect(xml).toContain("PAGE");
    // Content made it through the parser.
    expect(xml).toContain("LLD — Smart Energy Meter (First Draft)");
    expect(xml).toContain("2. Functional Requirements");
    expect(xml).toContain("Modbus RTU");
    // Lists are real Word numbering, never literal glyph runs in the body.
    expect(xml).toContain('w:val="bullet"');
    expect(xml).toContain('w:val="decimal"');
    expect(xml).not.toContain(">•"); // "•" only in numbering defs, not in <w:t>
  });

  it("keeps bold/italic as run formatting instead of leaking asterisks", async () => {
    const buf = await lldDocx(LLD_MD, META);
    const xml = unzipText(buf);
    expect(xml).not.toContain("**"); // markers consumed…
    expect(xml).toContain("<w:b/>"); // …and turned into real bold/italic runs
    expect(xml).toContain("<w:i/>");
  });

  it("still resolves when the logo file cannot be read (image skipped)", async () => {
    fsState.breakLogo = true;
    try {
      const buf = await lldDocx(LLD_MD, META);
      expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(buf.includes("word/document.xml")).toBe(true);
      expect(buf.includes("media/")).toBe(false); // no image embedded
      expect(unzipText(buf)).toContain("ELECBITS"); // wordmark still renders
    } finally {
      fsState.breakLogo = false;
    }
  });

  it("never throws on odd markdown — unknown lines become body paragraphs", async () => {
    const odd = [
      "####### not a heading",
      "**unclosed bold",
      "| a | b |",
      "> stray quote",
      "***",
      "1)no-space numbered",
      "*",
      "- ",
      "",
    ].join("\n");
    const buf = await lldDocx(odd, { leadRef: "EB-L-26-0007", dealId: null, company: null });
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    const xml = unzipText(buf);
    expect(xml).toContain("####### not a heading");
    expect(xml).toContain("| a | b |");
    expect(xml).toContain("1)no-space numbered");
  });
});
