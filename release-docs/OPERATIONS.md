# 操作設定と承認 / Operation Settings and Approvals

対象バージョン / Target version: `0.1.5`（ベータ版 / beta）

[インストールとはじめ方](INSTALL.md) | [Installation and first steps](INSTALL_en.md)

## 権限 / Permissions

| `agentdesklink.operationMode` | 動作 / Behavior |
| --- | --- |
| `read_only`（既定 / default） | 観測・移動・スクロール / Observe, navigate and scroll |
| `standard` | 通常のブラウザ入力・クリック。重要操作は拒否 / Ordinary browser inputs and clicks; consequential operations denied |
| `ask` | 通常操作に加え、検査可能な重要操作を VS Code の確認画面で一度ずつ承認 / Ordinary inputs plus native VS Code approval for inspected consequential operations |

パネルで「すべて許可」を選ぶと VS Code の確認画面が表示されます。既存の `agentdesklink.allowAllOperations: true` は更新後も優先されるため、段階的な権限を利用するときはパネルで読み取り専用・標準・都度承認を選び直してください。どの段階でも origin・アプリの許可と明示保護領域の制限は維持されます。
Selecting Allow all in the panel requires a VS Code confirmation. An existing `agentdesklink.allowAllOperations: true` still takes precedence after updating; choose Read only, Standard or Ask each time in the panel to switch to a permission tier. Origin/app grants and explicit protected regions remain enforced.

個別承認はブラウザの main document が対象です。対象・入力値・フォーム内容・revision を結び付け、変更・失効・停止後の再利用を拒否します。秘密値は確認画面にも送信しません。AI は承認を決定できません。承認後は同じ操作を再要求します。
One-shot approvals cover inspected controls in the browser's main document. They bind the target, exact input, form contents and revision. Changes, expiry or stop invalidate them. Secret values are not sent to the dialog. The AI cannot approve its own request; after approval it retries the same operation.

native・iframe・Shadow DOM 内への承認による昇格は未対応です。通信の許可は検査済み URL encoded フォーム POST 1 回で、multipart・ファイル・一般的な AJAX/DELETE は対象外です。VS Code に接続できない場合や確認画面自体をネイティブ操作できる設定では、承認を許可しません。
Approval escalation is unavailable for native apps, iframe and Shadow DOM controls. Network permits cover one inspected URL-encoded form POST, excluding multipart, files and generic AJAX/DELETE. A disconnected broker or a native setup that could control the approval host cannot authorize requests.

## ブラウザ / Browser

| 設定 / Setting | 既定値・内容 / Default and meaning |
| --- | --- |
| `agentdesklink.browserHeadless` | `true`。`false` で可視起動 / Set false for a visible browser |
| `agentdesklink.sessionIdleMinutes` | `15`。1〜60 分、利用中は延長 / 1–60 minutes, renewed on use |
| `agentdesklink.browserProxyServer` | 空 / empty。認証・パス・クエリのない http(s) proxy origin / HTTP(S) proxy origin without credentials, path or query |

可視ブラウザの手動ログインは `adl_handoff` の `pause` / `resume` を使用します。`ask` では、同じ origin のサイトスクリプト・フォーム通信を最大 120 秒許す専用確認が必要です。自動操作は停止したまま、再開または期限で通信許可を終了します。再開後は再観測し、新しい revision を使用してください。`standard` / `read_only` はこの通信許可を取得できません。
For a manual login use `adl_handoff` with `pause` / `resume` in a visible browser. Ask requires separate approval for same-origin website scripts and forms to send requests for up to 120 seconds. Automation stays paused; resume or expiry ends the grant. Observe again and use the new revision after resuming. Standard and read-only modes cannot obtain this grant.

この期間は人間のクリック前にもサイト処理が送信・変更・削除を行えます。再開・失効は新しい通信の送出を止めますが、送出済み処理は取り消せません。
Website scripts may send, change or delete before a human click during this interval. Resume or expiry prevents new dispatch; requests already dispatched cannot be rolled back.

普段のブラウザとは別のプロファイルを使います。プロキシ利用時も接続先 IP と TLS 証明書を検査します。
The browser uses a separate profile. Target IP and TLS certificate checks remain enforced through the proxy.

## MCP

- `adl_observe`: `format: "json"`（既定）、`"compact"`（既定値を省略）、`"lines"`（エスケープした行形式）。差分・scope・cursor は全形式で利用できます。Compact and lines declare their omitted defaults; diff, scope and cursor work in every format.
- `adl_act`: `press` / `back` / `hover`、および `click` の `point: {frame_id,x,y}`。座標は最新画像の取得元 CSS ピクセル、30 秒以内・同じ位置と対象が必要です。Coordinate clicks require the latest retained frame, source CSS pixels, unchanged geometry and a frame age under 30 seconds.
- `adl_sessions`: 開いているセッション・revision・アイドル期限・停止状態を確認します。Lists sessions, revisions, idle deadlines and pause state.
- `adl_approvals`: `ask` の要求状態を確認します。承認を決定するツールではありません。Reports Ask request status; it cannot approve a request.

閉じた Shadow DOM は意味的観測の対象外で、画像では iframe とともにマスクします。観測の収集上限は 5,000 件です。通常の入力欄や checkbox は画像で確認できますが、既知の秘密形式と明示保護は隠します。未知の秘密を完全に検出する保証はありません。
Closed Shadow DOM is not semantically observed and is masked with iframes in images. Collection is capped at 5,000 elements. Ordinary inputs and checkboxes remain visible; known secret patterns and explicit protected regions are masked. Unknown secret detection is not guaranteed.

CLI で `operationMode` を省略すると既存の `controls` 許可を維持します。明示的な `read_only` は操作を拒否します。CLI のランタイム設定は `browserHeadless`、`browserProxyServer`、`sessionTtlMs` です。
Omitting `operationMode` in a CLI policy preserves legacy control grants; explicit read-only denies mutations. CLI runtime settings are `browserHeadless`, `browserProxyServer` and `sessionTtlMs`.

ソースからの `npm run package:vsix` は実行 OS/CPU 用の VSIX を生成します。`--universal` で共通版も組み立てられます。公開リリースの更新ファイルは対応 OS 版を優先し、共通版へフォールバックします。
Source builds with `npm run package:vsix` produce a host-specific VSIX; `--universal` assembles the universal package. Updates prefer the matching host package and fall back to universal.
