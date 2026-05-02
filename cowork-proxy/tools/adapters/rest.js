// cowork-proxy/tools/adapters/rest.js
// =====================================================================
// Dispatcher for REST-flavoured tools. Each tool slug has a tiny module
// in ./rest/<slug>.js that exports { execute({op, args, secrets}) }.
// We load secrets here so the per-tool modules don't need to know about
// pgcrypto.
// =====================================================================

const path = require('path');
const fs = require('fs');
const { psql, q } = require('../db');
const { decryptSqlExpr } = require('../crypto');

async function _loadSecrets(toolSlug) {
  const out = await psql(`
    SELECT ${decryptSqlExpr('secrets_enc')}
    FROM tool_credentials
    WHERE tool_slug = ${q(toolSlug)};
  `);
  if (!out) return null;
  try { return JSON.parse(out); } catch (_) { return null; }
}

const _modCache = {};
function _loadModule(slug) {
  if (_modCache[slug]) return _modCache[slug];
  const file = path.join(__dirname, 'rest', `${slug}.js`);
  if (!fs.existsSync(file)) return null;
  _modCache[slug] = require(file);
  return _modCache[slug];
}

async function execute({ tool, op, args, agent }) {
  const slug = tool.slug;
  const mod = _loadModule(slug);
  if (!mod || typeof mod.execute !== 'function') {
    throw new Error(`No REST adapter file for tool '${slug}' (expected adapters/rest/${slug}.js)`);
  }
  const secrets = (await _loadSecrets(slug)) || {};
  return await mod.execute({ op, args: args || {}, secrets, agent });
}

module.exports = { execute };
