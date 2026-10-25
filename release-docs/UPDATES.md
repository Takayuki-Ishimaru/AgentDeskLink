# 更新の設定とファイルの確認

**日本語** | [English](UPDATES_en.md)

対象バージョン: `0.1.1`

## 更新先の設定

ユーザー設定の `agentdesklink.updateManifestUrl` に、自分の OS・CPU に対応する更新マニフェストの HTTPS URL を指定します。既定は空で、空のあいだは更新の通信を行いません。

| OS・CPU | マニフェスト名の例 |
| --- | --- |
| macOS / Apple silicon | `update-darwin-arm64.json` |
| Windows x64 | `update-win32-x64.json` |

異なる OS・CPU 用の更新先は使用しないでください。配布元から案内された URL を使います。

## 更新確認と停止

- `agentdesklink.checkForUpdates`: オンの場合、起動後と定期的に更新を確認します。オフにすると自動・手動の確認を停止します。
- `agentdesklink.autoUpdate`: オフの場合、新しい版の通知だけを行い、インストールしません。
- 自動更新では、ダウンロードした VSIX の SHA-256 を確認してからインストールします。
- 反映にはウィンドウの再読み込みが必要です。作業中のウィンドウを自動で再読み込みすることはありません。
- 現在と同じ版や古い版には自動更新しません。

認証が必要な配布先からの自動取得には対応していません。自動更新が利用できない場合は、リリースページから対応する VSIX を取得して手動インストールしてください。

## マニフェストの形式

更新情報は次の形式の JSON です。URL は例です。実際に案内された HTTPS の配布先に置き換えます。例の SHA-256 は書式を示すダミー値で、利用時は対応する VSIX の実際のハッシュが必要です。

```json
{
  "version": "0.1.1",
  "url": "https://downloads.example.com/AgentDeskLink/v0.1.1/agentdesklink-darwin-arm64-0.1.1.vsix",
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

`version` は SemVer、`url` は認証情報・フラグメントを含まない HTTPS URL、`sha256` は16進64文字です。自分の環境に対応した VSIX を指定してください。

ベータ用には配布元が案内する更新マニフェスト URL を使います。版番号を含む URL は自動的に次の版へ切り替わりません。

## ダウンロードした VSIX の確認

リリースに添付された `SHA256SUMS` と、ダウンロードしたファイルの SHA-256 を比較してください。次はファイルを保存したフォルダーで実行する例です。

macOS:

```sh
shasum -a 256 agentdesklink-darwin-arm64-0.1.1.vsix
```

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\agentdesklink-win32-x64-0.1.1.vsix | Format-List Hash
```

一覧と一致しない場合は、そのファイルをインストールせず、配布元から取得し直してください。
