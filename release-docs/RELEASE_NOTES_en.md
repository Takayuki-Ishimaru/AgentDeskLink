# AgentDeskLink 0.1.1 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents operate the local browser and desktop over MCP. Read the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Main changes

- In VS Code, trust the workspace and enable MCP to start. No policy JSON or Node.js path is required.
- The settings panel and Command Palette provide emergency stop and resume. The stop state is shared across extension-managed workspaces and persists after restart.
- Each VSIX bundles the matching Node.js and, on macOS and Windows, a desktop helper. Chrome uses a dedicated profile; if unavailable, a dedicated Chromium is downloaded automatically.
- Updated the Japanese and English guides for setup, operation scope, stopping and updates.

## Features

- Reads UI elements and changes, then clicks, fills, selects and scrolls. Multiple windows of the same application are handled individually.
- Captures browser or target-window images with `adl_capture` and inspects crops from retained images.
- Supports browser drags and touch swipes through `adl_gesture`, and timestamped frame sequences through `adl_record`.
- `interactive_desktop` uses the real mouse and keyboard. Inspect the target with `adl_prepare_input` before `adl_commit_input`. Preparation also moves the pointer, so do not use it while someone is interacting with the desktop.
- For macOS and Windows applications explicitly allowed in a CLI policy, `adl_applications` and `adl_app` provide status, launch and normal quit.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install the package for your operating system and CPU. No separate Node.js installation or build is needed. To replace an earlier beta, install the matching `0.1.1` VSIX and reload the window.

See the [installation guide](INSTALL_en.md) and [update guide](UPDATES_en.md).

## Usage notes

MCP starts disabled. Enabling it in the VS Code extension broadly permits the supported operations. There is no dedicated approval UI for consequential actions. Review the actions and targets you give the AI.

- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- Emergency stop cannot undo input or processing already dispatched to an application.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording.
- The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Linux supports browser operations only and requires a working Chromium operating system sandbox.

## License

AgentDeskLink is available under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.
