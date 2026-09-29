import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { bucketProblems, recomputeBuckets } from '../../bench/buckets.ts';
import { serveInChild, sleep, sql, withCapture } from './harness.ts';

// A commit writes all its records before capture can take any. One of 80,001
// renders, more than the page buffer's first 50,000 slots, arrives whole: the
// buffer grows instead of dropping, and drains once the page is idle.

const root = mkdtempSync(join(tmpdir(), 'react-log-buffer-'));
let server: { origin: string; child: ChildProcess };
beforeAll(async () => {
  server = await serveInChild();
});
afterAll(() => {
  server.child.kill();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('a first render and a re-render of 80,001 components each, nothing dropped', async () => {
  const run = await withCapture(root, 'big', `${server.origin}/react-19.3.0/big.html?n=40000`, {}, async (_cdp, page) => {
    const drained = async () => {
      for (let i = 0; (await page.eval<number>('window.__reactLog.pending()')) > 0; i++) {
        if (i > 1200) throw new Error('the page buffer did not drain in 60 s');
        await sleep(50);
      }
    };
    await drained();
    await page.click('#tick');
    await drained();
  });
  const { dir } = run.result.sessions[0]!;
  const info = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  expect(info.dropped).toBe(0);
  expect(info.buffer_peak).toBeGreaterThan(80_000);
  const commits = sql<{ rendered: number; dropped_rows: number }>(`SELECT rendered, dropped_rows FROM read_parquet('${dir}/commits-*.parquet') ORDER BY ts`);
  expect(commits.map((c) => [Number(c.rendered), Number(c.dropped_rows)])).toEqual([
    [80_001, 0],
    [80_001, 0],
  ]);
  expect(run.logs.some((l) => /, 0 dropped, page buffer peak 8\d{4} records$/.test(l))).toBe(true);
}, 120_000);

// Every row re-rendered on every frame: 4,001 renders a frame, far more than
// capture can take as they come. Past the high watermark (20,000 here) the
// page waits for capture at commit boundaries: nothing is dropped, the page's
// buffer stays near the watermark, and the page slows down but keeps going.
test('4,001 renders every frame for 4 s past a 20,000-record watermark: nothing dropped, memory bounded, the wait counted as capture', async () => {
  let ticks = 0;
  let stats: any = null;
  const run = await withCapture(root, 'loop', `${server.origin}/react-19.3.0/big.html?n=2000&loop=4`, { record: { ringHigh: 20_000 } }, async (_cdp, page) => {
    await page.click('#tick');
    for (let i = 0; !(await page.eval<boolean>('window.__loopDone === true')); i++) {
      if (i > 600) throw new Error('the loop did not end');
      await sleep(50);
    }
    for (let i = 0; (await page.eval<number>('window.__reactLog.pending()')) > 0; i++) {
      if (i > 1200) throw new Error('the page buffer did not drain in 60 s');
      await sleep(50);
    }
    ticks = await page.eval<number>('window.__ticks');
    stats = JSON.parse(await page.eval<string>('JSON.stringify(window.__reactLog.stats)'));
  });
  const { dir } = run.result.sessions[0]!;
  const info = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  expect(info.dropped).toBe(0);
  // The watermark and the one commit written since the last boundary.
  expect(info.buffer_peak).toBeGreaterThan(20_000);
  expect(info.buffer_peak).toBeLessThanOrEqual(20_000 + 4_100);
  expect(stats.spills).toBeGreaterThan(0);
  expect(ticks).toBeGreaterThan(10);
  // Every commit whole (React batches two frames' updates into one commit
  // when the page waited, so there are fewer commits than ticks), and every
  // walk recorded as capture's time.
  const [c] = sql(`SELECT count(*) AS commits, sum(dropped_rows) AS dropped, count(*) FILTER (rendered = 4001) AS full FROM read_parquet('${dir}/commits-*.parquet')`);
  expect(Number(c.dropped)).toBe(0);
  expect(Number(c.full)).toBe(Number(c.commits));
  const [w] = sql(`SELECT count(*) FILTER (extra->>'how' = 'spill') AS spills, count(*) FILTER (extra->>'how' = 'walk') AS walks FROM read_parquet('${dir}/seg-*.parquet') WHERE kind = 'capture'`);
  expect(Number(w.spills)).toBe(stats.spills);
  expect(Number(w.walks)).toBe(Number(c.commits));
  // The click's measure: capture's time is its own bucket, and the four still add up.
  const buckets = recomputeBuckets(dir);
  expect(buckets.length).toBeGreaterThan(0);
  for (const b of buckets) expect(bucketProblems(b), b.measure_instance_id).toEqual([]);
  expect(buckets.some((b) => b.capture_ms > 0)).toBe(true);
}, 120_000);
