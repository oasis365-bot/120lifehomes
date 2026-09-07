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
//   GET /api/hira-probe?mode=run           → 엔드포인트 확정 + S1~S9 시퀀스. GET 최대 30회, 순차 250ms(≈4tps)
//   GET /api/hira-probe?mode=one&base=<url|hospInfo|hospAsm|dtl>&op=..&ykiho=..&clCd=..&numOfRows=..
//                                          → 단건 디버그
// =====================================================================
import { timingSafeEqual } from 'node:crypto';

export const config = { maxDuration: 60 };

// ── 엔드포인트 후보 (2021 가이드 v1 이 폐기(code 12)라 현행판 우선 probe) ──
// 병원정보서비스: HIRA opendata(sno=713) = hospInfoService/getHospBasisList (접미사 1 없음)
const HOSP_INFO_CANDIDATES = [
  { base: 'https://apis.data.go.kr/B551182/hospInfoService', op: 'getHospBasisList' },
  { base: 'https://apis.data.go.kr/B551182/hospInfoServicev2', op: 'getHospBasisList' },
  { base: 'https://apis.data.go.kr/B551182/hospInfoService1', op: 'getHospBasisList1' },
  { base: 'https://apis.data.go.kr/B551182/hospInfoService2', op: 'getHospBasisList2' },
];
// 병원평가정보서비스: hospAsmInfoService/getHospAsmInfo (2025 가이드) + 접미사 1 변형
const HOSP_ASM_CANDIDATES = [
  { base: 'https://apis.data.go.kr/B551182/hospAsmInfoService', op: 'getHospAsmInfo' },
  { base: 'https://apis.data.go.kr/B551182/hospAsmInfoService1', op: 'getHospAsmInfo1' },
  { base: 'https://apis.data.go.kr/B551182/hospAsmInfoService2', op: 'getHospAsmInfo2' },
];
// 의료기관별상세정보: HIRA opendata(sno=708) base 확정, op 는 구/신(2.8·2.7) 병행 probe
const DTL_BASE_CANDIDATES = [
  'https://apis.data.go.kr/B551182/medicInsttDetailInfoService',
  'https://apis.data.go.kr/B551182/MadmDtlInfoService2.7',
];
const DTL_OP_SETS = {
  facility: ['getEqpInfo2.8', 'getEqpInfo2.7', 'getFacilityInfo'],                 // 시설·병상
  detail: ['getDtlInfo2.8', 'getDtlInfo2.7', 'getDetailInfo'],                     // 세부·폐업여부
  dgsbjt: ['getDgsbjtInfo2.8', 'getDgsbjtInfo2.7', 'getMdlrtSbjectInfoList'],      // 진료과목
  equip: ['getMedOftInfo2.8', 'getMedOftInfo2.7', 'getMedicalEquipmentInfoList'],  // 의료장비
  spcSbjt: ['getSpcSbjtSdrInfo2.8', 'getSpcSbjtSdrInfo2.7', 'getSpclMdlrtInfoList'], // 전문의수/특수진료
  etc: ['getEtcHstInfo2.8', 'getEtcHstInfo2.7'],                                   // 기타인력수
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
        format: 'json', resultCode: gw.returnReasonCode ?? null, resultMsg: gw.returnAuthMsg ?? gw.errMsg ?? null,
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
  const rm = pick(/<resultMsg>([^<]*)<\/resultMsg>/) ?? pick(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/) ?? pick(/<errMsg>([^<]*)<\/errMsg>/);
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
    gatewayError: /<OpenAPI_ServiceResponse>/.test(text) || /<cmmMsgHeader>/.test(text),
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
    firstItemFields: p.items[0] ? Object.keys(p.items[0]) : [],
    unionFields: [...allFields],
    items: p.items.slice(0, keep),
    rawSnippet: clean.slice(0, 3500),
  };
}

// 게이트웨이/서비스 미존재(12,99,NO_OPENAPI...) 가 아니면 "엔드포인트는 살아있음" 으로 간주
function endpointAlive(r) {
  if (!r || r.error) return false;
  if (r.httpStatus >= 500) return false;
  const rc = String(r.resultCode ?? '');
  if (r.gatewayError && (rc === '12' || rc === '99' || rc === '')) return false;
  if (/NO_OPENAPI_SERVICE/i.test(String(r.resultMsg ?? ''))) return false;
  return true;
}

// 후보 목록에서 살아있는 {base, op} 하나를 찾음
async function resolveService(cands, key, params, gap) {
  const tried = [];
  for (const c of cands) {
    const r = await hiraGet(c.base, c.op, key, params);
    tried.push({ base: c.base, op: c.op, httpStatus: r.httpStatus, resultCode: r.resultCode, resultMsg: r.resultMsg, gatewayError: r.gatewayError });
    await sleep(gap);
    if (endpointAlive(r)) return { resolved: c, probe: r, tried };
  }
  return { resolved: null, probe: null, tried };
}

// 여러 op 후보 중 살아있는 것으로 호출
async function hiraTry(base, ops, key, params, gap, keep = 3) {
  let last = null;
  for (const op of ops) {
    const r = await hiraGet(base, op, key, params, keep);
    await sleep(gap);
    if (endpointAlive(r)) return r;
    last = r;
  }
  return last;
}

// ── handler ──
export default async function handler(req, res) {
  if (process.env.VERCEL_ENV === 'production') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
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
      const baseMap = {
        hospInfo: HOSP_INFO_CANDIDATES[0].base,
        hospAsm: HOSP_ASM_CANDIDATES[0].base,
        dtl: DTL_BASE_CANDIDATES[0],
      };
      const base = baseMap[q.base] || (q.base && q.base.startsWith('http') ? q.base : HOSP_INFO_CANDIDATES[0].base);
      const op = q.op || HOSP_INFO_CANDIDATES[0].op;
      const params = {};
      for (const k of ['ykiho', 'clCd', 'zipCd', 'sidoCd', 'sgguCd', 'numOfRows', 'pageNo', 'yadmNm', 'dgsbjtCd']) {
        if (q[k] != null && q[k] !== '') params[k] = q[k];
      }
      const r = await hiraGet(base, op, key, params, 5);
      res.status(200).json({ mode: 'one', result: r });
      return;
    }

    if (mode === 'run') {
      const out = { mode: 'run', startedAt: new Date().toISOString(), calls: 0, endpoints: {}, samples: {}, notes: [] };
      const rec = (name, r) => { out.samples[name] = r; out.calls += 1; };
      const GAP = 250; // ms ≈4tps

      // ── 1) 병원정보서비스 엔드포인트 확정 ──
      const hi = await resolveService(HOSP_INFO_CANDIDATES, key, { clCd: '28', numOfRows: 3, pageNo: 1 }, GAP);
      out.calls += hi.tried.length;
      out.endpoints.hospInfo = { resolved: hi.resolved, tried: hi.tried };
      if (!hi.resolved) {
        out.notes.push('병원정보서비스 후보 모두 실패 → 중단');
        out.finishedAt = new Date().toISOString();
        res.status(200).json(out);
        return;
      }
      const HB = hi.resolved;

      // ── S1: 요양병원 목록 5건 ──
      const s1 = await hiraGet(HB.base, HB.op, key, { clCd: '28', numOfRows: 5, pageNo: 1 }, 5);
      rec('S1_hospList_clCd28', s1);
      await sleep(GAP);
      const list = Array.isArray(s1.items) ? s1.items : [];
      const ykOf = (it) => it.ykiho ?? it.YKIHO ?? it.ykIho ?? null;
      const hasCoord = (it) =>
        (it.XPos != null && it.XPos !== '') || (it.YPos != null && it.YPos !== '') ||
        (it.xPos != null && it.xPos !== '') || (it.yPos != null && it.yPos !== '');
      const withCoord = list.find((it) => ykOf(it) && hasCoord(it));
      const noCoordIn5 = list.find((it) => ykOf(it) && !hasCoord(it));
      const ykA = ykOf(withCoord || list.find((it) => ykOf(it)) || {});
      if (!ykA) out.notes.push('S1 에서 ykiho 미확보 → S2~S9 상세 중단');

      // ── S2: 1곳 기본정보 ──
      const s2 = await hiraGet(HB.base, HB.op, key, { clCd: '28', numOfRows: 1, pageNo: 1 }, 1);
      rec('S2_hospList_one', s2);
      await sleep(GAP);

      // ── 2) 의료기관별상세정보 엔드포인트 확정 (facility op-set 로 base+버전 락) ──
      let dtlBase = null;
      let dtlVer = null; // '2.8' | '2.7' | 'old'
      if (ykA) {
        outer:
        for (const cand of DTL_BASE_CANDIDATES) {
          for (const op of DTL_OP_SETS.facility) {
            const r = await hiraGet(cand, op, key, { ykiho: ykA, numOfRows: 5, pageNo: 1 }, 3);
            out.calls += 1;
            await sleep(GAP);
            if (endpointAlive(r)) {
              dtlBase = cand;
              dtlVer = op.endsWith('2.8') ? '2.8' : op.endsWith('2.7') ? '2.7' : 'old';
              out.samples['S3_facility(시설·병상)'] = r;
              break outer;
            }
          }
        }
        out.endpoints.dtl = { base: dtlBase, version: dtlVer };
        out.notes.push(dtlBase ? `의료기관별상세정보 base=${dtlBase} ver=${dtlVer}` : '의료기관별상세정보 후보 모두 실패');
      }

      // 확정된 버전으로 op 선택
      const pickOp = (set) => {
        const arr = DTL_OP_SETS[set];
        if (dtlVer === '2.8') return arr.find((o) => o.endsWith('2.8')) || arr[0];
        if (dtlVer === '2.7') return arr.find((o) => o.endsWith('2.7')) || arr[0];
        return arr[arr.length - 1];
      };

      // ── S4~S6, S9c: 같은 ykiho 상세 ──
      if (ykA && dtlBase) {
        const s4 = await hiraGet(dtlBase, pickOp('spcSbjt'), key, { ykiho: ykA, numOfRows: 20, pageNo: 1 }, 5);
        rec('S4_spcSbjt(전문의수)', s4); await sleep(GAP);
        const s5 = await hiraGet(dtlBase, pickOp('dgsbjt'), key, { ykiho: ykA, numOfRows: 30, pageNo: 1 }, 5);
        rec('S5_dgsbjt(진료과목)', s5); await sleep(GAP);
        const s6 = await hiraGet(dtlBase, pickOp('equip'), key, { ykiho: ykA, numOfRows: 30, pageNo: 1 }, 5);
        rec('S6_equip(의료장비)', s6); await sleep(GAP);
        const s9c = await hiraGet(dtlBase, pickOp('detail'), key, { ykiho: ykA, numOfRows: 5, pageNo: 1 }, 3);
        rec('S9c_detail(세부·폐업여부)', s9c); await sleep(GAP);
      }

      // ── 3) 병원평가정보 엔드포인트 확정 + S7 ──
      if (ykA) {
        const ha = await resolveService(HOSP_ASM_CANDIDATES, key, { ykiho: ykA, numOfRows: 3, pageNo: 1 }, GAP);
        out.calls += ha.tried.length;
        out.endpoints.hospAsm = { resolved: ha.resolved, tried: ha.tried };
        if (ha.resolved) {
          const HA = ha.resolved;
          const s7 = await hiraGet(HA.base, HA.op, key, { ykiho: ykA, numOfRows: 10, pageNo: 1 }, 3);
          rec('S7_hospAsm(적정성평가)', s7); await sleep(GAP);
          const s7b = await hiraGet(HA.base, HA.op, key, { numOfRows: 5, pageNo: 1 }, 3);
          rec('S7b_hospAsm_noYkiho', s7b); await sleep(GAP);

          // ── S9a: 평가정보 없는 요양병원 사례 ──
          for (let i = 1; i < Math.min(list.length, 4); i++) {
            const yk = ykOf(list[i]);
            if (!yk) continue;
            const r = await hiraGet(HA.base, HA.op, key, { ykiho: yk, numOfRows: 10, pageNo: 1 }, 3);
            out.calls += 1;
            await sleep(GAP);
            const it0 = (r.items && r.items[0]) || {};
            const hasAsm10 = it0.asmGrd10 != null && it0.asmGrd10 !== '';
            out.samples[`S9a_asm_check_${i}`] = {
              resultCode: r.resultCode, totalCount: r.totalCount, itemCount: r.itemCount,
              asmGrd10: it0.asmGrd10 ?? null, fields: r.firstItemFields,
              interpretation: r.itemCount === 0 ? '평가정보 없음(빈 목록)' : hasAsm10 ? 'asmGrd10 있음' : 'asmGrd10 없음/빈값',
            };
            if (r.itemCount === 0 || !hasAsm10) { out.notes.push(`S9-① 평가없음/asmGrd10없음: list[${i}]`); break; }
          }
        } else {
          out.notes.push('병원평가정보서비스 후보 모두 실패');
        }
      }

      // ── S8: 좌표 있는/없는 기관 대조 ──
      out.samples['S8_coord_withCoord_fromS1'] = withCoord
        ? { XPos: withCoord.XPos ?? withCoord.xPos ?? null, YPos: withCoord.YPos ?? withCoord.yPos ?? null, addr: withCoord.addr ?? null }
        : { note: 'S1 5건에 좌표 있는 기관 없음' };
      if (noCoordIn5) {
        out.samples['S8_coord_noCoord_fromS1'] = { note: 'S1 5건 중 좌표 없는 기관', addr: noCoordIn5.addr ?? null };
      } else if (ykA) {
        let found = null;
        for (let page = 1; page <= 2 && !found; page++) {
          const scan = await hiraGet(HB.base, HB.op, key, { clCd: '28', numOfRows: 50, pageNo: page }, 50);
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
          ? { note: '좌표 없는 요양병원 발견', addr: found.addr ?? null }
          : { note: 'scan 100건 내 좌표 없는 요양병원 못 찾음 (전수 아님)' };
      }

      out.finishedAt = new Date().toISOString();
      res.status(200).json(out);
      return;
    }

    res.status(400).json({ error: 'unknown_mode', allowed: ['check', 'run', 'one'] });
  } catch (e) {
    res.status(500).json({ error: 'probe_failed', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
