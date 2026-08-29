import { NextResponse } from "next/server";

import { cfg } from "@/lib/config";

export async function GET() {
  return NextResponse.json({ ok: true, mock_llm: cfg.mockLlm, mock_drive: cfg.mockDrive });
}
