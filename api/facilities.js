// GET /api/facilities — 요양시설 검색
//   쿼리: sido, sigungu, type(=type_code), grade(=eval_grade),
//         vacancy=1, q(기관명), sort=name|vacancy|grade, page, size
import { haveDb, sb } from '../lib/db.js';

export default async function handler(req, res) {
  if (!haveDb()) {
    res.status(503).json({ error: 'db_not_configured', items: [], page: 1, size: 0, total: 0 });
    return;
  }

  const q = req.query || {};
  const size = Math.min(Math.max(parseInt(q.size, 10) || 20, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);

  const p = new URLSearchParams();
  p.set('select', '*');
  if (q.sido) p.append('sido', `eq.${q.sido}`);
  if (q.sigungu) p.append('sigungu', `eq.${q.sigungu}`);
  if (q.type) p.append('type_code', `eq.${q.type}`);
  if (q.grade) p.append('eval_grade', `eq.${q.grade}`);
  if (q.partner === '1') p.append('is_partner', 'eq.true');
  if (q.q) p.append('name', `ilike.*${String(q.q).replace(/[*,()]/g, '')}*`);
  if (q.vacancy === '1') {
    // 정원>현원 인 곳만 (PostgREST 는 컬럼간 비교가 안 되어 하한만 근사 적용)
    p.append('capacity', 'gt.0');
  }

  const order =
    { name: 'name.asc', vacancy: 'capacity.desc', grade: 'eval_grade.asc.nullslast' }[q.sort] ||
    'name.asc';
  p.append('order', order);
  p.append('offset', String((page - 1) * size));
  p.append('limit', String(size));

  try {
    const { data, count } = await sb(`facilities?${p.toString()}`, { prefer: 'count=exact' });
    let items = Array.isArray(data) ? data : [];
    if (q.vacancy === '1') {
      items = items.filter((f) => (f.capacity || 0) - (f.current_count || 0) > 0);
    }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ items, page, size, total: count });
  } catch (e) {
    console.error('[facilities]', e.message);
    res.status(500).json({ error: 'query_failed' });
  }
}
