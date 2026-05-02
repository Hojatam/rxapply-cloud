// cowork-proxy/tools/adapters/rest/perplexity.js
// =====================================================================
// Perplexity API — search-grounded answers with citations.
// Docs: https://docs.perplexity.ai/
// Models:
//   sonar       — fast, ~$0.005 in/out per call
//   sonar-pro   — deep synthesis, ~$0.05 per call
// =====================================================================

const BASE = 'https://api.perplexity.ai/chat/completions';

async function _ask({ model, query, system, key }) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system || 'Be precise and cite sources.' },
        { role: 'user',   content: query },
      ],
      return_citations: true,
    }),
  });
  if (!r.ok) throw new Error(`Perplexity ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  return {
    answer: (msg && msg.content) || '',
    citations: j.citations || [],
    usage: j.usage || {},
  };
}

async function execute({ op, args, secrets }) {
  const key = secrets && secrets.api_key;
  if (!key) throw new Error('Perplexity api_key missing — connect the tool first.');

  if (op === 'ask' || op === 'test') {
    const r = await _ask({
      model: 'sonar',
      query: args.query || (op === 'test' ? 'What is 2+2?' : ''),
      system: args.system,
      key,
    });
    // Approximate cost: $0.005 flat for sonar
    return { output: r, costUsd: 0.005 };
  }

  if (op === 'ask_pro') {
    const r = await _ask({
      model: 'sonar-pro',
      query: args.query || '',
      system: args.system,
      key,
    });
    return { output: r, costUsd: 0.05 };
  }

  throw new Error(`perplexity: unknown op '${op}'`);
}

module.exports = { execute };
