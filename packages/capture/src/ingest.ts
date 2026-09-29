import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CaptureConfig } from './config.ts';
import { PageRollup, type RollupOutput, type SegRow } from './rollup.ts';
import { SegmentWriter } from './segments.ts';
import type { Mapped, SourceMaps } from './sourcemap.ts';
import { type ResolvedStack, resolveStack, resolveStackSync } from './stacks.ts';

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
  git_dirty: boolean | null;
  config: CaptureConfig;
  page_loads: { page_load_id: number; url: string; token: string; time_origin: number }[];
  refused: { reason: string; detail: string } | null;
  errors: string[];
  rows: number;
  commits: number;
  measures: number;
  dropped: number;
  // The most records a page of the session held before capture took them.
  buffer_peak: number;
}

interface PageLoad {
  id: number;
  timeOrigin: number;
  rollup: PageRollup;
  // Rows reach the rollup in page order; a row that waits for a source map
  // holds the ones behind it.
  tail: Promise<void>;
  waiting: number;
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

type GitState = { git_sha: string | null; git_dirty: boolean | null };
let gitAsked: Promise<GitState> | null = null;

// The commit capture runs from, and whether tracked files had changes on top
// of it, as a fix under test does before it is committed. Asked once per
// capture and off the event loop: git status can take seconds in a large
// repository, while capture is holding a new tab's document.
function gitState(): Promise<GitState> {
  gitAsked ??= (async () => {
    const git = async (...args: string[]) => (await promisify(execFile)('git', args, { timeout: 10_000 })).stdout;
    let sha: string | null;
    try {
      sha = (await git('rev-parse', 'HEAD')).trim() || null;
    } catch {
      return { git_sha: null, git_dirty: null };
    }
    try {
      return { git_sha: sha, git_dirty: (await git('status', '--porcelain', '--untracked-files=no')).trim() !== '' };
    } catch {
      return { git_sha: sha, git_dirty: null };
    }
  })();
  return gitAsked;
}

// What the shim was doing in a capture slice (pipeline.ts SLICE_*).
const SLICE_KINDS = ['idle', 'task', 'spill', 'walk'];

// One capture session: one browser target. Turns shim messages into rows,
// links and rolls them up per page load (rollup.ts), and hands them to the
// segment writer. Each execution context that says hello is a page load.
export class Session {
  readonly id: string;
  readonly dir: string;
  readonly writer: SegmentWriter;
  readonly info: SessionInfo;
  private readonly maps: SourceMaps;
  private readonly contexts = new Map<number, PageLoad>();
  private readonly defsSeen = new Set<string>();
  // component_id to display name, for the rollups' top types and producers.
  private readonly names = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();
  private saveTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
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
      git_sha: null,
      git_dirty: null,
      config: opts.config,
      page_loads: [],
      refused: null,
      errors: [],
      rows: 0,
      commits: 0,
      measures: 0,
      dropped: 0,
      buffer_peak: 0,
    };
    const git = gitState().then((g) => {
      Object.assign(this.info, g);
      this.save();
    });
    this.pending.add(git);
    void git.finally(() => this.pending.delete(git));
  }

  async start(): Promise<void> {
    await this.writer.init();
    this.drainTimer = setInterval(() => this.drain(false), 1000);
    this.drainTimer.unref();
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
        const rollup = new PageRollup({ sessionId: this.id, pageLoadId: id, names: this.names, marks: this.info.config.measures });
        this.contexts.set(contextId, { id, timeOrigin: msg.timeOrigin, rollup, tail: Promise.resolve(), waiting: 0 });
        this.info.page_loads.push({ page_load_id: id, url: msg.url, token: msg.token, time_origin: msg.timeOrigin });
        this.info.shim_version = msg.shim;
        if (this.info.app_url === '' || this.info.app_url === 'about:blank') this.info.app_url = msg.url;
        this.save();
        return;
      }
      case 'renderer':
        this.info.renderers.push(msg);
        if (msg.skipped == null) this.info.react_version ??= msg.version;
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
        if (typeof msg.peak === 'number' && msg.peak > this.info.buffer_peak) this.info.buffer_peak = msg.peak;
        // The shim's own main-thread work: measures count it as capture's.
        const slices: unknown[] = Array.isArray(msg.slices) ? msg.slices : [];
        for (let k = 0; k + 2 < slices.length; k += 3) {
          const [a, b, how] = slices.slice(k, k + 3) as number[];
          if (typeof a !== 'number' || typeof b !== 'number' || !(b >= a)) continue;
          this.enqueue(
            page,
            this.row(page, { kind: 'capture', ts: Math.round((page.timeOrigin + a) * 1000), dur_us: Math.round((b - a) * 1000), extra: { how: SLICE_KINDS[how!] ?? 'other' } }),
            null,
          );
        }
        if (msg.dropped > 0) {
          this.info.dropped += msg.dropped;
          this.enqueue(page, this.row(page, { kind: 'dropped', ts: Math.round(Date.now() * 1000), extra: { count: msg.dropped } }), null);
          this.save();
        }
        return;
      }
      default:
        return;
    }
  }

  // Everything final goes to the writer; with all, everything held.
  drain(all: boolean): void {
    const now = Date.now();
    for (const page of this.contexts.values()) {
      if (all || page.waiting === 0) this.write(page.rollup.drain(now, all));
    }
  }

  async close(): Promise<void> {
    if (this.drainTimer !== null) clearInterval(this.drainTimer);
    this.drainTimer = null;
    await Promise.all([...this.contexts.values()].map((p) => p.tail));
    this.drain(true);
    await Promise.all(this.pending);
    await this.writer.close();
    this.info.ended_at = new Date().toISOString();
    this.saveNow();
  }

  private write(out: RollupOutput): void {
    for (const r of out.seg) this.writer.write('seg', r);
    for (const c of out.commits) this.writer.write('commits', c);
    for (const m of out.measures) this.writer.write('measures', m);
    this.info.rows += out.seg.length;
    this.info.commits += out.commits.length;
    this.info.measures += out.measures.length;
  }

  private def(d: any[]): void {
    const [id, name, file, line, column, path, memo] = d;
    if (typeof name === 'string') this.names.set(id, name);
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
        memo: typeof memo === 'boolean' ? memo : null,
      });
    if (typeof file === 'string' && /^https?:\/\//.test(file) && typeof line === 'number') {
      const hit = this.maps.peek(file, line, column ?? 1);
      if (hit !== undefined) {
        write(hit);
        return;
      }
      const p = this.maps.resolve(file, line, column ?? 1).then(write, () => write(null));
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    } else {
      write(null);
    }
  }

  private row(page: PageLoad, fields: Partial<SegRow> & { kind: string }): SegRow {
    return {
      session_id: this.id,
      page_load_id: page.id,
      ts: null,
      dur_us: null,
      self_us: null,
      lane: null,
      component_id: null,
      commit_id: null,
      reason_code: null,
      changed_hooks: null,
      changed_context: null,
      changed_keys: null,
      committed: null,
      root_update_id: null,
      measure_instance_id: null,
      on_critical_path: null,
      call_site: null,
      extra: null,
      ...fields,
    };
  }

  private event(page: PageLoad, r: any[]): void {
    const [kind, ts, dur, self, lane, componentId, commit, reason, hooks, context, keys, committed, callSite, extra] = r;
    const row = this.row(page, {
      kind,
      ts: ts === null ? null : Math.round((page.timeOrigin + ts) * 1000),
      dur_us: dur,
      self_us: self,
      lane,
      component_id: componentId,
      commit_id: commit === null ? null : this.commitId(page, commit),
      reason_code: reason,
      changed_hooks: hooks,
      changed_context: context,
      changed_keys: keys,
      committed,
      call_site: callSite,
      extra: extra === null ? null : this.epochExtra(page, kind, extra),
    });
    let prep: Promise<void> | null = null;
    if (kind === 'update_enqueued' && row.extra !== null) {
      if (typeof row.extra.during === 'number') row.extra.during = this.commitId(page, row.extra.during);
      const text = row.extra.stack;
      if (typeof text === 'string') {
        const now = resolveStackSync(this.maps, text);
        if (now !== null) this.applyStack(row, now);
        else prep = resolveStack(this.maps, text).then((s) => this.applyStack(row, s));
      }
    }
    this.enqueue(page, row, prep);
  }

  private commitId(page: PageLoad, n: number): string {
    return `${this.id}.${page.id}.${n}`;
  }

  // The call site and phase come from the stack; every frame is kept, mapped.
  private applyStack(row: SegRow, s: ResolvedStack): void {
    row.call_site = s.callSite;
    row.extra.stack = s.frames;
    if ((row.extra.phase === null || row.extra.phase === 'cascade') && s.phase !== null) row.extra.phase = s.phase;
  }

  private enqueue(page: PageLoad, row: SegRow, prep: Promise<void> | null): void {
    if (prep === null && page.waiting === 0) {
      page.rollup.push(row, Date.now());
      return;
    }
    page.waiting++;
    page.tail = page.tail
      .then(() => prep)
      .catch((e) => this.error(`stack: ${(e as Error).message}`))
      .then(() => {
        page.rollup.push(row, Date.now());
        page.waiting--;
      });
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
