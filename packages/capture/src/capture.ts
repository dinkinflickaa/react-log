import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bundleShim } from '../../shim/build.ts';
import { CdpClient, type CdpEvent } from './cdp.ts';
import { launchChrome, type LaunchedChrome } from './chrome.ts';
import { type CaptureConfig, expandHome, shimConfig } from './config.ts';
import { Session } from './ingest.ts';
import { SourceMaps } from './sourcemap.ts';

export interface CaptureOptions {
  config: CaptureConfig;
  cdp?: string;
  urlMatch?: string;
  launch?: string;
  reload?: boolean;
  isolate?: boolean;
  headless?: boolean;
  segments?: string;
  duckdb?: string;
  chromeArgs?: string[];
  // Stop after this many ms; otherwise run until signal aborts.
  durationMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface CaptureResult {
  sessions: { id: string; dir: string; rows: number; dropped: number; url: string }[];
}

// The React DevTools extension (Chrome Web Store and Edge Add-ons ids). A
// hook the shim installs first would leave it half-working, so capture
// refuses to share a browser with it.
const DEVTOOLS_EXTENSION = /^chrome-extension:\/\/(fmkadmapgofadopljbjfkapdkoienihi|gpphkfbcpidddadnkolkpfckpihlkkil)\//;

export function findDevtoolsExtension(targets: { url: string; title?: string; type?: string }[]): string | null {
  const t = targets.find((x) => DEVTOOLS_EXTENSION.test(x.url) || x.title === 'React Developer Tools');
  return t === undefined ? null : t.url;
}

export function duckdbPath(explicit?: string): string {
  const bin = explicit ?? process.env.DUCKDB_PATH ?? 'duckdb';
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(`DuckDB CLI not found (${bin}). Install it (scripts/install-duckdb.sh) or set DUCKDB_PATH.`);
  }
  return bin;
}

interface Attached {
  sessionId: string;
  targetId: string;
  url: string;
  recordAll: boolean;
  session: Session | null;
  // Execution contexts (documents) that said hello, or null for one whose URL
  // does not match --url-match.
  contexts: Map<number, PageContext | null>;
  // Settles when the shim and the binding are in place.
  ready: Promise<void>;
}

interface PageContext {
  url: string;
  // A document is recorded from its first development React on. Until then
  // its hello and any skipped Reacts wait here; null once it records.
  held: string[] | null;
}

const attachedTo = (sessionId: string, targetId: string, url: string, recordAll: boolean): Attached => ({
  sessionId,
  targetId,
  url,
  recordAll,
  session: null,
  contexts: new Map(),
  ready: Promise.resolve(),
});

// Whether a page already runs React, and which build: React keeps each DOM
// node's fiber in an expando property, and only development fibers have
// _debugOwner.
const DETECT_REACT = `(() => {
  const all = document.getElementsByTagName('*');
  for (let i = 0; i < all.length && i < 5000; i++) {
    for (const k of Object.keys(all[i])) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$') || k.startsWith('__reactInternalInstance$')) {
        const f = all[i][k];
        return f !== null && typeof f === 'object' && '_debugOwner' in f ? 'development' : 'production';
      }
    }
  }
  return 'none';
})()`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function capture(opts: CaptureOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const config = opts.config;
  // Empty: every document with a development React is recorded.
  const urlMatch = opts.urlMatch ?? config.urlMatch;
  const segmentsDir = resolve(opts.segments ?? config.segments.dir);
  const duckdb = duckdbPath(opts.duckdb);
  const isolate = opts.isolate ?? config.launch.isolate;
  const source = `window.__reactLogConfig = ${JSON.stringify(shimConfig(config))};\n${await bundleShim()}`;
  mkdirSync(segmentsDir, { recursive: true });

  let chrome: LaunchedChrome | null = null;
  let endpoint = opts.cdp ?? config.cdp;
  if (opts.launch !== undefined) {
    chrome = await launchChrome({
      chromePath: config.launch.chromePath,
      userDataDir: resolve(expandHome(config.launch.userDataDir)),
      headless: opts.headless,
      args: opts.chromeArgs,
    });
    endpoint = chrome.wsUrl;
  }
  const cdp = await CdpClient.connect(endpoint);
  const marker = join(segmentsDir, '.capture.json');
  writeFileSync(marker, `${JSON.stringify({ cdp: endpoint, pid: process.pid, started_at: new Date().toISOString() })}\n`);

  const maps = new SourceMaps();
  const attached = new Map<string, Attached>();
  const done: Session[] = [];
  let fatal: Error | null = null;
  let stop: () => void = () => {};
  const stopped = new Promise<void>((r) => {
    stop = r;
  });

  // Synchronous, so messages that follow the first React are never lost while
  // the session's first files are written.
  const openSession = (a: Attached, url: string): Session => {
    const s = new Session({ root: segmentsDir, targetId: a.targetId, url, config, duckdb, maps });
    s.onError = (m) => log(`react-log: ${s.id}: ${m}`);
    a.session = s;
    s.start().catch((err) => log(`react-log: ${s.id}: ${err.message}`));
    log(`react-log: capturing ${url} into ${s.dir}`);
    return s;
  };

  // One target's messages. A target's session starts with the first document
  // that registers a development React; a document that never does (no
  // React, or only production ones) records nothing and stops nothing.
  const onMessage = (a: Attached, context: number, payload: string) => {
    if (payload.startsWith('{"t":"hello"')) {
      const url = JSON.parse(payload).url as string;
      const recorded = a.recordAll || urlMatch === '' || url.includes(urlMatch);
      a.contexts.set(context, recorded ? { url, held: [payload] } : null);
      return;
    }
    const page = a.contexts.get(context);
    if (page == null) return;
    const msg = payload.startsWith('{"t":"renderer"') || payload.startsWith('{"t":"refused"') || payload.startsWith('{"t":"error"') ? JSON.parse(payload) : null;
    if (msg?.t === 'renderer' && msg.skipped != null) {
      log(`react-log: ${page.url}: React ${msg.version} ${msg.skipped === 'not-a-dev-build' ? 'is a production build' : 'is not supported'}; not recorded`);
    }
    if (page.held === null) {
      a.session!.handle(context, payload);
      return;
    }
    if (msg?.t === 'renderer' && msg.skipped == null) {
      const session = a.session ?? openSession(a, page.url);
      for (const held of page.held) session.handle(context, held);
      page.held = null;
      session.handle(context, payload);
    } else if (msg?.t === 'renderer') {
      page.held.push(payload);
    } else if (msg?.t === 'refused') {
      log(`react-log: ${page.url}: ${msg.detail}; not recorded`);
    } else if (msg?.t === 'error') {
      log(`react-log: ${page.url}: shim: ${msg.message}`);
    }
    // Batches before a development React hold no React rows.
  };

  // A tab, or an iframe from another site (its own target). Auto-attach
  // reports new ones paused, before any of their scripts run; ones that
  // existed before capture attached are not paused.
  const instrument = (info: { targetId: string; type: string; url: string }, sid: string, waiting: boolean) => {
    if (info.type !== 'page' && info.type !== 'iframe') {
      if (waiting) void cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
      return;
    }
    if (attached.has(sid)) return;
    const a = attachedTo(sid, info.targetId, info.url, false);
    attached.set(sid, a);
    a.ready = setup(a, waiting).catch((err) => log(`react-log: cannot instrument ${info.url}: ${err.message}`));
  };

  const onEvent = (e: CdpEvent) => {
    const a = e.sessionId === undefined ? undefined : attached.get(e.sessionId);
    if (e.method === 'Runtime.bindingCalled' && a !== undefined && e.params.name === '__reactLogSink') {
      onMessage(a, e.params.executionContextId, e.params.payload);
      return;
    }
    if (e.method === 'Fetch.requestPaused' && a !== undefined) {
      void isolateResponse(cdp, e.sessionId!, e.params);
      return;
    }
    if (e.method === 'Target.attachedToTarget') {
      // From the browser: new tabs, paused. Tabs that existed before are
      // attached explicitly below. From a tab or iframe: its iframes from
      // other sites, paused when new.
      const waiting = e.params.waitingForDebugger === true;
      if (e.sessionId === undefined && !waiting) return;
      if (e.sessionId !== undefined && a === undefined) return;
      instrument(e.params.targetInfo, e.params.sessionId, waiting);
      return;
    }
    if (e.method === 'Fetch.requestPaused' && e.sessionId === undefined) {
      void holdDocument(e.params);
      return;
    }
    if (e.method === 'Target.detachedFromTarget') {
      const a0 = attached.get(e.params.sessionId);
      if (a0 === undefined) return;
      attached.delete(a0.sessionId);
      if (a0.session !== null) void closeSession(a0.session);
    }
  };

  // A tab the browser opens itself (open link in new tab, Target.createTarget
  // with a URL) starts loading while auto-attach reports it paused, so its
  // scripts could run before the shim. Every document request of a tab
  // capture instruments waits until the shim is in place; other documents
  // (subframes, tabs capture leaves alone) go straight through.
  const holdDocument = async (p: { requestId: string; frameId?: string }) => {
    try {
      for (const a of attached.values()) {
        if (a.targetId === p.frameId) {
          await Promise.race([a.ready, sleep(5000)]);
          break;
        }
      }
    } finally {
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    }
  };

  const closeSession = async (s: Session) => {
    await s.close();
    done.push(s);
    log(`react-log: session ${s.id}: ${s.info.rows} rows, ${s.writer.filesWritten} files, ${s.info.dropped} dropped, page buffer peak ${s.info.buffer_peak} records`);
  };

  const setup = async (a: Attached, waiting: boolean) => {
    const sid = a.sessionId;
    // Chromium installs the binding only with Runtime enabled, and runs
    // new-document scripts only with Page enabled.
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    // With Runtime enabled, V8 records up to 200 frames on every new Error in
    // case it goes uncaught, whatever Error.stackTraceLimit says. React 19 dev
    // creates an Error per JSX element, so that made the page's own work
    // slower under capture. Capture needs no exception stacks.
    await cdp.send('Runtime.setMaxCallStackSizeToCapture', { size: 0 }, sid).catch(() => {});
    await cdp.send('Runtime.addBinding', { name: '__reactLogSink' }, sid);
    // A tab opened with a URL (window.open, target=_blank) has created its
    // first document by the time it pauses, so a new-document script alone
    // would miss it. Paused, no page script has run yet, so the shim can run
    // in that document right away.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: waiting }, sid);
    if (isolate) {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }, sid);
    }
    // Iframes from other sites are targets of their own, attached through
    // their parent and paused until instrumented.
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
    if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
  };

  const off = cdp.on(onEvent);
  let closing = false;
  cdp.onClose(() => {
    if (!closing) fatal ??= new Error('the browser connection closed');
    stop();
  });

  try {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>('Target.getTargets');
    const ext = findDevtoolsExtension(targetInfos);
    if (ext !== null) {
      throw new Error(`The React DevTools extension is enabled in this browser (${ext}). react-log replaces it and cannot share a page with it: disable it in the capture profile.`);
    }
    // Browser-wide, so it also covers tabs opened from now on (holdDocument).
    await cdp
      .send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
      .catch((err) => log(`react-log: cannot hold new tabs until instrumented (${err.message}); a tab opened with a URL may start before the shim`));
    if (opts.launch !== undefined) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const a = attachedTo(sessionId, targetId, opts.launch, true);
      attached.set(sessionId, a);
      a.ready = setup(a, false);
      await a.ready;
      await cdp.send('Page.navigate', { url: opts.launch }, sessionId);
    } else {
      // Every open tab gets the shim for its next load. A tab already running
      // a development React started it before the shim: --reload reloads it
      // (and any tab --url-match names), otherwise capture says so.
      const pages = targetInfos.filter((t) => t.type === 'page');
      let running = 0;
      for (const t of pages) {
        try {
          const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          const a = attachedTo(sessionId, t.targetId, t.url, false);
          attached.set(sessionId, a);
          a.ready = setup(a, false);
          await a.ready;
          const found = await cdp
            .send<{ result: { value?: string } }>('Runtime.evaluate', { expression: DETECT_REACT, returnByValue: true }, sessionId)
            .then((r) => r.result.value ?? 'none')
            .catch(() => 'none');
          const named = urlMatch !== '' && t.url.includes(urlMatch);
          if (found === 'development') running++;
          if (found !== 'development' && !named) continue;
          if (opts.reload === true) await cdp.send('Page.reload', {}, sessionId);
          else log(`react-log: ${t.url} was already loaded; its React started before the shim. Reload it, or pass --reload.`);
        } catch (err) {
          log(`react-log: cannot instrument ${t.url}: ${(err as Error).message}`);
        }
      }
      if (running === 0) log('react-log: no open tab runs a development React yet; recording any that loads one');
    }
    // Tabs opened from now on pause until instrumented, so the shim runs
    // before any of their scripts.
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    const timer = opts.durationMs === undefined ? null : setTimeout(stop, opts.durationMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
    await stopped;
    if (timer !== null) clearTimeout(timer);
  } finally {
    closing = true;
    // Held document requests go through, and new ones are no longer held.
    if (!cdp.isClosed) await cdp.send('Fetch.disable').catch(() => {});
    // Rows still in a page's ring would be lost with the browser: flush them
    // through the binding first. The binding events arrive before the reply.
    if (!cdp.isClosed) {
      const flushes = [...attached.values()]
        .filter((a) => a.session !== null)
        .map((a) => cdp.send('Runtime.evaluate', { expression: 'window.__reactLog && window.__reactLog.flushNow()' }, a.sessionId).catch(() => {}));
      await Promise.race([Promise.all(flushes), new Promise((r) => setTimeout(r, 2000))]);
    }
    off();
    for (const a of attached.values()) if (a.session !== null) await closeSession(a.session);
    attached.clear();
    cdp.close();
    if (chrome !== null) await chrome.close();
    rmSync(marker, { force: true });
  }
  if (fatal !== null) throw fatal;
  return {
    sessions: done.map((s) => ({ id: s.id, dir: s.dir, rows: s.info.rows, dropped: s.info.dropped, url: s.info.app_url })),
  };
}

// --isolate: add COOP and COEP to document responses so the page is
// cross-origin isolated and timers tick in 5 µs steps. Only
// Fetch.fulfillRequest isolates the page; continueResponse does not.
async function isolateResponse(cdp: CdpClient, sessionId: string, p: any): Promise<void> {
  try {
    const status: number = p.responseStatusCode ?? 200;
    if (status >= 300 && status < 400) throw new Error('redirect');
    const body = await cdp.send<{ body: string; base64Encoded: boolean }>('Fetch.getResponseBody', { requestId: p.requestId }, sessionId);
    const headers = (p.responseHeaders ?? []).filter((h: { name: string }) => !/^cross-origin-(opener|embedder)-policy$/i.test(h.name));
    headers.push({ name: 'Cross-Origin-Opener-Policy', value: 'same-origin' }, { name: 'Cross-Origin-Embedder-Policy', value: 'credentialless' });
    await cdp.send(
      'Fetch.fulfillRequest',
      {
        requestId: p.requestId,
        responseCode: status,
        responseHeaders: headers,
        body: body.base64Encoded ? body.body : Buffer.from(body.body).toString('base64'),
      },
      sessionId,
    );
  } catch {
    await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {});
  }
}
