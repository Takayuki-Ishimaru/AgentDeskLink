# AgentDeskLink 0.1.11（ベータ版）

**日本語** | [English](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/RELEASE_NOTES_en.md)

AI エージェントから、MCP を通じてローカルのブラウザとデスクトップを操作するベータ版です。利用前に[対応環境と既知の制限](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/KNOWN_ISSUES.md)を確認してください。

## 0.1.10 からの主な変更

- **信頼済みワークスペースで、そのまま操作を始められる初期設定にしました。** MCP と全対応操作、すべての http(s) URL・アプリへのアクセスを既定で有効にします。対応 OS では物理入力とネイティブ画像、localhost・プライベートネットワークへの接続も既定で許可します。送信・削除・購入なども個別確認なしで実行できるため、導入時に設定パネルの「現在の権限」を確認してください。OS の権限設定は引き続き必要です。
- **用途に合わせて権限を選びやすくしました。** 「読み取り専用」「下書き（保存しない）」「承認付き保存」「全操作」を選べます。制限する段階を選ぶと全操作と物理入力がオフになり、承認付き保存では全アプリ許可もオフになります。ネイティブ操作を承認する場合は、確認画面を表示する VS Code 以外のアプリを個別指定してください。
- **入力の成功と保存状態を区別できるようにしました。** 操作・承認結果と関連エラーの `save` に、未保存・承認待ち・送信済み・要確認の状態と次の手順を返します。送信済みでも保存完了の保証ではありません。fetch / XHR の承認後は同じ操作を繰り返さず、画面を観測して結果を確認してください。
- **長い選択肢を検索・分割取得できるようにしました。** `adl_observe` の `options` で、最初の 100 件より先にある候補も検索できます。検索はマスク済みの内容に対して行い、最大 10,000 件を調べます。取得元・項目・応答容量による省略を区別して返します。
- **観測応答の容量をバイト数で指定できるようにしました。** `byte_budget` で UTF-8 JSON の上限を指定できます。従来の `token_budget` も利用できますが、モデル固有のトークン数を保証するものではありません。両方の同時指定はできません。
- **表や定義リスト内の個人情報のマスクを改善しました。** 氏名・住所などの見出しと周囲の構造も使って内容を保護します。任意の氏名・住所をすべて認識する保証はありません。`allowPersonalData` を有効にしても、認証情報と明示保護領域は引き続き保護します。
- **デスクトップの対象取得と同時作業時の扱いを改善しました。** macOS・Linux でも全アプリ許可を操作権限と分けて扱います。Windows の意味的操作では、人間の入力に伴うフォーカスやカーソルの変化がある場合も対象を再確認します。対象の置き換えや説明できない変化では停止します。物理入力は引き続き、人間と同時に使わないでください。

## 更新時の設定

明示的に保存済みの拒否設定と、既存の読み取り専用・標準・都度承認の指定は保持します。既存の `agentdesklink.allowAllOperations: true` は引き続き優先されます。権限を絞る場合は設定パネルで段階を選び、URL・アプリ・画像・物理入力・ネットワークの実効権限も確認してください。個人情報の表示許可は既定でオフです。

保存通信の個別承認と、信頼するサイトへの最長 30 分間の継続許可は引き続き利用できます。対象と制限は[操作設定と承認](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/OPERATIONS.md)・[対応環境と既知の制限](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/KNOWN_ISSUES.md)を参照してください。

## 導入と更新

VS Code 1.101 以上で、共通パッケージ `agentdesklink-0.1.11.vsix` を「拡張機能: VSIXからのインストール」で開きます。macOS / Apple silicon、Windows x64、Linux x64 で同じ VSIX を利用できます。Node.js・画像処理ライブラリ・各 OS 用のデスクトップ helper を同梱します。Linux の helper には OS 側の Python 3 と AT-SPI2 関連パッケージが必要です。インストール後はウィンドウを再読み込みしてください。

0.1.3〜0.1.10 からは更新確認・自動更新を利用できます。自動更新は段階的に届く場合があります。手動の場合は VSIX と `SHA256SUMS` を取得し、ハッシュを確認してからインストールしてください。0.1.2 以前からは手動インストールが必要です。

制限する段階への切り替えと対象範囲の設定は、[インストールガイド](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/INSTALL.md#初期設定と操作範囲)を参照してください。

他の AI クライアントは **AIクライアント → すべて有効** で登録します。選んだワークスペースの権限が共有され、他のプロジェクトからもその範囲を利用できます。更新・権限変更・VS Code の再起動後は、必要に応じて再接続してください。

[インストール手順](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/INSTALL.md)・[更新ガイド](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/UPDATES.md)を参照してください。

## 利用上の注意

- 個別承認には VS Code への接続が必要です。対象・入力内容・観測した状態が変わった場合は、観測し直してください。閉じた Shadow DOM と別プロセスの iframe の個別承認は未対応です。
- Linux の操作可否はアプリとデスクトップ環境に依存します。画像取得・物理入力・アプリの起動と終了は未対応です。別のウィンドウやアプリがアクティブになった場合はセッションを閉じ、`desktop_focus_changed` を返します。
- 手動ログインの通信許可中には、サイトのスクリプトも送信・変更・削除を行えます。再開・期限終了・緊急停止は送信済み処理を取り消せません。
- 対応 OS では物理入力と無加工のネイティブ画像を既定で許可します。`interactive_desktop` は実際のマウス・キーボードを使うため、人間の操作と並行して利用しないでください。
- 画像やテキスト内の未知の秘密情報を完全に検出する保証はありません。取得した情報は接続先の AI ホストへ渡ります。
- macOS のデスクトップ操作にはアクセシビリティ権限、画像取得には画面収録権限が必要です。Windows の helper は未署名、macOS の helper は ad-hoc 署名です。
- 拡張機能を削除する前に **すべて無効** で外部クライアントの管理対象登録を解除してください。

## ライセンス

AgentDeskLink は [MIT License](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/LICENSE) で提供します。同梱する第三者ソフトウェアには、それぞれのライセンスが適用されます。

## 配布ファイル / Downloads

- macOS / Apple silicon・Windows x64・Linux x64 共通 / Common VSIX: `agentdesklink-0.1.11.vsix`
- 日英ドキュメント / Japanese and English guides: `AgentDeskLink-0.1.11-docs.zip`
- SHA-256: `SHA256SUMS`

Linux のデスクトップ操作には OS 側の Python 3 と AT-SPI2 関連パッケージが必要です。画像取得・物理入力・アプリの起動と終了は対象外です。
Linux desktop control requires OS-provided Python 3 and AT-SPI2 packages. Window capture, physical input and application launch/quit are unsupported.

---

# AgentDeskLink 0.1.11 (beta)

[日本語](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/RELEASE_NOTES_ja.md) | **English**

This beta lets AI agents control a local browser and desktop through MCP. Check the [supported environments and known limitations](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/KNOWN_ISSUES_en.md) before use.

## Changes since 0.1.10

- **Start operating with the default settings in a trusted workspace.** MCP, all supported operations, and access to all http(s) URLs and applications are enabled by default. Physical input and native images on supported operating systems, plus localhost and private-network connections, are also allowed by default. This includes submitting, deleting and purchasing without individual confirmation; review Current permissions in the panel when installing. Operating system permissions are still required.
- **Choose permissions by task.** The selector offers Read only, Draft (no save), Save with approval, and All operations. Choosing a restricted tier turns off All operations and physical input. Save with approval also turns off All applications; configure an individual native app other than the VS Code host displaying the approval dialog.
- **Distinguish input delivery from saving.** The `save` fields on action and approval results and related errors describe an unsaved draft, pending approval, a submitted request or a result needing verification, together with the next step. Submission does not guarantee persistence. After approving a fetch / XHR write, observe the result without repeating the action.
- **Search and page through long choice lists.** The `options` argument of `adl_observe` reaches choices beyond the initial 100. Search runs over masked content and scans up to 10,000 choices. Omissions caused by acquisition, field limits and response capacity are reported separately.
- **Set observation capacity in bytes.** `byte_budget` limits the UTF-8 JSON response size. The existing `token_budget` remains available but does not guarantee a model-specific token count. The two arguments cannot be combined.
- **Improved personal-data masking in tables and definition lists.** Names and addresses can be protected using headings and surrounding structure. Arbitrary names and addresses cannot all be recognized. Enabling `allowPersonalData` still keeps credentials and explicitly protected regions protected.
- **Improved desktop discovery and handling of concurrent activity.** macOS and Linux separate permission to discover all applications from permission to operate them. Windows semantic actions recheck their target when focus or pointer changes accompany human input. Target replacement and unexplained changes stop operations. Physical input still must not be used concurrently with a person.

## Settings when updating

Explicit saved denials and existing Read only, Standard and Ask settings are preserved. An existing `agentdesklink.allowAllOperations: true` still takes precedence. To narrow permissions, select a tier in the panel and review the effective URL, application, image, physical-input and network permissions. Permission to reveal personal data remains off by default.

Save-request approvals and continued permission to write to a trusted site for up to 30 minutes remain available. See [operation settings and approvals](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/OPERATIONS.md) and [known limitations](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/KNOWN_ISSUES_en.md) for their scope and restrictions.

## Installation and updates

Use VS Code 1.101 or newer and select “Extensions: Install from VSIX...” to install `agentdesklink-0.1.11.vsix`. The same VSIX supports macOS / Apple silicon, Windows x64 and Linux x64. It bundles Node.js, image-processing libraries and desktop helpers for each OS. The Linux helper also needs OS-provided Python 3 and AT-SPI2 packages. Reload the window after installation.

The updaters in 0.1.3 through 0.1.10 support this release. Automatic updates may arrive in stages. For manual installation, download the VSIX and `SHA256SUMS`, verify the hash and install. Updating from 0.1.2 or earlier requires manual installation.

See the [installation guide](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/INSTALL_en.md#initial-settings-and-scope) to select a restricted tier and configure its target scope.

Register other AI clients with **AI Clients → Enable all**. They share the selected workspace's permissions, including from other projects in those clients. Reconnect when needed after updating, changing permissions or restarting VS Code.

See the [installation guide](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/INSTALL_en.md) and [update guide](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/release-docs/UPDATES_en.md).

## Usage notes

- Individual approvals need a connection to VS Code. Observe again when the target, input or observed state changes. Closed shadow roots and out-of-process iframe approvals remain unsupported.
- Available Linux actions depend on the app and desktop environment. Window capture, physical input and application launch/quit are unsupported. When a different window or app becomes active, the session closes with `desktop_focus_changed`.
- During a manual-login network grant, site scripts may send, change or delete data. Resume, expiry and emergency stop cannot undo requests already sent.
- Physical input and unredacted native images are allowed by default on supported operating systems. `interactive_desktop` uses the real mouse and keyboard; do not use it while someone is interacting with the desktop.
- Unknown secrets in images or text cannot be detected completely. Captured information is passed to the connected AI host.
- macOS desktop control requires Accessibility permission; capture requires Screen Recording. The Windows helper is unsigned and the macOS helper is ad-hoc signed.
- Use **Disable all** to remove managed external-client registrations before uninstalling the extension.

## License

AgentDeskLink is available under the [MIT License](https://github.com/Takayuki-Ishimaru/AgentDeskLink/blob/v0.1.11/LICENSE). Bundled third-party software remains subject to its respective licenses.
