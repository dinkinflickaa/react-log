import type { Line } from './constants.ts';
import { Ring } from './ring.ts';

// React internals are untyped on purpose: the shim reads fields that differ
// between versions and must never assume a shape it has not checked.
export type Fiber = any;

export interface Config {
  ringSize: number;
  flushIntervalMs: number;
  sliceMs: number;
  stacksPerBatch: number;
  watch: string[];
  // Entry types to record: event, mark and long-animation-frame through a
  // PerformanceObserver, measure through the performance.measure wrapper.
  observe: string[];
}

export const DEFAULT_CONFIG: Config = {
  ringSize: 50_000,
  flushIntervalMs: 250,
  sliceMs: 4,
  stacksPerBatch: 8,
  watch: [],
  observe: ['event', 'mark', 'measure', 'long-animation-frame'],
};

export interface Renderer {
  id: number;
  version: string;
  line: Line;
  internals: any;
  laneLabels: Map<number, string> | null;
}

// One React commit. Times are performance.now() ms; NaN means unknown.
export interface Commit {
  id: number;
  renderer: number;
  lanes: number;
  laneClass: number;
  root: number;
  priority: number | null;
  didError: boolean;
  strict: boolean;
  trigger: string | null;
  renderStart: number;
  renderEnd: number;
  commitStart: number;
  commitEnd: number;
  layoutStart: number;
  layoutEnd: number;
  passiveStart: number;
  passiveEnd: number;
  passivePending: boolean;
  probeFired: boolean;
  passiveSync: boolean | null;
  firstRenderStart: number;
  rendered: number;
  bailouts: number;
  walkMs: number;
  walked: boolean;
  finalized: boolean;
  // 19.2+: fibers with effect flags, in post-order, to match effect spans by name.
  effectFibers: Fiber[] | null;
  effectCursors: { layout: Map<string, number>; passive: Map<string, number> } | null;
}

export interface Stats {
  commits: number;
  walkMs: number;
  maxWalkMs: number;
  // Longest shim task: an idle slice or an observer callback.
  maxTaskMs: number;
  maxIdleMs: number;
  maxObserverMs: number;
  maxSinkMs: number;
  maxBatchBytes: number;
  batches: number;
  rows: number;
}

export interface Shim {
  g: any;
  config: Config;
  ring: Ring;
  stats: Stats;
  renderers: Map<number, Renderer>;
  // The renderer the 19.2+ Performance Track adapter reads (single renderer).
  tracksRenderer: Renderer | null;
  commitSeq: number;
  commits: Map<number, Commit>;
  open: Commit | null;
  started: Commit[];
  lastCommitted: Commit | null;
  pendingPassive: Commit | null;
  phase: 'idle' | 'render' | 'commit' | 'passive';
  updatesSinceCommit: number;
  forced: Set<Fiber>;
  // Effect spans recorded before their commit was known (19.2+).
  unassignedSpans: number[];
  // Update captures from console.createTask waiting for React's "Update" measure (19.2+).
  // `during`: the commit in progress when the update was enqueued, 0 if none.
  pendingTasks: { method: string; t: number; transition: boolean; event: string | null; stack: Error | null; during: number }[];
  pendingTrigger: string | null;
  pendingTriggerAt: number;
  // Idle pipeline state.
  idByFiber: WeakMap<object, string>;
  idByPath: Map<string, string>;
  stackOwner: WeakMap<object, string>;
  defs: unknown[][];
  defBytes: number;
  outbox: string[];
  watch: Set<string>;
  errors: Set<string>;
  idleScheduled: boolean;
  seq: number;
  lastDropped: number;
  // Walk scratch space.
  acc: Uint8Array;
  slots: Int32Array;
}

export function createShim(g: any, config: Config): Shim {
  return {
    g,
    config,
    ring: new Ring(config.ringSize),
    stats: { commits: 0, walkMs: 0, maxWalkMs: 0, maxTaskMs: 0, maxIdleMs: 0, maxObserverMs: 0, maxSinkMs: 0, maxBatchBytes: 0, batches: 0, rows: 0 },
    renderers: new Map(),
    tracksRenderer: null,
    commitSeq: 0,
    commits: new Map(),
    open: null,
    started: [],
    lastCommitted: null,
    pendingPassive: null,
    phase: 'idle',
    updatesSinceCommit: 0,
    forced: new Set(),
    unassignedSpans: [],
    pendingTasks: [],
    pendingTrigger: null,
    pendingTriggerAt: 0,
    idByFiber: new WeakMap(),
    idByPath: new Map(),
    stackOwner: new WeakMap(),
    defs: [],
    defBytes: 0,
    outbox: [],
    watch: new Set(config.watch),
    errors: new Set(),
    idleScheduled: false,
    seq: 0,
    lastDropped: 0,
    acc: new Uint8Array(4096),
    slots: new Int32Array(4096),
  };
}

export function newCommit(s: Shim, renderer: number): Commit {
  const c: Commit = {
    id: ++s.commitSeq,
    renderer,
    lanes: 0,
    laneClass: 0,
    root: 0,
    priority: null,
    didError: false,
    strict: false,
    // The event whose update started this render, else the event being
    // dispatched (an external store change calls no update hook on 18.0 to
    // 19.1, and React commits a discrete event's render before it returns).
    trigger: s.pendingTrigger !== null && now() - s.pendingTriggerAt < 1000 ? s.pendingTrigger : currentEvent(s.g),
    renderStart: NaN,
    renderEnd: NaN,
    commitStart: NaN,
    commitEnd: NaN,
    layoutStart: NaN,
    layoutEnd: NaN,
    passiveStart: NaN,
    passiveEnd: NaN,
    passivePending: false,
    probeFired: false,
    passiveSync: null,
    firstRenderStart: Infinity,
    rendered: 0,
    bailouts: 0,
    walkMs: 0,
    walked: false,
    finalized: false,
    effectFibers: null,
    effectCursors: null,
  };
  s.pendingTrigger = null;
  s.commits.set(c.id, c);
  s.updatesSinceCommit = 0;
  return c;
}

// The trusted event being dispatched right now, if any. React's scheduler
// runs its tasks from a MessageChannel, which is no one's input.
export function currentEvent(g: any): string | null {
  const e = g.event;
  if (e == null || e.isTrusted !== true || typeof e.type !== 'string') return null;
  if (e.type === 'message' && typeof g.MessagePort === 'function' && e.target instanceof g.MessagePort) return null;
  return e.type;
}

export function now(): number {
  return performance.now();
}
