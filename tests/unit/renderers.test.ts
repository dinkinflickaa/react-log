import { expect, test } from 'vitest';
import { start } from './harness.ts';

// A page can hold several Reacts: an embedded widget's production build, or
// an unsupported version, next to the app's development build. Those are
// reported and skipped; the development one records as if alone.

test(`React ${process.env.REACT_VERSION} beside a production React and an unsupported one: both skipped, the page still records`, async () => {
  const h = await start({
    before: (g) => {
      const hook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      hook.inject({ version: '18.2.0', bundleType: 0, rendererPackageName: 'react-dom' });
      hook.inject({ version: '17.0.2', bundleType: 1, rendererPackageName: 'react-dom' });
    },
  });
  const rows = h.take();
  expect(h.api.status).toBe('active');
  expect(h.messages.some((m) => m.t === 'refused')).toBe(false);
  const renderers = h.messages.filter((m) => m.t === 'renderer');
  expect(renderers.map((r) => [r.version, r.skipped])).toEqual([
    ['18.2.0', 'not-a-dev-build'],
    ['17.0.2', 'unsupported-react-version'],
    [expect.stringMatching(new RegExp(`^${process.env.REACT_VERSION!.replace(/\./g, '\\.')}`)), null],
  ]);
  expect(rows.filter((r) => r[0] === 'render').length).toBeGreaterThan(0);
  expect(rows.some((r) => r[0] === 'commit')).toBe(true);
});
