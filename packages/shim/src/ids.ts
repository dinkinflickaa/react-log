import { CLASS_COMPONENT, CONTEXT_CONSUMER, FORWARD_REF, MEMO_COMPONENT, SIMPLE_MEMO_COMPONENT } from './constants.ts';
import { parseFrames } from './frames.ts';
import type { Fiber, Shim } from './state.ts';

export function displayName(fiber: Fiber): string {
  const type = fiber.type;
  const tag: number = fiber.tag;
  if (tag === SIMPLE_MEMO_COMPONENT) {
    const outer = fiber.elementType;
    if (outer != null && typeof outer.displayName === 'string') return outer.displayName;
  }
  if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
  if (type != null && typeof type === 'object') {
    if (tag === FORWARD_REF) {
      if (typeof type.displayName === 'string') return type.displayName;
      const inner = type.render;
      const name = inner == null ? '' : inner.displayName || inner.name;
      return name ? `ForwardRef(${name})` : 'ForwardRef';
    }
    if (tag === CONTEXT_CONSUMER) {
      const ctx = type._context ?? type;
      return `${ctx.displayName || 'Context'}.Consumer`;
    }
  }
  if (typeof type === 'string') return type;
  return 'Unknown';
}

function segment(name: string, key: unknown): string {
  return key == null ? name : `${name}#${String(key)}`;
}

// Owner path of display names and keys, root first, for example
// "App>Sidebar>SidebarItem#42". React 19 owners can be server component info
// objects, which have a name but no tag.
export function ownerPath(fiber: Fiber, name: string): string {
  const segments = [segment(name, fiber.key)];
  let owner = fiber._debugOwner;
  for (let depth = 0; owner != null && depth < 64; depth++) {
    if (typeof owner.tag === 'number') {
      segments.push(segment(displayName(owner), owner.key));
      owner = owner._debugOwner;
    } else {
      segments.push(segment(typeof owner.name === 'string' ? owner.name : 'Server', owner.key));
      owner = owner.owner;
    }
  }
  return segments.reverse().join('>');
}

export interface Source {
  file: string;
  line: number;
  column: number;
}

const ELEMENT_FACTORY = /(^|\.)(jsxDEV|jsxDEVImpl|jsxs|jsx|jsxProd|createElement|cloneElement|createElementWithValidation|jsxWithValidation)$/;

// The JSX site an element comes from, as its owner path without keys: the
// items of one list share it.
export function siteOf(path: string): string {
  return path.replace(/#[^>]*/g, '');
}

// Where the element for this fiber was created. React 18 records it in
// _debugSource; React 19.1+ keeps an Error captured in the element factory
// (jsxDEV, createElement) in _debugStack, whose first frame past the factory
// is the call site. React 19.0 records neither.
//
// Past React's owner-stack budget (10,000 elements a second in 19.1 to 19.3)
// every element gets one shared placeholder Error, made at load by the JSX
// runtime, whose frames never start in the factory. It says nothing about
// the element, so the source comes from another element of the same JSX
// site if one had a real stack, else it is unknown. React never refreshes a
// fiber's _debugStack, so a component past the budget at mount stays so.
export function sourceOf(s: Shim, fiber: Fiber, path: string): Source | null {
  const src = fiber._debugSource;
  if (src != null && typeof src.fileName === 'string') {
    return { file: src.fileName, line: src.lineNumber ?? 0, column: src.columnNumber ?? 0 };
  }
  const err = fiber._debugStack;
  if (err == null || typeof err !== 'object') return null;
  const site = siteOf(path);
  const frames = parseFrames(String((err as Error).stack ?? ''));
  if (frames.length === 0 || !ELEMENT_FACTORY.test(frames[0]!.fn)) return s.sourceBySite.get(site) ?? null;
  for (const f of frames) {
    if (ELEMENT_FACTORY.test(f.fn)) continue;
    if (f.file === '') return null;
    const found = { file: f.file, line: f.line, column: f.column };
    if (s.sourceBySite.size >= 50_000) s.sourceBySite.clear();
    s.sourceBySite.set(site, found);
    return found;
  }
  return null;
}

// Whether React skips this component's render when its props are equal:
// React.memo (the inner fiber of a MemoComponent, or a SimpleMemoComponent)
// or a PureComponent class.
export function isMemo(fiber: Fiber): boolean {
  if (fiber.tag === SIMPLE_MEMO_COMPONENT) return true;
  if (fiber.return != null && fiber.return.tag === MEMO_COMPONENT) return true;
  return fiber.tag === CLASS_COMPONENT && fiber.type?.prototype?.isPureReactComponent === true;
}

// Stable component_id: a 53-bit hash of the owner path (names and keys) and
// the source location, so it survives reloads. New ids produce a defs row.
export function componentId(s: Shim, fiber: Fiber): string {
  let id = s.idByFiber.get(fiber);
  if (id !== undefined) return id;
  const alt = fiber.alternate;
  if (alt != null) {
    id = s.idByFiber.get(alt);
    if (id !== undefined) {
      s.idByFiber.set(fiber, id);
      return id;
    }
  }
  const name = displayName(fiber);
  const path = ownerPath(fiber, name);
  id = s.idByPath.get(path);
  if (id === undefined) {
    if (s.idByPath.size >= 50_000) s.idByPath.clear();
    const src = sourceOf(s, fiber, path);
    id = hash53(src === null ? path : `${path}|${src.file}:${src.line}:${src.column}`);
    s.idByPath.set(path, id);
    s.defs.push([id, name, src?.file ?? null, src?.line ?? null, src?.column ?? null, path, isMemo(fiber)]);
    s.defBytes += 46 + id.length + name.length + path.length + (src?.file.length ?? 0);
  }
  s.idByFiber.set(fiber, id);
  if (alt != null) s.idByFiber.set(alt, id);
  return id;
}

// cyrb53, a small well-distributed 53-bit string hash.
export function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}
