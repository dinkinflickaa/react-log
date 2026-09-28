import { readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureServer } from '../../fixture/serve.ts';
import { bundleShim } from '../../packages/shim/build.ts';
import { actual, INCREMENT, MOUNT, renders, STORE, THEME, TICK, TREE } from '../expected.ts';
import { type Browser, launch, openPage, type Page } from './chrome.ts';

const versions = readdirSync(fileURLToPath(new URL('../../fixture/versions', import.meta.url)))
  .filter((d) => d.startsWith('react-'))
  .map((d) => d.slice('react-'.length))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

let browser: Browser;
let server: Server;
let origin: string;
let shim: string;

beforeAll(async () => {
  [browser, server, shim] = await Promise.all([launch(), startFixtureServer(0), bundleShim()]);
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe.each(versions)('shim in headless Chromium, React %s', (version) => {
  let page: Page;
  const names = new Map<string, string>();
  const idOf = (name: string) => [...names].find(([, n]) => n === name)![0];
  const take = async () => {
    const { rows, defs } = await page.take();
    for (const d of defs) names.set(d[0], d[1]);
    return rows;
  };
  const table = (rows: any[][]) => {
    const list = renders(rows, names);
    return { order: list.map((r) => r.name), table: actual(list) };
  };
  let mount: any[][];

  beforeAll(async () => {
    page = await openPage(browser.cdp, `${origin}/react-${version}/`, shim);
    mount = await take();
  });
  afterAll(async () => {
    await page?.close();
  });

  test('installs and identifies the renderer', async () => {
    expect(await page.evaluate('window.__reactLog.status')).toBe('active');
    expect(page.messages[0].t).toBe('hello');
    expect(page.messages.find((m) => m.t === 'renderer').version.startsWith(version)).toBe(true);
    expect(await page.evaluate('crossOriginIsolated')).toBe(true);
  });

  test('mount', () => {
    const t = table(mount);
    expect(t.order).toEqual(TREE);
    expect(t.table).toEqual(MOUNT);
  });

  test('self_us is non-negative and at most dur_us; parents contain children', () => {
    const list = renders(mount, names);
    for (const { name, row } of list) {
      expect(row[3], `${name} self_us`).toBeGreaterThanOrEqual(0);
      expect(row[3], `${name} self_us <= dur_us`).toBeLessThanOrEqual(row[2]);
    }
    const dur = (n: string) => list.find((r) => r.name === n)!.row[2] as number;
    expect(dur('App')).toBeGreaterThanOrEqual(dur('Layout'));
    expect(dur('Main')).toBeGreaterThanOrEqual(dur('EffectPanel'));
  });

  test('event sequence: renders, then the commit row', () => {
    const kinds = mount.map((r) => r[0]).filter((k) => k === 'render' || k === 'commit');
    expect(kinds).toEqual([...Array(10).fill('render'), 'commit']);
  });

  test('increment: reasons and committed, effect times, update call site', async () => {
    await page.click('#inc');
    const rows = await take();
    const t = table(rows);
    expect(t.order).toEqual(Object.keys(INCREMENT));
    expect(t.table).toEqual(INCREMENT);

    // Per-component effect times: EffectPanel busy-waits 0.3 ms in each effect.
    const panel = idOf('EffectPanel');
    for (const kind of ['layout_effect', 'passive_effect']) {
      const effect = rows.find((r) => r[0] === kind && r[5] === panel);
      expect(effect, `${kind} row for EffectPanel`).toBeDefined();
      expect(effect![2], `${kind} dur_us`).toBeGreaterThanOrEqual(250);
    }

    // The setCount call in App's click handler, a trusted click, blocking lane.
    const update = rows.find((r) => r[0] === 'update_enqueued' && (r[5] === idOf('App') || r[13]?.component === 'App'));
    expect(update, 'update_enqueued for App').toBeDefined();
    expect(update![4]).toBe('Blocking');
    expect(update![12]).toMatch(/app\.js:\d+:\d+/);
    expect(update![12]).not.toMatch(/react-log-shim/);
    expect(update![13].event).toBe('click');

    // A discrete click commits on the sync lane, which flushes passive effects
    // in the same task.
    const commit = rows.find((r) => r[0] === 'commit')!;
    expect(commit[4]).toBe('Blocking');
    expect(commit[13].passiveSync).toBe(true);
  });

  test('theme: changed context', async () => {
    await page.click('#theme');
    const t = table(await take());
    expect(t.order).toEqual(Object.keys(THEME));
    expect(t.table).toEqual(THEME);
  });

  test('store and tick', async () => {
    await page.click('#store');
    expect(table(await take()).table).toEqual(STORE);
    await page.click('#tick');
    expect(table(await take()).table).toEqual(TICK);
  });

  test('performance marks reach the log', async () => {
    await page.evaluate("performance.mark('react-log-test')");
    const rows = await take();
    expect(rows.some((r) => r[0] === 'mark' && r[13].name === 'react-log-test')).toBe(true);
  });

  test('no shim errors, nothing dropped', () => {
    expect(page.messages.filter((m) => m.t === 'error')).toEqual([]);
    expect(page.messages.filter((m) => m.t === 'batch').reduce((n, m) => n + m.dropped, 0)).toBe(0);
  });
});

describe('refusal', () => {
  test('a pre-existing DevTools hook makes the shim refuse and stay out', async () => {
    const extensionLike = 'window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map(), supportsFiber: true, inject() { return 1; } };';
    const page = await openPage(browser.cdp, `${origin}/react-${versions.at(-1)}/`, shim, extensionLike);
    await page.take();
    expect(await page.evaluate('window.__reactLog.status')).toBe('refused');
    const refused = page.messages.find((m) => m.t === 'refused');
    expect(refused?.reason).toBe('devtools-hook-present');
    expect(page.messages.some((m) => m.t === 'batch' && m.rows.length > 0)).toBe(false);
    await page.close();
  });
});
