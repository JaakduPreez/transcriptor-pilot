# Transcriptor V7.0 — Pilot Control

This folder is the **admin control plane** for the Transcriptor V7.0 pilot.
It contains the Apps Script source, the Sheet template, and the encryption
helper for the org API keys.

You only need to do steps 1–3 once. After that, day-to-day pilot admin is just
editing the Google Sheet (add/remove users, see usage, see errors, push updates).

---

## Step 1 — Create the Google Sheet (5 min)

1. Open <https://sheets.new> while logged into your OneHope Google account.
2. Rename the spreadsheet to **Transcriptor Pilot Control**.
3. Create 5 tabs (rename Sheet1 + add 4 more): `Users`, `Usage`, `Errors`, `Version`, `Pilot`.
4. Open `template_sheet.csv` in this folder. Copy each header row into row 1 of the matching tab.
   - For the `Users`, `Version`, and `Pilot` tabs, also copy the example data row.
   - Replace `Pilot2026Spring!ChangeThisToSomethingLong` with your actual passphrase (16+ chars).
   - Leave `download_url` and `sha256` placeholders for now — we fill them after building the .app.
5. **Note the spreadsheet ID** — the long string in the URL between `/d/` and `/edit`. We'll need it.

---

## Step 2 — Deploy the Apps Script (5 min)

1. In the Sheet, go to **Extensions → Apps Script**. A new tab opens.
2. Delete the placeholder `Code.gs` and **paste the full contents of `apps_script/Code.gs`**.
3. Click the gear ⚙️ on the left → toggle **Show "appsscript.json" manifest file in editor**.
4. Open `appsscript.json` and replace its contents with `apps_script/appsscript.json` from this folder.
5. Save (Cmd+S).
6. Click **Deploy → New deployment**.
   - **Type**: Web app
   - **Description**: `Transcriptor Pilot v1`
   - **Execute as**: **Me** (your email)
   - **Who has access**: **Anyone**
   - Click **Deploy**.
7. **Authorize** when prompted (Google will warn it's "unverified" — proceed because you trust yourself).
8. Copy the **Web app URL** that ends in `/macros/s/{long-id}/exec`. **Save this URL** — we'll bake it into V7.0.

To re-deploy later (e.g., after editing `Code.gs`):
**Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.

The URL stays the same across re-deployments of the same deployment ID.

---

## Step 3 — Add yourself as a user

1. In the Apps Script editor, find the function `sha256_for_admin` at the bottom of `Code.gs`.
2. Edit the line `const password = 'CHANGE_ME';` to your chosen password.
3. Click ▶ **Run**.
4. **View → Logs** (or `Cmd+Enter` to open the bottom panel).
5. You'll see something like: `SHA-256 for "your-password":  e3b0c44…`
6. Copy that hex string.
7. In the Sheet's **Users** tab, fill in your row:
   - `name`: your full name
   - `username`: short login (lowercase, no spaces)
   - `password_sha256`: the hex you just copied
   - `department`: e.g., Studio
   - `active`: `TRUE`
   - `created`: today's date

Repeat for each pilot user. **Always change `CHANGE_ME` and re-run** for each user, then paste the hash into their row.

---

## Step 4 — Encrypt the org API keys (5 min, one-time)

1. `cd` into this `keys/` folder.
2. `cp keys_plaintext.example.json keys_plaintext.json`
3. Edit `keys_plaintext.json` with your real OneHope master keys for OpenAI, Anthropic, and AssemblyAI.
4. Make sure the `cryptography` package is installed in the venv used by V7.0:
   ```
   /Users/jacquesdupreez/Desktop/Transcriptor\ App/Current\ Working\ File/TranscriptorV7.0.app/Contents/Resources/venv/bin/pip install cryptography
   ```
   (V6.5's venv already has it; the duplicate inherits it.)
5. Run the encryptor (use the SAME passphrase you put into the Sheet's Pilot tab):
   ```
   /Users/jacquesdupreez/Desktop/Transcriptor\ App/Current\ Working\ File/TranscriptorV7.0.app/Contents/Resources/venv/bin/python3 \
     encrypt_keys.py \
     --in keys_plaintext.json \
     --out "/Users/jacquesdupreez/Desktop/Transcriptor App/Current Working File/TranscriptorV7.0.app/Contents/Resources/encrypted_keys.bin" \
     --passphrase "Pilot2026Spring!ChangeThisToSomethingLong"
   ```
6. Verify the file landed:
   ```
   ls -lh "/Users/jacquesdupreez/Desktop/Transcriptor App/Current Working File/TranscriptorV7.0.app/Contents/Resources/encrypted_keys.bin"
   ```
7. **Securely delete `keys_plaintext.json`** when done (or keep locally; never commit, never share).

---

## Step 5 — Tell V7.0 where the Apps Script lives

The desktop app reads `Contents/Resources/pilot_config.json` on launch. Edit it:

```json
{
  "apps_script_url": "https://script.google.com/macros/s/PASTE_YOUR_URL_HERE/exec",
  "heartbeat_secs": 600
}
```

Save the file and rebuild the `.app.zip` for distribution.

---

## Day-to-day pilot admin

| What you want | Where to do it |
|---|---|
| Add a new pilot user | Generate hash in Apps Script editor, append a row in Users tab |
| Remove a user (revoke access) | Set their `active` to `FALSE` — they get kicked within ~10 min |
| See who's using the app | Sort the Usage tab by `ts` desc |
| Bill a department | Filter Usage tab by `department` (join via username), sum `cost_usd` |
| See errors / crashes | Sort the Errors tab by `ts` desc |
| Push a new app version | Build new .app.zip → upload → update `current` + `download_url` + `sha256` in Version tab |
| End the pilot for everyone instantly | Set `kill_switch` to `TRUE` in the Pilot tab |
| Rotate the org API keys | Generate new keys at the vendors → re-encrypt with NEW passphrase → push new app version → update Pilot tab `key_passphrase` |

---

## Security notes

- The Apps Script runs as YOUR Google account — anyone calling the URL is acting on your behalf only inside the Sheet.
- Passwords are stored as SHA-256 hashes (not reversible by casual inspection), but use unique passwords because there's no salt.
- The org API keys are AES-256-GCM encrypted in the .app bundle. The decryption passphrase is fetched from the Sheet only after a successful login. A determined user with debugger access can extract the keys at runtime — this is "casual obfuscation," not bulletproof DRM.
- If a pilot user's machine gets compromised: revoke them on the Sheet (`active=FALSE`), then rotate the org API keys + bump the passphrase + push a new app version. Their old extracted keys become worthless.
