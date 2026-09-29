---
name: react-log
description: Analyze react-log capture sessions (Parquet segments under ./segments) with DuckDB to find the most expensive React commits, explain each one (cause, extent, self cost, effect cost), and either propose and apply a code fix or bail with a named reason. Use this whenever the user mentions react-log, segments, a capture session, expensive commits, render cost, re-renders, effect cost, or asks why an interaction in a React app is slow when a capture exists or can be taken.
---

# react-log

## What you need

1. `duckdb` CLI on PATH.
2. A segments directory (default `./segments`) with at least one session.
3. The `react-log` CLI for `capture`, `watch`, `sessions`, `top`, `card`, `query`: `react-log` on PATH (after `npm link` in the react-log repo's `packages/cli`), or `pnpm exec react-log` inside the react-log repo. Run it from the app's directory, where capture writes `./segments`, and add `--segments <dir>` when the sessions are elsewhere. Everything also works with plain SQL from `references/queries.md`: load its `views` block first, then run queries by name with the placeholders filled in.

## What is in a session

- `events`: one row per render, effect, commit, update, interaction entry and long frame. `root_update_id` ties every row to the chain of updates that caused it; a commit with `cascade_commit_id` came from an update that an effect of that commit enqueued.
- `commits`: one row per commit, with its cost split (render, layout, passive), fan-out (rendered, committed, noop), producer, call site, trigger, lane, `signature` (the kind of commit, stable across captures and fixes) and three shares of its total: `top1_share` (the costliest component's own render), `noop_share` (renders that changed nothing), `effect_share` (effects). `dropped_rows` counts the commit's rows the page had no room for (null in older sessions).
- `measures`: one row per interaction (a click or keypress of 16 ms or more) or configured mark pair, its duration split into on-path work, interference and waiting. A commit on a measure's critical path has `on_critical_path` true.
- `defs`: component names and where each component's element is created.

## Method, in this order

1. Pick the session. Run `react-log sessions`. Use the newest unless told otherwise.
2. Rank. Run `react-log top --session <id>`, then `top_signatures` and `p95_cutoff`. Work per signature, through its `worst_commit`. A signature is worth examining if its worst commit is above 8 ms on a measure's critical path, above 16 ms anywhere, or above the session's p95. Skip the page's first render (on no measure, and its card's `why` line is nearly all `mount`) unless the user asks about load. Take at most five, most expensive first.
3. Read the card. Run `react-log card <commit_id>` for each. It is the canonical view: signature and lane; total and its split; the measure and whether this commit is on its critical path; cause (trigger, producer, call site); chain root and cascade; extent; shares; `why` (render reasons and counts); self cost, top five, with each component's reason and what changed; effects; and the cause chain. Answer the five questions and write them down before deciding anything. Cause (trigger, producer, call site, lane, cascade, and for the top components which hook, context or prop changed). Extent (rendered, committed, noop, top type and its count). Self cost (top five, top1_share). Effects (layout and passive totals, top instance, passive_sync). Concentration (top1_share, noop_share, effect_share). The `card_*` queries give more rows than the card shows. If the card says `incomplete` (`dropped_rows` above 0), the page had no room for some of the commit's rows: its counts, times and shares undercount, so do not classify it. Ask for a re-capture of the same interaction; if none is possible, bail variance_too_high and name the dropped count.
4. Decide with the decision table below.
5. Act. For a fix class, write the smallest patch in the fix vocabulary, apply it, ask for a re-capture of the same interaction, and run `signature_before_after`. Report both numbers. For a bail, write the reason and the evidence and stop. When asked for findings only, stop after step 4: write `findings.json`, apply nothing, and leave `after_p50_ms` null.

## Decision table

A share is dominant when it is at least 0.5. A commit has no-op fan-out when one type renders at least 100 times in it and at least 80% of its renders commit nothing. Take the first row that matches.

| Evidence | Verdict | What the patch usually is |
| --- | --- | --- |
| total_ms under 8 | bail within_budget | none: no fix pays for itself |
| effect_share dominant | effect_shape | split, defer or cache effect work, fix deps, move layout reads before writes |
| top1_share dominant | hoist_render_work | move computation out of the render body, useMemo it, or move it to module scope |
| noop_share dominant or no-op fan-out, and the no-op renders' reason is `context` (or a store hook in `changed_hooks`) | narrow_input | split the context or narrow the selector, at the provider |
| same, reason `props`, `changed_keys` says `identity_only` for a function or object prop, and the component is memoized (`memo` yes on the card) | stabilize_producer | useCallback or useMemo for that prop where the producer creates it |
| same, but the component is not memoized (`memo` no) | memo_boundary | React.memo the component, and in the same patch give the identity-only prop a stable value; either alone changes nothing |
| same, reason `parent` (props equal, the parent re-rendered) | memo_boundary | React.memo the highest component whose subtree commits nothing |
| no dominant share, most renders committed | bail diffuse_genuine_work | none: the work is the output |

An empty `memo` means the capture predates it: read the component's definition to tell. If the verdict depends on whether props changed by identity only or by value and `changed_keys` is empty, do not guess. Run `react-log watch <name>`, ask the user for one more capture of the same interaction, then run `card_changed_keys`. If no capture is possible, bail design_change and name the component to watch. Anything the table does not cover is a bail with reason design_change.

## Fix vocabulary, only these

1. stabilize_producer
2. narrow_input
3. memo_boundary
4. hoist_render_work
5. effect_shape

## Bail vocabulary, only these

diffuse_genuine_work, within_budget, variance_too_high, third_party_owned, necessary_io_in_effect, design_change

## Output

Write `findings.json`: a JSON array with one entry per signature examined, most expensive first. Each entry has a fix or a bail, never both and never neither. The example is from an unrelated app.

```json
[
  {
    "commit_id": "20260301-101500-q7xa.1.42",
    "signature": "sig_03c9a1e2f4",
    "measure": "keydown",
    "on_critical_path": true,
    "total_ms": 38.4,
    "cause": { "producer": "SearchBox", "call_site": "onChange (src/search/SearchBox.jsx:31:7)", "trigger": "keydown", "cascade": false },
    "extent": { "rendered": 251, "committed": 12, "noop": 239, "top_type": "ResultRow", "top_type_count": 240 },
    "shares": { "top1": 0.11, "noop": 0.62, "effect": 0.04 },
    "fix_class": "stabilize_producer",
    "fix_summary": "useCallback for onHover in ResultsList, so ResultRow's memo holds when the query changes",
    "patch": "src/search/ResultsList.jsx",
    "bail_reason": null,
    "components": ["SearchBox", "ResultsList", "ResultRow"],
    "evidence_query": "SELECT round(c.total_ms, 1) AS total_ms, ... WHERE c.commit_id = '20260301-101500-q7xa.1.42';",
    "before_after": { "before_p50_ms": 35.9, "after_p50_ms": null }
  }
]
```

1. `commit_id` is the signature's worst commit; `signature`, `measure` and `on_critical_path` come from its card.
2. `total_ms`, `extent`, `shares` and `before_after.before_p50_ms` are exactly what the `finding_numbers` query returns for the commit, rounded as it rounds.
3. `evidence_query` is the `finding_numbers` query with the commit id filled in, complete, runnable as written after the views.
4. `cause.producer` is the card's producer; `cause.cascade` is true when the card says `cascade of`.
5. `components` lists every component the entry names anywhere, spelled as in `defs.display_name`.
6. For a fix: `patch` is the file the fix edits (the component's `source_file` in defs; when it is empty, as for elements React 19 dev created past its owner-stack budget, the nearest owner in `owner_path` that has one) and `fix_summary` names the component and the change in one sentence. For a bail: `fix_class` and `patch` are null, and `fix_summary` says in one sentence which evidence decided it.

## Guardrails

1. Never restructure components, change behavior, or touch third-party code.
2. One fix per PR. Include the card and both numbers.
3. Every number in a finding comes from `evidence_query`.
4. Never capture or print prop values. `changed_keys` is enough.
5. Stop after two failed attempts on the same commit and bail with variance_too_high or design_change.
