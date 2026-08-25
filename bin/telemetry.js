#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const telemetry = fs.existsSync(path.join(__dirname, '../src/telemetry.js'))
  ? require('../src/telemetry')
  : require('./telemetry');

const MAX_PROVIDER_FILE = 50 * 1024 * 1024;
const MAX_USAGE_FILE = 64 * 1024;

function warning(message) {
  const safe = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stderr.write(`::warning title=Code review telemetry::${safe}\n`);
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function readJson(file, maxSize) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maxSize) throw new Error(`input file is missing or exceeds ${maxSize} bytes`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function duration() {
  let raw = arg('started-ms');
  const startedFile = arg('started-ms-file');
  if (startedFile) {
    try { raw = fs.readFileSync(startedFile, 'utf8').trim(); } catch { raw = ''; }
  }
  const started = Number(raw);
  return Number.isFinite(started) && started >= 0 ? Math.max(0, Date.now() - started) : null;
}

function writeUsage(value) {
  const output = arg('output', '_usage/usage.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function normalize() {
  const provider = arg('provider');
  const status = arg('status', 'failure');
  const source = arg('source');
  let value;
  try {
    if (provider === 'claude') value = telemetry.normalizeClaude(readJson(source, MAX_PROVIDER_FILE), { durationMs: duration(), status });
    else if (provider === 'gemini') value = telemetry.normalizeGemini(readJson(source, MAX_PROVIDER_FILE), { durationMs: duration(), status });
    else if (provider === 'codex') {
      // The pinned codex-action exposes only the final message. Keep usage null until
      // upstream exposes its structured --json event stream as a file/output.
      value = telemetry.emptyUsage('codex', duration(), status);
    } else throw new Error('invalid provider');
  } catch (error) {
    warning(`${provider || 'provider'} usage unavailable: ${error.message}`);
    value = telemetry.emptyUsage(provider, duration(), status);
  }
  writeUsage(value);
}

function resultFor(provider) {
  const result = arg(`${provider}-result`, 'skipped');
  return ['success', 'failure', 'cancelled'].includes(result) ? result : 'failure';
}

async function submit() {
  try {
    const provider = arg('provider');
    const trigger = arg('trigger');
    const repository = arg('repository');
    const file = arg('usage-file', 'usage.json');
    let usage;
    try {
      usage = readJson(file, MAX_USAGE_FILE);
      const checked = telemetry.validateUsage(usage, provider);
      if (checked.errors.length) throw new Error(checked.errors.join('; '));
      usage = checked.value;
    } catch (error) {
      warning(`usage artifact rejected: ${error.message}`);
      usage = telemetry.emptyUsage(provider, null, resultFor(provider));
    }
    const series = telemetry.buildFinishSeries(usage, {
      trigger, repository, status: resultFor(provider),
    });
    await telemetry.submitSeries({ site: arg('site'), apiKey: process.env.DD_API_KEY, series });
  } catch (error) {
    // Deliberately fail-open: a warning is the only observable failure signal.
    warning(error.message);
  }
}

const command = process.argv[2];
if (command === 'normalize') normalize();
else if (command === 'finish') submit();
else {
  warning(`unknown command: ${command || '(missing)'}`);
  process.exitCode = 0;
}
