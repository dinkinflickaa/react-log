import { CLASS_COMPONENT, hasHooks, hookEntries, type Line, STATEFUL_HOOKS } from './constants.ts';
import type { Fiber } from './state.ts';
import { shallowEqual } from './walk.ts';

export interface Why {
  reason: string;
  hooks: string | null;
  context: string | null;
  keys: string[] | null;
}

// Why a fiber rendered, from references kept at commit time: previous and
// next props, state (hook list head or class state) and context dependency
// list heads. First match wins: mount, retry, force, context, hooks, state,
// props, parent, unknown.
export function whyRendered(
  fiber: Fiber,
  line: Line,
  mount: boolean,
  forced: boolean,
  retry: boolean,
  prevProps: any,
  nextProps: any,
  prevState: any,
  nextState: any,
  prevDeps: any,
  nextDeps: any,
): Why {
  if (mount) return { reason: 'mount', hooks: null, context: null, keys: null };
  const tag: number = fiber.tag;
  const context = changedContexts(prevDeps, nextDeps);
  const hooks = hasHooks(tag) ? changedHooks(fiber._debugHookTypes, prevState, nextState, line) : null;
  const stateChanged = tag === CLASS_COMPONENT && prevState !== nextState && !shallowEqual(prevState, nextState);
  const keys = prevProps !== nextProps ? changedKeys(prevProps, nextProps) : null;
  let reason: string;
  if (retry) reason = 'retry';
  else if (forced) reason = 'force';
  else if (context !== null) reason = 'context';
  else if (hooks !== null) reason = 'hooks';
  else if (stateChanged) reason = 'state';
  else if (keys !== null && keys.length > 0) reason = 'props';
  else if (prevProps !== nextProps) reason = 'parent';
  else if (tag === CLASS_COMPONENT) reason = 'force';
  else reason = 'unknown';
  return { reason, hooks, context, keys };
}

// Walk both context dependency lists in step, the way React DevTools does.
// Comparing with the context's current value would read the wrong value:
// React keeps context values on a stack that is empty once render finishes.
// If the order of contexts changed, props or state caused the render.
export function changedContexts(prev: any, next: any): string | null {
  let out: string | null = null;
  while (prev != null && next != null) {
    if (prev.context !== next.context) break;
    if (!Object.is(prev.memoizedValue, next.memoizedValue)) {
      const name = next.context?.displayName || 'Context';
      out = out === null ? name : `${out},${name}`;
    }
    prev = prev.next;
    next = next.next;
  }
  return out;
}

function listLength(head: any): number {
  let n = 0;
  for (let e = head; e != null && n < 10_000; e = e.next) n++;
  return n;
}

function isEffect(value: any): boolean {
  return value !== null && typeof value === 'object' && 'create' in value && 'tag' in value;
}

// Changed stateful hooks as "index:type", index being the position in
// _debugHookTypes (call order). Hook calls occupy 0 to 3 list entries each,
// so the lists are walked in step with a per-type entry count. If the list
// length disagrees with that count, fall back to comparing entries by shape.
export function changedHooks(types: string[] | null | undefined, prevHead: any, nextHead: any, line: Line): string | null {
  if (prevHead === nextHead || prevHead == null || nextHead == null) return null;
  const out: string[] = [];
  if (Array.isArray(types)) {
    let expected = 0;
    for (let i = 0; i < types.length; i++) expected += hookEntries(types[i]!, line);
    if (expected === listLength(nextHead) && expected === listLength(prevHead)) {
      let p = prevHead;
      let n = nextHead;
      for (let i = 0; i < types.length; i++) {
        const type = types[i]!;
        const count = hookEntries(type, line);
        let changed = false;
        for (let k = 0; k < count; k++) {
          if (STATEFUL_HOOKS.has(type) && !changed) {
            const a = p.memoizedState;
            const b = n.memoizedState;
            if (!Object.is(a, b) && !isEffect(b) && typeof b !== 'function') changed = true;
          }
          p = p.next;
          n = n.next;
        }
        if (changed) out.push(`${i}:${type}`);
      }
      return out.length === 0 ? null : out.join(',');
    }
  }
  let p = prevHead;
  let n = nextHead;
  for (let i = 0; p != null && n != null; i++, p = p.next, n = n.next) {
    const q = n.queue;
    if (q == null || isEffect(n.memoizedState)) continue;
    const label = typeof q.getSnapshot === 'function' ? 'useSyncExternalStore' : q.lastRenderedReducer?.name === 'basicStateReducer' ? 'useState' : 'useReducer';
    if (!Object.is(p.memoizedState, n.memoizedState)) out.push(`${i}:${label}`);
  }
  return out.length === 0 ? null : out.join(',');
}

export function changedKeys(prev: any, next: any): string[] {
  const out: string[] = [];
  if (prev == null || next == null) return out;
  for (const k in next) if (!Object.is(prev[k], next[k])) out.push(k);
  for (const k in prev) if (!(k in next)) out.push(k);
  return out;
}

// For watched components: did a changed prop keep its value (identity_only)
// or change it (value)? Bounded deep compare; functions with the same source
// text count as the same value, which is the useCallback case.
export function classifyKeys(keys: string[], prev: any, next: any): string {
  return keys.map((k) => `${k}:${deepEqual(prev?.[k], next?.[k], 0, { n: 0 }) ? 'identity_only' : 'value'}`).join(',');
}

function deepEqual(a: any, b: any, depth: number, budget: { n: number }): boolean {
  if (Object.is(a, b)) return true;
  if (++budget.n > 500 || depth > 4) return false;
  if (typeof a === 'function' && typeof b === 'function') return a.toString() === b.toString();
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a.$$typeof !== undefined || b.$$typeof !== undefined) {
    return a.$$typeof === b.$$typeof && a.type === b.type && a.key === b.key && deepEqual(a.props, b.props, depth + 1, budget);
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k], depth + 1, budget)) return false;
  return true;
}
