import { installTracks, profilingHooks, report } from './adapters.ts';
import { lineFor } from './constants.ts';
import { installObserver } from './observer.ts';
import { flushNow, post, scheduleIdle } from './pipeline.ts';
import { K_WATCH } from './ring.ts';
import { type Config, createShim, DEFAULT_CONFIG, now, type Renderer, type Shim, type Stats } from './state.ts';
import { onCommit, onPostCommit, onUnmount } from './walk.ts';

export const SHIM_VERSION = '0.1.0';

export interface ShimApi {
  status: 'active' | 'refused';
  reason: string | null;
  version: string;
  stats: Stats;
  config: Config;
  flushNow(): void;
  // Records waiting to be flushed.
  pending(): number;
}

const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

// Installs the shim on a global object before any React code runs. Returns
// the API exposed as window.__reactLog. Config comes from overrides, then
// window.__reactLogConfig (set by the capture program), then defaults.
export function install(g: any, overrides: Partial<Config> = {}): ShimApi {
  if (g.__reactLog != null) return g.__reactLog as ShimApi;
  const config: Config = { ...DEFAULT_CONFIG, ...(g.__reactLogConfig ?? {}), ...overrides };
  const s = createShim(g, config);
  const api: ShimApi = {
    status: 'active',
    reason: null,
    version: SHIM_VERSION,
    stats: s.stats,
    config,
    flushNow: () => flushNow(s),
    pending: () => s.ring.count + s.outbox.length,
  };
  Object.defineProperty(g, '__reactLog', { value: api, configurable: true });

  if (Object.prototype.hasOwnProperty.call(g, HOOK)) {
    refuse(s, api, 'devtools-hook-present', 'A __REACT_DEVTOOLS_GLOBAL_HOOK__ already exists, most likely from the React DevTools extension. Disable the extension in the capture profile: react-log replaces it.');
    startFlusher(s);
    return api;
  }

  installTracks(s);
  installHook(s);
  installObserver(s);
  installWatch(s);
  post(s, {
    t: 'hello',
    v: 1,
    shim: SHIM_VERSION,
    url: String(g.location?.href ?? ''),
    timeOrigin: performance.timeOrigin,
    token: Math.random().toString(36).slice(2),
  });
  startFlusher(s);
  return api;
}

function refuse(s: Shim, api: ShimApi, reason: string, detail: string): void {
  api.status = 'refused';
  api.reason = reason;
  post(s, { t: 'refused', reason, detail });
}

function installHook(s: Shim): void {
  let nextId = 0;
  const renderers = new Map<number, unknown>();
  const hook = {
    __reactLog: true,
    renderers,
    supportsFiber: true,
    inject(internals: any): number {
      const id = ++nextId;
      renderers.set(id, internals);
      try {
        onInject(s, id, internals);
      } catch (e) {
        report(s, e);
      }
      return id;
    },
    onCommitFiberRoot(id: number, root: any, priority?: number, didError?: boolean): void {
      const r = s.renderers.get(id);
      if (r === undefined) return;
      try {
        onCommit(s, r, root, priority, didError);
      } catch (e) {
        report(s, e);
      }
    },
    onPostCommitFiberRoot(id: number): void {
      if (!s.renderers.has(id)) return;
      try {
        onPostCommit(s);
      } catch (e) {
        report(s, e);
      }
    },
    onScheduleFiberRoot(): void {},
    onCommitFiberUnmount(id: number, fiber: any): void {
      if (!s.renderers.has(id)) return;
      try {
        onUnmount(s, fiber);
      } catch (e) {
        report(s, e);
      }
    },
    setStrictMode(): void {},
    checkDCE(): void {},
  };
  Object.defineProperty(s.g, HOOK, { value: hook, configurable: true, enumerable: false, writable: true });
}

// A page can hold several Reacts (an embedded widget, a second bundle). A
// production or unsupported one is reported and left alone; the page's
// development Reacts are recorded all the same.
function onInject(s: Shim, id: number, internals: any): void {
  const version = String(internals?.version ?? '');
  const line = lineFor(version);
  const skipped = internals?.bundleType !== 1 ? 'not-a-dev-build' : line === null ? 'unsupported-react-version' : null;
  post(s, {
    t: 'renderer',
    id,
    version,
    line: line?.id ?? null,
    bundleType: internals?.bundleType ?? null,
    package: internals?.rendererPackageName ?? null,
    skipped,
  });
  if (line === null || skipped !== null) return;
  const labels = typeof internals.getLaneLabelMap === 'function' ? internals.getLaneLabelMap() : null;
  const r: Renderer = { id, version, line, internals, laneLabels: labels instanceof Map ? labels : null };
  s.renderers.set(id, r);
  if (line.profilingHooks && typeof internals.injectProfilingHooks === 'function') {
    internals.injectProfilingHooks(profilingHooks(s, r));
  }
  if (line.id === '19.2+' && s.tracksRenderer === null) s.tracksRenderer = r;
}

// window.__reactLogWatch holds component names or ids whose changed prop keys
// get classified as identity_only or value. Setting it records a watch row.
function installWatch(s: Shim): void {
  Object.defineProperty(s.g, '__reactLogWatch', {
    configurable: true,
    get: () => [...s.watch],
    set: (value: unknown) => {
      s.watch = new Set(Array.isArray(value) ? value.map(String) : []);
      const i = s.ring.alloc(K_WATCH);
      if (i >= 0) {
        s.ring.t0[i] = now();
        s.ring.r0[i] = [...s.watch];
      }
    },
  });
}

function startFlusher(s: Shim): void {
  const timer = setInterval(() => {
    if (s.ring.count > 0 || s.outbox.length > 0 || s.pendingTasks.length > 0) scheduleIdle(s);
  }, s.config.flushIntervalMs) as unknown as { unref?: () => void };
  timer.unref?.();
  const g = s.g;
  if (typeof g.addEventListener === 'function') g.addEventListener('pagehide', () => flushNow(s));
  scheduleIdle(s);
}
