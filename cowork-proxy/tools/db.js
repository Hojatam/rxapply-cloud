// cowork-proxy/tools/db.js
// =====================================================================
// Thin pass-through to ../db.js so existing `require('./db')` imports
// inside tools/* keep working. All tools/* modules now share the single
// pg pool defined in the parent db.js.
//
// `psql(sql)` is now async (returns a Promise<string>) and mirrors the
// shape of legacy psql -tA stdout. Tools-framework callers must await.
// =====================================================================

const parent = require('../db');

async function psql(sql) {
  return await parent.queryValue(sql);
}

module.exports = {
  psql,                      // async — mirrors legacy psql -tA shape
  query:           parent.query,
  queryValue:      parent.queryValue,
  queryRows:       parent.queryRows,
  queryReturning:  parent.queryReturning,
  q:               parent.q,
  qJson:           parent.qJson,
  qArr:            parent.qArr,
  qBytea:          parent.qBytea,
};
