#!/usr/bin/env node
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildGuidelines, mutualExclusivityError } = require('../src/guidelines.js');

const USAGE = `Usage: find-guidelines [options]

Discovers review guideline files (by explicit list or glob pattern), scopes
them to a set of changed files using the same directory-prefix rule as the
code-review-action GitHub workflow, and aggregates their content. Intended
to be called independently (e.g. from a local dev command in another repo)
so that repo and the workflow share one implementation.

Options:
  --repo-root <dir>       Repository root to search and read files from (default: cwd).
  --pattern <glob>        Glob pattern used to auto-discover guideline files, evaluated
                          the same way as the workflow's prompt_file_pattern input
                          (e.g. '**/codereview_guideline.md'). Mutually exclusive with
                          --prompt-file.
  --prompt-file <path>    Explicit guideline file path, relative to --repo-root.
                          Repeatable. Mutually exclusive with --pattern.
  --base <ref>            Git ref to diff against, using
                          'git diff --name-only <base>...<head>'.
  --head <ref>            Git ref for the diff's head (default: HEAD).
  --changed-files <path>  File of newline-separated changed file paths ('-' for stdin).
                          Overrides --base/--head when set.
  --builtin <text>        Fallback guidelines text used when nothing matches.
  --builtin-file <path>   File containing the fallback guidelines text.
  -h, --help              Show this help.

Prints one JSON object to stdout:
  { error, included, guidelines: [{ path, content }], guidelinesBody, info }
Exit code is 1 when "error" is set, 2 on a usage/argument error, 0 otherwise.
`;

function parseArgs(argv) {
  const opts = { promptFiles: [], repoRoot: process.cwd(), head: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i++;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '--repo-root':     opts.repoRoot = next(); break;
      case '--pattern':       opts.pattern = next(); break;
      case '--prompt-file':   opts.promptFiles.push(next()); break;
      case '--base':          opts.base = next(); break;
      case '--head':          opts.head = next(); break;
      case '--changed-files': opts.changedFilesSource = next(); break;
      case '--builtin':       opts.builtin = next(); break;
      case '--builtin-file':  opts.builtinFile = next(); break;
      case '-h':
      case '--help':          opts.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function readChangedFiles(opts) {
  if (opts.changedFilesSource) {
    const raw = opts.changedFilesSource === '-'
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(opts.changedFilesSource, 'utf8');
    return raw.split('\n').map(s => s.trim()).filter(Boolean);
  }
  if (opts.base) {
    const out = execFileSync(
      'git',
      ['-C', opts.repoRoot, 'diff', '--name-only', `${opts.base}...${opts.head}`],
      { encoding: 'utf8' },
    );
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function readBuiltin(opts) {
  if (opts.builtinFile) return fs.readFileSync(opts.builtinFile, 'utf8');
  return opts.builtin || '';
}

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.error) process.stderr.write(`Error: ${result.error}\n`);
  process.exitCode = result.error ? 1 : 0;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(USAGE + `\nError: ${e.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) { process.stdout.write(USAGE); return; }

  const promptFiles       = opts.promptFiles.join('\n');
  const promptFilePattern = opts.pattern || '';

  const mutexError = mutualExclusivityError(promptFiles, promptFilePattern);
  if (mutexError) {
    emit({ error: mutexError, included: 0, guidelines: [], guidelinesBody: '', info: [] });
    return;
  }

  let changedFiles;
  try {
    changedFiles = readChangedFiles(opts);
  } catch (e) {
    process.stderr.write(`Error: could not resolve changed files: ${e.message}\n`);
    process.exitCode = 2;
    return;
  }

  const result = buildGuidelines({
    promptFiles,
    promptFilePattern,
    changedFiles,
    trustedDir: path.resolve(opts.repoRoot),
    builtinGuidelines: readBuiltin(opts),
  });

  emit(result);
}

main();
