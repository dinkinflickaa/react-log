import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Serves fixture/dist cross-origin isolated (COOP + COEP), so performance.now()
// ticks in 5 µs steps instead of 100 µs.

const distDir = join(dirname(fileURLToPath(import.meta.url)), 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export function startFixtureServer(port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const relative = normalize(pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    const file = join(distDir, relative);
    if (!file.startsWith(distDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        ...ISOLATION_HEADERS,
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404, ISOLATION_HEADERS).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  await startFixtureServer(port);
  console.log(`fixture on http://localhost:${port}/ (cross-origin isolated)`);
}
