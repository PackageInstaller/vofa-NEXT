import { describe, expect, it } from 'vitest';

import { mirrorFieldDrift } from './check-contracts.mjs';

/**
 * Self-test for the hand-maintained mirror comparison.
 *
 * `client/src/lib/tauri/tauriTypes.ts` shadows several Rust structs by hand, so the
 * byte-for-byte generated-file check cannot see it drift. That is not theoretical:
 * `PipelineConfig` gained `eval_simd` on the Rust side while this mirror kept the old
 * field list, so every settings push omitted the flag and `#[serde(default)]` silently
 * re-enabled SIMD. These fixtures pin the comparison that now catches it.
 */
describe('hand-written mirror drift', () => {
  it('reports the real eval_simd regression', () => {
    const rust = new Set([
      'mode',
      'max_workers',
      'eval_workers',
      'eval_simd',
      'memory_budget_mb',
      'preview_fps_limit',
      'preview_bandwidth_mb_per_sec',
    ]);
    const ts = new Set([
      'mode',
      'max_workers',
      'eval_workers',
      'memory_budget_mb',
      'preview_fps_limit',
      'preview_bandwidth_mb_per_sec',
    ]);

    const drift = mirrorFieldDrift('PipelineConfig', ts, rust);

    expect(drift).not.toBeNull();
    expect(drift).toContain('PipelineConfig');
    expect(drift).toContain('missing eval_simd');
  });

  it('accepts an identical field set', () => {
    const fields = new Set(['id', 'label']);

    expect(mirrorFieldDrift('Thing', fields, new Set(['id', 'label']))).toBeNull();
  });

  it('reports a field the Rust side does not have', () => {
    const drift = mirrorFieldDrift('Thing', new Set(['id', 'ghost']), new Set(['id']));

    expect(drift).not.toBeNull();
    expect(drift).toContain('not on the Rust side ghost');
    expect(drift).not.toContain('missing');
  });

  it('lists both directions when they differ', () => {
    const drift = mirrorFieldDrift('Thing', new Set(['keep', 'ghost']), new Set(['keep', 'added']));

    expect(drift).toContain('missing added');
    expect(drift).toContain('not on the Rust side ghost');
  });

  it('sorts the names so the message is stable', () => {
    const drift = mirrorFieldDrift('Thing', new Set(), new Set(['zeta', 'alpha']));

    expect(drift).toContain('missing alpha, zeta');
  });
});
