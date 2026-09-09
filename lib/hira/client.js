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

// 관측용 실패 종류 — allowlist. 이 밖의 값은 절대 밖으로 내보내지 않는다(엔드포인트/호스트/원문 비노출).
export const FAILURE_KINDS = Object.freeze([
  'timeout', // fetch/abort 타임아웃, undici headers/body/connect timeout
  'network', // ECONNRESET/REFUSED, 호스트 도달 불가 등
  'dns', // ENOTFOUND / EAI_AGAIN
  'tls', // 인증서/SSL 협상 실패
  'http_429', // 응답 429
  'http_5xx', // 응답 5xx
  'result_code_12', // data.go.kr 게이트웨이 code 12 (일시)
  'deadline', // wall-clock 예산 초과로 중단
  'unknown', // 분류 불가 — 원인 문자열은 남기지 않는다
]);
const KIND_SET = new Set(FAILURE_KINDS);
export const coerceFailureKind = (k) => (KIND_SET.has(k) ? k : 'unknown');

/** attemptSummary 를 allowlist 키 + 양의 정수로만 정제 (원문/비밀 유입 차단) */
export function sanitizeAttemptSummary(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of FAILURE_KINDS) {
    const n = s[k];
    if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

export const ELAPSED_BUCKETS = Object.freeze(['lt_1s', '1s_5s', '5s_15s', '15s_30s', '30s_45s', 'gte_45s']);
/** 정확한 경과 ms 대신 안전한 구간값만 (타이밍 사이드채널·핑거프린팅 축소) */
export function elapsedBucket(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return 'lt_1s';
  if (ms < 5000) return '1s_5s';
  if (ms < 15000) return '5s_15s';
  if (ms < 30000) return '15s_30s';
  if (ms < 45000) return '30s_45s';
  return 'gte_45s';
}

export class HiraError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'HiraError';
    this.op = info.op ?? null;
    this.reason = info.reason ?? 'unknown'; // 'timeout' | 'network' | 'http' | 'gateway' | 'result' | 'aborted_all' | 'deadline'
    // 관측용(allowlist). 원인 코드·메시지 원문은 담지 않는다.
    this.failureKind = info.failureKind == null ? null : coerceFailureKind(info.failureKind);
    this.attemptSummary = sanitizeAttemptSummary(info.attemptSummary);
    this.elapsedBucket = ELAPSED_BUCKETS.includes(info.elapsedBucket) ? info.elapsedBucket : null;
    this.attempts = info.attempts ?? 0;
    this.lastStatus = info.lastStatus ?? null;
    this.lastResultCode = info.lastResultCode ?? null;
  }
}

// ── fetch 실패 원인 분류 (allowlist) ──────────────────────────────────
//  Node(undici) 는 `TypeError: fetch failed` 로 감싸고 실제 원인을 e.cause 에 둔다.
//  e.cause.code / e.code / name 만 보고 allowlist 로 매핑한다. 코드·메시지 원문은
//  어디에도 저장·반환하지 않는다.
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);
const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EHOSTUNREACH', 'EHOSTDOWN',
  'ENETUNREACH', 'ENETDOWN', 'ENETRESET', 'EPIPE', 'EADDRNOTAVAIL', 'UND_ERR_SOCKET',
]);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT',
]);

export function classifyFetchFailure(e, aborted) {
  if (aborted) return 'timeout'; // 우리가 건 AbortController 타임아웃
  const tokens = [];
  const push = (v) => { if (typeof v === 'string' && v) tokens.push(v); };
  if (e) {
    push(e.code); push(e.name);
    if (e.cause) { push(e.cause.code); push(e.cause.name); }
  }
  for (const t of tokens) {
    if (t === 'AbortError' || t === 'TimeoutError') return 'timeout';
    if (DNS_CODES.has(t)) return 'dns';
    if (TLS_CODES.has(t) || t.startsWith('ERR_SSL_') || t.includes('CERT')) return 'tls';
    if (TIMEOUT_CODES.has(t)) return 'timeout';
    if (NETWORK_CODES.has(t)) return 'network';
  }
  return 'unknown';
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

const defaultSleep = (ms) => new Promise((r) => {
  const t = setTimeout(r, ms);
  if (t && typeof t.unref === 'function') t.unref(); // 이벤트 루프를 잡아 두지 않음
});

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

  // 전체 요청(수집) wall-clock 데드라인. 이 시각 이후로는 새 fetch·backoff 를 시작하지 않는다.
  const deadlineMs = Number.isFinite(opt.deadlineMs) ? opt.deadlineMs : null;
  const DEADLINE_PAD_MS = 500; // 데드라인 직전 이 만큼은 남겨 둔다 (응답 반환 여유)
  const timeLeft = () => (deadlineMs == null ? Infinity : deadlineMs - now());

  let lastReqAt = 0;
  let started = false;

  async function pace() {
    if (started) {
      let wait = lastReqAt + minIntervalMs - now();
      const budget = timeLeft();
      if (budget !== Infinity) wait = Math.min(wait, Math.max(0, budget - DEADLINE_PAD_MS));
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
    // 남은 예산보다 긴 타임아웃을 잡지 않는다.
    const budget = timeLeft();
    const effTimeout = budget === Infinity
      ? timeoutMs
      : Math.max(1000, Math.min(timeoutMs, budget - DEADLINE_PAD_MS));
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* noop */ } }, effTimeout);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(url, { method: 'GET', signal: ac.signal });
      const text = scrub(await res.text());
      return { status: res.status, text };
    } catch (e) {
      const aborted = ac.signal.aborted || /abort/i.test(String(e && e.name));
      // 원인 코드·메시지 원문은 버리고 allowlist 분류값만 넘긴다.
      return {
        status: 0, text: '', networkError: true,
        failureKind: classifyFetchFailure(e, aborted),
      };
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
    const startedAt = now();
    let lastStatus = null;
    let lastResultCode = null;
    let lastReason = 'unknown';
    let lastKind = 'unknown';
    let deadlineHit = false;
    // 시도별 실패 종류 카운트 (allowlist 키만). 원문·URL·키는 담기지 않는다.
    const kindTally = Object.create(null);
    const bump = (k) => { const kk = coerceFailureKind(k); kindTally[kk] = (kindTally[kk] || 0) + 1; lastKind = kk; };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 데드라인 임박 → 새 호출 시작 안 함
      if (timeLeft() <= DEADLINE_PAD_MS + 500) { deadlineHit = true; break; }
      await pace();
      const r = await once(url, op);
      lastStatus = r.status;

      // 네트워크 / 타임아웃 / DNS / TLS
      if (r.networkError) {
        const k = coerceFailureKind(r.failureKind);
        bump(k);
        lastReason = k === 'timeout' ? 'timeout' : 'network';
        if (attempt < maxRetries && !tryBackoff(attempt)) { deadlineHit = true; break; }
        if (attempt < maxRetries) { await doBackoff(attempt); continue; }
        break;
      }

      // HTTP 429 / 5xx → 재시도
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        lastReason = 'http';
        bump(r.status === 429 ? 'http_429' : 'http_5xx');
        if (attempt < maxRetries && !tryBackoff(attempt)) { deadlineHit = true; break; }
        if (attempt < maxRetries) { await doBackoff(attempt); continue; }
        break;
      }

      const parsed = parseHiraResponse(r.text, scrub);
      lastResultCode = parsed.resultCode;

      // 일시적 게이트웨이 오류 (code 12 만) → 재시도 (자동 fallback 은 안 함)
      if (isTransientResult(parsed)) {
        lastReason = 'gateway';
        bump('result_code_12');
        if (attempt < maxRetries && !tryBackoff(attempt)) { deadlineHit = true; break; }
        if (attempt < maxRetries) { await doBackoff(attempt); continue; }
        break;
      }

      // 정상 or 비일시적 서비스 오류(잘못된 파라미터 등) → 그대로 반환
      return { ...parsed, httpStatus: r.status, attempts: attempt };
    }

    throw new HiraError(`HIRA ${op} 재시도 ${maxRetries}회 실패`, {
      op,
      reason: deadlineHit ? 'deadline' : (lastReason === 'unknown' ? 'aborted_all' : lastReason),
      failureKind: deadlineHit ? 'deadline' : lastKind,
      attemptSummary: { ...kindTally },
      elapsedBucket: elapsedBucket(now() - startedAt),
      attempts: maxRetries,
      lastStatus,
      lastResultCode,
    });
  }

  const backoffMs = (attempt) => 250 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300);
  // 남은 예산보다 긴 backoff 는 시작하지 않는다.
  const tryBackoff = (attempt) => timeLeft() > backoffMs(attempt) + DEADLINE_PAD_MS + 500;
  async function doBackoff(attempt) {
    await sleep(Math.min(backoffMs(attempt), Math.max(0, timeLeft() - DEADLINE_PAD_MS)));
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
