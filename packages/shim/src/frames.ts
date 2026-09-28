// V8 stack frames, parsed. Shared by the page (where a component's element
// was created) and the capture program (update call sites and phases), which
// gets update stacks as raw text and does the parsing off the page.

export interface Frame {
  fn: string;
  file: string;
  line: number;
  column: number;
  text: string;
}

// V8 frames: "    at fn (file:line:col)" or "    at file:line:col".
export function parseFrames(stack: string): Frame[] {
  const out: Frame[] = [];
  const lines = stack.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (!text.startsWith('at ')) continue;
    const body = text.slice(3);
    const open = body.lastIndexOf(' (');
    let fn = '';
    let loc = body;
    if (open >= 0 && body.endsWith(')')) {
      fn = body.slice(0, open);
      loc = body.slice(open + 2, -1);
    }
    const bracket = fn.indexOf(' [as ');
    if (bracket >= 0) fn = fn.slice(0, bracket);
    if (fn.startsWith('async ')) fn = fn.slice(6);
    const m = /^(.*):(\d+):(\d+)$/.exec(loc);
    out.push(
      m === null
        ? { fn, file: '', line: 0, column: 0, text: body }
        : { fn, file: m[1]!, line: Number(m[2]), column: Number(m[3]), text: body },
    );
  }
  return out;
}

export const SHIM_FILE = /react-log-shim|[\\/]packages[\\/]shim[\\/]/;

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

// Frames from the first one outside the shim.
export function withoutShim(frames: Frame[]): Frame[] {
  let i = 0;
  while (i < frames.length && SHIM_FILE.test(frames[i]!.file)) i++;
  return frames.slice(i);
}

// Index of the call site: the first frame past React's update path.
export function callSiteIndex(frames: Frame[]): number {
  let i = 0;
  while (i < frames.length && (REACT_UPDATE.has(lastName(frames[i]!.fn)) || ROOT_RENDER.test(frames[i]!.fn))) i++;
  return i < frames.length ? i : -1;
}

// The first frame outside the shim and React's update path.
export function callSite(stack: string): string | null {
  const frames = withoutShim(parseFrames(stack));
  const i = callSiteIndex(frames);
  return i < 0 ? null : frames[i]!.text;
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

// Which React phase enqueued an update, from its frames: passive, layout,
// render, or null for anything else (an event handler, a timer).
export function phaseOf(frames: Frame[]): string | null {
  for (const f of frames) {
    const name = lastName(f.fn);
    if (PASSIVE_FRAMES.has(name)) return 'passive';
    if (LAYOUT_FRAMES.has(name)) return 'layout';
    if (RENDER_FRAMES.has(name)) return 'render';
  }
  return null;
}

export function phaseFromStack(stack: string): string | null {
  return phaseOf(parseFrames(stack));
}
