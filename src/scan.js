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

const VALID_EVENTS = new Set(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']);
const REVIEW_FIELDS = new Set(['body', 'event', 'comments']);
const COMMENT_FIELDS = new Set(['path', 'body', 'line', 'side']);
const FALLBACK_MARKER = '<!-- ai-review-status:suppressed -->';

function matchesTree(value, patterns) {
  if (typeof value === 'string') return patterns.some(pattern => pattern.test(value));
  if (Array.isArray(value)) return value.some(item => matchesTree(item, patterns));
  if (value && typeof value === 'object') {
    return Object.values(value).some(item => matchesTree(item, patterns));
  }
  return false;
}

function hasToken(value) {
  return matchesTree(value, TOKEN_PATTERNS);
}

function hasCanary(value) {
  return matchesTree(value, CANARY_PATTERNS);
}

function makeFallback(msg, runUrl) {
  return {
    body:     `${FALLBACK_MARKER}\n> [!WARNING]\n> **AI review could not be posted:** ${msg}\n>\n> See [workflow run](${runUrl}) for details.`,
    event:    'COMMENT',
    comments: [],
  };
}

function isFallback(review) {
  return typeof review?.body === 'string' && review.body.startsWith(`${FALLBACK_MARKER}\n`);
}

function rejectUnknownFields(value, allowedFields, location, errors) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) errors.push(`${location}.${field} is not allowed`);
  }
}

function validateReview(review) {
  const errors = [];
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    return { errors: ['review must be a non-null object'] };
  }

  rejectUnknownFields(review, REVIEW_FIELDS, 'review', errors);
  if (typeof review.body !== 'string')
    errors.push('body must be a string');
  if (!VALID_EVENTS.has(review.event))
    errors.push('event must be one of COMMENT|REQUEST_CHANGES|APPROVE');

  if (!Array.isArray(review.comments)) {
    errors.push('comments must be an array');
    return { errors };
  }
  if (review.comments.length > 100)
    errors.push('comments must contain at most 100 entries');

  for (let i = 0; i < review.comments.length; i++) {
    const comment = review.comments[i];
    const location = `comments[${i}]`;
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
      errors.push(`${location} must be an object`);
      continue;
    }

    rejectUnknownFields(comment, COMMENT_FIELDS, location, errors);
    if (typeof comment.path !== 'string' || comment.path.length === 0)
      errors.push(`${location}.path must be a non-empty string`);
    if (typeof comment.body !== 'string')
      errors.push(`${location}.body must be a string`);
    if (!Number.isInteger(comment.line) || comment.line < 1)
      errors.push(`${location}.line must be a positive integer`);
    if (comment.side !== 'LEFT' && comment.side !== 'RIGHT')
      errors.push(`${location}.side must be LEFT or RIGHT`);
  }

  return { errors };
}

module.exports = { hasToken, hasCanary, makeFallback, isFallback, validateReview };
