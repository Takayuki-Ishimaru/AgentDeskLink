/** Carry only browser test configuration into stdio children, never arbitrary host grants. */
export function browserRuntimeEnv(): Record<string, string> {
  return Object.fromEntries(
    [
      'ADL_BROWSER_EXECUTABLE',
      'PLAYWRIGHT_BROWSERS_PATH',
      'PLAYWRIGHT_SKIP_BROWSER_GC',
      'CHROME_DEVEL_SANDBOX',
    ].flatMap(key => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  );
}
