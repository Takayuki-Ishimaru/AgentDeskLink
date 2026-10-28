# AgentDeskLink 0.1.5 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents operate the local browser and desktop over MCP. Read the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.4

- Added **operation permission tiers**: Read only (default), Standard for ordinary browser inputs and clicks, and Ask each time for inspected consequential operations. Origins/apps, physical input and unredacted native images remain separate grants.
- Added **one-shot browser approvals** through a VS Code dialog. Review the target and action, then approve or deny. Approval binds the target, exact input, form contents and observed state. Changes, expiry and emergency stop prevent reuse. Secret values are not sent to the dialog, and the AI cannot approve its own request.
- Added panel settings for **browser origins, visible/headless launch, idle timeout and proxy**. Idle timeout is 1–60 minutes, with a default of 15.
- Added **`adl_handoff`** to pause automation for manual interaction in a visible browser. Ask each time uses a separate confirmation allowing website scripts and forms on the current origin to send requests for up to 120 seconds, so you can sign in manually and resume.
- Added **`compact` / `lines` observation formats**, **`press` / `back` / `hover` actions and coordinate clicks from retained images**. Use `adl_sessions` for sessions and deadlines, and `adl_approvals` for approval request status.
- Browser captures now show ordinary inputs and checkboxes while retaining masks for explicit protected regions, known secret patterns, iframes and closed Shadow DOM. Coordinate clicks require the latest image, unchanged target and geometry, and an image age below 30 seconds.
- Improved AI-client configuration discovery, including environment-selected locations for Codex, Claude Code and Cline, plus modern and legacy Cline paths. Codex TOML keeps comments and formatting outside the managed section and creates a backup before changes.
- Improved browser network controls, target checks through proxies, cancellation cleanup and observation response sizing. The updater prefers a matching platform-specific VSIX when available in the same release and continues to support the common VSIX.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.5.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js and image-processing libraries plus macOS/Windows helpers. Reload the window after installation.

The updaters in 0.1.3 and 0.1.4 support this release. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

**An existing `agentdesklink.allowAllOperations: true` still takes precedence after updating.** To use a permission tier, select Read only, Standard or Ask each time in the panel. Enabling MCP alone grants no target access.

Register other AI clients with **AI Clients → Enable all**. They share the selected workspace's permissions, including from other projects in those clients. Reconnect when needed after updating, changing permissions or restarting VS Code. Other servers and manual entries with the same name are preserved.

See the [installation guide](INSTALL_en.md), [operation settings and approvals](OPERATIONS.md) and [update guide](UPDATES_en.md).

## Usage notes

- One-shot approval covers inspected controls in the browser main document. Native apps, iframe and Shadow DOM controls cannot be escalated. Network permits cover one inspected URL-encoded form POST; multipart, files and generic AJAX/DELETE remain unsupported.
- Approval is unavailable without a connection to VS Code, or when permitted native operations could operate the approval host itself.
- During a manual handoff network grant, website scripts may send, change or delete before a human click. Resume, expiry and emergency stop cannot undo requests already dispatched.
- Physical input and unredacted native images default to off. `interactive_desktop` uses the real mouse and keyboard; do not use it while someone is interacting with the desktop.
- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording. The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Linux supports browser operations only. Ubuntu 24.04 x64 requires the shared libraries needed by Chrome / Chromium and a working OS sandbox.
- Use **Disable all** to remove managed external-client registrations before uninstalling the extension.

## License

AgentDeskLink is available under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.
