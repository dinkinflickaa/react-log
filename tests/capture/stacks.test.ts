import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bucketProblems, recomputeBuckets } from '../../bench/buckets.ts';
import { startFixtureServer } from '../../fixture/serve.ts';
import { serveInChild, sql, withCapture } from './harness.ts';

// Every update keeps its stack. One click on the fan-out page makes n + 1
// updates in one commit, and each one's call site is recorded. React 19.2+
// reports only a batch's first update (it makes a task for the first update
// after a render starts), so there it is one. The shim's time inside each
// update is capture's, not the app's, even where timers tick in 100 µs steps.

const VERSIONS = ['18.0.0', '18.2.0', '18.3.1', '19.0.8', '19.1.9', '19.2.8', '19.3.0'];
// The versions whose profiling hooks call the shim on every update.
const everyUpdate = (version: string) => /^(18\.|19\.[01]\.)/.test(version);

const fixture = readFileSync(fileURLToPath(new URL('../../fixture/app/src/fanout.jsx', import.meta.url)), 'utf8').split('\n');
const site = (code: string) => {
  const line = fixture.findIndex((l) => l.includes(code)) + 1;
  if (line === 0) throw new Error(`no ${code} in fanout.jsx`);
  return new RegExp(`\\(fixture/app/src/fanout\\.jsx:${line}:\\d+\\)$`);
};
const CELLS = site('for (const set of setters) set(');
const OWN = site('setClicks((c) => c + 1)');

const root = mkdtempSync(join(tmpdir(), 'react-log-stacks-'));
let isolated: { origin: string; child: ChildProcess };
let plain: Server;
const plainOrigin = () => `http://127.0.0.1:${(plain.address() as { port: number }).port}`;

beforeAll(async () => {
  isolated = await serveInChild();
  plain = await startFixtureServer(0, { isolate: false });
});
afterAll(() => {
  isolated.child.kill();
  plain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const fan = async (name: string, url: string) => {
  let loopMs = 0;
  const run = await withCapture(root, name, url, {}, async (_cdp, page) => {
    await page.click('#fan');
    await page.settle();
    loopMs = await page.eval<number>('window.__fanMs');
  });
  return { dir: run.result.sessions[0]!.dir, loopMs };
};
const clickUpdates = (dir: string) =>
  sql<{ call_site: string | null }>(`SELECT call_site FROM read_parquet('${dir}/seg-*.parquet') WHERE kind = 'update_enqueued' AND (extra->>'event') = 'click' ORDER BY ts`);
const updateTime = (dir: string) => {
  const [r] = sql(`SELECT count(*) AS n, coalesce(sum(dur_us), 0) AS us FROM read_parquet('${dir}/seg-*.parquet') WHERE kind = 'capture' AND (extra->>'how') = 'update'`);
  return { slices: Number(r.n), us: Number(r.us) };
};

describe.each(VERSIONS)('update stacks on React %s', (version) => {
  test('every update of a fan-out keeps its call site, and the shim time inside them is capture time', async () => {
    const { dir } = await fan(`fanout-${version}`, `${isolated.origin}/react-${version}/fanout.html`);
    const updates = clickUpdates(dir);
    const all = JSON.stringify(updates);
    if (everyUpdate(version)) {
      expect(updates, all).toHaveLength(25);
      expect(updates.filter((u) => CELLS.test(u.call_site ?? '')), all).toHaveLength(24);
      expect(updates.filter((u) => OWN.test(u.call_site ?? '')), all).toHaveLength(1);
      expect(updateTime(dir).slices).toBeGreaterThan(0);
    } else {
      expect(updates, all).toHaveLength(1);
      expect(updates[0]!.call_site, all).toMatch(CELLS);
    }
    // The click's measure: capture time is its own bucket, and the four add up.
    const buckets = recomputeBuckets(dir);
    expect(buckets).toHaveLength(1);
    for (const b of buckets) expect(bucketProblems(b), JSON.stringify(b)).toEqual([]);
    expect(buckets[0]!.capture_ms).toBeGreaterThan(0);
  }, 60_000);
});

test('with 100 µs timers (no cross-origin isolation), the summed update time still matches 5 µs timers', async () => {
  const runs = [await fan('fanout-isolated', `${isolated.origin}/react-18.3.1/fanout.html?n=2000`), await fan('fanout-plain', `${plainOrigin()}/react-18.3.1/fanout.html?n=2000`)];
  // The shim's share of the setters' loop, each against its own page's clock,
  // so a busier machine on one run moves both numbers.
  const shares = runs.map(({ dir, loopMs }) => {
    expect(clickUpdates(dir)).toHaveLength(2001);
    const t = updateTime(dir);
    console.log(`2,001 updates: ${t.us} µs of shim time in ${t.slices} slices, in a ${Math.round(loopMs * 1000)} µs loop`);
    // All of it inside the click's handler, and all of it in the measure's capture bucket.
    const [m] = recomputeBuckets(dir);
    expect(bucketProblems(m!), JSON.stringify(m)).toEqual([]);
    expect(m!.capture_ms * 1000).toBeGreaterThanOrEqual(t.us - 1);
    return t.us / (loopMs * 1000);
  });
  for (const share of shares) {
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(1.1);
  }
  // Each 100 µs reading is 0 or 100, but the sum is unbiased: an update
  // straddles a tick in proportion to its length.
  expect(shares[1]! / shares[0]!).toBeGreaterThan(0.6);
  expect(shares[1]! / shares[0]!).toBeLessThan(1.6);
}, 120_000);
