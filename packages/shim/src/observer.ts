import { report } from './adapters.ts';
import { K_ENTRY } from './ring.ts';
import { now, type Shim } from './state.ts';

// Event Timing, mark and long-animation-frame entries go into the same ring.
// Observer callbacks run after the fact, outside the interaction, but can run
// before the next frame, so they count as shim tasks. Event Timing only
// reports interactions of 16 ms or longer, its minimum durationThreshold.
// Measures are not observed: React 19.2+ logs one per re-rendered component,
// thousands per commit, so the performance.measure wrapper records the app's
// own measures instead (adapters.ts).
export function installObserver(s: Shim): void {
  const PO = s.g.PerformanceObserver;
  if (typeof PO !== 'function' || s.config.observe.length === 0) return;
  const supported: readonly string[] = Array.isArray(PO.supportedEntryTypes) ? PO.supportedEntryTypes : [];
  const observer = new PO((list: PerformanceObserverEntryList) => {
    const t0 = now();
    try {
      for (const e of list.getEntries()) recordEntry(s, e);
    } catch (e) {
      report(s, e);
    }
    const dt = now() - t0;
    if (dt > s.stats.maxObserverMs) s.stats.maxObserverMs = dt;
    if (dt > s.stats.maxTaskMs) s.stats.maxTaskMs = dt;
  });
  for (const type of s.config.observe) {
    if (type === 'measure' || !supported.includes(type)) continue;
    try {
      observer.observe(type === 'event' ? { type, buffered: true, durationThreshold: 16 } : { type, buffered: true });
    } catch {
      // Unsupported option on this browser: skip the type.
    }
  }
}

export function recordEntry(s: Shim, e: PerformanceEntry): void {
  if (e.entryType === 'event' && !((e as PerformanceEventTiming).interactionId > 0)) return;
  const i = s.ring.alloc(K_ENTRY);
  if (i < 0) return;
  s.ring.t0[i] = e.startTime;
  s.ring.t1[i] = e.duration;
  s.ring.r0[i] = e;
}
