import { posix } from 'node:path';

// Source Map v3 lookups, enough to map a bundle position from a V8 stack
// frame back to the original file. Maps are fetched once per script URL.

export interface Mapped {
  file: string;
  line: number;
  column: number;
  name: string | null;
}

interface ParsedMap {
  sources: string[];
  names: string[];
  // Per generated line: flat [genCol, srcIndex, srcLine, srcCol, nameIndex] groups, sorted by genCol.
  lines: Int32Array[];
}

const B64 = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

export function decodeMappings(mappings: string): Int32Array[] {
  const lines: Int32Array[] = [];
  let current: number[] = [];
  let genCol = 0;
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let name = 0;
  let i = 0;
  const fields: number[] = [];
  const flushSegment = () => {
    if (fields.length === 0) return;
    genCol += fields[0]!;
    if (fields.length >= 4) {
      src += fields[1]!;
      srcLine += fields[2]!;
      srcCol += fields[3]!;
      if (fields.length >= 5) name += fields[4]!;
      current.push(genCol, src, srcLine, srcCol, fields.length >= 5 ? name : -1);
    }
    fields.length = 0;
  };
  while (i <= mappings.length) {
    const ch = i < mappings.length ? mappings.charCodeAt(i) : 59; // treat the end as ';'
    if (ch === 59 /* ; */ || ch === 44 /* , */) {
      flushSegment();
      if (ch === 59) {
        lines.push(Int32Array.from(current));
        current = [];
        genCol = 0;
      }
      i++;
      continue;
    }
    // One base64 VLQ value.
    let value = 0;
    let shift = 0;
    for (;;) {
      const code = mappings.charCodeAt(i++);
      const digit = code < 128 ? B64[code]! : -1;
      if (digit < 0) throw new Error('invalid source map mapping');
      value += (digit & 31) << shift;
      if ((digit & 32) === 0) break;
      shift += 5;
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
  }
  return lines;
}

// line and column are 1-based, as in V8 stack frames.
function lookupParsed(map: ParsedMap, line: number, column: number): Mapped | null {
  const segs = map.lines[line - 1];
  if (segs === undefined || segs.length === 0) return null;
  const col = column - 1;
  let found = -1;
  for (let k = 0; k < segs.length; k += 5) {
    if (segs[k]! <= col) found = k;
    else break;
  }
  if (found < 0) return null;
  const source = map.sources[segs[found + 1]!];
  if (source === undefined) return null;
  const nameIndex = segs[found + 4]!;
  return { file: source, line: segs[found + 2]! + 1, column: segs[found + 3]! + 1, name: nameIndex >= 0 ? (map.names[nameIndex] ?? null) : null };
}

// A repo-relative path where one can be derived: sourceRoot joined with the
// source, webpack:// and file:// prefixes stripped, dot segments resolved.
export function sourcePath(sourceRoot: string | undefined, source: string): string {
  let s = source;
  if (/^webpack:\/\/[^/]*\//.test(s)) s = s.replace(/^webpack:\/\/[^/]*\//, '');
  else if (s.startsWith('file://')) s = decodeURIComponent(s.slice('file://'.length));
  else if (sourceRoot && !/^[a-z]+:\/\//i.test(s)) s = posix.join(sourceRoot, s);
  s = posix.normalize(s);
  if (s.startsWith('./')) s = s.slice(2);
  return s;
}

export function parseMap(json: any): ParsedMap {
  if (json.sections !== undefined) throw new Error('indexed source maps are not supported');
  const sources: string[] = (json.sources ?? []).map((s: string) => sourcePath(json.sourceRoot, s));
  return { sources, names: json.names ?? [], lines: decodeMappings(json.mappings ?? '') };
}

export class SourceMaps {
  private readonly cache = new Map<string, Promise<ParsedMap | null>>();
  private readonly ready = new Map<string, ParsedMap | null>();
  private readonly max: number;

  constructor(max = 32) {
    this.max = max;
  }

  // Synchronous lookup when the map for url is already loaded; undefined
  // means "not loaded yet", null means "no map or no mapping".
  peek(url: string, line: number, column: number): Mapped | null | undefined {
    if (!this.ready.has(url)) return undefined;
    const map = this.ready.get(url)!;
    return map === null ? null : lookupParsed(map, line, column);
  }

  async resolve(url: string, line: number, column: number): Promise<Mapped | null> {
    const map = await this.load(url);
    return map === null ? null : lookupParsed(map, line, column);
  }

  load(url: string): Promise<ParsedMap | null> {
    let p = this.cache.get(url);
    if (p === undefined) {
      if (this.cache.size >= this.max) {
        const oldest = this.cache.keys().next().value!;
        this.cache.delete(oldest);
        this.ready.delete(oldest);
      }
      p = fetchMap(url).catch(() => null);
      p.then((m) => this.ready.set(url, m));
      this.cache.set(url, p);
    }
    return p;
  }
}

async function fetchMap(scriptUrl: string): Promise<ParsedMap | null> {
  if (!/^https?:\/\//.test(scriptUrl)) return null;
  const res = await fetch(scriptUrl);
  if (!res.ok) return null;
  const text = await res.text();
  const m = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(text.slice(-4096));
  if (m === null) return null;
  const ref = m[1]!;
  if (ref.startsWith('data:')) {
    const comma = ref.indexOf(',');
    const meta = ref.slice(0, comma);
    const body = ref.slice(comma + 1);
    const json = meta.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
    return parseMap(JSON.parse(json));
  }
  const mapRes = await fetch(new URL(ref, scriptUrl));
  if (!mapRes.ok) return null;
  return parseMap(await mapRes.json());
}

// Splits a V8 frame location "fn (url:line:col)" or "url:line:col".
export function splitFrame(frame: string): { fn: string | null; url: string; line: number; column: number } | null {
  const m = /^(?:(.*) \()?(.+):(\d+):(\d+)\)?$/.exec(frame);
  if (m === null) return null;
  return { fn: m[1] ?? null, url: m[2]!, line: Number(m[3]), column: Number(m[4]) };
}
