// React internals the shim keys on. Verified against the react-dom npm builds
// 18.0.0 through 19.3.0; PLAN.md has the version facts table.

export type LineId = '18' | '19.0' | '19.1' | '19.2+';

export interface Line {
  id: LineId;
  major: number;
  minor: number;
  mutationMask: number;
  layoutMask: number;
  passiveMask: number;
  // injectProfilingHooks exists on the renderer internals (18.0 to 19.1).
  profilingHooks: boolean;
  // Hook-list entries one useDeferredValue call occupies (2 before 18.2).
  deferredValueEntries: number;
}

export function lineFor(version: string): Line | null {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (m === null) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === 18) {
    return { id: '18', major, minor, mutationMask: 12854, layoutMask: 8772, passiveMask: 2064, profilingHooks: true, deferredValueEntries: minor < 2 ? 2 : 1 };
  }
  if (major === 19 && minor <= 1) {
    return { id: minor === 0 ? '19.0' : '19.1', major, minor, mutationMask: 13878, layoutMask: 8772, passiveMask: 10256, profilingHooks: true, deferredValueEntries: 1 };
  }
  if (major >= 19) {
    return { id: '19.2+', major, minor, mutationMask: 13878, layoutMask: 8772, passiveMask: 10256, profilingHooks: false, deferredValueEntries: 1 };
  }
  return null;
}

// Fiber flags with the same value in 18.x and 19.x.
export const PERFORMED_WORK = 1;
export const PLACEMENT = 2;
export const UPDATE = 4;
export const CHILD_DELETION = 16;
export const CONTENT_RESET = 32;
export const CALLBACK = 64;
export const PASSIVE = 2048;
export const HYDRATING = 4096;
export const VISIBILITY = 8192;

export const STRICT_LEGACY_MODE = 8;

// Work tags, identical in 18.x and 19.x.
export const FUNCTION_COMPONENT = 0;
export const CLASS_COMPONENT = 1;
export const INDETERMINATE_COMPONENT = 2;
export const HOST_COMPONENT = 5;
export const HOST_TEXT = 6;
export const CONTEXT_CONSUMER = 9;
export const FORWARD_REF = 11;
export const SIMPLE_MEMO_COMPONENT = 15;
export const INCOMPLETE_CLASS_COMPONENT = 17;
export const HOST_HOISTABLE = 26;
export const HOST_SINGLETON = 27;
export const INCOMPLETE_FUNCTION_COMPONENT = 28;

// Fibers that run user render code. The MemoComponent wrapper (14) is left
// out: its inner fiber carries the render.
export function isComposite(tag: number): boolean {
  return (
    tag === FUNCTION_COMPONENT ||
    tag === CLASS_COMPONENT ||
    tag === FORWARD_REF ||
    tag === SIMPLE_MEMO_COMPONENT ||
    tag === INDETERMINATE_COMPONENT ||
    tag === INCOMPLETE_CLASS_COMPONENT ||
    tag === INCOMPLETE_FUNCTION_COMPONENT ||
    tag === CONTEXT_CONSUMER
  );
}

export function isHost(tag: number): boolean {
  return tag === HOST_COMPONENT || tag === HOST_TEXT || tag === HOST_HOISTABLE || tag === HOST_SINGLETON;
}

export function hasHooks(tag: number): boolean {
  return tag === FUNCTION_COMPONENT || tag === FORWARD_REF || tag === SIMPLE_MEMO_COMPONENT || tag === INCOMPLETE_FUNCTION_COMPONENT;
}

// How many memoizedState list entries a hook call occupies, by the name React
// records in _debugHookTypes. Measured on every matrix version; 1 otherwise.
const NO_ENTRIES = new Set(['useContext', 'useDebugValue', 'useHostTransitionStatus', 'useFormStatus']);
const TWO_ENTRIES = new Set(['useTransition', 'useSyncExternalStore']);
const THREE_ENTRIES = new Set(['useActionState', 'useFormState']);

export function hookEntries(type: string, line: Line): number {
  if (NO_ENTRIES.has(type)) return 0;
  if (TWO_ENTRIES.has(type)) return 2;
  if (THREE_ENTRIES.has(type)) return 3;
  if (type === 'useDeferredValue') return line.deferredValueEntries;
  return 1;
}

// Hooks whose value changing is a reason to render.
export const STATEFUL_HOOKS = new Set([
  'useState',
  'useReducer',
  'useSyncExternalStore',
  'useTransition',
  'useDeferredValue',
  'useOptimistic',
  'useActionState',
  'useFormState',
]);

// Lane classes, named like React 19.2's Scheduler tracks.
export const LANE_CLASSES = ['Other', 'Blocking', 'Gesture', 'Transition', 'Suspense', 'Idle'] as const;
export type LaneClass = (typeof LANE_CLASSES)[number];

export function laneClassIndex(name: string): number {
  const i = (LANE_CLASSES as readonly string[]).indexOf(name);
  return i < 0 ? 0 : i;
}

function classOfLabel(label: string): LaneClass {
  switch (label) {
    case 'Sync':
    case 'SyncHydrationLane':
    case 'InputContinuous':
    case 'InputContinuousHydration':
    case 'Default':
    case 'DefaultHydration':
      return 'Blocking';
    case 'Transition':
    case 'TransitionHydration':
      return 'Transition';
    case 'Retry':
      return 'Suspense';
    case 'SelectiveHydration':
    case 'IdleHydration':
    case 'Idle':
    case 'Offscreen':
    case 'Deferred':
      return 'Idle';
    default:
      return 'Other';
  }
}

// Lane bitmask to class, from the highest-priority lane, using the renderer's
// own getLaneLabelMap (18.0 to 19.1) because lane bits moved between 18 and 19.
export function laneClassOf(lanes: number, labels: Map<number, string> | null): number {
  if (!lanes || labels === null) return 0;
  const label = labels.get(lanes & -lanes);
  return label === undefined ? 0 : laneClassIndex(classOfLabel(label));
}
