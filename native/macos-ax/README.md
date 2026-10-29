# macOS Accessibility helper

macOS 14+ Apple silicon、AppKit / ApplicationServices / CryptoKitを使用する固定JSONLヘルパーです。Xcode Command Line ToolsがあるMacで `./build.sh` を実行します。生成物は `build/adl-macos-ax-helper`。権限は `AXIsProcessTrusted()` で検査し、OSのアクセシビリティ権限がなければ停止します。自動的に権限を付与・要求しません。

対象は設定したbundle IDとcanonicalな実行ファイルパスが一致する実行中のアプリだけです。PIDとカーネルが返す開始時刻、保持したAXWindowを検証します。各ウィンドウをopaque target IDとして列挙し、openはそのウィンドウだけへ結び付けます。AXWindowsへの所属とCFEqualを再確認し、破棄通知を処理するrun loopも保持します。同名で再作成したウィンドウへ古いセッションを接続し直しません。

画面情報はAXの左上原点のdesktop point座標です。負の座標・縦向き・複数画面との交差を扱い、座標で操作を振り分けません。モニターごとのscaleを1個の倍率へまとめません。最小化中は最後に取得したboundsを表示することがあり、観測・操作を明示拒否します。画面やウィンドウの遷移中にAXが不整合なら、読み取りが一時的に利用不可になります。

信頼設定のAXIdentifier + role（任意のsubrole）+ actionを、選択したウィンドウ内で一意に照合します。writable AXValue、advertised AXPress、checkの条件付きpressとreadback、writable AXSelected、scrollbarのadvertised increment/decrementだけを実装します。対応しないpatternは拒否します。基本fixtureの認定範囲はfill/click/checkです。select/scrollの他アプリ認定は行っていません。

`background_semantic` の操作経路にはアプリ起動・前面化・window raise・focus setter・物理入力・clipboardを含みません。WindowsのAutoSetFocus設定に相当する保証はありません。`focus_control: probe_guarded_semantic` は、前面PID、focused window/elementのexact identityと所有PID、cursorを監視するbest effortの判定です。アプリ独自の非同期動作まで非干渉を保証するものではありません。

意味的変更操作では、専用threadのlisten-only event tapで外部入力の種別・発信元PID・時刻とpointer位置だけを保持します。文字、key code、入力値は取得せず、履歴はメモリ上の最大512件です。OSで監視を利用できない場合は、従来の厳格な前後一致へ戻ります。権限を自動要求しません。

外部入力で説明できるpointer移動と、対象アプリ以外への画面／focus切替を許容します。pointerは実行開始後の最新の未使用イベントと各軸0.5 point以内で一致する必要があり、5秒のnative呼出し窓を超えた履歴は使用しません。確認済みの位置へ比較基準を進め、入力を止めた後も古い位置との差で停止しないようにします。採用したイベントは再使用しません。画面／focus切替は、250ms以内の外部クリック・キー／修飾キーイベントが必要です。pointer移動だけでfocus変更を許容することはありません。

対象アプリやhelper発信のイベントは根拠になりません。別アプリから対象アプリへの前面化、対象が前面のまま起きるfocus変更、権限拒否、入力で説明できない移動は `E_FOCUS_CHANGED` と実行不確定を維持して後続を止めます。切替中のforeign AX読取失敗は明示的なtransient状態として扱い、外部activationの根拠がある場合だけ許容します。失敗を既知の空focusへ置換しません。

入力の世代が変わらないcursor/historyの組を、読み取りだけで最大4回照合します。監視の無効化・再開は世代を変え、実行途中の根拠を失効させます。変更操作は再送しません。これらはイベントと観測の相関による軽減策であり、入力の発信元情報は人の本人性の証明ではありません。同時に発生するアプリ独自の副作用やサンプル間の変化を完全に帰属・検出できる保証はありません。起動／終了APIと物理入力のguardは、この緩和の対象に含めません。

IPC v2は64KiB/line。discoverはwindow targets配列、open/snapshot/act/closeはexact target/sessionを使用します。closeは1セッションだけを閉じます。helper停止・取消しで中断したIPCは全セッションのepochを失効させ、透過的には再起動しません。MCPサーバーを明示的に再起動してtargetsから取得し直します。

`--lifecycle-enabled` は固定の `--app-id` / `--app-path` のアプリにだけ `application` IPCを追加します。要求は `{op:"application",request_id,action:"status"|"launch"|"quit"}`、応答は `{running,managed,changed}` です。起動にはNSWorkspaceの `activates=false`、`hides=true`、代替アプリ・プロンプト無効を使います。終了はhelperが起動した個体のPIDとカーネル開始時刻を再照合して通常終了を要求し、既存の人間の個体・前面の個体・AXEdited文書は拒否します。`cancel_input` / EOFで待機を中断し、起動や終了を要求した後の失敗には `may_have_executed` を返します。

SwiftUIの一部のツールバーボタンはAXSubroleを汎用failureで返します。この場合だけ当該ボタンを `enabled:false` の観測要素にし、他の要素の観測を続けます。テキスト入力の安全属性、権限・通信・失効のエラーは引き続き拒否します。人間の前面アプリがAXFocusedUIElementを明示的にnoValueで返す場合も、その不在を保持して操作前後で比較します。

`fixture/` と `tools/` は合成データだけを使う試験用です。fixtureのforeground/interference等のコマンドは製品操作APIではありません。試験は同じOSデスクトップ上で1本ずつ実行してください。

```sh
native/macos-ax/build.sh
npm run build
node scripts/macos-desktop-e2e.mjs
node scripts/macos-desktop-negative.mjs
node native/macos-ax/tools/lifecycle.mjs
node scripts/macos-codex-host.mjs
```

`build.sh` は意味的guardの純粋契約と `tests/semantic/cases.json` の回帰ベクトルも実行します。ベクトルはLinux側でschemaを検査した後、親Macで同じ製品Swift関数に対して実行します。OS入力を合成しない連続MCP確認は、親ディレクトリから `node benchmarks/acceptance/run.mjs --mode automatic --iterations 120 --out artifacts/my-native-repeat` で実行できます。これは実参加者の操作量を揃えた比較測定ではありません。

## Policy tiers

Policy tiers are launch arguments, never protocol fields. Without `--operation-mode` the helper keeps the existing `--controls-file` allowlist (or `--allow-all`) behaviour.

- `--operation-mode standard`: no allowlist; the shared vocabulary decides, like the Linux and Windows helpers. Supported actions on enabled controls that are neither sensitive (`E_PRIVACY_BLOCKED`) nor consequential (`E_APPROVAL_REQUIRED`) are permitted. The consequential vocabulary is delete, remove (except "remove filters"), upload, send, submit, purchase, checkout, pay, payment, login, sign in/up, register, withdraw, transfer, confirm, cancel, order and the Japanese equivalents, matched on the AX name and the AXIdentifier after camelCase and `_`/`-` splitting (`consequentialLabel` in `src/Contract.swift`); `scroll` is exempt.
- `--operation-mode ask`: the standard tier plus the request field `approved: true`, which the parent adds to exactly one `act` after a human approved that action in the VS Code dialog; it lifts only the consequential gate (sensitive controls still return `E_PRIVACY_BLOCKED`). Any other value of `approved`, or the field under another tier, is `E_INVALID_ARGUMENT`.

`--operation-mode` cannot be combined with `--allow-all` or `--controls-file`; the helper exits with status 2. Discovery's `mutations_enabled` is true under either tier.

Status: the tier and approval changes (`--operation-mode`, `approved`) have only been syntax-checked (`swiftc -parse` on Linux). They have not yet been compiled or run on a Mac, so run `./build.sh` and the desktop E2E scripts on a Mac before relying on them.

## Opt-in window images

`--visual-enabled` enables a separate ScreenCaptureKit discovery path after `CGPreflightScreenCaptureAccess()` succeeds. No screen-recording permission request is made. Without the flag, no ScreenCaptureKit enumeration or capture occurs. The existing accessibility setup prerequisite remains in place.

Capture targets appear in `discover.targets` with `capture_only: true`; the response includes `visual_capture`. They are bound to the configured bundle ID, canonical executable path, process start time and exact `SCWindow.windowID`. Public AX APIs do not expose a supported AXWindow-to-CGWindowID mapping, so capture targets are separate from semantic AX targets; no title, order or geometry matching is attempted. Their labels are deliberately generic. A capture target supports `open` in `background_semantic`, empty `snapshot`, `capture`, and `close`. Semantic actions are rejected; physical input additionally requires the separate explicit `interactive_desktop` policy described below.

`capture` accepts only `op`, `request_id`, `target_id`, `session_id`. It returns `png_base64`, `captured_at`, `coordinate_space: window_pixels`, `viewport`, per-axis `source_to_desktop` in `desktop_points_top_left`, `surface_epoch`, and `redacted: false`. The transform maps source PNG pixels to desktop points without assuming a common multi-display scale. Parent policy must explicitly permit trusted window pixels and apply configured static masks; this helper does not claim AX-based automatic masking for a separately discovered capture target.

The single-window filter excludes the cursor, shadow and child windows. Images are bounded to 4,194,304 pixels, 4096 pixels per side and 8 MiB PNG; output JSON is bounded to 12 MiB while requests remain 64 KiB. Geometry and permission are checked before capture, after capture and after PNG encoding. Changed geometry, lost/replaced windows, process identity changes and permission revocation suppress output. Minimized/offscreen targets are rejected. Close remains available after loss/revocation. Screenshots are not persisted by the helper. Each ScreenCaptureKit asynchronous call has a bounded timeout and discards late completion; parent cancellation closes the helper.

`tests/capture/main.swift` uses a synthetic in-memory image source to exercise default-off behavior, permission loss, identity replacement, geometry changes, coordinate transforms, limits and timeouts without capturing user apps. `tools/capture-smoke.mjs` is an explicit opt-in runtime test against only the synthetic ADLFixture app; it never captures arbitrary app windows.

## Explicit foreground interactive input

`--interactive-config '<JSON>'` is a separate trusted launch policy (8 KiB maximum, at most 16 unique source-PNG pixel surfaces), and requires `--visual-enabled`. The exact schema is `{ "enabled": true, "surfaces": [{ "id": "canvas", "region": { "x": 0, "y": 0, "width": 200, "height": 100 }, "kinds": ["drag", "swipe"], "swipe_backend": "scroll" }] }`. It never enables input in `background_semantic`. Capture-only targets may explicitly open `interactive_desktop` while the configured app is already foreground; the helper never activates or raises it. Existing held mouse buttons/keys block entry. A per-user, regular, owner-only, no-symlink `flock` lease prevents two helpers from owning physical input simultaneously. Native macOS advertises `mouse_drag` and/or `scroll_swipe` only for configured surfaces. It does not implement genuine multitouch injection; `touch` requests fail closed.

Interactive capture adds a new opaque `input_token`, valid for five monotonic seconds and bound to the latest retained source-image geometry. A fresh capture and each operation require all 32 mouse buttons and 128 keyboard keys to be released. `gesture` consumes the token and requires `expected_revision`, `surface_id`, `kind`, 2–64 `points` (`x`, `y`, `t_ms`, zero first time, strictly increasing, at most 5000 ms), and `swipe_backend: "scroll"` for swipes. Every point must be inside the trusted region and source image. Interpolation, waits and dispatch recheck cancellation, cursor, exact process start, foreground PID, exact CGWindowID/geometry/topmost hit and AX hit PID, and deny known sensitive or consequential AX ancestry. Only the system WindowServer cursor at the documented cursor window level is excluded from occlusion checks. Per-element AX calls have 50 ms messaging bounds, cancellation checks and a bounded overall driver deadline. Only transient AX `cannotComplete` responses are retried for at most 300 ms through read-only convergence; no new input is sent until the original identity/focus checks succeed. Success reports the completed `kind`, exact `points_executed`, and actual `backend`.

For physical click/typing, `prepare_input` consumes a fresh token plus a point, `action` (`click` or `fill`), and optional intended public role/name. It requires a uniquely matched trusted AXIdentifier + role/action from the existing controls file. It moves only the pointer, rechecks the exact retained AX element after hover, and returns a one-shot opaque confirmation, actual remaining TTL (at most 30 seconds), target role/name/enabled/focused/editable/optional selection, pointer confirmation and focus match. It returns no field values. `commit_input` consumes the confirmation before revalidation, rejects any changed focus/window/element/geometry/human input, then dispatches a safe click pair. Fill focuses only through that validated click, proves the exact focused element, validates select-all through AXSelectedTextRange, and posts bounded plain Unicode chunks without clipboard; exact element identity, label, geometry, enablement, editability and focus are rechecked immediately before every chunk. Exact text-prefix and UTF16 caret/selection readback must match before and after each chunk, including empty replacement. The helper rechecks cancellation, interference, idle state and exact target after journal I/O immediately before each DOWN event. Read-only, secure, consequential and control-character paths are denied. Success means only `verified: "input_sequence_completed"` plus `released_input: true`, not proof that a larger user task succeeded.

A surrounding-image capture preserves a prepared proof and the same armed interference history. It cannot erase intervening human input or silently replace the original target, focus, caret/selection or geometry checks. A new prepare or gesture retires an older proof.

A tagged listen-only event tap runs on its own thread/run loop, so genuine input detection continues while the driver is synchronous. Dedicated stdin reading recognizes `{ "op": "cancel_input", "request_id": "<active original ID>" }` out of band; it emits no separate response. Matching pre-aborts, mid-operation cancellation and EOF all stop input and release a held left button before the original response. A bounded serial dispatcher prevents nested broker requests during capture's run-loop waits. Cancellation history and pending-request overflow fail closed. Unexpected helper death requires the parent fallback `--release-input`: an owner-only durable journal records the helper's possible left-button and fixed key-code 0/51 ownership before DOWN. Tagged UP receipt and released-state checks precede journal clearing. Recovery first acquires the same exclusive lease, releases only recorded fixed inputs, verifies tagged UP receipts and released state, emits `{ "released_input": true }` and exits 0, or emits false and exits 2. An empty journal performs no input, preserving pre-existing human-held buttons and keys. Dirty or malformed journals block new sessions; recovery cannot release another live helper owner's input or synthesize arbitrary keys. Source/input/proof identities remain private and opaque in MCP responses.

`tests/interactive/main.swift` adds non-input policy/path/Unicode/lease/cancellation contract checks. `tools/interactive-smoke.mjs` explicitly performs real input only into its own foreground ADLFixture drawing surface, safe allowlisted button and text field. It tests actual drag/scroll, click/fill, target/focus/hover rejection, cancellation after real mouse-down, EOF release, and real token/proof expiry. Run it only when no other native GUI test uses the same desktop.

`tools/interactive-mcp-smoke.mjs <parent-project-path>` exercises the real MCP server, Engine and native helper in both supported protocol modes against that same synthetic fixture, including surrounding-image prepare/commit, Unicode fill, drag, scroll and PNG decode/readback.
