// Overhead benchmark (PLAN.md, Overhead). For each React version, open three
// tabs: the shim, an empty DevTools hook, and no hook at all. Click the lab's
// small, medium and large interactions with trusted CDP input, alternating
// between the tabs click by click, and time each run in the page from the
// input event's timestamp to the end of React's commit.
//
//   node bench/overhead.ts [--versions 18.3.1,19.3.0] [--loads 3] [--runs 10] [--warmup 5] [--json out.json]
//
// Passes when the shim adds at most 5% over the empty hook at p50 and at p95
// for every interaction, and its longest task stays under 4 ms. React itself
// reacts to any DevTools hook (on 18.x, 19.0 and 19.1 it times every fiber),
// which no hook-based tool can avoid, so the no-hook tab is reported next to
// it but not gated.
//
// Every click comes at least 1.1 s after the same tab's previous one. React
// 19 dev captures an owner stack (an Error and a console task) for the first
// 10,000 elements created in each window of at least 1 s, reset when a render
// starts. Without the gap, whether a click pays for those stacks depends on
// how soon it follows the previous one, which moves the large interaction
// between about 45 and 150 ms in both modes.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CdpClient } from '../packages/capture/src/cdp.ts';
import { launchChrome } from '../packages/capture/src/chrome.ts';
import { startFixtureServer } from '../fixture/serve.ts';
import { bundleShim } from '../packages/shim/build.ts';

const INTERACTIONS = [
  { name: 'small', button: '#bench-small' },
  { name: 'medium', button: '#bench-medium' },
  { name: 'large', button: '#bench-large' },
] as const;
const BAR_PCT = 5;
const BAR_TASK_MS = 4;
const GAP_MS = 1100;

// An inert hook: React sees DevTools and turns on what it does for it
// (per-fiber profiler timers, updater tracking); nothing is recorded.
const EMPTY_HOOK = `Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { configurable: true, value: {
  renderers: new Map(), supportsFiber: true, inject() { return 1; }, onCommitFiberRoot() {}, onPostCommitFiberRoot() {},
  onCommitFiberUnmount() {}, onScheduleFiberRoot() {}, setStrictMode() {}, checkDCE() {} } });`;

type Mode = 'off' | 'on' | 'hook';

const { values } = parseArgs({
  options: {
    versions: { type: 'string', default: '18.3.1,19.3.0' },
    loads: { type: 'string', default: '3' },
    runs: { type: 'string', default: '10' },
    warmup: { type: 'string', default: '5' },
    json: { type: 'string' },
  },
});
const versions = values.versions!.split(',');
const loads = Number(values.loads);
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const modes: Mode[] = ['on', 'hook', 'off'];

// quantile_cont: linear interpolation between closest ranks.
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

interface Tab {
  mode: Mode;
  targetId: string;
  sessionId: string;
  eval: <T>(expression: string) => Promise<T>;
  sinkBytes: number;
  maxTaskMs: number;
  maxIdleMs: number;
  maxObserverMs: number;
  maxWalkMs: number;
}

async function openTab(cdp: CdpClient, url: string, mode: Mode, shim: string): Promise<Tab> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const tab: Tab = {
    mode,
    targetId,
    sessionId,
    sinkBytes: 0,
    maxTaskMs: 0,
    maxIdleMs: 0,
    maxObserverMs: 0,
    maxWalkMs: 0,
    eval: async <T>(expression: string): Promise<T> => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
      return r.result.value as T;
    },
  };
  cdp.on((e) => {
    if (e.sessionId === sessionId && e.method === 'Runtime.bindingCalled') tab.sinkBytes += e.params.payload.length;
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  if (mode === 'on') {
    await cdp.send('Runtime.addBinding', { name: '__reactLogSink' }, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shim }, sessionId);
  } else if (mode === 'hook') {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: EMPTY_HOOK }, sessionId);
  }
  const loaded = cdp.waitFor((e) => e.sessionId === sessionId && e.method === 'Page.loadEventFired');
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  await tab.eval(`new Promise((r) => { const f = () => document.querySelector('#bench-large') ? r(true) : setTimeout(f, 20); f(); })`);
  return tab;
}

// Every shim tab has flushed, so no tab's idle work overlaps a measured click.
async function quiet(tabs: Tab[]): Promise<void> {
  for (const t of tabs) {
    if (t.mode === 'on') await t.eval(`new Promise((r) => { const f = () => window.__reactLog.pending() === 0 ? r(true) : setTimeout(f, 10); f(); })`);
  }
}

async function click(cdp: CdpClient, tabs: Tab[], tab: Tab, selector: string): Promise<number> {
  await cdp.send('Page.bringToFront', {}, tab.sessionId);
  await quiet(tabs);
  // The gap, then a full GC and an idle period: identical in every mode.
  await tab.eval(`new Promise((r) => { const f = () => (window.__lab.last === null || performance.now() - window.__lab.last.end > ${GAP_MS} ? r(true) : setTimeout(f, 20)); f(); })`);
  await tab.eval('gc(); new Promise((r) => requestIdleCallback(() => r(true), { timeout: 500 }))');
  const box = await tab.eval<{ x: number; y: number }>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await tab.eval('new Promise((r) => requestAnimationFrame(() => r(true)))');
  const before = await tab.eval<number | null>('window.__lab.last && window.__lab.last.end');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, tab.sessionId);
  }
  const last = await tab.eval<{ id: string; ms: number }>(
    `new Promise((r) => { const f = () => (window.__lab.last && window.__lab.last.end !== ${JSON.stringify(before)} ? r(window.__lab.last) : setTimeout(f, 2)); f(); })`,
  );
  if (`#${last.id}` !== selector) throw new Error(`clicked ${last.id}, expected ${selector}`);
  return last.ms;
}

const root = fileURLToPath(new URL('..', import.meta.url));
if (!versions.every((v) => existsSync(`${root}fixture/dist/react-${v}/lab.js`))) {
  execFileSync(process.execPath, [`${root}fixture/build.ts`], { stdio: 'inherit' });
}
const server: Server = await startFixtureServer(0);
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const shim = await bundleShim();
const chrome = await launchChrome({ userDataDir: `/tmp/react-log-bench-${process.pid}`, headless: true, args: ['--js-flags=--expose-gc'] });
const cdp = await CdpClient.connect(chrome.wsUrl);

const report: any = { bar: { pct: BAR_PCT, taskMs: BAR_TASK_MS }, gapMs: GAP_MS, loads, runs, warmup, versions: {} };
let pass = true;
try {
  for (const version of versions) {
    const url = `${origin}/react-${version}/lab.html`;
    const ms: Record<Mode, Record<string, number[]>> = { on: {}, off: {}, hook: {} };
    const shimTabs: Tab[] = [];
    for (let load = 0; load < loads; load++) {
      // Rotate which mode loads and clicks first, to cancel ordering effects.
      const order = modes.map((_, i) => modes[(i + load) % modes.length]!);
      process.stderr.write(`React ${version}: load ${load + 1}/${loads} (${order.join(', ')})\n`);
      const tabs: Tab[] = [];
      for (const mode of order) tabs.push(await openTab(cdp, url, mode, shim));
      for (const it of INTERACTIONS) {
        for (let i = 0; i < warmup; i++) for (const t of tabs) await click(cdp, tabs, t, it.button);
        for (const t of tabs) {
          if (t.mode === 'on') await t.eval('Object.assign(window.__reactLog.stats, { maxTaskMs: 0, maxIdleMs: 0, maxObserverMs: 0, maxWalkMs: 0 })');
        }
        for (let i = 0; i < runs; i++) {
          // Alternate which tab goes first within each pair of runs.
          const seq = i % 2 === 0 ? tabs : [...tabs].reverse();
          for (const t of seq) (ms[t.mode][it.name] ??= []).push(await click(cdp, tabs, t, it.button));
        }
        await quiet(tabs);
        for (const t of tabs) {
          if (t.mode !== 'on') continue;
          const stats = await t.eval<{ maxTaskMs: number; maxIdleMs: number; maxObserverMs: number; maxWalkMs: number }>('window.__reactLog.stats');
          t.maxTaskMs = Math.max(t.maxTaskMs, stats.maxTaskMs);
          t.maxIdleMs = Math.max(t.maxIdleMs, stats.maxIdleMs);
          t.maxObserverMs = Math.max(t.maxObserverMs, stats.maxObserverMs);
          t.maxWalkMs = Math.max(t.maxWalkMs, stats.maxWalkMs);
        }
      }
      for (const t of tabs) {
        if (t.mode === 'on') shimTabs.push(t);
        await cdp.send('Target.closeTarget', { targetId: t.targetId });
      }
    }

    const rows = INTERACTIONS.map(({ name }) => {
      const on = ms.on[name]!;
      const hook = ms.hook[name]!;
      const off = ms.off[name]!;
      const r = {
        interaction: name,
        n: on.length,
        hook_p50: quantile(hook, 0.5),
        on_p50: quantile(on, 0.5),
        hook_p95: quantile(hook, 0.95),
        on_p95: quantile(on, 0.95),
        off_p50: quantile(off, 0.5),
        off_p95: quantile(off, 0.95),
        d_p50_pct: 0,
        d_p95_pct: 0,
        vs_off_p50_pct: 0,
        vs_off_p95_pct: 0,
        pass: false,
      };
      const pct = (a: number, b: number) => ((a - b) / b) * 100;
      r.d_p50_pct = pct(r.on_p50, r.hook_p50);
      r.d_p95_pct = pct(r.on_p95, r.hook_p95);
      r.vs_off_p50_pct = pct(r.on_p50, r.off_p50);
      r.vs_off_p95_pct = pct(r.on_p95, r.off_p95);
      r.pass = r.d_p50_pct <= BAR_PCT && r.d_p95_pct <= BAR_PCT;
      return r;
    });
    const maxTaskMs = Math.max(...shimTabs.map((t) => t.maxTaskMs));
    const maxIdleMs = Math.max(...shimTabs.map((t) => t.maxIdleMs));
    const maxObserverMs = Math.max(...shimTabs.map((t) => t.maxObserverMs));
    const maxWalkMs = Math.max(...shimTabs.map((t) => t.maxWalkMs));
    const taskPass = maxTaskMs < BAR_TASK_MS;
    pass &&= taskPass && rows.every((r) => r.pass);
    report.versions[version] = { rows, maxTaskMs, maxIdleMs, maxObserverMs, maxWalkMs, taskPass, sinkKbPerLoad: shimTabs.map((t) => Math.round(t.sinkBytes / 1024)), raw: ms };

    const f = (x: number) => x.toFixed(2).padStart(7);
    const p = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`.padStart(7);
    console.log(`\nReact ${version}: ${loads} loads per mode, ${runs} measured runs per load after ${warmup} warm-up, clicks alternate between tabs`);
    console.log('shim vs empty hook (gated)                                              | shim vs no hook (reported)');
    console.log('interaction    n  hook p50   on p50   Δp50   hook p95   on p95   Δp95  pass |  off p50   Δp50   off p95   Δp95');
    for (const r of rows) {
      console.log(
        `${r.interaction.padEnd(11)} ${String(r.n).padStart(4)}  ${f(r.hook_p50)}  ${f(r.on_p50)} ${p(r.d_p50_pct)}   ${f(r.hook_p95)}  ${f(r.on_p95)} ${p(r.d_p95_pct)}  ${r.pass ? 'yes' : 'NO '} |` +
          ` ${f(r.off_p50)} ${p(r.vs_off_p50_pct)}   ${f(r.off_p95)} ${p(r.vs_off_p95_pct)}`,
      );
    }
    console.log(
      `longest shim task ${maxTaskMs.toFixed(2)} ms (bar ${BAR_TASK_MS} ms): ${taskPass ? 'yes' : 'NO'} ` +
        `(idle slice ${maxIdleMs.toFixed(2)} ms, observer callback ${maxObserverMs.toFixed(2)} ms); longest commit walk ${maxWalkMs.toFixed(2)} ms`,
    );
  }
} finally {
  cdp.close();
  await chrome.close();
  server.close();
}
console.log(`\noverhead benchmark: ${pass ? 'PASS' : 'FAIL'} (times in ms)`);
if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
process.exitCode = pass ? 0 : 1;
