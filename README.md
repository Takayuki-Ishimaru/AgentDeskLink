<p align="center">
  <img src="media/readme-hero-v2.png" alt="AgentDeskLink — Browser + Desktop, over MCP" width="1200">
</p>

**日本語** | [English](README_en.md)

# AI に、ブラウザとデスクトップの操作を。

**ブラウザも、デスクトップも。使い慣れた AI エージェントから。**

AgentDeskLink は、AI エージェントとローカルのブラウザ・デスクトップをつなぐ MCP サーバーです。画面の要素を読み取り、許可されたクリックや文字入力を実行。必要な場面では画像も確認しながら操作できます。

[はじめる](release-docs/INSTALL.md) · [できること](#できること) · [対応環境](#対応環境) · [リリースガイド](release-docs/README.md) · [MIT License](LICENSE)

> **0.1.4 / ベータ版**  
> 利用範囲を限定して提供しています。導入前に[対応環境と既知の制限](release-docs/KNOWN_ISSUES.md)を確認してください。

## できること

| 機能 | 使いどころ |
| --- | --- |
| **画面を要素と差分で読む** | ボタンや入力欄の役割・値を取得し、操作後に変わった部分を読み返す |
| **必要なところを画像で見る** | ブラウザや対象ウィンドウを撮影し、Canvas や図表を含む描画を確認する |
| **ブラウザもアプリも操作する** | 許可した文字入力・クリック・選択・スクロールを、同じ MCP 接続から実行する |
| **複数ウィンドウを個別に扱う** | 同じアプリのウィンドウを区別し、観測した対象へ操作を行う |

ブラウザのドラッグやタッチスワイプ、時刻付きの連続フレーム取得にも対応します。デスクトップの物理入力は `interactive_desktop` モードで利用します。

## VS Code ではじめる

1. 共通パッケージ `agentdesklink-0.1.4.vsix` を取得し、「拡張機能: VSIXからのインストール」で導入します。
2. フォルダーを開き、ワークスペースを信頼します。
3. アクティビティバーの **AgentDeskLink** を開きます。
4. **設定を開く**から、許可するブラウザの origin または対象アプリと必要な操作権限を指定します。
5. **このワークスペースで MCP を有効にする**をオンにし、MCP 管理画面でサーバーを起動します。

**Node.js の別途インストールや helper のビルドは不要です。** 同じ VSIX に各 OS 用のランタイムを同梱し、起動時に自動で選びます。Chrome は専用プロファイルで利用し、見つからない場合は初回に専用 Chromium を自動取得します。

AgentDeskLink 自体に外部 AI の API キーは不要です。AI の接続・認証は利用する MCP ホスト側で行います。

[インストール手順を見る →](release-docs/INSTALL.md)

### 他のAIクライアントにも一括接続

設定パネルの **AIクライアント → すべて有効** で、インストール済みの Claude Code、Claude Desktop、Codex、Cursor、Windsurf、Devin、Gemini CLI、Cline、Roo Code を自動検出して MCP を登録します。VS Code の MCP も同時に有効になります。**すべて無効** で登録を解除し、接続中の外部クライアントも停止します。

一括有効にしたワークスペースの操作権限を共有します。他のMCP設定は保持し、同名の手動登録があれば個別に表示します。各クライアントで再接続・新しい会話・再起動が必要な場合があります。

## 対応環境

| 環境 | 利用できる範囲 |
| --- | --- |
| **macOS 14 以上 / Apple silicon** | ブラウザ・デスクトップ。OS のアクセシビリティ権限、画像取得には画面収録権限が必要 |
| **Windows 11 x64** | ブラウザ・デスクトップ。デスクトップ操作は対象アプリと同じ対話セッションで実行 |
| **Linux x64（Ubuntu 24.04）** | ブラウザ。Chrome または Chromium の実行に必要な共有ライブラリと OS sandbox が必要 |

macOS と Windows では、CLI のポリシーで明示的に許可したアプリの状態確認・起動・通常終了も利用できます。Windows で起動するアプリは専用の Win32 デスクトップに配置します。

OS・アプリ・表示構成によって利用できる操作は異なります。詳しくは[対応環境と既知の制限](release-docs/KNOWN_ISSUES.md)を参照してください。

## 操作する範囲を、自分で決める

- **初期状態はオフ。** MCP の接続許可と操作権限は別です。許可するブラウザの origin と対象アプリをワークスペース設定で指定します。物理入力と無加工のネイティブ画像は、それぞれ既定で無効です。
- **設定ファイルの指定は不要。** VS Code 拡張は同梱設定で動作します。CLI を直接起動する場合は、ポリシー JSON で対象と操作を設定します。
- **普段のブラウザと分けて使う。** 人間のプロファイルやログイン状態を共有しません。
- **物理入力は専用モード。** `interactive_desktop` は実際のマウス・キーボードを使うため、人間の操作と並行して利用しないでください。

重要操作を個別に承認する専用 UI はありません。AI に任せる対象と操作を確認してください。画像やテキスト内の未知の秘密情報を完全に検出する保証はありません。設定パネルやコマンドパレットの「緊急停止」で拡張が管理する操作を停止し、「操作を再開」で再開できます。すでにアプリへ渡った処理は取り消せません。

ブラウザの `data-adl-sensitive`、`data-adl-classification="SECRET"` / `"UNKNOWN"` は子孫にも適用されます。子の `PUBLIC` 指定では解除できません。観測では保護対象の内容をマスクし、通常のcontrol許可リストによる領域内の操作を拒否します。画像と保持フレームのcropにもマスクを適用します。これらの明示マーカーは自動検出を補うものです。

selectの候補一覧が観測予算を超える場合は、項目名・現在値・選択状態を残し、`options_truncated: true` で候補の省略を示します。`scope: "id:<element_id>"` と大きな `token_budget` で候補を再取得するか、`include` から `options` を外してください。候補の取得上限100件や候補内の文字数上限に達した場合も同じフラグを返します。最後のcursorページが `truncated: false` でも、この要素単位のフラグを確認してください。

## ソースから試す

このリポジトリを clone し、そのフォルダーで以下を実行します。Node.js 24 以上が必要です。VSIX や文書 ZIP にはデモのソースを同梱していません。

```sh
npm ci
npx playwright install chromium
npm run build
```

別のターミナルでローカルデモを起動します。

```sh
node examples/demo-server.mjs
```

MCP ホストから、デモ用ポリシーを指定してサーバーを起動します。パスは実際の絶対パスへ置き換えてください。ホストによって設定ファイルの形式は異なります。

```json
{
  "mcpServers": {
    "agentdesklink": {
      "command": "node",
      "args": [
        "/absolute/path/AgentDeskLink/dist/src/server.js",
        "--config",
        "/absolute/path/AgentDeskLink/config/demo.json"
      ]
    }
  }
}
```

サーバーは stdio 接続です。デスクトップをソースから利用する場合は OS 用 helper のビルドと設定も必要です。

### 設定例

| 試したいこと | 設定ファイル |
| --- | --- |
| ローカルのブラウザデモ | [demo.json](config/demo.json) |
| ブラウザの画像取得 | [visual.example.json](config/visual.example.json) |
| macOS 計算機の操作 | [macos-calculator.example.json](config/macos-calculator.example.json) |
| Windows 文字コード表の操作 | [windows-character-map.example.json](config/windows-character-map.example.json) |

## ガイド

- [インストールとはじめ方](release-docs/INSTALL.md)
- [このバージョンの変更点](release-docs/RELEASE_NOTES_ja.md)
- [対応環境と既知の制限](release-docs/KNOWN_ISSUES.md)
- [更新の設定](release-docs/UPDATES.md)

## ライセンス

[MIT License](LICENSE)。同梱する第三者ソフトウェアには、それぞれのライセンスが適用されます。
