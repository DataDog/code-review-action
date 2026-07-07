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
    .filter(rel => regex.test(rel))
    .sort();
}

function isInScope(pf, changedFiles) {
  const dir = path.dirname(pf);
  return dir === '.' || changedFiles.some(f => f.startsWith(dir + '/') || f === dir);
}

// Discovers guideline files applicable to changedFiles without walking the
// whole tree: for each changed file, walks its own directory up to the repo
// root, listing (and caching) only the directories actually visited. A
// directory's listing is done at most once regardless of how many changed
// files share it as an ancestor. This is O(changedFiles * depth) instead of
// discoverPatternFiles' O(totalRepoFiles), which matters for a large
// checkout with no prior sparse-checkout filtering (e.g. a local CLI run
// against a full monorepo clone).
function discoverGuidelinesForChangedFiles(trustedDir, pattern, changedFiles) {
  const regex = globToRegExp(pattern);
  const dirCache = new Map();

  const guidelinesIn = (dir) => {
    if (dirCache.has(dir)) return dirCache.get(dir);
    const absDir = path.join(trustedDir, dir);
    const matches = [];
    if (fs.existsSync(absDir)) {
      for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
        if (regex.test(rel)) matches.push(rel);
      }
    }
    dirCache.set(dir, matches);
    return matches;
  };

  const found = new Set(guidelinesIn('.'));

  for (const file of changedFiles) {
    let dir = path.dirname(file);
    while (true) {
      for (const m of guidelinesIn(dir)) found.add(m);
      if (dir === '.') break;
      dir = path.dirname(dir);
    }
  }

  return Array.from(found).sort();
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

  let guidelinesBody = '';
  let guidelines = [];
  let included = 0;

  const include = (pf, content) => {
    info.push(`Including: ${pf}`);
    if (included > 0) guidelinesBody += '\n\n---\n';
    guidelinesBody += content;
    guidelines.push({ path: pf, content });
    included++;
  };

  if (usingPromptFiles) {
    for (const pf of parseList(promptFiles)) {
      const trustedPath        = path.join(trustedDir, pf);
      const absoluteTrustedDir = path.resolve(trustedDir);
      const absolutePath       = path.resolve(trustedPath);
      if (!absolutePath.startsWith(absoluteTrustedDir + path.sep)) {
        return { error: `Path traversal detected in prompt file entry: '${pf}'`, info, guidelinesBody: '', guidelines: [], included: 0 };
      }
      if (!fs.existsSync(trustedPath)) {
        return {
          error: `prompt_file entry '${pf}' was not found on the default branch. Correct the path or remove the entry.`,
          info, guidelinesBody: '', guidelines: [], included: 0,
        };
      }

      if (!isInScope(pf, changedFiles)) { info.push(`Out of scope for this PR: ${pf}`); continue; }
      include(pf, fs.readFileSync(trustedPath, 'utf8').trimEnd());
    }
  } else if (usingPattern) {
    // Scoping is baked into discovery here (only ancestors of changedFiles
    // are ever visited), so every match is already in scope - no separate
    // filter step, and no existence check (found via directory listing).
    const matches = discoverGuidelinesForChangedFiles(trustedDir, promptFilePattern, changedFiles);
    info.push(`prompt_file_pattern matched ${matches.length} in-scope file(s): ${matches.join(', ') || '(none)'}`);
    for (const pf of matches) {
      include(pf, fs.readFileSync(path.join(trustedDir, pf), 'utf8').trimEnd());
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

module.exports = {
  parseList, globToRegExp, discoverPatternFiles, discoverGuidelinesForChangedFiles,
  isInScope, mutualExclusivityError, buildGuidelines,
};
