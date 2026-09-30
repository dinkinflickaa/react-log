// Capturing a stack records structured frames; V8 formats the text lazily,
// on first read of .stack, which happens in idle time. The capture itself
// runs inside the update and costs more with every frame kept (3.4 to 5.9 µs
// for 30 frames at a click handler's depth, PLAN.md 44), so the frames from
// `skip` inward (the shim's own) are left out. The page sends the text as
// is: the capture program parses it (frames.ts) and maps every frame to
// original source.
export function captureStack(limit: number, skip: Function): Error {
  const saved = Error.stackTraceLimit;
  Error.stackTraceLimit = limit;
  let e: Error;
  if (typeof Error.captureStackTrace === 'function') {
    e = { name: 'Error', message: 'react-log update' } as Error;
    Error.captureStackTrace(e, skip);
  } else {
    e = new Error('react-log update');
  }
  Error.stackTraceLimit = saved;
  return e;
}
