import { readFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prepareRuntime } from './prepare-runtime.mjs';
import { assembleUniversalVsix, UNIVERSAL_TARGETS } from './universal-vsix.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
let component = false,
  universal = false,
  directory,
  help = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--component') component = true;
  else if (arg === '--universal') universal = true;
  else if (arg === '--components') {
    directory = args[++i];
    if (!directory || directory.startsWith('--')) throw new Error('--components requires a directory');
  } else if (arg.startsWith('--components=')) {
    directory = arg.slice('--components='.length);
    if (!directory) throw new Error('--components requires a directory');
  } else if (arg === '--help' || arg === '-h') help = true;
  else throw new Error(`Unknown argument: ${arg}`);
}
if (component && (directory || universal))
  throw new Error('--component and --universal/--components cannot be combined');
if (help) {
  console.log(
    'Usage: npm run package:vsix -- [--universal [--components DIR]]\nBy default creates a smaller VSIX for the current OS/architecture.\n--universal assembles all three OS components; --component remains a compatible alias for the default.',
  );
} else if (component || (!universal && !directory)) {
  const target = `${process.platform}-${process.arch}`;
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await prepareRuntime({ root, target });
  const { createVSIX } = createRequire(import.meta.url)('@vscode/vsce');
  await createVSIX({
    cwd: root,
    target,
    packagePath: path.join(root, 'artifacts', `${pkg.name}-${target}-${pkg.version}.vsix`),
    allowMissingRepository: true,
    rewriteRelativeLinks: false,
  });
} else {
  const componentDir = path.resolve(root, directory ?? 'artifacts/components');
  const wanted = new Map(UNIVERSAL_TARGETS.map(target => [`${pkg.name}-${target}-${pkg.version}.vsix`, []]));
  let visited = 0;
  async function collect(dir, depth = 0) {
    if (depth > 8 || ++visited > 10000) throw new Error('Component directory scan exceeded its bounds');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Component paths cannot be symbolic links: ${entry.name}`);
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(file, depth + 1);
      else if (entry.isFile() && wanted.has(entry.name)) wanted.get(entry.name).push(file);
    }
  }
  try {
    await collect(componentDir);
  } catch (error) {
    throw new Error(`Cannot load component VSIX files from ${componentDir}: ${error.message}`);
  }
  const components = [];
  for (const [name, files] of wanted) {
    if (files.length !== 1)
      throw new Error(
        `Exactly one ${name} is required; found ${files.length}. Build/download all three components first.`,
      );
    components.push(files[0]);
  }
  const result = await assembleUniversalVsix({
    components,
    version: pkg.version,
    output: path.join(root, 'artifacts', `${pkg.name}-${pkg.version}.vsix`),
  });
  console.log(`Universal VSIX created: ${result.output} (${result.targets.join(', ')})`);
}
