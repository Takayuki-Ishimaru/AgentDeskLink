# Supported Environments and Known Limitations

[日本語](KNOWN_ISSUES.md) | **English**

Target version: `0.1.7`

This beta is provided for a limited range of use. It is not guaranteed to work with every application or operating system configuration.

## Supported environments

| Environment | Scope and conditions |
| --- | --- |
| macOS 14 or newer, Apple silicon | Browser and desktop. The Accessibility permission is required, and image capture also requires Screen Recording |
| Windows 11 x64 | Browser and desktop. Runs in the same interactive session as the target application |
| Linux x64 (Ubuntu 24.04) | Browser. Requires shared libraries for Chrome / Chromium and a working OS sandbox. Desktop: semantic control through AT-SPI (python3-gi, gir1.2-atspi-2.0, at-spi2-core) |
| macOS x64, Windows arm64, Linux arm64 | Not supported by this common VSIX |

Even on the same operating system, the available operations can differ by application, display scaling and monitor configuration. Check that your operating system and CPU are supported by the common VSIX.

This release uses the same VSIX on macOS / Apple silicon, Windows x64 and Linux x64. Linux desktop control covers observation and semantic actions (click, fill, check, select, scroll) through AT-SPI. Window capture, physical input and application launch/quit are unsupported and listed in `platform_unsupported` of `adl_capabilities`. On Wayland window positions are unavailable, only sizes. Focus-change detection is a best-effort probe that depends on the X11 window manager. GTK 4 check boxes expose no AT-SPI action, so `check` fails with `E_UNSUPPORTED_ACTION`. Qt 5 discovery may require the X root window to carry the accessibility bus address (`AT_SPI_BUS`). Without it (for example in a Wayland session), a Qt 5 application started with accessibility already enabled may not appear in discovery. In a Wayland session (`WAYLAND_DISPLAY` set) an X display ID is reported only for applications running through XWayland, not for native Wayland applications. Linux distributions other than Ubuntu 24.04 have not been verified.

Ubuntu's user-namespace restrictions may require additional sandbox setup for automatically downloaded Chromium. See [Linux preparation](INSTALL_en.md#per-operating-system-preparation).

## Applications and input

- Application status, launch and normal quit are available on macOS and Windows with explicit permission in a CLI policy. The default VS Code extension profile does not enable this launch/quit feature. On Windows, applications launch on a dedicated Win32 desktop; existing human-started applications are not moved to that desktop.
- Only permitted instances started by this server can be quit. Applications started by a person, frontmost applications, and applications with documents being edited are never quit or force quit.
- Background semantic operation does not guarantee complete non-interference, including delayed actions by the application itself.
- Select `interactive_desktop` mode to use physical input. It uses the same mouse and keyboard as the person, so do not use it while someone is working on the desktop.
- Desktop swipes are implemented as scrolling; they do not provide real operating system touch points.
- MCP enablement, target grants, permission tiers, physical input and unredacted images are separate settings. One-shot approval covers inspected controls in the main document, open Shadow DOM and same-origin iframes. For native apps the permission tier is also enforced inside the macOS, Windows and Linux helpers, and one-shot approval covers consequential controls only (delete, send and similar); sensitive controls are never operated, even with approval. Closed shadow roots and out-of-process iframe proofs remain unsupported. Same-origin iframe actions still require reobservation after page updates. Existing `allowAllOperations: true` takes precedence over the tier. CLI restrictions follow the supplied policy.
- If helper communication is cancelled or interrupted by a timeout, the session may become invalid. Restart the MCP server explicitly and start again from obtaining the target.

- Emergency stop applies to extension-managed servers and cannot undo processing already dispatched to an application. Stop manually launched servers through their MCP host.

## Browser approvals and manual interaction

- A network permit covers one inspected URL-encoded form POST. Multipart, files and generic AJAX/DELETE remain unsupported. Page handlers that change the payload cause refusal.
- One-shot approval (browser and native) is unavailable without a connection to VS Code, or when the granted desktop app is the VS Code host itself and could operate the approval dialog.
- Manual-login network permission applies to the current origin for at most 120 seconds. Website scripts may send, change or delete during that interval. Automation stays paused, but resume and expiry cannot roll back requests already dispatched.
- Coordinate clicks require the latest retained image, unchanged target and geometry, and an image age below 30 seconds. Capture again if the page changes.

See [operation settings and approvals](OPERATIONS.md).

## Browser networking and reading

- `browserOrigins` grants navigation; `browserResourceOrigins` grants only GET/HEAD subresource loading. Resource grants do not permit navigation or form submission. Unapproved fetch POST is blocked even for search.
- Check `network_blocked` / `warnings`. `network_blocked` is set only when the action's own traffic was blocked; unrelated subresource blocks are counted in `subresources_blocked`. An action response with `ok: true` acknowledges input and does not guarantee application success. `include_diff: true` returns immediate changes. If only the observation fails, inspect `observation_error`, observe again and avoid repeating the action.
- Pages whose DOM APIs cannot be verified safely stop with `untrusted_dom_api`. Ordinary Web Components are supported where verification is possible. Named properties from script-free markup such as `<input name="item">` or `<img name="title">` are not treated as tampering. A navigation that lands on an unverifiable page keeps the session; leave it with `back` / `navigate`.
- If a form contains a control named like an element API, such as `getAttribute`, `parentElement` or `matches`, click, fill (including date, time, color and range inputs), check and select switch to a direct path that does not use Playwright. `press` (keys) and `hover` still use Playwright and can fail on such forms (for example with `E_STALE_STATE`).
- In standard mode, submit buttons and Enter work for forms that JavaScript handles (`preventDefault`). A real form submission (GET or POST) is cancelled inside the browser before it is sent and returns `form_submission_requires_approval`; sending requires approval in ask mode. Buttons labelled delete, purchase, login and similar are still not run in standard mode. A submission scheduled by a timer after the click is outside the guard; its POST is still blocked by the network layer.
- Approval dialogs list only the form fields that are actually submitted (checked boxes, the selected radio and options, the pressed button).
- Bundled Node uses OS-trusted certificates. Destination DNS/IP checks remain local and TLS verification remains enforced through proxies. Hosts resolvable only by the proxy are unsupported.
- Use `text` in `adl_observe` to read beyond a clipped name. Offsets refer to redacted text. Visibility and protection checks may prevent reading. Observation and image collection have limits; check truncation flags.

## Images and privacy

Extension browser capture is limited to permitted origins; native capture requires separate permission. For the CLI, allow capture in the policy. Browser masks cover iframes, closed Shadow DOM, explicit protected regions, detected sensitive labels and secret text patterns. Ordinary inputs and checkboxes remain visible. Personal data such as email and phone numbers is masked by default; `allowPersonalData` explicitly permits revealing it. Credentials and protected regions remain protected. `redacted: true` records masking, not complete secret detection; inspect `redaction.scope` and `redaction.methods` for its scope. Unknown secrets in images or text cannot be detected completely. Information returned over MCP is passed to the AI host, so check which targets you allow to be captured.

Frame sequences can be captured, but audio, encoded video and automatic periodic capture are not supported.

Browser regions marked `data-adl-sensitive` or `data-adl-classification="SECRET"` / `"UNKNOWN"` protect their descendants as well. A child marked `PUBLIC` cannot remove that protection. Semantic observations redact protected content; ordinary control allowlists cannot authorize actions within these regions. Browser captures and retained crops mask them. These explicit markers complement automatic detection.

If a select candidate list exceeds the observation budget, the control retains its name and current state and reports `options_truncated: true`. Reobserve with `scope: "id:<element_id>"` and a larger `token_budget` to retrieve candidates, or omit `options` from `include`. At most 100 candidates are collected; reaching that source limit or clipping candidate text also sets this flag. Check it even when the last cursor page has `truncated: false`.

## Distribution and updates

- The Windows helper is unsigned and the macOS helper is ad-hoc signed. macOS notarization is not supported.
- The update source is fixed to the official GitHub repository and needs no configuration.
- When no release matches your operating system and CPU, only a check takes place and nothing is installed.
- Automatic updates from a distribution point that requires authentication are not supported; install the VSIX manually in that case.
- After an update, the window must be reloaded. A window in use is never reloaded automatically.

See the [installation guide](INSTALL_en.md) and the [update guide](UPDATES_en.md) for details. AgentDeskLink is provided under the [MIT License](../LICENSE). Bundled third-party software remains subject to its respective licenses.


## Reporting problems

When reporting a problem to the channel published by the distributor, include your operating system and CPU, the AgentDeskLink and VS Code versions, the reproduction steps and the error code. Open the logs from the settings panel or run “AgentDeskLink: ログを開く / Open Logs” in the Command Palette to check related errors. Do not send logs or images that contain personal information, credentials, screen contents or entered values.

To stop operations, first stop the server in the VS Code MCP management view and then turn off MCP for the workspace.
