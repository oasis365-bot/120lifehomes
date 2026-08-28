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

const BASE = 'https://apis.data.go.kr/B550928/searchLtcInsttService01';

// 오퍼레이션 경로가 확실치 않아 후보를 둔다. 확인되면 DATA_GO_KR_OP 로 고정.
const OP_CANDIDATES = [
  process.env.DATA_GO_KR_OP,
  'getBillGreentInsttSearchList01',
  'getLtcInsttSearchList',
  'getLtcInsttSearchList01',
  'getLtcInsttList',
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
async function fetchPage(key, op, pageNo, numOfRows) {
  const p = new URLSearchParams({
    serviceKey: key,
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
    _type: 'json',
  });
  const r = await fetch(`${BASE}/${op}?${p.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`JSON 파싱 실패 (op=${op}, http=${r.status}): ${text.slice(0, 300)}`);
  }
  const body = json?.response?.body ?? {};
  let item = body?.items?.item ?? body?.items ?? [];
  if (!Array.isArray(item)) item = item ? [item] : [];
  return { items: item, totalCount: Number(body.totalCount) || 0, header: json?.response?.header };
}

async function probe(key) {
  const out = [];
  for (const op of OP_CANDIDATES) {
    try {
      const { items, totalCount, header } = await fetchPage(key, op, 1, 1);
      out.push({
        op,
        ok: true,
        totalCount,
        header,
        sampleKeys: items[0] ? Object.keys(items[0]) : [],
        sample: items[0] || null,
      });
    } catch (e) {
      out.push({ op, ok: false, error: String(e.message || e).slice(0, 200) });
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
