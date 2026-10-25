# Installation and First Steps

[日本語](INSTALL.md) | **English**

Target version: `0.1.2` (beta)

## Requirements

- VS Code 1.101 or newer.
- A VSIX for your operating system and CPU. Check the [supported environments and known limitations](KNOWN_ISSUES_en.md).
- A network connection for the first Chromium download if Chrome is not installed.

Each VSIX bundles Node.js. macOS and Windows builds also include the desktop helper, so no separate build is needed. Check the release attachments for the operating systems and CPUs being distributed.

## Installation

1. Download the VSIX for your operating system and CPU and its `SHA256SUMS` file from the release page.
2. Compute the SHA-256 using the [update guide](UPDATES_en.md) and confirm it matches the list.
3. In the VS Code Command Palette, choose “Extensions: Install from VSIX...” and select the VSIX.
4. Open the folder you want to use, review its contents and trust the workspace.
5. Open **AgentDeskLink** in the activity bar on the left.
6. Turn on “Enable the AgentDeskLink MCP server for this workspace”.
7. Approve the server start in the VS Code MCP management view.

## Initial settings and scope

MCP is disabled by default for every workspace. Enabling it through the VS Code extension permits the supported browser and desktop operations. No policy JSON is required. There is no dedicated approval UI for consequential actions such as submission or purchases. Review the actions and targets you give the AI before enabling MCP.

The extension uses its bundled Node.js and helper without manual path settings. Chrome runs with a dedicated profile and does not share your usual sign-in state. If Chrome is unavailable, a dedicated Chromium is downloaded and reused.

When launching the CLI from another MCP host, supply a policy JSON with `--config`. That configuration is separate from the VS Code extension.

## Per-operating-system preparation

- **macOS**: desktop control requires Accessibility permission, and image capture requires Screen Recording. Grant these in System Settings.
- **Windows**: run the target application and server in the same interactive session.
- **Linux**: browser operations only. The environment must support the Chromium operating system sandbox.

Virtual workspaces are not supported. MCP cannot be enabled in an untrusted workspace.

## If something does not work

- If installation fails, check the VS Code version, operating system and CPU, and the VSIX hash.
- If the server does not start, check workspace trust, MCP enablement and the emergency-stop state.
- If the bundled runtime or helper is missing, reinstall the VSIX for your operating system and CPU.
- For `E_BACKEND_UNAVAILABLE`, check operating system permissions and browser requirements.
- A failed update check usually means a temporary network or GitHub problem. See the [update guide](UPDATES_en.md).

## Emergency stop and resume

Use **AgentDeskLink: Emergency Stop** from the settings panel or Command Palette to stop operations in extension-managed servers. The stop state applies across the workspaces managed by the extension and persists after restart. Use **AgentDeskLink: Resume Operations** to resume, then restart the server from MCP management if needed. Input or processing already dispatched to an application cannot be undone.

Stop servers launched manually from another MCP host through that host.

## Stopping and uninstalling

1. Stop running servers in the VS Code MCP management view.
2. Turn off MCP for this workspace.
3. To stop update checks, turn off `agentdesklink.checkForUpdates`.
4. Uninstall AgentDeskLink in the Extensions view and reload the window.

Stop and remove definitions registered manually with other MCP hosts separately. macOS permissions remain after uninstallation; revoke them in System Settings if no longer needed.
