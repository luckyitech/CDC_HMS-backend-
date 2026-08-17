# HMIS V4 — DICOM Bridge (clinic PC)

Headless service that receives ultrasound images from the **Samsung HS70A**
over DICOM on the clinic LAN, converts them to PNG, and uploads them to the
CDC HMS API over HTTPS. Images then appear automatically on the patient's
chart (Ultrasound tab) in the HMIS.

```
HS70A ──DICOM C-STORE (LAN, port 11112)──> Bridge (this PC)
                                              │  save raw .dcm  (incoming/)
                                              │  convert → PNG
                                              │  queue (queue/) — survives offline periods
                                              └──HTTPS──> POST /api/ultrasound/ingest
```

The clinic PC never holds database credentials — only the `INGEST_API_KEY`
shared secret, which authorizes exactly one endpoint (image ingest).

---

## 1. Install (Windows, once)

1. Install **Python 3.11+** from python.org (tick *"Add python.exe to PATH"*).
2. Copy this `bridge/` folder to e.g. `C:\hmis-bridge\`.
3. In a Command Prompt:

   ```bat
   cd C:\hmis-bridge
   python -m venv venv
   venv\Scripts\pip install -r requirements.txt
   copy .env.example .env
   notepad .env
   ```

4. In `.env`, set `INGEST_API_KEY` to the same value configured in the
   server's `backend/.env` (generate once with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

5. Test run:

   ```bat
   venv\Scripts\python main.py
   ```

   You should see: `DICOM bridge listening on 0.0.0.0:11112 (AE: WARDPC)`.

### Verify DICOM connectivity (no ultrasound machine needed)

From another prompt on the same PC:

```bat
venv\Scripts\python -c "from pynetdicom import AE; from pynetdicom.sop_class import Verification; ae=AE(); ae.add_requested_context(Verification); a=ae.associate('127.0.0.1',11112); print('C-ECHO:', a.send_c_echo()); a.release()"
```

Expect `C-ECHO: (0000, 0900) Status ... 0x0000`.

## 2. Windows firewall + network

- Give this PC a **static LAN IP** (or a DHCP reservation on the router).
- Allow inbound TCP 11112:

  ```bat
  netsh advfirewall firewall add rule name="HMIS DICOM bridge" dir=in action=allow protocol=TCP localport=11112
  ```

## 3. Configure the HS70A (once)

On the ultrasound machine: **Utility → Setup → Connectivity** → add a
**Storage** destination:

| Setting | Value |
|---|---|
| Host / IP | the clinic PC's static IP |
| Port | `11112` |
| AE Title | `WARDPC` |

Run the machine's DICOM **Ping / Verify** — it must succeed before scanning.

**Workflow rule for sonographers:** type the patient's **UHID** into the
HS70A's *Patient ID* field when starting a study. Images with a wrong or
missing UHID still upload, but land in the HMIS **Admin → Ultrasound Queue**
for manual linking instead of appearing on the chart automatically.

## 4. Run as a Windows service (auto-start)

Using [NSSM](https://nssm.cc/) (simplest reliable way):

```bat
nssm install HmisDicomBridge C:\hmis-bridge\venv\Scripts\python.exe C:\hmis-bridge\main.py
nssm set HmisDicomBridge AppDirectory C:\hmis-bridge
nssm set HmisDicomBridge Start SERVICE_AUTO_START
nssm start HmisDicomBridge
```

(Alternative without NSSM: Task Scheduler → *At startup* → run
`C:\hmis-bridge\venv\Scripts\python.exe C:\hmis-bridge\main.py`, "whether
user is logged on or not".)

## 5. Operations

- **Logs:** `bridge.log` in the bridge folder.
- **Raw archive:** every received study is kept as `.dcm` + `.png` under
  `incoming\<PatientID>\`. Prune periodically (external drive/backup) —
  the server keeps its own copy of every uploaded PNG.
- **Offline behaviour:** if the internet is down, uploads wait in `queue\`
  and retry every 60 s. Nothing is lost; the queue drains when the
  connection returns. Duplicate retries are harmless (the server dedupes on
  SOP Instance UID).
- **Key rotation:** change `INGEST_API_KEY` in the server `backend/.env`
  AND this PC's `.env`, restart both (`pm2 restart cdc-hms-api` server-side,
  `nssm restart HmisDicomBridge` here).

## 6. Troubleshooting

| Symptom | Check |
|---|---|
| HS70A Verify fails | bridge running? firewall rule? IP/port/AE match? |
| Images stay in `queue\` | `bridge.log`: HTTP 401 = key mismatch; 503 = key unset on server; network errors = internet down |
| Image on chart but wrong patient | sonographer typed the wrong UHID — admin can archive it and re-link via the Ultrasound Queue |
| Cine clips look like stills | by design (v1): the middle frame is extracted and flagged `CLIP` in the UI |
