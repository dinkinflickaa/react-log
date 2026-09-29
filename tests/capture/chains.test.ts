import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type CaptureRun, serveInChild, sleep, sql, withCapture } from './harness.ts';

// The chain linker end to end on every matrix version: capture the chains
// fixture page (fixture/app/src/chains.jsx), click each button once, and check
// how the commits and updates were linked.

const VERSIONS = ['18.0.0', '18.2.0', '18.3.1', '19.0.8', '19.1.9', '19.2.8', '19.3.0'];
// 19.2+ reports only the first update of each batch.
const tracks = (version: string) => Number(version.split('.')[1]) >= 2 && version.startsWith('19.');

// A call site's line in the fixture, found by its text.
const fixture = readFileSync(new URL('../../fixture/app/src/chains.jsx', import.meta.url), 'utf8').split('\n');
const site = (code: string) => {
  const line = fixture.findIndex((l) => l.includes(code)) + 1;
  if (line === 0) throw new Error(`no ${code} in chains.jsx`);
  return new RegExp(`\\(fixture/app/src/chains\\.jsx:${line}:\\d+\\)$`);
};

const root = mkdtempSync(join(tmpdir(), 'react-log-chains-'));
let server: { origin: string; child: ChildProcess };

beforeAll(async () => {
  server = await serveInChild();
});
afterAll(() => {
  server.child.kill();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Commit {
  commit_id: string;
  lane: string;
  root_update_id: string;
  cascade_commit_id: string | null;
  trigger_event: string | null;
  producer: string | null;
  producer_call_site: string | null;
  signature: string;
}

describe.each(VERSIONS)('chains on React %s', (version) => {
  let run: CaptureRun;
  let seg = '';
  let defs = '';
  let commits: Commit[] = [];
  const updates = (rootId: string) =>
    sql<{ phase: string | null; call_site: string | null }>(
      `SELECT extra->>'phase' AS phase, call_site FROM ${seg} WHERE kind = 'update_enqueued' AND root_update_id = '${rootId}' ORDER BY ts`,
    );
  const by = (producer: string) => commits.filter((c) => c.producer === producer);

  beforeAll(async () => {
    run = await withCapture(root, `chains-${version}`, `${server.origin}/react-${version}/chains.html`, {}, async (_cdp, page) => {
      for (const b of ['#cascade', '#batch', '#transition', '#store', '#pulse', '#prune']) {
        await page.click(b);
        await sleep(200);
      }
      await page.settle();
    });
    const dir = run.result.sessions[0]!.dir;
    seg = `read_parquet('${dir}/seg-*.parquet')`;
    defs = `read_parquet('${dir}/defs-*.parquet')`;
    commits = sql<Commit>(`
      WITH names AS (SELECT DISTINCT component_id, display_name FROM read_parquet('${dir}/defs-*.parquet'))
      SELECT c.commit_id, c.lane, c.root_update_id, c.cascade_commit_id, c.trigger_event, n.display_name AS producer,
             c.producer_call_site, c.signature
      FROM read_parquet('${dir}/commits-*.parquet') c LEFT JOIN names n ON n.component_id = c.producer_component_id
      ORDER BY c.ts`);
  }, 120_000);

  test('every commit has a rollup, and every row of a commit a chain', () => {
    const [{ n }] = sql(`SELECT count(*) AS n FROM ${seg} WHERE kind = 'commit'`);
    expect(commits).toHaveLength(n);
    const [{ orphans }] = sql(`SELECT count(*) AS orphans FROM ${seg} WHERE commit_id IS NOT NULL AND root_update_id IS NULL`);
    expect(orphans).toBe(0);
  });

  test('a layout effect and then a passive effect that enqueue updates: three commits, one chain', () => {
    const [first, second, third, ...rest] = by('Cascade');
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ cascade_commit_id: null, trigger_event: 'click' });
    expect(first!.producer_call_site).toMatch(/^onClick \(/);
    expect(first!.producer_call_site).toMatch(site('setClicks((c) => c + 1)'));
    expect(second).toMatchObject({ cascade_commit_id: first!.commit_id, root_update_id: first!.root_update_id, trigger_event: 'click' });
    expect(third).toMatchObject({ cascade_commit_id: second!.commit_id, root_update_id: first!.root_update_id, trigger_event: 'click' });
    expect(second!.producer_call_site).toMatch(site('setLaid(clicks)'));
    expect(third!.producer_call_site).toMatch(site('setSeen(laid)'));
    expect(updates(first!.root_update_id).map((u) => u.phase)).toEqual([null, 'layout', 'passive']);
    expect(new Set([first!.signature, second!.signature, third!.signature]).size).toBe(3);
  });

  test('one handler, two updates: one commit, one chain', () => {
    const [batch, ...rest] = by('Batch');
    expect(rest).toEqual([]);
    expect(batch).toMatchObject({ cascade_commit_id: null, trigger_event: 'click' });
    expect(updates(batch!.root_update_id)).toHaveLength(tracks(version) ? 1 : 2);
  });

  test('a blocking update and a transition: two commits in two lanes, two chains', () => {
    const both = by('Transition');
    expect(both.map((c) => c.lane)).toEqual(['Blocking', 'Transition']);
    expect(both[0]!.root_update_id).not.toBe(both[1]!.root_update_id);
    for (const c of both) expect(updates(c.root_update_id)).toHaveLength(1);
  });

  test('an effect whose cleanup and body both take time: every effect span keeps its component', () => {
    const [{ lost }] = sql(`SELECT count(*) AS lost FROM ${seg} WHERE kind IN ('layout_effect', 'passive_effect') AND component_id IS NULL`);
    expect(lost).toBe(0);
    const [pulse] = by('Pulses');
    expect(pulse).toBeDefined();
    // Each Pulse's cleanup (0.3 ms), in the mutation pass, then its body (1 ms
    // or 6 ms), in the layout pass. Time bounds are lower bounds only: a
    // loaded machine stretches spans, and a span on the wrong fiber takes a
    // bound's time away from the right one.
    const spans = sql<{ owner_path: string; us: number }>(`
      SELECT d.owner_path, e.dur_us AS us
      FROM ${seg} e JOIN (SELECT DISTINCT component_id, owner_path FROM ${defs}) d USING (component_id)
      WHERE e.commit_id = '${pulse!.commit_id}' AND e.kind = 'layout_effect'
      ORDER BY e.ts`);
    expect(spans.map((r) => r.owner_path.replace(/^.*>/, ''))).toEqual(['Pulse#short', 'Pulse#long', 'Pulse#short', 'Pulse#long']);
    expect(Number(spans[2]!.us)).toBeGreaterThanOrEqual(1000);
    expect(Number(spans[3]!.us)).toBeGreaterThanOrEqual(6000);
  });

  test('a deleted component, and nested components of one name: every effect span finds its own', () => {
    const [prune, ...rest] = by('Leaves');
    expect(rest).toEqual([]);
    const spent = (kind: string) =>
      Object.fromEntries(
        sql<{ owner_path: string; us: number }>(`
          SELECT d.owner_path, sum(e.dur_us) AS us
          FROM ${seg} e JOIN (SELECT DISTINCT component_id, owner_path FROM ${defs}) d USING (component_id)
          WHERE e.commit_id = '${prune!.commit_id}' AND e.kind = '${kind}'
          GROUP BY 1`).map((r) => [r.owner_path.replace(/^.*?>Leaves>/, ''), Number(r.us)]),
      );
    // Leaf#1 is deleted: its cleanups take 12 ms each. Leaf#0 and Leaf#2 re-run
    // theirs (1 ms and 5 ms) and their effects (0.2 ms). Lower bounds only, as
    // for the Pulses: Leaf#1's time on a sibling leaves Leaf#1 without it, and
    // the siblings' cleanups swapped leave Leaf#2 short of 5 ms.
    const layout = spent('layout_effect');
    const passive = spent('passive_effect');
    expect(Object.keys(layout).sort()).toEqual(['Leaf#0', 'Leaf#1', 'Leaf#2', 'Nest', 'Nest>Nest']);
    expect(Object.keys(passive).sort()).toEqual(['Leaf#0', 'Leaf#1', 'Leaf#2']);
    for (const t of [layout, passive]) {
      expect(t['Leaf#1']).toBeGreaterThanOrEqual(12000);
      expect(t['Leaf#0']).toBeGreaterThanOrEqual(1000);
      expect(t['Leaf#2']).toBeGreaterThanOrEqual(5000);
    }
    // The outer Nest's effect takes 6 ms, the inner's 1 ms.
    expect(layout['Nest']).toBeGreaterThanOrEqual(6000);
    expect(layout['Nest>Nest']).toBeGreaterThanOrEqual(1000);
  });

  test('an external store change', () => {
    const [store, ...rest] = by('Store');
    expect(rest).toEqual([]);
    expect(store!.trigger_event).toBe('click');
    if (tracks(version)) {
      // updateSyncExternalStore() is an update 19.2+ reports, from the store.
      expect(updates(store!.root_update_id).map((u) => u.call_site)).toEqual([expect.stringMatching(/\(fixture\/app\/src\/chains\.jsx:\d+:\d+\)$/)]);
    } else {
      // No update row: the commit starts its own chain.
      expect(store!.root_update_id).toBe(store!.commit_id);
    }
  });
});
