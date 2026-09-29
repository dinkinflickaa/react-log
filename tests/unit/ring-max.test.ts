import { expect, test } from 'vitest';
import { start } from './harness.ts';

// Its own file: the harness installs one shim per file, and this one needs
// a ring too small for the fixture app's first render.

test(`React ${process.env.REACT_VERSION} on a ring at its maximum: records dropped, never the commit row, which counts its own`, async () => {
  const h = await start({ config: { ringSize: 4, ringMax: 8 } });
  const rows = h.take();
  const lost = h.messages.filter((m) => m.t === 'batch').reduce((n, b) => n + b.dropped, 0);
  const commit = rows.find((r) => r[0] === 'commit');
  expect(commit).toBeDefined();
  expect(commit![13].dropped).toBeGreaterThan(0);
  expect(commit![13].dropped).toBeLessThanOrEqual(lost);
  expect(rows.filter((r) => r[0] === 'render').length).toBeLessThan(10);
});
