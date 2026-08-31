// GET /api/enrich — 장기요양기관 시설별 상세조회(15058856)로 facilities 보강
//
//   ?mode=probe&sym=<기관기호>   후보 오퍼레이션 호출해 응답/필드 확인
//   ?mode=one&sym=<기관기호>      한 기관 상세 조회 + 매핑 미리보기 (DB 미수정)
//   (기본 batch)                  address 없는 기관 N개 보강 (?limit=, ?sido=)
//
//   보호: ?secret=$CRON_SECRET 또는 Bearer
import { haveDb, sb } from '../lib/db.js';

export const config = { maxDuration: 60 };

const BASE = process.env.DATA_GO_KR_DETAIL_BASE || 'https://apis.data.go.kr/B550928/getLtcInsttDetailInfoService02';

// 오퍼레이션명 미확정 → 후보. 확인되면 상수로 고정.
const OPS = {
  general: ['getGnrlInfoService02', 'getGnrlInfo', 'getLtcInsttGnrlInfo', 'getBasInfo', 'getGnrlBasInfo02'],
  admission: ['getAdmiInfoService02', 'getAdmiInfo', 'getInmtInfo', 'getInmtPrsnInfo02', 'getInmtInfoService02'],
  facility: ['getFcltInfoService02', 'getFcltInfo', 'getSttusInfo02'],
};

function decodedKey(key) {
  try { return key.includes('%') ? decodeURIComponent(key) : key; } catch { return key; }
}
async function call(key, op, sym) {
  const qs = `serviceKey=${encodeURIComponent(decodedKey(key))}&longTermAdminSym=${encodeURIComponent(sym)}&_type=json`;
  const r = await fetch(`${BASE}/${op}?${qs}`);
  const text = await r.text();
  return { status: r.status, text };
}
function parse(text) {
  try {
    const j = JSON.parse(text);
    const err = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (err) return { code: err.returnReasonCode, msg: err.returnAuthMsg, items: [] };
    const body = j?.response?.body ?? {};
    let item = body?.items?.item ?? body?.items ?? [];
    if (!Array.isArray(item)) item = item ? [item] : [];
    return { code: j?.response?.header?.resultCode ?? '00', items: item, totalCount: body.totalCount };
  } catch { /* xml */ }
  const code = (text.match(/<resultCode>([^<]*)</) || [])[1];
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(text))) {
    const o = {};
    const fr = /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g;
    let f;
    while ((f = fr.exec(m[1]))) o[f[1]] = f[2];
    items.push(o);
  }
  return { code, items };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const ok = !secret || req.headers.authorization === `Bearer ${secret}` || (req.query && req.query.secret === secret);
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  const key = process.env.DATA_GO_KR_KEY;
  if (!key) { res.status(503).json({ error: 'DATA_GO_KR_KEY 미설정' }); return; }

  const mode = (req.query && req.query.mode) || 'batch';
  const sym = req.query && req.query.sym;

  try {
    if (mode === 'probe') {
      if (!sym) { res.status(400).json({ error: 'sym 필요 (예: 11132000337)' }); return; }
      const out = {};
      for (const [group, cands] of Object.entries(OPS)) {
        out[group] = [];
        for (const op of cands) {
          const { status, text } = await call(key, op, sym);
          const p = parse(text);
          out[group].push({
            op, http: status, code: p.code,
            keys: p.items[0] ? Object.keys(p.items[0]) : null,
            first: p.items[0] || null,
            rawHead: p.items.length ? undefined : text.slice(0, 200),
          });
        }
      }
      res.status(200).json({ base: BASE, out });
      return;
    }

    res.status(501).json({ error: 'probe 로 오퍼레이션 확인 후 batch/one 구현 예정' });
  } catch (e) {
    console.error('[enrich]', e);
    res.status(500).json({ error: 'enrich_failed', detail: String(e.message || e).slice(0, 300) });
  }
}
