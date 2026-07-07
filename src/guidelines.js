'use strict';
const fs   = require('node:fs');
const path = require('node:path');

function parseList(str) {
  return (str || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      re += '(?:.*/)?';
      i += 3;
    } else if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
    } else if (c === '*') {
      re += '[^/]*';
      i += 1;
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function discoverPatternFiles(trustedDir, pattern) {
  if (!fs.existsSync(trustedDir)) return [];
  const walk = (dir) => {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(walk(full));
      else out.push(full);
    }
    return out;
  };
  const regex = globToRegExp(pattern);
  return walk(trustedDir)
    .map(f => path.relative(trustedDir, f).split(path.sep).join('/'))
    .filter(rel => regex.test(rel));
}

function isInScope(pf, changedFiles) {
  const dir = path.dirname(pf);
  return dir === '.' || changedFiles.some(f => f.startsWith(dir + '/') || f === dir);
}

function mutualExclusivityError(promptFiles, promptFilePattern) {
  if ((promptFiles || '').trim() && (promptFilePattern || '').trim()) {
    return 'prompt_file and prompt_file_pattern are mutually exclusive - set only one.';
  }
  return null;
}

function buildGuidelines({ promptFiles, promptFilePattern, changedFiles, trustedDir, builtinGuidelines = '' }) {
  const usingPromptFiles = Boolean((promptFiles || '').trim());
  const usingPattern     = Boolean((promptFilePattern || '').trim());
  const info = [];

  let candidates = [];
  if (usingPromptFiles) {
    candidates = parseList(promptFiles);
  } else if (usingPattern) {
    candidates = discoverPatternFiles(trustedDir, promptFilePattern);
    info.push(`prompt_file_pattern matched ${candidates.length} file(s): ${candidates.join(', ') || '(none)'}`);
  }

  let guidelinesBody = '';
  let guidelines = [];
  let included = 0;

  if (usingPromptFiles || usingPattern) {
    for (const pf of candidates) {
      if (!pf) continue;

      const trustedPath        = path.join(trustedDir, pf);
      const absoluteTrustedDir = path.resolve(trustedDir);
      const absolutePath       = path.resolve(trustedPath);
      if (!absolutePath.startsWith(absoluteTrustedDir + path.sep)) {
        return { error: `Path traversal detected in prompt file entry: '${pf}'`, info, guidelinesBody: '', guidelines: [], included: 0 };
      }
      if (!fs.existsSync(trustedPath)) {
        if (usingPromptFiles) {
          return {
            error: `prompt_file entry '${pf}' was not found on the default branch. Correct the path or remove the entry.`,
            info, guidelinesBody: '', guidelines: [], included: 0,
          };
        }
        continue; // pattern-discovered entries always exist; defensive skip only
      }

      const inScope = isInScope(pf, changedFiles);
      if (!inScope) { info.push(`Out of scope for this PR: ${pf}`); continue; }

      const content = fs.readFileSync(trustedPath, 'utf8').trimEnd();
      info.push(`Including: ${pf}`);
      if (included > 0) guidelinesBody += '\n\n---\n';
      guidelinesBody += content;
      guidelines.push({ path: pf, content });
      included++;
    }
  }

  if (included === 0) {
    guidelinesBody = builtinGuidelines;
    if (usingPattern) {
      info.push('No files matched prompt_file_pattern for this PR - using built-in default');
    } else if (usingPromptFiles) {
      info.push('No prompt files matched this PR - using built-in default');
    } else {
      info.push('prompt_file not set - using built-in default');
    }
  } else {
    info.push(`Guidelines: ${included} file(s) included`);
  }

  return { error: null, info, guidelinesBody, guidelines, included };
}

module.exports = { parseList, globToRegExp, discoverPatternFiles, isInScope, mutualExclusivityError, buildGuidelines };
