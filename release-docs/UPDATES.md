# 更新の設定とファイルの確認

**日本語** | [English](UPDATES_en.md)

対象バージョン: `0.1.2`

## 0.1.1 以前からの更新

0.1.1 以前の版を利用している場合は、公式リリースページから自分の OS・CPU に合った `0.1.2` の VSIX と `SHA256SUMS` を取得し、ハッシュを確認して手動でインストールしてください。インストール後は VS Code のウィンドウを再読み込みします。0.1.2 以降では更新先 URL の設定は不要です。以前の `agentdesklink.updateManifestUrl` 設定は使用しません。

## 更新元（設定は不要）

更新元は GitHub の公式リポジトリ [Takayuki-Ishimaru/AgentDeskLink](https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases) に固定されています。URL を設定する必要はありません。拡張機能は GitHub の Releases API（`https://api.github.com/repos/Takayuki-Ishimaru/AgentDeskLink/releases?per_page=100`）を読み、直近 100 件のリリースから更新を探します。

- 現在の版より新しい SemVer タグを持つ、公開済みのリリースが対象です。GitHub のプレリリース（ベータ版）も含まれます。ドラフトや版番号として解釈できないタグは使いません。
- 自分の OS・CPU に対応する `agentdesklink-<OS>-<CPU>-<版>.vsix` を自動的に選びます。対応する配布ファイルがないリリースは無視し、他の OS・CPU 向けのパッケージをインストールすることはありません。
- ダウンロードした VSIX の SHA-256 を、GitHub が配布ファイルに付けたダイジェストと必ず照合します。一致しない場合はインストールしません。

| OS・CPU | 選択される配布ファイル名の例 |
| --- | --- |
| macOS / Apple silicon | `agentdesklink-darwin-arm64-0.1.2.vsix` |
| Windows x64 | `agentdesklink-win32-x64-0.1.2.vsix` |

## 更新確認と停止

- `agentdesklink.checkForUpdates`: オンの場合、起動 5 秒後と 6 時間ごとに確認します。オフにすると自動・手動の確認を停止します。
- `agentdesklink.autoUpdate`: オフの場合、新しい版の通知だけを行い、インストールしません。
- 自動更新では、ダウンロードした VSIX の SHA-256 を確認してからインストールします。
- 反映にはウィンドウの再読み込みが必要です。作業中のウィンドウを自動で再読み込みすることはありません。
- 現在と同じ版や古い版には自動更新しません。利用する OS・CPU に対応する版がまだ公開されていない場合は、その旨を表示し、ダウンロードもインストールも行いません。

認証が必要な配布先からの自動取得には対応していません。自動更新が利用できない場合は、リリースページから対応する VSIX を取得して手動インストールしてください。

## リリースの形式

各リリースには、対象ごとに次の名前の VSIX を添付します。拡張機能はこの名前と GitHub が返す `sha256:` ダイジェスト、`https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases/download/<タグ>/<配布ファイル名>` の正規 URL を使って配布ファイルを特定します。独自の更新情報ファイル（`update.json` など）は読みません。

```text
agentdesklink-darwin-arm64-0.1.2.vsix
agentdesklink-win32-x64-0.1.2.vsix
```

## ダウンロードした VSIX の確認

リリースに添付された `SHA256SUMS` と、ダウンロードしたファイルの SHA-256 を比較してください。次はファイルを保存したフォルダーで実行する例です。

macOS:

```sh
shasum -a 256 agentdesklink-darwin-arm64-0.1.2.vsix
```

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\agentdesklink-win32-x64-0.1.2.vsix | Format-List Hash
```

一覧と一致しない場合は、そのファイルをインストールせず、公式リポジトリのリリースページから取得し直してください。
