#!/usr/bin/env node
/**
 * check-rust-coverage.mjs — run `cargo llvm-cov` for one Rust workspace and export its report.
 *
 * Why a wrapper: `cargo llvm-cov --json` writes one file for the whole workspace, and
 * `check-coverage.mjs` judges that file against the per-file baseline. Keeping the two steps
 * apart means the comparison can also run in CI from a downloaded artifact, without paying for
 * the instrumented build a second time.
 *
 * The tool is a CI/developer prerequisite, not a Cargo dependency: `cargo llvm-cov` is installed
 * by the coverage job, and this script only invokes it.
 *
 * Usage:
 *   node scripts/check-rust-coverage.mjs <workspace-dir>   # e.g. server, server/data
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.argv[2];
if (workspace === undefined) {
  console.error('usage: node scripts/check-rust-coverage.mjs <workspace-dir>');
  process.exit(2);
}

const cwd = join(repoRoot, workspace);
if (!existsSync(join(cwd, 'Cargo.toml'))) {
  console.error(`✗ ${workspace} is not a Cargo workspace (no Cargo.toml)`);
  process.exit(2);
}

const outputDir = join(repoRoot, 'coverage');
mkdirSync(outputDir, { recursive: true });
const output = join(outputDir, `rust-${workspace.replace(/[\\/]/g, '-')}.json`);

try {
  execFileSync(
    'cargo',
    ['llvm-cov', '--workspace', '--json', '--output-path', output, '--locked'],
    { cwd, stdio: 'inherit' },
  );
} catch (error) {
  console.error(`✗ cargo llvm-cov failed in ${workspace}: ${error.message}`);
  console.error('  install it once with: cargo install cargo-llvm-cov --locked');
  process.exit(1);
}

console.log(`wrote ${relative(repoRoot, output)}`);
