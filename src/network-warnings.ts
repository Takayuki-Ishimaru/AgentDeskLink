import type { NetworkWarning } from './types.js';

// Blocked-request diagnostics. Only bounded enums are exposed: never a URL path, query or header.
const RESOURCE_TYPES = new Set([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
]);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// Blocks of these request kinds belong to what an action itself set in motion (navigation, data fetches).
const ACTION_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch', 'eventsource', 'websocket']);

export function networkResourceType(request: {
  resourceType(): string;
  isNavigationRequest(): boolean;
  frame(): { parentFrame(): unknown };
}): string {
  const type = request.resourceType();
  // A document inside a child frame (an embed, an ad) is background traffic, not a navigation of the page.
  if (type === 'document' && request.frame().parentFrame()) return 'subframe';
  return RESOURCE_TYPES.has(type) ? type : 'other';
}
export function networkMethod(method: string): string {
  const upper = method.toUpperCase();
  return METHODS.has(upper) ? upper : 'other';
}

/** True when a blocked request is attributable to an action's own work: a document navigation, a fetch/XHR/socket, or any write method. Blocked stylesheets, images, fonts, media and script GETs are unrelated subresources. */
export function isActionNetworkBlock(warning: Pick<NetworkWarning, 'resource_type' | 'method'>): boolean {
  // Warnings without classification (older adapters) stay conservative.
  if (warning.resource_type === undefined && warning.method === undefined) return true;
  return (
    ACTION_RESOURCE_TYPES.has(warning.resource_type ?? '') ||
    (warning.method !== undefined && warning.method !== 'GET' && warning.method !== 'HEAD')
  );
}
