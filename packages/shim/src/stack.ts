import { type Frame, parseFrames } from './ids.ts';

// Capturing a stack records structured frames; V8 formats the text lazily,
// on first read of .stack, which happens in idle time. The capture itself
// runs inside the update and costs more with every frame kept (about 50 µs
// for 30 frames of a React 18 click), so the frames from `skip` inward (the
// shim's own) are left out and only `limit` frames are kept.
export function captureStack(limit: number, skip: Function): Error {
  const saved = Error.stackTraceLimit;
  Error.stackTraceLimit = limit;
  let e: Error;
  if (typeof Error.captureStackTrace === 'function') {
    e = { name: 'Error', message: 'react-log update' } as Error;
    Error.captureStackTrace(e, skip);
  } else {
    e = new Error('react-log update');
  }
  Error.stackTraceLimit = saved;
  return e;
}

const SHIM_FILE = /react-log-shim|[\\/]packages[\\/]shim[\\/]/;

// React functions between setState and the code that called it.
const REACT_UPDATE = new Set([
  'dispatchSetState',
  'dispatchSetStateInternal',
  'dispatchReducerAction',
  'dispatchOptimisticSetState',
  'dispatchActionState',
  'markUpdateInDevTools',
  'markStateUpdateScheduled',
  'markForceUpdateScheduled',
  'enqueueSetState',
  'enqueueReplaceState',
  'enqueueForceUpdate',
  'setState',
  'replaceState',
  'forceUpdate',
  'startUpdateTimerByLane',
  'scheduleUpdateOnFiber',
  'forceStoreRerender',
  'checkIfSnapshotChanged',
  'handleStoreChange',
  'updateContainer',
  'updateContainerImpl',
]);

// root.render(): React assigns one function to both root prototypes, so V8
// names the frame "ReactDOMHydrationRoot.render.ReactDOMRoot.render".
const ROOT_RENDER = /(^|\.)ReactDOM(Hydration)?Root\.render$/;

function lastName(fn: string): string {
  const dot = fn.lastIndexOf('.');
  return dot < 0 ? fn : fn.slice(dot + 1);
}

// The first frame outside the shim and React's update path.
export function callSite(stack: string): string | null {
  const frames = parseFrames(stack);
  let i = 0;
  while (i < frames.length && SHIM_FILE.test(frames[i]!.file)) i++;
  while (i < frames.length && (REACT_UPDATE.has(lastName(frames[i]!.fn)) || ROOT_RENDER.test(frames[i]!.fn))) i++;
  const f: Frame | undefined = frames[i];
  return f === undefined ? null : f.text;
}

const PASSIVE_FRAMES = new Set([
  'commitPassiveMountOnFiber',
  'recursivelyTraversePassiveMountEffects',
  'commitHookPassiveMountEffects',
  'commitPassiveMountEffects',
  'commitPassiveMountEffects_complete',
  'commitPassiveUnmountEffects',
  'flushPassiveEffects',
  'flushPassiveEffectsImpl',
]);
const LAYOUT_FRAMES = new Set([
  'commitLayoutEffectOnFiber',
  'recursivelyTraverseLayoutEffects',
  'commitHookLayoutEffects',
  'commitLayoutEffects',
  'commitLayoutEffects_begin',
  'commitLayoutEffects_complete',
  'flushLayoutEffects',
  'commitMutationEffectsOnFiber',
  'commitRootImpl',
]);
const RENDER_FRAMES = new Set(['renderWithHooks', 'beginWork', 'performUnitOfWork', 'updateFunctionComponent', 'finishClassComponent']);

// Which React phase enqueued an update, from its stack: passive, layout,
// render, or null for anything else (an event handler, a timer).
export function phaseFromStack(stack: string): string | null {
  const frames = parseFrames(stack);
  for (const f of frames) {
    const name = lastName(f.fn);
    if (PASSIVE_FRAMES.has(name)) return 'passive';
    if (LAYOUT_FRAMES.has(name)) return 'layout';
    if (RENDER_FRAMES.has(name)) return 'render';
  }
  return null;
}
