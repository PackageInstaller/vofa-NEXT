#!/usr/bin/env node
//! check:model-catalog — model catalog consistency guard (frontend-visible surface).
//!
//! The backend `kind::widgets::ensure_valid` already validates registration ID/variant
//! uniqueness and port/lowering correspondence at startup; this script additionally
//! validates the frontend consumption surface and the exported fixtures:
//!   1. golden fixtures parse, NodeDocument kinds are valid, model id/variants unique;
//!   2. the catalog contract version agrees between the Rust source and the frontend store constant;
//!   3. every renderer / icon / panel-renderer key the template catalog declares is implemented
//!      by the client, and the client implements nothing the catalog does not declare;
//!   4. the test-catalog fixture's widget kind set matches the template catalog's kind set.

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

// ---- 3. Template fixture ↔ client implementation registries ----
//
// 模板目录是「有哪些控件 / 面板」的唯一权威, 客户端只提供实现。这里比对两侧的键:
// 模板声明了一个客户端没有的键 → 该控件会显示为不支持; 客户端有模板没声明的键 →
// 前端还在维护一份后端不认的清单。两种都必须失败。

/// 读取一段 `export const NAME = { ... }` 里的顶层键 (支持 `Key,` / `Key: Value,` /
/// `'kebab-key': Value,` 三种写法)。
function keysOfObject(source, marker, file) {
  const start = source.indexOf(marker);
  if (start < 0) {
    fail(`${file}: could not find ${marker}`);
    return null;
  }
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n};', open) >= 0 ? source.indexOf('\n};', open) : source.indexOf('\n} as const', open);
  if (open < 0 || close < 0) {
    fail(`${file}: could not delimit ${marker}`);
    return null;
  }
  const keys = [];
  for (const line of source.slice(open + 1, close).split('\n')) {
    const match = /^\s{2}(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_-]+))\s*[:,]/.exec(line);
    if (match) keys.push(match[1] ?? match[2] ?? match[3]);
  }
  if (keys.length === 0) fail(`${file}: ${marker} has no entries`);
  return keys;
}

const rendererRegistryFile = join(root, 'client', 'src', 'components', 'widgets', 'rendererRegistry.ts');
const iconRegistryFile = join(root, 'client', 'src', 'lib', 'icons', 'registry.ts');
const panelRendererFile = join(root, 'client', 'src', 'components', 'panels', 'panelRenderers.ts');

const rendererKeys = keysOfObject(readFileSync(rendererRegistryFile, 'utf8'), 'WIDGET_RENDERERS', rendererRegistryFile);
const iconKeys = keysOfObject(readFileSync(iconRegistryFile, 'utf8'), 'ICONS', iconRegistryFile);
const panelRendererKeys = keysOfObject(readFileSync(panelRendererFile, 'utf8'), 'PANEL_RENDERERS', panelRendererFile);

/// 两个集合必须互相覆盖, 差异各报一条。
///
/// `strict` 控制是否也禁止客户端多出实现。渲染器必须严格对齐 —— 一个模板不认识的
/// 渲染器就是一份后端不认的元数据。图标放宽: 外壳 tab 与协议/解码条目是客户端自有
/// 界面, 它们的图标键天然不在模板里。
function compareSets(label, declared, implemented, describe, strict = true) {
  const declaredSet = new Set(declared);
  const implementedSet = new Set(implemented);
  const missing = declared.filter((key) => !implementedSet.has(key));
  const extra = strict ? implemented.filter((key) => !declaredSet.has(key)) : [];
  if (missing.length) fail(`${label}: no client implementation for ${missing.join(', ')} ${describe}`);
  if (extra.length) fail(`${label}: client implements ${extra.join(', ')}, which the template catalog does not declare`);
  return missing.length === 0 && extra.length === 0;
}

const templateFixturePath = join(fixtureDir, 'template_catalog.json');
let templateFixture = null;
try {
  templateFixture = JSON.parse(readFileSync(templateFixturePath, 'utf8'));
} catch (error) {
  fail(`template_catalog.json is missing or invalid: ${error.message} — run pnpm generate:templates`);
}

if (templateFixture && rendererKeys && iconKeys && panelRendererKeys) {
  const widgets = templateFixture.widgets ?? [];
  const panels = [
    ...widgets.flatMap((widget) => (widget.panel ? [widget.panel] : [])),
    ...(templateFixture.standalonePanels ?? []),
  ];

  const renderersOk = compareSets(
    'template renderer keys',
    widgets.map((widget) => widget.rendererKey),
    rendererKeys,
    '(add it to client/src/components/widgets/rendererRegistry.ts)'
  );
  const panelRenderersOk = compareSets(
    'template panel renderer keys',
    panels.map((panel) => panel.rendererKey),
    panelRendererKeys,
    '(add it to client/src/components/panels/panelRenderers.ts)'
  );
  const iconKeysOk = compareSets(
    'template icon keys',
    [...widgets, ...panels, ...(templateFixture.palette ?? [])].map((entry) => entry.iconKey),
    iconKeys,
    '(add it to client/src/lib/icons/registry.ts)',
    false
  );

  const paletteIds = new Set((templateFixture.palette ?? []).map((section) => section.id));
  for (const widget of widgets) {
    // 控件落在前端不渲染的分区 = 用户在调色板里永远找不到它
    if (!paletteIds.has(widget.category)) {
      fail(`${widget.kind}: category ${widget.category} has no palette section`);
    }
  }

  if (renderersOk && panelRenderersOk && iconKeysOk) {
    ok(
      `template catalog matches the client registries (${widgets.length} widgets, ${panels.length} panels, ${paletteIds.size} sections)`
    );
  }
}

// ---- 4. Test-catalog fixture ↔ template widget kinds ----

const catalogTs = readFileSync(join(root, 'client', 'src', 'test', 'modelCatalog.ts'), 'utf8');
const listStart = catalogTs.indexOf('WIDGET_TEST_KINDS = [');
const listEnd = catalogTs.indexOf('] as const', listStart);
const kindsFromList = listStart >= 0 && listEnd > listStart
  ? [...catalogTs.slice(listStart, listEnd).matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1])
  : [];
if (kindsFromList.length === 0) {
  fail('could not parse WIDGET_TEST_KINDS from client/src/test/modelCatalog.ts');
} else if (templateFixture) {
  const templateKinds = (templateFixture.widgets ?? []).map((widget) => widget.kind);
  const template = new Set(templateKinds);
  const fixture = new Set(kindsFromList);
  const missingInFixture = templateKinds.filter((kind) => !fixture.has(kind));
  const extraInFixture = kindsFromList.filter((kind) => !template.has(kind));
  if (missingInFixture.length) fail(`test catalog is missing kinds present in the template catalog: ${missingInFixture.join(', ')}`);
  if (extraInFixture.length) fail(`test catalog has kinds the template catalog does not declare: ${extraInFixture.join(', ')}`);
  if (!missingInFixture.length && !extraInFixture.length) {
    ok(`test catalog kind set matches the template catalog (${templateKinds.length} kinds)`);
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
