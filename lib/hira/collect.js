// =====================================================================
// 요양병원 수집 오케스트레이터 (dry-run 전용, 1B-2)
// =====================================================================
//  흐름:
//    1) listHospitals(clCd=28) 페이지 순회 → ykiho 목록 (maxInstitutions 로 제한)
//    2) ykiho 기준 중복 제거
//    3) 기관별 상세 6종 + 평가 1종 호출 (부분 실패 허용)
//    4) adapter 로 정규화
//    5) 통계·경고 집계. 실패 기관은 재처리 가능하도록 목록 기록.
//
//  ⚠️ 이 모듈은 DB 를 import 하지 않는다. write 경로 없음 (dry-run).
//  ⚠️ 1,280곳 전체 수집 금지 — maxInstitutions 기본 20, 상한 20 (호출부에서도 캡).
// =====================================================================
import {
  normalizeHospitalRecord,
  normalizeEvaluationRecord,
  HOSPITAL_CL_CD,
} from './adapter.js';
import { isNormalResult } from './parse.js';
import { HiraError } from './client.js';

export const MAX_INSTITUTIONS_HARD_CAP = 20;

// "resultCode 정상 + (범위 내) 페이지 0건" 이라는 data.go.kr 실측 간헐 장애 대비 bounded retry.
const LIST_EMPTY_RETRY_MAX = 3;   // 같은 pageNo 최대 시도 횟수 (원 요청 1 + 재시도 2)
const LIST_RETRY_BASE_MS = 400;   // 지수 백오프 기준
const LIST_RETRY_MAX_MS = 4000;
const LIST_RETRY_JITTER_MS = 250;

const DETAIL_STEPS = [
  ['facility', (c, ykiho) => c.getFacilityInfo({ ykiho })],
  ['detail', (c, ykiho) => c.getDetailInfo({ ykiho })],
  ['departments', (c, ykiho) => c.getDepartments({ ykiho })],
  ['equipment', (c, ykiho) => c.getEquipment({ ykiho })],
  ['specialists', (c, ykiho) => c.getSpecialists({ ykiho })],
  ['otherStaff', (c, ykiho) => c.getOtherStaff({ ykiho })],
];

const firstItem = (parsed) => (parsed && parsed.items && parsed.items[0]) || null;
const allItems = (parsed) => (parsed && Array.isArray(parsed.items) ? parsed.items : []);

/** ykiho 를 로그·오류에 그대로 남기지 않기 위한 마스킹 */
export function maskYkiho(ykiho) {
  const s = String(ykiho ?? '');
  if (s.length <= 8) return `***(${s.length})`;
  return `${s.slice(0, 6)}…(${s.length})`;
}

/**
 * @param {ReturnType<import('./client.js').createHiraClient>} client
 * @param {Object} [opt]
 * @param {number} [opt.maxInstitutions=20]  (상한 20)
 * @param {number} [opt.pageSize=100]
 * @param {(ev:object)=>void} [opt.onProgress]
 * @returns {Promise<{ stats:object, warnings:string[], failures:object[], samples:object[], meta:object }>}
 */
export async function collectHospitals(client, opt = {}) {
  const maxInstitutions = Math.min(
    Math.max(1, opt.maxInstitutions ?? 20),
    MAX_INSTITUTIONS_HARD_CAP
  );
  const pageSize = Math.min(Math.max(1, opt.pageSize ?? 100), 100);
  const onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : () => {};
  const sleep = typeof opt.sleepImpl === 'function' ? opt.sleepImpl : (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = typeof opt.randomImpl === 'function' ? opt.randomImpl : Math.random;
  const now = typeof opt.now === 'function' ? opt.now : Date.now;
  // listOnly: getHospBasisList 목록만 호출해 기본 정규화까지. 상세 6종·평가 API 미호출.
  //  (readiness dry-run — HIRA 호출을 목록 범위로 제한해 안정적으로 3건 확보 여부만 확인)
  const listOnly = opt.listOnly === true;

  // 전체 수집 wall-clock 데드라인. 남은 시간보다 긴 fetch/backoff 를 시작하지 않고,
  //  데드라인 전에 명확한 오류(deadline_exceeded)를 던져 플랫폼 하드 타임아웃을 피한다.
  const deadlineMs = Number.isFinite(opt.deadlineMs) ? opt.deadlineMs : null;
  const timeLeft = () => (deadlineMs == null ? Infinity : deadlineMs - now());
  const EST_HIRA_CALL_MS = 8000; // 최악 1콜(타임아웃+여유) 추정 — 이보다 적게 남으면 새 콜 시작 안 함

  const meta = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dryRun: true,
    mode: listOnly ? 'list_only' : 'full',
    clCd: HOSPITAL_CL_CD,
    maxInstitutions,
    endpointsUsed: {
      list: `${client.endpoints.hospBasis.base}/${client.endpoints.hospBasis.op}`,
      detailBase: client.endpoints.detail.base,
      detailOps: client.endpoints.detail.ops,
      eval: `${client.endpoints.hospAsm.base}/${client.endpoints.hospAsm.op}`,
    },
    listTotalCount: null,
  };

  const stats = {
    listed: 0,
    deduped: 0,
    normalized: 0,
    withCoord: 0,
    coordWarnings: 0,
    evalFound: 0,
    evalMissing: 0,
    detailComplete: 0,
    detailPartial: 0,
    apiCalls: 0,
    listPages: 0,
    listRetries: 0,
  };
  const warnings = [];
  const failures = []; // { ykiho: masked, step, reason, detail }
  const samples = [];
  const normalizedAll = [];

  // ── 1) 목록 수집 ──
  const seen = new Set();
  const ykihos = [];

  // "의미적 빈 페이지" 판별 (정상 종료와 구분):
  //  · pageNo=1 : clCd=28 은 실측상 항상 항목이 있어야 함 → items=0 이면 transient
  //               (totalCount 가 양수든 0/누락이든 무관 — 이번 실측 근거)
  //  · pageNo>1 : 직전에 본 양수 totalCount 로 계산한 마지막 페이지 이내면 transient
  //  · 그 외(마지막 페이지 이후 / totalCount 미상)의 items=0 은 정상 종료
  const isSemanticEmptyPage = (pn, parsed) => {
    if (allItems(parsed).length > 0) return false;
    if (pn === 1) return true;
    const known = Number(meta.listTotalCount);
    const tc = Number(parsed && parsed.totalCount);
    const total = Number.isFinite(known) && known > 0 ? known : tc;
    if (Number.isFinite(total) && total > 0) return pn <= Math.ceil(total / pageSize);
    return false;
  };

  // 재시도 계층은 하나로 단일화한다:
  //   · timeout / network / HTTP 5xx·429 / 게이트웨이 code 12  →  client.js 내부에서만 재시도
  //   · "정상 resultCode + (범위 내) 0건"                       →  client 는 성공으로 보므로
  //                                                                collect 가 최대 3회 재시도
  //   collect 는 client 가 throw 한 오류를 다시 재시도하지 않는다(3×3 중첩 금지).
  //   모든 재시도·backoff 는 wall-clock 데드라인 안에서만 한다.
  const fetchListPage = async (pn) => {
    let parsed = null;
    for (let attempt = 1; attempt <= LIST_EMPTY_RETRY_MAX; attempt += 1) {
      if (attempt > 1) {
        const backoff =
          Math.min(LIST_RETRY_MAX_MS, LIST_RETRY_BASE_MS * 2 ** (attempt - 2)) +
          Math.floor(rand() * LIST_RETRY_JITTER_MS);
        // 남은 예산보다 긴 backoff + 다음 호출을 시작하지 않는다.
        if (timeLeft() < backoff + EST_HIRA_CALL_MS) return { kind: 'deadline', parsed, attempts: attempt - 1 };
        stats.listRetries += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(backoff);
      } else if (timeLeft() < EST_HIRA_CALL_MS) {
        return { kind: 'deadline', parsed, attempts: 0 };
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        parsed = await client.listHospitals({ clCd: HOSPITAL_CL_CD, pageNo: pn, numOfRows: pageSize });
      } catch (e) {
        return { kind: 'error', error: e, attempts: attempt };
      }
      stats.apiCalls += 1;
      stats.listPages += 1;
      if (!isNormalResult(parsed)) return { kind: 'abnormal', parsed, attempts: attempt };
      if (pn === 1) meta.listTotalCount = parsed.totalCount;
      if (!isSemanticEmptyPage(pn, parsed)) return { kind: 'ok', parsed, attempts: attempt };
      // 정상 resultCode 인데 (범위 내) 페이지가 비었다 → 재시도
    }
    return { kind: 'transient_empty_exhausted', parsed, attempts: LIST_EMPTY_RETRY_MAX };
  };

  let pageNo = 1;
  while (ykihos.length < maxInstitutions && pageNo <= 20) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetchListPage(pageNo);

    if (r.kind === 'deadline') {
      warnings.push(`목록 p${pageNo}: 시간 예산 초과로 중단`);
      if (ykihos.length === 0) {
        throw new HiraError('수집 시간 예산 초과', {
          op: 'getHospBasisList', reason: 'deadline_exceeded', attempts: r.attempts, lastResultCode: null,
        });
      }
      break;
    }
    if (r.kind === 'error') {
      const clientAttempts = r.error && Number.isFinite(r.error.attempts) ? r.error.attempts : null;
      warnings.push(`목록 p${pageNo} 조회 실패 — ${briefErr(r.error)}`);
      if (ykihos.length === 0) {
        // 첫 페이지부터 목록을 못 받음 → 보존할 부분 결과 없음. 빈 배열로 "성공" 반환 안 함.
        const deadline = r.error && r.error.reason === 'deadline';
        throw new HiraError(deadline ? '수집 시간 예산 초과' : 'HIRA 목록 조회 실패', {
          op: 'getHospBasisList',
          reason: deadline ? 'deadline_exceeded' : 'list_fetch_failed',
          attempts: clientAttempts ?? r.attempts, // client 내부 재시도 횟수
          lastResultCode: (r.error && r.error.lastResultCode) || null,
        });
      }
      break; // 이미 일부 페이지를 수집했으면 그것만 반환 (나머지는 배치 재처리)
    }
    if (r.kind === 'abnormal') {
      warnings.push(`목록 p${pageNo} 비정상 resultCode`);
      if (ykihos.length === 0) {
        throw new HiraError('HIRA 목록 비정상 응답', {
          op: 'getHospBasisList',
          reason: 'list_abnormal_result',
          attempts: r.attempts,
          lastResultCode: (r.parsed && r.parsed.resultCode) || null,
        });
      }
      break;
    }
    if (r.kind === 'transient_empty_exhausted') {
      // 빈 목록을 "성공 0건" 으로 반환하지 않는다 — 명확한 오류로 중단.
      warnings.push(`목록 p${pageNo}: 정상 resultCode 인데 ${r.attempts}회 모두 0건 — transient_empty_page_exhausted`);
      throw new HiraError('HIRA 목록 페이지가 반복적으로 빈 응답', {
        op: 'getHospBasisList',
        reason: 'transient_empty_page_exhausted',
        attempts: r.attempts,
        lastResultCode: (r.parsed && r.parsed.resultCode) || null,
      });
    }

    const items = allItems(r.parsed);
    if (!items.length) break; // 정상 종료 (마지막 페이지 이후)
    for (const it of items) {
      stats.listed += 1;
      const yk = it.ykiho ?? it.YKIHO;
      if (!yk) {
        warnings.push('목록 항목에 ykiho 없음 — 스킵');
        continue;
      }
      if (seen.has(yk)) continue; // 2) 중복 제거
      seen.add(yk);
      ykihos.push({ ykiho: yk, basis: it });
      if (ykihos.length >= maxInstitutions) break;
    }
    if (items.length < pageSize) break;
    pageNo += 1;
  }
  stats.deduped = ykihos.length;
  if (ykihos.length === 0) {
    warnings.push('HIRA 목록에서 유효 ykiho 0건');
  }
  onProgress({ phase: 'listed', count: ykihos.length });

  // ── 3~4) 기관별 상세 + 평가 + 정규화 ──
  //  listOnly 면 basis 만으로 기본 정규화 (상세·평가 API 미호출).
  let deadlineStop = false;
  for (const { ykiho, basis } of ykihos) {
    if (listOnly) {
      let norm;
      try {
        norm = normalizeHospitalRecord({ basis });
      } catch (e) {
        failures.push({ ykiho: maskYkiho(ykiho), step: 'normalize', reason: 'normalize', detail: briefErr(e) });
        continue;
      }
      // 필수필드 확인 (기본시설 행에 반드시 필요한 값)
      const missing = ['id', 'external_id', 'name'].filter((k) => norm[k] == null || norm[k] === '');
      if (missing.length) {
        failures.push({ ykiho: maskYkiho(ykiho), step: 'required_fields', reason: 'missing', detail: missing.join(',') });
        continue;
      }
      stats.normalized += 1;
      if (norm.lat != null && norm.lng != null) stats.withCoord += 1;
      if (Array.isArray(norm._warnings) && norm._warnings.length) {
        for (const w of norm._warnings) warnings.push(`${maskYkiho(ykiho)}: ${w}`);
      }
      normalizedAll.push({ hospital: norm, evaluation: null, raw: { basis } });
      onProgress({ phase: 'normalized', done: stats.normalized, total: ykihos.length });
      continue;
    }
    // 한 기관은 상세 6 + 평가 1 = 7콜. 남은 예산이 그보다 적으면 시작하지 않는다.
    if (timeLeft() < EST_HIRA_CALL_MS * 2) { deadlineStop = true; break; }
    const bundle = { basis };
    let stepFailures = 0;

    for (const [name, fn] of DETAIL_STEPS) {
      if (timeLeft() < EST_HIRA_CALL_MS) { deadlineStop = true; break; }
      try {
        const parsed = await fn(client, ykiho);
        stats.apiCalls += 1;
        if (!isNormalResult(parsed)) {
          stepFailures += 1;
          failures.push({
            ykiho: maskYkiho(ykiho),
            step: name,
            reason: 'result',
            detail: `resultCode=${parsed.resultCode}`,
          });
          continue;
        }
        // facility/detail = 단수, 나머지 = 배열
        bundle[name] = name === 'facility' || name === 'detail' ? firstItem(parsed) : allItems(parsed);
      } catch (e) {
        stepFailures += 1;
        failures.push({ ykiho: maskYkiho(ykiho), step: name, reason: e?.reason ?? 'error', detail: briefErr(e) });
      }
    }
    if (deadlineStop) break; // 상세가 시간 내에 안 끝남 → 이 기관 정규화 안 함, 루프 종료

    // 평가
    let evalItem = null;
    if (timeLeft() >= EST_HIRA_CALL_MS) {
      try {
        const parsed = await client.getEvaluation({ ykiho });
        stats.apiCalls += 1;
        if (isNormalResult(parsed)) evalItem = firstItem(parsed);
      } catch (e) {
        failures.push({ ykiho: maskYkiho(ykiho), step: 'evaluation', reason: e?.reason ?? 'error', detail: briefErr(e) });
      }
    }

    // 정규화 (basis 만 있어도 시도)
    let norm;
    try {
      norm = normalizeHospitalRecord(bundle);
    } catch (e) {
      failures.push({ ykiho: maskYkiho(ykiho), step: 'normalize', reason: 'normalize', detail: briefErr(e) });
      continue;
    }
    const evalNorm = normalizeEvaluationRecord({ basis, evalItem });

    stats.normalized += 1;
    if (norm.lat != null && norm.lng != null) stats.withCoord += 1;
    if (Array.isArray(norm._warnings) && norm._warnings.length) {
      stats.coordWarnings += norm._warnings.filter((w) => /좌표/.test(w)).length;
      for (const w of norm._warnings) warnings.push(`${maskYkiho(ykiho)}: ${w}`);
    }
    if (evalNorm) stats.evalFound += 1;
    else stats.evalMissing += 1;
    if (stepFailures === 0) stats.detailComplete += 1;
    else stats.detailPartial += 1;

    // raw 원본 묶음 — facility_sources.raw 로 보존 (persist 전용, API 응답에는 안 나감)
    const rawBundle = {
      basis,
      facility: bundle.facility ?? null,
      detail: bundle.detail ?? null,
      departments: bundle.departments ?? null,
      equipment: bundle.equipment ?? null,
      specialists: bundle.specialists ?? null,
      otherStaff: bundle.otherStaff ?? null,
      evalItem: evalItem ?? null,
      collectedAt: meta.startedAt,
    };
    normalizedAll.push({ hospital: norm, evaluation: evalNorm, raw: rawBundle });
    onProgress({ phase: 'normalized', done: stats.normalized, total: ykihos.length });
  }

  // 시간 예산 때문에 목표 수만큼 못 끝냈으면 — 부분 데이터로 "성공" 하지 않고 명확한 오류.
  if (deadlineStop && normalizedAll.length < maxInstitutions) {
    throw new HiraError('수집 시간 예산 초과', {
      op: 'collectHospitals', reason: 'deadline_exceeded',
      attempts: null, lastResultCode: null,
    });
  }

  // ── 5) 샘플 3건 (ykiho 마스킹) ──
  for (const rec of normalizedAll.slice(0, 3)) {
    samples.push(sanitizeSample(rec));
  }

  meta.finishedAt = new Date().toISOString();
  return { stats, warnings, failures, samples, meta, _normalizedAll: normalizedAll };
}

function briefErr(e) {
  const msg = String((e && e.message) || e || '').slice(0, 160);
  // 혹시 모를 ykiho 흔적 제거 (base64 유사 40+자 토큰)
  return msg.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '***');
}

/** API 응답 샘플: ykiho(및 id)를 마스킹, raw 원본은 제외 */
export function sanitizeSample(rec) {
  const h = rec.hospital || {};
  const e = rec.evaluation || null;
  const mask = maskYkiho(h.external_id);
  return {
    hospital: {
      ...h,
      external_id: mask,
      id: `H-${mask}`,
      normalized_hash: h.normalized_hash ? `${String(h.normalized_hash).slice(0, 12)}…` : null,
    },
    evaluation: e
      ? { ...e, external_id: mask, facility_id: `H-${mask}` }
      : null,
  };
}
