// GET /api/hospital/facilities — 요양병원 공개 검색·목록 API (1B-4C)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../../api/hospital/facilities.js';
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

// ── 시드 ────────────────────────────────────────────────────────────
function seededSb(extra = {}) {
  return makeMockSb({
    facilities: [
      {
        id: 'H-h1', name: '가나요양병원', address: '서울특별시 강남구 테헤란로 1',
        sido: '서울특별시', sigungu: null, sigungu_nm: '강남구', dong_nm: '역삼동',
        phone: '02-1', lat: 37.5, lng: 127.0, established_at: '2015-01-01',
        // 노출 금지 대상
        domain: 'HOSPITAL', source: 'hira_public', hira_ykiho: 'YK1JDQ4_RAW',
        type_code: '28', monthly_fee: 100, is_partner: true, intro: '운영자메모',
        raw: { basis: { ykiho: 'RAW' } }, synced_at: 'x',
      },
      {
        id: 'H-h2', name: '나다요양병원', address: '서울특별시 서초구 반포대로 2',
        sido: '서울특별시', sigungu: null, sigungu_nm: '서초구', dong_nm: '서초동',
        phone: '02-2', lat: 37.49, lng: 127.01, established_at: '2016-02-02',
        domain: 'HOSPITAL', hira_ykiho: 'YK2_RAW',
      },
      {
        id: 'H-h3', name: '다라의료재단부속요양병원', address: '경기도 성남시 분당구 성남대로 3',
        sido: '경기도', sigungu: null, sigungu_nm: '성남시 분당구', dong_nm: '정자동',
        phone: '031-3', lat: 37.3, lng: 127.1, established_at: '2017-03-03',
        domain: 'HOSPITAL', hira_ykiho: 'YK3_RAW',
      },
      {
        id: 'H-h4', name: '라마요양병원', address: '부산광역시 해운대구 센텀로 4',
        sido: '부산광역시', sigungu: null, sigungu_nm: '해운대구', dong_nm: '우동',
        phone: '051-4', lat: 35.1, lng: 129.1, established_at: '2018-04-04',
        domain: 'HOSPITAL', hira_ykiho: 'YK4_RAW',
      },
      {
        id: 'H-h5', name: '마바요양병원', address: '서울특별시 강남구 강남대로 5',
        sido: '서울특별시', sigungu: null, sigungu_nm: '강남구', dong_nm: '논현동',
        phone: '02-5', lat: 37.51, lng: 127.02, established_at: '2019-05-05',
        domain: 'HOSPITAL', hira_ykiho: 'YK5_RAW',
      },
      // LTC (혼입 0 확인용) — name 에 '가나' 포함시켜 q 검색이 LTC 를 안 긁는지 검증
      { id: '11111000006', name: '가나노인요양원', domain: 'LTC', sido: '서울특별시', sigungu_nm: '강남구', address: '서울특별시 강남구 삼성로 9' },
      { id: '22222000007', name: '서초실버케어', domain: 'LTC', sido: '서울특별시', sigungu_nm: '서초구', address: '서울특별시 서초구 9' },
    ],
    hospital_profiles: [
      {
        facility_id: 'H-h1', hira_ykiho: 'YK1JDQ4_RAW', establishment_type: '의료법인',
        bed_total: 200, bed_detail: { standard: 180 }, specialties: ['내과', '재활의학과'],
        specialist_counts: { 내과: 2 }, equipment: [{ code: 'E1' }],
        homepage: 'http://h1.example.kr', medical_services: { dialysis: 'FACILITY_CLAIMED' },
        created_at: 'x', updated_at: 'x',
      },
      {
        facility_id: 'H-h2', hira_ykiho: 'YK2_RAW', establishment_type: '개인',
        bed_total: 120, specialties: ['내과'], created_at: 'x',
      },
      // h3·h4·h5 → 프로필 없음
    ],
    facility_evaluations: [
      {
        id: 10, facility_id: 'H-h1', evaluation_authority: 'HIRA',
        evaluation_name: '요양병원 입원급여 적정성평가', evaluation_year: null,
        grade: '2', grade_scale: 'HIRA_1_5', source_reference: 'ref-old',
        collected_at: '2024-01-01T00:00:00.000Z', created_at: 'x',
      },
      {
        id: 11, facility_id: 'H-h1', evaluation_authority: 'HIRA',
        evaluation_name: '요양병원 입원급여 적정성평가', evaluation_year: null,
        grade: '1', grade_scale: 'HIRA_1_5', source_reference: 'ref-new',
        collected_at: '2025-06-01T00:00:00.000Z', created_at: 'x',
      },
      // h2: 동일 collected_at → id desc tie-break 으로 id 21(grade '3') 이 최신
      {
        id: 20, facility_id: 'H-h2', evaluation_authority: 'HIRA',
        evaluation_name: '요양병원 입원급여 적정성평가', evaluation_year: null,
        grade: '4', grade_scale: 'HIRA_1_5', collected_at: '2025-03-03T00:00:00.000Z', created_at: 'x',
      },
      {
        id: 21, facility_id: 'H-h2', evaluation_authority: 'HIRA',
        evaluation_name: '요양병원 입원급여 적정성평가', evaluation_year: null,
        grade: '3', grade_scale: 'HIRA_1_5', collected_at: '2025-03-03T00:00:00.000Z', created_at: 'x',
      },
      // h3·h4·h5 → 평가 없음
    ],
    ...extra,
  });
}

const H = (opts = {}) => createHandler({ getFlags: opts.getFlags || flagsOn, sb: opts.sb });

// ── 접근 규칙 ──────────────────────────────────────────────────────
test('hospital_module OFF → 404 not_found, 병원 테이블 조회 0', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ getFlags: flagsOff, sb })(mkReq({ query: {} }), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
  assert.equal(sb.calls.length, 0);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('POST → 405 + Allow: GET, DB 조회 0', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })({ method: 'POST', query: {} }, res);
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
    await H({ sb })({ method: m, query: {} }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, 'GET');
    assert.equal(sb.calls.length, 0);
  });
}

// ── 정상 목록 ──────────────────────────────────────────────────────
test('GET 정상 목록 → 200, items/page/size/total, 안정 정렬', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.page, 1);
  assert.equal(res.body.size, 20);
  assert.equal(res.body.total, 5);          // 요양병원 5건 (LTC 2건 제외)
  assert.equal(res.body.items.length, 5);
  assert.deepEqual(res.body.items.map((it) => it.facility.id), ['H-h1', 'H-h2', 'H-h3', 'H-h4', 'H-h5']);
});

test('domain=HOSPITAL 를 항상 강제한다', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  const facCall = sb.calls.find((c) => c.table === 'facilities');
  assert.ok(facCall.filters.some((f) => f.col === 'domain' && f.op === 'eq' && f.val === 'HOSPITAL'));
});

test('LTC 행 혼입 0 (q 검색이 LTC name 을 긁지 않음)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { q: '가나' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 1);
  assert.deepEqual(res.body.items.map((it) => it.facility.id), ['H-h1']); // 가나요양병원만, 가나노인요양원(LTC) 제외
});

test('q 기관명 검색', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { q: '마바' } }), res);
  assert.deepEqual(res.body.items.map((it) => it.facility.name), ['마바요양병원']);
  assert.equal(res.body.total, 1);
});

test('q 주소 검색 (name 엔 없고 address 에만 있는 키워드)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { q: '강남구' } }), res);
  assert.deepEqual(res.body.items.map((it) => it.facility.id).sort(), ['H-h1', 'H-h5']);
});

test('sido 정확 일치', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { sido: '서울특별시' } }), res);
  assert.deepEqual(res.body.items.map((it) => it.facility.id).sort(), ['H-h1', 'H-h2', 'H-h5']);
  assert.equal(res.body.total, 3);
});

test('sigungu 정확 일치 (sigungu_nm 컬럼 대상)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { sigungu: '강남구' } }), res);
  assert.deepEqual(res.body.items.map((it) => it.facility.id).sort(), ['H-h1', 'H-h5']);
  const facCall = sb.calls.find((c) => c.table === 'facilities');
  assert.ok(facCall.filters.some((f) => f.col === 'sigungu_nm' && f.op === 'eq' && f.val === '강남구'));
});

test('복합 필터 (sido + q)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { sido: '경기도', q: '재단' } }), res);
  assert.deepEqual(res.body.items.map((it) => it.facility.id), ['H-h3']);
  assert.equal(res.body.total, 1);
});

test('알 수 없는 파라미터는 무시 (기존 api/facilities.js 계약)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { bogus: 'x', specialties: '내과', grade: '1' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 5); // 필터 무시 → 전체
});

// ── page / size ───────────────────────────────────────────────────
test('page/size 기본값·경계', async () => {
  const sb = seededSb();
  let res = mkRes();
  await H({ sb })(mkReq({ query: { size: '2', page: '1' } }), res);
  assert.deepEqual(res.body.items.map((it) => it.facility.id), ['H-h1', 'H-h2']);
  assert.equal(res.body.total, 5);
  assert.equal(res.body.size, 2);

  res = mkRes();
  await H({ sb: seededSb() })(mkReq({ query: { size: '2', page: '3' } }), res);
  assert.deepEqual(res.body.items.map((it) => it.facility.id), ['H-h5']);

  res = mkRes();
  await H({ sb: seededSb() })(mkReq({ query: { size: '2', page: '4' } }), res);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.total, 5); // 범위 밖이어도 total 은 정확
});

test('size 최대 50 로 클램프', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { size: '100' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.size, 50);
  assert.equal(res.body.items.length, 5);
});

test('잘못된 page/size/q → 400, 병원 테이블 조회 0', async () => {
  for (const q of [
    { page: '0' }, { page: 'abc' }, { page: '1.5' }, { page: '-1' },
    { size: '0' }, { size: 'abc' }, { size: '-3' }, { size: '1.5' },
    { q: 'x'.repeat(101) }, { q: `ab${String.fromCharCode(1)}cd` }, { q: ['a', 'b'] }, { q: 42 },
    { sido: 'x'.repeat(61) }, { sido: `a${String.fromCharCode(9)}b` }, { sido: ['a'] }, { sigungu: ['a'] },
  ]) {
    const sb = seededSb();
    const res = mkRes();
    // eslint-disable-next-line no-await-in-loop
    await H({ sb })(mkReq({ query: q }), res);
    assert.equal(res.statusCode, 400, `query: ${JSON.stringify(q)}`);
    assert.equal(sb.calls.length, 0, `query: ${JSON.stringify(q)}`);
  }
});

test('빈 결과 → items=[], total=0, 후속 profile/evaluation 조회 생략', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { sido: '제주특별자치도' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.total, 0);
  assert.equal(sb.calls.length, 1); // facilities 조회 1회만
  assert.equal(sb.calls[0].table, 'facilities');
});

// ── profile / evaluation 조립 ─────────────────────────────────────
test('profile/evaluation 없는 기관도 정상 반환 (null)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  const byId = Object.fromEntries(res.body.items.map((it) => [it.facility.id, it]));
  assert.equal(byId['H-h3'].profile, null);
  assert.equal(byId['H-h3'].evaluation, null);
  assert.ok(byId['H-h1'].profile);
  assert.ok(byId['H-h1'].evaluation);
});

test('batch 조회 고정 — page 크기와 무관하게 sb 호출 3회, N+1 없음', async () => {
  for (const size of ['20', '2', '1']) {
    const sb = seededSb();
    const res = mkRes();
    // eslint-disable-next-line no-await-in-loop
    await H({ sb })(mkReq({ query: { size } }), res);
    assert.equal(sb.calls.length, 3, `size=${size}`);
    const tables = sb.calls.map((c) => c.table).sort();
    assert.deepEqual(tables, ['facilities', 'facility_evaluations', 'hospital_profiles']);
    assert.equal(sb.calls.filter((c) => c.table === 'facilities').length, 1);
    assert.equal(sb.calls.filter((c) => c.table === 'hospital_profiles').length, 1);
    assert.equal(sb.calls.filter((c) => c.table === 'facility_evaluations').length, 1);
    assert.ok(sb.calls.every((c) => c.method === 'GET'));
  }
});

test('facility_sources·ingestion_runs 는 조회하지 않는다', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  assert.equal(sb.calls.some((c) => c.table === 'facility_sources' || c.table === 'ingestion_runs'), false);
});

test('기관별 최신 evaluation 1건 — collected_at desc, id desc tie-break', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  const byId = Object.fromEntries(res.body.items.map((it) => [it.facility.id, it]));
  assert.equal(byId['H-h1'].evaluation.grade, '1'); // 2025-06-01 이 최신
  assert.equal(byId['H-h2'].evaluation.grade, '3'); // 동일 날짜 → id 21 (grade '3') 이 tie-break 승
});

// ── 공개 whitelist / 미노출 ───────────────────────────────────────
test('공개 whitelist 외 필드 미노출', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  const it = res.body.items.find((x) => x.facility.id === 'H-h1');
  assert.deepEqual(Object.keys(it.facility).sort(),
    ['address', 'dong_nm', 'established_at', 'id', 'lat', 'lng', 'name', 'phone', 'sido', 'sigungu', 'sigungu_nm'].sort());
  assert.deepEqual(Object.keys(it.profile).sort(), ['bed_total', 'establishment_type', 'specialties'].sort());
  assert.deepEqual(Object.keys(it.evaluation).sort(),
    ['collected_at', 'evaluation_authority', 'evaluation_name', 'evaluation_year', 'grade', 'grade_scale'].sort());
  assert.deepEqual(Object.keys(res.body).sort(), ['items', 'page', 'size', 'total'].sort());
});

test('raw / 요양기호 / external_id / hash / 비밀 / 내부 상태 미노출', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  const blob = JSON.stringify(res.body);
  for (const forbidden of [
    'hira_ykiho', 'YK1JDQ4_RAW', 'YK2_RAW', '_RAW', 'external_id', 'normalized_hash',
    'raw', 'source_reference', 'monthly_fee', 'is_partner', 'intro', 'synced_at',
    'domain', 'type_code', 'bed_detail', 'specialist_counts', 'equipment', 'homepage',
    'medical_services', 'ingestion', 'serviceKey', 'supabase',
  ]) {
    assert.equal(blob.includes(forbidden), false, `응답에 "${forbidden}" 노출됨`);
  }
});

test('공개 facility.id 는 "H-<요양기호>" 형식을 유지한다 (숨기지 않음)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  assert.ok(res.body.items.every((it) => /^H-/.test(it.facility.id)));
});

// ── DB 오류 ───────────────────────────────────────────────────────
test('facilities 조회 실패 → 503 db_unavailable, 내부 원문 미노출', async () => {
  const failSb = async (path) => {
    if (path.startsWith('facilities')) {
      throw new Error(`Supabase 500 ${path} :: internal serviceKey=abc https://x.supabase.co`);
    }
    return { data: [], count: null };
  };
  const res = mkRes();
  await H({ sb: failSb })(mkReq({ query: {} }), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'db_unavailable' });
  assert.equal(/serviceKey|Supabase 500|supabase\.co|facilities\?/.test(JSON.stringify(res.body)), false);
});

test('profile batch 조회 실패 → 503 (facilities 성공 후)', async () => {
  const base = seededSb();
  const failSb = async (path, opt) => {
    if (path.startsWith('hospital_profiles')) throw new Error('Supabase 500 hospital_profiles :: boom');
    return base(path, opt);
  };
  const res = mkRes();
  await H({ sb: failSb })(mkReq({ query: {} }), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'db_unavailable' });
});

test('getFlags 자체가 throw → 503, sb 조회 0', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ getFlags: async () => { throw new Error('flag db down'); }, sb })(mkReq({ query: {} }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(sb.calls.length, 0);
});

// ── DB 가 whitelist 밖 컬럼을 줘도 pick 이 막는다 ──
test('DB 가 whitelist 밖 컬럼을 반환해도 응답엔 whitelist 만 (pick 방어)', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: {} }), res);
  for (const it of res.body.items) {
    const keys = Object.keys(it.facility)
      .concat(it.profile ? Object.keys(it.profile) : [])
      .concat(it.evaluation ? Object.keys(it.evaluation) : []);
    for (const leaked of ['domain', 'source', 'hira_ykiho', 'raw', 'monthly_fee', 'is_partner',
      'intro', 'type_code', 'synced_at', 'facility_id', 'source_reference', 'bed_detail',
      'specialist_counts', 'equipment', 'homepage', 'medical_services', 'created_at', 'updated_at']) {
      assert.equal(keys.includes(leaked), false, `whitelist 밖 컬럼 "${leaked}" 노출`);
    }
  }
});

// ── 정적: 코드 whitelist·LTC 무관 ────────────────────────────────
test('정적: 공개 whitelist 가 코드에 상수로 명시됨', () => {
  const src = read('api/hospital/facilities.js');
  assert.ok(/const FACILITY_PUBLIC = Object\.freeze\(\[/.test(src));
  assert.ok(/const PROFILE_PUBLIC = Object\.freeze\(\[/.test(src));
  assert.ok(/const EVALUATION_PUBLIC = Object\.freeze\(\[/.test(src));
  const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const bad of ['hira_ykiho', 'external_id', 'normalized_hash', 'monthly_fee', 'is_partner', 'raw']) {
    assert.equal(new RegExp(`PUBLIC[^]*?'${bad}'`).test(codeOnly), false, `whitelist 에 ${bad}`);
  }
  // facility_sources / ingestion_runs 조회 없음
  assert.equal(/facility_sources/.test(codeOnly), false);
  assert.equal(/ingestion_runs/.test(codeOnly), false);
});

test('정적: 신규 endpoint 는 기존 LTC api/facilities.js·facility.js 를 import·수정하지 않음', () => {
  const src = read('api/hospital/facilities.js');
  assert.equal(src.includes("'../facilities.js'"), false);
  assert.equal(src.includes("'../facility.js'"), false);
  assert.equal(src.includes('../../api/facilities'), false);
  // 기존 LTC 파일이 이 브랜치에서 살아있는지(마커) 확인 — 바이트 동일은 CI diff 로 별도 확인
  assert.ok(read('api/facilities.js').includes('FACILITY_PUBLIC_COLUMNS'));
  assert.ok(read('api/facility.js').length > 0);
});

test('정적: specialties/grade/bed 필터는 이번 단계에서 미구현 (주석 명시)', () => {
  const src = read('api/hospital/facilities.js');
  assert.ok(/specialties.*grade.*bed|bed.*필터|후속 필터/.test(src));
});

// ── 1B-4C 보안: q/sido/sigungu 가 URL·PostgREST 구조를 못 바꾼다 ──────────
// 공격 입력: URL 구조 문자(& = ? #), PostgREST 구조 문자(( ) , ' " \ . *), SQL 와일드카드(%)
const ATTACKS = [
  '서울&domain=eq.LTC',
  '서울?limit=1000',
  '서울#fragment',
  '서울=eq.HOSPITAL',
  "서울'",
  '서울,주소',
  '서울(테스트)',
  '서울%',        // ?p=서울%25 → 디코드되면 '서울%'
  '서울*',
  '서울\\"',      // 역슬래시 + 쌍따옴표
  '서울 강남',     // 한글 + 공백 정상값
];

const FACILITY_SELECT_COLS = [
  'id', 'name', 'address', 'sido', 'sigungu', 'sigungu_nm', 'dong_nm', 'phone', 'lat', 'lng', 'established_at',
].join(',');

// facilities 쿼리 문자열이 구조적으로 안전한지 검증
function assertSafeFacilitiesQuery(path, allowedKeys) {
  assert.ok(path.startsWith('facilities?'), `facilities 쿼리 아님: ${path}`);
  assert.equal(path.includes('#'), false, `경로에 프래그먼트(#): ${path}`);
  const qs = path.slice('facilities?'.length);
  const entries = [...new URLSearchParams(qs)]; // [ [k,v], ... ] — & 로 나뉜 실제 파라미터

  // 1) 파라미터 키가 화이트리스트뿐 — 사용자가 새 파라미터를 만들 수 없다
  for (const [k] of entries) {
    assert.ok(allowedKeys.includes(k), `예상 못한 쿼리 파라미터 "${k}" (${path})`);
  }
  // 2) 각 구조 파라미터는 정확히 1번, 코드 고정값 그대로 (덮어쓰기·중복 불가)
  const only = (k) => entries.filter(([kk]) => kk === k).map(([, v]) => v);
  assert.deepEqual(only('domain'), ['eq.HOSPITAL'], `domain 오염: ${path}`);
  assert.deepEqual(only('order'), ['name.asc,id.asc'], `order 오염: ${path}`);
  assert.deepEqual(only('select'), [FACILITY_SELECT_COLS], `select 오염: ${path}`);
  assert.equal(only('limit').length, 1);
  assert.equal(only('offset').length, 1);
  assert.match(only('limit')[0], /^[0-9]+$/);
  assert.ok(Number(only('limit')[0]) <= 50, `limit > 50: ${path}`);
  assert.match(only('offset')[0], /^[0-9]+$/);

  // 3) or 파라미터가 있으면 정확히 1개, 우리가 만든 (name.ilike.*..*,address.ilike.*..*) 형태.
  //    사용자 값에 콤마·괄호가 없어 조건이 정확히 2개다 (3번째 조건 주입 불가).
  const ors = only('or');
  if (ors.length) {
    assert.equal(ors.length, 1, `or 중복: ${path}`);
    const inner = ors[0].replace(/^\(/, '').replace(/\)$/, '');
    const conds = inner.split(',');
    assert.equal(conds.length, 2, `or 조건이 2개가 아님(주입?): ${ors[0]}`);
    for (const c of conds) assert.match(c, /^(name|address)\.ilike\.\*[^,()]*\*$/, `or 조건 구조 오염: ${c}`);
  }

  // 4) sido/sigungu_nm 필터가 있으면 정확히 1개, eq. 접두 (콤마·괄호로 다른 절 못 붙임)
  for (const rk of ['sido', 'sigungu_nm']) {
    const vs = only(rk);
    if (vs.length) {
      assert.equal(vs.length, 1, `${rk} 중복: ${path}`);
      assert.match(vs[0], /^eq\.[^,()&=?#]*$/, `${rk} 값 구조 오염: ${vs[0]}`);
    }
  }
}

for (const param of ['q', 'sido', 'sigungu']) {
  for (const attack of ATTACKS) {
    test(`보안: ${param} = ${JSON.stringify(attack)} → 구조 불변 or 400`, async () => {
      const sb = seededSb();
      const res = mkRes();
      // eslint-disable-next-line no-await-in-loop
      await H({ sb })(mkReq({ query: { [param]: attack } }), res);

      if (res.statusCode === 400) {
        assert.equal(sb.calls.length, 0, `400 인데 병원 테이블 조회함: ${param}=${attack}`);
        return;
      }
      assert.equal(res.statusCode, 200, `${param}=${attack} → ${res.statusCode}`);
      // 200 이면: facilities 쿼리가 구조적으로 안전 + LTC 혼입 0
      const allowed = param === 'q'
        ? ['select', 'domain', 'or', 'order', 'offset', 'limit']
        : ['select', 'domain', param === 'sido' ? 'sido' : 'sigungu_nm', 'order', 'offset', 'limit'];
      const facCall = sb.calls.find((c) => c.table === 'facilities');
      assertSafeFacilitiesQuery(facCall.path, allowed);
      assert.ok(res.body.items.every((it) => /^H-/.test(it.facility.id)), 'LTC 혼입');
      // domain 필터가 파싱 단계에서도 정확히 HOSPITAL
      assert.ok(facCall.filters.some((f) => f.col === 'domain' && f.op === 'eq' && f.val === 'HOSPITAL'));
      assert.equal(facCall.filters.some((f) => f.col === 'domain' && f.val === 'LTC'), false);
    });
  }
}

test('보안: sido/sigungu 정상 한글 지역명은 회귀 없이 그대로 매칭', async () => {
  let sb = seededSb();
  let res = mkRes();
  await H({ sb })(mkReq({ query: { sido: '서울특별시' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map((it) => it.facility.id).sort(), ['H-h1', 'H-h2', 'H-h5']);

  sb = seededSb(); res = mkRes();
  await H({ sb })(mkReq({ query: { sigungu: '성남시 분당구' } }), res); // 공백 포함 지역명
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map((it) => it.facility.id), ['H-h3']);
});

test('보안: 정상 한글 기관명·주소 검색 회귀 없음', async () => {
  let sb = seededSb();
  let res = mkRes();
  await H({ sb })(mkReq({ query: { q: '요양병원' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 5); // 5곳 모두 name 에 '요양병원'

  sb = seededSb(); res = mkRes();
  await H({ sb })(mkReq({ query: { q: '테헤란로' } }), res); // address 에만 존재
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map((it) => it.facility.id), ['H-h1']);
});

test('보안: q 가 정제 후 빈 문자열이 되면 전체 목록으로 조용히 바뀌지 않고 400', async () => {
  for (const junk of ['***', '(),.', '%%%', '"\\', '...']) {
    const sb = seededSb();
    const res = mkRes();
    // eslint-disable-next-line no-await-in-loop
    await H({ sb })(mkReq({ query: { q: junk } }), res);
    assert.equal(res.statusCode, 400, `q=${JSON.stringify(junk)} → ${res.statusCode}`);
    assert.equal(sb.calls.length, 0);
  }
  // 반면 명시적 빈 문자열 q='' 는 "미지정" 계약 → 전체 목록
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({ query: { q: '' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 5);
  const facCall = sb.calls.find((c) => c.table === 'facilities');
  assert.equal(facCall.filters.some((f) => f.col === 'or'), false); // or 필터 없음
});

test('보안: order/limit/offset/select/domain 파라미터를 사용자가 보내도 무시된다', async () => {
  const sb = seededSb();
  const res = mkRes();
  await H({ sb })(mkReq({
    query: {
      order: 'established_at.desc', limit: '9999', offset: '5', select: '*',
      domain: 'LTC', or: '(name.ilike.*x*)',
    },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 5);
  assert.equal(res.body.size, 20); // limit=9999 무시
  assert.deepEqual(res.body.items.map((it) => it.facility.id), ['H-h1', 'H-h2', 'H-h3', 'H-h4', 'H-h5']); // 기본 정렬 유지
  const facCall = sb.calls.find((c) => c.table === 'facilities');
  assertSafeFacilitiesQuery(facCall.path, ['select', 'domain', 'order', 'offset', 'limit']);
  assert.equal(facCall.path.includes('LTC'), false);
});

test('정적: 모든 사용자 값이 URLSearchParams 를 거쳐 인코딩된다 (문자열 직접 연결 없음)', () => {
  const src = read('api/hospital/facilities.js');
  // sido/sigungu/or 를 URLSearchParams 인스턴스에 append 한다
  assert.ok(/new URLSearchParams\(\)/.test(src));
  assert.ok(/p\.append\('sido', `eq\.\$\{sidoR\.value\}`\)/.test(src));
  assert.ok(/p\.append\('or', `\(name\.ilike/.test(src));
  // 원문 sb 경로에 사용자 값을 백틱으로 직접 이어붙이지 않는다 (facilities 조회)
  assert.equal(/sb\(`facilities\?[^`]*\$\{(sidoR|sigunguR|qTerm|query\.)/.test(src), false);
  // domain 은 코드 상수
  assert.ok(src.includes("p.append('domain', 'eq.HOSPITAL')"));
});
