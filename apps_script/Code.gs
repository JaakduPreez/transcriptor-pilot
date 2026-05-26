/**
 * Transcriptor Pilot — Apps Script web app
 *
 * ⚠ WHEN EDITING THIS FILE: bump CODE_GS_VERSION below by one AND redeploy
 *   (Deploy → Manage deployments → ✏️ → Version: New version → Deploy).
 *   The admin dashboard shows this value so admins can verify what's actually
 *   deployed without opening the Apps Script editor.
 *
 * Version history:
 *   v1-v3 — initial pilot scaffolding (login, heartbeat, usage, errors, feedback)
 *   v4    — V7.7: _usage_totals (per-user week/month/all-time aggregation)
 *   v5    — V8.1: _active_users (public list for login dropdown), `today` field
 *           in _usage_totals, session-based admin endpoints (users / errors /
 *           dept_billing / sheet_url), MIGRATE_consolidate_test_users one-shot
 *   v6    — V8.1.5: today_by_route + today_by_route_count in _usage_totals so the
 *           cost popover can show a today-by-action breakdown (whisper / assemblyai /
 *           ha_* / claude_pdf_parse) instead of the Orphan section
 */
const CODE_GS_VERSION = '6';

/**
 * Transcriptor Pilot — Apps Script web app (v2)
 * ----------------------------------------------------------------------------
 * Deploy as:
 *   Deploy → New deployment → Type: Web app
 *     Execute as: Me (your account)
 *     Who has access: Anyone
 *   → copy the /macros/s/{ID}/exec URL into the desktop app's pilot_config.json
 *
 * Endpoints (URL-routed via ?path= or POSTed JSON's `path` field):
 *
 *   PUBLIC (no admin token):
 *     POST  ?path=login        { username, password_sha256 }
 *     POST  ?path=heartbeat    { session_token }
 *     POST  ?path=usage        { session_token, route, model, in_tok, out_tok, audio_secs, cost_usd, file_name }
 *     POST  ?path=error        { session_token, version, route, error_type, message, stack }
 *     POST  ?path=feedback     { session_token, category, message, version, current_tab }
 *     GET   ?path=version
 *
 *   ADMIN (require admin_token matching ADMIN_TOKEN script property):
 *     POST  ?path=admin/add_user        { admin_token, name, username, password_sha256, department }
 *     POST  ?path=admin/remove_user     { admin_token, username }
 *     POST  ?path=admin/set_active      { admin_token, username, active }
 *     POST  ?path=admin/list_users      { admin_token }
 *     POST  ?path=admin/update_version  { admin_token, current, download_url, sha256, release_notes, min_supported }
 *     POST  ?path=admin/set_kill_switch { admin_token, kill_switch }
 *     POST  ?path=admin/list_feedback   { admin_token, since_iso }
 *     POST  ?path=admin/list_errors     { admin_token, since_iso }
 *
 * SETUP (one-time):
 *   1. Project Settings (gear) → Script Properties → Add property:
 *        Name:  ADMIN_TOKEN
 *        Value: (a long random string — share with your admin only)
 *   2. Add a new tab to your Sheet called "Feedback" with columns:
 *        ts | username | category | message | app_version | current_tab
 *   3. Re-deploy: Deploy → Manage deployments → ✏️ → Version: New version → Deploy
 */

// ── Sheet plumbing ──────────────────────────────────────────────────────────
const SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const TAB = {
  USERS:    'Users',
  USAGE:    'Usage',
  ERRORS:   'Errors',
  VERSION:  'Version',
  PILOT:    'Pilot',
  FEEDBACK: 'Feedback',
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

// V8.0.6: PUBLIC endpoint — returns just the active users (name + username +
// department) so the desktop app's login dropdown can populate itself from the
// Sheet instead of having usernames hard-coded into the bundle. Cached 60s.
// Never returns password_sha256 or any private user fields.
function _active_users(body) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('active_users_v1');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }
  const rows = _rows(TAB.USERS);
  const users = rows
    .filter(u => {
      const a = String(u.active || '').toUpperCase();
      return a === 'TRUE' || a === 'YES';
    })
    .map(u => ({
      name: String(u.name || u.username || '').trim(),
      username: String(u.username || '').trim().toLowerCase(),
      department: String(u.department || '').trim(),
    }))
    .filter(u => !!u.username);
  const resp = { ok: true, users: users };
  try { cache.put('active_users_v1', JSON.stringify(resp), 60); } catch (e) { /* ignore */ }
  return resp;
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

// V7.7: aggregate this user's Usage rows by period. Validates session_token so each
// user can only see their own totals. If the caller's department is ADMIN (case
// insensitive), the response also includes "orphan" rows where username is blank
// or doesn't match any active user — useful for spotting unattributed historical
// usage.
function _usage_totals(body) {
  const sess = _getSession(body.session_token);
  if (!sess) return { error: 'no_session' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TAB.USAGE);
  if (!sh) return { error: 'no_usage_tab' };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) {
    return { ok: true, username: sess.username, week: 0, month: 0, all_time: 0,
             counts: { week: 0, month: 0, all_time: 0 }, orphan: null };
  }
  const headers = data[0].map(h => String(h));
  const tsCol   = headers.indexOf('ts');
  const userCol = headers.indexOf('username');
  const costCol = headers.indexOf('cost_usd');
  const routeCol = headers.indexOf('route');  // V8.1.5: for today_by_route breakdown
  if (tsCol < 0 || userCol < 0 || costCol < 0) {
    return { error: 'usage_tab_schema_mismatch', headers: headers };
  }
  // Window boundaries
  const now = new Date();
  const dayStart   = new Date(now.getFullYear(), now.getMonth(), now.getDate());  // V8.0.5: today
  const weekAgo    = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Resolve admin flag from the calling user's department
  const userInfo = _getUserByUsername(sess.username) || {};
  const isAdmin = String(userInfo.department || '').toUpperCase() === 'ADMIN';

  // Build set of known usernames so we can spot orphans
  const knownUsernames = new Set();
  if (isAdmin) {
    const usersSh = ss.getSheetByName(TAB.USERS);
    if (usersSh) {
      const u = usersSh.getDataRange().getValues();
      if (u.length > 1) {
        const uHeaders = u[0].map(String);
        const uCol = uHeaders.indexOf('username');
        if (uCol >= 0) for (let i = 1; i < u.length; i++) {
          const name = String(u[i][uCol] || '').trim();
          if (name) knownUsernames.add(name);
        }
      }
    }
  }

  let today = 0, week = 0, month = 0, all_time = 0;
  let cToday = 0, cWeek = 0, cMonth = 0, cAll = 0;
  let oToday = 0, oWeek = 0, oMonth = 0, oAll = 0;
  let cOToday = 0, cOWeek = 0, cOMonth = 0, cOAll = 0;
  // V8.1.5: today's cost broken down by route (whisper / assemblyai / ha_* / claude_pdf_parse)
  const today_by_route = {};
  const today_by_route_count = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowTsRaw = row[tsCol];
    const rowUser = String(row[userCol] || '').trim();
    const rowCost = Number(row[costCol] || 0);
    if (!isFinite(rowCost) || rowCost <= 0) continue;
    let rowTs;
    if (rowTsRaw instanceof Date) rowTs = rowTsRaw;
    else { rowTs = new Date(String(rowTsRaw)); if (isNaN(rowTs.getTime())) continue; }

    // Case-insensitive match so historical rows with different casing still aggregate.
    const sameUser = String(rowUser).toLowerCase() === String(sess.username).toLowerCase();
    if (sameUser) {
      all_time += rowCost; cAll++;
      if (rowTs >= monthStart) { month += rowCost; cMonth++; }
      if (rowTs >= weekAgo)    { week  += rowCost; cWeek++; }
      if (rowTs >= dayStart)   {
        today += rowCost; cToday++;
        // V8.1.5: route-level breakdown for today
        if (routeCol >= 0) {
          const route = String(row[routeCol] || 'unknown').trim() || 'unknown';
          today_by_route[route] = (today_by_route[route] || 0) + rowCost;
          today_by_route_count[route] = (today_by_route_count[route] || 0) + 1;
        }
      }
    } else if (isAdmin && (!rowUser || !knownUsernames.has(rowUser))) {
      oAll += rowCost; cOAll++;
      if (rowTs >= monthStart) { oMonth += rowCost; cOMonth++; }
      if (rowTs >= weekAgo)    { oWeek  += rowCost; cOWeek++; }
      if (rowTs >= dayStart)   { oToday += rowCost; cOToday++; }
    }
  }

  // V8.1.5: round today_by_route values to 6 dp for transport
  const today_by_route_rounded = {};
  Object.keys(today_by_route).forEach(k => { today_by_route_rounded[k] = Math.round(today_by_route[k] * 1e6) / 1e6; });
  const resp = {
    ok: true,
    username: sess.username,
    is_admin: isAdmin,
    today: Math.round(today * 1e6) / 1e6,
    week: Math.round(week * 1e6) / 1e6,
    month: Math.round(month * 1e6) / 1e6,
    all_time: Math.round(all_time * 1e6) / 1e6,
    counts: { today: cToday, week: cWeek, month: cMonth, all_time: cAll },
    today_by_route: today_by_route_rounded,
    today_by_route_count: today_by_route_count,
    now: now.toISOString(),
  };
  if (isAdmin) {
    resp.orphan = {
      today: Math.round(oToday * 1e6) / 1e6,
      week: Math.round(oWeek * 1e6) / 1e6,
      month: Math.round(oMonth * 1e6) / 1e6,
      all_time: Math.round(oAll * 1e6) / 1e6,
      counts: { today: cOToday, week: cOWeek, month: cOMonth, all_time: cOAll },
    };
  }
  return resp;
}

// V7.7 helper: look up a row in the Users tab by username (returns the row as an object).
function _getUserByUsername(username) {
  if (!username) return null;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TAB.USERS);
  if (!sh) return null;
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  const headers = data[0].map(String);
  const userCol = headers.indexOf('username');
  if (userCol < 0) return null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][userCol] || '').trim() === username) {
      const obj = {};
      for (let c = 0; c < headers.length; c++) obj[headers[c]] = data[i][c];
      return obj;
    }
  }
  return null;
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
    current:           String(v.current || '0'),
    download_url:      String(v.download_url || ''),
    sha256:            String(v.sha256 || ''),
    release_notes:     String(v.release_notes || ''),
    min_supported:     String(v.min_supported || '0'),
    code_gs_version:   CODE_GS_VERSION,  // V8.1: surface Apps Script source version
  };
}

function _feedback(body) {
  // Anyone with a valid session can submit. Stored in Sheet's Feedback tab.
  const sess = _getSession(body.session_token);
  const username = sess ? sess.username : '(anon)';
  _appendRow(TAB.FEEDBACK, {
    ts: new Date().toISOString(),
    username: username,
    category: String(body.category || 'other').slice(0, 30),
    message:  String(body.message || '').slice(0, 2000),
    app_version: String(body.version || ''),
    current_tab: String(body.current_tab || ''),
  });
  return { ok: true };
}

// ── Admin auth + endpoints ──────────────────────────────────────────────────
// Admin token lives in Script Properties (set once via Project Settings).
// Never returned in responses; only checked.
function _checkAdmin(body) {
  const want = (PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') || '').trim();
  if (!want) return { ok: false, error: 'admin_token_not_configured' };
  const got = String(body.admin_token || '').trim();
  if (got !== want) return { ok: false, error: 'admin_token_invalid' };
  return { ok: true };
}

function _admin_add_user(body) {
  const a = _checkAdmin(body); if (!a.ok) return a;
  const u = String(body.username || '').trim().toLowerCase();
  if (!u) return { ok: false, error: 'username_required' };
  // Reject duplicates
  const existing = _rows(TAB.USERS).find(r => String(r.username || '').trim().toLowerCase() === u);
  if (existing) return { ok: false, error: 'username_already_exists' };
  _appendRow(TAB.USERS, {
    name: String(body.name || ''),
    username: u,
    password_sha256: String(body.password_sha256 || '').toLowerCase(),
    department: String(body.department || ''),
    active: 'TRUE',
    created: (body.created || new Date().toISOString().slice(0, 10)),
    last_seen: '',
  });
  return { ok: true, username: u };
}

function _admin_remove_user(body) {
  const a = _checkAdmin(body); if (!a.ok) return a;
  const u = String(body.username || '').trim().toLowerCase();
  if (!u) return { ok: false, error: 'username_required' };
  const sh = _sheet(TAB.USERS);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const userIdx = headers.indexOf('username');
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][userIdx]).trim().toLowerCase() === u) {
      sh.deleteRow(r + 1);
      return { ok: true, removed: u };
    }
  }
  return { ok: false, error: 'username_not_found' };
}

function _admin_set_active(body) {
  const a = _checkAdmin(body); if (!a.ok) return a;
  const u = String(body.username || '').trim().toLowerCase();
  const desired = String(body.active || '').toUpperCase();
  if (!u) return { ok: false, error: 'username_required' };
  if (desired !== 'TRUE' && desired !== 'FALSE') return { ok: false, error: 'active_must_be_TRUE_or_FALSE' };
  const ok = _updateUserField(u, 'active', desired);
  return ok ? { ok: true, username: u, active: desired } : { ok: false, error: 'username_not_found' };
}

function _admin_list_users(body) {
  const a = _checkAdmin(body); if (!a.ok) return a;
  // Don't expose password hashes
  return {
    ok: true,
    users: _rows(TAB.USERS).map(r => ({
      name: r.name, username: r.username, department: r.department,
      active: r.active, created: r.created, last_seen: r.last_seen,
    })),
  };
}

function _admin_update_version(body) {
  const a = _checkAdmin(body); if (!a.ok) return a;
  const sh = _sheet(TAB.VERSION);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const want = {
    current:        body.current,
    download_url:   body.download_url,
    sha256:         body.sha256,
    release_notes:  body.release_notes,
    min_supported:  body.min_supported,
  };
  // Update each provided field (skip undefined) in row 2
  if (data.length < 2) sh.appendRow(headers.map(_ => ''));
  headers.forEach((h, i) => {
    if (want[h] !== undefined && want[h] !== null) {
      // Force string; force text format on version cells (so "7.1" doesn't become 7)
      sh.getRange(2, i + 1).setNumberFormat('@').setValue(String(want[h]));
    }
  });
  return { ok: true, version: _version() };
}

function _admin_set_kill_switch(body) {
  const a = _checkAdmin(body); if (!a.ok) return a;
  const desired = String(body.kill_switch || '').toUpperCase();
  if (desired !== 'TRUE' && desired !== 'FALSE') return { ok: false, error: 'kill_switch_must_be_TRUE_or_FALSE' };
  const sh = _sheet(TAB.PILOT);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idx = headers.indexOf('kill_switch');
  if (idx < 0) return { ok: false, error: 'kill_switch_column_missing' };
  if (data.length < 2) sh.appendRow(headers.map(_ => ''));
  sh.getRange(2, idx + 1).setValue(desired);
  return { ok: true, kill_switch: desired };
}

function _admin_list_feedback(body) {
  const a = _checkAdmin(body); if (!a.ok) return a;
  const since = body.since_iso ? new Date(body.since_iso).getTime() : 0;
  const all = _rows(TAB.FEEDBACK).filter(r => {
    if (!since) return true;
    const t = r.ts ? new Date(r.ts).getTime() : 0;
    return t >= since;
  });
  return { ok: true, feedback: all };
}

function _admin_list_errors(body) {
  const a = _checkAdmin(body); if (!a.ok) return a;
  const since = body.since_iso ? new Date(body.since_iso).getTime() : 0;
  const all = _rows(TAB.ERRORS).filter(r => {
    if (!since) return true;
    const t = r.ts ? new Date(r.ts).getTime() : 0;
    return t >= since;
  });
  return { ok: true, errors: all };
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
    case 'login':       result = _login(body);     break;
    case 'active_users':result = _active_users(body); break;  // V8.0.6: public list for the login dropdown
    case 'heartbeat':   result = _heartbeat(body); break;
    // V8.0.7: session-based admin endpoints (no admin_token needed — caller must be a
    // logged-in user with department=ADMIN). Used by the in-app admin drawer.
    case 'admin/session_users':       result = _admin_session_users(body); break;
    case 'admin/session_errors':      result = _admin_session_errors(body); break;
    case 'admin/session_dept_billing':result = _admin_session_dept_billing(body); break;
    case 'admin/session_sheet_url':   result = _admin_session_sheet_url(body); break;
    case 'usage':       result = _usage(body);     break;
    case 'usage/totals':result = _usage_totals(body); break;  // V7.7
    case 'error':       result = _error(body);     break;
    case 'version':     result = _version();       break;
    case 'feedback':    result = _feedback(body);  break;
    // Admin endpoints — all require admin_token in the JSON body
    case 'admin/add_user':         result = _admin_add_user(body);        break;
    case 'admin/remove_user':      result = _admin_remove_user(body);     break;
    case 'admin/set_active':       result = _admin_set_active(body);      break;
    case 'admin/list_users':       result = _admin_list_users(body);      break;
    case 'admin/update_version':   result = _admin_update_version(body);  break;
    case 'admin/set_kill_switch':  result = _admin_set_kill_switch(body); break;
    case 'admin/list_feedback':    result = _admin_list_feedback(body);   break;
    case 'admin/list_errors':      result = _admin_list_errors(body);     break;
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

// ── V8.0.7: SESSION-BASED ADMIN ENDPOINTS ──────────────────────────────────
// These endpoints let an authenticated user with department=ADMIN pull
// admin-only data through the desktop app's in-app drawer, without ever
// exposing the admin_token (which stays on the release machine only).

function _isAdminSession(token) {
  const sess = _getSession(token);
  if (!sess) return null;
  const u = _getUserByUsername(sess.username);
  if (!u) return null;
  const isAdmin = String(u.department || '').toUpperCase() === 'ADMIN';
  return isAdmin ? sess : null;
}

function _admin_session_users(body) {
  if (!_isAdminSession(body.session_token)) return { error: 'not_admin' };
  // Include the hash so admin can audit / verify cells. Never exposed to non-admins.
  return {
    ok: true,
    users: _rows(TAB.USERS).map(u => ({
      name:             String(u.name || ''),
      username:         String(u.username || ''),
      password_sha256:  String(u.password_sha256 || ''),
      department:       String(u.department || ''),
      active:           String(u.active || ''),
      created:          String(u.created || ''),
      last_seen:        String(u.last_seen || ''),
    })),
  };
}

function _admin_session_errors(body) {
  if (!_isAdminSession(body.session_token)) return { error: 'not_admin' };
  const since = body.since_iso ? new Date(body.since_iso).getTime() : 0;
  const limit = Math.min(Number(body.limit || 200), 500);
  const all = _rows(TAB.ERRORS).filter(r => {
    if (!since) return true;
    const t = r.ts ? new Date(r.ts).getTime() : 0;
    return t >= since;
  });
  // Newest first, cap at limit
  all.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0;
    const tb = b.ts ? new Date(b.ts).getTime() : 0;
    return tb - ta;
  });
  return { ok: true, errors: all.slice(0, limit), total_count: all.length };
}

function _admin_session_dept_billing(body) {
  if (!_isAdminSession(body.session_token)) return { error: 'not_admin' };
  const users = _rows(TAB.USERS);
  const userDept = {}; const userName = {};
  users.forEach(u => {
    const un = String(u.username || '').toLowerCase().trim();
    if (!un) return;
    userDept[un] = String(u.department || 'OTHER').toUpperCase() || 'OTHER';
    userName[un] = String(u.name || u.username || '');
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TAB.USAGE);
  if (!sh) return { ok: true, by_dept: {} };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: true, by_dept: {} };
  const headers = data[0].map(String);
  const tsCol = headers.indexOf('ts');
  const userCol = headers.indexOf('username');
  const costCol = headers.indexOf('cost_usd');
  if (tsCol < 0 || userCol < 0 || costCol < 0) return { error: 'schema_mismatch', headers: headers };

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const last30dAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const last7dAgo  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000);
  const dayStart   = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const byDept = {};
  const ensureDept = (d) => byDept[d] || (byDept[d] = {
    total: 0, today: 0, last_7d: 0, this_month: 0, last_30d: 0,
    row_count: 0, by_user: {}
  });

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const c = Number(row[costCol] || 0);
    if (!isFinite(c) || c <= 0) continue;
    let t;
    const tsRaw = row[tsCol];
    if (tsRaw instanceof Date) t = tsRaw;
    else { t = new Date(String(tsRaw)); if (isNaN(t.getTime())) t = null; }
    const un = String(row[userCol] || '').toLowerCase().trim();
    const dept = userDept[un] || 'ORPHAN';
    const bucket = ensureDept(dept);
    bucket.total += c; bucket.row_count++;
    if (t) {
      if (t >= monthStart)  bucket.this_month += c;
      if (t >= last30dAgo)  bucket.last_30d   += c;
      if (t >= last7dAgo)   bucket.last_7d    += c;
      if (t >= dayStart)    bucket.today      += c;
    }
    if (!bucket.by_user[un]) bucket.by_user[un] = { name: userName[un] || un, total: 0, this_month: 0, last_30d: 0, row_count: 0 };
    const u = bucket.by_user[un];
    u.total += c; u.row_count++;
    if (t) {
      if (t >= monthStart) u.this_month += c;
      if (t >= last30dAgo) u.last_30d   += c;
    }
  }
  // Round all values to 6dp for transport
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  Object.keys(byDept).forEach(d => {
    const b = byDept[d];
    b.total = r6(b.total); b.today = r6(b.today); b.last_7d = r6(b.last_7d);
    b.this_month = r6(b.this_month); b.last_30d = r6(b.last_30d);
    Object.keys(b.by_user).forEach(un => {
      const u = b.by_user[un];
      u.total = r6(u.total); u.this_month = r6(u.this_month); u.last_30d = r6(u.last_30d);
    });
  });
  return { ok: true, now: now.toISOString(), by_dept: byDept };
}

function _admin_session_sheet_url(body) {
  if (!_isAdminSession(body.session_token)) return { error: 'not_admin' };
  return {
    ok: true,
    url: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    code_gs_version: CODE_GS_VERSION,  // V8.1: so the admin drawer shows what's deployed
  };
}

// ── ONE-TIME MIGRATION (V8.0.5) ─────────────────────────────────────────────
// Consolidate "Studio Test" + "Jon Test" usage rows into Jacques (admin), then
// delete those two user rows. Run ONCE from the Apps Script editor:
//   1. Open this Code.gs in script.google.com
//   2. In the function dropdown, select `MIGRATE_consolidate_test_users`
//   3. Click Run.  View → Logs shows the summary.
// Safe to re-run — idempotent (after the first run, the from-users no longer
// exist so no rows match).
function MIGRATE_consolidate_test_users() {
  // Names we'll match against the Users tab + Usage rows (case- and separator-insensitive).
  const fromUsernames = ['studiotest', 'jontest', 'studio_test', 'jon_test'];
  // Username of the admin we want to merge INTO. Adjust if your admin row uses
  // a different value in the Users.username column.
  const into = 'jacques_admin';
  const norm = s => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
  const fromSet = new Set(fromUsernames.map(norm));

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Reassign Usage rows
  const usageSh = ss.getSheetByName(TAB.USAGE);
  if (!usageSh) throw new Error('Usage tab missing');
  const data = usageSh.getDataRange().getValues();
  if (data.length < 2) { Logger.log('No usage rows to migrate.'); return { ok: true, reassigned: 0, removed: [] }; }
  const headers = data[0].map(String);
  const userCol = headers.indexOf('username');
  if (userCol < 0) throw new Error('Usage.username column not found');
  let reassigned = 0;
  for (let r = 1; r < data.length; r++) {
    if (fromSet.has(norm(data[r][userCol]))) {
      usageSh.getRange(r + 1, userCol + 1).setValue(into);
      reassigned++;
    }
  }

  // 2. Delete the from-user rows in Users tab (bottom-up so deleteRow indexes stay valid)
  const usersSh = ss.getSheetByName(TAB.USERS);
  if (!usersSh) throw new Error('Users tab missing');
  const udata = usersSh.getDataRange().getValues();
  const uHeaders = udata[0].map(String);
  const uCol = uHeaders.indexOf('username');
  if (uCol < 0) throw new Error('Users.username column not found');
  const removed = [];
  for (let r = udata.length - 1; r >= 1; r--) {
    if (fromSet.has(norm(udata[r][uCol]))) {
      removed.push(String(udata[r][uCol]));
      usersSh.deleteRow(r + 1);
    }
  }

  const summary = `Reassigned ${reassigned} Usage row(s) into "${into}". Removed user row(s): ${removed.length ? removed.join(', ') : '(none)'}.`;
  Logger.log(summary);
  return { ok: true, reassigned, removed, into };
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
