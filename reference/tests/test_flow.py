"""End-to-end tests in mock mode — no keys, no network.

Drives all three tracks through the real API surface and asserts the
backbone side-effects: mock Drive folder, intake summary, funnel row, LLD.
"""
import os
import re
import tempfile

# Must be set BEFORE importing the app — config reads env at import time.
os.environ["MOCK_LLM"] = "true"
os.environ["MOCK_DRIVE"] = "true"
os.environ["XOR_DATA_DIR"] = tempfile.mkdtemp(prefix="xor-test-")

from fastapi.testclient import TestClient  # noqa: E402

from app import config  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app, raise_server_exceptions=True)

CONTACT = {"name": "Arjun Mehta", "company": "Acme Devices",
           "email": "arjun@acme.in", "phone": "+91 9876543210"}


def _chat(**payload):
    r = client.post("/api/chat", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def _start(text):
    opened = _chat(kind="open")
    sid = opened["session_id"]
    assert opened["messages"] and opened["widgets"][0]["type"] == "chips"
    res = _chat(session_id=sid, kind="text", text=text)
    return sid, res


def _through_contact(sid, res):
    assert res["meta"]["state"] == "TRACK_CONFIRM", res
    res = _chat(session_id=sid, kind="chip", chip_id="confirm:yes")
    assert res["meta"]["state"] == "CONTACT"
    res = _chat(session_id=sid, kind="form",
                form={"form_id": "contact", "values": CONTACT})
    return res


def test_odm_flow_produces_lld_and_funnel_row():
    sid, res = _start("I have an idea for a GPS tracker I want you to design")
    assert res["meta"]["track"] is None  # not locked until confirmed
    res = _through_contact(sid, res)
    assert res["meta"]["state"] == "ODM_SLOTS"

    answers = ["4G GPS tracker for fleet two-wheelers",
               "GPS+4G, CAN interface, IP67, 3-day battery",
               "5k first run, 50k per year", "under Rs 1200", "prototypes in 8 weeks",
               "India first, BIS + AIS-140", "similar to existing trackers on Flipkart"]
    for ans in answers:
        res = _chat(session_id=sid, kind="text", text=ans)
    assert res["meta"]["state"] == "ODM_REVIEW"
    assert any(w["type"] == "card" for w in res["widgets"])

    res = _chat(session_id=sid, kind="chip", chip_id="lld:generate")
    assert res["meta"]["state"] == "DONE"
    dl = [l for w in res["widgets"] if w["type"] == "card"
          for l in w.get("links", []) if "download" in l["url"]]
    assert dl, "LLD download link missing"
    r = client.get(dl[0]["url"])
    assert r.status_code == 200 and "LLD Draft" in r.text

    # backbone side-effects
    assert config.MOCK_FUNNEL_CSV.exists()
    rows = config.MOCK_FUNNEL_CSV.read_text().strip().splitlines()
    assert rows[0].startswith("Timestamp")
    assert "Acme Devices" in rows[-1]
    assert re.search(r"XOR-\d{8}-\d{3}", rows[-1])
    folders = list(config.MOCK_DRIVE_DIR.glob("XOR-*Acme Devices"))
    assert folders and (folders[0] / "00-Intake").exists()
    summaries = list(folders[0].glob("00-Intake/*intake-summary.md"))
    assert summaries and "New product design (ODM)" in summaries[0].read_text()


def test_ems_flow_collects_files_and_details():
    sid, res = _start("I have gerbers and BoM ready, need PCB assembly for 5000 units")
    res = _through_contact(sid, res)
    assert res["meta"]["state"] == "EMS_CHECKLIST"
    assert any(w["type"] == "upload" and w["item"]["key"] == "bom"
               for w in res["widgets"])

    # wrong extension is refused with a clear error
    r = client.post("/api/upload",
                    data={"session_id": sid, "item_key": "bom"},
                    files={"file": ("virus.exe", b"nope", "application/octet-stream")})
    assert r.status_code == 415

    r = client.post("/api/upload",
                    data={"session_id": sid, "item_key": "bom"},
                    files={"file": ("acme-bom.xlsx", b"fake-xlsx", "application/vnd.ms-excel")})
    assert r.status_code == 200
    res = r.json()
    assert any(w["type"] == "upload" and w["item"]["key"] == "gerber"
               for w in res["widgets"])

    r = client.post("/api/upload",
                    data={"session_id": sid, "item_key": "gerber"},
                    files={"file": ("fab_rev3.zip", b"fake-zip", "application/zip")})
    res = r.json()

    for key in ("pnp", "assembly", "cad", "test_fw"):
        res = _chat(session_id=sid, kind="chip", chip_id=f"skip:{key}")
    assert res["meta"]["state"] == "EMS_DETAILS"

    res = _chat(session_id=sid, kind="form",
                form={"form_id": "ems_details",
                      "values": {"quantity": "5,000 + 25k/yr",
                                 "target_date": "pilot by November",
                                 "notes": "ENIG finish, 4 layers"}})
    assert res["meta"]["state"] == "DONE"

    folders = sorted(config.MOCK_DRIVE_DIR.glob("XOR-*Acme Devices"))
    intake = folders[-1] / "00-Intake"
    names = {p.name for p in intake.iterdir()}
    assert any("acme-bom.xlsx" in n for n in names)
    assert any("fab_rev3.zip" in n for n in names)
    summary = next(p for p in intake.iterdir() if "summary" in p.name).read_text()
    assert "uploaded" in summary and "skipped" in summary
    last_row = config.MOCK_FUNNEL_CSV.read_text().strip().splitlines()[-1]
    assert "Manufacturing (EMS)" in last_row and "2" in last_row


def test_product_flow():
    sid, res = _start("do you sell soundbox devices off the shelf")
    res = _through_contact(sid, res)
    assert res["meta"]["state"] == "PRODUCT_CATEGORY"
    res = _chat(session_id=sid, kind="chip", chip_id="cat:epay")
    assert res["meta"]["state"] == "PRODUCT_DETAILS"
    res = _chat(session_id=sid, kind="form",
                form={"form_id": "product_details",
                      "values": {"quantity": "500", "timeline": "8 weeks",
                                 "customization": "white-label branding"}})
    assert res["meta"]["state"] == "DONE"
    last_row = config.MOCK_FUNNEL_CSV.read_text().strip().splitlines()[-1]
    assert "Ready products" in last_row and "E-payment" in last_row


def test_question_then_manual_track():
    opened = _chat(kind="open")
    sid = opened["session_id"]
    res = _chat(session_id=sid, kind="text", text="what certifications do you have")
    # QUESTION → answered + track chips re-offered
    assert any(w["type"] == "chips" for w in res["widgets"])
    res = _chat(session_id=sid, kind="chip", chip_id="track:ODM")
    assert res["meta"]["state"] == "CONTACT"


def test_contact_validation_rejects_bad_email():
    sid, res = _start("please design and develop a new smart plug product for us")
    assert res["meta"]["state"] == "TRACK_CONFIRM"
    _chat(session_id=sid, kind="chip", chip_id="confirm:yes")
    res = _chat(session_id=sid, kind="form",
                form={"form_id": "contact",
                      "values": {**CONTACT, "email": "not-an-email"}})
    assert "valid email" in res["messages"][0]
    # still on the contact step, form re-offered
    assert any(w["type"] == "form" for w in res["widgets"])
