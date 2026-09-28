# @react-log/shim

Page-side shim. `pnpm build` writes `dist/shim.js`, one IIFE that the capture program injects with `Page.addScriptToEvaluateOnNewDocument` before any page script runs. PLAN.md ("How the shim gets its data") explains the design.

## Wire format

The shim calls `window.__reactLogSink(json)`, a CDP binding, once per message.

| `t` | When | Fields |
| --- | --- | --- |
| `hello` | install | `v`, `shim`, `url`, `timeOrigin`, `token` (random per page load) |
| `renderer` | React injects | `id`, `version`, `line` (`18`, `19.0`, `19.1`, `19.2+`), `bundleType`, `package` |
| `refused` | a hook already exists, or a non-dev or unsupported React | `reason`, `detail` |
| `error` | a shim bug, once per distinct message | `message`, `stack` |
| `batch` | idle flush, every 250 ms | `seq`, `dropped`, `defs`, `rows` |

`defs` rows: `[component_id, display_name, source_file, source_line, source_column, owner_path]`. On 19.1+ the source is a position in the served bundle, for the capture program to map through source maps.

`rows`: `[kind, ts, dur_us, self_us, lane, component_id, commit, reason_code, changed_hooks, changed_context, changed_keys, committed, call_site, extra]`. `ts` is `performance.now()` ms on the page clock; add `timeOrigin` for wall time. `commit` is a per-page sequence number. `call_site` is always null from the page: the capture program finds it in the update's stack.

| kind | extra |
| --- | --- |
| `render` | `{strict}` when under StrictMode, else null |
| `commit` | `root`, `priority`, `didError`, `strict`, `trigger`, `renderStart`, `renderEnd`, `commitStart`, `commitEnd`, `layoutStart`, `layoutEnd`, `passiveStart`, `passiveEnd`, `passiveSync`, `rendered`, `bailouts`, `walkUs` |
| `layout_effect`, `passive_effect` | `{phase: mount or unmount}` on 18.0 to 19.1, `{name}` on 19.2+ |
| `update_enqueued` | `method`, `phase` (render, layout, passive or null), `event` (trusted event type), `component`, `label`, `stack` (V8's text, 30 frames from React's call into the shim outward, or null past `stacksPerBatch`), `during` (the `commit` whose layout or passive phase enqueued it, or null) |
| `event_timing` | `name`, `interactionId`, `processingStart`, `processingEnd`, `target` |
| `mark`, `measure` | `name`. Measures are the app's own `performance.measure` calls, recorded by the shim's wrapper; React 19.2+'s Performance Track measures are left out. |
| `loaf` | `blocking`, `renderStart`, `styleAndLayoutStart`, `scripts` (top three) |
| `watch` | `names` |
| `yield`, `suspend` | null |

## Page API

`window.__reactLog`: `status` (`active` or `refused`), `reason`, `version`, `stats`, `flushNow()`, and `pending()` (records not yet handed to the sink). `stats` has commit and row counts, total and longest walk time, the longest shim task (`maxTaskMs`, split into `maxIdleMs` for idle slices and `maxObserverMs` for PerformanceObserver callbacks), the longest sink call and the largest payload. `window.__reactLogWatch`: the watch list; setting it records a `watch` row. `window.__reactLogConfig`, if set before the shim runs, overrides `ringSize`, `flushIntervalMs`, `sliceMs`, `stacksPerBatch`, `watch` and `observe` (entry types: `event`, `mark`, `measure`, `long-animation-frame`).
