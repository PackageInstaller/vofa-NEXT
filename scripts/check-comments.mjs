#!/usr/bin/env node
/**
 * check-comments.mjs — reject development narrative in code comments.
 *
 * Why it exists: a comment that names a task, a phase, a date, or a migration asks the reader
 * to know the history of a change rather than the state of the code. Those markers go stale the
 * moment the work item closes, and the next reader cannot tell a live TODO from a resolved one.
 * This gate makes the rule mechanical, so it fails in the same run as the tests instead of in
 * review.
 *
 * Scope:
 *   - only comments are scanned (`//`, `///`, `//!`, and `/* … *\/` bodies), so a string that
 *     happens to contain "Phase 2" is not a finding;
 *   - `--all` scans every tracked source file of the umbrella and of each submodule, which is
 *     the audit mode used to record the existing tree;
 *   - the default mode scans the files a change touched, so unrelated code is never blamed;
 *   - generated contracts and third-party directories are skipped: they are not authored here.
 *
 * Usage:
 *   pnpm check:comments                 # files changed in each repository, against its base
 *   pnpm check:comments --all           # every tracked source file
 *   pnpm check:comments --base=<rev>    # explicit base, applied to every repository
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const scanAll = argv.includes('--all');
const baseArg = argv.find((arg) => arg.startsWith('--base='));
const base = baseArg === undefined ? 'origin/develop' : baseArg.slice('--base='.length);

/** The umbrella and the checkouts it composes, so one gate covers every repository. */
const REPOS = ['.', 'client', 'server', 'server/core', 'server/data', 'server/physical'];

/** Paths that are generated or vendored, so their comments are not written here. */
const SKIP = [/types\/generated\//, /node_modules\//, /\/target\//, /\/dist\//, /src-tauri\/gen\//];

/** A marker that only makes sense to someone who knows the change history. */
export const FORBIDDEN = [
  { pattern: /\b[Mm]\d+\.\d+\b/, what: 'a task or milestone id' },
  { pattern: /\b(?:Phase|Stage|Milestone)\s+\d+\b/i, what: 'a phase or stage name' },
  { pattern: /\bTask\s+#?\d+\b/i, what: 'a task reference' },
  { pattern: /\b(?:TODO|FIXME|XXX|HACK)\b/, what: 'an untracked TODO marker' },
  {
    pattern: /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/,
    what: 'a date',
  },
  {
    pattern: /\b(?:old implementation|legacy implementation|used to (?:live|be) here)\b/i,
    what: 'migration history',
  },
];

/** Files whose own text is the rule, so quoting a marker there is not a violation. */
const SELF_EXEMPT = new Set(['scripts/check-comments.mjs']);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function changedFiles(cwd, prefix) {
  try {
    // Two-dot `base` (not `base...HEAD`) also reports uncommitted work: a local run and a PR run
    // must see the same files, otherwise the gate passes locally and fails in CI.
    return git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', base])
      .split('\n')
      .filter(Boolean)
      .map((path) => `${prefix}${path}`);
  } catch {
    // A shallow clone or a missing base must not turn this gate green by accident.
    console.error(`✗ cannot read the diff against ${base} in ${prefix || '.'}; pass --base=<rev> or --all`);
    process.exit(1);
  }
}

function trackedFiles(cwd, prefix) {
  return git(cwd, ['ls-files'])
    .split('\n')
    .filter(Boolean)
    .map((path) => `${prefix}${path}`);
}

function isScannable(path) {
  if (!/\.(?:rs|ts|tsx)$/.test(path)) return false;
  return !SKIP.some((pattern) => pattern.test(path)) && existsSync(join(repoRoot, path));
}

/**
 * Extract comment text with its starting line, so a finding points at the marker rather than
 * the file. Block comments are handled as a unit, which is what a reader sees.
 *
 * `doc` marks a doc comment (Rust `///`, `//!`, block doc; JS block doc). Its body is
 * documentation that may legitimately contain code, so the dead-code rule does not apply there.
 */
/**
 * Find the index where a comment marker starts on this line, ignoring markers inside a string
 * or character literal.
 *
 * A naive `indexOf('//')` reads the `//` in `'https://example.com'` as a comment, which would
 * then be scanned and reported. The scanner therefore walks the line once, tracking whether it is
 * inside a quote, and only a marker found outside one starts a comment.
 */
function commentStart(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === '/' && line[index + 1] === '/') return { index, block: false };
      if (char === '/' && line[index + 1] === '*') return { index, block: true };
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) quote = null;
  }
  return null;
}

/**
 * Extract comment text with its starting line, so a finding points at the marker rather than
 * the file. Block comments are handled as a unit, which is what a reader sees.
 *
 * `doc` marks a doc comment (Rust `///`, `//!`, block doc; JS block doc). Its body is
 * documentation that may legitimately contain code, so the dead-code rule does not apply there.
 */
export function commentsOf(source) {
  const found = [];
  const lines = source.split('\n');
  let inBlock = false;
  let blockStart = 0;
  let blockLines = [];
  let blockDoc = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inBlock) {
      const end = line.indexOf('*/');
      blockLines.push(end === -1 ? line : line.slice(0, end));
      if (end !== -1) {
        found.push({ line: blockStart, doc: blockDoc, text: blockLines.join('\n') });
        inBlock = false;
        blockLines = [];
      }
      continue;
    }
    const start = commentStart(line);
    if (start === null) continue;
    if (start.block) {
      const open = start.index;
      const end = line.indexOf('*/', open + 2);
      const doc = line.slice(open + 2, open + 3) === '*';
      if (end === -1) {
        inBlock = true;
        blockStart = index + 1;
        blockDoc = doc;
        blockLines = [line.slice(open + 2)];
      } else {
        found.push({ line: index + 1, doc, text: line.slice(open + 2, end) });
      }
      continue;
    }
    const rest = line.slice(start.index + 2);
    const doc = rest.startsWith('/') || rest.startsWith('!');
    found.push({ line: index + 1, doc, text: doc ? rest.replace(/^[/!]/, '') : rest });
  }
  if (inBlock) found.push({ line: blockStart, doc: blockDoc, text: blockLines.join('\n') });
  return found;
}

/**
 * Commented-out code: a statement-shaped line, as opposed to a sentence or a documented example.
 *
 * Rustdoc examples inside a `///` or `//!` block are deliberately written as code, and their
 * leading `!` (a `hidden` line) or backtick-quoted prose is part of the documentation. The rule
 * therefore only fires on a plain `//` comment whose text is a statement and that is not inside
 * a doc block: that is the shape dead code takes when somebody comments it out instead of
 * deleting it.
 */
export function looksLikeCode(comment) {
  const trimmed = comment.text.trim();
  if (trimmed === '') return false;
  if (comment.doc || comment.example) return false;
  // A trailing semicolon or brace is the strongest signal that this was code. Prose rarely ends
  // in one, and the false positive is easy to fix by rewording; missing real dead code is not.
  if (!/[;{}]\s*$/.test(trimmed)) return false;
  if (trimmed.startsWith('`')) return false;
  return (
    /\b(?:const|let|var|fn|pub|return|if|for|while|match|self\.|this\.)\b/.test(trimmed) ||
    /^\w+\s*\(/.test(trimmed)
  );
}

/**
 * Scan one list of repository-relative paths, returning every finding.
 *
 * Pure enough to test: it reads files but takes the path list, so a test can point it at a
 * temporary fixture instead of the tree.
 */
export function scanComments(paths, root = repoRoot) {
  const findings = [];
  for (const path of paths) {
    const source = readFileSync(join(root, path), 'utf8');
    for (const comment of commentsOf(source)) {
      for (const rule of FORBIDDEN) {
        if (!rule.pattern.test(comment.text)) continue;
        findings.push({ path, line: comment.line, what: rule.what, text: comment.text.trim() });
        break;
      }
      if (looksLikeCode(comment)) {
        findings.push({ path, line: comment.line, what: 'commented-out code', text: comment.text.trim() });
      }
    }
  }
  return findings;
}

const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const findings = [];
let scanned = 0;

for (const repo of isEntryPoint ? REPOS : []) {
  const cwd = join(repoRoot, repo);
  if (!existsSync(join(cwd, '.git')) && repo !== '.') continue;
  const prefix = repo === '.' ? '' : `${repo}/`;
  const files = (scanAll ? trackedFiles(cwd, prefix) : changedFiles(cwd, prefix)).filter(isScannable);
  for (const path of files) {
    if (SELF_EXEMPT.has(path.replace(/^.*?(scripts\/check-comments\.mjs)$/, '$1'))) continue;
    scanned += 1;
    const source = readFileSync(join(repoRoot, path), 'utf8');
    for (const comment of commentsOf(source)) {
      for (const rule of FORBIDDEN) {
        if (!rule.pattern.test(comment.text)) continue;
        findings.push({ path, line: comment.line, what: rule.what, text: comment.text.trim() });
        break;
      }
      if (looksLikeCode(comment)) {
        findings.push({ path, line: comment.line, what: 'commented-out code', text: comment.text.trim() });
      }
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: comment carries ${finding.what}`);
    console.error(`  ${finding.text.split('\n')[0].slice(0, 100)}`);
  }
  console.error(`\ncheck:comments failed with ${findings.length} finding(s) in ${scanned} file(s)`);
  process.exit(1);
}

const scope = scanAll ? 'every tracked file' : `files changed against ${base}`;
console.log(`check:comments passed — ${scanned} file(s) scanned (${scope}, ${relative(repoRoot, repoRoot) || '.'})`);
