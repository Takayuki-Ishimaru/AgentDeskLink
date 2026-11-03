# AgentDeskLink 0.1.9 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents control a local browser and desktop through MCP. Check the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.8

- **Approve the requests web apps send to save data.** Ask mode holds fetch / XHR writes started during an action before sending them. Review the method, URL and body (with secrets masked), then send only the approved requests. The AI waits with `adl_approvals` and does not need to repeat the action.
- **Allow writes to a site for a limited time.** “Allow further writes to this site” in the approval dialog grants eligible requests from the AI server in the same VS Code window to the same destination origin for up to 30 minutes. The grant applies across chats and can be viewed and revoked in the settings panel. Requests carrying credentials and actions classified as purchases or payments are excluded. See the details below.
- **Identify changes that were not saved.** An action whose writes were blocked returns `write_blocked: true`. Standard mode continues to block write requests, so a change visible on screen may not have been saved.
- **Read clearer changes and warnings after an action.** The server waits up to 400 ms for requests started by the action and page changes to settle before returning the diff. Warnings are reported once, and action responses include warnings belonging to that action.
- **Use GET search forms without approval.** Recognised GET search forms work in Standard and Ask modes without approval. POST forms, forms carrying credentials and consequential actions such as deletion are excluded from this exception.
- **Simpler approval for Delete buttons.** Buttons classified as consequential only because of “Delete”, “Remove” or “削除” also run with network restrictions in Ask mode, which asks about the write request when one occurs. Other consequential controls, such as purchase or send, still require approval for the button action itself.
- **Read a selected area and get clearer scroll results.** Use `scope: "within:<element_id>"` in `adl_observe` to read inside an element. Reading main, article, named section and paragraph text containing links has improved. Scroll results distinguish a target that cannot scroll from one already at its edge.
- **Better Linux tab switching and selection.** Switching GTK tabs keeps the session open with `focus_moved` when focus moves within the same window. Observe again before the next action. Use `select` with `value` to choose a named option in a combo box, list or tab list. Consequential options must be targeted directly.

## Save approvals and continued site permission

Held writes cover POST, PUT, PATCH and DELETE requests from the main frame to the same origin or a granted origin. Bodies may be absent or contain up to 64 KiB of JSON, URL-encoded data or text/plain. Multipart, files, binary or streaming bodies, synchronous XHR, beacons and iframe writes cannot be held and are blocked. Writes started outside an action, such as timers and autosave, are also blocked. Start a save through an explicit action.

Approval sends the held requests. Denial, expiry, navigation, page-side cancellation and emergency stop discard them. Requests already sent cannot be undone. `ok: true` acknowledges input and does not guarantee that data was saved or a site operation completed.

Continued site permission ends on a settings or workspace-trust change, emergency stop, extension reload, revocation or expiry. Approval before a consequential button action, GET form submissions that require approval, and sets of writes to multiple origins remain outside this grant. Exclusion of credentials, purchases and payments relies on best-effort classification of site labels and URLs. While the grant is active, the AI can write to the site without asking again; use it only for sites you trust.

See [operation settings and approvals](OPERATIONS.md) and [known limitations](KNOWN_ISSUES_en.md) for the full scope and steps.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.9.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js, image-processing libraries and desktop helpers for each OS. The Linux helper also needs OS-provided Python 3 and AT-SPI2 packages. Reload the window after installation.

The updaters in 0.1.3 through 0.1.8 support this release. Automatic updates may arrive in stages. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

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
