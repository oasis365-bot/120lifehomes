// =====================================================================
// HIRA (건강보험심사평가원) 데이터 어댑터 — 인터페이스(계약)만.
// =====================================================================
//  ⚠️ 1A 에서는 구현하지 않는다. 실제 심평원 API 응답 샘플을 확보하기 전까지
//     응답 필드명·중첩구조·코드값을 추측해서 채우지 않는다.
//
//  이 파일의 역할:
//    · 1B 수집 코드가 의존할 함수 시그니처를 고정한다.
//    · "원본(raw) → 우리 스키마 정규화" 경계를 명확히 한다.
//    · 실제 매핑은 1B 에서 `normalizeHospitalRecord` / `normalizeEvaluationRecord`
//      본문만 채우면 되도록 한다. (호출부·테스트는 미리 작성 가능)
//
//  우리 스키마(확정): db/migrations/001_hospital_module_up.sql
//    facilities(id='H-'+ykiho, domain='HOSPITAL', source, hira_ykiho)
//    hospital_profiles(facility_id, bed_total, specialties, medical_services{...}, ...)
//    facility_evaluations(facility_id, evaluation_authority='HIRA', evaluation_name,
//                         evaluation_year, grade, grade_scale, source_url,
//                         source_reference, source_date, collected_at)
//    facility_sources(source_system, external_id=ykiho원문, raw, ...)
// =====================================================================

export const HIRA_ADAPTER_CONTRACT_VERSION = '0.1.0-interface-only';

/**
 * 심평원 요양기호(암호화) 원문 → 우리 내부 facility id.
 * 규칙(확정): "H-" + 요양기호 원문.
 * @param {string} ykiho  심평원 요양기호 원문 (external_id 로도 저장됨)
 * @returns {string}
 */
export function hospitalIdFromYkiho(ykiho) {
  const raw = String(ykiho == null ? '' : ykiho).trim();
  if (!raw) throw new Error('hospitalIdFromYkiho: 빈 요양기호');
  return `H-${raw}`;
}

/**
 * @typedef {Object} HiraRawRecord
 *   심평원 오픈API 한 건의 원본 객체. **필드명 미확정** — 1B 에서 실제 응답으로 결정.
 *   facility_sources.raw 에 그대로 저장한다.
 *
 * @typedef {'VERIFIED_TRUE'|'VERIFIED_FALSE'|'UNKNOWN'|'FACILITY_CLAIMED'} ServiceStatus
 *
 * @typedef {Object} NormalizedHospital
 *  @property {string}            external_id   심평원 요양기호 원문
 *  @property {string}            id            "H-"+external_id  (facilities.id)
 *  @property {'HOSPITAL'}        domain
 *  @property {'hira_public'}     source
 *  @property {string}            name
 *  @property {string|null}       address       도로명주소 문자열 (지역검색은 주소 기준)
 *  @property {string|null}       sido          시도명 (우리 REGIONS.name 과 일치하도록 정규화)
 *  @property {string|null}       sigungu_nm    시군구명
 *  @property {string|null}       post_no
 *  @property {string|null}       phone
 *  @property {string|null}       homepage
 *  @property {number|null}       lat           공식 응답에 있으면 채움. 없으면 null (지오코딩은 별도 단계)
 *  @property {number|null}       lng
 *  @property {string|null}       establishment_type
 *  @property {number|null}       bed_total
 *  @property {Object|null}       bed_detail
 *  @property {string[]}          specialties
 *  @property {Object|null}       specialist_counts
 *  @property {Object|null}       equipment
 *  @property {Object<string,ServiceStatus>} medical_services  기본 전부 'UNKNOWN'
 *  @property {string|null}       source_date   원본 기준일
 *
 * @typedef {Object} NormalizedEvaluation
 *  @property {string}       external_id
 *  @property {'HIRA'}       evaluation_authority
 *  @property {string}       evaluation_name   예: '요양병원 적정성평가' (실제 명칭 1B 확인)
 *  @property {number|null}  evaluation_year
 *  @property {string|null}  grade             원문 등급 문자열. **점수 환산 금지**
 *  @property {string}       grade_scale       예: 'HIRA_ADEQUACY' (요양원 A~E 와 절대 혼용 X)
 *  @property {string|null}  source_url
 *  @property {string|null}  source_reference
 *  @property {string|null}  source_date
 */

/**
 * 심평원 병원정보 원본 1건 → NormalizedHospital.
 * @param {HiraRawRecord} raw
 * @returns {NormalizedHospital}
 */
export function normalizeHospitalRecord(raw) {  // eslint-disable-line no-unused-vars
  throw new Error(
    'normalizeHospitalRecord: 미구현 (1B). 실제 심평원 병원정보서비스 응답 샘플 확보 후 매핑 작성.'
  );
}

/**
 * 심평원 적정성평가 원본 1건 → NormalizedEvaluation.
 * @param {HiraRawRecord} raw
 * @returns {NormalizedEvaluation}
 */
export function normalizeEvaluationRecord(raw) {  // eslint-disable-line no-unused-vars
  throw new Error(
    'normalizeEvaluationRecord: 미구현 (1B). 실제 심평원 병원평가정보서비스 응답 샘플 확보 후 매핑 작성.'
  );
}

/**
 * 심평원 API 클라이언트 계약. 1B 에서 구현.
 * data.go.kr 인증키·인코딩·재시도(초당/일일 한도)는 api/ingest.js·enrich.js 패턴 재사용.
 * @typedef {Object} HiraClient
 *  @property {(params: object) => Promise<{records: HiraRawRecord[], totalCount: number}>} listHospitals
 *  @property {(params: object) => Promise<{records: HiraRawRecord[], totalCount: number}>} listEvaluations
 */

/** 1B 이전에 실수로 호출되지 않도록 하는 스텁 클라이언트. */
export const notImplementedHiraClient = {
  async listHospitals() {
    throw new Error('HiraClient.listHospitals: 미구현 (1B). data.go.kr 활용신청·응답샘플 후.');
  },
  async listEvaluations() {
    throw new Error('HiraClient.listEvaluations: 미구현 (1B).');
  },
};
