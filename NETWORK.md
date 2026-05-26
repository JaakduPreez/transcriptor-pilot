# Transcriptor — Network Requirements

This is the firewall / proxy allowlist that IT needs to configure for pilot users.

## Outbound HTTPS (443) endpoints

| Endpoint | Purpose | Frequency | Critical? |
|---|---|---|---|
| `api.openai.com` | Whisper transcribe API (files ≤ 60 min) | Per transcribe of short/medium audio | Yes — primary transcription path |
| `api.assemblyai.com` | AssemblyAI transcribe API (long files, fallback) | Per transcribe of long audio OR Whisper failure | Yes — primary path for >60 min audio |
| `api.anthropic.com` | Claude API (parse + translate) | Per file that produces a PDF or SRT | Yes — no PDF/SRT export without it |
| `script.google.com` | OneHope's Google Apps Script web app (auth, heartbeat, usage logging, kill switch) | Every login + every 10 min heartbeat + every transcribe | Yes — no login without it |
| `raw.githubusercontent.com` | Sparkle appcast.xml (auto-update manifest) | Hourly while app is open | No — failure just delays updates |
| `github.com` (releases CDN) | Sparkle .app.zip downloads (auto-update binary) | Only when user accepts an update | No — only needed for updates |
| `go.vxmedia.co.za` | OneHope's branded short URL (redirects to GitHub for first install) | Once per fresh install | No — direct GitHub URL also works |
| `objects.githubusercontent.com` | GitHub Releases CDN backing assets | During update download | No — same as github.com |

## Outbound HTTP (port 80)

**None.** The application uses only HTTPS for all external traffic.

## Inbound connections

**None.** The application accepts no inbound connections from any network interface. The internal Flask backend binds exclusively to `127.0.0.1` (the loopback interface) and is reachable only by the WKWebView running in the same process.

## Local TCP (loopback only)

| Port | Direction | Purpose |
|---|---|---|
| `127.0.0.1:<dynamic>` | Swift wrapper ↔ Python backend | Picked at runtime by the OS — a different free port each launch. Never bound to a public interface. Never exposed to the LAN. |

## DNS

The application performs DNS lookups for the endpoints listed above. No custom DNS, no DoH/DoT requirements.

## Proxy support

The application uses the system's default networking stack (Python's `httpx` library + macOS `URLSession`). Both respect macOS system proxy settings:

- HTTP proxy (`HTTP_PROXY` / `HTTPS_PROXY` env vars OR System Settings → Network → Proxies)
- PAC (Proxy Auto-Config) files
- Per-domain proxy exclusions

If your environment uses TLS-intercepting proxies, the proxy's CA certificate must be installed in the system keychain. The bundled Python uses the system trust store via `httpx`.

## Bandwidth profile (typical pilot user)

| Action | Outbound | Inbound | Wall clock |
|---|---|---|---|
| Login | ~2 KB | ~1 KB | <1 s |
| Heartbeat | ~500 B | ~200 B | <1 s, every 10 min |
| Transcribe 5-min audio (Whisper) | ~7 MB audio | ~50 KB transcript | 30-60 s |
| Transcribe 90-min audio (AssemblyAI) | ~50 MB audio | ~200 KB transcript | 2-5 min |
| Claude parse (90-min transcript, chunked) | ~70 KB × 6 calls | ~250 KB PDF | 3-7 min |
| Auto-update download | — | ~22 MB (.app.zip) | 5-30 s |

Heavy users (long interviews daily) consume ~1-5 GB outbound + ~500 MB inbound per month, almost entirely audio uploads to the transcription providers.

## Verifying the allowlist

After IT configures the firewall:

1. Open Transcriptor → login as the test account
2. The login itself confirms `script.google.com` is reachable
3. Click the cost-burn chip to fetch usage totals — confirms heartbeat path
4. Drop a 30-second test audio file (provided in `test_media/1_short_english_30sec.m4a`)
5. Click "Make transcripts" → confirms `api.openai.com` + `api.anthropic.com` are reachable
6. Wait for the result → confirms outputs save locally
7. Admin → 🛡 For IT tab → click any GitHub link → confirms `github.com` is reachable (for auto-update path)

If any step fails, the in-app failure UI shows the exact error (including the unreachable hostname) — that goes straight to the Errors tab for IT review.

## Contact

Network questions: Jacques du Preez · jacques_admin@onehope · OneHope Studio Team
