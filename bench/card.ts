import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duckdbPath } from '../packages/capture/src/capture.ts';
import { type Family, SCHEMAS } from '../packages/capture/src/schema.ts';

// Every column cast to its pinned type, as capture writes it.
const pinned = (family: Family, select: string) => `SELECT ${SCHEMAS[family].map(([n, t]) => `${n}::${t} AS ${n}`).join(', ')} FROM (${select})`;

// Phase 3 acceptance: react-log card answers in under one second on a
// synthetic five-million-row session. The session is written the way capture
// writes one (the pinned schemas, zstd Parquet, 200,000-row segments): 2,000
// commits of 2,500 rows each (an update, 2,495 renders, three effects and the
// commit row), 3,000 components, a measure for every fourth commit.
//
//   node bench/card.ts [segments dir]   (default: a directory under /tmp)

const SESSION = '20260101-000000-synt';
const COMMITS = 2_000;
const PER_COMMIT = 2_500;
const ROWS = COMMITS * PER_COMMIT;
const PER_FILE = 200_000;
const COMPONENTS = 3_000;
const T0 = 1_767_225_600_000_000; // 2026-01-01, epoch µs
const GAP_US = 500_000; // between commits
const repo = resolve(fileURLToPath(import.meta.url), '../..');

function generate(dir: string, duckdb: string): void {
  mkdirSync(dir, { recursive: true });
  const sql: string[] = [];
  // Row i belongs to commit n = i / 2500 + 1, at position j = i % 2500.
  const seg = (lo: number, hi: number) => `
    SELECT
      '${SESSION}' AS session_id,
      1::INTEGER AS page_load_id,
      (${T0} + n * ${GAP_US} + j * 40)::BIGINT AS ts,
      CASE WHEN kind = 'render' THEN 30 + (i % 7) * 10 WHEN kind = 'commit' THEN 2000 WHEN kind IN ('layout_effect', 'passive_effect') THEN 500 END::BIGINT AS dur_us,
      CASE WHEN kind = 'render' THEN 20 + (i % 5) * 5 END::BIGINT AS self_us,
      kind,
      CASE WHEN kind IN ('update_enqueued', 'commit') THEN 'Blocking' END AS lane,
      CASE WHEN kind = 'render' OR kind LIKE '%effect' THEN 'c' || lpad(((n * 31 + j) % ${COMPONENTS})::VARCHAR, 5, '0') END AS component_id,
      CASE WHEN kind <> 'update_enqueued' THEN '${SESSION}.1.' || n END AS commit_id,
      CASE WHEN kind = 'render' THEN (['props', 'parent', 'hooks', 'context'])[1 + (i % 4)] END AS reason_code,
      CASE WHEN kind = 'render' AND i % 4 = 2 THEN '0:useState' END AS changed_hooks,
      NULL::VARCHAR AS changed_context,
      NULL::VARCHAR AS changed_keys,
      CASE WHEN kind = 'render' THEN i % 10 = 0 END AS committed,
      '${SESSION}.1.u' || n AS root_update_id,
      CASE WHEN n % 4 = 0 THEN '${SESSION}.1.m' || (n // 4) END AS measure_instance_id,
      CASE WHEN n % 4 = 0 THEN TRUE END AS on_critical_path,
      CASE WHEN kind = 'update_enqueued' THEN 'onClick (src/App.jsx:' || (10 + n % 50) || ':5)' END AS call_site,
      CASE
        WHEN kind = 'update_enqueued' THEN json_object('method', 'setState', 'phase', NULL, 'event', 'click', 'component', NULL, 'label', NULL, 'stack', NULL, 'during', NULL)
        WHEN kind = 'commit' THEN json_object('root', 1, 'trigger', 'click', 'renderStart', ${T0} + n * ${GAP_US} + 40, 'renderEnd', ${T0} + n * ${GAP_US} + 99800,
                                              'commitStart', ${T0} + n * ${GAP_US} + 99800, 'commitEnd', ${T0} + n * ${GAP_US} + 101800, 'passiveSync', TRUE)
        WHEN kind LIKE '%effect' THEN json_object('phase', 'mount')
      END::JSON AS extra
    FROM (
      SELECT i, n, j,
        CASE WHEN j = 0 THEN 'update_enqueued' WHEN j = ${PER_COMMIT - 1} THEN 'commit' WHEN j >= ${PER_COMMIT - 4} THEN (CASE WHEN j % 2 = 0 THEN 'layout_effect' ELSE 'passive_effect' END) ELSE 'render' END AS kind
      FROM (SELECT i, i // ${PER_COMMIT} + 1 AS n, i % ${PER_COMMIT} AS j FROM range(${lo}, ${hi}) t(i))
    )
    ORDER BY ts`;
  for (let f = 0; f * PER_FILE < ROWS; f++) {
    const lo = f * PER_FILE;
    sql.push(`COPY (${pinned('seg', seg(lo, Math.min(ROWS, lo + PER_FILE)))}) TO '${join(dir, `seg-${String(f).padStart(5, '0')}.parquet`)}' (FORMAT parquet, COMPRESSION zstd);`);
  }
  sql.push(`COPY (${pinned('defs', `
    SELECT 'c' || lpad(k::VARCHAR, 5, '0') AS component_id, 'Component' || (k % 400) AS display_name, 'src/components/File' || (k % 60) || '.jsx' AS source_file,
           (10 + k % 300)::INTEGER AS source_line, 5::INTEGER AS source_column, 'App>Shell>Component' || (k % 400) || '#' || k AS owner_path
    FROM range(${COMPONENTS}) t(k)`)}) TO '${join(dir, 'defs-00000.parquet')}' (FORMAT parquet, COMPRESSION zstd);`);
  sql.push(`COPY (${pinned('commits', `
    SELECT '${SESSION}.1.' || n AS commit_id, '${SESSION}' AS session_id, (${T0} + n * ${GAP_US} + 40)::BIGINT AS ts,
           CASE WHEN n % 4 = 0 THEN '${SESSION}.1.m' || (n // 4) END AS measure_instance_id, CASE WHEN n % 4 = 0 THEN TRUE END AS on_critical_path,
           'sig_' || lpad((n % 50)::VARCHAR, 10, '0') AS signature, '${SESSION}.1.u' || n AS root_update_id,
           'c' || lpad(((n * 31 + 1) % ${COMPONENTS})::VARCHAR, 5, '0') AS producer_component_id, 'onClick (src/App.jsx:' || (10 + n % 50) || ':5)' AS producer_call_site,
           'click' AS trigger_event, 'Blocking' AS lane, 101.76 + (n % 13) AS total_ms, 99.76 AS render_ms, 2.0 + (n % 13) AS layout_ms, 0.0 AS passive_ms,
           TRUE AS passive_sync, FALSE AS strict_mode, NULL::VARCHAR AS cascade_commit_id, ${PER_COMMIT - 5}::INTEGER AS rendered, 250::INTEGER AS committed,
           ${PER_COMMIT - 255}::INTEGER AS noop, 70.0 AS noop_ms, 400::INTEGER AS distinct_types, 'Component7' AS top_type, 12::INTEGER AS top_type_count,
           'c00001' AS top1_component_id, 0.02 AS top1_share, 0.69 AS noop_share, 0.01 AS effect_share
    FROM range(1, ${COMMITS + 1}) t(n)`)}) TO '${join(dir, 'commits-00000.parquet')}' (FORMAT parquet, COMPRESSION zstd);`);
  sql.push(`COPY (${pinned('measures', `
    SELECT '${SESSION}.1.m' || k AS measure_instance_id, '${SESSION}' AS session_id, 1::INTEGER AS page_load_id, 'click' AS name, 'event_timing' AS source,
           k::BIGINT AS interaction_id, 'button#go' AS target, (${T0} + 4 * k * ${GAP_US})::BIGINT AS ts_start, (${T0} + 4 * k * ${GAP_US} + 102000)::BIGINT AS ts_end_marker,
           (${T0} + 4 * k * ${GAP_US} + 112000)::BIGINT AS ts_end_paint, (${T0} + 4 * k * ${GAP_US} + 112000)::BIGINT AS ts_end_idle,
           112.0 AS duration_ms, 101.8 AS on_path_ms, 0.0 AS interference_ms, 10.2 AS waiting_ms
    FROM range(1, ${COMMITS / 4 + 1}) t(k)`)}) TO '${join(dir, 'measures-00000.parquet')}' (FORMAT parquet, COMPRESSION zstd);`);
  execFileSync(duckdb, [':memory:', '-c', sql.join('\n')], { stdio: ['ignore', 'ignore', 'inherit'] });
  writeFileSync(
    join(dir, 'session.json'),
    `${JSON.stringify(
      {
        session_id: SESSION,
        target_id: 'synthetic',
        app_url: 'synthetic://five-million-rows',
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: '2026-01-01T00:16:40.000Z',
        react_version: '19.3.0',
        renderers: [],
        shim_version: null,
        git_sha: null,
        git_dirty: null,
        config: {},
        page_loads: [{ page_load_id: 1, url: 'synthetic://five-million-rows', token: 'synthetic', time_origin: 0 }],
        refused: null,
        errors: [],
        rows: ROWS,
        commits: COMMITS,
        measures: COMMITS / 4,
        dropped: 0,
      },
      null,
      2,
    )}\n`,
  );
}

function timed(args: string[]): { ms: number; out: string } {
  const t = process.hrtime.bigint();
  const out = execFileSync(process.execPath, [join(repo, 'packages/cli/bin/react-log.js'), ...args]).toString();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const segments = resolve(process.argv[2] ?? join('/tmp', 'react-log-card-bench'));
  const dir = join(segments, SESSION);
  const duckdb = duckdbPath();
  if (!existsSync(join(dir, 'session.json'))) {
    const t = Date.now();
    generate(dir, duckdb);
    console.log(`generated ${ROWS.toLocaleString('en-US')} rows in ${((Date.now() - t) / 1000).toFixed(1)} s: ${dir}`);
  }
  const [{ n }] = JSON.parse(execFileSync(duckdb, ['-json', ':memory:', '-c', `SELECT count(*) AS n FROM read_parquet('${dir}/seg-*.parquet')`]).toString());
  console.log(`session ${SESSION}: ${Number(n).toLocaleString('en-US')} rows`);
  let worst = 0;
  for (const commit of [1, 500, 1000, 1500, COMMITS]) {
    const { ms, out } = timed(['card', `${SESSION}.1.${commit}`, '--segments', segments]);
    worst = Math.max(worst, ms);
    console.log(`card ${SESSION}.1.${commit}: ${ms.toFixed(0)} ms, ${out.trimEnd().split('\n').length} lines`);
  }
  const top = timed(['top', '--session', SESSION, '--segments', segments]);
  console.log(`top: ${top.ms.toFixed(0)} ms`);
  console.log(`slowest card ${worst.toFixed(0)} ms: ${worst < 1000 ? 'PASS' : 'FAIL'} (bar: under 1000 ms)`);
  process.exit(worst < 1000 ? 0 : 1);
}
