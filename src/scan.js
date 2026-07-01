'use strict';
const TOKEN_PATTERNS = [
  /ghp_[A-Za-z0-9_]{36,}/,
  /gho_[A-Za-z0-9_]{36,}/,
  /ghs_[A-Za-z0-9_]{36,}/,
  /ghr_[A-Za-z0-9_]{36,}/,
  /ghu_[A-Za-z0-9_]{36,}/,
  /github_pat_[A-Za-z0-9_]{82,}/,
  /sk-ant-api[0-9]{2}-[A-Za-z0-9_\-]+/,
  /sk-ant-oat[0-9]{2}-[A-Za-z0-9_\-]+/,
  /sk-ant-sid[0-9]{2}-[A-Za-z0-9_\-]+/,
  /sk-ant-[A-Za-z0-9_\-]{20,}/,
  /sk-proj-[A-Za-z0-9_\-]{20,}/,
  /sk-svcacct-[A-Za-z0-9_\-]{20,}/,
  /sk-[A-Za-z0-9]{48,}/,
  /AKIA[A-Z0-9]{16}/,
  /xox[bpasr]-[A-Za-z0-9\-]{10,}/,
  /AIzaSy[A-Za-z0-9_\-]{33,39}/,
  /BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/,
];
const CANARY_PATTERNS = [
  /(?:curl|wget|nc|bash|sh\s+-c|eval)\s+/i,
  /\bexec\s+["'\/\-]/i,
  />>?\s*\$GITHUB_OUTPUT/,
  />>?\s*\$GITHUB_ENV/,
];
function hasToken(v) {
  if (typeof v === 'string') return TOKEN_PATTERNS.some(p => p.test(v));
  if (Array.isArray(v))      return v.some(hasToken);
  if (v && typeof v === 'object') return Object.values(v).some(hasToken);
  return false;
}
function hasCanary(v) {
  if (typeof v === 'string') return CANARY_PATTERNS.some(p => p.test(v));
  if (Array.isArray(v))      return v.some(hasCanary);
  if (v && typeof v === 'object') return Object.values(v).some(hasCanary);
  return false;
}
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
module.exports = { hasToken, hasCanary, makeFallback, validateReview };
