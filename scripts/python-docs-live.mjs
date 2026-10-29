// Explicit network test of the public site and the shipped exact-target policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test(
  'official Python website: approved visible search fill and successive real links',
  { timeout: 60000 },
  async () => {
    const out = resolve(process.env.ADL_PROOF_DIR ?? `artifacts/python-docs-${Date.now()}`);
    await mkdir(out, { recursive: true });
    const policy = JSON.parse(await readFile('config/python-docs.example.json', 'utf8'));
    policy.auditPath = resolve(out, 'audit.jsonl');
    policy.browserTargets[0].visual = { enabled: true };
    const config = resolve(out, 'policy.json');
    await writeFile(config, JSON.stringify(policy, null, 2));
    const client = new Client(
      { name: 'adl-python-docs-live', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    const records = [];
    let success = false,
      inputVerified = false,
      links = [];
    const call = async (name, args = {}) => {
      const raw = await client.callTool({ name, arguments: args }, {}, { timeout: 25000 }),
        data = JSON.parse(raw.content.find(c => c.type === 'text').text);
      records.push({ tool: name, args, result: data });
      assert.equal(data.ok, true, JSON.stringify(data));
      return { data, raw };
    };
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve('dist/src/server.js'), '--config', config],
          cwd: process.cwd(),
          stderr: 'pipe',
        }),
      );
      const target = (await call('adl_targets')).data.targets[0],
        session = (await call('adl_open', { target_id: target.target_id })).data;
      const observe = async () => {
        let p = (await call('adl_observe', { session_id: session.session_id, token_budget: 8000 })).data;
        const revision = p.revision,
          elements = [...p.elements];
        let pages = 1;
        while (p.next_cursor && pages++ < 20) {
          p = (await call('adl_observe', { session_id: session.session_id, token_budget: 8000, cursor: p.next_cursor }))
            .data;
          assert.equal(p.revision, revision);
          elements.push(...p.elements);
        }
        assert.equal(p.next_cursor, null);
        return { ...p, elements };
      };
      const capture = async file => {
        const r = await call('adl_capture', { session_id: session.session_id, max_dimension: 1280 });
        await writeFile(resolve(out, file), Buffer.from(r.raw.content.find(c => c.type === 'image').data, 'base64'));
      };
      let state = await observe();
      const fields = state.elements.filter(e => e.role === 'textbox' && e.name === 'Quick search');
      assert.ok(fields.length >= 2);
      // Document order: desktop header, then footer. The hidden mobile search field
      // is neither observed nor approved. Duplicate names/IDs do not broaden policy.
      await call('adl_act', {
        session_id: session.session_id,
        expected_revision: state.revision,
        action: 'fill',
        element_id: fields[0].id,
        value: 'dictionary',
        expected_target: { role: 'textbox', name: 'Quick search' },
      });
      state = await observe();
      assert.equal(state.elements.find(e => e.id === fields[0].id).value, 'dictionary');
      for (const field of fields.slice(1)) assert.equal(state.elements.find(e => e.id === field.id).value, '');
      inputVerified = true;
      await capture('search-input.png');
      await writeFile(resolve(out, 'input-readback.json'), JSON.stringify(state, null, 2));
      for (const [name, heading] of [
        ['Tutorial', 'The Python Tutorial'],
        ['5. Data Structures', 'Data Structures'],
      ]) {
        state = await observe();
        const link = state.elements.find(e => e.role === 'link' && e.name === name);
        assert.ok(link, `visible sibling link ${name} remains observable after deep branches`);
        await call('adl_act', {
          session_id: session.session_id,
          expected_revision: state.revision,
          action: 'click',
          element_id: link.id,
          expected_target: { role: 'link', name },
        });
        await call('adl_wait', {
          session_id: session.session_id,
          condition: { role: 'heading', name: heading },
          timeout_ms: 5000,
        });
        links.push(name);
      }
      await capture('data-structures.png');
      await call('adl_close', { session_id: session.session_id });
      success = true;
    } finally {
      await client.close();
      await writeFile(resolve(out, 'mcp-transcript.json'), JSON.stringify(records, null, 2));
      await writeFile(
        resolve(out, 'verification.json'),
        JSON.stringify(
          {
            ok: success,
            site: 'https://docs.python.org/3/',
            search_input_verified: inputVerified,
            search_text: 'dictionary',
            other_search_fields_unchanged: true,
            links,
            physical_input: false,
            mcp_calls: records.length,
          },
          null,
          2,
        ),
      );
      console.log(`Evidence: ${out}`);
    }
  },
);
