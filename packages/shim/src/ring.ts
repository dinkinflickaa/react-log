// FIFO of raw records, written inside React's commit and read in idle time.
// Numbers live in typed arrays; object references (fibers, props, hook lists)
// in plain arrays, so writing a record allocates nothing.
//
// A commit writes all its records before capture can take any, and one can
// hold more than any fixed size (a first render of 100,000 components), so
// the ring grows instead of dropping. Records are appended at the end; at the
// end of the arrays the ring either moves the unread records to the front or
// doubles the arrays, up to maxCap. Growing keeps every index; moving shifts
// them, and fixes up the index arrays in `holders` (the walk's slots, effect
// spans waiting for their commit), so an index held across a write stays
// valid. Only past maxCap is an incoming record dropped and counted; the
// last slots are kept for commit rows, which carry each commit's count of
// dropped records, so a loss is never silent. Once empty, the ring goes back
// to its first size.

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
  readonly maxCap: number;
  // Slots at the top only commit rows may take.
  readonly reserve: number;
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

  constructor(cap: number, maxCap = cap) {
    this.minCap = Math.max(1, cap);
    this.maxCap = Math.max(this.minCap, maxCap);
    this.reserve = Math.min(1024, this.maxCap >> 3);
    this.resize(this.minCap);
  }

  // Returns the slot to fill, or -1 when the ring is at maxCap and full.
  alloc(kind: number): number {
    if ((kind !== K_COMMIT && this.count >= this.maxCap - this.reserve) || (this.head === this.cap && !this.makeRoom())) {
      this.dropped++;
      return -1;
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
    if (this.tail > 0 && this.count <= this.cap >> 1) this.moveTo(this.cap);
    else if (this.cap < this.maxCap) this.resize(Math.min(this.maxCap, this.cap * 2));
    else if (this.tail > 0) this.moveTo(this.cap);
    else return false;
    return true;
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
      const typed = <T extends Uint8Array | Int32Array | Float64Array>(old: T, next: T): T => {
        next.set(old.subarray(from, to), at);
        return next;
      };
      const refs = (old: unknown[]): unknown[] => {
        const next = new Array<unknown>(cap).fill(null);
        for (let i = from; i < to; i++) next[i - from + at] = old[i];
        return next;
      };
      this.kind = typed(this.kind, new Uint8Array(cap));
      this.commit = typed(this.commit, new Int32Array(cap));
      this.t0 = typed(this.t0, new Float64Array(cap));
      this.t1 = typed(this.t1, new Float64Array(cap));
      this.t2 = typed(this.t2, new Float64Array(cap));
      this.n0 = typed(this.n0, new Int32Array(cap));
      this.r0 = refs(this.r0);
      this.r1 = refs(this.r1);
      this.r2 = refs(this.r2);
      this.r3 = refs(this.r3);
      this.r4 = refs(this.r4);
      this.r5 = refs(this.r5);
      this.r6 = refs(this.r6);
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
