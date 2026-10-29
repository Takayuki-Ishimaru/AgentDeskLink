# AgentDeskLink 0.1.6 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents operate the local browser and desktop over MCP. Read the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.5

- **Improved browser action and one-shot approval reliability.** In the main document, unrelated display updates such as clocks no longer invalidate the action. Targets, exact input, form contents and document changes are still checked. Expired, reused or emergency-stop-revoked approvals are refused.
- **Added actions in open Shadow DOM and same-origin iframes.** Inspected controls support ordinary actions and one-shot approval. Closed shadow roots, out-of-process iframe proofs and native app approvals remain unsupported.
- **Separated navigation grants from resource-loading grants.** `browserResourceOrigins` allows GET/HEAD subresources such as CDN assets without granting navigation. Standard mode supports GET search forms, and action responses report blocked network requests.
- **Improved reading of long text and large tables.** Use `text` in `adl_observe` to retrieve text beyond a clipped name. Observations include parent relationships for tables, rows and lists. `adl_act` with `include_diff: true` returns immediate changes after an action.
- **Improved masking and error explanations.** Fewer ordinary labels are hidden unnecessarily. Revealing personal data requires an explicit `allowPersonalData` grant; credentials and protected regions remain protected. Errors give clearer reasons for occlusion, missing grants and connection failures.
- **Reorganized the settings panel.** Grants appear near the top, advanced settings collapse, and Japanese/English language switching and loopback/private-network controls are available. Adding localhost alone does not enable its network grant.
- **Improved networking and client registration.** Added connection reuse and conditional caching of public static assets. Bundled Node uses OS-trusted certificates. Registration also supports larger Claude client configuration files.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.6.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js and image-processing libraries plus macOS/Windows helpers. Reload the window after installation.

The updaters in 0.1.3 through 0.1.5 support this release. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

**An existing `agentdesklink.allowAllOperations: true` still takes precedence after updating.** To use a permission tier, select Read only, Standard or Ask each time in the panel. Enabling MCP alone grants no target access.

Register other AI clients with **AI Clients → Enable all**. They share the selected workspace's permissions, including from other projects in those clients. Reconnect when needed after updating, changing permissions or restarting VS Code. Other servers and manual entries with the same name are preserved.

See the [installation guide](INSTALL_en.md), [operation settings and approvals](OPERATIONS.md) and [update guide](UPDATES_en.md).

## Usage notes

- One-shot approval covers inspected controls in the main document, open Shadow DOM and same-origin iframes. Closed shadow roots, out-of-process iframe proofs and native app approvals remain unsupported. Reobserve after page updates when acting inside a same-origin iframe. Network permits cover one inspected URL-encoded form POST; multipart, files and generic AJAX/DELETE remain unsupported.
- Approval is unavailable without a connection to VS Code, or when permitted native operations could operate the approval host itself.
- During a manual handoff network grant, website scripts may send, change or delete before a human click. Resume, expiry and emergency stop cannot undo requests already dispatched.
- Physical input and unredacted native images default to off. `interactive_desktop` uses the real mouse and keyboard; do not use it while someone is interacting with the desktop.
- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording. The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Linux supports browser operations only. Ubuntu 24.04 x64 requires the shared libraries needed by Chrome / Chromium and a working OS sandbox.
- Use **Disable all** to remove managed external-client registrations before uninstalling the extension.

## License

AgentDeskLink is available under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.
