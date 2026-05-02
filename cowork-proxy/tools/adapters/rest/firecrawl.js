// cowork-proxy/tools/adapters/rest/firecrawl.js
// =====================================================================
// Firecrawl — JS-rendering URL → markdown scraper.
// Docs: https://docs.firecrawl.dev/
// Free tier: 500 calls/month.
// =====================================================================

const BASE = 'https://api.firecrawl.dev';

async function _call(path, method, key, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Firecrawl ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function execute({ op, args, secrets }) {
  const key = secrets && secrets.api_key;
  if (!key) throw new Error('Firecrawl api_key missing — connect the tool first.');

  if (op === 'scrape' || op === 'test') {
    const url = args.url || (op === 'test' ? 'https://example.com' : '');
    if (!url) throw new Error('scrape requires url');
    const j = await _call('/v1/scrape', 'POST', key, {
      url,
      formats: args.formats || ['markdown'],
    });
    const data = j.data || j;
    return {
      output: { url, markdown: (data.markdown || '').slice(0, 8000), metadata: data.metadata || {} },
      costUsd: 0.002,                                // approximation; free tier eats this for first 500
    };
  }

  if (op === 'crawl') {
    if (!args.url) throw new Error('crawl requires url');
    const j = await _call('/v1/crawl', 'POST', key, {
      url: args.url,
      limit: Math.min(50, args.limit || 10),
    });
    return { output: j, costUsd: 0.01 * (Math.min(50, args.limit || 10)) };
  }

  throw new Error(`firecrawl: unknown op '${op}'`);
}

module.exports = { execute };
