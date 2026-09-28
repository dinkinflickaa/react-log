import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test-only Chromium launcher and CDP client over Node's built-in WebSocket.

export function findChrome(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (existsSync(pw)) {
    for (const dir of readdirSync(pw).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const bin of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = join(pw, dir, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

type Message = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };

export class Cdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: Message) => void>();
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Message;
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(`${JSON.stringify(m.error)}`));
        else p?.resolve(m.result);
      } else {
        for (const l of this.listeners) l(m);
      }
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(listener: (m: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  once(pred: (m: Message) => boolean, timeoutMs = 15_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('timed out waiting for a CDP event'));
      }, timeoutMs);
      const off = this.on((m) => {
        if (!pred(m)) return;
        clearTimeout(timer);
        off();
        resolve(m);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export interface Browser {
  cdp: Cdp;
  close(): Promise<void>;
}

export async function launch(): Promise<Browser> {
  const bin = findChrome();
  if (bin === null) throw new Error('No Chrome or Chromium found. Set CHROME_PATH.');
  const profile = mkdtempSync(join(tmpdir(), 'react-log-test-'));
  const args = [
    '--headless',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank',
  ];
  const proc: ChildProcess = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${stderr}`)), 30_000);
    proc.stderr!.on('data', (d) => {
      stderr += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m !== null) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited with ${code}:\n${stderr}`)));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  return {
    cdp,
    async close() {
      const exited = new Promise((r) => proc.once('exit', r));
      // Browser.close lets Chrome's helper processes finish before the
      // profile directory goes; kill is the fallback.
      await Promise.race([cdp.send('Browser.close').catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      cdp.close();
      if (proc.exitCode === null) proc.kill();
      await exited;
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // A leftover temp profile is harmless.
      }
    },
  };
}

export interface Page {
  messages: any[];
  evaluate<T = unknown>(expression: string): Promise<T>;
  click(selector: string): Promise<void>;
  // Flush the shim and return the batch rows and defs received since the last call.
  take(): Promise<{ rows: any[][]; defs: any[][] }>;
  close(): Promise<void>;
}

// Opens a page with the shim injected before any page script, the way the
// capture program will: a CDP binding for the sink, then the shim as a
// new-document script. `before` runs first, to simulate a pre-existing hook.
export async function openPage(cdp: Cdp, url: string, shim: string, before?: string): Promise<Page> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const messages: any[] = [];
  const off = cdp.on((m) => {
    if (m.sessionId === sessionId && m.method === 'Runtime.bindingCalled' && m.params.name === '__reactLogSink') {
      messages.push(JSON.parse(m.params.payload));
    }
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.addBinding', { name: '__reactLogSink' }, sessionId);
  if (before !== undefined) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: before }, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shim }, sessionId);
  const loaded = cdp.once((m) => m.sessionId === sessionId && m.method === 'Page.loadEventFired');
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    return r.result.value as T;
  };
  let seen = 0;
  const settle = () => new Promise((r) => setTimeout(r, 150));
  return {
    messages,
    evaluate,
    async click(selector) {
      const box = await evaluate<{ x: number; y: number } | null>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      if (box === null) throw new Error(`no element ${selector}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
      }
      await settle();
    },
    async take() {
      await settle();
      await evaluate('window.__reactLog.flushNow()');
      await settle();
      const rows: any[][] = [];
      const defs: any[][] = [];
      for (; seen < messages.length; seen++) {
        const m = messages[seen];
        if (m.t !== 'batch') continue;
        rows.push(...m.rows);
        defs.push(...m.defs);
      }
      return { rows, defs };
    },
    async close() {
      off();
      await cdp.send('Target.closeTarget', { targetId });
    },
  };
}
