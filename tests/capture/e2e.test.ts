import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureServer } from '../../fixture/serve.ts';
import { type CaptureResult, capture, duckdbPath } from '../../packages/capture/src/capture.ts';
import { CdpClient } from '../../packages/capture/src/cdp.ts';
import { type CaptureConfig, DEFAULTS } from '../../packages/capture/src/config.ts';
import { captureEndpoint, watch } from '../../packages/capture/src/watch.ts';

// react-log capture end to end: a headless Chromium launched by capture, the
// fixture lab driven with trusted input over a second CDP connection (found
// the way react-log watch finds it), then the Parquet segments checked.

const duckdb = duckdbPath();
const root = mkdtempSync(join(tmpdir(), 'react-log-e2e-'));
let isolated: Server;
let plain: Server;
const origin = (s: Server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;

beforeAll(async () => {
  isolated = await startFixtureServer(0);
  plain = await startFixtureServer(0, { isolate: false });
});
afterAll(() => {
  isolated.close();
  plain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function sql<T = any>(query: string): T[] {
  const out = execFileSync(duckdb, ['-json', ':memory:', '-c', query]).toString().trim();
  return out === '' ? [] : JSON.parse(out);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tab {
  sessionId: string;
  eval<T = any>(expression: string): Promise<T>;
  // The lab has rendered with the shim in place.
  ready(): Promise<void>;
  click(selector: string): Promise<void>;
  // The shim has handed every record to the binding.
  settle(): Promise<void>;
}

function tab(cdp: CdpClient, sessionId: string): Tab {
  // Each call gets 5 s: a navigation that swaps renderer processes can drop a
  // pending command without a reply.
  const evaluate = async <T>(expression: string): Promise<T> => {
    const sent = cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    const r = await Promise.race([sent, sleep(5000).then(() => Promise.reject(new Error(`no reply: ${expression.slice(0, 80)}`)))]);
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    return r.result.value as T;
  };
  // Polled from here, one short evaluate at a time, so it survives navigations.
  const poll = async (condition: string) => {
    for (let i = 0; ; i++) {
      if (await evaluate<boolean>(`(() => { try { return !!(${condition}); } catch { return false; } })()`).catch(() => false)) return;
      if (i > 400) throw new Error(`timed out: ${condition}`);
      await sleep(50);
    }
  };
  return {
    sessionId,
    eval: evaluate,
    ready: () => poll(`window.__reactLog && window.__lab && document.querySelector('#bench-large')`),
    async click(selector) {
      await poll(`document.querySelector(${JSON.stringify(selector)})`);
      const before = await evaluate<number | null>('window.__lab.last && window.__lab.last.end');
      const box = await evaluate<{ x: number; y: number }>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
      }
      await poll(`window.__lab.last && window.__lab.last.end !== ${JSON.stringify(before)}`);
    },
    async settle() {
      await poll('window.__reactLog.pending() === 0');
    },
  };
}

async function attachTab(cdp: CdpClient, targetId: string): Promise<Tab> {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const t = tab(cdp, sessionId);
  await t.ready();
  return t;
}

function configFor(name: string): CaptureConfig {
  return {
    ...DEFAULTS,
    urlMatch: '127.0.0.1',
    launch: { chromePath: null, userDataDir: join(root, `profile-${name}`), isolate: false },
    segments: { dir: join(root, name), rotateSeconds: 2, rotateRows: 200_000 },
  };
}

// Runs capture --launch <url> in process, and hands `drive` a second CDP
// connection to the same browser, read from the segments marker file.
async function withCapture(
  name: string,
  url: string,
  opts: { isolate?: boolean },
  drive: (cdp: CdpClient, launched: Tab) => Promise<void>,
): Promise<{ result: CaptureResult; dir: string; logs: string[]; targetId: string }> {
  const config = configFor(name);
  const abort = new AbortController();
  const logs: string[] = [];
  const running = capture({ config, launch: url, headless: true, isolate: opts.isolate, duckdb, signal: abort.signal, log: (l) => logs.push(l) });
  let failed: unknown = null;
  running.catch((e) => (failed = e));
  const marker = join(config.segments.dir, '.capture.json');
  for (let i = 0; !existsSync(marker); i++) {
    if (failed !== null) throw failed;
    if (i > 300) throw new Error('capture never wrote its marker file');
    await sleep(50);
  }
  const cdp = await CdpClient.connect(captureEndpoint(config.segments.dir));
  let targetId = '';
  try {
    let page: { targetId: string } | undefined;
    for (let i = 0; page === undefined; i++) {
      if (i > 300) throw new Error(`no page for ${url}`);
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
      page = targetInfos.find((t) => t.type === 'page' && t.url === url);
      if (page === undefined) await sleep(50);
    }
    targetId = page.targetId;
    await drive(cdp, await attachTab(cdp, page.targetId));
    // Binding calls reach capture on its own connection; give the last ones a moment.
    await sleep(500);
  } finally {
    cdp.close();
    abort.abort();
  }
  return { result: await running, dir: config.segments.dir, logs, targetId };
}

describe.each(['19.3.0', '18.3.1'])('capture against the lab on React %s', (version) => {
  let run: Awaited<ReturnType<typeof withCapture>>;
  let seg = '';
  let defs = '';

  beforeAll(async () => {
    const url = `${origin(isolated)}/react-${version}/lab.html`;
    run = await withCapture(`e2e-${version}`, url, {}, async (cdp, page) => {
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
      // A tab opened with a URL while capture runs is paused, instrumented,
      // then resumed, and the shim still runs before the page's scripts.
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const second = await attachTab(cdp, targetId);
      expect(await second.eval('window.__reactLog.status')).toBe('active');
      await second.click('#bug-budget');
      await second.settle();
    });
    const main = run.result.sessions.find((s) => JSON.parse(readFileSync(join(s.dir, 'session.json'), 'utf8')).target_id === run.targetId);
    expect(main, JSON.stringify(run.result)).toBeDefined();
    seg = `read_parquet('${main!.dir}/seg-*.parquet')`;
    defs = `read_parquet('${main!.dir}/defs-*.parquet')`;
  }, 120_000);

  test('writes one session per tab, with no drops and no errors', () => {
    expect(run.result.sessions).toHaveLength(2);
    for (const s of run.result.sessions) {
      const info = JSON.parse(readFileSync(join(s.dir, 'session.json'), 'utf8'));
      expect(info.react_version).toBe(version);
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
});

describe('capture --isolate', () => {
  const url = () => `${origin(plain)}/react-19.3.0/lab.html`;

  test('makes a page served without COOP and COEP cross-origin isolated', async () => {
    let isolatedPage: unknown = null;
    await withCapture('isolate-on', url(), { isolate: true }, async (_cdp, page) => {
      isolatedPage = await page.eval('crossOriginIsolated');
    });
    expect(isolatedPage).toBe(true);
  }, 120_000);

  test('leaves it alone without the flag', async () => {
    let isolatedPage: unknown = null;
    await withCapture('isolate-off', url(), {}, async (_cdp, page) => {
      isolatedPage = await page.eval('crossOriginIsolated');
    });
    expect(isolatedPage).toBe(false);
  }, 120_000);
});
