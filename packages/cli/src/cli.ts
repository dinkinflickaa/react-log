import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { capture, captureEndpoint, loadConfig, watch } from '../../capture/src/index.ts';

interface Command {
  name: string;
  usage: string;
  summary: string;
  phase: number;
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'capture',
    usage: 'capture [--cdp <url> | --launch <url>] [--url-match <text>] [--reload] [--isolate] [--headless] [--segments <dir>] [--for <seconds>]',
    summary: 'Attach to a page over CDP and write the render log to segments until stopped.',
    phase: 2,
  },
  {
    name: 'watch',
    usage: 'watch <name|id>... [--clear] [--cdp <url>] [--url-match <text>] [--segments <dir>]',
    summary: "Add components to the running capture's watch list, to record changed_keys.",
    phase: 2,
  },
  {
    name: 'sessions',
    usage: 'sessions',
    summary: 'List captured sessions, newest first.',
    phase: 3,
  },
  {
    name: 'top',
    usage: 'top --session <id> [--measure <name>]',
    summary: 'Rank the most expensive commits in a session.',
    phase: 3,
  },
  {
    name: 'card',
    usage: 'card <commit_id>',
    summary: 'Explain one commit: cause, extent, self cost and effects.',
    phase: 3,
  },
  {
    name: 'query',
    usage: 'query "<sql>"',
    summary: 'Run SQL on the segments with the standard views loaded.',
    phase: 3,
  },
];

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    'Usage: react-log <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Options:',
    '  --config <path>  Config file (default: ./react-log.config.json)',
    "  -h, --help       Show help, or a command's usage with <command> --help",
    '  --version        Print the version',
    '',
  ].join('\n');
}

const err = (line: string) => process.stderr.write(`${line}\n`);

async function runCapture(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      cdp: { type: 'string' },
      'url-match': { type: 'string' },
      launch: { type: 'string' },
      reload: { type: 'boolean' },
      isolate: { type: 'boolean' },
      headless: { type: 'boolean' },
      segments: { type: 'string' },
      duckdb: { type: 'string' },
      for: { type: 'string' },
      config: { type: 'string' },
    },
  });
  const config = loadConfig(values.config);
  const abort = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    if (++interrupts > 1) process.exit(130);
    err('react-log: stopping; finishing the current segments (Ctrl-C again to quit now)');
    abort.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const result = await capture({
      config,
      cdp: values.cdp,
      urlMatch: values['url-match'],
      launch: values.launch,
      reload: values.reload,
      isolate: values.isolate,
      headless: values.headless,
      segments: values.segments,
      duckdb: values.duckdb,
      durationMs: values.for === undefined ? undefined : Number(values.for) * 1000,
      signal: abort.signal,
    });
    if (result.sessions.length === 0) err('react-log: nothing was captured');
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function runWatch(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      cdp: { type: 'string' },
      'url-match': { type: 'string' },
      segments: { type: 'string' },
      clear: { type: 'boolean' },
      config: { type: 'string' },
    },
  });
  if (positionals.length === 0 && values.clear !== true) {
    err('Usage: react-log watch <name|id>... [--clear]');
    return 1;
  }
  const config = loadConfig(values.config);
  const endpoint = captureEndpoint(values.segments ?? config.segments.dir, values.cdp);
  const updated = await watch(positionals, { endpoint, urlMatch: values['url-match'] ?? config.urlMatch, clear: values.clear });
  err(`react-log: watch list updated on ${updated} page(s)`);
  return updated > 0 ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '-h' || name === '--help' || name === 'help') {
    process.stdout.write(helpText());
    return 0;
  }
  if (name === '--version') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) {
    err(`react-log: unknown command "${name}". Run react-log --help.`);
    return 1;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`Usage: react-log ${command.usage}\n\n${command.summary}\n`);
    return 0;
  }
  try {
    if (command.name === 'capture') return await runCapture(rest);
    if (command.name === 'watch') return await runWatch(rest);
  } catch (e) {
    err(`react-log ${command.name}: ${(e as Error).message}`);
    return 1;
  }
  err(`react-log ${command.name}: not implemented yet (Phase ${command.phase} in PLAN.md).`);
  return 2;
}
