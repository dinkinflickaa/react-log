import { describe, expect, test } from 'vitest';
import { isMemo, siteOf, sourceOf } from '../../packages/shim/src/ids.ts';

// Where a component's element was created, and whether it is memoized, from
// fibers built by hand and, on React 19.1+, from the real JSX runtime past its
// owner-stack budget.

const version = process.env.REACT_VERSION!;
const [major, minor] = version.split('.').map(Number) as [number, number];
const ownerStacks = major > 19 || (major === 19 && minor >= 1);

const shim = () => ({ sourceBySite: new Map(), placeholders: new WeakSet() }) as any;
const stack = (...frames: string[]) => ({ stack: ['Error: react-stack-top-frame', ...frames.map((f) => `    at ${f}`)].join('\n') });

describe('sourceOf', () => {
  test('React 18 records the source on the fiber', () => {
    const fiber = { _debugSource: { fileName: 'src/App.jsx', lineNumber: 12, columnNumber: 5 } };
    expect(sourceOf(shim(), fiber, 'App>List>Item#1')).toEqual({ file: 'src/App.jsx', line: 12, column: 5 });
  });

  test("React 19.1+: the first frame past the element factory is the element's call site", () => {
    const fiber = { _debugStack: stack('exports.jsxDEV (http://h/app.js:100:20)', 'List (http://h/app.js:200:10)', 'renderWithHooks (http://h/app.js:9000:1)') };
    expect(sourceOf(shim(), fiber, 'App>List>Item#1')).toEqual({ file: 'http://h/app.js', line: 200, column: 10 });
  });

  test("past React's owner-stack budget: the placeholder is no source, and a sibling from the same JSX site lends its own", () => {
    const s = shim();
    const placeholder = stack('UnknownOwner (http://h/app.js:50:10)', 'Object.react_stack_bottom_frame (http://h/app.js:60:10)', 'http://h/app.js:70:5');
    // Nothing from that site yet: unknown, never React's runtime.
    expect(sourceOf(s, { _debugStack: placeholder }, 'App>Other>Cell#3')).toBeNull();
    sourceOf(s, { _debugStack: stack('exports.jsxDEV (http://h/app.js:100:20)', 'List (http://h/app.js:200:10)') }, 'App>List#a>Item#1');
    expect(siteOf('App>List#b>Item#2999')).toBe('App>List>Item');
    expect(sourceOf(s, { _debugStack: placeholder }, 'App>List#b>Item#2999')).toEqual({ file: 'http://h/app.js', line: 200, column: 10 });
  });

  test.runIf(ownerStacks)(`React ${version}: the JSX runtime's own placeholder, past 10,000 elements, is recognized`, async () => {
    const React = (await import('react')).default as any;
    const { jsxDEV } = (await import('react/jsx-dev-runtime')).default as any;
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    internals.recentlyCreatedOwnerStacks = 0;
    function Item() {
      return null;
    }
    const elements = Array.from({ length: 10_002 }, () => jsxDEV(Item, {}, undefined, false, undefined, undefined));
    const first = elements[0]._debugStack;
    const last = elements[10_001]._debugStack;
    expect(last).not.toBe(first);
    expect(elements[10_000]._debugStack).toBe(last);
    const s = shim();
    const real = sourceOf(s, { _debugStack: first }, 'Test>Item#0');
    expect(real?.file).toMatch(/tests\/unit\/ids\.test\.ts$/);
    // The placeholder takes the source of the real one from the same site.
    expect(sourceOf(s, { _debugStack: last }, 'Test>Item#10001')).toEqual(real);
    expect(sourceOf(shim(), { _debugStack: last }, 'Test>Item#10001')).toBeNull();
  });
});

describe('isMemo', () => {
  test('React.memo, with and without a compare function, and PureComponent', () => {
    expect(isMemo({ tag: 15 })).toBe(true);
    expect(isMemo({ tag: 0, return: { tag: 14 } })).toBe(true);
    expect(isMemo({ tag: 1, type: { prototype: { isPureReactComponent: true } } })).toBe(true);
    expect(isMemo({ tag: 0, return: { tag: 5 } })).toBe(false);
    expect(isMemo({ tag: 1, type: { prototype: {} } })).toBe(false);
  });
});
