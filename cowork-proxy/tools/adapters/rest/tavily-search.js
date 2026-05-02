// cowork-proxy/tools/adapters/rest/tavily-search.js
// =====================================================================
// Tavily Search — cited web search built for AI agents.
// Docs: https://docs.tavily.com/
// Free tier: 1000 calls/month. Then $0.005/call typical.
// =====================================================================

const TAVILY_BASE = 'https://api.tavily.com';

async function _call(path, key, body) {
  const r = await fetch(`${TAVILY_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function execute({ op, args, secrets }) {
  const key = secrets && secrets.api_key;
  if (!key) throw new Error('Tavily api_key missing — connect the tool first.');

  // Free-tier search — keep results tight to avoid burning credits.
  if (op === 'search' || op === 'test') {
    const j = await _call('/search', key, {
      query: args.query || (op === 'test' ? 'test query' : ''),
      search_depth: args.depth || 'basic',           // 'basic' or 'advanced'
      max_results: Math.min(10, args.max_results || 5),
      include_answer: args.include_answer !== false, // default true
    });
    return {
      output: {
        answer: j.answer || null,
        results: (j.results || []).map(r => ({
          title: r.title, url: r.url, content: (r.content || '').slice(0, 500), score: r.score,
        })),
      },
      costUsd: 0.005,                                // basic-tier pricing approximation
    };
  }

  if (op === 'search_news') {
    const j = await _call('/search', key, {
      query: args.query || '',
      topic: 'news',
      days: args.days || 7,
      max_results: Math.min(10, args.max_results || 5),
    });
    return {
      output: { results: (j.results || []).map(r => ({ title: r.title, url: r.url, published: r.published_date })) },
      costUsd: 0.005,
    };
  }

  if (op === 'extract') {
    const urls = Array.isArray(args.urls) ? args.urls : (args.url ? [args.url] : []);
    if (urls.length === 0) throw new Error('extract requires url(s)');
    const j = await _call('/extract', key, { urls });
    return {
      output: { results: (j.results || []).map(r => ({ url: r.url, content: (r.raw_content || r.content || '').slice(0, 4000) })) },
      costUsd: 0.005 * urls.length,
    };
  }

  throw new Error(`tavily-search: unknown op '${op}'`);
}

module.exports = { execute };
