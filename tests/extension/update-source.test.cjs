const { test } = require('node:test');
const assert = require('node:assert/strict');
const source = import('../../dist/src/extension/update-source.js');
const repository = 'https://github.com/Takayuki-Ishimaru/AgentDeskLink';
const api = 'https://api.github.com/repos/Takayuki-Ishimaru/AgentDeskLink/releases?per_page=100';
const digest = 'a'.repeat(64);
function release(version, target = 'darwin-arm64', extra = {}) {
  const name = `agentdesklink-${target}-${version}.vsix`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: true,
    assets: [
      {
        name,
        state: 'uploaded',
        digest: `sha256:${digest}`,
        browser_download_url: `${repository}/releases/download/v${version}/${name}`,
      },
    ],
    ...extra,
  };
}

test('fixed GitHub source selects published beta releases by SemVer and exact target', async () => {
  const { GITHUB_RELEASES_URL, findGitHubUpdate } = await source;
  assert.equal(GITHUB_RELEASES_URL, api);
  const result = findGitHubUpdate(
    [
      release('0.9.0'),
      release('0.10.0'),
      release('0.11.0', 'win32-x64'),
      release('9.0.0', 'darwin-arm64', { draft: true }),
      release('8.0.0', 'darwin-arm64', { tag_name: 'not-a-version' }),
    ],
    'darwin',
    'arm64',
  );
  assert.deepEqual(result, {
    version: '0.10.0',
    url: `${repository}/releases/download/v0.10.0/agentdesklink-darwin-arm64-0.10.0.vsix`,
    sha256: digest,
  });
  assert.equal(findGitHubUpdate([release('0.10.0')], 'linux', 'x64'), undefined);
  assert.equal(findGitHubUpdate([], 'darwin', 'arm64'), undefined);
});

test('GitHub source handles stable and SemVer prerelease tags without relying on API ordering', async () => {
  const { findGitHubUpdate } = await source;
  assert.equal(
    findGitHubUpdate([release('1.0.0-beta.2'), release('1.0.0-beta.10')], 'darwin', 'arm64').version,
    '1.0.0-beta.10',
  );
  assert.equal(
    findGitHubUpdate(
      [release('1.0.0', 'darwin-arm64', { prerelease: false }), release('1.0.0-beta.10')],
      'darwin',
      'arm64',
    ).version,
    '1.0.0',
  );
});

test('release assets need a matching name, SHA-256 and canonical URL in the fixed repository', async () => {
  const { findGitHubUpdate } = await source;
  const good = release('0.10.0');
  const asset = good.assets[0];
  for (const changed of [
    { name: 'agentdesklink-win32-x64-0.10.0.vsix' },
    { digest: null },
    { digest: 'sha256:bad' },
    { state: 'new' },
    { browser_download_url: asset.browser_download_url.replace('Takayuki-Ishimaru', 'another-owner') },
    { browser_download_url: asset.browser_download_url.replace('v0.10.0/', 'v0.9.0/') },
    { browser_download_url: asset.browser_download_url + '?download=1' },
    { browser_download_url: 'https://downloads.example/update.vsix' },
  ]) {
    assert.equal(
      findGitHubUpdate([{ ...good, assets: [{ ...asset, ...changed }] }], 'darwin', 'arm64'),
      undefined,
      JSON.stringify(changed),
    );
  }
  assert.equal(
    findGitHubUpdate([{ ...good, assets: [{ ...asset, digest: `sha256:${digest.toUpperCase()}` }] }], 'darwin', 'arm64')
      .sha256,
    digest,
  );
  for (const malformed of [null, {}, { message: 'rate limited' }])
    assert.throws(() => findGitHubUpdate(malformed, 'darwin', 'arm64'));
  assert.equal(findGitHubUpdate([null, {}, { tag_name: 'v1.0.0', assets: null }], 'darwin', 'arm64'), undefined);
});

test('update requests reject non-GitHub redirects before contacting them and allow GitHub asset CDN', async () => {
  const { isGitHubUpdateUrl } = await source;
  const { fetchUpdateBytes } = await import('../../dist/src/extension/update-download.js');
  const asset = release('0.10.0').assets[0].browser_download_url;
  for (const url of [
    api,
    asset,
    'https://release-assets.githubusercontent.com/github-production-release-asset/123/a?token=example',
  ])
    assert.equal(isGitHubUpdateUrl(url), true, url);
  for (const url of [
    'https://example.com/update',
    'https://github.com.evil.example/a',
    asset.replace('Takayuki-Ishimaru', 'another-owner'),
    'http://release-assets.githubusercontent.com/a',
    'https://user:pass@github.com/a',
  ])
    assert.equal(isGitHubUpdateUrl(url), false, url);
  const options = {
    maxBytes: 100,
    timeoutMs: 500,
    signal: new AbortController().signal,
    isAllowedUrl: isGitHubUpdateUrl,
  };
  let requests = [];
  await assert.rejects(
    fetchUpdateBytes('https://example.com/update.vsix', {
      ...options,
      fetch: async url => {
        requests.push(String(url));
        return new Response('unexpected');
      },
    }),
  );
  assert.deepEqual(requests, [], 'the initial URL is checked before fetching');
  await assert.rejects(
    fetchUpdateBytes(asset, {
      ...options,
      fetch: async url => {
        requests.push(String(url));
        return new Response(null, { status: 302, headers: { location: 'https://example.com/update.vsix' } });
      },
    }),
  );
  assert.deepEqual(requests, [asset]);
  requests = [];
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/a?token=example';
  const bytes = await fetchUpdateBytes(asset, {
    ...options,
    fetch: async url => {
      requests.push(String(url));
      return String(url) === asset
        ? new Response(null, { status: 302, headers: { location: cdn } })
        : new Response('vsix');
    },
  });
  assert.equal(bytes.toString(), 'vsix');
  assert.deepEqual(requests, [asset, cdn]);
});

const crypto = require('node:crypto');
const marker = percent => `Beta notes\n<!-- adl-rollout: ${percent} -->\nMore notes\n`;
const withBody = (version, body) => release(version, 'darwin-arm64', { body });
// rolloutId undefined is a manual check.
const pick = async (releases, rolloutId) => {
  const { findGitHubUpdate } = await source;
  return findGitHubUpdate(releases, 'darwin', 'arm64', rolloutId === undefined ? undefined : { rolloutId })?.version;
};
const bucketOf = (id, version) =>
  crypto.createHash('sha256').update(`${id}\n${version}`).digest().readUInt32BE(0) % 100;
const idWhere = (version, accept) => {
  for (let i = 0; ; i++) if (accept(bucketOf(`machine-${i}`, version))) return `machine-${i}`;
};

test('rolloutBucket is a deterministic 0..99 value of SHA-256(id, newline, version)', async () => {
  const { rolloutBucket } = await source;
  assert.equal(rolloutBucket('machine-1', '0.2.0'), 42);
  assert.equal(rolloutBucket('machine-1', '0.2.1'), 94);
  assert.equal(rolloutBucket('', '1.0.0'), 30);
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const id = `id-${i}`,
      version = `1.${i % 7}.0`;
    const bucket = rolloutBucket(id, version);
    assert.equal(bucket, rolloutBucket(id, version));
    assert.equal(bucket, bucketOf(id, version));
    assert.ok(Number.isInteger(bucket) && bucket >= 0 && bucket <= 99, `${id} ${bucket}`);
    seen.add(bucket);
  }
  assert.ok(seen.size > 50, 'buckets spread over the range');
  const perVersion = new Set(
    ['0.1.5', '0.1.6', '0.2.0', '1.0.0', '1.0.1'].map(version => rolloutBucket('machine-1', version)),
  );
  assert.ok(perVersion.size > 1, 'the same installation lands in different buckets for different versions');
});

test('staged rollout: no marker, 100 and a non-string body are eligible for automatic checks; 0 holds only automatic checks', async () => {
  const { findGitHubUpdate } = await source;
  for (const body of [undefined, null, 5, {}, '', 'Release notes without a marker', marker(100)]) {
    for (let i = 0; i < 40; i++)
      assert.equal(await pick([withBody('0.10.0', body)], `machine-${i}`), '0.10.0', JSON.stringify(body));
    assert.equal(await pick([withBody('0.10.0', body)]), '0.10.0');
  }
  for (let i = 0; i < 40; i++) assert.equal(await pick([withBody('0.10.0', marker(0))], `machine-${i}`), undefined);
  assert.equal(await pick([withBody('0.10.0', marker(0))]), '0.10.0', 'a manual check ignores the marker');
  assert.equal(
    findGitHubUpdate([withBody('0.10.0', marker(0))], 'darwin', 'arm64', {})?.version,
    '0.10.0',
    'no rolloutId is a manual check',
  );
});

test('staged rollout: a share of N admits exactly the installations whose bucket is below N', async () => {
  const { rolloutBucket } = await source;
  const below = idWhere('0.10.0', bucket => bucket < 50),
    above = idWhere('0.10.0', bucket => bucket >= 50);
  assert.ok(rolloutBucket(below, '0.10.0') < 50 && rolloutBucket(above, '0.10.0') >= 50);
  assert.equal(await pick([withBody('0.10.0', marker(50))], below), '0.10.0');
  assert.equal(await pick([withBody('0.10.0', marker(50))], above), undefined);
  assert.equal(await pick([withBody('0.10.0', marker(50))]), '0.10.0');
  let admitted = 0;
  for (let i = 0; i < 200; i++) {
    const id = `machine-${i}`,
      eligible = rolloutBucket(id, '0.10.0') < 50;
    admitted += eligible ? 1 : 0;
    assert.equal((await pick([withBody('0.10.0', marker(50))], id)) !== undefined, eligible, id);
  }
  assert.ok(admitted > 50 && admitted < 150, `roughly half admitted, got ${admitted}/200`);
  // The threshold is exclusive: bucket b is held at N=b and admitted at N=b+1.
  for (const id of ['machine-1', 'machine-2', 'machine-3']) {
    const bucket = rolloutBucket(id, '0.10.0');
    assert.equal(await pick([withBody('0.10.0', marker(bucket))], id), undefined, `${id} at ${bucket}`);
    assert.equal(await pick([withBody('0.10.0', marker(bucket + 1))], id), '0.10.0', `${id} at ${bucket + 1}`);
  }
  // The bucket belongs to the release version, not to the installation alone.
  const differs = [...Array(400).keys()]
    .map(i => `machine-${i}`)
    .find(id => rolloutBucket(id, '0.10.0') < 50 && rolloutBucket(id, '0.11.0') >= 50);
  assert.ok(differs);
  assert.equal(await pick([withBody('0.11.0', marker(50)), withBody('0.10.0', marker(50))], differs), '0.10.0');
});

test('staged rollout: marker lines are whitespace tolerant and matched per line', async () => {
  for (const body of [
    '<!--adl-rollout:0-->',
    '  <!--   adl-rollout :   0   -->  ',
    '\t<!-- adl-rollout:\t0 -->',
    'Notes\r\n<!-- adl-rollout: 0 -->\r\nMore\r\n',
    'First\n\nSecond\n<!-- adl-rollout: 0 -->',
    '<!-- adl-rollout: 0 -->\nSecond line',
    'a\n<!-- adl-rollout: 0 -->\n<!-- adl-rollout: 0 -->\nb',
  ]) {
    assert.equal(await pick([withBody('0.10.0', body)], 'machine-1'), undefined, JSON.stringify(body));
    assert.equal(await pick([withBody('0.10.0', body)]), '0.10.0', JSON.stringify(body));
  }
  for (const body of [
    '<!-- adl-rollout: 100 -->',
    '<!--adl-rollout:100-->\r\n',
    '<!-- adl-rollout: 100 -->\n<!-- adl-rollout: 100 -->',
  ]) {
    assert.equal(await pick([withBody('0.10.0', body)], 'machine-1'), '0.10.0', JSON.stringify(body));
  }
  // Other comments and text that merely mention the marker are not markers.
  for (const body of ['<!-- note: 0 -->', 'adl-rollout: 0', 'See `<!-- adl-rollout: 0 -->` in the docs']) {
    assert.equal(await pick([withBody('0.10.0', body)], 'machine-1'), '0.10.0', JSON.stringify(body));
  }
});

test('staged rollout: invalid or conflicting markers hold the release for automatic checks and are ignored by manual ones', async () => {
  for (const body of [
    marker(101),
    marker(-1),
    marker(1.5),
    marker('abc'),
    marker(''),
    marker('1e1'),
    marker('+10'),
    marker('10%'),
    marker('99999999999999999999'),
    '<!-- adl-rollout -->',
    '<!-- adl-rollout 10 -->',
    '<!-- adl-rollout: -->',
    '<!-- adl-rollout: 10 20 -->',
    '<!-- adl-rollout: 10 -->\n<!-- adl-rollout: 20 -->',
    '<!-- adl-rollout: 100 -->\n<!-- adl-rollout: 0 -->',
    '<!-- adl-rollout: 0 -->\n<!-- adl-rollout: 100 -->',
    '<!-- adl-rollout: 50 -->\n<!-- adl-rollout: abc -->',
  ]) {
    for (let i = 0; i < 40; i++)
      assert.equal(await pick([withBody('0.10.0', body)], `machine-${i}`), undefined, `${i} ${JSON.stringify(body)}`);
    assert.equal(await pick([withBody('0.10.0', body)]), '0.10.0', JSON.stringify(body));
  }
});

test('staged rollout: a held newest release does not hide an older eligible release', async () => {
  const { rolloutBucket } = await source;
  const releases = [withBody('0.11.0', marker(0)), withBody('0.10.0', marker(100)), withBody('0.9.0')];
  assert.equal(await pick(releases, 'machine-1'), '0.10.0');
  assert.equal(await pick([...releases].reverse(), 'machine-1'), '0.10.0', 'API order does not matter');
  assert.equal(await pick(releases), '0.11.0', 'a manual check takes the newest release');
  assert.equal(
    await pick([withBody('0.11.0', marker('abc')), withBody('0.10.0', marker(0)), withBody('0.9.0')], 'machine-1'),
    '0.9.0',
  );
  assert.equal(
    await pick([withBody('0.11.0', marker(0)), withBody('0.10.0', marker(0))], 'machine-1'),
    undefined,
    'every release held',
  );
  // Newest staged at 50: an installation above the share falls back, one below it takes the newest.
  const below = idWhere('0.11.0', bucket => bucket < 50),
    above = idWhere('0.11.0', bucket => bucket >= 50);
  const staged = [withBody('0.11.0', marker(50)), withBody('0.10.0')];
  assert.ok(rolloutBucket(below, '0.11.0') < 50 && rolloutBucket(above, '0.11.0') >= 50);
  assert.equal(await pick(staged, below), '0.11.0');
  assert.equal(await pick(staged, above), '0.10.0');
  // Releases for another platform never stand in for a held one.
  assert.equal(await pick([withBody('0.11.0', marker(0)), release('0.12.0', 'win32-x64')], 'machine-1'), undefined);
});
