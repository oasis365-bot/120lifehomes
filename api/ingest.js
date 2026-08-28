// GET /api/ingest — 공공데이터포털 장기요양기관 데이터 → Supabase 동기화
//
//   모드:
//     ?mode=probe   후보 오퍼레이션들을 1건씩 호출해 어떤 게 응답하는지 + 원본 필드명 확인
//     ?mode=sample  정상 오퍼레이션으로 3건 가져와 매핑 결과 미리보기
//     (기본)        전체 페이지 순회하며 upsert
//
//   보호: Vercel Cron 은 자동으로 Authorization: Bearer $CRON_SECRET 를 보냄.
//         수동 호출은 ?secret=$CRON_SECRET.
import { haveDb, sb } from '../lib/db.js';

const BASE = process.env.DATA_GO_KR_BASE || 'https://apis.data.go.kr/B550928/searchLtcInsttService01';

// base + operation 조합 후보. 확인되면 DATA_GO_KR_BASE / DATA_GO_KR_OP 로 고정.
const BASE_CANDIDATES = [
  process.env.DATA_GO_KR_BASE,
  'https://apis.data.go.kr/B550928/searchLtcInsttService01',
  'https://apis.data.go.kr/B550928/searchLtcInsttService',
  'https://apis.data.go.kr/B550928/orgInfoService',
].filter(Boolean);

const OP_CANDIDATES = [
  process.env.DATA_GO_KR_OP,
  'getBillGreentInsttSearchList01',
  'getBillGreentInsttSearchList',
  'getLtcInsttSearchList',
  'getEasyBGgList',
  'getInsttSearchList',
].filter(Boolean);

export default async function handler(req, res) {
  // ── 인증 ───────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization === `Bearer ${secret}`;
  const viaQuery = req.query && req.query.secret && req.query.secret === secret;
  if (secret && !auth && !viaQuery) {
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
    if (mode === 'probe') {
      res.status(200).json(await probe(key));
      return;
    }
    if (mode === 'diag') {
      res.status(200).json(await diag(key));
      return;
    }

    const op = await resolveOp(key);
    if (!op) {
      res.status(502).json({ error: 'no_working_operation', tried: OP_CANDIDATES });
      return;
    }

    if (mode === 'sample') {
      const { items } = await fetchPage(key, op, 1, 3);
      res.status(200).json({
        op,
        rawFirst: items[0] || null,
        mappedFirst: items[0] ? mapRecord(items[0]) : null,
        note: '필드명이 예상과 다르면 mapRecord() 를 이 rawFirst 기준으로 수정하세요.',
      });
      return;
    }

    // ── 전체 동기화 ─────────────────────────────────────
    if (!haveDb()) {
      res.status(503).json({ error: 'db_not_configured' });
      return;
    }
    const size = 500;
    let page = 1;
    let total = 0;
    let upserted = 0;
    const started = Date.now();
    // 안전장치: 최대 120페이지(6만건)
    while (page <= 120) {
      const { items, totalCount } = await fetchPage(key, op, page, size);
      if (page === 1) total = totalCount;
      if (!items.length) break;
      const rows = items.map(mapRecord).filter((r) => r.id && r.name);
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
      // 서버 부담 완화
      await sleep(150);
    }
    res.status(200).json({
      ok: true,
      op,
      totalCount: total,
      pages: page,
      upserted,
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    console.error('[ingest]', e);
    res.status(500).json({ error: 'ingest_failed', detail: String(e.message || e) });
  }
}

// ── data.go.kr 호출 ──────────────────────────────────────
// serviceKey 는 재인코딩하지 않는다. (Encoding 키는 이미 %2F/%3D 포함,
//  Decoding 키는 원문. 사용자가 어떤 걸 넣었든 그대로 붙인다 → decoded 우선 사용)
function decodedKey(key) {
  try {
    return key.includes('%') ? decodeURIComponent(key) : key;
  } catch {
    return key;
  }
}
async function fetchRaw(key, op, pageNo, numOfRows, extra = {}, base = BASE) {
  const rest = new URLSearchParams({
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
    _type: 'json',
    ...extra,
  });
  const url = `${base}/${op}?serviceKey=${encodeURIComponent(decodedKey(key))}&${rest.toString()}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await r.text();
  return { httpStatus: r.status, contentType: r.headers.get('content-type'), text, url };
}

// 모든 base × op 조합을 훑어 에러메시지를 수집한다.
async function diag(key) {
  const results = [];
  for (const base of BASE_CANDIDATES) {
    for (const op of OP_CANDIDATES) {
      try {
        const raw = await fetchRaw(key, op, 1, 2, {}, base);
        let errMsg = null;
        let ok = false;
        let firstKeys = null;
        try {
          const j = JSON.parse(raw.text);
          errMsg =
            j?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnAuthMsg ||
            j?.OpenAPI_ServiceResponse?.cmmMsgHeader?.errMsg ||
            j?.response?.header?.resultMsg ||
            null;
          const item =
            j?.response?.body?.items?.item ?? j?.response?.body?.items ?? null;
          const arr = Array.isArray(item) ? item : item ? [item] : [];
          if (arr[0]) {
            ok = true;
            firstKeys = Object.keys(arr[0]);
          } else if (j?.response?.header?.resultCode === '00') {
            ok = true;
          }
        } catch {
          errMsg = 'non-JSON: ' + raw.text.slice(0, 120);
        }
        results.push({ base: base.split('/B550928/')[1] || base, op, http: raw.httpStatus, ok, errMsg, firstKeys });
      } catch (e) {
        results.push({ base, op, error: String(e.message || e).slice(0, 150) });
      }
    }
  }
  return {
    keyLooksEncoded: key.includes('%'),
    keyLen: key.length,
    results,
  };
}

async function fetchPage(key, op, pageNo, numOfRows) {
  const { httpStatus, text } = await fetchRaw(key, op, pageNo, numOfRows);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`JSON 파싱 실패 (op=${op}, http=${httpStatus}): ${text.slice(0, 300)}`);
  }
  const body = json?.response?.body ?? json?.body ?? {};
  let item = body?.items?.item ?? body?.items ?? body?.item ?? [];
  if (!Array.isArray(item)) item = item ? [item] : [];
  const header = json?.response?.header ?? json?.header ?? null;
  return { items: item, totalCount: Number(body.totalCount) || 0, header, json };
}

async function probe(key) {
  const out = [];
  for (const op of OP_CANDIDATES) {
    try {
      const raw = await fetchRaw(key, op, 1, 3);
      let parsed = null;
      let topKeys = null;
      try {
        parsed = JSON.parse(raw.text);
        topKeys = Object.keys(parsed);
      } catch {
        /* XML 등 */
      }
      out.push({
        op,
        url: raw.url.replace(key, 'KEY'),
        httpStatus: raw.httpStatus,
        contentType: raw.contentType,
        topKeys,
        header: parsed?.response?.header ?? parsed?.header ?? null,
        bodyKeys: parsed?.response?.body ? Object.keys(parsed.response.body) : null,
        rawHead: raw.text.slice(0, 900),
      });
    } catch (e) {
      out.push({ op, ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }
  return { candidates: out };
}

let _op = null;
async function resolveOp(key) {
  if (_op) return _op;
  for (const op of OP_CANDIDATES) {
    try {
      const { header } = await fetchPage(key, op, 1, 1);
      const code = header?.resultCode ?? header?.['resultCode'];
      if (code === undefined || code === '00' || code === 0) {
        _op = op;
        return op;
      }
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

// ── 레코드 매핑 (첫 실사 응답 확인 후 조정 필요) ─────────────
function mapRecord(r) {
  return {
    id: pick(r, ['longTermAdminSym', 'ltcAdminSym', 'adminSym', 'ltcInsttCd', 'insttCode']),
    name: pick(r, ['adminNm', 'longTermAdminNm', 'ltcInsttNm', 'yadmNm', 'bplcNm']),
    type_code: pick(r, ['ltcClCd', 'admTypeCd', 'salaryKindCd', 'ltcInsttClCd']),
    type_label: pick(r, ['ltcClNm', 'admTypeNm', 'salaryKindNm', 'ltcInsttClNm']),
    sido: pick(r, ['siDoNm', 'sidoNm', 'siDoCd']),
    sigungu: pick(r, ['siGunGuNm', 'sigunguNm', 'siGunGuCd']),
    address: pick(r, ['lnmAddr', 'lotNoAddr', 'addr', 'address']),
    road_address: pick(r, ['roadNmAddr', 'rnAddr', 'roadAddr']),
    lat: num(pick(r, ['la', 'lat', 'yPos', 'yCrdnt'])),
    lng: num(pick(r, ['lo', 'lng', 'xPos', 'xCrdnt'])),
    phone: pick(r, ['telNo', 'telno', 'tel', 'phoneNumber']),
    capacity: int(pick(r, ['totRatedPersonCnt', 'ratedPersonCnt', 'fixNum', 'totPrsnCnt'])),
    current_count: int(pick(r, ['nowRatedPersonCnt', 'usePersonCnt', 'curNum', 'nowPrsnCnt'])),
    eval_grade: pick(r, ['evalGrade', 'evalGdCd', 'grade', 'evltGrde']),
    established_at: dateOf(pick(r, ['desnDate', 'estbDate', 'desnYmd', 'desginDate'])),
    raw: r,
    synced_at: new Date().toISOString(),
  };
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return null;
}
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function int(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function dateOf(v) {
  if (!v) return null;
  const s = String(v).replace(/[^\d]/g, '');
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
