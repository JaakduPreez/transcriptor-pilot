# Transcriptor — Security Model

This document is intended for IT review before the pilot phase begins.

## Threat model

Transcriptor sits between three classes of asset:

| Asset | Where it lives | Risk if compromised |
|---|---|---|
| Org API keys (OpenAI / Anthropic / AssemblyAI) | Encrypted inside the .app bundle | Attacker could rack up API charges and exfiltrate transcripts |
| User account credentials | Sheet's `Users` tab (hashed) | Unauthorized access to API keys via login |
| Audio + transcript content | In-flight to providers, locally on user's Mac | PII / sensitive personal stories disclosed to unintended parties |
| Sparkle update channel | GitHub Releases | Attacker could push a malicious update to all pilot users |

## Protections

### Org API keys at rest
- Stored in `Contents/Resources/encrypted_keys.bin` inside the .app bundle.
- AES-256-GCM encryption (via `cryptography` library, NIST-validated).
- Decryption passphrase lives in the Sheet's `Pilot` tab.
- The passphrase is **never bundled into the .app** — it's fetched at login time only.
- Decrypted keys live in process memory (`PILOT_KEYS` dict). Wiped from memory on logout or session revoke.
- A leaked .app bundle alone is useless to an attacker — they'd also need the Sheet passphrase.

### User authentication
- Username + SHA-256(password) sent to Apps Script `/login`.
- Apps Script compares hash against the Sheet's `Users` tab. No plaintext password ever transmitted or stored.
- On success, Apps Script issues a session token (UUIDv4 + UUIDv4 concatenated, 64 hex chars). 6-hour TTL via CacheService.
- Session token is required for every subsequent endpoint call.

### Account revocation
- Admin sets `active=FALSE` in Sheet's Users tab.
- Within ≤ 10 minutes, the running app's heartbeat detects the change and `_wipe_pilot_keys()` clears the decrypted keys from memory.
- The user is immediately logged out at the UI level.

### Pilot-wide kill switch
- Admin sets `kill_switch=TRUE` in Sheet's `Pilot` tab.
- All users lose access at next heartbeat (≤ 10 min).
- Login attempts return `pilot_terminated`.
- Used for incident response, end-of-pilot cleanup, or any other emergency.

### Auto-update integrity
- Sparkle (the de-facto macOS auto-updater) checks `https://raw.githubusercontent.com/JaakduPreez/transcriptor-pilot/main/appcast.xml` hourly.
- Each release zip is signed with an **Ed25519 private key** held only in the release engineer's macOS Keychain.
- The corresponding public key is embedded in the .app's `Info.plist` (`SUPublicEDKey`).
- Sparkle refuses to install any update whose Ed25519 signature doesn't verify against that public key. A compromised GitHub account cannot push a malicious update without the private key.

### Local-only Flask backend
- The Python backend binds to `127.0.0.1` only — never `0.0.0.0`.
- The Swift wrapper picks a random free port at runtime so two users on the same machine don't collide.
- The backend is reachable only from the same Mac — never from the LAN or internet.

### Code signing posture
- Pilot builds: **ad-hoc signed** (no Apple Developer ID). First-launch users see Gatekeeper's "developer cannot be verified" warning; right-click → Open dismisses it once.
- Production roadmap: When OneHope obtains an Apple Developer ID, builds will be signed + notarized so Gatekeeper accepts the .app without a warning on any Mac.
- The library-validation entitlement is disabled (`com.apple.security.cs.disable-library-validation`) so the ad-hoc signature can load the embedded Sparkle framework. This is the standard pattern for non-Developer-ID macOS apps and does not weaken any other protection.

## What this app does NOT do

- No telemetry beyond explicit logged events (no screen captures, keystrokes, clipboard scraping, browser-history reads)
- No background tasks while the app is closed
- No phone-home outside the documented endpoint list (see [NETWORK.md](./NETWORK.md))
- No data collected from other applications on the user's Mac
- No third-party analytics, ad SDKs, or fingerprinting libraries
- No persistent identifiers beyond the username

## Audit access for IT

Admins can review at any time:

| Sheet tab | What it contains |
|---|---|
| `Users` | Account roster + last_seen timestamps |
| `Usage` | Every transcribe / parse event with cost + audio duration |
| `Errors` | Every backend exception (anonymized: no audio, no transcript) |
| `Feedback` | User-submitted bug reports / suggestions / failure reports |
| `Version` | Current release version, SHA-256, release notes |

The same data is exportable as CSV from the in-app admin dashboard (Admin → 👥 Users / 💰 Billing / ⚠ Errors → 📥 Export CSV).

## Incident response

Documented inline at: **Admin → 🛡 For IT** tab inside the app. Summary:

1. **Compromised account** → flip `active=FALSE` in Sheet, ≤10 min global propagation
2. **Compromised API key** → rotate at vendor, regenerate `encrypted_keys.bin` + bump passphrase, ship new release
3. **Halt pilot** → flip `kill_switch=TRUE`
4. **Compromised release machine** → regenerate Sparkle keypair, re-sign all releases

## Contact

Jacques du Preez · jacques_admin · OneHope Studio Team
