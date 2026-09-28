import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkFindings, PLANTED } from './findings.ts';
import { fill, parseQueries, repo, run } from './golden.ts';

const queries = parseQueries();

// An entry built straight from the golden data, with the planted verdict.
function entry(producer: string): any {
  const [c] = run(`
    SELECT c.*, d.display_name AS producer, m.name AS measure_name
    FROM commits c JOIN defs d ON d.component_id = c.producer_component_id
    LEFT JOIN measures m ON m.measure_instance_id = c.measure_instance_id
    WHERE d.display_name = '${producer}' ORDER BY c.total_ms DESC LIMIT 1`);
  const evidence = fill(queries.get('finding_numbers')!, { commit_id: c.commit_id });
  const [n] = run(evidence);
  const verdict = PLANTED[producer]!.verdict;
  const fix = verdict.includes('_') && !['diffuse_genuine_work', 'within_budget'].includes(verdict) ? verdict : null;
  return {
    commit_id: c.commit_id,
    signature: c.signature,
    measure: c.measure_name,
    on_critical_path: c.on_critical_path,
    total_ms: n.total_ms,
    cause: { producer, call_site: c.producer_call_site, trigger: c.trigger_event, cascade: c.cascade_commit_id !== null },
    extent: { rendered: n.rendered, committed: n.committed, noop: n.noop, top_type: c.top_type, top_type_count: n.top_type_count },
    shares: { top1: n.top1_share, noop: n.noop_share, effect: n.effect_share },
    fix_class: fix,
    fix_summary: 'a sentence',
    patch: fix === null ? null : 'fixture/app/src/lab/Lab.jsx',
    bail_reason: fix === null ? verdict : null,
    components: [...new Set([producer, c.top_type])],
    evidence_query: evidence,
    before_after: { before_p50_ms: n.before_p50_ms, after_p50_ms: null },
  };
}

describe('the findings checker', () => {
  const good = ['Sidebar', 'Metrics', 'Grid', 'Report', 'Dashboard'].map(entry);

  test('passes entries that match the golden data and the planted verdicts', () => {
    const { entries, problems } = checkFindings(good);
    expect(problems).toEqual([]);
    for (const e of entries) expect(e.problems, e.commit_id).toEqual([]);
  });

  test('catches a wrong verdict, a wrong number, an unknown component and broken evidence', () => {
    const bad = structuredClone(good);
    bad[0].fix_class = 'memo_boundary';
    bad[1].total_ms += 1;
    bad[2].components.push('NoSuchComponent');
    bad[3].evidence_query = 'SELECT nope FROM commits';
    bad[4].fix_class = 'rewrite_everything';
    const { entries } = checkFindings(bad);
    expect(entries[0]!.problems.join()).toMatch(/Sidebar \(#bench-large\) is stabilize_producer, not memo_boundary/);
    expect(entries[1]!.problems.join()).toMatch(/total_ms is .*evidence_query returns/);
    expect(entries[2]!.problems.join()).toMatch(/component NoSuchComponent is not in defs/);
    expect(entries[3]!.problems.join()).toMatch(/evidence_query fails/);
    expect(entries[4]!.problems.join()).toMatch(/not in the fix vocabulary/);
  });

  test('catches more than five entries, a repeated signature, and bad order', () => {
    const six = [...good, good[0]];
    expect(checkFindings(six).problems.join()).toMatch(/6 entries/);
    expect(checkFindings(six).entries[5]!.problems.join()).toMatch(/examined twice/);
    expect(checkFindings([good[1], good[0]]).entries[1]!.problems.join()).toMatch(/most expensive first/);
  });
});

// The skill's own runs on the golden session (Phase 4 acceptance), checked in.
describe.each([
  ['findings.json', 5],
  ['findings-rest.json', 2],
])('tests/golden/%s', (file, count) => {
  const path = join(repo, 'tests/golden', file);
  test.skipIf(!existsSync(path))('passes the acceptance check', () => {
    const { entries, problems } = checkFindings(JSON.parse(readFileSync(path, 'utf8')));
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(count);
    for (const e of entries) expect(e.problems, e.commit_id).toEqual([]);
  });
});
