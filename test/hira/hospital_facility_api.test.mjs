// GET /api/hospital/facility — 요양병원 공개 상세 API (1B-4B)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../../api/hospital/facility.js';
import { makeMockSb } from './mockSb.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');

function mkRes() {
  return {
    statusCode: null, body: null, headers: {}, ended: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end() { this.ended = true; return this; },
  };
}
const mkReq = ({ method = 'GET', query = {} } = {}) => ({ method, query });

const flagsOn = async () => ({ flags: { hospital_module: true }, schemaReady: true });
const flagsOff = async () => ({ flags: {}, schemaReady: true });

const HID = 'H-JDQ4MTYyMiM4MSMkMSMkNCMkOTkkNTgxMzUxIzIxIyQxIyQ1IyQ4OSQzNjE4MzIjNjEjJDEjJDAjJDgz';

// 완전 시드된 mockSb (facilities + hospital_profiles + facility_evaluations + 내부컬럼 포함)
function seededSb(extra = {}) {
  return makeMockSb({
    facilities: [
      {
        id: HID, name: '성모아하브요양병원', address: '경남 김해시 김해대로 2479-1',
        sido: '경상남도', sigungu: null, sigungu_nm: '김해시', dong_nm: '삼정동',
        phone: '055-320-2080', lat: 35.2281381, lng: 128.8980324, established_at: '2010-07-27',
        // 아래는 절대 노출 금지 대상
        domain: 'HOSPITAL', source: 'hira_public', hira_ykiho: 'JDQ4MTYyMiM4MSMk_RAW',
        type_code: '28', type_label: '요양병원', post_no: '50934',
        monthly_fee: 1200, is_partner: true, intro: '운영자 소개', raw: { basis: { ykiho: 'RAW' } },
        synced_at: 'x', updated_at: 'x', capacity: 10, current_count: 5, eval_grade: 'C',
      },
      { id: '11111000006', name: '청운노인요양원', domain: 'LTC', sido: '서울특별시' },
    ],
    hospital_profiles: [
      {
        facility_id: HID, hira_ykiho: 'JDQ4MTYyMiM4MSMk_RAW',
        establishment_type: '의료법인', bed_total: 250,
        bed_detail: { standard: 212, higher: 38 },
        specialties: ['내과', '외과'], specialist_counts: { 내과: 1, 외과: 2 },
        equipment: [{ code: 'B101', name: '일반엑스선촬영장치', count: 1 }],
        homepage: 'http://example-hospital.kr',
        medical_services: { dialysis: 'FACILITY_CLAIMED' },
        last_verified_at: null, created_at: 'x', updated_at: 'x',
      },
    ],
    facility_evaluations: [
      {
        id: 1, facility_id: HID, evaluation_authority: 'HIRA',
        evaluation_name: '요양병원 입원급여 적정성평가', evaluation_year: null,
        grade: '3', grade_scale: 'HIRA_1_5',
        source_url: null, source_reference: 'hospAsmInfoService1/getHospAsmInfo1 (asmGrd10)',
        source_date: null, collected_at: '2025-01-01T00:00:00.000Z', created_at: 'x',
      },
      {
        id: 2, facility_id: HID, evaluation_authority: 'HIRA',
        evaluation_name: '요양병원 입원급여 적정성평가', evaluation_year: null,
        grade: '4', grade_scale: 'HIRA_1_5',
        source_reference: 'internal-ref', collected_at: '2026-06-01T00:00:00.000Z', created_at: 'x',
      },
    ],
    ...extra,
  });
}

const H = (opts = {}) => createHandler({ getFlags: opts.getFlags || flagsOn, sb: opts.sb });

// ── 접근 규칙 ──────────────────────────────────────────────────────
test('hospital_module OFF → 404 not_found, 시설 DB 조회 0', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ getFlags: flagsOff, sb })(mkReq({ query: { id: HID } }), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
  assert.equal(sb.calls.length, 0, 'flag OFF 면 sb 호출 0');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('POST → 405 method_not_allowed + Allow: GET, DB 조회 0', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })({ method: 'POST', query: { id: HID } }, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'method_not_allowed' });
  assert.equal(res.headers.Allow, 'GET');
  assert.equal(sb.calls.length, 0);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

for (const m of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
  test(`${m} → 405`, async () => {
    const sb = seededSb();
    const res = mkRes();
    await H({ sb })({ method: m, query: { id: HID } }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(sb.calls.length, 0);
  });
}

test('잘못된 id → 400 invalid_id, DB 조회 0 (flag 조회조차 하기 전 아니어도 sb 0)', async () => {
  for (const bad of ['', '  ', 'ab', '../etc/passwd', '<script>', 'H-abc def', 'H-abc;drop', 'H- ', 'x'.repeat(300)]) {
    const sb = seededSb();
    const res = mkRes();
    // eslint-disable-next-line no-await-in-loop
    await H({ sb })(mkReq({ query: { id: bad } }), res);
    assert.equal(res.statusCode, 400, `bad id: ${JSON.stringify(bad)}`);
    assert.deepEqual(res.body, { error: 'invalid_id' });
    assert.equal(sb.calls.length, 0);
  }
});

test('id 누락 / 문자열 아님 → 400', async () => {
  for (const q of [{}, { id: 123 }, { id: ['a'] }]) {
    const res = mkRes();
    const sb = seededSb();
    // eslint-disable-next-line no-await-in-loop
    await H({ sb })(mkReq({ query: q }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(sb.calls.length, 0);
  }
});

test('없는 id → 404 not_found', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: 'H-doesnotexist000000' } }), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('LTC id 입력 → 404 (domain=HOSPITAL 필터로 걸러짐)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: '11111000006' } }), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
  // facilities 조회는 했지만 domain 필터로 0행
  assert.ok(sb.calls.some((c) => c.table === 'facilities'));
});

// ── 정상 상세 ──────────────────────────────────────────────────────
test('HOSPITAL 정상 상세 → 200, 공개 whitelist 만, 내부 필드·비밀 미노출', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: HID } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');

  const { facility, profile, evaluation } = res.body;
  assert.deepEqual(Object.keys(facility).sort(),
    ['address', 'dong_nm', 'established_at', 'homepage', 'id', 'lat', 'lng', 'name', 'phone', 'sido', 'sigungu', 'sigungu_nm'].sort());
  assert.equal(facility.id, HID);
  assert.equal(facility.name, '성모아하브요양병원');
  assert.equal(facility.homepage, 'http://example-hospital.kr'); // profile 에서 옴
  assert.equal(facility.sigungu, null);
  assert.equal(facility.lat, 35.2281381);

  assert.deepEqual(Object.keys(profile).sort(),
    ['bed_detail', 'bed_total', 'equipment', 'establishment_type', 'medical_services', 'specialist_counts', 'specialties'].sort());
  assert.equal(profile.bed_total, 250);
  assert.deepEqual(profile.specialties, ['내과', '외과']);
  assert.deepEqual(profile.medical_services, { dialysis: 'FACILITY_CLAIMED' }); // 그대로
  assert.equal('homepage' in profile, false); // homepage 는 facility 로 감
  assert.equal('hira_ykiho' in profile, false);

  assert.deepEqual(Object.keys(evaluation).sort(),
    ['collected_at', 'evaluation_authority', 'evaluation_name', 'evaluation_year', 'grade', 'grade_scale'].sort());
  assert.equal(evaluation.grade, '4');            // 최신 1건 (2026-06-01)
  assert.equal(evaluation.grade_scale, 'HIRA_1_5');
  assert.equal(evaluation.evaluation_year, null);

  // 절대 노출 금지 항목 스캔
  const blob = JSON.stringify(res.body);
  for (const forbidden of [
    'hira_ykiho', 'external_id', 'normalized_hash', 'RAW', '_RAW', 'source_reference',
    'monthly_fee', 'is_partner', 'intro', 'synced_at', 'domain', 'type_code',
    'eval_grade', 'ingestion', 'serviceKey', 'supabase',
  ]) {
    assert.equal(blob.includes(forbidden), false, `응답에 "${forbidden}" 노출됨`);
  }
});

test('최신 evaluation 1건만 반환 (collected_at desc)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: HID } }), res);
  assert.equal(res.body.evaluation.grade, '4');
  assert.equal(res.body.evaluation.collected_at, '2026-06-01T00:00:00.000Z');
  const evalCalls = sb.calls.filter((c) => c.table === 'facility_evaluations');
  assert.equal(evalCalls.length, 1, 'evaluation 조회 1회 (N+1 없음)');
});

test('profile 없음 → 200, profile: null, facility.homepage: null', async () => {
  const sb = seededSb({ hospital_profiles: [] });
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: HID } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profile, null);
  assert.equal(res.body.facility.homepage, null);
  assert.ok(res.body.evaluation); // 평가는 있음
});

test('evaluation 없음 → 200, evaluation: null', async () => {
  const sb = seededSb({ facility_evaluations: [] });
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: HID } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.evaluation, null);
  assert.ok(res.body.profile);
});

test('profile·evaluation 둘 다 없음 → 200, 시설만', async () => {
  const sb = seededSb({ hospital_profiles: [], facility_evaluations: [] });
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: HID } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profile, null);
  assert.equal(res.body.evaluation, null);
  assert.equal(res.body.facility.id, HID);
});

test('조회는 병렬 3개, facility_sources·ingestion_runs 는 조회 안 함', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: HID } }), res);
  const tables = sb.calls.map((c) => c.table);
  assert.deepEqual([...new Set(tables)].sort(), ['facilities', 'facility_evaluations', 'hospital_profiles']);
  assert.equal(tables.filter((t) => t === 'facilities').length, 1);
  assert.equal(tables.filter((t) => t === 'hospital_profiles').length, 1);
  assert.equal(tables.filter((t) => t === 'facility_evaluations').length, 1);
  assert.equal(sb.calls.some((c) => c.table === 'facility_sources' || c.table === 'ingestion_runs'), false);
  // 전부 GET (write 0)
  assert.ok(sb.calls.every((c) => c.method === 'GET'));
});

test('DB 오류 → 503 db_unavailable, 내부 원문 미노출', async () => {
  const failSb = async (path) => {
    if (path.startsWith('facilities')) throw new Error(`Supabase 500 ${path} :: internal detail serviceKey=abc`);
    return { data: [], count: null };
  };
  const res = mkRes();
  await H({ sb: failSb })(mkReq({ query: { id: HID } }), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'db_unavailable' });
  const blob = JSON.stringify(res.body);
  assert.equal(/serviceKey|Supabase 500|internal detail|facilities\?/.test(blob), false);
});

test('getFlags 자체가 throw → 503 (fail-safe)', async () => {
  const res = mkRes();
  const sb = seededSb();
  await H({ getFlags: async () => { throw new Error('flag db down'); }, sb })(mkReq({ query: { id: HID } }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(sb.calls.length, 0);
});

// ── SELECT 가 더 많은 컬럼을 줘도 pick 이 whitelist 로 막는다 ──
test('DB 가 whitelist 밖 컬럼을 반환해도 응답엔 whitelist 만 (pick 방어)', async () => {
  // mockSb 는 select 를 무시하고 전체 행을 반환 → pick 이 유일한 경계
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { id: HID } }), res);
  const all = Object.keys(res.body.facility).concat(Object.keys(res.body.profile), Object.keys(res.body.evaluation));
  for (const leaked of ['domain', 'source', 'hira_ykiho', 'raw', 'monthly_fee', 'is_partner', 'intro',
    'type_code', 'type_label', 'post_no', 'synced_at', 'updated_at', 'created_at', 'id_1', 'facility_id',
    'source_url', 'source_reference', 'source_date', 'last_verified_at', 'capacity', 'current_count', 'eval_grade']) {
    assert.equal(all.includes(leaked), false, `whitelist 밖 컬럼 "${leaked}" 노출`);
  }
});

// ── 정적: 코드에 whitelist 가 명시돼 있고 LTC 를 안 건드림 ──
test('정적: 공개 whitelist 가 코드에 상수로 명시됨', () => {
  const src = read('api/hospital/facility.js');
  assert.ok(/const FACILITY_PUBLIC = Object\.freeze\(\[/.test(src));
  assert.ok(/const PROFILE_PUBLIC = Object\.freeze\(\[/.test(src));
  assert.ok(/const EVALUATION_PUBLIC = Object\.freeze\(\[/.test(src));
  // 금지 컬럼이 select/공개 목록에 없어야 함
  for (const bad of ['hira_ykiho', 'external_id', 'normalized_hash', 'monthly_fee', 'is_partner', 'raw']) {
    assert.equal(new RegExp(`PUBLIC[^]*?'${bad}'`).test(src.replace(/\/\/[^\n]*/g, '')), false, `whitelist 에 ${bad}`);
  }
  // facility_sources / ingestion_runs 조회 없음
  assert.equal(/sb\(`?facility_sources/.test(src), false);
  assert.equal(/sb\(`?ingestion_runs/.test(src), false);
});

test('정적: 신규 endpoint 는 기존 LTC api/facility.js 를 import·수정하지 않음', () => {
  const src = read('api/hospital/facility.js');
  assert.equal(src.includes("'../facility.js'"), false);
  assert.equal(src.includes('../../api/facility'), false);
  // LTC 핵심 파일은 이 브랜치에서 바뀌지 않음(바이트 동일)은 CI diff 로 별도 확인
});
