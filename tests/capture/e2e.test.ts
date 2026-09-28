import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureServer } from '../../fixture/serve.ts';
import { captureEndpoint, watch } from '../../packages/capture/src/watch.ts';
import { cardText, querySql, sessionsText, topText } from '../../packages/cli/src/report.ts';
import { bucketProblems, recomputeBuckets } from '../../bench/buckets.ts';
import { attachTab, type CaptureRun, duckdb, serveInChild, sleep, sql, withCapture } from './harness.ts';

// react-log capture end to end on the lab (harness.ts), then the Parquet
// segments checked.

const root = mkdtempSync(join(tmpdir(), 'react-log-e2e-'));
let isolated: { origin: string; child: ChildProcess };
let plain: Server;
const origin = (s: Server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;

beforeAll(async () => {
  isolated = await serveInChild();
  plain = await startFixtureServer(0, { isolate: false });
});
afterAll(() => {
  isolated.child.kill();
  plain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe.each(['19.3.0', '18.3.1'])('capture against the lab on React %s', (version) => {
  let run: CaptureRun;
  let dir = '';
  let seg = '';
  let defs = '';

  beforeAll(async () => {
    const url = `${isolated.origin}/react-${version}/lab.html`;
    run = await withCapture(root, `e2e-${version}`, url, {}, async (cdp, page) => {
      for (const b of ['#bench-small', '#bench-medium', '#bug-effect', '#bug-hoist']) await page.click(b);
      await page.settle();
      expect(await watch(['SidebarItem'], { endpoint: captureEndpoint(join(root, `e2e-${version}`)), urlMatch: '127.0.0.1' })).toBe(1);
      await page.click('#bench-large');
      await page.settle();
      // A reload is a second page load in the same session.
      await page.eval('window.__beforeReload = true');
      await cdp.send('Page.reload', {}, page.sessionId);
      for (let i = 0; await page.eval('window.__beforeReload === true').catch(() => true); i++) {
        if (i > 400) throw new Error('the page did not reload');
        await sleep(50);
      }
      await page.ready();
      await page.click('#bench-small');
      await page.settle();
      // A tab opened with a URL while capture runs starts loading at once,
      // paused or not. Capture runs in this process: keep it busy for 1.5 s,
      // and the shim must still run before the tab's scripts, because capture
      // holds the tab's document request until the tab is instrumented.
      const created = cdp.send<{ targetId: string }>('Target.createTarget', { url });
      const busyUntil = Date.now() + 1500;
      while (Date.now() < busyUntil) {
        // Capture's event handlers cannot run meanwhile.
      }
      const { targetId } = await created;
      const second = await attachTab(cdp, targetId, 'lab');
      expect(await second.eval('window.__reactLog.status')).toBe('active');
      expect(await second.eval('window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size')).toBe(1);
      await second.click('#bug-budget');
      await second.settle();
    });
    const main = run.result.sessions.find((s) => JSON.parse(readFileSync(join(s.dir, 'session.json'), 'utf8')).target_id === run.targetId);
    expect(main, JSON.stringify(run.result)).toBeDefined();
    dir = main!.dir;
    seg = `read_parquet('${main!.dir}/seg-*.parquet')`;
    defs = `read_parquet('${main!.dir}/defs-*.parquet')`;
  }, 120_000);

  test('writes one session per tab, with no drops and no errors', () => {
    expect(run.result.sessions).toHaveLength(2);
    for (const s of run.result.sessions) {
      const info = JSON.parse(readFileSync(join(s.dir, 'session.json'), 'utf8'));
      const brief = JSON.stringify({ target: info.target_id, page_loads: info.page_loads, renderers: info.renderers, rows: info.rows, errors: info.errors });
      expect(info.react_version, brief).toBe(version);
      expect(info.errors).toEqual([]);
      expect(info.dropped).toBe(0);
      expect(info.ended_at).not.toBeNull();
      const [{ n }] = sql(`SELECT count(*) AS n FROM read_parquet('${s.dir}/seg-*.parquet')`);
      expect(n).toBe(info.rows);
      expect(n).toBeGreaterThan(0);
    }
    expect(run.logs.some((l) => l.includes('react-log: capturing'))).toBe(true);
  });

  test('numbers page loads, and keeps commit ids unique across them', () => {
    const loads = sql(`SELECT page_load_id, count(*) FILTER (kind = 'commit') AS commits FROM ${seg} GROUP BY 1 ORDER BY 1`);
    expect(loads.map((l: any) => l.page_load_id)).toEqual([1, 2]);
    expect(loads.every((l: any) => l.commits > 0)).toBe(true);
    const [{ dup }] = sql(`SELECT count(*) - count(DISTINCT commit_id) AS dup FROM ${seg} WHERE kind = 'commit'`);
    expect(dup).toBe(0);
  });

  test('converts times to epoch microseconds', () => {
    const [{ lo, hi }] = sql(`SELECT min(ts) AS lo, max(ts) AS hi FROM ${seg} WHERE kind = 'commit'`);
    const now = Date.now() * 1000;
    expect(lo).toBeGreaterThan(now - 10 * 60e6);
    expect(hi).toBeLessThanOrEqual(now);
  });

  test('maps component definitions to original source', () => {
    const [d] = sql(`SELECT * FROM ${defs} WHERE display_name = 'SidebarItem' LIMIT 1`);
    expect(d.source_file).toMatch(/(^|\/)fixture\/app\/src\/lab\/Lab\.jsx$/);
    // The element is created on this line of Sidebar.
    expect(d.source_line).toBe(148);
    expect(d.owner_path).toMatch(/Sidebar>SidebarItem#\d+$/);
  });

  test('maps update call sites to original source', () => {
    const sites = sql<{ call_site: string }>(`SELECT DISTINCT call_site FROM ${seg} WHERE kind = 'update_enqueued' AND call_site IS NOT NULL`);
    expect(sites.length).toBeGreaterThan(0);
    for (const s of sites) expect(s.call_site).toMatch(/ \(fixture\/app\/src\/[\w/]+\.jsx:\d+:\d+\)$/);
    expect(sites.some((s) => s.call_site.includes('fixture/app/src/lab/Lab.jsx:'))).toBe(true);
  });

  test('records changed_keys for watched components only', () => {
    const rows = sql(`
      SELECT changed_keys, count(*) AS n
      FROM ${seg} s JOIN ${defs} d USING (component_id)
      WHERE s.kind = 'render' AND d.display_name = 'SidebarItem' AND s.reason_code = 'props'
      GROUP BY 1 ORDER BY 2 DESC`);
    expect(rows[0]).toEqual({ changed_keys: 'onSelect:identity_only', n: 2998 });
    expect(rows.slice(1)).toEqual([{ changed_keys: 'selected:value,onSelect:identity_only', n: 2 }]);
    const [{ other }] = sql(`SELECT count(*) AS other FROM ${seg} s JOIN ${defs} d USING (component_id) WHERE d.display_name <> 'SidebarItem' AND changed_keys IS NOT NULL`);
    expect(other).toBe(0);
    const [{ w }] = sql(`SELECT count(*) AS w FROM ${seg} WHERE kind = 'watch'`);
    expect(w).toBe(1);
  });

  test('records interactions from Event Timing', () => {
    const [{ n }] = sql(`SELECT count(*) AS n FROM ${seg} WHERE kind = 'event_timing' AND (extra->>'name') = 'click'`);
    expect(n).toBeGreaterThan(0);
  });

  test('rolls up every commit, linked to a chain', () => {
    const [{ rows }] = sql(`SELECT count(*) AS rows FROM ${seg} WHERE kind = 'commit'`);
    const [{ commits, unlinked }] = sql(`SELECT count(*) AS commits, count(*) FILTER (root_update_id IS NULL) AS unlinked FROM read_parquet('${dir}/commits-*.parquet')`);
    expect(commits).toBe(rows);
    expect(unlinked).toBe(0);
    const [{ orphans }] = sql(`SELECT count(*) AS orphans FROM ${seg} WHERE commit_id IS NOT NULL AND root_update_id IS NULL`);
    expect(orphans).toBe(0);
  });

  test('react-log sessions, top, card and query read the session', () => {
    const segments = dirname(dir);
    const session = basename(dir);
    expect(sessionsText(segments)).toContain(session);
    const [sidebar] = sql<{ commit_id: string }>(
      `SELECT commit_id FROM read_parquet('${dir}/commits-*.parquet') WHERE top_type = 'SidebarItem' AND trigger_event = 'click' ORDER BY total_ms DESC LIMIT 1`,
    );
    const top = topText(duckdb, segments, session, { limit: 5 });
    expect(top.split('\n').length).toBeLessThanOrEqual(12);
    expect(top).toContain(sidebar!.commit_id);
    const card = cardText(duckdb, segments, sidebar!.commit_id);
    expect(card.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
    expect(card).toMatch(/^cause click -> Sidebar at onClick \(lab\/Lab\.jsx:\d+:\d+\)$/m);
    expect(card).toMatch(/top type SidebarItem x3,000/);
    // SidebarItem was watched: the card says which prop changed, and how.
    expect(card).toMatch(/^ {2}SidebarItem +lab\/Lab\.jsx:148 +3,000 .* props +onSelect:identity_only$/m);
    expect(card).toMatch(/<- this commit$/m);
    const [{ n }] = JSON.parse(querySql(duckdb, segments, 'SELECT count(*) AS n FROM commits', { session, format: 'json' }));
    expect(n).toBeGreaterThan(0);
    expect(() => cardText(duckdb, segments, `${session}.1.999999`)).toThrow(/no commit/);
  });

  test('measures every slow click, and its buckets are unions of intervals that sum to its duration', () => {
    // The clicks on #bench-medium, #bench-large, #bug-effect and #bug-hoist
    // all take over 16 ms.
    const rows = recomputeBuckets(dir);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(bucketProblems(r), JSON.stringify(r)).toEqual([]);
    const [{ onPath }] = sql(`SELECT count(*) AS onPath FROM read_parquet('${dir}/commits-*.parquet') WHERE on_critical_path`);
    expect(onPath).toBeGreaterThanOrEqual(4);
  });
});

describe('capture --isolate', () => {
  const url = () => `${origin(plain)}/react-19.3.0/lab.html`;

  test('makes a page served without COOP and COEP cross-origin isolated', async () => {
    let isolatedPage: unknown = null;
    await withCapture(root, 'isolate-on', url(), { isolate: true }, async (_cdp, page) => {
      isolatedPage = await page.eval('crossOriginIsolated');
    });
    expect(isolatedPage).toBe(true);
  }, 120_000);

  test('leaves it alone without the flag', async () => {
    let isolatedPage: unknown = null;
    await withCapture(root, 'isolate-off', url(), {}, async (_cdp, page) => {
      isolatedPage = await page.eval('crossOriginIsolated');
    });
    expect(isolatedPage).toBe(false);
  }, 120_000);
});
