// React is loaded per matrix version at test time and is deliberately untyped
// here: the suites read internals that no @types package describes.
declare module 'react';
declare module 'react-dom/client';
declare module 'react-dom/test-utils';
declare module '*.jsx';
