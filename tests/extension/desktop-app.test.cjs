const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const load = () => import('../../dist/src/extension/desktop-app.js');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'adl-desktop-app-')));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = () => {
  const dir = path.join(root, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const plistOf = entries =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${entries}</dict></plist>`;
function makeBundle(dir, { name = 'Calc', executable = 'Calc', id = 'com.example.calc', plist, make = true } = {}) {
  const app = path.join(dir, `${name}.app`),
    macos = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  if (make) {
    fs.writeFileSync(path.join(macos, executable), 'binary');
    fs.chmodSync(path.join(macos, executable), 0o755);
  }
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    plist ??
      plistOf(
        `<key>CFBundleExecutable</key><string>${executable}</string><key>CFBundleIdentifier</key><string>${id}</string>`,
      ),
  );
  return { app, exe: path.join(macos, executable) };
}

test('XML property lists give top-level strings only; binary and non-plist input is refused', async () => {
  const { parseXmlPlistStrings } = await load();
  const entries = parseXmlPlistStrings(
    plistOf(
      '<!-- note --><key>CFBundleExecutable</key><string>My &amp; App</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleExecutable</key><string>nested</string></dict></array><key>LSUIElement</key><true/><key>CFBundleIdentifier</key><string>com.example.app</string><key>Empty</key><string/><key>Version</key><integer>3</integer><key>Name</key><string>&#x41;&#66;</string>',
    ),
  );
  assert.deepEqual(Object.fromEntries(entries), {
    CFBundleExecutable: 'My & App',
    CFBundleIdentifier: 'com.example.app',
    Empty: '',
    Name: 'AB',
  });
  assert.equal(parseXmlPlistStrings('bplist00\u0001\u0002'), undefined);
  assert.equal(parseXmlPlistStrings('not a property list'), undefined);
  assert.equal(
    parseXmlPlistStrings(
      plistOf('<key>A</key><dict><key>B</key><string>x</string></dict><key>C</key><string>y</string>'),
    ).get('C'),
    'y',
  );
  assert.equal(
    parseXmlPlistStrings(
      plistOf('<key>A</key><dict><key>B</key><string>x</string></dict><key>C</key><string>y</string>'),
    ).has('B'),
    false,
  );
});

test('macOS: choosing an .app resolves Contents/MacOS/<CFBundleExecutable> and suggests the bundle identifier', async () => {
  const { resolveDesktopSelection } = await load(),
    dir = fresh();
  const { app, exe } = makeBundle(dir, { name: 'My Calc', executable: 'CalcEngine', id: 'com.example.mycalc' });
  const picked = await resolveDesktopSelection(app, 'darwin');
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.equal(picked.pick.appPath, fs.realpathSync(exe));
  assert.equal(picked.pick.appId, 'com.example.mycalc');
  assert.equal(picked.pick.replaceId, true);
  const direct = await resolveDesktopSelection(exe, 'darwin');
  assert.equal(
    direct.pick.appId,
    'com.example.mycalc',
    'picking the executable inside the bundle also finds the identifier',
  );
  assert.equal(direct.pick.appPath, fs.realpathSync(exe));
  const other = path.join(path.dirname(exe), 'Helper');
  fs.writeFileSync(other, 'x');
  fs.chmodSync(other, 0o755);
  const helper = await resolveDesktopSelection(other, 'darwin');
  assert.equal(helper.ok, true);
  assert.equal(helper.pick.appId, undefined, 'an executable that is not the bundle executable gets no ID suggestion');
  assert.equal(helper.pick.replaceId, false);
  assert.ok(helper.pick.notes.length > 0);
});

test('macOS: binary or missing plists and bad bundles are explained instead of guessed', async () => {
  const { resolveDesktopSelection } = await load(),
    dir = fresh();
  const binary = makeBundle(dir, { name: 'Binary', executable: 'BinApp', plist: 'bplist00\u0000\u0001' });
  const refused = await resolveDesktopSelection(binary.app, 'darwin');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /binary format/);
  assert.match(refused.message, /バイナリ形式/);
  assert.match(refused.message, /BinApp/, 'lists what is in Contents/MacOS');
  assert.match(refused.message, /CFBundleIdentifier/);
  const none = makeBundle(dir, { name: 'None', executable: 'NoPlist' });
  fs.rmSync(path.join(none.app, 'Contents', 'Info.plist'));
  assert.equal((await resolveDesktopSelection(none.app, 'darwin')).ok, false);
  const noexe = makeBundle(dir, { name: 'Gone', executable: 'Gone', make: false });
  const gone = await resolveDesktopSelection(noexe.app, 'darwin');
  assert.equal(gone.ok, false);
  assert.match(gone.message, /Contents\/MacOS\/Gone/);
  const noKey = makeBundle(dir, { name: 'NoKey', plist: plistOf('<key>CFBundleIdentifier</key><string>x.y</string>') });
  assert.match((await resolveDesktopSelection(noKey.app, 'darwin')).message, /CFBundleExecutable/);
  const traversal = makeBundle(dir, {
    name: 'Trav',
    plist: plistOf('<key>CFBundleExecutable</key><string>../../escape</string>'),
  });
  assert.equal(
    (await resolveDesktopSelection(traversal.app, 'darwin')).ok,
    false,
    'an executable name cannot leave Contents/MacOS',
  );
  const folder = path.join(dir, 'plain-folder');
  fs.mkdirSync(folder);
  assert.equal((await resolveDesktopSelection(folder, 'darwin')).ok, false);
  assert.equal((await resolveDesktopSelection(path.join(dir, 'missing.app'), 'darwin')).ok, false);
  const bare = path.join(dir, 'bare');
  fs.writeFileSync(bare, 'x');
  fs.chmodSync(bare, 0o755);
  const bareResult = await resolveDesktopSelection(bare, 'darwin');
  assert.equal(bareResult.ok, true);
  assert.equal(bareResult.pick.appId, undefined);
  assert.ok(bareResult.pick.notes.some(note => /Bundle Identifier|bundle identifier/.test(note)));
  assert.equal((await resolveDesktopSelection('relative/path', 'darwin')).ok, false);
});

test('Windows and Linux: pick an executable file and suggest a label-safe ID', async t => {
  const { resolveDesktopSelection, suggestAppId } = await load(),
    dir = fresh();
  assert.equal(suggestAppId('C:\\Windows\\System32\\Char Map.exe', 'win32'), 'char-map');
  assert.equal(suggestAppId('/usr/bin/gnome-calculator'), 'gnome-calculator');
  assert.equal(suggestAppId('/opt/???'), '');
  const exe = path.join(dir, 'Notepad Plus.exe');
  fs.writeFileSync(exe, 'x');
  const win = await resolveDesktopSelection(exe, 'win32');
  assert.equal(win.ok, true);
  assert.equal(win.pick.appPath, exe);
  assert.equal(win.pick.appId, 'notepad-plus');
  assert.equal(win.pick.replaceId, false);
  const lnk = path.join(dir, 'Notepad.lnk');
  fs.writeFileSync(lnk, 'x');
  const refused = await resolveDesktopSelection(lnk, 'win32');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /\.lnk/);
  assert.equal((await resolveDesktopSelection(dir, 'win32')).ok, false);
  const tool = path.join(dir, 'calc-tool');
  fs.writeFileSync(tool, 'x');
  fs.chmodSync(tool, 0o755);
  const linux = await resolveDesktopSelection(tool, 'linux');
  assert.equal(linux.ok, true);
  assert.equal(linux.pick.appPath, tool);
  assert.equal(linux.pick.appId, 'calc-tool');
  assert.match(linux.pick.notes.join(' '), /AT-SPI/);
  if (process.platform !== 'win32') {
    const plain = path.join(dir, 'data.txt');
    fs.writeFileSync(plain, 'x');
    fs.chmodSync(plain, 0o644);
    assert.equal((await resolveDesktopSelection(plain, 'linux')).ok, false, 'a non-executable file is refused');
  } else t.diagnostic('POSIX execute-bit refusal is not applicable on Windows');
});

test('typed ID/path pairs are validated before they become trusted settings', async () => {
  const { validateDesktopApp } = await load(),
    dir = fresh();
  const { app, exe } = makeBundle(dir, { name: 'Typed', executable: 'Typed', id: 'com.example.typed' });
  assert.deepEqual(await validateDesktopApp({ appId: ' ', appPath: ' ' }, 'darwin'), {
    ok: true,
    value: { appId: '', appPath: '' },
    notes: [],
  });
  const mac = await validateDesktopApp({ appId: 'com.example.typed', appPath: exe }, 'darwin');
  assert.equal(mac.ok, true);
  assert.equal(mac.value.appPath, fs.realpathSync(exe));
  const bundle = await validateDesktopApp({ appId: 'com.example.typed', appPath: app }, 'darwin');
  assert.equal(bundle.ok, false, 'a typed .app bundle is not silently rewritten');
  assert.ok(bundle.message.includes(fs.realpathSync(exe)), 'but the exact executable is suggested');
  assert.match(bundle.message, /Contents\/MacOS/);
  assert.equal(
    (
      await validateDesktopApp(
        { appId: 'x', appPath: path.join(dir, 'Typed.app', 'Contents', 'MacOS', 'nope') },
        'darwin',
      )
    ).ok,
    false,
  );
  const win = path.join(dir, 'tool.exe');
  fs.writeFileSync(win, 'x');
  assert.equal((await validateDesktopApp({ appId: 'tool', appPath: win }, 'win32')).ok, true);
  assert.match((await validateDesktopApp({ appId: 'tool', appPath: exe }, 'win32')).message, /\.exe/);
  assert.match((await validateDesktopApp({ appId: '*', appPath: win }, 'win32')).message, /Wildcards/);
  assert.match((await validateDesktopApp({ appId: 'x', appPath: 'tool.exe' }, 'win32')).message, /absolute/);
  assert.match((await validateDesktopApp({ appId: 'x', appPath: '' }, 'win32')).message, /both/);
  assert.match((await validateDesktopApp({ appId: 'x'.repeat(129), appPath: win }, 'win32')).message, /128/);
  assert.match(
    (await validateDesktopApp({ appId: 'x', appPath: path.join(dir, 'ghost.exe') }, 'win32')).message,
    /not found/,
  );
});
