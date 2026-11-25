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

// ── view=regions: 화면 지역 선택지를 "DB 에 실제 저장된 값"으로만 만든다 ──
//  HIRA 원본 시도·시군구명(예: '전남광주', '세종시', '수원장안구')은 바꾸지 않는다.
//  같은 공식 코드(HIRA 원본 sidoCd·sgguCd, facility_sources.raw.basis)에 이름이 둘 이상
//  저장된 경우(예: 코드 360000 = '전남광주' 133곳 + 옛 표기 '전라남도' 1곳)에만 한 선택지로
//  묶는다. 선택지 이름(label)은 새로 만들지 않고 그 묶음에서 가장 많이 쓰인 원본 이름을 쓰며,
//  names 에 묶인 원본 이름을 모두 담는다 → 화면은 names 전부로 검색(sido=in.(...)).
//  코드가 없는 행은 이름 그대로 한 묶음. 치환·추정 없음.
//  Supabase max-rows(1000) 때문에 페이지로 나눠 읽는다. 코드는 응답에 내보내지 않는다.
const REGION_PAGE = 1000;
const REGION_MAX_PAGES = 20; // 2만 행 상한(현재 약 1,300행) — 무한 루프 방지
const REGION_NAMES_MAX = 5; // 한 선택지에 묶을 수 있는 원본 이름 수 상한(목록 API 입력 상한과 같음)
const koCompare = (a, b) => String(a).localeCompare(String(b), 'ko');
const cleanStr = (v) => (typeof v === 'string' ? v.trim() : '');

async function readAllPages(sb, table, build) {
  const out = [];
  for (let i = 0; i < REGION_MAX_PAGES; i += 1) {
    const p = build();
    p.append('offset', String(i * REGION_PAGE));
    p.append('limit', String(REGION_PAGE));
    const { data } = await sb(`${table}?${p.toString()}`);
    const rows = Array.isArray(data) ? data : [];
    out.push(...rows);
    if (rows.length < REGION_PAGE) break;
  }
  return out;
}

// 이름·코드를 노드로 하는 union-find. 같은 코드에 걸린 이름들 / 같은 이름에 걸린 코드들을 한 묶음으로.
function makeGroups() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  return { find, union };
}

// names: Map(name -> count) → { label, names[] } (label = 가장 많이 쓰인 원본 이름, 동률이면 가나다순)
function labelOf(names) {
  const list = [...names.entries()].sort((a, b) => (b[1] - a[1]) || koCompare(a[0], b[0])).map(([n]) => n);
  return { label: list[0], names: list.slice(0, REGION_NAMES_MAX) };
}

function groupRows(rows, nameKey, codeKey) {
  const g = makeGroups();
  for (const r of rows) {
    g.find(`n:${r[nameKey]}`);
    if (r[codeKey]) g.union(`n:${r[nameKey]}`, `c:${r[codeKey]}`);
  }
  const groups = new Map(); // root -> { names: Map, rows: [] }
  for (const r of rows) {
    const root = g.find(`n:${r[nameKey]}`);
    if (!groups.has(root)) groups.set(root, { names: new Map(), rows: [] });
    const e = groups.get(root);
    e.names.set(r[nameKey], (e.names.get(r[nameKey]) || 0) + 1);
    e.rows.push(r);
  }
  return [...groups.values()];
}

async function loadRegions(sb) {
  const facs = await readAllPages(sb, 'facilities', () => {
    const p = new URLSearchParams();
    p.set('select', 'id,sido,sigungu_nm');
    p.append('domain', 'eq.HOSPITAL');
    p.append('order', 'id.asc');
    return p;
  });
  // 공식 코드: HIRA 원본(raw.basis)의 sidoCd·sgguCd 만 읽는다. raw 자체는 읽지 않는다.
  const srcs = await readAllPages(sb, 'facility_sources', () => {
    const p = new URLSearchParams();
    p.set('select', 'facility_id,sido_cd:raw->basis->>sidoCd,sggu_cd:raw->basis->>sgguCd');
    p.append('source_system', 'eq.hira_hospital_ingest');
    p.append('order', 'facility_id.asc');
    return p;
  });
  const codeOf = new Map();
  for (const s of srcs) {
    const fid = cleanStr(s && s.facility_id);
    if (fid && !codeOf.has(fid)) codeOf.set(fid, { sido: cleanStr(s.sido_cd), sggu: cleanStr(s.sggu_cd) });
  }
  const rows = [];
  for (const f of facs) {
    const sido = cleanStr(f && f.sido);
    if (!sido) continue;
    const c = codeOf.get(cleanStr(f.id)) || { sido: '', sggu: '' };
    rows.push({ sido, sg: cleanStr(f.sigungu_nm), sidoCd: c.sido, sgguCd: c.sggu });
  }

  return groupRows(rows, 'sido', 'sidoCd')
    .map((grp) => {
      const { label, names } = labelOf(grp.names);
      const sigungu = groupRows(grp.rows.filter((r) => r.sg), 'sg', 'sgguCd')
        .map((sg) => { const l = labelOf(sg.names); return { name: l.label, names: l.names, count: sg.rows.length }; })
        .sort((a, b) => koCompare(a.name, b.name));
      return { sido: label, names, count: grp.rows.length, sigungu };
    })
    .sort((a, b) => koCompare(a.sido, b.sido));
}

const DEFAULT_SIZE = 20;
const MAX_SIZE = 50;
const Q_MAX = 100;
const REGION_MAX = 60;

const DIGITS_RE = /^[0-9]+$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/; // 제어문자

// q 정제 — 2단계 방어 중 1단계(PostgREST 논리트리 문법 차단).
//  기존 api/facilities.js 의 [%,()*] 제거를 or 그룹 breakout 문자(콤마·괄호·점·콜론·
//  따옴표·역슬래시)까지 확장. 2단계(URL 구조 문자 %26/%3D/%3F/%23 …)는 값을
//  URLSearchParams 에 넣을 때 자동 적용된다 (아래 handler 참고).
const stripFilterChars = (s) => String(s).replace(/[%,()*.:"\\]/g, '').replace(/\s+/g, ' ').trim();

const pick = (row, keys) => {
  const out = {};
  for (const k of keys) out[k] = row && row[k] !== undefined ? row[k] : null;
  return out;
};

// sido / sigungu 는 "정확 일치" 파라미터 — 실제 지역명은 문자·숫자·공백·하이픈뿐이다.
//  그 밖의 문자(& = ? # ( ) , * % " \ . : 등)가 들어오면 정상 지역명이 아니므로 400 으로 거부.
//  (eq 필터 + URLSearchParams 인코딩만으로도 구조 주입은 불가능하지만, 위험 입력을
//   명시적으로 거부해 계약을 분명히 한다.)
const REGION_RE = /^[\p{L}\p{N} \-]+$/u; // 문자·숫자·공백·하이픈만

// 반환: null(없음) | {value} | {bad:true}
function parseRegion(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return { bad: true };
  const v = raw.trim();
  if (v === '') return null; // 빈 값 = 미지정
  if (v.length > REGION_MAX || CTRL_RE.test(v) || !REGION_RE.test(v)) return { bad: true };
  return { value: v };
}

// sido / sigungu 는 문자열 1개(기존 계약) 또는 같은 공식 코드로 묶인 원본 이름 여러 개
//  (?sido=A&sido=B, 최대 REGION_NAMES_MAX). 하나라도 규칙 위반이면 전체 400.
// 반환: null(없음) | {values:[...]} | {bad:true}
function parseRegionList(raw) {
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.length > REGION_NAMES_MAX) return { bad: true };
    const values = [];
    for (const one of raw) {
      const r = parseRegion(one);
      if (!r || r.bad) return { bad: true }; // 빈 값 섞임도 거부
      if (!values.includes(r.value)) values.push(r.value);
    }
    return { values };
  }
  const r = parseRegion(raw);
  if (!r) return null;
  return r.bad ? r : { values: [r.value] };
}

// 값은 REGION_RE(문자·숫자·공백·하이픈)만 통과했으므로 따옴표 안에 그대로 넣어도 안전하다.
const regionFilter = (values) => (values.length === 1
  ? `eq.${values[0]}`
  : `in.(${values.map((v) => `"${v}"`).join(',')})`);

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

    // view: 미지정 = 목록(기존 계약), 'regions' = 지역 선택지. 그 밖의 값은 400.
    let view = 'list';
    if (query.view !== undefined && query.view !== '') {
      if (query.view !== 'regions') { res.status(400).json({ error: 'invalid_view' }); return; }
      view = 'regions';
    }

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

    // q 계약: 미지정(또는 빈 문자열) → 필터 없음(전체 목록). 값이 있는데 정제 후
    //  검색 가능한 내용이 0 이면 → 400 (조용히 전체 목록으로 바뀌지 않게 고정).
    let qTerm = '';
    if (query.q !== undefined) {
      if (typeof query.q !== 'string' || query.q.length > Q_MAX || CTRL_RE.test(query.q)) {
        res.status(400).json({ error: 'invalid_q' });
        return;
      }
      qTerm = stripFilterChars(query.q);
      if (query.q.trim() !== '' && qTerm === '') {
        res.status(400).json({ error: 'invalid_q' });
        return;
      }
    }

    const sidoR = parseRegionList(query.sido);
    if (sidoR && sidoR.bad) { res.status(400).json({ error: 'invalid_sido' }); return; }
    const sigunguR = parseRegionList(query.sigungu);
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

    if (view === 'regions') {
      try {
        const regions = await loadRegions(sb);
        res.status(200).json({ regions });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[hospital/facilities] db error:', (e && e.name) || 'Error');
        res.status(503).json({ error: 'db_unavailable' });
      }
      return;
    }

    // ── 1) facilities page 조회 ──
    //  select / domain / order / offset / limit / or 구조는 전부 코드 고정이다.
    //  사용자 입력은 sido·sigungu·q(정제된 qTerm) 의 "값" 으로만, 그것도 URLSearchParams
    //  를 거쳐 들어간다 → & = ? # ( ) , " \ % 등이 전부 percent-encoding 되므로
    //  사용자가 새 쿼리 파라미터를 만들거나 위 구조를 덮어쓸 수 없다.
    //  (page/size 는 위에서 /^[0-9]+$/ 로 검증된 정수라 offset/limit 에 안전.)
    const p = new URLSearchParams();
    p.set('select', FACILITY_PUBLIC.join(','));
    p.append('domain', 'eq.HOSPITAL'); // 코드 고정 — query.domain 은 읽지 않는다.
    if (sidoR) p.append('sido', regionFilter(sidoR.values));
    // 병원 행은 facilities.sigungu 가 비어 있고 sigungu_nm 만 채워진다 → 정확 일치는 sigungu_nm 대상.
    if (sigunguR) p.append('sigungu_nm', regionFilter(sigunguR.values));
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
