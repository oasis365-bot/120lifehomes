// GET /api/ingest — 공공데이터포털 장기요양기관 검색 목록 → Supabase 동기화
//
//   엔드포인트: apis.data.go.kr/B550928/searchLtcInsttService02/getLtcInsttSeachList02
//   이 오퍼레이션은 필터(siDoCd 등)가 필요 → 17개 시도를 순회하며 수집.
//   제공 필드: adminNm, adminPttnCd, longTermAdminSym, siDoCd, siGunGuCd,
//             longTermPeribRgtDt(지정일), stpRptDt(설치신고일)
//   (주소문자열·전화·정원·평가등급·좌표는 이 API 에 없음 → 상세조회 API 별도 필요)
//
//   모드: ?mode=sample | ?mode=diag | (기본 sync)
//   보호: Vercel Cron → Authorization: Bearer $CRON_SECRET, 수동 → ?secret=
import { haveDb, sb } from '../lib/db.js';

export const config = { maxDuration: 60 }; // Vercel Hobby 최대

const BASE = process.env.DATA_GO_KR_BASE || 'https://apis.data.go.kr/B550928/searchLtcInsttService02';
const OP = process.env.DATA_GO_KR_OP || 'getLtcInsttSeachList02';

// 시도 코드 (실측: 강원 51, 전북 52 신코드. 광주 29·전남 46 은 이 API 에 데이터 없음 — 상세 API 로 보완 예정)
const SIDO_CODES = ['11', '26', '27', '28', '29', '30', '31', '36', '41', '43', '44', '46', '47', '48', '50', '51', '52'];
const SIDO = {
  '11': '서울', '26': '부산', '27': '대구', '28': '인천', '29': '광주', '30': '대전',
  '31': '울산', '36': '세종', '41': '경기', '43': '충북', '44': '충남', '45': '전북',
  '46': '전남', '47': '경북', '48': '경남', '50': '제주', '51': '강원', '42': '강원', '52': '전북',
};

// 기관구분코드(adminPttnCd) → 라벨. 실측 분포 기반.
//  A0x = 시설급여, B0x = 재가장기요양기관, C0x = 재가노인복지시설, x: 1방문요양 2방문목욕 3방문간호 4주야간보호 5단기보호 6복지용구
const ADMIN_PTTN = {
  A01: '노인요양시설', A02: '노인요양시설', A03: '노인요양시설', A04: '노인요양공동생활가정', A05: '노인요양공동생활가정',
  B01: '방문요양', B02: '방문목욕', B03: '방문간호', B04: '주야간보호', B05: '단기보호', B06: '복지용구',
  C01: '방문요양', C02: '방문목욕', C03: '방문간호', C04: '주야간보호', C05: '단기보호', C06: '복지용구',
  S41: '재가노인지원', G31: '기타', H31: '기타', M32: '기타',
};

// 기관명 키워드로 유형 보강
function typeFromName(name) {
  const n = name || '';
  if (/요양병원/.test(n)) return '요양병원';
  if (/공동생활가정|그룹홈/.test(n)) return '노인요양공동생활가정';
  if (/주야간|데이케어|주간보호/.test(n)) return '주야간보호';
  if (/단기보호/.test(n)) return '단기보호';
  if (/방문목욕/.test(n)) return '방문목욕';
  if (/방문간호/.test(n)) return '방문간호';
  if (/방문요양|재가/.test(n)) return '방문요양';
  if (/실버타운|노인복지주택/.test(n)) return '노인복지주택';
  if (/양로/.test(n)) return '양로시설';
  if (/요양원|요양시설|노인요양/.test(n)) return '노인요양시설';
  return null;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const authed =
    !secret ||
    req.headers.authorization === `Bearer ${secret}` ||
    (req.query && req.query.secret === secret);
  if (!authed) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const key = process.env.DATA_GO_KR_KEY;
  if (!key) {
    res.status(503).json({ error: 'DATA_GO_KR_KEY 미설정' });
    return;
  }

  const mode = (req.query && req.query.mode) || 'sync';

  try {
    if (mode === 'diag') {
      const out = {};
      for (const cd of ['11', '41', '48']) {
        const p = parseResponse((await callApi(key, 1, 2, { siDoCd: cd })).text);
        out[cd] = { total: p.totalCount, first: p.items[0] || null };
      }
      res.status(200).json({ base: BASE, op: OP, out });
      return;
    }
    if (mode === 'stats' && haveDb()) {
      const { count: total } = await sb('facilities?select=id&limit=1', { prefer: 'count=exact' });
      const bySido = {};
      for (const s of ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주']) {
        const { count } = await sb(`facilities?select=id&sido=eq.${encodeURIComponent(s)}&limit=1`, { prefer: 'count=exact' });
        bySido[s] = count;
      }
      const byType = {};
      const byTypeLabel = {};
      for (let off = 0; off < 30000; off += 1000) {
        const { data } = await sb(`facilities?select=type_code,type_label&limit=1000&offset=${off}`);
        if (!data || !data.length) break;
        for (const r of data) {
          byType[r.type_code || 'null'] = (byType[r.type_code || 'null'] || 0) + 1;
          byTypeLabel[r.type_label || 'null'] = (byTypeLabel[r.type_label || 'null'] || 0) + 1;
        }
      }
      res.status(200).json({ total, bySido, byType, byTypeLabel });
      return;
    }

    if (mode === 'sample') {
      const p = parseResponse((await callApi(key, 1, 3, { siDoCd: '11' })).text);
      res.status(200).json({
        totalCount: p.totalCount,
        rawFirst: p.items[0] || null,
        mappedFirst: p.items[0] ? mapRecord(p.items[0]) : null,
      });
      return;
    }

    // ── 전체 동기화 (시도별 순회) ─────────────────────────
    if (!haveDb()) {
      res.status(503).json({ error: 'db_not_configured' });
      return;
    }
    const started = Date.now();
    const size = 500;
    const perSido = {};
    let upserted = 0;
    let calls = 0;
    const onlySido = req.query && req.query.sido; // 부분 동기화용

    for (const cd of onlySido ? [onlySido] : SIDO_CODES) {
      let page = 1;
      let sidoTotal = 0;
      while (page <= 40) {
        const { text } = await callApi(key, page, size, { siDoCd: cd });
        calls += 1;
        const p = parseResponse(text);
        if (p.resultCode && p.resultCode !== '00') {
          throw new Error(`시도 ${cd} p${page}: ${p.resultCode} ${p.resultMsg}`);
        }
        if (page === 1) sidoTotal = p.totalCount;
        if (!p.items.length) break;
        const rows = dedupe(p.items.map((r) => mapRecord(r, cd)).filter((r) => r.id && r.name));
        if (rows.length) {
          await sb('facilities', {
            method: 'POST',
            body: rows,
            prefer: 'resolution=merge-duplicates,return=minimal',
          });
          upserted += rows.length;
        }
        if (p.items.length < size) break;
        page += 1;
        await sleep(120);
      }
      perSido[cd] = sidoTotal;
      await sleep(150);
    }

    res.status(200).json({
      ok: true,
      calls,
      upserted,
      perSido,
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    console.error('[ingest]', e);
    res.status(500).json({ error: 'ingest_failed', detail: String(e.message || e).slice(0, 400) });
  }
}

// ── data.go.kr 호출 ──────────────────────────────────────
function decodedKey(key) {
  try {
    return key.includes('%') ? decodeURIComponent(key) : key;
  } catch {
    return key;
  }
}

async function callApi(key, pageNo, numOfRows, extra = {}) {
  let qs =
    `serviceKey=${encodeURIComponent(decodedKey(key))}` +
    `&pageNo=${pageNo}&numOfRows=${numOfRows}&_type=json`;
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') qs += `&${k}=${encodeURIComponent(v)}`;
  }
  const r = await fetch(`${BASE}/${OP}?${qs}`);
  const text = await r.text();
  return { status: r.status, text };
}

function parseResponse(text) {
  try {
    const j = JSON.parse(text);
    const err = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (err) return { resultCode: err.returnReasonCode, resultMsg: err.returnAuthMsg, items: [], totalCount: 0 };
    const body = j?.response?.body ?? {};
    let item = body?.items?.item ?? body?.items ?? [];
    if (!Array.isArray(item)) item = item ? [item] : [];
    return {
      resultCode: j?.response?.header?.resultCode ?? '00',
      resultMsg: j?.response?.header?.resultMsg,
      items: item,
      totalCount: Number(body.totalCount) || 0,
    };
  } catch {
    /* XML */
  }
  const resultCode = (text.match(/<resultCode>([^<]*)<\/resultCode>/) || [])[1];
  const resultMsg = (text.match(/<resultMsg>([^<]*)<\/resultMsg>/) || [])[1];
  const totalCount = Number((text.match(/<totalCount>([^<]*)<\/totalCount>/) || [])[1]) || 0;
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(text))) {
    const obj = {};
    const fieldRe = /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g;
    let f;
    while ((f = fieldRe.exec(m[1]))) obj[f[1]] = f[2];
    items.push(obj);
  }
  return { resultCode, resultMsg, items, totalCount };
}

// ── 레코드 매핑 ──────────────────────────────────────────
function mapRecord(r, sidoCdHint) {
  const sidoCd = str(r.siDoCd) || sidoCdHint || null;
  const sggCd = str(r.siGunGuCd);
  const name = str(r.adminNm) || str(r.longTermAdminNm);
  const pttn = str(r.adminPttnCd);
  return {
    id: str(r.longTermAdminSym) || str(r.ltcAdminSym),
    name,
    type_code: pttn,
    type_label: (pttn && ADMIN_PTTN[pttn]) || typeFromName(name),
    sido: (sidoCd && SIDO[sidoCd]) || sidoCd || null,
    sigungu: sidoCd && sggCd ? `${sidoCd}${sggCd.padStart(3, '0')}` : sggCd || null,
    established_at: dateOf(r.longTermPeribRgtDt),
    raw: r,
    synced_at: new Date().toISOString(),
  };
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}
function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function dateOf(v) {
  const s = String(v ?? '').replace(/[^\d]/g, '');
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
