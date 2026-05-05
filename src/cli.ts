import { runInit } from './subcommands/init';
import { runUninstall } from './subcommands/uninstall';
import { runRefresh } from './subcommands/refresh';
import { runRenderPromax } from './subcommands/render-promax';
import { runRenderEnterprise } from './subcommands/render-enterprise';
import { runDoctor } from './subcommands/doctor';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG_VERSION: string = ((): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

const HELP = `cc-statusline — usage-aware Claude Code statusline + installer

Usage:
  cc-statusline [--plan pro|max|enterprise] [--credentials-path=<path>] [--force]
  cc-statusline init [--plan pro|max|enterprise] [--credentials-path=<path>] [--force]
  cc-statusline uninstall
  cc-statusline render-promax       (invoked by Claude Code; reads stdin)
  cc-statusline render-enterprise   (invoked by Claude Code; reads stdin)
  cc-statusline refresh             (background token + usage refresh)
  cc-statusline doctor              (print cache diagnostics; no credentials)
  cc-statusline --version           (print the installed version)

Pro and Max use the same renderer; Enterprise uses cache-backed OAuth usage.

Run \`npx @nkootstra/cc-statusline --plan pro\` to get started.
`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2];

  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${PKG_VERSION}\n`);
    return 0;
  }

  if (cmd?.startsWith('--') && cmd !== '--help') {
    return runInit(argv.slice(2));
  }

  switch (cmd) {
    case 'init':
      return runInit(argv.slice(3));
    case 'uninstall':
      return runUninstall(argv.slice(3));
    case 'refresh':
      return runRefresh(argv.slice(3));
    case 'render-promax':
      return runRenderPromax();
    case 'render-enterprise':
      return runRenderEnterprise();
    case 'doctor':
      return runDoctor(argv.slice(3));
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

main(process.argv)
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`cc-statusline crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
