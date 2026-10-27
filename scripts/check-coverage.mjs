#!/usr/bin/env node
/**
 * check-coverage.mjs — enforce per-file coverage floors on the frontend and the Rust workspace.
 *
 * Why it exists: a global percentage hides the ratio this project actually cares about — a new
 * module must be tested from its first commit, while a pre-existing module must not get worse.
 * Neither vitest thresholds nor `cargo llvm-cov` can express that per file, so the comparison
 * lives here against `scripts/coverage-baseline.json`.
 *
 * How a file is judged:
 *   - it matches one of `newModuleGlobs` → every metric must reach `newModuleFloor` (90);
 *   - otherwise its floor is the recorded baseline for that file, or `legacyFloor` when the file
 *     is not in the baseline (a file that exists today and was never recorded is treated as
 *     legacy, so adding it is not blocked by an absent record);
 *   - a file with no measurable lines is skipped: an empty module has nothing to defend.
 *
 * Usage:
 *   pnpm check:coverage --frontend            # read the vitest JSON summary
 *   pnpm check:coverage --rust=<workspace>    # read a cargo-llvm-cov JSON export
 *   pnpm check:coverage --update-baseline     # rewrite baseline entries from this run
 *
 * The script never runs the test suites itself: the caller picks the suite (a coverage job runs
 * them with instrumentation), and this compares the report that came out. That keeps the gate
 * usable from CI where the report is downloaded as an artifact.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(repoRoot, 'scripts', 'coverage-baseline.json');

/** Metrics compared for every file, in report order. */
const METRICS = ['lines', 'branches', 'functions', 'statements'];

/** The subset of those metrics an LLVM export can carry; the rest are not recorded. */
const RUST_METRICS = ['lines', 'functions'];

/** A module introduced by this change is expected to be tested from its first commit. */
export const NEW_MODULE_FLOOR = 90;

/** Files that existed before the floor was introduced keep their recorded value. */
export const LEGACY_FLOOR = 0;

/**
 * Globs for modules this template work introduces. They are listed rather than inferred from
 * `git diff` so the rule is reviewable in one place and does not depend on a diff base.
 *
 * A glob is only consulted for a file that has no baseline record. An existing file keeps its
 * recorded value even when it sits inside a new module's directory: `lib/panels/` already held
 * the panel metadata mirror before those directories were introduced, and holding a file to the
 * new floor because of the directory it was moved into would fail a legitimate change.
 */
const NEW_MODULE_GLOBS = [
  /^client\/src\/lib\/templates\//,
  /^client\/src\/lib\/forms\//,
  /^client\/src\/lib\/panels\/(?!panelDefs\.ts$|panelTypes\.ts$)/,
  /^client\/src\/components\/templates\//,
  /^client\/src\/components\/forms\//,
  /^client\/src\/components\/panels\/PanelHost\.tsx$/,
];

/**
 * Importing this module is how the comparison is tested, so the command-line body only runs when
 * the file is executed. `process.argv[1]` is the script path in that case.
 */
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const argv = isEntryPoint ? process.argv.slice(2) : [];
const updateBaseline = argv.includes('--update-baseline');
const frontend = argv.includes('--frontend');
const rustArg = argv.find((arg) => arg.startsWith('--rust='));

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
};

function readJson(path, what) {
  if (!existsSync(path)) {
    fail(`${what} not found at ${relative(repoRoot, path)}; run the instrumented suite first`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${what} is not valid JSON: ${error.message}`);
    return null;
  }
}

/** The baseline file maps a repository-relative path to its four percentages. */
function readBaseline() {
  if (!existsSync(baselinePath)) return { total: {}, files: {} };
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  return { total: parsed.total ?? {}, files: parsed.files ?? {} };
}

/** A vitest `coverage-summary.json` entry as `{ lines, branches, functions, statements }`. */
function frontendReport() {
  const summary = readJson(join(repoRoot, 'client', 'coverage', 'coverage-summary.json'), 'frontend coverage summary');
  if (summary === null) return null;
  const files = {};
  for (const [path, entry] of Object.entries(summary)) {
    if (path === 'total') continue;
    const first = entry[METRICS[0]];
    if (first === undefined || first.total === 0) continue;
    const key = `client/${relative(join(repoRoot, 'client'), path).split(/[\\/]/).join('/')}`;
    files[key] = Object.fromEntries(METRICS.map((metric) => [metric, entry[metric]?.pct ?? 0]));
  }
  return { files, total: Object.fromEntries(METRICS.map((metric) => [metric, summary.total[metric]?.pct ?? 0])) };
}

/**
 * A `cargo llvm-cov --json` export as `{ files }`.
 *
 * The export lists absolute paths, so each is mapped back to its repository-relative form. The
 * `data[0].totals` block carries the workspace percentage for the metrics LLVM actually
 * instruments: lines and functions always, branches only under branch instrumentation, and
 * regions instead of statements. A metric the export does not measure is omitted rather than
 * recorded as zero — a zero would read as "0% covered" and silently pass forever.
 */
function rustReport(workspace) {
  const path = join(repoRoot, 'coverage', `rust-${workspace.replace(/[\\/]/g, '-')}.json`);
  const parsed = readJson(path, `Rust coverage export for ${workspace}`);
  if (parsed === null) return null;
  const files = {};
  for (const entry of parsed.data?.[0]?.files ?? []) {
    const filename = entry.filename;
    if (filename === undefined || filename.includes('/target/')) continue;
    const key = relative(repoRoot, filename).split(/[\\/]/).join('/');
    const summary = entry.summary ?? {};
    const entryMetrics = (metric) => {
      const value = summary[metric];
      if (value === undefined || value.count === 0) return undefined;
      return (value.covered / value.count) * 100;
    };
    const measured = {};
    for (const metric of RUST_METRICS) {
      const value = entryMetrics(metric);
      if (value !== undefined) measured[metric] = value;
    }
    files[key] = measured;
  }
  const totals = parsed.data?.[0]?.totals ?? {};
  const total = {};
  for (const metric of RUST_METRICS) {
    const value = totals[metric];
    if (value !== undefined && value.count > 0) total[metric] = (value.covered / value.count) * 100;
  }
  return { files, total };
}

/**
 * The floor a file must clear, per metric.
 *
 * A recorded file is measured against its own record, never against the new-module floor: the
 * record is the promise that it does not regress, and raising it on an unrelated move would
 * block work that is not about that file.
 */
export function coverageFloors(path, record) {
  if (record !== undefined) {
    return Object.fromEntries(METRICS.map((metric) => [metric, record[metric] ?? LEGACY_FLOOR]));
  }
  const floor = NEW_MODULE_GLOBS.some((pattern) => pattern.test(path)) ? NEW_MODULE_FLOOR : LEGACY_FLOOR;
  return Object.fromEntries(METRICS.map((metric) => [metric, floor]));
}

/**
 * Compare one report against the baseline, returning every place a file is short.
 *
 * Pure: it takes the measured percentages and the recorded ones, so the rule can be tested
 * without a coverage run. A file with no measurable lines is skipped — there is nothing to defend.
 */
export function judgeCoverage(files, baselineFiles) {
  const findings = [];
  for (const [path, metrics] of Object.entries(files)) {
    if ((metrics.lines?.total ?? metrics.lines ?? 0) === 0) continue;
    const floors = coverageFloors(path, baselineFiles[path]);
    for (const metric of METRICS) {
      const actual = metrics[metric];
      // A report that does not measure a metric (LLVM has no statement count) cannot say the
      // file regressed on it; recording the absence as zero would pass silently instead.
      if (actual === undefined) continue;
      const floor = floors[metric];
      if (actual + 0.005 < floor) findings.push({ path, metric, actual, floor });
    }
  }
  return findings;
}

const baseline = isEntryPoint ? readBaseline() : { total: {}, files: {} };
const reports = [];
if (frontend) reports.push({ name: 'frontend', report: frontendReport() });
if (rustArg !== undefined) {
  const workspace = rustArg.slice('--rust='.length);
  reports.push({ name: `rust:${workspace}`, report: rustReport(workspace) });
}
if (isEntryPoint && reports.length === 0) {
  fail('nothing to check; pass --frontend and/or --rust=<workspace>');
}

let findings = 0;
const updated = { total: { ...baseline.total }, files: { ...baseline.files } };
if (isEntryPoint) {

for (const { name, report } of reports) {
  if (report === null) continue;
  for (const short of judgeCoverage(report.files, baseline.files)) {
    findings += 1;
    console.error(
      `${short.path}: ${short.metric} is ${short.actual.toFixed(2)}%, below its ${short.floor.toFixed(2)}% floor (${name})`,
    );
  }
  for (const [path, metrics] of Object.entries(report.files)) {
    updated.files[path] = Object.fromEntries(
      METRICS.filter((metric) => metrics[metric] !== undefined).map((metric) => [
        metric,
        Number(metrics[metric].toFixed(2)),
      ]),
    );
  }
  for (const metric of METRICS) {
    if (report.total[metric] === undefined) continue;
    updated.total[`${name}:${metric}`] = Number(report.total[metric].toFixed(2));
  }
  console.log(`${name}: ${Object.keys(report.files).length} file(s) measured`);
}

if (updateBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`baseline written to ${relative(repoRoot, baselinePath)}`);
  process.exit(0);
}

if (findings > 0) {
  fail(`coverage below the floors in ${findings} place(s)`);
} else {
  console.log('check:coverage passed');
}
}
