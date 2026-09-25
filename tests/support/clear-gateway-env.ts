// Running the suite from inside a gateway-routed Claude Code session would
// otherwise switch every renderer test into model + context only output.
for (const key of [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]) {
  delete process.env[key];
}
