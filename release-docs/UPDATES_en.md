# Update Settings and File Verification

[日本語](UPDATES.md) | **English**

Target version: `0.1.6`

## Updating from 0.1.2 or earlier

A common VSIX has been used since version 0.1.3. This version uses `agentdesklink-0.1.6.vsix`. The updater in 0.1.2 and earlier does not recognize this filename. Download the common VSIX and `SHA256SUMS` from the official release page, verify the hash and install the VSIX manually. Reload the VS Code window after installation.

After updating, follow the [installation guide](INSTALL_en.md) to configure allowed origins/apps and operation permissions. Enabling MCP alone grants no additional permissions.

## Update source (no configuration needed)

Updates use the official GitHub repository [Takayuki-Ishimaru/AgentDeskLink](https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases). No URL setting is required. The extension reads the GitHub Releases API (`https://api.github.com/repos/Takayuki-Ishimaru/AgentDeskLink/releases?per_page=100`) and checks the most recent 100 releases.

- Only published releases with a newer SemVer tag are considered, including GitHub prereleases (betas). Drafts and tags that are not valid version numbers are ignored.
- The v0.1.6 updater prefers a matching `agentdesklink-<OS>-<CPU>-<version>.vsix` when available in the same release. Otherwise, macOS / Apple silicon, Windows x64 and Linux x64 use the common `agentdesklink-<version>.vsix`. The matching runtime is selected at startup.
- Hosts unsupported by the common VSIX do not install it. The updaters in 0.1.3 through 0.1.5 can also retrieve this release’s common VSIX.
- The downloaded VSIX must match the SHA-256 digest attached to the GitHub asset. A mismatch prevents installation.

The former `agentdesklink.updateManifestUrl` setting is no longer used.

## Checking and stopping updates

- `agentdesklink.checkForUpdates`: when on, checks 5 seconds after startup and every 6 hours. Turning it off stops both automatic and manual checks.
- `agentdesklink.autoUpdate`: when off, only notifies you of newer versions without installing them.
- Automatic updates verify the downloaded VSIX SHA-256 before installation.
- Reloading the window is required to apply an update. Your working window is never reloaded automatically.
- The current or an older version is never installed automatically. If no compatible asset is available, the extension reports this and neither downloads nor installs a file.

Authenticated distribution sources are unsupported. If automatic updates are unavailable, download the common VSIX from the release page and install it manually.

## Release format

This release attaches one VSIX:

```text
agentdesklink-0.1.6.vsix
```

The updater identifies it by this name, GitHub's `sha256:` digest and its canonical `https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases/download/<tag>/<filename>` URL. It does not read a custom update-information file such as `update.json`.

## Verify a downloaded VSIX

Compare the SHA-256 of your downloaded file with the release's `SHA256SUMS`. Run the following in the download folder.

macOS:

```sh
shasum -a 256 agentdesklink-0.1.6.vsix
```

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\agentdesklink-0.1.6.vsix | Format-List Hash
```

Linux:

```sh
sha256sum agentdesklink-0.1.6.vsix
```

If the hashes differ, do not install the file. Download it again from the official repository's release page.
