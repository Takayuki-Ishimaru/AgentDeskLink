import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension/extension.cjs',
  bundle: true,
  external: ['vscode'],
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});
