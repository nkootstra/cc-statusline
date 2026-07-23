import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const MAX_DIAGNOSTIC_LOG_BYTES = 256 * 1024;
const LOCK_TIMEOUT_MS = 200;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 5_000;

export interface DiagnosticLoggerOptions {
  now?: () => number;
  pid?: number;
}

export interface DiagnosticLogger {
  log(details: Record<string, unknown>): Promise<void>;
}

export function defaultDiagnosticLogPath(cachePath: string): string {
  return path.join(path.dirname(cachePath), 'debug.log');
}

export function defaultDiagnosticLogLockPath(logPath: string): string {
  const safe = Buffer.from(logPath).toString('hex');
  return path.join(os.tmpdir(), 'cc-statusline-diagnostics', `${safe}.lock`);
}

export function defaultDiagnosticLogDisabledPath(logPath: string): string {
  return `${logPath}.disabled`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return false;
  }
}

async function cleanupStaleLock(lockPath: string): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return;
    await fs.rm(lockPath, { force: true, recursive: true });
  } catch {
    // Stale lock cleanup is best-effort.
  }
}

export async function withDiagnosticLogLock<T>(
  logPath: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  const logDir = path.dirname(logPath);
  if (!(await exists(logDir))) return undefined;

  const lockPath = defaultDiagnosticLogLockPath(logPath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700, recursive: true });
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        if (Date.now() > deadline) {
          await cleanupStaleLock(lockPath);
        }
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      if (code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  try {
    return await action();
  } finally {
    await fs.rm(lockPath, { force: true, recursive: true });
  }
}

async function rotateIfNeeded(logPath: string, nextLineBytes: number): Promise<void> {
  let currentSize = 0;
  try {
    currentSize = (await fs.stat(logPath)).size;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (currentSize === 0 || currentSize + nextLineBytes <= MAX_DIAGNOSTIC_LOG_BYTES) {
    return;
  }

  const rotatedPath = `${logPath}.1`;
  await fs.rm(rotatedPath, { force: true });
  try {
    await fs.rename(logPath, rotatedPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function createDiagnosticLogger(
  logPath: string,
  options: DiagnosticLoggerOptions = {},
): DiagnosticLogger {
  const now = options.now ?? (() => Date.now());
  const pid = options.pid ?? process.pid;
  const disabledPath = defaultDiagnosticLogDisabledPath(logPath);
  const logDir = path.dirname(logPath);

  return {
    async log(details: Record<string, unknown>): Promise<void> {
      try {
        const event = {
          timestamp: new Date(now()).toISOString(),
          pid,
          ...details,
        };
        const line = JSON.stringify(event) + '\n';
        const lineBytes = Buffer.byteLength(line, 'utf8');

        if (!(await exists(logDir))) return;
        if (await exists(disabledPath)) return;

        await withDiagnosticLogLock(logPath, async () => {
          if (!(await exists(logDir))) return;
          if (await exists(disabledPath)) return;

          await rotateIfNeeded(logPath, lineBytes);
          await fs.appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 });
          await fs.chmod(logPath, 0o600);
        });
      } catch {
        // Diagnostics must never change the statusline or refresh outcome.
      }
    },
  };
}

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    return '';
  }
}

export async function readDiagnosticLog(logPath: string): Promise<string> {
  return (await readIfPresent(`${logPath}.1`)) + (await readIfPresent(logPath));
}
