# CDC HMS — fingerprint-scanner relay (attendance PC)

A small background program on the clinic's always-on attendance PC. It reads
punches from the **ZKTeco K40** over the clinic network and sends them to the
HMS, where they become check-ins and check-outs on HR Suite → Time & Attendance.

```
K40 scanner ──LAN, TCP 4370──> relay (attendance PC) ──HTTPS──> POST /api/hr/scanner-relay/punches
192.168.0.132                   checks every 60 s                 heartbeat → "Scanner online"
```

- **Fingerprints never leave the scanner.** The relay reads punches (user
  number, time, fingerprint or card) and the user list (number and name).
- **Nothing is deleted from the scanner.** The scanner is the queue: if the
  internet or the HMS is down, punches wait there and go on the next good
  minute. The HMS ignores any punch it already has.
- **ZKTime can keep running.** If both connect at the same moment, the relay
  waits a minute and tries again.
- The PC holds no database password, only the scanner's own key, which works
  for the relay's two endpoints and nothing else. HR can replace it at any time.
- Written in Node.js with no packages: `relay.js` (the loop) and `k40.js` (the
  scanner protocol, a port of the long-used pyzk library). It ships with its
  own `node.exe`, so the PC needs nothing installed first.

---

## 1. Register the scanner in the HMS (once)

HR Suite → Settings → Attendance → **Fingerprint scanner** (needs "HR Suite
settings"):

1. Serial number `A8N5203760092`, a name, and **Count punches from** (go-live).
2. **Register scanner** shows the **relay key once**. Copy it.

## 2. Install on the attendance PC

Run **`CDC-Scanner-Relay-Setup.exe`** (ask for the latest build, or build it
yourself: section 5). Windows may show "Windows protected your PC" because the
installer is not code-signed: click **More info → Run anyway**.

The wizard asks for the relay key, the scanner's serial number and IP address
(filled in for the clinic's K40) and the HMS address, then:

- installs to `C:\Program Files\CDC Scanner Relay\`;
- writes the settings to `C:\ProgramData\CDC Scanner Relay\config.json`;
- registers a Windows scheduled task, **CDC Scanner Relay**, that starts the
  relay with Windows (no one needs to sign in) and restarts it a minute after
  any crash;
- adds a Start-menu folder: **Check scanner connection**, **Relay log**,
  **Relay settings**, **Restart relay**, **Uninstall**.

Tick **Check the scanner connection now** on the last page. Expect:

```
Connected. Serial A8N5203760092, firmware Ver 8.0.4.2-20200723, N records, N users
Heartbeat accepted. The HMS counts punches from … onwards
```

and, within a minute, **Online** in HR Settings, with the scanner's users
listed for linking. Make sure the PC never sleeps (Settings → System → Power →
Sleep: Never); it is on a UPS already.

## 3. Link staff (HR, after the first heartbeat)

Enrol each person on the scanner with the **number part of their HMS staff ID**
(EMP005 → `5`) and their first name. The HMS proposes each match; HR clicks
**Confirm matches**. Punches made before a link count as soon as it is made.

## 4. Day to day

| What you see | What it means |
|---|---|
| HR → Time & Attendance: **Scanner online · 40 s ago** | The relay reached the scanner in the last minute. |
| **Scanner offline · last seen …** | No contact for 5 minutes: the PC is off or asleep, the relay task stopped, the scanner is unplugged, or the network is down. Punches are safe on the scanner. |
| **Scanner offline · not set up yet** | No scanner is registered in HR Settings. |
| **N punches waiting** in HR Settings | Someone on the scanner isn't linked to a staff member yet. |
| "The scanner's clock is N min fast/slow" in HR Settings | Set the time on the scanner (System → Date Time). Punch times come from its clock. |

- **Changing a setting:** Start → CDC Scanner Relay → **Relay settings**, edit,
  save, then **Restart relay** (run it as administrator).
- **Log:** `C:\ProgramData\CDC Scanner Relay\scanner-relay.log` (also in the
  Start menu). `state.json` beside it is the relay's bookmark; deleting it is
  safe (the HMS ignores repeats).
- **Uninstall:** Settings → Apps, or the Start-menu shortcut. It removes the
  task, the program and the settings file (which holds the key).

### Later: a scanner communication password

Today the scanner has no Comm Key, so any PC on the clinic network can read
it. Once the relay is running: set a numeric Comm Key on the scanner
(Comm. → PC Connection), put the same number in `config.json` as
`SCANNER_PASSWORD`, set it in ZKTime's device settings too, and restart the
relay.

## 5. Building the installer

On any machine with Node 18+, npm and NSIS 3 (`apt install nsis`,
`brew install makensis`, or nsis.sourceforge.io on Windows):

```
cd scanner-relay
node build-installer.js        →  dist/CDC-Scanner-Relay-Setup.exe
```

The Windows Node runtime comes from the `node-win-x64` npm package, pinned to
an exact version in `build-installer.js`; no Windows machine is needed to
build. Bump `version` in `package.json` for a new release; installing over an
older version keeps the existing settings.

Silent install (scripted setups): `CDC-Scanner-Relay-Setup.exe /S /KEY=<relay key> [/SERIAL=…] [/IP=…] [/API=…]`

## Settings (config.json)

| Key | Default | |
|---|---|---|
| `HMIS_API_URL` | https://api.cdiabetescentre.com/api | HMS API base, with `/api` |
| `SCANNER_KEY` | — | From HR Settings, shown once |
| `SCANNER_SERIAL` | A8N5203760092 | Must match the scanner and the HMS |
| `SCANNER_IP` / `SCANNER_PORT` | 192.168.0.132 / 4370 | Scanner menu → Comm. → Ethernet |
| `SCANNER_PASSWORD` | 0 | The scanner's Comm Key (0 = none) |
| `POLL_SECONDS` | 60 | How often to look |
| `USERS_EVERY_MINUTES` | 30 | How often to send the user list |

Running it by hand (any OS with Node): `node relay.js --check` or `node relay.js`,
with `config.json` beside it or in the folder named by `CDC_RELAY_HOME`.
