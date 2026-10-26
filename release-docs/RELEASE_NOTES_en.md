# AgentDeskLink 0.1.4 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents operate the local browser and desktop over MCP. Read the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.3

- Added **bulk AI-client connection**. The settings panel detects standard configurations for Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Devin, Gemini CLI, Cline and Roo Code, and registers or removes MCP entries. VS Code MCP is switched at the same time.
- External clients use the permissions of the workspace where bulk enable was last selected. Other servers and manual entries with the same name are preserved. The panel displays registration status, conflicts and errors. Disabling, changing permissions or using emergency stop revokes previous managed connections.
- The panel now shows **effective permissions** and explains unmet requirements. Invalid permission settings identify the setting and expected format; grants are denied until corrected.
- Improved protection for sensitive browser regions. `data-adl-sensitive` and `data-adl-classification="SECRET"` / `"UNKNOWN"` also protect descendants, and a child marked `PUBLIC` cannot remove that protection. Protection covers observations, captures and retained crops, and ordinary actions inside protected regions are denied.
- When select choices exceed the observation response budget, the control keeps its name and current state and reports omitted choices with `options_truncated: true`. The same flag indicates that the source collection limit was reached.
- Fixed cancellation while opening URLs, batch operations, state cleanup after application quit and server shutdown. Improved manual update checks made immediately after cancelling an earlier check.
- Updated Japanese and English installation guides, including AI-client registration and removal.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.4.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js and image-processing libraries for each OS plus the macOS/Windows helpers, and selects the matching runtime at startup. Reload the window after installation.

The updater in 0.1.3 supports the common VSIX. Use the update-check and automatic-update settings, or download the VSIX and `SHA256SUMS` from the release page, verify the hash and install manually. Updating from 0.1.2 or earlier requires manual installation.

Registration with other AI clients is opt-in. Review the allowed origins/app and operation permissions, then select **AI Clients → Enable all**. Each client may require reconnection, a new conversation or a restart. Registration uses user settings, so the selected workspace's granted scope is also available from other projects in those clients. Codex TOML is reformatted while preserving its configuration values. Nonstandard configuration locations are outside automatic registration.

See the [installation guide](INSTALL_en.md) and [update guide](UPDATES_en.md).

## Usage notes

- MCP starts disabled. Enabling it grants no target access or operation permissions. There is no dedicated approval UI for consequential actions.
- Physical input and unredacted native images default to off. `interactive_desktop` uses the real mouse and keyboard; do not use it while someone is interacting with the desktop.
- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- Emergency stop cannot undo input or processing already dispatched to an application.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording.
- The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Linux supports browser operations only. Ubuntu 24.04 x64 requires the shared libraries needed by Chrome / Chromium and a working OS sandbox.
- Use **Disable all** to remove managed external-client registrations before uninstalling the extension.

## License

AgentDeskLink is available under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.
