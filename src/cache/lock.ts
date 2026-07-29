import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const RETRY_INTERVAL_MS = 10;
const ACQUIRE_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 2 * 60 * 1000;

interface LockIdentity {
  pid: number;
  createdAt: number;
  token: string;
}

interface LockTicket extends LockIdentity {
  ticket: number;
}

interface LockJson {
  pid?: unknown;
  createdAt?: unknown;
  token?: unknown;
  ticket?: unknown;
}

interface LockState {
  choosing: LockIdentity[];
  tickets: LockTicket[];
}

function parseLockJson(raw: string): LockJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as LockJson;
}

function identityFrom(candidate: LockJson): LockIdentity | null {
  if (
    typeof candidate.pid !== 'number' ||
    !Number.isInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.token !== 'string' ||
    candidate.token.length === 0
  ) {
    return null;
  }
  return {
    pid: candidate.pid,
    createdAt: candidate.createdAt,
    token: candidate.token,
  };
}

function parseIdentity(raw: string): LockIdentity | null {
  const candidate = parseLockJson(raw);
  return candidate === null ? null : identityFrom(candidate);
}

function parseTicket(raw: string): LockTicket | null {
  const candidate = parseLockJson(raw);
  const identity = candidate === null ? null : identityFrom(candidate);
  if (
    identity === null ||
    candidate === null ||
    typeof candidate.ticket !== 'number' ||
    !Number.isInteger(candidate.ticket) ||
    candidate.ticket <= 0
  ) {
    return null;
  }
  return { ...identity, ticket: candidate.ticket };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isLive(identity: LockIdentity, now: number): boolean {
  return (
    processIsAlive(identity.pid) &&
    now - identity.createdAt < STALE_LOCK_MS
  );
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeEmptyDirectory(dirPath: string): Promise<void> {
  try {
    await fs.promises.rmdir(dirPath);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}

async function removeMalformedIfStale(
  filePath: string,
  now: number,
): Promise<void> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (now - stat.mtimeMs >= STALE_LOCK_MS) {
      await removeFile(filePath);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readLockState(lockDir: string, now: number): Promise<LockState> {
  const entries = await fs.promises.readdir(lockDir, { withFileTypes: true });
  const state: LockState = { choosing: [], tickets: [] };

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const entryPath = path.join(lockDir, entry.name);
    if (entry.name.endsWith('.pending')) {
      await removeMalformedIfStale(entryPath, now);
      continue;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(entryPath, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    if (entry.name.endsWith('.choosing')) {
      const identity = parseIdentity(raw);
      if (identity === null) {
        await removeMalformedIfStale(entryPath, now);
      } else if (isLive(identity, now)) {
        state.choosing.push(identity);
      } else {
        await removeFile(entryPath);
      }
      continue;
    }

    if (entry.name.endsWith('.ticket')) {
      const ticket = parseTicket(raw);
      if (ticket === null) {
        await removeMalformedIfStale(entryPath, now);
      } else if (isLive(ticket, now)) {
        state.tickets.push(ticket);
      } else {
        await removeFile(entryPath);
      }
      continue;
    }

    await removeMalformedIfStale(entryPath, now);
  }

  state.tickets.sort(
    (left, right) =>
      left.ticket - right.ticket ||
      left.token.localeCompare(right.token),
  );
  return state;
}

async function publish(
  lockDir: string,
  name: string,
  content: LockIdentity | LockTicket,
): Promise<string> {
  const destination = path.join(lockDir, name);
  const pending = path.join(lockDir, `${name}.pending`);

  while (true) {
    await fs.promises.mkdir(lockDir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.writeFile(pending, JSON.stringify(content), {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.promises.rename(pending, destination);
      return destination;
    } catch (error: unknown) {
      await removeFile(pending);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function acquire(cachePath: string): Promise<() => Promise<void>> {
  const lockDir = `${cachePath}.locks`;
  await fs.promises.mkdir(path.dirname(cachePath), {
    recursive: true,
    mode: 0o700,
  });

  const identity: LockIdentity = {
    pid: process.pid,
    createdAt: Date.now(),
    token: randomUUID(),
  };
  const choosingPath = await publish(
    lockDir,
    `${identity.token}.choosing`,
    identity,
  );
  let ticketPath: string | undefined;

  try {
    // Declaring ticket selection first prevents a later contender from
    // overtaking a writer that has already chosen its place in the queue.
    const current = await readLockState(lockDir, Date.now());
    const ticket = current.tickets.reduce(
      (highest, contender) => Math.max(highest, contender.ticket),
      0,
    ) + 1;
    const contender: LockTicket = { ...identity, ticket };
    ticketPath = await publish(
      lockDir,
      `${identity.token}.ticket`,
      contender,
    );
    await removeFile(choosingPath);

    const startedAt = Date.now();
    while (true) {
      const state = await readLockState(lockDir, Date.now());
      const first = state.tickets[0];
      if (
        state.choosing.length === 0 &&
        first?.token === identity.token
      ) {
        const ownedTicketPath = ticketPath;
        return async () => {
          await removeFile(ownedTicketPath);
          await removeEmptyDirectory(lockDir);
        };
      }

      if (!state.tickets.some((entry) => entry.token === identity.token)) {
        throw new Error(`Cache lock contender disappeared: ${ticketPath}`);
      }
      if (Date.now() - startedAt >= ACQUIRE_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for cache lock: ${cachePath}`);
      }
      await delay(RETRY_INTERVAL_MS);
    }
  } catch (error: unknown) {
    await removeFile(choosingPath);
    if (ticketPath !== undefined) await removeFile(ticketPath);
    await removeEmptyDirectory(lockDir);
    throw error;
  }
}

export async function withCacheLock<T>(
  cachePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquire(cachePath);
  try {
    return await operation();
  } finally {
    await release();
  }
}
