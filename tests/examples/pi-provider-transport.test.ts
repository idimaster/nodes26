import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createProviderTransport, shouldRotateProviderTransport } from '../../examples/pi/src/provider-transport.js';

it('uses a private HTTP/1.1 connection and opens a new one after rotation', async () => {
  const seen: { version: string; port: number | undefined; method: string | undefined; contentType: string | undefined }[] = [];
  const server = createServer((request, response) => {
    seen.push({ version: request.httpVersion, port: request.socket.remotePort, method: request.method, contentType: request.headers['content-type'] });
    response.setHeader('content-type', 'text/event-stream');
    response.end('data: ok\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  const url = `http://127.0.0.1:${address.port}/`;
  const transport = createProviderTransport();
  try {
    const request = () => transport.fetch(url, { method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: '{"test":true}' });
    expect(await (await request()).text()).toBe('data: ok\n\n');
    transport.rotate();
    expect(await (await request()).text()).toBe('data: ok\n\n');
    expect(seen.map(request => request.version)).toEqual(['1.1', '1.1']);
    expect(seen.map(request => [request.method, request.contentType])).toEqual([['POST', 'application/json'], ['POST', 'application/json']]);
    expect(seen[0]?.port).not.toBe(seen[1]?.port);
  } finally {
    await transport.close();
    await transport.close();
    server.close();
    await once(server, 'close');
  }
});

it('checks nested transport codes without message matching or cause cycles', () => {
  const trigger = Object.assign(new Error('provider detail'), { code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC' });
  const outer = new TypeError('fetch failed', { cause: trigger });
  expect(shouldRotateProviderTransport(outer)).toBe(true);
  const unrelated = Object.assign(new Error('alert bad record mac'), { code: 'ECONNRESET' });
  Object.assign(unrelated, { cause: unrelated });
  expect(shouldRotateProviderTransport(unrelated)).toBe(false);
});
