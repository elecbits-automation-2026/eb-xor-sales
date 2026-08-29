"""Google Drive + Sheets backbone.

Every finalized intake produces:
  • an account folder  <Lead ID> <Company>/  under ACCOUNTS_PARENT_FOLDER_ID,
    with the standard sub-folders (00-Intake … 04-Quotes-Orders),
  • the customer's uploads + intake-summary.md (+ LLD draft) in 00-Intake/,
  • one appended row in the funnel sheet.

Mock mode (MOCK_DRIVE=true) mirrors all of that under ./data/mock_drive and
./data/mock_funnel.csv so the flow can be demoed and tested without Google
credentials. Both implementations expose the same interface.
"""
from __future__ import annotations

import csv
import logging
import shutil
from pathlib import Path

from . import config

log = logging.getLogger("xor.drive")


class MockDrive:
    """Local-disk stand-in for Drive/Sheets."""

    def ensure_account_folder(self, lead_id: str, company: str) -> dict:
        safe = "".join(c for c in f"{lead_id} {company}" if c not in '\\/:*?"<>|').strip()
        root = config.MOCK_DRIVE_DIR / safe
        for sub in config.ACCOUNT_SUBFOLDERS:
            (root / sub).mkdir(parents=True, exist_ok=True)
        return {"folder_id": str(root), "folder_url": f"mock://{safe}"}

    def upload_file(self, folder: dict, local_path: str, name: str, subfolder: str = "00-Intake") -> str:
        dest = Path(folder["folder_id"]) / subfolder / name
        shutil.copyfile(local_path, dest)
        return str(dest)

    def write_text(self, folder: dict, name: str, text: str, subfolder: str = "00-Intake") -> str:
        dest = Path(folder["folder_id"]) / subfolder / name
        dest.write_text(text, encoding="utf-8")
        return str(dest)

    def append_funnel_row(self, row: list) -> None:
        new = not config.MOCK_FUNNEL_CSV.exists()
        with open(config.MOCK_FUNNEL_CSV, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(config.FUNNEL_COLUMNS)
            w.writerow(row)

    def fetch_templates(self) -> list[dict]:
        return [
            {"name": "Level-wise BoM template", "url": "#"},
            {"name": "Supplier self-assessment", "url": "#"},
            {"name": "RFI FAQ", "url": "#"},
        ]


class GoogleDrive:
    """Real Drive/Sheets client via a service account.

    Setup: create a service account, enable Drive + Sheets APIs, share the
    accounts parent folder AND the funnel spreadsheet with the service
    account's client_email as Editor. supportsAllDrives is set everywhere so
    Shared Drives work too.
    """

    SCOPES = ["https://www.googleapis.com/auth/drive",
              "https://www.googleapis.com/auth/spreadsheets"]

    def __init__(self) -> None:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        creds = service_account.Credentials.from_service_account_file(
            config.GOOGLE_SERVICE_ACCOUNT_FILE, scopes=self.SCOPES)
        self.drive = build("drive", "v3", credentials=creds, cache_discovery=False)
        self.sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)

    # -- folders ----------------------------------------------------------
    def _create_folder(self, name: str, parent: str) -> str:
        meta = {"name": name, "mimeType": "application/vnd.google-apps.folder",
                "parents": [parent]}
        f = self.drive.files().create(body=meta, fields="id",
                                      supportsAllDrives=True).execute()
        return f["id"]

    def ensure_account_folder(self, lead_id: str, company: str) -> dict:
        parent = config.DRIVE_IDS["accounts_parent"]
        if not parent:
            raise RuntimeError("ACCOUNTS_PARENT_FOLDER_ID is not set")
        root_id = self._create_folder(f"{lead_id} {company}".strip(), parent)
        subs = {}
        for sub in config.ACCOUNT_SUBFOLDERS:
            subs[sub] = self._create_folder(sub, root_id)
        return {"folder_id": root_id, "subfolders": subs,
                "folder_url": f"https://drive.google.com/drive/folders/{root_id}"}

    # -- files ------------------------------------------------------------
    def upload_file(self, folder: dict, local_path: str, name: str, subfolder: str = "00-Intake") -> str:
        from googleapiclient.http import MediaFileUpload

        parent = folder.get("subfolders", {}).get(subfolder, folder["folder_id"])
        media = MediaFileUpload(local_path, resumable=True)
        f = self.drive.files().create(
            body={"name": name, "parents": [parent]},
            media_body=media, fields="id, webViewLink",
            supportsAllDrives=True).execute()
        return f.get("webViewLink", f["id"])

    def write_text(self, folder: dict, name: str, text: str, subfolder: str = "00-Intake") -> str:
        from googleapiclient.http import MediaInMemoryUpload

        parent = folder.get("subfolders", {}).get(subfolder, folder["folder_id"])
        media = MediaInMemoryUpload(text.encode("utf-8"), mimetype="text/markdown")
        f = self.drive.files().create(
            body={"name": name, "parents": [parent]},
            media_body=media, fields="id, webViewLink",
            supportsAllDrives=True).execute()
        return f.get("webViewLink", f["id"])

    # -- funnel sheet ------------------------------------------------------
    def append_funnel_row(self, row: list) -> None:
        sid = config.DRIVE_IDS["funnel_spreadsheet"]
        if not sid:
            raise RuntimeError("FUNNEL_SPREADSHEET_ID is not set")
        tab = config.DRIVE_IDS["funnel_tab"]
        rng = f"'{tab}'!A1"
        current = self.sheets.spreadsheets().values().get(
            spreadsheetId=sid, range=f"'{tab}'!A1:A1").execute()
        values = [row]
        if not current.get("values"):
            values = [config.FUNNEL_COLUMNS, row]
        self.sheets.spreadsheets().values().append(
            spreadsheetId=sid, range=rng, valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS", body={"values": values}).execute()

    # -- templates the bot can offer --------------------------------------
    def fetch_templates(self) -> list[dict]:
        tid = config.DRIVE_IDS["templates"]
        if not tid:
            return []
        res = self.drive.files().list(
            q=f"'{tid}' in parents and trashed=false",
            fields="files(id,name,webViewLink)",
            supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
        return [{"name": f["name"], "url": f.get("webViewLink", "#")}
                for f in res.get("files", [])]


_backbone = None


def backbone():
    """Singleton accessor; orchestrator treats failures as non-fatal."""
    global _backbone
    if _backbone is None:
        _backbone = MockDrive() if config.MOCK_DRIVE else GoogleDrive()
    return _backbone
