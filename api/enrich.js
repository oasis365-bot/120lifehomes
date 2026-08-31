// GET /api/enrich — 장기요양기관 시설별 상세조회(15058856)로 facilities 보강
//
//   base: https://apis.data.go.kr/B550928/getLtcInsttDetailInfoService02
//   getGeneralSttusDetailInfoItem02 : 우편번호·시군구·도로명코드·전화·지정일  (param: longTermAdminSym, adminPttnCd)
//   getAceptncNmprDetailInfoItem02  : 정원(totPer)·현원(maNowPer+fmNowPer)·대기(maRsvPer+fmRsvPer)
//
//   ?mode=one&sym=<기관기호>&pttn=<유형코드>   한 기관 조회 미리보기 (DB 미수정)
//   ?limit=200 [&sido=서울] [&pttn=A03]         address/capacity 비어있는 기관 보강 (batch)
//   보호: ?secret=$CRON_SECRET
import { haveDb, sb } from '../lib/db.js';

export const config = { maxDuration: 60 };

const BASE = 'https://apis.data.go.kr/B550928/getLtcInsttDetailInfoService02';
const OP_GENERAL = 'getGeneralSttusDetailInfoItem02';
const OP_CAPACITY = 'getAceptncNmprDetailInfoItem02';

function decodedKey(k) { try { return k.includes('%') ? decodeURIComponent(k) : k; } catch { return k; } }

async function call(key, op, sym, pttn) {
  const qs = `serviceKey=${encodeURIComponent(decodedKey(key))}` +
    `&longTermAdminSym=${encodeURIComponent(sym)}&adminPttnCd=${encodeURIComponent(pttn || '')}&_type=json`;
  const r = await fetch(`${BASE}/${op}?${qs}`);
  return { status: r.status, text: await r.text() };
}
function parseItem(text) {
  try {
    const j = JSON.parse(text);
    const err = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (err) return { err: err.returnAuthMsg };
    const body = j?.response?.body ?? {};
    let it = body?.item ?? body?.items?.item ?? body?.items ?? null;
    if (Array.isArray(it)) it = it[0];
    return { item: it || null, code: j?.response?.header?.resultCode };
  } catch { /* xml */ }
  const m = text.match(/<item>([\s\S]*?)<\/item>/);
  if (!m) return { item: null, raw: text.slice(0, 200) };
  const o = {};
  const fr = /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g;
  let f;
  while ((f = fr.exec(m[1]))) o[f[1]] = f[2];
  return { item: o };
}

function n(v) { const x = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(x) ? x : null; }

function throttled(text) {
  return /REQUESTS_PER_SECOND|returnReasonCode":"23|<returnReasonCode>23</.test(text);
}
async function callRetry(key, op, sym, pttn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await call(key, op, sym, pttn);
    if (!throttled(r.text)) return r;
    await sleep(400 + i * 500 + Math.random() * 300);
  }
  return call(key, op, sym, pttn);
}
function isLimit(text) {
  return /LIMITED_NUMBER|returnReasonCode":"22|<returnReasonCode>22</.test(text);
}
async function fetchDetail(key, sym, pttn) {
  const isResi = /^A0/.test(pttn || '');
  const gr = await callRetry(key, OP_GENERAL, sym, pttn);
  const cr = isResi ? await callRetry(key, OP_CAPACITY, sym, pttn) : { text: '{}' };
  const g = parseItem(gr.text);
  const c = parseItem(cr.text);
  const hitLimit = isLimit(gr.text) || (isResi && isLimit(cr.text));
  const gi = g.item || {};
  const ci = c.item || {};
  const tel = [gi.locTelNo_1, gi.locTelNo_2, gi.locTelNo_3].map(x => String(x ?? '').trim()).filter(Boolean);
  const cap = n(ci.totPer);
  const now = (n(ci.maNowPer) || 0) + (n(ci.fmNowPer) || 0);
  const wait = (n(ci.maRsvPer) || 0) + (n(ci.fmRsvPer) || 0);
  return {
    general: gi, capacity: ci, hitLimit,
    mapped: {
      phone: tel.length === 3 ? tel.join('-') : (tel.join('') || null),
      post_no: String(gi.hmPostNo ?? '').trim() || null,
      detail_addr: String(gi.detailAddr ?? '').trim() || null,
      road_cd: String(gi.roadNmCd ?? '').trim() || null,
      bldg_main: n(gi.gunmulMlno), bldg_sub: n(gi.gunmulSlno),
      capacity: cap,
      current_count: cap != null ? now : null,
      waiting_count: wait || null,
      detail_synced_at: new Date().toISOString(),
    },
  };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const ok = !secret || req.headers.authorization === `Bearer ${secret}` || (req.query && req.query.secret === secret);
  if (!ok) { res.status(401).json({ error: 'unauthorized' }); return; }
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) { res.status(503).json({ error: 'DATA_GO_KR_KEY 미설정' }); return; }

  const q = req.query || {};

  try {
    if (q.mode === 'one') {
      if (!q.sym) { res.status(400).json({ error: 'sym 필요' }); return; }
      const pttn = q.pttn || 'A03';
      const gRaw = await call(key, OP_GENERAL, q.sym, pttn);
      const cRaw = await call(key, OP_CAPACITY, q.sym, pttn);
      const d = await fetchDetail(key, q.sym, pttn);
      res.status(200).json({
        req: { sym: q.sym, pttn },
        generalRaw: gRaw.text.slice(0, 700),
        capacityRaw: cRaw.text.slice(0, 500),
        mapped: d.mapped,
      });
      return;
    }

    if (!haveDb()) { res.status(503).json({ error: 'db_not_configured' }); return; }
    const limit = Math.min(parseInt(q.limit, 10) || 100, 400);

    // 아직 상세 미보강 기관 선택 (detail_synced_at 없음)
    const p = new URLSearchParams();
    p.set('select', 'id,type_code,sido');
    p.append('detail_synced_at', 'is.null');
    if (q.sido) p.append('sido', `eq.${q.sido}`);
    if (q.pttn) p.append('type_code', `eq.${q.pttn}`);
    p.append('order', 'id.asc');
    p.append('limit', String(limit));
    const { data: targets } = await sb(`facilities?${p.toString()}`);
    if (!targets || !targets.length) {
      res.status(200).json({ ok: true, done: true, updated: 0, note: '보강 대상 없음' });
      return;
    }

    const started = Date.now();
    let updated = 0, errors = 0, processed = 0;
    const CONCURRENCY = 4; // 초당 30tps 한도 고려
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      if (Date.now() - started > 48000) break;
      const slice = targets.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (t) => {
        processed += 1;
        try {
          const d = await fetchDetail(key, t.id, t.type_code || 'A03');
          if (d.hitLimit) { errors += 1; return; } // 일일한도 소진 — 마킹하지 않고 다음 기회에
          const m = d.mapped;
          const patch = { updated_at: new Date().toISOString(), detail_synced_at: new Date().toISOString() };
          if (m.phone) patch.phone = m.phone;
          if (m.post_no) patch.post_no = m.post_no;
          if (m.capacity != null) { patch.capacity = m.capacity; patch.current_count = m.current_count; }
          await sb(`facilities?id=eq.${encodeURIComponent(t.id)}`, {
            method: 'PATCH', prefer: 'return=minimal', body: patch,
          });
          if (m.phone || m.post_no || m.capacity != null) updated += 1;
        } catch (e) { errors += 1; }
      }));
      await sleep(250);
    }
    res.status(200).json({ ok: true, picked: targets.length, processed, updated, errors, elapsedMs: Date.now() - started });
  } catch (e) {
    console.error('[enrich]', e);
    res.status(500).json({ error: 'enrich_failed', detail: String(e.message || e).slice(0, 300) });
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
