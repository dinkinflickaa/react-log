import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
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
