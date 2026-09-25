import { describe, it, expect } from 'vitest';
import { isGatewayMode } from '../src/statusline/gateway';

describe('isGatewayMode', () => {
  it.each([
    [{}, false],
    [{ ANTHROPIC_BASE_URL: '' }, false],
    [{ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, false],
    [{ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }, false],
    [{ ANTHROPIC_BASE_URL: 'https://API.Anthropic.com' }, false],
    [{ ANTHROPIC_BASE_URL: 'https://gateway.example.com' }, true],
    [{ ANTHROPIC_BASE_URL: 'http://localhost:4000' }, true],
    [{ ANTHROPIC_BASE_URL: 'https://anthropic.com.evil.example' }, true],
    [{ ANTHROPIC_BASE_URL: 'not a url' }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, true],
    [{ CLAUDE_CODE_USE_VERTEX: 'true' }, true],
    [{ CLAUDE_CODE_USE_FOUNDRY: 'TRUE' }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: 'yes' }, true],
    [{ CLAUDE_CODE_USE_VERTEX: 'on' }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: '0' }, false],
    [{ CLAUDE_CODE_USE_VERTEX: '' }, false],
    [{ CLAUDE_CODE_USE_FOUNDRY: 'false' }, false],
  ] as const)('%j -> %s', (env, expected) => {
    expect(isGatewayMode(env)).toBe(expected);
  });
});
