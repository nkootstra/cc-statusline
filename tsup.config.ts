import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  target: 'node18',
  outDir: 'dist',
  outExtension: () => ({ js: '.cjs' }),
  minify: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  noExternal: ['write-file-atomic'],
  banner: { js: '#!/usr/bin/env node' },
});
