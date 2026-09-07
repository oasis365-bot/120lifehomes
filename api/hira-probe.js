// =====================================================================
// [임시·일회성] HIRA 공식 API 응답 샘플 수집기 — Preview 전용
// =====================================================================
//  목적 (1B-1): 실제 HIRA 응답 S1~S9 를 1회 수집해 필드/코드/NULL/예외를 확정.
//  수집이 끝나면 이 파일 하나만 지우면 됨:  git rm api/hira-probe.js
//  → 다른 파일 의존 없음. DB 접근 없음. 쓰기 없음. GET 만.
//
//  보안
//   · process.env.VERCEL_ENV === 'production'  → 무조건 404 (실행 안 함)
//   · CRON_SECRET Bearer 인증 (timingSafeEqual). 없거나 틀리면 401.  ?secret= 도 허용(호환)
//   · serviceKey 는 응답·에러·raw 어디에도 노출 안 함 (scrub)
//   · 요청 전체 URL 을 로그로 남기지 않음 (console 미사용)
//   · 업스트림 오류 시 stack/URL 없이 { error, op, status } 만 반환
//
//  사용
//   GET /api/hira-probe                    → mode=check (기본): 환경변수 존재 여부만. HIRA 호출 X
//   GET /api/hira-probe?mode=run           → S1~S9 시퀀스 수집. HIRA GET 약 12~22회, 순차 250ms 간격(≈4tps)
//   GET /api/hira-probe?mode=one&base=hospInfo|hospAsm|dtl&op=..&ykiho=..&clCd=..&numOfRows=..
//                                          → 단건 디버그
// =====================================================================
import { timingSafeEqual } from 'node:crypto';

export const config = { maxDuration: 60 };

// ── 확정된 base (1B-0 공식 가이드) ──
const HOSP_INFO_BASE = 'https://apis.data.go.kr/B551182/hospInfoService1';
const HOSP_ASM_BASE = 'https://apis.data.go.kr/B551182/hospAsmInfoService1';
const OP_HOSP_LIST = 'getHospBasisList1';
const OP_HOSP_ASM = 'getHospAsmInfo1';

// ── 의료기관별상세정보 2.8 : base 미확정 → 후보 probe ──
const DTL_BASE_CANDIDATES = [
  'https://apis.data.go.kr/B551182/medicInsttDetailInfoService',
  'https://apis.data.go.kr/B551182/medicInsttDetailInfoService2.8',
  'https://apis.data.go.kr/B551182/MadmDtlInfoService2.8',
  'https://apis.data.go.kr/B551182/MadmDtlInfoService',
];
const DTL_OPS = {
  eqp: 'getEqpInfo2.8',        // 시설정보 (병상 추정)
  dtl: 'getDtlInfo2.8',        // 세부정보 (폐업·운영상태 추정)
  dgsbjt: 'getDgsbjtInfo2.8',  // 진료과목정보
  medOft: 'getMedOftInfo2.8',  // 의료장비정보
  spcSbjt: 'getSpcSbjtSdrInfo2.8', // 전문과목별 전문의 수
  etcHst: 'getEtcHstInfo2.8',  // 기타인력수
};

// ── util ──
function decodedKey(k) {
  try { return k.includes('%') ? decodeURIComponent(k) : k; } catch { return k; }
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length === 0 || A.length !== B.length) return false;
  try { return timingSafeEqual(A, B); } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// serviceKey 흔적 완전 제거 (원문 / 디코딩 / 각 인코딩 변형)
function scrub(text, key) {
  if (!text || !key) return text || '';
  let out = String(text);
  const dk = decodedKey(key);
  for (const v of [key, dk, encodeURIComponent(key), encodeURIComponent(dk)]) {
    if (v && v.length > 8) out = out.split(v).join('***REDACTED***');
  }
  return out;
}

// JSON 우선, XML fallback (enrich.js / ingest.js 패턴)
function parse(text) {
  try {
    const j = JSON.parse(text);
    const gw = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (gw) {
      return {
        format: 'json', resultCode: gw.returnReasonCode ?? null, resultMsg: gw.returnAuthMsg ?? null,
        totalCount: null, numOfRows: null, pageNo: null, items: [], gatewayError: true,
      };
    }
    const h = j?.response?.header ?? {};
    const b = j?.response?.body ?? {};
    let it = b?.items?.item ?? b?.items ?? [];
    it = Array.isArray(it) ? it : (it ? [it] : []);
    return {
      format: 'json', resultCode: h.resultCode ?? null, resultMsg: h.resultMsg ?? null,
      totalCount: b?.totalCount != null ? Number(b.totalCount) : null,
      numOfRows: b?.numOfRows ?? null, pageNo: b?.pageNo ?? null, items: it, gatewayError: false,
    };
  } catch { /* not json → xml */ }
  const pick = (re) => (text.match(re) || [])[1] ?? null;
  const rc = pick(/<resultCode>([^<]*)<\/resultCode>/) ?? pick(/<returnReasonCode>([^<]*)<\/returnReasonCode>/);
  const rm = pick(/<resultMsg>([^<]*)<\/resultMsg>/) ?? pick(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/);
  const tc = pick(/<totalCount>([^<]*)<\/totalCount>/);
  const nor = pick(/<numOfRows>([^<]*)<\/numOfRows>/);
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(text))) {
    const obj = {};
    const fr = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let f;
    while ((f = fr.exec(m[1]))) obj[f[1]] = String(f[2]).trim();
    items.push(obj);
  }
  return {
    format: 'xml', resultCode: rc, resultMsg: rm,
    totalCount: tc != null ? Number(tc) : null, numOfRows: nor, pageNo: null, items,
    gatewayError: /<OpenAPI_ServiceResponse>/.test(text),
  };
}

async function hiraGet(base, op, key, params = {}, keep = 3) {
  const qs = new URLSearchParams();
  qs.set('serviceKey', decodedKey(key)); // URLSearchParams 가 인코딩
  qs.set('_type', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const url = `${base}/${op}?${qs.toString()}`;
  const reqParams = { ...params, _type: 'json', serviceKey: '***REDACTED***' };
  let httpStatus = 0;
  let text = '';
  try {
    const r = await fetch(url, { method: 'GET' });
    httpStatus = r.status;
    text = await r.text();
  } catch (e) {
    return {
      service: base, op, reqParams, httpStatus: 0,
      error: 'fetch_failed', detail: String((e && e.message) || e).slice(0, 160),
    };
  }
  const clean = scrub(text, key);
  const p = parse(clean);
  const firstFields = p.items[0] ? Object.keys(p.items[0]) : [];
  // 모든 item 의 필드 합집합 (NULL/누락 파악용)
  const allFields = new Set();
  for (const it of p.items) for (const k of Object.keys(it)) allFields.add(k);
  return {
    service: base, op, reqParams,
    httpStatus,
    format: p.format,
    gatewayError: p.gatewayError,
    resultCode: p.resultCode,
    resultMsg: p.resultMsg,
    totalCount: p.totalCount,
    numOfRows: p.numOfRows,
    pageNo: p.pageNo,
    itemCount: p.items.length,
    firstItemFields: firstFields,
    unionFields: [...allFields],
    items: p.items.slice(0, keep),
    rawSnippet: clean.slice(0, 4000),
  };
}

// 응답이 "정상"인지 (게이트웨이/서비스 에러 아님)
function looksOk(r) {
  if (!r || r.httpStatus < 200 || r.httpStatus >= 300) return false;
  if (r.gatewayError) return false;
  const rc = String(r.resultCode ?? '');
  return rc === '00' || rc === '0' || rc === 'NORMAL SERVICE.' || rc === '';
}

// ── handler ──
export default async function handler(req, res) {
  // 1) production 차단
  if (process.env.VERCEL_ENV === 'production') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // 2) CRON_SECRET 인증
  const secret = process.env.CRON_SECRET || '';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const qsecret = req.query && typeof req.query.secret === 'string' ? req.query.secret : '';
  const provided = bearer || qsecret;
  if (!secret || !safeEqual(provided, secret)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const mode = q.mode || 'check';
  const key = process.env.DATA_GO_KR_KEY || '';

  // 3) check: 환경변수 존재 여부만 (HIRA 호출 없음)
  if (mode === 'check') {
    res.status(200).json({
      mode: 'check',
      vercel_env: process.env.VERCEL_ENV || null,
      data_go_kr_key_configured: Boolean(key && key.trim()),
      cron_secret_configured: Boolean(secret),
      note: 'HIRA 호출 안 함. data_go_kr_key_configured=true 여야 mode=run 가능',
    });
    return;
  }

  if (!key || !key.trim()) {
    res.status(503).json({ error: 'DATA_GO_KR_KEY_not_configured', hint: 'Preview 환경에 DATA_GO_KR_KEY 미연결' });
    return;
  }

  try {
    if (mode === 'one') {
      const baseMap = { hospInfo: HOSP_INFO_BASE, hospAsm: HOSP_ASM_BASE };
      const base = baseMap[q.base] || (q.base && q.base.startsWith('http') ? q.base : DTL_BASE_CANDIDATES[0]);
      const op = q.op || OP_HOSP_LIST;
      const params = {};
      for (const k of ['ykiho', 'clCd', 'zipCd', 'sidoCd', 'sgguCd', 'numOfRows', 'pageNo', 'yadmNm', 'dgsbjtCd']) {
        if (q[k] != null && q[k] !== '') params[k] = q[k];
      }
      const r = await hiraGet(base, op, key, params);
      res.status(200).json({ mode: 'one', result: r });
      return;
    }

    if (mode === 'run') {
      const out = { mode: 'run', startedAt: new Date().toISOString(), calls: 0, samples: {}, notes: [] };
      const rec = (name, r) => { out.samples[name] = r; out.calls += 1; };
      const GAP = 250; // ms, ≈4tps (30tps 한도 대비 충분히 느림)

      // ---- S1: 요양병원 목록 5건 ----
      const s1 = await hiraGet(HOSP_INFO_BASE, OP_HOSP_LIST, key, { clCd: '28', numOfRows: 5, pageNo: 1 });
      rec('S1_hospList_clCd28', s1);
      await sleep(GAP);

      const list = Array.isArray(s1.items) ? s1.items : [];
      // ykiho 후보: 좌표 있는 것 / 없는 것
      const ykOf = (it) => it.ykiho ?? it.YKIHO ?? null;
      const hasCoord = (it) =>
        (it.XPos != null && it.XPos !== '') || (it.YPos != null && it.YPos !== '') ||
        (it.xPos != null && it.xPos !== '') || (it.yPos != null && it.yPos !== '');
      const withCoord = list.find((it) => ykOf(it) && hasCoord(it));
      const noCoordIn5 = list.find((it) => ykOf(it) && !hasCoord(it));
      const ykA = ykOf(withCoord || list.find((it) => ykOf(it)) || {});
      if (!ykA) {
        out.notes.push('S1 에서 ykiho 를 못 얻음 → S2~S8 중단');
      }

      // ---- S2: 1곳 기본정보 (numOfRows=1 로 별도 확인) ----
      const s2 = await hiraGet(HOSP_INFO_BASE, OP_HOSP_LIST, key, { clCd: '28', numOfRows: 1, pageNo: 1 });
      rec('S2_hospList_one', s2);
      await sleep(GAP);

      // ---- 의료기관별상세정보 base 확정 (getEqpInfo2.8 로 probe) ----
      let dtlBase = null;
      if (ykA) {
        for (const cand of DTL_BASE_CANDIDATES) {
          const p = await hiraGet(cand, DTL_OPS.eqp, key, { ykiho: ykA, numOfRows: 10, pageNo: 1 });
          out.calls += 1;
          await sleep(GAP);
          if (p.httpStatus === 200 && !p.gatewayError) {
            dtlBase = cand;
            out.samples['DTL_base_probe_OK'] = { candidate: cand, resultCode: p.resultCode, itemCount: p.itemCount, firstItemFields: p.firstItemFields };
            break;
          }
          out.samples[`DTL_base_probe_fail__${cand.split('/').pop()}`] = { candidate: cand, httpStatus: p.httpStatus, gatewayError: p.gatewayError, resultCode: p.resultCode, resultMsg: p.resultMsg };
        }
        out.notes.push(dtlBase ? `의료기관별상세정보 base = ${dtlBase}` : '의료기관별상세정보 base 후보 모두 실패');
      }

      // ---- S3~S6 : 같은 ykiho 상세 ----
      if (ykA && dtlBase) {
        const s3 = await hiraGet(dtlBase, DTL_OPS.eqp, key, { ykiho: ykA, numOfRows: 10, pageNo: 1 });
        rec('S3_eqp(시설·병상)', s3); await sleep(GAP);
        const s4 = await hiraGet(dtlBase, DTL_OPS.spcSbjt, key, { ykiho: ykA, numOfRows: 20, pageNo: 1 });
        rec('S4_spcSbjt(전문의수)', s4); await sleep(GAP);
        const s5 = await hiraGet(dtlBase, DTL_OPS.dgsbjt, key, { ykiho: ykA, numOfRows: 30, pageNo: 1 });
        rec('S5_dgsbjt(진료과목)', s5); await sleep(GAP);
        const s6 = await hiraGet(dtlBase, DTL_OPS.medOft, key, { ykiho: ykA, numOfRows: 30, pageNo: 1 });
        rec('S6_medOft(의료장비)', s6); await sleep(GAP);
        // S9-③,④ 근거: 세부정보(폐업·운영상태), 기타인력
        const s9c = await hiraGet(dtlBase, DTL_OPS.dtl, key, { ykiho: ykA, numOfRows: 10, pageNo: 1 });
        rec('S9c_dtl(세부·폐업여부)', s9c); await sleep(GAP);
        const s9c2 = await hiraGet(dtlBase, DTL_OPS.etcHst, key, { ykiho: ykA, numOfRows: 10, pageNo: 1 });
        rec('S9c_etcHst(기타인력)', s9c2); await sleep(GAP);
      }

      // ---- S7 : 같은 기관 병원평가 ----
      if (ykA) {
        const s7 = await hiraGet(HOSP_ASM_BASE, OP_HOSP_ASM, key, { ykiho: ykA, numOfRows: 10, pageNo: 1 });
        rec('S7_hospAsm(적정성평가)', s7); await sleep(GAP);
        // S7-b : ykiho 없이 (전체 목록 페이징 동작 확인)
        const s7b = await hiraGet(HOSP_ASM_BASE, OP_HOSP_ASM, key, { numOfRows: 5, pageNo: 1 });
        rec('S7b_hospAsm_noYkiho', s7b); await sleep(GAP);
      }

      // ---- S8 : 좌표 있는/없는 기관 대조 ----
      out.samples['S8_coord_withCoord_fromS1'] = withCoord
        ? { ykiho: '(있음)', XPos: withCoord.XPos ?? withCoord.xPos, YPos: withCoord.YPos ?? withCoord.yPos, addr: withCoord.addr }
        : { note: 'S1 5건에 좌표 있는 기관 없음' };
      if (noCoordIn5) {
        out.samples['S8_coord_noCoord_fromS1'] = { note: 'S1 5건 중 좌표 없는 기관 발견', addr: noCoordIn5.addr };
      } else {
        // 좌표 없는 기관 탐색: numOfRows 크게, XPos 비어있는 것 찾기 (최대 2페이지)
        let found = null;
        for (let page = 1; page <= 2 && !found; page++) {
          const scan = await hiraGet(HOSP_INFO_BASE, OP_HOSP_LIST, key, { clCd: '28', numOfRows: 50, pageNo: page }, 50);
          out.calls += 1;
          await sleep(GAP);
          const items = Array.isArray(scan.items) ? scan.items : [];
          const noCoordCnt = items.filter((it) => !((it.XPos && it.XPos !== '') || (it.xPos && it.xPos !== ''))).length;
          out.samples[`S8_scan_page${page}`] = {
            itemCount: scan.itemCount, totalCount: scan.totalCount, scannedItems: items.length, noCoordCount: noCoordCnt,
          };
          found = items.find((it) => !((it.XPos && it.XPos !== '') || (it.xPos && it.xPos !== '')));
        }
        out.samples['S8_coord_noCoord_search'] = found
          ? { note: '좌표 없는 요양병원 발견', addr: found.addr, ykiho: '(있음)' }
          : { note: 'scan 100건 내 좌표 없는 요양병원 못 찾음 (전수 아님)' };
      }

      // ---- S9-① 평가정보 없음 : S1 목록의 다른 ykiho 로 평가조회, asmGrd10 없는 사례 찾기 ----
      if (list.length > 1) {
        for (let i = 1; i < Math.min(list.length, 4); i++) {
          const yk = ykOf(list[i]);
          if (!yk) continue;
          const r = await hiraGet(HOSP_ASM_BASE, OP_HOSP_ASM, key, { ykiho: yk, numOfRows: 10, pageNo: 1 });
          out.calls += 1;
          await sleep(GAP);
          const it0 = (r.items && r.items[0]) || {};
          const hasAsm10 = it0.asmGrd10 != null && it0.asmGrd10 !== '';
          out.samples[`S9a_asm_check_${i}`] = {
            resultCode: r.resultCode, totalCount: r.totalCount, itemCount: r.itemCount,
            asmGrd10: it0.asmGrd10 ?? null, fields: r.firstItemFields,
            interpretation: r.itemCount === 0 ? '평가정보 없음(빈 목록)' : hasAsm10 ? 'asmGrd10 있음' : 'asmGrd10 없음/빈값',
          };
          if (r.itemCount === 0 || !hasAsm10) { out.notes.push(`S9-① 평가없음/asmGrd10없음 사례: list[${i}]`); break; }
        }
      }

      out.finishedAt = new Date().toISOString();
      res.status(200).json(out);
      return;
    }

    res.status(400).json({ error: 'unknown_mode', allowed: ['check', 'run', 'one'] });
  } catch (e) {
    // stack/URL 없이
    res.status(500).json({ error: 'probe_failed', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
