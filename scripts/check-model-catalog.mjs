#!/usr/bin/env node
//! check:model-catalog — model catalog consistency guard (frontend-visible surface).
//!
//! The backend `kind::widgets::ensure_valid` already validates registration ID/variant
//! uniqueness and port/lowering correspondence at startup; this script additionally
//! validates the frontend consumption surface and the exported fixtures:
//!   1. golden fixtures parse, NodeDocument kinds are valid, model id/variants unique;
//!   2. the catalog contract version agrees between the Rust source and the frontend store constant;
//!   3. the test-catalog fixture's widget kind set exactly matches the UI registry (rendererKey
//!      domain) — adding a backend variant/kind and missing it on either side shows up here.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const fail = (message) => { console.error(`✗ ${message}`); failed = true; };
const ok = (message) => console.log(`✓ ${message}`);

// ---- 1. golden fixtures ----

const fixtureDir = join(root, 'client', 'src', 'test', 'fixtures');
const fixtures = readdirSync(fixtureDir).filter((name) => name.endsWith('.json'));
if (fixtures.length === 0) fail('no exported fixtures under client/src/test/fixtures');
const VALID_KINDS = new Set(['device', 'protocol', 'pointSelector', 'widget']);
const seenDocIds = new Map();
for (const name of fixtures) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
  } catch (error) {
    fail(`${name} is not valid JSON: ${error.message}`);
    continue;
  }
  if (name.startsWith('node_document_')) {
    if (!VALID_KINDS.has(parsed.kind)) fail(`${name}: unknown document kind ${parsed.kind}`);
    if (typeof parsed.id !== 'string' || parsed.id === '') fail(`${name}: invalid document id`);
    if (seenDocIds.has(parsed.id) && seenDocIds.get(parsed.id) !== name) {
      fail(`${name}: document id ${parsed.id} duplicates ${seenDocIds.get(parsed.id)}`);
    }
    seenDocIds.set(parsed.id, name);
    if (parsed.config?.node) {
      const ids = new Set();
      const visit = (node) => {
        if (ids.has(node.id)) fail(`${name}: duplicate device-tree node id ${node.id}`);
        ids.add(node.id);
        for (const child of node.children ?? []) visit(child);
      };
      visit(parsed.config.node);
    }
  }
}
ok(`golden fixtures parsed (${fixtures.length} files)`);

// ---- 2. Catalog contract version agreement (Rust ↔ frontend store constant) ----

const modelDescriptorRs = readFileSync(
  join(root, 'server', 'core', 'crates', 'shared', 'data-model', 'src', 'model_descriptor.rs'), 'utf8');
const rustVersion = /MODEL_CATALOG_CONTRACT_VERSION(?:[^;=]*?)?=[ \t]*(\d+)/.exec(modelDescriptorRs)?.[1];
const storeTs = readFileSync(join(root, 'client', 'src', 'store', 'modelCatalogStore.ts'), 'utf8');
const tsVersion = /MODEL_CATALOG_CONTRACT_VERSION\s*=\s*(\d+)/.exec(storeTs)?.[1];
if (!rustVersion || !tsVersion) {
  fail(`failed to parse the contract version (rust=${rustVersion}, ts=${tsVersion})`);
} else if (rustVersion !== tsVersion) {
  fail(`catalog contract version mismatch: rust=${rustVersion}, ts=${tsVersion}`);
} else {
  ok(`catalog contract version matches (v${rustVersion})`);
}

// ---- 3. Test-catalog fixture ↔ UI registry kind set ----

const registryTs = readFileSync(join(root, 'client', 'src', 'components', 'widgets', 'registry.ts'), 'utf8');
const registryKinds = [...registryTs.matchAll(/^(?:\s){2}([A-Za-z0-9]+): \w+Def,$/gm)].map((m) => m[1]);
if (registryKinds.length === 0) fail('could not parse the widget kind table from client/src/components/widgets/registry.ts');

const catalogTs = readFileSync(join(root, 'client', 'src', 'test', 'modelCatalog.ts'), 'utf8');
const listStart = catalogTs.indexOf('WIDGET_TEST_KINDS = [');
const listEnd = catalogTs.indexOf('] as const', listStart);
const kindsFromList = listStart >= 0 && listEnd > listStart
  ? [...catalogTs.slice(listStart, listEnd).matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1])
  : [];
if (kindsFromList.length === 0) {
  fail('could not parse WIDGET_TEST_KINDS from client/src/test/modelCatalog.ts');
} else {
  const registry = new Set(registryKinds);
  const fixture = new Set(kindsFromList);
  const missingInFixture = registryKinds.filter((k) => !fixture.has(k));
  const extraInFixture = kindsFromList.filter((k) => !registry.has(k));
  if (missingInFixture.length) fail(`test catalog is missing kinds present in the UI registry: ${missingInFixture.join(', ')}`);
  if (extraInFixture.length) fail(`test catalog has kinds the UI registry does not implement: ${extraInFixture.join(', ')}`);
  if (!missingInFixture.length && !extraInFixture.length) {
    ok(`widget kind coverage matches (${registryKinds.length} kinds)`);
  }
}

// ---- 4. Template catalog fixture ↔ UI registry kind set ----

const templateFixturePath = join(fixtureDir, 'template_catalog.json');
let templateFixture = null;
try {
  templateFixture = JSON.parse(readFileSync(templateFixturePath, 'utf8'));
} catch (error) {
  fail(`template_catalog.json is missing or invalid: ${error.message} — run pnpm generate:templates`);
}
if (templateFixture) {
  const templateKinds = (templateFixture.widgets ?? []).map((widget) => widget.kind);
  const registry = new Set(registryKinds);
  const missing = registryKinds.filter((kind) => !templateKinds.includes(kind));
  const extra = templateKinds.filter((kind) => !registry.has(kind));
  if (missing.length) fail(`template catalog is missing widgets the UI implements: ${missing.join(', ')}`);
  if (extra.length) fail(`template catalog has widgets the UI does not implement: ${extra.join(', ')}`);
  const paletteIds = new Set((templateFixture.palette ?? []).map((section) => section.id));
  for (const widget of templateFixture.widgets ?? []) {
    // 控件落在前端不渲染的分区 = 用户在调色板里永远找不到它
    if (!paletteIds.has(widget.category)) {
      fail(`${widget.kind}: category ${widget.category} has no palette section`);
    }
  }
  if (!missing.length && !extra.length) {
    ok(`template catalog covers the UI registry (${templateKinds.length} widgets, ${paletteIds.size} sections)`);
  }
}

// ---- 5. Template fixture is what the backend projects right now ----

const generatedFixture = join(mkdtempSync(join(tmpdir(), 'lissio-templates-')), 'template_catalog.json');
try {
  const result = spawnSync('node', [join(root, 'scripts', 'generate-templates.mjs')], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, LISSIO_TEMPLATES_OUT: generatedFixture },
  });
  if (result.status !== 0) {
    fail('template catalog regeneration failed');
  } else if (!existsSync(templateFixturePath)) {
    fail('client/src/test/fixtures/template_catalog.json is missing — run pnpm generate:templates');
  } else {
    const committed = readFileSync(templateFixturePath, 'utf8');
    const regenerated = readFileSync(generatedFixture, 'utf8');
    if (committed !== regenerated) {
      fail('template catalog fixture is stale — run pnpm generate:templates');
    } else {
      ok('template catalog fixture matches the backend projection');
    }
  }
} finally {
  rmSync(dirname(generatedFixture), { recursive: true, force: true });
}

if (failed) {
  console.error('\ncheck:model-catalog failed');
  process.exit(1);
}
console.log('\ncheck:model-catalog passed');
