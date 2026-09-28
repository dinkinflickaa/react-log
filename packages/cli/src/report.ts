import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// react-log sessions, top, card and query: read a segments directory with
// the DuckDB CLI. Every command loads the same views (events, defs, commits,
// measures), over one session's files when it names one, else over all.

const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function viewsSql(dir: string, session?: string): string {
  const root = session === undefined ? `${dir}/*` : `${dir}/${session}`;
  const files = (family: string) => sq(`${root}/${family}-*.parquet`);
  return `
CREATE OR REPLACE VIEW events AS SELECT * FROM read_parquet(${files('seg')});
CREATE OR REPLACE VIEW defs AS
  SELECT component_id, any_value(display_name) AS display_name, any_value(source_file) AS source_file,
         any_value(source_line) AS source_line, any_value(owner_path) AS owner_path
  FROM read_parquet(${files('defs')}) GROUP BY component_id;
CREATE OR REPLACE VIEW commits AS SELECT * FROM read_parquet(${files('commits')});
CREATE OR REPLACE VIEW measures AS SELECT * FROM read_parquet(${files('measures')});
`;
}

// Runs statements; returns the rows of every statement that selects a
// `section` column, grouped by it.
function sections(duckdb: string, sql: string): Map<string, any[]> {
  const out = execFileSync(duckdb, ['-jsonlines', ':memory:', '-c', sql], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const bySection = new Map<string, any[]>();
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line);
    const list = bySection.get(row.section) ?? [];
    list.push(row);
    bySection.set(row.section, list);
  }
  return bySection;
}

function duckdbError(e: unknown): Error {
  const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
  return new Error(stderr !== undefined && stderr !== '' ? stderr.split('\n').slice(0, 3).join(' ') : (e as Error).message);
}

// ---- formatting

// DuckDB's JSON output gives DECIMAL and HUGEINT values as strings.
const int = (n: unknown) => (n == null ? '' : Math.round(Number(n)).toLocaleString('en-US'));
const ms = (n: unknown, digits = 1) => (n == null ? '' : Number(n).toFixed(digits));
const share = (n: unknown) => (n == null ? '' : Number(n).toFixed(2));

// The last two path segments: enough to find a file, short enough for a table.
function shortFile(file: string | null | undefined, line?: number | null): string {
  if (file == null) return '';
  const parts = file.split(/[\\/]/);
  const tail = parts.slice(-2).join('/');
  return line == null ? tail : `${tail}:${line}`;
}

// "fn (path/to/file.jsx:12:5)" with the path shortened.
function shortSite(site: string | null | undefined): string {
  if (site == null) return '';
  const m = /^(.*?) \((.*):(\d+):(\d+)\)$/.exec(site);
  return m === null ? site : `${m[1]} (${shortFile(m[2])}:${m[3]}:${m[4]})`;
}

interface Column {
  title: string;
  right?: boolean;
}

export function table(columns: Column[], rows: string[][]): string[] {
  const widths = columns.map((c, i) => Math.max(c.title.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (columns[i]!.right === true ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(columns.map((c) => c.title)), ...rows.map(line)];
}

// ---- sessions

export interface SessionSummary {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  app_url: string;
  react_version: string | null;
  page_loads: unknown[];
  rows: number;
  commits?: number;
  measures?: number;
  dropped: number;
}

export function listSessions(dir: string): SessionSummary[] {
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'session.json');
    if (!existsSync(file)) continue;
    try {
      out.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // A session.json being replaced right now; the next run sees it.
    }
  }
  return out.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function sessionsText(dir: string): string {
  const list = listSessions(dir);
  if (list.length === 0) return `No sessions in ${dir}.\n`;
  const when = (iso: string) => iso.replace('T', ' ').slice(0, 19);
  const rows = list.map((s) => [
    s.session_id,
    when(s.started_at),
    s.ended_at === null ? 'capturing' : 'ended',
    s.react_version ?? '',
    String(s.page_loads.length),
    int(s.rows),
    int(s.commits ?? 0),
    int(s.measures ?? 0),
    int(s.dropped),
    s.app_url,
  ]);
  const cols: Column[] = [
    { title: 'session' },
    { title: 'started (UTC)' },
    { title: 'state' },
    { title: 'react' },
    { title: 'loads', right: true },
    { title: 'rows', right: true },
    { title: 'commits', right: true },
    { title: 'measures', right: true },
    { title: 'dropped', right: true },
    { title: 'url' },
  ];
  return `${table(cols, rows).join('\n')}\n`;
}

// ---- top

export function topText(duckdb: string, dir: string, session: string, opts: { measure?: string; limit?: number } = {}): string {
  if (!existsSync(join(dir, session))) throw new Error(`no session ${session} in ${dir}`);
  const limit = opts.limit ?? 20;
  const filter = opts.measure === undefined ? 'TRUE' : `(m.name = ${sq(opts.measure)} OR c.measure_instance_id = ${sq(opts.measure)})`;
  let data: Map<string, any[]>;
  try {
    data = sections(
      duckdb,
      `${viewsSql(dir, session)}
SELECT 'summary' AS section, count(*) AS commits, quantile_cont(total_ms, 0.5) AS p50, quantile_cont(total_ms, 0.95) AS p95 FROM commits;
SELECT 'measures' AS section, name, count(*) AS n, quantile_cont(duration_ms, 0.5) AS p50, quantile_cont(duration_ms, 0.9) AS p90,
       quantile_cont(on_path_ms, 0.5) AS on_p50
  FROM measures GROUP BY name ORDER BY p50 DESC;
SELECT 'top' AS section, c.commit_id, c.total_ms, c.render_ms, c.layout_ms, c.passive_ms, c.on_critical_path, m.name AS measure,
       c.trigger_event, p.display_name AS producer, c.rendered, c.noop, c.top_type, c.top_type_count,
       c.top1_share, c.noop_share, c.effect_share, c.signature
  FROM commits c
  LEFT JOIN defs p ON p.component_id = c.producer_component_id
  LEFT JOIN measures m ON m.measure_instance_id = c.measure_instance_id
  WHERE ${filter}
  ORDER BY c.total_ms DESC LIMIT ${limit};`,
    );
  } catch (e) {
    throw duckdbError(e);
  }
  const s = data.get('summary')?.[0] ?? { commits: 0 };
  const lines = [`session ${session}: ${int(s.commits)} commits, p50 ${ms(s.p50)} ms, p95 ${ms(s.p95)} ms`];
  const measures = data.get('measures') ?? [];
  if (measures.length > 0) {
    lines.push(`measures: ${measures.map((m) => `${m.name} x${m.n} (p50 ${ms(m.p50)} ms, p90 ${ms(m.p90)} ms, on path p50 ${ms(m.on_p50)} ms)`).join('; ')}`);
  }
  const top = data.get('top') ?? [];
  if (top.length === 0) {
    lines.push('', opts.measure === undefined ? 'No commits.' : `No commits in measure ${opts.measure}.`);
    return `${lines.join('\n')}\n`;
  }
  const cols: Column[] = [
    { title: 'commit' },
    { title: 'total', right: true },
    { title: 'render', right: true },
    { title: 'layout', right: true },
    { title: 'passive', right: true },
    { title: 'path' },
    { title: 'measure' },
    { title: 'trigger' },
    { title: 'producer' },
    { title: 'rendered', right: true },
    { title: 'noop', right: true },
    { title: 'top type' },
    { title: 'top1', right: true },
    { title: 'noop', right: true },
    { title: 'effect', right: true },
    { title: 'signature' },
  ];
  const rows = top.map((c) => [
    c.commit_id,
    ms(c.total_ms),
    ms(c.render_ms),
    ms(c.layout_ms),
    ms(c.passive_ms),
    c.on_critical_path === true ? 'on' : c.on_critical_path === false ? 'off' : '',
    c.measure ?? '',
    c.trigger_event ?? '',
    c.producer ?? '',
    int(c.rendered),
    int(c.noop),
    c.top_type === null ? '' : `${c.top_type} x${int(c.top_type_count)}`,
    share(c.top1_share),
    share(c.noop_share),
    share(c.effect_share),
    c.signature,
  ]);
  lines.push('', 'times in ms; path: on or off the measure\'s critical path; top1, noop, effect: shares of total', ...table(cols, rows));
  return `${lines.join('\n')}\n`;
}

// ---- card

// A commit id is <session>.<page load>.<n>; session ids have no dots.
export function sessionOf(commitId: string): string {
  const dot = commitId.indexOf('.');
  if (dot <= 0) throw new Error(`not a commit id: ${commitId}`);
  return commitId.slice(0, dot);
}

export function cardText(duckdb: string, dir: string, commitId: string): string {
  const session = sessionOf(commitId);
  if (!existsSync(join(dir, session))) throw new Error(`no session ${session} in ${dir}`);
  const cid = sq(commitId);
  let data: Map<string, any[]>;
  try {
    data = sections(
      duckdb,
      `${viewsSql(dir, session)}
CREATE TEMP TABLE h AS
  SELECT c.*, p.display_name AS producer_name, t.display_name AS top1_name,
         m.name AS m_name, m.target AS m_target, m.duration_ms AS m_duration, m.on_path_ms AS m_on,
         m.interference_ms AS m_interference, m.waiting_ms AS m_waiting
  FROM commits c
  LEFT JOIN defs p ON p.component_id = c.producer_component_id
  LEFT JOIN defs t ON t.component_id = c.top1_component_id
  LEFT JOIN measures m ON m.measure_instance_id = c.measure_instance_id
  WHERE c.commit_id = ${cid};
-- One pass over the events: this commit's rows, and its chain's updates and commits.
CREATE TEMP TABLE r AS
  SELECT * FROM events
  WHERE commit_id = ${cid} OR (root_update_id = (SELECT root_update_id FROM h) AND kind IN ('update_enqueued', 'commit'));
SELECT 'header' AS section, * FROM h;
SELECT 'self' AS section, d.display_name AS name, d.source_file AS file, d.source_line AS line,
       count(*) AS renders, count(*) FILTER (r.committed) AS committed, sum(r.self_us) / 1000.0 AS self_ms,
       mode(r.reason_code) AS reason, mode(coalesce(r.changed_keys, r.changed_hooks, r.changed_context)) AS changed
  FROM r LEFT JOIN defs d USING (component_id)
  WHERE r.kind = 'render' AND r.commit_id = ${cid}
  GROUP BY 2, 3, 4 ORDER BY self_ms DESC LIMIT 5;
SELECT 'effects' AS section, r.kind, d.display_name AS name, d.source_file AS file, d.source_line AS line,
       count(*) AS runs, sum(r.dur_us) / 1000.0 AS ms
  FROM r LEFT JOIN defs d USING (component_id)
  WHERE r.kind IN ('layout_effect', 'passive_effect') AND r.commit_id = ${cid}
  GROUP BY 2, 3, 4, 5 ORDER BY ms DESC LIMIT 5;
SELECT 'reasons' AS section, coalesce(reason_code, 'unknown') AS reason, count(*) AS n
  FROM r WHERE kind = 'render' AND commit_id = ${cid} GROUP BY 2 ORDER BY n DESC;
SELECT 'updates' AS section, r.ts, r.call_site, r.extra->>'event' AS event, r.extra->>'phase' AS phase,
       r.extra->>'method' AS method, r.extra->>'label' AS label, coalesce(d.display_name, r.extra->>'component') AS component
  FROM r LEFT JOIN defs d USING (component_id)
  WHERE r.kind = 'update_enqueued' ORDER BY r.ts LIMIT 40;
SELECT 'commits' AS section, c.commit_id, c.ts, c.total_ms, c.cascade_commit_id, p.display_name AS producer
  FROM commits c LEFT JOIN defs p ON p.component_id = c.producer_component_id
  WHERE c.root_update_id = (SELECT root_update_id FROM h) ORDER BY c.ts LIMIT 40;`,
    );
  } catch (e) {
    throw duckdbError(e);
  }
  const h = data.get('header')?.[0];
  if (h === undefined) throw new Error(`no commit ${commitId} in ${join(dir, session)}`);

  const out: string[] = [];
  const yesNo = (b: boolean | null) => (b === true ? 'yes' : b === false ? 'no' : 'unknown');
  out.push(`commit ${h.commit_id}  ${h.signature}  lane ${h.lane ?? 'unknown'}  strict mode ${yesNo(h.strict_mode)}`);
  const passiveTask = h.passive_sync === true ? ', passive effects in the commit task' : h.passive_sync === false ? ', passive effects after paint' : '';
  out.push(`total ${ms(h.total_ms)} ms = render ${ms(h.render_ms)} + layout ${ms(h.layout_ms)} + passive ${ms(h.passive_ms)}${passiveTask}`);
  if (h.m_name != null) {
    out.push(
      `measure ${h.m_name}${h.m_target ? ` on ${h.m_target}` : ''} ${ms(h.m_duration)} ms (on path ${ms(h.m_on)}, interference ${ms(h.m_interference)}, waiting ${ms(h.m_waiting)}): ${h.on_critical_path ? 'this commit is on its critical path' : 'this commit is interference'}`,
    );
  } else {
    out.push('measure none');
  }
  const producer = h.producer_name ?? h.producer_component_id ?? 'unknown';
  out.push(`cause ${h.trigger_event ?? 'no input event'} -> ${producer}${h.producer_call_site ? ` at ${shortSite(h.producer_call_site)}` : ''}`);
  out.push(`chain root ${h.root_update_id}${h.cascade_commit_id ? `, cascade of ${h.cascade_commit_id}` : ''}`);
  out.push(
    `extent ${int(h.rendered)} rendered, ${int(h.committed)} committed, ${int(h.noop)} no-op (${ms(h.noop_ms)} ms), ${int(h.distinct_types)} types${h.top_type ? `, top type ${h.top_type} x${int(h.top_type_count)}` : ''}`,
  );
  out.push(`shares top1 ${share(h.top1_share)}${h.top1_name ? ` (${h.top1_name})` : ''}, no-op ${share(h.noop_share)}, effects ${share(h.effect_share)}`);
  const reasons = data.get('reasons') ?? [];
  if (reasons.length > 0) out.push(`why ${reasons.map((r) => `${r.reason} ${int(r.n)}`).join(', ')}`);

  const self = data.get('self') ?? [];
  if (self.length > 0) {
    out.push('', 'self cost, top 5');
    out.push(
      ...table(
        [{ title: '  component' }, { title: 'source' }, { title: 'renders', right: true }, { title: 'committed', right: true }, { title: 'self ms', right: true }, { title: 'reason' }, { title: 'changed' }],
        self.map((s) => [`  ${s.name ?? '?'}`, shortFile(s.file, s.line), int(s.renders), int(s.committed), ms(s.self_ms, 2), s.reason ?? '', s.changed ?? '']),
      ),
    );
  }
  const effects = data.get('effects') ?? [];
  if (effects.length > 0) {
    out.push('', 'effects, top 5');
    out.push(
      ...table(
        [{ title: '  kind' }, { title: 'component' }, { title: 'source' }, { title: 'runs', right: true }, { title: 'ms', right: true }],
        effects.map((e) => [`  ${e.kind === 'layout_effect' ? 'layout' : 'passive'}`, e.name ?? '?', shortFile(e.file, e.line), int(e.runs), ms(e.ms, 2)]),
      ),
    );
  }

  // The chain as a timeline: its updates and commits, from the root update.
  const updates = data.get('updates') ?? [];
  const commits = data.get('commits') ?? [];
  const events = [
    ...updates.map((u) => ({ ts: Number(u.ts), text: `update  ${u.component ?? '?'}${u.phase ? ` in a ${u.phase} effect` : ''}${u.event ? `, ${u.event}` : ''}${u.call_site ? `, ${shortSite(u.call_site)}` : ''}` })),
    ...commits.map((c) => ({
      ts: Number(c.ts),
      text: `commit  ${c.commit_id}  ${c.producer ?? '?'}  ${ms(c.total_ms)} ms${c.cascade_commit_id ? `  cascade of ${c.cascade_commit_id}` : ''}${c.commit_id === h.commit_id ? '  <- this commit' : ''}`,
    })),
  ].sort((a, b) => a.ts - b.ts);
  if (events.length > 0) {
    const t0 = events[0]!.ts;
    const shown = events.slice(0, 20);
    out.push('', `cause chain (${commits.length} commit${commits.length === 1 ? '' : 's'}, ${updates.length} update${updates.length === 1 ? '' : 's'})`);
    for (const e of shown) out.push(`  ${`+${((e.ts - t0) / 1000).toFixed(1)}`.padStart(9)} ms  ${e.text}`);
    if (events.length > shown.length) out.push(`  ... ${events.length - shown.length} more`);
  }
  return `${out.join('\n')}\n`;
}

// ---- query

export function querySql(duckdb: string, dir: string, sql: string, opts: { session?: string; format?: 'box' | 'json' | 'csv' } = {}): string {
  const mode = opts.format === 'json' ? '-json' : opts.format === 'csv' ? '-csv' : '-box';
  try {
    return execFileSync(duckdb, [mode, ':memory:', '-c', `${viewsSql(dir, opts.session)}\n${sql}`], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    throw duckdbError(e);
  }
}
