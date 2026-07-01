'use strict';
const assert = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const WORKFLOW = path.join(__dirname, '../.github/workflows/code-review.yml');
const SCAN_SRC = path.join(__dirname, '../src/scan.js');

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
// scan.js sync check
// ---------------------------------------------------------------------------

test('src/scan.js matches inline scan.js in workflow YAML', () => {
  const yaml      = readWorkflow();
  const inlined   = extractHeredoc(yaml, "cat > _prepare/scripts/scan.js << 'SCRIPT'", 'SCRIPT');
  const sourceFile = fs.readFileSync(SCAN_SRC, 'utf8');

  // Normalise: trim trailing whitespace per line and strip leading/trailing blank lines
  const normalise = s => s.split('\n').map(l => l.trimEnd()).join('\n').trim();

  const a = normalise(inlined);
  const b = normalise(sourceFile);

  if (a !== b) {
    // Show first differing line to make it easy to fix
    const aLines = a.split('\n');
    const bLines = b.split('\n');
    const maxLen = Math.max(aLines.length, bLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (aLines[i] !== bLines[i]) {
        assert.fail(
          `src/scan.js and the inline YAML version diverged at line ${i + 1}:\n` +
          `  YAML: ${JSON.stringify(aLines[i])}\n` +
          `   src: ${JSON.stringify(bLines[i])}`
        );
      }
    }
  }
});
