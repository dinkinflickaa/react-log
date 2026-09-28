// What the shim must report for the fixture app, shared by the unit (jsdom)
// and browser (headless Chromium) suites. Keys are in walk order.

export interface Expected {
  reason: string;
  committed: boolean;
  hooks?: string;
  context?: string;
}

export const TREE = ['App', 'Layout', 'Header', 'Main', 'Counter', 'Details', 'Clock', 'EffectPanel', 'StoreView', 'Footer'];

export const MOUNT: Record<string, Expected> = Object.fromEntries(TREE.map((n) => [n, { reason: 'mount', committed: true }]));

// #inc: state change in App; identity-only props below; memo skips Details.
// committed is false where a render changed nothing in the DOM.
export const INCREMENT: Record<string, Expected> = {
  App: { reason: 'hooks', committed: true, hooks: '0:useState' },
  Layout: { reason: 'props', committed: true },
  Header: { reason: 'props', committed: false },
  Main: { reason: 'props', committed: true },
  Counter: { reason: 'props', committed: true },
  Clock: { reason: 'parent', committed: false },
  EffectPanel: { reason: 'props', committed: true },
  StoreView: { reason: 'parent', committed: false },
  Footer: { reason: 'parent', committed: false },
};

// #theme: the context change reaches Header; everything else renders
// without changing the DOM.
export const THEME: Record<string, Expected> = {
  App: { reason: 'hooks', committed: true, hooks: '1:useState' },
  Layout: { reason: 'props', committed: true },
  Header: { reason: 'context', committed: true, context: 'ThemeContext' },
  Main: { reason: 'props', committed: false },
  Counter: { reason: 'props', committed: false },
  Clock: { reason: 'parent', committed: false },
  EffectPanel: { reason: 'parent', committed: false },
  StoreView: { reason: 'parent', committed: false },
  Footer: { reason: 'parent', committed: false },
};

export const STORE: Record<string, Expected> = {
  StoreView: { reason: 'hooks', committed: true, hooks: '0:useSyncExternalStore' },
};

export const TICK: Record<string, Expected> = {
  Clock: { reason: 'state', committed: true },
};

// Render rows of the single commit in `rows`, as comparable records.
export function renders(rows: any[][], names: Map<string, string>): { name: string; row: any[] }[] {
  const commits = new Set(rows.filter((r) => r[0] === 'render').map((r) => r[6]));
  if (commits.size !== 1) throw new Error(`expected one commit with renders, got ${commits.size}`);
  return rows.filter((r) => r[0] === 'render').map((row) => ({ name: names.get(row[5]) ?? '?', row }));
}

export function actual(list: { name: string; row: any[] }[]): Record<string, Expected> {
  return Object.fromEntries(
    list.map(({ name, row }) => {
      const e: Expected = { reason: row[7], committed: row[11] };
      if (row[8] !== null) e.hooks = row[8];
      if (row[9] !== null) e.context = row[9];
      return [name, e];
    }),
  );
}
