# AgentDeskLink 0.1.3 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents operate the local browser and desktop over MCP. Read the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.2

- The same VSIX now runs on macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js and image-processing libraries for each OS, plus the macOS/Windows helpers, and selects the matching runtime at startup.
- Separated MCP enablement from permissions. Configure browser origins, the desktop app, operations, physical input and unredacted native images separately. Enabling MCP alone grants no target access.
- Improved scoped screen diffs, element names, select choices and Japanese labels. Browser observations also support depth filtering.
- Improved browser screenshot masking for labels and text patterns that indicate sensitive information.
- Added optional `representation: "auto"` to `adl_observe`. It chooses full or delta output by response size and returns `reset: true` when switching to a full response.
- Other browser sessions can now continue while one session is waiting for a response.
- Improved screen-element reading and state checks during background operations on macOS and Windows.
- Updated the Japanese and English installation and update guides to match the current settings.

## Features

- Reads UI elements and changes, then clicks, fills, selects and scrolls. Multiple windows of the same application are handled individually.
- Captures browser or target-window images with `adl_capture` and inspects crops from retained images.
- Supports browser drags and touch swipes through `adl_gesture`, and timestamped frame sequences through `adl_record`.
- `interactive_desktop` uses the real mouse and keyboard. Inspect the target with `adl_prepare_input` before `adl_commit_input`. Preparation also moves the pointer, so do not use it while someone is interacting with the desktop.
- For macOS and Windows applications explicitly allowed in a CLI policy, `adl_applications` and `adl_app` provide status, launch and normal quit.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install the common `agentdesklink-0.1.3.vsix` package. No separate Node.js installation or helper build is needed. Reload the window after installation.

The updater in 0.1.2 and earlier does not recognize the new common filename. To upgrade to this version, download the common VSIX and `SHA256SUMS` from the release page, verify the hash and install it manually. Version 0.1.3 and later check the official GitHub releases for the common VSIX.

After updating, configure the allowed origins/app and operation permissions again. Enabling MCP alone does not allow operations. Physical input and unredacted native images default to off.

See the [installation guide](INSTALL_en.md) and [update guide](UPDATES_en.md).

## Usage notes

MCP starts disabled. Enabling the connection grants no target access or operation permissions. Configure browser origins, the desktop app, operations, physical input and unredacted native images separately in workspace settings. There is no dedicated approval UI for consequential actions. Review the actions and targets you give the AI.

- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- Emergency stop cannot undo input or processing already dispatched to an application.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording.
- The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Linux supports browser operations only and requires a working Chromium operating system sandbox.

## License

AgentDeskLink is available under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.
