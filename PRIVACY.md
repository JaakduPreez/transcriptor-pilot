# Transcriptor — Data Handling & Privacy

This document is intended for IT review before the pilot phase begins.

## What data leaves the user's Mac

For each transcribe operation, the application sends data to three classes of external services:

### 1. Transcription provider (OpenAI Whisper OR AssemblyAI)
- **What's sent:** the audio file (compressed mp3, mono, adaptive bitrate)
- **Selection logic:** Whisper for files ≤ 60 minutes; AssemblyAI for longer files OR when Whisper fails / times out
- **What's returned:** transcript text + word-level timestamps
- **Vendor retention:**
  - OpenAI Whisper API: per OpenAI's [API data usage policy](https://openai.com/policies/api-data-usage-policies), API inputs are retained for up to 30 days for abuse monitoring, then deleted. Not used for model training (API ≠ ChatGPT).
  - AssemblyAI: per AssemblyAI's [security policy](https://www.assemblyai.com/security), audio is deleted from their systems within 24 hours of transcription completion. Not used for model training.

### 2. Parser + translator (Anthropic Claude)
- **What's sent:** the transcript text (no audio) + project metadata (language, project name, agent name)
- **Models:** Claude Sonnet 4.5 (long transcripts) or Claude Haiku 4.5 (short ones), auto-selected
- **What's returned:** structured rows (sentence-level original + translation + timecodes) + summary
- **Vendor retention:** Per Anthropic's [API data usage policy](https://www.anthropic.com/legal/commercial-terms), API inputs are not used for model training by default. Retention for abuse monitoring is 30 days then deletion.

### 3. OneHope's own logging (Google Apps Script + private Sheet)
- **What's sent:** anonymized usage events
  - Timestamp
  - Username (login name only — never the user's real name unless they chose it as their login)
  - Route taken (`whisper` / `assemblyai` / `claude_pdf_parse` / etc.)
  - Model used
  - Audio duration in seconds
  - Cost in USD
  - **File name** (just the filename, e.g. `Mai_Pre-Interview_Audio.m4a` — used for cost-by-file reporting)
- **What's NOT sent:** the audio itself, the transcript content, the PDF, or any user-typed text
- **Retention:** indefinitely in the OneHope-owned Sheet, accessible only to OneHope admins

## What stays on the user's Mac

- The original audio file (untouched — Transcriptor never deletes or modifies the source)
- The generated PDF, TXT, and SRT files — saved to `~/Documents/Transcriptor/<file-stem>/` by default
- Decrypted API keys — in process memory only, wiped on logout / quit / session revoke
- localStorage entries:
  - Last-used per-file language settings (24h TTL)
  - Last-shown release-notes version (so the "what's new" modal doesn't repeat)
  - Cached cost totals (for instant header-chip display on login)
  - Privacy consent acknowledgement
- macOS Keychain (admin-only, optional):
  - Sparkle Ed25519 private key (release engineer's machine only)
  - Apps Script admin token (release machine only)

## What's NOT collected

- No audio is stored on OneHope-owned servers
- No transcript content is stored on OneHope-owned servers (only cost/usage metadata)
- No screen captures, screenshots, keystroke logs, or clipboard contents
- No browser history, file-system enumeration, or data from other apps
- No third-party analytics (no Google Analytics, no Segment, no Mixpanel, no Sentry SDK)
- No persistent device identifiers (no MAC address, IDFA, etc.)

## When a user account is removed

Admin process:
1. Set `active=FALSE` in Sheet's `Users` tab (immediate effect — user locked out within 10 min)
2. Optionally delete the user row entirely (recommended for clean exit)
3. The user's historical Usage / Errors / Feedback rows remain by default for billing reconciliation. Admin can delete those manually if needed.
4. If the user was the only one in a department, the admin can remove the department from the Sheet.

If the user requests their data be removed under GDPR or similar:
- Delete their `Users` tab row
- Filter and delete their `Usage`, `Errors`, `Feedback` tab rows
- Document the deletion in a separate audit log

## Cross-border data flow

OneHope is based in South Africa; pilot users are global. Provider data flow:
- **OpenAI:** US-based (primary region). EU/UK alternatives available via API region settings if needed for GDPR.
- **AssemblyAI:** US-based.
- **Anthropic:** US-based, with EU data residency option on request.
- **Google Apps Script + Sheet:** Hosted in the Google account region of the Sheet owner (likely US or EU based on the admin's Google Workspace location).
- **GitHub Releases:** Globally CDN'd, primary in US.

If your jurisdiction requires EU-only processing, contact the admin to request a configuration change — all three providers offer EU regions on Enterprise tiers.

## Privacy disclosure shown to each user

Each pilot user sees the **🛡 How your audio is handled** modal on their first login. They must explicitly click "I understand · let's go" before they can use the app. The acknowledgement is recorded per-user in localStorage. Dismissed modal is documented but not auditable from outside the user's machine.

## Contact

For data-handling questions: Jacques du Preez · jacques_admin@onehope · OneHope Studio Team
