import { parseStdin, readStdin } from '../statusline/stdin';
import {
  SEP,
  MISSING,
  colorTier,
  applyColor,
  formatResetHint,
  formatOptionalHint,
  chooseLayout,
} from '../statusline/format';
import { buildModelScopedSegments } from '../statusline/model-scoped';
import { isGatewayMode } from '../statusline/gateway';

export interface RenderPromaxDeps {
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Segment builders
// ---------------------------------------------------------------------------

function buildModelSegment(displayName: string): string {
  return displayName || MISSING;
}

function buildCtxSegment(usedPercentage: number | null | undefined): string {
  if (usedPercentage === null || usedPercentage === undefined) {
    return '';
  }
  const pct = Math.round(usedPercentage);
  const tier = colorTier(pct);
  return `ctx ${applyColor(`${pct}%`, tier)}`;
}

function buildRateLimitSegment(
  label: string,
  usedPercentage: number | undefined,
  hint: string,
): string {
  if (usedPercentage === undefined) {
    return `${label} ${MISSING}`;
  }
  const pct = Math.round(usedPercentage);
  const tier = colorTier(pct);
  return [label, applyColor(`${pct}%`, tier), formatOptionalHint(hint)]
    .filter(Boolean)
    .join(' ');
}

function buildCostSegment(totalCostUsd: number): string {
  if (totalCostUsd === 0) return '';
  return `$${totalCostUsd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderLine(input: ReturnType<typeof parseStdin>, gatewayMode: boolean): string {
  if (!input) return '';

  const modelSeg = buildModelSegment(input.model.display_name);
  const ctxSeg = buildCtxSegment(input.context_window?.used_percentage);
  if (gatewayMode) {
    return [modelSeg, ctxSeg].filter(Boolean).join(SEP) + '\n';
  }

  const fiveHour = input.rate_limits?.five_hour;
  const fiveHourSeg = buildRateLimitSegment(
    '5h',
    fiveHour?.used_percentage,
    formatResetHint(fiveHour?.resetsAt ?? null),
  );
  const sevenDay = input.rate_limits?.seven_day;
  const sevenDayHint = formatResetHint(sevenDay?.resetsAt ?? null);
  const sevenDaySeg = buildRateLimitSegment('7d', sevenDay?.used_percentage, sevenDayHint);
  const modelScopedSegs = buildModelScopedSegments(input.rate_limits?.model_scoped, {
    sharedResetHint: sevenDayHint,
  });
  const costSeg = buildCostSegment(input.cost.total_cost_usd);

  const layout = chooseLayout(process.stdout.columns);

  if (layout === 'wide') {
    return [modelSeg, ctxSeg, fiveHourSeg, sevenDaySeg, ...modelScopedSegs, costSeg]
      .filter(Boolean)
      .join(SEP) + '\n';
  }

  // Narrow layout: split into two lines.
  // Row 1: model · ctx
  // Row 2: 5h · 7d · <model-scoped windows> · $cost
  const row1 = [modelSeg, ctxSeg].filter(Boolean).join(SEP);
  const row2 = [fiveHourSeg, sevenDaySeg, ...modelScopedSegs, costSeg].filter(Boolean).join(SEP);
  return row1 + '\n' + row2 + '\n';
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * `render-promax` subcommand entrypoint.
 *
 * Reads stdin, formats one line of output, prints to stdout, exits.
 * Zero network calls, zero credential access, zero file I/O beyond stdin.
 *
 * @param _args    CLI args after the subcommand name (unused; accepted for
 *                 forward-compatibility with the dispatcher signature).
 * @param stdinSource  Override stdin for testing. Defaults to `process.stdin`.
 */
export async function runRenderPromax(
  _args: string[] = [],
  stdinSource: NodeJS.ReadableStream = process.stdin,
  deps: RenderPromaxDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const raw = await readStdin(stdinSource);

  if (raw === null) {
    // Timeout — fail blank per blank-on-failure semantics.
    process.stdout.write('\n');
    return 0;
  }

  const input = parseStdin(raw);

  if (!input) {
    // Non-JSON or empty stdin — silent fallback.
    process.stdout.write('\n');
    return 0;
  }

  const line = renderLine(input, isGatewayMode(env));
  process.stdout.write(line);
  return 0;
}
