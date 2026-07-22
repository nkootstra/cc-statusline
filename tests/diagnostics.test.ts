import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createDiagnosticLogger,
  MAX_DIAGNOSTIC_LOG_BYTES,
  readDiagnosticLog,
} from '../src/diagnostics/logger';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-diagnostics-test-'));
}

describe('diagnostic logger', () => {
  it('writes structured events with restrictive file permissions', async () => {
    const tmpDir = makeTmpDir();
    const logPath = path.join(tmpDir, 'debug.log');

    await createDiagnosticLogger(logPath, { now: () => 1_700_000_000_000 }).log({
      event: 'refresh.started',
      reason: 'stale-cache',
    });

    const line = fs.readFileSync(logPath, 'utf8').trim();
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(event).toMatchObject({
      timestamp: '2023-11-14T22:13:20.000Z',
      event: 'refresh.started',
      reason: 'stale-cache',
    });
    expect(typeof event['pid']).toBe('number');
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('rotates the active log when it exceeds the configured bound', async () => {
    const tmpDir = makeTmpDir();
    const logPath = path.join(tmpDir, 'debug.log');
    fs.writeFileSync(logPath, 'x'.repeat(MAX_DIAGNOSTIC_LOG_BYTES), { mode: 0o600 });

    await createDiagnosticLogger(logPath, { now: () => 1_700_000_000_000 }).log({
      event: 'refresh.completed',
      result: 'success',
    });

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.statSync(`${logPath}.1`).size).toBe(MAX_DIAGNOSTIC_LOG_BYTES);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('refresh.completed');
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LOG_BYTES);
  });

  it('reads retained history in chronological file order', async () => {
    const tmpDir = makeTmpDir();
    const logPath = path.join(tmpDir, 'debug.log');
    fs.writeFileSync(`${logPath}.1`, '{"event":"old"}\n', { mode: 0o600 });
    fs.writeFileSync(logPath, '{"event":"new"}\n', { mode: 0o600 });

    const output = await readDiagnosticLog(logPath);
    expect(output).toBe('{"event":"old"}\n{"event":"new"}\n');
  });
});
