'use strict';
const assert = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const WORKFLOW       = path.join(__dirname, '../.github/workflows/code-review.yml');
const SCAN_SRC       = path.join(__dirname, '../src/scan.js');
const GUIDELINES_SRC = path.join(__dirname, '../src/guidelines.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readWorkflow() {
  return fs.readFileSync(WORKFLOW, 'utf8');
}

// Extract content between two heredoc markers in the workflow YAML, stripping
// the uniform leading whitespace added by YAML run-block indentation.
function extractHeredoc(yaml, startMarker, endMarker) {
  const lines  = yaml.split('\n');
  const result = [];
  let capturing = false;
  let indent    = 0;

  for (const line of lines) {
    if (!capturing && line.includes(startMarker)) {
      // Measure indentation of the content that follows (next non-empty line)
      capturing = true;
      indent    = line.search(/\S/); // leading spaces on the marker line
      continue;
    }
    if (capturing) {
      const trimmed = line.trimEnd();
      if (trimmed === ' '.repeat(indent) + endMarker) { capturing = false; continue; }
      result.push(line.startsWith(' '.repeat(indent)) ? line.slice(indent) : line);
    }
  }
  return result.join('\n');
}

// Extracts a `script: |` block scalar from the workflow YAML by locating a
// line of source unique to that block, then collecting every subsequent line
// that is indented at least as much as the block's first line of content.
function extractScriptBlock(yaml, anchorLine) {
  const lines = yaml.split('\n');
  const anchorIdx = lines.findIndex(l => l.includes(anchorLine));
  if (anchorIdx === -1) throw new Error(`anchor not found: ${anchorLine}`);

  let scriptLineIdx = -1;
  for (let i = anchorIdx; i >= 0; i--) {
    if (/^\s*script:\s*\|\s*$/.test(lines[i])) { scriptLineIdx = i; break; }
  }
  if (scriptLineIdx === -1) throw new Error(`'script: |' not found above anchor: ${anchorLine}`);

  let bodyIndent = -1;
  for (let i = scriptLineIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    bodyIndent = lines[i].search(/\S/);
    break;
  }
  if (bodyIndent === -1) throw new Error('script block has no content');

  const result = [];
  for (let i = scriptLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && line.search(/\S/) < bodyIndent) break;
    result.push(line.length >= bodyIndent ? line.slice(bodyIndent) : line);
  }
  return result.join('\n');
}

// Recursively validate that every key in `properties` also appears in
// `required` — the rule OpenAI structured outputs enforce.
function collectOpenAIViolations(schema, path = '') {
  const errors = [];
  if (schema && typeof schema === 'object') {
    if (schema.type === 'object' && schema.properties) {
      const propKeys = Object.keys(schema.properties);
      const required = Array.isArray(schema.required) ? schema.required : [];
      const missing  = propKeys.filter(k => !required.includes(k));
      if (missing.length) {
        errors.push(`${path || '(root)'}: properties [${missing.join(', ')}] not in required`);
      }
      for (const [k, v] of Object.entries(schema.properties)) {
        errors.push(...collectOpenAIViolations(v, `${path}.properties.${k}`));
      }
    }
    if (schema.items)  errors.push(...collectOpenAIViolations(schema.items,  `${path}.items`));
    if (schema.anyOf)  schema.anyOf.forEach((s, i) => errors.push(...collectOpenAIViolations(s, `${path}.anyOf[${i}]`)));
    if (schema.oneOf)  schema.oneOf.forEach((s, i) => errors.push(...collectOpenAIViolations(s, `${path}.oneOf[${i}]`)));
    if (schema.allOf)  schema.allOf.forEach((s, i) => errors.push(...collectOpenAIViolations(s, `${path}.allOf[${i}]`)));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Codex schema conformance
// ---------------------------------------------------------------------------

test('codex schema - is valid JSON', () => {
  const yaml = readWorkflow();
  const raw  = extractHeredoc(yaml, "cat > codex-output-schema.json << 'SCHEMA'", 'SCHEMA');
  assert.ok(raw.trim().length > 0, 'extracted schema must not be empty');
  // Throws SyntaxError if invalid
  JSON.parse(raw);
});

test('codex schema - OpenAI structured output: every property key is in required', () => {
  const yaml   = readWorkflow();
  const raw    = extractHeredoc(yaml, "cat > codex-output-schema.json << 'SCHEMA'", 'SCHEMA');
  const schema = JSON.parse(raw);
  const errors = collectOpenAIViolations(schema);
  assert.deepEqual(errors, [], `Schema violations:\n${errors.join('\n')}`);
});

test('codex schema - optional fields use anyOf with null branch', () => {
  const yaml    = readWorkflow();
  const raw     = extractHeredoc(yaml, "cat > codex-output-schema.json << 'SCHEMA'", 'SCHEMA');
  const schema  = JSON.parse(raw);
  const items   = schema.properties.comments.items;
  const optionals = ['side', 'start_line', 'start_side'];
  for (const field of optionals) {
    const def = items.properties[field];
    assert.ok(Array.isArray(def.anyOf), `${field} must use anyOf`);
    const hasNull = def.anyOf.some(b => b.type === 'null');
    assert.ok(hasNull, `${field}.anyOf must include a null branch`);
  }
});

// ---------------------------------------------------------------------------
// self-checkout wiring for scan.js / guidelines.js
//
// The workflow no longer inlines these as heredocs; it self-checks-out this
// action's own repo (pinned to job.workflow_sha) and copies src/*.js from
// there, so there's nothing to byte-compare anymore - correctness is
// structural (cp), not textual. These tests just confirm the plumbing.
// ---------------------------------------------------------------------------

test('prepare self-checkout is pinned to job.workflow_repository/job.workflow_sha', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /repository:\s*\$\{\{\s*job\.workflow_repository\s*\}\}/);
  assert.match(yaml, /ref:\s*\$\{\{\s*job\.workflow_sha\s*\}\}/);
  assert.match(yaml, /path:\s*_action/);
});

test('prepare stages scan.js and guidelines.js from the self-checkout via cp, not a heredoc', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /cp _action\/src\/scan\.js _prepare\/scripts\/scan\.js/);
  assert.match(yaml, /cp _action\/src\/guidelines\.js _prepare\/scripts\/guidelines\.js/);
  assert.ok(!yaml.includes("cat > _prepare/scripts/scan.js << 'SCRIPT'"), 'scan.js should no longer be inlined as a heredoc');
  assert.ok(!yaml.includes("cat > _prepare/scripts/guidelines.js << 'SCRIPT'"), 'guidelines.js should no longer be inlined as a heredoc');
});

test('src/scan.js and src/guidelines.js are the files the self-checkout stages (sanity: they exist and are real modules)', () => {
  require(SCAN_SRC);
  require(GUIDELINES_SRC);
});

// ---------------------------------------------------------------------------
// prompt_file / prompt_file_pattern input definitions
// ---------------------------------------------------------------------------

// Extracts the body of a top-level `inputs:` entry (6-space indent) by name,
// up to the next sibling key at the same indent. Anchoring on the exact
// indent avoids matching mentions of the same name in comments elsewhere
// (e.g. the usage example near the top of the file, which is `#`-prefixed).
function extractInputBlock(yaml, name, nextName) {
  const startMatch = new RegExp(`\\n      ${name}:\\n`).exec(yaml);
  if (!startMatch) throw new Error(`input '${name}' not found`);
  const start = startMatch.index + 1;
  const nextMatch = new RegExp(`\\n      ${nextName}:\\n`).exec(yaml.slice(start));
  const end = nextMatch ? start + nextMatch.index : yaml.length;
  return yaml.slice(start, end);
}

test('workflow_call inputs - prompt_file_pattern exists with an empty string default', () => {
  const yaml = readWorkflow();
  const inputBlock = extractInputBlock(yaml, 'prompt_file_pattern', 'review_event');
  assert.match(inputBlock, /description:/);
  assert.match(inputBlock, /type:\s*string/);
  assert.match(inputBlock, /default:\s*''/);
});

test('workflow_call inputs - prompt_file and prompt_file_pattern both document mutual exclusivity', () => {
  const yaml = readWorkflow();
  const promptFileBlock    = extractInputBlock(yaml, 'prompt_file', 'prompt_file_pattern');
  const promptPatternBlock = extractInputBlock(yaml, 'prompt_file_pattern', 'review_event');
  assert.match(promptFileBlock, /[Mm]utually exclusive/);
  assert.match(promptPatternBlock, /[Mm]utually exclusive/);
});

// ---------------------------------------------------------------------------
// gate: prompt_file / prompt_file_pattern mutual exclusivity
// ---------------------------------------------------------------------------

// Runs the extracted gate script with a minimal core/context/github stub.
// The mutual-exclusivity guard is the first thing the script does and
// `return`s immediately on violation, so no other API surface needs mocking.
async function runGateScript(script, env) {
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    TRIGGER_MODE: 'always', PROVIDER: 'claude',
    PROMPT_FILE: '', PROMPT_FILE_PATTERN: '',
    ...env,
  });
  const calls = { setFailed: [], setOutput: [], info: [] };
  const core = {
    setFailed: (msg) => calls.setFailed.push(msg),
    setOutput: (k, v) => calls.setOutput.push([k, v]),
    info:      (msg) => calls.info.push(msg),
    warning:   () => {},
  };
  // context.eventName is left undefined so, past the guard, the script hits
  // its "Unknown trigger_mode"/"Skipping" branches and returns without
  // touching github.rest.
  const context = { payload: {}, repo: {} };
  const github  = {};
  try {
    const fn = new Function('core', 'context', 'github',
      `return (async () => { ${script} })();`);
    await fn(core, context, github);
  } finally {
    process.env = savedEnv;
  }
  return calls;
}

test('gate rejects prompt_file and prompt_file_pattern set together', async () => {
  const yaml   = readWorkflow();
  const script = extractScriptBlock(yaml, 'const triggerMode = process.env.TRIGGER_MODE;');
  const calls  = await runGateScript(script, {
    PROMPT_FILE: 'guide.md', PROMPT_FILE_PATTERN: '**/codereview_guideline.md',
  });
  assert.equal(calls.setFailed.length, 1);
  assert.match(calls.setFailed[0], /mutually exclusive/);
  // proceed is set false before the guard runs, and nothing overrides it.
  assert.deepEqual(calls.setOutput, [['proceed', 'false']]);
});

test('gate does not fail the mutual-exclusivity guard when only prompt_file is set', async () => {
  const yaml   = readWorkflow();
  const script = extractScriptBlock(yaml, 'const triggerMode = process.env.TRIGGER_MODE;');
  const calls  = await runGateScript(script, { PROMPT_FILE: 'guide.md' });
  assert.equal(calls.setFailed.length, 0);
});

test('gate does not fail the mutual-exclusivity guard when only prompt_file_pattern is set', async () => {
  const yaml   = readWorkflow();
  const script = extractScriptBlock(yaml, 'const triggerMode = process.env.TRIGGER_MODE;');
  const calls  = await runGateScript(script, { PROMPT_FILE_PATTERN: '**/codereview_guideline.md' });
  assert.equal(calls.setFailed.length, 0);
});
