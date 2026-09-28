import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Finds a Chrome or Chromium binary: the explicit path, CHROME_PATH,
// Playwright's Chromium, then the usual install locations.
export function findChrome(explicit?: string | null): string | null {
  for (const p of [explicit, process.env.CHROME_PATH]) if (p && existsSync(p)) return p;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (existsSync(pw)) {
    for (const dir of readdirSync(pw).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const bin of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = join(pw, dir, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface LaunchOptions {
  chromePath?: string | null;
  // Always a dedicated directory: branded Chrome 136+ refuses CDP on the
  // default profile.
  userDataDir: string;
  headless?: boolean;
  args?: string[];
}

export interface LaunchedChrome {
  wsUrl: string;
  pid: number;
  exited: Promise<number | null>;
  close(): Promise<void>;
}

export async function launchChrome(opts: LaunchOptions): Promise<LaunchedChrome> {
  const bin = findChrome(opts.chromePath);
  if (bin === null) throw new Error('No Chrome or Chromium found. Set launch.chromePath in react-log.config.json or CHROME_PATH.');
  mkdirSync(opts.userDataDir, { recursive: true });
  const args = [
    `--user-data-dir=${opts.userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...(opts.headless ? ['--headless', '--disable-gpu'] : []),
    // Chromium cannot sandbox when run as root, as in containers.
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    '--disable-dev-shm-usage',
    ...(opts.args ?? []),
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  let stderr = '';
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Chrome did not report a DevTools endpoint within 30 s. Is another Chrome using ${opts.userDataDir}?\n${stderr.slice(-2000)}`)),
      30_000,
    );
    proc.stderr!.on('data', (d) => {
      stderr += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m !== null) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with code ${code} before it was ready. Is another Chrome using ${opts.userDataDir}?\n${stderr.slice(-2000)}`));
    });
  });
  proc.stderr!.resume();
  return {
    wsUrl,
    pid: proc.pid!,
    exited,
    async close() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}
