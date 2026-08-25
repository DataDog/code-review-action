'use strict';
const TOKEN_PATTERNS = [
  { label: 'github-token',    pattern: /ghp_[A-Za-z0-9_]{36,}/ },
  { label: 'github-token',    pattern: /gho_[A-Za-z0-9_]{36,}/ },
  { label: 'github-token',    pattern: /ghs_[A-Za-z0-9_]{36,}/ },
  { label: 'github-token',    pattern: /ghr_[A-Za-z0-9_]{36,}/ },
  { label: 'github-token',    pattern: /ghu_[A-Za-z0-9_]{36,}/ },
  { label: 'github-token',    pattern: /github_pat_[A-Za-z0-9_]{82,}/ },
  { label: 'anthropic-key',   pattern: /sk-ant-api[0-9]{2}-[A-Za-z0-9_\-]+/ },
  { label: 'anthropic-key',   pattern: /sk-ant-oat[0-9]{2}-[A-Za-z0-9_\-]+/ },
  { label: 'anthropic-key',   pattern: /sk-ant-sid[0-9]{2}-[A-Za-z0-9_\-]+/ },
  { label: 'anthropic-key',   pattern: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { label: 'openai-key',      pattern: /sk-proj-[A-Za-z0-9_\-]{20,}/ },
  { label: 'openai-key',      pattern: /sk-svcacct-[A-Za-z0-9_\-]{20,}/ },
  { label: 'openai-key',      pattern: /sk-[A-Za-z0-9]{48,}/ },
  { label: 'aws-access-key',  pattern: /AKIA[A-Z0-9]{16}/ },
  { label: 'slack-token',     pattern: /xox[bpasr]-[A-Za-z0-9\-]{10,}/ },
  { label: 'gemini-api-key',  pattern: /AIzaSy[A-Za-z0-9_\-]{33,39}/ },
  { label: 'private-key',     pattern: /BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/ },
];
const CANARY_PATTERNS = [
  // curl/wget/nc/eval rarely appear as bare English words, so any same-line
  // argument (not a code-fence "```curl\n" style newline) is enough signal.
  // Word boundaries keep this from matching substrings like "async " or
  // "evaluation " (nc/eval embedded in common English/code words).
  { label: 'shell-invocation', pattern: /\b(?:curl|wget|nc|eval)\b[ \t]+[^\s]/i },
  // bash/sh are common English/code words ("bash scripting", "the sh
  // compatibility issue"), so require an actual invocation shape: a flag
  // (-c, -x, ...) or a quoted/path argument, not just any following word.
  { label: 'shell-invocation', pattern: /\b(?:bash|sh)\s+(?:-\w|["'\/])/i },
  { label: 'exec-invocation',  pattern: /\bexec\s+["'\/\-]/i },
  { label: 'github-output-override', pattern: />>?\s*\$GITHUB_OUTPUT/ },
  { label: 'github-env-override',    pattern: />>?\s*\$GITHUB_ENV/ },
];
function findMatch(entries, v) {
  if (typeof v === 'string') {
    for (const { label, pattern } of entries) {
      if (pattern.test(v)) return label;
    }
    return null;
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const m = findMatch(entries, item);
      if (m) return m;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const item of Object.values(v)) {
      const m = findMatch(entries, item);
      if (m) return m;
    }
    return null;
  }
  return null;
}
function findToken(v) { return findMatch(TOKEN_PATTERNS, v); }
function findCanary(v) { return findMatch(CANARY_PATTERNS, v); }
function hasToken(v) { return findToken(v) !== null; }
function hasCanary(v) { return findCanary(v) !== null; }
function makeFallback(msg, runUrl) {
  return {
    body:     `> [!WARNING]\n> **AI review could not be posted:** ${msg}\n>\n> See [workflow run](${runUrl}) for details.`,
    event:    'COMMENT',
    comments: [],
  };
}
const VALID_EVENTS = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];
function validateReview(review) {
  const errors = [];
  if (!review || typeof review !== 'object') {
    errors.push('review must be a non-null object');
    return { errors };
  }
  if (typeof review.body !== 'string')
    errors.push('body must be a string');
  if (!VALID_EVENTS.includes(review.event))
    errors.push(`event must be one of ${VALID_EVENTS.join('|')}`);
  if (!Array.isArray(review.comments)) {
    errors.push('comments must be an array');
  } else {
    for (let i = 0; i < review.comments.length; i++) {
      const c = review.comments[i];
      if (!c || typeof c !== 'object') {
        errors.push(`comments[${i}] must be an object`);
      } else {
        if (typeof c.path !== 'string')
          errors.push(`comments[${i}].path must be a string`);
        if (typeof c.body !== 'string')
          errors.push(`comments[${i}].body must be a string`);
        if (!Number.isInteger(c.line) || c.line < 1)
          errors.push(`comments[${i}].line must be a positive integer`);
      }
    }
  }
  return { errors };
}
// Scan backward from the last } to find its depth-matching { so that stray
// brace pairs in prose before the JSON block (e.g. `Foo{}`) are skipped.
function extractJson(text) {
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace === -1) return null;
  let depth = 0;
  for (let i = lastBrace; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{' && --depth === 0) return text.slice(i, lastBrace + 1);
  }
  return null;
}
module.exports = { hasToken, hasCanary, findToken, findCanary, makeFallback, validateReview, extractJson };
