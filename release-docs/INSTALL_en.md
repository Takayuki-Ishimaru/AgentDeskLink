# Installation and First Steps

[日本語](INSTALL.md) | **English**

Target version: `0.1.11` (beta)

## Requirements

- VS Code 1.101 or newer.
- The common `agentdesklink-0.1.11.vsix` package. Check the [supported environments and known limitations](KNOWN_ISSUES_en.md).
- A network connection for the first Chromium download if Chrome is not installed.

One VSIX bundles Node.js and image-processing libraries for macOS / Apple silicon, Windows x64 and Linux x64. It also includes the macOS, Windows and Linux desktop helpers (the Linux helper is a Python 3 script that needs the OS python3-gi packages). It selects the matching runtime at startup, so no separate build is needed.

The distribution file is shared across these operating systems. This common VSIX does not support macOS x64, Windows arm64 or Linux arm64.

## Installation

1. Download `agentdesklink-0.1.11.vsix` and `SHA256SUMS` from the release page.
2. Compute the SHA-256 using the [update guide](UPDATES_en.md) and confirm it matches the list.
3. In the VS Code Command Palette, choose “Extensions: Install from VSIX...” and select the VSIX.
4. Open the folder you want to use, review its contents and trust the workspace.
5. Open **AgentDeskLink** in the activity bar on the left.
6. Review effective permissions. Fresh settings enable all supported operations, all URLs and applications without registration; choose Read only, Draft or Save with approval if needed.
7. MCP is on by default in trusted workspaces. If previously disabled, turn on Enable MCP.
8. Approve the server start in the VS Code MCP management view.

## Use Claude Code and other AI clients

The **AI clients** section detects standard installations of Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Devin, Gemini CLI, Cline and Roo Code. **Enable all** registers AgentDeskLink with detected clients and enables the VS Code provider. Claude Code uses its own MCP settings, so the VS Code provider alone does not make tools available there. Reconnect or start a new conversation after registration.

**Detect again** finds newly installed clients. With `agentdesklink.syncClients` enabled, registrations also synchronize on startup and permission changes. Each client displays its registration, detection, conflict or error status. Other servers are preserved, and manual entries named `agentdesklink` are never overwritten or removed. Codex TOML updates the managed section while preserving comments and formatting elsewhere. Before changes, a backup is saved beside the file as `.agentdesklink.bak-…`. Backups also contain configuration data; handle them accordingly.

External clients share the permissions of the workspace where **Enable all** was last clicked. Opening another workspace does not take ownership. **Disable all** removes managed registrations and stops existing external connections. Permission changes and emergency stop also revoke old connections; reconnect when required. Registrations remain after VS Code exits. User-level registration makes that workspace's granted scope available from other projects in the client. Locations selected by `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `CLINE_MCP_SETTINGS_PATH`, plus modern and legacy Cline locations, are supported when visible to the extension. Other locations and unsupported clients require manual setup.

## Initial settings and scope

The following are workspace settings for the VS Code extension.

Trusted workspaces enable MCP, all supported operations, all http(s) URLs and applications, physical input, native images, loopback and private networks by default. No per-origin/application registration or policy JSON is needed. Explicit saved denials and previously selected restricted tiers are preserved. OS accessibility and screen-recording permissions remain necessary. Linux supports AT-SPI semantic control; native capture and physical input remain unsupported.

| Setting | What to configure |
| --- | --- |
| `agentdesklink.allowAllBrowserOrigins` / `agentdesklink.allowAllApplications` | On by default. Turn off to use individual origin/application grants |
| `agentdesklink.browserOrigins` | When All URLs is off: exact allowed `http(s)` origins, such as `https://example.com`, without paths or wildcards |
| `agentdesklink.browserResourceOrigins` | Origins permitted only for GET/HEAD subresources such as CDN assets, separately from navigation grants |
| `agentdesklink.allowPersonalData` | Reveals personal data such as email and phone numbers. Defaults to off; credentials and protected regions remain protected |
| `agentdesklink.desktopAppId` / `agentdesklink.desktopAppPath` | The ID and absolute executable path of one allowed app |
| `agentdesklink.operationMode` | `read_only`, `standard` (Draft) or `ask` (Save with approval); fresh settings use `allowAllOperations: true` |
| `agentdesklink.consequentialAllowLabels` / `agentdesklink.consequentialDenyLabels` | Button and link labels never / always treated as consequential (up to 64 entries of 1–64 characters each). Entries match the whole label or a whole word; Japanese entries match as substrings. The deny list wins. Credential, real form-submission, file, download and protected-region checks are unaffected. Set them in settings.json |
| `agentdesklink.allowAllOperations` | All supported operations, on by default, including saves. Selecting a restricted tier turns this off. Turning it back on shows a confirmation |
| `agentdesklink.browserHeadless` | Defaults to `true`. Set false for a visible browser and manual login |
| `agentdesklink.sessionIdleMinutes` | Idle session timeout, 1–60 minutes; defaults to 15 |
| `agentdesklink.browserProxyServer` | HTTP(S) proxy origin without credentials, path or query; defaults to empty |
| `agentdesklink.browserProxyConnectByHostname` | Off by default; sends HTTPS CONNECT by hostname for proxies that grant hosts by name. Local DNS/IP and TLS checks remain enforced |
| `agentdesklink.allowUnredactedImages` | Allows unredacted native images. On by default on supported platforms |
| `agentdesklink.allowPhysicalInput` | Physical input is on by default and needs native-image permission and a supported OS. All applications avoids individual registration |
| `agentdesklink.allowLoopback` / `agentdesklink.allowPrivateNetwork` | Allows loopback/private-network connections. On by default |

Check “Current permissions” in the panel to see the effective grants. Observation alone does not require broad operation permissions or physical input.

### Choose by task

- **Run the task**: keep the default All operations; registration and per-save approval are unnecessary.
- **View only**: choose Read only; an explicitly configured read-only tier completes setup.
- **Draft a form**: choose Draft; `save.state: draft_unsaved` identifies blocked saving.
- **Save with approval**: choose this tier; All applications turns off, and native targets must exclude the approval host. After fetch/XHR approval observe without replaying; a cancelled form submission retries only the approved identical action.

### Permission tiers and one-shot approvals

- **Read only**: observe, navigate and scroll. Browser operations are refused with `read_only_mode`. Allowed desktop apps are observe-only; operations are refused with `desktop_operation_not_granted`.
- **Standard**: ordinary browser inputs, clicks and forms handled within JavaScript, plus ordinary actions on the allowed desktop app on macOS, Windows and Linux (click, fill, check, select, scroll); consequential actions such as purchase, deletion or credential entry are denied. Browser actions are classified by the control's verb (delete, send, pay, unsubscribe, log out…) and by real form submissions; links that only navigate within the same origin, a dialog's Cancel, and nouns such as Order history are ordinary. Write requests a page sends to save data (fetch / XHR POST, PUT, PATCH, DELETE) are blocked, so most web apps cannot save changes (the action response carries `write_blocked: true`).
- **Ask each time**: standard actions plus inspected consequential actions approved once in a VS Code dialog. Submit buttons and Enter run as in Standard; only when a form is really submitted is the submission cancelled and approval requested. A write the page sends during an action is held unsent inside the browser; the dialog shows its method, URL and body fields (secrets masked), only the approved content is sent, once, and the AI reads the outcome (`sent`) with `adl_approvals`. Delete / Remove buttons run without a confirmation of the click, and the write they send is approved in one dialog. Choosing "Allow further writes to this site" in the dialog approves further writes to the same site for up to 30 minutes without a dialog (credentials and purchases still ask; revoke it in the panel). For a desktop app the dialog shows the app ID, window title, role and control name. Review the target and contents, then approve or deny. The AI cannot decide the approval. After approval, the AI observes the result (for a form submission or a click approval it retries the same operation).

Browser approvals cover inspected controls in the main document, open Shadow DOM and same-origin iframes. A desktop approval covers a single action on a consequential control (delete, send and similar) at the observed revision only. Sensitive controls such as password fields are always refused, even with approval. Closed shadow roots and out-of-process iframe proofs remain unsupported. A write can be held when it is a main-frame fetch / XHR with no body or a JSON, URL-encoded or text/plain body of at most 64 KiB. File uploads (multipart), binary bodies, writes from iframes, writes that start outside an action (timers, autosave) and a fifth write from one action are blocked. Changed contents, expiry and emergency stop invalidate approvals. Unavailable approval dialogs do not authorize consequential operations. Secret values are not sent to the dialog.

An existing `allowAllOperations: true` still takes precedence after updating. To use a permission tier, select Read only, Standard or Ask each time in the panel. Reconnect external clients after changing settings when needed.

### Manual login in a visible browser

Turn off `browserHeadless` and pause automation with `adl_handoff` and `pause`. Ask each time requires a separate dialog allowing website scripts and forms on the current origin to send requests for up to 120 seconds. The site may send, change or delete before a human click during this interval. After manual interaction, use `resume` and observe again. Resume and expiry cannot undo requests already sent. Read only and Standard cannot obtain this network grant.

See [operation settings and approvals](OPERATIONS.md) for details.

The extension uses its bundled Node.js and helper without manual path settings. Chrome runs with a dedicated profile and does not share your usual sign-in state. If Chrome is unavailable, a dedicated Chromium is downloaded and reused.

When launching the CLI from another MCP host, supply a policy JSON with `--config`. That configuration is separate from the VS Code extension.

## Per-operating-system preparation

- **macOS**: desktop control requires Accessibility permission, and image capture requires Screen Recording. Grant these in System Settings.
- **Windows**: run the target application and server in the same interactive session.
- **Linux x64 (Ubuntu 24.04)**: browser operations are supported. Install the operating system shared libraries needed by Chrome or Chromium and run as a regular user with a working OS sandbox. If libraries are missing, install the browser runtime dependencies through your operating system package manager.
- **Linux desktop control (AT-SPI2)**: install `sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core` and enable accessibility (GNOME: `gsettings set org.gnome.desktop.interface toolkit-accessibility true`; on other X11 desktops a running `at-spi-bus-launcher` is enough). In the settings panel the application ID is the AT-SPI application name and the path is the absolute executable (`readlink /proc/<pid>/exe`; for scripted applications this is the interpreter). List application names with:

  ```sh
  python3 -c "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi; d=Atspi.get_desktop(0); print(*[(a.get_name(), a.get_process_id()) for a in (d.get_child_at_index(i) for i in range(d.get_child_count())) if a], sep='\n')"
  ```

  Supported are window observation and the semantic actions click / fill / check / select / scroll. The standard tier refuses consequential controls (delete, send, purchase, login and similar) and sensitive fields such as passwords (sensitive fields stay refused even with all operations allowed). Physical input, window images and application launch/quit are unsupported on Linux and listed under `platform_unsupported` in `adl_capabilities`. Native Wayland apps expose size but no screen position or display ID. XWayland apps still return an X display ID within a Wayland session. GTK 4 check boxes have no AT-SPI action, so `check` is reported as unsupported for them. Switching a GTK page tab keeps the session and returns the warning `focus_moved`; observe again before the next action. If another window or application becomes active, the session is closed with `desktop_focus_changed`. `select` accepts a `value` on a combo box, list or tab list and chooses the option by name. Without the prerequisite packages or an accessibility bus, operations fail with reason `linux_accessibility_unavailable`.

Ubuntu 24.04 restricts user namespaces, so automatically downloaded Chromium may need an administrator to configure its sandbox. Use an OS-installed Chrome or ask your administrator to review Chromium's [sandbox setup](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md). AgentDeskLink does not change operating system settings automatically or launch Chromium with its sandbox disabled.

Virtual workspaces are not supported. MCP cannot be enabled in an untrusted workspace.

## If something does not work

- If installation fails, check the VS Code version, operating system and CPU, and the VSIX hash.
- If the server does not start, check workspace trust, MCP enablement and the emergency-stop state.
- If no target appears or you receive `E_POLICY_DENIED`, check the allowed origins/app and operation permissions. Enabling MCP alone adds no grants.
- If the bundled runtime or helper is missing, check that your operating system and CPU are supported and reinstall the common VSIX.
- For `E_BACKEND_UNAVAILABLE`, check operating system permissions and browser requirements.
- A failed update check usually means a temporary network or GitHub problem. See the [update guide](UPDATES_en.md).

## Emergency stop and resume

Use **AgentDeskLink: Emergency Stop** from the settings panel or Command Palette to stop operations in extension-managed servers. The stop state applies across the workspaces managed by the extension and persists after restart. Use **AgentDeskLink: Resume Operations** to resume, then restart the server from MCP management if needed. Input or processing already dispatched to an application cannot be undone.

Stop servers launched manually from another MCP host through that host.

## Stopping and uninstalling

If you registered other AI clients, first use **AI Clients → Disable all** to remove managed registrations. Uninstalling the extension alone does not remove entries from those clients.

1. Stop running servers in the VS Code MCP management view.
2. Turn off MCP for this workspace.
3. To stop update checks, turn off `agentdesklink.checkForUpdates`.
4. Uninstall AgentDeskLink in the Extensions view and reload the window.

Stop and remove definitions registered manually with other MCP hosts separately. macOS permissions remain after uninstallation; revoke them in System Settings if no longer needed.
