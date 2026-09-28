import { describe, expect, test } from 'vitest';
import { type CommitRow, HOLD_WALL_MS, type MarkPair, type MeasureRow, PageRollup, type SegRow, siteKey, spansOf, unionLength } from '../../packages/capture/src/rollup.ts';

// The chain linker, commit rollups and measures on synthetic rows, in the
// order a page sends them: on every React line a commit's own row comes after
// its renders and effects, and an update an effect enqueued comes before the
// commit row of the commit that ran the effect (18.0 to 19.1) or after it
// (19.2+, where the update row is written when its render starts).

const SID = 's1';
const T0 = 1_790_000_000_000_000; // epoch µs
const at = (ms: number) => T0 + Math.round(ms * 1000);
const cid = (n: number) => `${SID}.1.${n}`;
const uid = (n: number) => `${SID}.1.u${n}`;

const names = new Map([
  ['c-app', 'App'],
  ['c-list', 'List'],
  ['c-item', 'Item'],
  ['c-clock', 'Clock'],
]);

function row(kind: string, f: Partial<SegRow>): SegRow {
  return {
    session_id: SID,
    page_load_id: 1,
    ts: null,
    dur_us: null,
    self_us: null,
    kind,
    lane: null,
    component_id: null,
    commit_id: null,
    reason_code: null,
    changed_hooks: null,
    changed_context: null,
    changed_keys: null,
    committed: null,
    root_update_id: null,
    measure_instance_id: null,
    on_critical_path: null,
    call_site: null,
    extra: null,
    ...f,
  };
}

interface UpdateOpts {
  lane?: string;
  component?: string;
  event?: string;
  phase?: string;
  during?: number;
  label?: string;
  site?: string;
}

function update(ms: number, o: UpdateOpts = {}): SegRow {
  return row('update_enqueued', {
    ts: at(ms),
    lane: o.lane ?? 'Blocking',
    component_id: o.component ?? null,
    call_site: o.site ?? null,
    extra: {
      method: 'setState',
      phase: o.phase ?? null,
      event: o.event ?? null,
      component: null,
      label: o.label ?? null,
      stack: null,
      during: o.during === undefined ? null : cid(o.during),
    },
  });
}

function render(commit: number, ms: number, durMs: number, component: string, o: { self?: number; reason?: string; committed?: boolean } = {}): SegRow {
  return row('render', {
    ts: at(ms),
    dur_us: durMs * 1000,
    self_us: (o.self ?? durMs) * 1000,
    component_id: component,
    commit_id: cid(commit),
    reason_code: o.reason ?? 'props',
    committed: o.committed ?? true,
  });
}

function effect(kind: 'layout_effect' | 'passive_effect', commit: number, ms: number, durMs: number, component: string): SegRow {
  return row(kind, { ts: at(ms), dur_us: durMs * 1000, component_id: component, commit_id: cid(commit), extra: { phase: 'mount' } });
}

interface CommitOpts {
  render: [number, number];
  commit: [number, number];
  passive?: [number, number];
  trigger?: string;
  strict?: boolean;
  passiveSync?: boolean;
}

function commit(n: number, lane: string, o: CommitOpts): SegRow {
  return row('commit', {
    ts: at(o.commit[0]),
    dur_us: (o.commit[1] - o.commit[0]) * 1000,
    lane,
    commit_id: cid(n),
    extra: {
      root: 1,
      trigger: o.trigger ?? null,
      strict: o.strict ?? false,
      passiveSync: o.passiveSync ?? null,
      renderStart: at(o.render[0]),
      renderEnd: at(o.render[1]),
      commitStart: at(o.commit[0]),
      commitEnd: at(o.commit[1]),
      passiveStart: o.passive === undefined ? null : at(o.passive[0]),
      passiveEnd: o.passive === undefined ? null : at(o.passive[1]),
    },
  });
}

function eventTiming(name: string, interactionId: number, ms: number, durMs: number, processing: [number, number], target = 'button#go'): SegRow {
  return row('event_timing', {
    ts: at(ms),
    dur_us: durMs * 1000,
    extra: { name, interactionId, processingStart: at(processing[0]), processingEnd: at(processing[1]), target },
  });
}

const mark = (name: string, ms: number) => row('mark', { ts: at(ms), extra: { name } });

// Pushes rows one wall-clock millisecond apart, then drains everything.
function run(rows: SegRow[], marks: MarkPair[] = []): { seg: SegRow[]; commits: Map<string, CommitRow>; measures: MeasureRow[] } {
  const r = new PageRollup({ sessionId: SID, pageLoadId: 1, names, marks });
  rows.forEach((x, i) => r.push(x, 1000 + i));
  const out = r.drain(1000 + rows.length, true);
  return { seg: out.seg, commits: new Map(out.commits.map((c) => [c.commit_id, c])), measures: out.measures };
}

describe('chain linker', () => {
  test('a click batch: every row of the commit, and the second update, join the first update', () => {
    const rows = [
      update(0, { component: 'c-app', event: 'click', site: 'onClick (src/App.jsx:10:5)' }),
      update(0.5, { component: 'c-list', event: 'click' }),
      render(1, 1, 5, 'c-app', { self: 1, reason: 'hooks' }),
      render(1, 2, 3, 'c-list', { self: 2, reason: 'hooks' }),
      effect('layout_effect', 1, 6.2, 0.5, 'c-list'),
      commit(1, 'Blocking', { render: [1, 6], commit: [6, 7], trigger: 'click' }),
    ];
    const { seg, commits } = run(rows);
    expect(seg).toHaveLength(rows.length);
    for (const r of seg) expect(r.root_update_id).toBe(uid(1));
    const c = commits.get(cid(1))!;
    expect(c.root_update_id).toBe(uid(1));
    expect(c.producer_component_id).toBe('c-app');
    expect(c.producer_call_site).toBe('onClick (src/App.jsx:10:5)');
    expect(c.trigger_event).toBe('click');
    expect(c.cascade_commit_id).toBeNull();
  });

  test('a layout effect that enqueues an update: the cascade commit continues the chain', () => {
    const rows = [
      update(0, { component: 'c-app', event: 'click' }),
      effect('layout_effect', 1, 3.5, 0.5, 'c-item'),
      update(3.8, { component: 'c-item', phase: 'layout', during: 1 }),
      render(1, 1, 2, 'c-app', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [1, 3], commit: [3.2, 4.5] }),
      render(2, 4.6, 0.9, 'c-item', { reason: 'hooks' }),
      commit(2, 'Blocking', { render: [4.6, 5.5], commit: [5.5, 6] }),
    ];
    const { seg, commits } = run(rows);
    for (const r of seg) expect(r.root_update_id).toBe(uid(1));
    const c2 = commits.get(cid(2))!;
    expect(c2.root_update_id).toBe(uid(1));
    expect(c2.cascade_commit_id).toBe(cid(1));
    expect(c2.producer_component_id).toBe('c-item');
    // The trigger is the chain's: the click that started it.
    expect(c2.trigger_event).toBe('click');
    expect(commits.get(cid(1))!.producer_component_id).toBe('c-app');
  });

  test('a passive effect that enqueues an update (18.0 to 19.1 order): the chain continues', () => {
    const rows = [
      update(0, { component: 'c-app', event: 'click' }),
      render(1, 1, 2, 'c-app', { reason: 'hooks' }),
      effect('passive_effect', 1, 20, 1, 'c-list'),
      update(20.5, { component: 'c-list', phase: 'passive', during: 1 }),
      commit(1, 'Blocking', { render: [1, 3], commit: [3, 4], passive: [20, 21] }),
      render(2, 22, 2, 'c-list', { reason: 'hooks' }),
      commit(2, 'Blocking', { render: [22, 24], commit: [24, 25] }),
    ];
    const { seg, commits } = run(rows);
    for (const r of seg) expect(r.root_update_id).toBe(uid(1));
    expect(commits.get(cid(2))!.cascade_commit_id).toBe(cid(1));
    expect(commits.get(cid(2))!.root_update_id).toBe(uid(1));
  });

  test('a cascading update written after its parent commit finished (19.2+ order)', () => {
    const rows = [
      update(0, { component: 'c-app', event: 'click' }),
      render(1, 1, 2, 'c-app', { reason: 'hooks' }),
      effect('passive_effect', 1, 20, 1, 'c-list'),
      commit(1, 'Blocking', { render: [1, 3], commit: [3, 4], passive: [20, 21] }),
      // 19.2+ names the component only, and labels the update.
      update(20.5, { label: 'Cascading Update', during: 1 }),
      render(2, 22, 2, 'c-list', { reason: 'hooks' }),
      commit(2, 'Blocking', { render: [22, 24], commit: [24, 25] }),
    ];
    rows[4]!.extra.component = 'List';
    const { seg, commits } = run(rows);
    for (const r of seg) expect(r.root_update_id).toBe(uid(1));
    const c2 = commits.get(cid(2))!;
    expect(c2.cascade_commit_id).toBe(cid(1));
    // The producer's id comes from the render of the component it names.
    expect(c2.producer_component_id).toBe('c-list');
  });

  test('an input update rendered together with a pending timer update is the producer', () => {
    const rows = [
      update(0, { component: 'c-clock' }),
      update(3, { component: 'c-app', event: 'click' }),
      render(1, 4, 2, 'c-app', { reason: 'hooks' }),
      render(1, 6, 2, 'c-clock', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [4, 8], commit: [8, 9] }),
    ];
    const { seg, commits } = run(rows);
    const c = commits.get(cid(1))!;
    expect(c.producer_component_id).toBe('c-app');
    expect(c.root_update_id).toBe(uid(2));
    expect(c.trigger_event).toBe('click');
    // The timer's update rendered in the click's commit: it joins the chain.
    expect(seg[0]!.root_update_id).toBe(uid(2));
  });

  test('updates in different lanes produce the commits of their own lanes', () => {
    const rows = [
      update(0, { component: 'c-app', event: 'click' }),
      update(1, { component: 'c-list', lane: 'Transition', event: 'click' }),
      render(1, 2, 2, 'c-app', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [2, 4], commit: [4, 5] }),
      render(2, 6, 10, 'c-list', { reason: 'hooks' }),
      commit(2, 'Transition', { render: [6, 16], commit: [16, 17] }),
    ];
    const { commits } = run(rows);
    expect(commits.get(cid(1))!.root_update_id).toBe(uid(1));
    expect(commits.get(cid(2))!.root_update_id).toBe(uid(2));
    expect(commits.get(cid(2))!.producer_component_id).toBe('c-list');
  });

  test('an update that never rendered does not claim a later commit', () => {
    const rows = [
      update(0, { component: 'c-clock' }),
      update(5000, { component: 'c-app', event: 'click' }),
      render(1, 5001, 2, 'c-app', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [5001, 5003], commit: [5003, 5004] }),
    ];
    const { seg, commits } = run(rows);
    expect(commits.get(cid(1))!.root_update_id).toBe(uid(2));
    // The stale update's chain ends at itself.
    expect(seg[0]!.root_update_id).toBe(uid(1));
  });

  test('a commit with no update row: its own root, and the first component that rendered for its own state', () => {
    const rows = [
      render(1, 1, 3, 'c-app', { reason: 'parent', committed: false }),
      render(1, 1.5, 2, 'c-clock', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [1, 4], commit: [4, 5], trigger: 'message' }),
    ];
    const { seg, commits } = run(rows);
    const c = commits.get(cid(1))!;
    expect(c.root_update_id).toBe(cid(1));
    expect(c.producer_component_id).toBe('c-clock');
    expect(c.trigger_event).toBe('message');
    for (const r of seg) expect(r.root_update_id).toBe(cid(1));
  });

  test('a chain left open for 30 seconds expires', () => {
    const r = new PageRollup({ sessionId: SID, pageLoadId: 1, names });
    // An update that never renders, and a commit whose own row never comes.
    r.push(update(0, { component: 'c-clock' }), 1000);
    r.push(render(1, 1, 2, 'c-app', { reason: 'hooks' }), 1001);
    r.push(row('loaf', { ts: at(31_000), dur_us: 60_000, extra: { scripts: [] } }), 1002);
    const out = r.drain(1003);
    const rendered = out.seg.find((x) => x.kind === 'render');
    expect(rendered?.root_update_id).toBe(cid(1));
    // A commit 31 s later is not the stale update's.
    r.push(render(2, 31_001, 2, 'c-app', { reason: 'hooks' }), 1004);
    r.push(commit(2, 'Blocking', { render: [31_001, 31_003], commit: [31_003, 31_004] }), 1005);
    const later = r.drain(1006, true);
    expect(later.commits[0]!.root_update_id).toBe(cid(2));
  });
});

describe('commit rollup', () => {
  test('totals, fan-out and shares', () => {
    const rows = [
      update(0, { component: 'c-list', event: 'click', site: 'onClick (src/List.jsx:4:3)' }),
      render(1, 1, 10, 'c-list', { self: 4, reason: 'hooks' }),
      render(1, 2, 1, 'c-item', { self: 1, reason: 'props' }),
      render(1, 3, 1, 'c-item', { self: 1, reason: 'parent', committed: false }),
      render(1, 4, 1, 'c-item', { self: 1, reason: 'parent', committed: false }),
      effect('layout_effect', 1, 11.5, 1, 'c-item'),
      effect('passive_effect', 1, 13, 1, 'c-list'),
      commit(1, 'Blocking', { render: [1, 11], commit: [11, 12], passive: [13, 14], strict: true, passiveSync: true }),
    ];
    const c = run(rows).commits.get(cid(1))!;
    expect(c.render_ms).toBeCloseTo(10);
    expect(c.layout_ms).toBeCloseTo(1);
    expect(c.passive_ms).toBeCloseTo(1);
    expect(c.total_ms).toBeCloseTo(12);
    expect(c).toMatchObject({ rendered: 4, committed: 2, noop: 2, distinct_types: 2, top_type: 'Item', top_type_count: 3, top1_component_id: 'c-list' });
    expect(c.noop_ms).toBeCloseTo(2);
    expect(c.top1_share).toBeCloseTo(4 / 12);
    expect(c.noop_share).toBeCloseTo(2 / 12);
    expect(c.effect_share).toBeCloseTo(2 / 12);
    expect(c.passive_sync).toBe(true);
    expect(c.strict_mode).toBe(true);
    expect(c.lane).toBe('Blocking');
    expect(c.ts).toBe(at(1));
  });

  test('the signature survives edits that move lines, and tells producers apart', () => {
    const sig = (site: string, component = 'c-app', trigger = 'click') =>
      run([
        update(0, { component, event: trigger, site }),
        render(1, 1, 2, component, { reason: 'hooks' }),
        commit(1, 'Blocking', { render: [1, 3], commit: [3, 4] }),
      ]).commits.get(cid(1))!.signature;
    const before = sig('onClick (src/App.jsx:10:5)');
    expect(before).toMatch(/^sig_[0-9a-f]{10}$/);
    expect(sig('onClick (src/App.jsx:14:9)')).toBe(before);
    expect(sig('onClick (src/Other.jsx:10:5)')).not.toBe(before);
    expect(sig('onClick (src/App.jsx:10:5)', 'c-list')).not.toBe(before);
    expect(sig('onClick (src/App.jsx:10:5)', 'c-app', 'keydown')).not.toBe(before);
  });

  test('siteKey drops line and column', () => {
    expect(siteKey('onClick (src/App.jsx:10:5)')).toBe('onClick@src/App.jsx');
    expect(siteKey('src/App.jsx:10:5')).toBe('src/App.jsx');
    expect(siteKey(null)).toBeNull();
  });
});

describe('intervals', () => {
  test('unionLength merges nested and overlapping intervals and clips them', () => {
    expect(unionLength([], 0, 10)).toBe(0);
    expect(unionLength([[0, 10], [2, 5], [8, 12]], 0, 100)).toBe(12);
    expect(unionLength([[0, 10], [2, 5], [8, 12]], 3, 9)).toBe(6);
    expect(unionLength([[0, 1], [2, 3], [2.5, 4]], 0, 100)).toBe(3);
    expect(unionLength([[5, 5], [7, 6]], 0, 100)).toBe(0);
  });

  test('a blocking commit counts its render phase, a transition only its component spans', () => {
    const blocking = commit(1, 'Blocking', { render: [1, 5], commit: [5, 6], passive: [9, 10] });
    expect(spansOf(blocking)).toEqual([
      [at(1), at(5)],
      [at(5), at(6)],
      [at(9), at(10)],
    ]);
    const transition = commit(2, 'Transition', { render: [1, 50], commit: [50, 51] });
    expect(spansOf(transition)).toEqual([[at(50), at(51)]]);
  });
});

describe('measures', () => {
  // A click whose handler enqueues an update. A timer callback runs in the
  // same frame (its long-animation-frame script), and the chain's passive
  // effects run after the paint. Event Timing entries arrive after the paint.
  const clickRows = () => [
    update(4, { component: 'c-app', event: 'click' }),
    render(1, 5, 10, 'c-app', { reason: 'hooks' }),
    row('loaf', {
      ts: at(0),
      dur_us: 41_000,
      extra: {
        scripts: [
          { invoker: 'BUTTON.onclick', start: at(1), duration: 19 },
          { invoker: 'TimerHandler:setTimeout', start: at(25), duration: 6 },
        ],
      },
    }),
    eventTiming('pointerdown', 7, 0, 40, [1, 2]),
    eventTiming('pointerup', 7, 0.5, 40, [2, 3]),
    eventTiming('click', 7, 0.6, 40, [3, 20]),
    effect('passive_effect', 1, 45, 2, 'c-app'),
    commit(1, 'Blocking', { render: [5, 15], commit: [15, 18], passive: [45, 47] }),
  ];

  test('an Event Timing interaction: ends, time buckets as unions, and stamps', () => {
    const { seg, commits, measures } = run(clickRows());
    expect(measures).toHaveLength(1);
    const m = measures[0]!;
    expect(m).toMatchObject({ name: 'click', source: 'event_timing', interaction_id: 7, target: 'button#go' });
    expect(m.ts_start).toBe(at(0));
    expect(m.ts_end_marker).toBe(at(20));
    expect(m.ts_end_paint).toBe(at(40.6));
    // The chain's passive effects ran after the paint.
    expect(m.ts_end_idle).toBe(at(47));
    expect(m.duration_ms).toBeCloseTo(40.6);
    // Handlers [1, 20] cover the chain's render and commit [5, 18].
    expect(m.on_path_ms).toBeCloseTo(19);
    // The timer callback [25, 31].
    expect(m.interference_ms).toBeCloseTo(6);
    expect(m.waiting_ms).toBeCloseTo(40.6 - 25);
    expect(m.on_path_ms + m.interference_ms + m.waiting_ms).toBeCloseTo(m.duration_ms);

    const stamp = (r: SegRow | CommitRow) => [r.measure_instance_id, r.on_critical_path];
    const mid = m.measure_instance_id;
    for (const r of seg.filter((x) => x.kind === 'event_timing')) expect(stamp(r)).toEqual([mid, true]);
    expect(stamp(seg.find((x) => x.kind === 'update_enqueued')!)).toEqual([mid, true]);
    expect(stamp(seg.find((x) => x.kind === 'render')!)).toEqual([mid, true]);
    expect(stamp(seg.find((x) => x.kind === 'commit')!)).toEqual([mid, true]);
    expect(stamp(seg.find((x) => x.kind === 'loaf')!)).toEqual([mid, false]);
    // After the paint: in the chain, but not on the critical path.
    expect(stamp(seg.find((x) => x.kind === 'passive_effect')!)).toEqual([null, null]);
    expect(stamp(commits.get(cid(1))!)).toEqual([mid, true]);
  });

  test('a held mouse button: the time between the inputs is not part of the interaction', () => {
    const rows = [
      // A slow pointerdown, then the button is held for 200 ms.
      eventTiming('pointerdown', 9, 0, 16, [0.5, 1]),
      update(201, { component: 'c-app', event: 'pointerup' }),
      render(1, 202, 10, 'c-app', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [202, 212], commit: [212, 214] }),
      update(100, { component: 'c-clock' }),
      render(2, 101, 3, 'c-clock', { reason: 'hooks' }),
      commit(2, 'Blocking', { render: [101, 104], commit: [104, 105] }),
      eventTiming('pointerup', 9, 200, 48, [201, 230]),
      eventTiming('click', 9, 200.5, 48, [230, 231]),
    ];
    const { commits, measures } = run(rows);
    const m = measures[0]!;
    expect(m.name).toBe('click');
    expect(m.ts_start).toBe(at(0));
    expect(m.ts_end_marker).toBe(at(231));
    expect(m.ts_end_paint).toBe(at(248.5));
    // [0, 16] and [200, 248.5].
    expect(m.duration_ms).toBeCloseTo(16 + 48.5);
    expect(m.on_path_ms).toBeCloseTo(0.5 + 30);
    // A timer's commit while the button was down is no part of it.
    expect(m.interference_ms).toBeCloseTo(0);
    expect(commits.get(cid(2))!.measure_instance_id).toBeNull();
    expect(m.on_path_ms + m.interference_ms + m.waiting_ms).toBeCloseTo(m.duration_ms);
  });

  test('an input event with no entry of its own: its update is on the path, a timer update is not', () => {
    const rows = [
      // The click took under 16 ms: only the pointerdown has an entry.
      update(6, { component: 'c-app', event: 'click' }),
      render(1, 7, 2, 'c-app', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [7, 9], commit: [9, 10] }),
      update(11, { component: 'c-clock' }),
      render(2, 11.5, 1, 'c-clock', { reason: 'hooks' }),
      commit(2, 'Blocking', { render: [11.5, 12.5], commit: [12.5, 13] }),
      eventTiming('pointerdown', 4, 0, 16, [1, 1.5]),
    ];
    const { commits, measures } = run(rows);
    const m = measures[0]!;
    expect(m.name).toBe('pointerdown');
    expect(m.on_path_ms).toBeCloseTo(0.5 + 3);
    expect(m.interference_ms).toBeCloseTo(1.5);
    expect(commits.get(cid(1))!.on_critical_path).toBe(true);
    expect(commits.get(cid(2))!.on_critical_path).toBe(false);
  });

  test('a commit an input started is on the path, even when its only update row is a timer (19.2+)', () => {
    const rows = [
      // The timer's update was pending when the handler ran; 19.2+ reports
      // only the first update of the batch, and names the event on the render.
      update(0.5, { component: 'c-clock', label: 'Update' }),
      render(1, 5, 2, 'c-app', { reason: 'hooks' }),
      render(1, 7, 1, 'c-clock', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [5, 8], commit: [8, 9], trigger: 'click' }),
      eventTiming('click', 5, 0, 24, [1, 4.5]),
    ];
    const { commits, measures } = run(rows);
    expect(commits.get(cid(1))!.on_critical_path).toBe(true);
    expect(measures[0]!.on_path_ms).toBeCloseTo(3.5 + 4);
    expect(measures[0]!.interference_ms).toBeCloseTo(0);
  });

  test('a configured mark pair', () => {
    const rows = [
      mark('route:start', 100),
      update(150, { component: 'c-app' }),
      render(1, 151, 9, 'c-app', { reason: 'hooks' }),
      commit(1, 'Blocking', { render: [151, 160], commit: [160, 162] }),
      mark('route:end', 170),
    ];
    const { seg, measures } = run(rows, [{ name: 'route', start: 'route:start', end: 'route:end' }]);
    expect(measures).toHaveLength(1);
    const m = measures[0]!;
    expect(m).toMatchObject({ name: 'route', source: 'marks', interaction_id: null, ts_end_paint: null });
    expect(m.ts_start).toBe(at(100));
    expect(m.ts_end_marker).toBe(at(170));
    expect(m.duration_ms).toBeCloseTo(70);
    expect(m.on_path_ms).toBeCloseTo(11);
    expect(m.interference_ms).toBeCloseTo(0);
    expect(m.waiting_ms).toBeCloseTo(59);
    expect(seg.find((x) => x.kind === 'render')!.on_critical_path).toBe(true);
  });
});

describe('holding rows for late facts', () => {
  test('rows wait for their commit, then for the hold', () => {
    const r = new PageRollup({ sessionId: SID, pageLoadId: 1, names });
    r.push(update(0, { component: 'c-app' }), 1000);
    r.push(render(1, 1, 2, 'c-app', { reason: 'hooks' }), 1000);
    expect(r.drain(1000 + HOLD_WALL_MS + 1).seg.map((x) => x.kind)).toEqual(['update_enqueued']);
    r.push(commit(1, 'Blocking', { render: [1, 3], commit: [3, 4] }), 1000 + HOLD_WALL_MS + 2);
    // The commit's own row only just came: its rollup waits a hold too.
    const now = r.drain(1000 + HOLD_WALL_MS + 3);
    expect(now.seg.map((x) => x.kind)).toEqual(['render']);
    expect(now.commits).toEqual([]);
    const later = r.drain(1000 + 2 * HOLD_WALL_MS + 3);
    expect(later.seg.map((x) => x.kind)).toEqual(['commit']);
    expect(later.commits.map((c) => c.commit_id)).toEqual([cid(1)]);
    expect(r.heldRows).toBe(0);
  });

  test('an open interaction holds the rows it can still stamp', () => {
    const r = new PageRollup({ sessionId: SID, pageLoadId: 1, names });
    r.push(eventTiming('click', 3, 0, 40, [1, 20]), 1000);
    r.push(update(4, { component: 'c-app', event: 'click' }), 1000);
    // Two seconds of wall time pass with no new entry: the measure is final
    // and the rows it stamped go out after their own hold.
    expect(r.drain(1500).measures).toEqual([]);
    const done = r.drain(3001);
    expect(done.measures).toHaveLength(1);
    expect(done.seg).toEqual([]);
    const out = r.drain(1000 + HOLD_WALL_MS + 1);
    expect(out.seg.map((x) => [x.kind, x.on_critical_path])).toEqual([
      ['event_timing', true],
      ['update_enqueued', true],
    ]);
  });
});
