import { expect, test } from 'vitest';
import { Ring } from '../../packages/shim/src/ring.ts';
import { start } from './harness.ts';

// Its own file: the harness installs one shim per file. The browser refuses
// the ring anything past 8 slots, so the fixture app's first render cannot
// fit: the records that do not are lost, and the commit row, which the ring
// keeps room for, says how many.

test(`React ${process.env.REACT_VERSION}, the browser refusing memory: records lost, never silently`, async () => {
  const resize = (Ring.prototype as any).resize;
  (Ring.prototype as any).resize = function (this: Ring, cap: number) {
    if (cap > 8) throw new RangeError('Array buffer allocation failed');
    return resize.call(this, cap);
  };
  try {
    const h = await start({ config: { ringSize: 4 } });
    const rows = h.take();
    const lost = h.messages.filter((m) => m.t === 'batch').reduce((n, b) => n + b.dropped, 0);
    const commit = rows.find((r) => r[0] === 'commit');
    expect(commit).toBeDefined();
    expect(commit![13].dropped).toBeGreaterThan(0);
    expect(commit![13].dropped).toBeLessThanOrEqual(lost);
  } finally {
    (Ring.prototype as any).resize = resize;
  }
});
