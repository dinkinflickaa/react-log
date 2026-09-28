// Fixed-size FIFO of raw records, written inside React's commit and read in
// idle time. Numbers live in typed arrays; object references (fibers, props,
// hook lists) in preallocated arrays, so writing a record allocates nothing.
// When full, the incoming record is dropped and counted.

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

export class Ring {
  readonly cap: number;
  readonly kind: Uint8Array;
  readonly commit: Int32Array;
  readonly t0: Float64Array;
  readonly t1: Float64Array;
  readonly t2: Float64Array;
  readonly n0: Int32Array;
  readonly r0: unknown[];
  readonly r1: unknown[];
  readonly r2: unknown[];
  readonly r3: unknown[];
  readonly r4: unknown[];
  readonly r5: unknown[];
  readonly r6: unknown[];
  head = 0;
  tail = 0;
  count = 0;
  dropped = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.kind = new Uint8Array(cap);
    this.commit = new Int32Array(cap);
    this.t0 = new Float64Array(cap);
    this.t1 = new Float64Array(cap);
    this.t2 = new Float64Array(cap);
    this.n0 = new Int32Array(cap);
    this.r0 = new Array(cap).fill(null);
    this.r1 = new Array(cap).fill(null);
    this.r2 = new Array(cap).fill(null);
    this.r3 = new Array(cap).fill(null);
    this.r4 = new Array(cap).fill(null);
    this.r5 = new Array(cap).fill(null);
    this.r6 = new Array(cap).fill(null);
  }

  // Returns the slot to fill, or -1 when full.
  alloc(kind: number): number {
    if (this.count === this.cap) {
      this.dropped++;
      return -1;
    }
    const i = this.head;
    this.head = i + 1 === this.cap ? 0 : i + 1;
    this.count++;
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
    this.tail = i + 1 === this.cap ? 0 : i + 1;
    this.count--;
  }
}
