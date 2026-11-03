# Supported Environments and Known Limitations

[日本語](KNOWN_ISSUES.md) | **English**

Target version: `0.1.10`

This beta is provided for a limited range of use. It is not guaranteed to work with every application or operating system configuration.

## Reading and action limitations

- Pages such as GitHub whose initial DOM APIs cannot be verified open through isolated browser DOM APIs with `read_only: true`. Text, scoped search, pagination, navigation and back remain available. Input, scrolling, capture and manual handoff are disabled for that session. Child-frame contents are omitted with `frame_unavailable`. Later tampering with an already published document still fails closed.
- DOM acquisition stops at depth 64. `source_limits` identifies omissions that cursors cannot recover; read body text using a `landmarks` id.
- Purchase activation and an SPA request have separate approvals. The full request is unknown before its JavaScript runs.
- Replacement DOM nodes receive new IDs. Matching by name alone could silently retarget an action.
- Returning an action diff can take up to 400 ms. Check the next observation for save results or other messages that appear later. Paragraph, link and list-item content can partly overlap in the response.
- Personal-data masking uses known formats and labels; arbitrary names and addresses cannot all be recognized.

## Supported environments

| Environment | Scope and conditions |
| --- | --- |
| macOS 14 or newer, Apple silicon | Browser and desktop. The Accessibility permission is required, and image capture also requires Screen Recording |
| Windows 11 x64 | Browser and desktop. Runs in the same interactive session as the target application |
| Linux x64 (Ubuntu 24.04) | Browser. Requires shared libraries for Chrome / Chromium and a working OS sandbox. Desktop: semantic control through AT-SPI (python3-gi, gir1.2-atspi-2.0, at-spi2-core) |
| macOS x64, Windows arm64, Linux arm64 | Not supported by this common VSIX |

Even on the same operating system, the available operations can differ by application, display scaling and monitor configuration. Check that your operating system and CPU are supported by the common VSIX.

This release uses the same VSIX on macOS / Apple silicon, Windows x64 and Linux x64. Linux desktop control covers observation and semantic actions (click, fill, check, select, scroll) through AT-SPI. Window capture, physical input and application launch/quit are unsupported and listed in `platform_unsupported` of `adl_capabilities`. On Wayland window positions are unavailable, only sizes. Focus-change detection is a best-effort probe that depends on the X11 window manager. GTK 4 check boxes expose no AT-SPI action, so `check` fails with `E_UNSUPPORTED_ACTION`. Switching a GTK page tab only moves focus inside the window, so the session is kept and the warning `focus_moved` is returned; its revision is stale, so observe again before the next action. If another window or application becomes active, the session is closed with `desktop_focus_changed` (check the screen and open a new session). GTK 3 page tabs are selected by clicking them. `select` accepts a `value` on a combo box, list or tab list and chooses the option by its accessible name (an exact match, otherwise a single case-insensitive match; zero or several matches fail). A consequential option cannot be chosen through its container; target the option element itself. Qt 5 discovery may require the X root window to carry the accessibility bus address (`AT_SPI_BUS`). Without it (for example in a Wayland session), a Qt 5 application started with accessibility already enabled may not appear in discovery. In a Wayland session (`WAYLAND_DISPLAY` set) an X display ID is reported only for applications running through XWayland, not for native Wayland applications. Linux distributions other than Ubuntu 24.04 have not been verified.

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

- The form-submission approval covers one inspected URL-encoded form POST. Multipart and files remain unsupported, and page handlers that change the payload cause refusal.
- In Ask mode, a fetch / XHR write (POST, PUT, PATCH, DELETE) the page sends during an action is held unsent, and you can approve it after reviewing its content (`request_requires_approval`; the AI waits with `adl_approvals` and does not repeat the action). This covers writes from the main frame to the session origin or an allowed origin, with no body or a JSON, URL-encoded or text/plain body of at most 64 KiB. At most 4 requests per action and 25 lines in all are shown.
- A write that cannot be held (multipart or files, binary, a streamed (ReadableStream) body, over 64 KiB, a synchronous XHR the page waits for, beacons, writes from iframes, a fifth request, a description over 25 lines) is blocked as `request_not_approvable` and cannot be sent automatically in any tier. Even if the screen looks saved, it was not (`write_blocked: true` in the action response).
- A write that starts outside an action (a timer, autosave, a beacon) is always blocked as `background_write_blocked`; trigger the save with an explicit control such as its button. Writes the page chains after an approval (for example creating an order and then paying) are not held either and are blocked; operate the next step on the screen and that write is held and asked about.
- One request can be pending per session. A write another action sends meanwhile is blocked as `approval_pending_other_action`. A page-side timeout or abort, a navigation, a denial, expiry and emergency stop discard the held writes, and nothing is sent. The writes an action holds are one set that is released whole or not at all (if the page gives up on any one request, the whole set is discarded). If a request is stopped by the pre-dispatch checks after the approval, `sent` in `adl_approvals` is `false`. A write a timer sends inside an action's window is shown as that action's write (the dialog shows the request, not what started it).
- Standard mode blocks these writes (`method_requires_approval`), so most web apps cannot save changes. In `read_only`, every write a page sends is `background_write_blocked`.
- "Allow further writes to this site" in the dialog approves, for up to 30 minutes, every write the AI server of that VS Code window sends to the same destination origin. It survives across chats and ends after 30 minutes, on a settings change, a folder trust change, emergency stop, an extension reload or a revoke in the panel.
- Keeping credentials and purchase/payment-like operations out of a grant is a best-effort classification of labels and URLs the site controls, not a security boundary. While a grant is active, an AI steered by page text can make any write to that site without a dialog. Use it only on sites whose content you trust.
- Even with a grant, the confirmation before a consequential control is pressed, GET forms and write sets spanning several origins still ask every time.
- One-shot approval (browser and native) is unavailable without a connection to VS Code, or when the granted desktop app is the VS Code host itself and could operate the approval dialog.
- Manual-login network permission applies to the current origin for at most 120 seconds. Website scripts may send, change or delete during that interval. Automation stays paused, but resume and expiry cannot roll back requests already dispatched.
- Coordinate clicks require the latest retained image, unchanged target and geometry, and an image age below 30 seconds. Capture again if the page changes.

See [operation settings and approvals](OPERATIONS.md).

## Browser networking and reading

- `browserOrigins` grants navigation; `browserResourceOrigins` grants only GET/HEAD subresource loading. Resource grants do not permit navigation or form submission. In Standard mode, writes such as fetch POST are blocked even for search.
- Check `network_blocked` / `warnings`. `network_blocked` is set only when the action's own traffic was blocked; unrelated subresource blocks are counted in `subresources_blocked`. `write_blocked: true` means a write the page sent was blocked, so what the screen shows was not saved. An action response with `ok: true` acknowledges input and does not guarantee application success or that anything was saved. `include_diff: true` returns immediate changes. After an action the server waits until the requests it started have finished and the page has stopped changing (at most 400 ms) before computing the diff, so asynchronous messages such as a failed save appear in it; a message shown later can only be read in the next observation. If only the observation fails, inspect `observation_error`, observe again and avoid repeating the action.
- Warnings are reported once. An action response carries only the blocks that action caused and an observation carries the current page's blocks not reported yet. A navigation discards the previous page's blocks, and `adl_execute` steps do not repeat earlier warnings.
- Documents whose initial DOM APIs cannot be verified use the read-only compatibility path described above. Later tampering with an already observed document stops with `untrusted_dom_api`. Ordinary Web Components are supported where verification is possible. Named properties from script-free markup such as `<input name="item">` or `<img name="title">` are not treated as tampering. Leave a stopped document with `back` / `navigate`.
- If a form contains a control named like an element API, such as `getAttribute`, `parentElement` or `matches`, click, fill (including date, time, color and range inputs), check and select switch to a direct path that does not use Playwright. `press` (keys) and `hover` still use Playwright and can fail on such forms (for example with `E_STALE_STATE`).
- In standard mode, submit buttons and Enter work for forms that JavaScript handles (`preventDefault`). A real form submission (GET or POST) is cancelled inside the browser before it is sent and returns `form_submission_requires_approval`; sending requires approval in ask mode. A GET search form is the exception and is sent without approval (a form with `role="search"`, a form with an input of `type="search"` or named `q`, `query` or `search`, or a submission from a control whose name contains `search` or 検索); a control whose name is consequential, a form with a credential field, and POST are not covered. Ask mode uses the same detection and asks only when a real submission happens (page scripts run on both the cancelled attempt and the approved retry). Buttons whose verb is purchase, send, unsubscribe, log out and similar are not run in standard mode. A button consequential only because of "Delete", "Remove" or "削除" runs with network restrictions until the next action. Only requests shaped like those the page was already making before the click go on (query values containing digits are not told apart), and new images and the like are not loaded. A GET that starts after the next action is not stopped (a write such as POST is always blocked in Standard mode and held for approval in Ask mode). A new read request or navigation is stopped as `contained_request_blocked`. A periodic request that starts for the first time right after the click cannot be told apart from the button's own and is reported as stopped; use `consequentialAllowLabels` there. The same goes for a page that deletes through a GET URL (such as `/items/1/remove`). Ask mode runs these buttons with the same restrictions, shows no dialog for the click, and asks once about the write the button sends; other consequential controls such as purchase or send ask for the click first and then, separately, for the write they send. Links (`<a href>`) with those words still do not run; adjust the classification with `consequentialAllowLabels` / `consequentialDenyLabels`. A submission scheduled by a timer after the click is outside the guard; its POST is blocked as `background_write_blocked`. This limits traffic rather than containing the action: it does not make deletion safe, and page scripts and other side effects still run.
- Approval dialogs list only the form fields that are actually submitted (checked boxes, the selected radio and options, the pressed button).
- Bundled Node uses OS-trusted certificates. Destination DNS/IP checks remain local and TLS verification remains enforced through proxies. Hosts resolvable only by the proxy are unsupported.
- Use `text` in `adl_observe` to read beyond a clipped name. Offsets refer to redacted text. Visibility and protection checks may prevent reading. Observation and image collection have limits; check truncation flags.
- `main`, `article` and a `section` that has a name are returned as elements, and their id reads the whole body. A paragraph's name and read include inline text such as links. Text a human cannot see (not rendered, transparent, tiny) is left out of a read and flagged with `text.hidden_text: true`.
- `within:<element_id>` in `scope` keeps only what is inside that element (its descendants). An unknown id gives `scope_element_not_found`, and desktop apps give `scope_within_unsupported`. iframe content is appended at the end of the document, so the last container of the main document can include the first elements of an iframe.
- A `scroll` on a page or element that cannot scroll gives `E_UNSUPPORTED_ACTION` / `not_scrollable` (observe instead). A scroll that could not move because it is already at an edge succeeds (`ok: true`) with the warning `scroll_at_edge`.

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
