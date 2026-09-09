// node --test  (Node 20.14+ 내장 러너)
//  lib/db.js 서버 키 해석 + PostgREST 헤더 처리  /  api/env-check.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerKey, classifyServerKey, haveDb, sb } from '../lib/db.js';
import { createHandler } from '../api/env-check.js';

// ── helpers ──
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const makeJwt = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;

const LEGACY_SERVICE = makeJwt({ role: 'service_role', iss: 'supabase', ref: 'abc' });
const LEGACY_ANON = makeJwt({ role: 'anon', iss: 'supabase' });
const NEW_SECRET = 'sb_secret_ThisIsAFakeSecretValue000';
const NEW_PUBLISHABLE = 'sb_publishable_ThisIsAFakePublishable0';

function captureFetch(resInit = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: resInit.ok ?? true,
      status: resInit.status ?? 200,
      text: async () => resInit.text ?? '[]',
      headers: { get: () => resInit.contentRange ?? null },
    };
  };
  fn.calls = calls;
  return fn;
}
const H = (deps, path = 'feature_flags?select=key') => sb(path, {}, deps);

// ══════════════════════════════════════════════════════════════════════
// resolveServerKey — 우선순위
// ══════════════════════════════════════════════════════════════════════
test('두 변수 모두 있으면 SUPABASE_SECRET_KEY 우선', () => {
  const r = resolveServerKey({ SUPABASE_SECRET_KEY: NEW_SECRET, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE });
  assert.equal(r.key, NEW_SECRET);
  assert.equal(r.source, 'SUPABASE_SECRET_KEY');
});

test('SECRET_KEY 없으면 SERVICE_ROLE_KEY fallback', () => {
  const r = resolveServerKey({ SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE });
  assert.equal(r.key, LEGACY_SERVICE);
  assert.equal(r.source, 'SUPABASE_SERVICE_ROLE_KEY');
});

test('둘 다 없으면 source null', () => {
  const r = resolveServerKey({});
  assert.equal(r.key, '');
  assert.equal(r.source, null);
});

test('SECRET_KEY 가 공백뿐이면 fallback', () => {
  const r = resolveServerKey({ SUPABASE_SECRET_KEY: '   ', SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE });
  assert.equal(r.source, 'SUPABASE_SERVICE_ROLE_KEY');
});

// ══════════════════════════════════════════════════════════════════════
// classifyServerKey
// ══════════════════════════════════════════════════════════════════════
test('classify: sb_secret_ → new_secret, usable, Bearer 안 씀', () => {
  const c = classifyServerKey(NEW_SECRET);
  assert.deepEqual(c, { kind: 'new_secret', usable: true, useBearer: false });
});

test('classify: sb_publishable_ → 거부', () => {
  assert.deepEqual(classifyServerKey(NEW_PUBLISHABLE), { kind: 'new_publishable', usable: false, useBearer: false });
});

test('classify: legacy service_role JWT → usable + Bearer', () => {
  assert.deepEqual(classifyServerKey(LEGACY_SERVICE), { kind: 'legacy_service_role', usable: true, useBearer: true });
});

test('classify: legacy anon JWT → 거부', () => {
  assert.deepEqual(classifyServerKey(LEGACY_ANON), { kind: 'legacy_anon', usable: false, useBearer: false });
});

test('classify: 빈 값 / 알 수 없는 형식 → 거부', () => {
  assert.equal(classifyServerKey('').usable, false);
  assert.equal(classifyServerKey('random-string').usable, false);
  assert.equal(classifyServerKey('eyJnot.a.jwt').usable, false);
});

// ══════════════════════════════════════════════════════════════════════
// sb() 헤더 처리
// ══════════════════════════════════════════════════════════════════════
test('sb_secret_ 키 → apikey 만, Authorization 헤더 없음', async () => {
  const ff = captureFetch();
  await H({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: NEW_SECRET }, fetchImpl: ff });
  const h = ff.calls[0].init.headers;
  assert.equal(h.apikey, NEW_SECRET);
  assert.equal(h.Authorization, undefined);
});

test('legacy service_role JWT → apikey + Authorization: Bearer 둘 다', async () => {
  const ff = captureFetch();
  await H({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE }, fetchImpl: ff });
  const h = ff.calls[0].init.headers;
  assert.equal(h.apikey, LEGACY_SERVICE);
  assert.equal(h.Authorization, `Bearer ${LEGACY_SERVICE}`);
});

test('SECRET_KEY 우선: 둘 다 있으면 신규 키로 호출(Bearer 없음)', async () => {
  const ff = captureFetch();
  await H({
    env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: NEW_SECRET, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE },
    fetchImpl: ff,
  });
  const h = ff.calls[0].init.headers;
  assert.equal(h.apikey, NEW_SECRET);
  assert.equal(h.Authorization, undefined);
});

test('sb_publishable_ / anon 키 → sb() 는 호출 전에 거부(throw), fetch 안 함', async () => {
  for (const bad of [NEW_PUBLISHABLE, LEGACY_ANON]) {
    const ff = captureFetch();
    await assert.rejects(
      () => H({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: bad }, fetchImpl: ff }),
      /사용 불가/
    );
    assert.equal(ff.calls.length, 0);
  }
});

test('사용 불가 키 오류에 키 원문·길이 없음 (kind 만)', async () => {
  const secretish = 'sb_publishable_SUPER_SENSITIVE_1234567890';
  try {
    await H({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: secretish }, fetchImpl: captureFetch() });
    assert.fail('throw 했어야 함');
  } catch (e) {
    assert.ok(!e.message.includes('SUPER_SENSITIVE'));
    assert.ok(!e.message.includes(secretish));
    assert.ok(!e.message.includes(String(secretish.length)));
    assert.match(e.message, /kind=new_publishable/);
  }
});

test('URL 끝 슬래시 제거 + /rest/v1 경로', async () => {
  const ff = captureFetch();
  await H({ env: { SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SECRET_KEY: NEW_SECRET }, fetchImpl: ff });
  assert.ok(ff.calls[0].url.startsWith('https://x.supabase.co/rest/v1/feature_flags'));
});

test('URL 없으면 throw (키 노출 없음)', async () => {
  await assert.rejects(
    () => H({ env: { SUPABASE_SECRET_KEY: NEW_SECRET }, fetchImpl: captureFetch() }),
    /SUPABASE_URL/
  );
});

test('HTTP 오류 시 응답 본문만, 키 없음', async () => {
  const ff = captureFetch({ ok: false, status: 401, text: '{"message":"bad"}' });
  try {
    await H({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: NEW_SECRET }, fetchImpl: ff });
    assert.fail();
  } catch (e) {
    assert.match(e.message, /Supabase 401/);
    assert.ok(!e.message.includes(NEW_SECRET));
  }
});

test('count=exact: content-range 파싱', async () => {
  const ff = captureFetch({ contentRange: '0-19/1234' });
  const { count } = await H({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: NEW_SECRET }, fetchImpl: ff }, 'facilities?select=id');
  assert.equal(count, 1234);
});

// ══════════════════════════════════════════════════════════════════════
// haveDb
// ══════════════════════════════════════════════════════════════════════
test('haveDb: URL + 사용가능 키 → true', () => {
  assert.equal(haveDb({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: NEW_SECRET }), true);
  assert.equal(haveDb({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE }), true);
});
test('haveDb: publishable/anon 키 → false', () => {
  assert.equal(haveDb({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: NEW_PUBLISHABLE }), false);
  assert.equal(haveDb({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: LEGACY_ANON }), false);
});
test('haveDb: URL 없음 → false', () => {
  assert.equal(haveDb({ SUPABASE_SECRET_KEY: NEW_SECRET }), false);
});

// ══════════════════════════════════════════════════════════════════════
// Production legacy 회귀 — SERVICE_ROLE_KEY 만 있어도 그대로 동작
// ══════════════════════════════════════════════════════════════════════
test('Production 회귀: SUPABASE_SERVICE_ROLE_KEY(legacy JWT) 만 → apikey+Bearer, haveDb true', async () => {
  const env = { SUPABASE_URL: 'https://prod.supabase.co', SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE };
  assert.equal(haveDb(env), true);
  const ff = captureFetch();
  await H({ env, fetchImpl: ff });
  const h = ff.calls[0].init.headers;
  assert.equal(h.apikey, LEGACY_SERVICE);
  assert.equal(h.Authorization, `Bearer ${LEGACY_SERVICE}`);
  assert.equal(ff.calls[0].url, 'https://prod.supabase.co/rest/v1/feature_flags?select=key');
});

// ══════════════════════════════════════════════════════════════════════
// api/env-check.js
// ══════════════════════════════════════════════════════════════════════
function mkRes() {
  return {
    statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}
const SECRET = 'cron-secret-abc';
const authReq = (query = {}) => ({ headers: { authorization: `Bearer ${SECRET}` }, query });

test('env-check: db_ready = dbPing 결과, 키 원문·변수명 미노출', async () => {
  const h = createHandler({
    env: { CRON_SECRET: SECRET, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: NEW_SECRET },
    dbPing: async () => true,
  });
  const res = mkRes();
  await h(authReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.db_ready, true);
  assert.equal(res.body.supabase_url.configured, true);
  assert.equal(res.body.supabase_server_key.configured, true);
  const blob = JSON.stringify(res.body);
  assert.ok(!blob.includes(NEW_SECRET));
  assert.ok(!/SECRET_KEY|SERVICE_ROLE/.test(blob)); // 어느 변수인지 미노출
  assert.ok(!/prefix|length|len|role/.test(blob));
});

test('env-check: SERVICE_ROLE_KEY fallback 도 configured true', async () => {
  const h = createHandler({
    env: { CRON_SECRET: SECRET, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE },
    dbPing: async () => true,
  });
  const res = mkRes();
  await h(authReq(), res);
  assert.equal(res.body.supabase_server_key.configured, true);
  assert.equal(res.body.db_ready, true);
});

test('env-check: 사용 불가 키 → db_ready false, dbPing 호출 안 함', async () => {
  let pinged = false;
  const h = createHandler({
    env: { CRON_SECRET: SECRET, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: NEW_PUBLISHABLE },
    dbPing: async () => { pinged = true; return true; },
  });
  const res = mkRes();
  await h(authReq(), res);
  assert.equal(res.body.db_ready, false);
  assert.equal(pinged, false);
  assert.equal(res.body.supabase_server_key.configured, true); // 키는 있으나 형식이 부적합
});

test('env-check: dbPing 실패 → db_ready false', async () => {
  const h = createHandler({
    env: { CRON_SECRET: SECRET, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: NEW_SECRET },
    dbPing: async () => false,
  });
  const res = mkRes();
  await h(authReq(), res);
  assert.equal(res.body.db_ready, false);
});

test('env-check: 무인증 → production 404 / 비운영 401', async () => {
  const prod = createHandler({ env: { VERCEL_ENV: 'production', CRON_SECRET: SECRET }, dbPing: async () => true });
  const r1 = mkRes();
  await prod({ headers: {}, query: {} }, r1);
  assert.equal(r1.statusCode, 404);

  const preview = createHandler({ env: { VERCEL_ENV: 'preview', CRON_SECRET: SECRET }, dbPing: async () => true });
  const r2 = mkRes();
  await preview({ headers: {}, query: {} }, r2);
  assert.equal(r2.statusCode, 401);
});

test('env-check: Cache-Control no-store', async () => {
  const h = createHandler({ env: { CRON_SECRET: SECRET, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: NEW_SECRET }, dbPing: async () => true });
  const res = mkRes();
  await h(authReq(), res);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
