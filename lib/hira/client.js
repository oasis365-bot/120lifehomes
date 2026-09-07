// =====================================================================
// HIRA 공통 API 클라이언트 — GET only · 재시도 · 타임아웃 · 키 비노출
// =====================================================================
//  · DATA_GO_KR_KEY 는 서버 환경변수에서만 읽는다 (createHiraClient 에 명시 주입도 허용 — 테스트용).
//  · 요청 URL·serviceKey 를 로그로 남기지 않는다 (이 파일은 console 을 쓰지 않는다).
//  · 요청 간 최소 250ms 간격 (내부에서 강제).
//  · 최대 3회 재시도: timeout / 네트워크 오류 / HTTP 429 / HTTP 5xx / 게이트웨이 code 12
//    (code 1·99 는 실측 근거 없어 재시도 안 함 — parse.js isTransientResult 참고).
//      지수 백오프 + 소량 jitter.  3회 실패 시 구조화된 HiraError 를 throw.
//  · 폐기된 구형 endpoint 로 자동 fallback 하지 않는다 (1B-1 실측 현행 endpoint 고정).
//  · XML / 게이트웨이 오류 XML 모두 parse.js 가 안전 처리.
//
//  현행 실측 endpoint (2026-09-07, 1B-1):
//    병원기본정보  https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList
//    의료기관상세  https://apis.data.go.kr/B551182/MadmDtlInfoService2.8/get{X}Info2.8
//    병원평가정보  https://apis.data.go.kr/B551182/hospAsmInfoService1/getHospAsmInfo1
// =====================================================================
import { parseHiraResponse, isTransientResult } from './parse.js';

export const HIRA_ENDPOINTS = Object.freeze({
  hospBasis: {
    base: 'https://apis.data.go.kr/B551182/hospInfoServicev2',
    op: 'getHospBasisList',
    dataset: 'hira_hospital_info',
  },
  hospAsm: {
    base: 'https://apis.data.go.kr/B551182/hospAsmInfoService1',
    op: 'getHospAsmInfo1',
    dataset: 'hira_hospital_eval',
  },
  detail: {
    base: 'https://apis.data.go.kr/B551182/MadmDtlInfoService2.8',
    dataset: 'hira_hospital_detail',
    ops: Object.freeze({
      facility: 'getEqpInfo2.8', // 시설·병상
      detail: 'getDtlInfo2.8', // 세부(운영정보)
      departments: 'getDgsbjtInfo2.8', // 진료과목
      equipment: 'getMedOftInfo2.8', // 의료장비
      specialists: 'getSpcSbjtSdrInfo2.8', // 전문과목별 전문의 수
      otherStaff: 'getEtcHstInfo2.8', // 기타인력수
    }),
  },
});

export class HiraError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'HiraError';
    this.op = info.op ?? null;
    this.reason = info.reason ?? 'unknown'; // 'timeout' | 'network' | 'http' | 'gateway' | 'result' | 'aborted_all'
    this.attempts = info.attempts ?? 0;
    this.lastStatus = info.lastStatus ?? null;
    this.lastResultCode = info.lastResultCode ?? null;
  }
}

function decodedKey(k) {
  try {
    return k.includes('%') ? decodeURIComponent(k) : k;
  } catch {
    return k;
  }
}

// serviceKey 원문/디코딩/각 인코딩 변형을 응답 텍스트에서 제거 (본문엔 없지만 방어적)
function makeScrubber(key) {
  const variants = [];
  const dk = decodedKey(key);
  for (const v of [key, dk, encodeURIComponent(key), encodeURIComponent(dk)]) {
    if (v && v.length > 8) variants.push(v);
  }
  return (text) => {
    let out = String(text ?? '');
    for (const v of variants) out = out.split(v).join('***REDACTED***');
    return out;
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {Object} [opt]
 * @param {string} [opt.key]           명시 주입 (없으면 process.env.DATA_GO_KR_KEY)
 * @param {typeof fetch} [opt.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [opt.sleepImpl]
 * @param {() => number} [opt.now]
 * @param {number} [opt.timeoutMs=7000]
 * @param {number} [opt.minIntervalMs=250]
 * @param {number} [opt.maxRetries=3]
 * @param {(ms:number)=>void} [opt.onWait]  (테스트 관찰용)
 */
export function createHiraClient(opt = {}) {
  const key = opt.key ?? process.env.DATA_GO_KR_KEY ?? '';
  if (!key || !String(key).trim()) {
    throw new HiraError('DATA_GO_KR_KEY 미설정', { reason: 'config' });
  }
  const fetchImpl = opt.fetchImpl ?? globalThis.fetch;
  const sleep = opt.sleepImpl ?? defaultSleep;
  const now = opt.now ?? (() => Date.now());
  const timeoutMs = opt.timeoutMs ?? 7000;
  const minIntervalMs = opt.minIntervalMs ?? 250;
  const maxRetries = Math.max(1, opt.maxRetries ?? 3);
  const scrub = makeScrubber(String(key));

  let lastReqAt = 0;
  let started = false;

  async function pace() {
    if (started) {
      const wait = lastReqAt + minIntervalMs - now();
      if (wait > 0) {
        if (opt.onWait) opt.onWait(wait);
        await sleep(wait);
      }
    }
    started = true;
    lastReqAt = now();
  }

  function buildUrl(base, op, params) {
    const qs = new URLSearchParams();
    qs.set('serviceKey', decodedKey(String(key))); // URLSearchParams 가 인코딩
    qs.set('_type', 'json');
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    return `${base}/${op}?${qs.toString()}`;
  }

  async function once(url, op) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'GET', signal: ac.signal });
      const text = scrub(await res.text());
      return { status: res.status, text };
    } catch (e) {
      const aborted = ac.signal.aborted || /abort/i.test(String(e && e.name));
      return { status: 0, text: '', networkError: true, timeout: aborted };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 한 오퍼레이션을 재시도 포함 호출.
   * @returns {Promise<import('./parse.js').HiraParsed & { httpStatus:number, attempts:number }>}
   */
  async function request(base, op, params) {
    const url = buildUrl(base, op, params);
    let lastStatus = null;
    let lastResultCode = null;
    let lastReason = 'unknown';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await pace();
      const r = await once(url, op);
      lastStatus = r.status;

      // 네트워크 / 타임아웃
      if (r.networkError) {
        lastReason = r.timeout ? 'timeout' : 'network';
        if (attempt < maxRetries) {
          await backoff(attempt);
          continue;
        }
        break;
      }

      // HTTP 429 / 5xx → 재시도
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        lastReason = 'http';
        if (attempt < maxRetries) {
          await backoff(attempt);
          continue;
        }
        break;
      }

      const parsed = parseHiraResponse(r.text, scrub);
      lastResultCode = parsed.resultCode;

      // 일시적 게이트웨이 오류 (code 12 만) → 재시도 (자동 fallback 은 안 함)
      if (isTransientResult(parsed)) {
        lastReason = 'gateway';
        if (attempt < maxRetries) {
          await backoff(attempt);
          continue;
        }
        break;
      }

      // 정상 or 비일시적 서비스 오류(잘못된 파라미터 등) → 그대로 반환
      return { ...parsed, httpStatus: r.status, attempts: attempt };
    }

    throw new HiraError(`HIRA ${op} 재시도 ${maxRetries}회 실패`, {
      op,
      reason: lastReason === 'unknown' ? 'aborted_all' : lastReason,
      attempts: maxRetries,
      lastStatus,
      lastResultCode,
    });
  }

  async function backoff(attempt) {
    // 250 * 2^(attempt-1)  + jitter(0..300)
    const base = 250 * Math.pow(2, attempt - 1);
    await sleep(base + Math.floor(Math.random() * 300));
  }

  // ── 서비스별 메서드 ──
  const D = HIRA_ENDPOINTS.detail;
  return {
    endpoints: HIRA_ENDPOINTS,
    _scrub: scrub, // 테스트/상위 스크럽 재사용

    /** 병원 기본목록 (clCd=28 요양병원) */
    listHospitals({ clCd = '28', pageNo = 1, numOfRows = 100, sidoCd, sgguCd } = {}) {
      return request(HIRA_ENDPOINTS.hospBasis.base, HIRA_ENDPOINTS.hospBasis.op, {
        clCd,
        pageNo,
        numOfRows,
        sidoCd,
        sgguCd,
      });
    },

    /** 병원평가 (적정성평가). ykiho 지정 권장. */
    getEvaluation({ ykiho, pageNo = 1, numOfRows = 10 } = {}) {
      return request(HIRA_ENDPOINTS.hospAsm.base, HIRA_ENDPOINTS.hospAsm.op, {
        ykiho,
        pageNo,
        numOfRows,
      });
    },

    /** 시설·병상 */
    getFacilityInfo({ ykiho, pageNo = 1, numOfRows = 10 } = {}) {
      return request(D.base, D.ops.facility, { ykiho, pageNo, numOfRows });
    },
    /** 세부(운영정보) */
    getDetailInfo({ ykiho, pageNo = 1, numOfRows = 10 } = {}) {
      return request(D.base, D.ops.detail, { ykiho, pageNo, numOfRows });
    },
    /** 진료과목 */
    getDepartments({ ykiho, pageNo = 1, numOfRows = 50 } = {}) {
      return request(D.base, D.ops.departments, { ykiho, pageNo, numOfRows });
    },
    /** 의료장비 */
    getEquipment({ ykiho, pageNo = 1, numOfRows = 50 } = {}) {
      return request(D.base, D.ops.equipment, { ykiho, pageNo, numOfRows });
    },
    /** 전문과목별 전문의 수 */
    getSpecialists({ ykiho, pageNo = 1, numOfRows = 50 } = {}) {
      return request(D.base, D.ops.specialists, { ykiho, pageNo, numOfRows });
    },
    /** 기타인력수 */
    getOtherStaff({ ykiho, pageNo = 1, numOfRows = 20 } = {}) {
      return request(D.base, D.ops.otherStaff, { ykiho, pageNo, numOfRows });
    },

    /** (저수준) 임의 오퍼레이션 */
    _request: request,
  };
}
