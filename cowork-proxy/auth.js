// cowork-proxy/auth.js
// =====================================================================
// F7 · Single-user password auth for the dashboard.  [cloud build]
//
// Same scrypt-hashed-password design. New: async DB layer + cached
// settings so `middleware()` stays sync (Express middleware must be).
//
// 2FA + rate-limit + CSRF will land in Track1#6 (auth hardening). This
// file only changes the DB transport.
//
// Public API:
//   refresh()                  -> async; loads settings into the cache
//   isInitialized()            -> sync (cache-backed)
//   setPassword(plaintext)     -> async
//   login(plaintext)           -> async
//   logout(token)
//   verifyToken(token)
//   middleware(req, res, next) -> sync express middleware
// =====================================================================

const crypto = require('crypto');
const { query, queryValue, q } = require('./db');

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const sessions = new Map();   // token -> { expiresAt, createdAt }

// ── Cache ───────────────────────────────────────────────────────────
// Sync getter pattern: refresh() awaited at boot, then middleware reads
// from this. The "is auth initialized?" question is asked on every
// gated request — keep it lock-free.
let _settingsCache = null;
let _settingsStamp = 0;
const SETTINGS_TTL_MS = 30_000;

async function refresh() {
  try {
    const out = await queryValue(`
      SELECT row_to_json(s) FROM (
        SELECT auth_password_hash, auth_session_hours, totp_secret
          FROM dashboard_settings WHERE id = 1
      ) s;`);
    _settingsCache = out ? JSON.parse(out) : {};
    _settingsStamp = Date.now();
  } catch (_) {
    _settingsCache = _settingsCache || {};
  }
  return _settingsCache;
}

function _getSettings() {
  if (_settingsCache && (Date.now() - _settingsStamp) < SETTINGS_TTL_MS) return _settingsCache;
  refresh().catch(() => {});
  return _settingsCache || {};
}

// ── Password hashing ────────────────────────────────────────────────
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
  } catch (_) { return false; }
}

// ── Public API ─────────────────────────────────────────────────────
function isInitialized() {
  const s = _getSettings();
  return !!(s && s.auth_password_hash);
}

async function setPassword(plaintext) {
  if (!plaintext || typeof plaintext !== 'string' || plaintext.length < 6) {
    return { ok: false, error: 'password must be at least 6 chars' };
  }
  try {
    const hash = _hash(plaintext);
    await query(`UPDATE dashboard_settings
                    SET auth_password_hash = ${q(hash)}, updated_at = NOW()
                  WHERE id = 1;`);
    await refresh();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'DB write failed: ' + (e.message || '').slice(0, 200) };
  }
}

async function login(plaintext) {
  const s = await refresh();   // always read fresh on login (rare op; correctness > speed)
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

function logout(token) { if (token) sessions.delete(token); }

function verifyToken(token) {
  if (!token) return { ok: false };
  const s = sessions.get(token);
  if (!s) return { ok: false };
  if (s.expiresAt < Date.now()) { sessions.delete(token); return { ok: false }; }
  return { ok: true, expiresAt: s.expiresAt };
}

function pruneExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [token, s] of sessions) {
    if (s.expiresAt < now) { sessions.delete(token); removed++; }
  }
  return removed;
}

function _readToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const m = /(?:^|;\s*)rxapply_session=([^;]+)/.exec(cookieHeader);
  if (m) return decodeURIComponent(m[1]);
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.query && req.query.token) return req.query.token;
  return null;
}

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
  refresh,
  isInitialized,
  isDisabled,
  setPassword,
  login,
  logout,
  verifyToken,
  pruneExpired,
  middleware,
};
