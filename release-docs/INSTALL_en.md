# Installation and First Steps

[日本語](INSTALL.md) | **English**

Target version: `0.1.3` (beta)

## Requirements

- VS Code 1.101 or newer.
- The common `agentdesklink-0.1.3.vsix` package. Check the [supported environments and known limitations](KNOWN_ISSUES_en.md).
- A network connection for the first Chromium download if Chrome is not installed.

One VSIX bundles Node.js and image-processing libraries for macOS / Apple silicon, Windows x64 and Linux x64. It also includes the macOS and Windows desktop helpers. It selects the matching runtime at startup, so no separate build is needed.

The distribution file is shared across these operating systems. This common VSIX does not support macOS x64, Windows arm64 or Linux arm64.

## Installation

1. Download `agentdesklink-0.1.3.vsix` and `SHA256SUMS` from the release page.
2. Compute the SHA-256 using the [update guide](UPDATES_en.md) and confirm it matches the list.
3. In the VS Code Command Palette, choose “Extensions: Install from VSIX...” and select the VSIX.
4. Open the folder you want to use, review its contents and trust the workspace.
5. Open **AgentDeskLink** in the activity bar on the left.
6. Choose “Open Settings” in the panel and configure the browser origins or desktop app and the operation permissions you need. See “Initial settings and scope” below.
7. Turn on “Enable the AgentDeskLink MCP server for this workspace”.
8. Approve the server start in the VS Code MCP management view.

## Initial settings and scope

The following are workspace settings for the VS Code extension.

MCP is disabled by default for every workspace. Enabling it grants no target access. Configure browser origins and the desktop app in AgentDeskLink settings, then enable broad operations, physical input and unredacted native images separately when needed. No policy JSON is required. There is no dedicated approval UI for consequential actions such as submission or purchases. Review the actions and targets you give the AI before enabling MCP.

| Setting | What to configure |
| --- | --- |
| `agentdesklink.browserOrigins` | Exact allowed `http(s)` origins, such as `https://example.com`, without paths or wildcards |
| `agentdesklink.desktopAppId` / `agentdesklink.desktopAppPath` | The ID and absolute executable path of one allowed app |
| `agentdesklink.allowAllOperations` | Allows supported operations on permitted targets. Target access is a separate grant. Defaults to off |
| `agentdesklink.allowUnredactedImages` | Allows unredacted native images. Defaults to off |
| `agentdesklink.allowPhysicalInput` | Allows physical input. Also requires a configured app and `allowUnredactedImages`. Defaults to off |
| `agentdesklink.allowLoopback` / `agentdesklink.allowPrivateNetwork` | Allows loopback/private-network connections. Defaults to off |

Check “Current permissions” in the panel to see the effective grants. Observation alone does not require broad operation permissions or physical input.

The extension uses its bundled Node.js and helper without manual path settings. Chrome runs with a dedicated profile and does not share your usual sign-in state. If Chrome is unavailable, a dedicated Chromium is downloaded and reused.

When launching the CLI from another MCP host, supply a policy JSON with `--config`. That configuration is separate from the VS Code extension.

## Per-operating-system preparation

- **macOS**: desktop control requires Accessibility permission, and image capture requires Screen Recording. Grant these in System Settings.
- **Windows**: run the target application and server in the same interactive session.
- **Linux x64 (Ubuntu 24.04)**: browser operations are supported. Install the operating system shared libraries needed by Chrome or Chromium and run as a regular user with a working OS sandbox. If libraries are missing, install the browser runtime dependencies through your operating system package manager.

Virtual workspaces are not supported. MCP cannot be enabled in an untrusted workspace.

## If something does not work

- If installation fails, check the VS Code version, operating system and CPU, and the VSIX hash.
- If the server does not start, check workspace trust, MCP enablement and the emergency-stop state.
- If no target appears or you receive `E_POLICY_DENIED`, check the allowed origins/app and operation permissions. Enabling MCP alone adds no grants.
- If the bundled runtime or helper is missing, check that your operating system and CPU are supported and reinstall the common VSIX.
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
