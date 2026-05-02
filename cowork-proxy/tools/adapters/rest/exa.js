// cowork-proxy/tools/adapters/rest/exa.js
// =====================================================================
// Exa — neural search. Best when keyword search misses.
// Docs: https://docs.exa.ai/
// Free tier: 1000 calls/month.
// =====================================================================

const BASE = 'https://api.exa.ai';

async function _call(path, key, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Exa ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function execute({ op, args, secrets }) {
  const key = secrets && secrets.api_key;
  if (!key) throw new Error('Exa api_key missing — connect the tool first.');

  if (op === 'search' || op === 'test') {
    const j = await _call('/search', key, {
      query: args.query || (op === 'test' ? 'test' : ''),
      numResults: Math.min(10, args.num_results || 5),
      type: args.type || 'auto',                     // 'neural' | 'keyword' | 'auto'
    });
    return {
      output: { results: (j.results || []).map(r => ({ title: r.title, url: r.url, score: r.score, published: r.publishedDate })) },
      costUsd: 0.005,
    };
  }

  if (op === 'find_similar') {
    if (!args.url) throw new Error('find_similar requires url');
    const j = await _call('/findSimilar', key, {
      url: args.url,
      numResults: Math.min(10, args.num_results || 5),
    });
    return {
      output: { results: (j.results || []).map(r => ({ title: r.title, url: r.url, score: r.score })) },
      costUsd: 0.005,
    };
  }

  if (op === 'contents') {
    const ids = Array.isArray(args.ids) ? args.ids : (Array.isArray(args.urls) ? args.urls : []);
    if (ids.length === 0) throw new Error('contents requires ids[] or urls[]');
    const j = await _call('/contents', key, { ids, text: true });
    return {
      output: { results: (j.results || []).map(r => ({ url: r.url, title: r.title, text: (r.text || '').slice(0, 4000) })) },
      costUsd: 0.005 * ids.length,
    };
  }

  throw new Error(`exa: unknown op '${op}'`);
}

module.exports = { execute };
