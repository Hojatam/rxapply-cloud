// cowork-proxy/tools/adapters/rest/ig-graph.js
// =====================================================================
// Instagram Graph API — direct integration with the Meta business API.
// Docs: https://developers.facebook.com/docs/instagram-api/
//
// Auth: long-lived page access token + IG Business Account ID.
// Free (no per-call cost from Meta; rate-limited by app + page).
//
// SAFETY: every write op (send_dm, publish_post, reply_comment) MUST
// be gated by the dashboard's permission system. The default policy
// declared in registry.js is "ask" for these. We do not gate here —
// the runtime already has done that — but we DO refuse writes when
// the special _allow_write hint is missing (a belt-and-suspenders
// against accidental cron callers).
// =====================================================================

const GRAPH_VER = 'v20.0';
const BASE = `https://graph.facebook.com/${GRAPH_VER}`;

async function _get(path, token, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IG GET ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}
async function _post(path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  if (!r.ok) throw new Error(`IG POST ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

async function execute({ op, args, secrets }) {
  const token = secrets && secrets.access_token;
  const pageId = secrets && secrets.page_id;
  if (!token || !pageId) throw new Error('IG access_token + page_id required — connect the tool first.');

  // ── Read ops ───────────────────────────────────────────────────
  if (op === 'list_dms' || op === 'test') {
    const j = await _get(`/${pageId}/conversations`, token, {
      platform: 'instagram',
      limit: args.limit || 10,
      fields: 'id,participants,updated_time,message_count',
    });
    return {
      output: { conversations: (j.data || []).map(c => ({
        id: c.id,
        participants: c.participants && c.participants.data,
        updated_time: c.updated_time,
        message_count: c.message_count,
      })) },
      costUsd: 0,
    };
  }
  if (op === 'read_thread') {
    if (!args.conversation_id) throw new Error('read_thread requires conversation_id');
    const j = await _get(`/${args.conversation_id}/messages`, token, {
      fields: 'id,from,to,message,created_time',
      limit: args.limit || 20,
    });
    return { output: { messages: j.data || [] }, costUsd: 0 };
  }
  if (op === 'list_posts') {
    const j = await _get(`/${pageId}/media`, token, {
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
      limit: args.limit || 12,
    });
    return { output: { posts: j.data || [] }, costUsd: 0 };
  }

  // ── Write ops — dashboard's perm matrix has already approved this
  //    (or the call wouldn't reach the adapter). Belt-and-suspenders:
  //    require an explicit _allow_write hint to defend against direct
  //    server-side callers that bypass the gate.
  const isWrite = (op === 'send_dm' || op === 'publish_post' || op === 'reply_comment');
  if (isWrite && args._allow_write !== true) {
    throw new Error(`ig-graph: write op '${op}' requires _allow_write:true in args (set by runtime gate)`);
  }

  if (op === 'send_dm') {
    if (!args.recipient_id || !args.text) throw new Error('send_dm requires recipient_id + text');
    const j = await _post(`/${pageId}/messages`, token, {
      recipient: { id: args.recipient_id },
      message:   { text: args.text },
      messaging_type: 'RESPONSE',
    });
    return { output: j, costUsd: 0 };
  }

  if (op === 'publish_post') {
    if (!args.image_url || !args.caption) throw new Error('publish_post requires image_url + caption');
    // 2-step: create container → publish container
    const c = await _post(`/${pageId}/media`, token, {
      image_url: args.image_url,
      caption:   args.caption,
    });
    const p = await _post(`/${pageId}/media_publish`, token, { creation_id: c.id });
    return { output: { container: c, published: p }, costUsd: 0 };
  }

  if (op === 'reply_comment') {
    if (!args.comment_id || !args.text) throw new Error('reply_comment requires comment_id + text');
    const j = await _post(`/${args.comment_id}/replies`, token, { message: args.text });
    return { output: j, costUsd: 0 };
  }

  throw new Error(`ig-graph: unknown op '${op}'`);
}

module.exports = { execute };
