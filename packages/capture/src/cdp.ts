// Chrome DevTools Protocol over Node's built-in WebSocket. No dependencies:
// the capture program only needs Target, Page, Runtime, Fetch and Input.

export interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}

export class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e) => this.receive(String(e.data)));
    ws.addEventListener('close', () => this.shutdown(new Error('CDP connection closed')));
  }

  // endpoint: a ws:// URL, or an http://host:port DevTools endpoint.
  static async connect(endpoint: string): Promise<CdpClient> {
    const url = endpoint.startsWith('ws') ? endpoint : await browserWsUrl(endpoint);
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new CdpClient(ws);
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = ++this.nextId;
    this.ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  // Resolves with the first event matching pred.
  waitFor(pred: (e: CdpEvent) => boolean, timeoutMs = 30_000): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('timed out waiting for a CDP event'));
      }, timeoutMs);
      const off = this.on((e) => {
        if (!pred(e)) return;
        clearTimeout(timer);
        off();
        resolve(e);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.ws.close();
    this.shutdown(new Error('CDP connection closed'));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private receive(text: string): void {
    const m = JSON.parse(text);
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (p === undefined) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`));
      else p.resolve(m.result);
      return;
    }
    const event: CdpEvent = { method: m.method, params: m.params, sessionId: m.sessionId };
    for (const l of this.listeners) l(event);
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const l of this.closeListeners) l();
  }
}

async function browserWsUrl(http: string): Promise<string> {
  const base = http.replace(/\/+$/, '');
  const res = await fetch(`${base}/json/version`);
  if (!res.ok) throw new Error(`${base}/json/version answered ${res.status}`);
  const info = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) throw new Error(`${base} did not report a webSocketDebuggerUrl`);
  return info.webSocketDebuggerUrl;
}
