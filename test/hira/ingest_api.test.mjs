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
// 1B-5A: POST 전용 + JSON body 전용. query 는 절대 실행에 쓰이지 않아야 하므로,
// 회귀 확인을 위해 query 를 항상 같이 실어 보낸다(무시되는지 각 테스트에서 검증).
const mkReq = ({ headers = {}, body = {}, method = 'POST', query = {} } = {}) => ({ headers, body, method, query });
const SECRET = 'test-cron-secret-xyz';
const auth = { authorization: `Bearer ${SECRET}` };

const deps = (env = {}) => ({
  env: { CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'preview', ...env },
  createClient: () => makeMockClient({ listTotal: 5 }),
  collect: collectHospitals,
});

// ── Production: 메서드·인증·입력 무관 최우선 404 ───────────────────────
test('12. production → 404 (POST + 올바른 Bearer 여도)', async () => {
  const res = mkRes();
  await createHandler(deps({ VERCEL_ENV: 'production' }))(mkReq({ headers: auth, body: { limit: 3 } }), res);
  assert.equal(res.statusCode, 404);
});

test('12b. production → GET/POST/PUT 및 Bearer 정오 여부와 무관하게 전부 404, 호출 0', async () => {
  const h = deps({ VERCEL_ENV: 'production' });
  for (const method of ['GET', 'POST', 'PUT']) {
    for (const headers of [auth, {}, { authorization: 'Bearer nope' }]) {
      const res = mkRes();
      let touched = false;
      await createHandler({
        ...h,
        createClient: () => { touched = true; return makeMockClient({ listTotal: 5 }); },
        collect: async () => { touched = true; return {}; },
      })(mkReq({ headers, method, body: { dryRun: false, limit: 3 } }), res);
      assert.equal(res.statusCode, 404);
      assert.equal(touched, false);
    }
  }
});

// ── 메서드 게이트: POST 만 허용 ──────────────────────────────────────
test('21. Preview GET + 올바른 Bearer → 405, 호출 0', async () => {
  let touched = false;
  const res = mkRes();
  await createHandler({ ...deps(), createClient: () => { touched = true; return makeMockClient(); } })(
    mkReq({ headers: auth, method: 'GET' }), res
  );
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, 'method_not_allowed');
  assert.equal(res.headers.Allow, 'POST');
  assert.equal(touched, false);
});

test('21b. Preview GET + ?secret=<정상값> → 405, 호출 0 (query secret 은 인증에도 쓰이지 않음)', async () => {
  let touched = false;
  const res = mkRes();
  await createHandler({ ...deps(), createClient: () => { touched = true; return makeMockClient(); } })(
    mkReq({ method: 'GET', query: { secret: SECRET } }), res
  );
  assert.equal(res.statusCode, 405);
  assert.equal(touched, false);
});

test('21c. Preview PUT/DELETE + 올바른 Bearer → 405, 호출 0', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = mkRes();
    await createHandler(deps())(mkReq({ headers: auth, method }), res);
    assert.equal(res.statusCode, 405, `method=${method}`);
    assert.equal(res.headers.Allow, 'POST');
  }
});

// ── 인증: Authorization: Bearer 만 인정, query secret 폐지 ──────────────
test('13. 인증 없음 / 틀린 시크릿 → 401 (POST)', async () => {
  const h = createHandler(deps());
  for (const req of [
    mkReq(),
    mkReq({ headers: { authorization: 'Bearer nope' } }),
    mkReq({ query: { secret: SECRET } }), // query secret 무효
  ]) {
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

test('22. Preview POST + query secret 만 존재(Authorization 없음) → 401, 호출 0', async () => {
  let touched = false;
  const res = mkRes();
  await createHandler({ ...deps(), createClient: () => { touched = true; return makeMockClient(); } })(
    mkReq({ query: { secret: SECRET }, body: { limit: 3 } }), res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(touched, false);
});

test('23. Preview POST + Bearer 스킴 오류/누락/불일치 → 401, 호출 0', async () => {
  let touched = false;
  const mk = () => ({ createClient: () => { touched = true; return makeMockClient(); } });
  const cases = [
    mkReq({ body: { limit: 3 } }), // Authorization 헤더 없음
    mkReq({ headers: { authorization: SECRET }, body: { limit: 3 } }), // Bearer 스킴 누락
    mkReq({ headers: { authorization: 'Basic ' + SECRET }, body: { limit: 3 } }), // 잘못된 scheme
    mkReq({ headers: { authorization: 'Bearer wrong-value' }, body: { limit: 3 } }),
  ];
  for (const req of cases) {
    touched = false;
    const res = mkRes();
    await createHandler({ ...deps(), ...mk() })(req, res);
    assert.equal(res.statusCode, 401, JSON.stringify(req.headers));
    assert.equal(touched, false);
  }
});

// ── JSON body 계약 ───────────────────────────────────────────────────
test('정상 dry-run(body 비어있음=기본값) → 통계·샘플, dbWrites=0, _normalizedAll 미포함', async () => {
  const res = mkRes();
  await createHandler(deps())(mkReq({ headers: auth }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.dbWrites, 0);
  assert.ok(res.body.samples.length <= 3);
  assert.equal(res.body._normalizedAll, undefined);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('limit 상한 3 강제 (dry-run, body.limit=9999)', async () => {
  let seen = null;
  const res = mkRes();
  await createHandler({ ...deps(), collect: async (c, o) => { seen = o; return { stats: {}, warnings: [], failures: [], samples: [], meta: {} }; } })(
    mkReq({ headers: auth, body: { limit: 9999 } }), res
  );
  assert.equal(seen.maxInstitutions, 3);
});

test('24. query 의 dryRun/limit/secret 는 body 계약을 덮어쓰지 못함', async () => {
  let seen = null;
  const res = mkRes();
  // query 는 실 적재를 흉내내지만 body 는 dry-run + limit 3 그대로.
  await createHandler({ ...deps(), collect: async (c, o) => { seen = o; return { stats: { normalized: 3 }, warnings: [], failures: [], samples: [], meta: {} }; } })(
    mkReq({ headers: auth, body: { limit: 3 }, query: { dryRun: 'false', limit: '1', secret: 'nope' } }), res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true); // query.dryRun=false 무시됨
  assert.equal(seen.maxInstitutions, 3); // query.limit=1 무시됨
});

test('25. body 가 배열/문자열/null 이면 400 invalid_body, 호출 0', async () => {
  let touched = false;
  const mkTouch = () => { touched = true; return makeMockClient(); };
  for (const body of [[1, 2, 3], 'not-an-object', null]) {
    touched = false;
    const res = mkRes();
    await createHandler({ ...deps(), createClient: mkTouch })(mkReq({ headers: auth, body }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'invalid_body');
    assert.equal(touched, false);
  }
});

test('25b. body.dryRun 이 boolean 이 아니면 400, body.limit 이 문자열/NaN/0/음수/배열/객체면 400', async () => {
  const res1 = mkRes();
  await createHandler(deps())(mkReq({ headers: auth, body: { dryRun: 'false' } }), res1);
  assert.equal(res1.statusCode, 400);
  assert.equal(res1.body.reason, 'dryRun_must_be_boolean');

  for (const limit of ['3', NaN, 0, -1, 1.5, [], {}]) {
    const res = mkRes();
    await createHandler(deps())(mkReq({ headers: auth, body: { limit } }), res);
    assert.equal(res.statusCode, 400, `limit=${JSON.stringify(limit)}`);
    assert.equal(res.body.reason, 'limit_must_be_positive_integer');
  }
});

test('25c. body 를 아예 안 보냄(undefined) → 기본값(dryRun=true, limit=3) 취급', async () => {
  const res = mkRes();
  const req = mkReq({ headers: auth });
  delete req.body;
  await createHandler(deps())(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
});

test('25d. 알려지지 않은 body 필드는 무시(400 아님)', async () => {
  const res = mkRes();
  await createHandler(deps())(mkReq({ headers: auth, body: { limit: 3, unknownField: 'x' } }), res);
  assert.equal(res.statusCode, 200);
});

// ── dryRun=false : 1B-3A 에서는 비활성 ──────────────────────────────
test('14. dryRun=false + HOSPITAL_INGEST_PERSIST 없음 → 501 (persist 비활성)', async () => {
  const sbSpy = makeMockSb();
  const res = mkRes();
  await createHandler({ ...deps(), sbImpl: sbSpy, assertDb: async () => ({ ok: true }), persist: async () => ({ runId: 1, stats: {}, failures: [] }) })(
    mkReq({ headers: auth, body: { dryRun: false } }), res
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
  })(mkReq({ headers: auth, body: { dryRun: false } }), res);
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
  })(mkReq({ headers: auth, body: { dryRun: false, limit: 3 } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, false);
  assert.equal(res.body.runId, 7);
  assert.equal(res.body.persisted.new, 3);
  assert.equal(persistArgs.d.sb, sb); // 주입된 sb 사용
});

test('26. persist 경로도 정상 Bearer + JSON body 에서만 실행 (query 로는 트리거되지 않음)', async () => {
  let persistCalled = false;
  const res = mkRes();
  await createHandler({
    ...persistOn(),
    assertDb: async () => ({ ok: true }),
    persist: async () => { persistCalled = true; return { runId: 1, status: 'ok', stats: {}, failures: [] }; },
  })(mkReq({ headers: auth, body: { limit: 3 }, query: { dryRun: 'false' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true); // query.dryRun 무시 → dry-run 유지
  assert.equal(persistCalled, false);
});

test('16. persist 활성 + assertDb 실패(운영 DB 등) → 409 unsafe_db, persist 미실행', async () => {
  let persisted = false;
  const res = mkRes();
  await createHandler({
    ...persistOn(),
    assertDb: async () => ({ ok: false, reason: 'db_has_ltc_rows' }),
    persist: async () => { persisted = true; return {}; },
  })(mkReq({ headers: auth, body: { dryRun: false } }), res);
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
  })(mkReq({ headers: auth, body: { dryRun: false } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'hospital_module_on');
});

test('18. persist 활성이어도 production 은 404 (최우선)', async () => {
  const res = mkRes();
  await createHandler({
    ...persistOn({ env: { CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'production', HOSPITAL_INGEST_PERSIST: '1' } }),
    assertDb: async () => ({ ok: true }),
  })(mkReq({ headers: auth, body: { dryRun: false } }), res);
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
  })(mkReq({ headers: auth, body: { dryRun: false, limit: 20 } }), res);
  assert.equal(seen.maxInstitutions, 3);
});

test('19b. persist 활성 + collect 3건 반환하나 하나 name 누락 → 422 required_fields_incomplete, persist 미호출', async () => {
  let persistCalled = false;
  const item = (n, name) => ({ hospital: { id: `H-${n}`, external_id: `${n}`, name, normalized_hash: `h${n}` }, evaluation: null, raw: {} });
  const res = mkRes();
  await createHandler({
    ...persistOn(),
    assertDb: async () => ({ ok: true }),
    collect: async () => ({
      _normalizedAll: [item('a', 'A'), item('b', null), item('c', 'C')],
      stats: { deduped: 3, normalized: 3, listRetries: 0 }, warnings: [], failures: [], samples: [], meta: {},
    }),
    persist: async () => { persistCalled = true; return { runId: 1, status: 'ok', stats: {}, failures: [] }; },
  })(mkReq({ headers: auth, body: { dryRun: false, limit: 3 } }), res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, 'collect_count_mismatch');
  assert.equal(res.body.reason, 'required_fields_incomplete');
  assert.equal(res.body.validCount, 2);
  assert.equal(persistCalled, false);
});

test('20. persist 활성 + 실제 assertPreviewDb + 허용 host 와 다른 SUPABASE_URL → 409 wrong_preview_db, persist·collect 미실행', async () => {
  let touched = false;
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({
    // assertDb 를 주입하지 않음 → 실제 assertPreviewDb 사용. 합성 hostname (실제 ref 아님).
    env: {
      CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'preview', HOSPITAL_INGEST_PERSIST: '1',
      HOSPITAL_INGEST_DB_HOST: 'preview-db-ref-test.supabase.co',
      SUPABASE_URL: 'https://another-db-ref-test.supabase.co',
    },
    sbImpl: sb,
    createClient: () => { touched = true; return makeMockClient({ listTotal: 5 }); },
    collect: async () => { touched = true; return { _normalizedAll: [] }; },
    persist: async () => { touched = true; return {}; },
  })(mkReq({ headers: auth, body: { dryRun: false, limit: 3 } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'unsafe_db');
  assert.equal(res.body.reason, 'wrong_preview_db');
  assert.equal(touched, false);
  assert.equal(sb.calls.length, 0); // 목적지 틀리면 DB 접속 0
  // 응답에 URL·ref·키 없음
  const blob = JSON.stringify(res.body);
  assert.ok(!/supabase\.co|https?:|ref-test|apikey|SUPABASE/.test(blob));
});

test('20b. persist 활성 + HOSPITAL_INGEST_DB_HOST 미설정 → 409 wrong_preview_db (fail-closed)', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({
    env: {
      CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'preview', HOSPITAL_INGEST_PERSIST: '1',
      SUPABASE_URL: 'https://preview-db-ref-test.supabase.co', // URL 은 있으나 허용 host 미지정
    },
    sbImpl: sb,
    collect: async () => ({ _normalizedAll: [] }),
    persist: async () => ({}),
  })(mkReq({ headers: auth, body: { dryRun: false, limit: 3 } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'wrong_preview_db');
  assert.equal(sb.calls.length, 0);
});

// ── 비밀정보 비노출 ────────────────────────────────────────────────
test('11(api). 응답에 ykiho 원문·serviceKey 없음 (dry-run)', async () => {
  const res = mkRes();
  await createHandler(deps())(mkReq({ headers: auth, body: { limit: 3 } }), res);
  const blob = JSON.stringify(res.body);
  assert.equal(/JDQ4[A-Za-z0-9+/]{20,}/.test(blob), false);
  assert.equal(blob.includes('serviceKey'), false);
});

test('27. 응답·로그에 CRON_SECRET/토큰 노출 없음 (401/400/200 전 경로)', async () => {
  const cases = [
    mkReq({ headers: { authorization: 'Bearer ' + SECRET + 'extra-long-suffix-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
    mkReq({ headers: auth, body: { limit: 'bad' } }),
    mkReq({ headers: auth, body: { limit: 3 } }),
  ];
  for (const req of cases) {
    const res = mkRes();
    await createHandler(deps())(req, res);
    const blob = JSON.stringify(res.body) + JSON.stringify(res.headers);
    assert.equal(blob.includes(SECRET), false);
    assert.equal(/Bearer\s/.test(blob), false);
  }
});

test('HIRA 목록 첫 페이지부터 실패 → dry-run 도 성공 아님 (502 collect_failed), 토큰 스크럽', async () => {
  const res = mkRes();
  await createHandler({
    ...deps(),
    createClient: () => ({
      endpoints: makeMockClient().endpoints,
      listHospitals: async () => { throw new Error('boom AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); },
    }),
  })(mkReq({ headers: auth }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'collect_failed');
  assert.equal(res.body.reason, 'list_fetch_failed');
  assert.notEqual(res.body.ok, true);
  assert.equal(/A{40,}/.test(JSON.stringify(res.body)), false);
});

// ── 정적 계약 고정: query 를 실행에 쓰지 않는다 / production 가드 우선순위 ──────
test('28(정적). ingest.js 는 req.query 를 실행 제어에 쓰지 않는다', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../api/hospital/ingest.js', import.meta.url), 'utf8');
  assert.equal(/req\.query/.test(src.replace(/\/\/.*$/gm, '')), false, '주석 제외 실코드에 req.query 남아있음');
  assert.equal(src.includes("req.query.secret"), false);
});

test('29(정적). production 가드가 method/인증/DB/HIRA 처리보다 먼저 나온다', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../api/hospital/ingest.js', import.meta.url), 'utf8');
  const iProd = src.indexOf("env.VERCEL_ENV === 'production'");
  const iMethod = src.indexOf("method !== 'POST'");
  const iAuth = src.indexOf('safeEqual(bearer, secret)');
  assert.ok(iProd >= 0 && iMethod > iProd, 'production 체크가 method 체크보다 먼저여야 함');
  assert.ok(iAuth > iMethod, 'method 체크가 인증 체크보다 먼저여야 함');
});
