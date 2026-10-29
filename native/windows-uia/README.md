# AgentDeskLink Windows UIA helper

This .NET 8 Windows console helper speaks one JSON request and response per line on stdin/stdout. Launch it with one certified application identity:

```powershell
dotnet AgentDeskLink.WindowsUia.dll --app-id adl-fixture --app-path C:\full\path\AgentDeskLink.TestFixture.exe
```

The executable path must be absolute and exist when the helper starts. Every discovery/open binds the exact configured path, process ID, process start time, and root window handle. Snapshot and action requests revalidate that binding; callers cannot provide OS handles, PIDs, runtime IDs, paths, or selectors.

Supported operations are `discover`, `open`, `snapshot`, `act`, and `close`. Every request has `op` and `request_id`. `open` takes `target_id` and `mode`; `snapshot` takes `session_id`; `act` takes `session_id`, `element_id`, `action` and optionally `value`; `close` takes `session_id`. Responses have `ok`, `request_id`, and either `result` or a safe `{code,message}` error. `discover.result` contains `target_id`, `application_id`, `available`, and `capabilities`. `open.result` contains `session_id`, `mode`, `mutations_enabled`, and `reason` when gated. `snapshot.result` contains `session_id`, stable `revision`, `fingerprint`, `elements` (`id`, `role`, `name`, `value`, `enabled`, `checked`, `selected`), and `truncated`; `close.result` contains `closed`. Handles are random opaque values, with UIA runtime IDs used only as private keys to preserve element handles between snapshots. Traversal is capped at 1,000 controls. `IsPassword` elements and names containing password/secret/token/credential are suppressed; UIA values are returned only for other elements and are clipped to 256 characters.

`strict_isolated` always returns `E_INTERFERENCE_RISK`. `background_semantic` permits discovery and observation. Mutations currently return `E_UNSUPPORTED_ACTION`: the managed `System.Windows.Automation` wrapper does not provide a supported proof that `IUIAutomation2::put_AutoSetFocus(FALSE)` applies to its shared automation client. Enabling Invoke/Value/Selection/Toggle/Scroll calls before that proof would risk moving keyboard focus. No physical inputs, clipboard calls, `SetFocus`, or foreground activation are implemented. UIA observation is still best effort and an application can have its own side effects.

The included Windows Forms fixture covers a text field, button, checkbox, selection control, and scrollable content. On Windows, run `pwsh -NoProfile -File ./smoke.ps1`. It checks discovery, strict-mode rejection, background snapshot, mutation gating, stale session handling, and close. The smoke test cannot verify fill/click/check until the non-focusing UIA client has been established. On macOS/Linux, `pwsh -NoProfile -File ./smoke.ps1 -Help` only prints usage; a Windows-targeted cross-build is not runtime verification.
