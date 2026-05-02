// cowork-proxy/tools/registry.js
// =====================================================================
// Static catalog of tools the dashboard knows about. Each entry declares
// what the tool *is* — connection method, what op names exist, what
// fields to ask the founder for, default policy, cost model, kind.
// Adapters in ./adapters/* implement the actual op execution.
//
// Boot path: server.js calls registry.sync() once on startup → upserts
// every entry into the `tools` Postgres table so the UI can list them.
// Connection state and per-call data live in tool_credentials/tool_calls
// (the registry itself is read-only at runtime).
// =====================================================================

const { psql, q, qJson } = require('./db');

// ── Shared kind/icon helpers ────────────────────────────────────────
const ICONS = {
  tavily:     '🔎',
  perplexity: '🧠',
  exa:        '🔬',
  firecrawl:  '🕷',
  ig:         '📷',
  buffer:     '📅',
  ayrshare:   '📡',
  postplanify:'🗓',
  xpoz:       '📊',
  creatorcrawl:'📈',
  tiktok:     '🎵',
  reddit:     '🅁',
  github:     '🐙',
  email:      '✉',
  echo:       '🧪',
};

// ── Catalog ─────────────────────────────────────────────────────────
// Each entry: { slug, name, vendor, kind, conn_method, icon, cost_model,
//               description, default_policy, ops, secret_fields }
const CATALOG = [
  // ── Phase 2 · free / cheap REST tools ─────────────────────────────
  {
    slug: 'tavily-search',
    name: 'Tavily Search',
    vendor: 'Tavily',
    kind: 'research',
    conn_method: 'rest',
    icon: ICONS.tavily,
    cost_model: '1000 free / month · then $0.005/call',
    description: 'Cited web search built for AI agents. Fast, factual, returns short summaries with sources.',
    default_policy: 'Auto-approve all read queries. Suggest the user a topic if cost would exceed $0.10 in a single agent task.',
    ops: [
      { name: 'search',        write: false, description: 'General web search with summaries.' },
      { name: 'search_news',   write: false, description: 'Recency-biased news search.' },
      { name: 'extract',       write: false, description: 'Pull cleaned content from a URL.' },
    ],
    secret_fields: [
      { key: 'api_key', label: 'API Key', secret: true, hint: 'tvly-…  Get one at tavily.com' },
    ],
  },
  {
    slug: 'perplexity',
    name: 'Perplexity API',
    vendor: 'Perplexity',
    kind: 'research',
    conn_method: 'rest',
    icon: ICONS.perplexity,
    cost_model: '~$0.005/call (sonar) · $0.05/call (sonar-pro)',
    description: 'Search + synthesis in one. Better than Tavily when the answer needs reasoning across multiple sources.',
    default_policy: 'Ask before any sonar-pro call. Auto-approve sonar (fast) calls.',
    ops: [
      { name: 'ask',     write: false, description: 'Sonar-quality answer with citations.' },
      { name: 'ask_pro', write: false, description: 'Sonar-pro deep synthesis.' },
    ],
    secret_fields: [
      { key: 'api_key', label: 'API Key', secret: true, hint: 'pplx-…' },
    ],
  },
  {
    slug: 'exa',
    name: 'Exa',
    vendor: 'Exa',
    kind: 'research',
    conn_method: 'rest',
    icon: ICONS.exa,
    cost_model: '1000 free / month',
    description: 'Neural search optimised for finding similar pages. Use when Tavily is too keyword-y.',
    default_policy: 'Auto for search/find_similar. Ask for contents (more expensive).',
    ops: [
      { name: 'search',        write: false, description: 'Neural web search.' },
      { name: 'find_similar',  write: false, description: 'Find pages similar to a URL.' },
      { name: 'contents',      write: false, description: 'Fetch cleaned page contents.' },
    ],
    secret_fields: [
      { key: 'api_key', label: 'API Key', secret: true, hint: 'exa-…' },
    ],
  },
  {
    slug: 'firecrawl',
    name: 'Firecrawl',
    vendor: 'Firecrawl',
    kind: 'research',
    conn_method: 'rest',
    icon: ICONS.firecrawl,
    cost_model: '500 free / month',
    description: 'Heavy-duty URL → markdown scraper. Use when a regulator site needs JS rendering.',
    default_policy: 'Ask for crawl (multi-page). Auto for single-page scrape.',
    ops: [
      { name: 'scrape', write: false, description: 'Single URL → markdown.' },
      { name: 'crawl',  write: false, description: 'Recursively crawl a domain.' },
    ],
    secret_fields: [
      { key: 'api_key', label: 'API Key', secret: true, hint: 'fc-…' },
    ],
  },
  {
    slug: 'ig-graph',
    name: 'Instagram Graph API',
    vendor: 'Meta',
    kind: 'publish',
    conn_method: 'rest',
    icon: ICONS.ig,
    cost_model: 'Free (Meta business account)',
    description: 'Direct Instagram Business API. Read posts, reply to DMs, publish carousels. Highest leverage for the brand.',
    default_policy: 'NEVER auto-publish. Ask for every send_dm, publish_post, reply_comment. Auto for read ops only.',
    ops: [
      { name: 'list_dms',      write: false, description: 'List recent DM conversations.' },
      { name: 'read_thread',   write: false, description: 'Read a single DM thread.' },
      { name: 'list_posts',    write: false, description: 'List recent posts.' },
      { name: 'send_dm',       write: true,  description: 'Send a DM reply.' },
      { name: 'publish_post',  write: true,  description: 'Publish a post or carousel.' },
      { name: 'reply_comment', write: true,  description: 'Reply to a comment.' },
    ],
    secret_fields: [
      { key: 'page_id',     label: 'IG Business Account ID', secret: false },
      { key: 'access_token',label: 'Long-lived access token', secret: true, hint: 'EAA…  Get from Meta Business' },
    ],
  },

  // ── Phase 3 · hosted MCP ─────────────────────────────────────────
  {
    slug: 'buffer',
    name: 'Buffer',
    vendor: 'Buffer',
    kind: 'publish',
    conn_method: 'mcp_http',
    icon: ICONS.buffer,
    cost_model: 'Free (3 channels) · then $5/channel/mo',
    description: 'Multi-platform scheduler. Has an official MCP server with 18 ops covering posts, drafts, channels, analytics.',
    default_policy: 'Ask for all schedule_post / publish_now. Auto for analytics reads.',
    ops: [], // populated by mcp_http tools/list on connect
    secret_fields: [
      { key: 'mcp_url',  label: 'MCP endpoint', secret: false, hint: 'https://api.buffer.com/mcp' },
      { key: 'api_key',  label: 'Buffer API token', secret: true },
    ],
  },
  {
    slug: 'ayrshare',
    name: 'Ayrshare',
    vendor: 'Ayrshare',
    kind: 'publish',
    conn_method: 'mcp_http',
    icon: ICONS.ayrshare,
    cost_model: '$49/mo · 13+ platforms',
    description: 'Single API for IG, TG, YT, LinkedIn, TikTok and more. Good fallback if you don\'t want to maintain Meta tokens.',
    default_policy: 'Ask for all post / schedule. Auto for analytics.',
    ops: [],
    secret_fields: [
      { key: 'mcp_url', label: 'MCP endpoint',  secret: false, hint: 'https://app.ayrshare.com/mcp' },
      { key: 'api_key', label: 'Ayrshare key',  secret: true },
    ],
  },
  {
    slug: 'postplanify',
    name: 'PostPlanify',
    vendor: 'PostPlanify',
    kind: 'publish',
    conn_method: 'mcp_http',
    icon: ICONS.postplanify,
    cost_model: '$15/mo · 10 platforms',
    description: '22 tools across 10 social platforms. Cheaper than Ayrshare for small workspaces.',
    default_policy: 'Ask for all create_post. Auto for read ops.',
    ops: [],
    secret_fields: [
      { key: 'mcp_url', label: 'MCP endpoint', secret: false },
      { key: 'api_key', label: 'API key',      secret: true },
    ],
  },
  {
    slug: 'xpoz',
    name: 'Xpoz',
    vendor: 'Xpoz',
    kind: 'analytics',
    conn_method: 'mcp_http',
    icon: ICONS.xpoz,
    cost_model: 'Pay-as-you-go',
    description: 'Cross-platform social intelligence. Trending hashtags, engagement data, competitor posts on X / IG / TikTok / Reddit.',
    default_policy: 'Auto for all read queries. Cap monthly spend at $10.',
    ops: [],
    secret_fields: [
      { key: 'mcp_url', label: 'MCP endpoint', secret: false },
      { key: 'api_key', label: 'API key',      secret: true },
    ],
  },
  {
    slug: 'creatorcrawl',
    name: 'CreatorCrawl',
    vendor: 'CreatorCrawl',
    kind: 'analytics',
    conn_method: 'mcp_http',
    icon: ICONS.creatorcrawl,
    cost_model: 'Pay-as-you-go credits',
    description: 'Trending sounds, hashtags, formats from TikTok / IG Reels / YT Shorts / Reddit. Best signal for Afshin.',
    default_policy: 'Auto for trends/hashtags. Ask for deep competitor pulls.',
    ops: [],
    secret_fields: [
      { key: 'mcp_url', label: 'MCP endpoint', secret: false },
      { key: 'api_key', label: 'API key',      secret: true },
    ],
  },

  // ── Phase 4 · local stdio MCP ────────────────────────────────────
  {
    slug: 'tiktok-mcp',
    name: 'TikTok MCP',
    vendor: 'seym0n/tiktok-mcp',
    kind: 'analytics',
    conn_method: 'mcp_stdio',
    icon: ICONS.tiktok,
    cost_model: 'Free (community)',
    description: 'Read-only TikTok virality analysis. No posting. Great for "what formats are trending in my niche".',
    default_policy: 'Auto for all (read-only by design).',
    ops: [],
    secret_fields: [
      { key: 'package',  label: 'npm package', secret: false, hint: '@seym0n/tiktok-mcp' },
      { key: 'tikneuron_key', label: 'TikNeuron key (optional)', secret: true },
    ],
  },
  {
    slug: 'reddit-mcp',
    name: 'Reddit MCP',
    vendor: 'community',
    kind: 'analytics',
    conn_method: 'mcp_stdio',
    icon: ICONS.reddit,
    cost_model: 'Free',
    description: 'Browse subs, search threads, read top posts. r/dentistry, r/IranianAmerican, r/canadaimmigration etc.',
    default_policy: 'Auto for all (read-only).',
    ops: [],
    secret_fields: [
      { key: 'package', label: 'npm package', secret: false, hint: 'reddit-mcp-server' },
    ],
  },

  // ── Sentinel · always-on test tool used to verify the framework ──
  {
    slug: 'echo',
    name: 'Echo (test)',
    vendor: 'internal',
    kind: 'internal',
    conn_method: 'rest',
    icon: ICONS.echo,
    cost_model: 'Free',
    description: 'Local test tool. Echoes the args back. Use this to verify the perm matrix and cost cap end-to-end.',
    default_policy: 'Auto.',
    ops: [
      { name: 'ping', write: false, description: 'Returns "pong" plus the args.' },
      { name: 'fail', write: false, description: 'Always errors. Use to test error paths.' },
    ],
    secret_fields: [],
  },
];

function list() { return CATALOG.slice(); }
function get(slug) { return CATALOG.find(t => t.slug === slug) || null; }

// Sync the catalog into Postgres `tools` table. Idempotent — UPSERTs on
// slug. Only metadata is synced; ops list for MCP tools stays in DB
// (because it's discovered at runtime via tools/list).
function sync() {
  const values = CATALOG.map(t => `(${[
    q(t.slug), q(t.name), q(t.vendor), q(t.kind), q(t.conn_method),
    q(t.icon), q(t.cost_model), q(t.description), q(t.default_policy),
    qJson(t.conn_method === 'rest' ? t.ops : []),  // REST ops are static; MCP ops discovered later
  ].join(',')})`).join(',');
  psql(`
    INSERT INTO tools (slug, name, vendor, kind, conn_method, icon,
                       cost_model, description, default_policy, ops)
    VALUES ${values}
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      vendor = EXCLUDED.vendor,
      kind = EXCLUDED.kind,
      conn_method = EXCLUDED.conn_method,
      icon = EXCLUDED.icon,
      cost_model = EXCLUDED.cost_model,
      description = EXCLUDED.description,
      default_policy = EXCLUDED.default_policy,
      updated_at = now();
  `);
  return CATALOG.length;
}

module.exports = { list, get, sync };
