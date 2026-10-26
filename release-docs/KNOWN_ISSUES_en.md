# Supported Environments and Known Limitations

[日本語](KNOWN_ISSUES.md) | **English**

Target version: `0.1.4`

This beta is provided for a limited range of use. It is not guaranteed to work with every application or operating system configuration.

## Supported environments

| Environment | Scope and conditions |
| --- | --- |
| macOS 14 or newer, Apple silicon | Browser and desktop. The Accessibility permission is required, and image capture also requires Screen Recording |
| Windows 11 x64 | Browser and desktop. Runs in the same interactive session as the target application |
| Linux x64 (Ubuntu 24.04) | Browser. Requires shared libraries for Chrome / Chromium and a working OS sandbox |
| macOS x64, Windows arm64, Linux arm64 | Not supported by this common VSIX |

Even on the same operating system, the available operations can differ by application, display scaling and monitor configuration. Check that your operating system and CPU are supported by the common VSIX.

This release uses the same VSIX on macOS / Apple silicon, Windows x64 and Linux x64. Desktop control is unavailable on Linux. Linux distributions other than Ubuntu 24.04 have not been verified.

Ubuntu's user-namespace restrictions may require additional sandbox setup for automatically downloaded Chromium. See [Linux preparation](INSTALL_en.md#per-operating-system-preparation).

## Applications and input

- Application status, launch and normal quit are available on macOS and Windows with explicit permission in a CLI policy. The default VS Code extension profile does not enable this launch/quit feature. On Windows, applications launch on a dedicated Win32 desktop; existing human-started applications are not moved to that desktop.
- Only permitted instances started by this server can be quit. Applications started by a person, frontmost applications, and applications with documents being edited are never quit or force quit.
- Background semantic operation does not guarantee complete non-interference, including delayed actions by the application itself.
- Select `interactive_desktop` mode to use physical input. It uses the same mouse and keyboard as the person, so do not use it while someone is working on the desktop.
- Desktop swipes are implemented as scrolling; they do not provide real operating system touch points.
- MCP enablement, permitted origins/apps, broad operations, physical input and unredacted images are separate workspace settings. Enabling MCP alone grants no targets or additional privileges. There is no dedicated approval UI for consequential actions. Review the scope you give the AI for actions such as submission or purchases. CLI restrictions follow the supplied policy.
- If helper communication is cancelled or interrupted by a timeout, the session may become invalid. Restart the MCP server explicitly and start again from obtaining the target.

- Emergency stop applies to extension-managed servers and cannot undo processing already dispatched to an application. Stop manually launched servers through their MCP host.

## Images and privacy

Extension browser capture is limited to permitted origins; native capture requires separate permission. For the CLI, allow capture in the policy. Browser masks cover controls, frames, detected sensitive labels and text patterns. `redacted: true` records masking, not complete secret detection; inspect `redaction.scope` and `redaction.methods` for its scope. Unknown secrets in images or text cannot be detected completely. Information returned over MCP is passed to the AI host, so check which targets you allow to be captured.

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
