'use strict';
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '../bin/find-guidelines.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
           GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  });
}

function writeFile(repoDir, rel, content) {
  const full = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Sets up a repo with a base commit containing guideline files, then a
// second commit that changes a file under team-a/. Returns { repoDir, base, head }.
function makeGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-guidelines-cli-'));
  git(repoDir, ['init', '-q']);
  writeFile(repoDir, 'codereview_guideline.md', 'ROOT GUIDE');
  writeFile(repoDir, 'team-a/codereview_guideline.md', 'TEAM A GUIDE');
  writeFile(repoDir, 'team-b/sub/codereview_guideline.md', 'TEAM B SUB GUIDE');
  writeFile(repoDir, 'team-a/handler.go', 'package a\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  const base = git(repoDir, ['rev-parse', 'HEAD']).trim();

  writeFile(repoDir, 'team-a/handler.go', 'package a\n// changed\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'change team-a']);
  const head = git(repoDir, ['rev-parse', 'HEAD']).trim();

  return { repoDir, base, head };
}

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* left null on parse failure */ }
  return { ...result, parsed };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('CLI - pattern mode discovers and scopes guidelines via git diff, matching in-process behavior', () => {
  const { repoDir, base, head } = makeGitRepo();
  const { status, parsed } = run([
    '--repo-root', repoDir,
    '--pattern', '**/codereview_guideline.md',
    '--base', base, '--head', head,
  ]);

  assert.equal(status, 0);
  assert.equal(parsed.error, null);
  assert.equal(parsed.included, 2);
  assert.deepEqual(parsed.guidelines, [
    { path: 'codereview_guideline.md', content: 'ROOT GUIDE' },
    { path: 'team-a/codereview_guideline.md', content: 'TEAM A GUIDE' },
  ]);
  assert.equal(parsed.guidelinesBody, 'ROOT GUIDE\n\n---\nTEAM A GUIDE');
});

test('CLI - prompt-file mode accepts repeated flags', () => {
  const { repoDir, base, head } = makeGitRepo();
  const { status, parsed } = run([
    '--repo-root', repoDir,
    '--prompt-file', 'codereview_guideline.md',
    '--prompt-file', 'team-a/codereview_guideline.md',
    '--base', base, '--head', head,
  ]);

  assert.equal(status, 0);
  assert.equal(parsed.included, 2);
});

test('CLI - --changed-files overrides git-derived changes', () => {
  const { repoDir } = makeGitRepo();
  const changedFilesPath = path.join(repoDir, 'changed.txt');
  fs.writeFileSync(changedFilesPath, 'team-b/sub/anything.go\n');

  const { status, parsed } = run([
    '--repo-root', repoDir,
    '--pattern', '**/codereview_guideline.md',
    '--changed-files', changedFilesPath,
  ]);

  assert.equal(status, 0);
  assert.equal(parsed.included, 2);
  assert.deepEqual(parsed.guidelines.map(g => g.path), [
    'codereview_guideline.md',
    'team-b/sub/codereview_guideline.md',
  ]);
});

test('CLI - no --base and no --changed-files means only root-level guidelines apply', () => {
  const { repoDir } = makeGitRepo();
  const { status, parsed } = run([
    '--repo-root', repoDir,
    '--pattern', '**/codereview_guideline.md',
  ]);

  assert.equal(status, 0);
  assert.deepEqual(parsed.guidelines.map(g => g.path), ['codereview_guideline.md']);
});

test('CLI - rejects --pattern and --prompt-file together with exit code 1', () => {
  const { repoDir } = makeGitRepo();
  const { status, parsed } = run([
    '--repo-root', repoDir,
    '--pattern', '**/codereview_guideline.md',
    '--prompt-file', 'codereview_guideline.md',
  ]);

  assert.equal(status, 1);
  assert.match(parsed.error, /mutually exclusive/);
});

test('CLI - missing explicit prompt-file entry is a fatal error with exit code 1', () => {
  const { repoDir } = makeGitRepo();
  const { status, parsed } = run([
    '--repo-root', repoDir,
    '--prompt-file', 'does-not-exist.md',
  ]);

  assert.equal(status, 1);
  assert.match(parsed.error, /was not found/);
});

test('CLI - falls back to --builtin text when nothing matches', () => {
  const { repoDir } = makeGitRepo();
  const { status, parsed } = run([
    '--repo-root', repoDir,
    '--pattern', 'no/such/*.md',
    '--builtin', 'FALLBACK TEXT',
  ]);

  assert.equal(status, 0);
  assert.equal(parsed.included, 0);
  assert.equal(parsed.guidelinesBody, 'FALLBACK TEXT');
});

test('CLI - falls back to empty string when nothing matches and no --builtin is given', () => {
  const { repoDir } = makeGitRepo();
  const { status, parsed } = run([
    '--repo-root', repoDir,
    '--pattern', 'no/such/*.md',
  ]);

  assert.equal(status, 0);
  assert.equal(parsed.guidelinesBody, '');
});

test('CLI - unknown argument exits with code 2 and prints usage to stderr', () => {
  const result = run(['--not-a-real-flag']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: find-guidelines/);
  assert.match(result.stderr, /unknown argument/);
});

test('CLI - --help prints usage and exits 0', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: find-guidelines/);
});
