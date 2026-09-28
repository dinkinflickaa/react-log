# react-log queries

Run the views first in every DuckDB session. Placeholders in angle brackets get substituted. Column names match the data model in PLAN.md.

## views

```sql
CREATE OR REPLACE VIEW events AS
  SELECT * FROM read_parquet('segments/*/seg-*.parquet');
CREATE OR REPLACE VIEW defs AS
  SELECT DISTINCT component_id, display_name, source_file, source_line, owner_path
  FROM read_parquet('segments/*/defs-*.parquet');
CREATE OR REPLACE VIEW commits AS
  SELECT * FROM read_parquet('segments/*/commits-*.parquet');
CREATE OR REPLACE VIEW measures AS
  SELECT * FROM read_parquet('segments/*/measures-*.parquet');
```

## sessions

```sql
SELECT session_id, min(ts) AS started, max(ts) AS ended, count(*) AS events
FROM events
GROUP BY session_id
ORDER BY started DESC;
```

## top_commits

```sql
SELECT commit_id, ts, signature, on_critical_path,
       round(total_ms, 1) AS total_ms, round(render_ms, 1) AS render_ms,
       round(layout_ms, 1) AS layout_ms, round(passive_ms, 1) AS passive_ms, passive_sync,
       rendered, committed, noop, top_type, top_type_count,
       round(top1_share, 2) AS top1_share, round(noop_share, 2) AS noop_share,
       round(effect_share, 2) AS effect_share
FROM commits
WHERE session_id = '<session_id>'
ORDER BY total_ms DESC
LIMIT 20;
```

## p95_cutoff

```sql
SELECT round(quantile_cont(total_ms, 0.95), 1) AS p95_ms
FROM commits
WHERE session_id = '<session_id>';
```

## card_header

```sql
SELECT c.*, d.display_name AS producer_name
FROM commits c
LEFT JOIN defs d ON d.component_id = c.producer_component_id
WHERE c.commit_id = '<commit_id>';
```

## card_chain

```sql
SELECT e.ts, e.kind, d.display_name, e.reason_code, e.lane, e.call_site,
       round(e.dur_us / 1000.0, 2) AS ms
FROM events e
LEFT JOIN defs d USING (component_id)
WHERE e.root_update_id = '<root_update_id>'
ORDER BY e.ts
LIMIT 60;
```

## card_self

```sql
SELECT d.display_name, d.source_file, d.source_line,
       count(*) AS renders,
       sum(CASE WHEN e.committed THEN 1 ELSE 0 END) AS committed,
       round(sum(e.self_us) / 1000.0, 2) AS self_ms,
       mode(e.reason_code) AS reason
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
       sum(CASE WHEN e.committed THEN 0 ELSE 1 END) AS noop_renders,
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

Why each component in this commit rendered. `changed_hooks` and `changed_context` are always populated. `changed_keys` needs a watch.

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

Only populated for components that were on the watch list during capture.

```sql
SELECT d.display_name, e.changed_keys, count(*) AS renders
FROM events e
JOIN defs d USING (component_id)
WHERE e.commit_id = '<commit_id>' AND e.kind = 'render' AND e.changed_keys IS NOT NULL
GROUP BY 1, 2
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

## signature_before_after

Same kind of commit across two sessions. Run after a fix and a re-capture.

```sql
SELECT session_id, count(*) AS commits,
       round(quantile_cont(total_ms, 0.5), 1) AS p50_ms,
       round(quantile_cont(total_ms, 0.9), 1) AS p90_ms
FROM commits
WHERE signature = '<signature>'
GROUP BY session_id
ORDER BY session_id;
```

## measure_summary

Only when measures are configured.

```sql
SELECT name, count(*) AS instances,
       round(quantile_cont((ts_end_marker - ts_start) / 1000.0, 0.5), 1) AS p50_ms,
       round(quantile_cont((ts_end_marker - ts_start) / 1000.0, 0.9), 1) AS p90_ms
FROM measures
WHERE session_id = '<session_id>'
GROUP BY name
ORDER BY p50_ms DESC;
```
