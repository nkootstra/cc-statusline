const PKG_VERSION: string = ((): string => {
  try {
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

const HELP = `cc-statusline — usage-aware Claude Code statusline + installer

Usage:
  cc-statusline [--plan pro|max|enterprise] [--credentials-path=<path>] [--non-interactive] [--force]
  cc-statusline init [--plan pro|max|enterprise] [--credentials-path=<path>] [--non-interactive] [--force]
  cc-statusline uninstall
  cc-statusline render-promax       (invoked by Claude Code; reads stdin)
  cc-statusline render-enterprise   (invoked by Claude Code; reads stdin)
  cc-statusline refresh             (background credential + usage refresh)
  cc-statusline doctor [--logs]     (print cache diagnostics; no credentials)
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

  // Each subcommand is imported on demand so the render paths, which run on
  // every prompt, never evaluate the installer, refresher, or their deps.
  if (cmd?.startsWith('--') && cmd !== '--help') {
    const { runInit } = await import('./subcommands/init');
    return runInit(argv.slice(2));
  }

  switch (cmd) {
    case 'init': {
      const { runInit } = await import('./subcommands/init');
      return runInit(argv.slice(3));
    }
    case 'uninstall': {
      const { runUninstall } = await import('./subcommands/uninstall');
      return runUninstall(argv.slice(3));
    }
    case 'refresh': {
      const { runRefresh } = await import('./subcommands/refresh');
      return runRefresh(argv.slice(3));
    }
    case 'render-promax': {
      const { runRenderPromax } = await import('./subcommands/render-promax');
      return runRenderPromax();
    }
    case 'render-enterprise': {
      const { runRenderEnterprise } = await import('./subcommands/render-enterprise');
      return runRenderEnterprise();
    }
    case 'doctor': {
      const { runDoctor } = await import('./subcommands/doctor');
      return runDoctor(argv.slice(3));
    }
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
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`cc-statusline crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
