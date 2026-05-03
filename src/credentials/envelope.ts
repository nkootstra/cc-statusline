/**
 * Decode and validate the `claudeAiOauth` credential envelope that Claude Code
 * stores in the macOS keychain or on-disk credential files.
 *
 * Security note (ADV-003): error messages must NEVER include actual token
 * values — only the name of the missing or invalid field.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class InvalidEnvelopeError extends Error {
  constructor(public readonly missingField: string) {
    // Only include the field name — never include token values.
    super(`Credential envelope is missing or invalid: ${missingField}`);
    this.name = 'InvalidEnvelopeError';
  }
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Validate and decode a raw parsed JSON value into `OAuthCredentials`.
 *
 * Expected shape:
 * ```json
 * {
 *   "claudeAiOauth": {
 *     "accessToken": "<non-empty string>",
 *     "refreshToken": "<non-empty string>",
 *     "expiresAt": <finite number, epoch ms>
 *   }
 * }
 * ```
 *
 * @throws {InvalidEnvelopeError} if any required field is absent or has the
 *   wrong type. The error message contains the field name only — no values.
 */
export function decodeEnvelope(json: unknown): OAuthCredentials {
  // Top-level must be a non-null object.
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new InvalidEnvelopeError('claudeAiOauth');
  }

  const top = json as Record<string, unknown>;

  // claudeAiOauth must be a non-null object.
  const oauth = top['claudeAiOauth'];
  if (typeof oauth !== 'object' || oauth === null || Array.isArray(oauth)) {
    throw new InvalidEnvelopeError('claudeAiOauth');
  }

  const inner = oauth as Record<string, unknown>;

  // accessToken: non-empty string.
  const accessToken = inner['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new InvalidEnvelopeError('accessToken');
  }

  // refreshToken: non-empty string.
  const refreshToken = inner['refreshToken'];
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new InvalidEnvelopeError('refreshToken');
  }

  // expiresAt: finite number (epoch ms).
  const expiresAt = inner['expiresAt'];
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new InvalidEnvelopeError('expiresAt');
  }

  return { accessToken, refreshToken, expiresAt };
}
