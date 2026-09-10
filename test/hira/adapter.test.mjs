import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  hospitalIdFromYkiho,
  normalizeHospitalRecord,
  normalizeEvaluationRecord,
  normalizedHash,
  stripForHash,
  toCoord,
  toDateISO,
  toCount,
  normalizeSido,
  HOSPITAL_DOMAIN,
  EVAL_GRADE_SCALE,
} from '../../lib/hira/adapter.js';
import { parseHiraResponse } from '../../lib/hira/parse.js';
import * as RAW from './fixtures/raw.mjs';

const fx = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const items = (name) => parseHiraResponse(JSON.stringify(fx(name))).items;
const first = (name) => items(name)[0];

// 실측 raw 묶음 (성모아하브요양병원)
function realBundle() {
  return {
    basis: first('hospBasisList_clCd28.json'),
    facility: first('detail_eqp.json'),
    detail: first('detail_dtl.json'),
    departments: items('detail_dgsbjt.json'),
    equipment: items('detail_medOft.json'),
    specialists: items('detail_spcSbjt.json'),
    otherStaff: items('detail_etcHst.json'),
  };
}

test('hospitalIdFromYkiho — "H-"+원문, 공백 트림, 빈 값 throw', () => {
  assert.equal(hospitalIdFromYkiho('ABC'), 'H-ABC');
  assert.equal(hospitalIdFromYkiho('  ABC  '), 'H-ABC');
  assert.throws(() => hospitalIdFromYkiho(''));
  assert.throws(() => hospitalIdFromYkiho(null));
});

test('normalizeHospitalRecord — 실측 필드 매핑', () => {
  const n = normalizeHospitalRecord(realBundle());
  assert.equal(n.domain, HOSPITAL_DOMAIN);
  assert.equal(n.type_code, '28');
  assert.equal(n.type_label, '요양병원');
  assert.equal(n.facility_type, 'NURSING_HOSPITAL');
  assert.equal(n.source, 'hira_public');
  assert.equal(n.id, 'H-' + n.external_id);
  assert.equal(n.name, '(의)밀성학원의료재단 성모아하브요양병원');
  assert.equal(n.address, '경상남도 김해시 김해대로 2479-1, (삼정동)');
  assert.equal(n.sido, '경상남도'); // 축약형 "경남" → 정식명
  assert.equal(n.sido_raw, '경남');
  assert.equal(n.sigungu_nm, '김해시');
  assert.equal(n.dong_nm, '삼정동');
  assert.equal(n.post_no, '50934');
  assert.equal(n.phone, '055-320-2080');
  assert.equal(n.established_at, '2010-07-27');
  assert.equal(n.lng, 128.8980324);
  assert.equal(n.lat, 35.2281381);
  // 병상
  assert.equal(n.bed_total, 250);
  assert.equal(n.bed_detail.standard, 212);
  assert.equal(n.bed_detail.higher, 38);
  assert.equal(n.establishment_type, '의료법인');
  // 진료과목 / 전문의
  assert.ok(n.specialties.includes('내과'));
  assert.ok(n.specialties.includes('침구과'));
  assert.equal(n.specialist_counts['내과'], 1);
  assert.equal(n.specialist_counts['외과'], 2);
  // 장비 / 기타인력
  assert.deepEqual(n.equipment[0], { code: 'B101', name: '일반엑스선촬영장치', count: 1 });
  assert.equal(n.other_staff['약사'], 1);
  // 운영정보
  assert.equal(n.operations.parking_qty, 25);
  assert.equal(n.operations.hours.mon.start, '09:00');
  assert.equal(n.operations.hours.mon.end, '17:00');
  // 추측 금지 항목
  assert.equal(n.operating_status, null);
  assert.equal(n.source_date, null);
  assert.deepEqual(n.medical_services, {});
  // 해시
  assert.match(n.normalized_hash, /^[0-9a-f]{64}$/);
});

test('6. XPos/YPos number/string 혼재 처리', () => {
  const b = realBundle();
  b.basis = { ...b.basis, XPos: '129.2269050', YPos: 35.2228262 }; // 문자열 경도
  const n = normalizeHospitalRecord(b);
  assert.equal(n.lng, 129.226905);
  assert.equal(n.lat, 35.2228262);
  assert.equal(n._warnings.length, 0);
});

test('7. 빈 좌표 / 비정상 좌표 → NULL + 경고', () => {
  const zero = toCoord(0, 0);
  assert.equal(zero.lat, null);
  assert.equal(zero.lng, null);
  assert.match(zero.warning, /좌표/);

  const empty = toCoord('', '');
  assert.equal(empty.lng, null);

  const outOfRange = toCoord(200, 80); // 대한민국 밖
  assert.equal(outOfRange.lat, null);

  const nanCase = toCoord('N/A', 'N/A');
  assert.equal(nanCase.lat, null);

  const b = realBundle();
  b.basis = { ...b.basis, XPos: '', YPos: '' };
  const n = normalizeHospitalRecord(b);
  assert.equal(n.lat, null);
  assert.equal(n.lng, null);
  assert.ok(n._warnings.some((w) => /좌표/.test(w)));
});

test('8. asmGrd10 — 1~5 / 등급제외 / 빈 값', () => {
  const basis = first('hospBasisList_clCd28.json');

  assert.equal(EVAL_GRADE_SCALE, 'HIRA_1_5'); // 확정: HIRA 는 이 한 값만

  const g4 = normalizeEvaluationRecord({ basis, evalItem: first('hospAsm_withGrade.json') });
  assert.equal(g4.grade, '4');
  assert.equal(g4.grade_scale, 'HIRA_1_5');
  assert.equal(g4.evaluation_year, null); // ⚠️ 추측 금지
  assert.equal(g4.evaluation_authority, 'HIRA');
  assert.equal(g4.facility_id, 'H-' + g4.external_id);

  const excl = normalizeEvaluationRecord({
    basis,
    evalItem: parseHiraResponse(RAW.JSON_ASM_EXCLUDED).items[0],
  });
  assert.equal(excl.grade, '등급제외'); // 원문 보존
  assert.equal(excl.grade_scale, 'HIRA_1_5'); // 등급제외도 동일 scale

  const none = normalizeEvaluationRecord({
    basis,
    evalItem: parseHiraResponse(RAW.JSON_ASM_NONE).items[0],
  });
  assert.equal(none, null); // 평가정보 없음

  const emptyList = normalizeEvaluationRecord({ basis, evalItem: null });
  assert.equal(emptyList, null);

  // 숫자 문자열 "3" 도 정상 처리
  const s3 = normalizeEvaluationRecord({ basis, evalItem: { ykiho: basis.ykiho, asmGrd10: '3' } });
  assert.equal(s3.grade, '3');
});

test('9. 병상·인력·장비 일부 누락 — 정규화 계속', () => {
  const b = realBundle();
  delete b.facility; // 시설정보 실패
  b.equipment = []; // 장비 0건
  b.otherStaff = null; // 기타인력 실패
  const n = normalizeHospitalRecord(b);
  assert.equal(n.bed_total, null);
  assert.equal(n.bed_detail, null);
  assert.equal(n.equipment, null);
  assert.equal(n.other_staff, null);
  assert.equal(n.establishment_type, null);
  // 그래도 기본정보·진료과목은 유지
  assert.equal(n.name, '(의)밀성학원의료재단 성모아하브요양병원');
  assert.ok(n.specialties.length > 0);
});

test('9b. basis 없으면 throw', () => {
  assert.throws(() => normalizeHospitalRecord({}));
  assert.throws(() => normalizeHospitalRecord({ basis: { yadmNm: '이름만' } })); // ykiho 없음
});

test('9c. clCd != 28 이면 경고', () => {
  const b = realBundle();
  b.basis = { ...b.basis, clCd: 31 };
  const n = normalizeHospitalRecord(b);
  assert.ok(n._warnings.some((w) => /clCd/.test(w)));
});

test('normalizedHash 는 키 순서에 무관하게 안정적', () => {
  const a = normalizedHash({ x: 1, y: [{ b: 2, a: 1 }] });
  const b = normalizedHash({ y: [{ a: 1, b: 2 }], x: 1 });
  assert.equal(a, b);
});

test('stripForHash — _warnings / normalized_hash 제외, 나머지 그대로 (해시 계약)', () => {
  const n = normalizeHospitalRecord(realBundle());
  const s = stripForHash(n);
  assert.equal('_warnings' in s, false);
  assert.equal('normalized_hash' in s, false);
  assert.equal(s.external_id, n.external_id);
  assert.equal(s.bed_total, n.bed_total);
  // collect 가 쓰는 source-aware 합성: sources 순서/추가에 대해 안정적
  const h1 = normalizedHash({ core: s, sources: { a: 'x', b: 'y' } });
  const h2 = normalizedHash({ sources: { b: 'y', a: 'x' }, core: s });
  assert.equal(h1, h2);
  assert.notEqual(h1, normalizedHash({ core: s, sources: { a: 'x', b: 'z' } }));
});

test('util — toDateISO / toCount / normalizeSido', () => {
  assert.equal(toDateISO(20100727), '2010-07-27');
  assert.equal(toDateISO('20190207'), '2019-02-07');
  assert.equal(toDateISO('2019'), null);
  assert.equal(toDateISO(null), null);
  assert.equal(toDateISO('20191345'), null); // 잘못된 월/일

  assert.equal(toCount(5), 5);
  assert.equal(toCount('5'), 5);
  assert.equal(toCount(-1), null);
  assert.equal(toCount(1.5), null);
  assert.equal(toCount(''), null);

  assert.equal(normalizeSido('경남'), '경상남도');
  assert.equal(normalizeSido('서울'), '서울특별시');
  assert.equal(normalizeSido('알수없음'), '알수없음');
  assert.equal(normalizeSido(null), null);
});
