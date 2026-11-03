// Opt-in public-site check: normal website scripts, isolated reads, no authentication or input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('normal-script GitHub homepage, repository and issues are readable over MCP', { timeout: 120000 }, async () => {
  const out = resolve(process.env.ADL_GITHUB_PROOF_DIR ?? `artifacts/github-live-${Date.now()}`);
  await mkdir(out, { recursive: true });
  const config = resolve(out, 'policy.json');
  await writeFile(
    config,
    JSON.stringify(
      {
        operationMode: 'read_only',
        allowedOrigins: ['https://github.com'],
        resourceOrigins: ['https://github.githubassets.com', 'https://avatars.githubusercontent.com'],
        actionTimeoutMs: 20000,
        browserTargets: [
          { id: 'github', label: 'Public GitHub', url: 'https://github.com/', classification: 'PUBLIC' },
        ],
      },
      null,
      2,
    ),
  );
  const mode = process.env.ADL_GITHUB_PROTOCOL === 'modern' ? { pin: '2026-07-28' } : 'legacy';
  const client = new Client({ name: 'adl-github-live', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--use-system-ca', resolve('dist/src/server.js'), '--config', config],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  const records = [];
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, {}, { timeout: 25000 });
    const data = JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.equal(data.ok, true, JSON.stringify(data));
    return data;
  };
  try {
    await client.connect(transport);
    transport.stderr?.on('data', () => {});
    for (const url of [
      'https://github.com/',
      'https://github.com/microsoft/vscode',
      'https://github.com/microsoft/vscode/issues',
    ]) {
      const session = await call('adl_open', { url });
      try {
        // This proves the normal scripted document hit the integrity boundary.
        // Blocking the asset origin would leave a static document and fail this check.
        assert.equal(session.read_only, true, `${url} must use the isolated read-only path`);
        assert.deepEqual(session.capabilities, ['observe', 'read_state', 'wait_for', 'navigate', 'back']);
        const first = await call('adl_observe', { session_id: session.session_id });
        assert.equal(first.read_only, true);
        const main = first.landmarks?.find(item => item.role === 'main');
        assert.ok(main, `${url} exposes a body entry point in the default response`);
        const body = await call('adl_observe', {
          session_id: session.session_id,
          token_budget: 8000,
          text: { element_id: main.id, offset: 0, length: 8192 },
        });
        assert.equal(body.read_only, true);
        assert.ok(body.text.total_length > 100, `${url} body is readable`);
        const found = await call('adl_observe', {
          session_id: session.session_id,
          token_budget: 8000,
          scope: `within:${main.id}`,
        });
        assert.ok(found.elements.length > 0, `${url} body supports scoped observation`);
        records.push({
          url,
          title: first.title,
          read_only: true,
          initial_elements: first.elements.length,
          scoped_elements: found.elements.length,
          body_characters: body.text.total_length,
          source_limits: first.source_limits ?? [],
        });
        console.log(records.at(-1));
      } finally {
        await call('adl_close', { session_id: session.session_id });
      }
    }
  } finally {
    await writeFile(resolve(out, 'result.json'), JSON.stringify({ pages: records }, null, 2));
    await client.close();
  }
});
