import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds fixture/app once per React version in fixture/versions, in dev mode,
// into fixture/dist/react-<version>/.

const root = dirname(fileURLToPath(import.meta.url));
const versionsDir = join(root, 'versions');
const outDir = join(root, 'dist');

function packageDir(require: NodeJS.Require, name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

function packageVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
}

const versions = readdirSync(versionsDir)
  .filter((name) => name.startsWith('react-'))
  .map((name) => name.slice('react-'.length))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

rmSync(outDir, { recursive: true, force: true });

for (const version of versions) {
  const require = createRequire(join(versionsDir, `react-${version}`, 'package.json'));
  const react = packageDir(require, 'react');
  const reactDom = packageDir(require, 'react-dom');
  for (const dir of [react, reactDom]) {
    if (packageVersion(dir) !== version) {
      throw new Error(`${dir} is ${packageVersion(dir)}, expected ${version}`);
    }
  }

  const target = join(outDir, `react-${version}`);
  await build({
    entryPoints: { app: join(root, 'app/src/main.jsx'), lab: join(root, 'app/src/lab.jsx'), chains: join(root, 'app/src/chains.jsx'), big: join(root, 'app/src/big.jsx') },
    outdir: target,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    jsxDev: true,
    // Keep function names as written, as dev servers do; the shim reports them.
    keepNames: true,
    define: { 'process.env.NODE_ENV': '"development"' },
    alias: { react, 'react-dom': reactDom },
    sourcemap: 'linked',
    // Map sources resolve to repo-relative paths, like fixture/app/src/App.jsx.
    sourceRoot: `fixture/dist/react-${version}/`,
    logLevel: 'warning',
  });
  for (const [page, script, title] of [
    ['index.html', 'app.js', 'fixture'],
    ['lab.html', 'lab.js', 'lab'],
    ['chains.html', 'chains.js', 'chains'],
    ['big.html', 'big.js', 'big'],
  ]) {
    writeFileSync(
      join(target, page!),
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:," />
    <title>react-log ${title}, React ${version}</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="${script}"></script>
  </body>
</html>
`,
    );
  }
  // The chains page in an iframe from the other loopback name: another site,
  // so Chrome runs it out of process, as a CDP target of its own.
  writeFileSync(
    join(target, 'frames.html'),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:," />
    <title>react-log frames, React ${version}</title>
  </head>
  <body>
    <iframe id="child" width="900" height="700"></iframe>
    <script>
      const host = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      document.getElementById('child').src = location.protocol + '//' + host + ':' + location.port + location.pathname.replace(/frames\\.html$/, 'chains.html');
    </script>
  </body>
</html>
`,
  );
  const kb = (statSync(join(target, 'app.js')).size / 1024).toFixed(0);
  console.log(`react-${version}  ${join('fixture/dist', `react-${version}`, 'app.js')}  ${kb} KB`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'index.html'),
  `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:," />
    <title>react-log fixture</title>
  </head>
  <body>
    <ul>
${versions.map((v) => `      <li>React ${v}: <a href="/react-${v}/">tree</a>, <a href="/react-${v}/lab.html">lab</a></li>`).join('\n')}
    </ul>
  </body>
</html>
`,
);
console.log(`${versions.length} bundles`);
