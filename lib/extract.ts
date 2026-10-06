/**
 * Text extraction for CHAT-UPLOADED files (the paperclip) — the moment a
 * customer attaches "ELN Requirements.docx", XoR reads it and treats the
 * content like words they said, instead of a blind "file received".
 *
 * Mirrors the Drive-side extractors (exportKbFileText) but works on raw
 * bytes from Storage. Unsupported/undecodable types return null — the
 * orchestrator then says honestly what it can and can't read.
 */
import mammoth from "mammoth";

/** Types we can turn into text. Legacy .doc is NOT here — mammoth reads
 *  only .docx; the ack asks for a re-save instead of pretending. */
const PLAIN_TEXT = new Set(["txt", "md", "csv", "json", "xml", "log"]);

const MAX_CHARS = 30_000;

export function extractableExt(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf" || ext === "docx" || PLAIN_TEXT.has(ext)) return ext;
  return null;
}

export async function extractDocText(
  bytes: Uint8Array,
  filename: string,
): Promise<string | null> {
  const ext = extractableExt(filename);
  if (!ext) return null;
  try {
    let text: string;
    if (ext === "pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } else if (ext === "docx") {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      text = result.value;
    } else {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    const clean = text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
    return clean ? clean.slice(0, MAX_CHARS) : null;
  } catch (err) {
    console.error(`attachment text extraction failed (${filename})`, err);
    return null;
  }
}
