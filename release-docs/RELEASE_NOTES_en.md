# AgentDeskLink 0.1.11 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents control a local browser and desktop through MCP. Check the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.10

- **Start operating with the default settings in a trusted workspace.** MCP, all supported operations, and access to all http(s) URLs and applications are enabled by default. Physical input and native images on supported operating systems, plus localhost and private-network connections, are also allowed by default. This includes submitting, deleting and purchasing without individual confirmation; review Current permissions in the panel when installing. Operating system permissions are still required.
- **Choose permissions by task.** The selector offers Read only, Draft (no save), Save with approval, and All operations. Choosing a restricted tier turns off All operations and physical input. Save with approval also turns off All applications; configure an individual native app other than the VS Code host displaying the approval dialog.
- **Distinguish input delivery from saving.** The `save` fields on action and approval results and related errors describe an unsaved draft, pending approval, a submitted request or a result needing verification, together with the next step. Submission does not guarantee persistence. After approving a fetch / XHR write, observe the result without repeating the action.
- **Search and page through long choice lists.** The `options` argument of `adl_observe` reaches choices beyond the initial 100. Search runs over masked content and scans up to 10,000 choices. Omissions caused by acquisition, field limits and response capacity are reported separately.
- **Set observation capacity in bytes.** `byte_budget` limits the UTF-8 JSON response size. The existing `token_budget` remains available but does not guarantee a model-specific token count. The two arguments cannot be combined.
- **Improved personal-data masking in tables and definition lists.** Names and addresses can be protected using headings and surrounding structure. Arbitrary names and addresses cannot all be recognized. Enabling `allowPersonalData` still keeps credentials and explicitly protected regions protected.
- **Improved desktop discovery and handling of concurrent activity.** macOS and Linux separate permission to discover all applications from permission to operate them. Windows semantic actions recheck their target when focus or pointer changes accompany human input. Target replacement and unexplained changes stop operations. Physical input still must not be used concurrently with a person.

## Settings when updating

Explicit saved denials and existing Read only, Standard and Ask settings are preserved. An existing `agentdesklink.allowAllOperations: true` still takes precedence. To narrow permissions, select a tier in the panel and review the effective URL, application, image, physical-input and network permissions. Permission to reveal personal data remains off by default.

Save-request approvals and continued permission to write to a trusted site for up to 30 minutes remain available. See [operation settings and approvals](OPERATIONS.md) and [known limitations](KNOWN_ISSUES_en.md) for their scope and restrictions.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.11.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js, image-processing libraries and desktop helpers for each OS. The Linux helper also needs OS-provided Python 3 and AT-SPI2 packages. Reload the window after installation.

The updaters in 0.1.3 through 0.1.10 support this release. Automatic updates may arrive in stages. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

See the [installation guide](INSTALL_en.md#initial-settings-and-scope) to select a restricted tier and configure its target scope.

Register other AI clients with **AI Clients → Enable all**. They share the selected workspace's permissions, including from other projects in those clients. Reconnect when needed after updating, changing permissions or restarting VS Code.

See the [installation guide](INSTALL_en.md) and [update guide](UPDATES_en.md).

## Usage notes

- Individual approvals need a connection to VS Code. Observe again when the target, input or observed state changes. Closed shadow roots and out-of-process iframe approvals remain unsupported.
- Available Linux actions depend on the app and desktop environment. Window capture, physical input and application launch/quit are unsupported. When a different window or app becomes active, the session closes with `desktop_focus_changed`.
- During a manual-login network grant, site scripts may send, change or delete data. Resume, expiry and emergency stop cannot undo requests already sent.
- Physical input and unredacted native images are allowed by default on supported operating systems. `interactive_desktop` uses the real mouse and keyboard; do not use it while someone is interacting with the desktop.
- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording. The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Use **Disable all** to remove managed external-client registrations before uninstalling the extension.

## License

AgentDeskLink is available under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.
