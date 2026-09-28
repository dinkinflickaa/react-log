import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { captureEndpoint, watch } from '../packages/capture/src/watch.ts';
import { serveInChild, sleep, withCapture } from '../tests/capture/harness.ts';

// Captures the lab under scripted load (PLAN.md, Phase 5): each button
// clicked once per round, 1.1 s apart, for as many rounds as asked, with the
// watch list set first. The session lands in <out>/<session id>.
//
//   node bench/record.ts --out <segments dir> [--rounds 20] [--version 19.3.0]
//                        [--buttons '#bug-producer,#bug-effect'] [--watch 'SidebarItem,Cell']

const PLANTED = '#bug-producer,#bug-context,#bug-memo,#bug-hoist,#bug-effect,#bug-diffuse,#bug-budget';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    rounds: { type: 'string', default: '20' },
    version: { type: 'string', default: '19.3.0' },
    buttons: { type: 'string', default: PLANTED },
    watch: { type: 'string', default: 'SidebarItem,Cell' },
  },
});
if (values.out === undefined) {
  console.error('usage: node bench/record.ts --out <segments dir> [--rounds 20] [--version 19.3.0] [--buttons ...] [--watch ...]');
  process.exit(2);
}
const rounds = Number(values.rounds);
const buttons = values.buttons.split(',').filter(Boolean);
const watched = values.watch.split(',').filter(Boolean);
const tmp = mkdtempSync(join(tmpdir(), 'react-log-record-'));
const server = await serveInChild();
try {
  const url = `${server.origin}/react-${values.version}/lab.html`;
  const t0 = Date.now();
  const run = await withCapture(tmp, 'record', url, {}, async (_cdp, page) => {
    if (watched.length > 0 && (await watch(watched, { endpoint: captureEndpoint(join(tmp, 'record')), urlMatch: '127.0.0.1' })) !== 1) {
      throw new Error('watch reached no page');
    }
    for (let round = 0; round < rounds; round++) {
      for (const button of buttons) {
        await page.click(button);
        await sleep(1100);
      }
    }
    await page.settle();
  });
  const session = run.result.sessions[0]!;
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  cpSync(session.dir, join(out, session.id), { recursive: true });
  console.log(
    `session ${session.id}: ${rounds} rounds of ${buttons.join(' ')} on React ${values.version}, ${session.rows} rows, ${((Date.now() - t0) / 1000).toFixed(0)} s, in ${join(out, session.id)}`,
  );
} finally {
  server.child.kill();
  rmSync(tmp, { recursive: true, force: true });
}
