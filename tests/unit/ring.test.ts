import { describe, expect, test } from 'vitest';
import { K_COMMIT, K_RENDER, Ring } from '../../packages/shim/src/ring.ts';
import { start } from './harness.ts';

// The ring holds a commit's records until capture takes them. It grows
// rather than drop, keeps every index a writer holds, and drops only when the
// browser refuses the memory.

const fill = (ring: Ring, n: number) => Array.from({ length: n }, (_, k) => {
  const i = ring.alloc(K_RENDER);
  if (i >= 0) {
    ring.t0[i] = k;
    ring.r0[i] = { k };
  }
  return i;
});

describe('Ring', () => {
  test('grows past its first size, every record at the index it was written to', () => {
    const ring = new Ring(4);
    const slots = fill(ring, 20);
    expect(ring.dropped).toBe(0);
    expect(ring.cap).toBe(32);
    slots.forEach((i, k) => {
      expect(ring.t0[i]).toBe(k);
      expect(ring.r0[i]).toEqual({ k });
    });
  });

  test('at the end of its arrays, moves the unread records to the front and fixes up held indices', () => {
    const ring = new Ring(8);
    const held = new Int32Array([7, 3, -1]);
    ring.holders.push(held);
    fill(ring, 8);
    for (let k = 0; k < 6; k++) ring.release(ring.peek());
    const i = ring.alloc(K_COMMIT);
    expect(ring.dropped).toBe(0);
    expect([ring.tail, i, ring.count]).toEqual([0, 2, 3]);
    // Record 7 is now at 1; record 3 was already read.
    expect([...held]).toEqual([1, -1, -1]);
    expect(ring.t0[1]).toBe(7);
    expect(ring.r0[1]).toEqual({ k: 7 });
    expect(ring.r0[2]).toBeNull();
  });

  test('drops only when the browser refuses the memory, and counts it', () => {
    const ring = new Ring(4);
    (ring as any).resize = () => {
      throw new RangeError('Array buffer allocation failed');
    };
    expect(fill(ring, 6).filter((i) => i < 0)).toHaveLength(2);
    expect([ring.dropped, ring.count, ring.cap]).toEqual([2, 4, 4]);
    // Room at the front, once read, still takes a record.
    ring.release(ring.peek());
    expect(ring.alloc(K_COMMIT)).toBe(3);
    expect(ring.dropped).toBe(2);
  });

  test('empty again, goes back to its first size', () => {
    const ring = new Ring(4);
    fill(ring, 40);
    while (ring.peek() >= 0) ring.release(ring.peek());
    ring.settle();
    expect([ring.cap, ring.head, ring.tail, ring.peakCap, ring.peak]).toEqual([4, 0, 0, 64, 40]);
  });
});

describe(`the shim on a small ring, React ${process.env.REACT_VERSION}`, () => {
  test('a mount bigger than the ring grows it and loses nothing', async () => {
    const h = await start({ config: { ringSize: 4 } });
    const rows = h.take();
    const batches = h.messages.filter((m) => m.t === 'batch');
    expect(batches.reduce((n, b) => n + b.dropped, 0)).toBe(0);
    expect(rows.filter((r) => r[0] === 'render').length).toBe(10);
    const commit = rows.find((r) => r[0] === 'commit')!;
    expect(commit[13].dropped).toBe(0);
    expect(Math.max(...batches.map((b) => b.peak))).toBeGreaterThan(4);
  });
});

