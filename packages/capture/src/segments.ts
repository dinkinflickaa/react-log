import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { columnsLiteral, emptySelect, type Family, FAMILIES, sqlString } from './schema.ts';

export interface SegmentOptions {
  rotateSeconds: number;
  rotateRows: number;
  duckdb: string;
  onError?: (e: Error) => void;
}

// Writes one session's rows as NDJSON temp files and, every rotateSeconds or
// rotateRows event rows, converts each family's file to Parquet with the
// DuckDB CLI. Parquet is written under a dot-prefixed temp name and renamed
// into place, so a reader's glob never sees a partial file.
export class SegmentWriter {
  readonly dir: string;
  private readonly opts: SegmentOptions;
  private seq = 0;
  private streams = new Map<Family, { stream: WriteStream; path: string; rows: number }>();
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  rowsWritten = 0;
  filesWritten = 0;

  constructor(dir: string, opts: SegmentOptions) {
    this.dir = dir;
    this.opts = opts;
  }

  // Empty seq-0 files for every family, so views never fail on an empty glob.
  async init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    for (const family of FAMILIES) {
      const out = join(this.dir, `${family}-00000.parquet`);
      if (!existsSync(out)) await this.copyToParquet(emptySelect(family), out);
    }
    this.timer = setInterval(() => this.rotate(), this.opts.rotateSeconds * 1000);
    this.timer.unref();
  }

  write(family: Family, row: object): void {
    let s = this.streams.get(family);
    if (s === undefined) {
      const path = join(this.dir, `.tmp-${family}-${String(this.seq + 1).padStart(5, '0')}.ndjson`);
      s = { stream: createWriteStream(path), path, rows: 0 };
      this.streams.set(family, s);
    }
    s.stream.write(`${JSON.stringify(row)}\n`);
    s.rows++;
    if (family === 'seg') {
      this.rowsWritten++;
      if (s.rows >= this.opts.rotateRows) this.rotate();
    }
  }

  // Closes the current files and queues their conversion. Returns when this
  // rotation's files are in place.
  rotate(): Promise<void> {
    if (this.streams.size === 0) return this.queue;
    this.seq++;
    const seq = String(this.seq).padStart(5, '0');
    const closing = [...this.streams.entries()];
    this.streams = new Map();
    for (const [family, s] of closing) {
      const closed = new Promise<void>((resolve) => s.stream.end(resolve));
      this.queue = this.queue.then(async () => {
        await closed;
        const out = join(this.dir, `${family}-${seq}.parquet`);
        try {
          await this.copyToParquet(
            `SELECT * FROM read_json(${sqlString(s.path)}, format = 'newline_delimited', columns = ${columnsLiteral(family)})`,
            out,
          );
          rmSync(s.path, { force: true });
        } catch (e) {
          // Keep the NDJSON for recovery and carry on.
          this.opts.onError?.(e as Error);
        }
      });
    }
    return this.queue;
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.rotate();
    await this.queue;
  }

  private copyToParquet(select: string, out: string): Promise<void> {
    const tmp = join(this.dir, `.tmp-${out.split(/[\\/]/).pop()}`);
    const sql = `COPY (${select}) TO ${sqlString(tmp)} (FORMAT parquet, COMPRESSION zstd);`;
    return new Promise((resolve, reject) => {
      execFile(this.opts.duckdb, [':memory:', '-c', sql], { maxBuffer: 16 << 20 }, (err, _stdout, stderr) => {
        if (err) {
          rmSync(tmp, { force: true });
          reject(new Error(`duckdb failed writing ${out}: ${stderr || err.message}`));
          return;
        }
        renameSync(tmp, out);
        this.filesWritten++;
        resolve();
      });
    });
  }
}
