import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureEndpoint, watch } from '../../packages/capture/src/watch.ts';
import { serveInChild, sleep, withCapture } from '../capture/harness.ts';

// Records the golden session (PLAN.md, Phase 4): the lab on React 19.3.0,
// each planted bug's interaction three times, 1.1 s apart, with SidebarItem
// and Cell watched so their changed_keys are recorded (both re-render for
// changed props, and whether by identity or by value decides the verdict).
// Replaces tests/golden/segments/ with the new session.
//
//   node tests/golden/record.ts

export const GOLDEN_VERSION = '19.3.0';
export const PLANTED = ['#bench-large', '#bug-context', '#bug-memo', '#bug-hoist', '#bug-effect', '#bug-diffuse', '#bug-budget'];
export const WATCHED = ['SidebarItem', 'Cell'];
const ROUNDS = 3;

const here = dirname(fileURLToPath(import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tmp = mkdtempSync(join(tmpdir(), 'react-log-golden-'));
  const server = await serveInChild();
  try {
    const url = `${server.origin}/react-${GOLDEN_VERSION}/lab.html`;
    const run = await withCapture(tmp, 'golden', url, {}, async (_cdp, page) => {
      if ((await watch(WATCHED, { endpoint: captureEndpoint(join(tmp, 'golden')), urlMatch: '127.0.0.1' })) !== 1) throw new Error('watch reached no page');
      for (let round = 0; round < ROUNDS; round++) {
        for (const button of PLANTED) {
          await page.click(button);
          await sleep(1100);
        }
      }
      await page.settle();
    });
    const session = run.result.sessions[0]!;
    const out = join(here, 'segments');
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(session.dir, join(out, session.id), { recursive: true });
    console.log(`golden session ${session.id}: ${session.rows} rows, ${readdirSync(join(out, session.id)).length} files in ${join(out, session.id)}`);
  } finally {
    server.child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
}
