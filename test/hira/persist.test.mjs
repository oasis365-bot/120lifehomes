import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  persistCollected,
  assertPreviewDb,
  verifyPreviewDbUrl,
  allowedIngestDbHost,
  buildFacilityRow,
  buildProfileRow,
  SOURCE_SYSTEM,
} from '../../lib/hira/persist.js';
import { normalizeHospitalRecord, normalizeEvaluationRecord } from '../../lib/hira/adapter.js';
import { parseHiraResponse } from '../../lib/hira/parse.js';
import { makeMockSb } from './mockSb.mjs';

const fx = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const items = (name) => parseHiraResponse(JSON.stringify(fx(name))).items;
const first = (name) => items(name)[0];

function realBundle(overrides = {}) {
  const basis = { ...first('hospBasisList_clCd28.json'), ...(overrides.basis || {}) };
  return {
    basis,
    facility: first('detail_eqp.json'),
    detail: first('detail_dtl.json'),
    departments: items('detail_dgsbjt.json'),
    equipment: items('detail_medOft.json'),
    specialists: items('detail_spcSbjt.json'),
    otherStaff: items('detail_etcHst.json'),
  };
}

const ALL_OK_SOURCES = Object.freeze({
  facility: 'success_with_data', detail: 'success_with_data', departments: 'success_with_data',
  equipment: 'success_with_data', specialists: 'success_with_data', otherStaff: 'success_with_data',
});

function mkItem(overrides = {}) {
  const bundle = realBundle(overrides);
  const hospital = { ...normalizeHospitalRecord(bundle), ...(overrides.hospital || {}) };
  if (overrides.hash) hospital.normalized_hash = overrides.hash;
  const evalItem = overrides.evalItem === null ? null : (overrides.evalItem || first('hospAsm_withGrade.json'));
  const evaluation = normalizeEvaluationRecord({ basis: bundle.basis, evalItem });
  // collect 가 실을 sources (endpoint 상태). 지정 없으면 전부 정상.
  const sources = overrides.sources || ALL_OK_SOURCES;
  return {
    hospital, evaluation, sources,
    raw: { ...bundle, evalItem, collectedAt: '2026-09-07T00:00:00.000Z' },
  };
}

const NOW = () => '2026-09-07T12:00:00.000Z';

// ══════════════════════════════════════════════════════════════════════
// 신규 저장
// ══════════════════════════════════════════════════════════════════════
test('신규: facilities + hospital_profiles + facility_sources + evaluation + ingestion_runs', async () => {
  const sb = makeMockSb();
  const item = mkItem();
  const r = await persistCollected([item], { sb, now: NOW });

  assert.equal(r.stats.new, 1);
  assert.equal(r.stats.updated, 0);
  assert.equal(r.stats.unchanged, 0);
  assert.equal(r.stats.failed, 0);
  assert.equal(r.stats.evalNew, 1);

  const f = sb.tables.facilities[0];
  assert.equal(f.id, item.hospital.id);
  assert.equal(f.domain, 'HOSPITAL');
  assert.equal(f.type_code, '28');
  assert.equal(f.hira_ykiho, item.hospital.external_id);
  assert.equal(f.name, item.hospital.name);
  assert.equal(f.lat, item.hospital.lat);

  const p = sb.tables.hospital_profiles[0];
  assert.equal(p.facility_id, item.hospital.id);
  assert.equal(p.bed_total, 250);
  assert.deepEqual(p.medical_services, {});

  const s = sb.tables.facility_sources[0];
  assert.equal(s.source_system, SOURCE_SYSTEM);
  assert.equal(s.external_id, item.hospital.external_id);
  assert.equal(s.normalized_hash, item.hospital.normalized_hash);
  assert.ok(s.raw && s.raw.basis);

  const ev = sb.tables.facility_evaluations[0];
  assert.equal(ev.grade, '4');
  assert.equal(ev.grade_scale, 'HIRA_1_5');
  assert.equal(ev.evaluation_year, null);

  const run = sb.tables.ingestion_runs[0];
  assert.equal(run.job, 'hira_hospital_ingest');
  assert.equal(run.status, 'ok');
  assert.equal(run.count_new, 1);
  assert.equal(run.finished_at, NOW());
});

// ══════════════════════════════════════════════════════════════════════
// 재실행 무변경
// ══════════════════════════════════════════════════════════════════════
test('동일 데이터 재실행 → 무변경, 추가 write 없음', async () => {
  const sb = makeMockSb();
  const item = mkItem();
  await persistCollected([item], { sb, now: NOW });
  const writesAfter1 = sb.countWrites();

  const r2 = await persistCollected([item], { sb, now: NOW });
  assert.equal(r2.stats.unchanged, 1);
  assert.equal(r2.stats.new, 0);
  assert.equal(r2.stats.updated, 0);
  // 2회차엔 ingestion_runs 2개 행(POST+PATCH)만 늘어야 함 (앵커 hash 동일 → 그 외 write 0)
  assert.equal(sb.countWrites() - writesAfter1, 2);
  assert.equal(sb.tables.facilities.length, 1);
  assert.equal(sb.tables.facility_evaluations.length, 1);
});

// ══════════════════════════════════════════════════════════════════════
// 변경 → revision 생성 + 운영자 입력값 보존
// ══════════════════════════════════════════════════════════════════════
test('변경: 전화번호 바뀌면 facilities PATCH + facility_revisions 기록, 운영자 컬럼 불변', async () => {
  const sb = makeMockSb();
  const item1 = mkItem();
  await persistCollected([item1], { sb, now: NOW });

  // 운영자가 직접 채운 값 시뮬레이션
  const facRow = sb.tables.facilities[0];
  facRow.monthly_fee = 1500;
  facRow.is_partner = true;
  facRow.features = ['치매전담'];
  facRow.intro = '운영자 소개문';

  // 재수집: 전화번호 변경
  const item2 = mkItem({ basis: { telno: '055-999-0000' } });
  const r = await persistCollected([item2], { sb, now: NOW });

  assert.equal(r.stats.updated, 1);
  assert.equal(r.stats.new, 0);
  assert.equal(r.stats.revisions, 1);

  const rev = sb.tables.facility_revisions[0];
  assert.equal(rev.field, 'phone');
  assert.equal(rev.old_value, '055-320-2080');
  assert.equal(rev.new_value, '055-999-0000');
  assert.equal(rev.changed_by, 'pipeline:hira_hospital_ingest');

  const f = sb.tables.facilities[0];
  assert.equal(f.phone, '055-999-0000');
  // ── 운영자 입력값 보존 확인 ──
  assert.equal(f.monthly_fee, 1500);
  assert.equal(f.is_partner, true);
  assert.deepEqual(f.features, ['치매전담']);
  assert.equal(f.intro, '운영자 소개문');
});

test('buildFacilityRow / buildProfileRow 는 운영자 컬럼을 절대 포함하지 않음', () => {
  const item = mkItem();
  const fr = buildFacilityRow(item.hospital);
  for (const bad of ['monthly_fee', 'entry_fee', 'care_levels', 'features', 'intro', 'is_partner', 'capacity', 'current_count', 'eval_grade', 'eval_date', 'raw', 'detail_synced_at']) {
    assert.equal(bad in fr, false, `facility row 에 ${bad} 있음`);
  }
  const pr = buildProfileRow(item.hospital, item.hospital.id);
  assert.equal('created_at' in pr, false);
});

// ══════════════════════════════════════════════════════════════════════
// 1B-4A — source-aware: 부분응답이 기존 profile 값을 지우지 않음
// ══════════════════════════════════════════════════════════════════════

// 기존 완전 수집 1건을 저장해 두고, 특정 endpoint 만 상태를 바꿔 재수집하는 헬퍼
async function seedThenRecollect(sb, recollectOverrides) {
  await persistCollected([mkItem()], { sb, now: NOW });
  const prof0 = sb.tables.hospital_profiles[0];
  const before = JSON.parse(JSON.stringify(prof0));
  const w0 = sb.countWrites();
  const r = await persistCollected(
    [mkItem({ hash: 'recollect-hash-differs', ...recollectOverrides })],
    { sb, now: NOW },
  );
  return { r, before, after: sb.tables.hospital_profiles[0], newWrites: sb.countWrites() - w0 };
}

test('bed_detail 존재 + facility endpoint failed → bed_detail/bed_total/establishment_type 기존 값 유지', async () => {
  const sb = makeMockSb();
  const { after, before } = await seedThenRecollect(sb, {
    hospital: { bed_detail: null, bed_total: null, establishment_type: null },
    sources: { ...ALL_OK_SOURCES, facility: 'failed' },
  });
  assert.deepEqual(after.bed_detail, before.bed_detail);
  assert.equal(after.bed_total, before.bed_total);
  assert.equal(after.establishment_type, before.establishment_type);
  assert.ok(before.bed_total > 0, '사전조건: 기존 값 존재');
});

test('specialties 존재 + 진료과 endpoint 비정상(unavailable) → specialties/specialist_counts 유지', async () => {
  const sb = makeMockSb();
  const { after, before } = await seedThenRecollect(sb, {
    hospital: { specialties: [], specialist_counts: null },
    sources: { ...ALL_OK_SOURCES, departments: 'failed' }, // specialist_counts 는 departments+specialists 둘 다 필요
  });
  assert.deepEqual(after.specialties, before.specialties);
  assert.deepEqual(after.specialist_counts, before.specialist_counts);
  assert.ok(before.specialties.length > 0);
});

test('equipment 존재 + 장비 endpoint failed → equipment 유지, 다른 성공 필드는 갱신', async () => {
  const sb = makeMockSb();
  const { after, before } = await seedThenRecollect(sb, {
    hospital: { equipment: null, bed_total: 999 }, // equipment 는 실패, bed_total 은 성공적으로 변경
    sources: { ...ALL_OK_SOURCES, equipment: 'failed' },
  });
  assert.deepEqual(after.equipment, before.equipment, 'equipment 유지');
  assert.equal(after.bed_total, 999, 'facility 성공 → bed_total 갱신 (한 endpoint 실패가 다른 필드 갱신을 막지 않음)');
});

test('정상 성공 + authoritative empty(success_empty) → 기존 값 삭제(갱신)됨', async () => {
  const sb = makeMockSb();
  const { after, before } = await seedThenRecollect(sb, {
    hospital: { equipment: null, specialties: [] },
    // 해당 endpoint 가 "resultCode 정상 + 0건" (권위 있는 없음)
    sources: { ...ALL_OK_SOURCES, equipment: 'success_empty', departments: 'success_empty' },
  });
  assert.ok(before.equipment && before.equipment.length > 0);
  assert.equal(after.equipment, null, 'success_empty → 삭제');
  assert.deepEqual(after.specialties, [], 'success_empty → 빈 배열로 삭제');
});

test('success_with_data 인데 optional 원본 키 누락(값 null) → 기존 값 보존 (삭제 아님)', async () => {
  const sb = makeMockSb();
  const { after, before } = await seedThenRecollect(sb, {
    // getEqpInfo 는 item 을 줬지만 orgTyCdNm 이 없어 establishment_type=null 로 정규화된 상황
    hospital: { establishment_type: null, equipment: null },
    sources: { ...ALL_OK_SOURCES }, // 전부 success_with_data (success_empty 아님)
  });
  assert.equal(after.establishment_type, before.establishment_type, 'optional 키 누락 → 기존 값 유지');
  assert.ok(before.establishment_type);
  assert.deepEqual(after.equipment, before.equipment, 'optional 키 누락 → equipment 도 유지');
});

test('medical_services 는 파이프라인 미소유 — 운영자 FACILITY_CLAIMED 값이 재수집에 보존', async () => {
  const sb = makeMockSb();
  await persistCollected([mkItem()], { sb, now: NOW });
  assert.deepEqual(sb.tables.hospital_profiles[0].medical_services, {}, '신규 행: 기본값 {}');
  // 운영자/검증 절차가 채운 값
  sb.tables.hospital_profiles[0].medical_services = { dialysis: 'FACILITY_CLAIMED', rehab: 'VERIFIED_TRUE' };
  // profile 필드(bed_total)도 실제 바뀌는 재수집 → hospital_profiles PATCH 발생
  const r = await persistCollected(
    [mkItem({ hash: 'ms-recollect', hospital: { bed_total: 300 }, sources: { ...ALL_OK_SOURCES } })],
    { sb, now: NOW },
  );
  assert.equal(r.stats.updated, 1);
  assert.equal(sb.tables.hospital_profiles[0].bed_total, 300, 'bed_total 은 갱신');
  assert.deepEqual(sb.tables.hospital_profiles[0].medical_services,
    { dialysis: 'FACILITY_CLAIMED', rehab: 'VERIFIED_TRUE' }, 'medical_services 불변');
  const patches = sb.calls.filter((c) => c.method === 'PATCH' && c.table === 'hospital_profiles');
  assert.ok(patches.length >= 1, 'hospital_profiles PATCH 발생');
  for (const p of patches) assert.equal('medical_services' in (p.body || {}), false, 'PATCH body 에 medical_services 없음');
});

test('count=0 / false 는 유효값 — endpoint 성공 시 그대로 저장', async () => {
  const sb = makeMockSb();
  const { after } = await seedThenRecollect(sb, {
    hospital: { bed_total: 0, bed_detail: { standard: 0, higher: 0 } },
    sources: { ...ALL_OK_SOURCES },
  });
  assert.equal(after.bed_total, 0, '0 은 빈 값이 아님');
  assert.deepEqual(after.bed_detail, { standard: 0, higher: 0 });
});

test('동일 부분응답 재실행 → 멱등 (2회차 profile write 0)', async () => {
  const sb = makeMockSb();
  await persistCollected([mkItem()], { sb, now: NOW });
  // 부분응답(장비 실패). collect 라면 동일 sources → 동일 hash. 여기선 동일 hash 를 명시.
  const partialItem = () => mkItem({
    hash: 'partial-hash', hospital: { equipment: null },
    sources: { ...ALL_OK_SOURCES, equipment: 'failed' },
  });
  await persistCollected([partialItem()], { sb, now: NOW });
  const w = sb.countWrites();
  const r = await persistCollected([partialItem()], { sb, now: NOW });
  assert.equal(r.stats.unchanged, 1);
  assert.equal(sb.countWrites() - w, 2); // ingestion_runs POST+PATCH 만
});

test('부분 → 정상 회복: 다음 정상 수집에서 최신 값으로 복구', async () => {
  const sb = makeMockSb();
  await persistCollected([mkItem()], { sb, now: NOW });
  // 장비 실패 → equipment 유지
  await persistCollected([mkItem({ hash: 'h-partial', hospital: { equipment: null }, sources: { ...ALL_OK_SOURCES, equipment: 'failed' } })], { sb, now: NOW });
  const mid = sb.tables.hospital_profiles[0].equipment;
  assert.ok(mid && mid.length > 0, '부분수집 동안 equipment 유지됨');
  // 정상 회복 (equipment 에 새 목록)
  const recovered = [{ code: 'X999', name: 'CT', count: 1 }];
  await persistCollected([mkItem({ hash: 'h-recovered', hospital: { equipment: recovered }, sources: { ...ALL_OK_SOURCES } })], { sb, now: NOW });
  assert.deepEqual(sb.tables.hospital_profiles[0].equipment, recovered);
});

test('시설 기본정보(phone)의 정상 변경은 상세 endpoint 실패와 무관하게 반영', async () => {
  const sb = makeMockSb();
  await persistCollected([mkItem()], { sb, now: NOW });
  const r = await persistCollected([mkItem({
    hash: 'h-x', basis: { telno: '055-111-2222' },
    hospital: { equipment: null, bed_detail: null },
    sources: { ...ALL_OK_SOURCES, equipment: 'failed', facility: 'failed' },
  })], { sb, now: NOW });
  assert.equal(sb.tables.facilities[0].phone, '055-111-2222', 'basis 변경 반영');
  assert.equal(r.stats.revisions, 1);
  assert.ok(sb.tables.hospital_profiles[0].bed_detail, 'bed_detail 유지 (facility 실패)');
});

test('sources 는 facility_sources.raw / ingestion_runs 에 저장되지 않음', async () => {
  const sb = makeMockSb();
  await persistCollected([mkItem({ sources: { ...ALL_OK_SOURCES, equipment: 'failed' } })], { sb, now: NOW });
  const src = sb.tables.facility_sources[0];
  assert.equal('sources' in src, false);
  assert.equal(JSON.stringify(src.raw).includes('success_with_data'), false);
  assert.equal(JSON.stringify(src.raw).includes('"sources"'), false);
  const run = sb.tables.ingestion_runs.find((x) => x.detail);
  assert.equal(JSON.stringify(run.detail).includes('success_with_data'), false);
  // 집계 수치(sourceIncomplete)는 허용 (기관 식별정보 아님)
  assert.equal(typeof run.detail.sourceIncomplete, 'number');
});

test('부분실패 기관 있으면 ingestion_runs status=partial + sourceIncomplete 카운트', async () => {
  const sb = makeMockSb();
  const r = await persistCollected([
    mkItem(),
    mkItem({ basis: { ykiho: 'YK2', yadmNm: 'B' }, hospital: { id: 'H-YK2', external_id: 'YK2' }, sources: { ...ALL_OK_SOURCES, otherStaff: 'failed' } }),
  ], { sb, now: NOW });
  assert.equal(r.status, 'partial');
  assert.equal(r.stats.sourceIncomplete, 1);
  assert.equal(r.stats.failed, 0);
});

// ══════════════════════════════════════════════════════════════════════
// 부분 실패
// ══════════════════════════════════════════════════════════════════════
test('부분 실패: evaluation POST 가 실패해도 facilities 는 저장, partial 카운트', async () => {
  const sb = makeMockSb();
  const origSb = sb;
  // facility_evaluations POST 만 강제 실패
  const wrapped = async (path, opt = {}) => {
    if (path.startsWith('facility_evaluations') && (opt.method || 'GET') === 'POST') {
      throw new Error('Supabase 500 facility_evaluations :: boom');
    }
    return origSb(path, opt);
  };
  wrapped.tables = origSb.tables;

  const r = await persistCollected([mkItem()], { sb: wrapped, now: NOW });
  assert.equal(r.stats.partial, 1);
  assert.equal(r.stats.failed, 0);
  assert.equal(sb.tables.facilities.length, 1); // 시설은 저장됨
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].partial, true);
  assert.ok(r.failures[0].ykiho.includes('…') || r.failures[0].ykiho.includes('***'));
});

// ══════════════════════════════════════════════════════════════════════
// NULL 평가연도 중복 방지 + 동시 충돌
// ══════════════════════════════════════════════════════════════════════
test('NULL 평가연도: 두 번 적재해도 facility_evaluations 1행', async () => {
  const sb = makeMockSb();
  const item = mkItem();
  await persistCollected([item], { sb, now: NOW });
  // hash 를 억지로 바꿔 재적재 경로 강제
  const item2 = { ...item, hospital: { ...item.hospital, normalized_hash: 'different-hash-xxxx' } };
  await persistCollected([item2], { sb, now: NOW });
  assert.equal(sb.tables.facility_evaluations.length, 1);
});

test('동시 충돌: evaluation POST 가 409 → 재조회 후 PATCH, 중복 INSERT 없음', async () => {
  const sb = makeMockSb();
  sb.injectRace('facility_evaluations'); // 다음 POST 는 409 + 경쟁자가 행을 먼저 넣음
  const item = mkItem();
  const r = await persistCollected([item], { sb, now: NOW });
  assert.equal(sb.tables.facility_evaluations.length, 1); // 중복 없음
  assert.equal(r.stats.evalNew, 0);
  assert.equal(r.stats.evalUpdated, 1);
  assert.equal(r.stats.failed, 0);
});

test('동시 충돌: facilities POST 가 409 → 재조회 후 PATCH 경로', async () => {
  const sb = makeMockSb();
  sb.injectRace('facilities');
  const item = mkItem();
  const r = await persistCollected([item], { sb, now: NOW });
  assert.equal(sb.tables.facilities.length, 1);
  assert.equal(r.stats.failed, 0);
});

// ══════════════════════════════════════════════════════════════════════
// ykiho 중복 방지 / 평가 없음
// ══════════════════════════════════════════════════════════════════════
test('배치 내 같은 ykiho 2건 → 1건만 처리', async () => {
  const sb = makeMockSb();
  const item = mkItem();
  const r = await persistCollected([item, item], { sb, now: NOW });
  assert.equal(r.stats.new, 1);
  assert.equal(r.stats.unchanged, 1); // 두 번째는 중복 스킵
  assert.equal(sb.tables.facilities.length, 1);
});

test('평가정보 없음 → facility_evaluations 미기록, evalMissing', async () => {
  const sb = makeMockSb();
  const r = await persistCollected([mkItem({ evalItem: null })], { sb, now: NOW });
  assert.equal(r.stats.evalMissing, 1);
  assert.equal(sb.tables.facility_evaluations.length, 0);
  assert.equal(r.stats.new, 1);
});

// ══════════════════════════════════════════════════════════════════════
// verifyPreviewDbUrl — 허용 DB 목적지 검증 (allowed host 는 env HOSPITAL_INGEST_DB_HOST)
// ══════════════════════════════════════════════════════════════════════
// 테스트용 합성 hostname — 실제 프로젝트 ref 는 코드·테스트 어디에도 넣지 않는다.
const ALLOWED_HOST = 'preview-db-ref-test.supabase.co';
const OTHER_HOST = 'another-db-ref-test.supabase.co';
const PREVIEW_URL = `https://${ALLOWED_HOST}`;
const okReason = (r) => r.ok === true;
const bad = (r) => r.ok === false && r.reason === 'wrong_preview_db';
const V = (url) => verifyPreviewDbUrl(url, ALLOWED_HOST);

test('allowedIngestDbHost: env HOSPITAL_INGEST_DB_HOST 만 읽고 트림, 미설정 → null', () => {
  assert.equal(allowedIngestDbHost({ HOSPITAL_INGEST_DB_HOST: `  ${ALLOWED_HOST}  ` }), ALLOWED_HOST);
  assert.equal(allowedIngestDbHost({}), null);
  assert.equal(allowedIngestDbHost({ HOSPITAL_INGEST_DB_HOST: '' }), null);
  assert.equal(allowedIngestDbHost({ HOSPITAL_INGEST_DB_HOST: 42 }), null);
});

test('verifyPreviewDbUrl: expectedHost 미지정 → 거부 (fail-closed)', () => {
  assert.ok(bad(verifyPreviewDbUrl(PREVIEW_URL)));
  assert.ok(bad(verifyPreviewDbUrl(PREVIEW_URL, '')));
  assert.ok(bad(verifyPreviewDbUrl(PREVIEW_URL, null)));
  assert.ok(bad(verifyPreviewDbUrl(PREVIEW_URL, '   ')));
});

test('verifyPreviewDbUrl: 정확한 허용 hostname → 통과', () => {
  assert.ok(okReason(V(PREVIEW_URL)));
  assert.ok(okReason(V(`${PREVIEW_URL}/`))); // 끝 슬래시 하나는 허용
  assert.ok(okReason(V(` ${PREVIEW_URL} `))); // 트림
});

test('verifyPreviewDbUrl: 다른 Supabase hostname → 거부', () => {
  assert.ok(bad(V(`https://${OTHER_HOST}`)));
  assert.ok(bad(V('https://prod.supabase.co')));
});

test('verifyPreviewDbUrl: 유사 hostname → 거부 (부분문자열/endsWith/includes 아님)', () => {
  assert.ok(bad(V(`https://${ALLOWED_HOST}.evil.example`)));
  assert.ok(bad(V(`https://evil.${ALLOWED_HOST}`)));
  assert.ok(bad(V(`https://${ALLOWED_HOST}x`)));
  assert.ok(bad(V(`https://x${ALLOWED_HOST}`)));
  assert.ok(bad(V(`https://${ALLOWED_HOST}.`))); // 트레일링 닷
});

test('verifyPreviewDbUrl: http / 잘못된 protocol → 거부', () => {
  assert.ok(bad(V(`http://${ALLOWED_HOST}`)));
  assert.ok(bad(V(`postgres://${ALLOWED_HOST}`)));
  assert.ok(bad(V(`ftp://${ALLOWED_HOST}`)));
});

test('verifyPreviewDbUrl: port / path / query / hash / 인증정보 포함 → 거부', () => {
  assert.ok(bad(V(`https://${ALLOWED_HOST}:5432`)));
  assert.ok(bad(V(`https://${ALLOWED_HOST}/rest/v1`)));
  assert.ok(bad(V(`https://${ALLOWED_HOST}?x=1`)));
  assert.ok(bad(V(`https://${ALLOWED_HOST}#frag`)));
  assert.ok(bad(V(`https://user:pass@${ALLOWED_HOST}`)));
  assert.ok(bad(V(`https://user@${ALLOWED_HOST}`)));
});

test('verifyPreviewDbUrl: 미설정 / 형식 오류 → 거부', () => {
  for (const v of ['', '   ', undefined, null, 42, {}, 'not a url', ALLOWED_HOST, `//${ALLOWED_HOST}`]) {
    assert.ok(bad(V(v)), `허용됨: ${JSON.stringify(v)}`);
  }
});

test('verifyPreviewDbUrl: 실패 reason 은 wrong_preview_db 뿐, URL·ref 없음', () => {
  const r = V(`https://${OTHER_HOST}/rest/v1?token=abc#x`);
  assert.equal(r.reason, 'wrong_preview_db');
  assert.ok(!/supabase|http|ref-test|token|\d{3,}/.test(r.reason));
});

// ══════════════════════════════════════════════════════════════════════
// assertPreviewDb  (verifyPreviewDbUrl 을 step 0 으로 포함)
// ══════════════════════════════════════════════════════════════════════
const previewEnv = (extra = {}) => ({
  VERCEL_ENV: 'preview', SUPABASE_URL: PREVIEW_URL, HOSPITAL_INGEST_DB_HOST: ALLOWED_HOST, ...extra,
});

test('assertPreviewDb: HOSPITAL_INGEST_DB_HOST 미설정 → wrong_preview_db, DB 쿼리 0', async () => {
  const sb = makeMockSb();
  const g = await assertPreviewDb({ sb, env: { VERCEL_ENV: 'preview', SUPABASE_URL: PREVIEW_URL } });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'wrong_preview_db');
  assert.equal(sb.calls.length, 0);
});

test('assertPreviewDb: 정확한 URL + 빈 Preview DB → ok', async () => {
  const sb = makeMockSb();
  const g = await assertPreviewDb({ sb, env: previewEnv() });
  assert.equal(g.ok, true);
});

test('assertPreviewDb: SUPABASE_URL 이 운영 hostname → wrong_preview_db, DB 쿼리 0', async () => {
  const sb = makeMockSb();
  const g = await assertPreviewDb({ sb, env: previewEnv({ SUPABASE_URL: `https://${OTHER_HOST}` }) });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'wrong_preview_db');
  assert.equal(sb.calls.length, 0); // 목적지 검증 전에 DB 접속 안 함
});

test('assertPreviewDb: SUPABASE_URL 미설정 → wrong_preview_db (DB 쿼리 0)', async () => {
  const sb = makeMockSb();
  const g = await assertPreviewDb({ sb, env: { VERCEL_ENV: 'preview', HOSPITAL_INGEST_DB_HOST: ALLOWED_HOST } });
  assert.equal(g.reason, 'wrong_preview_db');
  assert.equal(sb.calls.length, 0);
});

test('assertPreviewDb: SUPABASE_URL 에 path/port 포함 → wrong_preview_db', async () => {
  const sb = makeMockSb();
  assert.equal((await assertPreviewDb({ sb, env: previewEnv({ SUPABASE_URL: `${PREVIEW_URL}/rest/v1` }) })).reason, 'wrong_preview_db');
  assert.equal((await assertPreviewDb({ sb, env: previewEnv({ SUPABASE_URL: `https://${ALLOWED_HOST}:6543` }) })).reason, 'wrong_preview_db');
});

test('assertPreviewDb: LTC 행 있으면(운영 DB) → 중단', async () => {
  const sb = makeMockSb({ facilities: [{ id: '11111000006', domain: 'LTC', name: '청운노인요양원' }] });
  const g = await assertPreviewDb({ sb, env: previewEnv() });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'db_has_ltc_rows');
});

test('assertPreviewDb: hospital_module ON → 중단', async () => {
  const sb = makeMockSb({ feature_flags: [{ key: 'hospital_module', enabled: true }] });
  const g = await assertPreviewDb({ sb, env: previewEnv() });
  assert.equal(g.reason, 'hospital_module_on');
});

test('assertPreviewDb: production 환경 → 중단 (URL 검증보다 먼저)', async () => {
  const sb = makeMockSb();
  const g = await assertPreviewDb({ sb, env: previewEnv({ VERCEL_ENV: 'production' }) });
  assert.equal(g.reason, 'production_env');
});

test('assertPreviewDb: 플래그 행 없음(migration 미적용) → 중단', async () => {
  const sb = makeMockSb({ feature_flags: [] });
  const g = await assertPreviewDb({ sb, env: previewEnv() });
  assert.equal(g.reason, 'flag_missing');
});

test('assertPreviewDb: 스키마 불완전 → schema_incomplete', async () => {
  const sb = makeMockSb();
  const wrap = async (p, o) => {
    if (p.startsWith('facility_sources')) throw new Error('Supabase 404 :: relation does not exist');
    return sb(p, o);
  };
  const g = await assertPreviewDb({ sb: wrap, env: previewEnv() });
  assert.equal(g.reason, 'schema_incomplete');
});

test('assertPreviewDb: 모든 실패 reason 에 URL·ref·행수·키 없음', async () => {
  const cases = [
    { env: previewEnv({ VERCEL_ENV: 'production' }), sb: makeMockSb() },
    { env: previewEnv({ SUPABASE_URL: `https://${OTHER_HOST}` }), sb: makeMockSb() },
    { env: previewEnv(), sb: makeMockSb({ facilities: [{ id: 'x', domain: 'LTC' }] }) },
    { env: previewEnv(), sb: makeMockSb({ feature_flags: [{ key: 'hospital_module', enabled: true }] }) },
  ];
  for (const c of cases) {
    const g = await assertPreviewDb({ sb: c.sb, env: c.env });
    assert.ok(!/supabase\.co|https?:|ref-test|token|apikey|\d{4,}/.test(g.reason || ''), `reason leak: ${g.reason}`);
  }
});

// ══════════════════════════════════════════════════════════════════════
// 비밀정보 비노출
// ══════════════════════════════════════════════════════════════════════
test('persist 결과(stats/failures)에 ykiho 원문 없음', async () => {
  const sb = makeMockSb();
  const wrapped = async (p, o = {}) => {
    if (p.startsWith('facility_sources') && (o.method || 'GET') === 'POST') throw new Error('Supabase 500 :: x');
    return sb(p, o);
  };
  wrapped.tables = sb.tables;
  const r = await persistCollected([mkItem()], { sb: wrapped, now: NOW });
  const blob = JSON.stringify({ stats: r.stats, failures: r.failures });
  assert.equal(/JDQ4[A-Za-z0-9+/]{20,}/.test(blob), false);
});
