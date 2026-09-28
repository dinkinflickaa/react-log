import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Build the fixture bundles once for the browser suite.
export default function setup(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../fixture/build.ts', import.meta.url))], { stdio: 'inherit' });
}
