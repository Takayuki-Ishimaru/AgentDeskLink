import * as vscode from 'vscode';
import {normalizePermissions, parsePermissionsEnv, effectivePermissions, describePermissionError, type EffectivePermissions, type ExtensionPermissions} from '../bundled-policy.js';

export {parsePermissionsEnv};
export type {ExtensionPermissions};

export interface Settings {
  enabled: boolean;
  syncClients: boolean;
  autoUpdate: boolean; checkForUpdates: boolean;
  browserOrigins: string[];
  desktopAppId: string; desktopAppPath: string;
  allowAllOperations: boolean; allowPhysicalInput: boolean; allowUnredactedImages: boolean;
  allowLoopback: boolean; allowPrivateNetwork: boolean;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('agentdesklink');
  return {
    enabled: c.get<boolean>('enabled', false),
    syncClients: c.get<boolean>('syncClients', false),
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

// Pick only grants: connection and update settings never become permissions.
function grantInput(s: Settings): ExtensionPermissions {
  return {
    browserOrigins: s.browserOrigins, desktopAppId: s.desktopAppId, desktopAppPath: s.desktopAppPath,
    allowAllOperations: s.allowAllOperations, allowPhysicalInput: s.allowPhysicalInput,
    allowUnredactedImages: s.allowUnredactedImages, allowLoopback: s.allowLoopback,
    allowPrivateNetwork: s.allowPrivateNetwork,
  };
}
function resolvePermissions(s: Settings): {grants: ExtensionPermissions; error: string | null} {
  try {
    const grants = normalizePermissions(grantInput(s));
    if (Buffer.byteLength(JSON.stringify(grants), 'utf8') > 65_536) return {
      grants: normalizePermissions({}), error: 'agentdesklink.browserOrigins: expected format / 期待する形式: serialized grants <= 65536 bytes. All grants are denied / すべての権限を拒否します。',
    };
    return {grants, error: null};
  } catch (error) { return {grants: normalizePermissions({}), error: describePermissionError(error)}; }
}
export function mcpPermissions(s: Settings): ExtensionPermissions { return resolvePermissions(s).grants; }
export function permissionError(s: Settings): string | null { return resolvePermissions(s).error; }
export interface PermissionSummary {
  requested: ExtensionPermissions;
  effective: EffectivePermissions;
}
export function panelPermissions(s: Settings, helperPath?: string, platform: string = process.platform): PermissionSummary {
  const {grants, error} = resolvePermissions(s);
  const effective = effectivePermissions(grants, helperPath, platform);
  if (error) effective.reasons.push(error);
  return {requested: grantInput(s), effective};
}
export function permissionsEnvJson(s: Settings): string { return JSON.stringify(mcpPermissions(s)); }

export const log = {
  channel: undefined as vscode.OutputChannel | undefined,
  line(msg: string) {
    const stamp = new Date().toISOString();
    try { this.channel?.appendLine(`[agentdesklink] ${stamp} ${msg}`); } catch { /* ignore */ }
    try { console.log(`[agentdesklink] ${msg}`); } catch { /* ignore */ }
  },
};
