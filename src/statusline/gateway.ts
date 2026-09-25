const PROVIDER_FLAGS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_VALUES.has(value.trim().toLowerCase());
}

function isAnthropicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'anthropic.com' || host.endsWith('.anthropic.com');
}

export function isGatewayMode(env: NodeJS.ProcessEnv): boolean {
  if (PROVIDER_FLAGS.some((flag) => isTruthyFlag(env[flag]))) return true;

  const baseUrl = env['ANTHROPIC_BASE_URL']?.trim();
  if (!baseUrl) return false;

  try {
    return !isAnthropicHost(new URL(baseUrl).hostname);
  } catch {
    return true;
  }
}
