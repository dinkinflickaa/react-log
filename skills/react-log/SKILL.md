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
