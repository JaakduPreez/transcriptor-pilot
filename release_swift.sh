#!/bin/bash
# Transcriptor — Swift wrapper release helper.
# ----------------------------------------------------------------------------
# Usage:   ./release_swift.sh 8.2                    # build, sign, push
#          ./release_swift.sh 8.2 --dry-run          # show what WOULD happen
#          ./release_swift.sh 8.2 --notes "fix bug"  # custom release notes
#
# What it does:
#   1. Bumps the Python bundle's APP_VERSION (so the in-app version tag stays in sync)
#   2. Runs ../swift/build.sh release → fresh dist/Transcriptor.app
#   3. Zips it
#   4. Signs the zip with Sparkle's sign_update (Ed25519, private key from Keychain)
#   5. Pushes the zip as an asset of the GitHub release for tag v<VER>
#   6. Regenerates ../appcast.xml with a new <item> entry — signed + sized + URL'd
#   7. Commits + pushes appcast.xml to main (so Sparkle clients see it)
#
# Prereq: ./swift/build.sh has been run at least once (Sparkle CLI tools are
#         at ./swift/build/Sparkle/bin/, public key in Info.plist).
#         macOS Keychain has the Ed25519 private key under "Sparkle Ed25519 keys".

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SWIFT_DIR="$REPO_ROOT/swift"

# ── Args ────────────────────────────────────────────────────────────────────
VER="${1:-}"; shift || true
[ -n "$VER" ] || { echo "Usage: $0 <version> [--dry-run] [--notes 'text']"; exit 2; }
DRY=0; NOTES=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1 ;;
        --notes)   shift; NOTES="$1" ;;
        *)         echo "Unknown arg: $1"; exit 2 ;;
    esac
    shift
done

NOTES_TEXT="${NOTES:-Native Swift wrapper · auto-update via Sparkle · V$VER bundle}"
GITHUB_REPO="JaakduPreez/transcriptor-pilot"
TAG="v$VER"
ZIP_NAME="Transcriptor-$VER.zip"
ZIP_PATH="$HOME/Desktop/$ZIP_NAME"
APP_PATH="$SWIFT_DIR/dist/Transcriptor.app"
APPCAST="$SCRIPT_DIR/appcast.xml"   # inside the JaakduPreez/transcriptor-pilot git repo
SIGN_TOOL="$SWIFT_DIR/build/Sparkle/bin/sign_update"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Releasing Transcriptor V$VER (Swift wrapper + Python backend)"
echo "  zip:    $ZIP_PATH"
echo "  github: $GITHUB_REPO → $TAG"
echo "  dry-run: $DRY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# ── 1. Bump Python APP_VERSION in the Current Working File bundle ──────────
PY_APP="$REPO_ROOT/Current Working File/TranscriptorV$VER.app"
if [ ! -d "$PY_APP" ]; then
    echo "✗ Python bundle not found at $PY_APP"
    echo "  Rename or create TranscriptorV$VER.app first (see release.sh for the Python release flow)."
    exit 3
fi
echo "[1/6] Python bundle: $PY_APP (V$VER)"

# ── 2. Build the Swift wrapper ─────────────────────────────────────────────
echo "[2/6] swift/build.sh release …"
[ $DRY -eq 0 ] && (cd "$SWIFT_DIR" && ./build.sh release) | tail -8
[ -d "$APP_PATH" ] || { echo "✗ build did not produce $APP_PATH"; exit 4; }

# ── 3. Zip ─────────────────────────────────────────────────────────────────
echo "[3/6] Zipping …"
[ $DRY -eq 0 ] && rm -f "$ZIP_PATH" && (cd "$SWIFT_DIR/dist" && ditto -c -k --keepParent --sequesterRsrc Transcriptor.app "$ZIP_PATH")
[ $DRY -eq 0 ] && ls -lh "$ZIP_PATH"
echo

# ── 4. Ed25519 sign ────────────────────────────────────────────────────────
echo "[4/6] Sparkle sign_update …"
SIG=""
SIZE=""
if [ $DRY -eq 0 ]; then
    [ -x "$SIGN_TOOL" ] || { echo "✗ $SIGN_TOOL missing. Run ./swift/build.sh once first to fetch Sparkle CLI tools."; exit 5; }
    SIGN_OUT=$("$SIGN_TOOL" "$ZIP_PATH" 2>&1)
    # sign_update prints something like:  sparkle:edSignature="abc…" length="12345"
    SIG=$(echo "$SIGN_OUT" | grep -oE 'sparkle:edSignature="[^"]*"' | sed 's/.*="//;s/"$//')
    SIZE=$(echo "$SIGN_OUT" | grep -oE 'length="[^"]*"' | sed 's/.*="//;s/"$//')
    [ -n "$SIG" ] || { echo "✗ Could not extract signature. sign_update output: $SIGN_OUT"; exit 6; }
    echo "      ✓ signature: ${SIG:0:24}…"
    echo "      ✓ size:      $SIZE bytes"
fi
echo

# ── 5. GitHub release ──────────────────────────────────────────────────────
echo "[5/6] GitHub release $TAG …"
NOTE_BODY="Native Swift wrapper for Transcriptor (carries Python backend V$VER inside).

$NOTES_TEXT

— Sparkle Ed25519 signature: $SIG
— Bundle size: $SIZE bytes"
if [ $DRY -eq 0 ]; then
    if gh release view "$TAG" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
        echo "  release $TAG exists — uploading + replacing asset"
        gh release upload "$TAG" "$ZIP_PATH" --repo "$GITHUB_REPO" --clobber 2>&1 | tail -3
        gh release edit  "$TAG" --repo "$GITHUB_REPO" --notes "$NOTE_BODY" 2>&1 | tail -2
    else
        gh release create "$TAG" "$ZIP_PATH" --repo "$GITHUB_REPO" \
            --title "Transcriptor V$VER (Swift)" --notes "$NOTE_BODY" 2>&1 | tail -3
    fi
fi
DL_URL="https://github.com/$GITHUB_REPO/releases/download/$TAG/$ZIP_NAME"
echo "  asset URL: $DL_URL"
echo

# ── 6. Regenerate appcast.xml ──────────────────────────────────────────────
echo "[6/6] Regenerating appcast.xml …"
if [ $DRY -eq 0 ]; then
    PUBDATE=$(date -u '+%a, %d %b %Y %H:%M:%S +0000')
    # Replace the channel body with a fresh <item>. Keeps history simple — Sparkle
    # only cares about the highest version, so a single entry is enough.
    cat > "$APPCAST" <<APPCAST_EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Transcriptor</title>
    <link>https://github.com/$GITHUB_REPO</link>
    <description>Transcribe audio with Whisper / AssemblyAI + AI-powered PDF export.</description>
    <language>en</language>
    <item>
      <title>Version $VER</title>
      <pubDate>$PUBDATE</pubDate>
      <sparkle:version>$VER</sparkle:version>
      <sparkle:shortVersionString>$VER</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <description><![CDATA[$NOTES_TEXT]]></description>
      <enclosure
        url="$DL_URL"
        sparkle:version="$VER"
        sparkle:edSignature="$SIG"
        length="$SIZE"
        type="application/octet-stream" />
    </item>
  </channel>
</rss>
APPCAST_EOF
    echo "      ✓ wrote $APPCAST"
    # Commit + push so raw.githubusercontent.com serves the fresh appcast within ~1 min
    (cd "$SCRIPT_DIR" && git add appcast.xml && git commit -m "Sparkle appcast: V$VER" >/dev/null 2>&1 && git push 2>&1 | tail -2) || \
        echo "  (no git commit — repo not initialised or no remote. Manually push appcast.xml when ready.)"
fi
echo

# ── 7. Update Rebrandly short URL → new GitHub asset ──────────────────────
echo "[7/8] Updating Rebrandly short URL …"
if [ $DRY -eq 0 ]; then
    REBRANDLY_KEY=$(security find-generic-password -s "com.onehope.transcriptor.release" -a rebrandly_key -w 2>/dev/null) || REBRANDLY_KEY=""
    REBRANDLY_LINK_ID=$(security find-generic-password -s "com.onehope.transcriptor.release" -a rebrandly_link_id -w 2>/dev/null) || REBRANDLY_LINK_ID=""
    if [ -n "$REBRANDLY_KEY" ] && [ -n "$REBRANDLY_LINK_ID" ]; then
        REBRAND_RESULT=$(curl -sf -X POST "https://api.rebrandly.com/v1/links/$REBRANDLY_LINK_ID" \
            -H "Content-Type: application/json" \
            -H "apikey: $REBRANDLY_KEY" \
            -d "{\"destination\":\"$DL_URL\"}") || REBRAND_RESULT=""
        if [ -n "$REBRAND_RESULT" ]; then
            echo "      ✓ Rebrandly now → $DL_URL"
        else
            echo "      ⚠ Rebrandly update failed — update manually if needed"
        fi
    else
        echo "      (skipped — Rebrandly Keychain entries missing)"
    fi
fi
echo

# ── 8. Bump Sheet Version tab so existing V8.1 in-app banner sees the update ───
echo "[8/8] Bumping Sheet Version tab via venv python (SSL workaround) …"
if [ $DRY -eq 0 ]; then
    ADMIN_TOKEN=$(security find-generic-password -s "com.onehope.transcriptor.release" -a admin_token -w 2>/dev/null) || ADMIN_TOKEN=""
    APPS_SCRIPT_URL=$(security find-generic-password -s "com.onehope.transcriptor.release" -a apps_script_url -w 2>/dev/null) || APPS_SCRIPT_URL=""
    VENV_PY="/Applications/Transcriptor.app/Contents/Resources/venv/bin/python3"
    if [ -x "$VENV_PY" ] && [ -n "$ADMIN_TOKEN" ] && [ -n "$APPS_SCRIPT_URL" ]; then
        ADMIN_TOKEN="$ADMIN_TOKEN" APPS_SCRIPT_URL="$APPS_SCRIPT_URL" \
        VER="$VER" DL_URL="$DL_URL" SHA="$SIG" NOTES_TEXT="$NOTES_TEXT" \
        "$VENV_PY" - <<'PYEOF'
import os, urllib.request, json
body = {
    "admin_token":    os.environ["ADMIN_TOKEN"],
    "current":        os.environ["VER"],
    "download_url":   os.environ["DL_URL"],
    "sha256":         os.environ.get("SHA", ""),
    "release_notes":  os.environ["NOTES_TEXT"],
    "min_supported":  os.environ["VER"],
}
req = urllib.request.Request(
    os.environ["APPS_SCRIPT_URL"] + "?path=admin/update_version",
    data=json.dumps(body).encode(),
    headers={"Content-Type":"application/json"})
with urllib.request.urlopen(req, timeout=20) as r:
    d = json.load(r)
print("      Sheet response ok=", d.get("ok"))
v = d.get("version", {})
if v: print(f"      current={v.get('current')}  url={v.get('download_url','')[:60]}…")
PYEOF
    else
        echo "      (skipped — venv python or Keychain entries missing)"
    fi
fi
echo

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Swift release V$VER done"
echo "  Sparkle clients see this version within ~1 hour (or on next manual Check for Updates)."
echo "  Old V8.1 browser-based pilots will auto-update via the in-app banner."
echo
echo "  GH release: https://github.com/$GITHUB_REPO/releases/tag/$TAG"
echo "  Direct DL:  $DL_URL"
echo "  Short URL:  https://go.vxmedia.co.za/transcriptor"
echo "  Appcast:    https://raw.githubusercontent.com/$GITHUB_REPO/main/appcast.xml"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
