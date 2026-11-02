# 操作設定と承認 / Operation Settings and Approvals

対象バージョン / Target version: `0.1.8`（ベータ版 / beta）

[インストールとはじめ方](INSTALL.md) | [Installation and first steps](INSTALL_en.md)

## 権限 / Permissions

| `agentdesklink.operationMode` | 動作 / Behavior |
| --- | --- |
| `read_only`（既定 / default） | 観測・移動・スクロール / Observe, navigate and scroll |
| `standard` | 通常のブラウザ入力・クリックと JavaScript 内で処理するフォーム、許可したデスクトップアプリの機密・重要でないコントロールの操作。重要操作は拒否 / Ordinary browser inputs, clicks and forms handled within JavaScript, plus non-sensitive, non-consequential controls of the granted desktop app; consequential operations denied |
| `ask` | 通常操作に加え、検査可能な重要操作（ブラウザ、およびデスクトップアプリの削除・送信などのコントロール）を VS Code の確認画面で一度ずつ承認 / Ordinary inputs plus native VS Code approval for inspected consequential operations in the browser and on desktop-app controls such as delete or send |

ブラウザの重要操作は、ボタンの動詞（削除・送信・支払・購読解除・アーカイブ・リセット・ログアウトなど）と実際のフォーム送信で判定します。「キャンセル」「Sort order」「注文履歴」「お気に入りに登録」のような閉じる操作や名詞は通常操作です。「OK」「確定」は、名前が重要操作を示すダイアログ（例「Delete this item?」）の中では重要操作になります。同一 origin へ移動するだけのリンクは、ログアウト・配信停止・削除などで始まるものと、移動先の URL に `logout`・`cancel`・`delete` などの区切りや `action=` を含むものだけが対象です。ダウンロードリンクは常に対象です。判定はクリック・Enter/Space・選択・チェックに適用し、入力・hover・スクロールには適用しません。`agentdesklink.consequentialAllowLabels` / `consequentialDenyLabels`（CLI の設定ファイルでも同名）でラベルを対象外・対象に追加できます。拒否側が優先し、認証情報・実際のフォーム送信・ファイル・ダウンロード・保護領域の判定は変わりません。
Browser actions are consequential by the control's verb (delete, send, pay, unsubscribe, archive, reset, log out…) and by real form submissions. Dismiss idioms and nouns such as Cancel, Sort order, Order history or "add to favourites" are ordinary. OK / Confirm become consequential inside a dialog whose name is consequential (for example "Delete this item?"). Same-origin navigation links are gated only when they start with a verb such as log out, unsubscribe or delete, or when the destination URL has a path segment or `action=` value such as `logout`, `cancel` or `delete`; download links are always gated. Classification applies to click, Enter/Space, select and check, never to fill, hover or scroll. `agentdesklink.consequentialAllowLabels` / `consequentialDenyLabels` (same keys in a CLI policy) add labels that are never / always consequential. The deny list wins, and neither list relaxes credential, real form-submission, file, download or protected-region checks.

パネルで「すべて許可」を選ぶと VS Code の確認画面が表示されます。既存の `agentdesklink.allowAllOperations: true` は更新後も優先されるため、段階的な権限を利用するときはパネルで読み取り専用・標準・都度承認を選び直してください。どの段階でも origin・アプリの許可と明示保護領域の制限は維持されます。
Selecting Allow all in the panel requires a VS Code confirmation. An existing `agentdesklink.allowAllOperations: true` still takes precedence after updating; choose Read only, Standard or Ask each time in the panel to switch to a permission tier. Origin/app grants and explicit protected regions remain enforced.

個別承認は main document、open Shadow DOM、同一 origin の iframe の検査可能な対象に対応します。対象・入力値・フォーム内容を結び付け、変更・失効・停止後の再利用を拒否します。main document では無関係な時計の更新を許容します。同一 origin の iframe ではページ更新後に観測し直してください。認証情報・隠しフォーム値は確認画面へ送りません。AI が指定したメールなどの個人情報は、入力内容を人間が確認できるよう表示される場合があります。AI は承認を決定できません。承認後は同じ操作を再要求します。
One-shot approvals cover inspected controls in the main document, open Shadow DOM and same-origin iframes. They bind the target, exact input and form contents. Changes, expiry or stop invalidate them. Unrelated clock updates in the main document are tolerated; reobserve after page updates for same-origin iframe actions. Credentials and hidden form values are not sent to the dialog. Personal data supplied by the AI, such as an email address, may appear so the person can review the exact input. The AI cannot approve its own request; after approval it retries the same operation.

デスクトップアプリの個別承認は、観測したコントロールの役割・名前・入力値と観測リビジョンに結び付き、確認画面にはアプリ ID・ウィンドウ名・コントロールを表示します。承認は 1 回の操作だけに有効で、画面が変わると失効します。パスワードなどの機密コントロールは承認の対象外で常に拒否します。helper 自身も同じ語彙で重要操作を判定し、承認済みの 1 件だけを通します。
Desktop-app approvals bind the observed control's role, name and input to the observed revision; the dialog shows the app ID, window title and control. An approval covers that one action only and lapses when the window changes. Sensitive controls such as password fields are never candidates and are always refused. The helper applies the same vocabulary itself and lets through only the one approved action.

閉じた Shadow DOM、別プロセスの iframe の個別承認は未対応です。通信の許可は検査済み URL encoded フォーム POST 1 回で、multipart・ファイル・一般的な AJAX/DELETE は対象外です。VS Code に接続できない場合や、許可したデスクトップアプリが VS Code 自身である設定では、承認を許可しません。
Closed shadow roots and out-of-process iframe proofs remain unsupported. Network permits cover one inspected URL-encoded form POST, excluding multipart, files and generic AJAX/DELETE. A disconnected broker, or a granted desktop app that is the VS Code host itself, cannot authorize requests.

## ブラウザ / Browser

| 設定 / Setting | 既定値・内容 / Default and meaning |
| --- | --- |
| `agentdesklink.browserOrigins` | 移動を許可する完全な http(s) origin / Exact origins permitted for navigation |
| `agentdesklink.browserResourceOrigins` | CDN など GET/HEAD のサブリソース専用。移動・送信の許可にはなりません / GET/HEAD subresources only; grants neither navigation nor submission |
| `agentdesklink.allowLoopback` / `agentdesklink.allowPrivateNetwork` | 既定はオフ。接続先の正確な origin の許可も必要 / Off by default; exact destination origin grants are also required |
| `agentdesklink.allowPersonalData` | 既定はオフ。個人情報の表示を許可。認証情報と明示保護は維持 / Off by default; reveals personal data while keeping credentials and protected regions protected |
| `agentdesklink.browserHeadless` | `true`。`false` で可視起動 / Set false for a visible browser |
| `agentdesklink.sessionIdleMinutes` | `15`。1〜60 分、利用中は延長 / 1–60 minutes, renewed on use |
| `agentdesklink.browserProxyServer` | 空 / empty。認証・パス・クエリのない http(s) proxy origin / HTTP(S) proxy origin without credentials, path or query |
| `agentdesklink.browserProxyConnectByHostname` | 既定はオフ。HTTPS の CONNECT をホスト名で送信。ローカル DNS/IP 検査と TLS 検証は維持 / Off by default; sends HTTPS CONNECT by hostname while preserving local DNS/IP and TLS checks |

許可元はパネル上部で設定します。localhost を追加してもループバック許可は自動で有効になりません。表示言語は日英を切り替えられ、初期値は VS Code の言語に従います。可視起動・アイドル期限・プロキシは「詳細設定」にあります。
Configure grants near the top of the panel. Adding localhost does not enable loopback permission automatically. Switch Japanese/English at the top; the initial language follows VS Code. Visible launch, idle timeout and proxy settings are under Advanced settings.

可視ブラウザの手動ログインは `adl_handoff` の `pause` / `resume` を使用します。`ask` では、同じ origin のサイトスクリプト・フォーム通信を最大 120 秒許す専用確認が必要です。自動操作は停止したまま、再開または期限で通信許可を終了します。再開後は再観測し、新しい revision を使用してください。`standard` / `read_only` はこの通信許可を取得できません。
For a manual login use `adl_handoff` with `pause` / `resume` in a visible browser. Ask requires separate approval for same-origin website scripts and forms to send requests for up to 120 seconds. Automation stays paused; resume or expiry ends the grant. Observe again and use the new revision after resuming. Standard and read-only modes cannot obtain this grant.

この期間は人間のクリック前にもサイト処理が送信・変更・削除を行えます。再開・失効は新しい通信の送出を止めますが、送出済み処理は取り消せません。
Website scripts may send, change or delete before a human click during this interval. Resume or expiry prevents new dispatch; requests already dispatched cannot be rolled back.

普段のブラウザとは別のプロファイルを使います。同梱 Node は OS の信頼済み証明書を利用します。プロキシ経由でも接続先のローカル DNS/IP 検査と TLS 検証を行うため、プロキシ側でしか名前解決できないホストは利用できません。
The browser uses a separate profile. Bundled Node uses OS-trusted certificates. Destination DNS/IP checks remain local and TLS verification stays enforced through proxies; hosts resolvable only by the proxy are unsupported.

## MCP

- `adl_observe`: `format: "json"`（既定）、`"lines"`（行形式）。どの形式でも `enabled: true` と空の `value` を省き、選択肢は label と同じ `value` と、false の `disabled` / `selected` を省きます（`"compact"` は `"json"` と同じ出力）。`lines` の各行は `<id> <role> "<name>" key=value…` で、id・ロールは英数字・`_`・`-` だけのときに引用符なし、それ以外の文字列は常に JSON の引用符付きです。`url` / `title` は全量の応答と、差分で変わったときだけ返します。`session_id`・`format` は応答に含めません。差分・scope・cursor は全形式で利用できます / `format: "json"` (default) or `"lines"`. Every format omits `enabled: true` and empty `value`; options omit a `value` equal to the label and false `disabled` / `selected` (`"compact"` gives the same output as `"json"`). A `lines` row is `<id> <role> "<name>" key=value…`: id and role are bare only when they consist of letters, digits, `_` and `-`; every other string is JSON-quoted. `url` / `title` appear on full responses and on deltas only when they changed. Responses no longer echo `session_id` or `format`. Diff, scope and cursor work in every format.
- `adl_act`: `press` / `back` / `hover`、および `click` の `point: {frame_id,x,y}`。座標は最新画像の取得元 CSS ピクセル、30 秒以内・同じ位置と対象が必要です。Coordinate clicks require the latest retained frame, source CSS pixels, unchanged geometry and a frame age under 30 seconds.
- `adl_observe` の `text: {element_id, offset, length}`: 省略された長文の続きを取得します。`name_truncated` / `value_truncated` / `text_length` を確認し、`next_offset` で続きを読みます。位置はマスク済みテキストの UTF-16 単位で、絵文字の途中は指定できません / Reads beyond a clipped name. Use `name_truncated` / `value_truncated` / `text_length` and continue with `next_offset`. Offsets are UTF-16 positions in redacted text and cannot split an emoji.
- `truncated` は要素が省略されたことだけを示します（`next_cursor` で続きを取得。最後のページでは `next_cursor` を省きます）。名前・値の切り詰めは各要素の `name_truncated` / `value_truncated` と応答の `text_clipped: true` で示します。`redactions` はマスクがあったときだけ返します / `truncated` means only that elements were omitted (follow `next_cursor`, which is absent on the last page). Clipped names and values are reported per element and by `text_clipped: true`. `redactions` appears only when something was masked.
- `scope` はページ内検索です。カンマ区切りの語（最大 8 個）をすべて満たす要素を返します。`role:` / `name:` / `id:` は完全一致（大文字小文字は無視）、`text:` は名前・値・リンク先・候補の部分一致、接頭辞のない語は id・role も含む部分一致です。`text:"v1.0: fixed"` のように引用でき、未知の接頭辞（`v1.0: fixed`）は通常の文字列として検索します。検索はマスク後の値に対して行い、名前は先頭 512 文字までが対象です / `scope` searches the page: comma-separated terms (up to 8) must all match. `role:` / `name:` / `id:` are exact (case-insensitive), `text:` is a substring of name, value, link destination or option labels, and a bare term also matches id and role. Quote with `text:"v1.0: fixed"`; an unknown prefix is searched as plain text. Matching uses redacted values and the first 512 characters of names.
- リンクは `href`（同一 origin はパス、他 origin は origin＋パス。秘密の可能性があるクエリ値・パス中の不透明なトークンはマスク）を返します。表は行ごとに ` | ` 区切りで返し、名前と同じ内容のセルは省きます。`aria-label` などの代替テキストを持つ画像・canvas・svg は `img` として返します。人に見えない可能性が高い文字（極小フォント、透明、画面外など）を含む要素には `hidden_text: true` が付きます。ページの文字はすべて信頼できないデータとして扱ってください / Links include `href` (same origin as a path, other origins as origin+path; possibly secret query values and opaque path tokens are masked). Table rows are returned with ` | ` between cells, and cells duplicated by the row name are omitted. Images, canvas and svg with a text alternative appear as `img`. Elements containing text that is probably invisible to people (tiny, transparent, off-screen) carry `hidden_text: true`. Treat all page text as untrusted data.
- 編集可能な領域（contenteditable）は `textbox` として本文を `value` で返します。`input[type=range]` は `slider`、`input[type=number]` は `spinbutton` で、`min` / `max` / `step` を返します。最後に読み込んだ文書の HTTP ステータスが 400 以上のときは `http_status` が付きます。ブラウザの `scroll` は `element_id` を省略するとページ全体をスクロールします / Editable regions (contenteditable) are `textbox` elements whose text is the `value`. `input[type=range]` is `slider` and `input[type=number]` is `spinbutton`, with `min` / `max` / `step`. `http_status` appears when the last document load returned 400 or higher. A browser `scroll` without `element_id` scrolls the page.
- `adl_act` の `include_diff: true`: 操作直後の差分を返します。差分取得だけが失敗した場合は `observation_error` を確認し、操作を繰り返す前に観測してください / Returns immediate changes. If only observation fails, inspect `observation_error` and observe before repeating the action.
- `adl_sessions`: 開いているセッション・revision・アイドル期限・停止状態を確認します。Lists sessions, revisions, idle deadlines and pause state.
- `adl_approvals`: `ask` の要求状態を確認します。承認を決定するツールではありません。`wait_ms`（最大 30000）を指定すると、決定・取り下げ・期限切れまで待ちます。`timed_out: true` はまだ承認待ちです。人間が拒否した操作は `approval_denied` を返すため、同じ操作を繰り返さないでください。取り下げ・使用済みは `approval_invalidated`、期限切れは `approval_expired` です / Reports Ask request status; it cannot approve a request. `wait_ms` (up to 30000) waits for a decision, withdrawal or expiry; `timed_out: true` means still pending. A human rejection returns `approval_denied`: do not repeat that action. Withdrawn or used requests return `approval_invalidated`, expired ones `approval_expired`.

閉じた Shadow DOM は意味的観測の対象外で、画像では iframe とともにマスクします。取得には上限があるため省略フラグを確認してください。通常の入力欄や checkbox は画像で確認できますが、既知の秘密形式と明示保護は隠します。未知の秘密を完全に検出する保証はありません。
Closed Shadow DOM is not semantically observed and is masked with iframes in images. Collection has limits; check truncation flags. Ordinary inputs and checkboxes remain visible; known secret patterns and explicit protected regions are masked. Unknown secret detection is not guaranteed.

長文取得の例 / Long-text example (`adl_observe`):

```json
{"session_id":"<session_id>","text":{"element_id":"<element_id>","offset":0,"length":4096}}
```

操作直後の差分 / Immediate action diff (`adl_act`):

```json
{"session_id":"<session_id>","expected_revision":12,"action":"click","element_id":"<element_id>","include_diff":true}
```

操作応答や観測の `network_blocked` / `warnings` を確認してください。`network_blocked: true` は操作自体の通信（ページ遷移、fetch / XHR、POST などの書き込み）が遮断された場合だけ付きます。未許可 origin の CSS・画像・フォントなど無関係なサブリソースの遮断は `subresources_blocked` の件数で示します。各 `warnings` には `code`（`origin_not_allowed`、`method_requires_approval`、`redirect_origin_not_allowed`、`proxy_connect_refused` など）、`resource_type`、`method` が付きます。チェック操作で、元の要素が要求した状態になったことを確認でき、直後に要素が作り直された場合は `ok: true` と警告 `target_replaced` を返し、セッションを維持します（観測し直してください）。リンク・フォーム・`navigate` の応答が本文のない 204 / 205 の場合（同じ origin へのリダイレクトの先を含む）は、表示中のページをそのまま残して `ok: true` と警告 `no_content` を返します（途中のリダイレクトが Cookie を設定した場合だけは、Cookie を保存するために元のページが空のページに置き換わります。`no_content` のメッセージで示すので、移動し直してください）。標準モードの「Delete」「Remove」「削除」だけが理由で重要操作になるボタンは、次の操作まで通信を制限した状態で実行し、`ok: true` と警告 `contained_action` を返します（ページ内のスクリプトは実行されます）。通るのは、押す前からそのページが出していた GET 通信と同じ形のもの（定期通信など。数字を含むクエリ値は区別しません）だけです。ボタンが新しい通信やページ移動を始めた場合は送信前に止めて `E_APPROVAL_REQUIRED` / `requires_ask_mode` と `page_script_ran: true` を返します（ページのスクリプトは動いた後なので、観測し直してください）。応答を返した後に始まった場合は、次の観測の `warnings` に `requires_ask_mode` として出ます。新しい画像・CSS・フォント・メディアは読み込まず、操作は止めません。文書のリダイレクトは、`browserOrigins` で許可した origin へなら別の origin にも従い、そこでの操作と元の origin への戻りができます（SSO のログイン向け。許可のない origin では `redirect_origin_not_allowed`。対象ごとの `controls`・画像取得・ジェスチャーは移動先では使えません）。`ok: true` は入力の受領を示し、サイトの処理完了を保証しません。未承認の fetch POST は検索用途でも遮断します。`expected_target` は対象の追加確認で、鮮度検査や承認を省略しません。
Check `network_blocked` / `warnings` in action responses and observations. `network_blocked: true` is set only when the action's own traffic (navigation, fetch / XHR, or a write such as POST) was blocked; unrelated subresources such as stylesheets, images or fonts from non-granted origins are counted in `subresources_blocked`. Each warning carries `code` (`origin_not_allowed`, `method_requires_approval`, `redirect_origin_not_allowed`, `proxy_connect_refused`, …), `resource_type` and `method`. For a check action, when the original element reached the requested state before being replaced, the response is `ok: true` with the warning `target_replaced` and the session stays open; observe again. When a link, form or `navigate` is answered with 204/205 and no content (including at the end of a same-origin redirect), the current page stays and the response is `ok: true` with the warning `no_content` (only when a redirect on the way set cookies does an empty page replace the current one, as storing them takes a document; the `no_content` message says so, and you navigate again). In standard mode, a button consequential only because of "Delete", "Remove" or "削除" runs with network restrictions until the next action and returns `ok: true` with the warning `contained_action` (page scripts still run). Only GET requests shaped like those the page was already making before the click (such as polling) go on; query values containing digits are not distinguished. If the button starts a new request or a navigation, it is stopped before it leaves and the response is `E_APPROVAL_REQUIRED` / `requires_ask_mode` with `page_script_ran: true` (the page's script has run by then, so observe again). One that starts after the response shows as `requires_ask_mode` in the `warnings` of the next observation. New images, CSS, fonts and media are left out without stopping the action. A document redirect is followed to another origin when `browserOrigins` grants it, and the session can act there and return to its origin (for SSO sign-ins); an origin without a grant gives `redirect_origin_not_allowed`, and a target's `controls`, image capture and gestures do not apply at the destination. `ok: true` acknowledges input and does not guarantee application success. Unapproved fetch POST remains blocked even for search. `expected_target` adds a target check and does not bypass freshness or approval checks.

遮蔽された対象には `E_NOT_INTERACTABLE` / `occluded` が返る場合があります。障害物を取り除いて観測し直してください。安全に DOM API を検証できないページは `untrusted_dom_api` で停止します。
An obscured target may return `E_NOT_INTERACTABLE` / `occluded`; remove the obstruction and observe again. Pages whose DOM APIs cannot be verified safely stop with `untrusted_dom_api`.

CLI の読み込み専用許可元は `resourceOrigins`、個人情報の表示許可は `allowPersonalData` です。
For the CLI, use `resourceOrigins` for resource-loading grants and `allowPersonalData` to reveal personal data.

CLI で `operationMode` を省略すると既存の `controls` 許可を維持します。明示的な `read_only` は操作を拒否します。CLI のランタイム設定は `browserHeadless`、`browserProxyServer`、`sessionTtlMs` です。
Omitting `operationMode` in a CLI policy preserves legacy control grants; explicit read-only denies mutations. CLI runtime settings are `browserHeadless`, `browserProxyServer` and `sessionTtlMs`.

ソースからの `npm run package:vsix` は実行 OS/CPU 用の VSIX を生成します。`--universal` で共通版も組み立てられます。公開リリースの更新ファイルは対応 OS 版を優先し、共通版へフォールバックします。
Source builds with `npm run package:vsix` produce a host-specific VSIX; `--universal` assembles the universal package. Updates prefer the matching host package and fall back to universal.

要素 ID（`e1` など）はセッションごとの別名です。ページ移動や対象の作り直し後は観測し直し、最新の ID を使ってください。古い ID を別の対象に割り当て直すことはありません。
Element IDs such as `e1` are session-specific aliases. Reobserve after navigation or target replacement and use the latest IDs. Old IDs are never reassigned to another target.

標準モードと都度承認モードでは JavaScript が送信を取り消して処理するフォームを承認なしで利用できます。実際の GET/POST フォーム送信は送信前にブラウザ内で取り消し、`form_submission_requires_approval` を返します。都度承認モードではこのとき承認の要求を作り、`request_id` と再実行に使う `revision` を返します。`adl_approvals` で決定を待ち、承認後に同じ操作を返された `revision` で再実行すると、承認した内容だけが送信されます。標準モードでは送信できません。詳しくは[制限事項](KNOWN_ISSUES.md)を確認してください。
In Standard and Ask modes, forms handled by JavaScript without submission work without approval. A real GET/POST form submission is cancelled in the browser before it is sent and returns `form_submission_requires_approval`. In Ask mode that creates an approval request and returns `request_id` plus the `revision` for the retry: wait with `adl_approvals`, then repeat the identical action with that `revision`, and only the approved submission is sent. Standard mode cannot send it. See [known limitations](KNOWN_ISSUES_en.md).
