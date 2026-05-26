# IT Demo — Walkthrough for the Transcriptor Pilot

A 15–20 minute scripted demo. Each section maps to a question IT is likely to ask.

---

## 0. Before they arrive (2 min prep)

- Open **Finder** in two windows:
  - `~/Documents/Transcriptor/` (currently empty — you'll show outputs landing here)
  - `[Transcriptor]/test_media/` (the four sample audio files)
- Have your browser ready with three tabs:
  - https://github.com/JaakduPreez/transcriptor-pilot
  - https://github.com/JaakduPreez/transcriptor-pilot/blob/main/SECURITY.md
  - https://go.vxmedia.co.za/transcriptor  *(don't click yet — you'll show the redirect)*
- Quit any open Transcriptor windows so first-launch is fresh
- Have the demo Google Sheet open in another tab (Users + Usage tabs visible)

---

## 1. "What does the user actually see?" (2 min)

1. Open **Finder** → drag `Transcriptor.app` from `~/Downloads/` (or wherever you've installed it). It's just a regular .app — same as any Mac application.
2. Double-click the icon → first-launch Gatekeeper warning ("developer cannot be verified"). **This is expected for a pilot.** Right-click → **Open** → click Open in the prompt. Done forever for this user.
3. Native window appears. Show:
   - Title bar reads **Transcriptor V8.2 · OneHope** (not a Safari/Chrome tab — this is a real macOS app)
   - Dock icon at the bottom
   - Cmd+Q quits cleanly (don't actually do it — just point it out)
4. **🛡 Privacy disclosure modal** pops up automatically on first login per user. Read it aloud — IT sees the app explicitly names every third-party service that touches audio. Click **I understand · let's go**.

> **Talking point**: "OneHope built this on top of a tiny SwiftUI shell so the experience is a real Mac app. But the engine inside is our existing Python code, so we can keep iterating fast. Sparkle handles the auto-updates."

---

## 2. "Where does the audio go?" (3 min)

1. Click the **🛠 Admin** chip in the header (top-right, only visible to admins like Jacques)
2. Click the **🛡 For IT** tab inside the drawer

This single screen answers most of IT's questions:
- **Data flow diagram** — show the ASCII flow chart
- **Network endpoints table** — *"These are the only hostnames you'll need to allowlist"* (read off the 8 URLs)
- **What's protected and how** — point to: AES-256-GCM encrypted keys, SHA-256 hashed passwords, Ed25519 signed updates, no audio retained on OneHope servers
- **Incident response** — emphasise the ≤10 min kill switch propagation

> **Talking point**: "Everything IT needs to allowlist is on this screen. The same content is also in SECURITY.md, PRIVACY.md, and NETWORK.md at the repo root — IT can review those offline."

---

## 3. "Can you actually transcribe something?" (4 min)

1. Close the admin drawer
2. From Finder, drag **`test_media/1_smoke_test_english_20sec.m4a`** into the drop zone
3. Watch the pre-flight chip: `✓ Whisper-safe · ~0.4 MB @ 96k`
4. Section 2 (Languages): English (already set as default)
5. Section 5 (Outputs): PDF + Raw .txt ticked
6. Section 7 (Save to): show that it defaults to `~/Documents/Transcriptor`
7. Click **✨ Make transcripts** (the bottom button)
8. Show the progress bar moving — `Converting → Transcribing → Parsing with Claude…` (animated shimmer bar)
9. ~45 seconds later: ✅ Done

Switch to the Finder window showing `~/Documents/Transcriptor/`:
- New folder `1_smoke_test_english_20sec/` appeared automatically
- Inside: `1_smoke_test_english_20sec_transcript.pdf` + `_transcript.txt`
- Double-click the PDF → opens in Preview. Show the OneHope-branded header, speaker labels, timecodes.

> **Talking point**: "Files save locally to `~/Documents/Transcriptor` by default. Nothing is uploaded back to OneHope. The PDF you just saw was rendered on your Mac from JSON that Claude returned — no copy of either lives on a OneHope server."

---

## 4. "Multi-speaker reconciliation" (3 min)

This is the headline AI feature — Whisper + AssemblyAI + Claude in concert.

1. Drag in **`test_media/4_multispeaker_25sec.m4a`**
2. Section 2: tick **Multiple speakers (High Accuracy)**
3. Click Make
4. Show that **both** Whisper *and* AssemblyAI run in parallel (cost chip updates with two providers' contributions)
5. Claude reconciles the two transcripts — picks the better word in places where they disagree

When done, open the PDF. Show the two distinct speakers ("Speaker A" / "Speaker B") with proper turn-taking and timecodes.

> **Talking point**: "Whisper is great at vocabulary, AssemblyAI is great at diarization (who said what when). Claude reconciles them. For sensitive interviews where accuracy matters, we get the best of both."

---

## 5. "What about long files or other languages?" (2 min — optional but impressive)

If you have your Vietnamese 90-min file:

1. Drag in `~/Desktop/Files Download/Mai Pre-Interview Audio.m4a`
2. Show the chip turns amber: `📡 Will use AssemblyAI · 90+ min (>60 min)`
3. **Point out (don't run)**: *"For files over 60 min we automatically use AssemblyAI because Whisper has a 25 MB cap. For files where Claude's parse output would exceed its 64K token limit, we chunk the transcript at paragraph boundaries and process each chunk separately. Both paths transparent to the user."*

If short on time, skip the live run — just show the chip changing colour and explain.

> **Talking point**: "We've tested with Vietnamese, Spanish, French. Whisper auto-detects 99 languages. The translation column is Claude — which handles low-resource languages much better than older translation APIs."

---

## 6. "How do you control access?" (3 min)

Open the Google Sheet in your second browser tab:

1. **Users tab** — show the 4 active users (Jacques_Admin, Dana_Heaney, Valeria_Ramirez, Chris_Chavann)
2. **Demonstrate revocation**:
   - Flip Dana_Heaney's `active` cell to FALSE
   - *"This is the kill switch. Dana's app will detect this within 10 minutes via the heartbeat. New transcribes will be rejected immediately. Keys will be wiped from memory."*
   - Flip it back to TRUE for the demo
3. **Pilot tab** — show the `kill_switch` column. *"If we ever need to stop ALL pilot users at once — a security incident, end-of-pilot — we flip this to TRUE and within 10 minutes everyone is locked out."*

Back in Transcriptor, switch to the **🛠 Admin** drawer:
- **👥 Users tab** — same data as the Sheet, plus password hashes (truncated by default, click 👁 to reveal). Click **📥 Export CSV** → file downloads. *"For SIEM ingestion or quarterly audits."*
- **💰 Billing tab** — cost broken down per department. *"This is how we'd split the bill between Comms and Studio teams."*
- **⚠ Errors tab** — every backend exception, with `📥 Export CSV` and `🤖 Copy as Claude report` (handy for getting AI help on debugging).

> **Talking point**: "Every user action is logged. Nothing happens in this app without an audit trail."

---

## 7. "What if the GitHub repo gets compromised?" (2 min)

Show the **🛡 For IT** tab again, specifically the "Update binaries (Sparkle .app.zip)" row:

> *"Each update zip is signed with an Ed25519 private key that lives ONLY on my Mac's Keychain — never on GitHub, never on the Sheet, never in code. The public key is embedded in the .app's Info.plist. Sparkle refuses to install any update whose signature doesn't verify against that public key. Even with full GitHub takeover, an attacker can't push a malicious update without the private key."*

Then click **App menu → Check for Updates…** (top of the screen, under the Apple logo):
- Native macOS update dialog appears
- "You're up to date" (or "V8.3 available" if you've shipped a newer version)

> **Talking point**: "This is the same auto-update framework Slack, Notion, Linear, Discord, every non-App-Store Mac app uses. It's been around for 20+ years."

---

## 8. "How do users actually install this?" (1 min)

In the browser:

1. Open https://go.vxmedia.co.za/transcriptor → it redirects to the latest GitHub release
2. The .zip downloads (~24 MB)
3. Double-click to extract → drag Transcriptor.app to /Applications
4. Right-click → Open (Gatekeeper first-launch warning)
5. They're in

For pilot rollout: just send the short URL `go.vxmedia.co.za/transcriptor` + their login credentials from the Sheet.

> **Talking point**: "No MDM push needed. No Apple Configurator. Each user downloads the same way they'd install any open-source Mac app."

---

## 9. Anticipated questions + crisp answers

| Q | A |
|---|---|
| "Is it code-signed?" | Ad-hoc signed today (pilot phase). We'll get an Apple Developer ID ($99/yr) for production so the Gatekeeper warning disappears. Auto-updates work regardless via Sparkle's Ed25519. |
| "Is it sandboxed?" | No — we need full disk access for the user's output folder. The Python backend binds to `127.0.0.1` only, never the LAN. |
| "Does the app run when closed?" | No. Cmd+Q kills both processes cleanly. No login items, no LaunchAgents, no background daemons. |
| "How long is data retained?" | Audio: never stored on OneHope side. Transcript: never stored. Cost/usage metadata: indefinitely in our private Sheet. Vendor retention: 30 days at OpenAI/Anthropic for abuse monitoring, 24 hours at AssemblyAI. |
| "GDPR / personal data?" | Per the PRIVACY.md doc, we never store the audio or transcript. If a user requests deletion, we delete their Users row + their Usage/Errors/Feedback rows. Vendors purge per their own policies. |
| "Network bandwidth?" | Heavy users: ~1–5 GB outbound, ~500 MB inbound per month. Almost entirely audio uploads. NETWORK.md has the detailed table. |
| "What if a user loses their Mac?" | Their session token expires after 6 hours. Admin sets active=FALSE in Users tab — within 10 minutes the app on the lost Mac wipes the decrypted API keys from memory. The Sparkle signed-update mechanism prevents anyone from injecting a malicious app via the lost machine. |
| "Can users transcribe audio they shouldn't?" | The privacy consent modal makes them acknowledge that audio leaves their Mac for processing. We can't technically prevent it — that's an HR/policy matter. |
| "What's the failure mode for the AI providers being down?" | Whisper → automatic fallback to AssemblyAI. Both down → user sees a clear failure with the actual error message + a one-click "Report failure" button. Claude down → no PDF, but raw transcript still saved as .txt. |

---

## 10. After the demo

1. Send IT the three repo docs:
   - https://github.com/JaakduPreez/transcriptor-pilot/blob/main/SECURITY.md
   - https://github.com/JaakduPreez/transcriptor-pilot/blob/main/PRIVACY.md
   - https://github.com/JaakduPreez/transcriptor-pilot/blob/main/NETWORK.md
2. Send the install link: https://go.vxmedia.co.za/transcriptor
3. If they want to test as a non-admin user: ask them for a username (e.g. `it_test`), add a row in the Users tab with a hash generated via `printf 'Password' | shasum -a 256`. Set department to `TEST`. They can log in immediately — no app re-install needed.

---

## Closing line

> "The pilot phase is exactly this — a small, controlled group, full audit trail, instant kill switch, and you (IT) have read every line of what data leaves the Mac before any audio gets uploaded. If something looks wrong, the four of you can have us shut down in 10 minutes."
