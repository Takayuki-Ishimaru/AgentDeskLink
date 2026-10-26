import * as vscode from 'vscode';
import {normalizePermissions, parsePermissionsEnv, type ExtensionPermissions} from '../bundled-policy.js';

export {parsePermissionsEnv};
export type {ExtensionPermissions};

export interface Settings {
  enabled: boolean;
  autoUpdate: boolean; checkForUpdates: boolean;
  browserOrigins: string[];
  desktopAppId: string; desktopAppPath: string;
  allowAllOperations: boolean; allowPhysicalInput: boolean; allowUnredactedImages: boolean;
  allowLoopback: boolean; allowPrivateNetwork: boolean;
}

const GRANT_SETTING_KEYS = ['browserOrigins', 'desktopAppId', 'desktopAppPath', 'allowAllOperations',
  'allowPhysicalInput', 'allowUnredactedImages', 'allowLoopback', 'allowPrivateNetwork'] as const;

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('agentdesklink');
  return {
    enabled: c.get<boolean>('enabled', false),
    autoUpdate: c.get<boolean>('autoUpdate', true),
    checkForUpdates: c.get<boolean>('checkForUpdates', true),
    browserOrigins: c.get<string[]>('browserOrigins', []),
    desktopAppId: c.get<string>('desktopAppId', ''),
    desktopAppPath: c.get<string>('desktopAppPath', ''),
    allowAllOperations: c.get<boolean>('allowAllOperations', false),
    allowPhysicalInput: c.get<boolean>('allowPhysicalInput', false),
    allowUnredactedImages: c.get<boolean>('allowUnredactedImages', false),
    allowLoopback: c.get<boolean>('allowLoopback', false),
    allowPrivateNetwork: c.get<boolean>('allowPrivateNetwork', false),
  };
}

// Only the grant keys reach normalization; enabled/autoUpdate are never grant keys.
export function mcpPermissions(s: Settings): ExtensionPermissions {
  const picked: Record<string, unknown> = {};
  for (const key of GRANT_SETTING_KEYS) picked[key] = (s as unknown as Record<string, unknown>)[key];
  try { return normalizePermissions(picked); } catch { return normalizePermissions({}); }
}

export function permissionsEnvJson(s: Settings): string {
  const json = JSON.stringify(mcpPermissions(s));
  return Buffer.byteLength(json,'utf8') > 65_536 ? JSON.stringify(normalizePermissions({})) : json;
}

export const log = {
  channel: undefined as vscode.OutputChannel | undefined,
  line(msg: string) {
    const stamp = new Date().toISOString();
    try { this.channel?.appendLine(`[agentdesklink] ${stamp} ${msg}`); } catch { /* ignore */ }
    try { console.log(`[agentdesklink] ${msg}`); } catch { /* ignore */ }
  },
};
