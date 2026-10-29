# Linux AT-SPI2 helper

`adl-linux-atspi-helper.py` is the Linux native helper for AgentDeskLink: one Python 3 script that speaks the fixed JSONL protocol v2 (`discover`, `open`, `snapshot`, `act`, `close`) over stdin/stdout, 64 KiB per line, one request at a time. At runtime it needs only the Python standard library plus `python3-gi` and `gir1.2-atspi-2.0` (and a running `at-spi2-core` bus). Gtk is used by the test fixture only. The VSIX bundles the script as `runtime/helper/adl-linux-atspi-helper`; it is copied, never compiled, and invoked through its `#!/usr/bin/python3` shebang.

```sh
sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core
gsettings set org.gnome.desktop.interface toolkit-accessibility true   # GNOME: let toolkits register on the bus
```

Missing `python3-gi`/`Atspi`, no session bus or no accessibility bus are reported per request as `E_ATSPI_UNAVAILABLE` with the installation hint; the helper keeps answering and never crashes. The parent maps the code to `E_BACKEND_UNAVAILABLE` with reason `linux_accessibility_unavailable`. `libatspi` aborts the process when it cannot reach a bus, so the connection is first proven in a disposable forked child.

## Identity

`--app-id` is the exact AT-SPI application name (`Atspi.Accessible.get_name()` of the application object, normally the program name) and `--app-path` the absolute canonical executable. A process matches only if its AT-SPI name equals `--app-id` and `/proc/<pid>/exe` resolves to `realpath(--app-path)`; interpreted applications therefore use the interpreter path (for example `/usr/bin/python3.12`, not the script). Targets are the application's `frame`, `dialog` and `window` children. Each target is bound to the process ID, the kernel start time (`/proc/<pid>/stat` field 22) and the exact window accessible; target IDs are opaque and random, stay stable while the same window lives, and are never reissued to a recreated window. Loss, hiding or replacement yields `E_TARGET_NOT_FOUND`; sessions bound to a lost target are dropped. There is no title, order or geometry matching and no silent rebinding.

Find the application name of a running program:

```sh
python3 -c "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi; d=Atspi.get_desktop(0); print(*[(a.get_name(), a.get_process_id()) for a in (d.get_child_at_index(i) for i in range(d.get_child_count())) if a], sep='\n')"
readlink /proc/<pid>/exe        # the value for --app-path (desktopAppPath)
```

`accerciser` shows the same names, roles and accessible IDs interactively.

## Geometry

Window bounds are the AT-SPI `Component` extents in `SCREEN` coordinates, reported as `desktop_physical_pixels` with `display_ids: ["x11:<DISPLAY>"]`. On Wayland GTK cannot know global window positions, so the extents AT-SPI returns are window-relative (origin 0,0); the helper reports them unchanged and leaves `display_ids` empty. Treat Wayland bounds as size only (verified on GTK 3 under headless Weston: origin 0,0, real size including client-side decorations). `display_ids` is derived from the helper process environment: `DISPLAY` without `WAYLAND_DISPLAY` gives `x11:<DISPLAY>`; with `WAYLAND_DISPLAY` set the helper opens `DISPLAY` once per discovery (read-only, best-effort) and reports `x11:<DISPLAY>` only for applications that have an X client window on it (an XWayland client, matched by `_NET_WM_PID`), so a native Wayland client keeps an empty list. `minimized` mirrors `STATE_ICONIFIED`; a hidden window disappears from the application's children and therefore from discovery.

## Snapshot

A bounded depth-first traversal (at most 1,000 nodes, 3.5 s, and a 60,000-byte reply budget; `truncated: true` when any bound hits) emits every visible node with a meaningful role, name or accessible ID. Roles are mapped to the AgentDeskLink vocabulary in the helper: `button`, `textbox`, `text`, `checkbox`, `radio`, `combobox`, `option`, `listitem`, `link`, `tab`, `menuitem`, `slider` (also scroll bars), `spinbutton`, `region` (scroll panes), `window`, `dialog`, `list`, `listbox`, `table`, `row`, `cell`, `tree`, `treeitem`, `heading`, `img`, `progressbar`, `status`, `toolbar`, `menu`. Names fall back to `LABELLED_BY` relations for form controls and are clipped to 512 characters; text values are clipped to 512 characters. `enabled` requires `ENABLED` and `SENSITIVE` (GTK 4 never reports `ENABLED`, so for GTK 4 applications `SENSITIVE` alone counts; a disabled GTK 4 widget lacks `SENSITIVE`); `checked` and `selected` mirror the AT-SPI states. `password text` and controls whose name or accessible ID matches the secret-label heuristic are `sensitive: true` and carry no value. Element IDs are opaque, unique per snapshot and stable for the same accessible within a session. `revision` starts at 1 and increments only when the emitted element list changes.

## Act and policy

`act` requires `target_id`, `session_id`, `element_id`, the current `expected_revision` and `action`; unknown fields fail with `E_BAD_REQUEST`. Before dispatch the helper revalidates the process, window, element identity (role, accessible ID, name, still inside the window, still enabled) and the policy, then samples the active window across the desktop and the focused element inside the target window. After dispatch it samples again; any change returns `E_FOCUS_CHANGED` with `may_have_executed: true` and drops the session. Discovery reports `focus_control: "probe_guarded_semantic"`: this is a best-effort before/after probe, not a guarantee against asynchronous application behaviour, and it does not sample the pointer because the helper never moves it.

| action | mechanism | readback |
| --- | --- | --- |
| `click` | advertised `click`/`press`/`activate`/`jump` action on buttons, links, menu items, tabs, options, check boxes and radio buttons | action acknowledged |
| `fill` | `EditableText.set_text_contents` on an editable, non-read-only, non-sensitive text field (≤ 4,096 bytes, no control characters except tab/newline) | `Text.get_text` equals the value |
| `check` | toggle action when `STATE_CHECKED` differs from `checked`; already in the desired state is a no-op | `STATE_CHECKED` (or `PRESSED`) equals `checked` |
| `select` | `Selection.select_child` on the container (combo box items select through the combo box) | `STATE_SELECTED` or the combo's selected child |
| `scroll` | `Value.set_current_value` on the scroll bar (or the vertical scroll bar of a scroll pane) by max(increment, 10 % of range) | the value changed; already at the bound is a no-op |

Policy tiers, evaluated inside the helper exactly like the macOS and Windows helpers evaluate theirs:

- `--allow-all`: supported actions on any non-sensitive, enabled control (consequential controls included).
- `--controls-file <json>`: allowlist `{ "<accessible id>": {"role": "<public or AT-SPI role>", "allowed": ["click", ...]} }`; the accessible ID must be unique in the window and the role and action must match ([controls.example.json](controls.example.json)).
- `--operation-mode standard`: ordinary actions on non-sensitive controls; controls whose name matches the consequential vocabulary (delete, remove, send, submit, purchase, checkout, pay, login, sign in, register, transfer, confirm, cancel, order and the Japanese equivalents) are refused with `E_APPROVAL_REQUIRED`. The parent passes this flag for `operationMode` `standard` when neither `allowAllOperations` nor `controlsPath` is set; the Engine applies the same vocabulary before the request reaches the helper.
- `--operation-mode ask`: the standard tier plus the request field `approved: true`, which the parent adds to exactly one `act` after a human approved that action in the VS Code dialog; it lifts only the consequential gate (sensitive controls still return `E_PRIVACY_BLOCKED`). Any other value of `approved`, or the field under `standard`, `--allow-all` or a controls file, is `E_BAD_REQUEST`.
- none of the above: `mutations_enabled: false`; every `act` returns `E_POLICY_DENIED`.

Sensitive controls are refused in every tier (`E_PRIVACY_BLOCKED`). `strict_isolated` returns `E_INTERFERENCE_RISK`; `interactive_desktop`, `capture`, `gesture`, `prepare_input`, `commit_input` and `application` return `E_UNSUPPORTED_ACTION` (physical input, window capture and lifecycle are `platform_unsupported` on Linux). `--release-input` prints `{"released_input":true}` because the helper never holds input.

## Tests

`fixture/fixture.py` is a synthetic GTK3 window (label, text, password, read-only, Run / Delete all / disabled buttons, check box, combo box, list box, scrolled text) whose control directory (`ADL_FIXTURE_CONTROL`) is a test-only command channel. `tests/test_helper.py` drives the real helper against it: discovery and snapshot shapes, click/label readback and revision changes, fill readback, check toggling, password sensitivity, stale revisions, the controls-file allowlist, observe-only without policy, wrong app path/name, select and scroll, consequential refusal in the standard tier, a closed dialog window, protocol errors, a missing accessibility bus and usage exits. `tests/linux-atspi-e2e.test.ts` (compiled to `dist/tests/`) runs the Engine and `LinuxAdapter` against the same helper and fixture. Both need a headless accessibility desktop:

```sh
sudo apt install xvfb at-spi2-core gir1.2-atspi-2.0 python3-gi gir1.2-gtk-3.0 dbus-x11
native/linux-atspi/tests/run-xvfb.sh python3 -m unittest -v native/linux-atspi/tests/test_helper.py
npm run build:tsc && native/linux-atspi/tests/run-xvfb.sh node --test --test-timeout=60000 --test-force-exit dist/tests/linux-atspi-e2e.test.js
```

The `linux-atspi` CI job runs these commands and the scenario tests below on `ubuntu-24.04`. Plain Xvfb has no window manager, so `STATE_ACTIVE` is usually empty there and the focus probe only compares before and after. Verification on a real GNOME/KDE session with other focused applications remains a manual acceptance step.

### Scenario tests

`tests/test_scenarios.py` covers the environments beyond plain Xvfb and skips each one cleanly when its prerequisite is missing: a real window manager (`ADL_WM=openbox` makes `run-xvfb.sh` start it; the fixture window then has `STATE_ACTIVE`, semantic click and fill leave another active window alone, and a second window taking the active state or keyboard focus during a click yields `E_FOCUS_CHANGED` with `may_have_executed`), a GTK 4 fixture (`fixture/fixture_gtk4.py`, needs `gir1.2-gtk-4.0`; GTK 4.14 check boxes expose no AT-SPI action, so `check` returns `E_PATTERN_UNSUPPORTED`, which the server reports as `E_UNSUPPORTED_ACTION`), a Qt fixture (`fixture/fixture_qt.py`, needs PyQt5 or PySide6; the test publishes `AT_SPI_BUS` on the X root window first, see Qt below), GTK 3 on a headless Weston compositor as a native Wayland client (needs `weston`; size-only bounds, empty `display_ids` although an X server is reachable) and as an X client of Weston's Xwayland (needs `xwayland`; `display_ids` `["x11:<n>"]`) and a 1,500-button tree (`fixture/fixture_big.py`; `truncated: true`, at most 1,000 elements, reply under 64 KiB, well within the 3.5 s walk bound):

```sh
sudo apt install openbox weston xwayland gir1.2-gtk-4.0 python3-pyqt5
ADL_WM=openbox native/linux-atspi/tests/run-xvfb.sh python3 -m unittest -v native/linux-atspi/tests/test_scenarios.py
```

### Qt

Qt 5.15 (python3-pyqt5 with Qt 5.15.13 on Ubuntu 24.04) connects to the accessibility bus asynchronously (`org.a11y.Bus.GetAddress`) but, when accessibility is already enabled at start-up (`QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`), registers with the AT-SPI registry at once. Unless the X root window already carries the bus address (`AT_SPI_BUS`, type `STRING`), that registration runs on a not yet connected D-Bus connection, fails with `org.freedesktop.DBus.Error.Disconnected` ("Error in contacting registry") and is not retried, so the application never appears in discovery; a running `at-spi2-registryd` does not change this. The test desktop's `at-spi-bus-launcher` (at-spi2-core 2.52) does not set `AT_SPI_BUS`; with the property set, Qt registers and discover, snapshot, click, fill and check work. A top-level QWidget is exposed as AT-SPI role `filler` directly under the application (no `frame`), which the helper accepts as a window. Whether a Qt 5 application without `AT_SPI_BUS` (for example in a Wayland session) becomes visible when accessibility is enabled after it started has not been verified.
