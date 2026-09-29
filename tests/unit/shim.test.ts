import { beforeAll, describe, expect, test } from 'vitest';
import { actual, INCREMENT, MOUNT, renders, STORE, THEME, TICK, TREE } from '../expected.ts';
import { type Harness, type Row, start } from './harness.ts';

describe(`shim under jsdom, React ${process.env.REACT_VERSION}`, () => {
  let h: Harness;
  let mountRows: Row[];
  beforeAll(async () => {
    h = await start();
    mountRows = h.take();
  });

  const commitOf = (rows: Row[]) => {
    const list = renders(rows, h.names);
    // Walk order is part of the contract: keys of the expected tables.
    return { order: list.map((r) => r.name), table: actual(list), list };
  };

  test('installs, identifies the renderer, and sends hello first', () => {
    expect(h.api.status).toBe('active');
    expect(h.messages[0].t).toBe('hello');
    const renderer = h.messages.find((m) => m.t === 'renderer');
    expect(renderer.version.startsWith(process.env.REACT_VERSION!)).toBe(true);
    expect(renderer.bundleType).toBe(1);
  });

  test('mount: every component renders once, in walk order, as mount', () => {
    const c = commitOf(mountRows);
    expect(c.order).toEqual(TREE);
    expect(c.table).toEqual(MOUNT);
    const commits = mountRows.filter((r) => r[0] === 'commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]![13].rendered).toBe(10);
  });

  test('self_us is non-negative and at most dur_us; parents contain children', () => {
    const { list } = commitOf(mountRows);
    for (const { name, row } of list) {
      expect(row[2], `${name} dur_us`).toBeTypeOf('number');
      expect(row[3], `${name} self_us`).toBeGreaterThanOrEqual(0);
      expect(row[3], `${name} self_us <= dur_us`).toBeLessThanOrEqual(row[2]);
    }
    const dur = (n: string) => list.find((r) => r.name === n)!.row[2] as number;
    expect(dur('App')).toBeGreaterThanOrEqual(dur('Layout'));
    expect(dur('Layout')).toBeGreaterThanOrEqual(dur('Main'));
    expect(dur('Main')).toBeGreaterThanOrEqual(dur('EffectPanel'));
  });

  test('defs carry a display name and owner path for every component', () => {
    const defs = h.messages.filter((m) => m.t === 'batch').flatMap((m) => m.defs);
    const byName = new Map(defs.map((d: any[]) => [d[1], d]));
    for (const name of TREE) expect(byName.has(name), name).toBe(true);
    expect(byName.get('Header')![5]).toBe('App>Layout>Header');
    expect(byName.get('Counter')![5]).toBe('App>Layout>Main>Counter');
    // React.memo: Details only.
    for (const [name, d] of byName) expect(d[6], name).toBe(name === 'Details');
  });

  test('increment: reasons, committed and changed hooks', async () => {
    await h.click('#inc');
    const c = commitOf(h.take());
    expect(c.order).toEqual(Object.keys(INCREMENT));
    expect(c.table).toEqual(INCREMENT);
  });

  test('theme: changed context', async () => {
    await h.click('#theme');
    const c = commitOf(h.take());
    expect(c.order).toEqual(Object.keys(THEME));
    expect(c.table).toEqual(THEME);
  });

  test('store: useSyncExternalStore change renders only StoreView', async () => {
    await h.click('#store');
    expect(commitOf(h.take()).table).toEqual(STORE);
  });

  test('tick: class state change renders only Clock', async () => {
    await h.click('#tick');
    expect(commitOf(h.take()).table).toEqual(TICK);
  });

  test('event sequence: a commit sends its renders, then its commit row', async () => {
    await h.click('#inc');
    const rows = h.take();
    const kinds = rows.map((r) => r[0]).filter((k) => k === 'render' || k === 'commit');
    expect(kinds).toEqual([...Array(9).fill('render'), 'commit']);
    const commit = rows.find((r) => r[0] === 'commit')!;
    expect(commit[13].rendered).toBe(9);
    expect(commit[13].walkUs).toBeGreaterThanOrEqual(0);
  });

  test('no shim errors', () => {
    expect(h.messages.filter((m) => m.t === 'error')).toEqual([]);
  });
});
