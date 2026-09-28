import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duckdbPath } from '../../packages/capture/src/capture.ts';

// The golden session (tests/golden/record.ts) and the skill's query file, for
// the skill's tests and the findings checker.

export const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const goldenSegments = join(repo, 'tests/golden/segments');
export const goldenSession = readdirSync(goldenSegments).find((d) => !d.startsWith('.'))!;
export const duckdb = duckdbPath();

// "## name" headings, each followed by one ```sql block.
export function parseQueries(md = readFileSync(join(repo, 'skills/react-log/references/queries.md'), 'utf8')): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^## (\S+)\n[\s\S]*?```sql\n([\s\S]*?)```/gm;
  for (let m = re.exec(md); m !== null; m = re.exec(md)) out.set(m[1]!, m[2]!.trim());
  return out;
}

// The views block, pointed at a segments directory.
export function viewsFor(segments: string, queries = parseQueries()): string {
  return queries.get('views')!.replaceAll("'segments/", `'${segments}/`);
}

export function run<T = any>(sql: string, segments = goldenSegments): T[] {
  const out = execFileSync(duckdb, ['-json', ':memory:', '-c', `${viewsFor(segments)}\n${sql}`], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
  return out === '' ? [] : JSON.parse(out);
}

// Placeholders filled with real ids from the golden session.
export function fill(sql: string, values: Record<string, string>): string {
  return sql.replace(/<(\w+)>/g, (whole, name: string) => {
    if (!(name in values)) throw new Error(`no value for placeholder ${whole}`);
    return values[name]!.replace(/'/g, "''");
  });
}
