# react-log queries

Load the views first in every DuckDB session, then run queries by name. Replace each placeholder in angle brackets, quotes kept. Column names match the data model in PLAN.md. Times are epoch microseconds (`ts`, `ts_start`, ...) or milliseconds (`*_ms`).

`react-log query "<sql>"` loads these views itself (`--segments <dir>` if the directory is not `./segments`, `--session <id>` to read one session only), so with the CLI you can skip `views`.

## views

The segments directory is `segments/` here. Replace it everywhere in this block if it is elsewhere (for example `tests/golden/segments/`).

Sessions captured before a column was added read it as null (`memo` is the newest).

```sql
CREATE OR REPLACE VIEW events AS
  SELECT * FROM read_parquet('segments/*/seg-*.parquet', union_by_name = true);
CREATE OR REPLACE VIEW defs AS
  SELECT component_id, any_value(display_name) AS display_name, any_value(source_file) AS source_file,
         any_value(source_line) AS source_line, any_value(owner_path) AS owner_path, any_value(memo) AS memo
  FROM (SELECT NULL::BOOLEAN AS memo WHERE false
        UNION ALL BY NAME
        SELECT * FROM read_parquet('segments/*/defs-*.parquet', union_by_name = true))
  GROUP BY component_id;
CREATE OR REPLACE VIEW commits AS
  SELECT * FROM read_parquet('segments/*/commits-*.parquet', union_by_name = true);
CREATE OR REPLACE VIEW measures AS
  SELECT * FROM read_parquet('segments/*/measures-*.parquet', union_by_name = true);
```

## sessions

```sql
SELECT session_id, to_timestamp(min(ts) / 1e6) AS started, to_timestamp(max(ts) / 1e6) AS ended,
       count(DISTINCT page_load_id) AS page_loads, count(*) AS events
FROM events
GROUP BY session_id
ORDER BY started DESC;
```

## top_signatures

One row per kind of commit (signature), most expensive first: how often it happened, its median and worst cost, its worst instance, and whether it was on an interaction's critical path. Examine a signature through its `worst_commit`.

```sql
SELECT c.signature, count(*) AS commits,
       round(median(c.total_ms), 1) AS p50_ms, round(max(c.total_ms), 1) AS max_ms,
       arg_max(c.commit_id, c.total_ms) AS worst_commit,
       bool_or(coalesce(c.on_critical_path, false)) AS on_critical_path,
       any_value(m.name) AS measure, any_value(d.display_name) AS producer,
       any_value(c.trigger_event) AS trigger_event, any_value(c.top_type) AS top_type
FROM commits c
LEFT JOIN defs d ON d.component_id = c.producer_component_id
LEFT JOIN measures m ON m.measure_instance_id = c.measure_instance_id
WHERE c.session_id = '<session_id>'
GROUP BY c.signature
ORDER BY max_ms DESC
LIMIT 20;
```

## top_commits

```sql
SELECT c.commit_id, c.signature, m.name AS measure, c.on_critical_path,
       round(c.total_ms, 1) AS total_ms, round(c.render_ms, 1) AS render_ms,
       round(c.layout_ms, 1) AS layout_ms, round(c.passive_ms, 1) AS passive_ms, c.passive_sync,
       d.display_name AS producer, c.trigger_event,
       c.rendered, c.committed, c.noop, c.top_type, c.top_type_count,
       round(c.top1_share, 2) AS top1_share, round(c.noop_share, 2) AS noop_share,
       round(c.effect_share, 2) AS effect_share
FROM commits c
LEFT JOIN defs d ON d.component_id = c.producer_component_id
LEFT JOIN measures m ON m.measure_instance_id = c.measure_instance_id
WHERE c.session_id = '<session_id>'
ORDER BY c.total_ms DESC
LIMIT 20;
```

## p95_cutoff

```sql
SELECT round(quantile_cont(total_ms, 0.95), 1) AS p95_ms
FROM commits
WHERE session_id = '<session_id>';
```

## measure_summary

Interactions (Event Timing) and configured mark pairs. `duration_ms` splits into on-path work (the chains the input started), interference (other work in the window) and waiting (neither: input delay, style, layout, paint).

```sql
SELECT name, count(*) AS instances,
       round(median(duration_ms), 1) AS p50_ms, round(quantile_cont(duration_ms, 0.9), 1) AS p90_ms,
       round(median(on_path_ms), 1) AS on_path_p50_ms, round(median(interference_ms), 1) AS interference_p50_ms,
       round(median(waiting_ms), 1) AS waiting_p50_ms
FROM measures
WHERE session_id = '<session_id>'
GROUP BY name
ORDER BY p50_ms DESC;
```

## card_header

```sql
SELECT c.*, d.display_name AS producer_name, t.display_name AS top1_name,
       m.name AS measure_name, m.target AS measure_target, round(m.duration_ms, 1) AS measure_ms
FROM commits c
LEFT JOIN defs d ON d.component_id = c.producer_component_id
LEFT JOIN defs t ON t.component_id = c.top1_component_id
LEFT JOIN measures m ON m.measure_instance_id = c.measure_instance_id
WHERE c.commit_id = '<commit_id>';
```

## card_chain

The updates and commits of one chain, from `card_header.root_update_id`. A commit with `cascade_commit_id` set came from an update that an effect of that commit enqueued.

```sql
SELECT to_timestamp(e.ts / 1e6) AS at, e.kind, e.commit_id,
       coalesce(d.display_name, e.extra->>'component') AS component,
       e.extra->>'event' AS event, e.extra->>'phase' AS phase, e.call_site
FROM events e
LEFT JOIN defs d USING (component_id)
WHERE e.root_update_id = '<root_update_id>' AND e.kind IN ('update_enqueued', 'commit')
ORDER BY e.ts
LIMIT 40;
```

## card_self

`memo` is true for a component in React.memo or a PureComponent, which React skips when its props are equal.

```sql
SELECT d.display_name, d.source_file, d.source_line, bool_or(d.memo) AS memo,
       count(*) AS renders,
       count(*) FILTER (e.committed) AS committed,
       round(sum(e.self_us) / 1000.0, 2) AS self_ms,
       mode(e.reason_code) AS reason,
       mode(coalesce(e.changed_keys, e.changed_hooks, e.changed_context)) AS changed
FROM events e
JOIN defs d USING (component_id)
WHERE e.commit_id = '<commit_id>' AND e.kind = 'render'
GROUP BY 1, 2, 3
ORDER BY self_ms DESC
LIMIT 5;
```

## card_effects

```sql
SELECT e.kind, d.display_name, d.source_file, d.source_line,
       count(*) AS runs, round(sum(e.dur_us) / 1000.0, 2) AS ms
FROM events e
JOIN defs d USING (component_id)
WHERE e.commit_id = '<commit_id>' AND e.kind IN ('layout_effect', 'passive_effect')
GROUP BY 1, 2, 3, 4
ORDER BY ms DESC
LIMIT 5;
```

## card_fanout

```sql
SELECT d.display_name, count(*) AS renders,
       count(*) FILTER (NOT e.committed) AS noop_renders,
       round(sum(CASE WHEN e.committed THEN 0 ELSE e.self_us END) / 1000.0, 2) AS noop_ms,
       mode(e.reason_code) AS reason
FROM events e
JOIN defs d USING (component_id)
WHERE e.commit_id = '<commit_id>' AND e.kind = 'render'
GROUP BY 1
ORDER BY renders DESC
LIMIT 5;
```

## card_reasons

Why each component in this commit rendered. `reason_code` is mount, retry, force, context, hooks, state, props, parent or unknown. `changed_hooks` (hook index and type) and `changed_context` are filled whenever they apply; `changed_keys` only for watched components.

```sql
SELECT d.display_name, e.reason_code, e.changed_hooks, e.changed_context, e.changed_keys,
       count(*) AS renders
FROM events e
JOIN defs d USING (component_id)
WHERE e.commit_id = '<commit_id>' AND e.kind = 'render'
GROUP BY 1, 2, 3, 4, 5
ORDER BY renders DESC
LIMIT 15;
```

## card_changed_keys

Only for components that were on the watch list during capture. Each entry is `prop:how`: `identity_only` (a new object or function equal in value, the usual cause of a wasted render) or `value`.

```sql
SELECT d.display_name, e.changed_keys, count(*) AS renders
FROM events e
JOIN defs d USING (component_id)
WHERE e.commit_id = '<commit_id>' AND e.kind = 'render' AND e.changed_keys IS NOT NULL
GROUP BY 1, 2
ORDER BY renders DESC
LIMIT 10;
```

## component_renders

Where one component sits and why it renders, across the session: its definition, and its renders by reason.

```sql
SELECT d.display_name, d.source_file, d.source_line, d.owner_path, d.memo, e.reason_code,
       count(*) AS renders, count(*) FILTER (e.committed) AS committed,
       round(sum(e.self_us) / 1000.0, 2) AS self_ms
FROM events e
JOIN defs d USING (component_id)
WHERE e.session_id = '<session_id>' AND e.kind = 'render' AND d.display_name = '<name>'
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY renders DESC
LIMIT 10;
```

## producers_noop

Which producers cause the most no-op fan-out across the session.

```sql
SELECT c.producer_component_id, d.display_name, c.producer_call_site,
       count(*) AS commits,
       round(sum(c.noop_ms), 1) AS noop_ms,
       round(sum(c.total_ms), 1) AS total_ms
FROM commits c
LEFT JOIN defs d ON d.component_id = c.producer_component_id
WHERE c.session_id = '<session_id>'
GROUP BY 1, 2, 3
ORDER BY noop_ms DESC
LIMIT 5;
```

## finding_numbers

The evidence query for a finding: every number in the finding, from the commit and its signature. Paste it into `evidence_query` with the commit id filled in.

```sql
SELECT round(c.total_ms, 1) AS total_ms, c.rendered, c.committed, c.noop, c.top_type_count,
       round(c.top1_share, 2) AS top1_share, round(c.noop_share, 2) AS noop_share,
       round(c.effect_share, 2) AS effect_share,
       (SELECT round(median(s.total_ms), 1) FROM commits s
        WHERE s.signature = c.signature AND s.session_id = c.session_id) AS before_p50_ms
FROM commits c
WHERE c.commit_id = '<commit_id>';
```

## signature_before_after

Same kind of commit across sessions. Run after a fix and a re-capture of the same interaction.

```sql
SELECT session_id, count(*) AS commits,
       round(quantile_cont(total_ms, 0.5), 1) AS p50_ms,
       round(quantile_cont(total_ms, 0.9), 1) AS p90_ms
FROM commits
WHERE signature = '<signature>'
GROUP BY session_id
ORDER BY session_id;
```
