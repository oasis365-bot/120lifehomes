// =====================================================================
// HIRA (건강보험심사평가원) 데이터 어댑터 — 원본(raw) → 우리 스키마 정규화
// =====================================================================
//  1B-1 실측(2026-09-07) 응답 필드 기준으로 구현.
//  우리 스키마(확정): db/migrations/001_hospital_module_up.sql
//    facilities(id='H-'+ykiho, domain='HOSPITAL', source='hira_public', hira_ykiho, type_code='28', type_label='요양병원')
//    hospital_profiles(facility_id, establishment_type, bed_total, bed_detail, specialties,
//                      specialist_counts, equipment, homepage, medical_services{...})
//    facility_evaluations(facility_id, evaluation_authority='HIRA', evaluation_name,
//                         evaluation_year(NULL — API 미제공), grade, grade_scale, ...)
//    facility_sources(source_system, external_id=ykiho원문, raw, normalized_hash, ...)
//
//  원칙(개발지시서):
//    · 요양병원 적정성평가(asmGrd10)를 요양원 A~E 와 같은 점수로 환산·서열화하지 않는다.
//    · 응답에 없는 값(평가 연도·회차, 폐업 상태)을 추측하거나 현재 연도/현재 상태로 채우지 않는다.
//    · 데이터가 없다는 이유로 medical_services 를 VERIFIED_FALSE 로 두지 않는다. 기본 UNKNOWN.
// =====================================================================
import { createHash } from 'node:crypto';

export const HIRA_ADAPTER_CONTRACT_VERSION = '1.0.0-1B-2';

export const HOSPITAL_DOMAIN = 'HOSPITAL'; // facilities.domain (001 CHECK: 'LTC'|'HOSPITAL')
export const HOSPITAL_SOURCE = 'hira_public'; // facilities.source
export const HOSPITAL_FACILITY_TYPE = 'NURSING_HOSPITAL'; // 의미 라벨 (도메인=HOSPITAL 의 세부)
export const HOSPITAL_TYPE_CODE = '28'; // clCd 요양병원
export const HOSPITAL_TYPE_LABEL = '요양병원';
export const HOSPITAL_CL_CD = '28';

export const EVAL_AUTHORITY = 'HIRA';
export const EVAL_NAME = '요양병원 입원급여 적정성평가';
// HIRA 요양병원 적정성평가는 이 한 가지 scale 만 쓴다.
// grade 값 = '1'~'5' (정수 등급) 또는 '등급제외' (원문 보존). 요양원 LTC_A_E 와 절대 혼용·환산 금지.
export const EVAL_GRADE_SCALE = 'HIRA_1_5';

// ── 시도명 정규화: hospInfoServicev2 는 축약형("경남")을 준다. 우리 REGIONS.name 은 정식명. ──
const SIDO_FULL = {
  서울: '서울특별시', 부산: '부산광역시', 대구: '대구광역시', 인천: '인천광역시',
  광주: '광주광역시', 대전: '대전광역시', 울산: '울산광역시', 세종: '세종특별자치시',
  경기: '경기도', 강원: '강원특별자치도', 충북: '충청북도', 충남: '충청남도',
  전북: '전북특별자치도', 전남: '전라남도', 경북: '경상북도', 경남: '경상남도',
  제주: '제주특별자치도',
};

// ── util ──
export function cleanStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 병상/인력 카운트: 정수 아니거나 음수면 null. */
export function toCount(v) {
  const n = toNum(v);
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** YYYYMMDD (숫자/문자 혼재) → 'YYYY-MM-DD' | null */
export function toDateISO(v) {
  const s = String(v ?? '').replace(/[^\d]/g, '');
  if (s.length !== 8) return null;
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * 좌표 정규화 — XPos/YPos 는 number|string 혼재. NaN·0·범위 밖은 NULL + 경고.
 * @param {any} xpos 경도  @param {any} ypos 위도
 * @returns {{ lat:number|null, lng:number|null, warning:string|null }}
 */
export function toCoord(xpos, ypos) {
  const lng = parseFloat(String(xpos ?? '').trim());
  const lat = parseFloat(String(ypos ?? '').trim());
  const okLng = Number.isFinite(lng) && lng !== 0 && lng >= 124 && lng <= 132; // 대한민국 경도대
  const okLat = Number.isFinite(lat) && lat !== 0 && lat >= 33 && lat <= 39; // 대한민국 위도대
  if (okLng && okLat) return { lat, lng, warning: null };
  const bad = [];
  if (!okLng) bad.push(`XPos=${JSON.stringify(xpos)}`);
  if (!okLat) bad.push(`YPos=${JSON.stringify(ypos)}`);
  return { lat: null, lng: null, warning: `좌표 무효/누락 → NULL 처리 (${bad.join(', ')})` };
}

export function normalizeSido(short) {
  const s = cleanStr(short);
  if (!s) return null;
  return SIDO_FULL[s] || s;
}

/** 정규화 결과의 안정적 해시 (재수집 시 변경 감지용) */
export function normalizedHash(obj) {
  const canon = JSON.stringify(sortKeysDeep(obj));
  return createHash('sha256').update(canon).digest('hex');
}
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeysDeep(v[k]);
        return acc;
      }, {});
  }
  return v;
}

/**
 * 심평원 요양기호(암호화) 원문 → 우리 내부 facility id.  규칙(확정): "H-" + 요양기호.
 * @param {string} ykiho
 * @returns {string}
 */
export function hospitalIdFromYkiho(ykiho) {
  const raw = String(ykiho == null ? '' : ykiho).trim();
  if (!raw) throw new Error('hospitalIdFromYkiho: 빈 요양기호');
  return `H-${raw}`;
}

// ── 병상 매핑 (getEqpInfo2.8) ──
function mapBeds(eqp) {
  if (!eqp) return { bed_total: null, bed_detail: null, establishment_type: null };
  const detail = {
    standard: toCount(eqp.stdSickbdCnt), // 일반(표준) 병상
    higher: toCount(eqp.hghrSickbdCnt), // 상급 병상
    isolation: toCount(eqp.isnrSbdCnt), // 격리
    negative_pressure: toCount(eqp.anvirTrrmSbdCnt), // 음압격리
    day_ward: toCount(eqp.dtrmSbdCnt), // 낮병동
    psych_closed_general: toCount(eqp.psydeptClsGnlSbdCnt),
    psych_closed_higher: toCount(eqp.psydeptClsHigSbdCnt),
    psych_open_general: toCount(eqp.psydeptOpenGnlSbdCnt),
    psych_open_higher: toCount(eqp.psydeptOpenHigSbdCnt),
  };
  const rooms = {
    operating: toCount(eqp.soprmCnt),
    emergency: toCount(eqp.emymCnt),
    delivery: toCount(eqp.partumCnt),
    physical_therapy: toCount(eqp.ptrmCnt),
    newborn: toCount(eqp.nbySprmCnt),
    child_recovery: toCount(eqp.chldSprmCnt),
    adult_child_recovery: toCount(eqp.aduChldSprmCnt),
  };
  // 값이 전부 null 인 하위객체는 통째로 제거해 저장 잡음 축소
  const prune = (o) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
  const prunedDetail = prune(detail);
  const prunedRooms = prune(rooms);
  return {
    bed_total: toCount(eqp.permSbdCnt), // 허가병상 수
    bed_detail:
      Object.keys(prunedDetail).length || Object.keys(prunedRooms).length
        ? { ...prunedDetail, ...(Object.keys(prunedRooms).length ? { rooms: prunedRooms } : {}) }
        : null,
    establishment_type: cleanStr(eqp.orgTyCdNm), // 설립구분 ("의료법인" 등)
  };
}

// ── 진료과목·전문의 (getDgsbjtInfo2.8 + getSpcSbjtSdrInfo2.8) ──
function mapDepartments(dgsbjt, spcSbjt) {
  const specialties = [];
  const counts = {};
  for (const it of asArray(dgsbjt)) {
    const nm = cleanStr(it.dgsbjtCdNm);
    if (!nm) continue;
    if (!specialties.includes(nm)) specialties.push(nm);
    const pr = toCount(it.dgsbjtPrSdrCnt);
    if (pr !== null && pr > 0) counts[nm] = pr;
  }
  // 전문과목별 전문의 수 API 가 더 정확 — 있으면 덮어씀
  for (const it of asArray(spcSbjt)) {
    const nm = cleanStr(it.dgsbjtCdNm);
    const c = toCount(it.dtlSdrCnt);
    if (nm && c !== null) counts[nm] = c;
  }
  return {
    specialties,
    specialist_counts: Object.keys(counts).length ? counts : null,
  };
}

// ── 의료장비 (getMedOftInfo2.8) ──
function mapEquipment(medOft) {
  const list = [];
  for (const it of asArray(medOft)) {
    const name = cleanStr(it.oftCdNm);
    if (!name) continue;
    list.push({ code: cleanStr(it.oftCd), name, count: toCount(it.oftCnt) ?? 1 });
  }
  return list.length ? list : null;
}

// ── 기타인력 (getEtcHstInfo2.8) ──
function mapOtherStaff(etc) {
  const out = {};
  for (const it of asArray(etc)) {
    const nm = cleanStr(it.dtlGnlNopCdNm);
    const c = toCount(it.gnlNopCnt);
    if (nm && c !== null) out[nm] = c;
  }
  return Object.keys(out).length ? out : null;
}

// ── 세부(운영정보) (getDtlInfo2.8) → medical_services 후보 아님(운영시간·주차 등). 별도 필드로. ──
function mapOperations(detail) {
  if (!detail) return null;
  const t = (v) => {
    const s = String(v ?? '').replace(/[^\d]/g, '');
    if (s.length === 3) return `0${s.slice(0, 1)}:${s.slice(1)}`;
    if (s.length === 4) return `${s.slice(0, 2)}:${s.slice(2)}`;
    return null;
  };
  const hours = {};
  for (const [d, s, e] of [
    ['mon', 'trmtMonStart', 'trmtMonEnd'],
    ['tue', 'trmtTueStart', 'trmtTueEnd'],
    ['wed', 'trmtWedStart', 'trmtWedEnd'],
    ['thu', 'trmtThuStart', 'trmtThuEnd'],
    ['fri', 'trmtFriStart', 'trmtFriEnd'],
    ['sat', 'trmtSatStart', 'trmtSatEnd'],
  ]) {
    const st = t(detail[s]);
    const en = t(detail[e]);
    if (st || en) hours[d] = { start: st, end: en };
  }
  const out = {
    hours: Object.keys(hours).length ? hours : null,
    lunch: cleanStr(detail.lunchWeek),
    reception: cleanStr(detail.rcvWeek),
    closed_sunday: cleanStr(detail.noTrmtSun),
    closed_holiday: cleanStr(detail.noTrmtHoli),
    emergency_day: cleanStr(detail.emyDayYn),
    emergency_night: cleanStr(detail.emyNgtYn),
    parking_qty: toCount(detail.parkQty),
    parking_paid: cleanStr(detail.parkXpnsYn),
    landmark: cleanStr(detail.plcNm),
  };
  const pruned = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null));
  return Object.keys(pruned).length ? pruned : null;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}

/**
 * @typedef {Object} HiraRawBundle  한 요양병원의 raw 묶음. 각 필드는 해당 API 의 첫 item(단수) 또는 item 배열.
 *  @property {Object}   basis        getHospBasisList item
 *  @property {Object}   [facility]   getEqpInfo2.8 item
 *  @property {Object}   [detail]     getDtlInfo2.8 item
 *  @property {Object[]} [departments] getDgsbjtInfo2.8 items
 *  @property {Object[]} [equipment]  getMedOftInfo2.8 items
 *  @property {Object[]} [specialists] getSpcSbjtSdrInfo2.8 items
 *  @property {Object[]} [otherStaff] getEtcHstInfo2.8 items
 *
 * @typedef {Object} NormalizedHospital  (필드 상세는 001 스키마 참조)
 */

/**
 * 심평원 요양병원 raw 묶음 → NormalizedHospital.
 * @param {HiraRawBundle} bundle
 * @returns {NormalizedHospital}
 */
export function normalizeHospitalRecord(bundle) {
  const b = bundle?.basis;
  if (!b || typeof b !== 'object') {
    throw new Error('normalizeHospitalRecord: basis(getHospBasisList item) 필요');
  }
  const ykiho = cleanStr(b.ykiho ?? b.YKIHO);
  if (!ykiho) throw new Error('normalizeHospitalRecord: ykiho 없음');

  const warnings = [];
  const { lat, lng, warning } = toCoord(b.XPos ?? b.xPos, b.YPos ?? b.yPos);
  if (warning) warnings.push(warning);

  const clCd = cleanStr(b.clCd);
  if (clCd && clCd !== HOSPITAL_CL_CD) {
    warnings.push(`clCd=${clCd} (요양병원 28 아님) — 수집 필터 확인 필요`);
  }

  const beds = mapBeds(bundle.facility);
  const depts = mapDepartments(bundle.departments, bundle.specialists);
  const equipment = mapEquipment(bundle.equipment);
  const otherStaff = mapOtherStaff(bundle.otherStaff);
  const operations = mapOperations(bundle.detail);

  // 병원기본목록의 의사수(전문의/일반의…) — 참고용 집계
  const doctorCounts = {
    total: toCount(b.drTotCnt),
    medical_specialist: toCount(b.mdeptSdrCnt),
    medical_general: toCount(b.mdeptGdrCnt),
    dental_specialist: toCount(b.detySdrCnt),
    oriental_specialist: toCount(b.cmdcSdrCnt),
  };

  const normalized = {
    external_id: ykiho,
    id: hospitalIdFromYkiho(ykiho),
    domain: HOSPITAL_DOMAIN,
    facility_type: HOSPITAL_FACILITY_TYPE,
    source: HOSPITAL_SOURCE,
    type_code: HOSPITAL_TYPE_CODE,
    type_label: HOSPITAL_TYPE_LABEL,

    name: cleanStr(b.yadmNm),
    address: cleanStr(b.addr),
    sido: normalizeSido(b.sidoCdNm),
    sido_raw: cleanStr(b.sidoCdNm),
    sigungu_nm: cleanStr(b.sgguCdNm),
    sigungu_cd: cleanStr(b.sgguCd),
    dong_nm: cleanStr(b.emdongNm),
    post_no: cleanStr(b.postNo),
    phone: cleanStr(b.telno),
    homepage: cleanStr(b.hospUrl),
    established_at: toDateISO(b.estbDd),

    lat,
    lng,

    // hospital_profiles
    establishment_type: beds.establishment_type,
    bed_total: beds.bed_total,
    bed_detail: beds.bed_detail,
    specialties: depts.specialties,
    specialist_counts: depts.specialist_counts,
    equipment,
    other_staff: otherStaff,
    doctor_counts: prune(doctorCounts),
    operations,
    homepage_detail: null,

    // medical_services: 상태 enum. HIRA 응답만으로는 판정 불가 → 전부 UNKNOWN.
    // (예: 인공호흡기·엑스선 장비 존재는 참고이나 "서비스 제공"과 동일하지 않음)
    medical_services: {},

    // 폐업/운영상태: HIRA API 에 필드 없음 → 추측 금지. null 로 둔다.
    operating_status: null,

    source_date: null, // 응답에 기준일 필드 없음
    _warnings: warnings,
  };

  normalized.normalized_hash = normalizedHash(stripMeta(normalized));
  return normalized;
}

function prune(o) {
  const e = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
  return Object.keys(e).length ? e : null;
}
function stripMeta(n) {
  const { _warnings, normalized_hash, ...rest } = n;
  return rest;
}

/**
 * 심평원 적정성평가 raw → NormalizedEvaluation | null (평가 없으면 null).
 * @param {{ basis?:Object, evalItem?:Object }} bundle
 * @returns {Object|null}
 */
export function normalizeEvaluationRecord(bundle) {
  const b = bundle?.basis;
  const ev = bundle?.evalItem;
  const ykiho = cleanStr(ev?.ykiho ?? b?.ykiho);
  if (!ykiho) return null;

  // asmGrd10 = 요양병원(입원) 적정성평가 등급. 값: 1~5 정수 또는 "등급제외".
  const rawGrade = ev ? ev.asmGrd10 : undefined;
  if (rawGrade === undefined || rawGrade === null || String(rawGrade).trim() === '') {
    return null; // 평가정보 없음
  }
  const gradeStr = String(rawGrade).trim();
  const num = Number(gradeStr);
  let grade;
  if (Number.isInteger(num) && num >= 1 && num <= 5) {
    grade = String(num); // '1'..'5'
  } else if (gradeStr === '등급제외' || /제외/.test(gradeStr)) {
    grade = '등급제외';
  } else {
    grade = gradeStr; // 알 수 없는 값도 원문 보존 (환산 금지)
  }

  return {
    external_id: ykiho,
    facility_id: hospitalIdFromYkiho(ykiho),
    evaluation_authority: EVAL_AUTHORITY,
    evaluation_name: EVAL_NAME,
    evaluation_year: null, // ⚠️ API 응답에 없음 — 추측·현재연도 삽입 금지
    grade,
    grade_scale: EVAL_GRADE_SCALE,
    source_url: null,
    source_reference: 'hospAsmInfoService1/getHospAsmInfo1 (asmGrd10)',
    source_date: null,
  };
}

// ── 1B 이전 스텁 클라이언트 (호환 유지) — 실제 클라이언트는 lib/hira/client.js ──
export const notImplementedHiraClient = {
  async listHospitals() {
    throw new Error('notImplementedHiraClient: lib/hira/client.js 의 createHiraClient() 를 쓰세요.');
  },
  async listEvaluations() {
    throw new Error('notImplementedHiraClient: lib/hira/client.js 의 createHiraClient() 를 쓰세요.');
  },
};
