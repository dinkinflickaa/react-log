import { callSiteIndex, type Frame, parseFrames, phaseOf, withoutShim } from '../../shim/src/frames.ts';
import type { Mapped, SourceMaps } from './sourcemap.ts';

// An update's stack, as the page sent it (V8 text), turned into what the log
// stores: every frame past the shim's own mapped to original source, the call
// site (the first frame past React's update path) and the phase the frames
// show (layout, passive, render or null).
export interface ResolvedStack {
  callSite: string | null;
  frames: string[];
  phase: string | null;
}

const HTTP = /^https?:\/\//;

function frameText(f: Frame, m: Mapped | null | undefined): string {
  if (m == null) return f.text;
  return `${f.fn || m.name || '<anonymous>'} (${m.file}:${m.line}:${m.column})`;
}

// React's own source files, once frames are mapped: some of its frames on
// the update path have no name (a store's change handler on 19.2+).
const REACT_SOURCE = /(^|[\\/])node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(react|react-dom|react-reconciler|scheduler)[\\/]/;

function resolve(maps: SourceMaps, frames: Frame[]): ResolvedStack {
  const mapped = frames.map((f) => (HTTP.test(f.file) ? maps.peek(f.file, f.line, f.column) : null));
  const texts = frames.map((f, k) => frameText(f, mapped[k]));
  let i = callSiteIndex(frames);
  while (i >= 0 && i < frames.length && mapped[i] != null && REACT_SOURCE.test(mapped[i]!.file)) i++;
  if (i >= frames.length) i = -1;
  return { callSite: i < 0 ? null : texts[i]!, frames: texts, phase: phaseOf(frames) };
}

// Synchronous when every script's source map is already loaded; otherwise
// null, and resolveStack loads them.
export function resolveStackSync(maps: SourceMaps, text: string): ResolvedStack | null {
  const frames = withoutShim(parseFrames(text));
  for (const f of frames) if (HTTP.test(f.file) && maps.peek(f.file, f.line, f.column) === undefined) return null;
  return resolve(maps, frames);
}

export async function resolveStack(maps: SourceMaps, text: string): Promise<ResolvedStack> {
  const frames = withoutShim(parseFrames(text));
  const urls = new Set(frames.map((f) => f.file).filter((u) => HTTP.test(u)));
  await Promise.all([...urls].map((u) => maps.load(u).catch(() => null)));
  return resolve(maps, frames);
}
