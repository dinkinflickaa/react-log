import { EFFECT_UNMOUNT, emitUpdateSpan, report, SPAN_PASSIVE } from './adapters.ts';
import { LANE_CLASSES, laneClassIndex } from './constants.ts';
import { componentId, displayName } from './ids.ts';
import {
  K_COMMIT,
  K_EFFECT_SPAN,
  K_ENTRY,
  K_LAYOUT_EFFECT,
  K_PASSIVE_EFFECT,
  K_RENDER,
  K_SUSPEND,
  K_UPDATE,
  K_WATCH,
  K_YIELD,
} from './ring.ts';
import { type Commit, type EffectIndex, type EffectPasses, type Fiber, now, type Shim } from './state.ts';
import { R_COMMITTED, R_FORCED, R_MOUNT, R_STRICT } from './walk.ts';
import { classifyKeys, whyRendered } from './why.ts';

// Wire format, one JSON message per sink call:
//   {t:"hello"|"renderer"|"refused"|"error", ...}
//   {t:"batch", seq, dropped, peak, defs, rows}
// defs: [component_id, display_name, source_file, source_line, source_column, owner_path, memo]
// rows: [kind, ts, dur_us, self_us, lane, component_id, commit, reason_code,
//        changed_hooks, changed_context, changed_keys, committed, call_site, extra]
// ts is performance.now() ms on the page's clock; hello carries timeOrigin.

export function post(s: Shim, message: object): void {
  s.outbox.push(JSON.stringify(message));
  scheduleIdle(s);
}

// Rows waiting beyond which the page's idle time is not enough: a busy page
// (a load, an animation) runs idle callbacks only on their timeout.
const BACKLOG = 2000;

export function scheduleIdle(s: Shim): void {
  if (s.idleScheduled) return;
  s.idleScheduled = true;
  const ric = s.g.requestIdleCallback;
  // With a backlog, a slice at least every 100 ms: at most 4% of a busy
  // main thread.
  const timeout = s.ring.count > BACKLOG ? 100 : 1000;
  if (typeof ric === 'function') ric.call(s.g, (d: IdleDeadline) => runIdle(s, d), { timeout });
  else setTimeout(() => runIdle(s, null), 1);
}

// With a backlog on an idle page, a slice takes up to a frame's worth of the
// idle period: Chrome runs one idle callback per period of up to 50 ms.
const BACKLOG_SLICE_MS = 16;

function runIdle(s: Shim, deadline: IdleDeadline | null): void {
  s.idleScheduled = false;
  const t0 = now();
  const scheduling = s.g.navigator?.scheduling;
  // Scrolls and drags too, not only clicks and keys.
  const inputPending = typeof scheduling?.isInputPending === 'function' ? () => scheduling.isInputPending({ includeContinuous: true }) === true : () => false;
  let until: number;
  if (deadline !== null && !deadline.didTimeout && s.ring.count > BACKLOG) {
    // Until 2 ms before the idle period ends, and no longer than a frame;
    // input stops it after the current payload.
    until = t0 + Math.max(1, Math.min(BACKLOG_SLICE_MS, deadline.timeRemaining() - 2));
  } else {
    // Fired on its timeout the callback has no idle time left, which is how a
    // busy or background page runs it (background tabs about once a second):
    // take the full slice then, or a hidden tab could not keep up.
    let budget = s.config.sliceMs;
    if (deadline !== null && !deadline.didTimeout) budget = Math.min(budget, Math.max(1, deadline.timeRemaining()));
    // Payloads until 60% of the budget is spent. The rest is headroom for the
    // last payload's sink call (about 0.35 ms for 24 KB) and for a GC or a
    // preemption that lands in the slice.
    until = t0 + budget * 0.6;
  }
  try {
    do drain(s, until);
    while (s.ring.count > 0 && now() < until && typeof s.g.__reactLogSink === 'function' && !inputPending());
    s.ring.settle();
  } catch (e) {
    report(s, e);
  }
  const dt = now() - t0;
  if (dt > s.stats.maxIdleMs) s.stats.maxIdleMs = dt;
  if (dt > s.stats.maxTaskMs) s.stats.maxTaskMs = dt;
  if (s.ring.count > 0 || s.outbox.length > 0) scheduleIdle(s);
}

// Everything, now, ignoring the slice budget: tests and pagehide. Each
// drain sends one payload of about 24 KB, so loop until the ring is empty.
export function flushNow(s: Shim): void {
  if (typeof s.g.__reactLogSink !== 'function') return;
  do {
    try {
      drain(s, Infinity);
    } catch (e) {
      report(s, e);
    }
  } while (s.ring.count > 0);
  drain(s, Infinity);
  s.ring.settle();
}

function drain(s: Shim, until: number): void {
  const sink = s.g.__reactLogSink;
  if (typeof sink !== 'function') return;
  while (s.outbox.length > 0) sink(s.outbox.shift());
  expireTasks(s);
  const ring = s.ring;
  const rows: string[] = [];
  let bytes = 0;
  while (ring.count > 0) {
    const i = ring.peek();
    // Formatting a stack can take a millisecond or more, so a slice formats
    // at most one, as its first row.
    if (rows.length > 0 && ring.kind[i] === K_UPDATE && ring.r2[i] != null) break;
    let row: unknown[] | null = null;
    try {
      row = serialize(s, i);
    } catch (e) {
      report(s, e);
    }
    ring.release(i);
    if (row !== null) {
      const json = JSON.stringify(row);
      rows.push(json);
      bytes += json.length;
    }
    // A row can cost a stack format, so check the clock after every one.
    // The CDP binding costs about 15 µs per KB, so payloads stay near 24 KB.
    if (now() > until || bytes + s.defBytes > 24_000) break;
  }
  const dropped = ring.dropped - s.lastDropped;
  if (rows.length === 0 && s.defs.length === 0 && dropped === 0) {
    while (s.outbox.length > 0) sink(s.outbox.shift());
    return;
  }
  // peak: the most records the page held at once, a measure of how far
  // capture fell behind.
  const message = `{"t":"batch","seq":${s.seq++},"dropped":${dropped},"peak":${ring.peak},"defs":${JSON.stringify(s.defs)},"rows":[${rows.join(',')}]}`;
  s.lastDropped = ring.dropped;
  s.defs = [];
  s.defBytes = 0;
  s.stats.batches++;
  s.stats.rows += rows.length;
  if (message.length > s.stats.maxBatchBytes) s.stats.maxBatchBytes = message.length;
  const t = now();
  sink(message);
  const sinkMs = now() - t;
  if (sinkMs > s.stats.maxSinkMs) s.stats.maxSinkMs = sinkMs;
  while (s.outbox.length > 0) sink(s.outbox.shift());
}

// 19.2+: a createTask capture that no "Update" measure claimed within two
// seconds still becomes an update row, without component name or lane.
function expireTasks(s: Shim): void {
  const tasks = s.pendingTasks;
  const cutoff = now() - 2000;
  while (tasks.length > 0 && tasks[0]!.t < cutoff) {
    const task = tasks.shift()!;
    emitUpdateSpan(s, task, task.t, laneClassIndex(task.transition ? 'Transition' : 'Blocking'), null, null, null);
  }
}

const r3 = (x: number): number | null => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const us = (x: number): number | null => (Number.isFinite(x) ? Math.round(x * 1000) : null);
const laneName = (i: number): string | null => (i > 0 ? LANE_CLASSES[i]! : null);

function serialize(s: Shim, i: number): unknown[] | null {
  const ring = s.ring;
  const kind = ring.kind[i]!;
  const commitId = ring.commit[i]!;
  switch (kind) {
    case K_RENDER:
      return renderRow(s, i, commitId);
    case K_COMMIT: {
      const c = ring.r0[i] as Commit;
      s.commits.delete(c.id);
      return commitRow(c);
    }
    case K_LAYOUT_EFFECT:
    case K_PASSIVE_EFFECT: {
      const fiber = ring.r0[i] as Fiber;
      return [
        kind === K_LAYOUT_EFFECT ? 'layout_effect' : 'passive_effect',
        r3(ring.t0[i]!),
        us(ring.t1[i]!),
        null,
        null,
        componentId(s, fiber),
        commitId || null,
        null,
        null,
        null,
        null,
        null,
        null,
        { phase: (ring.n0[i]! & EFFECT_UNMOUNT) !== 0 ? 'unmount' : 'mount' },
      ];
    }
    case K_EFFECT_SPAN:
      return effectSpanRow(s, i, commitId);
    case K_UPDATE:
      return updateRow(s, i);
    case K_YIELD:
      return ['yield', r3(ring.t0[i]!), null, null, null, null, null, null, null, null, null, null, null, null];
    case K_SUSPEND: {
      const fiber = ring.r0[i] as Fiber;
      return ['suspend', r3(ring.t0[i]!), null, null, null, fiber == null ? null : componentId(s, fiber), null, null, null, null, null, null, null, null];
    }
    case K_ENTRY:
      return entryRow(ring.r0[i] as PerformanceEntry);
    case K_WATCH:
      return ['watch', r3(ring.t0[i]!), null, null, null, null, null, null, null, null, null, null, null, { names: ring.r0[i] }];
    default:
      return null;
  }
}

function renderRow(s: Shim, i: number, commitId: number): unknown[] {
  const ring = s.ring;
  const fiber = ring.r0[i] as Fiber;
  const bits = ring.n0[i]!;
  const c = s.commits.get(commitId);
  const r = s.renderers.get(c?.renderer ?? -1) ?? s.renderers.values().next().value!;
  const mount = (bits & R_MOUNT) !== 0;
  const retry = !mount && c !== undefined && LANE_CLASSES[c.laneClass] === 'Suspense';
  const why = whyRendered(
    fiber,
    r.line,
    mount,
    (bits & R_FORCED) !== 0,
    retry,
    ring.r1[i],
    ring.r2[i],
    ring.r3[i],
    ring.r4[i],
    ring.r5[i],
    ring.r6[i],
  );
  const id = componentId(s, fiber);
  let keys: string | null = null;
  if (why.keys !== null && why.keys.length > 0 && s.watch.size > 0) {
    const name = displayName(fiber);
    if (s.watch.has(name) || s.watch.has(id)) keys = classifyKeys(why.keys, ring.r1[i], ring.r2[i]);
  }
  return [
    'render',
    r3(ring.t0[i]!),
    us(ring.t1[i]!),
    us(Math.max(0, ring.t2[i]!)),
    c === undefined ? null : laneName(c.laneClass),
    id,
    commitId,
    why.reason,
    why.hooks,
    why.context,
    keys,
    (bits & R_COMMITTED) !== 0,
    null,
    (bits & R_STRICT) !== 0 ? { strict: true } : null,
  ];
}

function commitRow(c: Commit): unknown[] {
  const start = Number.isFinite(c.commitStart) ? c.commitStart : c.layoutStart;
  return [
    'commit',
    r3(start),
    us(c.commitEnd - start),
    null,
    laneName(c.laneClass),
    null,
    c.id,
    null,
    null,
    null,
    null,
    null,
    null,
    {
      root: c.root,
      priority: c.priority,
      didError: c.didError,
      strict: c.strict,
      trigger: c.trigger,
      renderStart: r3(Number.isFinite(c.renderStart) ? c.renderStart : c.firstRenderStart),
      renderEnd: r3(c.renderEnd),
      commitStart: r3(c.commitStart),
      commitEnd: r3(c.commitEnd),
      layoutStart: r3(c.layoutStart),
      layoutEnd: r3(c.layoutEnd),
      passiveStart: r3(c.passiveStart),
      passiveEnd: r3(c.passiveEnd),
      passiveSync: c.passiveSync,
      rendered: c.rendered,
      bailouts: c.bailouts,
      walkUs: us(c.walkMs),
      dropped: c.dropped,
    },
  ];
}

// 19.2+: React names the component but not the fiber. In each phase it runs
// two passes, cleanups then effects (mutation then layout; passive unmount
// then passive mount), and logs a fiber's work in a pass that took over
// 0.05 ms, so one component can have two spans in a phase. The walk noted
// each pass's fibers in the order React visits them (EffectPasses).
function effectSpanRow(s: Shim, i: number, commitId: number): unknown[] {
  const ring = s.ring;
  const name = ring.r0[i] as string;
  const passive = (ring.n0[i]! & SPAN_PASSIVE) !== 0;
  const c = s.commits.get(commitId);
  let id: string | null = null;
  if (c !== undefined && c.passes !== null) {
    const index = (c.effectIndex ??= indexEffects(c.passes));
    const key = `${passive ? 'p' : 'l'}|${name}`;
    const k = index.cursor.get(key) ?? 0;
    index.cursor.set(key, k + 1);
    const fiber = pairSpan(index, passive, name, k, c.spanCounts?.get(key) ?? 0);
    if (fiber != null) id = componentId(s, fiber);
  }
  return [
    passive ? 'passive_effect' : 'layout_effect',
    r3(ring.t0[i]!),
    us(ring.t1[i]!),
    null,
    null,
    id,
    commitId || null,
    null,
    null,
    null,
    null,
    null,
    null,
    { name },
  ];
}

// The fiber of the k-th of n spans for a name in a phase. Spans past the
// effect pass's fibers are cleanups, which come first; with fewer spans than
// fibers in a pass, the first fibers are taken. Spans no pass explains (an
// Activity or Suspense boundary hiding or showing its content runs every
// effect in it) go to the name's one fiber if it has only one.
function pairSpan(index: EffectIndex, passive: boolean, name: string, k: number, n: number): Fiber | null | undefined {
  const pair = (passive ? index.passive : index.layout).get(name);
  if (pair !== undefined) {
    const extra = n - pair.create.length;
    if (k >= extra) return pair.create[k - Math.max(extra, 0)];
    if (k < pair.cleanup.length) return pair.cleanup[k];
  }
  return index.only.get(name);
}

// The name React gives a fiber's effect spans: for a function or class its
// displayName or name, which for React.memo is the inner function's, where
// displayName() prefers the memo wrapper's displayName.
function spanName(f: Fiber): string {
  const type = f.type;
  if (typeof type === 'function') return type.displayName || type.name || '';
  return displayName(f);
}

function indexEffects(p: EffectPasses): EffectIndex {
  const index: EffectIndex = { layout: new Map(), passive: new Map(), only: new Map(), cursor: new Map() };
  const names = new Map<Fiber, string>();
  const add = (m: EffectIndex['layout'], side: 'cleanup' | 'create', f: Fiber) => {
    let name = names.get(f);
    if (name === undefined) names.set(f, (name = spanName(f)));
    let pair = m.get(name);
    if (pair === undefined) m.set(name, (pair = { cleanup: [], create: [] }));
    pair[side].push(f);
    const one = index.only.get(name);
    if (one === undefined) index.only.set(name, f);
    else if (one !== f) index.only.set(name, null);
  };
  for (const f of p.mutation) add(index.layout, 'cleanup', f);
  for (const f of p.layout) add(index.layout, 'create', f);
  for (const f of p.unmount) add(index.passive, 'cleanup', f);
  for (const f of p.mount) add(index.passive, 'create', f);
  return index;
}

// The stack goes out as V8's text: the capture program finds the call site
// and the phase in it and maps every frame to original source.
function updateRow(s: Shim, i: number): unknown[] {
  const ring = s.ring;
  const fiber = ring.r0[i] as Fiber;
  const stack = ring.r2[i] as Error | null;
  return [
    'update_enqueued',
    r3(ring.t0[i]!),
    null,
    null,
    laneName(ring.n0[i]!),
    fiber == null ? null : componentId(s, fiber),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    {
      method: ring.r1[i] ?? null,
      phase: ring.r3[i] ?? null,
      event: ring.r4[i] ?? null,
      component: fiber == null ? (ring.r5[i] ?? null) : displayName(fiber),
      label: ring.r6[i] ?? null,
      stack: stack === null ? null : String(stack.stack ?? ''),
      during: ring.commit[i] || null,
    },
  ];
}

function describe(node: any): string | null {
  if (node == null || node.nodeType !== 1) return null;
  let out = String(node.localName ?? node.nodeName ?? '').toLowerCase();
  if (node.id) out += `#${node.id}`;
  const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
  if (cls) out += `.${cls}`;
  return out;
}

function entryRow(e: PerformanceEntry): unknown[] | null {
  const base = (kind: string, extra: object): unknown[] => [
    kind,
    r3(e.startTime),
    e.entryType === 'mark' ? null : us(e.duration),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    extra,
  ];
  switch (e.entryType) {
    case 'event': {
      const ev = e as PerformanceEventTiming;
      return base('event_timing', {
        name: ev.name,
        interactionId: ev.interactionId,
        processingStart: r3(ev.processingStart),
        processingEnd: r3(ev.processingEnd),
        target: describe(ev.target),
      });
    }
    case 'mark':
      return base('mark', { name: e.name });
    case 'measure':
      return base('measure', { name: e.name });
    case 'long-animation-frame': {
      const loaf = e as any;
      const scripts = Array.isArray(loaf.scripts)
        ? [...loaf.scripts]
            .sort((a: any, b: any) => b.duration - a.duration)
            .slice(0, 3)
            .map((sc: any) => ({
              invoker: sc.invoker ?? null,
              source: sc.sourceURL ?? null,
              fn: sc.sourceFunctionName ?? null,
              start: r3(sc.startTime),
              duration: r3(sc.duration),
            }))
        : [];
      return base('loaf', {
        blocking: r3(loaf.blockingDuration),
        renderStart: r3(loaf.renderStart),
        styleAndLayoutStart: r3(loaf.styleAndLayoutStart),
        scripts,
      });
    }
    default:
      return null;
  }
}

