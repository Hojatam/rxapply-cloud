// cowork-proxy/agent-contracts.js
// =====================================================================
// M49 · Per-capability output contract schemas.
//
// Each LLM stage in compose-orchestrator's pipeline returns JSON. The
// orchestrator parses it and passes it downstream. M49 adds explicit
// validation: required fields, expected types, allowed enum values.
// On validation failure, the orchestrator retries ONCE with the validation
// errors prepended to the user prompt. If still invalid, the stage fails.
//
// Why this matters (per Anthropic's multi-agent research): subagents need
// "an objective, an output format, guidance." Loose contracts produce drift
// + duplication. Tighter contracts produce more reliable pipelines.
//
// The validator here is intentionally tiny (no AJV dep). It supports:
//   - { type: 'string' | 'number' | 'boolean' | 'array' | 'object' }
//   - { required: true }
//   - { enum: ['a', 'b', 'c'] }
//   - { items: <schema> }   (for arrays)
//   - { properties: { … } } (for objects, recursive)
//   - { minLength, maxLength } for strings
//
// Public API:
//   validate(stageName, output) → { ok: true } | { ok: false, errors: [...] }
//   schemaFor(stageName) → schema object | null
// =====================================================================

'use strict';

// ── Per-capability schemas ───────────────────────────────────────────

const SCHEMAS = {
  plan: {
    type: 'object',
    properties: {
      topic:               { type: 'string', required: true, minLength: 4 },
      audience_pain_point: { type: 'string', required: true, minLength: 10 },
      angle:               { type: 'string', required: true, minLength: 10 },
      success_criteria:    { type: 'array',  required: true, items: { type: 'string' } },
      complexity:          { type: 'string', enum: ['trivial', 'standard', 'deep'] },
    },
  },

  research: {
    type: 'object',
    properties: {
      key_facts:          { type: 'array',  required: true, items: { type: 'string' } },
      regulatory_context: { type: 'string' },
      sources_used:       { type: 'array',  items: { type: 'string' } },
    },
  },

  verify: {
    type: 'object',
    properties: {
      passed:             { type: 'boolean', required: true },
      issues:             { type: 'array',   items: { type: 'object' } },
      overall_confidence: { type: 'number' },
    },
  },

  'verify-translation': {
    type: 'object',
    properties: {
      passed:             { type: 'boolean', required: true },
      issues:             { type: 'array',   items: { type: 'object' } },
      overall_confidence: { type: 'number' },
    },
  },

  draft: {
    type: 'object',
    properties: {
      title: { type: 'string', required: true, minLength: 4 },
      body:  { type: 'string', required: true, minLength: 30 },
    },
  },

  critique: {
    type: 'object',
    properties: {
      verdict: { type: 'string', required: true, enum: ['pass', 'needs_refine', 'fail'] },
      scores:  { type: 'object', required: true },
      actionable_fixes: { type: 'array', items: { type: 'string' } },
    },
  },

  audit: {
    type: 'object',
    properties: {
      verdict: { type: 'string', required: true, enum: ['pass', 'pass_with_flags', 'block'] },
      claims:  { type: 'array',  required: true, items: { type: 'object' } },
      summary: { type: 'string' },
    },
  },

  adapt: {
    type: 'object',
    properties: {
      fields: { type: 'object', required: true },
    },
  },

  translate: {
    type: 'object',
    properties: {
      fields: { type: 'object', required: true },
    },
  },

  design: {
    type: 'object',
    properties: {
      style:             { type: 'string',  required: true },
      composition:       { type: 'string',  required: true },
      color_palette:     { type: 'array',   required: true, items: { type: 'string' } },
      mood:              { type: 'string',  required: true },
      recommended_model: { type: 'string' },
      final_prompt:      { type: 'string',  required: true, minLength: 30 },
    },
  },

  // Eval harness · pairwise judge
  judge: {
    type: 'object',
    properties: {
      winner_overall:  { type: 'string', required: true, enum: ['candidate', 'baseline', 'tie'] },
      winner_on_brand: { type: 'string', required: true, enum: ['candidate', 'baseline', 'tie'] },
      winner_accuracy: { type: 'string', required: true, enum: ['candidate', 'baseline', 'tie'] },
      winner_format:   { type: 'string', required: true, enum: ['candidate', 'baseline', 'tie'] },
      reasoning:       { type: 'object' },
      confidence:      { type: 'number' },
    },
  },

  // DM triage
  triage: {
    type: 'object',
    properties: {
      status:     { type: 'string', required: true,
                    enum: ['curious', 'qualifying', 'hot', 'off-topic', 'complaint'] },
      confidence: { type: 'number', required: true },
      reasoning:  { type: 'string' },
      language:   { type: 'string' },
    },
  },

  'reply-draft': {
    type: 'object',
    properties: {
      draft:    { type: 'string', required: true, minLength: 10 },
      language: { type: 'string', required: true },
    },
  },
};

// ── Lightweight validator ────────────────────────────────────────────

function _typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function _validate(value, schema, pathStr = '$') {
  const errs = [];
  if (!schema) return errs;

  // Type check
  if (schema.type) {
    const t = _typeOf(value);
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.includes(t) && !(t === 'null' && schema.required !== true)) {
      errs.push(`${pathStr}: expected type ${allowed.join('|')}, got ${t}`);
      return errs;   // can't validate further if type is wrong
    }
  }

  // Enum check
  if (Array.isArray(schema.enum) && value != null && !schema.enum.includes(value)) {
    errs.push(`${pathStr}: value "${String(value).slice(0, 40)}" must be one of [${schema.enum.join(', ')}]`);
  }

  // String length
  if (schema.type === 'string' && typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errs.push(`${pathStr}: string length ${value.length} below minimum ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errs.push(`${pathStr}: string length ${value.length} above maximum ${schema.maxLength}`);
    }
  }

  // Array items
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errs.push(..._validate(item, schema.items, `${pathStr}[${i}]`));
    });
  }

  // Object properties
  if (schema.type === 'object' && value && typeof value === 'object') {
    const props = schema.properties || {};
    for (const [k, sub] of Object.entries(props)) {
      const present = Object.prototype.hasOwnProperty.call(value, k);
      if (sub.required && !present) {
        errs.push(`${pathStr}.${k}: required field missing`);
        continue;
      }
      if (present) {
        errs.push(..._validate(value[k], sub, `${pathStr}.${k}`));
      }
    }
  }

  return errs;
}

// ── Public API ───────────────────────────────────────────────────────

function schemaFor(stageName) {
  return SCHEMAS[stageName] || null;
}

function validate(stageName, output) {
  const schema = SCHEMAS[stageName];
  if (!schema) return { ok: true, errors: [] };          // no contract for this stage
  const errors = _validate(output, schema);
  return errors.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, errors };
}

// Render the schema as a brief block to inject when retrying — gives the
// model the EXACT contract it failed against.
function renderRetryHint(stageName, errors) {
  const schema = SCHEMAS[stageName];
  if (!schema) return '';
  return [
    '⚠ The previous response failed contract validation. Errors:',
    ...errors.map(e => `  • ${e}`),
    '',
    'You MUST return JSON that satisfies the contract for this stage. Re-emit the JSON now,',
    'fixing the issues listed above. Do not include explanations or apologies.',
  ].join('\n');
}

module.exports = {
  SCHEMAS,
  validate,
  schemaFor,
  renderRetryHint,
};
