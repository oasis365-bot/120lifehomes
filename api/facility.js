// GET /api/facility?id=<장기요양기관기호>
//   공개 시설 상세. 공개 가능한 컬럼만 반환 (lib/facilitySelect.js).
//   raw(수집 원본)·synced_at·detail_synced_at·hira_ykiho·source 등 내부 필드는 제외.
import { haveDb, sb } from '../lib/db.js';
import { getFlags, flagOn } from '../lib/flags.js';
import { FACILITY_PUBLIC_COLUMNS } from '../lib/facilitySelect.js';

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

  // 요양원 상세 API 는 요양병원 행을 돌려주지 않는다(스위치 ON/OFF 무관).
  //  요양병원 상세는 /api/hospital/facility 전용. 병원 id 는 계약상 항상 "H-" 로 시작한다.
  if (id.startsWith('H-')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const { flags, schemaReady } = await getFlags();
  // 001 적용 후에는 domain 으로도 한 번 더 요양원만 고정한다.
  const ltcOnly = schemaReady ? '&domain=eq.LTC' : '';
  const cols =
    schemaReady && flagOn(flags, 'hospital_module')
      ? `${FACILITY_PUBLIC_COLUMNS},domain`
      : FACILITY_PUBLIC_COLUMNS;

  try {
    const { data } = await sb(
      `facilities?id=eq.${encodeURIComponent(id)}${ltcOnly}&select=${cols}&limit=1`
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
