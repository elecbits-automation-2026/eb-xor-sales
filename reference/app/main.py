"""FastAPI app — API + the XOR chat page.

Endpoints
  GET  /                      the chat page (web/index.html)
  POST /api/chat              conversation turns (ChatIn → ChatOut)
  POST /api/upload            multipart file upload for the EMS checklist
  GET  /api/download/...      generated artifacts (LLD draft)
  GET  /healthz               liveness probe
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import config, orchestrator, sessions
from .flows import EMS_CHECKLIST
from .models import ChatIn, ChatOut

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("xor.main")

app = FastAPI(title="Elecbits XOR Intake Bot", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

WEB_DIR = config.BASE_DIR / "web"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "mock_llm": config.MOCK_LLM, "mock_drive": config.MOCK_DRIVE}


@app.post("/api/chat", response_model=ChatOut)
def chat(inp: ChatIn) -> ChatOut:
    return orchestrator.handle(inp)


@app.post("/api/upload", response_model=ChatOut)
async def upload(session_id: str = Form(...),
                 item_key: str = Form(...),
                 file: UploadFile = File(...)) -> ChatOut:
    item = next((i for i in EMS_CHECKLIST if i["key"] == item_key), None)
    if item is None:
        raise HTTPException(400, "unknown checklist item")

    original = Path(file.filename or "upload.bin").name
    safe = _SAFE_NAME.sub("_", original)[:120] or "upload.bin"

    if item["accept"] != "*":
        allowed = tuple(e.strip().lower() for e in item["accept"].split(","))
        if not safe.lower().endswith(allowed):
            raise HTTPException(
                415, f"{item['label']} should be one of: {item['accept']}")

    s = sessions.get(session_id)
    dest_dir = config.UPLOADS_DIR / s["id"]
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{item_key}--{safe}"

    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    written = 0
    with open(dest, "wb") as out:
        while chunk := await file.read(1024 * 1024):
            written += len(chunk)
            if written > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File exceeds {config.MAX_UPLOAD_MB} MB")
            out.write(chunk)
    log.info("upload session=%s item=%s file=%s bytes=%d", s["id"], item_key, safe, written)
    return orchestrator.handle_upload(s["id"], item_key, safe, str(dest))


@app.get("/api/download/{session_id}/{filename}")
def download(session_id: str, filename: str):
    s = sessions.get(session_id)
    safe = _SAFE_NAME.sub("_", Path(filename).name)
    if s.get("lld_file") != safe:
        raise HTTPException(404, "not found")
    path = config.GENERATED_DIR / safe
    if not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="text/markdown", filename=safe)


@app.exception_handler(Exception)
async def unhandled(request, exc):  # noqa: ANN001
    log.exception("unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "internal error"})
