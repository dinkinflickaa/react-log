import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));
const versionsDir = join(root, 'fixture/versions');
const versions = readdirSync(versionsDir)
  .filter((name) => name.startsWith('react-'))
  .map((name) => name.slice('react-'.length))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

// Each unit project resolves react and react-dom to one matrix version, so
// the same suite runs once per version.
function reactAlias(version: string): Record<string, string> {
  const require = createRequire(join(versionsDir, `react-${version}`, 'package.json'));
  return {
    react: dirname(require.resolve('react/package.json')),
    'react-dom': dirname(require.resolve('react-dom/package.json')),
  };
}

export default defineConfig({
  // Dev-mode automatic JSX, as in the fixture bundles: React 18 reads
  // _debugSource from it.
  oxc: { jsx: { runtime: 'automatic', development: true } },
  test: {
    passWithNoTests: true,
    projects: [
      ...versions.map((version) => ({
        extends: true,
        resolve: { alias: reactAlias(version) },
        test: {
          name: `unit@${version}`,
          environment: 'jsdom',
          include: ['tests/unit/**/*.test.ts'],
          env: { REACT_VERSION: version },
        },
      })),
      {
        extends: true,
        test: {
          name: 'capture',
          environment: 'node',
          include: ['tests/capture/**/*.test.ts'],
          globalSetup: ['tests/browser/setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'skill',
          environment: 'node',
          include: ['tests/skill/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          environment: 'node',
          include: ['tests/browser/**/*.test.ts'],
          globalSetup: ['tests/browser/setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
