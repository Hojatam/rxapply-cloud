// cowork-proxy/compose-renderers.js
// =====================================================================
// Renderer registry for the Compose orchestrator.
//
// Renderers are deterministic JS functions (no LLM call) that take the
// last LLM stage's output and produce the final artifact in the format
// the recipe declared. One renderer per output format.
//
// Contract:
//   render({ source, run, recipe, lang }) → object | string
//
// `source` is whichever upstream stage produced the structured fields
// (typically the `adapt` stage for non-IG formats, or `draft` if a recipe
// has no adapt stage).
//
// Real renderers ship in M26-M27. This file provides:
//   • _default — pass-through (puts source under `body`)
//   • email-html, seo-article, telegram, facebook, x-thread, ig
//     stubs that return the source unchanged with a `_format_warning`
//     so M26 has a clear extension point.
//
// Each renderer should be PURE — same source ⇒ same output. No DB writes.
// =====================================================================

'use strict';

function _default({ source, run, recipe, lang }) {
  return {
    _renderer: '_default',
    lang: lang || run.master_lang,
    body: source && source.fields ? source.fields : source,
  };
}

// Stubs — replaced by full implementations in M26 / M27.
function _stub(name, source, run, recipe, lang) {
  return {
    _renderer: name,
    _format_warning: `Renderer "${name}" is a stub; full implementation lands in M26/M27.`,
    lang: lang || run.master_lang,
    fields: source && source.fields ? source.fields : source,
  };
}

module.exports = {
  _default,
  // Format-specific stubs (M26)
  'email-html':  ({ source, run, recipe, lang }) => _stub('email-html', source, run, recipe, lang),
  'seo-article': ({ source, run, recipe, lang }) => _stub('seo-article', source, run, recipe, lang),
  'telegram':    ({ source, run, recipe, lang }) => _stub('telegram', source, run, recipe, lang),
  // Format-specific stubs (M27)
  'facebook':    ({ source, run, recipe, lang }) => _stub('facebook', source, run, recipe, lang),
  'x-thread':    ({ source, run, recipe, lang }) => _stub('x-thread', source, run, recipe, lang),
  // IG (M28)
  'ig':          ({ source, run, recipe, lang }) => _stub('ig', source, run, recipe, lang),
};
