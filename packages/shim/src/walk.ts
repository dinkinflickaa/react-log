import {
  CALLBACK,
  CHILD_DELETION,
  CLASS_COMPONENT,
  CONTENT_RESET,
  HOST_TEXT,
  HYDRATING,
  isComposite,
  isHost,
  LAYOUT_STATIC,
  OFFSCREEN_COMPONENT,
  PASSIVE,
  PASSIVE_STATIC,
  PERFORMED_WORK,
  PLACEMENT,
  REF,
  STRICT_LEGACY_MODE,
  UPDATE,
  VISIBILITY,
} from './constants.ts';
import { componentId } from './ids.ts';
import { K_COMMIT, K_RENDER } from './ring.ts';
import { type Commit, countSpan, type EffectPasses, type Fiber, newCommit, now, type Renderer, type Shim } from './state.ts';

// Bits in ring.n0 for render records.
export const R_COMMITTED = 1;
export const R_MOUNT = 2;
export const R_FORCED = 4;
export const R_STRICT = 8;

const rootIds = new WeakMap<object, number>();
let nextRootId = 0;

// onCommitFiberRoot runs after layout effects and before passive effects.
// Walk the fibers that rendered in this commit: the same traversal React
// DevTools' Profiler uses, skipping any subtree whose child pointer is
// unchanged since it did not render. Only numbers, flags and references are
// recorded here; everything that costs more runs later in idle time.
export function onCommit(s: Shim, r: Renderer, root: any, priority: number | undefined, didError: boolean | undefined): void {
  const t = now();
  settlePassive(s);
  let c = s.open;
  if (c === null || c.walked) c = newCommit(s, r.id);
  s.open = null;
  c.priority = priority ?? null;
  c.didError = Boolean(didError);
  let rootId = rootIds.get(root);
  if (rootId === undefined) rootIds.set(root, (rootId = ++nextRootId));
  c.root = rootId;
  if (Number.isNaN(c.commitEnd)) c.commitEnd = t;
  if (Number.isNaN(c.layoutEnd)) c.layoutEnd = t;

  walk(s, r, root.current, c);

  const spans = s.unassignedSpans;
  for (let i = 0; i < spans.length; i++) {
    s.ring.commit[spans[i]!] = c.id;
    countSpan(c, s.ring.r0[spans[i]!] as string, false);
  }
  spans.length = 0;

  c.walked = true;
  c.walkMs = now() - t;
  s.stats.commits++;
  s.stats.walkMs += c.walkMs;
  if (c.walkMs > s.stats.maxWalkMs) s.stats.maxWalkMs = c.walkMs;
  s.forced.clear();
  s.lastCommitted = c;

  const current = root.current;
  if (((current.flags | current.subtreeFlags) & r.line.passiveMask) !== 0) {
    c.passivePending = true;
    s.pendingPassive = c;
    probe(s, c);
  } else {
    finalize(s, c);
  }
}

// Passive effects are done for the commit that had them pending.
export function onPostCommit(s: Shim): void {
  const c = s.pendingPassive ?? s.lastCommitted;
  if (c === null || c.finalized) return;
  if (c.passivePending) c.passiveSync = !c.probeFired;
  if (Number.isNaN(c.passiveEnd)) c.passiveEnd = now();
  s.pendingPassive = null;
  finalize(s, c);
}

// React flushes pending passive effects before the next commit starts. If
// onPostCommitFiberRoot never came for them, close that commit now.
export function settlePassive(s: Shim): void {
  const c = s.pendingPassive;
  if (c === null) return;
  s.pendingPassive = null;
  finalize(s, c);
}

export function finalize(s: Shim, c: Commit): void {
  if (c.finalized) return;
  c.finalized = true;
  const i = s.ring.alloc(K_COMMIT);
  if (i < 0) {
    s.commits.delete(c.id);
    return;
  }
  s.ring.commit[i] = c.id;
  s.ring.r0[i] = c;
}

// passive_sync: a message posted at commit time fires only after the current
// task ends, so if passive effects finish before it fires they ran in the
// commit's own task.
let channel: MessageChannel | null = null;
const probing = new Map<number, Commit>();

function probe(s: Shim, c: Commit): void {
  if (channel === null) {
    if (typeof MessageChannel !== 'function') return;
    channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent) => {
      const pc = probing.get(e.data as number);
      if (pc !== undefined) {
        pc.probeFired = true;
        probing.delete(pc.id);
      }
    };
    const port = channel.port1 as unknown as { unref?: () => void };
    port.unref?.();
  }
  probing.set(c.id, c);
  channel.port2.postMessage(c.id);
}

function walk(s: Shim, r: Renderer, top: Fiber, c: Commit): void {
  const acc = s.acc;
  const slots = s.slots;
  const max = acc.length - 1;
  const line = r.line;
  // 19.2+ names the component of an effect span but not the fiber: note the
  // fibers each commit pass visits, outside hidden subtrees (no effects run
  // there), in React's order.
  const passes = line.id === '19.2+';
  let hiddenAt = -1;
  let node: Fiber = top;
  let depth = 0;

  outer: for (;;) {
    // Enter node.
    const tag: number = node.tag;
    const alt: Fiber = node.alternate;
    let slot = -1;
    let own = 0;
    if (isComposite(tag)) {
      if ((node.flags & PERFORMED_WORK) !== 0) slot = recordRender(s, c, node, alt);
      else c.bailouts++;
      own = (node.flags & (PLACEMENT | UPDATE | CHILD_DELETION | CALLBACK | PASSIVE)) !== 0 ? 1 : 0;
    } else if (isHost(tag)) {
      own = hostChanged(node, alt) ? 1 : 0;
    } else {
      own = (node.flags & (PLACEMENT | CHILD_DELETION | CONTENT_RESET | VISIBILITY | HYDRATING)) !== 0 ? 1 : 0;
    }
    // React clears Placement and Hydrating on the placed fiber during the
    // mutation phase, before this walk; its parent's subtreeFlags keep them.
    // A child inserted or moved is a DOM change for its ancestors only: a
    // moved row's own render produced the same output.
    if ((node.subtreeFlags & (PLACEMENT | HYDRATING)) !== 0) own = 1;
    acc[depth] = own;
    slots[depth] = slot;
    if (passes && hiddenAt < 0) {
      if (tag === OFFSCREEN_COMPONENT && node.memoizedState !== null) hiddenAt = depth;
      else if ((node.flags & CHILD_DELETION) !== 0 && node.deletions != null) passDeleted(c, node.deletions);
    }

    const child: Fiber = node.child;
    if (child !== null && (alt === null || child !== alt.child) && depth < max) {
      node = child;
      depth++;
      continue;
    }

    // Leave node, then climb until a sibling is found.
    for (;;) {
      const done = acc[depth]!;
      const s0 = slots[depth]!;
      if (s0 >= 0 && (done === 1 || (s.ring.n0[s0]! & R_MOUNT) !== 0)) s.ring.n0[s0]! |= R_COMMITTED;
      if (passes) {
        if (hiddenAt === depth) hiddenAt = -1;
        else if (hiddenAt < 0 && isComposite(node.tag)) passFiber(c, node, line.layoutMask);
      }
      if (depth === 0) break outer;
      if (done === 1) acc[depth - 1] = 1;
      if (node.sibling !== null) {
        node = node.sibling;
        continue outer;
      }
      node = node.return;
      depth--;
    }
  }
}

// A fiber of this commit in the passes that run its effects, as the walk
// leaves it (React logs a fiber's span after its subtree's). Cleanups run
// only for a fiber that was there before this commit.
function passFiber(c: Commit, f: Fiber, layoutMask: number): void {
  const flags: number = f.flags;
  if ((flags & (layoutMask | PASSIVE)) === 0) return;
  const p = (c.passes ??= newPasses());
  const updated = f.alternate !== null;
  if (updated && (flags & (UPDATE | REF)) !== 0) p.mutation.push(f);
  if ((flags & layoutMask) !== 0) p.layout.push(f);
  if ((flags & PASSIVE) !== 0) {
    if (updated) p.unmount.push(f);
    p.mount.push(f);
  }
}

// A parent's deleted subtrees, which React cleans up before the parent's
// other children: in the mutation pass it logs a fiber's layout cleanups
// after its subtree's, in the unmount pass its passive cleanups before.
function passDeleted(c: Commit, deletions: Fiber[]): void {
  const p = (c.passes ??= newPasses());
  for (const top of deletions) {
    let f: Fiber = top;
    subtree: for (;;) {
      if (isComposite(f.tag) && (f.flags & PASSIVE_STATIC) !== 0) p.unmount.push(f);
      const hidden = f.tag === OFFSCREEN_COMPONENT && f.memoizedState !== null;
      if (!hidden && f.child != null) {
        f = f.child;
        continue;
      }
      for (;;) {
        if (isComposite(f.tag) && hasLayoutCleanup(f)) p.mutation.push(f);
        if (f === top) break subtree;
        if (f.sibling != null) {
          f = f.sibling;
          break;
        }
        const up = f.return;
        if (up == null) break subtree;
        f = up;
      }
    }
  }
}

function hasLayoutCleanup(f: Fiber): boolean {
  if ((f.flags & LAYOUT_STATIC) !== 0) return true;
  return f.tag === CLASS_COMPONENT && typeof f.stateNode?.componentWillUnmount === 'function';
}

function newPasses(): EffectPasses {
  return { mutation: [], layout: [], unmount: [], mount: [] };
}

// React clears a deleted fiber's owner once its passive cleanups have run. A
// component that mounts and unmounts before the idle pipeline reaches its
// rows would lose its owner path, so its id is taken now.
export function onUnmount(s: Shim, fiber: Fiber): void {
  if (isComposite(fiber.tag) && !s.idByFiber.has(fiber)) componentId(s, fiber);
}

function recordRender(s: Shim, c: Commit, fiber: Fiber, alt: Fiber): number {
  const ring = s.ring;
  const i = ring.alloc(K_RENDER);
  if (i < 0) return -1;
  const start: number = fiber.actualStartTime;
  const dur: number = fiber.actualDuration;
  let self = dur;
  const child = fiber.child;
  if (alt === null || alt.child !== child) {
    for (let ch = child; ch !== null; ch = ch.sibling) self -= ch.actualDuration;
  }
  ring.commit[i] = c.id;
  ring.t0[i] = start;
  ring.t1[i] = dur;
  ring.t2[i] = self;
  let bits = 0;
  if (alt === null) bits |= R_MOUNT;
  if (s.forced.size > 0 && (s.forced.has(fiber) || (alt !== null && s.forced.has(alt)))) bits |= R_FORCED;
  if ((fiber.mode & STRICT_LEGACY_MODE) !== 0) {
    bits |= R_STRICT;
    c.strict = true;
  }
  ring.n0[i] = bits;
  ring.r0[i] = fiber;
  ring.r2[i] = fiber.memoizedProps;
  ring.r4[i] = fiber.memoizedState;
  const nd = fiber.dependencies;
  ring.r6[i] = nd == null ? null : nd.firstContext;
  if (alt !== null) {
    ring.r1[i] = alt.memoizedProps;
    ring.r3[i] = alt.memoizedState;
    const ad = alt.dependencies;
    ring.r5[i] = ad == null ? null : ad.firstContext;
  }
  if (start > 0 && start < c.firstRenderStart) c.firstRenderStart = start;
  c.rendered++;
  return i;
}

// Did this host fiber change the DOM? React 19 marks Update whenever a host
// element's props object changes, and React 18 when only an event handler
// changed, so the Update flag alone would count renders that changed nothing.
// A change counts when a non-function prop differs; handlers only swap the
// listener React calls, and element children are their own fibers.
function hostChanged(node: Fiber, alt: Fiber): boolean {
  const flags: number = node.flags;
  if ((flags & (PLACEMENT | CHILD_DELETION | CONTENT_RESET | VISIBILITY | HYDRATING)) !== 0) return true;
  if ((flags & UPDATE) === 0) return false;
  if (node.tag === HOST_TEXT || alt === null) return true;
  const prev = alt.memoizedProps;
  const next = node.memoizedProps;
  if (prev === next || prev == null || next == null) return prev !== next;
  for (const key in next) {
    const b = next[key];
    const a = prev[key];
    if (a === b || key === 'ref') continue;
    if (key === 'children') {
      if (typeof b === 'string' || typeof b === 'number' || typeof a === 'string' || typeof a === 'number') return true;
      continue;
    }
    if (typeof a === 'function' && typeof b === 'function') continue;
    if (key === 'style' && a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      if (!shallowEqual(a, b)) return true;
      continue;
    }
    if (key === 'dangerouslySetInnerHTML' && a != null && b != null) {
      if (a.__html !== b.__html) return true;
      continue;
    }
    return true;
  }
  for (const key in prev) {
    if (!(key in next) && key !== 'children' && key !== 'ref' && typeof prev[key] !== 'function') return true;
  }
  return false;
}

export function shallowEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  let n = 0;
  for (const k in a) {
    if (!Object.is(a[k], b[k])) return false;
    n++;
  }
  for (const _ in b) n--;
  return n === 0;
}
