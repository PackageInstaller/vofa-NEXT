import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { commentsOf, looksLikeCode, scanComments } from './check-comments.mjs';

/**
 * Self-test for the comment scan.
 *
 * Three behaviours matter and each has bitten a naive implementation: a marker inside a string
 * must not fire, a doc comment may legitimately contain code (Rust examples live there), and a
 * plain `//` comment holding a statement is dead code that should have been deleted.
 */
describe('comment extraction', () => {
  it('reads a line comment', () => {
    const found = commentsOf('const a = 1; // why\n');
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe(' why');
    expect(found[0].doc).toBe(false);
  });

  it('marks a Rust doc comment so its examples are exempt', () => {
    const found = commentsOf('/// Example: let x = f();\nfn f() {}\n');
    expect(found[0].doc).toBe(true);
  });

  it('does not treat a URL inside a string as a comment', () => {
    const found = commentsOf("const url = 'https://example.com';\n");
    expect(found).toHaveLength(0);
  });

  it('reads a block comment as one unit', () => {
    const found = commentsOf('/*\n * one\n * two\n */\n');
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('one');
    expect(found[0].text).toContain('two');
  });

  it('keeps counting lines so a finding points at the right one', () => {
    const found = commentsOf('a\nb\n// third\n');
    expect(found[0].line).toBe(3);
  });
});

describe('dead-code detection', () => {
  it('flags a commented-out statement', () => {
    expect(looksLikeCode({ doc: false, text: ' const value = compute();' })).toBe(true);
  });

  it('does not flag prose that ends in a full stop', () => {
    expect(looksLikeCode({ doc: false, text: ' Returns the value.' })).toBe(false);
  });

  it('does not flag a doc example', () => {
    expect(looksLikeCode({ doc: true, text: ' let value = compute();' })).toBe(false);
  });

  it('does not flag a backtick-quoted mention', () => {
    expect(looksLikeCode({ doc: false, text: ' `fn main() {}`;' })).toBe(false);
  });
});

describe('findings', () => {
  const root = mkdtempSync(join(tmpdir(), 'comments-'));

  const write = (name, content) => {
    writeFileSync(join(root, name), content);
    return name;
  };

  it('reports a task id in a comment', () => {
    const path = write('task.ts', '// see M3.5 for the rationale\n');
    const findings = scanComments([path], root);
    expect(findings).toHaveLength(1);
    expect(findings[0].what).toContain('task or milestone');
  });

  it('reports a date and an untracked TODO', () => {
    write('markers.rs', '// 2026-10-26\n// TODO: fix later\n');
    const findings = scanComments(['markers.rs'], root);
    expect(findings.map((finding) => finding.what)).toEqual([
      expect.stringContaining('date'),
      expect.stringContaining('TODO'),
    ]);
  });

  it('ignores a marker in a string literal', () => {
    const path = write('string.ts', "const label = 'Phase 2';\n");
    expect(scanComments([path], root)).toHaveLength(0);
  });

  it('accepts a comment that explains an invariant', () => {
    const path = write('clean.ts', '// The lock is held for the whole write so a reader cannot interleave.\n');
    expect(scanComments([path], root)).toHaveLength(0);
  });
});
