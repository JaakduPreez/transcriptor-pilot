#!/bin/bash
# Transcriptor pilot release helper
# ----------------------------------------------------------------------------
# Usage:   ./release.sh 7.2                    # build, push, update everything
#          ./release.sh 7.2 --dry-run          # show what WOULD happen
#          ./release.sh 7.2 --notes "fix X"    # custom release notes
#
# What it does:
#   1. Cleans __pycache__ from TranscriptorV<X>.app
#   2. ditto-zips it to ~/Desktop/TranscriptorV<X>.app.zip
#   3. Computes SHA-256
#   4. Pushes a GitHub release tagged v<X> with the zip as an asset
#   5. Updates the Rebrandly link (go.vxmedia.co.za/transcriptor) → new asset
#   6. Updates the Sheet's Version tab via the admin endpoint
#   7. Prints a summary
#
# Secrets live in macOS Keychain (NOT on disk). One-time setup:
#   security add-generic-password -U -s com.onehope.transcriptor.release -a admin_token       -w 'YOUR_ADMIN_TOKEN'
#   security add-generic-password -U -s com.onehope.transcriptor.release -a rebrandly_key     -w 'YOUR_REBRANDLY_KEY'
#   security add-generic-password -U -s com.onehope.transcriptor.release -a rebrandly_link_id -w 'YOUR_REBRANDLY_LINK_ID'
#   security add-generic-password -U -s com.onehope.transcriptor.release -a apps_script_url   -w 'YOUR_APPS_SCRIPT_URL'

set -euo pipefail

# ── Read secrets from Keychain ──────────────────────────────────────────────
SVC="com.onehope.transcriptor.release"
need_kc() {
  local val
  val=$(security find-generic-password -s "$SVC" -a "$1" -w 2>/dev/null) || {
    echo "✗ Missing Keychain entry: $1 (in service $SVC)"
    echo "  Set it with: security add-generic-password -U -s $SVC -a $1 -w 'VALUE'"
    exit 1
  }
  echo "$val"
}
ADMIN_TOKEN=$(need_kc admin_token)
REBRANDLY_KEY=$(need_kc rebrandly_key)
REBRANDLY_LINK_ID=$(need_kc rebrandly_link_id)
APPS_SCRIPT_URL=$(need_kc apps_script_url)

# ── Non-secret config ───────────────────────────────────────────────────────
GITHUB_REPO="JaakduPreez/transcriptor-pilot"
APP_BASE_DIR="/Users/jacquesdupreez/OneHope Dropbox/Jacques du Preez/[01] Jacques Dropbox/[06] Jacques' Apps/[Transcriptor]/Current Working File"

# ── Args ────────────────────────────────────────────────────────────────────
VER="${1:-}"; shift || true
[ -n "$VER" ] || {
  echo "Usage: $0 <version> [--dry-run] [--notes 'text']"
  echo "  e.g. $0 7.2"
  exit 2
}

DRY=0
NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --notes)   shift; NOTES="$1" ;;
    *)         echo "Unknown arg: $1"; exit 2 ;;
  esac
  shift
done

APP_DIR="$APP_BASE_DIR/TranscriptorV${VER}.app"
ZIP="$HOME/Desktop/TranscriptorV${VER}.app.zip"
TAG="v${VER}"
DL_URL="https://github.com/$GITHUB_REPO/releases/download/$TAG/TranscriptorV${VER}.app.zip"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Releasing Transcriptor V${VER}"
echo "  app:    $APP_DIR"
echo "  zip:    $ZIP"
echo "  github: $GITHUB_REPO  →  $TAG"
echo "  dry-run: $DRY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

[ -d "$APP_DIR" ] || { echo "✗ $APP_DIR does not exist"; exit 3; }

# 1. Clean
echo "[1/6] Cleaning __pycache__ …"
[ $DRY -eq 0 ] && find "$APP_DIR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null

# 2. Zip
echo "[2/6] Building zip …"
[ $DRY -eq 0 ] && rm -f "$ZIP"
[ $DRY -eq 0 ] && (cd "$APP_BASE_DIR" && ditto -c -k --keepParent --sequesterRsrc "TranscriptorV${VER}.app" "$ZIP")
[ $DRY -eq 0 ] && ls -lh "$ZIP"

# 3. SHA-256
SHA=""
if [ $DRY -eq 0 ]; then
  SHA=$(shasum -a 256 "$ZIP" | awk '{print $1}')
  echo "[3/6] SHA-256: $SHA"
else
  SHA="<dry-run-sha-not-computed>"
  echo "[3/6] (dry-run, sha skipped)"
fi
echo

# 4. GitHub release
echo "[4/6] Pushing GitHub release $TAG …"
NOTE_TEXT="${NOTES:-Release V${VER}}

SHA-256: ${SHA}"
if [ $DRY -eq 0 ]; then
  if gh release view "$TAG" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
    echo "  Release $TAG exists — uploading + replacing asset"
    gh release upload "$TAG" "$ZIP" --repo "$GITHUB_REPO" --clobber 2>&1 | tail -3
    gh release edit  "$TAG" --repo "$GITHUB_REPO" --notes "$NOTE_TEXT" 2>&1 | tail -2
  else
    gh release create "$TAG" "$ZIP" --repo "$GITHUB_REPO" \
      --title "Transcriptor V${VER}" --notes "$NOTE_TEXT" 2>&1 | tail -3
  fi
else
  echo "  (dry-run, gh release skipped)"
fi
echo "  Asset URL: $DL_URL"
echo

# 5. Rebrandly
echo "[5/6] Updating Rebrandly link to $DL_URL …"
if [ $DRY -eq 0 ]; then
  REBRAND_RESULT=$(curl -sf -X POST "https://api.rebrandly.com/v1/links/$REBRANDLY_LINK_ID" \
    -H "Content-Type: application/json" \
    -H "apikey: $REBRANDLY_KEY" \
    -d "{\"destination\":\"$DL_URL\"}")
  if [ -n "$REBRAND_RESULT" ]; then
    NEW_DEST=$(echo "$REBRAND_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('destination','?'))")
    echo "  ✓ Rebrandly now → $NEW_DEST"
  else
    echo "  ✗ Rebrandly update failed (curl returned non-zero)"; exit 5
  fi
else
  echo "  (dry-run, Rebrandly skipped)"
fi
echo

# 6. Sheet Version tab via admin endpoint
echo "[6/6] Updating Sheet Version tab …"
if [ $DRY -eq 0 ]; then
  PY=$(command -v python3 || echo "$APP_BASE_DIR/TranscriptorV${VER}.app/Contents/Resources/venv/bin/python3")
  ADMIN_TOKEN="$ADMIN_TOKEN" \
  APPS_SCRIPT_URL="$APPS_SCRIPT_URL" \
  VER="$VER" DL_URL="$DL_URL" SHA="$SHA" NOTES_TEXT="${NOTES:-Release V$VER}" \
  "$PY" - <<'PYEOF'
import os, urllib.request, json
body = {
    "admin_token":    os.environ["ADMIN_TOKEN"],
    "current":        os.environ["VER"],
    "download_url":   os.environ["DL_URL"],
    "sha256":         os.environ["SHA"],
    "release_notes":  os.environ["NOTES_TEXT"],
    "min_supported":  os.environ["VER"],
}
data = json.dumps(body).encode()
req = urllib.request.Request(
    os.environ["APPS_SCRIPT_URL"] + "?path=admin/update_version",
    data=data, headers={"Content-Type":"application/json"})
with urllib.request.urlopen(req, timeout=20) as r:
    d = json.load(r)
print("  Sheet response:", "ok" if d.get("ok") else d)
v = d.get("version", {})
if v: print(f"  current={v.get('current')}  url={v.get('download_url','')[:60]}…")
PYEOF
else
  echo "  (dry-run, Sheet update skipped)"
fi
echo

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Release V${VER} done"
echo "  Short URL:  https://go.vxmedia.co.za/transcriptor"
echo "  GH release: https://github.com/$GITHUB_REPO/releases/tag/$TAG"
echo "  Asset:      $DL_URL"
echo "  SHA-256:    $SHA"
echo
echo "  All running apps will see the update on next launch."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
