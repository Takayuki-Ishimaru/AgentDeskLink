# 更新の設定とファイルの確認

**日本語** | [English](UPDATES_en.md)

対象バージョン: `0.1.3`

## 0.1.2 以前からの更新

0.1.3 から配布ファイルを OS 共通の `agentdesklink-0.1.3.vsix` に変更しました。0.1.2 以前の更新機能はこのファイル名に対応していないため、公式リリースページから共通 VSIX と `SHA256SUMS` を取得し、ハッシュを確認して手動でインストールしてください。インストール後は VS Code のウィンドウを再読み込みします。

更新後は[インストールガイド](INSTALL.md)に従い、許可する origin／アプリと操作権限を設定してください。MCP の有効化だけでは権限を追加しません。

## 更新元（設定は不要）

更新元は GitHub の公式リポジトリ [Takayuki-Ishimaru/AgentDeskLink](https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases) に固定されています。URL を設定する必要はありません。拡張機能は GitHub の Releases API（`https://api.github.com/repos/Takayuki-Ishimaru/AgentDeskLink/releases?per_page=100`）を読み、直近 100 件のリリースから更新を探します。

- 現在の版より新しい SemVer タグを持つ、公開済みのリリースが対象です。GitHub のプレリリース（ベータ版）も含まれます。ドラフトや版番号として解釈できないタグは使いません。
- macOS / Apple silicon、Windows x64、Linux x64 では、OS 共通の `agentdesklink-<版>.vsix` を優先して選びます。同梱ランタイムの選択は起動時に自動で行います。
- 過去のリリースにある OS 別の VSIX も、自分の OS・CPU に正確に一致する場合に限って選べます。共通 VSIX が対応しない OS・CPU では、その共通 VSIX をインストールしません。
- ダウンロードした VSIX の SHA-256 を、GitHub が配布ファイルに付けたダイジェストと必ず照合します。一致しない場合はインストールしません。

以前の `agentdesklink.updateManifestUrl` 設定は使用しません。

## 更新確認と停止

- `agentdesklink.checkForUpdates`: オンの場合、起動 5 秒後と 6 時間ごとに確認します。オフにすると自動・手動の確認を停止します。
- `agentdesklink.autoUpdate`: オフの場合、新しい版の通知だけを行い、インストールしません。
- 自動更新では、ダウンロードした VSIX の SHA-256 を確認してからインストールします。
- 反映にはウィンドウの再読み込みが必要です。作業中のウィンドウを自動で再読み込みすることはありません。
- 現在と同じ版や古い版には自動更新しません。対応する配布ファイルがない場合は、その旨を表示し、ダウンロードもインストールも行いません。

認証が必要な配布先からの自動取得には対応していません。自動更新が利用できない場合は、リリースページから共通 VSIX を取得して手動インストールしてください。

## リリースの形式

このリリースに添付する VSIX は 1 つです。

```text
agentdesklink-0.1.3.vsix
```

拡張機能はこの名前と GitHub が返す `sha256:` ダイジェスト、`https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases/download/<タグ>/<配布ファイル名>` の正規 URL を使って配布ファイルを特定します。独自の更新情報ファイル（`update.json` など）は読みません。

## ダウンロードした VSIX の確認

リリースに添付された `SHA256SUMS` と、ダウンロードしたファイルの SHA-256 を比較してください。次はファイルを保存したフォルダーで実行する例です。

macOS:

```sh
shasum -a 256 agentdesklink-0.1.3.vsix
```

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\agentdesklink-0.1.3.vsix | Format-List Hash
```

Linux:

```sh
sha256sum agentdesklink-0.1.3.vsix
```

一覧と一致しない場合は、そのファイルをインストールせず、公式リポジトリのリリースページから取得し直してください。
