import { createServer } from 'node:http';
import { expect } from 'vitest';

/** Listener used by native fake processes; it never records or logs the Authorization header. */
export async function testMcpServer(token: string) {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      if (request.method === 'GET') {
        response.writeHead(405).end();
        return;
      }
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: number | string;
        method: string;
      };
      methods.push(body.method);
      if (body.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'corrallm', version: 'test' },
            }
          : body.method === 'tools/list'
            ? { tools: [{ name: 'probe_read', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'bound reply' }] };
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No MCP address');
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    methods,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
