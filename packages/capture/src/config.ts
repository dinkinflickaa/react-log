import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface MeasureConfig {
  name: string;
  start: string;
  end: string;
}

export interface CaptureConfig {
  cdp: string;
  urlMatch: string;
  launch: { chromePath: string | null; userDataDir: string; isolate: boolean };
  interactions: { eventTiming: boolean };
  measures: MeasureConfig[];
  // ringHigh: records the page holds before capture takes them synchronously
  // (about 250 bytes of page memory each, plus about 1 KB for an update's
  // stack until it is handed over).
  record: { compositeOnly: boolean; values: boolean; stacksOn: string[]; watch: string[]; ringHigh: number };
  segments: { dir: string; rotateSeconds: number; rotateRows: number };
}

export const DEFAULTS: CaptureConfig = {
  cdp: 'http://localhost:9222',
  // Empty: every tab and iframe running a development React is recorded.
  urlMatch: '',
  launch: { chromePath: null, userDataDir: '~/.react-log/profile', isolate: false },
  interactions: { eventTiming: true },
  measures: [],
  record: { compositeOnly: true, values: false, stacksOn: ['update'], watch: [], ringHigh: 250_000 },
  segments: { dir: './segments', rotateSeconds: 10, rotateRows: 200_000 },
};

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p;
}

// Defaults, then react-log.config.json (or the given path) one level deep.
export function loadConfig(path?: string): CaptureConfig {
  const file = resolve(path ?? 'react-log.config.json');
  if (path !== undefined && !existsSync(file)) throw new Error(`config file not found: ${file}`);
  const raw: Partial<CaptureConfig> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    cdp: raw.cdp ?? DEFAULTS.cdp,
    urlMatch: raw.urlMatch ?? DEFAULTS.urlMatch,
    launch: { ...DEFAULTS.launch, ...raw.launch },
    interactions: { ...DEFAULTS.interactions, ...raw.interactions },
    measures: raw.measures ?? DEFAULTS.measures,
    record: { ...DEFAULTS.record, ...raw.record },
    segments: { ...DEFAULTS.segments, ...raw.segments },
  };
}

// What the page-side shim reads from window.__reactLogConfig.
export function shimConfig(config: CaptureConfig): object {
  return {
    updateStacks: config.record.stacksOn.includes('update'),
    watch: config.record.watch,
    ringHigh: config.record.ringHigh,
    observe: ['mark', 'measure', 'long-animation-frame', ...(config.interactions.eventTiming ? ['event'] : [])],
  };
}
