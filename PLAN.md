# react-log plan, v2

v2 replaces v1 after the 2026-09-27 scope interview. The Decision log at the end says what changed and why. The skill lives in `skills/react-log/` (`SKILL.md` and `references/queries.md`). Those files are canonical, so this plan no longer embeds copies of them.

Two deliverables. A capture program that attaches to a Chromium browser over CDP and continuously writes a React render event log to Parquet, and a Claude Code skill that queries that log with DuckDB, finds expensive commits, explains them, and either proposes and applies a fix or bails with a named reason.

Not in v1. No A/B framework, no baseline service, no profiling or production builds, no out-of-process iframes or workers.

Not a goal at all: running next to the React DevTools extension. react-log is meant to replace it for this workflow, so a captured page runs without it.

## Scope, locked

1. React: every 18.x and 19.x release, dev builds only. A profiling or production build is detected and refused with a clear message.
2. Test matrix: 18.0.0, 18.2.0, 18.3.1, 19.0.8, 19.1.9, 19.2.8, 19.3.0. That is the 18.0 floor plus the latest patch of each later minor as of 2026-09-27. Every shim suite runs on every version.
3. Runtime: CDP only, so it works on any OS and any Chromium browser that exposes CDP. Everything is validated in headless Chromium in the cloud session. No step depends on a local machine.
4. Target: a demo app in `fixture/` with planted performance bugs, one per fix class plus two that must bail. Phase 5 runs against it.
5. Interactions: every trusted click and keypress becomes a measure, from Event Timing entries with an `interactionId`. Configured `performance.mark` pairs add named measures for async flows.
6. Overhead: at most 5% added at p50 and at p95 per interaction, and no single shim task over 4 ms. See Overhead.

## Success criteria

1. `react-log capture` runs until stopped against any React 18.x or 19.x dev app through CDP, segments stay queryable while it runs, and process memory stays flat however long it runs.
2. The overhead benchmark passes: on small, medium and large fixture interactions, 30 runs each, shim on versus no hook at all, the shim adds at most 5% at p50 and at p95, and its longest task stays under 4 ms. It runs on 18.3.1 and 19.3.0 by default, and on any matrix version on request.
3. `react-log card <commit_id>` answers in under one second at five million rows.
4. The skill, given a session, produces `findings.json` for the top five expensive commits, each with a fix or a bail, and every evidence query re-executes to the same numbers.
5. One fix from the skill lands in a PR against the fixture, with before and after cost for the same commit signature, captured on the same interaction.

## How the shim gets its data

React 19.2 removed the scheduling-profiler hooks (`injectProfilingHooks`) that v1 was built on. The shim therefore has one core that works on every version, plus a small adapter per React line.

Core, all versions. The shim installs `__REACT_DEVTOOLS_GLOBAL_HOOK__` before any page script runs. A hook's presence makes React 18.x, 19.0 and 19.1 keep per-fiber timers (ProfileMode); 19.2+ dev builds keep them anyway. On every `onCommitFiberRoot`, which runs after layout effects and before passive effects in both 18.3.1 and 19.3.0, the shim walks the fibers that rendered in this commit, the same way React DevTools' Profiler does:
1. A composite fiber rendered when its `PerformedWork` flag (1) is set. A subtree whose `child` pointer equals the alternate's did not render and is skipped, so the walk costs O(rendered fibers).
2. Timing comes from `actualStartTime` and `actualDuration`. `self_us` is `actualDuration` minus the children's `actualDuration`, the formula React itself uses for its Performance Tracks.
3. `committed` reads `flags | subtreeFlags` against the version's masks (table below).
4. It keeps references to the previous and next `memoizedProps`, hook list head (`memoizedState`) and `dependencies.firstContext`. The diffing runs later, in idle time.

Adapter for 18.0 to 19.1: the profiling hooks, through `internals.injectProfilingHooks`. They supply commit and effect phase boundaries, per-component layout and passive effect times, update_enqueued with lane and call site (`markStateUpdateScheduled`, `markForceUpdateScheduled`), render yields and suspends. The hooks object leaves out the per-component render start and stop methods, so React skips those calls; render timing comes from the core.

Adapter for 19.2 and later: React's own Performance Track calls. The shim wraps both functions before React loads, because React reads `console.createTask` once at module init.
1. A `console.timeStamp` wrapper keeps the Scheduler track spans (phases, lane class, cascading updates) and the per-component effect spans, then forwards every call unchanged. React only logs a component's effects when they took over 0.05 ms or spawned an update.
2. A `console.createTask` wrapper records update_enqueued with a capped stack when React names an update method: `setState()`, `dispatch()`, `updateSyncExternalStore()`, `refresh()`, `setOptimistic()`, `root.render()`, and the class variants. React calls it for the first update of each batch, which is the trigger the signature needs. React also calls it once per JSX element, so every other call returns after one string check.
3. Effect spans are mapped to fibers through the fiber's `_debugTask`, with component name and tree order as the fallback.

Hook install. If the capture program finds the React DevTools extension among the browser's targets, or a `__REACT_DEVTOOLS_GLOBAL_HOOK__` already exists when the shim runs, capture stops with an error that names the cause and says to disable the extension in the capture profile. Running both would leave the extension half-working. The shim's hook implements exactly what React calls: `supportsFiber`, `inject`, `isDisabled`, `checkDCE`, `onScheduleFiberRoot`, `onCommitFiberRoot`, `onPostCommitFiberRoot`, `onCommitFiberUnmount`, `setStrictMode`.

Why-data, computed in idle slices from the kept references:
1. `reason_code` is the first match in this order: mount (no alternate), retry (Suspense retry), force, context, hooks (a stateful hook changed, function components), state (class state changed), props (a prop changed by Object.is), parent (a new props object whose every key is equal, so memo would have skipped the render), unknown.
2. `changed_hooks` pairs changed hook indices with `_debugHookTypes`, for example `2:useState`.
3. `changed_context` compares the previous and next fiber's context dependency lists entry by entry, the method React DevTools uses. v1 compared against the context's current value, which after render is no longer the value this fiber read.
4. `changed_keys` is filled only for watched components.

Version facts the shim keys on. Checked in the react-dom npm builds on 2026-09-27.

| | 18.x | 19.0.x | 19.1.x | 19.2+ |
| --- | --- | --- | --- | --- |
| Profiling hooks | yes | yes | yes | no |
| Performance Tracks | no | no | no | yes |
| Source location on fibers | `_debugSource` | none | `_debugStack` | `_debugStack` |
| Per-fiber timers (ProfileMode) | if a hook exists at load | if a hook exists at load | if a hook exists at load | always in dev |
| Mutation, Layout, Passive masks | 12854, 8772, 2064 | 13878, 8772, 10256 | 13878, 8772, 10256 | 13878, 8772, 10256 |

`_debugHookTypes` exists in every dev build. Dev fibers are non-extensible, so per-fiber state lives in WeakMaps. Version strings can carry a build suffix (18.0.0 reports `18.0.0-fc46dba67-20220329`), so the shim keys on the leading major.minor only.

## Overhead

The hook's presence alone turns on React's per-fiber timers in 18.x, 19.0 and 19.1. That cost counts, because the benchmark baseline has no hook at all.
1. Inside React's commit, the shim only reads numbers and flags and keeps references. Numbers go into preallocated typed-array ring buffers, and nothing allocates per fiber beyond one slot.
2. Everything else runs in idle slices of at most 4 ms: diffs, component_id hashing (cached per fiber), stack formatting, serialization and flushing.
3. Stacks are captured only for updates, at most `stacksPerBatch` per batch, with `Error.stackTraceLimit` lowered during capture and formatting deferred.
4. The ring buffer never grows. On overflow the incoming event is dropped and counted as a dropped row.
5. Benchmark method. The fixture server sends COOP and COEP, so timers tick at 5 µs. Input goes through CDP `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`, because Event Timing ignores untrusted events. Each run is timed in the page, from the input event's timestamp to the first frame after the commit, since Event Timing rounds durations to 8 ms, too coarse for a 5% bar. Shim-on and no-hook page loads alternate: 3 loads per mode, 5 warm-up plus 10 measured runs per load. The shim times its own idle slices and flushes and reports the longest.

## Timer precision

`performance.now()` ticks in 100 µs steps unless the page is cross-origin isolated, and then in 5 µs steps (measured in headless Chromium). The fixture is always served isolated. For other apps, `react-log capture --isolate` adds `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` to the document response through CDP `Fetch.fulfillRequest`; `Fetch.continueResponse` does not isolate the page. The flag is off by default because it can block cross-origin resources. Without it, per-component numbers are quantized, commit-level numbers stay usable, and sums over many renders average out because Chrome rounds each value up or down at random.

## Repo layout

```
packages/shim        browser IIFE injected before any page script
packages/capture     CDP client, ingest, chain linker, rollups, segment writer
packages/cli         react-log binary (capture, watch, sessions, top, card, query)
fixture/app          demo app with planted perf bugs, plain JSX
fixture/versions     one small package per matrix version, pinning react and react-dom
bench/               overhead benchmark, headless Chromium, alternating runs
skills/react-log/    SKILL.md and references/queries.md
tests/               vitest: unit suites under jsdom, browser suites in headless Chromium
segments/            output, gitignored
```

## Dependencies

Runtime: nothing from npm. The capture program speaks raw CDP over Node 22's built-in WebSocket and parses arguments with `node:util` parseArgs. External tools: Node 22 or later, pnpm, the `duckdb` CLI on PATH (version pinned in Phase 0), and any Chrome or Chromium binary (`CHROME_PATH`, or Playwright's Chromium in the cloud session).

Dev: typescript, esbuild, vitest, jsdom, @types/node, and react plus react-dom for every matrix version, one small workspace package per version so each react-dom resolves its own react. The fixture is plain JSX, so no @types/react. Anything else gets asked first.

## Data model

Parquet per session under `segments/<session_id>/`. File families are `seg-*.parquet` (events), `defs-*.parquet`, `commits-*.parquet`, `measures-*.parquet`, plus `session.json`. Every session writes all four families, empty if need be, so the skill's views never fail on a missing glob. Column types are pinned (`read_json` with explicit `columns`, never `read_json_auto`), so segments union cleanly. Component names and source strings live only in defs.

```
events(session_id, page_load_id, ts, dur_us, self_us, kind, lane, component_id,
       commit_id, reason_code, changed_hooks, changed_context, changed_keys, committed,
       root_update_id, measure_instance_id, on_critical_path, call_site)

defs(component_id, display_name, source_file, source_line, owner_path)

measures(measure_instance_id, session_id, name, source, interaction_id, ts_start,
         ts_end_marker, ts_end_paint, ts_end_idle)

commits(commit_id, session_id, ts, measure_instance_id, on_critical_path, signature,
        root_update_id, producer_component_id, producer_call_site, trigger_event, lane,
        total_ms, render_ms, layout_ms, passive_ms, passive_sync, strict_mode,
        cascade_commit_id, rendered, committed, noop, noop_ms, distinct_types, top_type,
        top_type_count, top1_component_id, top1_share, noop_share, effect_share)
```

Event kinds. update_enqueued, render, bailout_count, commit, layout_effect, passive_effect, suspend, yield, mark, measure, loaf, event_timing, watch, dropped.

Definitions.

1. `component_id` is a stable hash of the owner path of display names, the keys along that path, and the source file and line where the version has them (not on 19.0.x), so it survives reloads. Frames in `_debugStack` point into the served bundle, so the capture program maps them back to original files through the page's source maps, off the page.
2. For a render, `ts` is `actualStartTime`, `dur_us` is `actualDuration`, and `self_us` is `actualDuration` minus the children's `actualDuration`. Children are not subtracted when their subtree did not render. `self_us` includes reconciling the component's children, not only its function body.
3. `committed` is true when `flags | subtreeFlags` has any bit in the version's mutation, layout or passive mask, read at `onCommitFiberRoot`.
4. `reason_code`, `changed_hooks`, `changed_context` and `changed_keys` are defined under Why-data.
5. `root_update_id` links update_enqueued, the renders and commit it produced, the effects that ran, and any update those effects enqueued. On 19.2+, update_enqueued exists only for the first update of each batch.
6. `lane` is the lane class name (Blocking, Transition, Suspense, Idle and so on). It comes from the commit lanes on 18.0 to 19.1 and from the Scheduler track name on 19.2+.
7. `on_critical_path` is true when an event is reachable from the measure's trigger and precedes the measure's end. `signature` is a hash of trigger_event, producer_call_site and top_type.
8. `passive_sync` is true when passive effects ran in the same task as the commit, detected with a MessageChannel probe on every version. `strict_mode` is true when the root runs under StrictMode, so dev render times include React's double render.
9. `measures.source` is `event_timing` or `marks`. For Event Timing measures, `ts_end_marker` is `processingEnd` and `ts_end_paint` is `startTime + duration`.

## Config

```json
{
  "cdp": "http://localhost:9222",
  "urlMatch": "localhost:3000",
  "launch": { "chromePath": null, "userDataDir": "~/.react-log/profile", "isolate": false },
  "interactions": { "eventTiming": true },
  "measures": [{ "name": "route_switch", "start": "route_switch:start", "end": "route_switch:end" }],
  "record": { "compositeOnly": true, "values": false, "stacksOn": ["update"], "stacksPerBatch": 8, "watch": [] },
  "segments": { "dir": "./segments", "rotateSeconds": 10, "rotateRows": 200000 }
}
```

`--launch` always uses `userDataDir`, never the default profile, because branded Chrome 136+ refuses CDP on the default profile.

## Phase 0. Scaffold (1 day)

0. Done in `25abb57`: PLAN.md v1 and the skill files.
1. pnpm workspace, TypeScript, esbuild, vitest, jsdom, the matrix packages, and the `duckdb` CLI documented and installed in the cloud session.
2. `react-log.config.json` as above.
3. Fixture skeleton: a ten-component tree in `fixture/app`, built once per matrix version in dev mode, served by a zero-dependency Node server that sends COOP and COEP.
4. Acceptance. `pnpm test` runs an empty suite, `react-log --help` prints the six commands, and `pnpm fixture:build` writes one bundle per matrix version.

## Phase 1. Shim (4 days)

1. Hook install and the refusal rules.
2. Core commit walk, version-keyed masks, reference capture.
3. Adapter for 18.0 to 19.1 and adapter for 19.2+.
4. Idle pipeline: why-data, component_id, stacks, serialization.
5. A PerformanceObserver forwards event (with `interactionId`), mark, measure and long-animation-frame entries into the same buffer.
6. Ring buffer of 50k rows in typed arrays, flushed every 250 ms in idle slices through `window.__reactLogSink(json)`, the CDP binding. Tests stub the sink. v1's localhost POST fallback is dropped.

Acceptance. The jsdom unit suite on every matrix version asserts the event sequence, `self_us`, `committed` values, reason codes, changed hooks and changed context for a ten-component tree. The headless Chromium browser suite on every matrix version asserts the same end to end, plus per-component effect times and at least one update call site on every version, and that capture refuses a page whose hook already exists.

## Phase 2. Capture program and fixture (3 days)

1. `react-log capture` connects to `--cdp`, picks the target by `--url-match`, or launches with `--launch <url>` on the dedicated profile. `--isolate` as above.
2. `Page.addScriptToEvaluateOnNewDocument` with the shim bundle, `Runtime.addBinding` for `__reactLogSink`, and `--reload` to reinstall on an already loaded page. Each target is its own session. Capture refuses when the React DevTools extension is present.
3. Ingest converts timestamps with `timeOrigin`, assigns `page_load_id` and `session_id`, writes `session.json` (start, app url, React version, config, git SHA when available), and appends NDJSON to a temp file.
4. Rotate every 10 seconds or 200k rows. Convert with the DuckDB CLI using the pinned column types, then rename into place. Same for defs, commits and measures files.
5. `react-log watch <name|id>` sends `Runtime.evaluate` to update `window.__reactLogWatch` and records a watch event.
6. Fixture interactions: small (about 50 components rendered), medium (about 500) and large (about 3,000, mostly no-op fan-out). Planted bugs: one per fix class (stabilize_producer, narrow_input, memo_boundary, hoist_render_work, effect_shape) and two that must bail (diffuse_genuine_work, within_budget).
7. `bench/`: the overhead benchmark as specified under Overhead.

Acceptance. A capture left running for at least an hour in the cloud session against the fixture under scripted load keeps `SELECT count(*) FROM read_parquet('segments/*/seg-*.parquet')` growing, holds capture process memory flat, and has no dropped rows. The overhead benchmark passes on 18.3.1 and 19.3.0.

## Phase 3. Rollups at ingest (3 days)

1. Chain linker assigns `root_update_id`. Batches arrive in order per page, so the linker keeps only open chains in memory, and expires a chain left open for 30 seconds.
2. Measures come from Event Timing interactions and the configured mark pairs. Stamp `measure_instance_id` by overlap, `on_critical_path` by reachability, and fill the three end columns.
3. Commits rollup with totals, fan-out, producer, signature, cascade link, `passive_sync`, `strict_mode` and the three shares, written as `commits-*.parquet`.
4. `react-log sessions`, `react-log top --session S [--measure M]`, `react-log card <commit_id>`, `react-log query "<sql>"`. Card prints the header row, top five self cost, effects, and the cause chain as text, under 60 lines.
5. Acceptance. For every measure instance in a recorded fixture session, on-path time and interference are unions of intervals, waiting is the uncovered remainder, and the three sum to the measure duration within 5 percent with no bucket negative. This is the check that catches double counting of nested intervals. Card answers in under one second on a synthetic five-million-row session.

## Phase 4. Skill (2 days)

1. Wire `skills/react-log/SKILL.md` and `references/queries.md` to the real schema and column names, and keep every query in the reference file runnable as pasted.
2. `react-log card` text output is the canonical shape the skill reads.
3. Record one fixture session and check it in under `tests/golden/`, so later fixture changes cannot break the golden run.
4. Acceptance. Run Claude Code with the skill on the golden session. It produces `findings.json` for five commits, every `evidence_query` re-executes to the same numbers, every component named exists in defs, and each planted bug lands on its expected fix class or bail.

## Phase 5. Closed loop on the fixture (2 days)

1. Capture the fixture under scripted load until the configured interaction has at least 20 instances.
2. Run the skill. Take the top finding that has a fix.
3. Apply the fix, re-capture 20 runs of the same interaction, and compare `total_ms` for the same signature before and after.
4. Open a PR with the card, the chain, and both numbers. Bail findings go in the PR description as examined and skipped, with reasons.
5. Acceptance. One merged PR.

## Tests

1. Shim unit suite under jsdom, every matrix version.
2. Shim browser suite in headless Chromium, every matrix version.
3. Linker on synthetic sequences, including an effect that enqueues an update.
4. Segment writer never exposes a partial file, pinned schemas union across segments, and dropped rows are counted.
5. Rollup reconciliation on a recorded session.
6. Overhead benchmark at the Phase 2 bar.
7. Skill golden run. Queries re-execute, schema validates, planted bugs classified.

## Later, not in this plan

1. Profiling builds, then the production path with sampling and build-time names.
2. Every update's call site on 19.2+, not only the first of each batch.
3. Out-of-process iframes and workers.
4. Baseline store and history gates (same signature last week).
5. CDP trace join for style, layout and paint per commit.
6. Concurrency model for concurrent roots.
7. React Compiler diagnostics on flagged components.

## Decision log

2026-09-27, scope interview. Evidence came from the react-dom npm builds 18.0.0 through 19.3.0, the React DevTools source, and experiments in headless Chromium in the cloud session.

1. React 19.2 removed `injectProfilingHooks`: present through 19.1.9, absent in 19.2.0, 19.2.8 and 19.3.0. The shim moved to a commit-walk core with per-line adapters, rather than degrading on 19.2+ or patching React's hook dispatcher.
2. A hook installed by the shim first silently disables the React DevTools extension, which skips its own install and then calls methods a minimal hook lacks. Coexistence is a non-goal, not deferred: react-log is meant to replace the extension for this workflow (owner's call). Capture refuses when the extension is present, so the extension never half-works.
3. `performance.now()` ticks at 100 µs without cross-origin isolation and at 5 µs with it. The fixture is served isolated, and `--isolate` is opt-in elsewhere.
4. v1's context check compared against the context's current value, which is wrong once render has finished. It now uses React DevTools' previous-versus-next dependency comparison.
5. Target is an in-repo fixture, runtime is CDP only and validated in the cloud session, builds are dev only, interactions come from Event Timing plus mark pairs, and the overhead bar is 5% at p50 and p95. The React DevTools clause left success criterion 1.
6. Branded Chrome 136+ refuses CDP on the default profile, and 137+ ignores `--load-extension`, so launch mode always uses its own profile directory.
7. The skill files moved out of this plan into `skills/react-log/`, their canonical home, so the two copies cannot drift.

## Kickoff prompt for Claude Code

```
Read PLAN.md, phase N. Implement only that phase. Acceptance is the test named in the phase; run it and paste the raw result. Do not touch other phases. React 18.x and 19.x dev builds only. Ask before adding any dependency not named in the plan.
```
