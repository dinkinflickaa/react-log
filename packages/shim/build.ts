import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The shim is injected with Page.addScriptToEvaluateOnNewDocument, so it ships
// as one IIFE. The sourceURL names its frames in stacks and LoAF attribution.
export async function bundleShim(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    footer: { js: '//# sourceURL=react-log-shim.js' },
    logLevel: 'warning',
  });
  return result.outputFiles[0]!.text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL('./dist/shim.js', import.meta.url));
  mkdirSync(fileURLToPath(new URL('./dist/', import.meta.url)), { recursive: true });
  writeFileSync(out, await bundleShim());
}
