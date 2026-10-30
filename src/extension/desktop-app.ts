import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Helpers for the panel's desktop-app picker. Everything here only reads the file system; nothing is executed.
const MAX_PLIST_BYTES = 1_048_576;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Top-level string entries of an XML property list. Binary (bplist) or non-plist input returns undefined. */
export function parseXmlPlistStrings(text: string): Map<string, string> | undefined {
  if (text.startsWith('bplist') || !/<plist[\s>]/.test(text)) return undefined;
  const body = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const entries = new Map<string, string>();
  const token = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  let depth = 0,
    key: string | undefined,
    reading: 'key' | 'string' | undefined,
    buffer = '';
  for (let match = token.exec(body); match; match = token.exec(body)) {
    if (match[4] !== undefined) {
      if (reading) buffer += match[4];
      continue;
    }
    const closing = match[1] === '/',
      name = match[2]!,
      selfClosing = match[3] === '/';
    if (name === 'plist') continue;
    if (name === 'dict' || name === 'array') {
      if (closing) {
        depth = Math.max(0, depth - 1);
        if (depth <= 1) key = undefined;
      } else if (selfClosing) {
        if (depth === 1) key = undefined;
      } else {
        depth++;
        if (depth === 2) key = undefined;
      }
      continue;
    }
    if (depth !== 1) continue;
    if (name === 'key' || name === 'string') {
      if (!closing && !selfClosing) {
        reading = name;
        buffer = '';
      } else if (selfClosing && name === 'string') {
        if (key !== undefined) entries.set(key, '');
        key = undefined;
      } else if (closing && reading === name) {
        if (name === 'key') key = decodeEntities(buffer);
        else {
          if (key !== undefined) entries.set(key, decodeEntities(buffer));
          key = undefined;
        }
        reading = undefined;
      }
      continue;
    }
    if (!closing) key = undefined; // integer, real, date, data, true and false values are not strings
  }
  return entries;
}

export interface DesktopPick {
  appPath: string;
  appId?: string;
  replaceId: boolean;
  notes: string[];
}
export type DesktopPickResult = { ok: true; pick: DesktopPick } | { ok: false; message: string };

const isBundle = (file: string): boolean => file.toLowerCase().endsWith('.app');
async function kind(file: string): Promise<'file' | 'directory' | 'missing' | 'other'> {
  try {
    const st = await fs.stat(file);
    return st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other';
  } catch {
    return 'missing';
  }
}
async function executable(file: string, platform: string): Promise<boolean> {
  if ((await kind(file)) !== 'file') return false;
  if (platform === 'win32') return true;
  try {
    await fs.access(file, 1);
    return true;
  } catch {
    return false;
  }
}
/** A short, label-safe application ID derived from a file name. */
export function suggestAppId(file: string): string {
  const base = (
    file
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? ''
  ).replace(/\.(exe|app)$/i, '');
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}
/** The `<bundle>.app` that contains `file`, when file sits under Contents/MacOS. */
function enclosingBundle(file: string): string | undefined {
  const parts = path.resolve(file).split(path.sep);
  for (let i = parts.length - 3; i > 0; i--) {
    if (isBundle(parts[i]!) && parts[i + 1] === 'Contents' && parts[i + 2] === 'MacOS')
      return parts.slice(0, i + 1).join(path.sep) || path.sep;
  }
  return undefined;
}
async function readPlist(
  bundle: string,
): Promise<{ state: 'missing' | 'binary' | 'unreadable' } | { state: 'xml'; entries: Map<string, string> }> {
  const file = path.join(bundle, 'Contents', 'Info.plist');
  let text: string;
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_PLIST_BYTES) return { state: 'unreadable' };
    const bytes = await fs.readFile(file);
    if (bytes.subarray(0, 6).toString('latin1') === 'bplist') return { state: 'binary' };
    text = bytes.toString('utf8');
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  const entries = parseXmlPlistStrings(text);
  return entries ? { state: 'xml', entries } : { state: 'binary' };
}
async function macosNames(bundle: string): Promise<string> {
  try {
    return (await fs.readdir(path.join(bundle, 'Contents', 'MacOS'))).slice(0, 8).join(', ');
  } catch {
    return '';
  }
}
const bi = (ja: string, en: string): string => `${ja} / ${en}`;
const MANUAL_ID_JA =
  'アプリ ID は Bundle Identifier を手入力してください（例: defaults read "<アプリ>/Contents/Info" CFBundleIdentifier）。';
const MANUAL_ID_EN =
  'Enter the bundle identifier as the app ID yourself (for example: defaults read "<app>/Contents/Info" CFBundleIdentifier).';
const MANUAL_ID = bi(MANUAL_ID_JA, MANUAL_ID_EN);

async function pickMac(selected: string): Promise<DesktopPickResult> {
  const type = await kind(selected);
  if (type === 'missing' || type === 'other')
    return { ok: false, message: '選択した項目が見つかりません。 / The selected item was not found.' };
  const bundle =
    type === 'directory' ? (isBundle(selected) ? path.resolve(selected) : undefined) : enclosingBundle(selected);
  if (type === 'directory' && !bundle)
    return {
      ok: false,
      message:
        'フォルダーではなく .app（またはその Contents/MacOS 内の実行ファイル）を選んでください。 / Choose an .app bundle, or the executable inside its Contents/MacOS folder, not a plain folder.',
    };
  if (!bundle) {
    // A bare executable outside any bundle: the path is usable but there is no bundle identifier to suggest.
    if (!(await executable(selected, 'darwin')))
      return { ok: false, message: '実行可能なファイルを選んでください。 / Choose an executable file.' };
    return {
      ok: true,
      pick: {
        appPath: await fs.realpath(selected),
        replaceId: false,
        notes: ['.app の外の実行ファイルです。 / This executable is not inside an .app bundle.', MANUAL_ID],
      },
    };
  }
  const plist = await readPlist(bundle);
  if (type === 'file') {
    if (!(await executable(selected, 'darwin')))
      return { ok: false, message: '実行可能なファイルを選んでください。 / Choose an executable file.' };
    const appPath = await fs.realpath(selected);
    if (plist.state === 'xml' && plist.entries.get('CFBundleExecutable') === path.basename(selected)) {
      const appId = plist.entries.get('CFBundleIdentifier');
      return {
        ok: true,
        pick: { appPath, ...(appId ? { appId } : {}), replaceId: true, notes: appId ? [] : [MANUAL_ID] },
      };
    }
    return { ok: true, pick: { appPath, replaceId: false, notes: [MANUAL_ID] } };
  }
  if (plist.state !== 'xml') {
    const names = await macosNames(bundle),
      binary = plist.state === 'binary';
    return {
      ok: false,
      message: bi(
        `${binary ? 'Info.plist がバイナリ形式のため自動で読めません。' : 'Info.plist を読めません。'}「Contents/MacOS」内の実行ファイル${names ? `（${names}）` : ''}を選び直してください。${MANUAL_ID_JA}`,
        `${binary ? 'Info.plist is in binary format and cannot be read automatically.' : 'Info.plist cannot be read.'} Select the executable in Contents/MacOS${names ? ` (${names})` : ''} instead. ${MANUAL_ID_EN}`,
      ),
    };
  }
  const name = plist.entries.get('CFBundleExecutable');
  if (!name || name !== path.basename(name) || name.includes('\0'))
    return {
      ok: false,
      message:
        'Info.plist に CFBundleExecutable がありません。Contents/MacOS 内の実行ファイルを直接選んでください。 / Info.plist has no CFBundleExecutable. Select the executable in Contents/MacOS directly.',
    };
  const exe = path.join(bundle, 'Contents', 'MacOS', name);
  if (!(await executable(exe, 'darwin')))
    return {
      ok: false,
      message: `実行ファイルが見つかりません: Contents/MacOS/${name} / Executable not found: Contents/MacOS/${name}`,
    };
  const appId = plist.entries.get('CFBundleIdentifier');
  return {
    ok: true,
    pick: {
      appPath: await fs.realpath(exe),
      ...(appId ? { appId } : {}),
      replaceId: true,
      notes: appId ? [] : [MANUAL_ID],
    },
  };
}

/** Turns what the user picked in the open dialog into an application path and an ID suggestion. */
export async function resolveDesktopSelection(
  selected: string,
  platform: string = process.platform,
): Promise<DesktopPickResult> {
  if (typeof selected !== 'string' || selected === '' || selected.includes('\0') || !path.isAbsolute(selected))
    return { ok: false, message: '絶対パスを選んでください。 / Choose an absolute path.' };
  if (platform === 'darwin') return pickMac(selected);
  if (platform === 'win32') {
    if (!/\.exe$/i.test(selected) || (await kind(selected)) !== 'file')
      return {
        ok: false,
        message:
          '.exe ファイルを選んでください（ショートカット .lnk やフォルダーは使えません）。 / Choose an .exe file; shortcuts (.lnk) and folders cannot be used.',
      };
    return {
      ok: true,
      pick: {
        appPath: path.resolve(selected),
        appId: suggestAppId(selected) || undefined,
        replaceId: false,
        notes: [
          'アプリ ID は AI に見せる名前です。必要なら変更できます。 / The app ID is only the name shown to the AI; change it if you like.',
        ],
      },
    };
  }
  if (!(await executable(selected, platform)))
    return { ok: false, message: '実行可能なファイルを選んでください。 / Choose an executable file.' };
  return {
    ok: true,
    pick: {
      appPath: path.resolve(selected),
      appId: suggestAppId(selected) || undefined,
      replaceId: false,
      notes: [
        'アプリ ID は AT-SPI のアプリケーション名に合わせてください（提案はファイル名です）。 / Set the app ID to the AT-SPI application name; the suggestion is the file name.',
      ],
    },
  };
}

export interface DesktopAppInput {
  appId: string;
  appPath: string;
}
export type DesktopValidation = { ok: true; value: DesktopAppInput; notes: string[] } | { ok: false; message: string };

/** Checks a typed ID/path pair before it is written as a trusted workspace setting. */
export async function validateDesktopApp(
  input: DesktopAppInput,
  platform: string = process.platform,
): Promise<DesktopValidation> {
  const appId = input.appId.trim(),
    appPath = input.appPath.trim();
  if (appId === '' && appPath === '') return { ok: true, value: { appId: '', appPath: '' }, notes: [] };
  if (appId === '' || appPath === '')
    return {
      ok: false,
      message:
        'アプリ ID と実行ファイルのパスは両方入力してください。 / Enter both the app ID and the executable path.',
    };
  if (appId.length > 128 || /[\u0000-\u001f\u007f]/.test(appId))
    return {
      ok: false,
      message:
        'アプリ ID は 128 文字以内の 1 行にしてください。 / The app ID must be one line of at most 128 characters.',
    };
  if (appId.includes('*'))
    return {
      ok: false,
      message:
        'ワイルドカードは使えません。アプリを 1 つだけ指定してください。 / Wildcards are not allowed; name exactly one application.',
    };
  const absolute = platform === 'win32' ? path.win32.isAbsolute(appPath) : path.isAbsolute(appPath);
  if (!absolute || appPath.includes('\0'))
    return {
      ok: false,
      message: '実行ファイルは絶対パスで指定してください。 / The executable must be an absolute path.',
    };
  const notes: string[] = [];
  if (platform === 'darwin') {
    if ((await kind(appPath)) === 'directory') {
      const picked = isBundle(appPath) ? await pickMac(appPath) : undefined;
      const suggestion = picked?.ok ? picked.pick.appPath : '';
      return {
        ok: false,
        message: bi(
          `.app ではなく、その中の Contents/MacOS/<実行ファイル> を指定してください。「参照…」で .app を選ぶと自動で解決します。${suggestion ? `候補: ${suggestion}` : ''}`,
          `Specify the executable inside Contents/MacOS/<executable>, not the .app. Browse… resolves a selected .app for you.${suggestion ? ` Suggested: ${suggestion}` : ''}`,
        ),
      };
    }
    if (!(await executable(appPath, 'darwin')))
      return { ok: false, message: '実行ファイルが見つかりません。 / The executable was not found.' };
    const real = await fs.realpath(appPath);
    if (real !== appPath)
      notes.push(`シンボリックリンクを解決して保存します: ${real} / Saved with symbolic links resolved: ${real}`);
    return { ok: true, value: { appId, appPath: real }, notes };
  }
  if (platform === 'win32' && !/\.exe$/i.test(appPath))
    return { ok: false, message: '.exe ファイルを指定してください。 / Specify an .exe file.' };
  if (!(await executable(appPath, platform)))
    return {
      ok: false,
      message: 'ファイルが見つからないか、実行できません。 / The file was not found or is not executable.',
    };
  return { ok: true, value: { appId, appPath }, notes };
}
