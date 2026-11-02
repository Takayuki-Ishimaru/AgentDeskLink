import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

export type StubEntry = {
  request_id: string;
  binding: string;
  expires_at: number;
  status: string;
  summary: { action: string; risk: string; details?: string[]; [key: string]: unknown };
  [key: string]: unknown;
};

/**
 * A loopback stand-in for the VS Code approval broker (the ADL_APPROVAL_* contract of src/approval-client.ts). Requests stay pending until a test
 * sets their status; DELETE consumes an approved request, invalidates a pending one and leaves any other status as it is. Set the environment
 * before the Engine is constructed: the Engine reads it once.
 */
export async function stubBroker() {
  const saved = {
    url: process.env.ADL_APPROVAL_URL,
    token: process.env.ADL_APPROVAL_TOKEN,
    epoch: process.env.ADL_APPROVAL_EPOCH,
  };
  const token = randomBytes(32).toString('base64url');
  const entries = new Map<string, StubEntry>();
  const state = { posts: 0, gets: 0, deletes: 0, consumes: 0 };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403);
        res.end();
        return;
      }
      let entry: StubEntry | undefined;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as StubEntry;
        state.posts++;
        entry = { ...body, status: 'pending' };
        entries.set(entry.request_id, entry);
      } else entry = entries.get(req.url!.split('/').at(-1)!);
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      let consumed = false;
      if (req.method === 'GET') state.gets++;
      if (req.method === 'DELETE') {
        state.deletes++;
        if (entry.status === 'approved' && entry.expires_at > Date.now()) {
          entry.status = 'consumed';
          state.consumes++;
          consumed = true;
        } else if (entry.status === 'pending') entry.status = 'invalidated';
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          v: 1,
          request_id: entry.request_id,
          binding: entry.binding,
          expires_at: entry.expires_at,
          status: entry.status,
          ...(req.method === 'DELETE' ? { consumed_now: consumed } : {}),
        }),
      );
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = token;
  process.env.ADL_APPROVAL_EPOCH = randomUUID();
  return {
    entries,
    state,
    /** The most recently created request. */
    latest: () => [...entries.values()].at(-1),
    byId: (id: string) => entries.get(id),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of [
        ['ADL_APPROVAL_URL', saved.url],
        ['ADL_APPROVAL_TOKEN', saved.token],
        ['ADL_APPROVAL_EPOCH', saved.epoch],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
