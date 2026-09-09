// api/hospital/ingest-control.js — 임시 1B-3B 운영자 화면 안전장치 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHandler,
  decideAvailability,
  mintToken,
  verifyToken,
  internalIngestQuery,
  readPreviewState,
  originDiagnostics,
  originUrlDiagnostics,
  BRANCH_ALIAS_HOST,
  CONFIRM_PHRASE,
  REQUIRED_LIMIT,
  CSRF_TTL_MS,
} from '../../api/hospital/ingest-control.js';
import { EXPECTED_PREVIEW_DB_HOST } from '../../lib/hira/persist.js';
import { createHandler as ingestCreateHandler } from '../../api/hospital/ingest.js';
import { collectHospitals } from '../../lib/hira/collect.js';
import { persistCollected } from '../../lib/hira/persist.js';
import { makeMockClient } from './mockClient.mjs';
import { makeMockSb } from './mockSb.mjs';

const PREVIEW_URL = `https://${EXPECTED_PREVIEW_DB_HOST}`;
const SECRET = 'unit-cron-secret-abc123';
const ORIGIN = `https://${BRANCH_ALIAS_HOST}`;

const baseEnv = (extra = {}) => ({
  VERCEL_ENV: 'preview',
  CRON_SECRET: SECRET,
  HOSPITAL_INGEST_CONTROL: '1',
  HOSPITAL_INGEST_PERSIST: '1',
  SUPABASE_URL: PREVIEW_URL,
  DATA_GO_KR_KEY: 'k',
  ...extra,
});

function mkRes() {
  return {
    statusCode: null, body: null, html: null, ended: false, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(h) { this.html = h; return this; },
    end() { this.ended = true; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
  };
}
const cookiesOf = (res) => {
  const sc = res.headers['Set-Cookie'] || [];
  const arr = Array.isArray(sc) ? sc : [sc];
  const out = {};
  for (const line of arr) {
    const first = String(line).split(';')[0];
    const i = first.indexOf('=');
    out[first.slice(0, i)] = decodeURIComponent(first.slice(i + 1));
  }
  return out;
};
const cookieHeader = (obj) =>
  Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

// 성공적인 적재를 흉내내는 runIngest 스파이 (mock sb 테이블도 채움)
function makeRunIngestSpy(sb, opt = {}) {
  const calls = [];
  const spy = async ({ dryRun }) => {
    calls.push({ dryRun });
    if (dryRun) {
      return { status: 200, body: { ok: true, dryRun: true, dbWrites: 0, stats: { deduped: 3, normalized: 3, apiCalls: 22 }, warnings: [], failures: [], samples: [] } };
    }
    const hosp = sb.tables.facilities.filter((f) => f.domain === 'HOSPITAL').length;
    if (opt.mode === 'idempotent' || hosp >= 3) {
      // 재실행 → 아무 행도 안 늘고 unchanged=3 (ingestion_runs 만 +1)
      sb.tables.ingestion_runs.push({ id: sb.tables.ingestion_runs.length + 1, job: 'hira_hospital_ingest', status: 'ok' });
      return { status: 200, body: { ok: true, dryRun: false, runId: sb.tables.ingestion_runs.length, persistStatus: 'ok', persisted: { new: 0, updated: 0, unchanged: 3, partial: 0, failed: 0 }, failures: [] } };
    }
    if (opt.mode === 'partial') {
      sb.tables.facilities.push({ id: 'H-p1', domain: 'HOSPITAL', name: 'x' });
      return { status: 200, body: { ok: true, dryRun: false, runId: 9, persistStatus: 'partial', persisted: { new: 1, updated: 0, unchanged: 0, partial: 2, failed: 0 }, failures: [{ ykiho: '***', reason: 'x' }] } };
    }
    if (opt.mode === 'throw') throw new Error('boom');
    if (opt.mode === 'list_fail') {
      // 내부 /api/hospital/ingest 가 목록 첫 페이지 실패로 502 반환 (DB write 0)
      return {
        status: 502,
        body: {
          error: 'ingest_failed', dryRun: false, reason: 'list_fetch_failed',
          failureKind: opt.failureKind ?? 'dns',
          attemptSummary: opt.attemptSummary ?? { dns: 2, timeout: 1 },
          elapsedBucket: opt.elapsedBucket ?? '5s_15s',
          attempts: 3, op: 'getHospBasisList',
        },
      };
    }
    for (let i = 1; i <= 3; i++) {
      sb.tables.facilities.push({ id: `H-ok${i}`, domain: 'HOSPITAL', name: `h${i}` });
      sb.tables.hospital_profiles.push({ facility_id: `H-ok${i}` });
      sb.tables.facility_sources.push({ id: i, source_system: 'hira_hospital_ingest', external_id: `e${i}`, normalized_hash: `h${i}` });
    }
    sb.tables.ingestion_runs.push({ id: 1, job: 'hira_hospital_ingest', status: 'ok' });
    return { status: 200, body: { ok: true, dryRun: false, runId: 1, persistStatus: 'ok', persisted: { new: 3, updated: 0, unchanged: 0, partial: 0, failed: 0 }, failures: [] } };
  };
  spy.calls = calls;
  return spy;
}

// Vercel 프록시가 same-origin form POST 에 붙이는 헤더 조합 (실측 기준)
const vercelPostHeaders = (over = {}) => {
  const h = {
    host: BRANCH_ALIAS_HOST,
    'x-forwarded-host': BRANCH_ALIAS_HOST,
    'x-forwarded-proto': 'https',
    origin: ORIGIN,
    referer: `${ORIGIN}/api/hospital/ingest-control`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  return h;
};

async function getThenPost(handler, {
  sb, step, confirm, tamper = {}, extraCookies = {}, omitCsrf = false,
  headers, headerOverrides = {}, query = {},
}) {
  const g = mkRes();
  await handler({ method: 'GET', headers: { host: BRANCH_ALIAS_HOST, 'sec-fetch-site': 'none' } }, g);
  const ck = cookiesOf(g);
  const csrf = ck['__Host-ic_csrf'];
  const jar = { ...ck, ...extraCookies };
  if (omitCsrf) delete jar['__Host-ic_csrf'];
  const body = { step, ...(confirm !== undefined ? { confirm } : {}) };
  if (!omitCsrf) body.csrf = tamper.csrf !== undefined ? tamper.csrf : csrf;
  const p = mkRes();
  const postHeaders = headers || vercelPostHeaders(headerOverrides);
  await handler({
    method: 'POST',
    headers: { ...postHeaders, cookie: cookieHeader(jar) },
    body: { ...body, ...query },
    query,
  }, p);
  return { get: g, post: p, csrf, jar };
}
const flashOf = (res) => {
  const c = cookiesOf(res)['__Host-ic_flash'];
  if (!c) return null;
  const p = c.split('.')[0];
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
};

// ══════════════════════════════════════════════════════════════════
// 토큰
// ══════════════════════════════════════════════════════════════════
test('mintToken/verifyToken: 정상·변조·만료·kind불일치·다른시크릿', () => {
  const t0 = 1_000_000_000_000;
  const tok = mintToken(SECRET, 'csrf', t0);
  assert.equal(verifyToken(SECRET, 'csrf', tok, t0), true);
  assert.equal(verifyToken(SECRET, 'csrf', tok, t0 + CSRF_TTL_MS + 1), false); // 만료
  assert.equal(verifyToken(SECRET, 'dryrun', tok, t0), false);                 // kind
  assert.equal(verifyToken('other', 'csrf', tok, t0), false);                  // 시크릿
  assert.equal(verifyToken(SECRET, 'csrf', `${tok}x`, t0), false);             // 변조
  assert.equal(verifyToken(SECRET, 'csrf', '', t0), false);
  assert.equal(verifyToken(SECRET, 'csrf', 'a.b.c', t0), false);
});

test('internalIngestQuery: limit 3 고정, ② = readiness / ③ = full', () => {
  assert.deepEqual(internalIngestQuery(true), { limit: '3', readiness: '1' });
  assert.deepEqual(internalIngestQuery(false), { dryRun: 'false', limit: '3' });
  assert.equal(REQUIRED_LIMIT, 3);
});

// ══════════════════════════════════════════════════════════════════
// decideAvailability
// ══════════════════════════════════════════════════════════════════
const cleanState = (extra = {}) => ({
  destOk: true, guardOk: true, schemaOk: true, persistEnabled: true,
  hospitalModule: false, ltcCount: 0, hospitalCount: 0, ...extra,
});

test('decideAvailability: 깨끗+HOSPITAL0 → dryrun/ingest 가능, idempotency 불가', () => {
  const a = decideAvailability(cleanState());
  assert.equal(a.hardBlock, false);
  assert.equal(a.ready, true);
  assert.equal(a.ingest, true);
  assert.equal(a.idempotency, false);
});
test('decideAvailability: HOSPITAL=3 → idempotency 만', () => {
  const a = decideAvailability(cleanState({ hospitalCount: 3 }));
  assert.equal(a.ready, false);
  assert.equal(a.ingest, false);
  assert.equal(a.idempotency, true);
});
test('decideAvailability: HOSPITAL>3 → 전부 차단', () => {
  const a = decideAvailability(cleanState({ hospitalCount: 4 }));
  assert.equal(a.overfilled, true);
  assert.equal(a.hardBlock, true);
  assert.equal(a.ready || a.ingest || a.idempotency, false);
});
test('decideAvailability: HOSPITAL=1,2 (부분) → 전부 차단', () => {
  for (const n of [1, 2]) {
    const a = decideAvailability(cleanState({ hospitalCount: n }));
    assert.equal(a.ready || a.ingest || a.idempotency, false, `n=${n}`);
  }
});
test('decideAvailability: LTC>0 / flag ON / wrongDB / schema / persist off → hardBlock', () => {
  for (const bad of [
    { ltcCount: 1 }, { hospitalModule: true }, { destOk: false },
    { guardOk: false }, { schemaOk: false }, { persistEnabled: false },
    { ltcCount: null }, { hospitalCount: null },
  ]) {
    assert.equal(decideAvailability(cleanState(bad)).hardBlock, true, JSON.stringify(bad));
  }
});

// ══════════════════════════════════════════════════════════════════
// 핸들러 게이트: production / control env / host / method
// ══════════════════════════════════════════════════════════════════
test('production → 404 (그 외 아무 것도 안 함)', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const res = mkRes();
  await createHandler({ env: baseEnv({ VERCEL_ENV: 'production' }), sb, runIngest: spy })(
    { method: 'GET', headers: { host: BRANCH_ALIAS_HOST } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(sb.calls.length, 0);
  assert.equal(spy.calls.length, 0);
});

test('HOSPITAL_INGEST_CONTROL 없음 → 404', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({ env: baseEnv({ HOSPITAL_INGEST_CONTROL: undefined }), sb, runIngest: makeRunIngestSpy(sb) })(
    { method: 'GET', headers: { host: BRANCH_ALIAS_HOST } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(sb.calls.length, 0);
});

test('CRON_SECRET 없음 → 503 (CSRF 불가)', async () => {
  const res = mkRes();
  await createHandler({ env: baseEnv({ CRON_SECRET: '' }), sb: makeMockSb(), runIngest: async () => ({}) })(
    { method: 'GET', headers: { host: BRANCH_ALIAS_HOST } }, res);
  assert.equal(res.statusCode, 503);
});

test('잘못된 Host → 403 (정확 일치, 부분문자열 불가)', async () => {
  const sb = makeMockSb();
  for (const host of [
    'evil.com',
    `${BRANCH_ALIAS_HOST}.evil.example`,
    `evil.${BRANCH_ALIAS_HOST}`,
    `${BRANCH_ALIAS_HOST}x`,
    '120lifehomes.com',
    '120lifehomes-git-feature-hospital-hira-adapter-120lifehomes.vercel.app:443',
  ]) {
    const res = mkRes();
    await createHandler({ env: baseEnv(), sb, runIngest: makeRunIngestSpy(sb) })(
      { method: 'GET', headers: { host } }, res);
    assert.equal(res.statusCode, 403, host);
  }
  assert.equal(sb.calls.length, 0);
});

test('PUT/DELETE → 405', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({ env: baseEnv(), sb, runIngest: makeRunIngestSpy(sb) })(
    { method: 'PUT', headers: { host: BRANCH_ALIAS_HOST } }, res);
  assert.equal(res.statusCode, 405);
});

// ══════════════════════════════════════════════════════════════════
// GET: 읽기 전용
// ══════════════════════════════════════════════════════════════════
test('GET → 200 HTML, sb 는 GET 만, runIngest 미호출, 보안 헤더', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const res = mkRes();
  await createHandler({ env: baseEnv(), sb, runIngest: spy })(
    { method: 'GET', headers: { host: BRANCH_ALIAS_HOST } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.html, /<!doctype html>/i);
  assert.equal(spy.calls.length, 0);
  assert.ok(sb.calls.length > 0);
  assert.ok(sb.calls.every((c) => c.method === 'GET'), 'GET 외 호출 존재');
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');
  assert.match(res.headers['X-Robots-Tag'], /noindex/);
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(res.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.doesNotMatch(res.headers['Content-Security-Policy'], /unsafe-inline/);
  const ck = cookiesOf(res);
  assert.ok(ck['__Host-ic_csrf']);
  const raw = (res.headers['Set-Cookie'] || []).join(' ');
  assert.match(raw, /__Host-ic_csrf=[^;]+;.*Secure/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
});

test('보안 헤더가 same-origin form POST 의 Origin 을 죽이지 않는 구성인지 (sandbox 없음 / no-referrer 아님)', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({ env: baseEnv(), sb, runIngest: makeRunIngestSpy(sb) })(
    { method: 'GET', headers: { host: BRANCH_ALIAS_HOST } }, res);
  const csp = res.headers['Content-Security-Policy'];
  // CSP sandbox → 문서 opaque origin → form POST Origin:null. 절대 금지.
  assert.equal(/\bsandbox\b/.test(csp), false, 'CSP 에 sandbox 지시어');
  // Referrer-Policy: no-referrer → Fetch 표준상 non-CORS form POST 의 Origin 을 null 로 만든다.
  assert.notEqual(res.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(res.headers['Referrer-Policy'], 'same-origin');
  // 유지돼야 하는 방어선
  for (const d of [
    "default-src 'none'", "base-uri 'none'", "form-action 'self'",
    "frame-ancestors 'none'", "script-src 'nonce-", "style-src 'nonce-",
  ]) assert.ok(csp.includes(d), `CSP 누락: ${d}`);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');
  assert.match(res.headers['X-Robots-Tag'], /noindex/);
});

test('Origin:null 은 여전히 403 forbidden_origin (수정이 게이트를 완화하지 않음)', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'precheck', headerOverrides: { origin: 'null' } });
  assert.equal(post.body.error, 'forbidden_origin');
  assert.equal(post.body.diagnostics.origin_is_literal_null, true);
  assert.equal(spy.calls.length, 0);
});

test('정확한 Origin + Sec-Fetch-Site same-origin + 정확한 Host → 통과 (302, 실행)', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'ready' }); // vercelPostHeaders = 정확한 Origin/Host/SFS
  assert.equal(post.statusCode, 302);
  assert.equal(spy.calls.length, 0);
});

test('GET HTML·쿠키에 비밀·토큰원문·URL 노출 없음', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({ env: baseEnv(), sb, runIngest: makeRunIngestSpy(sb) })(
    { method: 'GET', headers: { host: BRANCH_ALIAS_HOST } }, res);
  assert.equal(res.html.includes(SECRET), false);
  assert.equal(res.html.includes(EXPECTED_PREVIEW_DB_HOST), false);
  assert.equal(res.html.includes('supabase'), false);
  assert.equal(res.html.includes('DATA_GO_KR_KEY'), false);
  assert.equal(/CRON_SECRET/.test(res.html), false);
});

// ══════════════════════════════════════════════════════════════════
// POST: Origin / CSRF
// ══════════════════════════════════════════════════════════════════
test('POST 잘못된 Origin → 403 forbidden_origin, 실행 없음, boolean 진단만', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'ready', headerOverrides: { origin: 'https://evil.example' } });
  assert.equal(post.statusCode, 403);
  assert.equal(post.body.error, 'forbidden_origin');
  assert.equal(spy.calls.length, 0);
  // 진단은 boolean 만, 원본 URL 없음
  const d = post.body.diagnostics;
  assert.equal(typeof d, 'object');
  for (const v of Object.values(d)) assert.equal(typeof v, 'boolean');
  assert.equal(d.origin_present, true);
  assert.equal(d.origin_exact_match, false);
  assert.equal(d.host_exact_match, true);
  assert.equal(JSON.stringify(post.body).includes('evil.example'), false);
});

test('POST 유사 도메인 Origin / forwarded-host → 403 forbidden_origin', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  for (const origin of [
    `${ORIGIN}.evil.example`,
    `https://evil.${BRANCH_ALIAS_HOST}`,
    `${ORIGIN}x`,
    `http://${BRANCH_ALIAS_HOST}`,
    'null',
  ]) {
    const { post } = await getThenPost(h, { sb, step: 'ready', headerOverrides: { origin } });
    assert.equal(post.body.error, 'forbidden_origin', origin);
    assert.equal(post.body.diagnostics.origin_exact_match, false);
  }
  assert.equal(spy.calls.length, 0);
});

test('POST Origin 누락 / Sec-Fetch-Site 누락·cross-site → 403 forbidden_origin (누락 허용 안 함)', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });

  const noOrigin = await getThenPost(h, { sb, step: 'ready', headerOverrides: { origin: undefined } });
  assert.equal(noOrigin.post.body.error, 'forbidden_origin');
  assert.equal(noOrigin.post.body.diagnostics.origin_present, false);

  const noSfs = await getThenPost(h, { sb, step: 'ready', headerOverrides: { 'sec-fetch-site': undefined } });
  assert.equal(noSfs.post.body.error, 'forbidden_origin');
  assert.equal(noSfs.post.body.diagnostics.sec_fetch_site_same_origin, false);

  const crossSite = await getThenPost(h, { sb, step: 'ready', headerOverrides: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } });
  assert.equal(crossSite.post.body.error, 'forbidden_origin');

  assert.equal(spy.calls.length, 0);
});

test('POST Referer 만 맞고 Origin 틀림 → 여전히 차단 (Referer 로 대체 안 함)', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, {
    sb, step: 'ready',
    headerOverrides: { origin: undefined, referer: `${ORIGIN}/api/hospital/ingest-control` },
  });
  assert.equal(post.body.error, 'forbidden_origin');
  assert.equal(post.body.diagnostics.referer_exact_origin, true);
  assert.equal(post.body.diagnostics.origin_present, false);
  assert.equal(spy.calls.length, 0);
});

test('POST 정상 Vercel 프록시 헤더(Origin + forwarded-host + Sec-Fetch-Site) → 통과', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'ready' });
  assert.equal(post.statusCode, 302); // forbidden_origin 아님
  assert.equal(spy.calls.length, 0);
});

test('GET 잘못된 Host → 403 forbidden_host + boolean 진단', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const res = mkRes();
  await createHandler({ env: baseEnv(), sb, runIngest: spy })(
    { method: 'GET', headers: { host: `${BRANCH_ALIAS_HOST}.evil.example`, 'x-forwarded-host': `${BRANCH_ALIAS_HOST}.evil.example` } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'forbidden_host');
  for (const v of Object.values(res.body.diagnostics)) assert.equal(typeof v, 'boolean');
  assert.equal(res.body.diagnostics.host_exact_match, false);
  assert.equal(res.body.diagnostics.forwarded_host_exact_match, false);
  assert.equal(JSON.stringify(res.body).includes('evil.example'), false);
  assert.equal(sb.calls.length, 0);
  assert.equal(spy.calls.length, 0);
});

test('originDiagnostics: boolean 만, 원본 값 없음', () => {
  const d = originDiagnostics({
    method: 'POST',
    headers: {
      host: BRANCH_ALIAS_HOST, 'x-forwarded-host': BRANCH_ALIAS_HOST,
      origin: ORIGIN, referer: `${ORIGIN}/x`, 'sec-fetch-site': 'same-origin',
    },
  });
  for (const v of Object.values(d)) assert.equal(typeof v, 'boolean');
  assert.equal(d.host_exact_match, true);
  assert.equal(d.origin_exact_match, true);
  assert.equal(d.origin_matches_https_host_after_safe_url_normalization, true);
  const empty = originDiagnostics({});
  for (const v of Object.values(empty)) assert.equal(typeof v, 'boolean');
  assert.equal(empty.origin_present, false);
  assert.equal(empty.origin_is_literal_null, false);
});

// ── originUrlDiagnostics — Origin 헤더 new URL() 분해 (원본 미노출) ──
test('originUrlDiagnostics: 정상 Origin → 전 구성요소 통과', () => {
  const d = originUrlDiagnostics(ORIGIN);
  assert.deepEqual(d, {
    origin_is_literal_null: false,
    origin_parseable: true,
    origin_protocol_https: true,
    origin_hostname_exact: true,
    origin_port_empty: true,
    origin_username_empty: true,
    origin_password_empty: true,
    origin_path_root_or_empty: true,
    origin_query_empty: true,
    origin_hash_empty: true,
    origin_matches_https_host_after_safe_url_normalization: true,
  });
});

test('originUrlDiagnostics: literal "null" → origin_is_literal_null, 파싱 불가', () => {
  const d = originUrlDiagnostics('null');
  assert.equal(d.origin_is_literal_null, true);
  assert.equal(d.origin_parseable, false);
  assert.equal(d.origin_matches_https_host_after_safe_url_normalization, false);
});

test('originUrlDiagnostics: 빈/미상 → 전부 false (literal null 아님)', () => {
  for (const v of ['', undefined, null, 42, {}]) {
    const d = originUrlDiagnostics(v);
    assert.equal(d.origin_is_literal_null, false);
    assert.equal(d.origin_parseable, false);
    assert.equal(d.origin_matches_https_host_after_safe_url_normalization, false);
  }
});

test('originUrlDiagnostics: http / 다른 host / port / 인증정보 / path → 각 boolean 으로 구분', () => {
  const http = originUrlDiagnostics(`http://${BRANCH_ALIAS_HOST}`);
  assert.equal(http.origin_parseable, true);
  assert.equal(http.origin_protocol_https, false);
  assert.equal(http.origin_matches_https_host_after_safe_url_normalization, false);

  const evil = originUrlDiagnostics('https://evil.example');
  assert.equal(evil.origin_hostname_exact, false);
  assert.equal(evil.origin_matches_https_host_after_safe_url_normalization, false);

  const port = originUrlDiagnostics(`https://${BRANCH_ALIAS_HOST}:8443`);
  assert.equal(port.origin_port_empty, false);
  assert.equal(port.origin_matches_https_host_after_safe_url_normalization, false);

  const auth = originUrlDiagnostics(`https://u:p@${BRANCH_ALIAS_HOST}`);
  assert.equal(auth.origin_username_empty, false);
  assert.equal(auth.origin_password_empty, false);

  const sub = originUrlDiagnostics(`https://${BRANCH_ALIAS_HOST}.evil.example`);
  assert.equal(sub.origin_hostname_exact, false);
});

test('forbidden_origin 진단에 Origin URL 분해 boolean 포함 (원본 문자열 없음)', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });

  // literal null (opaque origin 시뮬레이션)
  const nul = await getThenPost(h, { sb, step: 'precheck', headerOverrides: { origin: 'null' } });
  assert.equal(nul.post.body.error, 'forbidden_origin');
  assert.equal(nul.post.body.diagnostics.origin_is_literal_null, true);
  assert.equal(nul.post.body.diagnostics.origin_parseable, false);
  assert.equal(nul.post.body.diagnostics.sec_fetch_site_same_origin, true);
  assert.equal(nul.post.body.diagnostics.host_exact_match, true);
  assert.equal(nul.post.body.diagnostics.origin_matches_https_host_after_safe_url_normalization, false);
  for (const v of Object.values(nul.post.body.diagnostics)) assert.equal(typeof v, 'boolean');

  // 다른 호스트
  const other = await getThenPost(h, { sb, step: 'precheck', headerOverrides: { origin: 'https://preview-abc123.vercel.app' } });
  assert.equal(other.post.body.diagnostics.origin_is_literal_null, false);
  assert.equal(other.post.body.diagnostics.origin_parseable, true);
  assert.equal(other.post.body.diagnostics.origin_hostname_exact, false);
  assert.equal(JSON.stringify(other.post.body).includes('preview-abc123'), false);

  assert.equal(spy.calls.length, 0);
});

test('POST CSRF 누락 / 변조 / 쿠키불일치 → 403, 실행 없음', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });

  const a = await getThenPost(h, { sb, step: 'ready', omitCsrf: true });
  assert.equal(a.post.statusCode, 403);

  const b = await getThenPost(h, { sb, step: 'ready', tamper: { csrf: 'garbage.token.here' } });
  assert.equal(b.post.statusCode, 403);

  // form 토큰은 유효하지만 쿠키가 다른 값
  const c = await getThenPost(h, { sb, step: 'ready', extraCookies: { '__Host-ic_csrf': mintToken(SECRET, 'csrf') } });
  assert.equal(c.post.statusCode, 403);

  assert.equal(spy.calls.length, 0);
});

test('POST CSRF 만료 → 403', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  let clock = 1_700_000_000_000;
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy, now: () => clock });
  const g = mkRes();
  await h({ method: 'GET', headers: { host: BRANCH_ALIAS_HOST } }, g);
  const ck = cookiesOf(g);
  clock += CSRF_TTL_MS + 5000; // 만료
  const p = mkRes();
  await h({
    method: 'POST',
    headers: {
      host: BRANCH_ALIAS_HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin',
      cookie: cookieHeader(ck),
    },
    body: { step: 'ready', csrf: ck['__Host-ic_csrf'] },
  }, p);
  assert.equal(p.statusCode, 403);
  assert.equal(p.body.error, 'csrf'); // Origin 은 통과, CSRF 만료로 차단
  assert.equal(spy.calls.length, 0);
});

test('bad step → 400', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: makeRunIngestSpy(sb) });
  const { post } = await getThenPost(h, { sb, step: 'DROP TABLE' });
  assert.equal(post.statusCode, 400);
});

// ══════════════════════════════════════════════════════════════════
// 단계 흐름
// ══════════════════════════════════════════════════════════════════
test('② 적재 승인: 깨끗한 DB → 302 + flash ok, HIRA 0/DB write 0, __Host-ic_dr 발급', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'ready' });
  assert.equal(post.statusCode, 302);
  assert.equal(post.headers['Location'], '/api/hospital/ingest-control');
  assert.equal(spy.calls.length, 0);            // ② 는 runIngest(HIRA collect) 호출 안 함
  const fl = flashOf(post);
  assert.equal(fl.ok, true);
  assert.equal(fl.step, 'ready');
  assert.equal(fl.detail.hiraCalls, 0);
  assert.equal(fl.detail.dbWrites, 0);
  assert.equal(fl.detail.hospitalCount, 0);
  assert.equal(fl.detail.hospitalModule, false);
  assert.ok(cookiesOf(post)['__Host-ic_dr']);
  assert.equal(sb.tables.facilities.length, 0);
  assert.ok(sb.calls.every((c) => c.method === 'GET')); // ② 도 읽기 전용
});

test('③ ingest: dry-run 쿠키 없음 → 차단(need_approval), 실행 없음', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'ingest', confirm: CONFIRM_PHRASE });
  assert.equal(post.statusCode, 302);
  const fl = flashOf(post);
  assert.equal(fl.ok, false);
  assert.equal(fl.code, 'need_approval');
  assert.equal(spy.calls.length, 0);
});

test('③ ingest: 확인문구 없음/오타 → 차단(need_confirm), 실행 없음', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const drCookie = { '__Host-ic_dr': mintToken(SECRET, 'dryrun') };
  for (const confirm of [undefined, 'preview-3', 'PREVIEW-4', '']) {
    const { post } = await getThenPost(h, { sb, step: 'ingest', confirm, extraCookies: drCookie });
    const fl = flashOf(post);
    assert.equal(fl.code, 'need_confirm', `confirm=${confirm}`);
  }
  assert.equal(spy.calls.length, 0);
});

test('③ ingest: dry-run 쿠키 + 확인문구 + HOSPITAL=0 → 1회 실행, persisted.new=3, HOSPITAL=3', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  assert.equal(post.statusCode, 302);
  assert.deepEqual(spy.calls, [{ dryRun: false }]);
  const fl = flashOf(post);
  assert.equal(fl.ok, true);
  assert.equal(fl.detail.persisted.new, 3);
  assert.equal(fl.detail.hospitalCountAfter, 3);
  // dry-run 쿠키 소거됨
  assert.equal(cookiesOf(post)['__Host-ic_dr'], '');
});

test('③ ingest: HOSPITAL 이미 3 → 차단(hospital_not_zero), 실행 없음', async () => {
  const sb = makeMockSb({ facilities: [
    { id: 'H-a', domain: 'HOSPITAL' }, { id: 'H-b', domain: 'HOSPITAL' }, { id: 'H-c', domain: 'HOSPITAL' },
  ] });
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const fl = flashOf(post);
  assert.equal(fl.ok, false);
  assert.equal(fl.code, 'hospital_not_zero');
  assert.equal(spy.calls.length, 0);
});

test('limit/dryRun query 조작 무시 — ② 는 게이트만, runIngest 미호출', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, {
    sb, step: 'ready', query: { limit: '999', dryRun: 'false', readiness: '0' },
  });
  assert.equal(spy.calls.length, 0);
  assert.equal(flashOf(post).ok, true);
});

test('③ ingest: 내부 호출 query 는 항상 { dryRun:false, limit:3 } (internalIngestQuery)', () => {
  assert.deepEqual(internalIngestQuery(false), { dryRun: 'false', limit: '3' });
});

test('④ idempotency: HOSPITAL=3 + 확인문구 → 1회 재실행, unchanged=3, 행 증가 없음(runs 제외)', async () => {
  const sb = makeMockSb({
    facilities: [{ id: 'H-a', domain: 'HOSPITAL' }, { id: 'H-b', domain: 'HOSPITAL' }, { id: 'H-c', domain: 'HOSPITAL' }],
    hospital_profiles: [{ facility_id: 'H-a' }, { facility_id: 'H-b' }, { facility_id: 'H-c' }],
    facility_sources: [{ id: 1, source_system: 'x', external_id: 'a' }, { id: 2, source_system: 'x', external_id: 'b' }, { id: 3, source_system: 'x', external_id: 'c' }],
    facility_evaluations: [{ id: 1 }, { id: 2 }],
    ingestion_runs: [{ id: 1 }],
  });
  const spy = makeRunIngestSpy(sb, { mode: 'idempotent' });
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'idempotency', confirm: CONFIRM_PHRASE });
  assert.equal(post.statusCode, 302);
  assert.deepEqual(spy.calls, [{ dryRun: false }]);
  const fl = flashOf(post);
  assert.equal(fl.ok, true);
  assert.equal(fl.detail.persisted.unchanged, 3);
  assert.equal(fl.detail.rowDelta.hospital, 0);
  assert.equal(fl.detail.rowDelta.profiles, 0);
  assert.equal(fl.detail.rowDelta.sources, 0);
  assert.equal(fl.detail.rowDelta.evaluations, 0);
  assert.equal(fl.detail.rowDelta.revisions, 0);
});

test('④ idempotency: HOSPITAL=0 → 차단(hospital_not_three)', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'idempotency', confirm: CONFIRM_PHRASE });
  assert.equal(flashOf(post).code, 'hospital_not_three');
  assert.equal(spy.calls.length, 0);
});

// ══════════════════════════════════════════════════════════════════
// hardBlock 상태들
// ══════════════════════════════════════════════════════════════════
test('wrong DB / LTC 존재 / hospital_module ON → 모든 실행 차단, DB 접속 최소', async () => {
  // wrong DB
  {
    const sb = makeMockSb();
    const spy = makeRunIngestSpy(sb);
    const h = createHandler({ env: baseEnv({ SUPABASE_URL: 'https://wdjqtynpqpzgiuzvphdr.supabase.co' }), sb, runIngest: spy });
    const { post } = await getThenPost(h, { sb, step: 'ready' });
    assert.equal(flashOf(post).ok, false);
    assert.match(flashOf(post).code, /hard_block/);
    assert.equal(spy.calls.length, 0);
    assert.equal(sb.calls.length, 0); // 목적지 틀리면 접속 0
  }
  // LTC 존재
  {
    const sb = makeMockSb({ facilities: [{ id: 'x', domain: 'LTC' }] });
    const spy = makeRunIngestSpy(sb);
    const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
    const { post } = await getThenPost(h, { sb, step: 'ingest', confirm: CONFIRM_PHRASE, extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') } });
    assert.equal(flashOf(post).ok, false);
    assert.equal(spy.calls.length, 0);
  }
  // hospital_module ON
  {
    const sb = makeMockSb({ feature_flags: [{ key: 'hospital_module', enabled: true }] });
    const spy = makeRunIngestSpy(sb);
    const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
    const { post } = await getThenPost(h, { sb, step: 'ready' });
    assert.equal(flashOf(post).ok, false);
    assert.equal(spy.calls.length, 0);
  }
});

test('persist 활성 아님(HOSPITAL_INGEST_PERSIST≠1) → dryrun/ingest 차단', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv({ HOSPITAL_INGEST_PERSIST: '0' }), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'ready' });
  assert.equal(flashOf(post).ok, false);
  assert.equal(spy.calls.length, 0);
});

test('① precheck: 항상 실행 가능, DB write 0, flash 에 URL·키 없음', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'precheck' });
  assert.equal(post.statusCode, 302);
  assert.equal(spy.calls.length, 0);
  assert.ok(sb.calls.every((c) => c.method === 'GET'));
  const fl = flashOf(post);
  const blob = JSON.stringify(fl);
  assert.equal(/supabase|wdjq|sojxq|https?:|apikey|Bearer|eyJ/.test(blob), false);
  assert.equal(blob.includes(SECRET), false);
});

test('ingest 실행 중 예외 → 자동 재시도 없음(runIngest 정확히 1회), flash 실패', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb, { mode: 'throw' });
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  assert.equal(spy.calls.length, 1);
  assert.equal(flashOf(post).ok, false);
  assert.equal(flashOf(post).code, 'ingest_error');
});

test('③ ingest: 내부 502 list_fetch_failed → flash 에 failureKind/attemptSummary/elapsedBucket (allowlist), 원문·키 없음', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb, {
    mode: 'list_fail', failureKind: 'dns',
    attemptSummary: { dns: 2, timeout: 1 }, elapsedBucket: '15s_30s',
  });
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  assert.equal(spy.calls.length, 1);
  const fl = flashOf(post);
  assert.equal(fl.ok, false);
  assert.equal(fl.code, 'ingest_failed');
  assert.equal(fl.detail.reason, 'list_fetch_failed');
  assert.equal(fl.detail.failureKind, 'dns');
  assert.deepEqual(fl.detail.attemptSummary, { dns: 2, timeout: 1 });
  assert.equal(fl.detail.elapsedBucket, '15s_30s');
  assert.equal(fl.detail.hospitalCountAfter, 0);
  // DB write 0
  assert.equal(sb.tables.facilities.length, 0);
  assert.equal(sb.tables.ingestion_runs.length, 0);
  // 비밀·엔드포인트·원문 없음
  const blob = JSON.stringify(fl);
  assert.equal(/supabase|https?:|apis\.data\.go\.kr|serviceKey|Bearer|eyJ|ykiho/i.test(blob), false);
  assert.equal(blob.includes(SECRET), false);
});

test('③ ingest: 내부가 allowlist 밖 failureKind 를 보내도 flash 에는 안 실림(null)', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb, {
    mode: 'list_fail', failureKind: 'ENOTFOUND apis.data.go.kr serviceKey=xyz',
    attemptSummary: { evil: 3, 'apis.data.go.kr': 1 }, elapsedBucket: '4123ms',
  });
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const fl = flashOf(post);
  assert.equal(fl.detail.failureKind, null);      // allowlist 밖 → 버림
  assert.equal(fl.detail.attemptSummary, null);   // allowlist 밖 키 → 전부 탈락
  assert.equal(fl.detail.elapsedBucket, null);    // 구간값 아님 → 버림
  const blob = JSON.stringify(fl);
  assert.equal(/apis\.data\.go\.kr|serviceKey|ENOTFOUND/i.test(blob), false);
});

test('ingest 부분 적재(HOSPITAL=1) → 실패 표시 + 이후 GET 에서 모든 단계 차단', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb, { mode: 'partial' });
  const h = createHandler({ env: baseEnv(), sb, runIngest: spy });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  assert.equal(flashOf(post).ok, false);
  assert.equal(flashOf(post).detail.hospitalCountAfter, 1);
  // 이후 상태
  const g = mkRes();
  await h({ method: 'GET', headers: { host: BRANCH_ALIAS_HOST } }, g);
  assert.match(g.html, /비정상 상태/);
});

test('CSRF 쿠키는 POST 처리 후 만료된다', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: makeRunIngestSpy(sb) });
  const { post } = await getThenPost(h, { sb, step: 'precheck' });
  const raw = (post.headers['Set-Cookie'] || []).join(' ');
  assert.match(raw, /__Host-ic_csrf=;[^,]*Max-Age=0/);
});

test('readPreviewState: wrong DB → sb 접속 0, destOk=false', async () => {
  const sb = makeMockSb();
  const s = await readPreviewState({ sb, env: baseEnv({ SUPABASE_URL: 'https://evil.example' }) });
  assert.equal(s.destOk, false);
  assert.equal(sb.calls.length, 0);
});

// ══════════════════════════════════════════════════════════════════
// 통합: control POST → 실제 ingest.js → 실제 collect(mock HIRA) → 실제 persist → mockSb
// 1B-3B "시설 0건" 사고 회귀 고정
// ══════════════════════════════════════════════════════════════════
const fastCollect = (client, o) =>
  collectHospitals(client, { ...o, sleepImpl: async () => {}, randomImpl: () => 0 });

function realRunIngest(sb, clientOpt = { listTotal: 3 }, over = {}) {
  return async ({ dryRun }) => {
    const handler = ingestCreateHandler({
      env: baseEnv(),
      createClient: () => makeMockClient(clientOpt),
      collect: fastCollect,
      persist: persistCollected,
      sbImpl: sb,
      assertDb: async () => ({ ok: true }),
      ...over,
    });
    const cap = { status: 200, body: null };
    await handler(
      {
        headers: { authorization: `Bearer ${SECRET}` },
        query: internalIngestQuery(dryRun), // ② = readiness(목록만), ③ = full collect
      },
      { status(c) { cap.status = c; return this; }, json(b) { cap.body = b; return this; }, setHeader() {} }
    );
    return cap;
  };
}

test('통합 ③: control ingest → ingest.js → collect(mock 3) → persist → mockSb : new 3, HOSPITAL 3, flash ok', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb) });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  assert.equal(post.statusCode, 302);
  const fl = flashOf(post);
  assert.equal(fl.ok, true);
  assert.equal(fl.detail.persisted.new, 3);
  assert.equal(fl.detail.persistInputCount, 3);
  assert.equal(fl.detail.hospitalCountAfter, 3);
  assert.equal(sb.tables.facilities.filter((f) => f.domain === 'HOSPITAL').length, 3);
  assert.equal(sb.tables.hospital_profiles.length, 3);
});

test('통합 ③: collect 2건(기대 3) → flash 실패 collect_count_mismatch, 시설 0', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb, { listTotal: 2 }) });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const fl = flashOf(post);
  assert.equal(fl.ok, false);
  assert.equal(fl.code, 'collect_count_mismatch');
  assert.equal(sb.tables.facilities.length, 0);
});

test('통합 ④: 적재 3 후 재실행 → flash ok, unchanged 3, HOSPITAL 3 유지, 로그만 +1', async () => {
  const sb = makeMockSb();
  // ③ 적재
  await getThenPost(
    createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb) }),
    { sb, step: 'ingest', confirm: CONFIRM_PHRASE, extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') } }
  );
  assert.equal(sb.tables.facilities.filter((f) => f.domain === 'HOSPITAL').length, 3);
  const runsBefore = sb.tables.ingestion_runs.length;

  // ④ 멱등성
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb) });
  const { post } = await getThenPost(h, { sb, step: 'idempotency', confirm: CONFIRM_PHRASE });
  const fl = flashOf(post);
  assert.equal(fl.ok, true);
  assert.equal(fl.detail.persisted.unchanged, 3);
  assert.equal(fl.detail.persisted.new, 0);
  assert.equal(fl.detail.rowDelta.hospital, 0);
  assert.equal(fl.detail.rowDelta.profiles, 0);
  assert.equal(fl.detail.rowDelta.sources, 0);
  assert.equal(sb.tables.ingestion_runs.length, runsBefore + 1);
});

test('통합 ③: HIRA 목록 3회 모두 0건 → flash 실패(transient_empty_page_exhausted 노출), persist 미호출, 시설 0', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb, { listTotal: 3, listEmptyFirst: 3 }) });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const fl = flashOf(post);
  assert.equal(fl.ok, false);
  assert.equal(fl.detail.reason, 'transient_empty_page_exhausted');
  assert.equal(fl.detail.attempts, 3);
  assert.equal(fl.detail.hospitalCountAfter, 0);
  assert.equal(sb.tables.facilities.length, 0);
  assert.equal(sb.tables.ingestion_runs.length, 0);
});

test('② 적재 승인: DB 게이트 미충족(wrong DB) → flash 실패, ic_dr 미발급, HIRA·sb 접속 0', async () => {
  const sb = makeMockSb();
  const spy = makeRunIngestSpy(sb);
  const h = createHandler({ env: baseEnv({ SUPABASE_URL: 'https://wdjqtynpqpzgiuzvphdr.supabase.co' }), sb, runIngest: spy });
  const { post } = await getThenPost(h, { sb, step: 'ready' });
  const fl = flashOf(post);
  assert.equal(fl.ok, false);
  assert.equal(cookiesOf(post)['__Host-ic_dr'], undefined); // 승인 실패 → 진행 토큰 없음
  assert.equal(spy.calls.length, 0);
  assert.equal(sb.calls.length, 0); // 목적지 틀리면 접속 0
});

test('통합 ③: 첫 수집 0건 → 재시도로 3건 → flash ok, HOSPITAL 3', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb, { listTotal: 3, listEmptyFirst: 1 }) });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const fl = flashOf(post);
  assert.equal(fl.ok, true);
  assert.equal(fl.detail.persisted.new, 3);
  assert.equal(sb.tables.facilities.filter((f) => f.domain === 'HOSPITAL').length, 3);
});

test('화면에 "다시 눌러" 자동 안내 없음 + 실패 시 "중단·보고" 안내', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb, { listTotal: 3, listEmptyFirst: 3 }) });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const g = mkRes();
  await h({ method: 'GET', headers: { host: BRANCH_ALIAS_HOST, cookie: cookieHeader(cookiesOf(post)) } }, g);
  assert.doesNotMatch(g.html, /다시\s*눌러\s*재시도|자동.*재시도.*하세요/);
  assert.match(g.html, /버튼을 다시 누르지 말고/);
  // 전체 소스에도 "③을 다시" 류 자동 재시도 유도 문구 없음
  assert.doesNotMatch(g.html, /③.{0,4}다시.{0,4}(눌|실행)/);
});

test('통합 ③ 재시험 재현: 2차 수집 목록 throw 3회 → flash 실패(list_fetch_failed), 시설 0, ingestion_runs 0', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb, { listTotal: 3, listThrowFirst: 3, listThrowReason: 'gateway' }) });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const fl = flashOf(post);
  assert.equal(fl.ok, false);
  assert.equal(fl.detail.reason, 'list_fetch_failed');
  assert.equal(fl.detail.attempts, 3);
  assert.equal(fl.detail.hospitalCountAfter, 0);
  assert.equal(sb.tables.facilities.length, 0);
  assert.equal(sb.tables.ingestion_runs.length, 0);
  const blob = JSON.stringify(fl);
  assert.equal(/serviceKey|supabase\.co|apis\.data\.go\.kr|JDQ4[A-Za-z0-9+/]{12}/.test(blob), false);
});

test('통합 ③: 2차 수집 목록 throw (client 소진) → collect 재재시도 없이 flash 실패, 시설 0', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb, { listTotal: 3, listThrowFirst: 1 }) });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const fl = flashOf(post);
  assert.equal(fl.ok, false);
  assert.equal(fl.detail.reason, 'list_fetch_failed');
  assert.equal(sb.tables.facilities.length, 0);
});

test('②③④ 흐름: ② 승인(HIRA 0, runIngest 미호출) → ③ full collect 정확히 1회 (목록도 ③ 에서만) → new 3 → ④ unchanged 3', async () => {
  const sb = makeMockSb();
  let runN = 0;
  const perRunCalls = [];
  const runIngest = async ({ dryRun }) => {
    runN += 1;
    const c = makeMockClient({ listTotal: 3 });
    const handler = ingestCreateHandler({
      env: baseEnv(), createClient: () => c, collect: fastCollect, persist: persistCollected,
      sbImpl: sb, assertDb: async () => ({ ok: true }),
    });
    const cap = { status: 200, body: null };
    await handler(
      { headers: { authorization: `Bearer ${SECRET}` }, query: internalIngestQuery(dryRun) },
      { status(x) { cap.status = x; return this; }, json(x) { cap.body = x; return this; }, setHeader() {} }
    );
    perRunCalls.push({ dryRun, calls: c.calls.slice() });
    return cap;
  };
  const h = createHandler({ env: baseEnv(), sb, runIngest });

  // ② 적재 승인 — HIRA·DB write 0, runIngest 미호출
  const p2 = await getThenPost(h, { sb, step: 'ready' });
  const fl2 = flashOf(p2.post);
  assert.equal(fl2.ok, true);
  assert.equal(fl2.detail.hiraCalls, 0);
  assert.equal(fl2.detail.dbWrites, 0);
  assert.equal(runN, 0); // ② 는 ingest 핸들러를 아예 호출하지 않음
  assert.ok(cookiesOf(p2.post)['__Host-ic_dr']);

  // ③ full collect (getHospBasisList 포함) 정확히 1회 → 그 결과 그대로 persist
  const p3 = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': cookiesOf(p2.post)['__Host-ic_dr'] },
  });
  const fl3 = flashOf(p3.post);
  assert.equal(fl3.ok, true);
  assert.equal(fl3.detail.persisted.new, 3);
  assert.equal(runN, 1);                          // ③ 에서 ingest 핸들러 정확히 1회
  assert.equal(perRunCalls[0].dryRun, false);
  assert.equal(perRunCalls[0].calls.filter((x) => x.startsWith('list:')).length, 1); // 목록 호출 1회
  assert.equal(perRunCalls[0].calls.length, 22);  // 목록1 + 상세6×3 + 평가3 — 재수집 없음(44 아님)
  assert.equal(sb.tables.facilities.filter((f) => f.domain === 'HOSPITAL').length, 3);

  // ④ 멱등성
  const p4 = await getThenPost(h, { sb, step: 'idempotency', confirm: CONFIRM_PHRASE });
  assert.equal(flashOf(p4.post).ok, true);
  assert.equal(flashOf(p4.post).detail.persisted.unchanged, 3);
});

test('통합: control flash detail 에 ykiho·raw·URL·키 없음 (익명 숫자만)', async () => {
  const sb = makeMockSb();
  const h = createHandler({ env: baseEnv(), sb, runIngest: realRunIngest(sb, { listTotal: 0 }) });
  const { post } = await getThenPost(h, {
    sb, step: 'ingest', confirm: CONFIRM_PHRASE,
    extraCookies: { '__Host-ic_dr': mintToken(SECRET, 'dryrun') },
  });
  const blob = JSON.stringify(flashOf(post));
  assert.equal(/serviceKey|supabase\.co|JDQ4[A-Za-z0-9+/]{16,}|Bearer/.test(blob), false);
});
