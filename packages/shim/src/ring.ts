// FIFO of raw records, written inside React's commit and read in idle time.
// Numbers live in typed arrays; object references (fibers, props, hook lists)
// in plain arrays, so writing a record allocates nothing.
//
// A commit writes all its records before capture can take any, and one can
// hold more than any fixed size (a first render of 100,000 components), so
// the ring grows instead of dropping. Records are appended at the end; at the
// end of the arrays the ring either moves the unread records to the front or
// doubles the arrays. Growing keeps every index; moving shifts them, and
// fixes up the index arrays in `holders` (the walk's slots, effect spans
// waiting for their commit, the last commit row), so an index held across a
// write stays valid. The ring itself has no limit: the pipeline keeps it near
// a high watermark by taking records synchronously (spill), and a record is
// dropped, and counted, only when the browser refuses the memory. Other
// records stop short of the last slots (up to 64), which only commit rows may
// take: a commit's row carries its count of lost records, so a loss is never
// silent. Once empty, the ring goes back to its first size.

export const K_RENDER = 1;
export const K_COMMIT = 2;
export const K_LAYOUT_EFFECT = 3;
export const K_PASSIVE_EFFECT = 4;
export const K_UPDATE = 5;
export const K_YIELD = 6;
export const K_SUSPEND = 7;
export const K_ENTRY = 8; // a PerformanceEntry: event, mark, measure, long-animation-frame
export const K_WATCH = 9;
export const K_EFFECT_SPAN = 10; // 19.2+: a component effect span, matched to a fiber in idle time

type Indices = { length: number; [i: number]: number };

export class Ring {
  cap = 0;
  readonly minCap: number;
  kind = new Uint8Array(0);
  commit = new Int32Array(0);
  t0 = new Float64Array(0);
  t1 = new Float64Array(0);
  t2 = new Float64Array(0);
  n0 = new Int32Array(0);
  r0: unknown[] = [];
  r1: unknown[] = [];
  r2: unknown[] = [];
  r3: unknown[] = [];
  r4: unknown[] = [];
  r5: unknown[] = [];
  r6: unknown[] = [];
  head = 0;
  tail = 0;
  count = 0;
  dropped = 0;
  // The most records held at once, and the most slots allocated.
  peak = 0;
  peakCap = 0;
  // Arrays of indices held across writes; -1 is none.
  readonly holders: Indices[] = [];

  constructor(cap: number) {
    this.minCap = Math.max(1, cap);
    this.resize(this.minCap);
  }

  // Returns the slot to fill, or -1 when the browser refused more memory.
  alloc(kind: number): number {
    while (this.head >= (kind === K_COMMIT ? this.cap : this.cap - Math.min(64, this.cap >> 3))) {
      if (!this.makeRoom()) {
        this.dropped++;
        return -1;
      }
    }
    const i = this.head++;
    this.count++;
    if (this.count > this.peak) this.peak = this.count;
    this.kind[i] = kind;
    this.commit[i] = 0;
    this.t0[i] = NaN;
    this.t1[i] = NaN;
    this.t2[i] = NaN;
    this.n0[i] = 0;
    return i;
  }

  // Oldest slot, or -1 when empty. Call release(i) after reading it.
  peek(): number {
    return this.count === 0 ? -1 : this.tail;
  }

  release(i: number): void {
    this.r0[i] = this.r1[i] = this.r2[i] = this.r3[i] = this.r4[i] = this.r5[i] = this.r6[i] = null;
    this.tail = i + 1;
    this.count--;
  }

  // Empty: back to the front, at the first size.
  settle(): void {
    if (this.count === 0 && (this.tail !== 0 || this.cap !== this.minCap)) this.moveTo(this.minCap);
  }

  private makeRoom(): boolean {
    try {
      if (this.tail > 0 && this.count <= this.cap >> 1) this.moveTo(this.cap);
      else this.resize(this.cap * 2);
      return true;
    } catch {
      // Out of memory for bigger arrays: room at the front, if any.
      if (this.tail === 0) return false;
      this.moveTo(this.cap);
      return true;
    }
  }

  // Arrays of `cap` slots, every record at the same index.
  private resize(cap: number): void {
    this.moveTo(cap, false);
  }

  // Arrays of `cap` slots (the same arrays when the size does not change),
  // with the unread records at the front, or at the same indices.
  private moveTo(cap: number, front = true): void {
    const from = this.tail;
    const to = this.head;
    const at = front ? 0 : from;
    if (cap === this.cap) {
      if (at !== from) {
        for (const a of [this.kind, this.commit, this.t0, this.t1, this.t2, this.n0]) a.copyWithin(at, from, to);
        for (const a of [this.r0, this.r1, this.r2, this.r3, this.r4, this.r5, this.r6]) {
          a.copyWithin(at, from, to);
          a.fill(null, at + this.count, to);
        }
      }
    } else {
      // Every new array first, so running out of memory leaves the ring as it was.
      const kind = new Uint8Array(cap);
      const commit = new Int32Array(cap);
      const t0 = new Float64Array(cap);
      const t1 = new Float64Array(cap);
      const t2 = new Float64Array(cap);
      const n0 = new Int32Array(cap);
      const refs = [this.r0, this.r1, this.r2, this.r3, this.r4, this.r5, this.r6].map(() => new Array<unknown>(cap).fill(null));
      kind.set(this.kind.subarray(from, to), at);
      commit.set(this.commit.subarray(from, to), at);
      t0.set(this.t0.subarray(from, to), at);
      t1.set(this.t1.subarray(from, to), at);
      t2.set(this.t2.subarray(from, to), at);
      n0.set(this.n0.subarray(from, to), at);
      [this.r0, this.r1, this.r2, this.r3, this.r4, this.r5, this.r6].forEach((old, k) => {
        const next = refs[k]!;
        for (let i = from; i < to; i++) next[i - from + at] = old[i];
      });
      this.kind = kind;
      this.commit = commit;
      this.t0 = t0;
      this.t1 = t1;
      this.t2 = t2;
      this.n0 = n0;
      [this.r0, this.r1, this.r2, this.r3, this.r4, this.r5, this.r6] = refs as [unknown[], unknown[], unknown[], unknown[], unknown[], unknown[], unknown[]];
      this.cap = cap;
      if (cap > this.peakCap) this.peakCap = cap;
    }
    if (at !== from) {
      for (const h of this.holders) {
        for (let j = 0; j < h.length; j++) {
          const x = h[j]!;
          if (x >= 0) h[j] = x >= from ? x - from + at : -1;
        }
      }
    }
    this.tail = at;
    this.head = at + this.count;
  }
}
