// cowork-proxy/auth.js
// =====================================================================
// F7 · Single-user password auth + TOTP 2FA + CSRF.  [cloud build]
//
// Password: scrypt-hashed, stored in dashboard_settings.auth_password_hash.
// 2FA:      otplib TOTP, secret encrypted at rest via pgcrypto pgp_sym
//           (same pattern as tool credentials). Stored in
//           dashboard_settings.totp_secret + recovery codes in
//           dashboard_settings.totp_recovery jsonb.
// Sessions: in-memory Map of token → { expiresAt, csrfToken }. Each
//           session gets a CSRF token returned on login; the dashboard
//           sends it back on every state-changing request via
//           `X-CSRF-Token` header.
// Cookies:  HttpOnly + SameSite=Strict + Secure-when-NODE_ENV=production.
//
// Public API:
//   refresh()                                  -> async; load cache
//   isInitialized()                            -> sync (cache-backed)
//   isTotpEnabled()                            -> sync
//   setPassword(plaintext)                     -> async
//   login(plaintext, [totpCode])               -> async
//                                                 returns { ok, token,
//                                                 expiresAt, csrfToken }
//                                                 OR { ok:false, error,
//                                                      requires_totp }
//   logout(token)
//   verifyToken(token)
//   verifyCsrf(token, providedCsrf) → bool
//   loginRateLimiter                           -> express-rate-limit middleware
//   middleware(req, res, next)                 -> auth gate (sync)
//   csrfMiddleware(req, res, next)             -> CSRF gate (sync)
//
//   setupTotp()                                -> async {secret, otpauthUrl, qrPng, recoveryCodes}
//   confirmTotpSetup(code)                     -> async (verify first code, persist)
//   disableTotp()                              -> async
//   buildSessionCookie(name, value, opts)      -> string (Set-Cookie value)
// =====================================================================

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { query, queryValue, q } = require('./db');
const { encryptSqlExpr, decryptSqlExpr } = require('./tools/crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const sessions = new Map();   // token -> { expiresAt, createdAt, csrfToken }

// otplib config — 30s window, 6 digits.
authenticator.options = { window: 1, digits: 6, step: 30 };

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
        SELECT auth_password_hash, auth_session_hours,
               (totp_secret IS NOT NULL) AS totp_enabled
          FROM dashboard_settings WHERE id = 1
      ) s;`);
    _settingsCache = out ? JSON.parse(out) : {};
    _settingsStamp = Date.now();
  } catch (_) {
    _settingsCache = _settingsCache || {};
  }
  return _settingsCache;
}

function isTotpEnabled() {
  const s = _getSettings();
  return !!(s && s.totp_enabled);
}

// Read the decrypted TOTP secret. Cached for one minute to avoid
// hitting pgcrypto on every login attempt.
let _totpSecretCache = { value: null, until: 0 };
const TOTP_SECRET_TTL_MS = 60_000;
async function _getTotpSecret() {
  if (_totpSecretCache.value && Date.now() < _totpSecretCache.until) {
    return _totpSecretCache.value;
  }
  const out = await queryValue(`
    SELECT ${decryptSqlExpr('totp_secret')} FROM dashboard_settings WHERE id = 1;`);
  _totpSecretCache = { value: out || null, until: Date.now() + TOTP_SECRET_TTL_MS };
  return out || null;
}
function _invalidateTotpCache() { _totpSecretCache = { value: null, until: 0 }; }

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

async function login(plaintext, totpCode = null) {
  const s = await refresh();   // always read fresh on login (rare op; correctness > speed)
  if (!s || !s.auth_password_hash) {
    return { ok: false, error: 'auth not initialized — set a password in Settings first' };
  }
  if (!_verify(plaintext, s.auth_password_hash)) {
    return { ok: false, error: 'incorrect password' };
  }
  // Second factor (if enabled).
  if (s.totp_enabled) {
    if (!totpCode || typeof totpCode !== 'string') {
      return { ok: false, requires_totp: true, error: 'totp_code_required' };
    }
    const ok = await _verifyTotp(totpCode);
    if (!ok) {
      return { ok: false, requires_totp: true, error: 'incorrect 2FA code' };
    }
  }
  const hours = s.auth_session_hours || 4;
  const token     = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + hours * 3600_000;
  sessions.set(token, { expiresAt, createdAt: Date.now(), csrfToken });
  return { ok: true, token, expiresAt, csrfToken };
}

// Verify a TOTP code OR a single-use recovery code. Recovery codes are
// stored hashed (sha256 hex) in totp_recovery jsonb so a DB read can't
// leak them. Used codes are removed.
async function _verifyTotp(code) {
  const trimmed = String(code || '').replace(/[^a-z0-9]/gi, '');
  // 6-digit TOTP path
  if (/^\d{6}$/.test(trimmed)) {
    const secret = await _getTotpSecret();
    if (!secret) return false;
    try { return authenticator.verify({ token: trimmed, secret }); }
    catch (_) { return false; }
  }
  // Recovery code path (treat anything else as a recovery code candidate).
  const hash = crypto.createHash('sha256').update(trimmed.toLowerCase()).digest('hex');
  try {
    const row = await queryValue(`SELECT totp_recovery FROM dashboard_settings WHERE id = 1;`);
    const arr = row ? (JSON.parse(row) || []) : [];
    const idx = arr.indexOf(hash);
    if (idx === -1) return false;
    arr.splice(idx, 1);  // single-use
    await query(`UPDATE dashboard_settings
                    SET totp_recovery = ${q(JSON.stringify(arr))}::jsonb,
                        updated_at = NOW()
                  WHERE id = 1;`);
    return true;
  } catch (_) { return false; }
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

// ── CSRF ────────────────────────────────────────────────────────────
function verifyCsrf(token, providedCsrf) {
  if (!token || !providedCsrf) return false;
  const s = sessions.get(token);
  if (!s || !s.csrfToken) return false;
  // Constant-time compare to defeat timing attacks.
  const a = Buffer.from(s.csrfToken);
  const b = Buffer.from(providedCsrf);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// CSRF middleware. Skips when:
//   - method is GET / HEAD / OPTIONS (state-safe by spec)
//   - auth is disabled (dev) or not yet initialized (bootstrap)
//   - the request comes through an open route (not auth.middleware-gated)
// Reads X-CSRF-Token header; rejects state-changing requests without
// a matching token.
// Paths exempt from CSRF — the firstRunGate already restricts /setup/* to
// pre-setup access, so adding CSRF on top creates fragile UX (the wizard
// loses the token across reloads). For tool-call writes after launch
// we still enforce CSRF.
const CSRF_EXEMPT_PREFIXES = ['/setup/', '/auth/'];

function csrfMiddleware(req, res, next) {
  if (isDisabled() || !isInitialized()) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (CSRF_EXEMPT_PREFIXES.some(p => req.path.startsWith(p))) return next();
  const token = _readToken(req);
  if (!token) return next();   // no auth cookie → other middleware will reject
  const provided = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
  if (!verifyCsrf(token, provided)) {
    return res.status(403).json({ ok: false, error: 'csrf_token_required' });
  }
  next();
}

// ── Rate limiter for /auth/login ────────────────────────────────────
// 5 attempts / 15 min per IP. Hard fail with 429 thereafter.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_login_attempts', retry_after: '15 minutes' },
  // Fingerprint by IP. Express sets req.ip from the first non-trusted-proxy
  // header so this works behind Railway's reverse proxy when we set
  // app.set('trust proxy', 1).
});

// ── Cookie builder ──────────────────────────────────────────────────
// Sets HttpOnly + SameSite=Strict + Secure-when-production. Caller does
// res.setHeader('Set-Cookie', buildSessionCookie(...)).
function buildSessionCookie(name, value, { maxAgeSec, clear = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value || '')}`, 'HttpOnly', 'Path=/', 'SameSite=Strict'];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  if (clear) {
    parts.push('Max-Age=0');
  } else if (Number.isFinite(maxAgeSec)) {
    parts.push(`Max-Age=${maxAgeSec | 0}`);
  }
  return parts.join('; ');
}

// ── TOTP setup / disable ────────────────────────────────────────────
// setupTotp() returns the data needed to render the QR + recovery list
// in the wizard. The secret is NOT persisted yet — confirmTotpSetup()
// does that AFTER the founder verifies the first 6-digit code.
async function setupTotp({ accountLabel = 'founder', issuer = 'RxApply' } = {}) {
  const secret = authenticator.generateSecret();   // 32-char base32
  const otpauthUrl = authenticator.keyuri(accountLabel, issuer, secret);
  // QR as a data: URL the browser can <img src="…"> directly.
  const qrPng = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', scale: 6, margin: 1 });
  // 10 recovery codes, 10 chars each, dash-separated for legibility.
  // base64url drops + and / so ambiguous-char filtering is rare.
  const recoveryCodes = [];
  for (let i = 0; i < 10; i++) {
    const raw = crypto.randomBytes(8).toString('base64url')
                  .replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 10);
    recoveryCodes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return { secret, otpauthUrl, qrPng, recoveryCodes };
}

// Persist the secret + recovery codes IFF the founder verified the
// 6-digit code from their authenticator app. Recovery codes stored as
// sha256 hashes; the originals are shown to the founder once.
async function confirmTotpSetup({ secret, code, recoveryCodes }) {
  if (!secret || !code) return { ok: false, error: 'secret + code required' };
  let valid = false;
  try { valid = authenticator.verify({ token: String(code), secret }); }
  catch (_) {}
  if (!valid) return { ok: false, error: 'code did not verify; try again' };

  const hashed = (Array.isArray(recoveryCodes) ? recoveryCodes : []).map(c =>
    crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex')
  );
  await query(`
    UPDATE dashboard_settings
       SET totp_secret   = ${encryptSqlExpr(secret)},
           totp_recovery = ${q(JSON.stringify(hashed))}::jsonb,
           updated_at    = NOW()
     WHERE id = 1;`);
  _invalidateTotpCache();
  await refresh();
  return { ok: true };
}

async function disableTotp() {
  await query(`UPDATE dashboard_settings
                  SET totp_secret = NULL, totp_recovery = '[]'::jsonb,
                      updated_at = NOW()
                WHERE id = 1;`);
  _invalidateTotpCache();
  await refresh();
  return { ok: true };
}

module.exports = {
  refresh,
  isInitialized,
  isTotpEnabled,
  isDisabled,
  setPassword,
  login,
  logout,
  verifyToken,
  verifyCsrf,
  pruneExpired,
  middleware,
  csrfMiddleware,
  loginRateLimiter,
  buildSessionCookie,
  setupTotp,
  confirmTotpSetup,
  disableTotp,
};
