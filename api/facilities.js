// GET /api/facilities — 장기요양기관 검색
//   쿼리: sido(시도명), sigungu_nm, type(type_label), grade, q(기관명),
//         sort=name|new, page, size, domain(LTC|HOSPITAL|ALL)
//
//   domain 처리:
//     · feature_flags.hospital_module = OFF  → 항상 요양원만 (domain 파라미터 무시).
//       응답 형태·결과 모두 기존과 동일 (select 에 domain 미포함).
//     · hospital_module = ON  → domain 파라미터로 탭 필터
//         LTC / HOSPITAL → 해당 유형만,  ALL 또는 미지정 → 둘 다.
//     · 마이그레이션(001) 전  → domain 컬럼을 아예 참조하지 않음 (완전 무변경).
import { haveDb, sb } from '../lib/db.js';
import { getFlags, flagOn } from '../lib/flags.js';
import { FACILITY_PUBLIC_COLUMNS } from '../lib/facilitySelect.js';

const BASE_SELECT = FACILITY_PUBLIC_COLUMNS;

export default async function handler(req, res) {
  if (!haveDb()) {
    res.status(503).json({ error: 'db_not_configured', items: [], page: 1, size: 0, total: 0 });
    return;
  }

  const q = req.query || {};
  const size = Math.min(Math.max(parseInt(q.size, 10) || 20, 1), 50);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);

  const { flags, schemaReady } = await getFlags();
  const hospitalOn = schemaReady && flagOn(flags, 'hospital_module');

  const p = new URLSearchParams();
  // domain 은 병원 모듈 ON 일 때만 노출 (OFF 면 응답 형태까지 기존과 동일)
  p.set('select', hospitalOn ? `${BASE_SELECT},domain` : BASE_SELECT);

  if (q.sido) p.append('sido', `eq.${q.sido}`);
  if (q.sigungu_nm) p.append('sigungu_nm', `eq.${q.sigungu_nm}`);
  else if (q.sigungu) p.append('sigungu', `eq.${q.sigungu}`);
  if (q.type) p.append('type_label', `eq.${q.type}`);
  if (q.grade) p.append('eval_grade', `eq.${q.grade}`);
  if (q.partner === '1') p.append('is_partner', 'eq.true');
  if (q.q) {
    const kw = String(q.q).replace(/[%,()*]/g, '').trim();
    if (kw) p.append('name', `ilike.*${kw}*`);
  }

  // ── domain 필터 ────────────────────────────────────────────────
  if (schemaReady) {
    if (hospitalOn) {
      const d = String(q.domain || '').toUpperCase();
      if (d === 'LTC' || d === 'HOSPITAL') p.append('domain', `eq.${d}`);
      // '' | 'ALL' → 필터 없음 (요양원 + 요양병원)
    } else {
      // 병원 모듈 OFF: 병원 데이터가 존재하더라도 완전히 숨김. 결과는 기존과 동일.
      p.append('domain', 'eq.LTC');
    }
  }
  // schemaReady=false (마이그레이션 전): domain 절 없음 → 기존 동작 그대로

  const order = q.sort === 'new' ? 'established_at.desc.nullslast,name.asc' : 'name.asc';
  p.append('order', order);
  p.append('offset', String((page - 1) * size));
  p.append('limit', String(size));

  try {
    const { data, count } = await sb(`facilities?${p.toString()}`, { prefer: 'count=exact' });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ items: Array.isArray(data) ? data : [], page, size, total: count });
  } catch (e) {
    console.error('[facilities]', e.message);
    res.status(500).json({ error: 'query_failed' });
  }
}
