# react-log

A React render event log captured over CDP and written to Parquet, plus a Claude Code skill that finds, explains and fixes expensive commits with DuckDB. [PLAN.md](PLAN.md) has the plan and every decision behind it.

## Requirements

- Node 22.18 or later, which runs the TypeScript sources directly, and pnpm 10.
- The DuckDB CLI 1.5.5 on PATH. On Linux or macOS, run `scripts/install-duckdb.sh`. Otherwise see https://duckdb.org/docs/installation.
- Chrome or Chromium, for capture and the browser tests. Set `CHROME_PATH` if it isn't found.

## Setup

```sh
pnpm install
pnpm fixture:build        # one dev bundle of the demo app per React version
pnpm fixture:serve        # http://localhost:3000, cross-origin isolated
pnpm test
pnpm exec react-log --help
```

## Capture

```sh
# Launch a dedicated Chrome profile on the app and record until Ctrl-C
pnpm exec react-log capture --launch http://localhost:3000/ [--headless] [--isolate]

# Or attach to a Chrome started with --remote-debugging-port=9222
pnpm exec react-log capture --cdp http://localhost:9222 --url-match localhost:3000 --reload

# While it runs: record which props changed by value for some components
pnpm exec react-log watch SidebarItem

duckdb -c "SELECT kind, count(*) FROM read_parquet('segments/*/seg-*.parquet') GROUP BY 1"
```

Each browser tab is a session under `segments/<session_id>/`, with `session.json` and Parquet files that rotate every 10 seconds: `seg` (every event), `defs` (components), `commits` (one rollup row per commit) and `measures` (one row per interaction or configured mark pair). Capture links every row to the chain of updates that caused it (`root_update_id`) and stamps the rows inside a measure (`measure_instance_id`, `on_critical_path`). A new tab opened while capture runs is recorded too. The React DevTools extension must be off in the capture profile. `react-log.config.json` holds the defaults.

## Reading a session

```sh
pnpm exec react-log sessions                     # newest first
pnpm exec react-log top [--session <id>] [--measure click] [--limit 20]
pnpm exec react-log card <commit_id>             # cause, extent, self cost, effects, cause chain
pnpm exec react-log query "SELECT name, count(*), median(duration_ms) FROM measures GROUP BY 1"
```

`query` runs DuckDB with four views loaded, over all sessions or one (`--session`): `events`, `defs`, `commits` and `measures`. `--json` and `--csv` change the output format.

## The skill

`skills/react-log/SKILL.md` is a Claude Code skill: it ranks a session's commits, reads each one's card, and either proposes a fix from a fixed vocabulary (stabilize_producer, narrow_input, memo_boundary, hoist_render_work, effect_shape) or bails with a named reason, writing `findings.json`. `skills/react-log/references/queries.md` holds its SQL.

`tests/golden/segments/` is a recorded session of the lab's planted bugs (React 19.3.0), checked in so fixture changes cannot move the goalposts. `tests/golden/findings.json` is the skill's own run on it.

```sh
node tests/golden/record.ts                       # re-record the golden session
node tests/skill/findings.ts <findings.json>      # check a run: vocabulary, evidence re-executes, components exist, planted bugs classified
```

## Benchmarks

```sh
node bench/overhead.ts             # shim vs an empty DevTools hook (gated) and vs no hook, React 18.3.1 and 19.3.0 (about 30 min)
node bench/soak.ts --minutes 60    # capture under scripted load: rows grow, memory flat, nothing dropped
node bench/buckets.ts <session dir> # every measure's time buckets, recomputed in SQL from its events
node bench/card.ts                 # react-log card on a synthetic five-million-row session: under 1 s
node bench/record.ts --out <dir>   # the lab under scripted load: each planted bug's button, 20 rounds
```

## Layout

```
packages/shim        browser IIFE injected before any page script (pnpm build)
packages/capture     CDP client, ingest, chain linker, rollups, segment writer
packages/cli         react-log binary
fixture/app          demo app, plain JSX: the lab (benchmark interactions and planted bugs) and the chains page (what the chain linker connects)
fixture/versions     one package per React version in the test matrix
skills/react-log/    the Claude Code skill and its queries
bench/               overhead benchmark, soak test and Phase 3 acceptance checks
tests/               vitest suites; tests/golden holds the golden session and the skill's findings on it
```
