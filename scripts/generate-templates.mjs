#!/usr/bin/env node
// Generates the template catalog fixture from the backend projection.
//
// The catalog answers "where does the palette put this widget, which renderer draws it, how big
// may the canvas make it, which panel does it open". A gate can only compare it if it exists as a
// file, and the export program writes it in registry order so the same code always produces the
// same bytes.
//
// Authoritative source: server/crates/desktop/rpc-api/examples/export_templates.rs
// Output: client/src/test/fixtures/template_catalog.json
//
// Environment variables:
//   LISSIO_TEMPLATES_OUT  overrides the output path (check:model-catalog writes to a temp file)
//
// Usage: pnpm generate:templates

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outFile =
  process.env.LISSIO_TEMPLATES_OUT ??
  path.join(root, 'client', 'src', 'test', 'fixtures', 'template_catalog.json');

const result = spawnSync(
  'cargo',
  ['run', '-q', '-p', 'lissio-rpc-api', '--example', 'export_templates'],
  {
    cwd: path.join(root, 'server'),
    stdio: 'inherit',
    env: { ...process.env, LISSIO_TEMPLATES_OUT: outFile },
  }
);

if (result.status !== 0) {
  console.error(`template generation failed (exit ${result.status ?? 'signal'})`);
  process.exit(result.status ?? 1);
}
