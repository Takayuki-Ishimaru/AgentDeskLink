# Update Settings and File Verification

[日本語](UPDATES.md) | **English**

Target version: `0.1.1`

## Configuring the update source

Set `agentdesklink.updateManifestUrl` in the user settings to the HTTPS URL of the update manifest for your operating system and CPU. The default is empty, and while it is empty no update traffic takes place.

| Operating system and CPU | Example manifest name |
| --- | --- |
| macOS, Apple silicon | `update-darwin-arm64.json` |
| Windows x64 | `update-win32-x64.json` |

Do not use an update source intended for a different operating system or CPU. Use the URL published by your distributor.

## Update checks and stopping them

- `agentdesklink.checkForUpdates`: when on, updates are checked after start and periodically. Turning it off stops both automatic and manual checks.
- `agentdesklink.autoUpdate`: when off, a newer version is only announced and never installed.
- Automatic updates verify the SHA-256 of the downloaded VSIX before installing it.
- Reloading the window is required for changes to take effect. A window in use is never reloaded automatically.
- Versions equal to or older than the installed one are never applied automatically.

Automatic download from a distribution point that requires authentication is not supported. When automatic updates are unavailable, download the matching VSIX from the release page and install it manually.

## Manifest format

Update information is JSON in the following format. The URL is an example; use the HTTPS distribution URL published by your distributor. The SHA-256 in the example is a dummy value that shows the format; a real release needs the actual hash of the matching VSIX.

```json
{
  "version": "0.1.1",
  "url": "https://downloads.example.com/AgentDeskLink/v0.1.1/agentdesklink-darwin-arm64-0.1.1.vsix",
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

`version` is SemVer, `url` is an HTTPS URL without credentials or a fragment, and `sha256` is 64 hexadecimal characters. Point it at the VSIX that matches your environment.

For beta updates, use the manifest URL published by your distributor. A URL containing a version does not move to the next version automatically.

## Verifying a downloaded VSIX

Compare the `SHA256SUMS` attached to the release with the SHA-256 of the file you downloaded. The following is an example to run in the folder where you saved the file.

macOS:

```sh
shasum -a 256 agentdesklink-darwin-arm64-0.1.1.vsix
```

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\agentdesklink-win32-x64-0.1.1.vsix | Format-List Hash
```

If the values do not match, do not install the file and obtain it again from your distributor.
