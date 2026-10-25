import {Buffer} from 'node:buffer';
import {errors,type Locator,type Page} from 'playwright';
import {AdlError} from './types.js';
import type {CapturedImage, VisualPolicy} from './visual-types.js';

const MAX_DIMENSION = 4096;
const MAX_PIXELS = 4194304;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 5000;
const BASE_MASK_SELECTORS = ['input', 'textarea', 'select', '[contenteditable]', 'iframe', 'frame', '[data-adl-sensitive]'];

interface Geometry {
  width: number; height: number; scroll_x: number; scroll_y: number; device_scale_factor: number;
}

const GEOMETRY_EXPRESSION =
  '({width: window.innerWidth, height: window.innerHeight, scroll_x: window.scrollX, scroll_y: window.scrollY, device_scale_factor: window.devicePixelRatio})';

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new AdlError('E_CANCELLED');
}

/** Races an untrusted page call so an abort never yields a result, and never lets a page error escape. */
async function guarded<T>(page: Page, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  assertActive(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new AdlError('E_CANCELLED'));
    signal.addEventListener('abort', onAbort, {once: true});
  });
  try {
    return await Promise.race([work(), aborted]);
  } catch (error) {
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    if (error instanceof AdlError) throw error;
    if (error instanceof errors.TimeoutError) throw new AdlError('E_TIMEOUT');
    throw new AdlError('E_PRIVACY_BLOCKED');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function sameGeometry(a: Geometry, b: Geometry): boolean {
  return a.width === b.width && a.height === b.height && a.scroll_x === b.scroll_x &&
    a.scroll_y === b.scroll_y && a.device_scale_factor === b.device_scale_factor;
}

function validateGeometry(value: unknown): Geometry {
  if (value === null || typeof value !== 'object') throw new AdlError('E_STALE_STATE');
  const raw = value as Record<string, unknown>;
  const {width, height, scroll_x: scrollX, scroll_y: scrollY, device_scale_factor: deviceScaleFactor} = raw;
  if (!isInteger(width) || !isInteger(height) || width <= 0 || height <= 0) throw new AdlError('E_STALE_STATE');
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new AdlError('E_RESOURCE_LIMIT');
  if (!isFiniteNumber(scrollX) || !isFiniteNumber(scrollY) || !isFiniteNumber(deviceScaleFactor) || deviceScaleFactor <= 0) {
    throw new AdlError('E_STALE_STATE');
  }
  return {width, height, scroll_x: scrollX, scroll_y: scrollY, device_scale_factor: deviceScaleFactor};
}

function assertOrigin(page: Page, origin: string): void {
  let current: unknown;
  try {
    current = page.url();
  } catch {
    throw new AdlError('E_PRIVACY_BLOCKED');
  }
  let currentOrigin: string;
  try {
    if (typeof current !== 'string') throw new Error('untrusted url');
    currentOrigin = new URL(current).origin;
  } catch {
    throw new AdlError('E_PRIVACY_BLOCKED');
  }
  if (currentOrigin !== origin) throw new AdlError('E_POLICY_DENIED');
}

/** Trusted mask configuration fails closed: a malformed selector must never be dropped silently. */
function maskSelectors(visual: VisualPolicy): string[] {
  const trusted = visual.maskSelectors === undefined ? [] : visual.maskSelectors;
  if (!Array.isArray(trusted)) throw new AdlError('E_PRIVACY_BLOCKED');
  for (const selector of trusted) {
    if (typeof selector !== 'string' || selector.trim().length === 0) throw new AdlError('E_PRIVACY_BLOCKED');
  }
  return [...new Set([...BASE_MASK_SELECTORS, ...trusted])];
}

export async function captureBrowserImage(
  page: Page, origin: string, visual: VisualPolicy | undefined, signal: AbortSignal
): Promise<CapturedImage> {
  assertActive(signal);
  if (visual?.enabled !== true) throw new AdlError('E_PRIVACY_BLOCKED');
  const selectors = maskSelectors(visual);
  assertOrigin(page, origin);

  const before = validateGeometry(await guarded(page, () => page.evaluate(GEOMETRY_EXPRESSION), signal));
  assertOrigin(page, origin);
  assertActive(signal);

  let mask: Locator[];
  try {
    mask = selectors.map((selector) => page.locator(selector));
  } catch {
    throw new AdlError('E_PRIVACY_BLOCKED');
  }

  const png = await guarded(page, () => page.screenshot({
    type: 'png',
    scale: 'css',
    fullPage: false,
    animations: 'allow',
    caret: 'initial',
    timeout: CAPTURE_TIMEOUT_MS,
    maskColor: '#000000',
    mask
  }), signal);
  assertActive(signal);

  assertOrigin(page, origin);
  const after = validateGeometry(await guarded(page, () => page.evaluate(GEOMETRY_EXPRESSION), signal));
  // Final page read is done: the last origin check must follow it, with no page call in between.
  assertOrigin(page, origin);
  if (!sameGeometry(before, after)) throw new AdlError('E_STALE_STATE');
  assertActive(signal);

  if (!(png instanceof Buffer) || png.length === 0) throw new AdlError('E_PRIVACY_BLOCKED');
  if (png.length > MAX_PNG_BYTES) throw new AdlError('E_RESOURCE_LIMIT');

  return {
    png,
    captured_at: new Date().toISOString(),
    coordinate_space: 'viewport_css_pixels',
    viewport: before,
    redacted: true
  };
}
