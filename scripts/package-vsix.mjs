import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prepareRuntime } from './prepare-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const target = `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'].includes(target)) {
  throw new Error(`Unsupported VSIX target: ${target}`);
}
await mkdir(path.join(root, 'artifacts'), { recursive: true });
// Runtime preparation must succeed before we create a distributable archive.
await prepareRuntime({ root, target });
// Sharp includes platform-native dependencies. Mark the package for this host instead of
// offering its binary dependencies as a universal extension for other operating systems.
const { createVSIX } = createRequire(import.meta.url)('@vscode/vsce');
await createVSIX({
  cwd: root,
  target,
  packagePath: path.join(root, 'artifacts', `${pkg.name}-${target}-${pkg.version}.vsix`),
  allowMissingRepository: true,
  rewriteRelativeLinks: false,
});
