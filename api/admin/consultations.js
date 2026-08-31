// /api/admin/consultations
//   GET  ?key=<ADMIN_KEY>            → 상담 접수 목록
//   POST ?key=<ADMIN_KEY> {id,status} → 상태 변경 (new/contacted/done/spam)
import { haveDb, sb } from '../../lib/db.js';

function authed(req) {
  const key = process.env.ADMIN_KEY || process.env.CRON_SECRET;
  if (!key) return false;
  const given =
    (req.query && req.query.key) ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return given === key;
}

export default async function handler(req, res) {
  if (!authed(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!haveDb()) {
    res.status(503).json({ error: 'db_not_configured' });
    return;
  }

  try {
    if (req.method === 'POST') {
      const { id, status } = req.body || {};
      const allowed = ['new', 'contacted', 'done', 'spam'];
      if (!id || !allowed.includes(status)) {
        res.status(400).json({ error: 'bad_input' });
        return;
      }
      await sb(`consultations?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status },
        prefer: 'return=minimal',
      });
      res.status(200).json({ ok: true });
      return;
    }

    const status = req.query && req.query.status;
    const p = new URLSearchParams();
    p.set('select', '*');
    p.set('order', 'created_at.desc');
    p.set('limit', '500');
    if (status) p.append('status', `eq.${status}`);
    const { data } = await sb(`consultations?${p.toString()}`, { prefer: 'count=exact' });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ items: Array.isArray(data) ? data : [] });
  } catch (e) {
    console.error('[admin/consultations]', e.message);
    res.status(500).json({ error: 'query_failed' });
  }
}
