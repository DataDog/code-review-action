'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const telemetry = require('../src/telemetry');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/telemetry', name), 'utf8'));

test('Claude usage normalization uses SDK metadata and provider-reported cost', () => {
  assert.deepEqual(telemetry.normalizeClaude(fixture('claude.json'), { durationMs: 1, status: 'success' }), {
    schema_version: 2,
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    api_requests: 4,
    input_tokens: 1300,
    cached_input_tokens: 1600,
    output_tokens: 200,
    duration_ms: 42000,
    cost_usd: 0.42,
    cost_source: 'provider_reported',
    pricing_version: null,
    api_errors: null,
    tool_calls: null,
    provider_latency_ms: null,
    status: 'success',
  });
});

test('Gemini usage normalization includes aggregate provider statistics and leaves cost unavailable', () => {
  const value = telemetry.normalizeGemini(fixture('gemini.json'), { durationMs: 43000, status: 'success' });
  assert.equal(value.model, 'gemini-2.5-pro');
  assert.equal(value.api_requests, 3);
  assert.equal(value.input_tokens, 1200);
  assert.equal(value.cached_input_tokens, 800);
  assert.equal(value.output_tokens, 350);
  assert.equal(value.duration_ms, 43000);
  assert.equal(value.api_errors, 0);
  assert.equal(value.tool_calls, 0);
  assert.equal(value.provider_latency_ms, 41000);
  assert.equal(value.cost_usd, null);
  assert.equal(value.cost_source, 'unavailable');
});

test('Codex structured turn events can be normalized without log scraping', () => {
  const value = telemetry.normalizeCodex(fixture('codex.json'), {
    durationMs: 1000, status: 'success', model: 'gpt-5.2-codex',
  });
  assert.equal(value.api_requests, 2);
  assert.equal(value.input_tokens, 700);
  assert.equal(value.cached_input_tokens, 1000);
  assert.equal(value.output_tokens, 120);
  assert.equal(value.model, 'gpt-5.2-codex');
});

test('unknown model and unavailable cost remain null, never zero', () => {
  const value = telemetry.emptyUsage('codex', 25, 'failure');
  assert.equal(value.model, null);
  assert.equal(value.cost_usd, null);
  assert.equal(value.cost_source, 'unavailable');
  assert.ok(telemetry.buildFinishSeries(value, {
    trigger: 'manual', repository: 'DataDog/example', status: 'failure', timestamp: 1,
  }).some((point) => point.metric === 'code_review_action.telemetry_missing'));
});

test('usage validator rejects provider mismatch, extra fields, malicious tags, and bad numbers', () => {
  const base = telemetry.normalizeClaude(fixture('claude.json'), { status: 'success' });
  const cases = [
    [{ ...base, provider: 'gemini' }, 'claude'],
    [{ ...base, prompt: 'secret' }, 'claude'],
    [{ ...base, model: 'safe\nrepository:evil' }, 'claude'],
    [{ ...base, input_tokens: -1 }, 'claude'],
    [{ ...base, output_tokens: Infinity }, 'claude'],
    [{ ...base, duration_ms: telemetry.LIMITS.duration_ms + 1 }, 'claude'],
    [{ ...base, api_errors: telemetry.LIMITS.api_errors + 1 }, 'claude'],
    [{ ...base, tool_calls: -1 }, 'claude'],
    [{ ...base, provider_latency_ms: Infinity }, 'claude'],
    [{ ...base, cost_source: 'unavailable', cost_usd: 0 }, 'claude'],
  ];
  for (const [value, provider] of cases) {
    assert.ok(telemetry.validateUsage(value, provider).errors.length > 0);
  }
});

test('site validation accepts standard Datadog sites and rejects URLs/arbitrary hosts', () => {
  assert.equal(telemetry.validateSite('datadoghq.com'), 'datadoghq.com');
  assert.equal(telemetry.validateSite('uk1.datadoghq.com'), 'uk1.datadoghq.com');
  assert.equal(telemetry.validateSite('https://datadoghq.com'), null);
  assert.equal(telemetry.validateSite('attacker.example'), null);
});

test('finish series counts one review run alongside usage metrics', () => {
  const value = telemetry.normalizeClaude(fixture('claude.json'), { durationMs: 42000, status: 'success' });
  const series = telemetry.buildFinishSeries(value, {
    trigger: 'manual', repository: 'DataDog/cra', status: 'success', timestamp: 123,
  });
  const runs = series.find((point) => point.metric === 'code_review_action.review_runs');
  assert.deepEqual(runs, {
    metric: 'code_review_action.review_runs', type: 1,
    points: [{ timestamp: 123, value: 1 }],
    tags: [
      'provider:claude', 'trigger:manual', 'model:claude-sonnet-4-5',
      'status:success', 'cost_source:provider_reported', 'repository:DataDog/cra',
    ],
  });
});

test('finish series submits Gemini provider statistics when available', () => {
  const usage = telemetry.normalizeGemini(fixture('gemini.json'), { durationMs: 43000, status: 'success' });
  const series = telemetry.buildFinishSeries(usage, {
    trigger: 'automatic', repository: 'DataDog/cra', status: 'success', timestamp: 123,
  });
  const metric = (name) => series.find((point) => point.metric === name)?.points[0].value;
  assert.equal(metric('code_review_action.provider_api_errors'), 0);
  assert.equal(metric('code_review_action.provider_tool_calls'), 0);
  assert.equal(metric('code_review_action.provider_latency_ms'), 41000);
});

test('Datadog API errors reject without exposing the key', async () => {
  let options;
  const fakeRequest = (opts, callback) => {
    options = opts;
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 500;
      response.resume = () => {};
      callback(response);
      response.emit('end');
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  const usage = telemetry.emptyUsage('claude', 25, 'success');
  await assert.rejects(telemetry.submitSeries({
    site: 'datadoghq.com', apiKey: 'super-secret',
    series: telemetry.buildFinishSeries(usage, { trigger: 'automatic', repository: 'DataDog/cra', status: 'success' }),
    request: fakeRequest,
  }), /HTTP 500/);
  assert.equal(options.protocol, 'https:');
  assert.equal(options.hostname, 'api.datadoghq.com');
  assert.equal(options.path, '/api/v2/series');
  assert.equal(options.headers['DD-API-KEY'], 'super-secret');
});

test('CLI warns and remains fail-open for a missing API key or invalid site', () => {
  const cli = path.join(__dirname, '../bin/telemetry.js');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cra-telemetry-'));
  const usageFile = path.join(directory, 'usage.json');
  try {
    fs.writeFileSync(usageFile, JSON.stringify(telemetry.emptyUsage('claude', 100, 'success')));
    for (const testCase of [
      { site: 'datadoghq.com', apiKey: '', warning: /API key is missing/ },
      { site: 'https://datadoghq.com', apiKey: 'not-a-real-key', warning: /unsupported Datadog site/ },
    ]) {
      const result = spawnSync(process.execPath, [cli, 'finish', '--provider', 'claude',
        '--trigger', 'manual', '--repository', 'DataDog/cra', '--site', testCase.site,
        '--usage-file', usageFile, '--claude-result', 'success'], {
        encoding: 'utf8', env: { ...process.env, DD_API_KEY: testCase.apiKey },
      });
      assert.equal(result.status, 0);
      assert.match(result.stderr, /::warning title=Code review telemetry::/);
      assert.match(result.stderr, testCase.warning);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI rejects an oversized usage artifact and remains fail-open', () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cra-telemetry-'));
  const usageFile = path.join(directory, 'usage.json');
  try {
    fs.writeFileSync(usageFile, JSON.stringify({ padding: 'x'.repeat(65 * 1024) }));
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/telemetry.js'), 'finish',
      '--provider', 'claude', '--trigger', 'manual', '--repository', 'DataDog/cra',
      '--site', 'datadoghq.com', '--usage-file', usageFile, '--claude-result', 'failure'], {
      encoding: 'utf8', env: { ...process.env, DD_API_KEY: '' },
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /usage artifact rejected: input file is missing or exceeds 65536 bytes/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
