import { readFileSync } from 'node:fs';

interface Command {
  name: string;
  usage: string;
  summary: string;
  phase: number;
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'capture',
    usage: 'capture [--cdp <url>] [--url-match <text>] [--launch <url>] [--reload] [--isolate]',
    summary: 'Attach to a page over CDP and write the render log to segments until stopped.',
    phase: 2,
  },
  {
    name: 'watch',
    usage: 'watch <name|id>',
    summary: 'Add a component to the running capture\'s watch list, to record changed_keys.',
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
    '  -h, --help       Show help, or a command\'s usage with <command> --help',
    '  --version        Print the version',
    '',
  ].join('\n');
}

export function main(argv: readonly string[]): number {
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
    process.stderr.write(`react-log: unknown command "${name}". Run react-log --help.\n`);
    return 1;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`Usage: react-log ${command.usage}\n\n${command.summary}\n`);
    return 0;
  }
  process.stderr.write(`react-log ${command.name}: not implemented yet (Phase ${command.phase} in PLAN.md).\n`);
  return 2;
}
