import { Readable } from 'node:stream';
import { parseStdin } from '../statusline/stdin';
import {
  SEP,
  MISSING,
  colorTier,
  applyColor,
  formatResetHint,
  formatOptionalHint,
  chooseLayout,
} from '../statusline/format';

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

/**
 * Read all data from `source` to a string, with a hard 1-second timeout.
 *
 * Returns `null` if EOF is not reached within the timeout (something is wrong —
 * Claude Code closes stdin promptly after writing; a long wait means a hang).
 */
function readStream(source: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, 1000);

    source.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    source.on('end', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });

    source.on('error', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
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
  resetsAt: number | undefined,
): string {
  if (usedPercentage === undefined) {
    return `${label} ${MISSING}`;
  }
  const pct = Math.round(usedPercentage);
  const tier = colorTier(pct);
  const hint = formatResetHint(resetsAt ?? null);
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

function renderLine(input: ReturnType<typeof parseStdin>): string {
  if (!input) return '';

  const modelSeg = buildModelSegment(input.model.display_name);
  const ctxSeg = buildCtxSegment(input.context_window?.used_percentage);
  const fiveHourSeg = buildRateLimitSegment(
    '5h',
    input.rate_limits?.five_hour?.used_percentage,
    input.rate_limits?.five_hour?.resetsAt,
  );
  const sevenDaySeg = buildRateLimitSegment(
    '7d',
    input.rate_limits?.seven_day?.used_percentage,
    input.rate_limits?.seven_day?.resetsAt,
  );
  const costSeg = buildCostSegment(input.cost.total_cost_usd);

  const layout = chooseLayout(process.stdout.columns);

  if (layout === 'wide') {
    return [modelSeg, ctxSeg, fiveHourSeg, sevenDaySeg, costSeg].filter(Boolean).join(SEP) + '\n';
  }

  // Narrow layout: split into two lines.
  // Row 1: model · ctx
  // Row 2: 5h · 7d · $cost
  const row1 = [modelSeg, ctxSeg].filter(Boolean).join(SEP);
  const row2 = [fiveHourSeg, sevenDaySeg, costSeg].filter(Boolean).join(SEP);
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
): Promise<number> {
  const raw = await readStream(stdinSource);

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

  const line = renderLine(input);
  process.stdout.write(line);
  return 0;
}
