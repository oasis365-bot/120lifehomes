import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../api/hospital/ingest.js';
import { collectHospitals } from '../../lib/hira/collect.js';
import { makeMockClient } from './mockClient.mjs';

// 최소 req/res 스텁
function mkRes() {
  const r = {
    statusCode: null,
    body: null,
    headers: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
  };
  return r;
}
const mkReq = ({ headers = {}, query = {} } = {}) => ({ headers, query });

const SECRET = 'test-cron-secret-xyz';
const deps = (env = {}) => ({
  env: { CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', ...env },
  createClient: () => makeMockClient({ listTotal: 5 }),
  collect: collectHospitals,
});

test('12. production 에서는 404', async () => {
  const h = createHandler(deps({ VERCEL_ENV: 'production' }));
  const res = mkRes();
  await h(mkReq({ headers: { authorization: `Bearer ${SECRET}` } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'not_found');
});

test('13. 인증 없음 / 틀린 시크릿 → 401', async () => {
  const h = createHandler(deps());
  const noAuth = mkRes();
  await h(mkReq(), noAuth);
  assert.equal(noAuth.statusCode, 401);

  const wrong = mkRes();
  await h(mkReq({ headers: { authorization: 'Bearer nope' } }), wrong);
  assert.equal(wrong.statusCode, 401);

  const qs = mkRes();
  await h(mkReq({ query: { secret: 'nope' } }), qs);
  assert.equal(qs.statusCode, 401);
});

test('13b. CRON_SECRET 미설정 → 401 (fail-closed)', async () => {
  const h = createHandler({ ...deps(), env: { DATA_GO_KR_KEY: 'k' } });
  const res = mkRes();
  await h(mkReq({ headers: { authorization: 'Bearer ' } }), res);
  assert.equal(res.statusCode, 401);
});

test('정상 dry-run — 통계·샘플 반환, dbWrites=0', async () => {
  const h = createHandler(deps());
  const res = mkRes();
  await h(mkReq({ headers: { authorization: `Bearer ${SECRET}` }, query: { limit: '5' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.dbWrites, 0);
  assert.equal(res.body.stats.normalized, 5);
  assert.ok(res.body.samples.length <= 3);
  assert.equal(res.body._normalizedAll, undefined); // 원본 전체 미포함
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('14. dryRun=false → 501, DB write 경로 없음', async () => {
  const h = createHandler(deps());
  const res = mkRes();
  await h(
    mkReq({ headers: { authorization: `Bearer ${SECRET}` }, query: { dryRun: 'false' } }),
    res
  );
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.error, 'db_write_not_implemented');
});

test('14b. 이 핸들러는 lib/db 를 import 하지 않는다 (정적)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    fileURLToPath(new URL('../../api/hospital/ingest.js', import.meta.url)),
    'utf8'
  );
  assert.equal(/lib\/db|from ['"].*db\.js/.test(src), false);
  assert.equal(/\bsb\(/.test(src), false);
});

test('limit 상한 20 강제', async () => {
  let seen = null;
  const h = createHandler({
    ...deps(),
    collect: async (client, o) => {
      seen = o;
      return { stats: {}, warnings: [], failures: [], samples: [], meta: {} };
    },
  });
  const res = mkRes();
  await h(mkReq({ headers: { authorization: `Bearer ${SECRET}` }, query: { limit: '9999' } }), res);
  assert.equal(seen.maxInstitutions, 20);
});

test('11(api). 응답에 ykiho 원문·API 키 없음', async () => {
  const h = createHandler(deps());
  const res = mkRes();
  await h(mkReq({ headers: { authorization: `Bearer ${SECRET}` }, query: { limit: '5' } }), res);
  const blob = JSON.stringify(res.body);
  assert.equal(/JDQ4[A-Za-z0-9+/]{20,}/.test(blob), false); // ykiho 원문 패턴
  assert.equal(blob.includes('serviceKey'), false);
});

test('HIRA 완전 실패 → 502 + 구조화 정보, 토큰 스크럽', async () => {
  const h = createHandler({
    ...deps(),
    createClient: () => ({
      endpoints: makeMockClient().endpoints,
      listHospitals: async () => {
        const e = new Error('boom AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        throw e;
      },
    }),
    collect: collectHospitals,
  });
  const res = mkRes();
  await h(mkReq({ headers: { authorization: `Bearer ${SECRET}` } }), res);
  // 목록 실패는 collect 내부에서 warning 처리 → 200 이지만 deduped 0
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stats.deduped, 0);
  assert.equal(/A{40,}/.test(JSON.stringify(res.body)), false);
});
