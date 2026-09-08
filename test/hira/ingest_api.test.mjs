import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../api/hospital/ingest.js';
import { collectHospitals } from '../../lib/hira/collect.js';
import { makeMockClient } from './mockClient.mjs';
import { makeMockSb } from './mockSb.mjs';

function mkRes() {
  return {
    statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}
const mkReq = ({ headers = {}, query = {} } = {}) => ({ headers, query });
const SECRET = 'test-cron-secret-xyz';
const auth = { authorization: `Bearer ${SECRET}` };

const deps = (env = {}) => ({
  env: { CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'preview', ...env },
  createClient: () => makeMockClient({ listTotal: 5 }),
  collect: collectHospitals,
});

test('12. production → 404', async () => {
  const res = mkRes();
  await createHandler(deps({ VERCEL_ENV: 'production' }))(mkReq({ headers: auth }), res);
  assert.equal(res.statusCode, 404);
});

test('13. 인증 없음 / 틀린 시크릿 → 401', async () => {
  const h = createHandler(deps());
  for (const req of [mkReq(), mkReq({ headers: { authorization: 'Bearer nope' } }), mkReq({ query: { secret: 'nope' } })]) {
    const res = mkRes();
    await h(req, res);
    assert.equal(res.statusCode, 401);
  }
});

test('13b. CRON_SECRET 미설정 → 401', async () => {
  const res = mkRes();
  await createHandler({ ...deps(), env: { DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'preview' } })(
    mkReq({ headers: { authorization: 'Bearer ' } }), res
  );
  assert.equal(res.statusCode, 401);
});

test('정상 dry-run → 통계·샘플, dbWrites=0, _normalizedAll 미포함', async () => {
  const res = mkRes();
  await createHandler(deps())(mkReq({ headers: auth, query: { limit: '3' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.dbWrites, 0);
  assert.ok(res.body.samples.length <= 3);
  assert.equal(res.body._normalizedAll, undefined);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('limit 상한 3 강제 (dry-run)', async () => {
  let seen = null;
  const res = mkRes();
  await createHandler({ ...deps(), collect: async (c, o) => { seen = o; return { stats: {}, warnings: [], failures: [], samples: [], meta: {} }; } })(
    mkReq({ headers: auth, query: { limit: '9999' } }), res
  );
  assert.equal(seen.maxInstitutions, 3);
});

// ── dryRun=false : 1B-3A 에서는 비활성 ──────────────────────────────
test('14. dryRun=false + HOSPITAL_INGEST_PERSIST 없음 → 501 (persist 비활성)', async () => {
  const sbSpy = makeMockSb();
  const res = mkRes();
  await createHandler({ ...deps(), sbImpl: sbSpy, assertDb: async () => ({ ok: true }), persist: async () => ({ runId: 1, stats: {}, failures: [] }) })(
    mkReq({ headers: auth, query: { dryRun: 'false' } }), res
  );
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.error, 'persist_disabled');
  assert.equal(res.body.phase, '1B-3A');
  assert.equal(sbSpy.countWrites(), 0); // DB 접근 0
});

test('14b. persist 비활성 시 assertDb / persist / collect 를 아예 호출하지 않음', async () => {
  let touched = false;
  const res = mkRes();
  await createHandler({
    ...deps(),
    assertDb: async () => { touched = true; return { ok: true }; },
    persist: async () => { touched = true; return {}; },
    collect: async () => { touched = true; return {}; },
  })(mkReq({ headers: auth, query: { dryRun: 'false' } }), res);
  assert.equal(res.statusCode, 501);
  assert.equal(touched, false);
});

// ── dryRun=false : PERSIST 활성 시 (1B-3B 시뮬레이션) ────────────────
const persistOn = (extra = {}) => ({
  ...deps({ HOSPITAL_INGEST_PERSIST: '1' }),
  sbImpl: makeMockSb(),
  ...extra,
});

test('15. persist 활성 + 안전 DB → collect + persist 실행, 200', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  let persistArgs = null;
  await createHandler({
    ...persistOn(),
    sbImpl: sb,
    assertDb: async () => ({ ok: true }),
    persist: async (items, d) => { persistArgs = { items, d }; return { runId: 7, status: 'ok', stats: { new: items.length }, failures: [] }; },
  })(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, false);
  assert.equal(res.body.runId, 7);
  assert.equal(res.body.persisted.new, 3);
  assert.equal(persistArgs.d.sb, sb); // 주입된 sb 사용
});

test('16. persist 활성 + assertDb 실패(운영 DB 등) → 409 unsafe_db, persist 미실행', async () => {
  let persisted = false;
  const res = mkRes();
  await createHandler({
    ...persistOn(),
    assertDb: async () => ({ ok: false, reason: 'db_has_ltc_rows' }),
    persist: async () => { persisted = true; return {}; },
  })(mkReq({ headers: auth, query: { dryRun: 'false' } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'unsafe_db');
  assert.equal(res.body.reason, 'db_has_ltc_rows');
  assert.equal(persisted, false);
});

test('17. persist 활성 + hospital_module ON → 409 (assertDb reason)', async () => {
  const res = mkRes();
  await createHandler({
    ...persistOn(),
    assertDb: async () => ({ ok: false, reason: 'hospital_module_on' }),
  })(mkReq({ headers: auth, query: { dryRun: 'false' } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'hospital_module_on');
});

test('18. persist 활성이어도 production 은 404 (최우선)', async () => {
  const res = mkRes();
  await createHandler({
    ...persistOn({ env: { CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'production', HOSPITAL_INGEST_PERSIST: '1' } }),
    assertDb: async () => ({ ok: true }),
  })(mkReq({ headers: auth, query: { dryRun: 'false' } }), res);
  assert.equal(res.statusCode, 404);
});

test('19. persist 활성 + limit 상한 3', async () => {
  let seen = null;
  const res = mkRes();
  await createHandler({
    ...persistOn(),
    assertDb: async () => ({ ok: true }),
    collect: async (c, o) => { seen = o; return { _normalizedAll: [] }; },
    persist: async () => ({ runId: 1, status: 'ok', stats: {}, failures: [] }),
  })(mkReq({ headers: auth, query: { dryRun: 'false', limit: '20' } }), res);
  assert.equal(seen.maxInstitutions, 3);
});

test('20. persist 활성 + 실제 assertPreviewDb + 틀린 SUPABASE_URL → 409 wrong_preview_db, persist·collect 미실행', async () => {
  let touched = false;
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({
    // assertDb 를 주입하지 않음 → 실제 assertPreviewDb 사용
    env: { CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'preview', HOSPITAL_INGEST_PERSIST: '1', SUPABASE_URL: 'https://wdjqtynpqpzgiuzvphdr.supabase.co' },
    sbImpl: sb,
    createClient: () => { touched = true; return makeMockClient({ listTotal: 5 }); },
    collect: async () => { touched = true; return { _normalizedAll: [] }; },
    persist: async () => { touched = true; return {}; },
  })(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'unsafe_db');
  assert.equal(res.body.reason, 'wrong_preview_db');
  assert.equal(touched, false);
  assert.equal(sb.calls.length, 0); // 목적지 틀리면 DB 접속 0
  // 응답에 URL·ref·키 없음
  const blob = JSON.stringify(res.body);
  assert.ok(!/supabase\.co|https?:|wdjq|sojxq|apikey|SUPABASE/.test(blob));
});

// ── 비밀정보 비노출 ────────────────────────────────────────────────
test('11(api). 응답에 ykiho 원문·serviceKey 없음 (dry-run)', async () => {
  const res = mkRes();
  await createHandler(deps())(mkReq({ headers: auth, query: { limit: '3' } }), res);
  const blob = JSON.stringify(res.body);
  assert.equal(/JDQ4[A-Za-z0-9+/]{20,}/.test(blob), false);
  assert.equal(blob.includes('serviceKey'), false);
});

test('HIRA 목록 실패 → dry-run 200, deduped 0, 토큰 스크럽', async () => {
  const res = mkRes();
  await createHandler({
    ...deps(),
    createClient: () => ({
      endpoints: makeMockClient().endpoints,
      listHospitals: async () => { throw new Error('boom AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); },
    }),
  })(mkReq({ headers: auth }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stats.deduped, 0);
  assert.equal(/A{40,}/.test(JSON.stringify(res.body)), false);
});
