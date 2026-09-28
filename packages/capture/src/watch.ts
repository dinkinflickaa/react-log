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
// every matching page. The shim records a watch row when it changes.
export async function watch(names: string[], opts: { endpoint: string; urlMatch: string; clear?: boolean }): Promise<number> {
  const cdp = await CdpClient.connect(opts.endpoint);
  try {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page' && t.url.includes(opts.urlMatch));
    const expression = opts.clear
      ? `window.__reactLogWatch = ${JSON.stringify(names)}; window.__reactLogWatch`
      : `window.__reactLogWatch = [...new Set([...(window.__reactLogWatch ?? []), ...${JSON.stringify(names)}])]; window.__reactLogWatch`;
    let updated = 0;
    for (const t of pages) {
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      if (!r.exceptionDetails) updated++;
      await cdp.send('Target.detachFromTarget', { sessionId });
    }
    return updated;
  } finally {
    cdp.close();
  }
}
