import { describe, expect, test } from 'vitest';
import { decodeMappings, parseMap, sourcePath, splitFrame } from '../../packages/capture/src/sourcemap.ts';

describe('source maps', () => {
  test('decodes VLQ mappings into per-line segments', () => {
    // Line 1: col 0 -> src 0 line 0 col 0; col 4 -> src 0 line 1 col 2, name 0.
    // Line 2: col 2 -> src 1 line 4 col 2. Only the generated column restarts
    // on a new line; source, line and column deltas carry over.
    const lines = decodeMappings('AAAA,IACEA;ECGA');
    expect(Array.from(lines[0]!)).toEqual([0, 0, 0, 0, -1, 4, 0, 1, 2, 0]);
    expect(Array.from(lines[1]!)).toEqual([2, 1, 4, 2, -1]);
  });

  test('rejects malformed mappings', () => {
    expect(() => decodeMappings('A!')).toThrow();
  });

  test('normalizes source paths to repo-relative ones', () => {
    expect(sourcePath('fixture/dist/react-19.3.0/', '../../app/src/App.jsx')).toBe('fixture/app/src/App.jsx');
    expect(sourcePath(undefined, 'webpack://my-app/./src/App.tsx')).toBe('src/App.tsx');
    expect(sourcePath(undefined, 'file:///home/me/app/src/App.tsx')).toBe('/home/me/app/src/App.tsx');
    expect(sourcePath('', './src/App.tsx')).toBe('src/App.tsx');
  });

  test('parses a map and keeps names', () => {
    const map = parseMap({ version: 3, sourceRoot: 'root/', sources: ['a.js'], names: ['fn'], mappings: 'AAAAA' });
    expect(map.sources).toEqual(['root/a.js']);
    expect(map.names).toEqual(['fn']);
  });

  test('splits V8 frames with and without a function name', () => {
    expect(splitFrame('onIncrement (http://127.0.0.1:3000/react-19.3.0/app.js:24752:28)')).toEqual({
      fn: 'onIncrement',
      url: 'http://127.0.0.1:3000/react-19.3.0/app.js',
      line: 24752,
      column: 28,
    });
    expect(splitFrame('http://127.0.0.1:3000/app.js:1:2')).toEqual({ fn: null, url: 'http://127.0.0.1:3000/app.js', line: 1, column: 2 });
    expect(splitFrame('native code')).toBeNull();
  });
});
