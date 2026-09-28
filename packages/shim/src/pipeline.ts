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
import { callSite, phaseFromStack } from './stack.ts';
import { type Commit, type Fiber, now, type Shim } from './state.ts';
import { R_COMMITTED, R_FORCED, R_MOUNT, R_STRICT } from './walk.ts';
import { classifyKeys, whyRendered } from './why.ts';

// Wire format, one JSON message per sink call:
//   {t:"hello"|"renderer"|"refused"|"error", ...}
//   {t:"batch", seq, dropped, defs, rows}
// defs: [component_id, display_name, source_file, source_line, source_column, owner_path]
// rows: [kind, ts, dur_us, self_us, lane, component_id, commit, reason_code,
//        changed_hooks, changed_context, changed_keys, committed, call_site, extra]
// ts is performance.now() ms on the page's clock; hello carries timeOrigin.

export function post(s: Shim, message: object): void {
  s.outbox.push(JSON.stringify(message));
  scheduleIdle(s);
}

export function scheduleIdle(s: Shim): void {
  if (s.idleScheduled) return;
  s.idleScheduled = true;
  const ric = s.g.requestIdleCallback;
  if (typeof ric === 'function') ric.call(s.g, (d: IdleDeadline) => runIdle(s, d), { timeout: 1000 });
  else setTimeout(() => runIdle(s, null), 1);
}

function runIdle(s: Shim, deadline: IdleDeadline | null): void {
  s.idleScheduled = false;
  const t0 = now();
  let budget = s.config.sliceMs;
  if (deadline !== null) budget = Math.min(budget, Math.max(1, deadline.timeRemaining()));
  try {
    // Leave room for JSON.stringify and the sink call inside the slice.
    drain(s, t0 + budget * 0.6);
  } catch (e) {
    report(s, e);
  }
  const dt = now() - t0;
  if (dt > s.stats.maxTaskMs) s.stats.maxTaskMs = dt;
  if (s.ring.count > 0 || s.outbox.length > 0) scheduleIdle(s);
}

// Everything, now, ignoring the slice budget: tests and pagehide.
export function flushNow(s: Shim): void {
  try {
    drain(s, Infinity);
  } catch (e) {
    report(s, e);
    drain(s, Infinity);
  }
}

function drain(s: Shim, until: number): void {
  const sink = s.g.__reactLogSink;
  if (typeof sink !== 'function') return;
  while (s.outbox.length > 0) sink(s.outbox.shift());
  expireTasks(s);
  const ring = s.ring;
  const rows: unknown[][] = [];
  while (ring.count > 0) {
    const i = ring.peek();
    let row: unknown[] | null = null;
    try {
      row = serialize(s, i);
    } catch (e) {
      report(s, e);
    }
    ring.release(i);
    if (row !== null) rows.push(row);
    // A row can cost a stack format, so check the clock after every one.
    if (now() > until) break;
  }
  const dropped = ring.dropped - s.lastDropped;
  if (rows.length === 0 && s.defs.length === 0 && dropped === 0) {
    while (s.outbox.length > 0) sink(s.outbox.shift());
    return;
  }
  const message = JSON.stringify({ t: 'batch', seq: s.seq++, dropped, defs: s.defs, rows });
  s.lastDropped = ring.dropped;
  s.defs = [];
  s.stats.batches++;
  s.stats.rows += rows.length;
  sink(message);
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
    },
  ];
}

// 19.2+: React names the component but not the fiber. Match the k-th span
// for a name to the k-th fiber with that name and effect flags, post-order,
// per phase. Unmount effects of deleted fibers find no match.
function effectSpanRow(s: Shim, i: number, commitId: number): unknown[] {
  const ring = s.ring;
  const name = ring.r0[i] as string;
  const passive = (ring.n0[i]! & SPAN_PASSIVE) !== 0;
  const c = s.commits.get(commitId);
  let id: string | null = null;
  if (c !== undefined && c.effectFibers !== null) {
    const cursors = (c.effectCursors ??= { layout: new Map(), passive: new Map() });
    const cursor = passive ? cursors.passive : cursors.layout;
    const list = c.effectFibers;
    for (let k = cursor.get(name) ?? 0; k < list.length; k++) {
      if (displayName(list[k]) === name) {
        id = componentId(s, list[k]);
        cursor.set(name, k + 1);
        break;
      }
    }
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

function updateRow(s: Shim, i: number): unknown[] {
  const ring = s.ring;
  const fiber = ring.r0[i] as Fiber;
  const stack = ring.r2[i] as Error | null;
  const text = stack === null ? null : String(stack.stack ?? '');
  let phase = ring.r3[i] as string | null;
  if (text !== null && (phase === null || phase === 'cascade')) phase = phaseFromStack(text) ?? phase;
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
    text === null ? null : callSite(text),
    {
      method: ring.r1[i] ?? null,
      phase,
      event: ring.r4[i] ?? null,
      component: fiber == null ? (ring.r5[i] ?? null) : displayName(fiber),
      label: ring.r6[i] ?? null,
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

