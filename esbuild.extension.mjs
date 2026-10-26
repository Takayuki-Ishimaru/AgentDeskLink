import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension/extension.cjs',
  bundle: true,
  external: ['vscode'],
  platform: 'node',
  // jsonc-parser's UMD factory contains relative runtime requires; bundle its
  // published ESM entry so the VSIX remains self-contained.
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});
