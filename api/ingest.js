// GET /api/ingest — 공공데이터포털 장기요양기관 검색 목록 → Supabase 동기화
//
//   모드:
//     ?mode=resolve  base 후보를 훑어 어떤 조합이 정상응답(resultCode 00)인지 찾기
//     ?mode=sample   정상 조합으로 3건 가져와 원본/매핑 미리보기
//     (기본 sync)    전체 페이지 순회하며 upsert
//
//   보호: Vercel Cron 은 Authorization: Bearer $CRON_SECRET. 수동은 ?secret=$CRON_SECRET.
import { haveDb, sb } from '../lib/db.js';

// 확인된 실제 엔드포인트 (data.go.kr 미리보기 URL 기준)
const BASE = process.env.DATA_GO_KR_BASE || 'https://apis.data.go.kr/B550928/searchLtcInsttService02';
const OP = process.env.DATA_GO_KR_OP || 'getBillGreentInsttSearchList02';

// data.go.kr 상세기능에 여러 오퍼레이션이 있음. 전체 목록용을 찾아야 함.
const OP_CANDIDATES = [
  process.env.DATA_GO_KR_OP,
  'getBillGreentInsttSearchList02',
  'getLtcInsttSeachList02',
  'getLtcInsttSearchList02',
  'getEasyBGgSeachList02',
  'getEasySeachList02',
].filter(Boolean);

const BASE_CANDIDATES = [
  process.env.DATA_GO_KR_BASE,
  'https://apis.data.go.kr/B550928/searchLtcInsttService02',
  'https://apis.data.go.kr/B550928/searchLtcInsttService01',
].filter(Boolean);

// 시도 법정동코드(2자리) → 이름
const SIDO = {
  '11': '서울', '26': '부산', '27': '대구', '28': '인천', '29': '광주', '30': '대전',
  '31': '울산', '36': '세종', '41': '경기', '42': '강원', '51': '강원', '43': '충북',
  '44': '충남', '45': '전북', '52': '전북', '46': '전남', '47': '경북', '48': '경남', '50': '제주',
};

// serviceKind(급여종류) 코드 → 라벨 (실측 후 보정). 원본코드는 raw 에 보존.
const SERVICE_KIND = {
  '01': '주야간보호', '02': '단기보호', '03': '방문요양', '04': '방문목욕', '05': '방문간호',
  '06': '복지용구', '07': '노인요양시설', '08': '노인요양공동생활가정',
  '001': '주야간보호', '002': '단기보호', '003': '방문요양', '004': '방문목욕', '005': '방문간호',
  '006': '복지용구', '007': '노인요양시설', '008': '노인요양공동생활가정',
};

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
    if (mode === 'resolve') {
      res.status(200).json(await resolveBase(key));
      return;
    }
    if (mode === 'ft') {
      const base = 'https://apis.data.go.kr/B550928/searchLtcInsttService02';
      const tests = [
        ['getLtcInsttSeachList02', { siDoCd: '11' }],
        ['getLtcInsttSeachList02', { siDoCd: '11', siGunGuCd: '680' }],
        ['getLtcInsttSeachList02', { serviceKind: '01' }],
        ['getLtcInsttSeachList02', { serviceKind: '05' }],
        ['getBillGreentInsttSearchList02', { siDoCd: '11' }],
      ];
      const out = [];
      for (const [op, extra] of tests) {
        const p = parseResponse((await callApi(key, base, 1, 3, extra, op)).text);
        out.push({
          op,
          extra,
          resultCode: p.resultCode,
          totalCount: p.totalCount,
          firstKeys: p.items[0] ? Object.keys(p.items[0]) : null,
          first: p.items[0] || null,
        });
      }
      res.status(200).json(out);
      return;
    }
    if (mode === 'ops') {
      const out = [];
      for (const base of BASE_CANDIDATES) {
        for (const op of OP_CANDIDATES) {
          try {
            const { status, text } = await callApi(key, base, 1, 2, {}, op);
            const p = parseResponse(text);
            out.push({
              base: base.split('/B550928/')[1],
              op,
              http: status,
              resultCode: p.resultCode,
              resultMsg: p.resultMsg,
              totalCount: p.totalCount,
              firstKeys: p.items[0] ? Object.keys(p.items[0]) : null,
            });
          } catch (e) {
            out.push({ base, op, error: String(e.message || e).slice(0, 150) });
          }
        }
      }
      res.status(200).json({ candidates: out });
      return;
    }
    if (mode === 'count') {
      const base = BASE;
      const out = { noFilter: null, bySido: {}, byServiceKind: {} };
      const nf = parseResponse((await callApi(key, base, 1, 1)).text);
      out.noFilter = { totalCount: nf.totalCount, resultCode: nf.resultCode };
      for (const cd of ['11', '26', '41', '44', '52']) {
        const p = parseResponse((await callApi(key, base, 1, 1, { siDoCd: cd })).text);
        out.bySido[cd] = p.totalCount;
      }
      for (const sk of ['01', '02', '03', '04', '05', '06', '07', '08', '001', '007', '11', '12']) {
        const p = parseResponse((await callApi(key, base, 1, 1, { serviceKind: sk })).text);
        if (p.totalCount) out.byServiceKind[sk] = p.totalCount;
      }
      res.status(200).json(out);
      return;
    }

    const base = await resolveBaseUrl(key);
    if (!base) {
      res.status(502).json({ error: 'no_working_base', tried: BASE_CANDIDATES });
      return;
    }

    if (mode === 'sample') {
      const { items, totalCount } = await fetchPage(key, base, 1, 3);
      res.status(200).json({
        base,
        op: OP,
        totalCount,
        count: items.length,
        rawFirst: items[0] || null,
        mappedFirst: items[0] ? mapRecord(items[0]) : null,
      });
      return;
    }

    // ── 전체 동기화 ──────────────────────────────────────
    if (!haveDb()) {
      res.status(503).json({ error: 'db_not_configured' });
      return;
    }
    const size = 500;
    let page = 1;
    let total = 0;
    let upserted = 0;
    const started = Date.now();
    while (page <= 200) {
      const { items, totalCount } = await fetchPage(key, base, page, size);
      if (page === 1) total = totalCount;
      if (!items.length) break;
      const rows = dedupe(items.map(mapRecord).filter((r) => r.id && r.name));
      if (rows.length) {
        await sb('facilities', {
          method: 'POST',
          body: rows,
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        upserted += rows.length;
      }
      if (items.length < size) break;
      page += 1;
      await sleep(120);
    }
    res.status(200).json({ ok: true, base, totalCount: total, pages: page, upserted, elapsedMs: Date.now() - started });
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

async function callApi(key, base, pageNo, numOfRows, extra = {}, op = OP) {
  let qs =
    `serviceKey=${encodeURIComponent(decodedKey(key))}` +
    `&pageNo=${pageNo}&numOfRows=${numOfRows}&_type=json`;
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') qs += `&${k}=${encodeURIComponent(v)}`;
  }
  const r = await fetch(`${base}/${op}?${qs}`);
  const text = await r.text();
  return { status: r.status, text };
}

// 응답이 JSON 이든 XML 이든 { items, totalCount, resultCode } 로 정규화
function parseResponse(text) {
  // JSON 시도
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

async function fetchPage(key, base, pageNo, numOfRows) {
  const { status, text } = await callApi(key, base, pageNo, numOfRows);
  const parsed = parseResponse(text);
  if (parsed.resultCode && parsed.resultCode !== '00') {
    throw new Error(`data.go.kr ${parsed.resultCode} ${parsed.resultMsg || ''} (http ${status})`);
  }
  return parsed;
}

let _base = null;
async function resolveBaseUrl(key) {
  if (_base) return _base;
  for (const base of BASE_CANDIDATES) {
    try {
      const { text } = await callApi(key, base, 1, 1);
      const p = parseResponse(text);
      if ((p.resultCode === '00' || p.items.length) && !/NO_OPENAPI_SERVICE/.test(text)) {
        _base = base;
        return base;
      }
    } catch {
      /* 다음 */
    }
  }
  return null;
}

async function resolveBase(key) {
  const out = [];
  for (const base of BASE_CANDIDATES) {
    try {
      const { status, text } = await callApi(key, base, 1, 2);
      const p = parseResponse(text);
      out.push({
        base,
        http: status,
        resultCode: p.resultCode,
        resultMsg: p.resultMsg,
        totalCount: p.totalCount,
        firstKeys: p.items[0] ? Object.keys(p.items[0]) : null,
        first: p.items[0] || null,
      });
    } catch (e) {
      out.push({ base, error: String(e.message || e).slice(0, 200) });
    }
  }
  return { op: OP, candidates: out };
}

// ── 레코드 매핑 (실측: adminNm, longTermAdminSym, serviceKind, siDoCd, siGunGuCd, locTelNo_1~3, hmPostNo) ──
function mapRecord(r) {
  const sidoCd = str(r.siDoCd);
  const sggCd = str(r.siGunGuCd);
  const tel = [r.locTelNo_1, r.locTelNo_2, r.locTelNo_3].map(str).filter(Boolean);
  const kind = str(r.serviceKind);
  return {
    id: str(r.longTermAdminSym) || str(r.ltcAdminSym),
    name: str(r.adminNm) || str(r.longTermAdminNm),
    type_code: kind,
    type_label: (kind && SERVICE_KIND[kind]) || null,
    sido: (sidoCd && SIDO[sidoCd]) || sidoCd || null,
    sigungu: sidoCd && sggCd ? `${sidoCd}${sggCd}` : sggCd || null,
    address: null, // 목록 API 에는 주소 문자열 없음 (상세조회 API 필요)
    road_address: null,
    phone: tel.length === 3 ? tel.join('-') : tel.join('') || null,
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
