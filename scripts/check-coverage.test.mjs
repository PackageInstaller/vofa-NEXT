import { describe, expect, it } from 'vitest';

import { coverageFloors, judgeCoverage, NEW_MODULE_FLOOR } from './check-coverage.mjs';

/**
 * Self-test for the per-file coverage comparison.
 *
 * The rule this pins: a newly introduced module must be tested from its first commit, while an
 * existing file is measured against its own recorded value and never against the new-module
 * floor. The second half is not theoretical — `client/src/lib/panels/` already held the panel
 * metadata mirror when the new directories were introduced, and holding it to 90% because of
 * the directory it sits in would fail a change that never touched it.
 */
describe('coverage floors', () => {
  it('applies the new-module floor to an unrecorded file in a new module', () => {
    expect(coverageFloors('client/src/lib/templates/select.ts').lines).toBe(NEW_MODULE_FLOOR);
  });

  it('keeps a recorded file on its own value even inside a new module', () => {
    const floors = coverageFloors('client/src/lib/panels/panelDefs.ts', {
      lines: 57.34,
      branches: 48.22,
      functions: 49.98,
      statements: 55.3,
    });
    expect(floors.branches).toBe(48.22);
  });

  it('does not raise a recorded file to the new-module floor', () => {
    const floors = coverageFloors('client/src/components/panels/PanelHost.tsx', {
      lines: 12,
      branches: 8,
      functions: 10,
      statements: 12,
    });
    expect(floors.lines).toBeLessThan(NEW_MODULE_FLOOR);
  });

  it('treats an unrecorded legacy file as legacy', () => {
    expect(coverageFloors('client/src/components/ui/Select.tsx').lines).toBe(0);
  });
});

describe('coverage judgement', () => {
  const baseline = {
    'client/src/lib/templates/select.ts': { lines: 95, branches: 95, functions: 95, statements: 95 },
  };

  it('reports a file below its recorded value', () => {
    const findings = judgeCoverage(
      { 'client/src/lib/templates/select.ts': { lines: 80, branches: 95, functions: 95, statements: 95 } },
      baseline,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].metric).toBe('lines');
    expect(findings[0].actual).toBe(80);
    expect(findings[0].floor).toBe(95);
  });

  it('accepts a file at exactly its floor', () => {
    expect(
      judgeCoverage(
        { 'client/src/lib/templates/select.ts': { lines: 95, branches: 95, functions: 95, statements: 95 } },
        baseline,
      ),
    ).toHaveLength(0);
  });

  it('reports every metric that is short, not only the first', () => {
    const findings = judgeCoverage(
      { 'client/src/lib/templates/select.ts': { lines: 10, branches: 20, functions: 30, statements: 40 } },
      baseline,
    );
    expect(findings.map((finding) => finding.metric).sort()).toEqual([
      'branches',
      'functions',
      'lines',
      'statements',
    ]);
  });

  it('skips a metric the report does not measure', () => {
    // LLVM exports lines and functions only; a baseline that also carries branches and
    // statements must not turn their absence into a silent 0% against a recorded floor.
    const recorded = {
      'server/crates/graph/kind/src/widgets.rs': { lines: 90, functions: 90 },
    };
    const findings = judgeCoverage(
      { 'server/crates/graph/kind/src/widgets.rs': { lines: 89 } },
      recorded,
    );
    expect(findings).toEqual([
      { path: 'server/crates/graph/kind/src/widgets.rs', metric: 'lines', actual: 89, floor: 90 },
    ]);
  });

  it('ignores a file with nothing to measure', () => {
    expect(
      judgeCoverage({ 'client/src/lib/templates/empty.ts': { lines: 0, branches: 0, functions: 0, statements: 0 } }, {}),
    ).toHaveLength(0);
  });
});
