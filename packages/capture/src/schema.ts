// Pinned Parquet schemas, one per file family. Every segment of a family has
// exactly these columns and types, so read_parquet over a glob unions them.

export type Family = 'seg' | 'defs' | 'commits' | 'measures';

export const SCHEMAS: Record<Family, [name: string, type: string][]> = {
  seg: [
    ['session_id', 'VARCHAR'],
    ['page_load_id', 'INTEGER'],
    ['ts', 'BIGINT'], // µs since the Unix epoch
    ['dur_us', 'BIGINT'],
    ['self_us', 'BIGINT'],
    ['kind', 'VARCHAR'],
    ['lane', 'VARCHAR'],
    ['component_id', 'VARCHAR'],
    ['commit_id', 'VARCHAR'],
    ['reason_code', 'VARCHAR'],
    ['changed_hooks', 'VARCHAR'],
    ['changed_context', 'VARCHAR'],
    ['changed_keys', 'VARCHAR'],
    ['committed', 'BOOLEAN'],
    ['root_update_id', 'VARCHAR'],
    ['measure_instance_id', 'VARCHAR'],
    ['on_critical_path', 'BOOLEAN'],
    ['call_site', 'VARCHAR'],
    ['extra', 'JSON'],
  ],
  defs: [
    ['component_id', 'VARCHAR'],
    ['display_name', 'VARCHAR'],
    ['source_file', 'VARCHAR'],
    ['source_line', 'INTEGER'],
    ['source_column', 'INTEGER'],
    ['owner_path', 'VARCHAR'],
  ],
  commits: [
    ['commit_id', 'VARCHAR'],
    ['session_id', 'VARCHAR'],
    ['ts', 'BIGINT'],
    ['measure_instance_id', 'VARCHAR'],
    ['on_critical_path', 'BOOLEAN'],
    ['signature', 'VARCHAR'],
    ['root_update_id', 'VARCHAR'],
    ['producer_component_id', 'VARCHAR'],
    ['producer_call_site', 'VARCHAR'],
    ['trigger_event', 'VARCHAR'],
    ['lane', 'VARCHAR'],
    ['total_ms', 'DOUBLE'],
    ['render_ms', 'DOUBLE'],
    ['layout_ms', 'DOUBLE'],
    ['passive_ms', 'DOUBLE'],
    ['passive_sync', 'BOOLEAN'],
    ['strict_mode', 'BOOLEAN'],
    ['cascade_commit_id', 'VARCHAR'],
    ['rendered', 'INTEGER'],
    ['committed', 'INTEGER'],
    ['noop', 'INTEGER'],
    ['noop_ms', 'DOUBLE'],
    ['distinct_types', 'INTEGER'],
    ['top_type', 'VARCHAR'],
    ['top_type_count', 'INTEGER'],
    ['top1_component_id', 'VARCHAR'],
    ['top1_share', 'DOUBLE'],
    ['noop_share', 'DOUBLE'],
    ['effect_share', 'DOUBLE'],
  ],
  measures: [
    ['measure_instance_id', 'VARCHAR'],
    ['session_id', 'VARCHAR'],
    ['page_load_id', 'INTEGER'],
    ['name', 'VARCHAR'],
    ['source', 'VARCHAR'],
    ['interaction_id', 'BIGINT'],
    ['target', 'VARCHAR'],
    ['ts_start', 'BIGINT'],
    ['ts_end_marker', 'BIGINT'],
    ['ts_end_paint', 'BIGINT'],
    ['ts_end_idle', 'BIGINT'],
    // [ts_start, ts_end_paint] (Event Timing) or [ts_start, ts_end_marker]
    // (marks), split three ways: on-path work, interference, waiting.
    ['duration_ms', 'DOUBLE'],
    ['on_path_ms', 'DOUBLE'],
    ['interference_ms', 'DOUBLE'],
    ['waiting_ms', 'DOUBLE'],
  ],
};

export const FAMILIES = Object.keys(SCHEMAS) as Family[];

export function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// DuckDB struct literal for read_json's columns parameter.
export function columnsLiteral(family: Family): string {
  return `{${SCHEMAS[family].map(([n, t]) => `${n}: ${sqlString(t)}`).join(', ')}}`;
}

// A zero-row SELECT with the family's columns, for empty files.
export function emptySelect(family: Family): string {
  return `SELECT ${SCHEMAS[family].map(([n, t]) => `NULL::${t} AS ${n}`).join(', ')} LIMIT 0`;
}
