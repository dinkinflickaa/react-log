import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CdpClient } from './cdp.ts';

// The CDP endpoint of a running capture, from the marker file it writes into
// the segments directory, unless one is given.
export function captureEndpoint(segmentsDir: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const marker = join(resolve(segmentsDir), '.capture.json');
  if (!existsSync(marker)) throw new Error(`no running capture found (${marker}); pass --cdp`);
  return (JSON.parse(readFileSync(marker, 'utf8')) as { cdp: string }).cdp;
}

// Adds names (display names or component ids) to window.__reactLogWatch on
// every page and iframe that runs the shim (and matches urlMatch, when set).
// The shim records a watch row when it changes. Returns how many it reached.
export async function watch(names: string[], opts: { endpoint: string; urlMatch: string; clear?: boolean }): Promise<number> {
  const cdp = await CdpClient.connect(opts.endpoint);
  try {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
    const pages = targetInfos.filter((t) => (t.type === 'page' || t.type === 'iframe') && t.url.includes(opts.urlMatch));
    const list = JSON.stringify(names);
    const expression = `window.__reactLog === undefined ? false : (window.__reactLogWatch = ${opts.clear ? list : `[...new Set([...(window.__reactLogWatch ?? []), ...${list}])]`}, true)`;
    let updated = 0;
    for (const t of pages) {
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId).catch(() => null);
      if (r !== null && !r.exceptionDetails && r.result?.value === true) updated++;
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    return updated;
  } finally {
    cdp.close();
  }
}
