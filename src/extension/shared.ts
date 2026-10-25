import * as vscode from 'vscode';

export interface Settings {
  enabled: boolean;
  autoUpdate: boolean; checkForUpdates: boolean; updateManifestUrl: string;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('agentdesklink');
  return {
    enabled: c.get<boolean>('enabled', false),
    autoUpdate: c.get<boolean>('autoUpdate', true),
    checkForUpdates: c.get<boolean>('checkForUpdates', true),
    updateManifestUrl: c.get<string>('updateManifestUrl', ''),
  };
}

export const log = {
  channel: undefined as vscode.OutputChannel | undefined,
  line(msg: string) {
    const stamp = new Date().toISOString();
    try { this.channel?.appendLine(`[agentdesklink] ${stamp} ${msg}`); } catch { /* ignore */ }
    try { console.log(`[agentdesklink] ${msg}`); } catch { /* ignore */ }
  },
};
