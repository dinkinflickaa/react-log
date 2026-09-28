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

## Layout

```
packages/shim        browser IIFE injected before any page script (pnpm build)
packages/capture     CDP client, ingest, chain linker, rollups, segment writer
packages/cli         react-log binary
fixture/app          demo app, plain JSX
fixture/versions     one package per React version in the test matrix
skills/react-log/    the Claude Code skill
tests/               vitest suites
```
