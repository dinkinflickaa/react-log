// Soak test (PLAN.md, Phase 2 acceptance). Runs `react-log capture --launch`
// as a child process against the fixture lab for an hour while a second CDP
// connection clicks through every lab interaction about once a second and
// reloads the page every 15 minutes. Once a minute it samples the Parquet row
// count, the capture process's resident memory, the page's JS heap and the
// dropped-row count.
//
//   node bench/soak.ts [--minutes 60] [--version 19.3.0] [--reload-every 15] [--json out.json]
//
// Passes when the row count grows at every sample, capture's memory is flat
// (mean RSS over the last 10 minutes within 10% of the mean over minutes 5 to
// 15), and no row was dropped.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startFixtureServer } from '../fixture/serve.ts';
import { duckdbPath } from '../packages/capture/src/capture.ts';
import { CdpClient } from '../packages/capture/src/cdp.ts';

const BUTTONS = ['#bench-small', '#bench-medium', '#bench-large', '#bug-context', '#bug-memo', '#bug-hoist', '#bug-effect', '#bug-diffuse', '#bug-budget'];

const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '60' },
    version: { type: 'string', default: '19.3.0' },
    'reload-every': { type: 'string', default: '15' },
    json: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
const minutes = Number(values.minutes);
const reloadEveryMs = Number(values['reload-every']) * 60_000;

const repo = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(`${repo}fixture/dist/react-${values.version}/lab.js`)) {
  execFileSync(process.execPath, [`${repo}fixture/build.ts`], { stdio: 'inherit' });
}
const duckdb = duckdbPath();
const work = mkdtempSync(join(tmpdir(), 'react-log-soak-'));
const segments = join(work, 'segments');
const configPath = join(work, 'react-log.config.json');
writeFileSync(
  configPath,
  JSON.stringify({ urlMatch: '127.0.0.1', launch: { userDataDir: join(work, 'profile') }, segments: { dir: segments, rotateSeconds: 10, rotateRows: 200_000 } }),
);

const server: Server = await startFixtureServer(0);
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/react-${values.version}/lab.html`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [`${repo}packages/cli/bin/react-log.js`, 'capture', '--launch', url, '--headless', '--config', configPath], {
  stdio: ['ignore', 'inherit', 'pipe'],
});
let captureLog = '';
child.stderr!.on('data', (d) => {
  captureLog += d;
  process.stderr.write(d);
});
const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));

function rssMb(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return Number(/VmRSS:\s+(\d+) kB/.exec(status)![1]) / 1024;
}

function sql<T = any>(query: string): T[] {
  const out = execFileSync(duckdb, ['-json', ':memory:', '-c', query]).toString().trim();
  return out === '' ? [] : JSON.parse(out);
}

function sessionsDropped(): number {
  let dropped = 0;
  for (const d of readdirSync(segments)) {
    const f = join(segments, d, 'session.json');
    if (existsSync(f)) dropped += JSON.parse(readFileSync(f, 'utf8')).dropped ?? 0;
  }
  return dropped;
}

interface Sample {
  minute: number;
  rows: number;
  files: number;
  rssMb: number;
  pageHeapMb: number;
  dropped: number;
  clicks: number;
  reloads: number;
  driverErrors: number;
}

const samples: Sample[] = [];
let clicks = 0;
let reloads = 0;
let driverErrors = 0;
let failure: string | null = null;

try {
  const marker = join(segments, '.capture.json');
  for (let i = 0; !existsSync(marker); i++) {
    if (child.exitCode !== null || i > 600) throw new Error(`capture did not start:\n${captureLog}`);
    await sleep(100);
  }
  const cdp = await CdpClient.connect(JSON.parse(readFileSync(marker, 'utf8')).cdp);
  let sessionId = '';
  for (let i = 0; sessionId === ''; i++) {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page' && t.url === url);
    if (page !== undefined) sessionId = (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    else if (i > 600) throw new Error('the lab page never appeared');
    else await sleep(100);
  }
  await cdp.send('Runtime.enable', {}, sessionId);
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value as T;
  };
  const ready = () => evaluate<boolean>(`!!window.__reactLog && !!window.__lab && !!document.querySelector('#bench-large')`).catch(() => false);
  while (!(await ready())) await sleep(100);

  const click = async (selector: string) => {
    const box = await evaluate<{ x: number; y: number }>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
    }
  };

  const t0 = Date.now();
  let nextSample = t0 + 60_000;
  let nextReload = t0 + reloadEveryMs;
  process.stderr.write(`soak: ${minutes} min against ${url}; capture pid ${child.pid}; segments in ${segments}\n`);
  process.stderr.write('minute      rows   Δrows  files  capture RSS MB  page heap MB  dropped  clicks\n');
  while (samples.length < minutes) {
    if (child.exitCode !== null) throw new Error(`capture exited early (${child.exitCode})`);
    try {
      if (Date.now() >= nextReload) {
        nextReload += reloadEveryMs;
        await evaluate('window.__beforeReload = true');
        await cdp.send('Page.reload', {}, sessionId);
        for (let i = 0; !(await evaluate<boolean>('!window.__beforeReload').catch(() => false) && (await ready())); i++) {
          if (i > 600) throw new Error('the page did not reload');
          await sleep(100);
        }
        reloads++;
      }
      await click(BUTTONS[clicks % BUTTONS.length]!);
      clicks++;
    } catch (e) {
      driverErrors++;
      process.stderr.write(`soak: driver error: ${(e as Error).message}\n`);
    }
    await sleep(1000);
    if (Date.now() >= nextSample) {
      nextSample += 60_000;
      const [{ n, files }] = sql<{ n: number; files: number }>(
        `SELECT count(*) AS n, count(DISTINCT filename) AS files FROM read_parquet('${segments}/*/seg-*.parquet', filename = true)`,
      );
      const heap = await cdp.send<{ usedSize: number }>('Runtime.getHeapUsage', {}, sessionId).catch(() => ({ usedSize: NaN }));
      const s: Sample = {
        minute: samples.length + 1,
        rows: n,
        files,
        rssMb: rssMb(child.pid!),
        pageHeapMb: heap.usedSize / 1e6,
        dropped: sessionsDropped(),
        clicks,
        reloads,
        driverErrors,
      };
      samples.push(s);
      const prev = samples.length > 1 ? samples[samples.length - 2]!.rows : 0;
      process.stderr.write(
        `${String(s.minute).padStart(6)} ${String(s.rows).padStart(9)} ${String(s.rows - prev).padStart(7)} ${String(s.files).padStart(6)} ${s.rssMb.toFixed(1).padStart(15)} ${s.pageHeapMb.toFixed(1).padStart(13)} ${String(s.dropped).padStart(8)} ${String(s.clicks).padStart(7)}\n`,
      );
    }
  }
  cdp.close();
} catch (e) {
  failure = (e as Error).message;
} finally {
  if (child.exitCode === null) child.kill('SIGINT');
  const code = await Promise.race([exited, sleep(60_000).then(() => 'timeout' as const)]);
  if (code === 'timeout') {
    child.kill('SIGKILL');
    failure ??= 'capture did not stop within 60 s of SIGINT';
  } else if (code !== 0) {
    failure ??= `capture exited with ${code}`;
  }
  server.close();
}

// After a clean stop every row is in Parquet: the last count, and the drops.
const [{ n: finalRows, dropRows }] = sql<{ n: number; dropRows: number }>(
  `SELECT count(*) AS n, count(*) FILTER (kind = 'dropped') AS dropRows FROM read_parquet('${segments}/*/seg-*.parquet')`,
);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const early = samples.filter((s) => s.minute >= 5 && s.minute <= 15).map((s) => s.rssMb);
const late = samples.slice(-10).map((s) => s.rssMb);
const growing = samples.length > 0 && samples.every((s, i) => i === 0 || s.rows > samples[i - 1]!.rows);
const flat = early.length > 0 && late.length > 0 && mean(late) <= mean(early) * 1.1;
const noDrops = sessionsDropped() === 0 && dropRows === 0;
const longEnough = samples.length >= minutes;
const pass = failure === null && growing && flat && noDrops && longEnough;

const summary = {
  minutes,
  version: values.version,
  samples,
  finalRows,
  dropRows,
  earlyRssMb: early.length ? mean(early) : null,
  lateRssMb: late.length ? mean(late) : null,
  growing,
  flat,
  noDrops,
  longEnough,
  failure,
  pass,
};
console.log(`\nsoak: ${samples.length} samples, ${clicks} clicks, ${reloads} reloads, ${driverErrors} driver errors`);
console.log(`rows in Parquet after stop: ${finalRows}; dropped rows: ${dropRows}; session.json dropped: ${sessionsDropped()}`);
console.log(`row count grew at every sample: ${growing ? 'yes' : 'NO'}`);
console.log(
  `capture RSS: minutes 5-15 mean ${summary.earlyRssMb?.toFixed(1)} MB, last 10 minutes mean ${summary.lateRssMb?.toFixed(1)} MB (bar +10%): ${flat ? 'yes' : 'NO'}`,
);
console.log(`no dropped rows: ${noDrops ? 'yes' : 'NO'}`);
if (failure !== null) console.log(`failure: ${failure}`);
console.log(`\nsoak: ${pass ? 'PASS' : 'FAIL'}`);
if (values.json) writeFileSync(values.json, `${JSON.stringify(summary, null, 2)}\n`);
if (!values.keep) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
else console.log(`kept ${work}`);
process.exitCode = pass ? 0 : 1;
