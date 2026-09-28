import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bucketProblems, recomputeBuckets } from '../../bench/buckets.ts';
import { type CaptureRun, serveInChild, sleep, sql, withCapture } from './harness.ts';

// Measures end to end on every matrix version: the chains page with its
// ticker (a clock that re-renders every 10 ms from a timer), and three clicks
// on #slow, whose handler computes for 40 ms. Each click is an Event Timing
// interaction whose window also holds some of the ticker's commits.

const VERSIONS = ['18.0.0', '18.2.0', '18.3.1', '19.0.8', '19.1.9', '19.2.8', '19.3.0'];

const root = mkdtempSync(join(tmpdir(), 'react-log-measures-'));
let server: { origin: string; child: ChildProcess };

beforeAll(async () => {
  server = await serveInChild();
});
afterAll(() => {
  server.child.kill();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe.each(VERSIONS)('measures on React %s', (version) => {
  let run: CaptureRun;
  let dir = '';

  beforeAll(async () => {
    run = await withCapture(root, `measures-${version}`, `${server.origin}/react-${version}/chains.html?ticker`, {}, async (_cdp, page) => {
      for (let k = 0; k < 3; k++) {
        await page.click('#slow');
        await sleep(300);
      }
      // The ticker never lets the shim's queue empty; capture flushes it on stop.
      await sleep(500);
    });
    dir = run.result.sessions[0]!.dir;
  }, 120_000);

  test('one measure per click, named for it', () => {
    const measures = sql(`SELECT name, source, target, interaction_id FROM read_parquet('${dir}/measures-*.parquet') ORDER BY ts_start`);
    const entries = () =>
      JSON.stringify(
        sql(`SELECT extra->>'name' AS name, (extra->>'interactionId')::BIGINT AS iid, ts, dur_us, (extra->>'processingStart')::BIGINT - ts AS ps, (extra->>'processingEnd')::BIGINT - ts AS pe, measure_instance_id AS m
             FROM read_parquet('${dir}/seg-*.parquet') WHERE kind = 'event_timing' ORDER BY ts`),
      );
    expect(measures, entries()).toHaveLength(3);
    for (const m of measures) expect(m, entries()).toMatchObject({ name: 'click', source: 'event_timing', target: 'button#slow' });
  });

  test('buckets are unions of intervals, recomputed from the events', () => {
    const rows = recomputeBuckets(dir);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(bucketProblems(r), JSON.stringify(r)).toEqual([]);
    // The ticker's commits land in the windows.
    expect(rows.some((r) => r.interference_ms > 0)).toBe(true);
  });

  test("the commit each click's update rendered in is on its critical path, the ticker's own are not", () => {
    // React can render a pending ticker update in the same commit as the
    // click's (and 19.2+ then reports only the ticker's update), so commits
    // are told apart by whether Slow rendered in them.
    const names = `(SELECT DISTINCT component_id, display_name FROM read_parquet('${dir}/defs-*.parquet'))`;
    const stamped = sql<{ commit_id: string; m: string; onp: boolean; slow: boolean }>(`
      WITH names AS ${names},
      slow AS (
        SELECT DISTINCT s.commit_id FROM read_parquet('${dir}/seg-*.parquet') s JOIN names n USING (component_id)
        WHERE s.kind = 'render' AND n.display_name = 'Slow' AND s.reason_code = 'hooks')
      SELECT c.commit_id, c.measure_instance_id AS m, c.on_critical_path AS onp, c.commit_id IN (SELECT commit_id FROM slow) AS slow
      FROM read_parquet('${dir}/commits-*.parquet') c WHERE c.measure_instance_id IS NOT NULL ORDER BY c.ts`);
    const clicks = stamped.filter((c) => c.slow);
    expect(clicks, JSON.stringify(stamped)).toHaveLength(3);
    expect(new Set(clicks.map((c) => c.m)).size).toBe(3);
    for (const c of clicks) expect(c.onp).toBe(true);
    for (const c of stamped.filter((x) => !x.slow)) expect(c.onp, JSON.stringify(stamped)).toBe(false);
  });
});
