import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureConfig } from './config.ts';
import { SegmentWriter } from './segments.ts';
import { type Mapped, type SourceMaps, splitFrame } from './sourcemap.ts';

export interface SessionInfo {
  session_id: string;
  target_id: string;
  app_url: string;
  started_at: string;
  ended_at: string | null;
  react_version: string | null;
  renderers: object[];
  shim_version: string | null;
  git_sha: string | null;
  config: CaptureConfig;
  page_loads: { page_load_id: number; url: string; token: string; time_origin: number }[];
  refused: { reason: string; detail: string } | null;
  errors: string[];
  rows: number;
  dropped: number;
}

interface PageLoad {
  id: number;
  timeOrigin: number;
}

// Page-clock ms fields inside `extra`, converted to epoch µs like `ts`.
const TIME_FIELDS: Record<string, string[]> = {
  commit: ['renderStart', 'renderEnd', 'commitStart', 'commitEnd', 'layoutStart', 'layoutEnd', 'passiveStart', 'passiveEnd'],
  event_timing: ['processingStart', 'processingEnd'],
  loaf: ['renderStart', 'styleAndLayoutStart'],
};

export function newSessionId(now = new Date()): string {
  const iso = now.toISOString(); // 2026-09-28T03:12:45.123Z
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

// One capture session: one browser target. Turns shim messages into rows for
// the segment writer. Each execution context that says hello is a page load.
export class Session {
  readonly id: string;
  readonly dir: string;
  readonly writer: SegmentWriter;
  readonly info: SessionInfo;
  private readonly maps: SourceMaps;
  private readonly contexts = new Map<number, PageLoad>();
  private readonly defsSeen = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private saveTimer: NodeJS.Timeout | null = null;
  onRefused: ((reason: string, detail: string) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  constructor(opts: { root: string; targetId: string; url: string; config: CaptureConfig; duckdb: string; maps: SourceMaps; id?: string }) {
    this.id = opts.id ?? newSessionId();
    this.dir = join(opts.root, this.id);
    mkdirSync(this.dir, { recursive: true });
    this.maps = opts.maps;
    this.writer = new SegmentWriter(this.dir, {
      rotateSeconds: opts.config.segments.rotateSeconds,
      rotateRows: opts.config.segments.rotateRows,
      duckdb: opts.duckdb,
      onError: (e) => this.error(e.message),
    });
    this.info = {
      session_id: this.id,
      target_id: opts.targetId,
      app_url: opts.url,
      started_at: new Date().toISOString(),
      ended_at: null,
      react_version: null,
      renderers: [],
      shim_version: null,
      git_sha: gitSha(),
      config: opts.config,
      page_loads: [],
      refused: null,
      errors: [],
      rows: 0,
      dropped: 0,
    };
  }

  async start(): Promise<void> {
    await this.writer.init();
    this.saveNow();
  }

  handle(contextId: number, payload: string): void {
    let msg: any;
    try {
      msg = JSON.parse(payload);
    } catch {
      this.error('unparseable shim message');
      return;
    }
    switch (msg.t) {
      case 'hello': {
        const id = this.info.page_loads.length + 1;
        this.contexts.set(contextId, { id, timeOrigin: msg.timeOrigin });
        this.info.page_loads.push({ page_load_id: id, url: msg.url, token: msg.token, time_origin: msg.timeOrigin });
        this.info.shim_version = msg.shim;
        if (this.info.app_url === '' || this.info.app_url === 'about:blank') this.info.app_url = msg.url;
        this.save();
        return;
      }
      case 'renderer':
        this.info.renderers.push(msg);
        this.info.react_version ??= msg.version;
        this.save();
        return;
      case 'refused':
        this.info.refused = { reason: msg.reason, detail: msg.detail };
        this.save();
        this.onRefused?.(msg.reason, msg.detail);
        return;
      case 'error':
        this.error(`shim: ${msg.message}`);
        return;
      case 'batch': {
        const page = this.contexts.get(contextId);
        if (page === undefined) {
          this.error('batch from a page that never said hello; was the shim injected after load? Use --reload.');
          return;
        }
        for (const d of msg.defs) this.def(d);
        for (const r of msg.rows) this.event(page, r);
        if (msg.dropped > 0) {
          this.info.dropped += msg.dropped;
          this.writeEvent(page, { kind: 'dropped', ts: Math.round(Date.now() * 1000), extra: { count: msg.dropped } });
          this.save();
        }
        return;
      }
      default:
        return;
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.pending);
    await this.writer.close();
    this.info.ended_at = new Date().toISOString();
    this.saveNow();
  }

  private def(d: any[]): void {
    const [id, name, file, line, column, path] = d;
    if (this.defsSeen.has(id)) return;
    if (this.defsSeen.size >= 200_000) this.defsSeen.clear();
    this.defsSeen.add(id);
    const write = (m: Mapped | null) =>
      this.writer.write('defs', {
        component_id: id,
        display_name: name,
        source_file: m === null ? file : m.file,
        source_line: m === null ? line : m.line,
        source_column: m === null ? column : m.column,
        owner_path: path,
      });
    if (typeof file === 'string' && /^https?:\/\//.test(file) && typeof line === 'number') {
      this.mapped(file, line, column ?? 1, write);
    } else {
      write(null);
    }
  }

  private event(page: PageLoad, r: any[]): void {
    const [kind, ts, dur, self, lane, componentId, commit, reason, hooks, context, keys, committed, callSite, extra] = r;
    const row: Record<string, unknown> = {
      kind,
      ts: ts === null ? null : Math.round((page.timeOrigin + ts) * 1000),
      dur_us: dur,
      self_us: self,
      lane,
      component_id: componentId,
      commit_id: commit === null ? null : `${this.id}.${page.id}.${commit}`,
      reason_code: reason,
      changed_hooks: hooks,
      changed_context: context,
      changed_keys: keys,
      committed,
      call_site: callSite,
      extra: extra === null ? null : this.epochExtra(page, kind, extra),
    };
    const frame = typeof callSite === 'string' ? splitFrame(callSite) : null;
    if (frame !== null && /^https?:\/\//.test(frame.url)) {
      this.mapped(frame.url, frame.line, frame.column, (m) => {
        if (m !== null) row.call_site = `${frame.fn ?? m.name ?? '<anonymous>'} (${m.file}:${m.line}:${m.column})`;
        this.writeEvent(page, row);
      });
    } else {
      this.writeEvent(page, row);
    }
  }

  private epochExtra(page: PageLoad, kind: string, extra: any): object {
    const fields = TIME_FIELDS[kind];
    if (fields === undefined && kind !== 'loaf') return extra;
    const out = { ...extra };
    for (const f of fields ?? []) if (typeof out[f] === 'number') out[f] = Math.round((page.timeOrigin + out[f]) * 1000);
    if (kind === 'loaf' && Array.isArray(out.scripts)) {
      out.scripts = out.scripts.map((s: any) => (typeof s.start === 'number' ? { ...s, start: Math.round((page.timeOrigin + s.start) * 1000) } : s));
    }
    return out;
  }

  private writeEvent(page: PageLoad, row: Record<string, unknown>): void {
    this.writer.write('seg', {
      session_id: this.id,
      page_load_id: page.id,
      root_update_id: null,
      measure_instance_id: null,
      on_critical_path: null,
      ...row,
    });
    this.info.rows++;
  }

  // Runs write with the original-source position, synchronously when the
  // script's source map is already loaded.
  private mapped(url: string, line: number, column: number, write: (m: Mapped | null) => void): void {
    const hit = this.maps.peek(url, line, column);
    if (hit !== undefined) {
      write(hit);
      return;
    }
    const p = this.maps.resolve(url, line, column).then(write, () => write(null));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private error(message: string): void {
    if (this.info.errors.length < 50) this.info.errors.push(message);
    this.onError?.(message);
    this.save();
  }

  private save(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 500);
    this.saveTimer.unref();
  }

  private saveNow(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const file = join(this.dir, 'session.json');
    writeFileSync(`${file}.tmp`, `${JSON.stringify(this.info, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }
}
