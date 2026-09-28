import { report } from './adapters.ts';
import { K_ENTRY } from './ring.ts';
import type { Shim } from './state.ts';

// Event Timing, mark, measure and long-animation-frame entries go into the
// same ring. Observer callbacks run after the fact, outside the interaction.
// Event Timing only reports interactions of 16 ms or longer, its minimum
// durationThreshold.
export function installObserver(s: Shim): void {
  const PO = s.g.PerformanceObserver;
  if (typeof PO !== 'function') return;
  const supported: readonly string[] = Array.isArray(PO.supportedEntryTypes) ? PO.supportedEntryTypes : [];
  const observer = new PO((list: PerformanceObserverEntryList) => {
    try {
      for (const e of list.getEntries()) record(s, e);
    } catch (e) {
      report(s, e);
    }
  });
  for (const type of ['event', 'mark', 'measure', 'long-animation-frame']) {
    if (!supported.includes(type)) continue;
    try {
      observer.observe(type === 'event' ? { type, buffered: true, durationThreshold: 16 } : { type, buffered: true });
    } catch {
      // Unsupported option on this browser: skip the type.
    }
  }
}

function record(s: Shim, e: PerformanceEntry): void {
  if (e.entryType === 'event') {
    if (!((e as PerformanceEventTiming).interactionId > 0)) return;
  } else if (e.entryType === 'measure') {
    // React's own measures: per-component (zero-width space prefix) and the
    // ones that carry DevTools track details.
    if (e.name.charCodeAt(0) === 0x200b || s.devtoolsMeasures.has(e.name)) return;
  }
  const i = s.ring.alloc(K_ENTRY);
  if (i < 0) return;
  s.ring.t0[i] = e.startTime;
  s.ring.t1[i] = e.duration;
  s.ring.r0[i] = e;
}
