import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  persistCollected,
  assertPreviewDb,
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

function mkItem(overrides = {}) {
  const bundle = realBundle(overrides);
  const hospital = normalizeHospitalRecord(bundle);
  const evalItem = overrides.evalItem === null ? null : (overrides.evalItem || first('hospAsm_withGrade.json'));
  const evaluation = normalizeEvaluationRecord({ basis: bundle.basis, evalItem });
  return { hospital, evaluation, raw: { ...bundle, evalItem, collectedAt: '2026-09-07T00:00:00.000Z' } };
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
// assertPreviewDb
// ══════════════════════════════════════════════════════════════════════
test('assertPreviewDb: 빈 Preview DB → ok', async () => {
  const sb = makeMockSb();
  // 001 스키마 테이블 존재 (mockSb 가 기본 생성) + hospital_module=false
  const g = await assertPreviewDb({ sb, env: { VERCEL_ENV: 'preview' } });
  assert.equal(g.ok, true);
});

test('assertPreviewDb: LTC 행 있으면(운영 DB) → 중단', async () => {
  const sb = makeMockSb({ facilities: [{ id: '11111000006', domain: 'LTC', name: '청운노인요양원' }] });
  const g = await assertPreviewDb({ sb, env: { VERCEL_ENV: 'preview' } });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'db_has_ltc_rows');
});

test('assertPreviewDb: hospital_module ON → 중단', async () => {
  const sb = makeMockSb({ feature_flags: [{ key: 'hospital_module', enabled: true }] });
  const g = await assertPreviewDb({ sb, env: { VERCEL_ENV: 'preview' } });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'hospital_module_on');
});

test('assertPreviewDb: production 환경 → 중단', async () => {
  const sb = makeMockSb();
  const g = await assertPreviewDb({ sb, env: { VERCEL_ENV: 'production' } });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'production_env');
});

test('assertPreviewDb: 플래그 행 없음(migration 미적용) → 중단', async () => {
  const sb = makeMockSb({ feature_flags: [] });
  const g = await assertPreviewDb({ sb, env: { VERCEL_ENV: 'preview' } });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'flag_missing');
});

test('assertPreviewDb reason 에 URL·행수·키 없음', async () => {
  const sb = makeMockSb({ facilities: [{ id: 'x', domain: 'LTC', name: 'n' }] });
  const g = await assertPreviewDb({ sb, env: { VERCEL_ENV: 'preview', SUPABASE_URL: 'https://prod.supabase.co' } });
  assert.ok(!/supabase\.co|https|\d{3,}/.test(g.reason));
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
