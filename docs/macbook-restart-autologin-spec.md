# Spec: Weekly Auto-Restart + Auto-Login + Auto-Lock (this MacBook)

> **Local config — DO NOT COMMIT.** This document describes machine-specific changes to
> Ivan's MacBook (`ivan@`, Apple Silicon). It is installation-specific and references the
> local security posture. Keep it untracked (it lives in `docs/` only for convenience).
> Status: **IMPLEMENTED & VERIFIED (C1–C4).** Verified 2026-06-08 via a manual `sudo reboot`
> dry-run: no FileVault prompt → auto-login as `ivan` → screen auto-locked → Ren + Docker
> recovered. Weekly-restart daemon loaded and armed (`StartCalendarInterval` Weekday 0 / 04:00,
> `watching = 1`). First scheduled fire: the upcoming Sunday 04:00 — left as the live first run.
> Date: 2026-06-08.

---

## 1. Goal

Two pieces of "good hygiene + keep Ren alive" automation:

1. **Periodic restart** — reboot the MacBook automatically **every week, Sunday 04:00**.
2. **Unattended return to a locked-but-running state** — after the reboot the Mac should
   **auto-login**, so the GUI session comes back and **Ren (NanoClaw) + Docker auto-start**,
   then the screen should **auto-lock** so the laptop is physically secure.

Net effect: every Sunday at 04:00 the Mac reboots itself, comes back up with Ren running,
and sits on a locked screen — no human in the loop.

---

## 2. The decision that shaped this spec

Ren (`com.nanoclaw-v2-98989602`) is a **LaunchAgent** — it only runs inside a **logged-in GUI
session**. It also depends on **Docker Desktop**, a GUI app that needs a GUI session too. So
"Ren back up after reboot, unattended" requires a **GUI session to appear by itself**, which
means **auto-login**.

macOS **disables auto-login while FileVault is on** (every boot stops at the pre-boot unlock
screen). FileVault is currently **ON** on this machine.

**Chosen path (approved): disable FileVault → enable auto-login → auto-lock on login.**
Fully unattended. The cost is encryption-at-rest (see §4).

Rejected alternatives: keeping FileVault with a manual unlock tap per reboot (not unattended);
re-architecting Ren to a system LaunchDaemon + headless Colima + `fdesetup authrestart` (delivers
everything but is a multi-day, high-risk migration — overkill for weekly-restart hygiene).

---

## 3. Current machine state (verified 2026-06-08)

| Fact | Value | Relevance |
|------|-------|-----------|
| macOS | 26.3.2 (build 25D2140) | `CGSession` lock binary removed; use `pmset displaysleepnow` + immediate lock |
| Chip | Apple Silicon (arm64) | Prefer a LaunchDaemon for the scheduled restart over `pmset repeat` (AS scheduler quirks) |
| FileVault | **ON** | Must be disabled for auto-login |
| Auto-login | not set; no `/etc/kcpassword`; `DisableFDEAutoLogin` not set | Clean slate to enable |
| Account | `ivan` (short name) | auto-login user |
| Screen lock delay | **300s** (`sysadminctl -screenLock status`) | Must set to **immediate** or the auto-lock won't require a password |
| Ren launch | `~/Library/LaunchAgents/com.nanoclaw-v2-98989602.plist` (LaunchAgent, `RunAtLoad`+`KeepAlive`) | Needs GUI session; restarts itself on crash |
| Stay-awake | `com.ivan.caffeinate` (`caffeinate -disu`, `RunAtLoad`+`KeepAlive`); `SleepDisabled=1` | Machine is always awake → a 04:00 LaunchDaemon will reliably fire |
| Container runtime | Docker Desktop 29.3.1, `AutoStart: true` | Auto-launches with the GUI session; ~20–60s to become ready |
| Secrets | `/Users/ivan/.onecli` (OneCLI vault: API keys / OAuth tokens) | **On disk — unencrypted once FileVault is off** |

---

## 4. Security implications (read before implementing)

Disabling FileVault is a real downgrade. Be explicit about what you keep and what you lose:

- **Lost: encryption at rest.** A stolen or powered-off MacBook's entire disk — including
  `/Users/ivan/.onecli` (live API keys and OAuth tokens) — becomes readable by anyone who pulls
  the drive or boots from external media. The auto-lock screen does **not** protect against this;
  it only stops someone *sitting down at the running machine*.
- **Auto-login stores the password recoverably.** `/etc/kcpassword` is XOR-obfuscated with a
  well-known key — trivially reversible by anyone with disk access. (Moot once FileVault is off,
  but worth knowing.)
- **Kept: the lock screen** (the stated "security reason") — protects against a passer-by at the
  desk. This requirement is fully met.

**Recommended compensating controls (do these alongside, not instead):**

- [x] Confirm **Find My Mac** is on (remote lock / erase if stolen). ✅ verified 2026-06-08
      (`FMMEnabled = 1`; "Find My Mac: On" + "Find My network: On" in System Settings).
- [x] **Activation Lock** — armed via Find My ("This Mac cannot be erased and reactivated
      without a password"). NOTE: `system_profiler SPHardwareDataType` "Activation Lock Status"
      reads **Disabled** on a personal/unmanaged Mac by design — that field tracks only the
      MDM/enterprise-provisioned variant. The Find My anti-reactivation lock is the personal-Mac
      equivalent and is the authoritative signal. Don't chase the CLI flag.
- [ ] Consider a **recovery lock / firmware-level protection** so the disk can't be trivially
      booted from external media (Apple Silicon: Recovery + "Activation Lock"; for stronger,
      `bputil` is involved and risky — optional, advanced).
- [ ] Treat the OneCLI vault as compromised-if-stolen: rotate keys if the laptop is ever lost.
- [ ] Keep the machine **physically secured** when unattended (this is now the primary control).

If any of the above feels unacceptable, revisit the FileVault decision before proceeding.

---

## 5. Boot/restart sequence (target behaviour)

```
Sunday 04:00
  └─ LaunchDaemon (root) fires StartCalendarInterval → `shutdown -r now`
       └─ macOS reboots (in-flight agent sessions die; containers are --rm — accepted)
            └─ Boot → NO FileVault prompt → auto-login as `ivan`
                 ├─ GUI session starts
                 │    ├─ caffeinate agent re-runs (keeps Mac awake)        [RunAtLoad]
                 │    ├─ Docker Desktop auto-launches (~20–60s to ready)   [AutoStart]
                 │    └─ Ren LaunchAgent starts node dist/index.js         [RunAtLoad]
                 │         └─ (optional) waits for `docker info` before serving
                 └─ Auto-lock agent runs → display sleep + immediate lock
                      └─ Screen is LOCKED, password required; Ren keeps running.
```

Key invariant: **locking the screen does not end the GUI session** — LaunchAgents (Ren,
caffeinate) and Docker keep running while locked.

---

## 6. Implementation

Six components. Do them in order; **C1 (FileVault) before C2 (auto-login)** is mandatory.

### C1 — Disable FileVault

```bash
sudo fdesetup disable          # prompts for your login password
fdesetup status                # poll until: "FileVault is Off."
```

Decryption runs in the background and can take a while on a large disk. The Mac is usable and
rebootable meanwhile, **but do not enable auto-login (C2) until `fdesetup status` reports Off** —
otherwise the boot still stops at the FileVault screen.

### C2 — Enable auto-login for `ivan`

**Preferred (GUI — encodes `/etc/kcpassword` correctly):**
System Settings → **Users & Groups** → **Automatically log in as** → select **ivan** → enter
password. (This option only appears once FileVault is fully Off.)

**CLI alternative** (if the GUI toggle is unavailable):
```bash
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser ivan
# Then write /etc/kcpassword (XOR-obfuscated password). Use a vetted helper such as
# `kcpassword` (brew) or the GUI toggle above — do NOT hand-roll the cipher.
```

Verify after a test reboot (§7).

### C3 — Require password immediately + auto-lock on login

**C3a — make the lock actually require a password (one-time, system-wide):**
```bash
sudo sysadminctl -screenLock immediate -password -   # prompts interactively
sysadminctl -screenLock status                       # expect: "screenLock is set to immediate"
```
(Currently 300s — without this, a "locked" screen would let anyone back in for 5 minutes.)

**C3b — the auto-lock agent.** macOS 26 removed `CGSession -suspend`; the supported, no-special-
permission method is to blank the display (`pmset displaysleepnow`), which — with immediate lock
from C3a — leaves the session locked and password-gated.

Create `~/bin/autolock-on-login.sh`:
```bash
#!/bin/bash
# Give the GUI session a moment to come up, then lock.
sleep 8
/usr/bin/pmset displaysleepnow
```
```bash
chmod +x ~/bin/autolock-on-login.sh
```

Create `~/Library/LaunchAgents/com.ivan.autolock-on-login.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.ivan.autolock-on-login</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/ivan/bin/autolock-on-login.sh</string>
    </array>
    <key>RunAtLoad</key><true/>
</dict>
</plist>
```
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ivan.autolock-on-login.plist
```

> **Fallback if you want the literal lock-screen UI** (rather than display-off-then-locked):
> bind Ctrl-Cmd-Q via `osascript ... keystroke "q" using {control down, command down}`.
> This requires granting the launching process **Accessibility** permission (a one-time TCC
> prompt that doesn't auto-approve), so it's less suitable for fully-unattended use. Prefer C3b.

### C4 — Scheduled weekly restart (Sunday 04:00)

Primary mechanism: a **root LaunchDaemon**. Reliable here because the Mac is always awake
(caffeinate + `SleepDisabled=1`), and it's visible in `launchctl`.

Create `/Library/LaunchDaemons/com.ivan.weekly-restart.plist` (owner `root:wheel`, mode 644):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.ivan.weekly-restart</string>
    <key>ProgramArguments</key>
    <array>
        <string>/sbin/shutdown</string>
        <string>-r</string>
        <string>now</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key><integer>0</integer>   <!-- 0 = Sunday -->
        <key>Hour</key><integer>4</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
</dict>
</plist>
```
```bash
sudo chown root:wheel /Library/LaunchDaemons/com.ivan.weekly-restart.plist
sudo chmod 644        /Library/LaunchDaemons/com.ivan.weekly-restart.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.ivan.weekly-restart.plist
```

> **Alternative (`pmset`)** — native scheduled restart that also *wakes* the Mac if asleep:
> `sudo pmset repeat restart U 04:00:00` (U = Sunday). Cancel with `sudo pmset repeat cancel`.
> Not chosen as primary because of Apple-Silicon scheduler flakiness and because the machine is
> always awake anyway. **Pick one mechanism, not both**, to avoid double restarts.

> `shutdown -r now` is forceful — it does not wait for unsaved work. That's fine for this
> always-locked, Ren-only role; Ren's `KeepAlive` brings it back. If you later want a graceful
> drain (stop accepting messages, let in-flight sessions finish, then reboot), wrap it in a
> script the daemon calls instead of `shutdown` directly. Out of scope for v1.

### C5 — Docker readiness gate (recommended)

**Without this, Ren still recovers — but via a crash-loop.** On boot, Ren and Docker start
together. The host's startup check (`ensureContainerRuntimeRunning` → `docker info`, 10s timeout)
**throws and exits the process if Docker isn't ready yet** — it does not wait. `KeepAlive=true`
then restarts Ren every ~10s (launchd's respawn floor), each attempt re-checking `docker info`,
until Docker finishes booting (~20–60s) and the next start succeeds. So Ren **always eventually
comes up** with no permanent failure mode; the only cost is a handful of
`FATAL: Container runtime failed to start` banners in `logs/nanoclaw.error.log` during the boot
window. (Verified against `src/index.ts:86` + `src/container-runtime.ts:37`.)

This gate replaces that crash-loop with a single clean wait. Optional for correctness, recommended
for a quiet error log.

Create `~/bin/start-ren.sh`:
```bash
#!/bin/bash
DOCKER=/usr/local/bin/docker
for _ in $(seq 1 60); do
  "$DOCKER" info >/dev/null 2>&1 && break
  sleep 2
done
exec /Users/ivan/.local/share/mise/installs/node/20/bin/node \
     /Users/ivan/nanoclaw-sandbox-5296/dist/index.js
```
Then point the Ren plist's `ProgramArguments` at `/bin/bash /Users/ivan/bin/start-ren.sh`.

> **Caveat:** `com.nanoclaw-v2-98989602.plist` is generated by NanoClaw setup and may be
> regenerated on reinstall/update, which would drop this wrapper. Re-apply after any
> `/setup`/`/update-nanoclaw` that rewrites the plist. Verify the `docker` path with
> `which docker` before committing the script (Docker Desktop usually symlinks `/usr/local/bin/docker`).

### C6 — Resilience settings (optional)

```bash
sudo pmset -a autorestart 1     # auto-restart after a power failure (good for always-on)
# Turn off "Reopen windows when logging back in" so the reboot doesn't repopulate the desktop:
#   System Settings → General → Login (or the shutdown dialog checkbox).
```
caffeinate already re-runs at login (`RunAtLoad`), so stay-awake survives the reboot — no change.

---

## 7. Verification plan

Test **before** trusting the Sunday schedule. Do a manual reboot dry-run:

1. **FileVault off:** `fdesetup status` → "FileVault is Off."
2. **Auto-login + auto-lock:** `sudo reboot`. Expect: no FileVault prompt → desktop logs in by
   itself → within ~8s the display blanks and the screen is locked. Move the mouse → it asks for
   the password immediately (not after 5 min).
3. **Ren is alive while locked:** unlock, then:
   ```bash
   launchctl print gui/$(id -u)/com.nanoclaw-v2-98989602 | grep -i state   # running
   docker info >/dev/null 2>&1 && echo "docker ok"
   tail -n 30 /Users/ivan/nanoclaw-sandbox-5296/logs/nanoclaw.log
   ```
   Send a test message to Ren and confirm it responds (proves Docker + Ren both came up).
4. **Scheduled restart fires:** temporarily set the daemon to ~3 min out — edit `Hour`/`Minute`
   to the next clock minute, `sudo launchctl bootout system ...` then `bootstrap` again, and watch
   it reboot. Then restore to Sunday 04:00 and re-bootstrap.
5. **Confirm the daemon is loaded:** `sudo launchctl print system/com.ivan.weekly-restart`.

---

## 8. Rollback

```bash
# Re-enable encryption
sudo fdesetup enable

# Disable auto-login
sudo defaults delete /Library/Preferences/com.apple.loginwindow autoLoginUser
sudo rm -f /etc/kcpassword

# Restore screen-lock delay (e.g. immediate is fine to keep; to revert to 5 min:)
sudo sysadminctl -screenLock 300 -password -

# Remove auto-lock agent
launchctl bootout gui/$(id -u)/com.ivan.autolock-on-login
rm -f ~/Library/LaunchAgents/com.ivan.autolock-on-login.plist ~/bin/autolock-on-login.sh

# Remove scheduled restart
sudo launchctl bootout system/com.ivan.weekly-restart
sudo rm -f /Library/LaunchDaemons/com.ivan.weekly-restart.plist
# (if you used pmset instead:) sudo pmset repeat cancel

# Revert Ren wrapper (if C5 applied): point the plist back at node dist/index.js directly.
sudo pmset -a autorestart 0     # if you set it
```

---

## 9. Edge cases & maintenance

- **Account password change** breaks auto-login → re-run C2. (Also breaks `/etc/kcpassword`.)
- **macOS major updates** may reset login-window prefs and can require interactive auth at the
  update reboot — the scheduled restart won't interfere, but the *update's own* reboot may pause.
  Re-verify §7 after big updates.
- **NanoClaw reinstall/update** may regenerate the Ren plist and drop the C5 wrapper → re-apply.
- **Restart colliding with a scheduled agent task** at 04:00 — check NanoClaw's recurrence/cron
  schedule; nudge the restart time if something important runs then.
- **Forceful reboot loses in-flight sessions** — accepted; KeepAlive + `--rm` containers mean a
  clean restart, no orphan cleanup needed.
- **Don't run both** the LaunchDaemon (C4) and `pmset repeat restart` — duplicate reboots.

---

## 10. Open items to confirm on this machine

- [ ] `which docker` path for the C5 wrapper (assumed `/usr/local/bin/docker`).
- [ ] Confirm `pmset displaysleepnow` + immediate lock yields an acceptable "locked" feel for you
      (display off → password on wake). If you want the literal lock-screen UI, decide on the
      Accessibility-permission Ctrl-Cmd-Q fallback (§C3b note).
- [ ] Decide whether to also enable C5 (Docker gate) and C6 (power-loss autorestart), or keep v1
      minimal (C1–C4 only).
- [ ] Confirm the compensating security controls in §4 are in place before going live.

---

## 11. Implementation checklist (minimal v1 = C1–C4)

- [x] C1 — `sudo fdesetup disable`, wait for "FileVault is Off." ✅ (FileVault Off)
- [x] C2 — enable auto-login for `ivan` (GUI). ✅ (`autoLoginUser = ivan`, `/etc/kcpassword` written)
- [x] C3a — `sudo sysadminctl -screenLock immediate -password -`. ✅ (screenLock immediate)
- [x] C3b — auto-lock agent (`~/bin/autolock-on-login.sh` + plist + bootstrap). ✅ (active)
- [x] C4 — weekly-restart LaunchDaemon (Sunday 04:00) + bootstrap. ✅ (loaded, `watching = 1`)
- [x] §7 — manual reboot dry-run. ✅ 2026-06-08, full sequence worked. (Near-time schedule
      test skipped by choice — Sunday 04:00 is the live first run.)
- [x] §4 — compensating security controls (partial). ✅ Find My Mac + Find My network on;
      anti-reactivation lock armed. ⬜ recovery/firmware boot lock (optional, advanced).
      📋 Key-rotation-if-stolen plan written — see §12.
- [ ] (optional) C5 Docker gate, C6 power-loss autorestart. ← not applied (v1 minimal C1–C4).

---

## 12. Key-rotation checklist — if this laptop is lost or stolen

> **Why this exists.** FileVault is OFF (§4). A powered-off or drive-pulled MacBook exposes the
> entire disk. The screen lock and Find My anti-reactivation lock do **not** protect data at rest.
> Assume everything below is readable by the thief the moment they have the disk — so the only real
> mitigation is to **revoke and reissue** these credentials fast. Verified surface as of 2026-06-08.

### What's exposed on disk (in rough order of blast radius)

| # | Credential | Where on disk | Why it matters |
|---|-----------|---------------|----------------|
| 1 | **macOS login password** | `/etc/kcpassword` (XOR-obfuscated, trivially reversible) | Unlocks the **login keychain** (Safari/system saved passwords). If you reuse this password anywhere, treat all those accounts as exposed. |
| 2 | **OneCLI vault secrets** | Docker volume `onecli_pgdata` (Postgres; compose defaults creds to `onecli`/`onecli`) | Holds the real **Anthropic API key** (`api.anthropic.com`) and any **Google OAuth tokens** (Gmail/Calendar, via the stub bridge — fetched from this vault at request time). |
| 3 | **OneCLI agent access tokens** | same Postgres volume; also printed by `onecli agents list` | `aoc_…` tokens for **Default Agent** + **Ren** — each is `secretMode: all`, so the token is a skeleton key to every vault secret via the gateway. |
| 4 | **Telegram bot token** | `.env` → `TELEGRAM_BOT_TOKEN` (cleartext) | Full control of the Ren bot: read/send as the bot, hijack the channel. |
| 5 | **login keychain** | `~/Library/Keychains/` (unlocked by #1) | Whatever Safari/apps saved. |
| 6 | **iCloud session** | signed-in Mac | Anti-reactivation lock limits *device reuse*; remote-wipe via Find My. Change Apple ID password if you suspect session theft. |

### Rotation order (do top-down — most reused / widest blast radius first)

- [ ] **1. macOS login password** — change it immediately (any other Mac/iPhone, or iCloud).
      *Also* change it anywhere you reused it. This invalidates the stolen `/etc/kcpassword`.
- [ ] **2. Apple ID password** + sign the lost Mac out of iCloud (icloud.com → Find Devices →
      Erase, then Remove from account). Confirms remote wipe + cuts its iCloud session.
- [ ] **3. Anthropic API key** — console.anthropic.com → API keys → **revoke** the leaked key,
      issue a new one. Then update the OneCLI vault:
      `onecli secrets …` (or web UI http://127.0.0.1:10254) → replace the `Anthropic` secret
      (id `6f1d495c-…`) on the **new** machine. Ren can't talk to Claude until this is replaced.
- [ ] **4. Google OAuth (if Gmail/Calendar tools were ever wired)** — myaccount.google.com →
      Security → **Third-party access** → remove the OneCLI/app grant. This revokes the refresh
      token so the stolen access tokens die. Re-consent on the new machine if you still want the tools.
- [ ] **5. OneCLI agent tokens** — regenerate/rotate the `Default Agent` and `Ren` access tokens
      (web UI → Agents, or recreate the agents). The old `aoc_…` values become useless.
- [ ] **6. Telegram bot token** — Telegram → **@BotFather** → `/revoke` → `/token` for the Ren
      bot. Put the new token in `.env` `TELEGRAM_BOT_TOKEN` on the new machine and restart Ren.
- [ ] **7. Any password stored in the login keychain** that you care about — rotate per-service.

### Make recovery faster (do these now, before anything happens)

- [ ] Keep this list current: re-run `onecli secrets list` / `onecli agents list` after adding any
      new integration, and add the new credential to the table above.
- [x] **DONE 2026-06-08 — hardened the Postgres role password** off the `onecli`/`onecli` default
      to a 48-hex random value. Done by `ALTER USER onecli WITH PASSWORD …` inside the live DB,
      saved to `/Users/ivan/.onecli/.env` (`POSTGRES_PASSWORD=…`, mode 600) so compose substitutes
      it into both the postgres env and the onecli `DATABASE_URL`, then `docker compose up -d`.
      **Scope — be precise:** this only gates **live network connections** to the DB. `pg_hba.conf`
      is `trust` for localhost/socket and `scram-sha-256` for other hosts; the onecli container and
      any host process reaching the published `127.0.0.1:5432` port arrive as non-localhost → now
      need the new password instead of the default. It does **NOT** protect **data at rest** — a
      disk thief reads the `onecli_pgdata` volume files directly (plaintext, password-irrelevant).
      The at-rest exposure is unchanged; the rotation plan above remains the real mitigation.
- [ ] Strongly consider: **don't reuse the macOS login password anywhere else.** That single
      reuse is what turns "stolen laptop" into "stolen everything" via #1.
