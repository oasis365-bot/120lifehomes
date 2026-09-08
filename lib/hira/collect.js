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

  const meta = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dryRun: true,
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

  // 같은 pageNo 를 최대 LIST_EMPTY_RETRY_MAX 회. 재시도 전 지수 백오프 + jitter.
  //  (client 가 요청 간 250ms 를 이미 강제 → 그 위에 추가 대기. endpoint fallback·무한 루프 없음.)
  const fetchListPage = async (pn) => {
    let parsed = null;
    for (let attempt = 1; attempt <= LIST_EMPTY_RETRY_MAX; attempt += 1) {
      if (attempt > 1) {
        stats.listRetries += 1;
        const backoff = Math.min(LIST_RETRY_MAX_MS, LIST_RETRY_BASE_MS * 2 ** (attempt - 2));
        // eslint-disable-next-line no-await-in-loop
        await sleep(backoff + Math.floor(rand() * LIST_RETRY_JITTER_MS));
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

    if (r.kind === 'error') {
      warnings.push(`목록 p${pageNo} 실패: ${briefErr(r.error)} — 수집 중단하지 않고 현재까지로 진행`);
      break;
    }
    if (r.kind === 'abnormal') {
      warnings.push(`목록 p${pageNo} 비정상 resultCode=${r.parsed.resultCode} ${r.parsed.resultMsg ?? ''}`);
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
  for (const { ykiho, basis } of ykihos) {
    const bundle = { basis };
    let stepFailures = 0;

    for (const [name, fn] of DETAIL_STEPS) {
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

    // 평가
    let evalItem = null;
    try {
      const parsed = await client.getEvaluation({ ykiho });
      stats.apiCalls += 1;
      if (isNormalResult(parsed)) evalItem = firstItem(parsed);
    } catch (e) {
      failures.push({ ykiho: maskYkiho(ykiho), step: 'evaluation', reason: e?.reason ?? 'error', detail: briefErr(e) });
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
