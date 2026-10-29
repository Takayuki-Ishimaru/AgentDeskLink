<p align="center">
  <img src="media/readme-hero-v2.png" alt="AgentDeskLink — Browser + Desktop, over MCP" width="1200">
</p>

[日本語](README.md) | **English**

# Give AI control of your browser and desktop.

**Browser and desktop alike — from the AI agent you already use.**

AgentDeskLink is an MCP server that connects AI agents to your local browser and desktop. It reads on-screen elements, performs permitted clicks and text entry, and provides images when visual context is needed.

[Get started](release-docs/INSTALL_en.md) · [What you can do](#what-you-can-do) · [Supported environments](#supported-environments) · [Release guide](release-docs/README_en.md) · [MIT License](LICENSE)

> **0.1.7 / Beta**\
> This beta is intended for a limited range of use. Before installing, review [supported environments and known limitations](release-docs/KNOWN_ISSUES_en.md).

This version adds Linux desktop control and desktop permission tiers with one-shot approvals, and improves browser actions, observations and setup. See [what changed](release-docs/RELEASE_NOTES_en.md) and the [operation settings and approval guide](release-docs/OPERATIONS.md).

## What you can do

| Capability | When it helps |
| --- | --- |
| **Read the screen as elements and diffs** | Get the role and value of buttons and fields, then re-read only what changed after an action |
| **Look at the parts that need it** | Capture the browser or target window to check rendering, including Canvas and charts |
| **Drive browsers and apps alike** | Run the typing, clicking, selecting and scrolling you have allowed, all over the same MCP connection |
| **Handle multiple windows separately** | Tell windows of the same app apart, and act on the one you actually observed |

Drag inside the browser, touch swipes and timestamped continuous frame capture are supported as well. Physical desktop input uses the `interactive_desktop` mode.

## Get started in VS Code

1. Download the common `agentdesklink-0.1.7.vsix` package, then install it with "Extensions: Install from VSIX".
2. Open a folder and trust the workspace.
3. Open **AgentDeskLink** in the activity bar.
4. Choose **Open Settings** and configure the allowed browser origins or desktop app and the operation permissions you need.
5. Turn on **Enable MCP for this workspace**, then start the server from the MCP management view.

**No separate Node.js installation or helper build is required.** The same VSIX includes the runtimes for all supported operating systems and selects one automatically at startup. Chrome runs in a dedicated profile, and if it is not found a dedicated Chromium is downloaded automatically on first use.

AgentDeskLink itself needs no external AI API key. AI connection and authentication happen on the MCP host side.

[See the installation steps →](release-docs/INSTALL_en.md)

### Connect other AI clients together

In the settings panel, choose **AI clients → Enable all** to detect installed Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Devin, Gemini CLI, Cline and Roo Code clients and register MCP. This also enables the VS Code MCP provider. **Disable all** removes managed registrations and stops connected external clients.

Clients share the permissions of the workspace where you last explicitly enabled them. Other MCP settings are preserved; existing manual registrations with the same name are reported individually. Clients may require reconnection, a new conversation or a restart.

## Supported environments

| Environment | What is available |
| --- | --- |
| **macOS 14 or later / Apple silicon** | Browser and desktop. Requires the OS accessibility permission, plus screen recording for image capture |
| **Windows 11 x64** | Browser and desktop. Desktop actions run in the same interactive session as the target app |
| **Linux x64 (Ubuntu 24.04)** | Browser and desktop (semantic control through AT-SPI2). The browser needs the shared libraries for Chrome or Chromium and a working OS sandbox; the desktop needs python3-gi, gir1.2-atspi-2.0 and at-spi2-core |

On macOS and Windows you can also check the state of, launch and normally close the apps you have allowed. Apps launched on Windows are placed on a dedicated Win32 desktop. Launching and closing are available when explicitly permitted in a CLI policy.

Linux desktop control is observation plus click / fill / check / select / scroll through the accessibility API (AT-SPI2) only. Physical input, window images and application launch/quit are unsupported and listed under `platform_unsupported` in `adl_capabilities`. The application ID is the AT-SPI application name and the path is the absolute executable (`readlink /proc/<pid>/exe`); see [Linux setup](release-docs/INSTALL_en.md#per-operating-system-preparation).

Which actions are available depends on your OS, app and display setup. See [supported environments and known limitations](release-docs/KNOWN_ISSUES_en.md) for details.

## Decide how far it can reach

- **Off by default.** MCP connection permission is separate from target access. Configure browser origins and the desktop app per workspace. Physical input and unredacted native images each default to off.
- **No configuration file is required.** The VS Code extension uses its bundled profile. When launching the CLI directly, configure targets and actions in a policy JSON.
- **Keep it apart from your everyday browser.** No human profile or sign-in state is shared.
- **Physical input uses a dedicated mode.** `interactive_desktop` uses your real mouse and keyboard, so do not run it alongside your own input.

Choose **Read only / Standard / Ask**. Standard permits ordinary input, clicks and forms handled within JavaScript. Real GET/POST form submissions require approval. Ask binds each approval to the exact target, input and form contents. In the main document, unrelated clock updates preserve approval; target, form or document changes, expiry and emergency stop invalidate it. Open Shadow DOM and same-origin iframes are supported. The same tiers apply to native actions in the granted desktop app (macOS, Windows and Linux): Standard operates only non-sensitive, non-consequential controls, and Ask approves consequential controls such as delete or send one at a time, bound to the target, control name and observed revision. Sensitive controls such as password fields are never operated, even with approval. Closed shadow roots and out-of-process iframe proofs remain unsupported. The legacy explicit all-operations setting takes precedence when enabled.

Configure trusted grants near the top of the panel. `browserOrigins` grants navigation targets; `browserResourceOrigins` separately grants CDN assets for GET/HEAD loading. Localhost needs both its exact origin and `allowLoopback`. Personal data is masked by default; explicitly enable `allowPersonalData` to reveal email addresses and phone numbers. Credentials and explicitly protected regions remain protected.

Use `adl_observe` with `text: {element_id, offset, length}` to read beyond a clipped name. Offsets refer to redacted text. `adl_act` with `include_diff: true` returns immediate changes and switches to a full observation (`reset: true`) after a navigation. `network_blocked` means the action's own traffic was blocked; unrelated subresource blocks are counted in `subresources_blocked`. `ok: true` acknowledges input, not application success. Unapproved fetch POST remains blocked even for search.

Unknown secrets in images or text cannot be detected completely. Use Emergency Stop in the settings panel or Command Palette to stop extension-managed operations, and Resume Operations to resume. Processing already dispatched to an application cannot be undone.

The panel also configures a visible browser, idle timeout and an HTTP(S) proxy without authentication. Use `adl_handoff` for a manual login in the visible browser. Ask mode requires a separate approval allowing same-origin website scripts and forms to send requests for at most 120 seconds while automation is paused. Website scripts may send, change or delete before a human click during this interval. Resume and observe again after the manual step. Resume and expiry cannot undo requests already dispatched.

Bundled Node starts with `--use-system-ca`. Destination DNS/IP validation remains local, including through a proxy, so hosts resolvable only by the proxy are unsupported. Pages whose DOM APIs cannot be verified fail closed with `untrusted_dom_api`. See [supported environments and known limitations](release-docs/KNOWN_ISSUES_en.md).

`adl_observe` supports `format: "compact"` to omit declared defaults and `"lines"` for escaped rows. JSON remains the default; diffs, scope and cursors work in all formats. `scope` searches the page: quote with `text:"v1.0: fixed"`, or use `role:` / `name:` / `id:` (see [operation settings](release-docs/OPERATIONS.md)). Links include `href`, images and canvas with a text alternative appear as `img`, and elements containing text that is hard for people to see carry `hidden_text: true`. Coordinate clicks use `adl_act` with `point: {frame_id,x,y}` in source CSS pixels from the latest retained capture. Capture again when geometry or the target changes.

Browser regions marked `data-adl-sensitive` or `data-adl-classification="SECRET"` / `"UNKNOWN"` protect their descendants as well. Neither a child marked `PUBLIC` nor `allowAllOperations` removes that protection. Semantic observations redact protected content, and actions within these regions are denied. Browser captures and retained crops mask them. These explicit markers complement automatic detection.

If a select candidate list exceeds the observation budget, the control retains its name and current state and reports `options_truncated: true`. Reobserve with `scope: "id:<element_id>"` and a larger `token_budget` to retrieve candidates, or omit `options` from `include`. At most 100 candidates are collected; reaching that source limit or clipping candidate text also sets this flag. Check it even when the last cursor page has `truncated: false`.

## Try it from source

Clone this repository and run the following commands in its folder. Node.js 24 or later is required. The VSIX and documentation ZIP do not include the demo source.

```sh
npm ci
npx playwright install chromium
npm run build
```

In another terminal, start the local demo.

```sh
node examples/demo-server.mjs
```

Start the server from your MCP host, pointing it at the demo policy. Replace the paths with your real absolute paths. The settings file format differs by host.

```json
{
  "mcpServers": {
    "agentdesklink": {
      "command": "node",
      "args": [
        "/absolute/path/AgentDeskLink/dist/src/server.js",
        "--config",
        "/absolute/path/AgentDeskLink/config/demo.json"
      ]
    }
  }
}
```

The server connects over stdio. Using the desktop from source also requires building and configuring the OS helper. The Linux helper is a Python script (`native/linux-atspi/adl-linux-atspi-helper.py`) that needs no build; install `python3-gi`, `gir1.2-atspi-2.0` and `at-spi2-core` from the OS packages.

Relative CLI `auditPath` values resolve from the policy JSON's directory. An unwritable log stops startup with a cause code on stderr before the MCP connection starts.

See [operation settings and approvals](release-docs/OPERATIONS.md) for the settings and supported scope.

### Example configurations

| What you want to try | Configuration file |
| --- | --- |
| Local browser demo | [demo.json](config/demo.json) |
| Browser image capture | [visual.example.json](config/visual.example.json) |
| Driving the macOS Calculator | [macos-calculator.example.json](config/macos-calculator.example.json) |
| Driving the Windows Character Map | [windows-character-map.example.json](config/windows-character-map.example.json) |
| Driving a Linux app (AT-SPI2) in the standard tier | [linux-atspi.example.json](config/linux-atspi.example.json) |

## Guides

- [Installation and first steps](release-docs/INSTALL_en.md)
- [What changed in this version](release-docs/RELEASE_NOTES_en.md)
- [Supported environments and known limitations](release-docs/KNOWN_ISSUES_en.md)
- [Update settings](release-docs/UPDATES_en.md)

## License

[MIT License](LICENSE). The third-party software we ship is covered by its own licenses.
