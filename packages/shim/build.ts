import { build } from 'esbuild';

// The shim is injected with Page.addScriptToEvaluateOnNewDocument, so it ships as one IIFE.
await build({
  entryPoints: [new URL('./src/index.ts', import.meta.url).pathname],
  outfile: new URL('./dist/shim.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
});
