const PROVIDER_FLAGS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function isAnthropicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'anthropic.com' || host.endsWith('.anthropic.com');
}

// Returns a description safe to print: the base URL may embed credentials,
// so only its hostname is ever surfaced.
export function detectGateway(env: NodeJS.ProcessEnv): string | null {
  for (const flag of PROVIDER_FLAGS) {
    if (isTruthyFlag(env[flag])) return flag;
  }

  const baseUrl = env['ANTHROPIC_BASE_URL']?.trim();
  if (!baseUrl) return null;

  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return 'ANTHROPIC_BASE_URL=<unparseable>';
  }
  return isAnthropicHost(hostname) ? null : `ANTHROPIC_BASE_URL=${hostname}`;
}

export function isGatewayMode(env: NodeJS.ProcessEnv): boolean {
  return detectGateway(env) !== null;
}
