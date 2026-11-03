# AgentDeskLink 0.1.10 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents control a local browser and desktop through MCP. Check the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.9

- **A compatibility path for reading pages such as GitHub.** An initial document whose DOM APIs cannot be verified is read through browser DOM APIs isolated from page JavaScript. A session marked `read_only: true` supports text, search and navigation; input, clicks, scrolling, capture and manual handoff are refused. Personal-data masking and network restrictions remain in place.
- **Read deeper page structures and reach the body beyond a long table of contents.** DOM acquisition reaches depth 64. Default full observations include `landmarks` that lead to the body; use `text` or `within:<element_id>` to read the relevant content. `source_limits` distinguishes data omitted during acquisition from response pagination.
- **Omit concealed prose while preserving useful control labels.** Hidden, transparent and tiny prose is excluded and marked with `hidden_text: true`. Legitimate screen-reader control labels remain accessible names. The flag alone does not establish malicious intent.
- **Improved masking of Japanese personal data.** Protection now covers postal codes, numbered addresses, labeled names and addresses, and input values identified by form labels or autocomplete hints. Arbitrary unlabeled names and addresses cannot all be recognized. Enabling `allowPersonalData` still keeps credentials and explicitly protected regions protected.
- **Approval for closing or discarding in desktop apps.** Close, Quit, Exit, Discard and Do not save are denied in Standard mode and require confirmation before dispatch in Ask mode. A disappearing target or a focus change does not prove that an app exited; check the target list again.
- **Clearer approval dialogs.** Dialogs use Japanese or English according to the VS Code display language. Browser actions can include nearby row, item or dialog context. This is page-provided information and does not certify which resource the server will affect. Protected regions, concealed prose and input values are excluded from this extra context.
- **Clearer diagnostics for continuing an operation.** Connection failures are distinguished from policy blocks, stale-state errors include the current revision, and targets expose supported gesture surfaces. Observe again after an error and avoid repeating an action whose effect may already have occurred.

## Compatibility-read scope

A compatibility session stays read-only; changing permissions does not enable input in it. Child-frame contents are omitted and reported as `frame_unavailable` in `source_limits`. Later tampering with the same document already observed through the normal path still stops with `untrusted_dom_api`.

Save-request approvals and continued permission to write to a trusted site for up to 30 minutes remain available. See [operation settings and approvals](OPERATIONS.md) and [known limitations](KNOWN_ISSUES_en.md) for their scope and restrictions.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.10.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js, image-processing libraries and desktop helpers for each OS. The Linux helper also needs OS-provided Python 3 and AT-SPI2 packages. Reload the window after installation.

The updaters in 0.1.3 through 0.1.9 support this release. Automatic updates may arrive in stages. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

**An existing `agentdesklink.allowAllOperations: true` still takes precedence after updating.** To use a permission tier, select Read only, Standard or Ask in the panel. Enabling MCP alone grants no target access.

Register other AI clients with **AI Clients → Enable all**. They share the selected workspace's permissions, including from other projects in those clients. Reconnect when needed after updating, changing permissions or restarting VS Code.

See the [installation guide](INSTALL_en.md) and [update guide](UPDATES_en.md).

## Usage notes

- Individual approvals need a connection to VS Code. Observe again when the target, input or observed state changes. Closed shadow roots and out-of-process iframe approvals remain unsupported.
- Available Linux actions depend on the app and desktop environment. Window capture, physical input and application launch/quit are unsupported. When a different window or app becomes active, the session closes with `desktop_focus_changed`.
- During a manual-login network grant, site scripts may send, change or delete data. Resume, expiry and emergency stop cannot undo requests already sent.
- Physical input and unredacted native images default to off. `interactive_desktop` uses the real mouse and keyboard; do not use it while someone is interacting with the desktop.
- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording. The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Use **Disable all** to remove managed external-client registrations before uninstalling the extension.

## License

AgentDeskLink is available under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.
