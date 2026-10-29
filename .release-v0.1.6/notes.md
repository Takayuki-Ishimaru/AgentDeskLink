# AgentDeskLink 0.1.6（ベータ版）

**日本語** | [English](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/RELEASE_NOTES_en.md)

AI エージェントから、MCP を通じてローカルのブラウザとデスクトップを操作するベータ版です。利用前に[対応環境と既知の制限](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/KNOWN_ISSUES.md)を確認してください。

## 0.1.5 からの主な変更

- **ブラウザ操作と個別承認の安定性を改善しました。** main document では時計など無関係な表示の更新を許容し、操作対象・入力値・フォーム内容・文書の変化は引き続き検査します。承認の期限切れ、二重利用、緊急停止後の再利用は拒否します。
- **open Shadow DOM と同一 origin の iframe の操作に対応しました。** 検査可能な対象を通常操作・個別承認で扱えます。閉じた Shadow DOM、別プロセスの iframe、ネイティブアプリの個別承認は対象外です。
- **移動先と読み込み専用の許可元を分けました。** `browserResourceOrigins` で CDN などの GET/HEAD サブリソースを許可できます。移動先の許可にはなりません。標準モードで GET 検索フォームを利用でき、遮断された通信は操作応答でも確認できます。
- **長文と大きな表を読みやすくしました。** 省略されたテキストは `adl_observe` の `text` 指定で続きを取得でき、表・行・リストの親子関係も返します。`adl_act` の `include_diff: true` で操作直後の差分を取得できます。
- **マスクと操作エラーの説明を改善しました。** 通常のラベルを過剰に隠す場合を減らし、個人情報の表示を `allowPersonalData` の明示設定へ分けました。認証情報と明示保護領域は引き続き保護します。遮蔽・許可不足・接続失敗などの理由も確認しやすくしました。
- **設定パネルを整理しました。** 許可元を上部にまとめ、詳細設定を折りたたみ、日英の表示切替とループバック／プライベートネットワークの許可設定を追加しました。localhost の追加だけではネットワークの許可は有効になりません。
- **通信とクライアント登録を改善しました。** 接続の再利用と公開静的資産の条件付きキャッシュを追加しました。同梱 Node は OS の信頼済み証明書を利用します。大きな Claude クライアント設定の登録にも対応しました。

## 導入と更新

VS Code 1.101 以上で、共通パッケージ `agentdesklink-0.1.6.vsix` を「拡張機能: VSIXからのインストール」で開きます。macOS / Apple silicon、Windows x64、Linux x64 で同じ VSIX を利用できます。Node.js と画像処理ライブラリ、macOS/Windows 用 helper を同梱します。インストール後はウィンドウを再読み込みしてください。

0.1.3〜0.1.5 からは更新確認・自動更新を利用できます。手動の場合は VSIX と `SHA256SUMS` を取得し、ハッシュを確認してからインストールしてください。0.1.2 以前からは手動インストールが必要です。

**既存の `agentdesklink.allowAllOperations: true` は更新後も優先されます。** 段階的な権限へ切り替えるには、設定パネルで読み取り専用・標準・都度承認を選び直してください。MCP の有効化だけでは対象へのアクセス権限を追加しません。

他の AI クライアントは **AIクライアント → すべて有効** で登録します。選んだワークスペースの権限が共有され、他のプロジェクトからもその範囲を利用できます。更新・権限変更・VS Code の再起動後は、必要に応じて再接続してください。既存の別サーバーや同名の手動登録は保持します。

[インストール手順](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/INSTALL.md)・[操作設定と承認](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/OPERATIONS.md)・[更新ガイド](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/UPDATES.md)を参照してください。

## 利用上の注意

- 個別承認は main document、open Shadow DOM、同一 origin の iframe にある検査可能な操作が対象です。閉じた Shadow DOM、別プロセスの iframe、ネイティブアプリの個別承認は未対応です。同一 origin の iframe でも、ページ更新後は観測し直す必要があります。通信の許可は検査済み URL encoded フォーム POST 1 回に限られ、multipart・ファイル・一般的な AJAX/DELETE は対象外です。
- VS Code に接続できない場合や、許可したネイティブ操作で確認画面自体を操作できる構成では、個別承認を利用できません。
- 手動引き継ぎの通信許可中は、人間のクリック前にもサイトが送信・変更・削除を行えます。再開・期限終了・緊急停止は、すでに送信した処理を取り消せません。
- 物理入力と無加工のネイティブ画像は既定で無効です。`interactive_desktop` は実際のマウス・キーボードを使うため、人間の操作と並行して利用しないでください。
- 画像やテキスト内の未知の秘密情報を完全に検出する保証はありません。取得した情報は接続先の AI ホストへ渡ります。
- macOS のデスクトップ操作にはアクセシビリティ権限、画像取得には画面収録権限が必要です。Windows の helper は未署名、macOS の helper は ad-hoc 署名です。
- Linux はブラウザ操作のみです。Ubuntu 24.04 x64 で、Chrome / Chromium に必要な共有ライブラリと OS sandbox が動作する環境が必要です。
- 拡張機能を削除する前に **すべて無効** で外部クライアントの管理対象登録を解除してください。

## ライセンス

AgentDeskLink は [MIT License](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/LICENSE) で提供します。同梱する第三者ソフトウェアには、それぞれのライセンスが適用されます。

## 配布ファイル / Downloads

- macOS / Apple silicon・Windows x64・Linux x64 共通 / Common VSIX: `agentdesklink-0.1.6.vsix`
- 日英ドキュメント / Japanese and English guides: `AgentDeskLink-0.1.6-docs.zip`
- SHA-256: `SHA256SUMS`

Linux は Ubuntu 24.04 x64 のブラウザ操作に対応します。デスクトップ操作には対応していません。
Linux supports browser operations on Ubuntu 24.04 x64. Desktop control is unavailable on Linux.

---

# AgentDeskLink 0.1.6 (beta)

[日本語](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents operate the local browser and desktop over MCP. Read the [supported environments and known limitations](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.5

- **Improved browser action and one-shot approval reliability.** In the main document, unrelated display updates such as clocks no longer invalidate the action. Targets, exact input, form contents and document changes are still checked. Expired, reused or emergency-stop-revoked approvals are refused.
- **Added actions in open Shadow DOM and same-origin iframes.** Inspected controls support ordinary actions and one-shot approval. Closed shadow roots, out-of-process iframe proofs and native app approvals remain unsupported.
- **Separated navigation grants from resource-loading grants.** `browserResourceOrigins` allows GET/HEAD subresources such as CDN assets without granting navigation. Standard mode supports GET search forms, and action responses report blocked network requests.
- **Improved reading of long text and large tables.** Use `text` in `adl_observe` to retrieve text beyond a clipped name. Observations include parent relationships for tables, rows and lists. `adl_act` with `include_diff: true` returns immediate changes after an action.
- **Improved masking and error explanations.** Fewer ordinary labels are hidden unnecessarily. Revealing personal data requires an explicit `allowPersonalData` grant; credentials and protected regions remain protected. Errors give clearer reasons for occlusion, missing grants and connection failures.
- **Reorganized the settings panel.** Grants appear near the top, advanced settings collapse, and Japanese/English language switching and loopback/private-network controls are available. Adding localhost alone does not enable its network grant.
- **Improved networking and client registration.** Added connection reuse and conditional caching of public static assets. Bundled Node uses OS-trusted certificates. Registration also supports larger Claude client configuration files.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.6.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js and image-processing libraries plus macOS/Windows helpers. Reload the window after installation.

The updaters in 0.1.3 through 0.1.5 support this release. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

**An existing `agentdesklink.allowAllOperations: true` still takes precedence after updating.** To use a permission tier, select Read only, Standard or Ask each time in the panel. Enabling MCP alone grants no target access.

Register other AI clients with **AI Clients → Enable all**. They share the selected workspace's permissions, including from other projects in those clients. Reconnect when needed after updating, changing permissions or restarting VS Code. Other servers and manual entries with the same name are preserved.

See the [installation guide](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/INSTALL_en.md), [operation settings and approvals](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/OPERATIONS.md) and [update guide](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/release-docs/UPDATES_en.md).

## Usage notes

- One-shot approval covers inspected controls in the main document, open Shadow DOM and same-origin iframes. Closed shadow roots, out-of-process iframe proofs and native app approvals remain unsupported. Reobserve after page updates when acting inside a same-origin iframe. Network permits cover one inspected URL-encoded form POST; multipart, files and generic AJAX/DELETE remain unsupported.
- Approval is unavailable without a connection to VS Code, or when permitted native operations could operate the approval host itself.
- During a manual handoff network grant, website scripts may send, change or delete before a human click. Resume, expiry and emergency stop cannot undo requests already dispatched.
- Physical input and unredacted native images default to off. `interactive_desktop` uses the real mouse and keyboard; do not use it while someone is interacting with the desktop.
- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording. The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Linux supports browser operations only. Ubuntu 24.04 x64 requires the shared libraries needed by Chrome / Chromium and a working OS sandbox.
- Use **Disable all** to remove managed external-client registrations before uninstalling the extension.

## License

AgentDeskLink is available under the [MIT License](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.6/LICENSE). Bundled third-party software remains subject to its respective licenses.
