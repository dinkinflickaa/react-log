import { install, type ShimApi } from '../../packages/shim/src/install.ts';

export type Row = [
  kind: string,
  ts: number | null,
  dur_us: number | null,
  self_us: number | null,
  lane: string | null,
  component_id: string | null,
  commit: number | null,
  reason_code: string | null,
  changed_hooks: string | null,
  changed_context: string | null,
  changed_keys: string | null,
  committed: boolean | null,
  call_site: string | null,
  extra: any,
];

export interface Harness {
  api: ShimApi;
  messages: any[];
  names: Map<string, string>;
  act: (fn: () => unknown) => Promise<void>;
  click: (selector: string) => Promise<void>;
  // Flush the shim and return the rows sent since the previous call.
  take: () => Row[];
}

// Installs the shim on the jsdom global before React loads, then renders the
// fixture app with the React version this vitest project aliases. `before`
// runs between the two, with the shim's hook in place.
export async function start(opts: { before?: (g: any) => void } = {}): Promise<Harness> {
  const g = globalThis as any;
  const messages: any[] = [];
  g.__reactLogSink = (json: string) => messages.push(JSON.parse(json));
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const api = install(g, { flushIntervalMs: 3_600_000 });
  opts.before?.(g);

  const React = (await import('react')).default as any;
  const { createRoot } = (await import('react-dom/client')).default as any;
  const act = React.act ?? ((await import('react-dom/test-utils')) as any).default.act;
  const { App } = (await import('../../fixture/app/src/App.jsx')) as any;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const names = new Map<string, string>();
  let seen = 0;

  const h: Harness = {
    api,
    messages,
    names,
    act: async (fn) => {
      await act(async () => {
        fn();
      });
    },
    click: async (selector) => {
      const el = container.querySelector(selector);
      if (el === null) throw new Error(`no element ${selector}`);
      await h.act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    },
    take: () => {
      api.flushNow();
      const rows: Row[] = [];
      for (; seen < messages.length; seen++) {
        const m = messages[seen];
        if (m.t !== 'batch') continue;
        for (const d of m.defs) names.set(d[0], d[1]);
        rows.push(...m.rows);
      }
      return rows;
    },
  };
  await h.act(() => root.render(React.createElement(App)));
  return h;
}

export function rendersByCommit(rows: Row[], names: Map<string, string>): Map<number, { name: string; row: Row }[]> {
  const out = new Map<number, { name: string; row: Row }[]>();
  for (const row of rows) {
    if (row[0] !== 'render') continue;
    const list = out.get(row[6]!) ?? [];
    list.push({ name: names.get(row[5]!) ?? '?', row });
    out.set(row[6]!, list);
  }
  return out;
}
