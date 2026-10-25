import { gt, valid } from 'semver';

const OWNER = 'Takayuki-Ishimaru';
const REPO = 'AgentDeskLink';
export const GITHUB_RELEASES_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`;

export interface GitHubUpdate { version: string; url: string; sha256: string }

function canonicalUrl(tag: string, name: string): string {
  return `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${name}`;
}

function tagVersion(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  return valid(version) ?? undefined;
}

/** Newest published release with an exact VSIX for platform-arch; throws on a non-array API response. */
export function findGitHubUpdate(data: unknown, platform: string, arch: string): GitHubUpdate | undefined {
  if (!Array.isArray(data)) throw new Error('GitHub リリース情報の形式が不正です。');
  let best: GitHubUpdate | undefined;
  for (const item of data as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const release = item as Record<string, unknown>;
    if (release.draft !== false) continue;
    const version = tagVersion(release.tag_name);
    if (!version || !Array.isArray(release.assets)) continue;
    const name = `agentdesklink-${platform}-${arch}-${version}.vsix`;
    for (const asset of release.assets as unknown[]) {
      if (typeof asset !== 'object' || asset === null || Array.isArray(asset)) continue;
      const a = asset as Record<string, unknown>;
      if (a.name !== name || a.state !== 'uploaded' || typeof a.digest !== 'string') continue;
      const match = /^sha256:([0-9a-f]{64})$/i.exec(a.digest);
      if (!match) continue;
      const url = canonicalUrl(String(release.tag_name), name);
      if (a.browser_download_url !== url) continue;
      if (!best || gt(version, best.version)) best = { version, url, sha256: match[1]!.toLowerCase() };
      break;
    }
  }
  return best;
}

/** Only the fixed API endpoint, this repository's canonical release downloads and GitHub's signed asset CDN. */
export function isGitHubUpdateUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return false;
  if (url.host === 'api.github.com') return url.pathname === `/repos/${OWNER}/${REPO}/releases` && url.search === '?per_page=100';
  if (url.host === 'github.com') return !url.search && new RegExp(`^/${OWNER}/${REPO}/releases/download/[^/]+/[^/]+$`).test(url.pathname);
  return url.host === 'release-assets.githubusercontent.com';
}
