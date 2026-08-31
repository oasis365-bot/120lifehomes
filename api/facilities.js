// GET /api/facilities — 장기요양기관 검색
//   쿼리: sido(시도명), type(type_label), q(기관명), sort=name|new, page, size
import { haveDb, sb } from '../lib/db.js';

export default async function handler(req, res) {
  if (!haveDb()) {
    res.status(503).json({ error: 'db_not_configured', items: [], page: 1, size: 0, total: 0 });
    return;
  }

  const q = req.query || {};
  const size = Math.min(Math.max(parseInt(q.size, 10) || 20, 1), 50);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);

  const p = new URLSearchParams();
  p.set('select', 'id,name,type_code,type_label,sido,sigungu,address,road_address,phone,capacity,eval_grade,established_at,is_partner');
  if (q.sido) p.append('sido', `eq.${q.sido}`);
  if (q.type) p.append('type_label', `eq.${q.type}`);
  if (q.partner === '1') p.append('is_partner', 'eq.true');
  if (q.q) {
    const kw = String(q.q).replace(/[%,()*]/g, '').trim();
    if (kw) p.append('name', `ilike.*${kw}*`);
  }

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
