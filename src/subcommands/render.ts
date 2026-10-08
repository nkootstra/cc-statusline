import { parseStdin, readStdin, type StatuslineInput } from '../statusline/stdin';
import { readCache, defaultCachePath } from '../cache/store';
import { isGatewayMode } from '../statusline/gateway';
import { buildIdentityRow } from '../statusline/identity-row';
import { buildSubscriptionUsageRow, hasCachedWindows } from '../statusline/subscription-row';
import { buildCachedUsageRow } from '../statusline/cached-usage-row';
import { getStaleThresholdMs } from '../statusline/usage-status';
import {
  defaultSpawnFn,
  startBackgroundRefresh,
  type SpawnFn,
} from './background-refresh';

// A credits-only cache next to a subscription payload most likely belongs to
// the account the user just switched away from. Refresh it well before the
// normal stale threshold, but not on every render in case the API keeps
// answering that way for this account.
const FOREIGN_CACHE_REFRESH_MS = 60 * 1000;

export interface RenderDeps {
  cachePath?: string;
  bundlePath?: string;
  spawnRefresh?: SpawnFn;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

function hasPayloadWindows(input: StatuslineInput): boolean {
  return input.rate_limits?.five_hour !== undefined ||
    input.rate_limits?.seven_day !== undefined;
}

// Takes no arguments: settings written by older installs may still pass
// `--payload-only`, and that line must keep rendering.
export async function runRender(
  stdinSource: NodeJS.ReadableStream = process.stdin,
  deps: RenderDeps = {},
): Promise<number> {
  const raw = await readStdin(stdinSource);
  const input = raw === null ? null : parseStdin(raw);
  if (!input) {
    process.stdout.write('\n');
    return 0;
  }

  const identityRow = buildIdentityRow(input);

  // Subscription usage does not apply behind a gateway, and the OAuth
  // credentials the refresh needs may not exist at all.
  if (isGatewayMode(deps.env ?? process.env)) {
    process.stdout.write(identityRow + '\n');
    return 0;
  }

  const cachePath = deps.cachePath ?? defaultCachePath();
  const nowMs = (deps.now ?? (() => Date.now()))();
  const staleThresholdMs = getStaleThresholdMs();
  const cache = readCache(cachePath);

  let usageRow: string;
  let refreshThresholdMs = staleThresholdMs;
  if (hasPayloadWindows(input)) {
    const usage = cache?.usage ?? null;
    const foreign = usage !== null && !hasCachedWindows(usage);
    if (foreign) {
      refreshThresholdMs = Math.min(staleThresholdMs, FOREIGN_CACHE_REFRESH_MS);
    }
    usageRow = buildSubscriptionUsageRow(
      input,
      cache,
      foreign ? null : usage,
      nowMs,
      staleThresholdMs,
    );
  } else {
    usageRow = buildCachedUsageRow(cache, nowMs, staleThresholdMs, input.cost.total_cost_usd);
  }

  // Print before touching the lock so concurrent sessions never wait on
  // each other to show a line; the refresh claim is a side effect.
  process.stdout.write(identityRow + '\n' + usageRow + '\n');

  await startBackgroundRefresh({
    cache,
    cachePath,
    bundlePath: deps.bundlePath ?? __filename,
    spawnFn: deps.spawnRefresh ?? defaultSpawnFn(),
    nowMs,
    staleThresholdMs: refreshThresholdMs,
  });
  return 0;
}
