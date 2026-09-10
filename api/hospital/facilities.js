// GET /api/hospital/facilities — 요양병원 공개 검색·목록
// ─────────────────────────────────────────────────────────────────────
//  요양병원 목록(검색·페이지네이션). 현재 DB 에 저장된 컬럼만 조립해서 반환한다.
//  · additive — 기존 LTC /api/facilities.js · /api/facility.js · 프런트는 건드리지 않는다.
//  · hospital_module OFF 면 존재 자체를 숨긴다 (404 not_found, 병원 테이블 조회 0).
//  · GET 만. 다른 method → 405 + Allow: GET.  모든 응답 Cache-Control: no-store.
//  · 항상 facilities.domain = 'HOSPITAL' 조건을 강제한다 (LTC 행 혼입 0).
//
//  이번 단계 범위:
//    · q(기관명·주소) / sido / sigungu 정확 일치 + page/size 만.
//    · specialties·grade·bed 필터는 **교차 테이블 pagination 을 왜곡**하므로 여기서
//      구현하지 않는다. 이런 필터는 후속 필터 전용 API 로 분리한다.
//
//  공개 whitelist (아래 상수). select·pick 양쪽에서 그 밖의 컬럼을 제외한다:
//    hira_ykiho / facility_sources(external_id·raw) / normalized_hash / source 내부상태 /
//    ingestion_runs / 운영자 전용 컬럼 / serviceKey·Supabase URL·키 / 내부 오류 원문.
//  공개 facility.id 는 현재 계약상 "H-" + 요양기호 형식이며 프런트 호출에 필요하다 —
//  이 형식은 숨기지 않는다. 원문 요양기호 컬럼(hospital_profiles.hira_ykiho,
//  facility_sources.external_id)·raw 는 노출하지 않는다.
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
const PROFILE_PUBLIC = Object.freeze([
  'establishment_type', 'bed_total', 'specialties',
]);
const EVALUATION_PUBLIC = Object.freeze([
  'evaluation_authority', 'evaluation_name', 'evaluation_year',
  'grade', 'grade_scale', 'collected_at',
]);
// batch 조회용 select (facility_id 는 그룹핑 키, evaluations.id 는 tie-break 정렬용 —
//  둘 다 pick() 에는 넣지 않으므로 응답에는 나오지 않는다).
const PROFILE_SELECT = Object.freeze(['facility_id', ...PROFILE_PUBLIC]);
const EVAL_SELECT = Object.freeze(['facility_id', 'id', ...EVALUATION_PUBLIC]);

const DEFAULT_SIZE = 20;
const MAX_SIZE = 50;
const Q_MAX = 100;
const REGION_MAX = 60;

const DIGITS_RE = /^[0-9]+$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/; // 제어문자

// PostgREST 필터/or 표현식 삽입 차단: 기존 api/facilities.js 의 [%,()*] 를
//  or 그룹(콤마·괄호·점·콜론·따옴표·역슬래시)까지 커버하도록 확장.
const stripFilterChars = (s) => String(s).replace(/[%,()*.:"\\]/g, '').replace(/\s+/g, ' ').trim();

const pick = (row, keys) => {
  const out = {};
  for (const k of keys) out[k] = row && row[k] !== undefined ? row[k] : null;
  return out;
};

// sido / sigungu 값 검증 (정확 일치용). 반환: null(없음) | {value} | {bad:true}
function parseRegion(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return { bad: true };
  if (raw.length > REGION_MAX || CTRL_RE.test(raw)) return { bad: true };
  const v = raw.trim();
  return v ? { value: v } : null;
}

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

    const query = req.query && typeof req.query === 'object' ? req.query : {};

    // ── 입력 검증 (DB 조회 전) — 알 수 없는 파라미터는 무시(기존 api/facilities.js 계약) ──
    let page = 1;
    if (query.page !== undefined) {
      const raw = String(query.page);
      if (!DIGITS_RE.test(raw)) { res.status(400).json({ error: 'invalid_page' }); return; }
      page = parseInt(raw, 10);
      if (page < 1) { res.status(400).json({ error: 'invalid_page' }); return; }
    }

    let size = DEFAULT_SIZE;
    if (query.size !== undefined) {
      const raw = String(query.size);
      if (!DIGITS_RE.test(raw)) { res.status(400).json({ error: 'invalid_size' }); return; }
      size = parseInt(raw, 10);
      if (size < 1) { res.status(400).json({ error: 'invalid_size' }); return; }
      if (size > MAX_SIZE) size = MAX_SIZE; // 최대 50 로 클램프
    }

    let qTerm = '';
    if (query.q !== undefined) {
      if (typeof query.q !== 'string' || query.q.length > Q_MAX || CTRL_RE.test(query.q)) {
        res.status(400).json({ error: 'invalid_q' });
        return;
      }
      qTerm = stripFilterChars(query.q); // 전부 제거되면 q 필터 미적용 (기존 api/facilities.js 와 동일)
    }

    const sidoR = parseRegion(query.sido);
    if (sidoR && sidoR.bad) { res.status(400).json({ error: 'invalid_sido' }); return; }
    const sigunguR = parseRegion(query.sigungu);
    if (sigunguR && sigunguR.bad) { res.status(400).json({ error: 'invalid_sigungu' }); return; }

    // ── 기능 OFF → 존재 미노출. 병원 테이블(facilities/hospital_profiles/facility_evaluations)
    //    조회를 하지 않는다 (fail-fast). ──
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

    // ── 1) facilities page 조회 (domain=HOSPITAL 강제, 안정 정렬, count=exact) ──
    const p = new URLSearchParams();
    p.set('select', FACILITY_PUBLIC.join(','));
    p.append('domain', 'eq.HOSPITAL');
    if (sidoR && sidoR.value) p.append('sido', `eq.${sidoR.value}`);
    // 병원 행은 facilities.sigungu 가 비어 있고 sigungu_nm 만 채워진다 → 정확 일치는 sigungu_nm 대상.
    if (sigunguR && sigunguR.value) p.append('sigungu_nm', `eq.${sigunguR.value}`);
    if (qTerm) p.append('or', `(name.ilike.*${qTerm}*,address.ilike.*${qTerm}*)`);
    p.append('order', 'name.asc,id.asc');
    p.append('offset', String((page - 1) * size));
    p.append('limit', String(size));

    let facRows;
    let total;
    try {
      const { data, count } = await sb(`facilities?${p.toString()}`, { prefer: 'count=exact' });
      facRows = Array.isArray(data) ? data : [];
      total = typeof count === 'number' ? count : facRows.length;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[hospital/facilities] db error:', (e && e.name) || 'Error');
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    // 빈 결과 → profile/evaluation 조회 생략
    if (facRows.length === 0) {
      res.status(200).json({ items: [], page, size, total });
      return;
    }

    // ── 2) 이번 page 의 facility id 로만 batch 조회 (각 1회, N+1 없음) ──
    //  id 는 DB 에서 온 값(사용자 입력 아님)이고 "H-"+base64 라 콤마·괄호·따옴표를
    //  포함하지 않는다. 각 값을 큰따옴표로 감싸고 URLSearchParams 로 인코딩한다.
    const ids = facRows.map((r) => r.id);
    const inClause = `in.(${ids.map((id) => `"${String(id)}"`).join(',')})`;

    const profP = new URLSearchParams();
    profP.set('select', PROFILE_SELECT.join(','));
    profP.append('facility_id', inClause);

    const evalP = new URLSearchParams();
    evalP.set('select', EVAL_SELECT.join(','));
    evalP.append('facility_id', inClause);
    evalP.append('order', 'collected_at.desc,id.desc');

    let profRows = [];
    let evalRows = [];
    try {
      const [profRes, evalRes] = await Promise.all([
        sb(`hospital_profiles?${profP.toString()}`),
        sb(`facility_evaluations?${evalP.toString()}`),
      ]);
      profRows = Array.isArray(profRes.data) ? profRes.data : [];
      evalRows = Array.isArray(evalRes.data) ? evalRes.data : [];
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[hospital/facilities] db error:', (e && e.name) || 'Error');
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    const profById = new Map();
    for (const r of profRows) {
      if (r && r.facility_id != null && !profById.has(r.facility_id)) profById.set(r.facility_id, r);
    }
    // evalRows 는 collected_at desc, id desc 전역 정렬 → 기관별 첫 행이 최신 1건.
    const evalById = new Map();
    for (const r of evalRows) {
      if (r && r.facility_id != null && !evalById.has(r.facility_id)) evalById.set(r.facility_id, r);
    }

    const items = facRows.map((r) => {
      const prof = profById.get(r.id) || null;
      const ev = evalById.get(r.id) || null;
      return {
        facility: pick(r, FACILITY_PUBLIC),
        profile: prof ? pick(prof, PROFILE_PUBLIC) : null,
        evaluation: ev ? pick(ev, EVALUATION_PUBLIC) : null,
      };
    });

    res.status(200).json({ items, page, size, total });
  };
}

export default createHandler();
