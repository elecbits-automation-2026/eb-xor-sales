/**
 * Branded PDF renderer for XoR customer documents — LLD drafts and Product
 * Definition & Benchmark Reports.
 *
 * Turns the bot's generated Markdown (well-formed: "# " title, "## "
 * sections, "### " subs, -/1. lists, **bold** / *italic* inline, "---"
 * rules, ``` fences and — the workhorse — pipe tables) into the
 * Elecbits-styled PDF a customer actually receives: A4, first-page
 * letterhead (XoR mark + wordmark + lead meta over a blue accent rule), a
 * slim running header on later pages, and a Confidential footer with
 * "Page X of Y" stamped onto every buffered page at the end.
 *
 * Tables render as real grids: column widths proportional to content,
 * header row on a light accent tint, hairline borders, and rows that never
 * split mid-row — each row's height is measured first and the row breaks to
 * a new page (repeating the header) when it will not fit.
 *
 * The parser is a small hand-rolled line scanner — no markdown dependency —
 * and rendering never throws on odd input: any line it does not recognise
 * becomes a body paragraph, a missing/unreadable public/xor-mark.png simply
 * renders the letterhead without the image, and unreadable brand fonts fall
 * back to the built-in Helvetica faces (losing the ₹ glyph, nothing else).
 */
import { existsSync, readFileSync } from "fs";
import path from "path";

import PDFDocument from "pdfkit";

type Doc = PDFKit.PDFDocument;

// ── brand palette + metrics ───────────────────────────────────────────────
const ACCENT = "#2563eb"; // Elecbits blue
const INK = "#1e293b"; // near-black headings/body
const MUTED = "#64748b"; // meta + footer grey
const RULE = "#e2e8f0"; // hairline dividers
const TABLE_HEAD_BG = "#eff6ff"; // accent-tinted table header fill
const CODE_BG = "#f1f5f9"; // fenced-block background

// A4 portrait, ~48 pt margins; all lengths in PDF points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BOTTOM = PAGE_H - MARGIN; // content may not flow past this line

const BODY_SIZE = 9;
const BODY_GAP = 1.6; // lineGap ≈ 1.35 leading at 9 pt

/** Shape of brandedPdf's meta argument (internal alias — only brandedPdf is exported). */
interface BrandedPdfMeta {
  /** e.g. "LLD Draft v0.1" | "Product Definition & Benchmark Report v0.1" */
  docLabel: string;
  leadRef: string;
  dealId?: string | null;
  company?: string | null;
  /** Pre-formatted date; defaults to today in IST, "30 Aug 2026" style. */
  date?: string;
}

type ResolvedMeta = BrandedPdfMeta & { date: string };

/** The typeface names to draw with — DejaVu when embedded, Helvetica fallback. */
interface Faces {
  body: string;
  bold: string;
  italic: string;
  boldItalic: string;
  mono: string;
}

interface Ctx {
  doc: Doc;
  faces: Faces;
}

// ── small utilities ───────────────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today in IST (fixed UTC+5:30 — no DST), "30 Aug 2026" style. */
function todayIst(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

/**
 * Register the embeddable DejaVu faces (they carry the ₹ U+20B9 glyph these
 * documents lean on). The literal path.join(process.cwd(), …) strings keep
 * Vercel's file tracing aware of the assets. Any failure — missing file,
 * unparsable font — falls back to the built-in Helvetica faces.
 */
function registerFaces(doc: Doc): Faces {
  try {
    const regular = readFileSync(path.join(process.cwd(), "assets/fonts/DejaVuSans.ttf"));
    const bold = readFileSync(path.join(process.cwd(), "assets/fonts/DejaVuSans-Bold.ttf"));
    doc.registerFont("EB-Sans", regular);
    doc.registerFont("EB-Sans-Bold", bold);
    doc.font("EB-Sans-Bold").font("EB-Sans"); // force-parse both now, not mid-render
    // DejaVu ships no oblique here: italic renders as the regular face.
    return { body: "EB-Sans", bold: "EB-Sans-Bold", italic: "EB-Sans", boldItalic: "EB-Sans-Bold", mono: "EB-Sans" };
  } catch {
    return {
      body: "Helvetica",
      bold: "Helvetica-Bold",
      italic: "Helvetica-Oblique",
      boldItalic: "Helvetica-BoldOblique",
      mono: "Courier",
    };
  }
}

// ── inline markdown → styled runs ─────────────────────────────────────────
interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

/**
 * Split one line into runs, toggling bold on "**" and italics on "*". A "*"
 * that could neither open (space follows) nor close (space precedes) an
 * italic span stays literal, so "5 * 3" survives. Unclosed markers never
 * throw — the style simply runs to the end of the line.
 */
function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  let buf = "";
  let bold = false;
  let italic = false;
  const flush = () => {
    if (buf) runs.push({ text: buf, bold, italic });
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("**", i)) {
      flush();
      bold = !bold;
      i++; // consume the second "*"
      continue;
    }
    if (text[i] === "*") {
      const prev = i > 0 ? text[i - 1] : " ";
      const next = i + 1 < text.length ? text[i + 1] : " ";
      const canOpen = !italic && next !== " " && next !== "*";
      const canClose = italic && prev !== " ";
      if (canOpen || canClose) {
        flush();
        italic = !italic;
        continue;
      }
    }
    buf += text[i];
  }
  flush();
  return runs;
}

/** Inline markers stripped — used for measuring and for all-bold headings. */
function plainText(text: string): string {
  return inlineRuns(text)
    .map((r) => r.text)
    .join("");
}

function fontFor(faces: Faces, run: Run): string {
  if (run.bold && run.italic) return faces.boldItalic;
  if (run.bold) return faces.bold;
  if (run.italic) return faces.italic;
  return faces.body;
}

interface RunDrawOpts {
  x: number;
  /** Explicit start y; defaults to the current cursor. */
  y?: number;
  width: number;
  size: number;
  color: string;
  lineGap: number;
}

/**
 * Draw styled runs as one flowed text: each run continues the previous via
 * pdfkit's {continued} chaining, so bold/italic spans wrap naturally inside
 * the same paragraph (and across pages, where the pageAdded handler keeps
 * the running header out of the paragraph's way).
 */
function drawRuns(ctx: Ctx, runs: Run[], opts: RunDrawOpts): void {
  const { doc, faces } = ctx;
  const drawable = runs.filter((r) => r.text);
  if (!drawable.length) {
    doc.y = (opts.y ?? doc.y) + opts.size + opts.lineGap; // blank content still takes a line
    return;
  }
  drawable.forEach((run, i) => {
    doc.font(fontFor(faces, run)).fontSize(opts.size).fillColor(opts.color);
    const textOpts = { width: opts.width, lineGap: opts.lineGap, continued: i < drawable.length - 1 };
    if (i === 0) doc.text(run.text, opts.x, opts.y ?? doc.y, textOpts);
    else doc.text(run.text, textOpts);
  });
}

// ── markdown → blocks ─────────────────────────────────────────────────────
interface HeadingBlock {
  kind: "title" | "h2" | "h3";
  text: string;
}

type Block =
  | HeadingBlock
  | { kind: "para"; text: string }
  | { kind: "bullet"; text: string; level: number }
  | { kind: "numbered"; text: string; label: string; level: number }
  | { kind: "hr" }
  | { kind: "fence"; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

function isPipeRow(line: string): boolean {
  const t = line.trim();
  return t.length > 1 && t.startsWith("|") && t.endsWith("|");
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** The `|---|:---:|` row that promotes the pipe row above it to a header. */
function isSeparatorRow(line: string): boolean {
  if (!isPipeRow(line)) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/** Two indent spaces ≈ one nesting level; rendering supports levels 0–2. */
function listLevel(indent: string): number {
  return Math.min(2, Math.floor(indent.length / 2));
}

/**
 * Line scanner for our own generated markdown. The first "# " becomes the
 * document title (later ones demote to sections); a pipe row only starts a
 * table when the next line is a `|---|` separator; anything unrecognised is
 * a plain body paragraph, so odd input renders instead of throwing.
 */
function parseBlocks(markdown: string): Block[] {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const blocks: Block[] = [];
  let titleSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue; // block spacing provides the rhythm

    if (trimmed.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i].trimEnd().replace(/\t/g, "  "));
        i++;
      }
      blocks.push({ kind: "fence", lines: body }); // unclosed fence: runs to EOF
      continue;
    }

    if (isPipeRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const header = splitCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isPipeRow(lines[i])) {
        rows.push(splitCells(lines[i]));
        i++;
      }
      i--; // the for-loop increments past the last table row
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const text = heading[2].trim();
      if (heading[1].length === 1 && !titleSeen) {
        titleSeen = true;
        blocks.push({ kind: "title", text });
      } else if (heading[1].length <= 2) {
        blocks.push({ kind: "h2", text });
      } else {
        blocks.push({ kind: "h3", text });
      }
      continue;
    }

    const bullet = /^(\s*)[-*]\s(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "bullet", text: bullet[2].trim(), level: listLevel(bullet[1]) });
      continue;
    }

    const numbered = /^(\s*)(\d{1,4})[.)]\s(.*)$/.exec(line);
    if (numbered) {
      // Our generators write real ordinals, so the label is taken verbatim.
      blocks.push({ kind: "numbered", label: `${numbered[2]}.`, text: numbered[3].trim(), level: listLevel(numbered[1]) });
      continue;
    }

    blocks.push({ kind: "para", text: trimmed });
  }
  return blocks;
}

// ── block rendering ───────────────────────────────────────────────────────
function ensureRoom(doc: Doc, needed: number): void {
  if (doc.y + needed > BOTTOM) doc.addPage();
}

function hairline(doc: Doc, y: number, width = 0.5, color = RULE): void {
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(width).strokeColor(color).stroke();
}

function renderHeading(ctx: Ctx, block: HeadingBlock): void {
  const { doc } = ctx;
  const atPageTop = () => doc.y <= MARGIN + 1;
  const runs = inlineRuns(block.text).map((r) => ({ ...r, bold: true }));

  if (block.kind === "title") {
    ensureRoom(doc, 48);
    drawRuns(ctx, runs, { x: MARGIN, width: CONTENT_W, size: 22, color: INK, lineGap: 3 });
    doc.y += 10;
    return;
  }
  if (block.kind === "h2") {
    // Never orphan a section heading at the very bottom of a page.
    if (BOTTOM - doc.y < 90) doc.addPage();
    if (!atPageTop()) doc.y += 12;
    drawRuns(ctx, runs, { x: MARGIN, width: CONTENT_W, size: 13, color: INK, lineGap: 2 });
    hairline(doc, doc.y + 3, 0.75);
    doc.y += 11;
    return;
  }
  if (BOTTOM - doc.y < 55) doc.addPage();
  if (!atPageTop()) doc.y += 9;
  drawRuns(ctx, runs, { x: MARGIN, width: CONTENT_W, size: 10.5, color: INK, lineGap: 1.5 });
  doc.y += 4;
}

function renderListItem(ctx: Ctx, block: Extract<Block, { kind: "bullet" | "numbered" }>): void {
  const { doc, faces } = ctx;
  ensureRoom(doc, 14); // keep the marker and the first line together
  const indent = 4 + block.level * 12;
  const x = MARGIN + indent;
  const y = doc.y;
  doc.font(faces.body).fontSize(BODY_SIZE).fillColor(INK);
  const label = block.kind === "bullet" ? "•" : block.label;
  const labelW = block.kind === "bullet" ? 11 : Math.max(doc.widthOfString(label) + 4, 15);
  doc.text(label, x, y, { lineBreak: false });
  drawRuns(ctx, inlineRuns(block.text), {
    x: x + labelW,
    y,
    width: CONTENT_W - indent - labelW,
    size: BODY_SIZE,
    color: INK,
    lineGap: BODY_GAP,
  });
  doc.y += 2.5;
}

function renderFence(ctx: Ctx, lines: string[]): void {
  const { doc, faces } = ctx;
  const PAD = 6;
  const innerW = CONTENT_W - PAD * 2;
  const content = lines.length ? lines : [""];
  doc.font(faces.mono).fontSize(8);
  const heights = content.map((l) => doc.heightOfString(l || " ", { width: innerW, lineGap: 1 }));

  doc.y += 3;
  let i = 0;
  while (i < content.length) {
    if (doc.y + heights[i] + PAD * 2 > BOTTOM && doc.y > MARGIN + 1) doc.addPage();
    const top = doc.y;
    let used = 0;
    let count = 0;
    while (i + count < content.length && top + PAD * 2 + used + heights[i + count] <= BOTTOM - 0.5) {
      used += heights[i + count];
      count++;
    }
    if (!count) {
      count = 1; // pathological: one line taller than a page — draw it anyway
      used = heights[i];
    }
    doc.rect(MARGIN, top, CONTENT_W, used + PAD * 2).lineWidth(0.5).fillAndStroke(CODE_BG, RULE);
    doc.font(faces.mono).fontSize(8).fillColor(INK);
    let ly = top + PAD;
    for (let k = 0; k < count; k++) {
      doc.text(content[i + k] || " ", MARGIN + PAD, ly, { width: innerW, lineGap: 1 });
      ly += heights[i + k];
    }
    doc.y = top + used + PAD * 2 + 6;
    i += count;
  }
}

// ── tables — measured grid, rows never split mid-row ──────────────────────
const CELL_SIZE = 8;
const CELL_GAP = 1;
const CELL_PX = 4; // horizontal cell padding
const CELL_PY = 3; // vertical cell padding

function renderTable(ctx: Ctx, block: Extract<Block, { kind: "table" }>): void {
  const { doc, faces } = ctx;
  const header = block.header.length ? block.header : [""];
  const cols = header.length;
  // Malformed rows pad/truncate to the header's column count.
  const rows = block.rows.map((r) => {
    const cells = r.slice(0, cols);
    while (cells.length < cols) cells.push("");
    return cells;
  });

  // Column widths proportional to the widest content per column (capped so a
  // long URL cannot hog the page), lifted to a 55 pt floor where page width
  // allows, and scaled to fit inside the content width.
  doc.fontSize(CELL_SIZE);
  const desired = header.map((h, i) => {
    doc.font(faces.bold);
    let w = doc.widthOfString(plainText(h) || " ");
    doc.font(faces.body);
    for (const r of rows) w = Math.max(w, doc.widthOfString(plainText(r[i]) || " "));
    return Math.min(Math.max(w + CELL_PX * 2 + 2, 26), 220);
  });
  const desiredSum = desired.reduce((a, b) => a + b, 0) || 1;
  const floor = Math.min(55, CONTENT_W / cols);
  const tableW = Math.min(CONTENT_W, Math.max(desiredSum, floor * cols));
  let widths = desired.map((d) => (d / desiredSum) * tableW);
  const small = widths.map((w) => w < floor);
  const liftedW = small.filter(Boolean).length * floor;
  const restSum = widths.reduce((a, w, i) => a + (small[i] ? 0 : w), 0);
  if (restSum > 0 && liftedW < tableW) {
    widths = widths.map((w, i) => (small[i] ? floor : (w / restSum) * (tableW - liftedW)));
  }
  if (!widths.every((w) => Number.isFinite(w) && w >= 8)) {
    widths = header.map(() => tableW / cols);
  }
  const innerW = (i: number) => Math.max(widths[i] - CELL_PX * 2, 4);

  // Height of a row is its tallest wrapped cell. Cells with bold spans are
  // measured all-bold — bold is wider, so the measure can only overestimate,
  // which keeps the drawn text inside the box.
  const rowHeight = (cells: string[], boldRow: boolean): number => {
    let h = 0;
    for (let i = 0; i < cols; i++) {
      doc
        .font(boldRow || cells[i].includes("**") ? faces.bold : faces.body)
        .fontSize(CELL_SIZE);
      h = Math.max(h, doc.heightOfString(plainText(cells[i]) || " ", { width: innerW(i), lineGap: CELL_GAP }));
    }
    return h + CELL_PY * 2;
  };

  const drawRowAt = (cells: string[], y: number, h: number, isHeader: boolean): void => {
    if (isHeader) doc.rect(MARGIN, y, tableW, h).fill(TABLE_HEAD_BG);
    let x = MARGIN;
    for (let i = 0; i < cols; i++) {
      const runs = inlineRuns(cells[i]).map((r) => (isHeader ? { ...r, bold: true } : r));
      drawRuns(ctx, runs, {
        x: x + CELL_PX,
        y: y + CELL_PY,
        width: innerW(i),
        size: CELL_SIZE,
        color: INK,
        lineGap: CELL_GAP,
      });
      x += widths[i];
    }
    doc.lineWidth(0.5).strokeColor(RULE).rect(MARGIN, y, tableW, h).stroke();
    let vx = MARGIN;
    for (let i = 0; i < cols - 1; i++) {
      vx += widths[i];
      doc.moveTo(vx, y).lineTo(vx, y + h).stroke();
    }
  };

  doc.y += 6;
  const headH = rowHeight(header, true);
  const firstH = rows.length ? rowHeight(rows[0], false) : 0;
  let y = doc.y;
  if (y + headH + firstH > BOTTOM && y > MARGIN + 1) {
    doc.addPage(); // never orphan the header row at the bottom of a page
    y = doc.y;
  }
  drawRowAt(header, y, headH, true);
  y += headH;

  for (const row of rows) {
    const h = rowHeight(row, false);
    // Rows never split mid-row: break first, repeating the header on the new
    // page. The y-guard keeps a taller-than-a-page row from looping forever.
    if (y + h > BOTTOM && y > MARGIN + headH + 1) {
      doc.addPage();
      y = doc.y;
      drawRowAt(header, y, headH, true);
      y += headH;
    }
    drawRowAt(row, y, h, false);
    y += h;
  }

  doc.x = MARGIN;
  doc.y = y + 8;
}

function renderBlocks(ctx: Ctx, blocks: Block[]): void {
  const { doc } = ctx;
  for (const block of blocks) {
    switch (block.kind) {
      case "title":
      case "h2":
      case "h3":
        renderHeading(ctx, block);
        break;
      case "para":
        drawRuns(ctx, inlineRuns(block.text), {
          x: MARGIN,
          width: CONTENT_W,
          size: BODY_SIZE,
          color: INK,
          lineGap: BODY_GAP,
        });
        doc.y += 5;
        break;
      case "bullet":
      case "numbered":
        renderListItem(ctx, block);
        break;
      case "hr": {
        ensureRoom(doc, 14);
        hairline(doc, doc.y + 4, 0.75);
        doc.y += 14;
        break;
      }
      case "fence":
        renderFence(ctx, block.lines);
        break;
      case "table":
        renderTable(ctx, block);
        break;
    }
  }
}

// ── letterhead, running header, footer ────────────────────────────────────
/**
 * Page-1 letterhead: XoR mark + spaced-caps wordmark on the left,
 * right-aligned lead meta, and the 1.5 pt blue accent rule underneath.
 */
function drawLetterhead(ctx: Ctx, meta: ResolvedMeta): void {
  const { doc, faces } = ctx;
  const top = MARGIN;
  let x = MARGIN;
  try {
    const logo = readFileSync(path.join(process.cwd(), "public", "xor-mark.png"));
    doc.image(logo, MARGIN, top, { width: 42, height: 25 });
    x += 52;
  } catch {
    // Letterhead renders without the mark.
  }

  const SPACING = 1.5;
  const wordY = top + 8;
  doc.font(faces.bold).fontSize(11).fillColor(INK);
  doc.text("ELECBITS", x, wordY, { characterSpacing: SPACING, lineBreak: false });
  const wordW = doc.widthOfString("ELECBITS") + SPACING * "ELECBITS".length;
  doc.fillColor(ACCENT).text(" · XoR", x + wordW, wordY, { characterSpacing: SPACING, lineBreak: false });

  // Right-aligned meta block: docLabel · leadRef, then deal / company / date.
  const rightEdge = MARGIN + CONTENT_W;
  let my = top;
  doc.fontSize(8);
  const labelText = `${meta.docLabel} · `;
  doc.font(faces.body);
  const labelW = doc.widthOfString(labelText);
  doc.font(faces.bold);
  const refW = doc.widthOfString(meta.leadRef);
  doc.font(faces.body).fillColor(MUTED).text(labelText, rightEdge - labelW - refW, my, { lineBreak: false });
  doc.font(faces.bold).fillColor(INK).text(meta.leadRef, rightEdge - refW, my, { lineBreak: false });
  my += 11;
  doc.font(faces.body).fontSize(7.5).fillColor(MUTED);
  const metaLine = (text: string) => {
    doc.text(text, rightEdge - doc.widthOfString(text), my, { lineBreak: false });
    my += 10;
  };
  if (meta.dealId) metaLine(`Deal ${meta.dealId}`);
  if (meta.company) metaLine(meta.company);
  metaLine(meta.date);

  const ruleY = Math.max(top + 28, my + 2);
  hairline(doc, ruleY, 1.5, ACCENT);
  doc.x = MARGIN;
  doc.y = ruleY + 18;
}

/** pdfkit state a pageAdded handler must put back before text flow resumes. */
interface MutableTextState {
  _font?: unknown;
  _fontSize?: number;
  _fillColor?: [PDFKit.Mixins.ColorValue, number];
}

/**
 * Slim one-line running header for pages 2+, drawn inside the top margin.
 * A page can be added mid-paragraph while pdfkit's line wrapper is live, so
 * everything this touches — cursor, font, fill colour (which the wrapper
 * re-applies from doc._fillColor after a break) — is restored on the way out.
 */
function drawRunningHeader(ctx: Ctx, meta: ResolvedMeta): void {
  const { doc, faces } = ctx;
  const state = doc as unknown as MutableTextState;
  const prevFont = state._font;
  const prevSize = state._fontSize;
  const prevFill = state._fillColor
    ? ([...state._fillColor] as [PDFKit.Mixins.ColorValue, number])
    : undefined;
  const prevX = doc.x;
  const prevY = doc.y;

  doc
    .font(faces.body)
    .fontSize(6.5)
    .fillColor(MUTED)
    .text(`ELECBITS · ${meta.docLabel} · ${meta.leadRef}`, MARGIN, 20, { lineBreak: false });
  hairline(doc, 33);

  state._font = prevFont;
  if (typeof prevSize === "number") doc.fontSize(prevSize);
  if (prevFill) doc.fillColor(prevFill[0], prevFill[1]);
  doc.x = prevX;
  doc.y = prevY;
}

/**
 * Footer on every page, stamped after the body so the total is known:
 * hairline, Confidential line left, "Page X of Y" right — drawn in the
 * bottom margin with the margin zeroed so stamping can never add a page.
 */
function stampFooters(ctx: Ctx, meta: ResolvedMeta): void {
  const { doc, faces } = ctx;
  const range = doc.bufferedPageRange();
  const label = `Elecbits · Confidential — ${meta.docLabel}, generated by XoR`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = PAGE_H - 36;
    hairline(doc, y - 4);
    doc.font(faces.body).fontSize(7.5).fillColor(MUTED).text(label, MARGIN, y, { lineBreak: false });
    const pageText = `Page ${i + 1} of ${range.count}`;
    doc.text(pageText, MARGIN + CONTENT_W - doc.widthOfString(pageText), y, { lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

// ── document assembly ─────────────────────────────────────────────────────
/**
 * Render generated markdown into the branded Elecbits PDF. Resolves with the
 * finished file's bytes; odd markdown, a missing logo and unreadable brand
 * fonts all degrade gracefully instead of rejecting.
 */
export async function brandedPdf(
  markdown: string,
  meta: { docLabel: string; leadRef: string; dealId?: string | null; company?: string | null; date?: string },
): Promise<Buffer> {
  // The constructor loads its default font (Helvetica) from pdfkit's own
  // .afm data files — the classic serverless failure when the bundler drops
  // them. Point the default at our bundled TTF instead, so the constructor
  // never touches an AFM; Helvetica stays the last-resort when even the
  // bundled font is missing.
  const dejaVu = path.join(process.cwd(), "assets/fonts/DejaVuSans.ttf");
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true, // keep pages so footers can stamp "Page X of Y" at the end
    ...(existsSync(dejaVu) ? { font: dejaVu } : {}),
    info: {
      Title: `${meta.docLabel} — ${meta.leadRef}`,
      Author: "Elecbits · XoR",
      Subject: meta.docLabel,
      Creator: "Elecbits XoR",
    },
  });

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const ctx: Ctx = { doc, faces: registerFaces(doc) };
  const resolved: ResolvedMeta = { ...meta, date: meta.date?.trim() || todayIst() };

  doc.on("pageAdded", () => drawRunningHeader(ctx, resolved));
  drawLetterhead(ctx, resolved);
  renderBlocks(ctx, parseBlocks(markdown));
  stampFooters(ctx, resolved);
  doc.end();

  return finished;
}
