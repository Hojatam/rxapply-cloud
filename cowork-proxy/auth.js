// cowork-proxy/auth.js
// =====================================================================
// F7 · Single-user password auth for the dashboard's protected sections.
//
// Design:
//   - One password (the founder's). Stored as scrypt hash + salt in
//     dashboard_settings.auth_password_hash (DB).
//   - Login → ephemeral session token in an HTTP-only cookie.
//   - Sessions live in memory (Map). Server restart = re-login.
//   - Default expiry 4h, configurable in dashboard_settings.
//   - "Bootstrap" mode: until a password is set, /settings is open
//     and shows a "Set password" prompt.
//
// Public API:
//   isInitialized()              -> bool
//   setPassword(plaintext)        -> { ok }
//   login(plaintext)              -> { ok, token, expiresAt } | { ok:false, error }
//   logout(token)
//   verifyToken(token)            -> { ok, expiresAt } | { ok:false }
//   middleware(req, res, next)    -> express middleware, gates /settings + PUT /prompts/*
// =====================================================================

const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PG_CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_rxapply-test';
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
// Token: 32 random bytes -> base64url (43 chars)
const TOKEN_BYTES = 32;

// In-memory session store: token -> { expiresAt: number, createdAt: number }
const sessions = new Map();

// ── psql helpers (mirror log-writer.js for consistency) ──────────────

function _psqlExecScript(script) {
  const args = ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1'];
  const r = spawnSync('docker', args, { input: script, encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`psql failed (${r.status}): ${(r.stderr || '').slice(0, 500)}`);
  }
  return (r.stdout || '').trim();
}

function _q(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── Password hashing ──────────────────────────────────────────────────

function _hash(plaintext) {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function _verify(plaintext, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const want = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(plaintext, salt, want.length);
    return crypto.timingSafeEqual(want, got);
  } catch (_) {
    return false;
  }
}

// ── DB getters/setters ────────────────────────────────────────────────

function _getSettings() {
  try {
    const out = _psqlExecScript(`SELECT row_to_json(s) FROM (SELECT auth_password_hash, auth_session_hours FROM dashboard_settings WHERE id = 1) s;`);
    return out ? JSON.parse(out) : null;
  } catch (e) {
    return null;
  }
}

function _saveHash(hash) {
  _psqlExecScript(`UPDATE dashboard_settings SET auth_password_hash = ${_q(hash)}, updated_at = NOW() WHERE id = 1;`);
}

// ── Public API ────────────────────────────────────────────────────────

// H-3: cache isInitialized result to avoid spawning a docker subprocess on
// every auth-gated request. Once a password is set it cannot become unset
// without a manual DB edit + proxy restart, so true is permanent within a
// process lifetime. Negative results are cached for 5s to recover from
// race conditions during first-time bootstrap.
let _initCache = { value: null, until: 0 };

function isInitialized() {
  const now = Date.now();
  if (_initCache.value === true) return true;
  if (_initCache.value === false && now < _initCache.until) return false;
  const s = _getSettings();
  const v = !!(s && s.auth_password_hash);
  _initCache = { value: v, until: v ? Infinity : now + 5000 };
  return v;
}

function setPassword(plaintext) {
  if (!plaintext || typeof plaintext !== 'string' || plaintext.length < 6) {
    return { ok: false, error: 'password must be at least 6 chars' };
  }
  try {
    _saveHash(_hash(plaintext));
    _initCache = { value: true, until: Infinity };  // invalidate negative cache
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'DB write failed: ' + (e.message || '').slice(0, 200) };
  }
}

function login(plaintext) {
  const s = _getSettings();
  if (!s || !s.auth_password_hash) {
    return { ok: false, error: 'auth not initialized — set a password in Settings first' };
  }
  if (!_verify(plaintext, s.auth_password_hash)) {
    return { ok: false, error: 'incorrect password' };
  }
  const hours = s.auth_session_hours || 4;
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = Date.now() + hours * 3600_000;
  sessions.set(token, { expiresAt, createdAt: Date.now() });
  return { ok: true, token, expiresAt };
}

function logout(token) {
  if (token) sessions.delete(token);
}

function verifyToken(token) {
  if (!token) return { ok: false };
  const s = sessions.get(token);
  if (!s) return { ok: false };
  if (s.expiresAt < Date.now()) { sessions.delete(token); return { ok: false }; }
  return { ok: true, expiresAt: s.expiresAt };
}

// Periodic cleanup of expired tokens (called from server.js on interval).
function pruneExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [token, s] of sessions) {
    if (s.expiresAt < now) { sessions.delete(token); removed++; }
  }
  return removed;
}

// Read token from cookie OR Authorization header.
function _readToken(req) {
  // Cookie format: "rxapply_session=<token>; ..."
  const cookieHeader = req.headers.cookie || '';
  const m = /(?:^|;\s*)rxapply_session=([^;]+)/.exec(cookieHeader);
  if (m) return decodeURIComponent(m[1]);
  // Authorization: Bearer <token>
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  // ?token=… query (not recommended; just for debugging)
  if (req.query && req.query.token) return req.query.token;
  return null;
}

// Express middleware. Gates anything we attach it to.
// Bootstrap mode: if auth is not initialized, ALL settings access is open.
// Dev override: AUTH_DISABLED=1 in .env makes every gated request pass.
function middleware(req, res, next) {
  if (process.env.AUTH_DISABLED === '1' || process.env.AUTH_DISABLED === 'true') {
    req.auth = { disabled: true };
    return next();
  }
  if (!isInitialized()) {
    req.auth = { initialized: false };
    return next();
  }
  const token = _readToken(req);
  const v = verifyToken(token);
  if (!v.ok) {
    return res.status(401).json({ ok: false, error: 'auth required', initialized: true });
  }
  req.auth = { initialized: true, token, expiresAt: v.expiresAt };
  next();
}

function isDisabled() {
  return process.env.AUTH_DISABLED === '1' || process.env.AUTH_DISABLED === 'true';
}

module.exports = {
  isInitialized,
  isDisabled,
  setPassword,
  login,
  logout,
  verifyToken,
  pruneExpired,
  middleware,
};
