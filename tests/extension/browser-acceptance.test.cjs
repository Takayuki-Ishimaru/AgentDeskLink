const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const load = () => import('../../dist/src/extension/browser-setup.js');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'adl-browser-parent-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extensionRoot = path.join(root, 'extension');
  await fs.mkdir(path.join(extensionRoot, 'node_modules/playwright'), { recursive: true });
  await fs.writeFile(path.join(extensionRoot, 'node_modules/playwright/cli.js'), 'fake');
  const storageDir = path.join(root, 'storage');
  const calls = [];
  const options = {
    extensionRoot,
    storageDir,
    nodePath: process.execPath,
    playwrightVersion: '1.64.1',
    probePaths: [],
    runCommand: async (args, opts) => {
      calls.push({ args, opts });
      const cache = opts.env.PLAYWRIGHT_BROWSERS_PATH;
      // The installer call and the registry query are separate commands: pick the mode from either.
      const headful = args.includes('--no-shell') || args.some(arg => /findExecutable\("chromium"\)/.test(arg));
      const exe = headful
        ? path.join(cache, 'chromium-1248', 'chrome-linux', 'chrome')
        : path.join(cache, 'chromium_headless_shell-1248', 'chrome-headless-shell');
      if (args.includes('install')) {
        await fs.mkdir(path.dirname(exe), { recursive: true });
        await fs.writeFile(exe, 'browser');
        await fs.chmod(exe, 0o755);
        return { stdout: '', stderr: '' };
      }
      return { stdout: JSON.stringify({ executable: exe, playwrightVersion: '1.64.1' }), stderr: '' };
    },
  };
  return { root, options, calls };
}
test('installed Chrome skips all installer commands and does not touch its profile', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const chrome = path.join(f.root, 'Google Chrome');
  await fs.writeFile(chrome, 'chrome');
  await fs.chmod(chrome, 0o755);
  const profile = path.join(f.root, 'Default');
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'Cookies'), 'do not touch');
  const result = await prepareBrowser({ ...f.options, probePaths: [chrome] });
  assert.equal(result.source, 'chrome');
  assert.equal(result.executablePath, await fs.realpath(chrome));
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(path.join(profile, 'Cookies'), 'utf8'), 'do not touch');
});
test('absent Chrome installs with the bundled node and reuses its private cache offline', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const first = await prepareBrowser(f.options);
  assert.equal(first.source, 'chromium');
  assert.ok(first.executablePath.startsWith((await fs.realpath(f.options.storageDir)) + path.sep));
  const install = f.calls.find(call => call.args.includes('install'));
  assert.equal(install.args[0], process.execPath);
  assert.ok(install.args.includes('--only-shell'));
  assert.equal(install.opts.env.PLAYWRIGHT_SKIP_BROWSER_GC, '1');
  const second = await prepareBrowser({
    ...f.options,
    runCommand: async () => {
      throw Error('offline');
    },
  });
  assert.equal(second.executablePath, first.executablePath);
});
test('failed install cleans up, retries, and concurrent preparation uses one install', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  await assert.rejects(
    prepareBrowser({
      ...f.options,
      runCommand: async () => {
        throw Error('offline');
      },
    }),
  );
  const [a, b] = await Promise.all([prepareBrowser(f.options), prepareBrowser(f.options)]);
  assert.equal(a.executablePath, b.executablePath);
  assert.equal(f.calls.filter(call => call.args.includes('install')).length, 1);
});
test('pre-cancelled setup never starts an installer', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(prepareBrowser({ ...f.options, signal: abort.signal }));
  assert.equal(f.calls.length, 0);
});
test('Chrome candidates cover supported operating systems without executing a shell', async () => {
  const { chromeCandidates } = await load();
  assert.ok(
    chromeCandidates('darwin', {}, '/users/example').includes(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ),
  );
  assert.ok(chromeCandidates('linux', {}, '/home/example').includes('/opt/google/chrome/chrome'));
  assert.deepEqual(
    chromeCandidates(
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' },
      'C:\\Users\\Example',
    ),
    [
      'C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ],
  );
});
test('a missing or corrupt cached executable is repaired', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const first = await prepareBrowser(f.options);
  await fs.writeFile(first.executablePath, '');
  const repaired = await prepareBrowser(f.options);
  assert.equal(repaired.executablePath, first.executablePath);
  assert.equal(f.calls.filter(call => call.args.includes('install')).length, 2);
});
test('query paths and symlinks cannot escape the private browser cache', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.writeFile(outside, 'untouched');
  for (const symlink of [false, true]) {
    await assert.rejects(
      prepareBrowser({
        ...f.options,
        runCommand: async (args, opts) => {
          await f.options.runCommand(args, opts);
          if (args.includes('install')) return { stdout: '', stderr: '' };
          let file = outside;
          if (symlink) {
            file = path.join(opts.env.PLAYWRIGHT_BROWSERS_PATH, 'evil');
            await fs.symlink(outside, file);
          }
          return { stdout: JSON.stringify({ executable: file, playwrightVersion: '1.64.1' }), stderr: '' };
        },
      }),
      /escapes/,
    );
    assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
  }
});
test('cancellation stops its installer and removes staging before it rejects', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t),
    controller = new AbortController();
  let started;
  const entered = new Promise(yes => (started = yes));
  const pending = prepareBrowser({
    ...f.options,
    signal: controller.signal,
    runCommand: async (args, opts) => {
      started();
      await new Promise((_, no) =>
        opts.signal.addEventListener('abort', () => no(new Error('cancelled')), { once: true }),
      );
      return { stdout: '', stderr: '' };
    },
  });
  await entered;
  controller.abort();
  await assert.rejects(pending);
  assert.deepEqual(await fs.readdir(path.join(f.options.storageDir, 'browsers')), []);
});
test('one cancelled subscriber cannot cancel another subscriber sharing the installer', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t),
    controller = new AbortController();
  const run = async (args, opts) => {
    await new Promise(yes => setTimeout(yes, 20));
    return f.options.runCommand(args, opts);
  };
  const first = prepareBrowser({ ...f.options, signal: controller.signal, runCommand: run });
  const second = prepareBrowser({ ...f.options, runCommand: run });
  controller.abort();
  await assert.rejects(first);
  assert.equal((await second).source, 'chromium');
  assert.equal(f.calls.filter(call => call.args.includes('install')).length, 1);
});
test('lock contention is bounded and real installer subprocess timeout releases its process', async t => {
  const { prepareBrowser, runBrowserCommand } = await load();
  const f = await fixture(t);
  const parent = path.join(f.options.storageDir, 'browsers');
  await fs.mkdir(parent, { recursive: true });
  const lock = path.join(parent, `1.64.1-${process.platform}-${process.arch}.lock`);
  await fs.writeFile(lock, 'another owner');
  await assert.rejects(prepareBrowser({ ...f.options, lockTimeoutMs: 20 }), /lock timed out/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'another owner');
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    runBrowserCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      cwd: f.root,
      env: process.env,
      timeoutMs: 40,
    }),
    /timed out/,
  );
});
test('a retry started while the last cancelling user is still settling gets a fresh installer', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t),
    controller = new AbortController();
  let entered,
    started = new Promise(yes => (entered = yes)),
    release,
    aborted = new Promise(yes => (release = yes)),
    installs = 0;
  const runCommand = async (args, opts) => {
    if (args.includes('install')) {
      installs++;
      if (installs === 1) {
        entered();
        await new Promise(yes => opts.signal.addEventListener('abort', yes, { once: true }));
        release();
        throw new Error('cancelled');
      }
    }
    return f.options.runCommand(args, opts);
  };
  const first = prepareBrowser({ ...f.options, signal: controller.signal, runCommand });
  await started;
  controller.abort();
  await aborted;
  const retry = prepareBrowser({ ...f.options, runCommand });
  await assert.rejects(first);
  const result = await retry;
  assert.equal(result.source, 'chromium');
  assert.equal(installs, 2, 'the dead flight is replaced by a real install');
  const names = await fs.readdir(path.join(f.options.storageDir, 'browsers'));
  assert.ok(!names.some(name => name.includes('staging')), 'no staging left behind');
  assert.ok(!names.some(name => name.endsWith('.lock')), 'the install lock is released');
});
const target = () => `${process.platform}-${process.arch}`;
const headlessCache = f => path.join(f.options.storageDir, 'browsers', `1.64.1-${target()}`);
const headfulCache = f => path.join(f.options.storageDir, 'browsers', `1.64.1-${target()}-headful`);
const queryOf = f => f.calls.find(call => call.args[1] === '-e').args[2];
test('headless default keeps --only-shell and the headless-shell registry entry', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const result = await prepareBrowser(f.options);
  const install = f.calls.find(call => call.args.includes('install'));
  assert.ok(install.args.includes('--only-shell'));
  assert.ok(!install.args.includes('--no-shell'));
  assert.match(queryOf(f), /findExecutable\("chromium-headless-shell"\)/);
  assert.ok(result.executablePath.startsWith((await fs.realpath(headlessCache(f))) + path.sep));
});
test('headful installs the full Chromium build and queries the chromium registry entry', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const result = await prepareBrowser({ ...f.options, headless: false });
  const install = f.calls.find(call => call.args.includes('install'));
  assert.ok(install.args.includes('--no-shell'));
  assert.ok(!install.args.includes('--only-shell'));
  assert.match(queryOf(f), /findExecutable\("chromium"\)/);
  assert.doesNotMatch(queryOf(f), /headless/);
  assert.equal(result.source, 'chromium');
  const root = await fs.realpath(headfulCache(f));
  assert.ok(result.executablePath.startsWith(root + path.sep));
  assert.ok(result.browsersPath.startsWith(root));
});
test('headful never reuses the headless cache and each mode keeps its own cache and lock', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const headless = await prepareBrowser(f.options);
  const headful = await prepareBrowser({ ...f.options, headless: false });
  assert.notEqual(headful.executablePath, headless.executablePath);
  assert.notEqual(headful.browsersPath, headless.browsersPath);
  assert.equal(f.calls.filter(call => call.args.includes('--no-shell')).length, 1);
  const offline = {
    ...f.options,
    runCommand: async () => {
      throw Error('offline');
    },
  };
  assert.equal((await prepareBrowser(offline)).executablePath, headless.executablePath);
  assert.equal((await prepareBrowser({ ...offline, headless: false })).executablePath, headful.executablePath);
  const names = await fs.readdir(path.join(f.options.storageDir, 'browsers'));
  assert.ok(
    names.every(name => !name.endsWith('.lock') && !name.includes('staging') && !name.includes('previous')),
    'locks and staging released',
  );
});
test('concurrent opposite modes never share a flight while same modes coalesce', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const slow = async (args, opts) => {
    await new Promise(yes => setTimeout(yes, 20));
    return f.options.runCommand(args, opts);
  };
  const [a, b, headless, headful] = await Promise.all([
    prepareBrowser({ ...f.options, runCommand: slow }),
    prepareBrowser({ ...f.options, runCommand: slow }),
    prepareBrowser({ ...f.options, headless: false, runCommand: slow }),
    prepareBrowser({ ...f.options, headless: false, runCommand: slow }),
  ]);
  assert.equal(a.executablePath, b.executablePath);
  assert.equal(headless.executablePath, headful.executablePath);
  assert.notEqual(a.executablePath, headless.executablePath);
  assert.equal(f.calls.filter(call => call.args.includes('--only-shell')).length, 1);
  assert.equal(f.calls.filter(call => call.args.includes('--no-shell')).length, 1);
});
test('an absent or malformed headful cache is never reused and refuses an escaping executable', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const cache = headfulCache(f);
  await fs.mkdir(cache, { recursive: true });
  const offline = {
    ...f.options,
    headless: false,
    runCommand: async () => {
      throw Error('offline');
    },
  };
  await assert.rejects(prepareBrowser(offline), /offline/, 'an absent headful cache installs');
  for (const meta of [
    { schemaVersion: 2, version: '1.64.1', target: target(), executable: 'chrome' },
    { version: '1.64.1', target: target(), executable: 'chrome' },
    { schemaVersion: 1, version: '9.9.9', target: target(), executable: 'chrome' },
    { schemaVersion: 1, version: '1.64.1', target: 'other-target', executable: 'chrome' },
    { schemaVersion: 1, version: '1.64.1', target: target(), executable: '../../../../etc/passwd' },
    { schemaVersion: 1, version: '1.64.1', target: target(), executable: '' },
    { schemaVersion: 1, version: '1.64.1', target: target(), executable: 'a//b' },
    { schemaVersion: 1, version: '1.64.1', target: target(), executable: 'C:\\evil.exe' },
  ]) {
    await fs.writeFile(path.join(cache, 'ready.json'), JSON.stringify(meta));
    await assert.rejects(prepareBrowser(offline), /offline/, 'a refused headful cache is never reused');
  }
  await fs.rm(cache, { recursive: true, force: true });
  const outside = path.join(f.root, 'outside');
  await fs.writeFile(outside, 'untouched');
  for (const symlink of [false, true]) {
    await assert.rejects(
      prepareBrowser({
        ...f.options,
        headless: false,
        runCommand: async (args, opts) => {
          if (args.includes('install')) return { stdout: '', stderr: '' };
          let file = outside;
          if (symlink) {
            file = path.join(opts.env.PLAYWRIGHT_BROWSERS_PATH, 'evil');
            await fs.symlink(outside, file);
          }
          return { stdout: JSON.stringify({ executable: file, playwrightVersion: '1.64.1' }), stderr: '' };
        },
      }),
      /escapes/,
    );
    assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
  }
  assert.equal(
    (await fs.readdir(path.join(f.options.storageDir, 'browsers'))).length,
    0,
    'no partial headful cache survives',
  );
});
test('headful cancellation removes its staging directory before it rejects', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t),
    controller = new AbortController();
  let started;
  const entered = new Promise(yes => (started = yes));
  const pending = prepareBrowser({
    ...f.options,
    headless: false,
    signal: controller.signal,
    runCommand: async (args, opts) => {
      started();
      await new Promise((_, no) =>
        opts.signal.addEventListener('abort', () => no(new Error('cancelled')), { once: true }),
      );
      return { stdout: '', stderr: '' };
    },
  });
  await entered;
  controller.abort();
  await assert.rejects(pending);
  assert.deepEqual(await fs.readdir(path.join(f.options.storageDir, 'browsers')), []);
});
test('an installed Chrome is preferred in headful mode too', async t => {
  const { prepareBrowser } = await load();
  const f = await fixture(t);
  const chrome = path.join(f.root, 'Google Chrome');
  await fs.writeFile(chrome, 'chrome');
  await fs.chmod(chrome, 0o755);
  const result = await prepareBrowser({ ...f.options, headless: false, probePaths: [chrome] });
  assert.equal(result.source, 'chrome');
  assert.equal(result.executablePath, await fs.realpath(chrome));
  assert.equal(f.calls.length, 0);
});

// ---- Installed-browser fallback and download hosts (panel requirement 1) ----
async function exe(dir, ...parts) {
  const file = path.join(dir, ...parts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'browser');
  await fs.chmod(file, 0o755);
  return file;
}
test('fallback candidates cover Edge and Chromium on each operating system', async () => {
  const { fallbackCandidates } = await load();
  assert.deepEqual(
    fallbackCandidates(
      'win32',
      {
        LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local',
        PROGRAMFILES: 'C:\\Program Files',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      },
      'C:\\Users\\Example',
    ).map(c => c.path),
    [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Users\\Example\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  );
  const mac = fallbackCandidates('darwin', {}, '/Users/example');
  assert.ok(
    mac.some(c => c.id === 'msedge' && c.path === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
  );
  assert.ok(mac.some(c => c.id === 'chromium' && c.path === '/Applications/Chromium.app/Contents/MacOS/Chromium'));
  assert.ok(
    mac.some(
      c => c.path === path.join('/Users/example', 'Applications', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    ),
  );
  const linux = fallbackCandidates('linux', {}, '/home/example').map(c => c.path);
  for (const expected of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/opt/microsoft/msedge/msedge',
  ])
    assert.ok(linux.includes(expected), expected);
  assert.ok(
    !fallbackCandidates('linux', {}, '/home/example').some(c => c.path.includes('google-chrome')),
    'Chrome itself is probed first, not offered as a fallback',
  );
});
test('installed browsers are detected without being launched, with version hints and snap shims refused', async t => {
  const { detectInstalledBrowsers } = await load(),
    f = await fixture(t);
  const edge = await exe(f.root, 'Edge', 'Application', 'msedge.exe');
  await fs.mkdir(path.join(path.dirname(edge), '99.1.2.3'));
  await fs.mkdir(path.join(path.dirname(edge), '130.0.2849.80'));
  await fs.mkdir(path.join(path.dirname(edge), '130.0.2849.9'));
  await fs.mkdir(path.join(path.dirname(edge), 'Installer'));
  const found = await detectInstalledBrowsers({
    platform: 'win32',
    candidates: [
      { id: 'msedge', label: 'Microsoft Edge', path: edge },
      { id: 'msedge', label: 'Microsoft Edge', path: edge },
      { id: 'msedge', label: 'Microsoft Edge', path: path.join(f.root, 'absent.exe') },
    ],
  });
  assert.equal(found.length, 1, 'duplicates and missing files are dropped');
  assert.equal(found[0].id, 'msedge');
  assert.equal(found[0].label, 'Microsoft Edge');
  assert.equal(found[0].usable, true);
  assert.equal(found[0].version, '130.0.2849.80');
  assert.equal(found[0].executablePath, await fs.realpath(edge));
  const shim = path.join(f.root, 'bin', 'chromium-browser');
  await fs.mkdir(path.dirname(shim));
  await fs.writeFile(shim, '#!/bin/sh\nexec /snap/bin/chromium "$@"\n');
  await fs.chmod(shim, 0o755);
  const debian = path.join(f.root, 'bin', 'chromium');
  await fs.writeFile(debian, '#!/bin/sh\nexec /usr/lib/chromium/chromium "$@"\n');
  await fs.chmod(debian, 0o755);
  const empty = path.join(f.root, 'bin', 'empty');
  await fs.writeFile(empty, '');
  await fs.chmod(empty, 0o755);
  const linux = await detectInstalledBrowsers({
    platform: 'linux',
    candidates: [
      { id: 'chromium', label: 'Chromium', path: shim },
      { id: 'chromium', label: 'Chromium', path: debian },
      { id: 'chromium', label: 'Chromium', path: empty },
    ],
  });
  assert.equal(linux.length, 2, 'an empty file is not a browser');
  const shimPath = await fs.realpath(shim),
    debianPath = await fs.realpath(debian);
  const snap = linux.find(item => item.executablePath === shimPath),
    real = linux.find(item => item.executablePath === debianPath);
  assert.equal(snap.usable, false);
  assert.match(snap.note, /Snap/);
  assert.match(snap.note, /Playwright/);
  assert.match(snap.label, /snap/);
  assert.equal(real.usable, true);
  assert.equal(real.note, undefined);
  const plist =
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>131.0.2903.51</string></dict></plist>';
  const app = await exe(f.root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge');
  await fs.writeFile(path.join(f.root, 'Microsoft Edge.app', 'Contents', 'Info.plist'), plist);
  assert.equal(
    (
      await detectInstalledBrowsers({
        platform: 'darwin',
        candidates: [{ id: 'msedge', label: 'Microsoft Edge', path: app }],
      })
    )[0].version,
    '131.0.2903.51',
  );
  assert.deepEqual(await detectInstalledBrowsers({ platform: 'linux', candidates: [] }), []);
});
test('a chosen installed browser replaces the download but never an installed Chrome, and a missing one falls back to the installer', async t => {
  const { prepareBrowser } = await load(),
    f = await fixture(t),
    chosen = await exe(f.root, 'edge', 'msedge'),
    chrome = await exe(f.root, 'chrome', 'chrome');
  const result = await prepareBrowser({ ...f.options, fallbackExecutable: chosen });
  assert.equal(result.source, 'fallback');
  assert.equal(result.executablePath, await fs.realpath(chosen));
  assert.equal(f.calls.length, 0, 'no installer command runs');
  assert.ok(
    result.browsersPath.startsWith(path.join(f.options.storageDir, 'browsers')),
    'the cache location is still reported',
  );
  const withChrome = await prepareBrowser({ ...f.options, probePaths: [chrome], fallbackExecutable: chosen });
  assert.equal(withChrome.source, 'chrome');
  assert.equal(withChrome.executablePath, await fs.realpath(chrome));
  const missing = await prepareBrowser({ ...f.options, fallbackExecutable: path.join(f.root, 'gone', 'msedge') });
  assert.equal(missing.source, 'chromium');
  assert.ok(
    f.calls.some(call => call.args.includes('install')),
    'a vanished browser falls back to the download',
  );
  const [a, b] = await Promise.all([
    prepareBrowser({ ...f.options, fallbackExecutable: chosen }),
    prepareBrowser(f.options),
  ]);
  assert.equal(a.source, 'fallback');
  assert.equal(b.source, 'chromium', 'the choice is part of the flight identity');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(prepareBrowser({ ...f.options, fallbackExecutable: chosen, signal: abort.signal }));
});
test('the Chromium version Playwright was built for is read from playwright-core', async () => {
  const { expectedChromium } = await load(),
    repo = path.resolve(__dirname, '../..');
  const entry = JSON.parse(
    await fs.readFile(path.join(repo, 'node_modules/playwright-core/browsers.json'), 'utf8'),
  ).browsers.find(b => b.name === 'chromium');
  assert.deepEqual(await expectedChromium(repo), { revision: entry.revision, version: entry.browserVersion });
  assert.match(entry.browserVersion, /^\d+\.\d+\.\d+\.\d+$/);
  assert.deepEqual(await expectedChromium(path.join(repo, 'does-not-exist')), {});
});
test('the listed download hosts are the ones playwright-core 1.64 contacts for Chromium and its helpers', async () => {
  const { BROWSER_DOWNLOAD_HOSTS } = await load(),
    repo = path.resolve(__dirname, '../..');
  const bundle = await fs.readFile(path.join(repo, 'node_modules/playwright-core/lib/coreBundle.js'), 'utf8');
  // Chromium and the headless shell come from the Chrome-for-Testing mirror list; ffmpeg and winldd use the CDN mirror list. Update BROWSER_DOWNLOAD_HOSTS when either changes.
  const cft = /function cftUrl\(suffix\)[\s\S]*?mirrors: \[\s*"https:\/\/([^"/]+)"\s*\]/.exec(bundle);
  assert.equal(cft?.[1], 'cdn.playwright.dev');
  const mirrors = /PLAYWRIGHT_CDN_MIRRORS = \[([\s\S]*?)\];/.exec(bundle);
  assert.ok(mirrors, 'the CDN mirror list is present');
  assert.deepEqual(
    [...new Set([...mirrors[1].matchAll(/"https:\/\/([^"/]+)/g)].map(match => match[1]))].sort(),
    [...BROWSER_DOWNLOAD_HOSTS].sort(),
  );
  assert.ok(
    bundle.includes('PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST') && bundle.includes('PLAYWRIGHT_DOWNLOAD_HOST'),
    'the override variables the panel honours still exist',
  );
});
