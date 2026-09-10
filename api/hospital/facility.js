// GET /api/hospital/facility?id=<facility_id>
// ─────────────────────────────────────────────────────────────────────
//  요양병원 공개 상세. 현재 DB 에 이미 저장된 값만 조립해서 반환한다.
//  · additive — 기존 LTC /api/facility.js 는 건드리지 않는다.
//  · hospital_module OFF 면 존재 자체를 숨긴다 (404 not_found, 시설 DB 조회 0).
//  · 대상이 없거나 domain !== 'HOSPITAL' 이면 동일하게 404 (존재 여부 미노출).
//  · GET 만. 다른 method → 405.  응답은 Cache-Control: no-store.
//
//  공개 whitelist (아래 상수). 그 밖의 컬럼은 select·pick 양쪽에서 제외한다:
//    hira_ykiho / facility_sources(external_id·raw) / normalized_hash / source 내부상태 /
//    ingestion_runs / 운영자 전용 컬럼(monthly_fee·is_partner·intro …) / 내부 오류 원문 / 비밀.
//  id 는 앱의 공개 시설 키(= "H-" + 요양기호)이며 프런트가 이 endpoint 를 호출할 때 필요하다.
//  raw 요양기호 컬럼(hospital_profiles.hira_ykiho, facility_sources.external_id)·raw 는 노출하지 않는다.
// ─────────────────────────────────────────────────────────────────────
import { getFlags as realGetFlags, flagOn } from '../../lib/flags.js';
import { sb as realSb } from '../../lib/db.js';

const HOSPITAL_MODULE_FLAG = 'hospital_module';

// ── 공개 컬럼 whitelist (스키마 001 기준) ──
const FACILITY_PUBLIC = Object.freeze([
  'id', 'name', 'address',
  'sido', 'sigungu', 'sigungu_nm', 'dong_nm',
  'phone', 'lat', 'lng', 'established_at',
]);
// hospital_profiles: homepage 는 응답에서 facility 블록에 넣는다(스펙 그룹). 나머지는 profile 블록.
const PROFILE_PUBLIC = Object.freeze([
  'establishment_type', 'bed_total', 'bed_detail',
  'specialties', 'specialist_counts', 'equipment', 'medical_services',
]);
const PROFILE_SELECT = Object.freeze([...PROFILE_PUBLIC, 'homepage']); // homepage 는 select 만
const EVALUATION_PUBLIC = Object.freeze([
  'evaluation_authority', 'evaluation_name', 'evaluation_year',
  'grade', 'grade_scale', 'collected_at',
]);

// id 허용 형식: 영숫자로 시작 + 안전문자만. LTC(숫자) / HOSPITAL("H-"+base64계열) 둘 다 통과.
//  잘못된 입력은 여기서 400 으로 차단(그 뒤 DB 조회 없음).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9=_./+-]{2,255}$/;

const enc = (v) => encodeURIComponent(String(v));
const pick = (row, keys) => {
  const out = {};
  for (const k of keys) out[k] = row[k] === undefined ? null : row[k];
  return out;
};

/**
 * @param {object} [deps]
 * @param {() => Promise<{flags:object, schemaReady:boolean}>} [deps.getFlags]
 * @param {(path:string, opt?:object)=>Promise<{data:any,count:(number|null)}>} [deps.sb]
 */
export function createHandler(deps = {}) {
  const getFlags = deps.getFlags || realGetFlags;
  const sb = deps.sb || realSb;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if ((req.method || 'GET').toUpperCase() !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const id = req.query && typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }

    // 기능 OFF → 존재 미노출. 시설/프로필/평가 DB 조회를 하지 않는다 (fail-fast).
    let flags;
    try {
      ({ flags } = await getFlags());
    } catch {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (!flagOn(flags, HOSPITAL_MODULE_FLAG)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // 병렬 read (N+1 없음). facility_sources / ingestion_runs 는 조회하지 않는다.
    let results;
    try {
      results = await Promise.all([
        sb(`facilities?id=eq.${enc(id)}&domain=eq.HOSPITAL&select=${FACILITY_PUBLIC.join(',')}&limit=1`),
        sb(`hospital_profiles?facility_id=eq.${enc(id)}&select=${PROFILE_SELECT.join(',')}&limit=1`),
        sb(`facility_evaluations?facility_id=eq.${enc(id)}&select=${EVALUATION_PUBLIC.join(',')}&order=collected_at.desc,id.desc&limit=1`),
      ]);
    } catch (e) {
      // 내부 원문(쿼리·id·비밀) 미노출. 로그도 에러 클래스만.
      // eslint-disable-next-line no-console
      console.error('[hospital/facility] db error:', (e && e.name) || 'Error');
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    const facData = results[0] && results[0].data;
    const profData = results[1] && results[1].data;
    const evalData = results[2] && results[2].data;

    const facRow = Array.isArray(facData) ? facData[0] : null;
    if (!facRow) {
      // 없음 또는 domain !== 'HOSPITAL' → 동일하게 404
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const profRow = (Array.isArray(profData) && profData[0]) || null;
    const evalRow = (Array.isArray(evalData) && evalData[0]) || null;

    const facility = {
      ...pick(facRow, FACILITY_PUBLIC),
      homepage: profRow ? (profRow.homepage ?? null) : null,
    };
    const profile = profRow ? pick(profRow, PROFILE_PUBLIC) : null;
    const evaluation = evalRow ? pick(evalRow, EVALUATION_PUBLIC) : null;

    res.status(200).json({ facility, profile, evaluation });
  };
}

export default createHandler();
