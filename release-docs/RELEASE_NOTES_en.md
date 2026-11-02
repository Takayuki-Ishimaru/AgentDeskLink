# AgentDeskLink 0.1.8 (beta)

[日本語](RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents operate the local browser and desktop over MCP. Read the [supported environments and known limitations](KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.7

- **Fewer false positives in consequential-action checks.** Controls are still recognised by their verb (delete, send, pay, unsubscribe, log out…), and ordinary actions are now less often treated as consequential. Adjust the classification with `consequentialAllowLabels` / `consequentialDenyLabels`.
- **Consistent detection and approval of real form submissions.** A real submission is detected for both GET and POST and requires approval, while forms handled within JavaScript (`preventDefault`) remain available in Standard mode. When a submission is approved, the page's scripts run on both the cancelled attempt and the approved retry. Use `wait_ms` in `adl_approvals` to wait for a decision. Retrying an action distinguishes human rejection (`approval_denied`), a withdrawn or used approval (`approval_invalidated`), and expiry (`approval_expired`).
- **Standard-mode Delete buttons run with network restrictions.** A button that is consequential only because of the words "Delete", "Remove" or "削除" (links are not included) now runs with the network restricted until your next action and returns the `contained_action` warning. See "Delete buttons and network restrictions" below.
- **204 / 205 responses no longer end the session.** When a navigation, form or link response arrives with 204 or 205 and no content, the current page normally stays and the response is `ok: true` with the warning `no_content`. A redirect that sets cookies can replace it with an empty page; navigate again in that case. Cookies set by a redirect are retained, and 301 / 302 / 303 responses to a POST are followed as GET. In Standard and Ask modes, 307 / 308 redirects that would forward a write beyond the approved URL are refused.
- **Navigation to allowed origins for SSO sign-ins.** A read-only navigation now follows a redirect to an origin granted in `browserOrigins`. An origin without a grant stops with `redirect_origin_not_allowed`, so not every SSO flow works.
- **Improved Linux desktop control.** Improved post-action changes reported through AT-SPI and fixed duplicate labels on GTK 4 buttons.
- **Improved observations and actions.** Added clicks on links that span several lines, values and diffs for `contenteditable`, min / max / step for sliders and spin buttons, and page scrolling without an element ID. Observations and tool definitions now omit fields left at their default value.
- **Improved the settings panel and first setup.** Added a summary of the current permissions, a getting-started checklist and collapsible advanced settings.

## Delete buttons and network restrictions

In Standard mode, pressing a button that is consequential only because of the words "Delete", "Remove" or "削除" runs it with the network restricted until your next action, and the response carries the `contained_action` warning. Page scripts still run.

- GET requests shaped like those the page was already making before the click continue (query values containing digits are not distinguished). New data requests, navigations and new images, CSS, fonts and media are blocked.
- A GET that starts after your next action is not stopped. Writes such as POST remain blocked.
- A periodic request that starts for the first time right after the click cannot be told apart from the button's own and is reported as blocked; configure `consequentialAllowLabels` in that case.
- Links (`<a href>`) with those words are not run. Ask mode still asks for approval.

These restrictions do not undo page-script effects or side effects caused by existing GET requests.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.8.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js, image-processing libraries and desktop helpers for each OS. The Linux helper also needs OS-provided Python 3 and AT-SPI2 packages. Reload the window after installation.

The updaters in 0.1.3 through 0.1.7 support this release. Automatic updates may arrive in stages. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

**An existing `agentdesklink.allowAllOperations: true` still takes precedence after updating.** To use a permission tier, select Read only, Standard or Ask each time in the panel. Enabling MCP alone grants no target access.

Register other AI clients with **AI Clients → Enable all**. They share the selected workspace's permissions, including from other projects in those clients. Reconnect when needed after updating, changing permissions or restarting VS Code. Other servers and manual entries with the same name are preserved.

See the [installation guide](INSTALL_en.md), [operation settings and approvals](OPERATIONS.md) and [update guide](UPDATES_en.md).

## Usage notes

- Only read-only navigation to an origin granted in `browserOrigins` (excluding those classified `SECRET` / `UNKNOWN`) is followed. `browserOrigins` also lists the origins a session's scripts may navigate to. Per-target controls, image capture and gestures do not apply on the destination origin, and the manual-login grant stays origin-scoped. Cross-origin writes (cross-origin POST), iframe and subresource redirects, and SAML form POST remain unsupported.
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
