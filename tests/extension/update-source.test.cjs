const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = import('../../dist/src/extension/update-source.js');
const repository = 'https://github.com/Takayuki-Ishimaru/AgentDeskLink';
const api = 'https://api.github.com/repos/Takayuki-Ishimaru/AgentDeskLink/releases?per_page=100';
const digest = 'a'.repeat(64);
function release(version, target = 'darwin-arm64', extra = {}) {
  const name = `agentdesklink-${target}-${version}.vsix`;
  return { tag_name: `v${version}`, draft: false, prerelease: true, assets: [{
    name, state: 'uploaded', digest: `sha256:${digest}`,
    browser_download_url: `${repository}/releases/download/v${version}/${name}`,
  }], ...extra };
}

test('fixed GitHub source selects published beta releases by SemVer and exact target', async () => {
  const { GITHUB_RELEASES_URL, findGitHubUpdate } = await source;
  assert.equal(GITHUB_RELEASES_URL, api);
  const result = findGitHubUpdate([
    release('0.9.0'), release('0.10.0'), release('0.11.0', 'win32-x64'),
    release('9.0.0', 'darwin-arm64', { draft: true }),
    release('8.0.0', 'darwin-arm64', { tag_name: 'not-a-version' }),
  ], 'darwin', 'arm64');
  assert.deepEqual(result, { version: '0.10.0', url: `${repository}/releases/download/v0.10.0/agentdesklink-darwin-arm64-0.10.0.vsix`, sha256: digest });
  assert.equal(findGitHubUpdate([release('0.10.0')], 'linux', 'x64'), undefined);
  assert.equal(findGitHubUpdate([], 'darwin', 'arm64'), undefined);
});

test('GitHub source handles stable and SemVer prerelease tags without relying on API ordering', async () => {
  const { findGitHubUpdate } = await source;
  assert.equal(findGitHubUpdate([release('1.0.0-beta.2'), release('1.0.0-beta.10')], 'darwin', 'arm64').version, '1.0.0-beta.10');
  assert.equal(findGitHubUpdate([release('1.0.0', 'darwin-arm64', { prerelease: false }), release('1.0.0-beta.10')], 'darwin', 'arm64').version, '1.0.0');
});

test('release assets need a matching name, SHA-256 and canonical URL in the fixed repository', async () => {
  const { findGitHubUpdate } = await source;
  const good = release('0.10.0');
  const asset = good.assets[0];
  for (const changed of [
    { name: 'agentdesklink-win32-x64-0.10.0.vsix' }, { digest: null },
    { digest: 'sha256:bad' }, { state: 'new' },
    { browser_download_url: asset.browser_download_url.replace('Takayuki-Ishimaru', 'another-owner') },
    { browser_download_url: asset.browser_download_url.replace('v0.10.0/', 'v0.9.0/') },
    { browser_download_url: asset.browser_download_url + '?download=1' },
    { browser_download_url: 'https://downloads.example/update.vsix' },
  ]) {
    assert.equal(findGitHubUpdate([{ ...good, assets: [{ ...asset, ...changed }] }], 'darwin', 'arm64'), undefined, JSON.stringify(changed));
  }
  assert.equal(findGitHubUpdate([{ ...good, assets: [{ ...asset, digest: `sha256:${digest.toUpperCase()}` }] }], 'darwin', 'arm64').sha256, digest);
  for (const malformed of [null, {}, { message: 'rate limited' }]) assert.throws(() => findGitHubUpdate(malformed, 'darwin', 'arm64'));
  assert.equal(findGitHubUpdate([null, {}, { tag_name: 'v1.0.0', assets: null }], 'darwin', 'arm64'), undefined);
});

test('update requests reject non-GitHub redirects before contacting them and allow GitHub asset CDN', async () => {
  const { isGitHubUpdateUrl } = await source;
  const { fetchUpdateBytes } = await import('../../dist/src/extension/update-download.js');
  const asset = release('0.10.0').assets[0].browser_download_url;
  for (const url of [api, asset, 'https://release-assets.githubusercontent.com/github-production-release-asset/123/a?token=example']) assert.equal(isGitHubUpdateUrl(url), true, url);
  for (const url of [
    'https://example.com/update', 'https://github.com.evil.example/a',
    asset.replace('Takayuki-Ishimaru', 'another-owner'),
    'http://release-assets.githubusercontent.com/a', 'https://user:pass@github.com/a',
  ]) assert.equal(isGitHubUpdateUrl(url), false, url);
  const options = { maxBytes: 100, timeoutMs: 500, signal: new AbortController().signal, isAllowedUrl: isGitHubUpdateUrl };
  let requests = [];
  await assert.rejects(fetchUpdateBytes('https://example.com/update.vsix', { ...options, fetch: async url => {
    requests.push(String(url)); return new Response('unexpected');
  } }));
  assert.deepEqual(requests, [], 'the initial URL is checked before fetching');
  await assert.rejects(fetchUpdateBytes(asset, { ...options, fetch: async url => {
    requests.push(String(url)); return new Response(null, { status: 302, headers: { location: 'https://example.com/update.vsix' } });
  } }));
  assert.deepEqual(requests, [asset]);
  requests = [];
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/a?token=example';
  const bytes = await fetchUpdateBytes(asset, { ...options, fetch: async url => {
    requests.push(String(url)); return String(url) === asset ? new Response(null, { status: 302, headers: { location: cdn } }) : new Response('vsix');
  } });
  assert.equal(bytes.toString(), 'vsix');
  assert.deepEqual(requests, [asset, cdn]);
});
