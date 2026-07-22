import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const MAX_DIAGNOSTIC_LOG_BYTES = 256 * 1024;

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
  await fs.rename(logPath, rotatedPath);
}

export function createDiagnosticLogger(
  logPath: string,
  options: DiagnosticLoggerOptions = {},
): DiagnosticLogger {
  const now = options.now ?? (() => Date.now());
  const pid = options.pid ?? process.pid;

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

        await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
        await rotateIfNeeded(logPath, lineBytes);
        await fs.appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 });
        await fs.chmod(logPath, 0o600);
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
