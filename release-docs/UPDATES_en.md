# Update Settings and File Verification

[日本語](UPDATES.md) | **English**

Target version: `0.1.3`

## Upgrading from 0.1.1 or earlier

If you use 0.1.1 or earlier, download the `0.1.3` VSIX for your operating system and CPU together with `SHA256SUMS` from the official release page, verify the hash, and install the VSIX manually. Reload the VS Code window after installation. Version 0.1.2 and later do not require an update URL. The former `agentdesklink.updateManifestUrl` setting is no longer used.

## Updating from 0.1.2

With update checks and automatic updates enabled, the extension downloads a matching newer VSIX from the official GitHub releases. If you use notifications only or have disabled update checks, download the VSIX manually from the release page.

Version 0.1.3 separates MCP enablement from operation permissions. After updating, follow the [installation guide](INSTALL_en.md) to configure allowed origins/apps and operation permissions.

## Update source (no configuration needed)

The update source is fixed to the official GitHub repository [Takayuki-Ishimaru/AgentDeskLink](https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases). You do not set any URL. The extension reads the GitHub Releases API (`https://api.github.com/repos/Takayuki-Ishimaru/AgentDeskLink/releases?per_page=100`) and looks for updates among the 100 most recent releases.

- Only published releases whose SemVer tag is newer than the installed version are considered, including GitHub prereleases (beta versions). Drafts and tags that cannot be read as a version are ignored.
- The asset matching your operating system and CPU, `agentdesklink-<os>-<cpu>-<version>.vsix`, is selected automatically. Releases without a matching asset are ignored, and a package built for another platform is never installed.
- The SHA-256 of the downloaded VSIX is always compared with the digest GitHub reports for the asset. Nothing is installed when the values differ.

| Operating system and CPU | Example asset name |
| --- | --- |
| macOS, Apple silicon | `agentdesklink-darwin-arm64-0.1.3.vsix` |
| Windows x64 | `agentdesklink-win32-x64-0.1.3.vsix` |

## Update checks and stopping them

- `agentdesklink.checkForUpdates`: when on, updates are checked 5 seconds after start and then every 6 hours. Turning it off stops both automatic and manual checks.
- `agentdesklink.autoUpdate`: when off, a newer version is only announced and never installed.
- Automatic updates verify the SHA-256 of the downloaded VSIX before installing it.
- Reloading the window is required for changes to take effect. A window in use is never reloaded automatically.
- Versions equal to or older than the installed one are never applied automatically. When no release matches your operating system and CPU, the extension reports that and neither downloads nor installs anything.

Automatic download from a distribution point that requires authentication is not supported. When automatic updates are unavailable, download the matching VSIX from the release page and install it manually.

## Release format

Each release carries one VSIX per target, named as follows. The extension identifies the asset by this name, the `sha256:` digest GitHub returns for it, and the canonical URL `https://github.com/Takayuki-Ishimaru/AgentDeskLink/releases/download/<tag>/<asset name>`. No custom manifest file (such as `update.json`) is read.

```text
agentdesklink-darwin-arm64-0.1.3.vsix
agentdesklink-win32-x64-0.1.3.vsix
```

## Verifying a downloaded VSIX

Compare the `SHA256SUMS` attached to the release with the SHA-256 of the file you downloaded. The following is an example to run in the folder where you saved the file.

macOS:

```sh
shasum -a 256 agentdesklink-darwin-arm64-0.1.3.vsix
```

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\agentdesklink-win32-x64-0.1.3.vsix | Format-List Hash
```

If the values do not match, do not install the file and obtain it again from the release page of the official repository.
