# react-log, single-file plan

Save this file as `PLAN.md` at the root of a new repo. It contains the plan, the Claude Code skill, and the skill's queries. Two blocks at the end are files; the marker lines `===== FILE: <path> =====` and `===== END FILE =====` delimit them. Writing those two files to their paths is the first step of Phase 0.


Two deliverables. A capture program that attaches to Chrome over CDP and continuously writes a React render event log to Parquet, and a Claude Code skill that queries that log with DuckDB, finds expensive commits, explains them, and either proposes and applies a fix or bails with a named reason.

Not in v1. No A/B framework, no baseline service, no eval fixture, no production builds. Targets React 18 and 19 development and profiling builds.

## Success criteria

1. `react-log capture` runs until stopped against any React 18 or 19 dev app through CDP, with React DevTools open in the same page, segments stay queryable while it runs, and process memory stays flat however long it runs.
2. Overhead on one chosen interaction is under 3 ms at p50, measured with the shim on and off over 20 runs of the same script.
3. `react-log card <commit_id>` answers in under one second at five million rows.
4. The skill, given a session, produces `findings.json` for the top five expensive commits, each with a fix or a bail, and every evidence query re-executes to the same numbers.
5. One fix from the skill lands in a PR with before and after cost for the same commit signature, captured on the same interaction.

## Repo layout

```
packages/shim        browser IIFE injected before any page script
packages/capture     CDP client, ingest, chain linker, rollups, segment writer
packages/cli         react-log binary (capture, watch, sessions, top, card, query)
skills/react-log/    SKILL.md and references/queries.md (drafted, see skills/)
tests/               vitest, React 18 and 19 fixtures
segments/            output, gitignored
```

## Data model

Parquet per session under `segments/<session_id>/`. File families are `seg-*.parquet` (events), `defs-*.parquet`, `commits-*.parquet`, `measures-*.parquet`, plus `session.json`. Strings only in defs.

```
events(session_id, page_load_id, ts, dur_us, self_us, kind, lane, component_id,
       commit_id, reason_code, changed_hooks, changed_context, changed_keys, committed,
       root_update_id, measure_instance_id, on_critical_path, call_site)

defs(component_id, display_name, source_file, source_line, owner_path)

measures(measure_instance_id, session_id, name, ts_start,
         ts_end_marker, ts_end_paint, ts_end_idle)

commits(commit_id, session_id, ts, measure_instance_id, on_critical_path, signature,
        root_update_id, producer_component_id, producer_call_site, trigger_event, lane,
        total_ms, render_ms, layout_ms, passive_ms, passive_sync, cascade_commit_id,
        rendered, committed, noop, noop_ms, distinct_types, top_type, top_type_count,
        top1_component_id, top1_share, noop_share, effect_share)
```

Event kinds. update_enqueued, render, bailout_count, commit, layout_effect, passive_effect, suspend, yield, mark, measure, loaf, event_timing, watch, dropped.

Definitions.

1. `component_id` is a stable hash of the owner path of display names, the keys along that path, and the source file and line, so it survives reloads.
2. `self_us` for a render is its own interval minus nested child render intervals.
3. `committed` is true when `flags | subtreeFlags` on the rendered fiber has any bit in the mutation, layout or passive masks at commit start.
4. `reason_code` is one of parent, props, state, context, hooks, mount, retry, force, from a shallow key compare against the alternate at render start. `changed_hooks` lists the hook indices whose memoizedState changed, each with its type from `_debugHookTypes` (for example `2:useState`, `6:useSyncExternalStore`). `changed_context` names the context whose value changed, from its displayName. Both are always on, since the check is Object.is against the alternate, the same check DevTools runs for why-did-this-render. `changed_keys` lists changed prop keys with identity_only or value per key and is filled only for watched components, since value comparison costs.
5. `root_update_id` links update_enqueued, the renders and commit it produced, the effects that ran, and any update those effects enqueued. `on_critical_path` is true when an event is reachable from the measure's trigger and precedes the measure's end. `signature` is a hash of trigger_event, producer_call_site and top_type.

## Config

```json
{
  "cdp": "http://localhost:9222",
  "urlMatch": "localhost:3000",
  "measures": [{ "name": "route_switch", "start": "route_switch:start", "end": "route_switch:end" }],
  "record": { "compositeOnly": true, "values": false, "stacksOn": ["update"], "watch": [] },
  "segments": { "dir": "./segments", "rotateSeconds": 10, "rotateRows": 200000 }
}
```

## Phase 0. Scaffold (half day)

0. Write the two embedded FILE blocks at the end of this document to their paths, byte for byte, then delete nothing else.
1. pnpm workspace, TypeScript, esbuild for the shim IIFE, vitest, and the `duckdb` CLI as a documented dependency.
2. `react-log.config.json` as above.
3. Acceptance. `pnpm test` runs an empty suite and `react-log --help` prints the six commands.

## Phase 1. Shim (3 days)

1. Install `__REACT_DEVTOOLS_GLOBAL_HOOK__` if absent. If present (DevTools extension), wrap it. Wrap `inject` to capture renderer internals, install a multiplexing set of profiling hooks, and wrap `injectProfilingHooks` so DevTools registers as a second listener instead of replacing the shim. Both keep working.
2. From the profiling hooks record render start and stop per component with `self_us`, layout and passive effect start and stop per component, update_enqueued with lane and a `call_site` from a capped stack (`_debugSource` on 18, owner stack on 19), suspend, yield, commit start and stop. Composite fibers only. Bailouts counted per commit.
3. At commit start, for every fiber rendered in this commit, set `committed` from `flags | subtreeFlags`. Compute `reason_code` by shallow key compare against the alternate, `changed_hooks` by walking the hook list on `memoizedState` against the alternate's and pairing indices with `_debugHookTypes`, and `changed_context` by walking `dependencies.firstContext` and comparing each `memoizedValue` with the context's current value. For components listed on `window.__reactLogWatch`, also compare prop values and emit `changed_keys`.
4. A PerformanceObserver forwards mark, measure, long-animation-frame and event entries into the same buffer.
5. Ring buffer of 50k flat arrays, flushed every 250 ms through `window.__reactLogSink(json)` when present, else POST to a configured localhost port. On overflow drop the incoming event and count it as a dropped row.

Acceptance. vitest with jsdom renders a ten-component tree on React 18 and on React 19 and asserts the exact event sequence, `self_us` nesting, `committed` values and reason codes. A manual run in a real app with DevTools open shows both the DevTools profiler and the shim receiving events.

## Phase 2. Capture program (3 days)

1. `react-log capture` connects to the CDP endpoint from config or `--cdp`, picks the target by `--url-match`, or launches Chrome with `--launch <url>`.
2. `Page.addScriptToEvaluateOnNewDocument` with the shim bundle, `Runtime.addBinding` for `__reactLogSink`, and `--reload` to reinstall on an already loaded page. Each target is its own session.
3. Ingest converts timestamps with `timeOrigin`, assigns `page_load_id` and `session_id`, writes `session.json` (start, app url, React version, config, git SHA when available), and appends NDJSON to a temp file.
4. Rotate every 10 seconds or 200k rows. Convert with the DuckDB CLI (`COPY (SELECT * FROM read_json_auto('tmp')) TO 'seg-00001.parquet'`), then rename into place. Same for defs, commits and measures files.
5. `react-log watch <name|id>` sends `Runtime.evaluate` to update `window.__reactLogWatch` and records a watch event.

Acceptance. A capture left running for at least an hour against a dev app (the program has no duration limit) keeps `SELECT count(*) FROM read_parquet('segments/*/seg-*.parquet')` growing, holds process memory flat, has no dropped rows during normal use, and shows overhead under 3 ms p50 on the configured interaction across 20 runs with the shim on and off.

## Phase 3. Rollups at ingest (3 days)

1. Chain linker assigns `root_update_id`. Batches arrive in order per page, so the linker keeps only open chains in memory.
2. Measures come from the configured mark pairs. Stamp `measure_instance_id` by overlap, `on_critical_path` by reachability, and fill the three end columns.
3. Commits rollup with totals, fan-out, producer, signature, cascade link and the three shares, written as `commits-*.parquet`.
4. `react-log sessions`, `react-log top --session S [--measure M]`, `react-log card <commit_id>`, `react-log query "<sql>"`. Card prints the header row, top five self cost, effects, and the cause chain as text, under 60 lines.
5. Acceptance. For any measure instance, on-path self time plus waiting plus interference reconciles to the measure duration within 5 percent, as a test that runs on every recorded session. Card answers under one second at five million rows.

## Phase 4. Skill (2 days)

1. `skills/react-log/SKILL.md` and `references/queries.md` are drafted. Wire them to the real schema and column names once Phase 3 lands, and keep every query in the reference file runnable as pasted.
2. Add `react-log card` text output as the canonical shape the skill reads.
3. Acceptance. Run Claude Code with the skill on one recorded session. It must produce `findings.json` for five commits, every `evidence_query` must re-execute to the same numbers, and every component named must exist in defs.

## Phase 5. Closed loop on a real app (2 days)

1. Capture the app during normal use until the configured interaction has at least 20 instances.
2. Run the skill. Take the top finding that has a fix.
3. Apply the fix, re-capture 20 runs of the same interaction, and compare `total_ms` for the same signature before and after.
4. Open a PR with the card, the chain, and both numbers. Bail findings go in the PR description as examined and skipped, with reasons.
5. Acceptance. One merged PR.

## Tests

1. Shim event sequence on React 18 and 19 under jsdom.
2. Linker on synthetic sequences, including an effect that enqueues an update.
3. Segment writer never exposes a partial file, and dropped rows are counted.
4. Rollup reconciliation on a recorded session.
5. Skill golden run. Queries re-execute, schema validates.

## Later, not in this plan

1. Baseline store and history gates (same signature last week).
2. CDP trace join for style, layout and paint per commit.
3. Concurrency model for concurrent roots.
4. Production path with sampling and build-time names.
5. React Compiler diagnostics on flagged components.

## Kickoff prompt for Claude Code

```
Read PLAN.md, phase N. Implement only that phase. Acceptance is the test named in the phase; run it and paste the raw result. Do not touch other phases. React 18 and 19 dev and profiling builds only. Ask before adding any dependency not named in the plan.
```

## Embedded files

===== FILE: skills/react-log/SKILL.md =====
---
name: react-log
description: Analyze react-log capture sessions (Parquet segments under ./segments) with DuckDB to find the most expensive React commits, explain each one (cause, extent, self cost, effect cost), and either propose and apply a code fix or bail with a named reason. Use this whenever the user mentions react-log, segments, a capture session, expensive commits, render cost, re-renders, effect cost, or asks why an interaction in a React app is slow when a capture exists or can be taken.
---

# react-log

## What you need

1. `duckdb` CLI on PATH.
2. A segments directory (default `./segments`) with at least one session.
3. Optionally the `react-log` CLI for `capture`, `watch`, `sessions`, `top`, `card`, `query`. Everything below also works with plain SQL from `references/queries.md`.

Start every DuckDB session by loading the views at the top of `references/queries.md`, then run queries by name from that file, substituting the placeholders.

## Method, in this order

1. Pick the session. Run `sessions`. Use the newest unless told otherwise.
2. Rank commits. Run `top_commits` and `p95_cutoff`. A commit is worth examining if `total_ms` is above 8 ms on the critical path, above 16 ms anywhere, or above the session's p95. Take at most five.
3. Build the card for each commit. Run `card_header`, `card_chain`, `card_self`, `card_effects`, `card_fanout`, `card_reasons`. Answer the five questions and write them down before deciding anything. Cause (root update, producer, call site, trigger, lane, cascade, and for the top components which hook or context changed). Extent (rendered, committed, noop, distinct types, top type and its count). Self cost (top five, top1_share). Effects (layout and passive totals, top instance, passive_sync). Concentration (top1_share, noop_share, effect_share).
4. Decide with the table below. The dominant share names the fix class. If the verdict depends on whether props changed by identity only or by value, do not guess. Run `react-log watch <name>`, ask the user for one more capture of the same interaction, then run `card_changed_keys`.
5. Act. For a fix class, write the smallest patch in the fix vocabulary, apply it, ask for a re-capture of the same interaction, and run `signature_before_after`. Report both numbers. For a bail, write the reason and the evidence and stop.

## Decision table

| Dominant share | Fix class | What the patch usually is |
| --- | --- | --- |
| top1_share | hoist_render_work | move computation out of the render body, useMemo it, or move it above the component |
| noop_share, producer is a callback or object | stabilize_producer | useCallback or useMemo at the producer |
| noop_share, producer is a context or store | narrow_input | split the context or narrow the selector |
| noop_share, reason is parent | memo_boundary | React.memo the component whose subtree commits nothing |
| effect_share | effect_shape | split, defer or cache effect work, fix deps, move layout reads before writes |
| no dominant share, most renders committed | bail | diffuse_genuine_work |

Extent overrides. If one commit renders hundreds of instances of one type and most of them commit nothing, the fix is at the producer (`producers_noop` query), not at the instances.

## Fix vocabulary, only these

1. stabilize_producer
2. narrow_input
3. memo_boundary
4. hoist_render_work
5. effect_shape

Anything outside this list is a bail with reason design_change.

## Bail vocabulary, only these

diffuse_genuine_work, within_budget, variance_too_high, third_party_owned, necessary_io_in_effect, design_change

## Output

Write `findings.json`. One entry per commit examined, fix or bail, never both empty.

```json
{
  "commit_id": "c_000412",
  "signature": "sig_9f1c",
  "measure": "route_switch",
  "on_critical_path": true,
  "total_ms": 14.2,
  "cause": { "producer": "Sidebar", "call_site": "src/sidebar/Sidebar.tsx:41", "trigger": "click", "cascade": false },
  "extent": { "rendered": 312, "committed": 22, "noop": 290, "top_type": "SidebarItem", "top_type_count": 300 },
  "shares": { "top1": 0.08, "noop": 0.71, "effect": 0.12 },
  "fix_class": "stabilize_producer",
  "fix_summary": "wrap onSelect in useCallback so SidebarItem props keep identity",
  "patch": "src/sidebar/Sidebar.tsx",
  "bail_reason": null,
  "evidence_query": "card_fanout WHERE commit_id = 'c_000412'",
  "before_after": { "before_p50_ms": 14.2, "after_p50_ms": null }
}
```

## Guardrails

1. Never restructure components, change behavior, or touch third-party code.
2. One fix per PR. Include the card and both numbers.
3. Every number in a finding comes from a query pasted in `evidence_query`.
4. Never capture or print prop values. `changed_keys` is enough.
5. Stop after two failed attempts on the same commit and bail with variance_too_high or design_change.
===== END FILE =====

===== FILE: skills/react-log/references/queries.md =====
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
===== END FILE =====
