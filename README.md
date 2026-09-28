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

Each browser tab is a session under `segments/<session_id>/`, with `session.json` and Parquet files that rotate every 10 seconds. The React DevTools extension must be off in the capture profile. `react-log.config.json` holds the defaults.

## Benchmarks

```sh
node bench/overhead.ts             # shim on vs no hook, React 18.3.1 and 19.3.0 (about 20 min)
node bench/soak.ts --minutes 60    # capture under scripted load: rows grow, memory flat, nothing dropped
```

## Layout

```
packages/shim        browser IIFE injected before any page script (pnpm build)
packages/capture     CDP client, ingest, chain linker, rollups, segment writer
packages/cli         react-log binary
fixture/app          demo app, plain JSX
fixture/versions     one package per React version in the test matrix
skills/react-log/    the Claude Code skill
bench/               overhead benchmark and soak test, headless Chromium
tests/               vitest suites
```
