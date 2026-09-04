// facilities 공개 API 응답에 포함하는 컬럼 목록 (단일 출처).
//   · /api/facilities 와 /api/facility 가 공유 → 두 엔드포인트 응답 형태 불일치 방지.
//   · 여기 없는 컬럼(raw, synced_at, updated_at, detail_synced_at, is_partner 보강필드,
//     domain/source/hira_ykiho 등 내부·수집·검수용)은 공개 응답에서 제외.
//   · domain 은 병원 모듈 ON 일 때만 별도로 덧붙인다 (api/facilities.js 참고).
//
//   프런트 사용처(2026-09 확인): assets/js/app.js facilityCardHTML(), facility.html
//     사용 필드 = id,name,type_label,sido,sigungu,sigungu_nm,dong_nm,address,post_no,
//                 phone,capacity,current_count,eval_grade,eval_date,established_at
//     (+ type_code 는 미사용이나 공개 가능 정보라 포함, is_partner 는 카드 배지용 여지)

export const FACILITY_PUBLIC_COLUMNS = [
  'id',
  'name',
  'type_code',
  'type_label',
  'sido',
  'sigungu',
  'sigungu_nm',
  'dong_nm',
  'address',
  'post_no',
  'phone',
  'capacity',
  'current_count',
  'eval_grade',
  'eval_date',
  'established_at',
  'is_partner',
].join(',');
