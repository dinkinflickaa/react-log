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
  // Execution contexts whose hello was for a URL that does not match.
  ignored: Set<number>;
}

export async function capture(opts: CaptureOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const config = opts.config;
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

  // Synchronous, so messages that follow the hello are never lost while the
  // session's first files are written.
  const openSession = (a: Attached, url: string): Session => {
    const s = new Session({ root: segmentsDir, targetId: a.targetId, url, config, duckdb, maps });
    s.onRefused = (reason, detail) => {
      fatal = new Error(`the shim refused this page (${reason}): ${detail}`);
      stop();
    };
    s.onError = (m) => log(`react-log: ${s.id}: ${m}`);
    a.session = s;
    s.start().catch((err) => log(`react-log: ${s.id}: ${err.message}`));
    log(`react-log: capturing ${url} into ${s.dir}`);
    return s;
  };

  const onEvent = (e: CdpEvent) => {
    const a = e.sessionId === undefined ? undefined : attached.get(e.sessionId);
    if (e.method === 'Runtime.bindingCalled' && a !== undefined && e.params.name === '__reactLogSink') {
      const payload: string = e.params.payload;
      const context: number = e.params.executionContextId;
      if (payload.startsWith('{"t":"hello"')) {
        // Record documents from matching URLs only (any URL in launch mode).
        // The session starts at the first one.
        const url = JSON.parse(payload).url as string;
        if (!a.recordAll && !url.includes(urlMatch)) {
          a.ignored.add(context);
          return;
        }
        (a.session ?? openSession(a, url)).handle(context, payload);
        return;
      }
      if (a.session !== null && !a.ignored.has(context)) a.session.handle(context, payload);
      return;
    }
    if (e.method === 'Fetch.requestPaused' && a !== undefined) {
      void isolateResponse(cdp, e.sessionId!, e.params);
      return;
    }
    if (e.method === 'Target.attachedToTarget' && e.sessionId === undefined) {
      // Auto-attach reports new targets paused. Explicit attaches (and targets
      // that existed before auto-attach) are not paused and are handled where
      // they are made.
      if (e.params.waitingForDebugger !== true) return;
      const info = e.params.targetInfo;
      const sid: string = e.params.sessionId;
      if (info.type !== 'page') {
        void cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        return;
      }
      const a: Attached = { sessionId: sid, targetId: info.targetId, url: info.url, recordAll: false, session: null, ignored: new Set() };
      attached.set(sid, a);
      void setup(a, false, true).catch((err) => log(`react-log: cannot instrument ${info.url}: ${err.message}`));
      return;
    }
    if (e.method === 'Target.detachedFromTarget' && e.sessionId === undefined) {
      const a0 = attached.get(e.params.sessionId);
      if (a0 === undefined) return;
      attached.delete(a0.sessionId);
      if (a0.session !== null) void closeSession(a0.session);
    }
  };

  const closeSession = async (s: Session) => {
    await s.close();
    done.push(s);
    log(`react-log: session ${s.id}: ${s.info.rows} rows, ${s.writer.filesWritten} files, ${s.info.dropped} dropped`);
  };

  const setup = async (a: Attached, reload: boolean, waiting: boolean) => {
    const sid = a.sessionId;
    // Chromium installs the binding only with Runtime enabled, and runs
    // new-document scripts only with Page enabled.
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Runtime.addBinding', { name: '__reactLogSink' }, sid);
    // A tab opened with a URL (window.open, target=_blank) has created its
    // first document by the time it pauses, so a new-document script alone
    // would miss it. Paused, no page script has run yet, so the shim can run
    // in that document right away.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: waiting }, sid);
    if (isolate) {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }, sid);
    }
    if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
    if (reload) await cdp.send('Page.reload', {}, sid);
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
    if (opts.launch !== undefined) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const a: Attached = { sessionId, targetId, url: opts.launch, recordAll: true, session: null, ignored: new Set() };
      attached.set(sessionId, a);
      await setup(a, false, false);
      await cdp.send('Page.navigate', { url: opts.launch }, sessionId);
    } else {
      const pages = targetInfos.filter((t) => t.type === 'page' && t.url.includes(urlMatch));
      if (pages.length === 0) log(`react-log: no open page matches "${urlMatch}" yet; waiting for one`);
      for (const t of pages) {
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const a: Attached = { sessionId, targetId: t.targetId, url: t.url, recordAll: false, session: null, ignored: new Set() };
        attached.set(sessionId, a);
        await setup(a, opts.reload === true, false);
        if (opts.reload !== true) log(`react-log: ${t.url} was already loaded; its React started before the shim. Reload it, or pass --reload.`);
      }
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
