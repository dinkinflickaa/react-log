import { hash53 } from '../../shim/src/ids.ts';

// Rollups at ingest (PLAN.md, Phase 3), one per page load: the chain linker
// (root_update_id), the commits rollup, and measures with their critical path
// and time breakdown. Rows arrive in page order. Each is held a few seconds
// so that facts arriving later can still stamp it: a commit's own row comes
// after its renders and effects, and an interaction's Event Timing entries
// come after the next paint. Then it goes to the writer.

export interface SegRow {
  session_id: string;
  page_load_id: number;
  ts: number | null;
  dur_us: number | null;
  self_us: number | null;
  kind: string;
  lane: string | null;
  component_id: string | null;
  commit_id: string | null;
  reason_code: string | null;
  changed_hooks: string | null;
  changed_context: string | null;
  changed_keys: string | null;
  committed: boolean | null;
  root_update_id: string | null;
  measure_instance_id: string | null;
  on_critical_path: boolean | null;
  call_site: string | null;
  extra: any;
}

export interface CommitRow {
  commit_id: string;
  session_id: string;
  ts: number | null;
  measure_instance_id: string | null;
  on_critical_path: boolean | null;
  signature: string;
  root_update_id: string;
  producer_component_id: string | null;
  producer_call_site: string | null;
  trigger_event: string | null;
  lane: string | null;
  total_ms: number;
  render_ms: number;
  layout_ms: number;
  passive_ms: number;
  passive_sync: boolean | null;
  strict_mode: boolean | null;
  cascade_commit_id: string | null;
  rendered: number;
  committed: number;
  noop: number;
  noop_ms: number;
  distinct_types: number;
  top_type: string | null;
  top_type_count: number;
  top1_component_id: string | null;
  top1_share: number | null;
  noop_share: number | null;
  effect_share: number | null;
  // Records of this commit the page had no room for: its numbers undercount.
  dropped_rows: number;
}

export interface MeasureRow {
  measure_instance_id: string;
  session_id: string;
  page_load_id: number;
  name: string;
  source: 'event_timing' | 'marks';
  interaction_id: number | null;
  target: string | null;
  ts_start: number;
  ts_end_marker: number | null;
  ts_end_paint: number | null;
  ts_end_idle: number | null;
  duration_ms: number;
  on_path_ms: number;
  interference_ms: number;
  waiting_ms: number;
}

export interface MarkPair {
  name: string;
  start: string;
  end: string;
}

export interface RollupOutput {
  seg: SegRow[];
  commits: CommitRow[];
  measures: MeasureRow[];
}

// Page time a row waits for late facts, or wall time when the page is quiet.
export const HOLD_US = 5_000_000;
export const HOLD_WALL_MS = 5_000;
// An interaction's Event Timing entries and the commit rows it produced have
// all arrived this long after its paint.
const MEASURE_WAIT_US = 2_000_000;
const MEASURE_WAIT_WALL_MS = 2_000;
// PLAN.md: a chain left open for 30 seconds expires.
const CHAIN_TTL_US = 30_000_000;
// Updates this close together render in one commit (one event's batch).
const BATCH_US = 100_000;
// A render-phase update lands just before the render ends; clocks round.
const SLACK_US = 1_000;
// Held rows beyond this are flushed unstamped rather than grow memory.
const MAX_HELD = 400_000;
// Finalized commits whose root a late cascade update can still look up. On
// 19.2+ an update row is written when the render it starts begins, after
// the commit whose effect enqueued it has finished.
const FINALIZED_KEPT = 4096;

const PRODUCER_REASONS = new Set(['hooks', 'state', 'force']);

interface Update {
  id: string;
  row: SegRow;
  ts: number;
  lane: string | null;
  // The commit whose layout or passive phase enqueued it (a cascade), and
  // that commit's aggregate while its own row has not arrived yet.
  parentId: string | null;
  parentAgg: CommitAgg | null;
  root: string | null;
}

interface CommitAgg {
  id: string;
  rows: SegRow[];
  commitRow: SegRow | null;
  finalized: boolean;
  lastSeen: number;
  root: string | null;
  producer: Update | null;
  cascades: Update[];
  renders: number;
  committed: number;
  noopSelfUs: number;
  effectUs: number;
  passiveEffectUs: number;
  firstRenderTs: number;
  lastRenderEnd: number;
  selfById: Map<string, number>;
  countByName: Map<string, number>;
  producerCandidates: SegRow[];
}

interface Measure {
  id: string;
  name: string;
  source: 'event_timing' | 'marks';
  interactionId: number | null;
  target: string | null;
  tsStart: number;
  tsEndMarker: number | null;
  tsEndPaint: number | null;
  entries: SegRow[];
  // An interaction's window: the union of its entries' windows (settled when
  // final). A mark pair's is [start, end].
  pieces: [number, number][] | null;
  lastPageTs: number;
  lastWall: number;
}

interface Held {
  row: SegRow;
  arrival: number;
  agg: CommitAgg | null;
}

interface HeldCommit {
  row: CommitRow;
  arrival: number;
  // Main-thread intervals of the commit phase and passive flush, for measures.
  spans: [number, number][];
  // The event the shim saw start this commit (not the chain's).
  trigger: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const laneOk = (a: string | null, b: string | null) => a === null || b === null || a === b;

// "fn (file:line:col)" to "fn@file": a fix that edits the file moves lines,
// and the signature must still match before and after.
export function siteKey(callSite: string | null): string | null {
  if (callSite === null) return null;
  const m = /^(.*?) \((.*):\d+:\d+\)$/.exec(callSite);
  return m === null ? callSite.replace(/:\d+:\d+$/, '') : `${m[1]}@${m[2]}`;
}

// Intervals merged where they overlap or touch, in order.
export function mergeIntervals(spans: [number, number][]): [number, number][] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Length of the union of intervals, clipped to [lo, hi].
export function unionLength(spans: [number, number][], lo: number, hi: number): number {
  const clipped = spans.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number]);
  return mergeIntervals(clipped).reduce((t, [a, b]) => t + (b - a), 0);
}

// Main-thread work a row stands for, as [start, end] µs intervals.
export function spansOf(row: SegRow): [number, number][] {
  const x = row.extra ?? {};
  switch (row.kind) {
    case 'render':
    case 'layout_effect':
    case 'passive_effect':
      return row.ts !== null && (row.dur_us ?? 0) > 0 ? [[row.ts, row.ts + row.dur_us!]] : [];
    case 'commit': {
      const out: [number, number][] = [];
      // A blocking render never yields, so its whole render phase is this
      // commit's main-thread work, React's own included. Other lanes can
      // yield mid-render; their component spans stand for the work.
      const rs = num(x.renderStart);
      const re = num(x.renderEnd);
      if ((row.lane === 'Blocking' || row.lane === 'Gesture') && rs !== null && re !== null && re > rs) out.push([rs, re]);
      const cs = num(x.commitStart) ?? row.ts;
      const ce = num(x.commitEnd) ?? (row.ts !== null && row.dur_us !== null ? row.ts + row.dur_us : null);
      if (cs !== null && ce !== null && ce > cs) out.push([cs, ce]);
      const ps = num(x.passiveStart);
      const pe = num(x.passiveEnd);
      if (ps !== null && pe !== null && pe > ps) out.push([ps, pe]);
      return out;
    }
    case 'event_timing': {
      const a = num(x.processingStart);
      const b = num(x.processingEnd);
      return a !== null && b !== null && b > a ? [[a, b]] : [];
    }
    case 'loaf':
      return Array.isArray(x.scripts)
        ? x.scripts
            .filter((s: any) => num(s.start) !== null && num(s.duration) !== null && s.duration > 0)
            .map((s: any) => [s.start, s.start + s.duration * 1000] as [number, number])
        : [];
    default:
      return [];
  }
}

export class PageRollup {
  readonly sessionId: string;
  readonly pageLoadId: number;
  private readonly names: Map<string, string>;
  private readonly marks: MarkPair[];
  private held: Held[] = [];
  private heldCommits: HeldCommit[] = [];
  private readonly aggs = new Map<string, CommitAgg>();
  private pending: Update[] = [];
  // The trigger event of each chain, by root update id (recent ones only).
  private readonly rootEvents = new Map<string, string | null>();
  private readonly finalizedRoots = new Map<string, string>();
  private readonly interactions = new Map<number, Measure>();
  private readonly openMarks = new Map<string, SegRow>();
  private openMeasures: Measure[] = [];
  private updateSeq = 0;
  private measureSeq = 0;
  private latest = 0;

  constructor(opts: { sessionId: string; pageLoadId: number; names: Map<string, string>; marks?: MarkPair[] }) {
    this.sessionId = opts.sessionId;
    this.pageLoadId = opts.pageLoadId;
    this.names = opts.names;
    this.marks = opts.marks ?? [];
  }

  get heldRows(): number {
    return this.held.length;
  }

  push(row: SegRow, now: number): void {
    if (row.ts !== null && row.ts > this.latest) this.latest = row.ts;
    let agg: CommitAgg | null = null;
    switch (row.kind) {
      case 'update_enqueued':
        this.onUpdate(row);
        break;
      case 'render':
      case 'layout_effect':
      case 'passive_effect':
        if (row.commit_id !== null) {
          agg = this.agg(row.commit_id);
          this.add(agg, row);
        }
        break;
      case 'commit':
        if (row.commit_id !== null) {
          const a = this.agg(row.commit_id);
          a.commitRow = row;
          this.finalize(a, now);
        }
        break;
      case 'event_timing':
        this.onEventTiming(row, now);
        break;
      case 'mark':
        this.onMark(row, now);
        break;
    }
    this.held.push({ row, arrival: now, agg });
  }

  // Rows, commit rollups and measures that are final. With all, everything.
  drain(now: number, all = false): RollupOutput {
    const out: RollupOutput = { seg: [], commits: [], measures: [] };
    this.expire(now, all);
    for (const m of [...this.openMeasures]) {
      const quiet = this.latest - (m.tsEndPaint ?? m.tsEndMarker ?? m.tsStart) > MEASURE_WAIT_US || now - m.lastWall > MEASURE_WAIT_WALL_MS;
      if (all || quiet) out.measures.push(this.finalizeMeasure(m));
    }
    // An open measure can still stamp rows that reach into its window, and an
    // open mark pair rows after its start.
    let guard = Infinity;
    for (const m of this.openMeasures) guard = Math.min(guard, m.tsStart);
    for (const r of this.openMarks.values()) if (r.ts !== null && this.latest - r.ts < CHAIN_TTL_US) guard = Math.min(guard, r.ts);
    const force = this.held.length > MAX_HELD ? this.held.length - MAX_HELD : 0;
    const ready = (ts: number | null, arrival: number, i: number) =>
      all ||
      i < force ||
      ((ts === null || ts < guard) && ((ts !== null && this.latest - ts > HOLD_US) || now - arrival > HOLD_WALL_MS));
    const keep: Held[] = [];
    this.held.forEach((h, i) => {
      const blocked = h.agg !== null && !h.agg.finalized;
      const end = h.row.ts === null ? null : h.row.ts + Math.max(0, h.row.dur_us ?? 0);
      if (ready(end, h.arrival, i) && (!blocked || all || i < force)) out.seg.push(h.row);
      else keep.push(h);
    });
    this.held = keep;
    const keepCommits: HeldCommit[] = [];
    for (const c of this.heldCommits) {
      const end = c.spans.reduce((e, [, b]) => Math.max(e, b), c.row.ts ?? 0);
      if (ready(end, c.arrival, Infinity)) out.commits.push(c.row);
      else keepCommits.push(c);
    }
    this.heldCommits = keepCommits;
    for (const [id, a] of this.aggs) if (a.finalized) this.aggs.delete(id);
    return out;
  }

  // ---- chain linker

  private agg(id: string): CommitAgg {
    let a = this.aggs.get(id);
    if (a === undefined) {
      a = {
        id,
        rows: [],
        commitRow: null,
        finalized: false,
        lastSeen: this.latest,
        root: null,
        producer: null,
        cascades: [],
        renders: 0,
        committed: 0,
        noopSelfUs: 0,
        effectUs: 0,
        passiveEffectUs: 0,
        firstRenderTs: Infinity,
        lastRenderEnd: -Infinity,
        selfById: new Map(),
        countByName: new Map(),
        producerCandidates: [],
      };
      this.aggs.set(id, a);
    }
    a.lastSeen = this.latest;
    return a;
  }

  private name(componentId: string | null): string | null {
    return componentId === null ? null : (this.names.get(componentId) ?? componentId);
  }

  private add(a: CommitAgg, row: SegRow): void {
    a.rows.push(row);
    if (a.finalized) {
      row.root_update_id = a.root;
      return;
    }
    if (row.kind === 'render') {
      a.renders++;
      const self = Math.max(0, row.self_us ?? 0);
      if (row.committed === true) a.committed++;
      else a.noopSelfUs += self;
      if (row.component_id !== null) a.selfById.set(row.component_id, (a.selfById.get(row.component_id) ?? 0) + self);
      const name = this.name(row.component_id) ?? '?';
      a.countByName.set(name, (a.countByName.get(name) ?? 0) + 1);
      if (row.ts !== null) {
        a.firstRenderTs = Math.min(a.firstRenderTs, row.ts);
        a.lastRenderEnd = Math.max(a.lastRenderEnd, row.ts + Math.max(0, row.dur_us ?? 0));
      }
      if (row.reason_code !== null && PRODUCER_REASONS.has(row.reason_code) && a.producerCandidates.length < 64) a.producerCandidates.push(row);
    } else {
      const d = Math.max(0, row.dur_us ?? 0);
      a.effectUs += d;
      if (row.kind === 'passive_effect') a.passiveEffectUs += d;
    }
  }

  private onUpdate(row: SegRow): void {
    const x = row.extra ?? {};
    const id = `${this.sessionId}.${this.pageLoadId}.u${++this.updateSeq}`;
    const cascade = x.phase === 'layout' || x.phase === 'passive' || x.label === 'Cascading Update';
    const parentId = cascade && typeof x.during === 'string' ? x.during : null;
    const u: Update = { id, row, ts: row.ts ?? this.latest, lane: row.lane, parentId, parentAgg: null, root: null };
    if (parentId === null) {
      u.root = id;
      this.rootEvents.set(id, typeof x.event === 'string' ? x.event : null);
      if (this.rootEvents.size > FINALIZED_KEPT) this.rootEvents.delete(this.rootEvents.keys().next().value!);
    } else if (this.finalizedRoots.has(parentId)) {
      u.root = this.finalizedRoots.get(parentId)!;
    } else {
      const parent = this.agg(parentId);
      if (parent.finalized) {
        u.root = parent.root;
      } else {
        u.parentAgg = parent;
        parent.cascades.push(u);
      }
    }
    row.root_update_id = u.root;
    this.pending.push(u);
  }

  private finalize(a: CommitAgg, now: number): void {
    const c = a.commitRow!;
    const x = c.extra ?? {};
    const renderStart = num(x.renderStart) ?? (Number.isFinite(a.firstRenderTs) ? a.firstRenderTs : c.ts);
    const renderEnd = num(x.renderEnd) ?? (Number.isFinite(a.lastRenderEnd) ? a.lastRenderEnd : renderStart);
    // The updates that produced this commit: the latest batch in its lane,
    // enqueued before its render ended. Older ones in the same lane never
    // rendered (React bailed out on them), and their chains end here.
    const candidates = this.pending.filter(
      (u) => u.parentAgg !== a && (u.parentAgg === null || u.parentAgg.finalized) && renderEnd !== null && u.ts <= renderEnd + SLACK_US && laneOk(u.lane, c.lane),
    );
    let batch: Update[] = [];
    if (candidates.length > 0) {
      const newest = Math.max(...candidates.map((u) => u.ts));
      batch = candidates.filter((u) => u.ts >= newest - BATCH_US);
      // An update enqueued by input is why this commit happened now; a
      // pending timer update that React rendered with it rode along.
      a.producer = batch.find((u) => typeof u.row.extra?.event === 'string') ?? batch[0] ?? null;
      const gone = new Set(candidates);
      this.pending = this.pending.filter((u) => !gone.has(u));
    }
    a.root = a.producer?.root ?? a.id;
    // The rest of the batch rendered in this commit too (a handler that sets
    // two states): updates that started chains of their own join this one.
    for (const u of batch) {
      if (u !== a.producer && u.root === u.id) {
        u.root = a.root;
        u.row.root_update_id = a.root;
      }
    }
    for (const r of a.rows) r.root_update_id = a.root;
    c.root_update_id = a.root;
    for (const u of a.cascades) {
      u.root = a.root;
      u.row.root_update_id = a.root;
    }
    a.finalized = true;
    this.finalizedRoots.set(a.id, a.root);
    if (this.finalizedRoots.size > FINALIZED_KEPT) this.finalizedRoots.delete(this.finalizedRoots.keys().next().value!);
    const row = this.rollup(a, renderStart, renderEnd);
    this.heldCommits.push({ row, arrival: now, spans: spansOf(c), trigger: typeof x.trigger === 'string' ? x.trigger : null });
    a.rows = [];
    a.producerCandidates = [];
  }

  private expire(now: number, all: boolean): void {
    const cutoff = this.latest - CHAIN_TTL_US;
    this.pending = all ? [] : this.pending.filter((u) => u.ts >= cutoff);
    // A commit whose own row never came: stop holding its rows.
    for (const a of this.aggs.values()) {
      if (!a.finalized && (all || a.lastSeen < cutoff)) {
        a.finalized = true;
        a.root ??= a.id;
        for (const r of a.rows) r.root_update_id ??= a.root;
        for (const u of a.cascades) {
          u.root ??= a.root;
          u.row.root_update_id ??= a.root;
        }
      }
    }
    void now;
  }

  private rollup(a: CommitAgg, renderStart: number | null, renderEnd: number | null): CommitRow {
    const c = a.commitRow!;
    const x = c.extra ?? {};
    const cs = num(x.commitStart);
    const ce = num(x.commitEnd);
    const ps = num(x.passiveStart);
    const pe = num(x.passiveEnd);
    const renderMs = renderStart !== null && renderEnd !== null ? Math.max(0, renderEnd - renderStart) / 1000 : 0;
    const layoutMs = cs !== null && ce !== null ? Math.max(0, ce - cs) / 1000 : Math.max(0, c.dur_us ?? 0) / 1000;
    const passiveMs = ps !== null && pe !== null ? Math.max(0, pe - ps) / 1000 : a.passiveEffectUs / 1000;
    const totalMs = renderMs + layoutMs + passiveMs;
    let top1: string | null = null;
    let top1Us = 0;
    for (const [id, us] of a.selfById) {
      if (us > top1Us) {
        top1 = id;
        top1Us = us;
      }
    }
    let topType: string | null = null;
    let topCount = 0;
    for (const [n, k] of a.countByName) {
      if (k > topCount) {
        topType = n;
        topCount = k;
      }
    }
    const share = (us: number) => (totalMs > 0 ? Math.min(1, us / 1000 / totalMs) : null);
    const p = a.producer;
    const px = p?.row.extra ?? {};
    let producerId = p?.row.component_id ?? null;
    let producerName: string | null = producerId !== null ? this.name(producerId) : typeof px.component === 'string' ? px.component : null;
    if (producerId === null && producerName !== null) {
      const hit = a.producerCandidates.find((r) => this.name(r.component_id) === producerName);
      producerId = hit?.component_id ?? null;
    }
    if (p === null && a.producerCandidates.length > 0) {
      // No update row (a store change on 18.0 to 19.1, a Suspense retry):
      // the first component that rendered for its own state.
      producerId = a.producerCandidates[0]!.component_id;
      producerName = this.name(producerId);
    }
    const rootEvent = a.root !== null ? this.rootEvents.get(a.root) : undefined;
    const trigger = rootEvent ?? (typeof x.trigger === 'string' ? x.trigger : null);
    const callSite = p?.row.call_site ?? null;
    // What caused the commit, not what it cost, and nothing a fix moves:
    // the trigger, the producer, its call site without line numbers, the
    // lane, and the phase that enqueued the update (a layout or passive
    // effect's cascade, or neither).
    const phase = typeof px.phase === 'string' ? px.phase : '';
    const signature = `sig_${hash53([trigger ?? '', producerName ?? '', siteKey(callSite) ?? '', c.lane ?? '', phase].join('|')).slice(0, 10)}`;
    return {
      commit_id: a.id,
      session_id: this.sessionId,
      ts: renderStart,
      measure_instance_id: null,
      on_critical_path: null,
      signature,
      root_update_id: a.root!,
      producer_component_id: producerId,
      producer_call_site: callSite,
      trigger_event: trigger,
      lane: c.lane,
      total_ms: totalMs,
      render_ms: renderMs,
      layout_ms: layoutMs,
      passive_ms: passiveMs,
      passive_sync: typeof x.passiveSync === 'boolean' ? x.passiveSync : null,
      strict_mode: typeof x.strict === 'boolean' ? x.strict : null,
      cascade_commit_id: p?.parentId ?? null,
      rendered: a.renders,
      committed: a.committed,
      noop: a.renders - a.committed,
      noop_ms: a.noopSelfUs / 1000,
      distinct_types: a.countByName.size,
      top_type: topType,
      top_type_count: topCount,
      top1_component_id: top1,
      top1_share: share(top1Us),
      noop_share: share(a.noopSelfUs),
      effect_share: share(a.effectUs),
      dropped_rows: typeof x.dropped === 'number' ? x.dropped : 0,
    };
  }

  // ---- measures

  private newMeasure(source: 'event_timing' | 'marks', name: string, tsStart: number, now: number): Measure {
    const m: Measure = {
      id: `${this.sessionId}.${this.pageLoadId}.m${++this.measureSeq}`,
      name,
      source,
      interactionId: null,
      target: null,
      tsStart,
      tsEndMarker: null,
      tsEndPaint: null,
      entries: [],
      pieces: null,
      lastPageTs: this.latest,
      lastWall: now,
    };
    this.openMeasures.push(m);
    return m;
  }

  // Entries of one interaction (pointerdown, pointerup, click; keydown,
  // keyup) arrive in any order. Until the measure is final, tsStart and the
  // end fields bound them all, which is what the hold needs.
  private onEventTiming(row: SegRow, now: number): void {
    const x = row.extra ?? {};
    const iid = num(x.interactionId);
    if (iid === null || iid <= 0 || row.ts === null) return;
    let m = this.interactions.get(iid);
    if (m === undefined) {
      m = this.newMeasure('event_timing', String(x.name ?? 'interaction'), row.ts, now);
      m.interactionId = iid;
      this.interactions.set(iid, m);
    }
    m.entries.push(row);
    m.tsStart = Math.min(m.tsStart, row.ts);
    const paint = row.ts + Math.max(0, row.dur_us ?? 0);
    m.tsEndPaint = Math.max(m.tsEndPaint ?? paint, paint);
    const pe = num(x.processingEnd);
    if (pe !== null) m.tsEndMarker = Math.max(m.tsEndMarker ?? pe, pe);
    m.lastPageTs = this.latest;
    m.lastWall = now;
  }

  // The page answers an interaction once per input slow enough to get an
  // entry: from that input to the paint after its handlers (never before
  // they end; Event Timing rounds durations to 8 ms). The measure's window is
  // the union of those, so a mouse button or key held down between inputs,
  // which is the person and not the page, is not part of it, while a slow
  // pointerdown and a slow click both are. It is named for what the person
  // did: click when there is one, else the longest entry.
  private settleInteraction(m: Measure): void {
    m.pieces = mergeIntervals(
      m.entries.map((e) => {
        const a = e.ts!;
        return [a, Math.max(a + Math.max(0, e.dur_us ?? 0), num(e.extra?.processingEnd) ?? a)] as [number, number];
      }),
    );
    const longest = m.entries.reduce((a, b) => ((b.dur_us ?? 0) > (a.dur_us ?? 0) ? b : a));
    const named = m.entries.find((e) => e.extra?.name === 'click') ?? longest;
    m.name = String(named.extra?.name ?? m.name);
    m.target = named.extra?.target ?? m.entries.find((e) => e.extra?.target)?.extra?.target ?? null;
  }

  private onMark(row: SegRow, now: number): void {
    const name = row.extra?.name;
    if (typeof name !== 'string' || row.ts === null) return;
    for (const pair of this.marks) {
      if (name === pair.start) {
        this.openMarks.set(pair.name, row);
      } else if (name === pair.end) {
        const start = this.openMarks.get(pair.name);
        if (start === undefined || start.ts === null) continue;
        this.openMarks.delete(pair.name);
        const m = this.newMeasure('marks', pair.name, start.ts, now);
        m.tsEndMarker = row.ts;
        m.entries.push(start, row);
      }
    }
  }

  // Stamp measure_instance_id and on_critical_path on the rows and commits in
  // the measure's window, and split its duration into on-path work,
  // interference and waiting, each a union of intervals.
  private finalizeMeasure(m: Measure): MeasureRow {
    this.openMeasures = this.openMeasures.filter((x) => x !== m);
    if (m.interactionId !== null) {
      this.interactions.delete(m.interactionId);
      this.settleInteraction(m);
    }
    const start = m.tsStart;
    // Event Timing rounds a duration to the nearest 8 ms, so startTime +
    // duration can land before processingEnd; the paint is never earlier.
    const end = Math.max(m.tsEndPaint ?? start, m.tsEndMarker ?? start);
    const pieces = m.pieces ?? [[start, end]];
    const inWindow = (a: number, b: number) => pieces.some(([lo, hi]) => a < hi && b > lo);
    const triggerEnd = (m.tsEndMarker ?? end) + SLACK_US;
    // The chains the measure caused. An interaction's are the ones an input
    // event started before the paint: updates enqueued while it was
    // dispatched, and commits the shim saw it start. That leaves out a timer
    // that fires between the input and its handlers, and keeps an event that
    // took under 16 ms (so no entry of its own, like a click after a slow
    // pointerdown). A commit counts even when its chain's first update came
    // from elsewhere: on 19.2+ a timer update that was pending when the
    // handler ran is the batch's only update row. A mark pair's are the
    // updates enqueued between its two marks, and commits with no update row
    // that started there.
    const interaction = m.source === 'event_timing';
    const caused = (ts: number | null, event: unknown) =>
      ts !== null && ts >= start && (interaction ? ts < end && typeof event === 'string' : ts <= triggerEnd);
    const roots = new Set<string>();
    for (const h of this.held) {
      const r = h.row;
      if (r.root_update_id === null) continue;
      if (r.kind === 'update_enqueued' ? caused(r.ts, r.extra?.event) : r.kind === 'commit' && (interaction || r.root_update_id === r.commit_id) && caused(r.ts, r.extra?.trigger)) {
        roots.add(r.root_update_id);
      }
    }
    for (const c of this.heldCommits) {
      if ((interaction || c.row.root_update_id === c.row.commit_id) && caused(c.row.ts, c.trigger)) roots.add(c.row.root_update_id);
    }
    const own = new Set(m.entries);
    const onSpans: [number, number][] = [];
    const otherSpans: [number, number][] = [];
    let idle = end;
    for (const h of this.held) {
      const r = h.row;
      if (r.ts === null) continue;
      const spans = spansOf(r);
      const rEnd = spans.reduce((e, [, b]) => Math.max(e, b), r.ts + Math.max(0, r.dur_us ?? 0));
      const chain = r.root_update_id !== null && roots.has(r.root_update_id);
      // The chain goes idle when its last work ends, after the paint too.
      if (chain) idle = Math.max(idle, rEnd);
      if (own.has(r) || (chain && r.ts < end)) {
        if (r.on_critical_path !== true) {
          r.measure_instance_id = m.id;
          r.on_critical_path = true;
        }
        onSpans.push(...spans);
      } else if (inWindow(r.ts, rEnd)) {
        if (r.measure_instance_id === null) {
          r.measure_instance_id = m.id;
          r.on_critical_path = false;
        }
        otherSpans.push(...spans);
      }
    }
    for (const c of this.heldCommits) {
      const ts = c.row.ts;
      if (ts === null) continue;
      const cEnd = c.spans.reduce((e, [, b]) => Math.max(e, b), ts);
      const chain = roots.has(c.row.root_update_id);
      if (chain) idle = Math.max(idle, cEnd);
      if (chain && ts < end) {
        if (c.row.on_critical_path !== true) {
          c.row.measure_instance_id = m.id;
          c.row.on_critical_path = true;
        }
        onSpans.push(...c.spans);
      } else if (inWindow(ts, cEnd)) {
        if (c.row.measure_instance_id === null) {
          c.row.measure_instance_id = m.id;
          c.row.on_critical_path = false;
        }
        otherSpans.push(...c.spans);
      }
    }
    const within = (spans: [number, number][]) => pieces.reduce((t, [lo, hi]) => t + unionLength(spans, lo, hi), 0);
    const duration = pieces.reduce((t, [lo, hi]) => t + (hi - lo), 0);
    const on = within(onSpans);
    const all = within([...onSpans, ...otherSpans]);
    return {
      measure_instance_id: m.id,
      session_id: this.sessionId,
      page_load_id: this.pageLoadId,
      name: m.name,
      source: m.source,
      interaction_id: m.interactionId,
      target: m.target,
      ts_start: start,
      ts_end_marker: m.tsEndMarker,
      ts_end_paint: m.tsEndPaint,
      ts_end_idle: idle,
      duration_ms: duration / 1000,
      on_path_ms: on / 1000,
      interference_ms: (all - on) / 1000,
      waiting_ms: (duration - all) / 1000,
    };
  }
}
