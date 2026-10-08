import { parseStdin, readStdin, type StatuslineInput } from '../statusline/stdin';
import {
  SEP,
  STALE_MARKER,
  applyDim,
} from '../statusline/format';
import { readCache, defaultCachePath, type Cache } from '../cache/store';
import type { UsageResponse } from '../oauth/types';
import { modelScopedWindows } from '../oauth/usage';
import { buildModelScopedSegments } from '../statusline/model-scoped';
import { isGatewayMode } from '../statusline/gateway';
import {
  buildCostSegment,
  buildIdentityRow,
  buildPayloadUsageRow,
  buildPayloadWindowSegments,
} from './render-promax';
import {
  buildAuthHint,
  buildCacheUsageRow,
  defaultSpawnFn,
  getStaleThresholdMs,
  hasCreditUsage,
  isCacheStale,
  startBackgroundRefresh,
  type SpawnFn,
} from './render-enterprise';

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

export function hasCachedWindows(usage: UsageResponse): boolean {
  return (usage.five_hour !== null && usage.five_hour !== undefined) ||
    (usage.seven_day !== null && usage.seven_day !== undefined);
}

function buildExtraSpendSegment(usage: UsageResponse): string {
  const extra = usage.extra_usage;
  if (extra?.is_enabled !== true || !hasCreditUsage(extra)) return '';
  const usedDisplay = (extra.used_credits / 100).toFixed(2);
  const limitDisplay = (extra.monthly_limit / 100).toFixed(2);
  return `extra $${usedDisplay} / $${limitDisplay}`;
}

function buildSubscriptionUsageRow(
  input: StatuslineInput,
  cache: Cache | null,
  usage: UsageResponse | null,
  nowMs: number,
  staleThresholdMs: number,
): string {
  const windows = buildPayloadWindowSegments(input);

  let cachedSegs: string[] = [];
  if (usage !== null) {
    cachedSegs = [
      ...(windows.modelScoped === undefined
        ? buildModelScopedSegments(modelScopedWindows(usage), {
          now: nowMs,
          sharedResetHint: windows.sevenDayHint,
        })
        : []),
      buildExtraSpendSegment(usage),
    ].filter(Boolean);
  }

  let cachedText = cachedSegs.join(SEP);
  if (cachedText !== '') {
    if (isCacheStale(cache, nowMs, staleThresholdMs)) {
      cachedText = applyDim(cachedText) + STALE_MARKER;
    } else if (cache?.authState === 'fatal') {
      cachedText = applyDim(cachedText);
    }
  }

  return [
    windows.fiveHour,
    windows.sevenDay,
    ...(windows.modelScoped ?? []),
    cachedText,
    buildCostSegment(input.cost.total_cost_usd),
  ].filter(Boolean).join(SEP) + buildAuthHint(cache, nowMs);
}

function joinRows(identityRow: string, usageRow: string): string {
  return identityRow + '\n' + usageRow + '\n';
}

export async function runRender(
  args: string[] = [],
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

  if (args.includes('--payload-only')) {
    process.stdout.write(joinRows(identityRow, buildPayloadUsageRow(input)));
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
    usageRow = buildCacheUsageRow(cache, nowMs, staleThresholdMs, input.cost.total_cost_usd);
  }

  // Print before touching the lock so concurrent sessions never wait on
  // each other to show a line; the refresh claim is a side effect.
  process.stdout.write(joinRows(identityRow, usageRow));

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

export function runRenderPromax(
  args: string[] = [],
  stdinSource: NodeJS.ReadableStream = process.stdin,
  deps: RenderDeps = {},
): Promise<number> {
  return runRender(['--payload-only', ...args], stdinSource, deps);
}

export function runRenderEnterprise(
  args: string[] = [],
  stdinSource: NodeJS.ReadableStream = process.stdin,
  deps: RenderDeps = {},
): Promise<number> {
  return runRender(args, stdinSource, deps);
}
