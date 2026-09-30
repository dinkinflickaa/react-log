import { laneClassIndex, laneClassOf } from './constants.ts';
import { K_EFFECT_SPAN, K_LAYOUT_EFFECT, K_PASSIVE_EFFECT, K_SUSPEND, K_UPDATE, K_YIELD } from './ring.ts';
import { recordEntry } from './observer.ts';
import { r3, SLICE_UPDATE } from './pipeline.ts';
import { captureStack } from './stack.ts';
import { countSpan, currentEvent, type Fiber, newCommit, now, type Renderer, type Shim } from './state.ts';
import { settlePassive } from './walk.ts';

export const EFFECT_UNMOUNT = 1;
export const SPAN_ERROR_COLOR = 1;
export const SPAN_PASSIVE = 2;

function setTrigger(s: Shim, event: string): void {
  s.pendingTrigger = event;
  s.pendingTriggerAt = now();
}

// Frames kept past the shim's own: React's update path, the call site and
// the app code above it, and React's commit or render frames that tell the
// phase. The capture program stores all of them, source-mapped.
const STACK_FRAMES = 30;

function stackForUpdate(s: Shim, limit: number, skip: Function): Error | null {
  return s.config.updateStacks ? captureStack(limit, skip) : null;
}

// The shim's time inside an update runs inside the app's setState, so it is
// recorded as capture's own, as the commit walk's is.
function spent(s: Shim, t0: number): void {
  const t1 = now();
  if (t1 > t0) s.slices.push(r3(t0)!, r3(t1)!, SLICE_UPDATE);
}

// React 18.0 to 19.1: the scheduling-profiler hooks, installed through
// internals.injectProfilingHooks. The per-component render start and stop
// methods are left out on purpose, so React skips those calls; render timing
// comes from the commit walk instead.
export function profilingHooks(s: Shim, r: Renderer): Record<string, (...args: any[]) => void> {
  const ring = s.ring;
  let renderStart = NaN;
  let renderEnd = NaN;
  let commitDepth = 0;
  let effFiber: Fiber = null;
  let effStart = 0;
  let effKind = 0;
  let effSub = 0;

  const resting = (): 'commit' | 'idle' => (commitDepth > 0 ? 'commit' : 'idle');

  const startEffect = (fiber: Fiber, kind: number, sub: number) => {
    effFiber = fiber;
    effStart = now();
    effKind = kind;
    effSub = sub;
  };
  const stopEffect = () => {
    if (effFiber === null) return;
    const i = ring.alloc(effKind);
    const c = effKind === K_PASSIVE_EFFECT ? (s.pendingPassive ?? s.lastCommitted) : (s.open ?? s.lastCommitted);
    if (i < 0 && c !== null) c.dropped++;
    if (i >= 0) {
      ring.commit[i] = c === null ? 0 : c.id;
      ring.t0[i] = effStart;
      ring.t1[i] = now() - effStart;
      ring.n0[i] = effSub;
      ring.r0[i] = effFiber;
    }
    effFiber = null;
  };
  // `cut` is the hook function React called: the stack starts at its caller.
  const update = (fiber: Fiber, lane: number, method: string, cut: Function) => {
    const t = now();
    const i = ring.alloc(K_UPDATE);
    if (i < 0) {
      spent(s, t);
      return;
    }
    const event = currentEvent(s.g);
    if (event !== null && s.pendingTrigger === null) setTrigger(s, event);
    ring.t0[i] = t;
    ring.n0[i] = laneClassOf(lane, r.laneLabels);
    ring.r0[i] = fiber;
    ring.r1[i] = method;
    ring.r2[i] = stackForUpdate(s, STACK_FRAMES, cut);
    ring.r3[i] = s.phase === 'idle' ? null : s.phase === 'commit' ? 'layout' : s.phase;
    ring.r4[i] = event;
    // An update enqueued inside a commit's layout or passive phase is that
    // commit's cascade; the capture program links the two.
    const during = s.phase === 'commit' ? s.open : s.phase === 'passive' ? (s.pendingPassive ?? s.lastCommitted) : null;
    ring.commit[i] = during === null ? 0 : during.id;
    spent(s, t);
  };
  const wrap =
    <A extends any[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      try {
        fn(...args);
      } catch (e) {
        report(s, e);
      }
    };

  const hooks: Record<string, (...args: any[]) => void> = {
    markRenderStarted: wrap((_lanes: number) => {
      if (Number.isNaN(renderStart)) renderStart = now();
      s.phase = 'render';
    }),
    markRenderYielded: wrap(() => {
      const i = ring.alloc(K_YIELD);
      if (i >= 0) ring.t0[i] = now();
    }),
    markRenderStopped: wrap(() => {
      renderEnd = now();
      s.phase = resting();
    }),
    markCommitStarted: wrap((lanes: number) => {
      settlePassive(s);
      const c = newCommit(s, r.id);
      c.lanes = lanes;
      c.laneClass = laneClassOf(lanes, r.laneLabels);
      c.commitStart = now();
      c.renderStart = renderStart;
      c.renderEnd = renderEnd;
      renderStart = renderEnd = NaN;
      s.open = c;
      commitDepth++;
      s.phase = 'commit';
    }),
    markCommitStopped: wrap(() => {
      commitDepth = Math.max(0, commitDepth - 1);
      s.phase = resting();
    }),
    markLayoutEffectsStarted: wrap(() => {
      if (s.open !== null) s.open.layoutStart = now();
    }),
    markLayoutEffectsStopped: wrap(() => {
      if (s.open !== null) s.open.layoutEnd = now();
    }),
    markPassiveEffectsStarted: wrap(() => {
      const c = s.pendingPassive ?? s.lastCommitted;
      if (c !== null) c.passiveStart = now();
      s.phase = 'passive';
    }),
    markPassiveEffectsStopped: wrap(() => {
      const c = s.pendingPassive ?? s.lastCommitted;
      if (c !== null) c.passiveEnd = now();
      s.phase = resting();
    }),
    markComponentLayoutEffectMountStarted: wrap((f: Fiber) => startEffect(f, K_LAYOUT_EFFECT, 0)),
    markComponentLayoutEffectMountStopped: wrap(stopEffect),
    markComponentLayoutEffectUnmountStarted: wrap((f: Fiber) => startEffect(f, K_LAYOUT_EFFECT, EFFECT_UNMOUNT)),
    markComponentLayoutEffectUnmountStopped: wrap(stopEffect),
    markComponentPassiveEffectMountStarted: wrap((f: Fiber) => startEffect(f, K_PASSIVE_EFFECT, 0)),
    markComponentPassiveEffectMountStopped: wrap(stopEffect),
    markComponentPassiveEffectUnmountStarted: wrap((f: Fiber) => startEffect(f, K_PASSIVE_EFFECT, EFFECT_UNMOUNT)),
    markComponentPassiveEffectUnmountStopped: wrap(stopEffect),
    markStateUpdateScheduled: wrap((f: Fiber, lane: number) => update(f, lane, 'setState', hooks.markStateUpdateScheduled!)),
    markForceUpdateScheduled: wrap((f: Fiber, lane: number) => {
      s.forced.add(f);
      if (f.alternate != null) s.forced.add(f.alternate);
      update(f, lane, 'forceUpdate', hooks.markForceUpdateScheduled!);
    }),
    markComponentSuspended: wrap((f: Fiber) => {
      const i = ring.alloc(K_SUSPEND);
      if (i < 0) return;
      ring.t0[i] = now();
      ring.r0[i] = f;
    }),
  };
  return hooks;
}

const SCHEDULER = 'Scheduler ⚛';
const COMPONENTS = 'Components ⚛';
const UPDATE_MEASURES = new Set(['Update', 'Cascading Update', 'Update Blocked', 'Promise Resolved']);

// React 19.2+: React's own Performance Track calls. Installed before React
// loads, because React reads console.createTask once at module init. Each
// wrapper does a couple of comparisons and always forwards the call. On every
// version the performance.measure wrapper also records the app's measures:
// React's own all carry detail.devtools and are left out.
export function installTracks(s: Shim): void {
  const g = s.g;
  const con = g.console;
  if (con != null) {
    const timeStamp = con.timeStamp;
    if (typeof timeStamp === 'function') {
      con.timeStamp = function (this: unknown, label: unknown, start: unknown, end: unknown, track: unknown, group: unknown, color: unknown) {
        if (s.tracksRenderer !== null && typeof label === 'string') {
          try {
            onTimeStamp(s, label, start as number, end as number, track, group, color);
          } catch (e) {
            report(s, e);
          }
        }
        return timeStamp.apply(this, arguments as unknown as unknown[]);
      };
    }
    const createTask = con.createTask;
    if (typeof createTask === 'function') {
      const wrapped = function (this: unknown, name: unknown) {
        // Element tasks are named "<Type>"; update methods end in "()".
        if (s.tracksRenderer !== null && typeof name === 'string' && name.charCodeAt(0) !== 60 && name.charCodeAt(name.length - 1) === 41) {
          try {
            onUpdateTask(s, name, wrapped);
          } catch (e) {
            report(s, e);
          }
        }
        return createTask.apply(this, arguments as unknown as unknown[]);
      };
      con.createTask = wrapped;
    }
  }
  const perf = g.performance;
  if (perf != null && typeof perf.measure === 'function') {
    const measure = perf.measure;
    const recordApp = s.config.observe.includes('measure');
    perf.measure = function (this: unknown, name: unknown, options: any) {
      const devtools = options != null && typeof options === 'object' && options.detail != null ? options.detail.devtools : undefined;
      if (devtools != null && typeof name === 'string') {
        try {
          onDevtoolsMeasure(s, name, options, devtools);
        } catch (e) {
          report(s, e);
        }
      }
      const entry = measure.apply(this, arguments as unknown as unknown[]);
      if (devtools == null && recordApp && entry != null && typeof entry === 'object') {
        try {
          recordEntry(s, entry as PerformanceEntry);
        } catch (e) {
          report(s, e);
        }
      }
      return entry;
    };
  }
}

function onTimeStamp(s: Shim, label: string, start: number, end: number, track: unknown, group: unknown, color: unknown): void {
  if (group === SCHEDULER) {
    switch (label) {
      case 'Render':
      case 'Hydrated':
      case 'Prepared': {
        // Logged as commitRoot begins: this is the commit-start signal.
        settlePassive(s);
        let c = s.open;
        if (c === null || c.walked) c = s.open = newCommit(s, s.tracksRenderer!.id);
        c.renderStart = start;
        c.renderEnd = end;
        c.laneClass = laneClassIndex(String(track));
        c.commitStart = end;
        return;
      }
      case 'Commit':
      case 'Commit Interrupted View Transition': {
        const c = s.open ?? s.lastCommitted;
        if (c !== null) {
          c.commitStart = start;
          c.commitEnd = end;
        }
        return;
      }
      case 'Waiting for Paint':
      case 'Waiting': {
        const c = s.pendingPassive ?? s.lastCommitted;
        if (c !== null) c.passiveStart = end;
        return;
      }
      case 'Remaining Effects': {
        const c = s.pendingPassive ?? s.lastCommitted;
        if (c !== null) {
          c.passiveStart = start;
          c.passiveEnd = end;
        }
        return;
      }
      default:
        if (label.startsWith('Event: ')) setTrigger(s, label.slice(7));
        return;
    }
  }
  if (track === COMPONENTS && typeof color === 'string' && (color.startsWith('secondary') || color === 'error')) {
    // A component's effects in one commit phase. Renders use primary and
    // tertiary colors and are skipped: the commit walk has them.
    const ring = s.ring;
    const i = ring.alloc(K_EFFECT_SPAN);
    if (i < 0) {
      const c = s.pendingPassive ?? s.open;
      if (c !== null) c.dropped++;
      return;
    }
    ring.t0[i] = start;
    ring.t1[i] = end - start;
    ring.r0[i] = label;
    let bits = color === 'error' ? SPAN_ERROR_COLOR : 0;
    if (s.pendingPassive !== null) {
      bits |= SPAN_PASSIVE;
      ring.commit[i] = s.pendingPassive.id;
      countSpan(s.pendingPassive, label, true);
    } else if (s.open !== null) {
      ring.commit[i] = s.open.id;
      countSpan(s.open, label, false);
    } else {
      s.unassignedSpans.push(i);
    }
    ring.n0[i] = bits;
  }
}

// `cut` is the console.createTask wrapper: the stack starts at React's frame.
function onUpdateTask(s: Shim, method: string, cut: Function): void {
  const t = now();
  const shared = s.tracksRenderer!.internals.currentDispatcherRef;
  const event = currentEvent(s.g);
  if (event !== null && s.pendingTrigger === null) setTrigger(s, event);
  if (s.pendingTasks.length >= 16) s.pendingTasks.shift();
  s.pendingTasks.push({
    method,
    t,
    transition: shared != null && shared.T != null,
    event,
    stack: stackForUpdate(s, STACK_FRAMES, cut),
    // Mid-commit or mid-passive-flush: the stack tells the capture program
    // whether an effect enqueued this update.
    during: (s.pendingPassive ?? s.open)?.id ?? 0,
  });
  spent(s, t);
}

// React's "Update" measure carries the updated component's name, the method
// and the lane track. It is logged when the render starts; the matching
// console.createTask capture holds the time and stack of the setState call.
function onDevtoolsMeasure(s: Shim, name: string, options: any, devtools: any): void {
  if (devtools.trackGroup !== SCHEDULER || !UPDATE_MEASURES.has(name)) return;
  let component: string | null = null;
  let method: string | null = null;
  if (Array.isArray(devtools.properties)) {
    for (const p of devtools.properties) {
      if (p[0] === 'Component name') component = String(p[1]);
      else if (p[0] === 'Method name') method = String(p[1]);
    }
  }
  const transition = devtools.track === 'Transition';
  let task: Shim['pendingTasks'][number] | null = null;
  for (let k = 0; k < s.pendingTasks.length; k++) {
    const p = s.pendingTasks[k]!;
    if (p.transition === transition && (method === null || p.method === method)) {
      task = p;
      s.pendingTasks.splice(k, 1);
      break;
    }
  }
  emitUpdateSpan(s, task, typeof options.start === 'number' ? options.start : now(), laneClassIndex(String(devtools.track)), method, component, name);
}

export function emitUpdateSpan(
  s: Shim,
  task: Shim['pendingTasks'][number] | null,
  t: number,
  laneClass: number,
  method: string | null,
  component: string | null,
  label: string | null,
): void {
  const ring = s.ring;
  const i = ring.alloc(K_UPDATE);
  if (i < 0) return;
  ring.t0[i] = task === null ? t : task.t;
  ring.n0[i] = laneClass;
  ring.r0[i] = null;
  ring.r1[i] = method ?? task?.method ?? null;
  ring.r2[i] = task?.stack ?? null;
  ring.r3[i] = label === 'Cascading Update' ? 'cascade' : null;
  ring.r4[i] = task?.event ?? null;
  ring.r5[i] = component;
  ring.r6[i] = label;
  ring.commit[i] = task?.during ?? 0;
}

// Shim errors never reach React: report each distinct one once.
export function report(s: Shim, e: unknown): void {
  const err = e as { message?: unknown; stack?: unknown } | null;
  const message = String(err?.message ?? e);
  if (s.errors.size >= 20 || s.errors.has(message)) return;
  s.errors.add(message);
  s.outbox.push(JSON.stringify({ t: 'error', message, stack: String(err?.stack ?? '').slice(0, 2000) }));
}
