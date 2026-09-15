import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../../api/hospital/[action].js';

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('동적 라우터는 기존 ingest와 batch 주소를 각각 정확히 전달한다', async () => {
  const calls = [];
  const handler = createHandler({
    ingest: async (req, res) => { calls.push(['ingest', req]); res.status(201).json({ route: 'ingest' }); },
    batch: async (req, res) => { calls.push(['batch', req]); res.status(202).json({ route: 'batch' }); },
  });

  for (const [url, code, route] of [
    ['/api/hospital/ingest', 201, 'ingest'],
    ['/api/hospital/batch?ignored=1', 202, 'batch'],
  ]) {
    const req = { url, method: 'POST' };
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, code);
    assert.deepEqual(res.body, { route });
    assert.equal(calls.at(-1)[1], req);
  }
  assert.deepEqual(calls.map(([route]) => route), ['ingest', 'batch']);
});

test('알 수 없거나 변형된 경로는 내부 handler 호출 없이 404', async () => {
  let calls = 0;
  const handler = createHandler({
    ingest: async () => { calls += 1; },
    batch: async () => { calls += 1; },
  });
  for (const url of [
    '/api/hospital/unknown',
    '/api/hospital/ingest/extra',
    '/api/other/ingest',
    'not a valid route',
  ]) {
    const res = response();
    await handler({ url }, res);
    assert.equal(res.statusCode, 404, url);
    assert.deepEqual(res.body, { error: 'not_found' });
  }
  assert.equal(calls, 0);
});

test('Vercel Hobby 배포 함수는 최대 12개이고 ingest/batch 물리 파일은 통합됐다', () => {
  const apiRoot = fileURLToPath(new URL('../../api/', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.js')) files.push(relative(apiRoot, path).replaceAll('\\', '/'));
    }
  };
  walk(apiRoot);
  assert.equal(files.length, 12, files.sort().join('\n'));
  assert.equal(files.includes('hospital/ingest.js'), false);
  assert.equal(files.includes('hospital/batch.js'), false);
  assert.equal(files.includes('hospital/[action].js'), true);
});
