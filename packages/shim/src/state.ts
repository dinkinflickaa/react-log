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
}

export const DEFAULT_CONFIG: Config = {
  ringSize: 50_000,
  flushIntervalMs: 250,
  sliceMs: 4,
  stacksPerBatch: 8,
  watch: [],
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
  maxTaskMs: number;
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
  pendingTasks: { method: string; t: number; transition: boolean; event: string | null; stack: Error | null }[];
  pendingTrigger: string | null;
  pendingTriggerAt: number;
  devtoolsMeasures: Set<string>;
  // Idle pipeline state.
  idByFiber: WeakMap<object, string>;
  idByPath: Map<string, string>;
  stackOwner: WeakMap<object, string>;
  defs: unknown[][];
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
    stats: { commits: 0, walkMs: 0, maxWalkMs: 0, maxTaskMs: 0, batches: 0, rows: 0 },
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
    devtoolsMeasures: new Set(),
    idByFiber: new WeakMap(),
    idByPath: new Map(),
    stackOwner: new WeakMap(),
    defs: [],
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
    trigger: s.pendingTrigger !== null && now() - s.pendingTriggerAt < 1000 ? s.pendingTrigger : null,
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

export function now(): number {
  return performance.now();
}
