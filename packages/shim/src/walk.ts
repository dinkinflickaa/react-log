import {
  CALLBACK,
  CHILD_DELETION,
  CONTENT_RESET,
  HOST_TEXT,
  HYDRATING,
  isComposite,
  isHost,
  PASSIVE,
  PERFORMED_WORK,
  PLACEMENT,
  STRICT_LEGACY_MODE,
  UPDATE,
  VISIBILITY,
} from './constants.ts';
import { K_COMMIT, K_RENDER } from './ring.ts';
import { type Commit, type Fiber, newCommit, now, type Renderer, type Shim } from './state.ts';

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
  for (let i = 0; i < spans.length; i++) s.ring.commit[spans[i]!] = c.id;
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
      if (own === 1 && line.id === '19.2+') (c.effectFibers ??= []).push(node);
    } else if (isHost(tag)) {
      own = hostChanged(node, alt) ? 1 : 0;
    } else {
      own = (node.flags & (PLACEMENT | CHILD_DELETION | CONTENT_RESET | VISIBILITY | HYDRATING)) !== 0 ? 1 : 0;
    }
    acc[depth] = own;
    slots[depth] = slot;

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
