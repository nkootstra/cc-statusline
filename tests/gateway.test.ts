import { describe, it, expect } from 'vitest';
import { detectGateway, isGatewayMode } from '../src/statusline/gateway';

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
    [{ CLAUDE_CODE_USE_BEDROCK: '0' }, false],
    [{ CLAUDE_CODE_USE_VERTEX: '' }, false],
    [{ CLAUDE_CODE_USE_FOUNDRY: 'false' }, false],
  ] as const)('%j -> %s', (env, expected) => {
    expect(isGatewayMode(env)).toBe(expected);
  });
});

describe('detectGateway', () => {
  it('reports only the hostname of a custom base URL', () => {
    expect(detectGateway({ ANTHROPIC_BASE_URL: 'https://user:secret@gw.example.com/v1?key=abc' }))
      .toBe('ANTHROPIC_BASE_URL=gw.example.com');
  });

  it('does not echo an unparseable base URL', () => {
    expect(detectGateway({ ANTHROPIC_BASE_URL: 'secret-token-not-a-url' }))
      .toBe('ANTHROPIC_BASE_URL=<unparseable>');
  });

  it('names the provider flag', () => {
    expect(detectGateway({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('CLAUDE_CODE_USE_BEDROCK');
  });

  it('returns null without a gateway', () => {
    expect(detectGateway({})).toBeNull();
  });
});
