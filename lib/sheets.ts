/**
 * Funnel-sheet append. One row per finalized lead; the header row is written
 * automatically the first time the tab is used (mirrors reference/app/drive.py
 * append_funnel_row).
 */
import { FUNNEL_COLUMNS, cfg } from "@/lib/config";
import { sheets } from "@/lib/drive";

export async function appendFunnelRow(row: (string | number)[]): Promise<void> {
  const spreadsheetId = cfg.funnelSpreadsheetId;
  if (!spreadsheetId) throw new Error("FUNNEL_SPREADSHEET_ID is not set");
  const tab = cfg.funnelSheetTab;

  const api = sheets();
  const current = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'!A1:A1`,
  });
  const values: (string | number)[][] = current.data.values?.length
    ? [row]
    : [FUNNEL_COLUMNS, row];

  await api.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tab}'!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}
