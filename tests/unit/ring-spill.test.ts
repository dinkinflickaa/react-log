import { expect, test } from 'vitest';
import { start } from './harness.ts';

// Its own file: the harness installs one shim per file, and this one needs a
// high watermark below the fixture app's first render.

test(`React ${process.env.REACT_VERSION}, past the high watermark: capture takes finished records at the commit boundary, nothing dropped`, async () => {
  const h = await start({ config: { ringSize: 4, ringHigh: 6 } });
  // Batches sent before anything asked: the spill, after the first commit.
  const early = h.messages.filter((m) => m.t === 'batch').length;
  expect(early).toBeGreaterThan(0);
  expect(h.api.stats.spills).toBeGreaterThan(0);
  const rows = h.take();
  const batches = h.messages.filter((m) => m.t === 'batch');
  expect(batches.reduce((n, b) => n + b.dropped, 0)).toBe(0);
  expect(rows.filter((r) => r[0] === 'render').length).toBe(10);
  const commit = rows.find((r) => r[0] === 'commit')!;
  expect(commit[13].dropped).toBe(0);
  // The spill and the walk are recorded as the shim's own work.
  const kinds = new Set(batches.flatMap((b) => b.slices.filter((_: number, k: number) => k % 3 === 2)));
  expect(kinds.has(2)).toBe(true);
  expect(kinds.has(3)).toBe(true);
});
