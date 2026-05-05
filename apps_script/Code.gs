/**
 * Transcriptor Pilot — Apps Script web app
 * ----------------------------------------------------------------------------
 * 5 endpoints, all backed by Sheet reads/writes.  Deploy as:
 *   Deploy → New deployment → Type: Web app
 *     Execute as: Me (your account)
 *     Who has access: Anyone
 *   → copy the /macros/s/{ID}/exec URL into the desktop app's pilot_config.json
 *
 * Endpoints (URL-routed via ?path= or POSTed JSON's `path` field):
 *   POST  ?path=login        { username, password_sha256 }
 *   POST  ?path=heartbeat    { session_token }
 *   POST  ?path=usage        { session_token, route, model, in_tok, out_tok, audio_secs, cost_usd, file_name }
 *   POST  ?path=error        { session_token, version, route, error_type, message, stack }
 *   GET   ?path=version
 *
 * NOTE: Apps Script web apps don't support real REST routing — we use ?path= as
 * the discriminator in both GET (e=event.parameter) and POST (e.parameter or
 * the JSON body).  The desktop app sets the path in the URL.
 */

// ── Sheet plumbing ──────────────────────────────────────────────────────────
const SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const TAB = {
  USERS:   'Users',
  USAGE:   'Usage',
  ERRORS:  'Errors',
  VERSION: 'Version',
  PILOT:   'Pilot',
};

function _sheet(name) {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s) throw new Error(`Tab "${name}" not found in sheet`);
  return s;
}

function _rows(name) {
  // Returns array of {colName: value} objects keyed by header row
  const sh = _sheet(name);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function _appendRow(name, obj) {
  const sh = _sheet(name);
  const headers = sh.getDataRange().getValues()[0];
  const row = headers.map(h => obj[h] != null ? obj[h] : '');
  sh.appendRow(row);
}

function _updateUserField(username, field, value) {
  const sh = _sheet(TAB.USERS);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const userIdx = headers.indexOf('username');
  const fieldIdx = headers.indexOf(field);
  if (userIdx < 0 || fieldIdx < 0) return false;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][userIdx]).toLowerCase() === String(username).toLowerCase()) {
      sh.getRange(r + 1, fieldIdx + 1).setValue(value);
      return true;
    }
  }
  return false;
}

// ── Pilot config helpers ─────────────────────────────────────────────────────
function _pilotConfig() {
  const rows = _rows(TAB.PILOT);
  return rows[0] || {};
}

function _isKilled() {
  const cfg = _pilotConfig();
  const k = String(cfg.kill_switch || '').toUpperCase();
  return k === 'TRUE' || k === 'YES' || k === '1';
}

function _passphrase() {
  return String(_pilotConfig().key_passphrase || '');
}

// ── Token helpers ────────────────────────────────────────────────────────────
// Sessions are stored in Apps Script's CacheService (24h TTL) keyed by token.
// Value = JSON {username, expires_at}.  No DB needed — sessions are ephemeral.
const SESSION_TTL_SECS = 6 * 3600;  // 6h

function _newToken() {
  const bytes = Utilities.getUuid().replace(/-/g, '');
  return bytes + Utilities.getUuid().replace(/-/g, '');
}

function _saveSession(token, username) {
  const cache = CacheService.getScriptCache();
  cache.put(`s:${token}`, JSON.stringify({
    username,
    expires_at: Date.now() + SESSION_TTL_SECS * 1000,
  }), SESSION_TTL_SECS);
}

function _getSession(token) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(`s:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// ── Endpoint handlers ───────────────────────────────────────────────────────

function _login(body) {
  if (_isKilled()) return { error: 'pilot_terminated' };
  const username = String(body.username || '').trim().toLowerCase();
  const pwHash = String(body.password_sha256 || '').trim().toLowerCase();
  if (!username || !pwHash) return { error: 'missing_credentials' };
  const users = _rows(TAB.USERS);
  const user = users.find(u => String(u.username || '').trim().toLowerCase() === username);
  if (!user) return { error: 'invalid_credentials' };
  const userActive = String(user.active || '').toUpperCase() === 'TRUE' ||
                     String(user.active || '').toUpperCase() === 'YES';
  if (!userActive) return { error: 'account_revoked' };
  const stored = String(user.password_sha256 || '').trim().toLowerCase();
  if (!stored || stored !== pwHash) return { error: 'invalid_credentials' };
  // Issue session
  const token = _newToken();
  _saveSession(token, username);
  // Stamp last_seen
  _updateUserField(username, 'last_seen', new Date().toISOString());
  return {
    session_token: token,
    key_passphrase: _passphrase(),
    valid_until: new Date(Date.now() + SESSION_TTL_SECS * 1000).toISOString(),
    user: {
      name:       user.name       || username,
      username:   username,
      department: user.department || '',
    },
  };
}

function _heartbeat(body) {
  const sess = _getSession(body.session_token);
  if (!sess) return { error: 'no_session' };
  if (_isKilled()) return { error: 'pilot_terminated' };
  // Re-check the user is still active
  const users = _rows(TAB.USERS);
  const user = users.find(u => String(u.username || '').trim().toLowerCase() === sess.username);
  if (!user) return { error: 'user_removed' };
  const userActive = String(user.active || '').toUpperCase() === 'TRUE' ||
                     String(user.active || '').toUpperCase() === 'YES';
  if (!userActive) return { error: 'account_revoked' };
  _updateUserField(sess.username, 'last_seen', new Date().toISOString());
  return { ok: true };
}

function _usage(body) {
  const sess = _getSession(body.session_token);
  if (!sess) return { error: 'no_session' };
  _appendRow(TAB.USAGE, {
    ts: new Date().toISOString(),
    username: sess.username,
    route: body.route || '',
    model: body.model || '',
    input_tokens: Number(body.input_tokens || 0),
    output_tokens: Number(body.output_tokens || 0),
    audio_secs: Number(body.audio_secs || 0),
    cost_usd: Number(body.cost_usd || 0),
    file_name: body.file_name || '',
  });
  return { ok: true };
}

function _error(body) {
  // Errors don't require a valid session — we want to capture pre-login errors too
  const username = (_getSession(body.session_token) || {}).username || '(anon)';
  _appendRow(TAB.ERRORS, {
    ts: new Date().toISOString(),
    username,
    version: body.version || '',
    route: body.route || '',
    error_type: body.error_type || '',
    message: String(body.message || '').slice(0, 500),
    stack_truncated: String(body.stack || '').slice(0, 2000),
  });
  return { ok: true };
}

function _version() {
  const rows = _rows(TAB.VERSION);
  const v = rows[0] || {};
  return {
    current:        String(v.current || '0'),
    download_url:   String(v.download_url || ''),
    sha256:         String(v.sha256 || ''),
    release_notes:  String(v.release_notes || ''),
    min_supported:  String(v.min_supported || '0'),
  };
}

// ── HTTP routing ────────────────────────────────────────────────────────────

function doGet(e) {
  const path = (e.parameter || {}).path || 'version';
  if (path === 'version') return _json(_version());
  return _json({ error: `unknown_path:${path}` }, 404);
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return _json({ error: 'bad_json' }, 400);
  }
  const path = (e.parameter || {}).path || body.path || '';
  let result;
  switch (path) {
    case 'login':     result = _login(body);     break;
    case 'heartbeat': result = _heartbeat(body); break;
    case 'usage':     result = _usage(body);     break;
    case 'error':     result = _error(body);     break;
    case 'version':   result = _version();       break;
    default:          return _json({ error: `unknown_path:${path}` }, 404);
  }
  return _json(result);
}

function _json(obj, status) {
  // Apps Script doesn't expose response status codes via ContentService — clients
  // detect errors via the `error` field in the JSON body instead.
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Helper: hash a password (run from the script editor by you, the admin) ──
// Usage: select sha256_for_admin in the editor → Run → check "View → Logs" for the hash.
function sha256_for_admin() {
  // Edit this string, save, run, check logs.  Then paste the hash into the Users tab.
  const password = 'CHANGE_ME';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  const hex = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  Logger.log(`SHA-256 for "${password}":  ${hex}`);
  return hex;
}
