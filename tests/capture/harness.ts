import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CaptureResult, capture, duckdbPath } from '../../packages/capture/src/capture.ts';
import { CdpClient } from '../../packages/capture/src/cdp.ts';
import { type CaptureConfig, DEFAULTS } from '../../packages/capture/src/config.ts';
import { captureEndpoint } from '../../packages/capture/src/watch.ts';

// Capture end to end: a headless Chromium launched by capture, a fixture page
// driven with trusted input over a second CDP connection (found the way
// react-log watch finds it), then the Parquet segments queried.

export const duckdb = duckdbPath();

export function sql<T = any>(query: string): T[] {
  const out = execFileSync(duckdb, ['-json', ':memory:', '-c', query], { maxBuffer: 64 * 1024 * 1024 }).toString().trim();
  return out === '' ? [] : JSON.parse(out);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The isolated fixture server runs in a child process, so a test that blocks
// this process (where capture runs) does not block the page's loads.
export async function serveInChild(): Promise<{ origin: string; child: ChildProcess }> {
  const serve = join(dirname(fileURLToPath(import.meta.url)), '../../fixture/serve.ts');
  const child = spawn(process.execPath, [serve], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d) => {
      out += d;
      const m = /localhost:(\d+)\//.exec(out);
      if (m !== null) resolve(m[1]!);
    });
    child.on('exit', (code) => reject(new Error(`fixture server exited (${code})`)));
  });
  return { origin: `http://127.0.0.1:${port}`, child };
}

export interface Tab {
  sessionId: string;
  eval<T = any>(expression: string): Promise<T>;
  // The page has rendered with the shim in place.
  ready(): Promise<void>;
  // A trusted click, and the render it causes is done.
  click(selector: string): Promise<void>;
  // The shim has handed every record to the binding.
  settle(): Promise<void>;
}

// On the lab, a click is done when the lab's click listener has timed it;
// on other pages, when the button's text changes.
export function tab(cdp: CdpClient, sessionId: string, page: 'lab' | 'chains' | 'other'): Tab {
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
  const lab = page === 'lab';
  return {
    sessionId,
    eval: evaluate,
    ready: () =>
      poll(
        lab
          ? `window.__reactLog && window.__lab && document.querySelector('#bench-large')`
          : page === 'chains'
            ? `window.__reactLog && document.querySelector('#store')`
            : `window.__reactLog && document.readyState === 'complete'`,
      ),
    async click(selector) {
      const el = `document.querySelector(${JSON.stringify(selector)})`;
      await poll(el);
      const before = await evaluate<unknown>(lab ? 'window.__lab.last && window.__lab.last.end' : `${el}.textContent`);
      const box = await evaluate<{ x: number; y: number }>(
        `(() => { const el = ${el}; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
      }
      await poll(lab ? `window.__lab.last && window.__lab.last.end !== ${JSON.stringify(before)}` : `${el}.textContent !== ${JSON.stringify(before)}`);
    },
    async settle() {
      await poll('window.__reactLog.pending() === 0');
    },
  };
}

export async function attachTab(cdp: CdpClient, targetId: string, page: 'lab' | 'chains' | 'other'): Promise<Tab> {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const t = tab(cdp, sessionId, page);
  await t.ready();
  return t;
}

export function configFor(root: string, name: string): CaptureConfig {
  return {
    ...DEFAULTS,
    launch: { chromePath: null, userDataDir: join(root, `profile-${name}`), isolate: false },
    segments: { dir: join(root, name), rotateSeconds: 2, rotateRows: 200_000 },
  };
}

export interface CaptureRun {
  result: CaptureResult;
  dir: string;
  logs: string[];
  targetId: string;
}

// Runs capture --launch <url> in process, and hands `drive` a second CDP
// connection to the same browser, read from the segments marker file.
export async function withCapture(
  root: string,
  name: string,
  url: string,
  opts: { isolate?: boolean },
  drive: (cdp: CdpClient, launched: Tab) => Promise<void>,
): Promise<CaptureRun> {
  const config = configFor(root, name);
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
    const kind = url.includes('/lab.html') ? 'lab' : url.includes('/chains.html') ? 'chains' : 'other';
    await drive(cdp, await attachTab(cdp, page.targetId, kind));
    // Binding calls reach capture on its own connection; give the last ones a moment.
    await sleep(500);
  } catch (e) {
    // Stop capture and let it close its browser before failing.
    cdp.close();
    abort.abort();
    await running.catch(() => {});
    throw e;
  }
  cdp.close();
  abort.abort();
  return { result: await running, dir: config.segments.dir, logs, targetId };
}
