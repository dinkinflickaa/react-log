import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureServer } from '../../fixture/serve.ts';
import { serveInChild, sleep, sql, tab, withCapture } from './harness.ts';

// Which documents capture records: every tab and iframe with a development
// React, and nothing else. A production React on a page, or a tab without a
// development React, never stops capture.

const root = mkdtempSync(join(tmpdir(), 'react-log-targets-'));
let isolated: { origin: string; child: ChildProcess };
let plain: Server;
const plainOrigin = () => `http://127.0.0.1:${(plain.address() as { port: number }).port}`;
// What a production react-dom does when it loads under a DevTools hook.
const PRODUCTION = `window.__REACT_DEVTOOLS_GLOBAL_HOOK__.inject({ version: '18.2.0', bundleType: 0, rendererPackageName: 'react-dom' })`;

beforeAll(async () => {
  isolated = await serveInChild();
  plain = await startFixtureServer(0, { isolate: false });
});
afterAll(() => {
  isolated.child.kill();
  plain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sessionInfo = (dir: string) => JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
const commits = (dir: string) => Number(sql(`SELECT count(*) AS n FROM read_parquet('${dir}/commits-*.parquet')`)[0].n);

describe('capture across tabs and frames', () => {
  test('a production React beside the development one is skipped, and the page keeps recording', async () => {
    const run = await withCapture(root, 'beside', `${isolated.origin}/react-19.3.0/lab.html`, {}, async (_cdp, page) => {
      await page.eval(PRODUCTION);
      await page.click('#bug-budget');
      await page.settle();
    });
    expect(run.result.sessions).toHaveLength(1);
    const { dir } = run.result.sessions[0]!;
    const info = sessionInfo(dir);
    expect(info.react_version).toBe('19.3.0');
    expect(info.refused).toBeNull();
    expect(info.renderers.map((r: any) => [r.version, r.skipped])).toEqual([
      ['19.3.0', null],
      ['18.2.0', 'not-a-dev-build'],
    ]);
    expect(run.logs.some((l) => l.includes('React 18.2.0 is a production build; not recorded'))).toBe(true);
    // The page load, and the click after the production React registered.
    expect(commits(dir)).toBeGreaterThanOrEqual(2);
  });

  test('a tab with only a production React records nothing, until it loads a development one', async () => {
    const run = await withCapture(root, 'tabs', `${isolated.origin}/react-19.3.0/lab.html`, {}, async (cdp) => {
      // A second tab on the fixture's index of links, which has no React, then
      // a production one.
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `${isolated.origin}/` });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const second = tab(cdp, sessionId, 'other');
      await second.ready();
      await second.eval(PRODUCTION);
      await second.eval('window.__reactLog.flushNow()');
      await sleep(300);
      // The same tab navigates to a page with a development React.
      await cdp.send('Page.navigate', { url: `${isolated.origin}/react-19.3.0/chains.html` }, sessionId);
      const chains = tab(cdp, sessionId, 'chains');
      await chains.ready();
      await chains.click('#batch');
      await chains.settle();
    });
    expect(run.logs.some((l) => l.includes(`${isolated.origin}/: React 18.2.0 is a production build; not recorded`))).toBe(true);
    expect(run.result.sessions).toHaveLength(2);
    const second = run.result.sessions.find((s) => s.url.endsWith('/chains.html'))!;
    const info = sessionInfo(second.dir);
    // Only the chains page: the index page never registered a development React.
    expect(info.page_loads.map((p: any) => p.url)).toEqual([`${isolated.origin}/react-19.3.0/chains.html`]);
    expect(info.renderers.map((r: any) => r.version)).toEqual(['19.3.0']);
    expect(commits(second.dir)).toBeGreaterThanOrEqual(2);
  });

  test('an iframe from another site is a target of its own, recorded as its own session', async () => {
    const run = await withCapture(root, 'frames', `${plainOrigin()}/react-19.3.0/frames.html`, {}, async (cdp) => {
      let frame: { targetId: string } | undefined;
      for (let i = 0; frame === undefined; i++) {
        if (i > 200) throw new Error('no iframe target for chains.html');
        const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
        frame = targetInfos.find((t) => t.type === 'iframe' && t.url.includes('/chains.html'));
        if (frame === undefined) await sleep(50);
      }
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: frame.targetId, flatten: true });
      const inner = tab(cdp, sessionId, 'chains');
      await inner.ready();
      await inner.settle();
    });
    // The top page has no React, so the iframe's is the only session.
    expect(run.result.sessions.map((s) => new URL(s.url).hostname)).toEqual(['localhost']);
    const { dir, url } = run.result.sessions[0]!;
    expect(url).toMatch(/\/react-19\.3\.0\/chains\.html$/);
    expect(sessionInfo(dir).react_version).toBe('19.3.0');
    expect(commits(dir)).toBeGreaterThan(0);
  });
});
