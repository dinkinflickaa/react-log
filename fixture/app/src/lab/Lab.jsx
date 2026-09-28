import { createContext, memo, useContext, useLayoutEffect, useRef, useState } from 'react';

// The lab: benchmark interactions and planted performance bugs. Each section
// owns its state and button, so an interaction re-renders only its section.
//
//   #bench-small   SmallPanel     ~50 components, all commit
//   #bench-medium  MediumTable    ~500 rows, reordered
//   #bench-large   LargeList      ~3,000 items, nearly all no-op
//   #bug-producer  Sidebar        ~3,000 items, nearly all no-op  (stabilize_producer)
//   #bug-context   ShellProvider  200 context consumers, no-op    (narrow_input)
//   #bug-memo      Dashboard      300-bar chart re-renders, no-op (memo_boundary)
//   #bug-hoist     Report         heavy computation in render     (hoist_render_work)
//   #bug-effect    Metrics        forced layouts in an effect     (effect_shape)
//   #bug-diffuse   Grid           1,000 cells all change          (bail: diffuse_genuine_work)
//   #bug-budget    Toggle         one cheap render                (bail: within_budget)

function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

// Deterministic pseudo-random numbers, so every run does the same work.
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// ---- narrow_input: one context carries unrelated fields and is rebuilt on
// every render, so all 200 badges re-render when only the cart changes.

const ShellContext = createContext(null);
ShellContext.displayName = 'ShellContext';
const USER = { name: 'Ada' };

function ShellProvider({ children }) {
  const [cart, setCart] = useState(0);
  const shell = { theme: 'light', user: USER, cart, addToCart: () => setCart((c) => c + 1) };
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
}

function CartButton() {
  const { cart, addToCart } = useContext(ShellContext);
  return (
    <button id="bug-context" onClick={addToCart}>
      cart: {cart}
    </button>
  );
}

function ThemeBadge({ label }) {
  const { theme } = useContext(ShellContext);
  return <span className={`badge badge-${theme}`}>{label}</span>;
}

function Badges() {
  return (
    <section>
      <CartButton />
      {range(200).map((i) => (
        <ThemeBadge key={i} label={`b${i}`} />
      ))}
    </section>
  );
}

// ---- bench-small: about 50 components, every one shows the new value.

function SmallItem({ value, index }) {
  return (
    <li>
      {index}: {value}
    </li>
  );
}

function SmallPanel() {
  const [count, setCount] = useState(0);
  return (
    <section>
      <button id="bench-small" onClick={() => setCount((c) => c + 1)}>
        small {count}
      </button>
      <ul>
        {range(48).map((i) => (
          <SmallItem key={i} index={i} value={count} />
        ))}
      </ul>
    </section>
  );
}

// ---- bench-medium: 500 rows re-render and move when the order flips.

const ROWS = range(500).map((i) => ({ id: i, name: `row ${i}`, score: (i * 7919) % 1000 }));

function TableRow({ row }) {
  return (
    <tr>
      <td>{row.name}</td>
      <td>{row.score}</td>
    </tr>
  );
}

function MediumTable() {
  const [asc, setAsc] = useState(true);
  const rows = asc ? ROWS : [...ROWS].reverse();
  return (
    <section>
      <button id="bench-medium" onClick={() => setAsc((a) => !a)}>
        order {asc ? 'asc' : 'desc'}
      </button>
      <table>
        <tbody>
          {rows.map((row) => (
            <TableRow key={row.id} row={row} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---- bench-large: the benchmark's large interaction. Every item is
// memoized, but the inline onSelect is a new function on each render, so all
// 3,000 re-render and only the two whose selection changed commit anything.
// The same code as Sidebar below, kept as it is: fixes land in Sidebar, and
// this one stays the overhead benchmark's workload.

const ITEMS = range(3000).map((i) => ({ id: i, label: `item ${i}` }));

const LargeItem = memo(function LargeItem({ item, selected, onSelect }) {
  return (
    <li className={selected ? 'selected' : ''} onClick={() => onSelect(item.id)}>
      {item.label}
    </li>
  );
});

function LargeList() {
  const [selected, setSelected] = useState(0);
  return (
    <section>
      <button id="bench-large" onClick={() => setSelected((s) => (s + 1) % ITEMS.length)}>
        select next ({selected})
      </button>
      <ul>
        {ITEMS.map((item) => (
          <LargeItem key={item.id} item={item} selected={item.id === selected} onSelect={(id) => setSelected(id)} />
        ))}
      </ul>
    </section>
  );
}

// ---- stabilize_producer: every item is memoized, but the inline onSelect is
// a new function on each render, so all 3,000 re-render and only the two
// whose selection changed commit anything.

const SidebarItem = memo(function SidebarItem({ item, selected, onSelect }) {
  return (
    <li className={selected ? 'selected' : ''} onClick={() => onSelect(item.id)}>
      {item.label}
    </li>
  );
});

function Sidebar() {
  const [selected, setSelected] = useState(0);
  return (
    <section>
      <button id="bug-producer" onClick={() => setSelected((s) => (s + 1) % ITEMS.length)}>
        select next ({selected})
      </button>
      <ul>
        {ITEMS.map((item) => (
          <SidebarItem key={item.id} item={item} selected={item.id === selected} onSelect={(id) => setSelected(id)} />
        ))}
      </ul>
    </section>
  );
}

// ---- memo_boundary: the chart re-renders with every refresh although its
// data never changes.

const CHART = range(300).map((i) => ({ id: i, value: (i * 37) % 100 }));

function Bar({ value }) {
  return <div className="bar" style={{ height: value }} />;
}

function HeavyChart({ data }) {
  return (
    <div className="chart">
      {data.map((d) => (
        <Bar key={d.id} value={d.value} />
      ))}
    </div>
  );
}

function Dashboard() {
  const [refreshes, setRefreshes] = useState(0);
  return (
    <section>
      <button id="bug-memo" onClick={() => setRefreshes((r) => r + 1)}>
        refreshed {refreshes}
      </button>
      <HeavyChart data={CHART} />
    </section>
  );
}

// ---- hoist_render_work: the statistics are recomputed on every render from
// data that never changes.

const SAMPLES = (() => {
  const rand = seeded(7);
  return range(40_000).map(() => rand() * 1000);
})();

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.floor(q * (sorted.length - 1))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { p50: at(0.5).toFixed(1), p95: at(0.95).toFixed(1), mean: mean.toFixed(1) };
}

function Report() {
  const [version, setVersion] = useState(0);
  const stats = summarize(SAMPLES);
  return (
    <section>
      <button id="bug-hoist" onClick={() => setVersion((v) => v + 1)}>
        report v{version}
      </button>
      <p>
        p50 {stats.p50}, p95 {stats.p95}, mean {stats.mean}
      </p>
    </section>
  );
}

// ---- effect_shape: a layout effect with no dependency list writes and
// reads layout in a loop, forcing a synchronous layout per item, on every
// render.

function Metrics() {
  const [tick, setTick] = useState(0);
  const listRef = useRef(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    let i = 0;
    for (const el of list.children) {
      el.style.width = `${100 + ((tick + i++) % 50)}px`;
      el.dataset.height = String(list.offsetHeight);
    }
  });
  return (
    <section>
      <button id="bug-effect" onClick={() => setTick((t) => t + 1)}>
        metrics {tick}
      </button>
      <ul ref={listRef}>
        {range(400).map((i) => (
          <li key={i}>metric {i}</li>
        ))}
      </ul>
    </section>
  );
}

// ---- diffuse_genuine_work: every cell shows a new value, so every render
// commits; nothing to fix.

function Cell({ value }) {
  return <td>{value}</td>;
}

function Grid() {
  const [seed, setSeed] = useState(1);
  const rand = seeded(seed);
  const values = range(1000).map(() => Math.floor(rand() * 100));
  return (
    <section>
      <button id="bug-diffuse" onClick={() => setSeed((s) => s + 1)}>
        shuffle {seed}
      </button>
      <table>
        <tbody>
          {range(40).map((r) => (
            <tr key={r}>
              {range(25).map((c) => (
                <Cell key={c} value={values[r * 25 + c]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---- within_budget: one cheap render.

function Toggle() {
  const [on, setOn] = useState(false);
  return (
    <button id="bug-budget" onClick={() => setOn((v) => !v)}>
      {on ? 'on' : 'off'}
    </button>
  );
}

export function Lab() {
  return (
    <ShellProvider>
      <SmallPanel />
      <MediumTable />
      <LargeList />
      <Sidebar />
      <Badges />
      <Dashboard />
      <Report />
      <Metrics />
      <Grid />
      <Toggle />
    </ShellProvider>
  );
}
