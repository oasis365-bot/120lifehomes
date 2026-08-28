// GET /api/facility?id=<장기요양기관기호>
import { haveDb, sb } from '../lib/db.js';

export default async function handler(req, res) {
  if (!haveDb()) {
    res.status(503).json({ error: 'db_not_configured' });
    return;
  }
  const id = String((req.query && req.query.id) || '').trim();
  if (!id) {
    res.status(400).json({ error: 'missing_id' });
    return;
  }
  try {
    const { data } = await sb(
      `facilities?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
    );
    const item = Array.isArray(data) ? data[0] : null;
    if (!item) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ item });
  } catch (e) {
    console.error('[facility]', e.message);
    res.status(500).json({ error: 'query_failed' });
  }
}
