// POST /api/consult — 무료 입소 상담 신청 접수
import { haveDb, sb } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const b = req.body || {};

  // 허니팟: 사람에게 안 보이는 필드가 채워졌으면 봇 → 조용히 성공 처리
  if (b.company) {
    res.status(200).json({ ok: true });
    return;
  }

  const name = clean(b.name);
  const phone = clean(b.phone);
  if (!name || name.length < 2 || !phone || digits(phone).length < 9) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }

  const row = {
    name,
    phone,
    relation: clean(b.relation),
    region: clean(b.region),
    facility_type: clean(b.type),
    care_level: clean(b.level),
    budget: clean(b.budget),
    facility_name: clean(b.facility),
    memo: clean(b.memo, 2000),
    source_ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
    user_agent: clean(req.headers['user-agent'], 300),
  };

  if (!haveDb()) {
    // DB 미연결 단계 — 접수는 받되 로그만 남김 (사용자에겐 정상 처리로 보임)
    console.log('[consult] DB 미설정, 접수 내용:', JSON.stringify(row));
    res.status(200).json({ ok: true, stored: false });
    return;
  }

  try {
    await sb('consultations', { method: 'POST', body: row, prefer: 'return=minimal' });
    res.status(200).json({ ok: true, stored: true });
  } catch (e) {
    console.error('[consult] 저장 실패:', e.message);
    res.status(500).json({ error: 'store_failed' });
  }
}

function clean(v, max = 200) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function digits(s) {
  return String(s).replace(/\D/g, '');
}
