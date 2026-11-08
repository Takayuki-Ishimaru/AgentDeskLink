# AgentDeskLink 0.1.12 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

AgentDeskLink is a VS Code extension that lets AI agents operate a local browser and desktop through MCP.

## Changes since 0.1.11

- **Permission settings carry over on update.** Setups with earlier settings or a record of prior use keep explicit choices and use the earlier restricted defaults for omitted permissions. First-time setups default to All operations. After updating, review the operation tier and allowed URLs and applications under Effective permissions.
- **Browser personal-data masking covers more cases.** When a choice list is identified as a name field, its selected value, choice labels and choice values are masked. Choice search uses the same protection. Phone masking covers hyphenated numbers, labelled numbers without separators, and full-width forms.
- **Request all observation fields in one call.** `adl_observe` accepts every field advertised for `include`.
- **The settings panel explains browser and desktop permissions separately.** In the browser, Standard blocks save requests and Ask for approval can hold writes for approval during an action. On desktop, Ask covers consequential actions such as delete or send, and apps can save or autosave during ordinary actions. Manually switching from a restricted mode to All operations opens a confirmation dialog.
- **Resume a batch after approval.** When a browser write is held, `adl_task` reports the approval state and request ID. Once the write is released, observe again and start a new batch with the remaining steps at the reported index. When an automatic save is blocked, the recovery hint points to the page’s Save control.
- **Updated bundled runtime and libraries.** This release uses Node.js 24.22.2 and Playwright 1.65.0. Chromium startup now distinguishes a missing executable from a sandbox launch failure.

## Installation and updates

Use VS Code 1.101 or newer and install `agentdesklink-0.1.12.vsix` with “Extensions: Install from VSIX.” The common VSIX supports macOS on Apple silicon, Windows x64 and Linux x64. For a manual update, verify the archive against `SHA256SUMS` and reload the VS Code window after installation.

Automatic updates may arrive in stages. Version 0.1.2 and earlier require a manual installation. See the [installation guide](INSTALL_en.md), [update guide](UPDATES_en.md) and [operation settings and approvals](OPERATIONS.md).

[Supported environments and known limitations](KNOWN_ISSUES_en.md) | [MIT License](../LICENSE)
