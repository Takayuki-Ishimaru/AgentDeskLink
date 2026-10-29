# AgentDeskLink 0.1.7 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents operate the local browser and desktop over MCP. Read the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.6

- **Added Linux desktop control.** On Ubuntu 24.04 x64, AT-SPI2 supports window observation and semantic click, fill, check, select and scroll actions. OS accessibility settings and additional packages are required. Window capture, physical input and application launch/quit are unsupported.
- **Added desktop permission tiers and one-shot approvals.** Read only, Standard and Ask each time apply to the granted app on macOS, Windows and Linux. Ask confirms consequential controls such as delete or send in VS Code, one action at a time. Sensitive controls such as password fields are never operated, even with approval.
- **Improved browser actions and approvals.** Improved target checks after scrolling, named page and form elements, and immediate diffs after approval. Standard mode supports forms handled within JavaScript; real GET/POST form submissions are stopped before sending and require approval. Approval dialogs also reflect the actual submitted fields.
- **Made observations easier to read.** Element IDs use short session-specific names. Tables, lists, link destinations and images with alternative text are easier to inspect. Element omission is distinguished from clipped text, with clearer page-search syntax and argument errors.
- **Improved setup and first launch.** The panel helps select a desktop app. Failed browser downloads offer retry and an explicit choice of an installed browser. Allow all confirmation describes the operations being granted.
- **Added a corporate proxy option.** Explicitly enabling `browserProxyConnectByHostname` sends HTTPS CONNECT requests by hostname. Local DNS/IP checks and TLS hostname verification remain enforced.
- **Improved masking, warnings and stopping.** Expanded secret masking, distinguished action-related network blocks from unrelated subresource blocks, and improved saving the emergency-stop state on Windows.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.7.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js, image-processing libraries and desktop helpers for each OS. The Linux helper also needs OS-provided Python 3 and AT-SPI2 packages. Reload the window after installation.

The updaters in 0.1.3 through 0.1.6 support this release. Automatic updates may arrive in stages. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

**An existing `agentdesklink.allowAllOperations: true` still takes precedence after updating.** To use a permission tier, select Read only, Standard or Ask each time in the panel. Enabling MCP alone grants no target access.

Register other AI clients with **AI Clients → Enable all**. They share the selected workspace's permissions, including from other projects in those clients. Reconnect when needed after updating, changing permissions or restarting VS Code. Other servers and manual entries with the same name are preserved.

See the [installation guide](INSTALL_en.md), [operation settings and approvals](OPERATIONS.md) and [update guide](UPDATES_en.md).

## Usage notes

- Browser one-shot approval covers inspected controls in the main document, open Shadow DOM and same-origin iframes. Closed shadow roots and out-of-process iframe proofs remain unsupported. Network permits cover one inspected URL-encoded form POST; multipart, files and generic AJAX/DELETE remain unsupported.
- Approval binds the target, input and observed state. Reobserve when the screen changes. Approval is unavailable without a connection to VS Code, or when the granted desktop app could operate the approval dialog.
- On Linux, available AT-SPI2 features depend on the app and desktop environment. See [known limitations](KNOWN_ISSUES_en.md) for GTK 4 check boxes, Qt 5 discovery and Wayland geometry restrictions.
- During a manual handoff network grant, website scripts may send, change or delete before a human click. Resume, expiry and emergency stop cannot undo requests already dispatched.
- Physical input and unredacted native images default to off. `interactive_desktop` uses the real mouse and keyboard; do not use it while someone is interacting with the desktop.
- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording. The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Use **Disable all** to remove managed external-client registrations before uninstalling the extension.

## License

AgentDeskLink is available under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.
