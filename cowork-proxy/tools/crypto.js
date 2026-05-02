// cowork-proxy/tools/crypto.js
// =====================================================================
// Symmetric encryption for tool credentials at rest.
// We delegate to Postgres pgcrypto's pgp_sym_encrypt/decrypt rather
// than rolling our own AES wrapper — that way the secret never leaves
// the DB in plaintext form except inside the proxy process. The key
// comes from process.env.SECRETS_KEY (32 random bytes hex-encoded);
// start-proxy.bat persists it across restarts.
//
// Public:
//   getKey()                       → throws if SECRETS_KEY unset
//   encrypt(jsonObj) → bytea hex   ← runs pgp_sym_encrypt in psql
//   decrypt(byteaHex) → jsonObj    ← runs pgp_sym_decrypt in psql
//   encryptSqlExpr(text)           → SQL fragment (avoids round-trip on insert)
//   decryptSqlExpr(byteaCol)       → SQL fragment for SELECT
// =====================================================================

const { psql, q } = require('./db');

function getKey() {
  const k = process.env.SECRETS_KEY;
  if (!k || k.length < 32) {
    throw new Error('SECRETS_KEY env var is missing or <32 chars. Generate one and add it to start-proxy.bat.');
  }
  return k;
}

// SQL fragments — preferred path. Lets us write
//   INSERT … secrets_enc = ${encryptSqlExpr(jsonText)}
// in a single psql round trip.
function encryptSqlExpr(plainText) {
  const key = getKey();
  return `pgp_sym_encrypt(${q(String(plainText))}, ${q(key)})`;
}
function decryptSqlExpr(byteaCol) {
  const key = getKey();
  return `pgp_sym_decrypt(${byteaCol}, ${q(key)})`;
}

// Round-trip helpers (used rarely — when you only have a buffer in JS)
function encrypt(obj) {
  const out = psql(`SELECT encode(${encryptSqlExpr(JSON.stringify(obj))}, 'hex');`);
  return out;
}
function decrypt(hexEnc) {
  if (!hexEnc) return null;
  const out = psql(`SELECT ${decryptSqlExpr(`decode(${q(hexEnc)}, 'hex')`)};`);
  try { return JSON.parse(out); } catch (_) { return null; }
}

module.exports = { getKey, encrypt, decrypt, encryptSqlExpr, decryptSqlExpr };
