import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { duckdbPath, findDevtoolsExtension } from '../../packages/capture/src/capture.ts';
import { DEFAULTS } from '../../packages/capture/src/config.ts';
import { Session } from '../../packages/capture/src/ingest.ts';
import { FAMILIES, SCHEMAS } from '../../packages/capture/src/schema.ts';
import { SegmentWriter } from '../../packages/capture/src/segments.ts';
import { SourceMaps } from '../../packages/capture/src/sourcemap.ts';

const duckdb = duckdbPath();
const root = mkdtempSync(join(tmpdir(), 'react-log-segments-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sql<T = any>(query: string): T[] {
  const out = execFileSync(duckdb, ['-json', ':memory:', '-c', query]).toString().trim();
  return out === '' ? [] : JSON.parse(out);
}

// DuckDB's JSON output inlines JSON columns as values.
const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

const row = (i: number) => ({
  session_id: 's',
  page_load_id: 1,
  ts: 1_000_000 + i,
  dur_us: i,
  self_us: i,
  kind: 'render',
  lane: 'Blocking',
  component_id: `c${i % 7}`,
  commit_id: `s.1.${i >> 4}`,
  reason_code: i % 2 ? 'props' : null,
  changed_hooks: null,
  changed_context: null,
  changed_keys: null,
  committed: i % 3 === 0,
  root_update_id: null,
  measure_instance_id: null,
  on_critical_path: null,
  call_site: null,
  extra: i % 5 === 0 ? { strict: true } : null,
});

describe('segment writer', () => {
  test('starts every family with an empty file, so views never fail on an empty glob', async () => {
    const dir = join(root, 'empty');
    const w = new SegmentWriter(dir, { rotateSeconds: 3600, rotateRows: 1_000_000, duckdb });
    await w.init();
    await w.close();
    for (const family of FAMILIES) {
      const [{ n }] = sql(`SELECT count(*) AS n FROM read_parquet('${dir}/${family}-*.parquet')`);
      expect(n, family).toBe(0);
    }
  });

  test('rotates by row count, and segments union with the pinned schema', async () => {
    const dir = join(root, 'rotate');
    const w = new SegmentWriter(dir, { rotateSeconds: 3600, rotateRows: 1000, duckdb });
    await w.init();
    for (let i = 0; i < 2500; i++) w.write('seg', row(i));
    await w.close();
    const files = readdirSync(dir).filter((f) => /^seg-\d+\.parquet$/.test(f)).sort();
    expect(files).toEqual(['seg-00000.parquet', 'seg-00001.parquet', 'seg-00002.parquet', 'seg-00003.parquet']);
    const [{ n, committed }] = sql(`SELECT count(*) AS n, count(*) FILTER (committed) AS committed FROM read_parquet('${dir}/seg-*.parquet')`);
    expect(n).toBe(2500);
    expect(committed).toBe(834);
    const types = sql<{ column_name: string; column_type: string }>(`DESCRIBE SELECT * FROM read_parquet('${dir}/seg-*.parquet')`);
    expect(types.map((t) => [t.column_name, t.column_type])).toEqual(SCHEMAS.seg.map(([name, type]) => [name, type]));
    const [{ strict }] = sql(`SELECT count(*) AS strict FROM read_parquet('${dir}/seg-*.parquet') WHERE (extra->>'strict')::BOOLEAN`);
    expect(strict).toBe(500);
  });

  test('never exposes a partial file: work happens under dot-prefixed temp names', async () => {
    const dir = join(root, 'atomic');
    const w = new SegmentWriter(dir, { rotateSeconds: 3600, rotateRows: 1_000_000, duckdb });
    await w.init();
    for (let i = 0; i < 50_000; i++) w.write('seg', row(i));
    const rotation = w.rotate();
    // While DuckDB converts, every file the glob can see must read cleanly.
    let checks = 0;
    let done = false;
    void rotation.then(() => (done = true));
    while (!done) {
      for (const f of readdirSync(dir).filter((x) => /^seg-\d+\.parquet$/.test(x))) {
        sql(`SELECT count(*) FROM read_parquet('${join(dir, f)}')`);
        checks++;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await w.close();
    expect(checks).toBeGreaterThan(0);
    expect(readdirSync(dir).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
    const [{ n }] = sql(`SELECT count(*) AS n FROM read_parquet('${dir}/seg-*.parquet')`);
    expect(n).toBe(50_000);
  });
});

describe('ingest', () => {
  test('counts dropped rows, converts times to epoch µs, and scopes commit ids', async () => {
    const s = new Session({ root, targetId: 't', url: 'http://x/', config: DEFAULTS, duckdb, maps: new SourceMaps(), id: 'ingest-test' });
    await s.start();
    s.handle(1, JSON.stringify({ t: 'hello', v: 1, shim: '0.1.0', url: 'http://x/', timeOrigin: 1_700_000_000_000, token: 'a' }));
    s.handle(
      1,
      JSON.stringify({
        t: 'batch',
        seq: 0,
        dropped: 5,
        defs: [['c1', 'App', 'src/App.jsx', 3, 1, 'App']],
        rows: [
          ['render', 12.5, 400, 100, 'Blocking', 'c1', 7, 'mount', null, null, null, true, null, null],
          ['commit', 13, 900, null, 'Blocking', null, 7, null, null, null, null, null, null, { renderStart: 12.5, commitEnd: 13.9, passiveSync: true }],
        ],
      }),
    );
    await s.close();
    expect(s.info.dropped).toBe(5);
    const rows = sql(`SELECT kind, ts, commit_id, extra FROM read_parquet('${s.dir}/seg-*.parquet') ORDER BY kind`);
    const byKind = Object.fromEntries(rows.map((r: any) => [r.kind, r]));
    expect(byKind.render.ts).toBe(1_700_000_000_012_500);
    expect(byKind.render.commit_id).toBe('ingest-test.1.7');
    expect(json(byKind.commit.extra).renderStart).toBe(1_700_000_000_012_500);
    expect(json(byKind.dropped.extra).count).toBe(5);
    const [def] = sql(`SELECT * FROM read_parquet('${s.dir}/defs-*.parquet')`);
    expect(def).toMatchObject({ component_id: 'c1', display_name: 'App', source_file: 'src/App.jsx', source_line: 3, owner_path: 'App' });
  });

  test('recognizes the React DevTools extension among browser targets', () => {
    expect(findDevtoolsExtension([{ url: 'chrome-extension://fmkadmapgofadopljbjfkapdkoienihi/build/background.js', type: 'service_worker' }])).not.toBeNull();
    expect(findDevtoolsExtension([{ url: 'chrome-extension://gpphkfbcpidddadnkolkpfckpihlkkil/build/background.js' }])).not.toBeNull();
    expect(findDevtoolsExtension([{ url: 'http://localhost:3000/', title: 'App', type: 'page' }])).toBeNull();
  });
});
