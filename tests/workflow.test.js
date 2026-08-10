'use strict';
const assert = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const WORKFLOW       = path.join(__dirname, '../.github/workflows/code-review.yml');
const SCAN_SRC       = path.join(__dirname, '../src/scan.js');
const GUIDELINES_SRC = path.join(__dirname, '../src/guidelines.js');
const REVIEW_SCHEMA  = path.join(__dirname, '../schemas/github-review.json');

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

test('codex schema - shared schema is valid JSON', () => {
  JSON.parse(fs.readFileSync(REVIEW_SCHEMA, 'utf8'));
});

test('codex schema - OpenAI structured output: every property key is in required', () => {
  const schema = JSON.parse(fs.readFileSync(REVIEW_SCHEMA, 'utf8'));
  const errors = collectOpenAIViolations(schema);
  assert.deepEqual(errors, [], `Schema violations:\n${errors.join('\n')}`);
});

test('codex schema - uses the strict single-line comment contract', () => {
  const schema = JSON.parse(fs.readFileSync(REVIEW_SCHEMA, 'utf8'));
  const comments = schema.properties.comments;
  assert.equal(comments.maxItems, 100);
  assert.deepEqual(comments.items.required, ['path', 'body', 'line', 'side']);
  assert.equal(comments.items.additionalProperties, false);
  assert.deepEqual(
    Object.keys(comments.items.properties).sort(),
    ['body', 'line', 'path', 'side']
  );
});

test('codex schema - workflow derives its output schema from the shared schema', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /fs\.readFileSync\('_prepare\/trusted\/github-review\.json'/);
  assert.match(yaml, /_prepare\/trusted\/runtime\/codex-output-schema\.json/);
  assert.ok(!yaml.includes("cat > codex-output-schema.json << 'SCHEMA'"));
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

test('prepare stages scripts and schema from the self-checkout via cp, not a heredoc', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /cp _action\/src\/scan\.js _prepare\/trusted\/scripts\/scan\.js/);
  assert.match(yaml, /cp _action\/src\/guidelines\.js _prepare\/trusted\/scripts\/guidelines\.js/);
  assert.match(yaml, /cp _action\/schemas\/github-review\.json _prepare\/trusted\/github-review\.json/);
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
    REVIEW_EVENT: 'COMMENT_ONLY',
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

test('gate rejects unknown providers and review event policies', async () => {
  const yaml   = readWorkflow();
  const script = extractScriptBlock(yaml, 'const triggerMode = process.env.TRIGGER_MODE;');

  const badProvider = await runGateScript(script, { PROVIDER: 'other' });
  assert.equal(badProvider.setFailed.length, 1);
  assert.match(badProvider.setFailed[0], /Unknown provider/);

  const badEvent = await runGateScript(script, { REVIEW_EVENT: 'MAYBE' });
  assert.equal(badEvent.setFailed.length, 1);
  assert.match(badEvent.setFailed[0], /Unknown review_event/);
});

test('gate requires an exact /dd-review command token', () => {
  const yaml   = readWorkflow();
  const script = extractScriptBlock(yaml, 'const triggerMode = process.env.TRIGGER_MODE;');
  assert.match(script, /tokens\[0\] !== '\/dd-review'/);
  assert.ok(!script.includes("body.startsWith('/dd-review')"));
});

test('trusted checkouts use the default-branch commit pinned by gate', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /trusted_sha:\s+\$\{\{ steps\.gate\.outputs\.trusted_sha \}\}/);
  assert.match(yaml, /github\.rest\.git\.getRef/);
  assert.equal(
    (yaml.match(/ref:\s*\$\{\{ needs\.gate\.outputs\.trusted_sha \}\}/g) || []).length,
    2
  );
});

test('provider runtimes are pinned and bounded', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /openai\/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56/);
  assert.match(yaml, /codex-version:\s+0\.144\.5/);
  assert.match(yaml, /-iname "\.npmrc"/);
  assert.ok(yaml.indexOf('-iname ".npmrc"') < yaml.indexOf('uses: openai/codex-action@'));
  assert.match(yaml, /NPM_CONFIG_USERCONFIG:\s*\/dev\/null/);
  assert.match(yaml, /NPM_CONFIG_REGISTRY:\s*https:\/\/registry\.npmjs\.org\//);
  assert.match(yaml, /NPM_CONFIG_IGNORE_SCRIPTS:\s*'true'/);
  assert.match(yaml, /permission-profile:\s+":read-only"/);
  assert.ok(!yaml.includes('sandbox:         read-only'));
  assert.match(yaml, /npm pack --silent @google\/gemini-cli@0\.47\.0/);
  assert.match(yaml, /720d18dd7d9bc090[0-9a-f]{112}\s+\$gemini_tgz/);
  assert.match(yaml, /npm install [^\n]*--global "\.\/\$gemini_tgz"/);
  assert.match(yaml, /npm install [^\n]*--omit=optional/);
  assert.match(yaml, /rm -r -- "\$gemini_root\/node_modules"/);
  assert.match(yaml, /GEMINI_SANDBOX_IMAGE: 'us-docker\.pkg\.dev\/gemini-code-dev\/gemini-cli\/sandbox@sha256:[0-9a-f]{64}'/);
  assert.equal((yaml.match(/timeout-minutes:\s*30/g) || []).length, 3);
});

test('Claude uses the pinned official action with fail-closed structured output', () => {
  const yaml = readWorkflow();
  const start = yaml.indexOf('\n  review_claude:');
  const end = yaml.indexOf('\n  # -- REVIEW (Codex)', start);
  const claude = yaml.slice(start, end);

  assert.match(claude, /anthropics\/claude-code-action@6c0083bb7289c31716797a039b6367b3079cc46e/);
  assert.match(claude, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:\s*"1"/);
  assert.match(claude, /allowed_non_write_users:\s*"__force_sandbox_dummy__"/);
  assert.match(claude, /--tools "Read,Glob,Grep"/);
  assert.match(claude, /--allowedTools "Read,Glob,Grep"/);
  assert.match(claude, /--permission-mode dontAsk/);
  assert.match(claude, /--disallowedTools "Bash,Edit,Write,MultiEdit,NotebookEdit"/);
  assert.match(claude, /--setting-sources user/);
  assert.match(claude, /--max-turns 10/);
  assert.match(claude, /--json-schema/);
  assert.match(claude, /toJSON\(steps\.claude\.outputs\.structured_output\)/);
  assert.match(claude, /validateReview\(review\)/);
  assert.ok(!claude.includes('STRUCTURED_OUTPUT:'));
  assert.ok(!claude.includes('execution_file'));
  assert.ok(!claude.includes('src/claude.js'));
  assert.ok(!claude.includes("candidate.indexOf('{')"));
  assert.ok(!claude.includes('trigger_phrase:'));
  assert.ok(!claude.includes('track_progress:'));
});

test('prepare generates a complete pinned local diff and rejects oversized input', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /ref:\s*refs\/pull\/\$\{\{ needs\.gate\.outputs\.pr_number \}\}\/head/);
  assert.match(yaml, /actual_head=.*git -C _diff_source rev-parse HEAD/);
  assert.match(yaml, /--no-ext-diff --no-textconv/);
  assert.match(yaml, /diff_bytes.*-gt 1000000/);
  assert.match(yaml, /diff_lines.*-gt 20000/);
  assert.ok(!yaml.includes('application/vnd.github.v3.diff'));
});

test('repository-reading providers use the base pull ref and verify the pinned head', () => {
  const yaml = readWorkflow();
  const claudeStart = yaml.indexOf('\n  review_claude:');
  const codexStart = yaml.indexOf('\n  review_codex:');
  const geminiStart = yaml.indexOf('\n  review_gemini:');
  const postStart = yaml.indexOf('\n  post:');
  const sections = [
    yaml.slice(claudeStart, codexStart),
    yaml.slice(codexStart, geminiStart),
    yaml.slice(geminiStart, postStart),
  ];

  for (const section of sections) {
    assert.match(section, /repository:\s*\$\{\{ github\.repository \}\}/);
    assert.match(section, /ref:\s*refs\/pull\/\$\{\{ needs\.gate\.outputs\.pr_number \}\}\/head/);
    assert.match(section, /actual_head=.*git(?: -C __untrusted)? rev-parse HEAD/);
    assert.match(section, /actual_head.*!=.*HEAD_SHA/);
    assert.ok(!section.includes('repository: ${{ needs.gate.outputs.head_repo }}'));
  }
});

test('prepare stores API-derived changed filenames as structured JSON', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /_prepare\/untrusted\/changed_files\.json/);
  assert.match(yaml, /JSON\.stringify\(files\.map/);
  assert.match(yaml, /JSON\.parse\(fs\.readFileSync\('_prepare\/untrusted\/changed_files\.json'/);
  assert.ok(!yaml.includes('_prepare/untrusted/changed_files.txt'));
});

test('post never executes code from a cross-job artifact', () => {
  const yaml = readWorkflow();
  const start = yaml.indexOf('\n  post:');
  const end = yaml.indexOf('\n  # -- FINISH SIGNAL', start);
  const post = yaml.slice(start, end);

  assert.match(post, /repository:\s*\$\{\{ job\.workflow_repository \}\}/);
  assert.match(post, /ref:\s*\$\{\{ job\.workflow_sha \}\}/);
  assert.match(post, /require\(path\.join\(process\.env\.GITHUB_WORKSPACE, '_action\/src\/scan\.js'\)\)/);
  assert.match(post, /path:\s*_review_artifact/);
  assert.match(post, /lstatSync\(artifactPath\)/);
  assert.match(post, /currentPull\.state !== 'open' \|\| currentPull\.head\.sha !== commit_id/);
  assert.ok(!post.includes('name: ai-review-prepare'));
  assert.ok(!post.includes('_prepare/trusted/scripts/scan.js'));
});

test('fork reviews cannot pass through merge-affecting events', () => {
  const yaml = readWorkflow();
  assert.match(yaml, /is_fork:\s+\$\{\{ steps\.gate\.outputs\.is_fork \}\}/);
  assert.match(yaml, /const isFork\s+= process\.env\.IS_FORK === 'true'/);
  assert.match(yaml, /reviewEventPolicy === 'ALL' && !isFork \? review\.event : 'COMMENT'/);
});

test('cancelled runs close their check without reporting a technical failure', () => {
  const yaml = readWorkflow();
  const start = yaml.indexOf('\n  finish_signal:');
  const finish = yaml.slice(start);

  assert.match(finish, /id:\s*cancellation\s+if:\s*\$\{\{ cancelled\(\) \}\}/);
  assert.match(finish, /Close check-run and update reaction\s+if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(finish, /RUN_CANCELLED:\s*\$\{\{ steps\.cancellation\.outputs\.cancelled \|\| 'false' \}\}/);
  assert.match(finish, /const wasCancelled = .*RUN_CANCELLED.*postResult === 'cancelled'/);
  assert.match(finish, /wasCancelled\s*\? 'cancelled'/);
  assert.match(finish, /if \(!wasCancelled && postResult !== 'success'\)/);
  assert.match(finish, /!wasCancelled && conclusion === 'failure'/);
});
