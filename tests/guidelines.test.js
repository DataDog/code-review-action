'use strict';
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { parseList, globToRegExp, discoverPatternFiles, isInScope, mutualExclusivityError, buildGuidelines } = require('../src/guidelines.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrustedTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidelines-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// parseList
// ---------------------------------------------------------------------------

test('parseList - splits, trims, and drops blank lines', () => {
  assert.deepEqual(parseList('guide.md\n  bazel/guide.md \n\n'), ['guide.md', 'bazel/guide.md']);
});

test('parseList - empty input returns empty array', () => {
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
});

// ---------------------------------------------------------------------------
// discoverPatternFiles
// ---------------------------------------------------------------------------

test('discoverPatternFiles - walks nested directories and returns posix-relative paths', () => {
  const dir = makeTrustedTree({
    'codereview_guideline.md': 'root',
    'team-a/codereview_guideline.md': 'a',
    'team-b/sub/codereview_guideline.md': 'b',
  });
  const found = discoverPatternFiles(dir, '**/codereview_guideline.md');
  assert.deepEqual(found, [
    'codereview_guideline.md',
    'team-a/codereview_guideline.md',
    'team-b/sub/codereview_guideline.md',
  ]);
});

test('discoverPatternFiles - skips .git directories', () => {
  const dir = makeTrustedTree({
    'codereview_guideline.md': 'root',
    '.git/HEAD': 'ref: refs/heads/main',
  });
  assert.deepEqual(discoverPatternFiles(dir, '**/codereview_guideline.md'), ['codereview_guideline.md']);
});

// ---------------------------------------------------------------------------
// globToRegExp
// ---------------------------------------------------------------------------

test('globToRegExp - "**/name.md" matches at any depth, including the root', () => {
  const re = globToRegExp('**/codereview_guideline.md');
  assert.ok(re.test('codereview_guideline.md'));
  assert.ok(re.test('team-a/codereview_guideline.md'));
  assert.ok(re.test('team-a/sub/codereview_guideline.md'));
  assert.ok(!re.test('team-a/handler.go'));
  assert.ok(!re.test('codereview_guideline.md.bak'));
});

test('globToRegExp - "*" matches within a single path segment only', () => {
  const re = globToRegExp('bazel/*.md');
  assert.ok(re.test('bazel/guide.md'));
  assert.ok(!re.test('bazel/sub/guide.md'));
});

test('globToRegExp - "**/*.md" matches any markdown file at any depth', () => {
  const re = globToRegExp('**/*.md');
  assert.ok(re.test('guide.md'));
  assert.ok(re.test('a/b/c/guide.md'));
  assert.ok(!re.test('guide.txt'));
});

test('globToRegExp - literal patterns without wildcards match only the exact path', () => {
  const re = globToRegExp('codereview_guideline.md');
  assert.ok(re.test('codereview_guideline.md'));
  assert.ok(!re.test('team-a/codereview_guideline.md'));
});

test('globToRegExp - regex metacharacters in the pattern are treated literally', () => {
  const re = globToRegExp('a+b.md');
  assert.ok(re.test('a+b.md'));
  assert.ok(!re.test('ab.md'));
});

test('globToRegExp - "?" matches exactly one character within a segment', () => {
  const re = globToRegExp('guide?.md');
  assert.ok(re.test('guide1.md'));
  assert.ok(!re.test('guide12.md'));
  assert.ok(!re.test('guide/.md'));
});

test('globToRegExp - trailing "**" without a slash matches the rest of the path', () => {
  const re = globToRegExp('team-a/**');
  assert.ok(re.test('team-a/guide.md'));
  assert.ok(re.test('team-a/sub/guide.md'));
  assert.ok(!re.test('team-b/guide.md'));
});

test('discoverPatternFiles - missing directory returns empty array', () => {
  assert.deepEqual(discoverPatternFiles('/nonexistent/path/for/sure', '**/*.md'), []);
});

test('discoverPatternFiles - only returns files matching the glob, not everything on disk', () => {
  const dir = makeTrustedTree({
    'codereview_guideline.md': 'root',
    'team-a/codereview_guideline.md': 'a',
    'team-a/handler.go': 'package a',
  });
  assert.deepEqual(discoverPatternFiles(dir, '**/codereview_guideline.md'), [
    'codereview_guideline.md',
    'team-a/codereview_guideline.md',
  ]);
});

test('discoverPatternFiles - result is sorted regardless of filesystem readdir order', () => {
  // Create entries in reverse-alphabetical order so a naive implementation
  // relying on fs.readdirSync order (not guaranteed sorted) would return
  // them out of order. Found via dogfooding: a real /dd-review run on this
  // repo caught this as a determinism bug before this test existed.
  const dir = makeTrustedTree({
    'team-b/codereview_guideline.md': 'b',
    'team-a/codereview_guideline.md': 'a',
    'codereview_guideline.md': 'root',
  });
  assert.deepEqual(discoverPatternFiles(dir, '**/codereview_guideline.md'), [
    'codereview_guideline.md',
    'team-a/codereview_guideline.md',
    'team-b/codereview_guideline.md',
  ]);
});

// ---------------------------------------------------------------------------
// isInScope
// ---------------------------------------------------------------------------

test('isInScope - root-level file always applies', () => {
  assert.ok(isInScope('guide.md', []));
  assert.ok(isInScope('guide.md', ['unrelated/file.go']));
});

test('isInScope - subdirectory file applies only when a changed file shares the prefix', () => {
  assert.ok(isInScope('bazel/guide.md', ['bazel/BUILD']));
  assert.ok(!isInScope('bazel/guide.md', ['pkg/auth/foo.go']));
});

test('isInScope - exact directory-as-file match counts as in scope', () => {
  assert.ok(isInScope('bazel/guide.md', ['bazel']));
});

// ---------------------------------------------------------------------------
// buildGuidelines - prompt_file (explicit list) behavior is unchanged
// ---------------------------------------------------------------------------

test('buildGuidelines - neither input set falls back to built-in', () => {
  const result = buildGuidelines({
    promptFiles: '', promptFilePattern: '', changedFiles: [],
    trustedDir: '__trusted', builtinGuidelines: 'BUILTIN',
  });
  assert.equal(result.error, null);
  assert.equal(result.included, 0);
  assert.equal(result.guidelinesBody, 'BUILTIN');
  assert.ok(result.info.some(m => m.includes('prompt_file not set')));
});

test('buildGuidelines - prompt_file includes root file unconditionally', () => {
  const dir = makeTrustedTree({ 'guide.md': 'ROOT GUIDE' });
  const result = buildGuidelines({
    promptFiles: 'guide.md', promptFilePattern: '', changedFiles: [],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.equal(result.error, null);
  assert.equal(result.included, 1);
  assert.equal(result.guidelinesBody, 'ROOT GUIDE');
});

test('buildGuidelines - prompt_file subdirectory entry requires a changed-file match', () => {
  const dir = makeTrustedTree({ 'bazel/guide.md': 'BAZEL GUIDE' });
  const outOfScope = buildGuidelines({
    promptFiles: 'bazel/guide.md', promptFilePattern: '', changedFiles: ['pkg/foo.go'],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.equal(outOfScope.included, 0);
  assert.equal(outOfScope.guidelinesBody, 'BUILTIN');

  const inScope = buildGuidelines({
    promptFiles: 'bazel/guide.md', promptFilePattern: '', changedFiles: ['bazel/BUILD'],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.equal(inScope.included, 1);
  assert.equal(inScope.guidelinesBody, 'BAZEL GUIDE');
});

test('buildGuidelines - prompt_file entry missing on default branch is a fatal error', () => {
  const dir = makeTrustedTree({});
  const result = buildGuidelines({
    promptFiles: 'missing.md', promptFilePattern: '', changedFiles: [],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.match(result.error, /was not found on the default branch/);
});

test('buildGuidelines - prompt_file path traversal is rejected', () => {
  const dir = makeTrustedTree({});
  const result = buildGuidelines({
    promptFiles: '../../etc/passwd', promptFilePattern: '', changedFiles: [],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.match(result.error, /Path traversal detected/);
});

test('buildGuidelines - multiple in-scope prompt_file entries are joined with a separator', () => {
  const dir = makeTrustedTree({ 'guide.md': 'ROOT', 'bazel/guide.md': 'BAZEL' });
  const result = buildGuidelines({
    promptFiles: 'guide.md\nbazel/guide.md', promptFilePattern: '', changedFiles: ['bazel/BUILD'],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.equal(result.included, 2);
  assert.equal(result.guidelinesBody, 'ROOT\n\n---\nBAZEL');
});

// ---------------------------------------------------------------------------
// buildGuidelines - prompt_file_pattern (auto-discovery)
// ---------------------------------------------------------------------------

test('buildGuidelines - prompt_file_pattern discovers and scopes files exactly like prompt_file', () => {
  const dir = makeTrustedTree({
    'codereview_guideline.md': 'ROOT',
    'team-a/codereview_guideline.md': 'TEAM A',
    'team-b/sub/codereview_guideline.md': 'TEAM B SUB',
  });
  // Only a team-a file changed: root always applies, team-a applies, team-b/sub does not.
  const result = buildGuidelines({
    promptFiles: '', promptFilePattern: '**/codereview_guideline.md', changedFiles: ['team-a/handler.go'],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.equal(result.error, null);
  assert.equal(result.included, 2);
  assert.equal(result.guidelinesBody, 'ROOT\n\n---\nTEAM A');
  assert.ok(result.info.some(m => m.includes('Out of scope for this PR: team-b/sub/codereview_guideline.md')));
});

test('buildGuidelines - prompt_file_pattern with no matches falls back to built-in', () => {
  const dir = makeTrustedTree({});
  const result = buildGuidelines({
    promptFiles: '', promptFilePattern: '**/codereview_guideline.md', changedFiles: [],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.equal(result.included, 0);
  assert.equal(result.guidelinesBody, 'BUILTIN');
  assert.ok(result.info.some(m => m.includes('No files matched prompt_file_pattern')));
});

test('buildGuidelines - prompt_file_pattern never fails when a discovered file scopes out; it is skipped, not fatal', () => {
  const dir = makeTrustedTree({ 'team-b/sub/codereview_guideline.md': 'TEAM B SUB' });
  const result = buildGuidelines({
    promptFiles: '', promptFilePattern: '**/codereview_guideline.md', changedFiles: ['unrelated/file.go'],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.equal(result.error, null);
  assert.equal(result.included, 0);
  assert.equal(result.guidelinesBody, 'BUILTIN');
});

// ---------------------------------------------------------------------------
// buildGuidelines - structured `guidelines` list (for non-workflow consumers,
// e.g. a local CLI that wants per-file path/content rather than a
// pre-joined blob)
// ---------------------------------------------------------------------------

test('buildGuidelines - guidelines array reports path/content for each included file, in scope order', () => {
  const dir = makeTrustedTree({
    'codereview_guideline.md': 'ROOT',
    'team-a/codereview_guideline.md': 'TEAM A',
  });
  const result = buildGuidelines({
    promptFiles: '', promptFilePattern: '**/codereview_guideline.md', changedFiles: ['team-a/handler.go'],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.deepEqual(result.guidelines, [
    { path: 'codereview_guideline.md', content: 'ROOT' },
    { path: 'team-a/codereview_guideline.md', content: 'TEAM A' },
  ]);
});

test('buildGuidelines - guidelines array is empty when nothing is included', () => {
  const dir = makeTrustedTree({});
  const result = buildGuidelines({
    promptFiles: '', promptFilePattern: '**/codereview_guideline.md', changedFiles: [],
    trustedDir: dir, builtinGuidelines: 'BUILTIN',
  });
  assert.deepEqual(result.guidelines, []);
});

test('buildGuidelines - builtinGuidelines defaults to an empty string when omitted', () => {
  const result = buildGuidelines({
    promptFiles: '', promptFilePattern: '', changedFiles: [], trustedDir: '__trusted',
  });
  assert.equal(result.error, null);
  assert.equal(result.guidelinesBody, '');
});

// ---------------------------------------------------------------------------
// mutualExclusivityError
// ---------------------------------------------------------------------------

test('mutualExclusivityError - null when only one of the two is set', () => {
  assert.equal(mutualExclusivityError('guide.md', ''), null);
  assert.equal(mutualExclusivityError('', '**/codereview_guideline.md'), null);
});

test('mutualExclusivityError - null when neither is set', () => {
  assert.equal(mutualExclusivityError('', ''), null);
  assert.equal(mutualExclusivityError(undefined, undefined), null);
});

test('mutualExclusivityError - returns a message when both are set', () => {
  const err = mutualExclusivityError('guide.md', '**/codereview_guideline.md');
  assert.match(err, /mutually exclusive/);
});
