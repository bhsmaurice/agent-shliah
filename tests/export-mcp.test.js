'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { init } = require('../features/export/export.server');

test('MCP bearer access, tools, photos and credential redaction', async () => {
  const routes = {};
  const previous = process.env.EXPORT_API_KEY;
  process.env.EXPORT_API_KEY = 'local-test-secret';
  let calls = 0;
  init({ app: { get(path, ...h) { routes['GET ' + path] = h; }, post(path, ...h) { routes['POST ' + path] = h; } },
    publicBaseUrl: 'https://shliah.example', pool: { async query(sql) {
      calls++;
      if (sql.includes('m.data')) return { rows: [{ data: Buffer.from([255, 216, 255]), mime_type: 'image/jpeg' }] };
      return { rows: [{ id: 'publie-1', date: new Date('2026-11-12T00:00:00Z'), statut: 'publié', instagram: 'Texte', facebook: '',
        photos: ['https://shliah.example/media/9'], resultat: 'Instagram : publié ✅' }] };
    } } });
  async function request(body, headers = { authorization: 'Bearer local-test-secret' }) {
    const req = { headers, query: {}, body };
    const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; },
      json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
    let allowed = false;
    const handlers = routes['POST /api/export/mcp'];
    handlers[0](req, res, () => { allowed = true; });
    if (allowed) await handlers[1](req, res);
    return res;
  }
  const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
  try {
    assert.equal((await request(rpc('tools/list'), {})).statusCode, 401);
    assert.equal(calls, 0);
    assert.equal((await request(rpc('tools/list'), { authorization: 'Bearer local-test-secret', origin: 'https://evil.example' })).statusCode, 403);
    const handshake = await request(rpc('initialize', { protocolVersion: '2025-11-25' }));
    assert.equal(handshake.body.result.protocolVersion, '2025-11-25');
    const list = await request(rpc('tools/list'));
    assert.deepEqual(list.body.result.tools.map(t => t.name), ['read_posts', 'read_photo']);
    assert.ok(list.body.result.tools.every(t => t.annotations.readOnlyHint));
    const posts = await request(rpc('tools/call', { name: 'read_posts', arguments: { days: 7 } }));
    assert.ok(!JSON.stringify(posts.body).includes('local-test-secret'));
    assert.deepEqual(JSON.parse(posts.body.result.content[0].text).posts[0].photos, [{ id: '9', url: 'https://shliah.example/api/export/media/9' }]);
    const photo = await request(rpc('tools/call', { name: 'read_photo', arguments: { id: '9' } }));
    assert.equal(photo.body.result.content[0].mimeType, 'image/jpeg');
    assert.equal(photo.body.result.content[0].data, '/9j/');
    assert.equal((await request(rpc('tools/call', { name: 'delete_post' }))).body.error.code, -32602);
    assert.equal((await request(rpc('tools/call', { name: 'read_posts', arguments: { days: 61 } }))).body.error.code, -32602);
    assert.equal((await request({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode, 202);
  } finally {
    if (previous === undefined) delete process.env.EXPORT_API_KEY; else process.env.EXPORT_API_KEY = previous;
  }
});
