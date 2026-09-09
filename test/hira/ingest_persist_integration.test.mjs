// 통합: collect(mock HIRA) → api/hospital/ingest.js(dryRun=false) → lib/hira/persist.js → mockSb
// 1B-3B "시설 0건" 사고(_normalizedAll 유실 / 빈 수집이 status=ok) 회귀 고정.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../api/hospital/ingest.js';
import { collectHospitals } from '../../lib/hira/collect.js';
import { createHiraClient } from '../../lib/hira/client.js';
import { persistCollected, EXPECTED_PREVIEW_DB_HOST } from '../../lib/hira/persist.js';
import { makeMockClient } from './mockClient.mjs';
import { makeMockSb } from './mockSb.mjs';

const SECRET = 'integ-secret';
const auth = { authorization: `Bearer ${SECRET}` };
const PREVIEW_URL = `https://${EXPECTED_PREVIEW_DB_HOST}`;
const env = (e = {}) => ({
  CRON_SECRET: SECRET, DATA_GO_KR_KEY: 'k', VERCEL_ENV: 'preview',
  HOSPITAL_INGEST_PERSIST: '1', SUPABASE_URL: PREVIEW_URL, ...e,
});
const mkRes = () => ({
  statusCode: null, body: null, headers: {},
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  setHeader(k, v) { this.headers[k] = v; },
});
const mkReq = ({ headers = {}, query = {} } = {}) => ({ headers, query });

// 실제 collect — 단 retry backoff 는 즉시 (실 대기 없음)
const fastCollect = (client, o) =>
  collectHospitals(client, { ...o, sleepImpl: async () => {}, randomImpl: () => 0 });

const realDeps = (sb, clientOpt = { listTotal: 3 }, over = {}) => ({
  env: env(),
  createClient: () => makeMockClient(clientOpt),
  collect: fastCollect,
  persist: persistCollected,
  sbImpl: sb,
  assertDb: async () => ({ ok: true }),
  ...over,
});
const hospCount = (sb) => sb.tables.facilities.filter((f) => f.domain === 'HOSPITAL').length;

// ── 정상 경로 ──────────────────────────────────────────────────────
test('통합: collect 3 → ingest → persist → mockSb : new=3, HOSPITAL 3, 프로필/소스 3', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler(realDeps(sb))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.persisted.new, 3);
  assert.equal(res.body.persistInputCount, 3);
  assert.equal(res.body.collectedCount, 3);
  assert.equal(res.body.normalizedCount, 3);
  assert.equal(hospCount(sb), 3);
  assert.equal(sb.tables.hospital_profiles.length, 3);
  assert.equal(sb.tables.facility_sources.length, 3);
  assert.equal(sb.tables.ingestion_runs[0].status, 'ok');
  assert.equal(sb.tables.ingestion_runs[0].count_new, 3);
});

test('통합: 동일 재실행 → unchanged 3, new 0, facilities 3 유지 (추가 write 없음)', async () => {
  const sb = makeMockSb();
  await createHandler(realDeps(sb))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), mkRes());
  const res2 = mkRes();
  await createHandler(realDeps(sb))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res2);

  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.persisted.unchanged, 3);
  assert.equal(res2.body.persisted.new, 0);
  assert.equal(hospCount(sb), 3);
  assert.equal(sb.tables.hospital_profiles.length, 3);
  assert.equal(sb.tables.facility_sources.length, 3);
  assert.equal(sb.tables.ingestion_runs.length, 2); // 로그만 +1
});

test('통합: 운영자 입력 컬럼은 재수집에도 보존', async () => {
  const sb = makeMockSb();
  await createHandler(realDeps(sb))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), mkRes());
  const f = sb.tables.facilities[0];
  f.monthly_fee = 1200; f.is_partner = true; f.intro = '운영자';
  await createHandler(realDeps(sb))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), mkRes());
  const f2 = sb.tables.facilities.find((x) => x.id === f.id);
  assert.equal(f2.monthly_fee, 1200);
  assert.equal(f2.is_partner, true);
  assert.equal(f2.intro, '운영자');
});

// ── 사고 재현 / fail-closed ─────────────────────────────────────────
// (HIRA 목록이 3회 재시도 후에도 0건이면 502 transient_empty_page_exhausted —
//  아래 "bounded retry" 섹션에서 검증. collect_count_mismatch 는 아래 "2건만" 케이스.)

test('통합: collect 가 2건만(기대 3) → 422 collect_count_mismatch, persist 미호출, 시설 0', async () => {
  const sb = makeMockSb();
  let persistCalled = false;
  const res = mkRes();
  await createHandler(realDeps(sb, { listTotal: 2 }, {
    persist: async (...a) => { persistCalled = true; return persistCollected(...a); },
  }))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.persistInputCount, 2);
  assert.equal(persistCalled, false);
  assert.equal(sb.tables.facilities.length, 0);
});

test('통합: 저장 결과 합계가 입력수와 불일치 → 500 persist_count_mismatch, 성공 아님', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler(realDeps(sb, { listTotal: 3 }, {
    persist: async () => ({ runId: 9, status: 'ok', stats: { new: 1, updated: 0, unchanged: 0, partial: 0, failed: 0 }, failures: [] }),
  }))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'persist_count_mismatch');
  assert.equal(res.body.persistInputCount, 3);
  assert.equal(res.body.writeSum, 1);
});

// ── bounded retry: "정상코드 + 첫 페이지 0건" ──────────────────────
test('통합: HIRA 첫 수집 0건 → 재시도로 3건 → 정상 적재 new=3, listRetries 1', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler(realDeps(sb, { listTotal: 3, listEmptyFirst: 1 }))(
    mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.persisted.new, 3);
  assert.equal(res.body.stats.listRetries, 1);
  assert.equal(sb.tables.facilities.filter((f) => f.domain === 'HOSPITAL').length, 3);
});

test('통합: HIRA 목록 3회 모두 0건 → 502(transient_empty_page_exhausted), persist 미호출, 시설 0, 로그 0', async () => {
  const sb = makeMockSb();
  let persistCalled = false;
  const res = mkRes();
  await createHandler(realDeps(sb, { listTotal: 3, listEmptyFirst: 3 }, {
    persist: async (...a) => { persistCalled = true; return persistCollected(...a); },
  }))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.reason, 'transient_empty_page_exhausted');
  assert.equal(res.body.attempts, 3);
  assert.equal(res.body.dryRun, false);
  assert.equal(persistCalled, false);
  assert.equal(sb.tables.facilities.length, 0);
  assert.equal(sb.tables.hospital_profiles.length, 0);
  assert.equal(sb.tables.ingestion_runs.length, 0);
  const blob = JSON.stringify(res.body);
  assert.equal(/serviceKey|apis\.data\.go\.kr|https?:\/\/|JDQ4/.test(blob), false);
});

test('통합 dry-run: 목록 3회 모두 0건 → 502 collect_failed, ok 아님', async () => {
  const res = mkRes();
  await createHandler(realDeps(makeMockSb(), { listTotal: 3, listEmptyFirst: 3 }))(
    mkReq({ headers: auth, query: { limit: '3' } }), res);
  assert.equal(res.statusCode, 502);
  assert.notEqual(res.body.ok, true);
  assert.equal(res.body.reason, 'transient_empty_page_exhausted');
});

// ── 재시험(2026-09-09) 재현: 2차 수집의 목록 호출이 throw / 비정상 resultCode ──
test('통합: 2차 수집 목록 throw 3회 → 502 ingest_failed(list_fetch_failed), persist 미호출, 시설·로그 0', async () => {
  const sb = makeMockSb();
  let persistCalled = false;
  const res = mkRes();
  await createHandler(realDeps(sb, { listTotal: 3, listThrowFirst: 3, listThrowReason: 'gateway' }, {
    persist: async (...a) => { persistCalled = true; return persistCollected(...a); },
  }))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'ingest_failed');
  assert.equal(res.body.reason, 'list_fetch_failed');
  assert.equal(res.body.attempts, 3);
  assert.equal(persistCalled, false);
  assert.equal(sb.tables.facilities.length, 0);
  assert.equal(sb.tables.ingestion_runs.length, 0);
  const blob = JSON.stringify(res.body);
  assert.equal(/serviceKey|apis\.data\.go\.kr|https?:\/\/|JDQ4/.test(blob), false);
});

test('통합: 목록 회복은 client 계층에서 (첫 fetch 503 → 두 번째 200) → 정상 적재 new=3', async () => {
  const LIST_JSON = JSON.stringify({
    response: { header: { resultCode: '00' }, body: {
      totalCount: 3, numOfRows: 100, pageNo: 1,
      items: { item: [1, 2, 3].map((i) => ({ ykiho: `YKIHO_INTEG_${i}`, yadmNm: `H${i}`, clCd: 28, addr: 'x', XPos: '127.0', YPos: '37.5', estbDd: 20100101 })) },
    } },
  });
  const EMPTY_OK = JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: '', totalCount: 0 } } });
  let listCall = 0;
  const ff = async (url) => {
    if (/hospInfoServicev2/.test(url)) {
      listCall += 1;
      if (listCall === 1) return { status: 503, text: async () => 'busy' };
      return { status: 200, text: async () => LIST_JSON };
    }
    return { status: 200, text: async () => EMPTY_OK };
  };
  const createClient = (o) => createHiraClient({ ...o, key: 'k', fetchImpl: ff, sleepImpl: async () => {}, minIntervalMs: 0, maxRetries: 3 });
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({
    env: env(), createClient, collect: collectHospitals, persist: persistCollected,
    sbImpl: sb, assertDb: async () => ({ ok: true }),
  })(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.persisted.new, 3);
  assert.equal(listCall, 2); // client 가 1회 재시도 후 회복
  assert.equal(sb.tables.facilities.filter((f) => f.domain === 'HOSPITAL').length, 3);
});

test('통합: 목록 비정상 resultCode(code 1, 비일시적) → 502 list_abnormal_result, persist 미호출, 재시도 없음', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler(realDeps(sb, { listTotal: 3, listAbnormalFirst: 1, listAbnormalCode: '1' }))(
    mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.reason, 'list_abnormal_result');
  assert.equal(res.body.lastResultCode, '1');
  assert.equal(sb.tables.facilities.length, 0);
});

// ── wall-clock deadline: 플랫폼 하드 타임아웃 전에 502 ──────────────
test('통합: 상세 수집이 예산 초과(느린 HIRA) → 60s 전에 502 deadline_exceeded, persist 미호출, 시설·로그 0', async () => {
  let clock = 0;
  const now = () => clock;
  const c = makeMockClient({ listTotal: 3, tick: () => { clock += 4000; } }); // 매 HIRA 콜 4s
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({
    env: env(), createClient: () => c, collect: collectHospitals, persist: persistCollected,
    sbImpl: sb, assertDb: async () => ({ ok: true }), now,
  })(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.reason, 'deadline_exceeded');
  assert.ok(clock < 45_000, `시뮬 경과 ${clock}ms — 예산(40s)+여유 안`);
  assert.equal(sb.tables.facilities.length, 0);
  assert.equal(sb.tables.ingestion_runs.length, 0);
  const blob = JSON.stringify(res.body);
  assert.equal(/serviceKey|apis\.data\.go\.kr|https?:\/\/|JDQ4/.test(blob), false);
});

test('통합: 최악(모든 HIRA 호출 timeout, 실제 client) → 60s 전에 502, DB write 0', async () => {
  let clock = 0;
  const now = () => clock;
  const ff = async () => { clock += 6500; const e = new Error('t'); e.name = 'AbortError'; throw e; };
  const createClient = (o) => createHiraClient({
    ...o, key: 'k', fetchImpl: ff, sleepImpl: async (ms) => { clock += Math.max(0, ms); },
    now, minIntervalMs: 20, maxRetries: 3,
  });
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({
    env: env(), createClient, collect: collectHospitals, persist: persistCollected,
    sbImpl: sb, assertDb: async () => ({ ok: true }), now,
  })(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);

  assert.equal(res.statusCode, 502);
  assert.ok(['list_fetch_failed', 'deadline_exceeded', 'deadline', 'timeout'].includes(res.body.reason), res.body.reason);
  assert.ok(clock < 55_000, `시뮬 경과 ${clock}ms`);
  assert.equal(sb.tables.facilities.length, 0);
  assert.equal(sb.countWrites(), 0);
});

test('통합 dry-run: 예산 초과 → 502 (dry-run 도 동일 안전장치), DB write 0', async () => {
  let clock = 0;
  const now = () => clock;
  const c = makeMockClient({ listTotal: 3, tick: () => { clock += 6000; } });
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler({
    env: env(), createClient: () => c, collect: collectHospitals, persist: persistCollected,
    sbImpl: sb, assertDb: async () => ({ ok: true }), now,
  })(mkReq({ headers: auth, query: { limit: '3' } }), res); // dryRun 기본 true

  assert.equal(res.statusCode, 502);
  assert.notEqual(res.body.ok, true);
  assert.ok(clock < 45_000);
  assert.equal(sb.countWrites(), 0);
});

// ── _normalizedAll 전달 경로 ───────────────────────────────────────
test('_normalizedAll 회귀: collect 반환값에 배열로 존재하고 ingest 가 그대로 persist 로 전달', async () => {
  const r = await collectHospitals(makeMockClient({ listTotal: 3 }), { maxInstitutions: 3, pageSize: 100 });
  assert.equal(Object.prototype.hasOwnProperty.call(r, '_normalizedAll'), true);
  assert.equal(Array.isArray(r._normalizedAll), true);
  assert.equal(r._normalizedAll.length, 3);

  // ingest.js 가 result._normalizedAll 로 직접 읽는지 — persist 스파이로 확인
  let seen = null;
  const sb = makeMockSb();
  await createHandler(realDeps(sb, { listTotal: 3 }, {
    persist: async (items) => {
      seen = items;
      return { runId: 1, status: 'ok', stats: { new: 3, updated: 0, unchanged: 0, partial: 0, failed: 0 }, failures: [] };
    },
  }))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), mkRes());
  assert.equal(Array.isArray(seen), true);
  assert.equal(seen.length, 3);
});

test('dryRun=true 와 dryRun=false 는 같은 collect 결과 형태를 받는다 (_normalizedAll 만 응답에서 제거)', async () => {
  const dry = mkRes();
  await createHandler(realDeps(makeMockSb(), { listTotal: 3 }))(mkReq({ headers: auth, query: { limit: '3' } }), dry);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.dbWrites, 0);
  assert.equal(dry.body.stats.normalized, 3);
  assert.equal(dry.body._normalizedAll, undefined); // 응답 미포함

  const wet = mkRes();
  await createHandler(realDeps(makeMockSb(), { listTotal: 3 }))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), wet);
  assert.equal(wet.body.dryRun, false);
  assert.equal(wet.body.normalizedCount, 3);
  assert.equal(wet.body._normalizedAll, undefined);
});

// ── persistCollected 단위: 빈 입력 ─────────────────────────────────
test('persistCollected([]) → status failed, 시설 0, ingestion_runs 는 failed 로 마감', async () => {
  const sb = makeMockSb();
  const r = await persistCollected([], { sb, now: () => '2026-09-08T00:00:00.000Z' });
  assert.equal(r.status, 'failed');
  assert.equal(sb.tables.facilities.length, 0);
  assert.equal(sb.tables.ingestion_runs.length, 1);
  assert.equal(sb.tables.ingestion_runs[0].status, 'failed');
  assert.equal(sb.tables.ingestion_runs[0].count_new, 0);
});

test('persistCollected 정상 1건 → status ok (회귀: 합계검증이 정상 경로를 깨지 않음)', async () => {
  const sb = makeMockSb();
  const items = (await collectHospitals(makeMockClient({ listTotal: 1 }), { maxInstitutions: 1, pageSize: 100 }))._normalizedAll;
  const r = await persistCollected(items, { sb, now: () => '2026-09-08T00:00:00.000Z' });
  assert.equal(r.stats.new, 1);
  assert.equal(r.status, 'ok');
  assert.equal(sb.tables.ingestion_runs[0].status, 'ok');
});

// ── 비밀 비노출 ────────────────────────────────────────────────────
test('통합 응답에 ykiho 원문·serviceKey·URL 없음', async () => {
  const sb = makeMockSb();
  const res = mkRes();
  await createHandler(realDeps(sb))(mkReq({ headers: auth, query: { dryRun: 'false', limit: '3' } }), res);
  const blob = JSON.stringify(res.body);
  assert.equal(/serviceKey|supabase\.co|JDQ4[A-Za-z0-9+/]{16,}/.test(blob), false);
});
