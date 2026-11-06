import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Desktop runners cannot reliably keep several Chromium-heavy files within
// the same action deadlines. Serialize Windows and macOS; Linux retains four
// workers. Assertions, per-test deadlines and the complete file list stay fixed.
const concurrency = process.platform === 'win32' || process.platform === 'darwin' ? 1 : 4;
const files = (await readdir('dist/tests'))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => join('dist/tests', name));
if (!files.length) throw new Error('No compiled tests found');
console.error(`Test runner: ${process.platform}, ${files.length} files, ${concurrency} worker(s)`);
const child = spawn(
  process.execPath,
  [
    '--test',
    `--test-concurrency=${concurrency}`,
    '--test-timeout=30000',
    '--test-force-exit',
    '--test-reporter=tap',
    ...files,
  ],
  { stdio: 'inherit', windowsHide: true },
);
child.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`Test runner terminated by signal ${signal}`);
  else if (code !== 0) console.error(`Test runner exited with code ${code}`);
  process.exitCode = code ?? (signal ? 1 : 0);
});
