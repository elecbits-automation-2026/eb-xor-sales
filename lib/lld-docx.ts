/**
 * Branded .docx renderer for the LLD draft.
 *
 * Turns the bot's generated LLD Markdown (well-formed: "# " title, "## "
 * sections, "### " subs, -/1. lists, **bold** / *italic* inline, "---"
 * rules) into the Elecbits-styled Word document a customer actually
 * receives: A4, first-page letterhead (XoR mark + wordmark + lead meta over
 * a blue accent rule), bordered section headings, real Word list numbering,
 * and a Confidential footer with page numbers on every page.
 *
 * The parser is a small hand-rolled line scanner — no markdown dependency —
 * and rendering never throws on odd input: any line it does not recognise
 * becomes a body paragraph, and a missing/unreadable public/xor-mark.png
 * simply renders the letterhead without the image.
 */
import { readFileSync } from "fs";
import path from "path";

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  Tab,
  TabStopType,
  Table,
  TableBorders,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type IRunOptions,
} from "docx";

// ── brand palette + metrics ───────────────────────────────────────────────
const ACCENT = "2563EB"; // Elecbits blue
const INK = "1E293B"; // near-black headings/body
const MUTED = "64748B"; // meta + footer grey
const RULE = "E2E8F0"; // hairline dividers

/**
 * Calibri with fallbacks declared: ascii/hAnsi ask for Calibri (renderers
 * without it substitute the metric-compatible Carlito), cs covers complex
 * scripts — Indic text in names/addresses — via Nirmala UI.
 */
const FONT = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Calibri", cs: "Nirmala UI" };

// A4 portrait with 2 cm margins; all lengths in twips (1/20 pt).
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1134;
const CONTENT_W = PAGE_W - 2 * MARGIN; // right tab stop in header/footer

const BODY: IRunOptions = { font: FONT, size: 20, color: INK }; // 10 pt
const BODY_SPACING = { line: 276, lineRule: LineRuleType.AUTO } as const; // 1.15

const BULLET_REF = "xor-bullet";
const DECIMAL_REF = "xor-decimal";

/** Shape of lldDocx's meta argument (internal alias — only lldDocx is exported). */
interface LldDocxMeta {
  leadRef: string;
  dealId?: string | null;
  company?: string | null;
  /** Pre-formatted date; defaults to today in IST, "30 Aug 2026" style. */
  date?: string;
}

// ── small utilities ───────────────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today in IST (fixed UTC+5:30 — no DST), "30 Aug 2026" style. */
function todayIst(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

/** The XoR mark for the letterhead; null (image skipped) when unreadable. */
function readLogo(): Buffer | null {
  try {
    return readFileSync(path.join(process.cwd(), "public", "xor-mark.png"));
  } catch {
    return null;
  }
}

/**
 * Split one line into TextRuns, toggling bold on "**" and italics on "*".
 * A "*" that could neither open (space follows) nor close (space precedes)
 * an italic span stays literal, so "5 * 3" survives. Unclosed markers never
 * throw — the style simply runs to the end of the line.
 */
function inlineRuns(text: string, base: IRunOptions): TextRun[] {
  const runs: TextRun[] = [];
  let buf = "";
  let bold = false;
  let italic = false;
  const flush = () => {
    if (!buf) return;
    runs.push(
      new TextRun({
        ...base,
        text: buf,
        bold: bold || base.bold || undefined,
        italics: italic || base.italics || undefined,
      }),
    );
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
  if (!runs.length) runs.push(new TextRun({ ...base, text: "" }));
  return runs;
}

/** Inline markers stripped — used for the docx metadata title. */
function plainText(text: string): string {
  return text.replace(/\*+/g, "").trim();
}

// ── markdown → body paragraphs ────────────────────────────────────────────
function titleParagraph(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.TITLE,
    spacing: { before: 0, after: 240 },
    children: inlineRuns(text, { font: FONT, size: 52, bold: true, color: INK }), // 26 pt
  });
}

function h2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    spacing: { before: 300, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: RULE, space: 3 } }, // 2 pt
    children: inlineRuns(text, { font: FONT, size: 26, bold: true, color: INK }), // 13 pt
  });
}

function h3(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    keepNext: true,
    spacing: { before: 220, after: 100 },
    children: inlineRuns(text, { font: FONT, size: 22, bold: true, color: INK }), // 11 pt
  });
}

function bodyParagraph(text: string): Paragraph {
  return new Paragraph({ spacing: { after: 120, ...BODY_SPACING }, children: inlineRuns(text, BODY) });
}

function listItem(text: string, reference: string, level: number, instance: number): Paragraph {
  return new Paragraph({
    numbering: { reference, level, instance },
    spacing: { after: 60, ...BODY_SPACING },
    children: inlineRuns(text, BODY),
  });
}

/** "---" rule (and the H2 underline's big sibling): a bordered empty line. */
function hr(): Paragraph {
  return new Paragraph({
    spacing: { before: 60, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE } },
    children: [],
  });
}

/** Two indent spaces ≈ one nesting level; the configs define levels 0–2. */
function listLevel(indent: string): number {
  return Math.min(2, Math.floor(indent.length / 2));
}

/**
 * Line scanner for our own generated markdown. The first "# " becomes the
 * document title (later ones demote to sections); anything unrecognised is
 * a plain body paragraph, so odd input renders instead of throwing.
 */
function buildBody(markdown: string): { children: Paragraph[]; title: string | null } {
  const children: Paragraph[] = [];
  let title: string | null = null;
  let decimalInstance = 0; // bump per list so each "1." run restarts at 1
  let inNumbered = false;

  for (const raw of String(markdown ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue; // paragraph spacing provides the rhythm

    const bullet = /^(\s*)[-*]\s(.*)$/.exec(line);
    const numbered = /^(\s*)\d{1,4}[.)]\s(.*)$/.exec(line);
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    // A list item keeps a numbered run alive (nested bullets under FRs);
    // any other content ends it, so the next "1." starts a fresh sequence.
    if (!bullet && !numbered) inNumbered = false;

    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      children.push(hr());
    } else if (heading) {
      const text = heading[2].trim();
      if (heading[1].length === 1 && title === null) {
        title = plainText(text);
        children.push(titleParagraph(text));
      } else if (heading[1].length <= 2) {
        children.push(h2(text));
      } else {
        children.push(h3(text));
      }
    } else if (bullet) {
      children.push(listItem(bullet[2].trim(), BULLET_REF, listLevel(bullet[1]), 0));
    } else if (numbered) {
      if (!inNumbered) decimalInstance++;
      inNumbered = true;
      children.push(
        listItem(numbered[2].trim(), DECIMAL_REF, listLevel(numbered[1]), decimalInstance),
      );
    } else {
      children.push(bodyParagraph(trimmed));
    }
  }

  if (!children.length) children.push(bodyParagraph(""));
  return { children, title };
}

// ── letterhead + footer ───────────────────────────────────────────────────
function metaRun(text: string, opts: IRunOptions = {}): TextRun {
  return new TextRun({ font: FONT, size: 16, color: MUTED, ...opts, text }); // 8 pt
}

/**
 * First-page letterhead: XoR mark + spaced-caps wordmark on the left,
 * right-aligned lead meta, and the blue accent rule underneath. Built as a
 * borderless two-cell table so both sides sit on one line.
 */
function firstPageHeader(logo: Buffer | null, meta: LldDocxMeta): Header {
  const brand = new Paragraph({
    spacing: { after: 0 },
    children: [
      ...(logo
        ? [new ImageRun({ type: "png", data: logo, transformation: { width: 42, height: 25 } })]
        : []),
      new TextRun({
        text: `${logo ? "   " : ""}ELECBITS`,
        font: FONT,
        size: 24,
        bold: true,
        color: INK,
        characterSpacing: 20,
      }),
      new TextRun({
        text: " · XoR",
        font: FONT,
        size: 24,
        bold: true,
        color: ACCENT,
        characterSpacing: 20,
      }),
    ],
  });

  const metaLines: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 20 },
      children: [
        metaRun("LLD Draft · ", { size: 18 }),
        metaRun(meta.leadRef, { size: 18, bold: true, color: INK }),
      ],
    }),
  ];
  const metaLine = (run: TextRun) =>
    metaLines.push(
      new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 20 }, children: [run] }),
    );
  if (meta.dealId) metaLine(metaRun(`Deal ${meta.dealId}`));
  if (meta.company) metaLine(metaRun(meta.company));
  metaLine(metaRun(meta.date?.trim() || todayIst()));

  const block = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TableBorders.NONE,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 55, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlign.CENTER,
            children: [brand],
          }),
          new TableCell({
            width: { size: 45, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlign.CENTER,
            children: metaLines,
          }),
        ],
      }),
    ],
  });

  const accentRule = new Paragraph({
    spacing: { before: 100, after: 0 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT } },
    children: [],
  });

  return new Header({ children: [block, accentRule] });
}

/** Slim running header for pages 2+ so the draft stays branded throughout. */
function runningHeader(meta: LldDocxMeta): Header {
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 2 } },
        spacing: { after: 0 },
        children: [
          metaRun("ELECBITS · XoR", { bold: true, characterSpacing: 12 }),
          new TextRun({
            font: FONT,
            size: 16,
            color: MUTED,
            children: [new Tab(), `LLD Draft · ${meta.leadRef}`],
          }),
        ],
      }),
    ],
  });
}

/** Every page: confidentiality line left, "Page N of M" field right. */
function pageFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 4 } },
        spacing: { before: 0, after: 0 },
        children: [
          metaRun("Elecbits · Confidential — first-draft LLD, generated by XoR"),
          new TextRun({
            font: FONT,
            size: 16,
            color: MUTED,
            children: [new Tab(), "Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
          }),
        ],
      }),
    ],
  });
}

// ── document assembly ─────────────────────────────────────────────────────
const GLYPHS = ["•", "◦", "▪"]; // • ◦ ▪ — numbering defs, never text runs

const NUMBERING = {
  config: [
    {
      reference: BULLET_REF,
      levels: GLYPHS.map((text, level) => ({
        level,
        format: LevelFormat.BULLET,
        text,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 460 + 320 * level, hanging: 240 } } },
      })),
    },
    {
      reference: DECIMAL_REF,
      levels: [0, 1, 2].map((level) => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 500 + 320 * level, hanging: 280 } } },
      })),
    },
  ],
};

/**
 * Render the LLD markdown draft into the branded Elecbits .docx. Resolves
 * with the finished file's bytes; odd markdown and a missing logo degrade
 * gracefully instead of rejecting.
 */
export async function lldDocx(
  markdown: string,
  meta: { leadRef: string; dealId?: string | null; company?: string | null; date?: string },
): Promise<Buffer> {
  const logo = readLogo();
  const { children, title } = buildBody(markdown);

  const doc = new Document({
    creator: "Elecbits · XoR",
    title: title ?? `LLD Draft ${meta.leadRef}`,
    subject: "Low-Level Design — first draft",
    description: `First-draft LLD generated by XoR for ${meta.leadRef}`,
    styles: {
      default: {
        document: { run: BODY, paragraph: { spacing: BODY_SPACING } },
      },
    },
    numbering: NUMBERING,
    sections: [
      {
        properties: {
          titlePage: true, // letterhead on page 1, slim running header after
          page: {
            size: { width: PAGE_W, height: PAGE_H },
            margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN, header: 510, footer: 440 },
          },
        },
        headers: { first: firstPageHeader(logo, meta), default: runningHeader(meta) },
        footers: { first: pageFooter(), default: pageFooter() },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
