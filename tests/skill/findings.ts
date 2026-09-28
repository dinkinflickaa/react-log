import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fill, goldenSegments, parseQueries, run } from './golden.ts';

// The Phase 4 acceptance check for a findings.json the skill wrote: its
// vocabulary, that every evidence_query re-executes to the entry's numbers,
// that every component it names exists in defs, and that each planted bug in
// the lab lands on its expected fix class or bail.
//
//   node tests/skill/findings.ts <findings.json> [segments dir]

export const FIXES = ['stabilize_producer', 'narrow_input', 'memo_boundary', 'hoist_render_work', 'effect_shape'];
export const BAILS = ['diffuse_genuine_work', 'within_budget', 'variance_too_high', 'third_party_owned', 'necessary_io_in_effect', 'design_change'];

// The lab's planted bugs (fixture/app/src/lab/Lab.jsx), by the component
// whose state change produces the commit.
export const PLANTED: Record<string, { button: string; verdict: string }> = {
  Sidebar: { button: '#bench-large', verdict: 'stabilize_producer' },
  ShellProvider: { button: '#bug-context', verdict: 'narrow_input' },
  Dashboard: { button: '#bug-memo', verdict: 'memo_boundary' },
  Report: { button: '#bug-hoist', verdict: 'hoist_render_work' },
  Metrics: { button: '#bug-effect', verdict: 'effect_shape' },
  Grid: { button: '#bug-diffuse', verdict: 'diffuse_genuine_work' },
  Toggle: { button: '#bug-budget', verdict: 'within_budget' },
};

// evidence_query columns and where each number sits in an entry.
const NUMBERS: [column: string, path: string[]][] = [
  ['total_ms', ['total_ms']],
  ['rendered', ['extent', 'rendered']],
  ['committed', ['extent', 'committed']],
  ['noop', ['extent', 'noop']],
  ['top_type_count', ['extent', 'top_type_count']],
  ['top1_share', ['shares', 'top1']],
  ['noop_share', ['shares', 'noop']],
  ['effect_share', ['shares', 'effect']],
  ['before_p50_ms', ['before_after', 'before_p50_ms']],
];

const at = (o: any, path: string[]) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
const same = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

export interface Checked {
  commit_id: string;
  producer: string | null;
  verdict: string | null;
  problems: string[];
}

export function checkFindings(findings: unknown, segments = goldenSegments): { entries: Checked[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(findings)) return { entries: [], problems: ['findings.json is not a JSON array'] };
  if (findings.length === 0 || findings.length > 5) problems.push(`${findings.length} entries; the skill examines one to five`);
  const queries = parseQueries();
  const names = new Set(run<{ display_name: string }>('SELECT DISTINCT display_name FROM defs', segments).map((r) => r.display_name));
  const signatures = new Set<string>();
  let lastTotal = Infinity;
  const entries = findings.map((f: any): Checked => {
    const p: string[] = [];
    const id = typeof f?.commit_id === 'string' ? f.commit_id : '';
    const [commit] = run(
      `SELECT c.*, d.display_name AS producer, m.name AS measure_name
       FROM commits c LEFT JOIN defs d ON d.component_id = c.producer_component_id
       LEFT JOIN measures m ON m.measure_instance_id = c.measure_instance_id
       WHERE c.commit_id = '${id.replace(/'/g, "''")}'`,
      segments,
    );
    if (commit === undefined) return { commit_id: id, producer: null, verdict: null, problems: [`no commit ${JSON.stringify(f?.commit_id)}`] };
    // Shape and vocabulary.
    if (f.signature !== commit.signature) p.push(`signature ${f.signature} is not the commit's (${commit.signature})`);
    if (signatures.has(commit.signature)) p.push(`signature ${commit.signature} examined twice`);
    signatures.add(commit.signature);
    if (commit.total_ms > lastTotal + 1e-9) p.push('entries are not ordered most expensive first');
    lastTotal = commit.total_ms;
    if ((f.measure ?? null) !== (commit.measure_name ?? null)) p.push(`measure ${f.measure} is not the commit's (${commit.measure_name})`);
    if ((f.on_critical_path ?? null) !== (commit.on_critical_path ?? null)) p.push(`on_critical_path ${f.on_critical_path} is not the commit's (${commit.on_critical_path})`);
    const fix = f.fix_class ?? null;
    const bail = f.bail_reason ?? null;
    if ((fix === null) === (bail === null)) p.push('needs exactly one of fix_class and bail_reason');
    if (fix !== null && !FIXES.includes(fix)) p.push(`fix_class ${fix} is not in the fix vocabulary`);
    if (bail !== null && !BAILS.includes(bail)) p.push(`bail_reason ${bail} is not in the bail vocabulary`);
    if (fix !== null && (typeof f.patch !== 'string' || f.patch === '')) p.push('a fix names the file it patches');
    if (bail !== null && f.patch != null) p.push('a bail patches nothing');
    if (typeof f.fix_summary !== 'string' || f.fix_summary.trim() === '') p.push('fix_summary is empty');
    if ((f.cause?.producer ?? null) !== (commit.producer ?? null)) p.push(`cause.producer ${f.cause?.producer} is not the commit's (${commit.producer})`);
    if ((f.cause?.cascade ?? null) !== (commit.cascade_commit_id !== null)) p.push('cause.cascade does not match the commit');
    // Every evidence_query re-executes to the same numbers, and they are the commit's.
    const expected = run(fill(queries.get('finding_numbers')!, { commit_id: commit.commit_id }), segments)[0];
    let evidence: any[] = [];
    try {
      evidence = typeof f.evidence_query === 'string' ? run(f.evidence_query, segments) : [];
    } catch (e) {
      p.push(`evidence_query fails: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split('\n')[0]}`);
    }
    if (evidence.length !== 1) p.push(`evidence_query returns ${evidence.length} rows, not one`);
    for (const [column, path] of NUMBERS) {
      const value = at(f, path);
      if (evidence.length === 1 && !(column in evidence[0])) p.push(`evidence_query has no ${column}`);
      else if (evidence.length === 1 && !same(evidence[0][column], value)) p.push(`${path.join('.')} is ${value}; evidence_query returns ${evidence[0][column]}`);
      if (!same(expected[column], value)) p.push(`${path.join('.')} is ${value}; the commit's is ${expected[column]}`);
    }
    // Every component named exists in defs.
    const named: string[] = Array.isArray(f.components) ? f.components : [];
    if (named.length === 0) p.push('components is empty');
    for (const n of named) if (!names.has(n)) p.push(`component ${n} is not in defs`);
    for (const n of [f.cause?.producer, f.extent?.top_type]) if (typeof n === 'string' && !named.includes(n)) p.push(`${n} is named but not in components`);
    // Each planted bug lands on its expected verdict.
    const planted = commit.producer === null ? undefined : PLANTED[commit.producer];
    const verdict = fix ?? bail;
    if (planted !== undefined && verdict !== planted.verdict) p.push(`${commit.producer} (${planted.button}) is ${planted.verdict}, not ${verdict}`);
    return { commit_id: commit.commit_id, producer: commit.producer, verdict, problems: p };
  });
  return { entries, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error('usage: node tests/skill/findings.ts <findings.json> [segments dir]');
    process.exit(2);
  }
  const { entries, problems } = checkFindings(JSON.parse(readFileSync(file, 'utf8')), process.argv[3] ?? goldenSegments);
  for (const e of entries) {
    console.log(`${e.commit_id}  ${String(e.producer).padEnd(14)} ${String(e.verdict).padEnd(22)} ${e.problems.length === 0 ? 'ok' : `FAIL: ${e.problems.join('; ')}`}`);
  }
  for (const p of problems) console.log(`FAIL: ${p}`);
  const failed = problems.length + entries.filter((e) => e.problems.length > 0).length;
  console.log(`${entries.length} findings, ${failed} failing: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failed === 0 ? 0 : 1);
}
