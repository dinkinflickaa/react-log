import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { duckdbPath } from '../packages/capture/src/capture.ts';

// Phase 3 acceptance: every measure's time buckets, recomputed in SQL from
// the session's events, independently of the rollup code. On-path time is
// the union of the intervals of the rows the measure stamped on its critical
// path, interference the union of every other row's intervals inside the
// window, and waiting the uncovered rest. Unions, never sums: nested
// intervals (a parent render and its children, a handler and the render
// inside it) count once.
//
//   node bench/buckets.ts <session dir>

export interface BucketRow {
  measure_instance_id: string;
  name: string;
  duration_ms: number;
  // The window, from the measure's ends.
  window_ms: number;
  on_path_ms: number;
  interference_ms: number;
  waiting_ms: number;
  on_path_re: number;
  interference_re: number;
  waiting_re: number;
}

export function bucketsSql(dir: string): string {
  return `
-- Intervals (m, kind, a, b) merged where they overlap or touch: an interval
-- starts a new run when it begins after every earlier one of its group ended.
CREATE MACRO merged(t) AS TABLE
  SELECT m, kind, min(a) AS a, max(b) AS b FROM (
    SELECT m, kind, a, b, sum(CASE WHEN prev IS NULL OR a > prev THEN 1 ELSE 0 END)
      OVER (PARTITION BY m, kind ORDER BY a, b ROWS UNBOUNDED PRECEDING) AS run
    FROM (
      SELECT m, kind, a, b, max(b) OVER (PARTITION BY m, kind ORDER BY a, b ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev
      FROM query_table(t)
      WHERE b > a))
  GROUP BY m, kind, run;
WITH
seg AS (SELECT * FROM read_parquet('${dir}/seg-*.parquet')),
measures AS (SELECT * FROM read_parquet('${dir}/measures-*.parquet')),
-- Main-thread intervals each row stands for, in µs, with its stamps.
spans AS (
  SELECT measure_instance_id AS mid, on_critical_path AS onp, ts AS a, ts + dur_us AS b
    FROM seg WHERE kind IN ('render', 'layout_effect', 'passive_effect') AND dur_us > 0
  UNION ALL
  -- A blocking render never yields: its whole render phase is main-thread work.
  SELECT measure_instance_id, on_critical_path, (extra->>'renderStart')::BIGINT, (extra->>'renderEnd')::BIGINT
    FROM seg WHERE kind = 'commit' AND lane IN ('Blocking', 'Gesture')
  UNION ALL
  SELECT measure_instance_id, on_critical_path, coalesce((extra->>'commitStart')::BIGINT, ts), coalesce((extra->>'commitEnd')::BIGINT, ts + dur_us)
    FROM seg WHERE kind = 'commit'
  UNION ALL
  SELECT measure_instance_id, on_critical_path, (extra->>'passiveStart')::BIGINT, (extra->>'passiveEnd')::BIGINT
    FROM seg WHERE kind = 'commit'
  UNION ALL
  SELECT measure_instance_id, on_critical_path, (extra->>'processingStart')::BIGINT, (extra->>'processingEnd')::BIGINT
    FROM seg WHERE kind = 'event_timing'
  UNION ALL
  SELECT mid, onp, (s->>'start')::BIGINT, (s->>'start')::DOUBLE + (s->>'duration')::DOUBLE * 1000
    FROM (SELECT measure_instance_id AS mid, on_critical_path AS onp, unnest(from_json(extra->'scripts', '["JSON"]')) AS s FROM seg WHERE kind = 'loaf')
),
-- An interaction's window is the union of its entries' windows: each from
-- its input to the paint after its handlers, never before they end (Event
-- Timing rounds durations to 8 ms). A mark pair's runs between its marks.
entry_windows AS (
  SELECT x.measure_instance_id AS m, 'window' AS kind, e.ts AS a, greatest(e.ts + e.dur_us, (e.extra->>'processingEnd')::BIGINT) AS b
  FROM measures x JOIN seg e
    ON e.kind = 'event_timing' AND e.page_load_id = x.page_load_id AND (e.extra->>'interactionId')::BIGINT = x.interaction_id
  WHERE x.source = 'event_timing'
  UNION ALL
  SELECT measure_instance_id, 'window', ts_start, ts_end_marker FROM measures WHERE source = 'marks'
),
win AS (SELECT m, a AS lo, b AS hi FROM merged(entry_windows)),
clipped AS (
  SELECT w.m, greatest(s.a, w.lo) AS a, least(s.b, w.hi) AS b, coalesce(s.onp AND s.mid = w.m, false) AS on_path
  FROM win w JOIN spans s ON s.a IS NOT NULL AND s.b IS NOT NULL AND s.b > w.lo AND s.a < w.hi
),
sets AS (
  SELECT m, 'all' AS kind, a, b FROM clipped WHERE b > a
  UNION ALL
  SELECT m, 'on', a, b FROM clipped WHERE b > a AND on_path
),
unions AS (SELECT m, kind, sum(b - a) AS us FROM merged(sets) GROUP BY m, kind),
windows AS (SELECT m, sum(hi - lo) AS us FROM win GROUP BY m)
SELECT x.measure_instance_id, x.name, x.duration_ms, w.us / 1000 AS window_ms, x.on_path_ms, x.interference_ms, x.waiting_ms,
       coalesce(o.us, 0) / 1000 AS on_path_re,
       (coalesce(a.us, 0) - coalesce(o.us, 0)) / 1000 AS interference_re,
       w.us / 1000 - coalesce(a.us, 0) / 1000 AS waiting_re
FROM measures x
JOIN windows w ON w.m = x.measure_instance_id
LEFT JOIN unions o ON o.m = x.measure_instance_id AND o.kind = 'on'
LEFT JOIN unions a ON a.m = x.measure_instance_id AND a.kind = 'all'
ORDER BY x.ts_start`;
}

export function recomputeBuckets(dir: string, duckdb = duckdbPath()): BucketRow[] {
  const out = execFileSync(duckdb, ['-json', ':memory:', '-c', bucketsSql(dir)], { maxBuffer: 256 * 1024 * 1024 }).toString().trim();
  return out === '' ? [] : JSON.parse(out);
}

// The acceptance bar: the three buckets sum to the duration within 5% with
// none negative, and each matches its recomputation within 5% (or 0.05 ms).
export function bucketProblems(r: BucketRow): string[] {
  const out: string[] = [];
  const near = (x: number, y: number) => Math.abs(x - y) <= Math.max(0.05, 0.05 * r.duration_ms);
  if (!near(r.window_ms, r.duration_ms)) out.push(`duration ${r.duration_ms.toFixed(3)} != window ${r.window_ms.toFixed(3)}`);
  const sum = r.on_path_ms + r.interference_ms + r.waiting_ms;
  if (!near(sum, r.duration_ms)) out.push(`sum ${sum.toFixed(3)} != duration ${r.duration_ms.toFixed(3)}`);
  for (const k of ['on_path_ms', 'interference_ms', 'waiting_ms'] as const) if (r[k] < -1e-6) out.push(`${k} negative (${r[k]})`);
  if (!near(r.on_path_ms, r.on_path_re)) out.push(`on_path ${r.on_path_ms.toFixed(3)} vs recomputed ${r.on_path_re.toFixed(3)}`);
  if (!near(r.interference_ms, r.interference_re)) out.push(`interference ${r.interference_ms.toFixed(3)} vs recomputed ${r.interference_re.toFixed(3)}`);
  if (!near(r.waiting_ms, r.waiting_re)) out.push(`waiting ${r.waiting_ms.toFixed(3)} vs recomputed ${r.waiting_re.toFixed(3)}`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('usage: node bench/buckets.ts <session dir>');
    process.exit(2);
  }
  const rows = recomputeBuckets(dir);
  const f = (x: number) => x.toFixed(2).padStart(8);
  console.log(`${'measure'.padEnd(28)} ${'name'.padEnd(12)} duration   on_path interfere   waiting | recomputed: on_path interfere   waiting`);
  let failed = 0;
  for (const r of rows) {
    const problems = bucketProblems(r);
    if (problems.length > 0) failed++;
    console.log(
      `${r.measure_instance_id.padEnd(28)} ${r.name.padEnd(12)} ${f(r.duration_ms)} ${f(r.on_path_ms)} ${f(r.interference_ms)} ${f(r.waiting_ms)} |            ${f(r.on_path_re)} ${f(r.interference_re)} ${f(r.waiting_re)}${problems.length > 0 ? `  FAIL: ${problems.join('; ')}` : ''}`,
    );
  }
  console.log(`${rows.length} measures, ${failed} failing: ${failed === 0 && rows.length > 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failed === 0 && rows.length > 0 ? 0 : 1);
}
