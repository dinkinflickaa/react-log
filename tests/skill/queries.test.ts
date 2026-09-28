import { describe, expect, test } from 'vitest';
import { fill, goldenSession, parseQueries, run } from './golden.ts';

// Every query in skills/react-log/references/queries.md runs as pasted, with
// its placeholders filled, on the golden session, and returns rows.

const queries = parseQueries();

// The worst commit of a producer's signature in the golden session.
function worst(producer: string): { commit_id: string; root_update_id: string; signature: string } {
  const [row] = run(`
    SELECT c.commit_id, c.root_update_id, c.signature
    FROM commits c JOIN defs d ON d.component_id = c.producer_component_id
    WHERE d.display_name = '${producer}' ORDER BY c.total_ms DESC LIMIT 1`);
  if (row === undefined) throw new Error(`no commit produced by ${producer}`);
  return row;
}

const sidebar = worst('Sidebar');
const metrics = worst('Metrics');
const values = {
  session_id: goldenSession,
  commit_id: sidebar.commit_id,
  root_update_id: sidebar.root_update_id,
  signature: sidebar.signature,
  name: 'SidebarItem',
};
// The Sidebar commit runs no effects; Metrics' does.
const overrides: Record<string, Record<string, string>> = {
  card_effects: { ...values, commit_id: metrics.commit_id },
};

describe('references/queries.md on the golden session', () => {
  test('has the views and the queries SKILL.md names', () => {
    for (const name of ['views', 'sessions', 'top_signatures', 'top_commits', 'p95_cutoff', 'card_header', 'card_chain', 'card_self', 'card_effects', 'card_fanout', 'card_reasons', 'card_changed_keys', 'producers_noop', 'finding_numbers', 'signature_before_after', 'measure_summary']) {
      expect(queries.has(name), name).toBe(true);
    }
  });

  test.each([...queries.keys()].filter((n) => n !== 'views'))('%s runs as pasted and returns rows', (name) => {
    const rows = run(fill(queries.get(name)!, overrides[name] ?? values));
    expect(rows.length, name).toBeGreaterThan(0);
  });

  test('card_changed_keys shows why SidebarItem re-rendered', () => {
    const rows = run(fill(queries.get('card_changed_keys')!, values));
    expect(rows[0]).toMatchObject({ display_name: 'SidebarItem', changed_keys: 'onSelect:identity_only' });
  });
});
