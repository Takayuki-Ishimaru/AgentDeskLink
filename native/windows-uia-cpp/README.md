# Windows native UI Automation helper

This package builds a Windows-only C++17 console helper for AgentDeskLink. It uses one `IUIAutomation2` COM client on an MTA thread and verifies `AutoSetFocus == FALSE` before serving requests. It uses UIA patterns only; it never calls `SetFocus`, sends physical keys or mouse input, uses the clipboard, or activates a foreground window.

The helper is bound at launch to one configured application ID and exact full executable path. The optional trusted controls JSON maps exact UIA `AutomationId` strings to approved action names. The sample grants only the fixture operations:

```json
{
  "FixtureText": { "role": "edit", "allowed": ["fill"] },
  "FixtureButton": { "role": "button", "allowed": ["click"] },
  "FixtureCheck": { "role": "checkbox", "allowed": ["check"] },
  "FixtureSelectBeta": { "role": "listitem", "allowed": ["select"] },
  "FixtureScroll": { "role": "pane", "allowed": ["scroll"] }
}
```

Each policy entry must name one supported UIA role as well as its allowed actions. The role is checked both in the snapshot and again during the bounded live-tree match before dispatch.

Build with Visual Studio 2022 Build Tools, the Windows SDK, CMake 3.24 or newer, and .NET 8 for the fixture. CMake fetches nlohmann/json at the pinned 3.11.3 commit `9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03`; no ATL component is required.

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

Each stdin line is a JSON object no larger than 64 KiB. Each response is one JSON object on stdout, also bounded to 64 KiB. Diagnostics never include executable paths, UIA runtime IDs, pointers, or stack traces. The supported operations are `discover`, `open`, `snapshot`, `act`, and `close`; unknown fields and operations fail closed. `request_id` must be a non-empty string. Discovery returns a bounded `targets` array with one opaque `target_id` per exact window; open requires that ID and `mode: "background_semantic"`. `strict_isolated` returns `E_INTERFERENCE_RISK`. A successful open returns an opaque `session_id`.

Snapshot returns `{revision, truncated, elements}`. Each element has an opaque `id`, role, name, value, and enabled state, with `checked`, `selected`, or `sensitive` when applicable. Traversal is bounded to 1,000 nodes. Password and heuristically sensitive controls never expose values. Element handles are retained by the helper and only accepted with the current snapshot revision; every action also revalidates process identity, window/root identity, unique live AutomationId and enabled state.

An `act` request contains `target_id`, `session_id`, `element_id`, `expected_revision`, and `action`. `fill` also takes a value of at most 4,096 UTF-8 bytes; `check` takes a boolean `checked`; `scroll` takes `direction: "up"` or `"down"`. The implementation uses only InvokePattern, ValuePattern, SelectionItemPattern, TogglePattern, or ScrollPattern respectively. Unsupported patterns, disabled controls, read-only values, password/sensitive/consequential controls, and controls absent from the trusted allowlist are rejected. There is no coordinate, keystroke, or fallback path.

Policy tiers are launch arguments, never protocol fields, and exactly one applies:

- `--controls-file <json>` (above): the trusted allowlist; consequential names follow the helper's broad native blocklist.
- `--allow-all`: supported actions on any observed, enabled control (password controls stay blocked).
- `--operation-mode standard`: the same semantics as the Linux helper. Supported actions on enabled controls that are neither sensitive (`E_PRIVACY_BLOCKED`) nor consequential by the shared vocabulary (`E_APPROVAL_REQUIRED`; delete, remove, send, submit, purchase, checkout, pay, login, sign in/up, register, withdraw, transfer, confirm, cancel, order and the Japanese equivalents, matched on the name and the AutomationId after camelCase/`_`/`-` splitting); `scroll` is exempt. Element identity uses the retained UIA element like `--allow-all`, so anonymous AutomationIds are not a restriction. Both gates are re-checked against the live provider values immediately before dispatch.
- `--operation-mode ask`: the standard tier plus the request field `approved: true`, which the parent adds to exactly one `act` after a human approved that action in the VS Code dialog; it lifts only the consequential gate. Any other value, or the field under another tier, is `E_BAD_REQUEST`. Combining `--operation-mode` with `--allow-all` or `--controls-file` is `E_CONFIG`.

Discovery's `mutations_enabled` reports whether any of these launch options can permit an `act`. `tools/standard-tier-smoke.ps1` exercises the standard and ask tiers against the fixture (semantic background mode only).

The non-client `SystemMenuBar` branch is traversed and counted toward raw-tree bounds but receives no public/actionable handles. Windows recreates its virtual system-menu item during reads, which must not make an unchanged application form permanently stale. Application controls keep the existing exact-identity and unique-live-element checks.

For verified native Rich Edit controls, a bounded, read-only `WM_GETTEXT` query can confirm that UIA appended one structural CR paragraph marker. Observation and ValuePattern readback then expose the confirmed logical value. The native HWND must belong to the UIA element's process and have an exact supported Rich Edit class. No marker is removed if the values disagree, and actual user newlines are not trimmed. Mutation still uses only ValuePattern.SetValue; there is no message-based write or physical-input fallback.

Before and after an action the helper records the foreground HWND, native/UIA focus, and cursor coordinates. If any change or cannot be sampled, it returns `E_FOCUS_CHANGED` (or the probe error), marks `may_have_executed: true` when dispatch may have happened, and invalidates the session. No rollback is attempted.

`tools/smoke.ps1` builds the helper and WinForms fixture, then exercises discovery, isolation-mode rejection, snapshots/revision stability, stale and unknown handles, allowlist denial, fill/readback, click/readback, check/readback, selection/readback, scrolling, focus/cursor stability, and close. It must be run in an interactive Windows desktop session because a UIA provider generally does not expose an interactive application correctly from Session 0. A passing Linux configure or source review is not Windows verification.

## Window protocol v2

Discovery returns up to 32 individual window targets, including geometry tagged as desktop physical pixels. Target IDs bind retained process/start/HWND/UIA-root generations; titles, z-order and screen position never select a replacement. Move and title updates keep identity, destruction and new roots invalidate it. A dedicated WinEvent message loop poisons destroyed generations, supplementing exact process and CompareElements checks. Its asynchronous delivery is not a race-free guarantee about a window generation.

One persistent helper supports up to 32 sessions. snapshot/act/close require both exact target_id and session_id; close releases only that session. EOF releases everything. The native bridge invalidates its whole epoch on interrupted IPC and requires an explicit MCP server restart. Old v1 helper binaries are incompatible with beta2.

Before each mutation the helper verifies AutoSetFocus=false, exact trusted AutomationId/role/action, element identity and uniqueness, current revision and safety flags. A 100ms completion interval samples foreground/focus/cursor to catch asynchronous handlers. Interference invalidates the affected session and reports may_have_executed; an already dispatched action is not rolled back. Arbitrarily delayed application activity is outside this bounded guard.

The pure cross-platform contract suite contains 38 named cases. The fixture can expose 3 same-title windows in one process with --multi-window; its control directory is a test-only command channel. Run scripts/windows-multiwindow-e2e.ps1 in the interactive experimental environment for real multiwindow verification.

On Windows, the protocol-only build also runs 8 SAFEARRAY focus-identity checks. Focus probes require a complete, bounded 1D integer runtime ID and fail closed on unavailable or malformed data; no truncated ID or released COM pointer address is used as a fallback. The deliberate interference fixture records its actual cursor readback so an edge-clamped no-op cannot masquerade as the negative-test stimulus.

## Opt-in application lifecycle

The trusted `--lifecycle-enabled` option enables the session-less request
`{"op":"application","request_id":"...","action":"status|launch|quit"}`.
Only the executable and application ID fixed at helper startup are eligible;
requests cannot supply commands, arguments, paths, PIDs or window handles.
The result is `{running, managed, changed}`. Without opt-in the operation is
rejected. The MCP configuration is `windows.lifecycle: {"enabled":true}`.

Lifecycle-managed applications run on a helper-specific Win32 desktop that is
never switched to the user's input desktop. Plain `SW_SHOWNOACTIVATE` startup
is insufficient for this contract because application startup can activate its
own windows. Private-desktop startup avoids sharing those windows with the
human. The ordinary lifecycle-disabled UIA path continues to inspect existing
windows on the shared desktop with its original focus guard. Physical input
is incompatible with lifecycle isolation. Exact-window capture is not exposed
by the private-desktop path.

Launch is idempotent while the same retained process is alive. Quit validates
the owned process generation and executable and requests normal window close;
it does not force termination, dismiss dialogs, save or discard documents.
Refused or uncertain termination retains ownership for a later retry. A normal
successful quit invalidates desktop targets and sessions. An external process
or another helper's instance is never adopted for termination. Close the owned
application explicitly before disconnecting.

Use the Character Map configuration under `config/` and run the reproducible
MCP test from a logged-in Windows session after building TypeScript:

```powershell
./native/windows-uia-cpp/tools/lifecycle-smoke.ps1 `
  -HelperExe C:/AgentDeskLink/native-build/Release/adl-windows-uia-helper.exe
```

The test starts, edits, toggles, restores and closes Character Map through the
MCP three times. It selects the exact window by its observed approved controls,
not `Process.MainWindowHandle`, which can identify an auxiliary UIA window.
An independent read-only sampler records human foreground HWND, native focus,
complete UIA focus runtime ID and cursor; any observed change or probe error
fails the test. Sampling is evidence for the tested interval, not proof about
arbitrary applications or all transient events.

References: [Win32 desktops](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createdesktopw),
[process startup desktop](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow),
[UIA AutoSetFocus](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-get_autosetfocus).

## Opt-in exact-window images

`--visual-enabled` is an optional trusted launch flag. Without it, discovery
returns `visual_capture:false` and `capture` is denied. The v2 operation accepts
only `{op:'capture',request_id,target_id,session_id}` and returns an inline PNG
with capture timestamp, `window_pixels` coordinates, physical-pixel desktop
mapping, and a session-local `surface_epoch` that changes on window geometry
changes. Captures do not advance semantic revisions. PNGs are bounded to 8 MiB,
4,194,304 pixels and 4,096 pixels per side; visual JSON output is bounded to
12 MiB. Input and semantic snapshots remain bounded to 64 KiB.

Windows Graphics Capture binds `IGraphicsCaptureItemInterop::CreateForWindow`
to the retained HWND and uses a free-threaded one-frame D3D11 pool. It does not
use a picker, monitor capture, `PrintWindow`, or foreground activation. The OS
capture border is retained and the cursor is excluded. Frame acquisition and
GPU readback have a combined 1.5 second deadline. Interrupted IPC terminates the
helper as before; in-process WinRT/D3D calls also remain subject to the bridge's
5 second process deadline. Windows 11 and an available graphics capture device
are required; unsupported/denied capture fails without fallback.

The backend revalidates retained process/window/root identity before and after
acquisition and encoding. DWM frame bounds must exactly match capture dimensions
and stay stable. Known editable/password/sensitive UIA control rectangles from
complete scans before and after capture are blacked out; a changed mask identity
or rectangle rejects the frame. This bounded check does not prove absence of
transient sensitive content between samples. Incomplete trees,
unverifiable process branches and missing sensitive geometry are denied. This
cannot recognize arbitrary secrets painted inside images or Canvas; the target
still requires explicit trusted visual disclosure and configured region masks.

`adl_window_capture_tests` checks bounded PNG encoding and mask placement with
negative desktop coordinates. Its optional `--interactive` mode creates only a
synthetic non-activating window, verifies WGC content and closed-target denial,
and checks that foreground and cursor do not change. Run it in the interactive
Windows test session with an overall timeout; a protocol-only build does not
prove Windows Graphics Capture behavior.

References: [exact-window interop](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow),
[free-threaded frame pool](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded).

`tools/capture-smoke.ps1 -BuildDir <build> -FixtureExe <published FixtureApp.exe>
-OutputDirectory <fresh output> [-DotnetRoot <private .NET root>]` also exercises
the actual helper against the synthetic UIA fixture, checks black edit/password
pixels in the PNG, default-off policy, exact target denial, move epochs and
foreground/cursor stability. Run in an interactive session under an external
bounded process deadline. It closes only its own fixture/helper processes.

## Explicit interactive desktop input

Background semantic sessions retain their existing non-interference contract.
Physical input is a separate opt-in: launch with `--visual-enabled` and
`--interactive-config '<bounded JSON>'`, then open `interactive_desktop`.
The JSON argument is inline UTF-8, at most 8192 bytes, with this shape:

```json
{"enabled":true,"surfaces":[{"id":"canvas","region":{"x":0,"y":180,"width":610,"height":350},"kinds":["drag","swipe"],"swipe_backend":"scroll"}]}
```

Regions use source-window PNG pixels. The helper advertises `mouse_drag` and
`scroll_swipe`; physical touch injection is unsupported. Gestures need a current
capture input token (five seconds), a matching native revision, 2–64 points,
a first time of zero, increasing times, and a total duration at most five
seconds. Every point and its UIA ancestry must belong to the retained window
and the trusted surface. Known interactive, sensitive and consequential
ancestors are denied for gestures.

Click and fill use `prepare_input` and one-shot `commit_input`. Preparation
moves the pointer, re-reads its exact hit target, and checks optional expected
public role/name plus the existing trusted control/action table. Confirmation
expires after 30 seconds. Read-only captures preserve the confirmation. Focus,
selection/caret (when exposed by UIA TextPattern), geometry, identity and input
monitor history are revalidated before committing. Physical fill additionally
requires verifiable full text selection; each Unicode chunk must produce the
intended value prefix and ending caret, and the final value must match exactly.
Clipboard, control characters, password and consequential fields are denied.

A per-user desktop input lease excludes other helpers. Low-level keyboard and
mouse hooks run on an independent thread and recognize only injected events
carrying this helper's random 32-bit tag (Windows/RDP truncates `ExtraInfo` to
32 bits). Human and other injected input retire the lease; capturing cannot
reset that history. The helper never brings a target to the foreground.
`cancel_input` with the active request ID cooperatively stops the driver;
EOF also cancels. Every path releases owned input before returning.

Crash recovery uses a lease-protected fixed ownership journal in the current
user's temporary directory, scoped to the Windows desktop session. The helper
checks the file owner, private DACL, regular-file status and single-link count.
Two checksummed records persist owned downs before injection; verified ups
clear both records, including any bounded UTF-16 recovery units. A dirty
journal denies a new interactive session. `--release-input` acquires the lease
and releases only recorded owned input, returning `{"released_input":true}`
after verification. An empty journal performs no input, preserving preexisting
human-held keys and buttons. Corrupt or unverifiable journals fail closed.

`adl_input_recovery_tests` checks the journal without injecting input. Its
explicit `--interactive-hold <synthetic-fixture HWND>` mode is only for the
fixture runner's forced-process-death recovery check. Native protocol tests,
encoder tests, recovery tests and the WinForms fixture are separate from user
applications.

A reproducible physical fixture check (run only in a connected disposable user
session, with no simultaneous Mac/RDP input):

```powershell
& $Dotnet publish tools\interactive-fixture\InteractiveFixture.csproj -c Release -o build\interactive-fixture
powershell -NoProfile -ExecutionPolicy Bypass -File tools\interactive-smoke.ps1 -BuildDir "$PWD\build" -DotnetRoot (Split-Path $Dotnet)
```

The runner records `physical-result.json` and per-check progress in the selected
build directory, and closes only its own synthetic fixture/helper processes.

Reproduce physical input only in the included disposable fixture on an interactive test desktop:

```powershell
# After compiling the native helper and tools/interactive-fixture into build/interactive-fixture:
powershell -NoProfile -File tools/interactive-smoke.ps1 -BuildDir ./build -DotnetRoot <dotnet-sdk-dir>
powershell -NoProfile -File tools/input-lifecycle-smoke.ps1 -BuildDir ./build -DotnetRoot <dotnet-sdk-dir>
# Build the parent TypeScript project first; this exercises both MCP protocol forms.
powershell -NoProfile -File tools/physical-mcp-smoke.ps1 -BuildDir ./build -NodeWorkspace ../.. -DotnetRoot <dotnet-sdk-dir>
```

The lifecycle fixture verifies an actual held native drag across EOF and forced helper death. The MCP fixture verifies PNG output, preparation crops, click, multi-batch Unicode replacement, drag and explicit wheel scrolling by application readback; its runner restores the original cursor and removes its own temporary JavaScript harness. These tests move the real desktop pointer and must run without concurrent user input.
