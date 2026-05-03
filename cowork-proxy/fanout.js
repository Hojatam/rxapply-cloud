// cowork-proxy/fanout.js
// =====================================================================
// M48 · Fan-out · 1 source compose run → N channel-shaped runs.
//
// Founder finishes a master content piece (e.g. an SEO article, a long
// email, a Telegram channel post). With one click they expand it into
// IG caption, Facebook post, X thread, Email teaser, additional Telegram
// post — each rendered for that channel's conventions and (optionally)
// their target languages.
//
// Implementation: a thin orchestration layer over composeOrchestrator.
// For each requested channel we create a NEW compose_runs row whose
// topic is the source's final body (rich text or markdown), and whose
// metadata.fanout_source_run_id points back to the source. Each child
// run is independent — has its own gates, its own timeline, its own
// publish action. We DON'T parallelise inside the orchestrator (its
// sequential phase model is intentional); we parallelise BETWEEN runs
// by spawning N independent runs.
//
// Public API:
//   expand({ sourceRunId, channels, options, gateStrategy, masterLang, targetLangs })
//     → { ok, source_run_id, children: [{ recipe, run_id, status }] }
// =====================================================================

'use strict';

const { queryRows } = require('./db');
const composeOrchestrator = require('./compose-orchestrator');

// Try to extract a useful "source body" from a finished compose run's
// final output. The shape varies by recipe — pick the most-substantive field.
function _extractSourceBody(run) {
  const out = run.final_output || {};
  const masterLang = run.master_lang || 'en';
  const langOut = out[masterLang] || (Object.values(out)[0]) || {};

  // Per-recipe field preferences
  switch (run.recipe_id) {
    case 'email':       return [langOut.subject, langOut.body_md].filter(Boolean).join('\n\n');
    case 'seo-article': return [langOut.title, langOut.meta_description, langOut.body_md].filter(Boolean).join('\n\n');
    case 'telegram':    return langOut.body_plain || langOut.body_md || '';
    case 'facebook':    return [langOut.hook, langOut.body, langOut.cta_text].filter(Boolean).join('\n\n');
    case 'x-thread':    return Array.isArray(langOut.tweets) ? langOut.tweets.join('\n\n') : '';
    case 'ig':          return [langOut.caption, (langOut.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
    default:
      // Fallback: pick the first non-empty string field from the language output
      for (const v of Object.values(langOut)) {
        if (typeof v === 'string' && v.trim().length > 40) return v;
      }
      return JSON.stringify(langOut).slice(0, 4000);
  }
}

// Validate a target recipe id against the recipe loader. Throws on unknown.
function _validateRecipe(recipeId) {
  const recipe = composeOrchestrator.getRecipe(recipeId);   // throws if unknown
  return recipe;
}

async function expand({ sourceRunId, channels = [], options = {}, gateStrategy = 'critique',
                        masterLang = null, targetLangs = null, agentOverrides = {},
                        startImmediately = true }) {
  if (!sourceRunId) throw new Error('sourceRunId required');
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('channels[] required');

  // Validate every channel up-front so we don't half-create
  for (const c of channels) _validateRecipe(c);

  const source = await composeOrchestrator.getRun(sourceRunId);
  if (!source) throw new Error('source run not found');
  if (source.status !== 'done' && source.status !== 'awaiting_approval') {
    throw new Error(`source run is in status ${source.status}; finish it first (must be done or awaiting_approval)`);
  }

  const sourceBody = _extractSourceBody(source);
  if (!sourceBody.trim()) throw new Error('could not extract a usable body from the source run');

  // For each channel, create + (optionally) kick off a child run
  const children = [];
  for (const recipeId of channels) {
    try {
      // Topic for the child = the source body. Audience inherits from source.
      // We tag fanout_source_run_id in options for traceability.
      const childOptions = {
        ...(options || {}),
        fanout_source_run_id: sourceRunId,
        fanout_source_recipe: source.recipe_id,
      };
      const r = await composeOrchestrator.start({
        recipeId,
        topic: sourceBody.slice(0, 8000),
        audience: source.audience,
        masterLang: masterLang || source.master_lang,
        targetLangs: Array.isArray(targetLangs) ? targetLangs : (source.target_langs || []),
        options: childOptions,
        gateStrategy,
        agentOverrides,
      });
      children.push({ recipe: recipeId, run_id: r.id, status: 'queued' });

      // Fire-and-forget run-to-block (don't block on N parallel calls)
      if (startImmediately) {
        composeOrchestrator.runToBlock(r.id, { maxIterations: 60 }).catch(() => {});
      }
    } catch (e) {
      children.push({ recipe: recipeId, run_id: null, status: 'failed', error: e.message });
    }
  }

  return {
    ok: true,
    source_run_id: sourceRunId,
    source_recipe: source.recipe_id,
    n_channels: channels.length,
    children,
  };
}

// List child runs that were fanned out from a given source.
async function listChildren(sourceRunId) {
  const rows = await queryRows(`
    SELECT id::text, recipe_id, topic, master_lang, target_langs, status,
            current_stage, total_cost_usd, created_at::text, finished_at::text
      FROM compose_runs
     WHERE options->>'fanout_source_run_id' = '${String(sourceRunId).replace(/'/g, "''")}'
     ORDER BY created_at DESC;`);
  return rows;
}

module.exports = { expand, listChildren };
