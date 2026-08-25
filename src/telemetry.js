'use strict';

const https = require('node:https');

const SCHEMA_VERSION = 1;
const PROVIDERS = new Set(['claude', 'codex', 'gemini']);
const STATUSES = new Set(['success', 'failure', 'cancelled']);
const COST_SOURCES = new Set(['provider_reported', 'estimated', 'unavailable']);
const DATADOG_SITES = new Set([
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ddog-gov.com',
  'us2.ddog-gov.com',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'uk1.datadoghq.com',
]);
const USAGE_FIELDS = new Set([
  'schema_version', 'provider', 'model', 'api_requests', 'input_tokens',
  'cached_input_tokens', 'output_tokens', 'duration_ms', 'cost_usd',
  'cost_source', 'pricing_version', 'status',
]);

const LIMITS = Object.freeze({
  api_requests: 1_000_000,
  input_tokens: 1_000_000_000_000,
  cached_input_tokens: 1_000_000_000_000,
  output_tokens: 1_000_000_000_000,
  duration_ms: 7 * 24 * 60 * 60 * 1000,
  cost_usd: 1_000_000,
});

function safeNumber(value, { integer = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

function safeString(value, maxLength = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ? value : null;
}

function emptyUsage(provider, durationMs, status) {
  return {
    schema_version: SCHEMA_VERSION,
    provider,
    model: null,
    api_requests: null,
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    duration_ms: safeNumber(durationMs, { integer: true, max: LIMITS.duration_ms }),
    cost_usd: null,
    cost_source: 'unavailable',
    pricing_version: null,
    status: STATUSES.has(status) ? status : 'failure',
  };
}

function normalizeClaude(messages, { durationMs, status = 'success' } = {}) {
  const out = emptyUsage('claude', durationMs, status);
  if (!Array.isArray(messages)) return out;

  const init = messages.find((entry) => entry && entry.type === 'system' && entry.subtype === 'init');
  out.model = safeString(init?.model);

  let input = 0;
  let cached = 0;
  let output = 0;
  let usageEntries = 0;
  for (const entry of messages) {
    if (!entry || entry.type !== 'assistant' || !entry.message || typeof entry.message !== 'object') continue;
    const usage = entry.message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const direct = safeNumber(usage.input_tokens, { integer: true, max: LIMITS.input_tokens });
    const created = safeNumber(usage.cache_creation_input_tokens ?? 0, { integer: true, max: LIMITS.input_tokens });
    const read = safeNumber(usage.cache_read_input_tokens ?? 0, { integer: true, max: LIMITS.cached_input_tokens });
    const generated = safeNumber(usage.output_tokens, { integer: true, max: LIMITS.output_tokens });
    if ([direct, created, read, generated].some((v) => v === null)) continue;
    input += direct + created;
    cached += read;
    output += generated;
    usageEntries++;
  }
  if (usageEntries && input <= LIMITS.input_tokens && cached <= LIMITS.cached_input_tokens && output <= LIMITS.output_tokens) {
    out.input_tokens = input;
    out.cached_input_tokens = cached;
    out.output_tokens = output;
  }

  const results = messages.filter((entry) => entry && entry.type === 'result');
  const result = results.at(-1);
  if (result) {
    out.api_requests = safeNumber(result.num_turns, { integer: true, max: LIMITS.api_requests });
    const providerDuration = safeNumber(result.duration_ms, { integer: true, max: LIMITS.duration_ms });
    if (providerDuration !== null) out.duration_ms = providerDuration;
    const cost = safeNumber(result.total_cost_usd, { max: LIMITS.cost_usd });
    if (cost !== null) {
      out.cost_usd = cost;
      out.cost_source = 'provider_reported';
    }
  }
  return out;
}

function normalizeGemini(document, { durationMs, status = 'success' } = {}) {
  const out = emptyUsage('gemini', durationMs, status);
  const models = document && typeof document === 'object' && document.stats &&
    typeof document.stats === 'object' && document.stats.models &&
    typeof document.stats.models === 'object' && !Array.isArray(document.stats.models)
    ? document.stats.models : null;
  if (!models) return out;

  const entries = Object.entries(models);
  if (entries.length === 1) out.model = safeString(entries[0][0]);
  let requests = 0;
  let input = 0;
  let cached = 0;
  let output = 0;
  let valid = entries.length > 0;
  for (const [, metrics] of entries) {
    const req = safeNumber(metrics?.api?.totalRequests, { integer: true, max: LIMITS.api_requests });
    const uncached = safeNumber(metrics?.tokens?.input, { integer: true, max: LIMITS.input_tokens });
    const cacheRead = safeNumber(metrics?.tokens?.cached, { integer: true, max: LIMITS.cached_input_tokens });
    const candidates = safeNumber(metrics?.tokens?.candidates, { integer: true, max: LIMITS.output_tokens });
    const thoughts = safeNumber(metrics?.tokens?.thoughts ?? 0, { integer: true, max: LIMITS.output_tokens });
    if ([req, uncached, cacheRead, candidates, thoughts].some((v) => v === null)) { valid = false; break; }
    requests += req;
    input += uncached;
    cached += cacheRead;
    // Gemini's candidates exclude thought tokens; both are output billing dimensions.
    output += candidates + thoughts;
  }
  if (valid && requests <= LIMITS.api_requests && input <= LIMITS.input_tokens &&
      cached <= LIMITS.cached_input_tokens && output <= LIMITS.output_tokens) {
    out.api_requests = requests;
    out.input_tokens = input;
    out.cached_input_tokens = cached;
    out.output_tokens = output;
  }
  return out;
}

function normalizeCodex(events, { durationMs, status = 'success', model = null } = {}) {
  const out = emptyUsage('codex', durationMs, status);
  out.model = safeString(model);
  const parsed = Array.isArray(events) ? events : [];
  let input = 0;
  let cached = 0;
  let output = 0;
  let requests = 0;
  for (const event of parsed) {
    if (!event || event.type !== 'turn.completed' || !event.usage) continue;
    const i = safeNumber(event.usage.input_tokens, { integer: true, max: LIMITS.input_tokens });
    const c = safeNumber(event.usage.cached_input_tokens, { integer: true, max: LIMITS.cached_input_tokens });
    const o = safeNumber(event.usage.output_tokens, { integer: true, max: LIMITS.output_tokens });
    if ([i, c, o].some((v) => v === null) || c > i) continue;
    // Codex reports cache-inclusive input; expose uncached and cached separately.
    input += i - c;
    cached += c;
    output += o;
    requests++;
  }
  if (requests && requests <= LIMITS.api_requests && input <= LIMITS.input_tokens &&
      cached <= LIMITS.cached_input_tokens && output <= LIMITS.output_tokens) {
    out.api_requests = requests;
    out.input_tokens = input;
    out.cached_input_tokens = cached;
    out.output_tokens = output;
  }
  return out;
}

function validateUsage(value, expectedProvider) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { errors: ['usage must be an object'], value: null };
  for (const key of Object.keys(value)) if (!USAGE_FIELDS.has(key)) errors.push(`unexpected field: ${key}`);
  for (const key of USAGE_FIELDS) if (!(key in value)) errors.push(`missing field: ${key}`);
  if (value.schema_version !== SCHEMA_VERSION) errors.push('unsupported schema_version');
  if (!PROVIDERS.has(value.provider)) errors.push('invalid provider');
  if (value.provider !== expectedProvider) errors.push('provider mismatch');
  if (value.model !== null && safeString(value.model) === null) errors.push('invalid model');
  if (!STATUSES.has(value.status)) errors.push('invalid status');
  if (!COST_SOURCES.has(value.cost_source)) errors.push('invalid cost_source');
  if (value.pricing_version !== null && safeString(value.pricing_version, 64) === null) errors.push('invalid pricing_version');
  for (const [field, max] of Object.entries(LIMITS)) {
    const number = value[field];
    if (number !== null && safeNumber(number, { integer: field !== 'cost_usd', max }) === null) errors.push(`invalid ${field}`);
  }
  if (value.cost_source === 'unavailable' && value.cost_usd !== null) errors.push('unavailable cost must be null');
  if (value.cost_source !== 'unavailable' && value.cost_usd === null) errors.push('available cost must be numeric');
  if (value.cost_source === 'estimated' && value.pricing_version === null) errors.push('estimated cost requires pricing_version');
  return { errors, value: errors.length ? null : Object.fromEntries([...USAGE_FIELDS].map((key) => [key, value[key]])) };
}

function validateSite(site) {
  return DATADOG_SITES.has(site) ? site : null;
}

function validateRepository(repository) {
  if (typeof repository !== 'string' || repository.length > 200) return null;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : null;
}

function point(metric, value, tags, timestamp) {
  return { metric, type: 1, points: [{ timestamp, value }], tags };
}

function buildFinishSeries(usage, { trigger, repository, status, timestamp = Math.floor(Date.now() / 1000) }) {
  const checked = validateUsage(usage, usage?.provider);
  if (checked.errors.length) throw new Error(checked.errors.join('; '));
  if (!['manual', 'automatic'].includes(trigger)) throw new Error('invalid trigger');
  const repo = validateRepository(repository);
  if (!repo) throw new Error('invalid repository');
  if (!STATUSES.has(status)) throw new Error('invalid status');
  const value = checked.value;
  const model = value.model || 'unavailable';
  const tags = [
    `provider:${value.provider}`, `trigger:${trigger}`, `model:${model}`,
    `status:${status}`, `cost_source:${value.cost_source}`, `repository:${repo}`,
  ];
  const series = [point('code_review_action.review_runs', 1, tags, timestamp)];
  const metrics = {
    api_requests: 'code_review_action.provider_api_requests',
    input_tokens: 'code_review_action.input_tokens',
    cached_input_tokens: 'code_review_action.cached_input_tokens',
    output_tokens: 'code_review_action.output_tokens',
    cost_usd: 'code_review_action.cost_usd',
    duration_ms: 'code_review_action.duration_ms',
  };
  for (const [field, metric] of Object.entries(metrics)) {
    if (value[field] !== null) series.push(point(metric, value[field], tags, timestamp));
  }
  const missing = value.model === null || Object.keys(metrics).some((field) => value[field] === null);
  if (missing) series.push(point('code_review_action.telemetry_missing', 1, tags, timestamp));
  return series;
}

function submitSeries({ site, apiKey, series, request = https.request }) {
  return new Promise((resolve, reject) => {
    if (!validateSite(site)) { reject(new Error(`unsupported Datadog site: ${site}`)); return; }
    if (typeof apiKey !== 'string' || !apiKey.trim()) { reject(new Error('Datadog API key is missing')); return; }
    if (!Array.isArray(series) || !series.length) { reject(new Error('no metrics to submit')); return; }
    const body = JSON.stringify({ series });
    const req = request({
      protocol: 'https:', hostname: `api.${site}`, port: 443, path: '/api/v2/series', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'DD-API-KEY': apiKey,
        'User-Agent': 'code-review-action-telemetry/1',
      },
      timeout: 10_000,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Datadog metrics API returned HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Datadog metrics API request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = {
  SCHEMA_VERSION, DATADOG_SITES, LIMITS, emptyUsage, normalizeClaude, normalizeGemini,
  normalizeCodex, validateUsage, validateSite, validateRepository,
  buildFinishSeries, submitSeries,
};
